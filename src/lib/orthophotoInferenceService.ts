import * as pngjsNs from 'pngjs';
import type { Pair } from 'polygon-clipping';
import type {
  DetectedRoofStructure,
  DetectedTreeCrown,
  LandClass,
  LatLon,
  LatLonMultiPolygon,
  OrthophotoSemanticClass,
  ParcelOrthophotoCvAnalysis,
  ParcelVectorContext,
  SpatialZoneBreakdown,
  ZoneCvComplianceMetrics,
} from '../types/domain.ts';
import {
  cleanOpenRing3763,
  computeExternalPolygonDistanceToParcel3763,
  isPointInRing3763,
  latLonRingToMultiPolygon3763,
  projectWgs84ToPtTm06Exact,
  ptTm06ToWgs84,
} from './booleanSpatialEngine.ts';
import {
  ORTHOPHOTO_CLASS_META,
  ORTHOPHOTO_CLASS_ORDER,
  computeParcelCvRasterGrid,
  runOrthophotoPixelPipeline,
  synthesizeDeterministicParcelOrthophotoRgba,
  type ParcelCvRasterGrid,
} from './orthophotoCvPipeline.ts';

const PNG =
  (
    pngjsNs as unknown as {
      PNG?: typeof pngjsNs.PNG;
      default?: { PNG: typeof pngjsNs.PNG };
    }
  ).PNG ?? (pngjsNs as unknown as { default: { PNG: typeof pngjsNs.PNG } }).default.PNG;

/**
 * Default live Hostinger KVM 4 OrthoSeg / SegFormer endpoint when ORTHOPHOTO_CV_SERVICE_URL is unset.
 * Set ORTHOPHOTO_CV_SERVICE_URL="local" or "disabled" to force local-only OBIA execution.
 */
export const DEFAULT_ORTHOPHOTO_CV_SERVICE_URL =
  'https://goat-orthosegkv4service-8bwzr9-ae82ec-45-133-178-58.sslip.io/';

/**
 * Default pixel metric scale used by OrthoSeg KVM when an uploaded PNG/JPEG has no GeoTIFF affine tags.
 * Verified empirically: 800 px -> 64.0 m (`800 * 0.08 = 64.0`, exact integer pixel recovery `col = x / 0.08`).
 */
export const ORTHOSEG_DEFAULT_LOCAL_PIXEL_SCALE_M = 0.08;

export interface ResolvedOrthophotoEndpoints {
  configuredUrl: string;
  baseOriginUrl: string;
  healthzUrl: string;
  multipartAnalyzeUrl: string;
  segformerContractUrl: string;
  bundleTarUrl: string;
  preferredProtocol: 'MULTIPART_ANALYZE' | 'JSON_CONTRACT';
}

export interface OrthophotoRemoteHealthStatus {
  reachable: boolean;
  configured: boolean;
  serviceUrl: string;
  analyzeEndpoint: string;
  contractEndpoint: string;
  status: string;
  workers?: number;
  workersWarmed?: boolean;
  executionMode?: string;
  buildingModelSource?: string;
  shmTotalMb?: number;
  shmFreeMb?: number;
  latencyMs: number;
  checkedAtIso: string;
  errorMessage?: string;
}

export interface PixelCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreparedOrthophotoCrop {
  imageBuffer: Buffer;
  mimeType: 'image/png' | 'image/jpeg';
  filename: string;
  width: number;
  height: number;
  rgba?: Uint8Array;
  grid: ParcelCvRasterGrid;
  sourceLabel: string;
  wasCropped: boolean;
}

export interface RemoteInferenceTelemetry {
  usedRemoteService: boolean;
  endpointCalled: string | null;
  protocolUsed: 'MULTIPART_ANALYZE' | 'JSON_CONTRACT' | 'LOCAL_OBIA_FALLBACK';
  elapsedMs: number;
  remoteStatusHttp?: number;
  executionMode?: string;
  remoteWorkers?: number;
  sourceModels: string[];
  fallbackReason?: string;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

let cachedRemoteHealth: { expiresAtMs: number; url: string; health: OrthophotoRemoteHealthStatus } | null =
  null;

/**
 * Resolves the active remote Orthophoto CV service URL from environment variables.
 * Returns empty string if explicitly disabled (`"off"`, `"disabled"`, `"false"`, `"local"`).
 */
export function resolveConfiguredOrthophotoServiceUrl(envValue?: string): string {
  const raw = envValue !== undefined ? envValue.trim() : (process.env.ORTHOPHOTO_CV_SERVICE_URL?.trim() ?? '');
  if (
    raw.toLowerCase() === 'off' ||
    raw.toLowerCase() === 'disabled' ||
    raw.toLowerCase() === 'false' ||
    raw.toLowerCase() === 'local'
  ) {
    return '';
  }
  return raw || DEFAULT_ORTHOPHOTO_CV_SERVICE_URL;
}

/**
 * Normalizes a base or path-qualified `ORTHOPHOTO_CV_SERVICE_URL` into concrete discovery,
 * multipart (`/v1/analyze`), and JSON SegFormer contract (`/api/analyze-contract`) URLs.
 */
export function resolveOrthophotoServiceEndpoints(rawUrl: string): ResolvedOrthophotoEndpoints {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  const lower = trimmed.toLowerCase();

  let baseOriginUrl = trimmed;
  let preferredProtocol: ResolvedOrthophotoEndpoints['preferredProtocol'] = 'MULTIPART_ANALYZE';
  let explicitMultipartUrl: string | null = null;
  let explicitContractUrl: string | null = null;

  if (lower.endsWith('/api/analyze-contract')) {
    baseOriginUrl = trimmed.slice(0, -'/api/analyze-contract'.length);
    preferredProtocol = 'JSON_CONTRACT';
    explicitContractUrl = trimmed;
  } else if (lower.endsWith('/v1/analyze')) {
    baseOriginUrl = trimmed.slice(0, -'/v1/analyze'.length);
    preferredProtocol = 'MULTIPART_ANALYZE';
    explicitMultipartUrl = trimmed;
  } else if (lower.endsWith('/infer') || lower.endsWith('/v1/infer') || lower.endsWith('/predict')) {
    const lastSlash = trimmed.lastIndexOf('/');
    baseOriginUrl = trimmed.slice(0, Math.max(0, lastSlash));
    if (baseOriginUrl.toLowerCase().endsWith('/v1')) {
      baseOriginUrl = baseOriginUrl.slice(0, -3);
    }
    preferredProtocol = 'MULTIPART_ANALYZE';
    explicitMultipartUrl = trimmed;
  } else if (lower.endsWith('/healthz')) {
    baseOriginUrl = trimmed.slice(0, -'/healthz'.length);
  }

  return {
    configuredUrl: trimmed,
    baseOriginUrl,
    healthzUrl: `${baseOriginUrl}/healthz`,
    multipartAnalyzeUrl: explicitMultipartUrl ?? `${baseOriginUrl}/v1/analyze`,
    segformerContractUrl: explicitContractUrl ?? `${baseOriginUrl}/api/analyze-contract`,
    bundleTarUrl: `${baseOriginUrl}/api/bundle/tar`,
    preferredProtocol,
  };
}

/**
 * Probes `/healthz` on the configured remote Orthophoto CV service (`OrthoSeg KVM` / `SegFormer`)
 * with a short 30-second memory cache to avoid redundant roundtrips.
 */
export async function probeOrthophotoServiceHealth(params?: {
  serviceUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  forceRefresh?: boolean;
  fetchImpl?: FetchLike;
}): Promise<OrthophotoRemoteHealthStatus> {
  const resolvedUrl = resolveConfiguredOrthophotoServiceUrl(params?.serviceUrl);
  const nowIso = new Date().toISOString();

  if (!resolvedUrl) {
    return {
      reachable: false,
      configured: false,
      serviceUrl: '',
      analyzeEndpoint: '',
      contractEndpoint: '',
      status: 'disabled',
      latencyMs: 0,
      checkedAtIso: nowIso,
    };
  }

  if (
    !params?.forceRefresh &&
    cachedRemoteHealth &&
    cachedRemoteHealth.url === resolvedUrl &&
    cachedRemoteHealth.expiresAtMs > Date.now()
  ) {
    return cachedRemoteHealth.health;
  }

  const endpoints = resolveOrthophotoServiceEndpoints(resolvedUrl);
  const fetchFn = params?.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1000, params?.timeoutMs ?? 4000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const startedAt = Date.now();

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'FaixaSegura-SGIFR/2.0 (OrthophotoInferenceService)',
  };
  const apiKey = params?.apiKey ?? process.env.ORTHOPHOTO_CV_API_KEY?.trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const resp = await fetchFn(endpoints.healthzUrl, {
      method: 'GET',
      headers,
      signal: ctrl.signal,
    });
    const latencyMs = Date.now() - startedAt;

    if (!resp.ok) {
      const unreachable: OrthophotoRemoteHealthStatus = {
        reachable: false,
        configured: true,
        serviceUrl: endpoints.baseOriginUrl,
        analyzeEndpoint: endpoints.multipartAnalyzeUrl,
        contractEndpoint: endpoints.segformerContractUrl,
        status: `http_${resp.status}`,
        latencyMs,
        checkedAtIso: nowIso,
        errorMessage: `Health probe returned HTTP ${resp.status}`,
      };
      return unreachable;
    }

    const json = (await resp.json()) as Record<string, unknown>;
    const compatPath =
      typeof json.compat_endpoint === 'string' && json.compat_endpoint.startsWith('/')
        ? `${endpoints.baseOriginUrl}${json.compat_endpoint}`
        : endpoints.multipartAnalyzeUrl;

    const health: OrthophotoRemoteHealthStatus = {
      reachable: true,
      configured: true,
      serviceUrl: endpoints.baseOriginUrl,
      analyzeEndpoint: compatPath,
      contractEndpoint: endpoints.segformerContractUrl,
      status: typeof json.status === 'string' ? json.status : 'ok',
      workers: typeof json.workers === 'number' ? json.workers : undefined,
      workersWarmed: typeof json.workers_warmed === 'boolean' ? json.workers_warmed : undefined,
      executionMode: typeof json.execution_mode === 'string' ? json.execution_mode : undefined,
      buildingModelSource:
        typeof json.building_model_source === 'string' ? json.building_model_source : undefined,
      shmTotalMb: typeof json.shm_total_mb === 'number' ? json.shm_total_mb : undefined,
      shmFreeMb: typeof json.shm_free_mb === 'number' ? json.shm_free_mb : undefined,
      latencyMs,
      checkedAtIso: nowIso,
    };

    cachedRemoteHealth = {
      expiresAtMs: Date.now() + 30_000,
      url: resolvedUrl,
      health,
    };
    return health;
  } catch (err) {
    return {
      reachable: false,
      configured: true,
      serviceUrl: endpoints.baseOriginUrl,
      analyzeEndpoint: endpoints.multipartAnalyzeUrl,
      contractEndpoint: endpoints.segformerContractUrl,
      status: 'unreachable',
      latencyMs: Date.now() - startedAt,
      checkedAtIso: nowIso,
      errorMessage: err instanceof Error ? err.message : 'Timeout / network error',
    };
  } finally {
    clearTimeout(timer);
  }
}

function roundDimMultipleOf8(v: number, minVal = 96, maxVal = 1024): number {
  const clamped = Math.max(minVal, Math.min(maxVal, Math.round(v)));
  return Math.max(minVal, Math.min(maxVal, Math.round(clamped / 8) * 8));
}

/**
 * Builds a georeferenced `ParcelCvRasterGrid` for an explicit `[west, south, east, north]` WGS84 bounding box
 * and exact pixel dimensions `(width, height)`.
 */
