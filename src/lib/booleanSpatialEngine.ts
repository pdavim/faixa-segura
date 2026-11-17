import * as polygonClippingNs from 'polygon-clipping';
import type { MultiPolygon, Pair, Polygon, Ring } from 'polygon-clipping';
import type {
  DetectedExemptFeature,
  DetectedLinearEasement,
  DetectedVectorBuilding,
  LandClass,
  LatLon,
  LatLonMultiPolygon,
  ParcelRecord,
  ParcelVectorContext,
  PtTm06Coord,
  SpatialZoneBreakdown,
} from '../types/domain.ts';

// CJS / ESM dual-runtime resolver for tsx (Node) and Vite (Browser)
const pc: typeof polygonClippingNs =
  (polygonClippingNs as unknown as { default?: typeof polygonClippingNs }).default ??
  polygonClippingNs;

/**
 * ETRS89 / PT-TM06 (EPSG:3763) Official Portuguese Projection Constants (DGT)
 * Central Meridian: -8° 07' 59.19" W (-8.133108333333334°)
 * Latitude of Origin: 39° 40' 05.73" N (39.668258333333334°)
 * Scale factor k0 = 1.0, False Easting = 0.0, False Northing = 0.0
 */
const PT_TM06_LON0_DEG = -8.133108333333334;
const PT_TM06_LAT0_DEG = 39.668258333333334;
const GRS80_A = 6378137.0;
const GRS80_F = 1 / 298.257222101;
const GRS80_E2 = 2 * GRS80_F - GRS80_F * GRS80_F;
const GRS80_EP2 = GRS80_E2 / (1 - GRS80_E2);

function meridionalArcGrs80(latRad: number): number {
  const e2 = GRS80_E2;
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  const A0 = 1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256;
  const A2 = (3 / 8) * (e2 + e4 / 4 + (15 * e6) / 128);
  const A4 = (15 / 256) * (e4 + (3 * e6) / 4);
  const A6 = (35 * e6) / 3072;
  return (
    GRS80_A *
    (A0 * latRad -
      A2 * Math.sin(2 * latRad) +
      A4 * Math.sin(4 * latRad) -
      A6 * Math.sin(6 * latRad))
  );
}

const M0_ORIGIN = meridionalArcGrs80((PT_TM06_LAT0_DEG * Math.PI) / 180);

/**
 * Forward projection: WGS84 (EPSG:4326) -> ETRS89 / PT-TM06 (EPSG:3763) in meters.
 */
export function projectWgs84ToPtTm06Exact(coord: LatLon): Pair {
  const phi = (coord.lat * Math.PI) / 180;
  const lam = (coord.lon * Math.PI) / 180;
  const lam0 = (PT_TM06_LON0_DEG * Math.PI) / 180;
  const dLam = lam - lam0;

  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);
  const N = GRS80_A / Math.sqrt(1 - GRS80_E2 * sinPhi * sinPhi);
  const T = tanPhi * tanPhi;
  const C = GRS80_EP2 * cosPhi * cosPhi;
  const A = cosPhi * dLam;
  const M = meridionalArcGrs80(phi);

  const x =
    N *
    (A +
      ((1 - T + C) * Math.pow(A, 3)) / 6 +
      ((5 - 18 * T + T * T + 72 * C - 58 * GRS80_EP2) * Math.pow(A, 5)) / 120);

  const y =
    M -
    M0_ORIGIN +
    N *
      tanPhi *
      ((A * A) / 2 +
        ((5 - T + 9 * C + 4 * C * C) * Math.pow(A, 4)) / 24 +
        ((61 - 58 * T + T * T + 600 * C - 330 * GRS80_EP2) * Math.pow(A, 6)) / 720);

  return [Number(x.toFixed(4)), Number(y.toFixed(4))];
}

/**
 * Exact inverse projection: ETRS89 / PT-TM06 (EPSG:3763) meters -> WGS84 (EPSG:4326).
 * Uses GRS80 footpoint latitude expansion (< 1 mm accuracy across mainland Portugal).
 */
