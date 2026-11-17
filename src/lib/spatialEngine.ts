import type {
  LandClass,
  LatLon,
  LatLonMultiPolygon,
  ParcelRecord,
  ParcelVectorContext,
  PtTm06Coord,
  SpatialZoneBreakdown,
} from '../types/domain.ts';
import {
  computeBooleanParcelDecomposition,
  ptTm06ToWgs84,
} from './booleanSpatialEngine.ts';

export { ptTm06ToWgs84 };

/**
 * ETRS89 / PT-TM06 (EPSG:3763) Official Portuguese Projection Constants (DGT)
 * Central Meridian: -8° 07' 59.19" W (-8.1331083333°)
 * Latitude of Origin: 39° 40' 05.73" N (39.6682583333°)
 * Scale factor k0 = 1.0, False Easting = 0.0, False Northing = 0.0
 */
const PT_TM06_LON0 = -8.133108333333334;
const PT_TM06_LAT0 = 39.668258333333334;
const GRS80_A = 6378137.0;
const GRS80_F = 1 / 298.257222101;
const GRS80_E2 = 2 * GRS80_F - GRS80_F * GRS80_F;

function meridionalArc(latRad: number): number {
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

const M0 = meridionalArc((PT_TM06_LAT0 * Math.PI) / 180);

/**
 * Projects WGS84 (EPSG:4326) to official Portuguese ETRS89 / PT-TM06 (EPSG:3763) in meters.
 */
export function wgs84ToPtTm06(coord: LatLon): PtTm06Coord {
  const phi = (coord.lat * Math.PI) / 180;
  const lam = (coord.lon * Math.PI) / 180;
  const lam0 = (PT_TM06_LON0 * Math.PI) / 180;
  const dLam = lam - lam0;

  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);
  const ep2 = GRS80_E2 / (1 - GRS80_E2);
  const N = GRS80_A / Math.sqrt(1 - GRS80_E2 * sinPhi * sinPhi);
  const T = tanPhi * tanPhi;
  const C = ep2 * cosPhi * cosPhi;
  const A = cosPhi * dLam;
  const M = meridionalArc(phi);

  const x =
    N *
    (A +
      ((1 - T + C) * Math.pow(A, 3)) / 6 +
      ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * Math.pow(A, 5)) / 120);

  const y =
    M -
    M0 +
    N *
      tanPhi *
      ((A * A) / 2 +
        ((5 - T + 9 * C + 4 * C * C) * Math.pow(A, 4)) / 24 +
        ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * Math.pow(A, 6)) / 720);

  return {
    x: Number(x.toFixed(2)),
    y: Number(y.toFixed(2)),
  };
}

/**
 * Inverse projection from PT-TM06 (EPSG:3763) metric offsets near a reference WGS84 origin.
 */
export function offsetMetersFromWgs84(origin: LatLon, dxMeters: number, dyMeters: number): LatLon {
  const latRad = (origin.lat * Math.PI) / 180;
  const metersPerDegLat = 111132.92 - 559.82 * Math.cos(2 * latRad) + 1.175 * Math.cos(4 * latRad);
  const metersPerDegLon = 111412.84 * Math.cos(latRad) - 93.5 * Math.cos(3 * latRad);
  return {
    lat: Number((origin.lat + dyMeters / metersPerDegLat).toFixed(6)),
    lon: Number((origin.lon + dxMeters / metersPerDegLon).toFixed(6)),
  };
}

/**
 * Computes exact metric area (m²) and perimeter (m) in EPSG:3763 via Shoelace theorem.
 */