export function buildRasterGridFromBboxWgs84(
  bboxWgs84: [number, number, number, number],
  widthPx?: number,
  heightPx?: number,
  targetMaxDimPx = 640
): ParcelCvRasterGrid {
  const [westRaw, southRaw, eastRaw, northRaw] = bboxWgs84;
  const west = Number(Math.min(westRaw, eastRaw).toFixed(6));
  const east = Number(Math.max(westRaw, eastRaw).toFixed(6));
  const south = Number(Math.min(southRaw, northRaw).toFixed(6));
  const north = Number(Math.max(southRaw, northRaw).toFixed(6));

  const nw3763 = projectWgs84ToPtTm06Exact({ lat: north, lon: west });
  const ne3763 = projectWgs84ToPtTm06Exact({ lat: north, lon: east });
  const sw3763 = projectWgs84ToPtTm06Exact({ lat: south, lon: west });
  const se3763 = projectWgs84ToPtTm06Exact({ lat: south, lon: east });

  const spanX = Math.max(12, Math.hypot(ne3763[0] - nw3763[0], ne3763[1] - nw3763[1]));
  const spanY = Math.max(12, Math.hypot(nw3763[0] - sw3763[0], nw3763[1] - sw3763[1]));

  let width: number;
  let height: number;
  if (widthPx && heightPx && widthPx >= 16 && heightPx >= 16) {
    width = Math.round(widthPx);
    height = Math.round(heightPx);
  } else {
    const idealW = spanX / 0.25;
    const idealH = spanY / 0.25;
    const scale = Math.min(1, targetMaxDimPx / Math.max(idealW, idealH));
    width = roundDimMultipleOf8(idealW * scale, 96, targetMaxDimPx);
    height = roundDimMultipleOf8(idealH * scale, 96, targetMaxDimPx);
  }

  const gsdX = spanX / width;
  const gsdY = spanY / height;
  const gsdMetersPerPx = Number(((gsdX + gsdY) / 2).toFixed(3));
  const pixelAreaM2 = gsdX * gsdY;

  const minX = Math.min(nw3763[0], sw3763[0], ne3763[0], se3763[0]);
  const minY = Math.min(nw3763[1], sw3763[1], ne3763[1], se3763[1]);
  const maxX = Math.max(nw3763[0], sw3763[0], ne3763[0], se3763[0]);
  const maxY = Math.max(nw3763[1], sw3763[1], ne3763[1], se3763[1]);

  return {
    width,
    height,
    bbox3763: [
      Number(minX.toFixed(2)),
      Number(minY.toFixed(2)),
      Number(maxX.toFixed(2)),
      Number(maxY.toFixed(2)),
    ],
    bboxWgs84: [west, south, east, north],
    leafletBounds: [
      [south, west],
      [north, east],
    ],
    gsdMetersPerPx,
    pixelAreaM2,
    nw3763,
    ne3763,
    sw3763,
    se3763,
  };
}

/**
 * Extracts `{ width, height }` from a JPEG binary buffer (`SOF0`..`SOF3` markers) without native dependencies.
 */
export function readJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1];
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    if (offset + 4 >= buf.length) break;
    const segLen = buf.readUInt16BE(offset + 2);
    if (segLen < 2 || offset + 2 + segLen > buf.length) break;

    // SOF0 (0xC0), SOF1 (0xC1), SOF2 (0xC2), SOF3 (0xC3)
    if (marker >= 0xc0 && marker <= 0xc3 && offset + 9 <= buf.length) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      if (width > 0 && height > 0) {
        return { width, height };
      }
    }
    offset += 2 + segLen;
  }
  return null;
}

/**
 * Encodes an RGBA `Uint8Array` into a **24-bit 3-channel RGB PNG (`colorType: 2`, zero alpha channel)**
 * so ONNX / PyTorch / DeepForest / SegFormer models expecting 3-channel RGB tensors never reject 4-channel RGBA.
 */
export function encodeRgbaToRgb24PngBuffer(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number
): Buffer {
  const png = new PNG({
    width,
    height,
    colorType: 2,
    inputColorType: 6,
    inputHasAlpha: true,
  });
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  return PNG.sync.write(png, { colorType: 2 });
}

/**
 * Crops an RGBA raster to `cropRect` and adjusts the geographic `bboxWgs84` proportionally.
 */
export function cropRgbaAndAdjustGrid(params: {
  rgba: Uint8Array;
  sourceWidth: number;
  sourceHeight: number;
  baseBboxWgs84: [number, number, number, number];
  cropRect?: PixelCropRect;
  adjustBboxToCrop?: boolean;
}): {
  rgba: Uint8Array;
  width: number;
  height: number;
  grid: ParcelCvRasterGrid;
  wasCropped: boolean;
} {
  const { rgba, sourceWidth, sourceHeight, baseBboxWgs84, cropRect } = params;
  if (!cropRect) {
    return {
      rgba,
      width: sourceWidth,
      height: sourceHeight,
      grid: buildRasterGridFromBboxWgs84(baseBboxWgs84, sourceWidth, sourceHeight),
      wasCropped: false,
    };
  }

  const x0 = Math.max(0, Math.min(sourceWidth - 16, Math.round(cropRect.x)));
  const y0 = Math.max(0, Math.min(sourceHeight - 16, Math.round(cropRect.y)));
  const cropW = Math.max(16, Math.min(sourceWidth - x0, Math.round(cropRect.width)));
  const cropH = Math.max(16, Math.min(sourceHeight - y0, Math.round(cropRect.height)));

  const croppedRgba = new Uint8Array(cropW * cropH * 4);
  for (let r = 0; r < cropH; r++) {
    const srcRowStart = ((y0 + r) * sourceWidth + x0) * 4;
    const dstRowStart = r * cropW * 4;
    croppedRgba.set(rgba.subarray(srcRowStart, srcRowStart + cropW * 4), dstRowStart);
  }

  let nextBbox: [number, number, number, number] = baseBboxWgs84;
  if (params.adjustBboxToCrop !== false) {
    const [west, south, east, north] = baseBboxWgs84;
    const lonSpan = east - west;
    const latSpan = north - south;
    const subWest = west + (x0 / sourceWidth) * lonSpan;
    const subEast = west + ((x0 + cropW) / sourceWidth) * lonSpan;
    const subNorth = north - (y0 / sourceHeight) * latSpan;
    const subSouth = north - ((y0 + cropH) / sourceHeight) * latSpan;
    nextBbox = [subWest, subSouth, subEast, subNorth];
  }

  return {
    rgba: croppedRgba,
    width: cropW,
    height: cropH,
    grid: buildRasterGridFromBboxWgs84(nextBbox, cropW, cropH),
    wasCropped: x0 > 0 || y0 > 0 || cropW !== sourceWidth || cropH !== sourceHeight,
  };
}

/**
 * Decodes a client-supplied cropped orthophoto (`data:image/...;base64,...`, raw base64, or `Buffer`),
 * optionally sub-crops `cropRect`, and prepares a 3-channel RGB PNG/JPEG payload ready for remote neural inference.
 */
export function prepareUploadedOrthophotoCrop(params: {
  imageBase64?: string;
  rawImageBuffer?: Buffer;
  parcelVertices: LatLon[];
  bboxWgs84?: [number, number, number, number];
  cropRect?: PixelCropRect;
  adjustBboxToCrop?: boolean;
  sourceLabel?: string;
}): PreparedOrthophotoCrop {
  let buf: Buffer | null = params.rawImageBuffer ?? null;
  if (!buf && params.imageBase64) {
    const trimmed = params.imageBase64.trim();
    const commaIdx = trimmed.indexOf(',');
    const rawB64 = trimmed.startsWith('data:') && commaIdx !== -1 ? trimmed.slice(commaIdx + 1) : trimmed;
    buf = Buffer.from(rawB64, 'base64');
  }
  if (!buf || buf.length < 32) {
    throw new Error('Imagem recortada da ortofoto vazia ou inválida.');
  }

  const defaultGrid = computeParcelCvRasterGrid(params.parcelVertices, 24, 640);
  const baseBbox = params.bboxWgs84 ?? defaultGrid.bboxWgs84;

  // Case A: PNG (`89 50 4E 47`) -> decode RGBA, apply optional cropRect, re-encode 24-bit 3-channel RGB PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const decoded = PNG.sync.read(buf);
    const rawRgba = new Uint8Array(
      decoded.data.buffer,
      decoded.data.byteOffset,
      decoded.data.byteLength
    );
    const cropped = cropRgbaAndAdjustGrid({
      rgba: rawRgba,
      sourceWidth: decoded.width,
      sourceHeight: decoded.height,
      baseBboxWgs84: baseBbox,
      cropRect: params.cropRect,
      adjustBboxToCrop: params.adjustBboxToCrop,
    });
    const rgb24Png = encodeRgbaToRgb24PngBuffer(cropped.rgba, cropped.width, cropped.height);
    return {
      imageBuffer: rgb24Png,
      mimeType: 'image/png',
      filename: 'orthophoto_crop_rgb24.png',
      width: cropped.width,
      height: cropped.height,
      rgba: cropped.rgba,
      grid: cropped.grid,
      sourceLabel: params.sourceLabel ?? 'Recorte de Ortofoto Enviado (PNG RGB 24-bit)',
      wasCropped: cropped.wasCropped,
    };
  }

  // Case B: JPEG (`FF D8 FF`) -> extract exact SOF dimensions and pass crisp 3-channel RGB JPEG directly
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    const dims = readJpegDimensions(buf) ?? { width: defaultGrid.width, height: defaultGrid.height };
    const grid = buildRasterGridFromBboxWgs84(baseBbox, dims.width, dims.height);
    return {
      imageBuffer: buf,
      mimeType: 'image/jpeg',
      filename: 'orthophoto_crop_rgb.jpg',
      width: dims.width,
      height: dims.height,
      rgba: undefined,
      grid,
      sourceLabel: params.sourceLabel ?? 'Recorte de Ortofoto Enviado (JPEG RGB)',
      wasCropped: false,
    };
  }

  throw new Error('Formato de imagem não suportado. Envie um recorte PNG ou JPEG válido.');
}

/**
 * Acquires a high-definition (`~25 cm` GSD, up to `640×640 px`) cropped aerial orthophoto around the parcel
 * from DGT Official WMS (`Ortos2021-RGB`) or Esri `World_Imagery` (`png24`), encoding a 24-bit 3-channel RGB PNG.
 */
