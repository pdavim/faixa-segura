import type {
  DetectedExemptFeature,
  DetectedLinearEasement,
  DetectedVectorBuilding,
  LatLon,
  ParcelRecord,
  ParcelVectorContext,
} from '../types/domain.ts';
import {
  cleanOpenRing3763,
  computeExternalPolygonDistanceToParcel3763,
  computeMultiPolygonArea3763,
  isPointInRing3763,
  latLonRingToMultiPolygon3763,
  projectWgs84ToPtTm06Exact,
  ptTm06ToWgs84,
} from './booleanSpatialEngine.ts';

export interface OverpassGeomPoint {
  lat: number;
  lon: number;
}

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: OverpassGeomPoint[];
}

export interface OverpassResponsePayload {
  elements?: OverpassElement[];
}

/**
 * Computes a padded WGS84 bounding box [south, west, north, east] around parcel vertices.
 */
export function computePaddedBoundingBoxWgs84(
  vertices: LatLon[],
  paddingMeters = 110
): [number, number, number, number] {
  if (vertices.length === 0) {
    return [38.797, -9.464, 38.80, -9.46];
  }
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  for (const v of vertices) {
    if (v.lat < minLat) minLat = v.lat;
    if (v.lat > maxLat) maxLat = v.lat;
    if (v.lon < minLon) minLon = v.lon;
    if (v.lon > maxLon) maxLon = v.lon;
  }

  const midLatRad = (((minLat + maxLat) / 2) * Math.PI) / 180;
  const dLat = paddingMeters / 111132.0;
  const dLon = paddingMeters / Math.max(25000, 111320.0 * Math.cos(midLatRad));

  return [
    Number((minLat - dLat).toFixed(6)),
    Number((minLon - dLon).toFixed(6)),
    Number((maxLat + dLat).toFixed(6)),
    Number((maxLon + dLon).toFixed(6)),
  ];
}

/**
 * Builds an Overpass QL query fetching real buildings, overhead powerlines, power poles/towers,
 * public roads, waterways, and agricultural/residential landuse within ~110m of the parcel.
 */
export function buildOverpassParcelContextQuery(
  vertices: LatLon[],
  searchRadiusM = 110
): string {
  const [south, west, north, east] = computePaddedBoundingBoxWgs84(vertices, searchRadiusM);
  const bbox = `${south},${west},${north},${east}`;
  return [
    '[out:json][timeout:8];',
    '(',
    `  way["building"](${bbox});`,
    `  way["power"~"^(line|minor_line)$"](${bbox});`,
    `  node["power"~"^(tower|pole)$"](${bbox});`,
    `  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential)$"](${bbox});`,
    `  way["waterway"~"^(river|stream|canal|drain)$"](${bbox});`,
    `  way["landuse"~"^(orchard|vineyard|farmland|residential)$"](${bbox});`,
    ');',
    'out body geom;',
  ].join('\n');
}

function normalizeWayLatLons(geom?: OverpassGeomPoint[]): LatLon[] {
  if (!Array.isArray(geom)) return [];
  const out: LatLon[] = [];
  for (const pt of geom) {
    if (typeof pt?.lat === 'number' && typeof pt?.lon === 'number') {
      const prev = out[out.length - 1];
      if (!prev || Math.abs(prev.lat - pt.lat) > 1e-7 || Math.abs(prev.lon - pt.lon) > 1e-7) {
        out.push({
          lat: Number(pt.lat.toFixed(6)),
          lon: Number(pt.lon.toFixed(6)),
        });
      }
    }
  }
  return out;
}

function stripClosingLatLon(pts: LatLon[]): LatLon[] {
  if (pts.length >= 4) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.abs(first.lat - last.lat) < 1e-6 && Math.abs(first.lon - last.lon) < 1e-6) {
      return pts.slice(0, -1);
    }
  }
  return pts;
}

function parseVoltageKv(rawVoltage?: string): number {
  if (!rawVoltage) return 0;
  const firstToken = rawVoltage.split(/[;,]/)[0]?.trim() ?? '';
  const num = Number(firstToken);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return num >= 1000 ? num / 1000 : num;
}