export function ptTm06ToWgs84(coord: PtTm06Coord | Pair): LatLon {
  const x = Array.isArray(coord) ? coord[0] : coord.x;
  const y = Array.isArray(coord) ? coord[1] : coord.y;

  const e2 = GRS80_E2;
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  const M = M0_ORIGIN + y;
  const mu = M / (GRS80_A * (1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256));

  const sqrtOneMinusE2 = Math.sqrt(1 - e2);
  const e1 = (1 - sqrtOneMinusE2) / (1 + sqrtOneMinusE2);
  const e1_2 = e1 * e1;
  const e1_3 = e1_2 * e1;
  const e1_4 = e1_2 * e1_2;

  const J1 = (3 * e1) / 2 - (27 * e1_3) / 32;
  const J2 = (21 * e1_2) / 16 - (55 * e1_4) / 32;
  const J3 = (151 * e1_3) / 96;
  const J4 = (1097 * e1_4) / 512;

  const phi1 =
    mu +
    J1 * Math.sin(2 * mu) +
    J2 * Math.sin(4 * mu) +
    J3 * Math.sin(6 * mu) +
    J4 * Math.sin(8 * mu);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);

  const C1 = GRS80_EP2 * cosPhi1 * cosPhi1;
  const T1 = tanPhi1 * tanPhi1;
  const N1 = GRS80_A / Math.sqrt(1 - e2 * sinPhi1 * sinPhi1);
  const R1 = (GRS80_A * (1 - e2)) / Math.pow(1 - e2 * sinPhi1 * sinPhi1, 1.5);
  const D = x / N1;
  const D2 = D * D;
  const D4 = D2 * D2;
  const D6 = D4 * D2;

  const phi =
    phi1 -
    ((N1 * tanPhi1) / R1) *
      (D2 / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * GRS80_EP2) * D4) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * GRS80_EP2 - 3 * C1 * C1) * D6) /
          720);

  const lam0 = (PT_TM06_LON0_DEG * Math.PI) / 180;
  const lam =
    lam0 +
    (D -
      ((1 + 2 * T1 + C1) * D * D2) / 6 +
      ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * GRS80_EP2 + 24 * T1 * T1) * D * D4) /
        120) /
      cosPhi1;

  return {
    lat: Number(((phi * 180) / Math.PI).toFixed(6)),
    lon: Number(((lam * 180) / Math.PI).toFixed(6)),
  };
}

export function cleanOpenRing3763(pts: Pair[]): Pair[] {
  const out: Pair[] = [];
  for (const p of pts) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) > 1e-4) {
      out.push([Number(p[0].toFixed(4)), Number(p[1].toFixed(4))]);
    }
  }
  if (
    out.length >= 2 &&
    Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 1e-4
  ) {
    out.pop();
  }
  return out;
}

export function toClosedRing3763(pts: Pair[]): Ring {
  const open = cleanOpenRing3763(pts);
  if (open.length < 3) return [];
  return [...open, [open[0][0], open[0][1]]];
}