export async function acquireServerCroppedParcelOrthophoto(params: {
  parcelVertices: LatLon[];
  landClass: LandClass;
  spatial: SpatialZoneBreakdown;
  vectorContext?: ParcelVectorContext;
  bboxWgs84?: [number, number, number, number];
  cropRect?: PixelCropRect;
  targetMaxDimPx?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<PreparedOrthophotoCrop & { fallbackEngineMode: ParcelOrthophotoCvAnalysis['engineMode'] }> {
  const maxDim = roundDimMultipleOf8(params.targetMaxDimPx ?? 400, 128, 896);
  const baseGrid = params.bboxWgs84
    ? buildRasterGridFromBboxWgs84(params.bboxWgs84, undefined, undefined, maxDim)
    : computeParcelCvRasterGrid(params.parcelVertices, 20, maxDim);

  const [west, south, east, north] = baseGrid.bboxWgs84;
  const customDgtWms = process.env.DGT_ORTHO_WMS_URL?.trim();
  const dgtWmsBase =
    customDgtWms || 'https://cartografia.dgterritorio.gov.pt/ortos2021/service';

  const candidates: Array<{ url: string; label: string; timeoutMs: number }> = [
    {
      url: `${dgtWmsBase}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=Ortos2021-RGB&STYLES=&SRS=EPSG:4326&BBOX=${west},${south},${east},${north}&WIDTH=${baseGrid.width}&HEIGHT=${baseGrid.height}&FORMAT=image/png`,
      label: 'DGT Ortofotos Oficiais 25 cm (WMS PT)',
      timeoutMs: customDgtWms ? Math.max(2000, params.timeoutMs ?? 4000) : 1800,
    },
    {
      url: `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${west},${south},${east},${north}&bboxSR=4326&imageSR=4326&size=${baseGrid.width},${baseGrid.height}&format=png24&f=image`,
      label: 'Ortofoto Aérea Real 25 cm (World Imagery RGB)',
      timeoutMs: Math.max(2200, params.timeoutMs ?? 4200),
    },
  ];

  const fetchFn = params.fetchImpl ?? fetch;

  for (const cand of candidates) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cand.timeoutMs);
    try {
      const resp = await fetchFn(cand.url, {
        headers: {
          Accept: 'image/png,*/*;q=0.8',
          'User-Agent': 'FaixaSeguraPT/2.0 (OrthophotoInferenceService)',
        },
        signal: ctrl.signal,
      });
      if (!resp.ok) continue;
      const contentType = (resp.headers.get('content-type') || '').toLowerCase();
      if (
        contentType.includes('xml') ||
        contentType.includes('html') ||
        contentType.includes('json')
      ) {
        continue;
      }

      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 256) continue;
      const decoded = PNG.sync.read(buf);
      if (decoded.width < 32 || decoded.height < 32) continue;

      let rgba: Uint8Array;
      if (decoded.width === baseGrid.width && decoded.height === baseGrid.height) {
        rgba = new Uint8Array(
          decoded.data.buffer,
          decoded.data.byteOffset,
          decoded.data.byteLength
        );
      } else {
        rgba = new Uint8Array(baseGrid.width * baseGrid.height * 4);
        for (let r = 0; r < baseGrid.height; r++) {
          const srcR = Math.min(
            decoded.height - 1,
            Math.floor((r * decoded.height) / baseGrid.height)
          );
          for (let c = 0; c < baseGrid.width; c++) {
            const srcC = Math.min(
              decoded.width - 1,
              Math.floor((c * decoded.width) / baseGrid.width)
            );
            const sIdx = (srcR * decoded.width + srcC) * 4;
            const dIdx = (r * baseGrid.width + c) * 4;
            rgba[dIdx] = decoded.data[sIdx];
            rgba[dIdx + 1] = decoded.data[sIdx + 1];
            rgba[dIdx + 2] = decoded.data[sIdx + 2];
            rgba[dIdx + 3] = decoded.data[sIdx + 3];
          }
        }
      }

      // Reject uniform/empty frames
      const pxCount = baseGrid.width * baseGrid.height;
      let sumLum = 0;
      let sumSqLum = 0;
      let opaqueCount = 0;
      for (let i = 0; i < pxCount; i++) {
        const bIdx = i * 4;
        if (rgba[bIdx + 3] > 20) opaqueCount++;
        const l = 0.299 * rgba[bIdx] + 0.587 * rgba[bIdx + 1] + 0.114 * rgba[bIdx + 2];
        sumLum += l;
        sumSqLum += l * l;
      }
      const meanL = sumLum / pxCount;
      const stdDev = Math.sqrt(Math.max(0, sumSqLum / pxCount - meanL * meanL));
      if (opaqueCount < pxCount * 0.75 || stdDev < 4.5) continue;

      const cropped = cropRgbaAndAdjustGrid({
        rgba,
        sourceWidth: baseGrid.width,
        sourceHeight: baseGrid.height,
        baseBboxWgs84: baseGrid.bboxWgs84,
        cropRect: params.cropRect,
      });

      const rgb24Png = encodeRgbaToRgb24PngBuffer(cropped.rgba, cropped.width, cropped.height);
      return {
        imageBuffer: rgb24Png,
        mimeType: 'image/png',
        filename: 'parcel_orthophoto_25cm.png',
        width: cropped.width,
        height: cropped.height,
        rgba: cropped.rgba,
        grid: cropped.grid,
        sourceLabel: cand.label,
        wasCropped: cropped.wasCropped,
        fallbackEngineMode: 'REAL_ORTHOPHOTO_PIXEL_CV',
      };
    } catch {
      // Try next candidate
    } finally {
      clearTimeout(timer);
    }
  }

  // Deterministic synthetic fallback crop
  const synthClamped = synthesizeDeterministicParcelOrthophotoRgba({
    grid: baseGrid,
    parcelVertices: params.parcelVertices,
    landClass: params.landClass,
    spatial: params.spatial,
    vectorContext: params.vectorContext,
  });
  const synthRgba = new Uint8Array(
    synthClamped.buffer,
    synthClamped.byteOffset,
    synthClamped.byteLength
  );
  const cropped = cropRgbaAndAdjustGrid({
    rgba: synthRgba,
    sourceWidth: baseGrid.width,
    sourceHeight: baseGrid.height,
    baseBboxWgs84: baseGrid.bboxWgs84,
    cropRect: params.cropRect,
  });
  const rgb24Png = encodeRgbaToRgb24PngBuffer(cropped.rgba, cropped.width, cropped.height);

  return {
    imageBuffer: rgb24Png,
    mimeType: 'image/png',
    filename: 'parcel_orthophoto_synth.png',
    width: cropped.width,
    height: cropped.height,
    rgba: cropped.rgba,
    grid: cropped.grid,
    sourceLabel: 'Ortofoto Sintética Georreferenciada EPSG:3763 (Modo Offline)',
    wasCropped: cropped.wasCropped,
    fallbackEngineMode: 'OFFLINE_SYNTHETIC_CV',
  };
}

/**
 * Maps external SegFormer semantic class labels or indices (SGIFR 7-class, FLAIR-1 aerial,
 * LoveDA, Potsdam/Vaihingen, ADE20K) onto FaixaSegura's 7 canonical `ORTHOPHOTO_CLASS_ORDER` indices `0..6`.
 */
export function mapSegFormerLabelOrIdToSgifrClassIndex(
  labelOrId: string | number,
  id2label?: Record<string, string>
): number {
  if (typeof labelOrId === 'number' && Number.isFinite(labelOrId)) {
    const idx = Math.round(labelOrId);
    if (id2label && typeof id2label[String(idx)] === 'string') {
      return mapSegFormerLabelOrIdToSgifrClassIndex(id2label[String(idx)]);
    }
    return Math.max(0, Math.min(6, idx));
  }

  const raw = String(labelOrId).trim();
  const exactIdx = ORTHOPHOTO_CLASS_ORDER.indexOf(raw as OrthophotoSemanticClass);
  if (exactIdx !== -1) return exactIdx;

  const norm = raw.toLowerCase().replace(/[_-]+/g, ' ');

  if (
    norm.includes('building') ||
    norm.includes('roof') ||
    norm.includes('house') ||
    norm.includes('edifice') ||
    norm.includes('structure') ||
    norm.includes('shed') ||
    norm.includes('annex') ||
    norm.includes('cobertura')
  ) {
    return 2; // BUILT_ROOF_STRUCTURE
  }
  if (
    norm.includes('water') ||
    norm.includes('river') ||
    norm.includes('stream') ||
    norm.includes('lake') ||
    norm.includes('pool') ||
    norm.includes('riparian') ||
    norm.includes('wetland') ||
    norm.includes('agua')
  ) {
    return 6; // WATER_RIPARIAN
  }
  if (
    norm.includes('tree') ||
    norm.includes('canopy') ||
    norm.includes('crown') ||
    norm.includes('conifer') ||
    norm.includes('deciduous') ||
    norm.includes('forest') ||
    norm.includes('woodland') ||
    norm.includes('pine') ||
    norm.includes('eucalypt') ||
    norm.includes('copa')
  ) {
    return 5; // TREE_CANOPY_CROWN
  }
  if (
    norm.includes('shrub') ||
    norm.includes('scrub') ||
    norm.includes('brushwood') ||
    norm.includes('bush') ||
    norm.includes('heath') ||
    norm.includes('vineyard') ||
    norm.includes('mato') ||
    norm.includes('fuel')
  ) {
    return 4; // SHRUB_SCRUB_FUEL
  }
  if (
    norm.includes('impervious') ||
    norm.includes('road') ||
    norm.includes('asphalt') ||
    norm.includes('pavement') ||
    norm.includes('sidewalk') ||
    norm.includes('street') ||
    norm.includes('parking') ||
    norm.includes('paviment')
  ) {
    return 1; // PAVED_ROAD_IMPERVIOUS
  }
  if (
    norm.includes('bare') ||
    norm.includes('mineral') ||
    norm.includes('inert') ||
    norm.includes('gravel') ||
    norm.includes('rock') ||
    norm.includes('sand') ||
    norm.includes('pervious surface') ||
    norm.includes('barren') ||
    norm.includes('earth') ||
    norm.includes('brita')
  ) {
    return 0; // MINERAL_INERT_BARE
  }
  if (
    norm.includes('herbaceous') ||
    norm.includes('grass') ||
    norm.includes('lawn') ||
    norm.includes('pasture') ||
    norm.includes('agricult') ||
    norm.includes('crop') ||
    norm.includes('meadow') ||
    norm.includes('cleared')
  ) {
    return 3; // LOW_HERBACEOUS_CLEARED
  }

  const parsedInt = Number.parseInt(raw, 10);
  if (Number.isFinite(parsedInt)) {
    return Math.max(0, Math.min(6, parsedInt));
  }
  return 3;
}

/**
 * Decodes a SegFormer semantic segmentation payload (2D class matrix, flat class array,
 * `[C, H, W]` / `[1, C, H, W]` logits tensor, or base64 class-index PNG) into a `Uint8Array(targetW * targetH)`
 * with values in `0..6` (`ORTHOPHOTO_CLASS_ORDER`).
 */