function minDistancePolylineToParcel3763(
  linePts: LatLon[],
  parcelOpenRing3763: Array<[number, number]>
): number {
  const projected = linePts.map(projectWgs84ToPtTm06Exact);
  for (const pt of projected) {
    if (isPointInRing3763(pt, parcelOpenRing3763)) return 0;
  }
  let minD = Infinity;
  for (const pt of projected) {
    for (const pv of parcelOpenRing3763) {
      const d = Math.hypot(pt[0] - pv[0], pt[1] - pv[1]);
      if (d < minD) minD = d;
    }
  }
  return minD;
}

/**
 * Parses a raw Overpass JSON payload into legal/physical vector context around a parcel:
 * - Classifies buildings as OWN (overlapping/inside parcel) vs NEIGHBOR (outside within <= 100 m)
 * - Classifies E-REDES / REN overhead powerlines (and reconstructs minor lines from aligned poles)
 * - Classifies public municipal/national roads (10 m legal roadside corridor per Art.º 49.º DL 82/2021)
 * - Classifies riparian waterways (5 m protected gallery) and irrigated orchards/vineyards
 */
export function parseOverpassVectorContext(params: {
  overpassJson: unknown;
  parcelVertices: LatLon[];
  searchRadiusM?: number;
  detectedAtIso?: string;
}): ParcelVectorContext {
  const searchRadiusM = params.searchRadiusM ?? 110;
  const detectedAtIso = params.detectedAtIso ?? new Date().toISOString();
  const parcelMp = latLonRingToMultiPolygon3763(params.parcelVertices);
  const parcelOpen3763 = cleanOpenRing3763(
    params.parcelVertices.map(projectWgs84ToPtTm06Exact)
  );

  const raw = params.overpassJson as OverpassResponsePayload | null | undefined;
  const elements = Array.isArray(raw?.elements) ? raw.elements : [];

  const buildings: DetectedVectorBuilding[] = [];
  const easements: DetectedLinearEasement[] = [];
  const exemptFeatures: DetectedExemptFeature[] = [];
  const powerPoles: LatLon[] = [];
  let hasResidentialLanduse = false;
  let settlementName: string | undefined;

  for (const el of elements) {
    const tags = el.tags ?? {};

    if (
      el.type === 'node' &&
      (tags.power === 'pole' || tags.power === 'tower') &&
      typeof el.lat === 'number' &&
      typeof el.lon === 'number'
    ) {
      powerPoles.push({ lat: Number(el.lat.toFixed(6)), lon: Number(el.lon.toFixed(6)) });
      continue;
    }

    if (el.type !== 'way') continue;
    const pts = normalizeWayLatLons(el.geometry);
    if (pts.length < 2) continue;

    // 1. Building footprints
    if (tags.building && pts.length >= 3) {
      const footprint = stripClosingLatLon(pts);
      if (footprint.length < 3) continue;
      const bMp = latLonRingToMultiPolygon3763(footprint);
      const areaM2 = Number(computeMultiPolygonArea3763(bMp).toFixed(2));
      if (areaM2 < 6) continue; // Ignore tiny sheds < 6 m²

      const bRing3763 = cleanOpenRing3763(footprint.map(projectWgs84ToPtTm06Exact));
      const distM = computeExternalPolygonDistanceToParcel3763(
        bRing3763,
        parcelMp,
        parcelOpen3763
      );

      if (distM > 100) continue;
      const role: 'OWN' | 'NEIGHBOR' = distM === 0 ? 'OWN' : 'NEIGHBOR';
      const bType = tags.building === 'yes' ? 'Edifício' : `Edifício (${tags.building})`;

      buildings.push({
        id: `osm-bldg-${el.id}`,
        role,
        label:
          tags.name ||
          (role === 'OWN'
            ? `${bType} na Parcela`
            : `${bType} Confinante (${distM.toFixed(1)} m)`),
        source: 'OSM_OVERPASS',
        footprint,
        areaM2,
        distanceToParcelEdgeM: distM,
      });
      continue;
    }

    // 2. Overhead powerlines (E-REDES / REN)
    if (tags.power === 'line' || tags.power === 'minor_line') {
      const distM = minDistancePolylineToParcel3763(pts, parcelOpen3763);
      if (distM > 35) continue;
      const kv = parseVoltageKv(tags.voltage);
      const isRenMat = kv >= 110;
      const halfWidthM = isRenMat ? 14.0 : tags.power === 'line' || kv >= 45 ? 5.0 : 3.5;

      easements.push({
        id: `osm-power-${el.id}`,
        category: isRenMat ? 'REN_MAT' : 'EREDES_MT_AT',
        label: isRenMat
          ? `Linha Muito Alta Tensão (${kv || 150} kV)`
          : tags.power === 'line'
            ? `Linha Alta/Média Tensão (${kv || 60} kV)`
            : 'Linha Aérea Média Tensão (15–30 kV)',
        operatorLabel: tags.operator || (isRenMat ? 'REN Rede Elétrica Nacional' : 'E-REDES'),
        bufferHalfWidthM: halfWidthM,
        centerline: pts,
        source: 'OSM_OVERPASS',
      });
      continue;
    }

    // 3. Public Roads (10m roadside protection corridor per Art.º 49.º DL 82/2021)
    if (tags.highway) {
      const distM = minDistancePolylineToParcel3763(pts, parcelOpen3763);
      if (distM > 18) continue;
      const roadName = tags.name || tags.ref || `Via Pública (${tags.highway})`;
      easements.push({
        id: `osm-road-${el.id}`,
        category: 'PUBLIC_ROAD',
        label: `Faixa Viária: ${roadName}`,
        operatorLabel: 'Município / Infraestruturas de Portugal',
        bufferHalfWidthM: 5.0,
        centerline: pts,
        source: 'OSM_OVERPASS',
      });
      continue;
    }

    // 4. Waterways (Protected riparian corridor per DL 82/2021)
    if (tags.waterway) {
      const distM = minDistancePolylineToParcel3763(pts, parcelOpen3763);
      if (distM > 20) continue;
      const waterName = tags.name || (tags.waterway === 'river' ? 'Rio / Ribeira' : 'Linha de Água');
      exemptFeatures.push({
        id: `osm-water-${el.id}`,
        category: 'RIPARIAN_WATERWAY',
        label: `Galeria Ripícola: ${waterName}`,
        legalBasis: 'Proteção de galeria ripícola (Art.º 49.º DL 82/2021 & Lei da Água)',
        bufferHalfWidthM: tags.waterway === 'river' ? 8.0 : 5.0,
        centerline: pts,
        source: 'OSM_OVERPASS',
      });
      continue;
    }

    // 5. Landuse (Irrigated orchard/vineyard exemptions & residential cluster detection)
    if (tags.landuse === 'residential') {
      hasResidentialLanduse = true;
      if (tags.name) settlementName = tags.name;
      continue;
    }

    if (
      (tags.landuse === 'orchard' ||
        tags.landuse === 'vineyard' ||
        tags.landuse === 'farmland') &&
      pts.length >= 3
    ) {
      const poly = stripClosingLatLon(pts);
      if (poly.length >= 3) {
        exemptFeatures.push({
          id: `osm-agri-${el.id}`,
          category: 'IRRIGATED_AGRICULTURE',
          label:
            tags.landuse === 'vineyard'
              ? 'Vinha / Cultura Agrícola'
              : tags.landuse === 'orchard'
                ? 'Pomar / Olival Ordenado'
                : 'Parcela Agrícola Cultivada',
          legalBasis: 'Solo agrícola cultivado isento de desbaste florestal (DL 82/2021)',
          polygon: poly,
          source: 'OSM_OVERPASS',
        });
      }
    }
  }

  // Reconstruct minor overhead line if >= 2 aligned power poles were mapped without an explicit way
  if (
    easements.every((e) => e.category !== 'EREDES_MT_AT' && e.category !== 'REN_MAT') &&
    powerPoles.length >= 2
  ) {
    const sortedPoles = [...powerPoles].sort((a, b) => a.lon - b.lon);
    const distM = minDistancePolylineToParcel3763(sortedPoles, parcelOpen3763);
    if (distM <= 25) {
      easements.push({
        id: 'osm-poles-reconstructed',
        category: 'EREDES_MT_AT',
        label: `Linha Aérea Reconstruída (${sortedPoles.length} apoios mapeados)`,
        operatorLabel: 'E-REDES',
        bufferHalfWidthM: 3.5,
        centerline: sortedPoles,
        source: 'OSM_OVERPASS',
      });
    }
  }

  // Sort neighbor buildings closest-first
  buildings.sort((a, b) => a.distanceToParcelEdgeM - b.distanceToParcelEdgeM);

  const totalBuildingsNear = buildings.length;
  const isSettlementInterface100m = hasResidentialLanduse || totalBuildingsNear >= 10;

  return {
    detectedAtIso,
    sourceMode: 'LIVE_OVERPASS_WFS',
    sourceSummaryPt: `OpenStreetMap Overpass em Tempo Real (${buildings.length} edifícios · ${easements.length} servidões · ${exemptFeatures.length} zonas ripícolas/agrícolas)`,
    searchRadiusM,
    isSettlementInterface100m,
    settlementName,
    buildings,
    easements,
    exemptFeatures,
  };
}