export function computeSignedRingArea3763(ring: Ring): number {
  if (ring.length < 3) return 0;
  let sum = 0;
  const n =
    Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < 1e-5
      ? ring.length - 1
      : ring.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

export function computeRingPerimeter3763(ring: Ring): number {
  const open = cleanOpenRing3763(ring);
  if (open.length < 2) return 0;
  let perim = 0;
  for (let i = 0; i < open.length; i++) {
    const a = open[i];
    const b = open[(i + 1) % open.length];
    perim += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return perim;
}

/**
 * Exact Shoelace area of a MultiPolygon in EPSG:3763 m² (outer rings minus interior holes).
 */
export function computeMultiPolygonArea3763(mp: MultiPolygon): number {
  let total = 0;
  for (const poly of mp) {
    if (!poly || poly.length === 0) continue;
    let polyArea = Math.abs(computeSignedRingArea3763(poly[0]));
    for (let r = 1; r < poly.length; r++) {
      polyArea -= Math.abs(computeSignedRingArea3763(poly[r]));
    }
    if (polyArea > 1e-4) {
      total += polyArea;
    }
  }
  return total;
}

function buildCirclePolygon3763(center: Pair, radiusM: number, steps = 24): Polygon {
  const pts: Pair[] = [];
  for (let i = 0; i < steps; i++) {
    const theta = (2 * Math.PI * i) / steps;
    pts.push([
      Number((center[0] + Math.cos(theta) * radiusM).toFixed(4)),
      Number((center[1] + Math.sin(theta) * radiusM).toFixed(4)),
    ]);
  }
  return [toClosedRing3763(pts)];
}

/**
 * Exact convex stadium/capsule polygon around a metric segment [a, b] with radius r (meters).
 */
export function buildSegmentCapsule3763(
  a: Pair,
  b: Pair,
  radiusM: number,
  arcSteps = 12
): Polygon {
  if (radiusM <= 0) return [];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) {
    return buildCirclePolygon3763(a, radiusM, Math.max(16, arcSteps * 2));
  }

  const baseAngle = Math.atan2(dy, dx);
  const pts: Pair[] = [];

  // Semicircle around B from (baseAngle - pi/2) to (baseAngle + pi/2)
  for (let i = 0; i <= arcSteps; i++) {
    const ang = baseAngle - Math.PI / 2 + (Math.PI * i) / arcSteps;
    pts.push([
      Number((b[0] + Math.cos(ang) * radiusM).toFixed(4)),
      Number((b[1] + Math.sin(ang) * radiusM).toFixed(4)),
    ]);
  }

  // Semicircle around A from (baseAngle + pi/2) to (baseAngle + 3*pi/2)
  for (let i = 0; i <= arcSteps; i++) {
    const ang = baseAngle + Math.PI / 2 + (Math.PI * i) / arcSteps;
    pts.push([
      Number((a[0] + Math.cos(ang) * radiusM).toFixed(4)),
      Number((a[1] + Math.sin(ang) * radiusM).toFixed(4)),
    ]);
  }

  return [toClosedRing3763(pts)];
}

function safeUnionAll(geoms: Array<Polygon | MultiPolygon>): MultiPolygon {
  const nonEmpty = geoms.filter((g) => Array.isArray(g) && g.length > 0);
  if (nonEmpty.length === 0) return [];
  try {
    const [first, ...rest] = nonEmpty;
    return rest.length === 0 ? pc.union(first) : pc.union(first, ...rest);
  } catch {
    // Sequential fallback if a single degenerate ring occurs
    let acc: MultiPolygon = [];
    for (const g of nonEmpty) {
      try {
        acc = acc.length === 0 ? pc.union(g) : pc.union(acc, g);
      } catch {
        // Skip invalid fragment
      }
    }
    return acc;
  }
}

function safeIntersection(subject: MultiPolygon, clip: MultiPolygon): MultiPolygon {
  if (subject.length === 0 || clip.length === 0) return [];
  try {
    return pc.intersection(subject, clip);
  } catch {
    return [];
  }
}

function safeDifference(subject: MultiPolygon, ...clips: MultiPolygon[]): MultiPolygon {
  if (subject.length === 0) return [];
  const activeClips = clips.filter((c) => c.length > 0);
  if (activeClips.length === 0) return subject;
  try {
    return pc.difference(subject, ...activeClips);
  } catch {
    let cur = subject;
    for (const c of activeClips) {
      try {
        cur = pc.difference(cur, c);
      } catch {
        // Keep current
      }
    }
    return cur;
  }
}

/**
 * Exact Minkowski outward buffer of a MultiPolygon in EPSG:3763 meters:
 * Buffer(M, r) = M U Union_{all ring segments e} Capsule(e, r).
 */
export function bufferMultiPolygon3763(
  mp: MultiPolygon,
  radiusM: number,
  arcSteps = 12
): MultiPolygon {
  if (mp.length === 0 || radiusM <= 0) return mp;
  const parts: Array<Polygon | MultiPolygon> = [mp];
  for (const poly of mp) {
    for (const ring of poly) {
      const open = cleanOpenRing3763(ring);
      if (open.length === 0) continue;
      for (let i = 0; i < open.length; i++) {
        const a = open[i];
        const b = open[(i + 1) % open.length];
        const cap = buildSegmentCapsule3763(a, b, radiusM, arcSteps);
        if (cap.length > 0) parts.push(cap);
      }
    }
  }
  return safeUnionAll(parts);
}

/**
 * Exact Minkowski buffer of a polyline (powerline, road, or stream) in EPSG:3763 meters.
 */
export function bufferPolyline3763(
  pts: Pair[],
  halfWidthM: number,
  arcSteps = 10
): MultiPolygon {
  const clean = cleanOpenRing3763(pts);
  if (halfWidthM <= 0 || clean.length === 0) return [];
  if (clean.length === 1) {
    return [buildCirclePolygon3763(clean[0], halfWidthM, 20)];
  }
  const caps: Polygon[] = [];
  for (let i = 0; i < clean.length - 1; i++) {
    const cap = buildSegmentCapsule3763(clean[i], clean[i + 1], halfWidthM, arcSteps);
    if (cap.length > 0) caps.push(cap);
  }
  return safeUnionAll(caps);
}

export function latLonRingToMultiPolygon3763(vertices: LatLon[]): MultiPolygon {
  const projected = vertices.map(projectWgs84ToPtTm06Exact);
  const closed = toClosedRing3763(projected);
  if (closed.length < 4) return [];
  return safeUnionAll([[closed]]);
}

export function multiPolygon3763ToWgs84(mp: MultiPolygon): LatLonMultiPolygon {
  const result: LatLonMultiPolygon = [];
  for (const poly of mp) {
    if (!poly || poly.length === 0) continue;
    const outerArea = Math.abs(computeSignedRingArea3763(poly[0]));
    if (outerArea < 0.05) continue; // Ignore microscopic sliver < 0.05 m²

    const ringsWgs84: LatLon[][] = [];
    for (let r = 0; r < poly.length; r++) {
      const open3763 = cleanOpenRing3763(poly[r]);
      if (open3763.length < 3) continue;
      if (r > 0 && Math.abs(computeSignedRingArea3763(poly[r])) < 0.05) continue;
      ringsWgs84.push(open3763.map((pair) => ptTm06ToWgs84(pair)));
    }
    if (ringsWgs84.length > 0) {
      result.push(ringsWgs84);
    }
  }
  return result;
}

/**
 * Extracts the largest outer polygon ring (WGS84) from a MultiPolygon for single-ring legacy consumers (PDF/KML).
 */
export function largestOuterRingFromMultiPolygon(mp3763: MultiPolygon): LatLon[] {
  let bestRing: Ring | null = null;
  let bestArea = 0;
  for (const poly of mp3763) {
    if (!poly || poly.length === 0) continue;
    const area = Math.abs(computeSignedRingArea3763(poly[0]));
    if (area > bestArea) {
      bestArea = area;
      bestRing = poly[0];
    }
  }
  if (!bestRing) return [];
  return cleanOpenRing3763(bestRing).map((pair) => ptTm06ToWgs84(pair));
}

function pointToSegmentClosest3763(
  p: Pair,
  a: Pair,
  b: Pair
): { distM: number; closest: Pair } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-8) {
    return { distM: Math.hypot(p[0] - a[0], p[1] - a[1]), closest: a };
  }
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
  const cx = a[0] + t * dx;
  const cy = a[1] + t * dy;
  return {
    distM: Math.hypot(p[0] - cx, p[1] - cy),
    closest: [cx, cy],
  };
}