export function decodeSegFormerMaskPayload(
  payload: Record<string, unknown>,
  targetWidth: number,
  targetHeight: number
): Uint8Array | null {
  const id2labelRaw = payload.id2label ?? payload.classMap ?? payload.classes_map;
  const id2label =
    id2labelRaw && typeof id2labelRaw === 'object' && !Array.isArray(id2labelRaw)
      ? (id2labelRaw as Record<string, string>)
      : undefined;

  // 1. Base64-encoded PNG class mask (`maskBase64` / `segmentation_png_base64` / `mask_png`)
  const b64Field =
    payload.maskBase64 ??
    payload.mask_base64 ??
    payload.segmentation_png_base64 ??
    payload.semantic_mask_png;
  if (typeof b64Field === 'string' && b64Field.trim().length > 16) {
    const trimmed = b64Field.trim();
    const commaIdx = trimmed.indexOf(',');
    const rawB64 = trimmed.startsWith('data:') && commaIdx !== -1 ? trimmed.slice(commaIdx + 1) : trimmed;
    const pngBuf = Buffer.from(rawB64, 'base64');
    if (pngBuf.length >= 24 && pngBuf[0] === 0x89 && pngBuf[1] === 0x50) {
      const decoded = PNG.sync.read(pngBuf);
      const out = new Uint8Array(targetWidth * targetHeight);
      for (let r = 0; r < targetHeight; r++) {
        const srcR = Math.min(decoded.height - 1, Math.floor((r * decoded.height) / targetHeight));
        for (let c = 0; c < targetWidth; c++) {
          const srcC = Math.min(decoded.width - 1, Math.floor((c * decoded.width) / targetWidth));
          const pIdx = (srcR * decoded.width + srcC) * 4;
          const rawClassVal = decoded.data[pIdx];
          out[r * targetWidth + c] = mapSegFormerLabelOrIdToSgifrClassIndex(rawClassVal, id2label);
        }
      }
      return out;
    }
  }

  // 2. 2D or 1D class mask (`semanticMask` / `segmentation_mask` / `class_map` / `pred_mask`)
  const rawMask =
    payload.semanticMask ??
    payload.semantic_mask ??
    payload.segmentation_mask ??
    payload.class_map ??
    payload.pred_mask;

  if (Array.isArray(rawMask) && rawMask.length > 0) {
    // 2D `[H][W]` array
    if (Array.isArray(rawMask[0])) {
      const srcH = rawMask.length;
      const srcW = (rawMask[0] as unknown[]).length;
      if (srcH > 0 && srcW > 0) {
        const out = new Uint8Array(targetWidth * targetHeight);
        for (let r = 0; r < targetHeight; r++) {
          const srcR = Math.min(srcH - 1, Math.floor((r * srcH) / targetHeight));
          const rowArr = rawMask[srcR] as Array<string | number>;
          for (let c = 0; c < targetWidth; c++) {
            const srcC = Math.min(srcW - 1, Math.floor((c * srcW) / targetWidth));
            out[r * targetWidth + c] = mapSegFormerLabelOrIdToSgifrClassIndex(
              rowArr[srcC] ?? 3,
              id2label
            );
          }
        }
        return out;
      }
    } else {
      // Flat 1D array with explicit or square dimensions
      const flat = rawMask as Array<string | number>;
      const srcW =
        typeof payload.maskWidth === 'number'
          ? payload.maskWidth
          : typeof payload.width === 'number' && flat.length % payload.width === 0
            ? payload.width
            : Math.round(Math.sqrt(flat.length));
      const srcH = srcW > 0 ? Math.floor(flat.length / srcW) : 0;
      if (srcW > 0 && srcH > 0 && srcW * srcH === flat.length) {
        const out = new Uint8Array(targetWidth * targetHeight);
        for (let r = 0; r < targetHeight; r++) {
          const srcR = Math.min(srcH - 1, Math.floor((r * srcH) / targetHeight));
          for (let c = 0; c < targetWidth; c++) {
            const srcC = Math.min(srcW - 1, Math.floor((c * srcW) / targetWidth));
            out[r * targetWidth + c] = mapSegFormerLabelOrIdToSgifrClassIndex(
              flat[srcR * srcW + srcC],
              id2label
            );
          }
        }
        return out;
      }
    }
  }

  // 3. Raw NCHW / CHW Logits (`logits` + `logitsShape`: `[1, C, H, W]` or `[C, H, W]`)
  if (Array.isArray(payload.logits) && Array.isArray(payload.logitsShape)) {
    const shape = (payload.logitsShape as unknown[]).map((n) => Number(n));
    const dims = shape.length === 4 ? shape.slice(1) : shape.length === 3 ? shape : null;
    if (dims && dims[0] >= 2 && dims[1] >= 4 && dims[2] >= 4) {
      const [numClasses, srcH, srcW] = dims;
      const flatLogits = payload.logits as number[];
      const planeSize = srcH * srcW;
      if (flatLogits.length >= numClasses * planeSize) {
        const argmaxSrc = new Uint8Array(planeSize);
        for (let i = 0; i < planeSize; i++) {
          let bestC = 0;
          let bestV = -Infinity;
          for (let ch = 0; ch < numClasses; ch++) {
            const v = Number(flatLogits[ch * planeSize + i]);
            if (v > bestV) {
              bestV = v;
              bestC = ch;
            }
          }
          argmaxSrc[i] = mapSegFormerLabelOrIdToSgifrClassIndex(bestC, id2label);
        }
        const out = new Uint8Array(targetWidth * targetHeight);
        for (let r = 0; r < targetHeight; r++) {
          const srcR = Math.min(srcH - 1, Math.floor((r * srcH) / targetHeight));
          for (let c = 0; c < targetWidth; c++) {
            const srcC = Math.min(srcW - 1, Math.floor((c * srcW) / targetWidth));
            out[r * targetWidth + c] = argmaxSrc[srcR * srcW + srcC];
          }
        }
        return out;
      }
    }
  }

  return null;
}

function pixelToPtTm06(grid: ParcelCvRasterGrid, col: number, row: number): Pair {
  const u = (col + 0.5) / grid.width;
  const v = (row + 0.5) / grid.height;
  const topX = grid.nw3763[0] + u * (grid.ne3763[0] - grid.nw3763[0]);
  const topY = grid.nw3763[1] + u * (grid.ne3763[1] - grid.nw3763[1]);
  const botX = grid.sw3763[0] + u * (grid.se3763[0] - grid.sw3763[0]);
  const botY = grid.sw3763[1] + u * (grid.se3763[1] - grid.sw3763[1]);
  return [topX + v * (botX - topX), topY + v * (botY - topY)];
}

function ptTm06ToPixel(grid: ParcelCvRasterGrid, pt: Pair): [number, number] {
  const [minX, minY, maxX, maxY] = grid.bbox3763;
  const u = (pt[0] - minX) / Math.max(1e-6, maxX - minX);
  const v = (maxY - pt[1]) / Math.max(1e-6, maxY - minY);
  return [u * grid.width, v * grid.height];
}

function shoelaceArea3763(openRing: Pair[]): number {
  if (openRing.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < openRing.length; i++) {
    const [x1, y1] = openRing[i];
    const [x2, y2] = openRing[(i + 1) % openRing.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) * 0.5;
}

function pointToSegmentDist3763(p: Pair, a: Pair, b: Pair): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-8) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function minDistancePointToRingEdges3763(pt: Pair, openRing: Pair[]): number {
  if (openRing.length === 0) return Infinity;
  if (isPointInRing3763(pt, openRing)) return 0;
  let best = Infinity;
  for (let i = 0; i < openRing.length; i++) {
    const d = pointToSegmentDist3763(pt, openRing[i], openRing[(i + 1) % openRing.length]);
    if (d < best) best = d;
  }
  return best;
}

interface ProjectedMultiPoly {
  outer: Pair[];
  holes: Pair[][];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function projectMultiPoly3763(
  mpWgs84: LatLonMultiPolygon | undefined,
  fallbackSingle?: LatLon[]
): ProjectedMultiPoly[] {
  const source: LatLonMultiPolygon =
    mpWgs84 && mpWgs84.length > 0
      ? mpWgs84
      : fallbackSingle && fallbackSingle.length >= 3
        ? [[fallbackSingle]]
        : [];
  const res: ProjectedMultiPoly[] = [];
  for (const poly of source) {
    if (!poly || poly.length === 0) continue;
    const outer = cleanOpenRing3763(poly[0].map(projectWgs84ToPtTm06Exact));
    if (outer.length < 3) continue;
    const holes = poly
      .slice(1)
      .map((r) => cleanOpenRing3763(r.map(projectWgs84ToPtTm06Exact)))
      .filter((r) => r.length >= 3);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of outer) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    res.push({ outer, holes, minX, minY, maxX, maxY });
  }
  return res;
}

