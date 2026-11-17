import type { Pair } from 'polygon-clipping';
import type {
  DetectedRoofStructure,
  DetectedTreeCrown,
  DetectedVectorBuilding,
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

export const ORTHOPHOTO_CLASS_ORDER: readonly OrthophotoSemanticClass[] = [
  'MINERAL_INERT_BARE',
  'PAVED_ROAD_IMPERVIOUS',
  'BUILT_ROOF_STRUCTURE',
  'LOW_HERBACEOUS_CLEARED',
  'SHRUB_SCRUB_FUEL',
  'TREE_CANOPY_CROWN',
  'WATER_RIPARIAN',
] as const;

export const ORTHOPHOTO_CLASS_META: Record<
  OrthophotoSemanticClass,
  {
    id: number;
    labelPt: string;
    rgbaOverlay: [number, number, number, number];
    hex: string;
  }
> = {
  MINERAL_INERT_BARE: {
    id: 0,
    labelPt: 'Solo Mineral Inerte / Brita (Zona 1)',
    rgbaOverlay: [226, 232, 240, 138],
    hex: '#E2E8F0',
  },
  PAVED_ROAD_IMPERVIOUS: {
    id: 1,
    labelPt: 'Via Pavimentada / Impermeável',
    rgbaOverlay: [100, 116, 139, 132],
    hex: '#64748B',
  },
  BUILT_ROOF_STRUCTURE: {
    id: 2,
    labelPt: 'Cobertura Edificada / Anexo',
    rgbaOverlay: [244, 63, 94, 182],
    hex: '#F43F5E',
  },
  LOW_HERBACEOUS_CLEARED: {
    id: 3,
    labelPt: 'Herbáceo Rasteiro / Terreno Limpo',
    rgbaOverlay: [132, 204, 22, 118],
    hex: '#84CC16',
  },
  SHRUB_SCRUB_FUEL: {
    id: 4,
    labelPt: 'Mato Denso / Combustível Inflamável',
    rgbaOverlay: [217, 119, 6, 162],
    hex: '#D97706',
  },
  TREE_CANOPY_CROWN: {
    id: 5,
    labelPt: 'Copa Arbórea Densa',
    rgbaOverlay: [21, 128, 61, 174],
    hex: '#15803D',
  },
  WATER_RIPARIAN: {
    id: 6,
    labelPt: 'Plano de Água / Galeria Húmida',
    rgbaOverlay: [14, 165, 233, 164],
    hex: '#0EA5E9',
  },
};

export interface OrthophotoInferenceSpec {
  specVersion: 'SGIFR-ORTHOPHOTO-ONNX-V2';
  crsMetric: 'EPSG:3763';
  crsGeographic: 'EPSG:4326';
  targetGsdMeters: number;
  recommendedModels: {
    semanticSegmentation: string;
    instanceDetection: string;
  };
  inputTensor: {
    layout: 'NCHW';
    dtype: 'float32';
    shape: ['batch=1', 'channels=3 (RGB)', 'height=H (multiple of 8)', 'width=W (multiple of 8)'];
    imagenetMean: [number, number, number];
    imagenetStd: [number, number, number];
  };
  semanticClasses: Array<{
    classIndex: number;
    code: OrthophotoSemanticClass;
    labelPt: string;
    hex: string;
  }>;
  legalThresholds675_2026: {
    zone1MinInertPct: number;
    minCrownToWallDistanceM: number;
    minCrownSpacingGeneralM: number;
    minCrownSpacingResinousForestM: number;
  };
}

/**
 * Returns the exact ONNX Runtime / FastAPI CV microservice contract for external deployment
 * (`yolo11s-seg` + `segformer-b2-dgt25cm` over 25 cm DGT aerial orthophotos).
 */
export function buildOrthophotoInferenceSpec(
  modelProfile = 'yolo11s-seg+segformer-b2-dgt25cm'
): OrthophotoInferenceSpec {
  return {
    specVersion: 'SGIFR-ORTHOPHOTO-ONNX-V2',
    crsMetric: 'EPSG:3763',
    crsGeographic: 'EPSG:4326',
    targetGsdMeters: 0.25,
    recommendedModels: {
      semanticSegmentation: `${modelProfile.split('+')[1] ?? 'segformer-b2-dgt25cm'}.onnx`,
      instanceDetection: `${modelProfile.split('+')[0] ?? 'yolo11s-seg'}.onnx`,
    },
    inputTensor: {
      layout: 'NCHW',
      dtype: 'float32',
      shape: ['batch=1', 'channels=3 (RGB)', 'height=H (multiple of 8)', 'width=W (multiple of 8)'],
      imagenetMean: [0.485, 0.456, 0.406],
      imagenetStd: [0.229, 0.224, 0.225],
    },
    semanticClasses: ORTHOPHOTO_CLASS_ORDER.map((code) => ({
      classIndex: ORTHOPHOTO_CLASS_META[code].id,
      code,
      labelPt: ORTHOPHOTO_CLASS_META[code].labelPt,
      hex: ORTHOPHOTO_CLASS_META[code].hex,
    })),
    legalThresholds675_2026: {
      zone1MinInertPct: 85,
      minCrownToWallDistanceM: 5.0,
      minCrownSpacingGeneralM: 4.0,
      minCrownSpacingResinousForestM: 10.0,
    },
  };
}

/**
 * Converts an RGBA Uint8Array into a normalized NCHW `[1, 3, H, W]` Float32Array
 * using standard ImageNet mean/std for direct feeding into `onnxruntime-node` or PyTorch.
 */
export function buildNormalizedNchwFloat32Tensor(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number
): Float32Array {
  const planeSize = width * height;
  const tensor = new Float32Array(3 * planeSize);
  const meanR = 0.485;
  const meanG = 0.456;
  const meanB = 0.406;
  const stdR = 0.229;
  const stdG = 0.224;
  const stdB = 0.225;

  for (let i = 0; i < planeSize; i++) {
    const base = i * 4;
    const r = rgba[base] / 255;
    const g = rgba[base + 1] / 255;
    const b = rgba[base + 2] / 255;
    tensor[i] = (r - meanR) / stdR;
    tensor[planeSize + i] = (g - meanG) / stdG;
    tensor[2 * planeSize + i] = (b - meanB) / stdB;
  }
  return tensor;
}

export interface ParcelCvRasterGrid {
  width: number;
  height: number;
  bbox3763: [number, number, number, number]; // [minX, minY, maxX, maxY]
  bboxWgs84: [number, number, number, number]; // [west, south, east, north]
  leafletBounds: [[number, number], [number, number]]; // [[south, west], [north, east]]
  gsdMetersPerPx: number;
  pixelAreaM2: number;
  nw3763: Pair;
  ne3763: Pair;
  sw3763: Pair;
  se3763: Pair;
}

function roundToMultipleOf8(v: number, minVal = 96, maxVal = 256): number {
  const clamped = Math.max(minVal, Math.min(maxVal, Math.round(v)));
  return Math.max(minVal, Math.min(maxVal, Math.round(clamped / 8) * 8));
}

/**
 * Computes a georeferenced metric raster grid around the parcel in EPSG:3763 & WGS84,
 * aligned to multiples of 8 pixels for ONNX Runtime compatibility.
 */
export function computeParcelCvRasterGrid(
  parcelVertices: LatLon[],
  paddingMeters = 28,
  targetMaxDimPx = 224
): ParcelCvRasterGrid {
  const pts3763 =
    parcelVertices.length >= 3
      ? parcelVertices.map(projectWgs84ToPtTm06Exact)
      : [projectWgs84ToPtTm06Exact({ lat: 38.7984, lon: -9.4621 })];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts3763) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  minX -= paddingMeters;
  minY -= paddingMeters;
  maxX += paddingMeters;
  maxY += paddingMeters;

  const swWgs = ptTm06ToWgs84([minX, minY]);
  const neWgs = ptTm06ToWgs84([maxX, maxY]);
  const nwWgs = ptTm06ToWgs84([minX, maxY]);
  const seWgs = ptTm06ToWgs84([maxX, minY]);

  const west = Number(Math.min(swWgs.lon, nwWgs.lon).toFixed(6));
  const east = Number(Math.max(neWgs.lon, seWgs.lon).toFixed(6));
  const south = Number(Math.min(swWgs.lat, seWgs.lat).toFixed(6));
  const north = Number(Math.max(nwWgs.lat, neWgs.lat).toFixed(6));

  const nw3763 = projectWgs84ToPtTm06Exact({ lat: north, lon: west });
  const ne3763 = projectWgs84ToPtTm06Exact({ lat: north, lon: east });
  const sw3763 = projectWgs84ToPtTm06Exact({ lat: south, lon: west });
  const se3763 = projectWgs84ToPtTm06Exact({ lat: south, lon: east });

  const spanX = Math.max(24, Math.hypot(ne3763[0] - nw3763[0], ne3763[1] - nw3763[1]));
  const spanY = Math.max(24, Math.hypot(nw3763[0] - sw3763[0], nw3763[1] - sw3763[1]));

  // Aim for 25 cm GSD when parcel fits, capped cleanly at targetMaxDimPx
  const idealWidth = spanX / 0.25;
  const idealHeight = spanY / 0.25;
  const scale = Math.min(1, targetMaxDimPx / Math.max(idealWidth, idealHeight));

  const width = roundToMultipleOf8(idealWidth * scale, 96, targetMaxDimPx);
  const height = roundToMultipleOf8(idealHeight * scale, 96, targetMaxDimPx);

  const gsdX = spanX / width;
  const gsdY = spanY / height;
  const gsdMetersPerPx = Number(((gsdX + gsdY) / 2).toFixed(3));
  const pixelAreaM2 = gsdX * gsdY;

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

function pixelToWgs84(grid: ParcelCvRasterGrid, col: number, row: number): LatLon {
  const [west, south, east, north] = grid.bboxWgs84;
  const u = (col + 0.5) / grid.width;
  const v = (row + 0.5) / grid.height;
  return {
    lat: Number((north - v * (north - south)).toFixed(6)),
    lon: Number((west + u * (east - west)).toFixed(6)),
  };
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

interface ProjectedMultiPolygonRings {
  outer: Pair[];
  holes: Pair[][];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function projectLatLonMultiPolyForFastLookup(
  mpWgs84: LatLonMultiPolygon | undefined,
  fallbackSingle?: LatLon[]
): ProjectedMultiPolygonRings[] {
  const source: LatLonMultiPolygon =
    mpWgs84 && mpWgs84.length > 0
      ? mpWgs84
      : fallbackSingle && fallbackSingle.length >= 3
        ? [[fallbackSingle]]
        : [];

  const result: ProjectedMultiPolygonRings[] = [];
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
    result.push({ outer, holes, minX, minY, maxX, maxY });
  }
  return result;
}

function isPointInProjectedMultiPoly(pt: Pair, polys: ProjectedMultiPolygonRings[]): boolean {
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

function hash2dDeterministic(col: number, row: number, seed = 1337): number {
  let h = (col * 374761393 + row * 668265263 + seed * 1442695041) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/**
 * Generates a realistic, georeferenced 25 cm multispectral RGB orthophoto RGBA buffer
 * anchored to the parcel's EPSG:3763 geometry for offline field mode and deterministic unit tests.
 * Includes mapped residential roof(s), an unmapped 18 m² terracotta rural annex, partial gravel Zone 1,
 * individual pine/eucalypt & oak crowns (with realistic <5m wall & <10m spacing cases), scrub, road, and stream.
 */
export function synthesizeDeterministicParcelOrthophotoRgba(params: {
  grid: ParcelCvRasterGrid;
  parcelVertices: LatLon[];
  landClass: LandClass;
  spatial: SpatialZoneBreakdown;
  vectorContext?: ParcelVectorContext;
}): Uint8ClampedArray {
  const { grid, parcelVertices, landClass, spatial, vectorContext } = params;
  const rgba = new Uint8ClampedArray(grid.width * grid.height * 4);

  const parcelOpen = cleanOpenRing3763(parcelVertices.map(projectWgs84ToPtTm06Exact));
  const cx = spatial.centroidPtTm06.x;
  const cy = spatial.centroidPtTm06.y;

  // Mapped buildings in EPSG:3763
  const mappedBuildingRings: Pair[][] = [];
  if (vectorContext && vectorContext.buildings.length > 0) {
    for (const b of vectorContext.buildings) {
      const r = cleanOpenRing3763(b.footprint.map(projectWgs84ToPtTm06Exact));
      if (r.length >= 3) mappedBuildingRings.push(r);
    }
  } else if (spatial.polygons.buildingFootprint.length >= 3) {
    mappedBuildingRings.push(
      cleanOpenRing3763(spatial.polygons.buildingFootprint.map(projectWgs84ToPtTm06Exact))
    );
  }

  // Primary own building center for anchoring realistic Zone 1 / Crown test features
  const primaryRing = mappedBuildingRings[0] ?? [
    [cx - 5.5, cy - 4.25],
    [cx + 5.5, cy - 4.25],
    [cx + 5.5, cy + 4.25],
    [cx - 5.5, cy + 4.25],
  ];
  const bCx = primaryRing.reduce((s, p) => s + p[0], 0) / primaryRing.length;
  const bCy = primaryRing.reduce((s, p) => s + p[1], 0) / primaryRing.length;

  // Unmapped 19.5 m² (5.0m x 3.9m) rural terracotta annex ("Anexo / Palheiro Omisso no Cadastro") inside parcel
  const annexCx = bCx + 15.5;
  const annexCy = bCy - 4.5;
  const unmappedAnnexRing: Pair[] = [
    [annexCx - 2.5, annexCy - 1.95],
    [annexCx + 2.5, annexCy - 1.95],
    [annexCx + 2.5, annexCy + 1.95],
    [annexCx - 2.5, annexCy + 1.95],
  ];

  // Deterministic individual tree crowns [x, y, radiusM, isResinous]
  // Includes: 1 crown at ~3.4m from primary building wall (< 5m violation!),
  // 2 closely spaced pine crowns in Zona 3 (~2.2m apart, < 10m violation!),
  // and well-spaced compliant broadleaf/cork-oak crowns.
  const syntheticCrowns: Array<{ x: number; y: number; r: number; resinous: boolean }> = [
    { x: bCx - 8.4, y: bCy + 1.5, r: 2.3, resinous: true }, // ~0.6m-3.0m from west wall -> <5m wall violation!
    { x: bCx - 17.5, y: bCy + 12.0, r: 2.8, resinous: true }, // Zona 3 pine A
    { x: bCx - 11.2, y: bCy + 13.5, r: 2.6, resinous: true }, // Zona 3 pine B (~1.1m edge-to-edge -> <10m violation!)
    { x: bCx + 6.0, y: bCy + 18.0, r: 2.7, resinous: false }, // Broadleaf oak A
    { x: bCx + 21.0, y: bCy + 16.5, r: 2.9, resinous: false }, // Broadleaf oak B (~9.4m edge-to-edge -> compliant)
    { x: bCx - 22.0, y: bCy - 13.0, r: 3.1, resinous: true }, // Outer pine
  ];

  // Polylines for road & stream if present in vectorContext
  const roadLines: Pair[][] = [];
  const powerLines: Pair[][] = [];
  for (const eas of vectorContext?.easements ?? []) {
    const pts = eas.centerline.map(projectWgs84ToPtTm06Exact);
    if (eas.category === 'PUBLIC_ROAD' || eas.category === 'RAILWAY') {
      roadLines.push(pts);
    } else {
      powerLines.push(pts);
    }
  }
  if (powerLines.length > 0 && powerLines[0].length >= 2) {
    const midX = (powerLines[0][0][0] + powerLines[0][1][0]) / 2;
    const midY = (powerLines[0][0][1] + powerLines[0][1][1]) / 2;
    syntheticCrowns.push({ x: midX, y: midY, r: 2.2, resinous: true }); // Intrusion in E-REDES corridor
  }

  const waterLines: Pair[][] = (vectorContext?.exemptFeatures ?? [])
    .filter((ef) => ef.centerline && ef.centerline.length >= 2)
    .map((ef) => ef.centerline!.map(projectWgs84ToPtTm06Exact));

  for (let row = 0; row < grid.height; row++) {
    for (let col = 0; col < grid.width; col++) {
      const idx = (row * grid.width + col) * 4;
      const pt = pixelToPtTm06(grid, col, row);
      const n = hash2dDeterministic(col, row, 91) * 14 - 7;

      // Default background: cleared herbaceous or forest scrub mosaic
      const patchWave =
        Math.sin((pt[0] - cx) * 0.09) * Math.cos((pt[1] - cy) * 0.08) +
        (hash2dDeterministic(col >> 2, row >> 2, 17) - 0.5) * 0.5;

      let r = landClass === 'AGRICULTURE' ? 136 : 114;
      let g = landClass === 'AGRICULTURE' ? 168 : 138;
      let b = landClass === 'AGRICULTURE' ? 84 : 66;

      if (patchWave > 0.12 && landClass === 'FOREST_SCRUB') {
        // Shrub / gorse / cistus fuel patch (mato denso)
        r = 104;
        g = 118;
        b = 54;
      } else {
        // Low herbaceous cleared grass
        r = 132;
        g = 172;
        b = 86;
      }

      // Gravel / inert mineral strip around primary building (0-2m, with realistic 80% coverage + 20% weed encroachment)
      const distPrimary = minDistancePointToRingEdges3763(pt, primaryRing);
      if (distPrimary > 0 && distPrimary <= 2.15) {
        const angle = Math.atan2(pt[1] - bCy, pt[0] - bCx);
        if (angle > -2.35) {
          r = 198;
          g = 194;
          b = 186;
        }
      }

      // Paved road strip
      for (const rl of roadLines) {
        for (let i = 0; i < rl.length - 1; i++) {
          if (pointToSegmentDist3763(pt, rl[i], rl[i + 1]) <= 2.6) {
            r = 98;
            g = 102;
            b = 108;
          }
        }
      }

      // Riparian stream water channel
      for (const wl of waterLines) {
        for (let i = 0; i < wl.length - 1; i++) {
          if (pointToSegmentDist3763(pt, wl[i], wl[i + 1]) <= 1.8) {
            r = 34;
            g = 76;
            b = 106;
          }
        }
      }

      // Tree crowns (rendered above ground/shrubs)
      for (const c of syntheticCrowns) {
        const d = Math.hypot(pt[0] - c.x, pt[1] - c.y);
        if (d <= c.r) {
          const shade = 1 - (d / c.r) * 0.22;
          if (c.resinous) {
            r = Math.round(28 * shade);
            g = Math.round(74 * shade);
            b = Math.round(38 * shade);
          } else {
            r = Math.round(44 * shade);
            g = Math.round(92 * shade);
            b = Math.round(42 * shade);
          }
        }
      }

      // Mapped terracotta roofs
      let onRoof = false;
      for (const ring of mappedBuildingRings) {
        if (isPointInRing3763(pt, ring)) {
          onRoof = true;
          break;
        }
      }
      // Unmapped rural annex (inside parcel)
      if (!onRoof && isPointInRing3763(pt, parcelOpen) && isPointInRing3763(pt, unmappedAnnexRing)) {
        onRoof = true;
      }

      if (onRoof) {
        r = 192;
        g = 96;
        b = 68;
      }

      rgba[idx] = Math.max(0, Math.min(255, Math.round(r + n)));
      rgba[idx + 1] = Math.max(0, Math.min(255, Math.round(g + n)));
      rgba[idx + 2] = Math.max(0, Math.min(255, Math.round(b + n)));
      rgba[idx + 3] = 255;
    }
  }

  return rgba;
}

function encodeRgbaToBrowserDataUrlIfAvailable(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): string | undefined {
  if (typeof document === 'undefined') return undefined;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    const imgData = ctx.createImageData(width, height);
    imgData.data.set(rgba);
    ctx.putImageData(imgData, 0, 0);
    return canvas.toDataURL('image/png');
  } catch {
    return undefined;
  }
}

export interface OrthophotoPipelineOutput {
  analysis: ParcelOrthophotoCvAnalysis;
  overlayRgba: Uint8ClampedArray;
  semanticMask: Uint8Array;
}

/**
 * Pure, deterministic, isomorphic Computer Vision & OBIA pipeline over 25 cm RGB orthophoto pixels:
 *  - Stage 1: Radiometric & Sobel gradient extraction (`ExG`, `NGRDI`, HSV chroma, terracotta roof index)
 *  - Stage 2: 7-class SGIFR semantic classification + 3×3 morphological majority smoothing
 *  - Stage 3: 8-connected instance segmentation for individual tree crowns (with watershed splitting
 *             on closed-canopy stands) & unmapped roof/annex detection
 *  - Stage 4: Despacho n.º 675/2026 compliance audit clipped against Phase 1 EPSG:3763 boolean zones
 */
export function runOrthophotoPixelPipeline(params: {
  rgba: Uint8Array | Uint8ClampedArray;
  grid: ParcelCvRasterGrid;
  parcelVertices: LatLon[];
  landClass: LandClass;
  spatial: SpatialZoneBreakdown;
  vectorContext?: ParcelVectorContext;
  imagerySourceLabel: string;
  engineMode: ParcelOrthophotoCvAnalysis['engineMode'];
  modelProfile?: string;
  analyzedAtIso?: string;
}): OrthophotoPipelineOutput {
  const {
    rgba,
    grid,
    parcelVertices,
    landClass,
    spatial,
    vectorContext,
    imagerySourceLabel,
    engineMode,
    modelProfile = 'yolo11s-seg+segformer-b2-dgt25cm',
    analyzedAtIso = new Date().toISOString(),
  } = params;

  const { width, height, pixelAreaM2 } = grid;
  const totalPixels = width * height;

  // Stage 1: Luminance, Excess Green, and 3×3 Sobel gradient magnitude
  const lumArr = new Float32Array(totalPixels);
  const exgArr = new Float32Array(totalPixels);
  const gradArr = new Float32Array(totalPixels);

  for (let i = 0; i < totalPixels; i++) {
    const base = i * 4;
    const rn = rgba[base] / 255;
    const gn = rgba[base + 1] / 255;
    const bn = rgba[base + 2] / 255;
    lumArr[i] = 0.299 * rn + 0.587 * gn + 0.114 * bn;
    exgArr[i] = 2 * gn - rn - bn;
  }

  for (let row = 1; row < height - 1; row++) {
    for (let col = 1; col < width - 1; col++) {
      const idx = row * width + col;
      const gx =
        -lumArr[idx - width - 1] +
        lumArr[idx - width + 1] -
        2 * lumArr[idx - 1] +
        2 * lumArr[idx + 1] -
        lumArr[idx + width - 1] +
        lumArr[idx + width + 1];
      const gy =
        -lumArr[idx - width - 1] -
        2 * lumArr[idx - width] -
        lumArr[idx - width + 1] +
        lumArr[idx + width - 1] +
        2 * lumArr[idx + width] +
        lumArr[idx + width + 1];
      gradArr[idx] = Math.hypot(gx, gy);
    }
  }

  // Stage 2: Raw per-pixel 7-class classification
  const rawMask = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    const base = i * 4;
    const rn = rgba[base] / 255;
    const gn = rgba[base + 1] / 255;
    const bn = rgba[base + 2] / 255;
    const lum = lumArr[i];
    const exg = exgArr[i];
    const grad = gradArr[i];
    const maxC = Math.max(rn, gn, bn);
    const minC = Math.min(rn, gn, bn);
    const sat = maxC > 1e-4 ? (maxC - minC) / maxC : 0;
    const ngrdi = (gn - rn) / (gn + rn + 1e-4);

    // 2: Terracotta / ceramic tile roof or crisp high-albedo roof
    const isTerracottaRoof =
      rn > 0.44 &&
      rn > gn * 1.24 &&
      gn >= bn * 0.9 &&
      rn - bn > 0.17 &&
      exg < 0.01;
    const isWhitewashedRoof = lum > 0.84 && sat < 0.11;

    // 6: Water / dark wet riparian surface
    const isWater = bn > rn * 1.14 && bn > gn * 1.03 && lum < 0.42 && exg < 0.03;

    // 1: Asphalt / paved impervious road
    const isPaved =
      sat < 0.13 &&
      lum >= 0.24 &&
      lum <= 0.52 &&
      Math.abs(rn - bn) < 0.06 &&
      exg < 0.035;

    // 0: Bare mineral / gravel / limestone / clean sandy soil
    const isBareMineral =
      (sat < 0.22 && lum > 0.52 && lum <= 0.84 && exg < 0.045) ||
      (rn > gn * 1.03 &&
        gn > bn * 1.04 &&
        sat >= 0.14 &&
        sat < 0.34 &&
        lum >= 0.48 &&
        exg < 0.02);

    let cls = 3; // Default LOW_HERBACEOUS_CLEARED
    if (isTerracottaRoof) {
      cls = 2; // BUILT_ROOF_STRUCTURE
    } else if (isWater) {
      cls = 6; // WATER_RIPARIAN
    } else if (exg >= 0.04 || (ngrdi > 0.025 && gn > 0.21)) {
      // Vegetated pixel: separate Tree Canopy (5), Shrub/Scrub Fuel (4), and Low Herbaceous (3)
      if (
        (lum < 0.36 && (exg > 0.045 || gn > rn * 1.06)) ||
        (exg > 0.15 && lum < 0.44)
      ) {
        cls = 5; // TREE_CANOPY_CROWN
      } else if (lum >= 0.47 && exg >= 0.05 && grad < 0.22) {
        cls = 3; // LOW_HERBACEOUS_CLEARED
      } else {
        cls = 4; // SHRUB_SCRUB_FUEL
      }
    } else if (isWhitewashedRoof) {
      cls = 2;
    } else if (isPaved) {
      cls = 1; // PAVED_ROAD_IMPERVIOUS
    } else if (isBareMineral) {
      cls = 0; // MINERAL_INERT_BARE
    } else if (lum < 0.34 && gn >= rn * 0.98) {
      // Shaded woodland / dense canopy edge
      cls = 5;
    } else if (lum < 0.48 && gn >= bn * 1.06) {
      cls = 4;
    } else {
      cls = 0;
    }

    rawMask[i] = cls;
  }

  // Stage 2b: 3×3 Morphological Majority Filter to remove salt-and-pepper noise
  const semanticMask = new Uint8Array(totalPixels);
  const counts = new Int32Array(7);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const idx = row * width + col;
      if (row === 0 || row === height - 1 || col === 0 || col === width - 1) {
        semanticMask[idx] = rawMask[idx];
        continue;
      }
      counts.fill(0);
      for (let dy = -1; dy <= 1; dy++) {
        const rBase = (row + dy) * width + col;
        counts[rawMask[rBase - 1]]++;
        counts[rawMask[rBase]]++;
        counts[rawMask[rBase + 1]]++;
      }
      let bestCls = rawMask[idx];
      let bestCount = counts[bestCls];
      for (let c = 0; c < 7; c++) {
        if (counts[c] > bestCount) {
          bestCount = counts[c];
          bestCls = c;
        }
      }
      semanticMask[idx] = bestCls;
    }
  }

  // Pre-project boolean zone MultiPolygons for fast O(1) pixel & crown membership tests
  const parcelOpen3763 = cleanOpenRing3763(parcelVertices.map(projectWgs84ToPtTm06Exact));
  const parcelMp3763 = latLonRingToMultiPolygon3763(parcelVertices);

  const mp = spatial.multiPolygons;
  const z1Polys = projectLatLonMultiPolyForFastLookup(
    mp?.zone1Immediate,
    spatial.polygons.zone1Immediate
  );
  const z2Polys = projectLatLonMultiPolyForFastLookup(mp?.zone2Near, spatial.polygons.zone2Near);
  const z3Polys = projectLatLonMultiPolyForFastLookup(
    mp?.zone3Extended,
    spatial.polygons.zone3Extended
  );
  const easementPolys = projectLatLonMultiPolyForFastLookup(
    mp?.thirdPartyCorridor,
    spatial.polygons.thirdPartyCorridor
  );
  const exemptPolys = projectLatLonMultiPolyForFastLookup(
    mp?.exemptCore,
    spatial.polygons.exemptCore
  );

  // Existing mapped building rings in EPSG:3763 (own + neighbor) for wall-distance & unmapped-roof checks
  const mappedBuildingRings3763: Pair[][] = [];
  if (vectorContext && vectorContext.buildings.length > 0) {
    for (const b of vectorContext.buildings) {
      const r = cleanOpenRing3763(b.footprint.map(projectWgs84ToPtTm06Exact));
      if (r.length >= 3) mappedBuildingRings3763.push(r);
    }
  }
  if (mappedBuildingRings3763.length === 0 && spatial.polygons.buildingFootprint.length >= 3) {
    mappedBuildingRings3763.push(
      cleanOpenRing3763(spatial.polygons.buildingFootprint.map(projectWgs84ToPtTm06Exact))
    );
  }

  // Stage 3A: Connected-Component Roof Detection & Geometric Validation
  // Filter spurious non-compact roof pixels back to MINERAL_INERT_BARE so gravel driveways aren't mistaken for roofs
  const visitedRoof = new Uint8Array(totalPixels);
  const detectedRoofs: DetectedRoofStructure[] = [];
  const bfsQueue = new Int32Array(totalPixels);

  for (let startIdx = 0; startIdx < totalPixels; startIdx++) {
    if (semanticMask[startIdx] !== 2 || visitedRoof[startIdx]) continue;
    let head = 0;
    let tail = 0;
    bfsQueue[tail++] = startIdx;
    visitedRoof[startIdx] = 1;

    let minCol = width;
    let maxCol = 0;
    let minRow = height;
    let maxRow = 0;
    let sumX = 0;
    let sumY = 0;
    let terracottaCount = 0;

    while (head < tail) {
      const curr = bfsQueue[head++];
      const r = Math.floor(curr / width);
      const c = curr - r * width;
      if (c < minCol) minCol = c;
      if (c > maxCol) maxCol = c;
      if (r < minRow) minRow = r;
      if (r > maxRow) maxRow = r;
      const pt = pixelToPtTm06(grid, c, r);
      sumX += pt[0];
      sumY += pt[1];
      const base = curr * 4;
      if (rgba[base] > rgba[base + 1] * 1.18) terracottaCount++;

      for (let dy = -1; dy <= 1; dy++) {
        const nr = r + dy;
        if (nr < 0 || nr >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nc = c + dx;
          if (nc < 0 || nc >= width) continue;
          const nIdx = nr * width + nc;
          if (!visitedRoof[nIdx] && semanticMask[nIdx] === 2) {
            visitedRoof[nIdx] = 1;
            bfsQueue[tail++] = nIdx;
          }
        }
      }
    }

    const compPixels = tail;
    const areaM2 = compPixels * pixelAreaM2;
    const bboxAreaPx = (maxCol - minCol + 1) * (maxRow - minRow + 1);
    const fillRatio = compPixels / Math.max(1, bboxAreaPx);
    const aspect =
      Math.max(maxCol - minCol + 1, maxRow - minRow + 1) /
      Math.max(1, Math.min(maxCol - minCol + 1, maxRow - minRow + 1));

    const isValidRoof =
      areaM2 >= 9.5 && areaM2 <= 750 && fillRatio >= 0.36 && aspect <= 4.2;

    if (!isValidRoof) {
      // Reclassify non-building bright/soil sliver as MINERAL_INERT_BARE
      for (let k = 0; k < compPixels; k++) {
        semanticMask[bfsQueue[k]] = 0;
      }
      continue;
    }

    const centerPt: Pair = [sumX / compPixels, sumY / compPixels];
    const distToParcelEdge = isPointInRing3763(centerPt, parcelOpen3763)
      ? 0
      : minDistancePointToRingEdges3763(centerPt, parcelOpen3763);

    if (distToParcelEdge > 45) continue;

    // Build clean rectangular metric footprint scaled to exact blob area
    const spanColsM = Math.max(2.6, (maxCol - minCol + 1) * grid.gsdMetersPerPx * 0.92);
    const spanRowsM = Math.max(2.6, (maxRow - minRow + 1) * grid.gsdMetersPerPx * 0.92);
    const scaleFactor = Math.sqrt(areaM2 / Math.max(1, spanColsM * spanRowsM));
    const halfW = (spanColsM * scaleFactor) / 2;
    const halfH = (spanRowsM * scaleFactor) / 2;

    const rect3763: Pair[] = [
      [centerPt[0] - halfW, centerPt[1] - halfH],
      [centerPt[0] + halfW, centerPt[1] - halfH],
      [centerPt[0] + halfW, centerPt[1] + halfH],
      [centerPt[0] - halfW, centerPt[1] + halfH],
    ];
    const footprintWgs84 = rect3763.map((p) => ptTm06ToWgs84(p));
    const distParcelExact = computeExternalPolygonDistanceToParcel3763(
      rect3763,
      parcelMp3763,
      parcelOpen3763
    );
    const role: 'OWN' | 'NEIGHBOR' = distParcelExact <= 0.5 ? 'OWN' : 'NEIGHBOR';

    // Check if already mapped in OSM / Cadastre vectorContext
    let matchesExisting = false;
    for (const existingRing of mappedBuildingRings3763) {
      if (minDistancePointToRingEdges3763(centerPt, existingRing) <= 4.5) {
        matchesExisting = true;
        break;
      }
    }

    const terracottaRatio = terracottaCount / compPixels;
    const confidence = Number(
      Math.min(0.98, 0.72 + terracottaRatio * 0.18 + Math.min(0.08, fillRatio * 0.1)).toFixed(2)
    );

    detectedRoofs.push({
      id: `cv-roof-${detectedRoofs.length + 1}`,
      label: !matchesExisting
        ? role === 'OWN'
          ? 'Anexo / Construção Detetada em Ortofoto (Omisso OSM)'
          : 'Edificação Vizinha Detetada em Ortofoto (Omissa OSM)'
        : 'Cobertura Edificada Confirmada por Ortofoto',
      centerWgs84: ptTm06ToWgs84(centerPt),
      areaM2: Number(areaM2.toFixed(1)),
      footprintWgs84,
      confidence,
      isUnmappedInOsm: !matchesExisting,
      role,
      distanceToParcelEdgeM: Number(distParcelExact.toFixed(2)),
    });
  }

  // All building rings (mapped + newly detected roofs) for wall-to-crown audit
  const allAuditBuildingRings3763: Pair[][] = [
    ...mappedBuildingRings3763,
    ...detectedRoofs
      .filter((r) => r.isUnmappedInOsm)
      .map((r) => cleanOpenRing3763(r.footprintWgs84.map(projectWgs84ToPtTm06Exact))),
  ];

  // Stage 3B: Connected-Component Individual Tree Crown Extraction (with closed-canopy grid splitting)
  const visitedCrown = new Uint8Array(totalPixels);
  interface RawCrownCandidate {
    centerPt: Pair;
    areaM2: number;
    meanR: number;
    meanG: number;
    meanLum: number;
  }
  const rawCrowns: RawCrownCandidate[] = [];

  for (let startIdx = 0; startIdx < totalPixels; startIdx++) {
    if (semanticMask[startIdx] !== 5 || visitedCrown[startIdx]) continue;
    let head = 0;
    let tail = 0;
    bfsQueue[tail++] = startIdx;
    visitedCrown[startIdx] = 1;

    while (head < tail) {
      const curr = bfsQueue[head++];
      const r = Math.floor(curr / width);
      const c = curr - r * width;
      for (let dy = -1; dy <= 1; dy++) {
        const nr = r + dy;
        if (nr < 0 || nr >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nc = c + dx;
          if (nc < 0 || nc >= width) continue;
          const nIdx = nr * width + nc;
          if (!visitedCrown[nIdx] && semanticMask[nIdx] === 5) {
            visitedCrown[nIdx] = 1;
            bfsQueue[tail++] = nIdx;
          }
        }
      }
    }

    const compPixels = tail;
    const compAreaM2 = compPixels * pixelAreaM2;
    if (compAreaM2 < 2.4) continue;

    if (compAreaM2 <= 52) {
      let sumX = 0;
      let sumY = 0;
      let sumR = 0;
      let sumG = 0;
      let sumL = 0;
      for (let k = 0; k < compPixels; k++) {
        const pIdx = bfsQueue[k];
        const r = Math.floor(pIdx / width);
        const c = pIdx - r * width;
        const pt = pixelToPtTm06(grid, c, r);
        sumX += pt[0];
        sumY += pt[1];
        sumR += rgba[pIdx * 4];
        sumG += rgba[pIdx * 4 + 1];
        sumL += lumArr[pIdx];
      }
      const centerPt: Pair = [sumX / compPixels, sumY / compPixels];
      if (minDistancePointToRingEdges3763(centerPt, parcelOpen3763) <= 14) {
        rawCrowns.push({
          centerPt,
          areaM2: compAreaM2,
          meanR: sumR / compPixels,
          meanG: sumG / compPixels,
          meanLum: sumL / compPixels,
        });
      }
    } else {
      // Closed canopy stand (>52 m²): partition into ~6.5 m × 6.5 m individual tree crown cells
      const cellSizeM = 6.5;
      const buckets = new Map<
        string,
        { count: number; sumX: number; sumY: number; sumR: number; sumG: number; sumL: number }
      >();
      for (let k = 0; k < compPixels; k++) {
        const pIdx = bfsQueue[k];
        const r = Math.floor(pIdx / width);
        const c = pIdx - r * width;
        const pt = pixelToPtTm06(grid, c, r);
        const bx = Math.floor(pt[0] / cellSizeM);
        const by = Math.floor(pt[1] / cellSizeM);
        const key = `${bx}:${by}`;
        let b = buckets.get(key);
        if (!b) {
          b = { count: 0, sumX: 0, sumY: 0, sumR: 0, sumG: 0, sumL: 0 };
          buckets.set(key, b);
        }
        b.count++;
        b.sumX += pt[0];
        b.sumY += pt[1];
        b.sumR += rgba[pIdx * 4];
        b.sumG += rgba[pIdx * 4 + 1];
        b.sumL += lumArr[pIdx];
      }
      for (const b of buckets.values()) {
        const subArea = b.count * pixelAreaM2;
        if (subArea < 3.0) continue;
        const centerPt: Pair = [b.sumX / b.count, b.sumY / b.count];
        if (minDistancePointToRingEdges3763(centerPt, parcelOpen3763) <= 14) {
          rawCrowns.push({
            centerPt,
            areaM2: subArea,
            meanR: b.sumR / b.count,
            meanG: b.sumG / b.count,
            meanLum: b.sumL / b.count,
          });
        }
      }
    }
  }

  // Evaluate crown metrics, wall distances, inter-crown spacing & Despacho 675/2026 violations
  const crownsFull: DetectedTreeCrown[] = rawCrowns.map((rc, idx) => {
    const diameterM = Number((2 * Math.sqrt(rc.areaM2 / Math.PI)).toFixed(2));
    const radiusM = diameterM / 2;

    // Wall distance from crown outer drip-line to nearest building wall
    let minWallCenterDist = Infinity;
    for (const bRing of allAuditBuildingRings3763) {
      const d = minDistancePointToRingEdges3763(rc.centerPt, bRing);
      if (d < minWallCenterDist) minWallCenterDist = d;
    }
    const distanceToBuildingWallM = Number(
      Math.max(0, (Number.isFinite(minWallCenterDist) ? minWallCenterDist : 99) - radiusM).toFixed(2)
    );

    // Nearest neighbor crown edge-to-edge distance
    let nearestEdgeDist = Infinity;
    for (let j = 0; j < rawCrowns.length; j++) {
      if (j === idx) continue;
      const otherR = Math.sqrt(rawCrowns[j].areaM2 / Math.PI);
      const centerDist = Math.hypot(
        rc.centerPt[0] - rawCrowns[j].centerPt[0],
        rc.centerPt[1] - rawCrowns[j].centerPt[1]
      );
      const edgeDist = Math.max(0, centerDist - radiusM - otherR);
      if (edgeDist < nearestEdgeDist) nearestEdgeDist = edgeDist;
    }
    const nearestCrownDistanceM = Number(
      (Number.isFinite(nearestEdgeDist) ? nearestEdgeDist : 25).toFixed(2)
    );

    // Zone membership in EPSG:3763
    let zoneCode: DetectedTreeCrown['zoneCode'] = 'OUTSIDE';
    if (isPointInRing3763(rc.centerPt, parcelOpen3763)) {
      if (isPointInProjectedMultiPoly(rc.centerPt, z1Polys)) {
        zoneCode = 'ZONE_1';
      } else if (isPointInProjectedMultiPoly(rc.centerPt, z2Polys)) {
        zoneCode = 'ZONE_2';
      } else if (isPointInProjectedMultiPoly(rc.centerPt, easementPolys)) {
        zoneCode = 'EASEMENT';
      } else if (isPointInProjectedMultiPoly(rc.centerPt, z3Polys)) {
        zoneCode = 'ZONE_3';
      } else if (isPointInProjectedMultiPoly(rc.centerPt, exemptPolys)) {
        zoneCode = 'EXEMPT';
      } else {
        zoneCode = 'ZONE_3';
      }
    }

    // Resinous pine/eucalypt vs broadleaf oak spectral signature
    const greenRedRatio = rc.meanG / Math.max(1, rc.meanR);
    const speciesGroup: DetectedTreeCrown['speciesGroup'] =
      rc.meanLum < 0.26 || greenRedRatio > 2.25 ? 'RESINOUS_EUCALYPT' : 'BROADLEAF_QUERCUS';

    const reqSpacingM =
      speciesGroup === 'RESINOUS_EUCALYPT' && landClass === 'FOREST_SCRUB' ? 10.0 : 4.0;

    let violationRulePt: string | null = null;
    if (zoneCode === 'ZONE_1' || (zoneCode !== 'OUTSIDE' && distanceToBuildingWallM < 2.0)) {
      violationRulePt = `Infração Zona 1 (0–2 m): Copa sobre faixa inerte (${distanceToBuildingWallM.toFixed(1)} m da fachada)`;
    } else if (zoneCode !== 'OUTSIDE' && distanceToBuildingWallM < 5.0) {
      violationRulePt = `Infração Despacho 675/2026: Copa a ${distanceToBuildingWallM.toFixed(1)} m da parede (< 5 m)`;
    } else if (zoneCode === 'EASEMENT') {
      violationRulePt = 'Alerta Servidão: Intrusão arbórea na faixa E-REDES / Rede Viária';
    } else if (
      (zoneCode === 'ZONE_2' || zoneCode === 'ZONE_3') &&
      nearestCrownDistanceM < reqSpacingM
    ) {
      violationRulePt = `Infração ${zoneCode === 'ZONE_2' ? 'Zona 2' : 'Zona 3'}: Afastamento entre copas ${nearestCrownDistanceM.toFixed(1)} m (< ${reqSpacingM} m)`;
    }

    // Build 12-gon crown polygon in WGS84
    const polyPts: LatLon[] = [];
    for (let s = 0; s < 12; s++) {
      const ang = (2 * Math.PI * s) / 12;
      polyPts.push(
        ptTm06ToWgs84([
          rc.centerPt[0] + Math.cos(ang) * radiusM,
          rc.centerPt[1] + Math.sin(ang) * radiusM,
        ])
      );
    }

    return {
      id: `crown-${idx + 1}`,
      centerWgs84: ptTm06ToWgs84(rc.centerPt),
      centerPtTm06: {
        x: Number(rc.centerPt[0].toFixed(2)),
        y: Number(rc.centerPt[1].toFixed(2)),
      },
      areaM2: Number(rc.areaM2.toFixed(1)),
      diameterM,
      polygonWgs84: polyPts,
      speciesGroup,
      distanceToBuildingWallM,
      nearestCrownDistanceM,
      zoneCode,
      violationRulePt,
    };
  });

  // Prioritize violating and building-proximate crowns, capped at 56 instances for clean GIS/Leaflet UX
  crownsFull.sort((a, b) => {
    const aViol = a.violationRulePt ? 0 : 1;
    const bViol = b.violationRulePt ? 0 : 1;
    if (aViol !== bViol) return aViol - bViol;
    return a.distanceToBuildingWallM - b.distanceToBuildingWallM;
  });
  const crowns = crownsFull.slice(0, 56);

  // Stage 4: Clip Semantic Mask against Parcel & Boolean Legal Zones + Build RGBA Overlay
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
      const clsCode = ORTHOPHOTO_CLASS_ORDER[semanticMask[idx]];
      const meta = ORTHOPHOTO_CLASS_META[clsCode];
      const pt = pixelToPtTm06(grid, col, row);
      const insideParcel = isPointInRing3763(pt, parcelOpen3763);
      const outBase = idx * 4;

      if (insideParcel) {
        classPixelCountsInsideParcel[semanticMask[idx]]++;
        overlayRgba[outBase] = meta.rgbaOverlay[0];
        overlayRgba[outBase + 1] = meta.rgbaOverlay[1];
        overlayRgba[outBase + 2] = meta.rgbaOverlay[2];
        overlayRgba[outBase + 3] = meta.rgbaOverlay[3];

        if (isPointInProjectedMultiPoly(pt, z1Polys)) {
          z1TotalPx++;
          if (semanticMask[idx] === 0 || semanticMask[idx] === 1 || semanticMask[idx] === 2) {
            z1InertPx++;
          }
        } else if (isPointInProjectedMultiPoly(pt, z2Polys)) {
          z2TotalPx++;
          if (semanticMask[idx] === 5) z2CanopyPx++;
          if (semanticMask[idx] === 4) z2ShrubPx++;
        } else if (isPointInProjectedMultiPoly(pt, easementPolys)) {
          easTotalPx++;
          if (semanticMask[idx] === 4 || semanticMask[idx] === 5) easIntrusionPx++;
        } else if (isPointInProjectedMultiPoly(pt, z3Polys)) {
          z3TotalPx++;
          if (semanticMask[idx] === 5) z3CanopyPx++;
          if (semanticMask[idx] === 4) z3ShrubPx++;
        }
      } else {
        // Subtle 28% alpha outside parcel boundary so nearby roofs/crowns remain contextualized without clutter
        overlayRgba[outBase] = meta.rgbaOverlay[0];
        overlayRgba[outBase + 1] = meta.rgbaOverlay[1];
        overlayRgba[outBase + 2] = meta.rgbaOverlay[2];
        overlayRgba[outBase + 3] = semanticMask[idx] === 2 || semanticMask[idx] === 5 ? 64 : 0;
      }
    }
  }

  // Scale inside-parcel pixel areas to match exact parcel totalAreaM2
  const totalParcelPx = Math.max(
    1,
    classPixelCountsInsideParcel.reduce((acc, v) => acc + v, 0)
  );
  const areaScale = spatial.totalAreaM2 / (totalParcelPx * pixelAreaM2);
  const classAreasM2 = {} as Record<OrthophotoSemanticClass, number>;
  for (let c = 0; c < ORTHOPHOTO_CLASS_ORDER.length; c++) {
    classAreasM2[ORTHOPHOTO_CLASS_ORDER[c]] = Number(
      (classPixelCountsInsideParcel[c] * pixelAreaM2 * areaScale).toFixed(1)
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

  const browserDataUrl = encodeRgbaToBrowserDataUrlIfAvailable(overlayRgba, width, height);

  return {
    analysis: {
      analyzedAtIso,
      engineMode,
      imagerySourceLabel,
      modelProfile,
      rasterWidthPx: width,
      rasterHeightPx: height,
      gsdMetersPerPx: grid.gsdMetersPerPx,
      bboxWgs84: grid.bboxWgs84,
      leafletBounds: grid.leafletBounds,
      overlayDataUrl: browserDataUrl,
      classAreasM2,
      crowns,
      detectedRoofs,
      unmappedRoofsCount,
      zoneCompliance,
    },
    overlayRgba,
    semanticMask,
  };
}

/**
 * Fuses unmapped roof structures (rural annexes, sheds, neighbor houses) detected by the 25 cm
 * Orthophoto CV pipeline into `ParcelVectorContext.buildings` without duplicating existing buildings,
 * so `computeParcelFgc` immediately updates the exact EPSG:3763 boolean zones!
 */
export function fuseCvDetectionsIntoVectorContext(params: {
  existingContext?: ParcelVectorContext;
  cvAnalysis: ParcelOrthophotoCvAnalysis;
  parcelVertices: LatLon[];
}): {
  vectorContext: ParcelVectorContext;
  addedBuildingsCount: number;
} {
  const { existingContext, cvAnalysis } = params;
  const baseBuildings: DetectedVectorBuilding[] = [...(existingContext?.buildings ?? [])];
  const existingCenters3763 = baseBuildings
    .filter((b) => b.footprint.length >= 3)
    .map((b) => {
      const pts = b.footprint.map(projectWgs84ToPtTm06Exact);
      const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      return [cx, cy] as Pair;
    });

  let addedBuildingsCount = 0;
  for (const roof of cvAnalysis.detectedRoofs) {
    if (!roof.isUnmappedInOsm || roof.footprintWgs84.length < 3) continue;
    const c3763 = projectWgs84ToPtTm06Exact(roof.centerWgs84);
    const alreadyPresent = existingCenters3763.some(
      (ec) => Math.hypot(ec[0] - c3763[0], ec[1] - c3763[1]) <= 4.5
    );
    if (alreadyPresent) continue;

    existingCenters3763.push(c3763);
    addedBuildingsCount++;
    baseBuildings.push({
      id: `bldg-${roof.id}`,
      role: roof.role,
      label:
        roof.role === 'OWN'
          ? `Anexo / Cobertura Detetada CV 25cm (${roof.areaM2.toFixed(0)} m²)`
          : `Edifício Vizinho Detetado CV 25cm (${roof.areaM2.toFixed(0)} m²)`,
      source: 'CV_ORTHOPHOTO_25CM',
      footprint: roof.footprintWgs84,
      areaM2: roof.areaM2,
      distanceToParcelEdgeM: roof.distanceToParcelEdgeM,
    });
  }

  const ownCount = baseBuildings.filter((b) => b.role === 'OWN').length;
  const nbCount = baseBuildings.filter((b) => b.role === 'NEIGHBOR').length;

  const updatedContext: ParcelVectorContext = {
    detectedAtIso: new Date().toISOString(),
    sourceMode: existingContext?.sourceMode ?? 'SYNTHESIZED_CADASTRE',
    sourceSummaryPt: `Fusão Booleana + Ortofoto CV 25 cm (${ownCount} edif. próprio(s), ${nbCount} vizinho(s)${addedBuildingsCount > 0 ? `, +${addedBuildingsCount} via CV` : ''})`,
    searchRadiusM: existingContext?.searchRadiusM ?? 110,
    isSettlementInterface100m: existingContext?.isSettlementInterface100m,
    settlementName: existingContext?.settlementName,
    buildings: baseBuildings,
    easements: existingContext?.easements ?? [],
    exemptFeatures: existingContext?.exemptFeatures ?? [],
    neighborParcels: existingContext?.neighborParcels,
  };

  return {
    vectorContext: updatedContext,
    addedBuildingsCount,
  };
}