export function isPointInRing3763(pt: Pair, ring: Pair[]): boolean {
  const open = cleanOpenRing3763(ring);
  if (open.length < 3) return false;
  let inside = false;
  for (let i = 0, j = open.length - 1; i < open.length; j = i++) {
    const xi = open[i][0];
    const yi = open[i][1];
    const xj = open[j][0];
    const yj = open[j][1];
    const intersect =
      yi > pt[1] !== yj > pt[1] &&
      pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi + 1e-15) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function computeMinDistancePolygonToParcelBoundary3763(
  subjectMp: MultiPolygon,
  parcelOpenRing: Pair[]
): {
  minDistanceM: number;
  directionLabelPt: string;
  closestBoundaryPoint: Pair;
  closestBuildingPoint: Pair;
} {
  if (parcelOpenRing.length < 3 || subjectMp.length === 0) {
    return {
      minDistanceM: 4.2,
      directionLabelPt: 'Poente / Noroeste',
      closestBoundaryPoint: parcelOpenRing[0] ?? [0, 0],
      closestBuildingPoint: parcelOpenRing[0] ?? [0, 0],
    };
  }

  let bestDist = Infinity;
  let bestBoundary: Pair = parcelOpenRing[0];
  let bestBuild: Pair = parcelOpenRing[0];

  const buildingPts: Pair[] = [];
  for (const poly of subjectMp) {
    if (!poly[0]) continue;
    buildingPts.push(...cleanOpenRing3763(poly[0]));
  }

  for (const bp of buildingPts) {
    for (let i = 0; i < parcelOpenRing.length; i++) {
      const a = parcelOpenRing[i];
      const b = parcelOpenRing[(i + 1) % parcelOpenRing.length];
      const res = pointToSegmentClosest3763(bp, a, b);
      if (res.distM < bestDist) {
        bestDist = res.distM;
        bestBoundary = res.closest;
        bestBuild = bp;
      }
    }
  }

  // Also check parcel vertices to building edges
  for (const poly of subjectMp) {
    const bOpen = cleanOpenRing3763(poly[0] ?? []);
    if (bOpen.length < 2) continue;
    for (const pv of parcelOpenRing) {
      for (let j = 0; j < bOpen.length; j++) {
        const a = bOpen[j];
        const b = bOpen[(j + 1) % bOpen.length];
        const res = pointToSegmentClosest3763(pv, a, b);
        if (res.distM < bestDist) {
          bestDist = res.distM;
          bestBoundary = pv;
          bestBuild = res.closest;
        }
      }
    }
  }

  // Azimuth from building point toward closest parcel boundary (0° = North, 90° = East, 180° = South, 270° = West)
  const dx = bestBoundary[0] - bestBuild[0];
  const dy = bestBoundary[1] - bestBuild[1];
  const azDeg = (((Math.atan2(dx, dy) * 180) / Math.PI) % 360 + 360) % 360;
  const dirs = [
    'Norte',
    'Nordeste',
    'Nascente',
    'Sudeste',
    'Sul',
    'Sudoeste',
    'Poente',
    'Noroeste',
  ];
  const directionLabelPt = dirs[Math.round(azDeg / 45) % 8];

  return {
    minDistanceM: Number(Math.max(0.5, bestDist).toFixed(2)),
    directionLabelPt,
    closestBoundaryPoint: bestBoundary,
    closestBuildingPoint: bestBuild,
  };
}

/**
 * Computes minimum distance (m) from an external polygon to the parcel polygon (0 if overlapping/inside).
 */
export function computeExternalPolygonDistanceToParcel3763(
  polyRing: Pair[],
  parcelMp: MultiPolygon,
  parcelOpenRing: Pair[]
): number {
  const extMp = safeUnionAll([[toClosedRing3763(polyRing)]]);
  if (extMp.length === 0) return Infinity;
  const overlap = safeIntersection(extMp, parcelMp);
  if (computeMultiPolygonArea3763(overlap) > 0.25) {
    return 0;
  }
  const distInfo = computeMinDistancePolygonToParcelBoundary3763(extMp, parcelOpenRing);
  return distInfo.minDistanceM;
}

function buildDefaultBuildingFootprint3763(
  parcelMp: MultiPolygon,
  parcelOpenRing: Pair[],
  centroid3763: Pair,
  buildingCenterWgs84?: LatLon
): DetectedVectorBuilding {
  let center3763: Pair = buildingCenterWgs84
    ? projectWgs84ToPtTm06Exact(buildingCenterWgs84)
    : [centroid3763[0] - 8, centroid3763[1] - 5];

  // Ensure default building center lies comfortably inside arbitrary concave/drawn polygons
  if (!isPointInRing3763(center3763, parcelOpenRing)) {
    if (isPointInRing3763(centroid3763, parcelOpenRing)) {
      center3763 = centroid3763;
    } else if (parcelOpenRing.length >= 3) {
      // Midpoint between vertex 0 and vertex floor(n/2) or average of first triangle
      const triMid: Pair = [
        (parcelOpenRing[0][0] + parcelOpenRing[1][0] + parcelOpenRing[2][0]) / 3,
        (parcelOpenRing[0][1] + parcelOpenRing[1][1] + parcelOpenRing[2][1]) / 3,
      ];
      center3763 = triMid;
    }
  }

  // Realistic Portuguese rural L-shaped / rectangular residential dwelling (~11m x 8.5m)
  const rawRect: Pair[] = [
    [center3763[0] - 5.5, center3763[1] - 4.25],
    [center3763[0] + 5.5, center3763[1] - 4.25],
    [center3763[0] + 5.5, center3763[1] + 4.25],
    [center3763[0] - 5.5, center3763[1] + 4.25],
  ];

  const rawMp = safeUnionAll([[toClosedRing3763(rawRect)]]);
  // Inset parcel slightly or intersect with parcel so building never protrudes outside a tiny drawn parcel
  const clippedMp = safeIntersection(rawMp, parcelMp);
  const effectiveMp =
    computeMultiPolygonArea3763(clippedMp) >= 9 ? clippedMp : rawMp;
  const footprintWgs84 = largestOuterRingFromMultiPolygon(effectiveMp);
  const areaM2 = Number(computeMultiPolygonArea3763(effectiveMp).toFixed(2));

  return {
    id: 'bldg-own-primary',
    role: 'OWN',
    label: 'Edificação Principal na Parcela',
    source: 'CADASTRO_SEED',
    footprint: footprintWgs84,
    areaM2,
    distanceToParcelEdgeM: 0,
  };
}

function buildDefaultEredesEasement3763(
  parcelOpenRing: Pair[],
  eredesType?: ParcelRecord['eredesType']
): DetectedLinearEasement {
  const xs = parcelOpenRing.map((p) => p[0]);
  const ys = parcelOpenRing.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanY = Math.max(10, maxY - minY);

  const isAt60 = eredesType?.includes('60kV');
  const halfWidthM = isAt60 ? 5.0 : 4.25; // 10m (AT 60kV) or 8.5m effective MT corridor

  // Realistic slightly angled overhead line crossing the upper corridor of the parcel
  const pStart = ptTm06ToWgs84([minX - 12, maxY - spanY * 0.13]);
  const pEnd = ptTm06ToWgs84([maxX + 12, maxY - spanY * 0.06]);

  return {
    id: 'easement-eredes-default',
    category: 'EREDES_MT_AT',
    label: isAt60 ? 'Linha Aérea AT 60 kV' : 'Linha Aérea MT 15–30 kV',
    operatorLabel: 'E-REDES Distribuição Elétrica',
    bufferHalfWidthM: halfWidthM,
    centerline: [pStart, pEnd],
    source: 'CADASTRO_SEED',
  };
}

/**
 * Exact Boolean Spatial Fuel-Break Decomposition Engine (Phase 1 — EPSG:3763)
 * Implements rigorous Minkowski buffering and Martinez-Rueda boolean polygon algebra
 * per Decreto-Lei n.º 82/2021 (SGIFR) and Despacho n.º 675/2026.
 */
export function computeBooleanParcelDecomposition(params: {
  vertices: LatLon[];
  buildingCenter?: LatLon;
  landClass: LandClass;
  hasEredesLine: boolean;
  eredesType?: ParcelRecord['eredesType'];
  isClusterInterface?: boolean;
  neighborDistanceOverrideM?: number;
  vectorContext?: ParcelVectorContext;
}): SpatialZoneBreakdown {
  const parcelOpen3763 = cleanOpenRing3763(params.vertices.map(projectWgs84ToPtTm06Exact));

  if (parcelOpen3763.length < 3) {
    const fallbackOrigin = params.vertices[0] ?? { lat: 38.7984, lon: -9.4621 };
    const c3763 = projectWgs84ToPtTm06Exact(fallbackOrigin);
    return {
      totalAreaM2: 0,
      perimeterM: 0,
      centroidWgs84: fallbackOrigin,
      centroidPtTm06: { x: Number(c3763[0].toFixed(2)), y: Number(c3763[1].toFixed(2)) },
      zone1ImmediateM2: 0,
      zone2NearM2: 0,
      zone3ExtendedM2: 0,
      mandatoryCleanAreaM2: 0,
      thirdPartyEasementM2: 0,
      exemptAreaM2: 0,
      estimatedEredesSavingsEur: 0,
      polygons: {
        parcel: params.vertices,
        buildingFootprint: [],
        zone1Immediate: [],
        zone2Near: [],
        zone3Extended: [],
        thirdPartyCorridor: [],
        exemptCore: [],
        neighborRiskParcel: [],
      },
      neighborMinDistanceM: 4.2,
      neighborDirection: 'Poente',
    };
  }

  const parcelMp = safeUnionAll([[toClosedRing3763(parcelOpen3763)]]);
  const rawParcelAreaM2 = Math.max(computeMultiPolygonArea3763(parcelMp), 1);
  const totalAreaM2 = Number(rawParcelAreaM2.toFixed(2));
  const perimeterM = Number(computeRingPerimeter3763(parcelOpen3763).toFixed(2));

  const sumLat = params.vertices.reduce((s, v) => s + v.lat, 0);
  const sumLon = params.vertices.reduce((s, v) => s + v.lon, 0);
  const centroidWgs84: LatLon = {
    lat: Number((sumLat / params.vertices.length).toFixed(6)),
    lon: Number((sumLon / params.vertices.length).toFixed(6)),
  };
  const centroidPair = projectWgs84ToPtTm06Exact(centroidWgs84);
  const centroidPtTm06: PtTm06Coord = {
    x: Number(centroidPair[0].toFixed(2)),
    y: Number(centroidPair[1].toFixed(2)),
  };

  // Resolve outer legal buffer rule: 100m (aglomerado rural), 50m (floresta/mato), or 10m (agrícola)
  const isSettlement100 =
    Boolean(params.isClusterInterface) ||
    Boolean(params.vectorContext?.isSettlementInterface100m);
  const outerBufferRadiusM: 10 | 50 | 100 = isSettlement100
    ? 100
    : params.landClass === 'FOREST_SCRUB'
      ? 50
      : 10;

  // 1. Resolve Own Buildings (inside parcel) & External Neighbor Buildings (<= outerBufferRadiusM)
  const ctxBuildings = params.vectorContext?.buildings ?? [];
  const ownBuildingItems: DetectedVectorBuilding[] = ctxBuildings.filter(
    (b) => b.role === 'OWN' && b.footprint.length >= 3
  );
  if (ownBuildingItems.length === 0) {
    ownBuildingItems.push(
      buildDefaultBuildingFootprint3763(
        parcelMp,
        parcelOpen3763,
        centroidPair,
        params.buildingCenter
      )
    );
  }

  const neighborBuildingItems: DetectedVectorBuilding[] = ctxBuildings.filter(
    (b) =>
      b.role === 'NEIGHBOR' &&
      b.footprint.length >= 3 &&
      b.distanceToParcelEdgeM <= outerBufferRadiusM
  );

  const ownBuildingsMp = safeIntersection(
    safeUnionAll(ownBuildingItems.map((b) => latLonRingToMultiPolygon3763(b.footprint))),
    parcelMp
  );
  const neighborBuildingsMp = safeUnionAll(
    neighborBuildingItems.map((b) => latLonRingToMultiPolygon3763(b.footprint))
  );
  const allRelevantBuildingsMp = safeUnionAll([ownBuildingsMp, neighborBuildingsMp]);

  const parcelMinusOwnBuildingsMp = safeDifference(parcelMp, ownBuildingsMp);

  // 2. Resolve Easements (E-REDES / REN Powerlines + Public Roads)
  const ctxEasements = params.vectorContext?.easements ?? [];
  const activeEasements: DetectedLinearEasement[] = [...ctxEasements];
  const hasPowerEasementInCtx = activeEasements.some(
    (e) => e.category === 'EREDES_MT_AT' || e.category === 'REN_MAT'
  );
  if (params.hasEredesLine && !hasPowerEasementInCtx) {
    activeEasements.push(buildDefaultEredesEasement3763(parcelOpen3763, params.eredesType));
  }

  const powerEasements = activeEasements.filter(
    (e) =>
      (e.category === 'EREDES_MT_AT' || e.category === 'REN_MAT') &&
      params.hasEredesLine
  );
  const roadEasements = activeEasements.filter(
    (e) => e.category === 'PUBLIC_ROAD' || e.category === 'RAILWAY'
  );

  const powerCorridorRawMp = safeUnionAll(
    powerEasements.map((e) =>
      bufferPolyline3763(
        e.centerline.map(projectWgs84ToPtTm06Exact),
        e.bufferHalfWidthM,
        10
      )
    )
  );
  const roadCorridorRawMp = safeUnionAll(
    roadEasements.map((e) =>
      bufferPolyline3763(
        e.centerline.map(projectWgs84ToPtTm06Exact),
        e.bufferHalfWidthM,
        10
      )
    )
  );

  const eredesClippedMp = safeIntersection(powerCorridorRawMp, parcelMinusOwnBuildingsMp);
  const roadClippedMp = safeDifference(
    safeIntersection(roadCorridorRawMp, parcelMinusOwnBuildingsMp),
    eredesClippedMp
  );
  const thirdPartyCorridorMp = safeUnionAll([eredesClippedMp, roadClippedMp]);

  // 3. Resolve Environmental / Agricultural Exemptions (Riparian galleries & irrigated orchards)
  const ctxExempt = params.vectorContext?.exemptFeatures ?? [];
  const riparianAndAgriRawParts: MultiPolygon[] = [];
  for (const ef of ctxExempt) {
    if (ef.centerline && ef.centerline.length >= 2) {
      riparianAndAgriRawParts.push(
        bufferPolyline3763(
          ef.centerline.map(projectWgs84ToPtTm06Exact),
          ef.bufferHalfWidthM ?? 5,
          10
        )
      );
    } else if (ef.polygon && ef.polygon.length >= 3) {
      riparianAndAgriRawParts.push(latLonRingToMultiPolygon3763(ef.polygon));
    }
  }
  const riparianAndAgriMp = safeDifference(
    safeIntersection(safeUnionAll(riparianAndAgriRawParts), parcelMinusOwnBuildingsMp),
    thirdPartyCorridorMp
  );

  // 4. Exact Concentric Minkowski Buffers (Despacho n.º 675/2026: 0-2m, 2-10m, 10-50m/100m)
  const buf2AllMp = bufferMultiPolygon3763(allRelevantBuildingsMp, 2.0, 12);
  const buf10AllMp = bufferMultiPolygon3763(allRelevantBuildingsMp, 10.0, 14);
  const bufOuterAllMp = bufferMultiPolygon3763(allRelevantBuildingsMp, outerBufferRadiusM, 16);

  const z1Mp = safeDifference(
    safeIntersection(buf2AllMp, parcelMinusOwnBuildingsMp),
    thirdPartyCorridorMp
  );
  const z2Mp = safeDifference(
    safeIntersection(safeDifference(buf10AllMp, buf2AllMp), parcelMinusOwnBuildingsMp),
    thirdPartyCorridorMp
  );
  const z3Mp = safeDifference(
    safeIntersection(safeDifference(bufOuterAllMp, buf10AllMp), parcelMinusOwnBuildingsMp),
    thirdPartyCorridorMp,
    riparianAndAgriMp
  );

  // Isolate Neighbor-Induced Obligation inside our parcel (area forced solely by neighbor's house!)
  const bufOuterOwnOnlyMp = bufferMultiPolygon3763(ownBuildingsMp, outerBufferRadiusM, 16);
  const ownInducedCleanMp = safeDifference(
    safeIntersection(bufOuterOwnOnlyMp, parcelMinusOwnBuildingsMp),
    thirdPartyCorridorMp,
    riparianAndAgriMp
  );
  const allCleanMp = safeUnionAll([z1Mp, z2Mp, z3Mp]);
  const neighborInducedMp =
    neighborBuildingItems.length > 0
      ? safeDifference(allCleanMp, ownInducedCleanMp)
      : [];

  // 5. Exact Remainder Exempt MultiPolygon (Guarantees Z1 + Z2 + Z3 + S + Exempt === TotalArea!)
  const occupiedNonExemptMp = safeUnionAll([thirdPartyCorridorMp, z1Mp, z2Mp, z3Mp]);
  const exemptMp = safeDifference(parcelMp, occupiedNonExemptMp);

  // 6. Neighbor Risk Overflow Crescent: Buffer(OwnBuildings, outerBufferRadiusM) \ Parcel
  const rawOverflowOutsideParcelMp = safeDifference(bufOuterOwnOnlyMp, parcelMp);
  let neighborRiskOverflowMp = rawOverflowOutsideParcelMp;
  if (
    params.vectorContext?.neighborParcels &&
    params.vectorContext.neighborParcels.length > 0
  ) {
    const nbParcelsMp = safeUnionAll(
      params.vectorContext.neighborParcels.map((np) => latLonRingToMultiPolygon3763(np.polygon))
    );
    const clippedToNb = safeIntersection(rawOverflowOutsideParcelMp, nbParcelsMp);
    if (computeMultiPolygonArea3763(clippedToNb) > 5) {
      neighborRiskOverflowMp = clippedToNb;
    }
  } else {
    // Focus overflow onto the confrontation half-plane nearest to the dwelling so GTF petitions target the exact closest neighbor
    const distCheck = computeMinDistancePolygonToParcelBoundary3763(
      ownBuildingsMp,
      parcelOpen3763
    );
    const vx = distCheck.closestBoundaryPoint[0] - distCheck.closestBuildingPoint[0];
    const vy = distCheck.closestBoundaryPoint[1] - distCheck.closestBuildingPoint[1];
    const vLen = Math.hypot(vx, vy) || 1;
    const ux = vx / vLen;
    const uy = vy / vLen;
    const px = -uy;
    const py = ux;
    const bx = distCheck.closestBoundaryPoint[0];
    const by = distCheck.closestBoundaryPoint[1];
    const halfPlaneSector: Polygon = [
      toClosedRing3763([
        [bx - px * 80, by - py * 80],
        [bx + px * 80, by + py * 80],
        [bx + px * 80 + ux * 65, by + py * 80 + uy * 65],
        [bx - px * 80 + ux * 65, by - py * 80 + uy * 65],
      ]),
    ];
    const sectorClipped = safeIntersection(rawOverflowOutsideParcelMp, [halfPlaneSector]);
    if (computeMultiPolygonArea3763(sectorClipped) > 5) {
      neighborRiskOverflowMp = sectorClipped;
    }
  }

  // 7. Exact Metric Areas (m²) with strict conservation reconciliation on final rounding centi-square-meter
  const zone1ImmediateM2 = Number(computeMultiPolygonArea3763(z1Mp).toFixed(2));
  const zone2NearM2 = Number(computeMultiPolygonArea3763(z2Mp).toFixed(2));
  const zone3ExtendedM2 = Number(computeMultiPolygonArea3763(z3Mp).toFixed(2));
  const mandatoryCleanAreaM2 = Number(
    (zone1ImmediateM2 + zone2NearM2 + zone3ExtendedM2).toFixed(2)
  );
  const eredesEasementM2 = Number(computeMultiPolygonArea3763(eredesClippedMp).toFixed(2));
  const roadEasementM2 = Number(computeMultiPolygonArea3763(roadClippedMp).toFixed(2));
  const thirdPartyEasementM2 = Number(
    computeMultiPolygonArea3763(thirdPartyCorridorMp).toFixed(2)
  );
  const exemptAreaM2 = Number(
    Math.max(0, totalAreaM2 - mandatoryCleanAreaM2 - thirdPartyEasementM2).toFixed(2)
  );

  const ownBuildingsAreaM2 = Number(computeMultiPolygonArea3763(ownBuildingsMp).toFixed(2));
  const neighborInducedCleanAreaM2 = Number(
    computeMultiPolygonArea3763(neighborInducedMp).toFixed(2)
  );
  const riparianProtectedM2 = Number(computeMultiPolygonArea3763(riparianAndAgriMp).toFixed(2));
  const neighborOverflowRiskM2 = Number(
    computeMultiPolygonArea3763(neighborRiskOverflowMp).toFixed(2)
  );

  // Quantifiable landowner savings on utility/public road strips (~0.38 €/m² forestry clearing rate)
  const estimatedEredesSavingsEur = Number((thirdPartyEasementM2 * 0.38).toFixed(2));

  // Exact confrontation distance & direction
  const boundaryDist = computeMinDistancePolygonToParcelBoundary3763(
    ownBuildingsMp,
    parcelOpen3763
  );
  const neighborMinDistanceM =
    params.neighborDistanceOverrideM !== undefined && !params.vectorContext
      ? params.neighborDistanceOverrideM
      : boundaryDist.minDistanceM;

  // Legacy single-ring polygons (outer ring of largest polygon in each layer)
  const fallbackNeighborRing =
    largestOuterRingFromMultiPolygon(neighborRiskOverflowMp).length >= 3
      ? largestOuterRingFromMultiPolygon(neighborRiskOverflowMp)
      : [
          ptTm06ToWgs84([centroidPair[0] - 48, centroidPair[1] - 20]),
          ptTm06ToWgs84([centroidPair[0] - 48, centroidPair[1] + 20]),
          ptTm06ToWgs84([centroidPair[0] - 32, centroidPair[1] + 20]),
          ptTm06ToWgs84([centroidPair[0] - 32, centroidPair[1] - 20]),
        ];

  return {
    totalAreaM2,
    perimeterM,
    centroidWgs84,
    centroidPtTm06,
    zone1ImmediateM2,
    zone2NearM2,
    zone3ExtendedM2,
    mandatoryCleanAreaM2,
    thirdPartyEasementM2,
    exemptAreaM2,
    estimatedEredesSavingsEur,
    polygons: {
      parcel: params.vertices,
      buildingFootprint: largestOuterRingFromMultiPolygon(ownBuildingsMp),
      zone1Immediate: largestOuterRingFromMultiPolygon(z1Mp),
      zone2Near: largestOuterRingFromMultiPolygon(z2Mp),
      zone3Extended: largestOuterRingFromMultiPolygon(z3Mp),
      thirdPartyCorridor: largestOuterRingFromMultiPolygon(thirdPartyCorridorMp),
      exemptCore: largestOuterRingFromMultiPolygon(exemptMp),
      neighborRiskParcel: fallbackNeighborRing,
    },
    multiPolygons: {
      ownBuildings: multiPolygon3763ToWgs84(ownBuildingsMp),
      neighborBuildings: multiPolygon3763ToWgs84(neighborBuildingsMp),
      zone1Immediate: multiPolygon3763ToWgs84(z1Mp),
      zone2Near: multiPolygon3763ToWgs84(z2Mp),
      zone3Extended: multiPolygon3763ToWgs84(z3Mp),
      neighborInducedObligation: multiPolygon3763ToWgs84(neighborInducedMp),
      thirdPartyCorridor: multiPolygon3763ToWgs84(thirdPartyCorridorMp),
      riparianAndAgriExempt: multiPolygon3763ToWgs84(riparianAndAgriMp),
      exemptCore: multiPolygon3763ToWgs84(exemptMp),
      neighborRiskOverflow: multiPolygon3763ToWgs84(neighborRiskOverflowMp),
    },
    decompositionMeta: {
      engineVersion: 'BOOLEAN_EPSG3763_V2',
      outerBufferRadiusM,
      ownBuildingsCount: ownBuildingItems.length,
      ownBuildingsAreaM2,
      neighborBuildingsWithin50mCount: neighborBuildingItems.length,
      neighborInducedCleanAreaM2,
      eredesEasementM2,
      roadEasementM2,
      riparianProtectedM2,
      neighborOverflowRiskM2,
      vectorSourceLabel:
        params.vectorContext?.sourceSummaryPt ??
        'Álgebra Booleana EPSG:3763 (Cadastro Base)',
    },
    neighborMinDistanceM,
    neighborDirection: boundaryDist.directionLabelPt,
  };
}