function isPointInProjectedMultiPoly(pt: Pair, polys: ProjectedMultiPoly[]): boolean {
  for (const poly of polys) {
    if (pt[0] < poly.minX || pt[0] > poly.maxX || pt[1] < poly.minY || pt[1] > poly.maxY) {
      continue;
    }
    if (!isPointInRing3763(pt, poly.outer)) continue;
    let inHole = false;
    for (const hole of poly.holes) {
      if (isPointInRing3763(pt, hole)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

function rasterizePixelPolygonOntoMask(
  mask: Uint8Array,
  width: number,
  height: number,
  pixelRing: Array<[number, number]>,
  classId: number
): void {
  if (pixelRing.length < 3) return;
  let minCol = Infinity;
  let maxCol = -Infinity;
  let minRow = Infinity;
  let maxRow = -Infinity;
  for (const [c, r] of pixelRing) {
    if (c < minCol) minCol = c;
    if (c > maxCol) maxCol = c;
    if (r < minRow) minRow = r;
    if (r > maxRow) maxRow = r;
  }
  const c0 = Math.max(0, Math.floor(minCol));
  const c1 = Math.min(width - 1, Math.ceil(maxCol));
  const r0 = Math.max(0, Math.floor(minRow));
  const r1 = Math.min(height - 1, Math.ceil(maxRow));

  const ringPairs: Pair[] = pixelRing.map(([c, r]) => [c, r]);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (isPointInRing3763([c + 0.5, r + 0.5], ringPairs)) {
        mask[r * width + c] = classId;
      }
    }
  }
}

interface ParsedNeuralPolygon {
  kind: 'TREE_CROWN' | 'BUILDING';
  ring3763: Pair[];
  ringWgs84: LatLon[];
  pixelRing: Array<[number, number]>;
  confidence: number;
  sourceModel: string;
  speciesHint?: 'RESINOUS_EUCALYPT' | 'BROADLEAF_QUERCUS';
}

function extractExteriorCoordRings(geometry: Record<string, unknown>): number[][][] {
  const gType = String(geometry.type ?? '');
  const coords = geometry.coordinates;
  if (!Array.isArray(coords)) return [];
  if (gType === 'Polygon' && Array.isArray(coords[0])) {
    return [coords[0] as number[][]];
  }
  if (gType === 'MultiPolygon') {
    const rings: number[][][] = [];
    for (const poly of coords) {
      if (Array.isArray(poly) && Array.isArray(poly[0])) {
        rings.push(poly[0] as number[][]);
      }
    }
    return rings;
  }
  return [];
}

/**
 * Transforms a remote SegFormer / OrthoSeg KVM JSON response (GeoJSON `FeatureCollection`,
 * SegFormer `semanticMask` / `logits` / `maskBase64`, or `/api/analyze-contract` object)
 * into a georeferenced `ParcelOrthophotoCvAnalysis` aligned to `ParcelCvRasterGrid` and Despacho n.º 675/2026.
 */
export function processRemoteInferencePayloadToCvAnalysis(params: {
  remotePayload: Record<string, unknown>;
  grid: ParcelCvRasterGrid;
  rgba?: Uint8Array;
  parcelVertices: LatLon[];
  landClass: LandClass;
  spatial: SpatialZoneBreakdown;
  vectorContext?: ParcelVectorContext;
  imagerySourceLabel: string;
  configuredModelProfile: string;
}): {
  cvAnalysis: ParcelOrthophotoCvAnalysis;
  sourceModels: string[];
} {
  const {
    remotePayload,
    grid,
    rgba,
    parcelVertices,
    landClass,
    spatial,
    vectorContext,
    imagerySourceLabel,
    configuredModelProfile,
  } = params;

  // Case 1: Pre-built `cvAnalysis` contract object (`POST /api/analyze-contract`)
  if (
    remotePayload.cvAnalysis &&
    typeof remotePayload.cvAnalysis === 'object' &&
    !Array.isArray(remotePayload.cvAnalysis)
  ) {
    const rawCv = remotePayload.cvAnalysis as ParcelOrthophotoCvAnalysis;
    return {
      cvAnalysis: {
        ...rawCv,
        analyzedAtIso: rawCv.analyzedAtIso || new Date().toISOString(),
        engineMode: 'ONNX_MICROSERVICE',
        imagerySourceLabel: rawCv.imagerySourceLabel || imagerySourceLabel,
        modelProfile: rawCv.modelProfile || configuredModelProfile,
        bboxWgs84: rawCv.bboxWgs84 ?? grid.bboxWgs84,
        leafletBounds: rawCv.leafletBounds ?? grid.leafletBounds,
      },
      sourceModels: [rawCv.modelProfile || configuredModelProfile],
    };
  }

  const width = grid.width;
  const height = grid.height;
  const totalPixels = width * height;
  const sourceModelsSet = new Set<string>();

  // Step A: Decode SegFormer semantic mask if present; otherwise compute radiometric land-cover base
  const segformerMask = decodeSegFormerMaskPayload(remotePayload, width, height);
  let semanticMask: Uint8Array;

  if (segformerMask) {
    semanticMask = segformerMask;
    const segModelName =
      typeof remotePayload.segmentation_model === 'string'
        ? remotePayload.segmentation_model
        : typeof remotePayload.model === 'string'
          ? remotePayload.model
          : 'segformer-b2-dgt25cm';
    sourceModelsSet.add(segModelName);
  } else if (rgba && rgba.length === totalPixels * 4) {
    const baseOut = runOrthophotoPixelPipeline({
      rgba,
      grid,
      parcelVertices,
      landClass,
      spatial,
      vectorContext,
      imagerySourceLabel,
      engineMode: 'ONNX_MICROSERVICE',
      modelProfile: configuredModelProfile,
    });
    semanticMask = new Uint8Array(baseOut.semanticMask);
  } else {
    // JPEG input without local RGBA decode: synthesize deterministic land-cover ground base before painting neural polygons
    const synthClamped = synthesizeDeterministicParcelOrthophotoRgba({
      grid,
      parcelVertices,
      landClass,
      spatial,
      vectorContext,
    });
    const baseOut = runOrthophotoPixelPipeline({
      rgba: synthClamped,
      grid,
      parcelVertices,
      landClass,
      spatial,
      vectorContext,
      imagerySourceLabel,
      engineMode: 'ONNX_MICROSERVICE',
      modelProfile: configuredModelProfile,
    });
    semanticMask = new Uint8Array(baseOut.semanticMask);
  }

  // Step B: Parse GeoJSON FeatureCollection (`OrthoSeg KVM` `/v1/analyze` or hybrid SegFormer+Instances)
  const crsNameRaw =
    remotePayload.crs &&
    typeof remotePayload.crs === 'object' &&
    (remotePayload.crs as { properties?: { name?: string } }).properties?.name
      ? String((remotePayload.crs as { properties: { name: string } }).properties.name)
      : 'LOCAL_PIXEL_METRIC';
  const crsUpper = crsNameRaw.toUpperCase();

  const metaObj =
    remotePayload.metadata && typeof remotePayload.metadata === 'object'
      ? (remotePayload.metadata as Record<string, unknown>)
      : undefined;
  const localPixelScaleM =
    metaObj && typeof metaObj.gsd_m === 'number' && metaObj.gsd_m > 0
      ? metaObj.gsd_m
      : ORTHOSEG_DEFAULT_LOCAL_PIXEL_SCALE_M;

  const featuresRaw = Array.isArray(remotePayload.features)
    ? (remotePayload.features as Array<Record<string, unknown>>)
    : [];
  const hasFeatureCollection =
    remotePayload.type === 'FeatureCollection' || Array.isArray(remotePayload.features);

  const parsedPolygons: ParsedNeuralPolygon[] = [];

  for (const feat of featuresRaw) {
    if (!feat || typeof feat !== 'object') continue;
    const geom = feat.geometry as Record<string, unknown> | undefined;
    const props = (feat.properties as Record<string, unknown> | undefined) ?? {};
    if (!geom) continue;

    const rawClass = String(
      props.class ?? props.category ?? props.label ?? props.feature_type ?? 'tree_crown'
    ).toLowerCase();
    const kind: ParsedNeuralPolygon['kind'] =
      rawClass.includes('build') ||
      rawClass.includes('roof') ||
      rawClass.includes('struct') ||
      rawClass.includes('house') ||
      rawClass.includes('shed') ||
      rawClass.includes('annex')
        ? 'BUILDING'
        : 'TREE_CROWN';

    const sourceModel =
      typeof props.source_model === 'string' && props.source_model.trim()
        ? props.source_model.trim()
        : kind === 'BUILDING'
          ? 'aerial-building-onnx'
          : 'deepforest-retinanet';
    sourceModelsSet.add(sourceModel);

    const confidence =
      typeof props.confidence === 'number'
        ? props.confidence
        : typeof props.score === 'number'
          ? props.score
          : 0.85;

    const speciesRaw = String(props.species_group ?? props.species ?? '').toUpperCase();
    const speciesHint: ParsedNeuralPolygon['speciesHint'] = speciesRaw.includes('QUERCUS') ||
      speciesRaw.includes('BROADLEAF')
      ? 'BROADLEAF_QUERCUS'
      : speciesRaw.includes('RESINOUS') || speciesRaw.includes('PINE') || speciesRaw.includes('EUCALYPT')
        ? 'RESINOUS_EUCALYPT'
        : undefined;

    const coordRings = extractExteriorCoordRings(geom);
    for (const rawRing of coordRings) {
      if (rawRing.length < 3) continue;
      // Drop duplicate closing point if present
      const openCoords =
        rawRing.length >= 4 &&
        Math.hypot(
          Number(rawRing[0][0]) - Number(rawRing[rawRing.length - 1][0]),
          Number(rawRing[0][1]) - Number(rawRing[rawRing.length - 1][1])
        ) < 1e-6
          ? rawRing.slice(0, -1)
          : rawRing;

      if (openCoords.length < 3) continue;

      const ring3763: Pair[] = [];
      const ringWgs84: LatLon[] = [];
      const pixelRing: Array<[number, number]> = [];

      for (const pt of openCoords) {
        const x = Number(pt[0]);
        const y = Number(pt[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

        if (crsUpper.includes('4326') || crsUpper.includes('WGS84') || crsUpper.includes('CRS84')) {
          const wgs: LatLon = { lat: Number(y.toFixed(6)), lon: Number(x.toFixed(6)) };
          const p3763 = projectWgs84ToPtTm06Exact(wgs);
          ringWgs84.push(wgs);
          ring3763.push(p3763);
          pixelRing.push(ptTm06ToPixel(grid, p3763));
        } else if (crsUpper.includes('3763')) {
          const p3763: Pair = [x, y];
          ring3763.push(p3763);
          ringWgs84.push(ptTm06ToWgs84(p3763));
          pixelRing.push(ptTm06ToPixel(grid, p3763));
        } else {
          // LOCAL_PIXEL_METRIC (`x = col * scale`, `y = -row * scale`)
          const col = x / localPixelScaleM;
          const row = -y / localPixelScaleM;
          const p3763 = pixelToPtTm06(grid, col - 0.5, row - 0.5);
          pixelRing.push([col, row]);
          ring3763.push(p3763);
          ringWgs84.push(ptTm06ToWgs84(p3763));
        }
      }

      if (ring3763.length >= 3) {
        parsedPolygons.push({
          kind,
          ring3763,
          ringWgs84,
          pixelRing,
          confidence,
          sourceModel,
          speciesHint,
        });
      }
    }
  }

  // If the remote server returned an authoritative FeatureCollection without a separate SegFormer mask,
  // demote heuristic OBIA tree pixels to shrub/herbaceous before stamping the exact neural crowns & roofs!
  if (hasFeatureCollection && !segformerMask) {
    const neuralCrownsPresent = parsedPolygons.some((p) => p.kind === 'TREE_CROWN');
    const neuralBuildingsPresent = parsedPolygons.some((p) => p.kind === 'BUILDING');
    for (let i = 0; i < totalPixels; i++) {
      if (neuralCrownsPresent && semanticMask[i] === 5) {
        semanticMask[i] = landClass === 'FOREST_SCRUB' ? 4 : 3;
      }
      if (neuralBuildingsPresent && semanticMask[i] === 2) {
        semanticMask[i] = 0;
      }
    }
  }

  // Ensure known mapped buildings in `vectorContext` remain reflected on the semantic mask
  const parcelOpen3763 = cleanOpenRing3763(parcelVertices.map(projectWgs84ToPtTm06Exact));
  const parcelMp3763 = latLonRingToMultiPolygon3763(parcelVertices);
  const mappedBuildings = vectorContext?.buildings ?? [];
  const mappedBuildingRings3763: Pair[][] = [];
  for (const b of mappedBuildings) {
    const r3763 = cleanOpenRing3763(b.footprint.map(projectWgs84ToPtTm06Exact));
    if (r3763.length >= 3) {
      mappedBuildingRings3763.push(r3763);
      const pxRing = r3763.map((pt) => ptTm06ToPixel(grid, pt));
      rasterizePixelPolygonOntoMask(semanticMask, width, height, pxRing, 2);
    }
  }
  if (mappedBuildingRings3763.length === 0 && spatial.polygons.buildingFootprint.length >= 3) {
    const fallbackBldg = cleanOpenRing3763(
      spatial.polygons.buildingFootprint.map(projectWgs84ToPtTm06Exact)
    );
    if (fallbackBldg.length >= 3) {
      mappedBuildingRings3763.push(fallbackBldg);
      rasterizePixelPolygonOntoMask(
        semanticMask,
        width,
        height,
        fallbackBldg.map((pt) => ptTm06ToPixel(grid, pt)),
        2
      );
    }
  }

  // Stamp neural tree crowns (class 5) and neural buildings (class 2) onto semanticMask
  for (const poly of parsedPolygons) {
    if (poly.kind === 'TREE_CROWN') {
      rasterizePixelPolygonOntoMask(semanticMask, width, height, poly.pixelRing, 5);
    }
  }
  for (const poly of parsedPolygons) {
    if (poly.kind === 'BUILDING') {
      rasterizePixelPolygonOntoMask(semanticMask, width, height, poly.pixelRing, 2);
    }
  }

  // Step C: Build `DetectedRoofStructure[]` (from neural BUILDING polygons OR SegFormer class 2 components)
  const detectedRoofs: DetectedRoofStructure[] = [];
  const neuralBuildings = parsedPolygons.filter((p) => p.kind === 'BUILDING');

  if (neuralBuildings.length > 0) {
    neuralBuildings.forEach((bPoly, idx) => {
      const areaM2 = Number(Math.max(4, shoelaceArea3763(bPoly.ring3763)).toFixed(1));
      if (areaM2 < 6 || areaM2 > 4500) return;

      const cx = bPoly.ring3763.reduce((s, p) => s + p[0], 0) / bPoly.ring3763.length;
      const cy = bPoly.ring3763.reduce((s, p) => s + p[1], 0) / bPoly.ring3763.length;
      const centerPt: Pair = [cx, cy];

      let matchedOsm = false;
      for (const mRing of mappedBuildingRings3763) {
        const mCx = mRing.reduce((s, p) => s + p[0], 0) / mRing.length;
        const mCy = mRing.reduce((s, p) => s + p[1], 0) / mRing.length;
        if (
          isPointInRing3763(centerPt, mRing) ||
          Math.hypot(cx - mCx, cy - mCy) <= 5.5 ||
          minDistancePointToRingEdges3763(centerPt, mRing) <= 2.5
        ) {
          matchedOsm = true;
          break;
        }
      }

      const insideParcel = isPointInRing3763(centerPt, parcelOpen3763);
      const distEdge = insideParcel
        ? 0
        : Number(
            computeExternalPolygonDistanceToParcel3763(
              bPoly.ring3763,
              parcelMp3763,
              parcelOpen3763
            ).toFixed(1)
          );
      if (!insideParcel && distEdge > 60) return;

      const role: 'OWN' | 'NEIGHBOR' = insideParcel ? 'OWN' : 'NEIGHBOR';
      detectedRoofs.push({
        id: `cv-roof-${idx + 1}`,
        label: matchedOsm
          ? role === 'OWN'
            ? 'Edificação Principal Confirmada (ONNX 25 cm)'
            : 'Edifício Vizinho Confirmado (ONNX 25 cm)'
          : role === 'OWN'
            ? 'Anexo / Cobertura Omissa Detetada (ONNX 25 cm)'
            : 'Edificação Confinante Omissa Detetada (ONNX 25 cm)',
        centerWgs84: ptTm06ToWgs84(centerPt),
        areaM2,
        footprintWgs84: bPoly.ringWgs84,
        confidence: Number(Math.min(0.99, Math.max(0.5, bPoly.confidence)).toFixed(2)),
        isUnmappedInOsm: !matchedOsm,
        role,
        distanceToParcelEdgeM: distEdge,
      });
    });
  } else {
    // Connected components over semanticMask === 2 (SegFormer BUILT_ROOF_STRUCTURE or mapped footprints)
    const visitedRoof = new Uint8Array(totalPixels);
    const queue = new Int32Array(totalPixels);
    let roofSeq = 0;

    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const start = r * width + c;
        if (visitedRoof[start] || semanticMask[start] !== 2) continue;
        let head = 0;
        let tail = 0;
        queue[tail++] = start;
        visitedRoof[start] = 1;

        let sumCol = 0;
        let sumRow = 0;
        let minCol = c;
        let maxCol = c;
        let minRow = r;
        let maxRow = r;
        let count = 0;

        while (head < tail) {
          const cur = queue[head++];
          const cr = Math.floor(cur / width);
          const cc = cur - cr * width;
          sumCol += cc;
          sumRow += cr;
          if (cc < minCol) minCol = cc;
          if (cc > maxCol) maxCol = cc;
          if (cr < minRow) minRow = cr;
          if (cr > maxRow) maxRow = cr;
          count++;

          const neighbors = [
            cr > 0 ? (cr - 1) * width + cc : -1,
            cr + 1 < height ? (cr + 1) * width + cc : -1,
            cc > 0 ? cr * width + (cc - 1) : -1,
            cc + 1 < width ? cr * width + (cc + 1) : -1,
          ];
          for (const nb of neighbors) {
            if (nb >= 0 && !visitedRoof[nb] && semanticMask[nb] === 2) {
              visitedRoof[nb] = 1;
              queue[tail++] = nb;
            }
          }
        }

        const areaM2 = count * grid.pixelAreaM2;
        if (areaM2 < 8.5 || areaM2 > 2800) continue;
        roofSeq++;
        const centerPt = pixelToPtTm06(grid, sumCol / count, sumRow / count);

        let matchedOsm = false;
        for (const mRing of mappedBuildingRings3763) {
          const mCx = mRing.reduce((s, p) => s + p[0], 0) / mRing.length;
          const mCy = mRing.reduce((s, p) => s + p[1], 0) / mRing.length;
          if (
            isPointInRing3763(centerPt, mRing) ||
            Math.hypot(centerPt[0] - mCx, centerPt[1] - mCy) <= 5.5
          ) {
            matchedOsm = true;
            break;
          }
        }

        const nw = pixelToPtTm06(grid, minCol, minRow);
        const ne = pixelToPtTm06(grid, maxCol, minRow);
        const se = pixelToPtTm06(grid, maxCol, maxRow);
        const sw = pixelToPtTm06(grid, minCol, maxRow);
        const poly3763: Pair[] = [nw, sw, se, ne];
        const insideParcel = isPointInRing3763(centerPt, parcelOpen3763);
        const distEdge = insideParcel
          ? 0
          : Number(
              computeExternalPolygonDistanceToParcel3763(
                poly3763,
                parcelMp3763,
                parcelOpen3763
              ).toFixed(1)
            );
        if (!insideParcel && distEdge > 55) continue;

        const role: 'OWN' | 'NEIGHBOR' = insideParcel ? 'OWN' : 'NEIGHBOR';
        detectedRoofs.push({
          id: `cv-roof-${roofSeq}`,
          label: matchedOsm
            ? role === 'OWN'
              ? 'Edificação Principal Confirmada (SegFormer 25 cm)'
              : 'Edifício Vizinho Confirmado (SegFormer 25 cm)'
            : role === 'OWN'
              ? 'Anexo / Palheiro Omisso Detetado (SegFormer 25 cm)'
              : 'Edificação Confinante Omissa (SegFormer 25 cm)',
          centerWgs84: ptTm06ToWgs84(centerPt),
          areaM2: Number(areaM2.toFixed(1)),
          footprintWgs84: poly3763.map(ptTm06ToWgs84),
          confidence: matchedOsm ? 0.96 : 0.89,
          isUnmappedInOsm: !matchedOsm,
          role,
          distanceToParcelEdgeM: distEdge,
        });
      }
    }
  }

  // All building walls (mapped + newly detected roofs) for exact <5m crown-to-wall audit
  const allWallRings3763: Pair[][] = [...mappedBuildingRings3763];
  for (const dr of detectedRoofs) {
    if (dr.isUnmappedInOsm && dr.footprintWgs84.length >= 3) {
      allWallRings3763.push(cleanOpenRing3763(dr.footprintWgs84.map(projectWgs84ToPtTm06Exact)));
    }
  }

  // Legal boolean zone projections
  const mp = spatial.multiPolygons;
  const z1Polys = projectMultiPoly3763(mp?.zone1Immediate, spatial.polygons.zone1Immediate);
  const z2Polys = projectMultiPoly3763(mp?.zone2Near, spatial.polygons.zone2Near);
  const z3Polys = projectMultiPoly3763(mp?.zone3Extended, spatial.polygons.zone3Extended);
  const easementPolys = projectMultiPoly3763(
    mp?.thirdPartyCorridor,
    spatial.polygons.thirdPartyCorridor
  );

  // Step D: Build `DetectedTreeCrown[]` (from neural TREE_CROWN polygons OR SegFormer class 5 components)
  interface RawCrownItem {
    centerPt: Pair;
    areaM2: number;
    radiusM: number;
    polygonWgs84: LatLon[];
    speciesGroup: 'RESINOUS_EUCALYPT' | 'BROADLEAF_QUERCUS';
  }
  const rawCrowns: RawCrownItem[] = [];
  const neuralCrowns = parsedPolygons.filter((p) => p.kind === 'TREE_CROWN');

  if (neuralCrowns.length > 0) {
    for (const cPoly of neuralCrowns) {
      const areaM2 = Math.max(1.8, shoelaceArea3763(cPoly.ring3763));
      if (areaM2 > 650) continue;
      const cx = cPoly.ring3763.reduce((s, p) => s + p[0], 0) / cPoly.ring3763.length;
      const cy = cPoly.ring3763.reduce((s, p) => s + p[1], 0) / cPoly.ring3763.length;
      const centerPt: Pair = [cx, cy];
      const radiusM = Math.max(0.85, Math.sqrt(areaM2 / Math.PI));

      let speciesGroup: RawCrownItem['speciesGroup'] =
        cPoly.speciesHint ?? (landClass === 'FOREST_SCRUB' ? 'RESINOUS_EUCALYPT' : 'BROADLEAF_QUERCUS');

      if (!cPoly.speciesHint && rgba && rgba.length === totalPixels * 4) {
        const [pxC, pxR] = ptTm06ToPixel(grid, centerPt);
        const ic = Math.max(0, Math.min(width - 1, Math.round(pxC)));
        const ir = Math.max(0, Math.min(height - 1, Math.round(pxR)));
        const pBase = (ir * width + ic) * 4;
        const lum = 0.299 * rgba[pBase] + 0.587 * rgba[pBase + 1] + 0.114 * rgba[pBase + 2];
        speciesGroup =
          lum < 68 && landClass === 'FOREST_SCRUB' ? 'RESINOUS_EUCALYPT' : 'BROADLEAF_QUERCUS';
      }

      rawCrowns.push({
        centerPt,
        areaM2,
        radiusM,
        polygonWgs84: cPoly.ringWgs84,
        speciesGroup,
      });
    }
  } else if (!hasFeatureCollection) {
    // SegFormer semantic mask (`class === 5`) connected-component crown extraction
    const visitedCrown = new Uint8Array(totalPixels);
    const queue = new Int32Array(totalPixels);
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const start = r * width + c;
        if (visitedCrown[start] || semanticMask[start] !== 5) continue;
        let head = 0;
        let tail = 0;
        queue[tail++] = start;
        visitedCrown[start] = 1;
        let sumCol = 0;
        let sumRow = 0;
        let count = 0;

        while (head < tail) {
          const cur = queue[head++];
          const cr = Math.floor(cur / width);
          const cc = cur - cr * width;
          sumCol += cc;
          sumRow += cr;
          count++;

          const neighbors = [
            cr > 0 ? (cr - 1) * width + cc : -1,
            cr + 1 < height ? (cr + 1) * width + cc : -1,
            cc > 0 ? cr * width + (cc - 1) : -1,
            cc + 1 < width ? cr * width + (cc + 1) : -1,
          ];
          for (const nb of neighbors) {
            if (nb >= 0 && !visitedCrown[nb] && semanticMask[nb] === 5) {
              visitedCrown[nb] = 1;
              queue[tail++] = nb;
            }
          }
        }

        const areaM2 = count * grid.pixelAreaM2;
        if (areaM2 < 2.5 || areaM2 > 450) continue;
        const centerPt = pixelToPtTm06(grid, sumCol / count, sumRow / count);
        const radiusM = Math.max(1.0, Math.sqrt(areaM2 / Math.PI));
        const polyPts: LatLon[] = [];
        for (let s = 0; s < 12; s++) {
          const ang = (2 * Math.PI * s) / 12;
          polyPts.push(
            ptTm06ToWgs84([
              centerPt[0] + Math.cos(ang) * radiusM,
              centerPt[1] + Math.sin(ang) * radiusM,
            ])
          );
        }
        rawCrowns.push({
          centerPt,
          areaM2,
          radiusM,
          polygonWgs84: polyPts,
          speciesGroup: landClass === 'FOREST_SCRUB' ? 'RESINOUS_EUCALYPT' : 'BROADLEAF_QUERCUS',
        });
      }
    }
  }

  const crownsFull: DetectedTreeCrown[] = rawCrowns.map((rc, idx) => {
    const diameterM = Number((rc.radiusM * 2).toFixed(2));
    let minCenterToWall = Infinity;
    for (const bRing of allWallRings3763) {
      const d = minDistancePointToRingEdges3763(rc.centerPt, bRing);
      if (d < minCenterToWall) minCenterToWall = d;
    }
    const distanceToBuildingWallM = Number(Math.max(0, minCenterToWall - rc.radiusM).toFixed(2));

    let nearestCrownDistanceM = 99.9;
    for (let j = 0; j < rawCrowns.length; j++) {
      if (j === idx) continue;
      const other = rawCrowns[j];
      const centerDist = Math.hypot(
        rc.centerPt[0] - other.centerPt[0],
        rc.centerPt[1] - other.centerPt[1]
      );
      const edgeGap = Math.max(0, centerDist - rc.radiusM - other.radiusM);
      if (edgeGap < nearestCrownDistanceM) {
        nearestCrownDistanceM = Number(edgeGap.toFixed(2));
      }
    }

    const insideParcel = isPointInRing3763(rc.centerPt, parcelOpen3763);
    let zoneCode: DetectedTreeCrown['zoneCode'] = 'OUTSIDE';
    if (insideParcel) {
      if (isPointInProjectedMultiPoly(rc.centerPt, z1Polys)) zoneCode = 'ZONE_1';
      else if (isPointInProjectedMultiPoly(rc.centerPt, z2Polys)) zoneCode = 'ZONE_2';
      else if (isPointInProjectedMultiPoly(rc.centerPt, easementPolys)) zoneCode = 'EASEMENT';
      else if (isPointInProjectedMultiPoly(rc.centerPt, z3Polys)) zoneCode = 'ZONE_3';
      else zoneCode = 'EXEMPT';
    }

    const reqSpacingM =
      rc.speciesGroup === 'RESINOUS_EUCALYPT' && landClass === 'FOREST_SCRUB' ? 10.0 : 4.0;
    let violationRulePt: string | null = null;
    if (zoneCode === 'ZONE_1') {
      violationRulePt = 'Infração Zona 1 (0–2 m): Copa sobre faixa estritamente inerte';
    } else if (zoneCode !== 'OUTSIDE' && distanceToBuildingWallM < 5.0) {
      violationRulePt = `Infração Despacho 675/2026: Copa a ${distanceToBuildingWallM.toFixed(1)} m da parede (mín. 5,0 m)`;
    } else if (
      (zoneCode === 'ZONE_2' || zoneCode === 'ZONE_3') &&
      nearestCrownDistanceM < reqSpacingM
    ) {
      violationRulePt = `Infração ${zoneCode === 'ZONE_2' ? 'Zona 2' : 'Zona 3'}: Afastamento entre copas ${nearestCrownDistanceM.toFixed(1)} m (< ${reqSpacingM} m)`;
    }

    return {
      id: `neural-crown-${idx + 1}`,
      centerWgs84: ptTm06ToWgs84(rc.centerPt),
      centerPtTm06: {
        x: Number(rc.centerPt[0].toFixed(2)),
        y: Number(rc.centerPt[1].toFixed(2)),
      },
      areaM2: Number(rc.areaM2.toFixed(1)),
      diameterM,
      polygonWgs84: rc.polygonWgs84,
      speciesGroup: rc.speciesGroup,
      distanceToBuildingWallM,
      nearestCrownDistanceM,
      zoneCode,
      violationRulePt,
    };
  });

  crownsFull.sort((a, b) => {
    const aViol = a.violationRulePt ? 0 : 1;
    const bViol = b.violationRulePt ? 0 : 1;
    if (aViol !== bViol) return aViol - bViol;
    return a.distanceToBuildingWallM - b.distanceToBuildingWallM;
  });
  const crowns = crownsFull.slice(0, 64);

  // Step E: Compute 7-Class Parcel Areas, Legal Zone Compliance & RGBA PNG Overlay
  const overlayRgba = new Uint8ClampedArray(totalPixels * 4);
  const classPixelCountsInsideParcel = new Int32Array(7);

  let z1TotalPx = 0;
  let z1InertPx = 0;
  let z2TotalPx = 0;
  let z2CanopyPx = 0;
  let z2ShrubPx = 0;
  let z3TotalPx = 0;
  let z3CanopyPx = 0;
  let z3ShrubPx = 0;
  let easTotalPx = 0;
  let easIntrusionPx = 0;

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const idx = row * width + col;
      const clsIndex = Math.max(0, Math.min(6, semanticMask[idx]));
      const clsCode = ORTHOPHOTO_CLASS_ORDER[clsIndex];
      const meta = ORTHOPHOTO_CLASS_META[clsCode];
      const pt = pixelToPtTm06(grid, col, row);
      const insideParcel = isPointInRing3763(pt, parcelOpen3763);
      const outBase = idx * 4;

      if (insideParcel) {
        classPixelCountsInsideParcel[clsIndex]++;
        overlayRgba[outBase] = meta.rgbaOverlay[0];
        overlayRgba[outBase + 1] = meta.rgbaOverlay[1];
        overlayRgba[outBase + 2] = meta.rgbaOverlay[2];
        overlayRgba[outBase + 3] = meta.rgbaOverlay[3];

        if (isPointInProjectedMultiPoly(pt, z1Polys)) {
          z1TotalPx++;
          if (clsIndex === 0 || clsIndex === 1 || clsIndex === 2) z1InertPx++;
        } else if (isPointInProjectedMultiPoly(pt, z2Polys)) {
          z2TotalPx++;
          if (clsIndex === 5) z2CanopyPx++;
          if (clsIndex === 4) z2ShrubPx++;
        } else if (isPointInProjectedMultiPoly(pt, easementPolys)) {
          easTotalPx++;
          if (clsIndex === 4 || clsIndex === 5) easIntrusionPx++;
        } else if (isPointInProjectedMultiPoly(pt, z3Polys)) {
          z3TotalPx++;
          if (clsIndex === 5) z3CanopyPx++;
          if (clsIndex === 4) z3ShrubPx++;
        }
      } else {
        overlayRgba[outBase] = meta.rgbaOverlay[0];
        overlayRgba[outBase + 1] = meta.rgbaOverlay[1];
        overlayRgba[outBase + 2] = meta.rgbaOverlay[2];
        overlayRgba[outBase + 3] = clsIndex === 2 || clsIndex === 5 ? 64 : 0;
      }
    }
  }

  const totalParcelPx = Math.max(
    1,
    classPixelCountsInsideParcel.reduce((acc, v) => acc + v, 0)
  );
  const areaScale = spatial.totalAreaM2 / (totalParcelPx * grid.pixelAreaM2);
  const classAreasM2 = {} as Record<OrthophotoSemanticClass, number>;
  for (let c = 0; c < ORTHOPHOTO_CLASS_ORDER.length; c++) {
    classAreasM2[ORTHOPHOTO_CLASS_ORDER[c]] = Number(
      (classPixelCountsInsideParcel[c] * grid.pixelAreaM2 * areaScale).toFixed(1)
    );
  }

  const zone1BareMineralPct =
    z1TotalPx > 0 ? Number(((z1InertPx / z1TotalPx) * 100).toFixed(1)) : 100;
  const zone1Compliant = zone1BareMineralPct >= 85;
  const zone2CanopyPct =
    z2TotalPx > 0 ? Number(((z2CanopyPx / z2TotalPx) * 100).toFixed(1)) : 0;
  const zone2ShrubPct =
    z2TotalPx > 0 ? Number(((z2ShrubPx / z2TotalPx) * 100).toFixed(1)) : 0;
  const zone3CanopyPct =
    z3TotalPx > 0 ? Number(((z3CanopyPx / z3TotalPx) * 100).toFixed(1)) : 0;
  const zone3ShrubPct =
    z3TotalPx > 0 ? Number(((z3ShrubPx / z3TotalPx) * 100).toFixed(1)) : 0;
  const easementCanopyIntrusionPct =
    easTotalPx > 0 ? Number(((easIntrusionPx / easTotalPx) * 100).toFixed(1)) : 0;

  const zone2CrownsUnder5mCount = crowns.filter(
    (c) => c.zoneCode !== 'OUTSIDE' && c.distanceToBuildingWallM < 5.0
  ).length;
  const crownSpacingViolationsCount = crowns.filter(
    (c) =>
      (c.zoneCode === 'ZONE_2' || c.zoneCode === 'ZONE_3') &&
      c.distanceToBuildingWallM >= 5.0 &&
      c.violationRulePt !== null &&
      c.violationRulePt.includes('Afastamento')
  ).length;

  const z3Crowns = crowns.filter((c) => c.zoneCode === 'ZONE_2' || c.zoneCode === 'ZONE_3');
  const zone3MeanCrownSpacingM =
    z3Crowns.length >= 2
      ? Number(
          (
            z3Crowns.reduce((s, c) => s + Math.min(25, c.nearestCrownDistanceM), 0) /
            z3Crowns.length
          ).toFixed(1)
        )
      : 12.0;

  let overallStatus: ZoneCvComplianceMetrics['overallStatus'] = 'COMPLIANT';
  if (zone2CrownsUnder5mCount > 0 || crownSpacingViolationsCount > 0 || !zone1Compliant) {
    overallStatus =
      zone2CrownsUnder5mCount > 0 || zone1BareMineralPct < 60 ? 'NON_COMPLIANT' : 'ATTENTION';
  } else if (zone3ShrubPct > 25 || easementCanopyIntrusionPct > 20) {
    overallStatus = 'ATTENTION';
  }

  const unmappedRoofsCount = detectedRoofs.filter((r) => r.isUnmappedInOsm).length;
  const auditParts: string[] = [];
  if (!zone1Compliant) {
    auditParts.push(`Zona 1 com ${zone1BareMineralPct}% inerte (alvo ≥85%)`);
  } else {
    auditParts.push(`Zona 1 conforme (${zone1BareMineralPct}% inerte)`);
  }
  if (zone2CrownsUnder5mCount > 0) {
    auditParts.push(`${zone2CrownsUnder5mCount} copa(s) a <5 m da parede`);
  }
  if (crownSpacingViolationsCount > 0) {
    auditParts.push(`${crownSpacingViolationsCount} copa(s) c/ afastamento insuficiente`);
  }
  if (unmappedRoofsCount > 0) {
    auditParts.push(`${unmappedRoofsCount} anexo(s)/edifício(s) omisso(s) no OSM`);
  }

  const zoneCompliance: ZoneCvComplianceMetrics = {
    zone1BareMineralPct,
    zone1Compliant,
    zone2CanopyPct,
    zone2ShrubPct,
    zone2CrownsUnder5mCount,
    zone3CanopyPct,
    zone3ShrubPct,
    zone3MeanCrownSpacingM,
    crownSpacingViolationsCount,
    easementCanopyIntrusionPct,
    overallStatus,
    auditSummaryPt: auditParts.join(' · '),
  };

  const pngOut = new PNG({ width, height });
  pngOut.data = Buffer.from(overlayRgba.buffer, overlayRgba.byteOffset, overlayRgba.byteLength);
  const overlayDataUrl = `data:image/png;base64,${PNG.sync.write(pngOut).toString('base64')}`;

  if (sourceModelsSet.size === 0) {
    sourceModelsSet.add(configuredModelProfile);
  }
  const sourceModels = Array.from(sourceModelsSet);
  const resolvedProfile = sourceModels.join(' + ');

  return {
    cvAnalysis: {
      analyzedAtIso: new Date().toISOString(),
      engineMode: 'ONNX_MICROSERVICE',
      imagerySourceLabel,
      modelProfile: resolvedProfile,
      rasterWidthPx: width,
      rasterHeightPx: height,
      gsdMetersPerPx: grid.gsdMetersPerPx,
      bboxWgs84: grid.bboxWgs84,
      leafletBounds: grid.leafletBounds,
      overlayDataUrl,
      classAreasM2,
      crowns,
      detectedRoofs,
      unmappedRoofsCount,
      zoneCompliance,
    },
    sourceModels,
  };
}

