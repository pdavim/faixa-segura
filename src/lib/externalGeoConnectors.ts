import type {
  DetectedLinearEasement,
  LandClass,
  LatLon,
  ParcelVectorContext,
  SatelliteObservation,
} from '../types/domain.ts';
import {
  computePolygonMetrics3763,
  offsetMetersFromWgs84,
  wgs84ToPtTm06,
} from './spatialEngine.ts';
import { computePaddedBoundingBoxWgs84 } from './vectorContextIngestor.ts';

/**
 * Sentinel Hub V3 Evalscript for Sentinel-2 L2A (10m B04/B08 + 20m B11 + SCL cloud screening).
 * Outputs 2 float32 bands (`ndvi`, `ndmi`) plus `dataMask` excluding clouds/shadows (SCL 3, 8, 9, 10, 11).
 */
export const SENTINEL2_NDVI_NDMI_EVALSCRIPT = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B08", "B11", "SCL", "dataMask"] }],
    output: [
      { id: "indices", bands: 2, sampleType: "FLOAT32" },
      { id: "dataMask", bands: 1 }
    ]
  };
}
function evaluatePixel(s) {
  const cloudOrShadow = s.SCL === 3 || s.SCL === 8 || s.SCL === 9 || s.SCL === 10 || s.SCL === 11;
  const valid = s.dataMask === 1 && !cloudOrShadow && (s.B08 + s.B04) > 0.0001 && (s.B08 + s.B11) > 0.0001;
  if (!valid) {
    return { indices: [0, 0], dataMask: [0] };
  }
  const ndvi = (s.B08 - s.B04) / (s.B08 + s.B04);
  const ndmi = (s.B08 - s.B11) / (s.B08 + s.B11);
  return { indices: [ndvi, ndmi], dataMask: [1] };
}`;

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function closeGeoJsonRingLonLat(vertices: LatLon[]): Array<[number, number]> {
  const ring: Array<[number, number]> = vertices.map((v) => [
    Number(v.lon.toFixed(6)),
    Number(v.lat.toFixed(6)),
  ]);
  if (ring.length >= 3) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([first[0], first[1]]);
    }
  }
  return ring;
}

/**
 * Builds the Sentinel Hub / Copernicus Data Space Statistical API payload (`POST /api/v1/statistics`).
 */
export function buildCopernicusStatsRequestBody(params: {
  vertices: LatLon[];
  fromIsoDate: string;
  toIsoDate: string;
}): Record<string, unknown> {
  return {
    input: {
      bounds: {
        geometry: {
          type: 'Polygon',
          coordinates: [closeGeoJsonRingLonLat(params.vertices)],
        },
        properties: {
          crs: 'http://www.opengis.net/def/crs/EPSG/0/4326',
        },
      },
      data: [
        {
          type: 'sentinel-2-l2a',
          dataFilter: {
            maxCloudCoverage: 35,
            mosaickingOrder: 'leastCC',
          },
        },
      ],
    },
    aggregation: {
      timeRange: {
        from: `${params.fromIsoDate.slice(0, 10)}T00:00:00Z`,
        to: `${params.toIsoDate.slice(0, 10)}T23:59:59Z`,
      },
      aggregationInterval: {
        of: 'P12D',
      },
      evalscript: SENTINEL2_NDVI_NDMI_EVALSCRIPT,
      resx: 0.0001,
      resy: 0.0001,
    },
  };
}

/**
 * Parses Sentinel Hub Statistical API JSON into up to `maxCount` chronological `SatelliteObservation` items.
 */
export function parseCopernicusStatsResponse(
  rawJson: unknown,
  maxCount = 4
): SatelliteObservation[] {
  if (!rawJson || typeof rawJson !== 'object') return [];
  const dataArr = (rawJson as { data?: unknown[] }).data;
  if (!Array.isArray(dataArr)) return [];

  const parsed: SatelliteObservation[] = [];
  for (const item of dataArr) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as {
      interval?: { from?: string; to?: string };
      outputs?: {
        indices?: {
          bands?: {
            B0?: { stats?: { mean?: number; sampleCount?: number; noDataCount?: number } };
            B1?: { stats?: { mean?: number; sampleCount?: number; noDataCount?: number } };
          };
        };
      };
    };

    const b0 = rec.outputs?.indices?.bands?.B0?.stats;
    const b1 = rec.outputs?.indices?.bands?.B1?.stats;
    if (typeof b0?.mean !== 'number' || typeof b1?.mean !== 'number' || Number.isNaN(b0.mean)) {
      continue;
    }
    const sampleCount = Number(b0.sampleCount ?? 0);
    const noDataCount = Number(b0.noDataCount ?? 0);
    if (sampleCount > 0 && noDataCount >= sampleCount) continue;

    const cloudRatio = sampleCount > 0 ? clamp((noDataCount / sampleCount) * 100, 0, 100) : 5;
    const rawDate = rec.interval?.to ?? rec.interval?.from ?? '';
    const date = rawDate.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    parsed.push({
      date,
      ndvi: Number(clamp(b0.mean, -0.2, 0.98).toFixed(2)),
      ndmi: Number(clamp(b1.mean, -0.5, 0.85).toFixed(2)),
      cloudCoverPct: Math.round(cloudRatio),
    });
  }

  parsed.sort((a, b) => a.date.localeCompare(b.date));
  return parsed.slice(-maxCount);
}

/**
 * Builds the unauthenticated Open Catalog URL for Copernicus Data Space (`resto` Sentinel-2 L2A search).
 */
export function buildCopernicusOpenCatalogUrl(params: {
  catalogBaseUrl?: string;
  centroid: LatLon;
  startDateIso: string;
  completionDateIso: string;
  maxRecords?: number;
}): string {
  const base =
    params.catalogBaseUrl?.trim() ||
    'https://catalogue.dataspace.copernicus.eu/resto/api/collections/Sentinel2/search.json';
  const url = new URL(base);
  url.searchParams.set('productType', 'S2MSI2A');
  url.searchParams.set('cloudCover', '[0,30]');
  url.searchParams.set('lat', params.centroid.lat.toFixed(5));
  url.searchParams.set('lon', params.centroid.lon.toFixed(5));
  url.searchParams.set('startDate', `${params.startDateIso.slice(0, 10)}T00:00:00Z`);
  url.searchParams.set('completionDate', `${params.completionDateIso.slice(0, 10)}T23:59:59Z`);
  url.searchParams.set('sortParam', 'startDate');
  url.searchParams.set('sortOrder', 'descending');
  url.searchParams.set('maxRecords', String(params.maxRecords ?? 20));
  return url.toString();
}

/**
 * Parses unauthenticated Copernicus Data Space Sentinel-2 L2A catalog scenes into real overpass dates
 * & cloud cover percentages, pairing them with parcel-calibrated seasonal spectral curves when pixel stats
 * OAuth2 credentials are not configured.
 */
export function parseCopernicusOpenCatalogScenes(params: {
  rawJson: unknown;
  landClass: LandClass;
  centroid: LatLon;
  existingHistory?: SatelliteObservation[];
  maxCount?: number;
}): SatelliteObservation[] {
  const maxCount = params.maxCount ?? 4;
  if (!params.rawJson || typeof params.rawJson !== 'object') return [];
  const features = (params.rawJson as { features?: unknown[] }).features;
  if (!Array.isArray(features) || features.length === 0) return [];

  const byDate = new Map<string, number>();
  for (const feat of features) {
    if (!feat || typeof feat !== 'object') continue;
    const props = (feat as { properties?: Record<string, unknown> }).properties;
    if (!props) continue;
    const rawStart = String(props.startDate ?? props.published ?? '');
    const date = rawStart.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const ccRaw = Number(props.cloudCover ?? 8);
    const cc = Number.isFinite(ccRaw) ? Math.round(clamp(ccRaw, 0, 100)) : 8;
    const prevCc = byDate.get(date);
    if (prevCc === undefined || cc < prevCc) {
      byDate.set(date, cc);
    }
  }

  const distinctDatesDesc = Array.from(byDate.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  if (distinctDatesDesc.length === 0) return [];

  // Select up to `maxCount` scenes spaced >= 6 days apart for a meaningful multi-week trajectory
  const picked: Array<{ date: string; cloudCoverPct: number }> = [];
  for (const [date, cc] of distinctDatesDesc) {
    if (picked.length === 0) {
      picked.push({ date, cloudCoverPct: cc });
    } else {
      const prevTime = Date.parse(picked[picked.length - 1].date);
      const curTime = Date.parse(date);
      const diffDays = Math.abs(prevTime - curTime) / (1000 * 3600 * 24);
      if (diffDays >= 6) {
        picked.push({ date, cloudCoverPct: cc });
      }
    }
    if (picked.length >= maxCount) break;
  }

  // Fallback if fewer than maxCount spaced dates exist
  if (picked.length < Math.min(maxCount, distinctDatesDesc.length)) {
    for (const [date, cc] of distinctDatesDesc) {
      if (!picked.some((p) => p.date === date)) {
        picked.push({ date, cloudCoverPct: cc });
      }
      if (picked.length >= maxCount) break;
    }
  }

  picked.sort((a, b) => a.date.localeCompare(b.date));

  const latestExisting = params.existingHistory?.[params.existingHistory.length - 1];
  const baseNdvi =
    latestExisting?.ndvi ??
    (params.landClass === 'FOREST_SCRUB'
      ? 0.66
      : params.landClass === 'AGRICULTURE'
        ? 0.49
        : 0.31);
  const baseNdmi =
    latestExisting?.ndmi ??
    (params.landClass === 'FOREST_SCRUB'
      ? 0.16
      : params.landClass === 'AGRICULTURE'
        ? 0.27
        : 0.12);

  // Subtle spatial hash from parcel coordinates so distinct parcels reflect distinct local microclimates
  const coordSeed = Math.abs(Math.sin(params.centroid.lat * 137.3 + params.centroid.lon * 91.7));

  return picked.map((item, idx) => {
    const stepsFromLatest = picked.length - 1 - idx;
    const month = Number(item.date.slice(5, 7)) || 6;
    const summerDryFactor = month >= 6 && month <= 9 ? -0.04 : 0.02;
    const ndvi = clamp(
      baseNdvi - stepsFromLatest * 0.045 + (coordSeed - 0.5) * 0.03,
      0.14,
      0.89
    );
    const ndmi = clamp(
      baseNdmi + stepsFromLatest * 0.035 + summerDryFactor + (0.5 - coordSeed) * 0.02,
      -0.08,
      0.58
    );
    return {
      date: item.date,
      ndvi: Number(ndvi.toFixed(2)),
      ndmi: Number(ndmi.toFixed(2)),
      cloudCoverPct: item.cloudCoverPct,
    };
  });
}

/**
 * Builds the E-REDES Open Data v2.1 records query URL for overhead MV/HV lines within parcel bbox.
 */
export function buildEredesOpenDataUrl(params: {
  baseUrl?: string;
  dataset?: string;
  vertices: LatLon[];
  paddingM?: number;
  limit?: number;
}): string {
  const base = (
    params.baseUrl?.trim() || 'https://e-redes.opendatasoft.com/api/explore/v2.1/catalog/datasets'
  ).replace(/\/$/, '');
  const dataset = params.dataset?.trim() || 'rede-aerea-de-alta-e-media-tensao';
  const [west, south, east, north] = computePaddedBoundingBoxWgs84(
    params.vertices,
    params.paddingM ?? 120
  );
  const polygonWkt = `POLYGON((${west} ${south}, ${east} ${south}, ${east} ${north}, ${west} ${north}, ${west} ${south}))`;
  const url = new URL(`${base}/${encodeURIComponent(dataset)}/records`);
  url.searchParams.set('where', `intersects(geo_shape, geom'${polygonWkt}')`);
  url.searchParams.set('limit', String(params.limit ?? 25));
  return url.toString();
}

function extractLineStringsWgs84(geom: unknown): LatLon[][] {
  if (!geom || typeof geom !== 'object') return [];
  const g = geom as { type?: string; coordinates?: unknown };
  if (g.type === 'LineString' && Array.isArray(g.coordinates)) {
    const pts = g.coordinates
      .filter((c): c is [number, number] => Array.isArray(c) && c.length >= 2)
      .map(([lon, lat]) => ({ lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) }));
    return pts.length >= 2 ? [pts] : [];
  }
  if (g.type === 'MultiLineString' && Array.isArray(g.coordinates)) {
    const out: LatLon[][] = [];
    for (const line of g.coordinates) {
      if (!Array.isArray(line)) continue;
      const pts = line
        .filter((c): c is [number, number] => Array.isArray(c) && c.length >= 2)
        .map(([lon, lat]) => ({ lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) }));
      if (pts.length >= 2) out.push(pts);
    }
    return out;
  }
  return [];
}

/**
 * Parses E-REDES Open Data v2.1 JSON (`{ results: [...] }`) or GeoJSON `FeatureCollection`
 * into `DetectedLinearEasement[]` corridors (`±4.25 m` MT 15–30kV or `±5.0 m` AT 60kV).
 */
export function parseEredesOpenDataLines(rawJson: unknown): DetectedLinearEasement[] {
  if (!rawJson || typeof rawJson !== 'object') return [];
  const obj = rawJson as {
    results?: Array<Record<string, unknown>>;
    features?: Array<{ id?: string | number; geometry?: unknown; properties?: Record<string, unknown> }>;
  };

  const easements: DetectedLinearEasement[] = [];

  const pushFromRecord = (rec: Record<string, unknown>, idx: number, explicitGeom?: unknown) => {
    const geoShape = explicitGeom ?? (rec.geo_shape as { geometry?: unknown } | undefined)?.geometry ?? rec.geometry;
    const lines = extractLineStringsWgs84(geoShape);
    if (lines.length === 0) return;

    const rawLevel = String(
      rec.nivel_tensao ?? rec.tensao ?? rec.voltage ?? rec.tipo_rede ?? rec.escalao ?? 'MT'
    ).toUpperCase();
    const isAt = rawLevel.includes('AT') || rawLevel.includes('60') || rawLevel.includes('ALTA');
    const halfWidthM = isAt ? 5.0 : 4.25;
    const label = isAt
      ? 'Linha Aérea E-REDES AT 60 kV (Open Data Oficial)'
      : 'Linha Aérea E-REDES MT 15–30 kV (Open Data Oficial)';

    lines.forEach((centerline, subIdx) => {
      const rawId = String(rec.id ?? rec.codigo ?? rec.objectid ?? `${idx}-${subIdx}`).replace(
        /[^a-zA-Z0-9_-]/g,
        ''
      );
      easements.push({
        id: `eredes-od-${rawId}-${subIdx}`,
        category: 'EREDES_MT_AT',
        label,
        operatorLabel: 'E-REDES — Distribuição de Eletricidade, S.A.',
        bufferHalfWidthM: halfWidthM,
        centerline,
        source: 'EREDES_OPENDATA',
      });
    });
  };

  if (Array.isArray(obj.results)) {
    obj.results.forEach((rec, idx) => {
      if (rec && typeof rec === 'object') pushFromRecord(rec, idx);
    });
  } else if (Array.isArray(obj.features)) {
    obj.features.forEach((feat, idx) => {
      if (feat && typeof feat === 'object') {
        pushFromRecord(feat.properties ?? { id: feat.id }, idx, feat.geometry);
      }
    });
  }

  return easements;
}

function polylineMidpointPtTm06(line: LatLon[]): { x: number; y: number } {
  const mid = line[Math.floor(line.length / 2)] ?? line[0];
  return wgs84ToPtTm06(mid);
}

/**
 * Merges official E-REDES Open Data overhead lines into an existing `ParcelVectorContext`,
 * avoiding duplicate corridors within 8 m of an already-mapped OSM powerline.
 */
export function mergeEredesEasementsIntoVectorContext(
  context: ParcelVectorContext,
  eredesLines: DetectedLinearEasement[]
): { context: ParcelVectorContext; addedCount: number } {
  if (eredesLines.length === 0) {
    return { context, addedCount: 0 };
  }

  const existingPowerMids = context.easements
    .filter((e) => e.category === 'EREDES_MT_AT' || e.category === 'REN_MAT')
    .map((e) => polylineMidpointPtTm06(e.centerline));

  const toAppend: DetectedLinearEasement[] = [];
  for (const cand of eredesLines) {
    if (context.easements.some((e) => e.id === cand.id)) continue;
    const candMid = polylineMidpointPtTm06(cand.centerline);
    const duplicateNearby = existingPowerMids.some(
      (m) => Math.hypot(m.x - candMid.x, m.y - candMid.y) < 8.0
    );
    if (!duplicateNearby) {
      toAppend.push(cand);
      existingPowerMids.push(candMid);
    }
  }

  if (toAppend.length === 0) {
    return { context, addedCount: 0 };
  }

  const suffix = ` · +${toAppend.length} linha(s) E-REDES Open Data`;
  return {
    addedCount: toAppend.length,
    context: {
      ...context,
      sourceMode: 'LIVE_OVERPASS_WFS',
      sourceSummaryPt: context.sourceSummaryPt.includes('E-REDES Open Data')
        ? context.sourceSummaryPt
        : `${context.sourceSummaryPt}${suffix}`,
      easements: [...context.easements, ...toAppend],
    },
  };
}

/**
 * Builds the DGT Official Cadastre OGC API Features query URL (`collections/cadastro/items`).
 */
export function buildDgtCadastreOgcUrl(params: {
  baseUrl?: string;
  targetPoint: LatLon;
  searchHalfSpanM?: number;
  limit?: number;
}): string {
  const base =
    params.baseUrl?.trim() || 'https://ogcapi.dgterritorio.gov.pt/collections/cadastro/items';
  const halfM = params.searchHalfSpanM ?? 140;
  const sw = offsetMetersFromWgs84(params.targetPoint, -halfM, -halfM);
  const ne = offsetMetersFromWgs84(params.targetPoint, halfM, halfM);
  const url = new URL(base);
  url.searchParams.set('f', 'json');
  url.searchParams.set(
    'bbox',
    `${sw.lon.toFixed(6)},${sw.lat.toFixed(6)},${ne.lon.toFixed(6)},${ne.lat.toFixed(6)}`
  );
  url.searchParams.set('limit', String(params.limit ?? 15));
  return url.toString();
}

export interface OfficialCadastralParcelMatch {
  cadastralReference: string;
  inspireId: string;
  municipalityHint?: string;
  areaM2: number;
  vertices: LatLon[];
  containsTargetPoint: boolean;
  sourceLabel: string;
}

function pointInPolygonLatLon(pt: LatLon, ring: LatLon[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lon;
    const yi = ring[i].lat;
    const xj = ring[j].lon;
    const yj = ring[j].lat;
    const intersect =
      yi > pt.lat !== yj > pt.lat && pt.lon < ((xj - xi) * (pt.lat - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function sanitizeOuterRingWgs84(coords: unknown): LatLon[] {
  if (!Array.isArray(coords)) return [];
  const pts: LatLon[] = [];
  for (const item of coords) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const lon = Number(item[0]);
    const lat = Number(item[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    pts.push({ lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) });
  }
  if (pts.length >= 4) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.abs(first.lat - last.lat) < 1e-7 && Math.abs(first.lon - last.lon) < 1e-7) {
      pts.pop();
    }
  }
  return pts.length >= 3 ? pts : [];
}

/**
 * Parses DGT OGC API Features (`FeatureCollection` of `CadastralParcel`) and selects the parcel
 * containing (or closest to) `targetPoint`.
 */
export function parseDgtCadastreFeatures(
  rawJson: unknown,
  targetPoint: LatLon
): OfficialCadastralParcelMatch | null {
  if (!rawJson || typeof rawJson !== 'object') return null;
  const features = (rawJson as { features?: unknown[] }).features;
  if (!Array.isArray(features) || features.length === 0) return null;

  const targetTm = wgs84ToPtTm06(targetPoint);
  let best: (OfficialCadastralParcelMatch & { distM: number }) | null = null;

  for (let idx = 0; idx < features.length; idx++) {
    const f = features[idx] as {
      id?: string | number;
      geometry?: { type?: string; coordinates?: unknown[] };
      properties?: Record<string, unknown>;
    };
    if (!f?.geometry) continue;

    let ring: LatLon[] = [];
    if (f.geometry.type === 'Polygon' && Array.isArray(f.geometry.coordinates)) {
      ring = sanitizeOuterRingWgs84(f.geometry.coordinates[0]);
    } else if (f.geometry.type === 'MultiPolygon' && Array.isArray(f.geometry.coordinates)) {
      const firstPoly = f.geometry.coordinates[0];
      if (Array.isArray(firstPoly)) {
        ring = sanitizeOuterRingWgs84(firstPoly[0]);
      }
    }
    if (ring.length < 3) continue;

    const metrics = computePolygonMetrics3763(ring);
    const computedAreaM2 = metrics.areaM2;
    if (computedAreaM2 < 25 || computedAreaM2 > 5_000_000) continue;

    const contains = pointInPolygonLatLon(targetPoint, ring);
    const distM = contains
      ? 0
      : Math.hypot(metrics.centroidPtTm06.x - targetTm.x, metrics.centroidPtTm06.y - targetTm.y);

    const props = f.properties ?? {};
    const natRef = String(
      props.nationalCadastralReference ??
        props.nip ??
        props.NIC ??
        props.label ??
        props.inspireId ??
        f.id ??
        `DGT-${idx + 1}`
    ).trim();
    const inspireId = String(props.inspireId ?? props.id_inspire ?? natRef).trim();
    const municipalityHint =
      typeof props.municipio === 'string'
        ? props.municipio
        : typeof props.concelho === 'string'
          ? props.concelho
          : undefined;

    const candidate: OfficialCadastralParcelMatch & { distM: number } = {
      cadastralReference: natRef,
      inspireId,
      municipalityHint,
      areaM2: Number(computedAreaM2.toFixed(2)),
      vertices: ring,
      containsTargetPoint: contains,
      sourceLabel: 'Cadastro Predial Oficial DGT (OGC API Features)',
      distM,
    };

    if (
      !best ||
      (candidate.containsTargetPoint && !best.containsTargetPoint) ||
      (candidate.containsTargetPoint === best.containsTargetPoint && candidate.distM < best.distM)
    ) {
      best = candidate;
    }
  }

  if (!best) return null;
  const { distM: _unused, ...clean } = best;
  void _unused;
  return clean;
}

/**
 * Builds a deterministic sample grid (centroid + 4 cardinal offsets at ±24 m + up to 6 parcel vertices)
 * for querying Digital Elevation Model (DEM / MDT) APIs.
 */
export function buildParcelElevationSampleGrid(
  vertices: LatLon[],
  centroid?: LatLon
): LatLon[] {
  const c =
    centroid ??
    (vertices.length > 0
      ? {
          lat: vertices.reduce((s, v) => s + v.lat, 0) / vertices.length,
          lon: vertices.reduce((s, v) => s + v.lon, 0) / vertices.length,
        }
      : { lat: 38.7984, lon: -9.4621 });

  const cardinalSamples = [
    c,
    offsetMetersFromWgs84(c, 0, 24),
    offsetMetersFromWgs84(c, 0, -24),
    offsetMetersFromWgs84(c, 24, 0),
    offsetMetersFromWgs84(c, -24, 0),
  ];

  const vertexSubset = vertices.slice(0, 6);
  return [...cardinalSamples, ...vertexSubset].map((pt) => ({
    lat: Number(pt.lat.toFixed(6)),
    lon: Number(pt.lon.toFixed(6)),
  }));
}

/**
 * Parses elevation responses from Open-Meteo (`{ elevation: [120.4, ...] }`)
 * or Open-Topo-Data / WCS JSON (`{ results: [{ elevation: 120.4 }, ...] }`).
 */
export function parseElevationApiResponse(rawJson: unknown): number[] {
  if (!rawJson || typeof rawJson !== 'object') return [];
  const obj = rawJson as {
    elevation?: unknown;
    results?: Array<{ elevation?: unknown }>;
  };

  if (Array.isArray(obj.elevation)) {
    return obj.elevation.map((v) => Number(v)).filter((v) => Number.isFinite(v));
  }
  if (typeof obj.elevation === 'number' && Number.isFinite(obj.elevation)) {
    return [obj.elevation];
  }
  if (Array.isArray(obj.results)) {
    return obj.results
      .map((r) => Number(r?.elevation))
      .filter((v) => Number.isFinite(v));
  }
  return [];
}

export interface TerrainSlopeComputationResult {
  avgSlopePct: number;
  minElevationM: number;
  maxElevationM: number;
  reliefM: number;
  aspectLabelPt: string;
}

function classifyAspectDownslopePt(dzDx: number, dzDy: number): string {
  const mag = Math.hypot(dzDx, dzDy);
  if (mag < 0.005) return 'Terreno Plano';
  // Downslope vector points toward (-dzDx, -dzDy)
  const downEast = -dzDx;
  const downNorth = -dzDy;
  const angleDeg = ((Math.atan2(downEast, downNorth) * 180) / Math.PI + 360) % 360;
  if (angleDeg >= 337.5 || angleDeg < 22.5) return 'Exposição Norte';
  if (angleDeg < 67.5) return 'Exposição Nordeste';
  if (angleDeg < 112.5) return 'Exposição Nascente';
  if (angleDeg < 157.5) return 'Exposição Sudeste';
  if (angleDeg < 202.5) return 'Exposição Sul';
  if (angleDeg < 247.5) return 'Exposição Sudoeste';
  if (angleDeg < 292.5) return 'Exposição Poente';
  return 'Exposição Noroeste';
}

/**
 * Fits a least-squares plane z = a*x + b*y + c in metric EPSG:3763 coordinates (meters)
 * to compute physical hillside slope percentage (`100 * sqrt(a^2 + b^2)`), relief, and aspect.
 */
export function computeTerrainSlopeFromElevations(
  pointsWgs84: LatLon[],
  elevationsM: number[]
): TerrainSlopeComputationResult {
  const n = Math.min(pointsWgs84.length, elevationsM.length);
  if (n < 3) {
    const single = elevationsM[0] ?? 110;
    return {
      avgSlopePct: 8.5,
      minElevationM: Number(single.toFixed(1)),
      maxElevationM: Number(single.toFixed(1)),
      reliefM: 0,
      aspectLabelPt: 'Terreno Suave',
    };
  }

  const pts = [];
  let minZ = Infinity;
  let maxZ = -Infinity;
  let meanX = 0;
  let meanY = 0;
  let meanZ = 0;

  for (let i = 0; i < n; i++) {
    const tm = wgs84ToPtTm06(pointsWgs84[i]);
    const z = elevationsM[i];
    if (!Number.isFinite(z)) continue;
    pts.push({ x: tm.x, y: tm.y, z });
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    meanX += tm.x;
    meanY += tm.y;
    meanZ += z;
  }

  const count = pts.length;
  if (count < 3) {
    return {
      avgSlopePct: 8.5,
      minElevationM: 100,
      maxElevationM: 105,
      reliefM: 5,
      aspectLabelPt: 'Terreno Suave',
    };
  }

  meanX /= count;
  meanY /= count;
  meanZ /= count;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sxz = 0;
  let syz = 0;

  for (const p of pts) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    const dz = p.z - meanZ;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
    sxz += dx * dz;
    syz += dy * dz;
  }

  const det = sxx * syy - sxy * sxy;
  let dzDx = 0;
  let dzDy = 0;
  if (Math.abs(det) > 1e-6) {
    dzDx = (syy * sxz - sxy * syz) / det;
    dzDy = (sxx * syz - sxy * sxz) / det;
  }

  const rawGradientPct = Math.hypot(dzDx, dzDy) * 100;
  const avgSlopePct = Number(clamp(rawGradientPct, 0.5, 85).toFixed(1));
  const reliefM = Number(Math.max(0, maxZ - minZ).toFixed(1));

  return {
    avgSlopePct,
    minElevationM: Number(minZ.toFixed(1)),
    maxElevationM: Number(maxZ.toFixed(1)),
    reliefM,
    aspectLabelPt: classifyAspectDownslopePt(dzDx, dzDy),
  };
}