/**
 * Deterministic Cadastral Vector Context Synthesizer:
 * Used when offline or in rural areas where public OSM has 0 mapped footprints around the parcel,
 * producing physically realistic own building, neighbor dwelling (<50m), E-REDES corridor, and
 * optional riparian stream anchored to the parcel's exact EPSG:3763 geometry.
 */
export function synthesizeDeterministicCadastreContext(params: {
  parcelVertices: LatLon[];
  buildingCenter?: LatLon;
  hasEredesLine: boolean;
  eredesType?: ParcelRecord['eredesType'];
  hasProtectedOaks?: boolean;
  detectedAtIso?: string;
}): ParcelVectorContext {
  const detectedAtIso = params.detectedAtIso ?? new Date().toISOString();
  const open3763 = cleanOpenRing3763(params.parcelVertices.map(projectWgs84ToPtTm06Exact));

  const xs = open3763.map((p) => p[0]);
  const ys = open3763.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const spanX = Math.max(20, maxX - minX);
  const spanY = Math.max(20, maxY - minY);

  const bCenter3763 = params.buildingCenter
    ? projectWgs84ToPtTm06Exact(params.buildingCenter)
    : ([cx - spanX * 0.12, cy - spanY * 0.06] as [number, number]);

  const ownFootprint: LatLon[] = [
    ptTm06ToWgs84([bCenter3763[0] - 5.8, bCenter3763[1] - 4.4]),
    ptTm06ToWgs84([bCenter3763[0] + 5.8, bCenter3763[1] - 4.4]),
    ptTm06ToWgs84([bCenter3763[0] + 5.8, bCenter3763[1] + 4.4]),
    ptTm06ToWgs84([bCenter3763[0] - 5.8, bCenter3763[1] + 4.4]),
  ];

  // Neighbor house 18.5 m outside eastern/northeastern boundary (induces 50m obligation inside our parcel!)
  const nbCenterX = maxX + 18.5;
  const nbCenterY = cy + spanY * 0.12;
  const neighborFootprint: LatLon[] = [
    ptTm06ToWgs84([nbCenterX - 5.0, nbCenterY - 4.5]),
    ptTm06ToWgs84([nbCenterX + 5.0, nbCenterY - 4.5]),
    ptTm06ToWgs84([nbCenterX + 5.0, nbCenterY + 4.5]),
    ptTm06ToWgs84([nbCenterX - 5.0, nbCenterY + 4.5]),
  ];

  const buildings: DetectedVectorBuilding[] = [
    {
      id: 'synth-bldg-own-1',
      role: 'OWN',
      label: 'Habitação Principal na Parcela',
      source: 'CADASTRO_SEED',
      footprint: ownFootprint,
      areaM2: 102.1,
      distanceToParcelEdgeM: 0,
    },
    {
      id: 'synth-bldg-neighbor-1',
      role: 'NEIGHBOR',
      label: 'Habitação Confinante a Nascente (13.5 m)',
      source: 'CADASTRO_SEED',
      footprint: neighborFootprint,
      areaM2: 90.0,
      distanceToParcelEdgeM: 13.5,
    },
  ];

  const easements: DetectedLinearEasement[] = [];
  if (params.hasEredesLine) {
    const isAt60 = params.eredesType?.includes('60kV');
    easements.push({
      id: 'synth-eredes-1',
      category: 'EREDES_MT_AT',
      label: isAt60 ? 'Linha Aérea AT 60 kV (Faixa 10 m)' : 'Linha Aérea MT 15 kV (Faixa 8.5 m)',
      operatorLabel: 'E-REDES Distribuição Elétrica',
      bufferHalfWidthM: isAt60 ? 5.0 : 4.25,
      centerline: [
        ptTm06ToWgs84([minX - 14, maxY - spanY * 0.14]),
        ptTm06ToWgs84([maxX + 14, maxY - spanY * 0.05]),
      ],
      source: 'CADASTRO_SEED',
    });
  }

  // Municipal access road bordering outside the southern boundary wall
  easements.push({
    id: 'synth-road-south',
    category: 'PUBLIC_ROAD',
    label: 'Caminho Municipal Pavimentado (Faixa Exterior)',
    operatorLabel: 'Câmara Municipal',
    bufferHalfWidthM: 4.0,
    centerline: [
      ptTm06ToWgs84([minX - 10, minY - 4.5]),
      ptTm06ToWgs84([maxX + 10, minY - 4.5]),
    ],
    source: 'CADASTRO_SEED',
  });

  const exemptFeatures: DetectedExemptFeature[] = [
    {
      id: 'synth-riparian-se',
      category: 'RIPARIAN_WATERWAY',
      label: 'Linha de Água Sazonal / Galeria Ripícola',
      legalBasis: 'Proteção de vegetação ripícola (Art.º 49.º DL 82/2021)',
      bufferHalfWidthM: 4.0,
      centerline: [
        ptTm06ToWgs84([minX + spanX * 0.68, maxY + 6]),
        ptTm06ToWgs84([maxX + 6, minY + spanY * 0.28]),
      ],
      source: 'CADASTRO_SEED',
    },
  ];

  // Adjacent western neighbor parcel polygon for exact infringement clipping
  const neighborParcels = [
    {
      id: 'synth-neighbor-parcel-west',
      label: 'Prédio Confinante Poente',
      bupiRef: 'Confrontação Poente (Cadastro RGG)',
      polygon: [
        ptTm06ToWgs84([minX - 42, minY - 4]),
        ptTm06ToWgs84([minX, minY - 4]),
        ptTm06ToWgs84([minX, maxY + 4]),
        ptTm06ToWgs84([minX - 42, maxY + 4]),
      ],
      ndvi: 0.74,
    },
  ];

  return {
    detectedAtIso,
    sourceMode: 'SYNTHESIZED_CADASTRE',
    sourceSummaryPt: `Síntese Cadastral Determinística (${buildings.length} edifícios · ${easements.length} servidões · ${exemptFeatures.length} linha de água)`,
    searchRadiusM: 110,
    isSettlementInterface100m: false,
    buildings,
    easements,
    exemptFeatures,
    neighborParcels,
  };
}