/**
 * End-to-end Node.js server orchestrator:
 * 1. Prepares or acquires a 3-channel RGB cropped orthophoto image (`PreparedOrthophotoCrop`),
 * 2. Sends it to `ORTHOPHOTO_CV_SERVICE_URL` (`POST /v1/analyze` multipart OR `POST /api/analyze-contract` JSON),
 * 3. Processes the SegFormer / OrthoSeg KVM response into `ParcelOrthophotoCvAnalysis` (`engineMode: 'ONNX_MICROSERVICE'`),
 * 4. Seamlessly falls back to local OBIA pixel segmentation only if the remote inference service is disabled or unreachable.
 */
export async function executeRemoteOrthophotoInference(params: {
  parcelVertices: LatLon[];
  landClass: LandClass;
  spatial: SpatialZoneBreakdown;
  vectorContext?: ParcelVectorContext;
  croppedImageBase64?: string;
  rawImageBuffer?: Buffer;
  bboxWgs84?: [number, number, number, number];
  cropRect?: PixelCropRect;
  serviceUrl?: string;
  apiKey?: string;
  modelProfile?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<{
  cvAnalysis: ParcelOrthophotoCvAnalysis;
  telemetry: RemoteInferenceTelemetry;
}> {
  const startedAt = Date.now();
  const fetchFn = params.fetchImpl ?? fetch;
  const modelProfile =
    params.modelProfile?.trim() ||
    process.env.ORTHOPHOTO_ONNX_PROFILE?.trim() ||
    'yolo11s-seg+segformer-b2-dgt25cm';

  // 1. Prepare cropped 3-channel RGB orthophoto
  let prepared: PreparedOrthophotoCrop;
  let fallbackEngineMode: ParcelOrthophotoCvAnalysis['engineMode'] = 'REAL_ORTHOPHOTO_PIXEL_CV';

  if (params.rawImageBuffer || (params.croppedImageBase64 && params.croppedImageBase64.trim())) {
    prepared = prepareUploadedOrthophotoCrop({
      imageBase64: params.croppedImageBase64,
      rawImageBuffer: params.rawImageBuffer,
      parcelVertices: params.parcelVertices,
      bboxWgs84: params.bboxWgs84,
      cropRect: params.cropRect,
    });
  } else {
    const acquired = await acquireServerCroppedParcelOrthophoto({
      parcelVertices: params.parcelVertices,
      landClass: params.landClass,
      spatial: params.spatial,
      vectorContext: params.vectorContext,
      bboxWgs84: params.bboxWgs84,
      cropRect: params.cropRect,
      targetMaxDimPx: 400,
      fetchImpl: fetchFn,
    });
    prepared = acquired;
    fallbackEngineMode = acquired.fallbackEngineMode;
  }

  // 2. Resolve remote `ORTHOPHOTO_CV_SERVICE_URL`
  const resolvedUrl = resolveConfiguredOrthophotoServiceUrl(params.serviceUrl);
  const apiKey = params.apiKey ?? process.env.ORTHOPHOTO_CV_API_KEY?.trim();

  if (resolvedUrl) {
    const endpoints = resolveOrthophotoServiceEndpoints(resolvedUrl);
    const health = await probeOrthophotoServiceHealth({
      serviceUrl: resolvedUrl,
      apiKey,
      timeoutMs: 3200,
      fetchImpl: fetchFn,
    });

    const primaryMultipartUrl = health.reachable
      ? health.analyzeEndpoint
      : endpoints.multipartAnalyzeUrl;
    const timeoutMs = Math.max(3000, params.timeoutMs ?? 25_000);

    const attemptMultipart = async (targetUrl: string) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const form = new FormData();
        const blob = new Blob([Uint8Array.from(prepared.imageBuffer)], {
          type: prepared.mimeType,
        });
        form.append('file', blob, prepared.filename);
        form.append('bbox_wgs84', JSON.stringify(prepared.grid.bboxWgs84));
        form.append('gsd_m', String(prepared.grid.gsdMetersPerPx));
        form.append('model_profile', modelProfile);

        const headers: Record<string, string> = {
          Accept: 'application/json',
        };
        if (apiKey) {
          headers.Authorization = `Bearer ${apiKey}`;
        }

        const resp = await fetchFn(targetUrl, {
          method: 'POST',
          headers,
          body: form,
          signal: ctrl.signal,
        });
        if (!resp.ok) {
          return { ok: false as const, status: resp.status, json: null };
        }
        const json = (await resp.json()) as Record<string, unknown>;
        return { ok: true as const, status: resp.status, json };
      } finally {
        clearTimeout(timer);
      }
    };

    const attemptJsonContract = async (targetUrl: string) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        };
        if (apiKey) {
          headers.Authorization = `Bearer ${apiKey}`;
        }
        const resp = await fetchFn(targetUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            specVersion: 'SGIFR-ORTHOPHOTO-ONNX-V2',
            modelProfile,
            imageBase64: prepared.imageBuffer.toString('base64'),
            mimeType: prepared.mimeType,
            width: prepared.width,
            height: prepared.height,
            bboxWgs84: prepared.grid.bboxWgs84,
            gsdMetersPerPx: prepared.grid.gsdMetersPerPx,
            parcelVertices: params.parcelVertices,
            landClass: params.landClass,
            vectorContext: params.vectorContext,
          }),
          signal: ctrl.signal,
        });
        if (!resp.ok) {
          return { ok: false as const, status: resp.status, json: null };
        }
        const json = (await resp.json()) as Record<string, unknown>;
        return { ok: true as const, status: resp.status, json };
      } finally {
        clearTimeout(timer);
      }
    };

    let lastStatusHttp: number | undefined;
    let fallbackReason = 'Remote endpoint unreachable';

    try {
      if (endpoints.preferredProtocol === 'JSON_CONTRACT') {
        const resContract = await attemptJsonContract(endpoints.segformerContractUrl);
        lastStatusHttp = resContract.status;
        if (resContract.ok && resContract.json) {
          const processed = processRemoteInferencePayloadToCvAnalysis({
            remotePayload: resContract.json,
            grid: prepared.grid,
            rgba: prepared.rgba,
            parcelVertices: params.parcelVertices,
            landClass: params.landClass,
            spatial: params.spatial,
            vectorContext: params.vectorContext,
            imagerySourceLabel: `${prepared.sourceLabel} · SegFormer Remoto`,
            configuredModelProfile: modelProfile,
          });
          return {
            cvAnalysis: processed.cvAnalysis,
            telemetry: {
              usedRemoteService: true,
              endpointCalled: endpoints.segformerContractUrl,
              protocolUsed: 'JSON_CONTRACT',
              elapsedMs: Date.now() - startedAt,
              remoteStatusHttp: resContract.status,
              executionMode: health.executionMode,
              remoteWorkers: health.workers,
              sourceModels: processed.sourceModels,
            },
          };
        }
        // Fallback to multipart /v1/analyze on the same host if /api/analyze-contract returned 404/405
        if (resContract.status === 404 || resContract.status === 405) {
          const resMulti = await attemptMultipart(primaryMultipartUrl);
          lastStatusHttp = resMulti.status;
          if (resMulti.ok && resMulti.json) {
            const processed = processRemoteInferencePayloadToCvAnalysis({
              remotePayload: resMulti.json,
              grid: prepared.grid,
              rgba: prepared.rgba,
              parcelVertices: params.parcelVertices,
              landClass: params.landClass,
              spatial: params.spatial,
              vectorContext: params.vectorContext,
              imagerySourceLabel: `${prepared.sourceLabel} · OrthoSeg KVM`,
              configuredModelProfile: modelProfile,
            });
            return {
              cvAnalysis: processed.cvAnalysis,
              telemetry: {
                usedRemoteService: true,
                endpointCalled: primaryMultipartUrl,
                protocolUsed: 'MULTIPART_ANALYZE',
                elapsedMs: Date.now() - startedAt,
                remoteStatusHttp: resMulti.status,
                executionMode: health.executionMode,
                remoteWorkers: health.workers,
                sourceModels: processed.sourceModels,
              },
            };
          }
        }
        fallbackReason = `HTTP ${lastStatusHttp ?? 'error'}`;
      } else {
        const resMulti = await attemptMultipart(primaryMultipartUrl);
        lastStatusHttp = resMulti.status;
        if (resMulti.ok && resMulti.json) {
          const processed = processRemoteInferencePayloadToCvAnalysis({
            remotePayload: resMulti.json,
            grid: prepared.grid,
            rgba: prepared.rgba,
            parcelVertices: params.parcelVertices,
            landClass: params.landClass,
            spatial: params.spatial,
            vectorContext: params.vectorContext,
            imagerySourceLabel: `${prepared.sourceLabel} · OrthoSeg KVM`,
            configuredModelProfile: modelProfile,
          });
          return {
            cvAnalysis: processed.cvAnalysis,
            telemetry: {
              usedRemoteService: true,
              endpointCalled: primaryMultipartUrl,
              protocolUsed: 'MULTIPART_ANALYZE',
              elapsedMs: Date.now() - startedAt,
              remoteStatusHttp: resMulti.status,
              executionMode: health.executionMode,
              remoteWorkers: health.workers,
              sourceModels: processed.sourceModels,
            },
          };
        }
        // Secondary attempt on /api/analyze-contract if /v1/analyze returned 404/405
        if (resMulti.status === 404 || resMulti.status === 405) {
          const resContract = await attemptJsonContract(endpoints.segformerContractUrl);
          lastStatusHttp = resContract.status;
          if (resContract.ok && resContract.json) {
            const processed = processRemoteInferencePayloadToCvAnalysis({
              remotePayload: resContract.json,
              grid: prepared.grid,
              rgba: prepared.rgba,
              parcelVertices: params.parcelVertices,
              landClass: params.landClass,
              spatial: params.spatial,
              vectorContext: params.vectorContext,
              imagerySourceLabel: `${prepared.sourceLabel} · SegFormer Remoto`,
              configuredModelProfile: modelProfile,
            });
            return {
              cvAnalysis: processed.cvAnalysis,
              telemetry: {
                usedRemoteService: true,
                endpointCalled: endpoints.segformerContractUrl,
                protocolUsed: 'JSON_CONTRACT',
                elapsedMs: Date.now() - startedAt,
                remoteStatusHttp: resContract.status,
                executionMode: health.executionMode,
                remoteWorkers: health.workers,
                sourceModels: processed.sourceModels,
              },
            };
          }
        }
        fallbackReason = `HTTP ${lastStatusHttp ?? 'error'}`;
      }
    } catch (err) {
      fallbackReason = err instanceof Error ? err.message : 'Timeout / network error';
    }

    // Remote failed -> execute local pixel OBIA fallback
    const localRgba =
      prepared.rgba ??
      new Uint8Array(
        synthesizeDeterministicParcelOrthophotoRgba({
          grid: prepared.grid,
          parcelVertices: params.parcelVertices,
          landClass: params.landClass,
          spatial: params.spatial,
          vectorContext: params.vectorContext,
        }).buffer
      );

    const localOut = runOrthophotoPixelPipeline({
      rgba: localRgba,
      grid: prepared.grid,
      parcelVertices: params.parcelVertices,
      landClass: params.landClass,
      spatial: params.spatial,
      vectorContext: params.vectorContext,
      imagerySourceLabel: prepared.sourceLabel,
      engineMode: fallbackEngineMode,
      modelProfile,
    });

    const pngOut = new PNG({ width: prepared.width, height: prepared.height });
    pngOut.data = Buffer.from(
      localOut.overlayRgba.buffer,
      localOut.overlayRgba.byteOffset,
      localOut.overlayRgba.byteLength
    );
    return {
      cvAnalysis: {
        ...localOut.analysis,
        overlayDataUrl: `data:image/png;base64,${PNG.sync.write(pngOut).toString('base64')}`,
      },
      telemetry: {
        usedRemoteService: false,
        endpointCalled: primaryMultipartUrl,
        protocolUsed: 'LOCAL_OBIA_FALLBACK',
        elapsedMs: Date.now() - startedAt,
        remoteStatusHttp: lastStatusHttp,
        sourceModels: [modelProfile],
        fallbackReason,
      },
    };
  }

  // Service explicitly disabled -> local pixel OBIA
  const localRgba =
    prepared.rgba ??
    new Uint8Array(
      synthesizeDeterministicParcelOrthophotoRgba({
        grid: prepared.grid,
        parcelVertices: params.parcelVertices,
        landClass: params.landClass,
        spatial: params.spatial,
        vectorContext: params.vectorContext,
      }).buffer
    );
  const localOut = runOrthophotoPixelPipeline({
    rgba: localRgba,
    grid: prepared.grid,
    parcelVertices: params.parcelVertices,
    landClass: params.landClass,
    spatial: params.spatial,
    vectorContext: params.vectorContext,
    imagerySourceLabel: prepared.sourceLabel,
    engineMode: fallbackEngineMode,
    modelProfile,
  });
  const pngOut = new PNG({ width: prepared.width, height: prepared.height });
  pngOut.data = Buffer.from(
    localOut.overlayRgba.buffer,
    localOut.overlayRgba.byteOffset,
    localOut.overlayRgba.byteLength
  );
  return {
    cvAnalysis: {
      ...localOut.analysis,
      overlayDataUrl: `data:image/png;base64,${PNG.sync.write(pngOut).toString('base64')}`,
    },
    telemetry: {
      usedRemoteService: false,
      endpointCalled: null,
      protocolUsed: 'LOCAL_OBIA_FALLBACK',
      elapsedMs: Date.now() - startedAt,
      sourceModels: [modelProfile],
      fallbackReason: 'ORTHOPHOTO_CV_SERVICE_URL disabled',
    },
  };
}