export function computePolygonMetrics3763(vertices: LatLon[]): {
  areaM2: number;
  perimeterM: number;
  centroidWgs84: LatLon;
  centroidPtTm06: PtTm06Coord;
} {
  if (vertices.length < 3) {
    const fallback = vertices[0] ?? { lat: 38.7984, lon: -9.4621 };
    return {
      areaM2: 0,
      perimeterM: 0,
      centroidWgs84: fallback,
      centroidPtTm06: wgs84ToPtTm06(fallback),
    };
  }

  const pts = vertices.map(wgs84ToPtTm06);
  let doubleArea = 0;
  let perimeter = 0;
  let sumLat = 0;
  let sumLon = 0;

  for (let i = 0; i < pts.length; i++) {
    const curr = pts[i];
    const next = pts[(i + 1) % pts.length];
    doubleArea += curr.x * next.y - next.x * curr.y;
    perimeter += Math.hypot(next.x - curr.x, next.y - curr.y);
    sumLat += vertices[i].lat;
    sumLon += vertices[i].lon;
  }

  const centroidWgs84: LatLon = {
    lat: Number((sumLat / vertices.length).toFixed(6)),
    lon: Number((sumLon / vertices.length).toFixed(6)),
  };

  return {
    areaM2: Number((Math.abs(doubleArea) / 2).toFixed(2)),
    perimeterM: Number(perimeter.toFixed(2)),
    centroidWgs84,
    centroidPtTm06: wgs84ToPtTm06(centroidWgs84),
  };
}

export function haversineDistanceKm(a: LatLon, b: LatLon): number {
  const R = 6371.0;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  return Number((R * c).toFixed(2));
}

export function azimuthCardinalLabel(deg: number): string {
  const normalized = ((deg % 360) + 360) % 360;
  const dirs = [
    'Norte',
    'Nordeste',
    'Este',
    'Sudeste',
    'Sul',
    'Sudoeste',
    'Oeste',
    'Noroeste',
  ];
  return dirs[Math.round(normalized / 45) % 8];
}

/**
 * Exact Boolean Spatial Fuel-Break Engine (DL n.º 82/2021 + Despacho n.º 675/2026)
 * Performs true Minkowski capsule buffering and Martinez-Rueda boolean polygon algebra
 * in official Portuguese ETRS89 / PT-TM06 (EPSG:3763) metric coordinates.
 */
export function computeParcelFgc(params: {
  vertices: LatLon[];
  buildingCenter?: LatLon;
  landClass: LandClass;
  hasEredesLine: boolean;
  eredesType?: ParcelRecord['eredesType'];
  isClusterInterface?: boolean;
  neighborDistanceOverrideM?: number;
  vectorContext?: ParcelVectorContext;
}): SpatialZoneBreakdown {
  return computeBooleanParcelDecomposition(params);
}

/**
 * Generates municipal SIG-ready GeoJSON FeatureCollection for GTF engineers (/gtf/[code]).
 */
export function buildMunicipalGtfGeoJson(params: {
  reqCode: string;
  municipality: string;
  dicofre: string;
  minDistanceFacadeM: number;
  neighborNdvi: number;
  neighborPolygon: LatLon[];
  buildingPolygon: LatLon[];
}): string {
  const toRing = (pts: LatLon[]) => {
    const ring = pts.map((p) => [p.lon, p.lat]);
    if (ring.length > 0) ring.push([pts[0].lon, pts[0].lat]);
    return [ring];
  };

  const fc = {
    type: 'FeatureCollection',
    name: `FaixaSegura_GTF_${params.reqCode}`,
    crs: {
      type: 'name',
      properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' },
    },
    features: [
      {
        type: 'Feature',
        properties: {
          dossier_ref: params.reqCode,
          layer: 'PREDIO_CONFINANTE_EM_INFRACAO',
          municipio: params.municipality,
          dicofre: params.dicofre,
          distancia_minima_fachada_m: params.minDistanceFacadeM,
          sentinel2_ndvi: params.neighborNdvi,
          base_legal: 'Art. 49, 57 e 58 DL 82/2021 + Despacho 675/2026',
        },
        geometry: {
          type: 'Polygon',
          coordinates: toRing(params.neighborPolygon),
        },
      },
      {
        type: 'Feature',
        properties: {
          dossier_ref: params.reqCode,
          layer: 'EDIFICACAO_HABITACIONAL_EM_RISCO',
          municipio: params.municipality,
        },
        geometry: {
          type: 'Polygon',
          coordinates: toRing(params.buildingPolygon),
        },
      },
    ],
  };

  return JSON.stringify(fc, null, 2);
}