/**
 * Merges live Overpass vector detections with parcel baseline guarantees:
 * - If Overpass found real context features around the parcel, keeps all real features,
 *   and only injects the parcel's known dwelling if OSM had 0 mapped buildings inside rural woods.
 * - If Overpass returned completely empty (unmapped deep forest), falls back to deterministic cadastre context.
 */
export function finalizeParcelVectorContext(params: {
  liveParsed: ParcelVectorContext | null;
  parcelVertices: LatLon[];
  buildingCenter?: LatLon;
  hasEredesLine: boolean;
  eredesType?: ParcelRecord['eredesType'];
  hasProtectedOaks?: boolean;
  existingContext?: ParcelVectorContext;
}): ParcelVectorContext {
  const synth = synthesizeDeterministicCadastreContext({
    parcelVertices: params.parcelVertices,
    buildingCenter: params.buildingCenter,
    hasEredesLine: params.hasEredesLine,
    eredesType: params.eredesType,
    hasProtectedOaks: params.hasProtectedOaks,
  });

  const appendPreservedUserElements = (base: ParcelVectorContext): ParcelVectorContext => {
    const prev = params.existingContext;
    if (!prev) return base;
    const userBldgs = prev.buildings.filter((b) => b.source === 'USER_DEFINED');
    const userEas = prev.easements.filter((e) => e.source === 'USER_DEFINED');
    const userEx = prev.exemptFeatures.filter((ex) => ex.source === 'USER_DEFINED');
    const userTotal = userBldgs.length + userEas.length + userEx.length;
    if (userTotal === 0) return base;

    const userCenters = userBldgs.map((ub) => {
      const pts = ub.footprint.map(projectWgs84ToPtTm06Exact);
      const sx = pts.reduce((s, p) => s + p[0], 0) / Math.max(1, pts.length);
      const sy = pts.reduce((s, p) => s + p[1], 0) / Math.max(1, pts.length);
      return [sx, sy] as const;
    });

    const filteredAutoBldgs = base.buildings.filter((ab) => {
      if (ab.source === 'USER_DEFINED') return false;
      const pts = ab.footprint.map(projectWgs84ToPtTm06Exact);
      const ax = pts.reduce((s, p) => s + p[0], 0) / Math.max(1, pts.length);
      const ay = pts.reduce((s, p) => s + p[1], 0) / Math.max(1, pts.length);
      return !userCenters.some(([ux, uy]) => Math.hypot(ax - ux, ay - uy) <= 3.5);
    });

    return {
      ...base,
      humanVerifiedCount: userTotal,
      buildings: [...filteredAutoBldgs, ...userBldgs],
      easements: [...base.easements.filter((e) => e.source !== 'USER_DEFINED'), ...userEas],
      exemptFeatures: [
        ...base.exemptFeatures.filter((ex) => ex.source !== 'USER_DEFINED'),
        ...userEx,
      ],
      sourceSummaryPt: `${base.sourceSummaryPt} · +${userTotal} validado(s) manualmente`,
    };
  };

  if (!params.liveParsed) {
    return appendPreservedUserElements(synth);
  }

  const live = params.liveParsed;
  const totalLiveFeatures =
    live.buildings.length + live.easements.length + live.exemptFeatures.length;

  if (totalLiveFeatures === 0) {
    return appendPreservedUserElements(synth);
  }

  const mergedBuildings = [...live.buildings];
  const hasOwnBuilding =
    mergedBuildings.some((b) => b.role === 'OWN') ||
    (params.existingContext?.buildings.some(
      (b) => b.source === 'USER_DEFINED' && b.role === 'OWN'
    ) ??
      false);
  if (!hasOwnBuilding && synth.buildings[0]) {
    mergedBuildings.unshift({
      ...synth.buildings[0],
      label: 'Edificação na Parcela (Referência Cadastral)',
    });
  }

  const mergedEasements = [...live.easements];
  const hasPower =
    mergedEasements.some((e) => e.category === 'EREDES_MT_AT' || e.category === 'REN_MAT') ||
    (params.existingContext?.easements.some(
      (e) =>
        e.source === 'USER_DEFINED' &&
        (e.category === 'EREDES_MT_AT' || e.category === 'REN_MAT')
    ) ??
      false);
  if (params.hasEredesLine && !hasPower && synth.easements[0]) {
    mergedEasements.push(synth.easements[0]);
  }

  return appendPreservedUserElements({
    ...live,
    buildings: mergedBuildings,
    easements: mergedEasements,
    sourceSummaryPt: `OpenStreetMap Overpass + Cadastro (${mergedBuildings.length} edifícios · ${mergedEasements.length} servidões · ${live.exemptFeatures.length} zonas ripícolas/agrícolas)`,
  });
}