/**
 * Generates OGC KML 2.2 XML for 1-click import into Google Earth / ArcGIS / QGIS Municipal.
 */
export function buildMunicipalGtfKml(params: {
  reqCode: string;
  municipality: string;
  minDistanceFacadeM: number;
  neighborPolygon: LatLon[];
}): string {
  const coords = [...params.neighborPolygon, params.neighborPolygon[0]]
    .filter(Boolean)
    .map((p) => `${p.lon},${p.lat},0`)
    .join(' ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>FaixaSegura Dossie GTF ${params.reqCode}</name>
    <Placemark>
      <name>Terreno Confinante em Infracao (${params.municipality})</name>
      <description>Distancia minima a fachada habitacional: ${params.minDistanceFacadeM.toFixed(2)} m (DL 82/2021 + Despacho 675/2026)</description>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>${coords}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>
  </Document>
</kml>`;
}

function slugifyAscii(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function deduplicateClosingVertex(vertices: LatLon[]): LatLon[] {
  if (vertices.length < 2) return vertices;
  const first = vertices[0];
  const last = vertices[vertices.length - 1];
  if (Math.abs(first.lat - last.lat) < 1e-8 && Math.abs(first.lon - last.lon) < 1e-8) {
    return vertices.slice(0, -1);
  }
  return vertices;
}

function toCounterClockwiseClosedRing(vertices: LatLon[]): Array<[number, number]> {
  const unique = deduplicateClosingVertex(vertices);
  if (unique.length === 0) return [];

  const coords: Array<[number, number]> = unique.map((v) => [
    Number(v.lon.toFixed(6)),
    Number(v.lat.toFixed(6)),
  ]);

  let signedDoubleArea = 0;
  for (let i = 0; i < coords.length; i++) {
    const [x1, y1] = coords[i];
    const [x2, y2] = coords[(i + 1) % coords.length];
    signedDoubleArea += x1 * y2 - x2 * y1;
  }

  // RFC 7946 §3.1.6: exterior rings follow the right-hand rule (counterclockwise -> signedDoubleArea > 0)
  const oriented =
    signedDoubleArea < 0 && coords.length >= 3
      ? [coords[0], ...coords.slice(1).reverse()]
      : coords;

  return [...oriented, [oriented[0][0], oriented[0][1]]];
}

export function buildParcelGeoJsonFilename(
  parcel: Pick<ParcelRecord, 'id' | 'bupiRggId' | 'municipality' | 'label'>
): string {
  const refSlug = slugifyAscii(parcel.bupiRggId || parcel.id || 'parcela');
  const munSlug = slugifyAscii(parcel.municipality || 'portugal');
  const base = ['faixasegura', refSlug, munSlug].filter(Boolean).join('-');
  return `${base || 'faixasegura-parcela'}.geojson`;
}

/**
 * Exports the selected parcel's boundary polygon and individual corner vertices
 * as an RFC 7946 GeoJSON FeatureCollection (CRS84 / WGS84 + ETRS89 / PT-TM06 EPSG:3763 attributes)
 * for direct import into QGIS, ArcGIS Pro, Google Earth, BUPi, and PostGIS.
 */
export function buildParcelVerticesGeoJson(
  parcel: ParcelRecord,
  exportedAtIso: string = new Date().toISOString()
): string {
  const rawVertices =
    parcel.vertices.length >= 3 ? parcel.vertices : parcel.spatial.polygons.parcel;
  const uniqueVertices = deduplicateClosingVertex(rawVertices);
  const closedRing = toCounterClockwiseClosedRing(uniqueVertices);

  const lons = uniqueVertices.map((v) => Number(v.lon.toFixed(6)));
  const lats = uniqueVertices.map((v) => Number(v.lat.toFixed(6)));
  const bbox: [number, number, number, number] =
    uniqueVertices.length > 0
      ? [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
      : [0, 0, 0, 0];

  const boundaryFeature = {
    type: 'Feature' as const,
    id: parcel.id,
    properties: {
      feature_role: 'PARCEL_BOUNDARY',
      parcel_id: parcel.id,
      label: parcel.label,
      bupi_rgg_id: parcel.bupiRggId,
      matrix_article: parcel.matrixArticle,
      municipality: parcel.municipality,
      parish: parcel.parish,
      district: parcel.district,
      dico: parcel.dico,
      dicofre: parcel.dicofre,
      land_class: parcel.landClass,
      vertex_count: uniqueVertices.length,
      total_area_m2: parcel.spatial.totalAreaM2,
      perimeter_m: parcel.spatial.perimeterM,
      mandatory_clean_area_m2: parcel.spatial.mandatoryCleanAreaM2,
      zone1_immediate_0_2m_m2: parcel.spatial.zone1ImmediateM2,
      zone2_near_2_10m_m2: parcel.spatial.zone2NearM2,
      zone3_extended_10_50m_m2: parcel.spatial.zone3ExtendedM2,
      eredes_easement_m2: parcel.spatial.thirdPartyEasementM2,
      exempt_area_m2: parcel.spatial.exemptAreaM2,
      avg_slope_pct: parcel.avgSlopePct,
      has_protected_oaks: parcel.hasProtectedOaks,
      has_eredes_line: parcel.hasEredesLine,
      centroid_wgs84_lat: parcel.spatial.centroidWgs84.lat,
      centroid_wgs84_lon: parcel.spatial.centroidWgs84.lon,
      centroid_pt_tm06_x_m: parcel.spatial.centroidPtTm06.x,
      centroid_pt_tm06_y_m: parcel.spatial.centroidPtTm06.y,
      metric_projection: 'ETRS89 / PT-TM06 (EPSG:3763)',
      legal_basis: 'DL 82/2021 (SGIFR) + Despacho 675/2026',
      exported_at: exportedAtIso,
    },
    geometry: {
      type: 'Polygon' as const,
      coordinates: [closedRing],
    },
  };

  const vertexFeatures = uniqueVertices.map((vertex, idx) => {
    const lon = Number(vertex.lon.toFixed(6));
    const lat = Number(vertex.lat.toFixed(6));
    const ptTm06 = wgs84ToPtTm06(vertex);
    return {
      type: 'Feature' as const,
      id: `${parcel.id}-v${idx + 1}`,
      properties: {
        feature_role: 'PARCEL_VERTEX',
        parcel_id: parcel.id,
        bupi_rgg_id: parcel.bupiRggId,
        vertex_index: idx + 1,
        vertex_label: `V${idx + 1}`,
        lon_wgs84: lon,
        lat_wgs84: lat,
        pt_tm06_x_m: ptTm06.x,
        pt_tm06_y_m: ptTm06.y,
      },
      geometry: {
        type: 'Point' as const,
        coordinates: [lon, lat],
      },
    };
  });

  const featureCollection = {
    type: 'FeatureCollection' as const,
    name: `FaixaSegura_${parcel.bupiRggId || parcel.id}`,
    bbox,
    crs: {
      type: 'name',
      properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' },
    },
    features: [boundaryFeature, ...vertexFeatures],
  };

  return JSON.stringify(featureCollection, null, 2);
}

export interface ParcelLeafletBounds {
  southWest: LatLon;
  northEast: LatLon;
  center: LatLon;
  leafletBounds: [[number, number], [number, number]];
}

/**
 * Computes WGS84 bounding box coordinates for centering and fitting a Leaflet map
 * onto the active parcel's boundary vertices with safe fallback padding.
 */
export function computeParcelLeafletBounds(parcel: ParcelRecord): ParcelLeafletBounds {
  const sourceVertices =
    parcel.vertices.length >= 3
      ? parcel.vertices
      : parcel.spatial.polygons.parcel.length >= 3
        ? parcel.spatial.polygons.parcel
        : [];

  if (sourceVertices.length === 0) {
    const c = parcel.spatial.centroidWgs84;
    const sw = offsetMetersFromWgs84(c, -40, -40);
    const ne = offsetMetersFromWgs84(c, 40, 40);
    return {
      southWest: sw,
      northEast: ne,
      center: c,
      leafletBounds: [
        [sw.lat, sw.lon],
        [ne.lat, ne.lon],
      ],
    };
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  for (const pt of sourceVertices) {
    if (pt.lat < minLat) minLat = pt.lat;
    if (pt.lat > maxLat) maxLat = pt.lat;
    if (pt.lon < minLon) minLon = pt.lon;
    if (pt.lon > maxLon) maxLon = pt.lon;
  }

  // Ensure non-zero span even on collinear / ultra-tight vertices
  if (maxLat - minLat < 0.00015) {
    minLat -= 0.00015;
    maxLat += 0.00015;
  }
  if (maxLon - minLon < 0.00015) {
    minLon -= 0.00015;
    maxLon += 0.00015;
  }

  const southWest: LatLon = {
    lat: Number(minLat.toFixed(6)),
    lon: Number(minLon.toFixed(6)),
  };
  const northEast: LatLon = {
    lat: Number(maxLat.toFixed(6)),
    lon: Number(maxLon.toFixed(6)),
  };
  const center: LatLon = {
    lat: Number(((minLat + maxLat) / 2).toFixed(6)),
    lon: Number(((minLon + maxLon) / 2).toFixed(6)),
  };

  return {
    southWest,
    northEast,
    center,
    leafletBounds: [
      [southWest.lat, southWest.lon],
      [northEast.lat, northEast.lon],
    ],
  };
}

function toOrientedClosedRing(
  vertices: LatLon[],
  counterClockwise: boolean
): Array<[number, number]> {
  const ccw = toCounterClockwiseClosedRing(vertices);
  if (ccw.length < 4) return ccw;
  if (counterClockwise) return ccw;
  // Interior hole rings in RFC 7946 §3.1.6 must be clockwise
  return [...ccw].reverse();
}

function latLonMultiPolygonToGeoJsonCoords(
  mp: LatLonMultiPolygon | undefined
): Array<Array<Array<[number, number]>>> {
  if (!mp || mp.length === 0) return [];
  const out: Array<Array<Array<[number, number]>>> = [];
  for (const poly of mp) {
    if (!poly || poly.length === 0) continue;
    const rings: Array<Array<[number, number]>> = [];
    for (let r = 0; r < poly.length; r++) {
      const closed = toOrientedClosedRing(poly[r], r === 0);
      if (closed.length >= 4) {
        rings.push(closed);
      }
    }
    if (rings.length > 0) {
      out.push(rings);
    }
  }
  return out;
}

export function buildParcelLegalGeoJsonFilename(
  parcel: Pick<ParcelRecord, 'id' | 'bupiRggId' | 'municipality' | 'label'>
): string {
  const refSlug = slugifyAscii(parcel.bupiRggId || parcel.id || 'parcela');
  const munSlug = slugifyAscii(parcel.municipality || 'portugal');
  const base = ['faixasegura-camadas-legais', refSlug, munSlug].filter(Boolean).join('-');
  return `${base}.geojson`;
}

/**
 * Exports all boolean legal decomposition layers (MultiPolygons with true interior holes + detected easements/waterways)
 * as an RFC 7946 GeoJSON FeatureCollection ready for QGIS, ArcGIS Pro, BUPi, and Municipal GTF audit.
 */
export function buildParcelLegalDecompositionGeoJson(
  parcel: ParcelRecord,
  exportedAtIso: string = new Date().toISOString()
): string {
  const sp = parcel.spatial;
  const mp = sp.multiPolygons;
  const meta = sp.decompositionMeta;

  const rawVertices =
    parcel.vertices.length >= 3 ? parcel.vertices : sp.polygons.parcel;
  const uniqueVertices = deduplicateClosingVertex(rawVertices);
  const parcelClosedRing = toCounterClockwiseClosedRing(uniqueVertices);

  const features: Array<Record<string, unknown>> = [
    {
      type: 'Feature',
      id: `${parcel.id}-boundary`,
      properties: {
        layer_code: 'PARCEL_BOUNDARY',
        layer_label_pt: 'Limite Cadastral da Parcela (RGG)',
        parcel_id: parcel.id,
        bupi_rgg_id: parcel.bupiRggId,
        municipality: parcel.municipality,
        parish: parcel.parish,
        area_m2: sp.totalAreaM2,
        perimeter_m: sp.perimeterM,
        human_verified_count: parcel.vectorContext?.humanVerifiedCount ?? 0,
        engine_version: meta?.engineVersion ?? 'BOOLEAN_EPSG3763_V2',
        metric_crs: 'ETRS89 / PT-TM06 (EPSG:3763)',
        exported_at: exportedAtIso,
      },
      geometry: {
        type: 'Polygon',
        coordinates: [parcelClosedRing],
      },
    },
  ];

  const pushMultiPolygonLayer = (params: {
    code: string;
    labelPt: string;
    legalRulePt: string;
    areaM2: number;
    colorHex: string;
    multiPoly?: LatLonMultiPolygon;
    fallbackSingleRing?: LatLon[];
  }) => {
    const coords =
      params.multiPoly && params.multiPoly.length > 0
        ? latLonMultiPolygonToGeoJsonCoords(params.multiPoly)
        : params.fallbackSingleRing && params.fallbackSingleRing.length >= 3
          ? [[toCounterClockwiseClosedRing(params.fallbackSingleRing)]]
          : [];

    if (coords.length === 0) return;

    features.push({
      type: 'Feature',
      id: `${parcel.id}-${params.code.toLowerCase()}`,
      properties: {
        layer_code: params.code,
        layer_label_pt: params.labelPt,
        legal_rule: params.legalRulePt,
        area_m2: params.areaM2,
        stroke_hex: params.colorHex,
        parcel_id: parcel.id,
        bupi_rgg_id: parcel.bupiRggId,
      },
      geometry: {
        type: 'MultiPolygon',
        coordinates: coords,
      },
    });
  };

  pushMultiPolygonLayer({
    code: 'OWN_BUILDINGS',
    labelPt: 'Edificações Próprias na Parcela',
    legalRulePt: 'Alvenaria base para medição das faixas concêntricas (Despacho n.º 675/2026)',
    areaM2: meta?.ownBuildingsAreaM2 ?? 0,
    colorHex: '#FFFFFF',
    multiPoly: mp?.ownBuildings,
    fallbackSingleRing: sp.polygons.buildingFootprint,
  });

  pushMultiPolygonLayer({
    code: 'NEIGHBOR_BUILDINGS',
    labelPt: 'Edificações Vizinhas Confinantes (<= 50m/100m)',
    legalRulePt: 'Edifícios externos que projetam obrigação legal de limpeza sobre esta parcela',
    areaM2:
      parcel.vectorContext?.buildings
        .filter((b) => b.role === 'NEIGHBOR')
        .reduce((acc, b) => acc + b.areaM2, 0) ?? 0,
    colorHex: '#C084FC',
    multiPoly: mp?.neighborBuildings,
  });

  pushMultiPolygonLayer({
    code: 'ZONE_1_IMMEDIATE_0_2M',
    labelPt: 'Zona 1 · Interface Imediata (0–2 m)',
    legalRulePt: 'Faixa inerte obrigatória (brita, lajeado ou solo mineral nu) — Despacho n.º 675/2026',
    areaM2: sp.zone1ImmediateM2,
    colorHex: '#E11D48',
    multiPoly: mp?.zone1Immediate,
    fallbackSingleRing: sp.polygons.zone1Immediate,
  });

  pushMultiPolygonLayer({
    code: 'ZONE_2_NEAR_2_10M',
    labelPt: 'Zona 2 · Interface Próxima (2–10 m)',
    legalRulePt: 'Desramação a 50% / mín. 4 m e zero copas a < 5 m da alvenaria — Despacho n.º 675/2026',
    areaM2: sp.zone2NearM2,
    colorHex: '#EA580C',
    multiPoly: mp?.zone2Near,
    fallbackSingleRing: sp.polygons.zone2Near,
  });

  pushMultiPolygonLayer({
    code: 'ZONE_3_EXTENDED_10_50M',
    labelPt: `Zona 3 · Interface Alargada (10–${meta?.outerBufferRadiusM ?? 50} m)`,
    legalRulePt: 'Corte de mato (< 20 cm) e afastamento de copas 4 m / 10 m (pinheiro/eucalipto)',
    areaM2: sp.zone3ExtendedM2,
    colorHex: '#F59E0B',
    multiPoly: mp?.zone3Extended,
    fallbackSingleRing: sp.polygons.zone3Extended,
  });

  pushMultiPolygonLayer({
    code: 'NEIGHBOR_INDUCED_OBLIGATION',
    labelPt: 'Sub-camada · Obrigação Induzida por Edifício Vizinho',
    legalRulePt: 'Área dentro da nossa parcela cuja limpeza é exigida exclusivamente por habitação confinante',
    areaM2: meta?.neighborInducedCleanAreaM2 ?? 0,
    colorHex: '#FB7185',
    multiPoly: mp?.neighborInducedObligation,
  });

  pushMultiPolygonLayer({
    code: 'THIRD_PARTY_EASEMENT',
    labelPt: 'Servidões de Terceiros (E-REDES / REN / Rede Viária)',
    legalRulePt: 'Gestão de combustível da responsabilidade da entidade gestora (Art.º 49.º DL 82/2021)',
    areaM2: sp.thirdPartyEasementM2,
    colorHex: '#06B6D4',
    multiPoly: mp?.thirdPartyCorridor,
    fallbackSingleRing: sp.polygons.thirdPartyCorridor,
  });

  pushMultiPolygonLayer({
    code: 'RIPARIAN_AGRI_EXEMPT',
    labelPt: 'Galeria Ripícola & Solo Agrícola Protegido',
    legalRulePt: 'Isenção ambiental de vegetação ripícola e culturas agrícolas regadas (DL 82/2021)',
    areaM2: meta?.riparianProtectedM2 ?? 0,
    colorHex: '#10B981',
    multiPoly: mp?.riparianAndAgriExempt,
  });

  pushMultiPolygonLayer({
    code: 'EXEMPT_ZONE',
    labelPt: 'Zona Total Isenta de Gestão Florestal',
    legalRulePt: 'Fora dos buffers legais ou protegida por regime hídrico/agrícola',
    areaM2: sp.exemptAreaM2,
    colorHex: '#4ADE80',
    multiPoly: mp?.exemptCore,
    fallbackSingleRing: sp.polygons.exemptCore,
  });

  pushMultiPolygonLayer({
    code: 'NEIGHBOR_OVERFLOW_RISK',
    labelPt: 'Transbordo da Faixa de 50 m sobre Terreno Vizinho',
    legalRulePt: 'Coroa exterior de proteção da nossa habitação incidente sobre prédio confinante (Art.º 57.º/58.º DL 82/2021)',
    areaM2: meta?.neighborOverflowRiskM2 ?? 0,
    colorHex: '#A855F7',
    multiPoly: mp?.neighborRiskOverflow,
    fallbackSingleRing: sp.polygons.neighborRiskParcel,
  });

  // Include individual human-verified building footprints & linear/polygonal context features for CAD/GIS audit
  for (const bldg of parcel.vectorContext?.buildings ?? []) {
    if (bldg.source === 'USER_DEFINED' && bldg.footprint.length >= 3) {
      features.push({
        type: 'Feature',
        id: `${parcel.id}-hitl-bldg-${bldg.id}`,
        properties: {
          layer_code: 'USER_VERIFIED_BUILDING',
          building_id: bldg.id,
          role: bldg.role,
          label_pt: bldg.label,
          area_m2: bldg.areaM2,
          dist_parcel_edge_m: bldg.distanceToParcelEdgeM,
          source: bldg.source,
          human_verified: true,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [toCounterClockwiseClosedRing(bldg.footprint)],
        },
      });
    }
  }

  for (const eas of parcel.vectorContext?.easements ?? []) {
    if (eas.centerline.length >= 2) {
      features.push({
        type: 'Feature',
        id: `${parcel.id}-line-${eas.id}`,
        properties: {
          layer_code: 'DETECTED_EASEMENT_AXIS',
          easement_category: eas.category,
          label_pt: eas.label,
          operator: eas.operatorLabel,
          half_width_m: eas.bufferHalfWidthM,
          source: eas.source,
          human_verified: eas.source === 'USER_DEFINED',
        },
        geometry: {
          type: 'LineString',
          coordinates: eas.centerline.map((pt) => [
            Number(pt.lon.toFixed(6)),
            Number(pt.lat.toFixed(6)),
          ]),
        },
      });
    }
  }

  for (const ex of parcel.vectorContext?.exemptFeatures ?? []) {
    if (ex.centerline && ex.centerline.length >= 2) {
      features.push({
        type: 'Feature',
        id: `${parcel.id}-water-${ex.id}`,
        properties: {
          layer_code: 'DETECTED_WATERWAY_AXIS',
          exempt_category: ex.category,
          label_pt: ex.label,
          legal_basis: ex.legalBasis,
          half_width_m: ex.bufferHalfWidthM ?? 5,
          source: ex.source,
          human_verified: ex.source === 'USER_DEFINED',
        },
        geometry: {
          type: 'LineString',
          coordinates: ex.centerline.map((pt) => [
            Number(pt.lon.toFixed(6)),
            Number(pt.lat.toFixed(6)),
          ]),
        },
      });
    } else if (ex.polygon && ex.polygon.length >= 3) {
      features.push({
        type: 'Feature',
        id: `${parcel.id}-exempt-poly-${ex.id}`,
        properties: {
          layer_code: 'DETECTED_EXEMPT_POLYGON',
          exempt_category: ex.category,
          label_pt: ex.label,
          legal_basis: ex.legalBasis,
          source: ex.source,
          human_verified: ex.source === 'USER_DEFINED',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [toCounterClockwiseClosedRing(ex.polygon)],
        },
      });
    }
  }

  // Phase 2 & Phase 3 CV Layers: Individual Tree Crowns & Unmapped Roof Structures from 25 cm Orthophoto
  if (parcel.cvAnalysis) {
    for (const crown of parcel.cvAnalysis.crowns) {
      if (crown.polygonWgs84.length >= 3) {
        features.push({
          type: 'Feature',
          id: `${parcel.id}-cv-${crown.id}`,
          properties: {
            layer_code: 'DETECTED_TREE_CROWN',
            crown_id: crown.id,
            species_group: crown.speciesGroup,
            diameter_m: crown.diameterM,
            area_m2: crown.areaM2,
            dist_building_wall_m: crown.distanceToBuildingWallM,
            nearest_crown_dist_m: crown.nearestCrownDistanceM,
            zone_code: crown.zoneCode,
            compliant: crown.violationRulePt === null,
            violation_rule_pt: crown.violationRulePt,
            human_override: crown.humanOverride ?? null,
            gsd_m_px: parcel.cvAnalysis.gsdMetersPerPx,
          },
          geometry: {
            type: 'Polygon',
            coordinates: [toCounterClockwiseClosedRing(crown.polygonWgs84)],
          },
        });
      }
    }

    for (const roof of parcel.cvAnalysis.detectedRoofs) {
      if (roof.isUnmappedInOsm && roof.footprintWgs84.length >= 3) {
        features.push({
          type: 'Feature',
          id: `${parcel.id}-cv-${roof.id}`,
          properties: {
            layer_code: 'CV_UNMAPPED_STRUCTURE',
            structure_id: roof.id,
            label_pt: roof.label,
            role: roof.role,
            area_m2: roof.areaM2,
            confidence: roof.confidence,
            dist_parcel_edge_m: roof.distanceToParcelEdgeM,
            review_status: roof.reviewStatus ?? 'UNREVIEWED',
          },
          geometry: {
            type: 'Polygon',
            coordinates: [toCounterClockwiseClosedRing(roof.footprintWgs84)],
          },
        });
      }
    }
  }

  return JSON.stringify(
    {
      type: 'FeatureCollection',
      name: `FaixaSegura_Decomposicao_Legal_${parcel.bupiRggId || parcel.id}`,
      crs: {
        type: 'name',
        properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' },
      },
      features,
    },
    null,
    2
  );
}

