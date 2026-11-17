import type { Pair } from 'polygon-clipping';
import type {
  DetectedExemptFeature,
  DetectedLinearEasement,
  DetectedRoofStructure,
  DetectedTreeCrown,
  DetectedVectorBuilding,
  EasementCategory,
  ExemptFeatureCategory,
  LatLon,
  ParcelOrthophotoCvAnalysis,
  ParcelRecord,
  ParcelVectorContext,
  ZoneCvComplianceMetrics,
} from '../types/domain.ts';
import {
  cleanOpenRing3763,
  computeExternalPolygonDistanceToParcel3763,
  computeMultiPolygonArea3763,
  latLonRingToMultiPolygon3763,
  projectWgs84ToPtTm06Exact,
  ptTm06ToWgs84,
} from './booleanSpatialEngine.ts';
import { computeParcelFgc } from './spatialEngine.ts';
import { synthesizeDeterministicCadastreContext } from './vectorContextIngestor.ts';

export type AssistedSubTool =
  | 'REVIEW'
  | 'OWN_BUILDING'
  | 'NEIGHBOR_BUILDING'
  | 'EASEMENT_LINE'
  | 'EXEMPT_ZONE';

export type BuildingDrawStyle = 'STAMP_1CLICK' | 'POLYGON';

export type EasementPresetCode = 'EREDES_MT' | 'EREDES_AT' | 'REN_MAT' | 'PUBLIC_ROAD';

export type ExemptPresetCode = 'RIPARIAN_WATERWAY' | 'IRRIGATED_AGRICULTURE';

export const EASEMENT_PRESETS: Record<
  EasementPresetCode,
  {
    category: EasementCategory;
    labelPt: string;
    operatorLabel: string;
    defaultHalfWidthM: number;
  }
> = {
  EREDES_MT: {
    category: 'EREDES_MT_AT',
    labelPt: 'Linha Aérea E-REDES Média Tensão (15–30 kV)',
    operatorLabel: 'E-REDES Distribuição Elétrica',
    defaultHalfWidthM: 4.25,
  },
  EREDES_AT: {
    category: 'EREDES_MT_AT',
    labelPt: 'Linha Aérea E-REDES Alta Tensão (60 kV)',
    operatorLabel: 'E-REDES Distribuição Elétrica',
    defaultHalfWidthM: 5.0,
  },
  REN_MAT: {
    category: 'REN_MAT',
    labelPt: 'Linha REN Muito Alta Tensão (150–400 kV)',
    operatorLabel: 'REN Rede Elétrica Nacional',
    defaultHalfWidthM: 14.0,
  },
  PUBLIC_ROAD: {
    category: 'PUBLIC_ROAD',
    labelPt: 'Estrada / Caminho Municipal Público',
    operatorLabel: 'Câmara Municipal / IP',
    defaultHalfWidthM: 5.0,
  },
};

export const EXEMPT_PRESETS: Record<
  ExemptPresetCode,
  {
    category: ExemptFeatureCategory;
    labelPt: string;
    legalBasis: string;
    minPoints: 2 | 3;
    defaultHalfWidthM?: number;
  }
> = {
  RIPARIAN_WATERWAY: {
    category: 'RIPARIAN_WATERWAY',
    labelPt: 'Ribeira / Linha de Água (Galeria Ripícola)',
    legalBasis: 'Proteção de vegetação ripícola (Art.º 49.º DL 82/2021 & Lei da Água)',
    minPoints: 2,
    defaultHalfWidthM: 5.0,
  },
  IRRIGATED_AGRICULTURE: {
    category: 'IRRIGATED_AGRICULTURE',
    labelPt: 'Pomar / Olival / Cultura Agrícola Regada',
    legalBasis: 'Solo agrícola cultivado isento de desbaste florestal (DL 82/2021)',
    minPoints: 3,
  },
};

/**
 * Ensures a parcel always has an initialized `ParcelVectorContext` before applying Human-in-the-Loop edits.
 */
export function ensureParcelVectorContext(parcel: ParcelRecord): ParcelVectorContext {
  if (parcel.vectorContext) {
    return {
      ...parcel.vectorContext,
      buildings: [...parcel.vectorContext.buildings],
      easements: [...parcel.vectorContext.easements],
      exemptFeatures: [...parcel.vectorContext.exemptFeatures],
    };
  }
  return synthesizeDeterministicCadastreContext({
    parcelVertices: parcel.vertices,
    buildingCenter: parcel.buildingCenter,
    hasEredesLine: parcel.hasEredesLine,
    eredesType: parcel.eredesType,
    hasProtectedOaks: parcel.hasProtectedOaks,
  });
}

/**
 * Counts how many active vector or CV elements have been manually verified or created by the user.
 */
export function countHumanVerifiedEdits(
  ctx?: ParcelVectorContext,
  cv?: ParcelOrthophotoCvAnalysis
): number {
  let total = 0;
  if (ctx) {
    total += ctx.buildings.filter((b) => b.source === 'USER_DEFINED').length;
    total += ctx.easements.filter((e) => e.source === 'USER_DEFINED').length;
    total += ctx.exemptFeatures.filter((ex) => ex.source === 'USER_DEFINED').length;
  }
  if (cv) {
    total += cv.detectedRoofs.filter(
      (r) => r.reviewStatus === 'ACCEPTED' || r.reviewStatus === 'DISMISSED'
    ).length;
    total += cv.crowns.filter((c) => Boolean(c.humanOverride)).length;
  }
  return total;
}

/**
 * Builds an exact metric rectangular building footprint centered at `centerWgs84` in EPSG:3763 meters.
 */
export function buildRectangularFootprintAtWgs84(
  centerWgs84: LatLon,
  widthM = 8.5,
  heightM = 6.5
): LatLon[] {
  const [cx, cy] = projectWgs84ToPtTm06Exact(centerWgs84);
  const hw = Math.max(1.5, widthM / 2);
  const hh = Math.max(1.5, heightM / 2);
  return [
    ptTm06ToWgs84([cx - hw, cy - hh]),
    ptTm06ToWgs84([cx + hw, cy - hh]),
    ptTm06ToWgs84([cx + hw, cy + hh]),
    ptTm06ToWgs84([cx - hw, cy + hh]),
  ];
}

function buildHumanContextSummaryPt(ctx: ParcelVectorContext, cv?: ParcelOrthophotoCvAnalysis): string {
  const userCount = countHumanVerifiedEdits(ctx, cv);
  const basePrefix =
    ctx.sourceMode === 'LIVE_OVERPASS_WFS'
      ? 'OSM Overpass + Edição Assistida'
      : 'Cadastro + Edição Assistida';
  return `${basePrefix} (${ctx.buildings.length} edifícios · ${ctx.easements.length} servidões · ${ctx.exemptFeatures.length} isenções${userCount > 0 ? ` · ${userCount} validado(s) manualmente` : ''})`;
}

/**
 * Recomputes CV compliance summary & counters deterministically after user roof/crown reviews.
 */
export function recomputeCvComplianceSummary(
  cv: ParcelOrthophotoCvAnalysis
): ParcelOrthophotoCvAnalysis {
  const unmappedRoofsCount = cv.detectedRoofs.filter(
    (r) => r.isUnmappedInOsm && r.reviewStatus !== 'DISMISSED' && r.reviewStatus !== 'ACCEPTED'
  ).length;

  const zone2CrownsUnder5mCount = cv.crowns.filter(
    (c) =>
      c.zoneCode !== 'OUTSIDE' &&
      c.distanceToBuildingWallM < 5.0 &&
      c.violationRulePt !== null
  ).length;

  const crownSpacingViolationsCount = cv.crowns.filter(
    (c) =>
      (c.zoneCode === 'ZONE_2' || c.zoneCode === 'ZONE_3') &&
      c.distanceToBuildingWallM >= 5.0 &&
      c.violationRulePt !== null &&
      c.violationRulePt.includes('Afastamento')
  ).length;

  const baseZc = cv.zoneCompliance;
  let overallStatus: ZoneCvComplianceMetrics['overallStatus'] = 'COMPLIANT';
  if (zone2CrownsUnder5mCount > 0 || crownSpacingViolationsCount > 0 || !baseZc.zone1Compliant) {
    overallStatus =
      zone2CrownsUnder5mCount > 0 || baseZc.zone1BareMineralPct < 60
        ? 'NON_COMPLIANT'
        : 'ATTENTION';
  } else if (baseZc.zone3ShrubPct > 25 || baseZc.easementCanopyIntrusionPct > 20) {
    overallStatus = 'ATTENTION';
  }

  const protectedOaksMarked = cv.crowns.filter(
    (c) => c.humanOverride === 'PROTECTED_QUERCUS'
  ).length;
  const prunedMarked = cv.crowns.filter((c) => c.humanOverride === 'PRUNED_COMPLIANT').length;

  const auditParts: string[] = [];
  if (!baseZc.zone1Compliant) {
    auditParts.push(`Zona 1 com ${baseZc.zone1BareMineralPct}% inerte (alvo ≥85%)`);
  } else {
    auditParts.push(`Zona 1 conforme (${baseZc.zone1BareMineralPct}% inerte)`);
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
  if (protectedOaksMarked > 0) {
    auditParts.push(`${protectedOaksMarked} quercínea(s) protegida(s) ICNF`);
  }
  if (prunedMarked > 0) {
    auditParts.push(`${prunedMarked} copa(s) desramada(s)/validada(s)`);
  }

  return {
    ...cv,
    unmappedRoofsCount,
    zoneCompliance: {
      ...baseZc,
      zone2CrownsUnder5mCount,
      crownSpacingViolationsCount,
      overallStatus,
      auditSummaryPt: auditParts.join(' · '),
    },
  };
}

/**
 * Recomputes a parcel's exact EPSG:3763 boolean zones (`computeParcelFgc`) and metadata
 * whenever its `vectorContext` or `cvAnalysis` is modified in Human-in-the-Loop mode.
 */
export function recomputeParcelFromEditedContext(
  parcel: ParcelRecord,
  nextContext: ParcelVectorContext,
  nextCv: ParcelOrthophotoCvAnalysis | undefined = parcel.cvAnalysis
): ParcelRecord {
  const refreshedCv = nextCv ? recomputeCvComplianceSummary(nextCv) : undefined;
  const powerEasements = nextContext.easements.filter(
    (e) => e.category === 'EREDES_MT_AT' || e.category === 'REN_MAT'
  );
  const hasPowerEasement = powerEasements.length > 0;
  const maxPowerHalfWidth = powerEasements.reduce(
    (acc, e) => Math.max(acc, e.bufferHalfWidthM),
    0
  );

  const nextEredesType: ParcelRecord['eredesType'] = hasPowerEasement
    ? maxPowerHalfWidth >= 5.0
      ? 'AT 60kV (Faixa 10m)'
      : 'MT 15kV (Faixa 7m)'
    : 'Sem linha aérea';

  const humanCount = countHumanVerifiedEdits(nextContext, refreshedCv);
  const finalizedContext: ParcelVectorContext = {
    ...nextContext,
    detectedAtIso: new Date().toISOString(),
    humanVerifiedCount: humanCount,
    sourceSummaryPt: buildHumanContextSummaryPt(nextContext, refreshedCv),
  };

  // Update primary buildingCenter if own buildings exist
  const firstOwn = finalizedContext.buildings.find(
    (b) => b.role === 'OWN' && b.footprint.length >= 3
  );
  const nextBuildingCenter = firstOwn
    ? {
        lat: Number(
          (
            firstOwn.footprint.reduce((s, p) => s + p.lat, 0) / firstOwn.footprint.length
          ).toFixed(6)
        ),
        lon: Number(
          (
            firstOwn.footprint.reduce((s, p) => s + p.lon, 0) / firstOwn.footprint.length
          ).toFixed(6)
        ),
      }
    : parcel.buildingCenter;

  const nextSpatial = computeParcelFgc({
    vertices: parcel.vertices,
    buildingCenter: nextBuildingCenter,
    landClass: parcel.landClass,
    hasEredesLine: hasPowerEasement,
    eredesType: nextEredesType,
    vectorContext: finalizedContext,
  });

  const hasProtectedCrownOverride =
    refreshedCv?.crowns.some((c) => c.humanOverride === 'PROTECTED_QUERCUS') ?? false;
  const nextHasProtectedOaks = parcel.hasProtectedOaks || hasProtectedCrownOverride;
  const nextOakNotes =
    hasProtectedCrownOverride && !parcel.hasProtectedOaks
      ? 'Sobreiro/Azinheira validado manualmente em ortofoto — abate interdito sem autorização ICNF (DL 169/2001).'
      : parcel.protectedOakNotes;

  return {
    ...parcel,
    buildingCenter: nextBuildingCenter,
    hasEredesLine: hasPowerEasement,
    eredesType: nextEredesType,
    hasProtectedOaks: nextHasProtectedOaks,
    protectedOakNotes: nextOakNotes,
    vectorContext: finalizedContext,
    cvAnalysis: refreshedCv,
    spatial: nextSpatial,
  };
}

/**
 * Adds a user-drawn or 1-click stamped building footprint (`OWN` or `NEIGHBOR`) and recomputes EPSG:3763 zones.
 */
export function addAssistedBuildingToParcel(
  parcel: ParcelRecord,
  params: {
    footprint: LatLon[];
    role?: 'AUTO' | 'OWN' | 'NEIGHBOR';
    label?: string;
    id?: string;
  }
): ParcelRecord {
  if (!Array.isArray(params.footprint) || params.footprint.length < 3) {
    return parcel;
  }
  const baseCtx = ensureParcelVectorContext(parcel);
  const parcelMp = latLonRingToMultiPolygon3763(parcel.vertices);
  const parcelOpen3763 = cleanOpenRing3763(parcel.vertices.map(projectWgs84ToPtTm06Exact));

  const normFootprint = params.footprint.map((pt) => ({
    lat: Number(pt.lat.toFixed(6)),
    lon: Number(pt.lon.toFixed(6)),
  }));
  const bMp = latLonRingToMultiPolygon3763(normFootprint);
  const areaM2 = Math.max(4, Number(computeMultiPolygonArea3763(bMp).toFixed(1)));
  const bRing3763 = cleanOpenRing3763(normFootprint.map(projectWgs84ToPtTm06Exact));
  const distM = Number(
    computeExternalPolygonDistanceToParcel3763(bRing3763, parcelMp, parcelOpen3763).toFixed(2)
  );

  const resolvedRole: 'OWN' | 'NEIGHBOR' =
    params.role === 'OWN' || params.role === 'NEIGHBOR'
      ? params.role
      : distM <= 0.5
        ? 'OWN'
        : 'NEIGHBOR';

  const newBuilding: DetectedVectorBuilding = {
    id: params.id ?? `user-bldg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    role: resolvedRole,
    label:
      params.label?.trim() ||
      (resolvedRole === 'OWN'
        ? `Edificação / Anexo Marcado (${areaM2.toFixed(0)} m²)`
        : `Edifício Vizinho Marcado (${distM.toFixed(1)} m)`),
    source: 'USER_DEFINED',
    footprint: normFootprint,
    areaM2,
    distanceToParcelEdgeM: resolvedRole === 'OWN' ? 0 : distM,
  };

  return recomputeParcelFromEditedContext(parcel, {
    ...baseCtx,
    buildings: [...baseCtx.buildings, newBuilding],
  });
}

/**
 * Adds a user-traced linear utility or roadway easement (`>= 2` points) and subtracts its legal corridor in EPSG:3763.
 */
export function addAssistedEasementToParcel(
  parcel: ParcelRecord,
  params: {
    centerline: LatLon[];
    preset?: EasementPresetCode;
    category?: EasementCategory;
    bufferHalfWidthM?: number;
    label?: string;
    operatorLabel?: string;
    id?: string;
  }
): ParcelRecord {
  if (!Array.isArray(params.centerline) || params.centerline.length < 2) {
    return parcel;
  }
  const baseCtx = ensureParcelVectorContext(parcel);
  const presetMeta = params.preset ? EASEMENT_PRESETS[params.preset] : EASEMENT_PRESETS.EREDES_MT;
  const category = params.category ?? presetMeta.category;
  const halfWidth = Math.max(
    1.5,
    Math.min(30, Number((params.bufferHalfWidthM ?? presetMeta.defaultHalfWidthM).toFixed(2)))
  );

  const centerline = params.centerline.map((pt) => ({
    lat: Number(pt.lat.toFixed(6)),
    lon: Number(pt.lon.toFixed(6)),
  }));

  const newEasement: DetectedLinearEasement = {
    id: params.id ?? `user-eas-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    category,
    label: params.label?.trim() || `${presetMeta.labelPt} (±${halfWidth} m)`,
    operatorLabel: params.operatorLabel?.trim() || presetMeta.operatorLabel,
    bufferHalfWidthM: halfWidth,
    centerline,
    source: 'USER_DEFINED',
  };

  return recomputeParcelFromEditedContext(parcel, {
    ...baseCtx,
    easements: [...baseCtx.easements, newEasement],
  });
}

/**
 * Adds a user-traced riparian waterway (`>= 2` points) or irrigated orchard/agricultural exemption polygon (`>= 3` points).
 */
export function addAssistedExemptZoneToParcel(
  parcel: ParcelRecord,
  params: {
    points: LatLon[];
    preset?: ExemptPresetCode;
    category?: ExemptFeatureCategory;
    bufferHalfWidthM?: number;
    label?: string;
    id?: string;
  }
): ParcelRecord {
  const presetMeta =
    params.preset ? EXEMPT_PRESETS[params.preset] : EXEMPT_PRESETS.RIPARIAN_WATERWAY;
  const category = params.category ?? presetMeta.category;
  const isLineWaterway = category === 'RIPARIAN_WATERWAY';
  const minPts = isLineWaterway ? 2 : 3;

  if (!Array.isArray(params.points) || params.points.length < minPts) {
    return parcel;
  }

  const baseCtx = ensureParcelVectorContext(parcel);
  const normPts = params.points.map((pt) => ({
    lat: Number(pt.lat.toFixed(6)),
    lon: Number(pt.lon.toFixed(6)),
  }));

  const halfWidth = isLineWaterway
    ? Math.max(2, Math.min(20, Number((params.bufferHalfWidthM ?? 5.0).toFixed(2))))
    : undefined;

  const newExempt: DetectedExemptFeature = {
    id: params.id ?? `user-exempt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    category,
    label:
      params.label?.trim() ||
      (isLineWaterway
        ? `${presetMeta.labelPt} (±${halfWidth} m)`
        : presetMeta.labelPt),
    legalBasis: presetMeta.legalBasis,
    bufferHalfWidthM: halfWidth,
    centerline: isLineWaterway ? normPts : undefined,
    polygon: !isLineWaterway ? normPts : undefined,
    source: 'USER_DEFINED',
  };

  return recomputeParcelFromEditedContext(parcel, {
    ...baseCtx,
    exemptFeatures: [...baseCtx.exemptFeatures, newExempt],
  });
}

/**
 * Toggles an existing vector building between `OWN` (inside/belonging to parcel) and `NEIGHBOR` (external building),
 * marking it as human-verified (`USER_DEFINED`) and recomputing boolean rings.
 */
export function toggleAssistedBuildingRole(
  parcel: ParcelRecord,
  buildingId: string
): ParcelRecord {
  const baseCtx = ensureParcelVectorContext(parcel);
  const parcelMp = latLonRingToMultiPolygon3763(parcel.vertices);
  const parcelOpen3763 = cleanOpenRing3763(parcel.vertices.map(projectWgs84ToPtTm06Exact));

  let changed = false;
  const nextBuildings = baseCtx.buildings.map((b) => {
    if (b.id !== buildingId) return b;
    changed = true;
    const nextRole: 'OWN' | 'NEIGHBOR' = b.role === 'OWN' ? 'NEIGHBOR' : 'OWN';
    const bRing3763 = cleanOpenRing3763(b.footprint.map(projectWgs84ToPtTm06Exact));
    const exactDist = computeExternalPolygonDistanceToParcel3763(
      bRing3763,
      parcelMp,
      parcelOpen3763
    );
    return {
      ...b,
      role: nextRole,
      source: 'USER_DEFINED' as const,
      distanceToParcelEdgeM: nextRole === 'OWN' ? 0 : Number(Math.max(0.5, exactDist).toFixed(1)),
      label:
        nextRole === 'OWN'
          ? `Edificação Própria Validada (${b.areaM2.toFixed(0)} m²)`
          : `Edificação Vizinha Validada (${b.areaM2.toFixed(0)} m²)`,
    };
  });

  if (!changed) return parcel;
  return recomputeParcelFromEditedContext(parcel, {
    ...baseCtx,
    buildings: nextBuildings,
  });
}

/**
 * Updates the legal half-width (`bufferHalfWidthM`) of an easement corridor (e.g., 3.5m -> 5.0m -> 14.0m)
 * and recomputes the exact subtracted third-party area in EPSG:3763.
 */
export function updateAssistedEasementWidth(
  parcel: ParcelRecord,
  easementId: string,
  nextHalfWidthM: number
): ParcelRecord {
  const baseCtx = ensureParcelVectorContext(parcel);
  const clamped = Math.max(1.5, Math.min(30, Number(nextHalfWidthM.toFixed(2))));
  let changed = false;

  const nextEasements = baseCtx.easements.map((e) => {
    if (e.id !== easementId) return e;
    changed = true;
    return {
      ...e,
      bufferHalfWidthM: clamped,
      source: 'USER_DEFINED' as const,
    };
  });

  if (!changed) return parcel;
  return recomputeParcelFromEditedContext(parcel, {
    ...baseCtx,
    easements: nextEasements,
  });
}

/**
 * Removes a specific building, easement, or exempt feature from `vectorContext` and recomputes EPSG:3763 zones.
 */
export function removeAssistedVectorElement(
  parcel: ParcelRecord,
  kind: 'BUILDING' | 'EASEMENT' | 'EXEMPT',
  elementId: string
): ParcelRecord {
  const baseCtx = ensureParcelVectorContext(parcel);
  const nextCtx: ParcelVectorContext = {
    ...baseCtx,
    buildings:
      kind === 'BUILDING'
        ? baseCtx.buildings.filter((b) => b.id !== elementId)
        : baseCtx.buildings,
    easements:
      kind === 'EASEMENT'
        ? baseCtx.easements.filter((e) => e.id !== elementId)
        : baseCtx.easements,
    exemptFeatures:
      kind === 'EXEMPT'
        ? baseCtx.exemptFeatures.filter((ex) => ex.id !== elementId)
        : baseCtx.exemptFeatures,
  };

  return recomputeParcelFromEditedContext(parcel, nextCtx);
}

/**
 * Human-in-the-Loop review of an unmapped roof structure detected by Phase 2 25 cm Orthophoto CV:
 *  - `ACCEPT_OWN` / `ACCEPT_NEIGHBOR`: promotes the roof into `vectorContext.buildings` as `USER_DEFINED`
 *  - `DISMISS_FALSE_POSITIVE`: marks the CV detection as dismissed (e.g., rock outcrop or greenhouse tarp)
 */
export function reviewCvRoofDetection(
  parcel: ParcelRecord,
  roofId: string,
  decision: 'ACCEPT_OWN' | 'ACCEPT_NEIGHBOR' | 'DISMISS_FALSE_POSITIVE'
): ParcelRecord {
  if (!parcel.cvAnalysis) return parcel;
  const targetRoof = parcel.cvAnalysis.detectedRoofs.find((r) => r.id === roofId);
  if (!targetRoof) return parcel;

  const baseCtx = ensureParcelVectorContext(parcel);
  let nextBuildings = [...baseCtx.buildings];

  const nextRoofs: DetectedRoofStructure[] = parcel.cvAnalysis.detectedRoofs.map((r) => {
    if (r.id !== roofId) return r;
    if (decision === 'DISMISS_FALSE_POSITIVE') {
      return {
        ...r,
        isUnmappedInOsm: false,
        reviewStatus: 'DISMISSED',
      };
    }
    const acceptedRole: 'OWN' | 'NEIGHBOR' =
      decision === 'ACCEPT_OWN' ? 'OWN' : 'NEIGHBOR';
    return {
      ...r,
      role: acceptedRole,
      isUnmappedInOsm: false,
      reviewStatus: 'ACCEPTED',
    };
  });

  if (decision === 'ACCEPT_OWN' || decision === 'ACCEPT_NEIGHBOR') {
    const role: 'OWN' | 'NEIGHBOR' = decision === 'ACCEPT_OWN' ? 'OWN' : 'NEIGHBOR';
    const c3763 = projectWgs84ToPtTm06Exact(targetRoof.centerWgs84);
    const alreadyExists = nextBuildings.some((b) => {
      if (b.id === `hitl-${targetRoof.id}` || b.id === `bldg-${targetRoof.id}`) return true;
      if (b.footprint.length < 3) return false;
      const pts = b.footprint.map(projectWgs84ToPtTm06Exact);
      const bx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const by = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      return Math.hypot(bx - c3763[0], by - c3763[1]) <= 3.5;
    });

    if (!alreadyExists && targetRoof.footprintWgs84.length >= 3) {
      nextBuildings = [
        ...nextBuildings,
        {
          id: `hitl-${targetRoof.id}`,
          role,
          label:
            role === 'OWN'
              ? `Anexo Validado em Ortofoto (${targetRoof.areaM2.toFixed(0)} m²)`
              : `Construção Vizinha Validada (${targetRoof.areaM2.toFixed(0)} m²)`,
          source: 'USER_DEFINED',
          footprint: targetRoof.footprintWgs84,
          areaM2: targetRoof.areaM2,
          distanceToParcelEdgeM: role === 'OWN' ? 0 : targetRoof.distanceToParcelEdgeM,
        },
      ];
    }
  } else {
    // If previously promoted, remove it when dismissed
    nextBuildings = nextBuildings.filter(
      (b) => b.id !== `hitl-${targetRoof.id}` && b.id !== `bldg-${targetRoof.id}`
    );
  }

  const nextCv: ParcelOrthophotoCvAnalysis = {
    ...parcel.cvAnalysis,
    detectedRoofs: nextRoofs,
  };

  return recomputeParcelFromEditedContext(
    parcel,
    {
      ...baseCtx,
      buildings: nextBuildings,
    },
    nextCv
  );
}

/**
 * Human-in-the-Loop override of an individual tree crown detected by Phase 2 CV:
 *  - `PROTECTED_QUERCUS`: classifies tree as protected Cork/Holm Oak (`Sobreiro/Azinheira` — DL 169/2001),
 *    clearing felling spacing violations (except <2m direct wall contact) and enabling `hasProtectedOaks`.
 *  - `PRUNED_COMPLIANT`: records that field pruning/thinning was already performed on this tree.
 *  - `CLEAR`: restores automatic CV rule audit.
 */
export function overrideCvCrownStatus(
  parcel: ParcelRecord,
  crownId: string,
  override: 'PROTECTED_QUERCUS' | 'PRUNED_COMPLIANT' | 'CLEAR'
): ParcelRecord {
  if (!parcel.cvAnalysis) return parcel;
  let changed = false;

  const nextCrowns: DetectedTreeCrown[] = parcel.cvAnalysis.crowns.map((crown) => {
    if (crown.id !== crownId) return crown;
    changed = true;
    const baselineRule =
      crown.originalViolationRulePt !== undefined
        ? crown.originalViolationRulePt
        : crown.violationRulePt;

    if (override === 'CLEAR') {
      const restored: DetectedTreeCrown = {
        ...crown,
        violationRulePt: baselineRule,
        originalViolationRulePt: baselineRule,
      };
      delete restored.humanOverride;
      return restored;
    }

    if (override === 'PROTECTED_QUERCUS') {
      return {
        ...crown,
        speciesGroup: 'BROADLEAF_QUERCUS',
        originalViolationRulePt: baselineRule,
        humanOverride: 'PROTECTED_QUERCUS',
        violationRulePt: null,
      };
    }

    return {
      ...crown,
      originalViolationRulePt: baselineRule,
      humanOverride: 'PRUNED_COMPLIANT',
      violationRulePt: null,
    };
  });

  if (!changed) return parcel;

  const baseCtx = ensureParcelVectorContext(parcel);
  const nextCv: ParcelOrthophotoCvAnalysis = {
    ...parcel.cvAnalysis,
    crowns: nextCrowns,
  };

  return recomputeParcelFromEditedContext(parcel, baseCtx, nextCv);
}

function centerOfRing3763(pts: LatLon[]): Pair {
  const projected = pts.map(projectWgs84ToPtTm06Exact);
  if (projected.length === 0) return [0, 0];
  const sx = projected.reduce((s, p) => s + p[0], 0) / projected.length;
  const sy = projected.reduce((s, p) => s + p[1], 0) / projected.length;
  return [sx, sy];
}

/**
 * Preserves all `source === 'USER_DEFINED'` buildings, easements, and exempt features from a previous
 * parcel context when refreshing automatic OSM Overpass / cadastral detections, preventing data loss!
 */
export function mergePreservingUserDefinedContext(
  autoContext: ParcelVectorContext,
  previousContext?: ParcelVectorContext
): ParcelVectorContext {
  if (!previousContext) return autoContext;

  const userBuildings = previousContext.buildings.filter((b) => b.source === 'USER_DEFINED');
  const userEasements = previousContext.easements.filter((e) => e.source === 'USER_DEFINED');
  const userExempts = previousContext.exemptFeatures.filter((ex) => ex.source === 'USER_DEFINED');

  if (userBuildings.length === 0 && userEasements.length === 0 && userExempts.length === 0) {
    return autoContext;
  }

  // Deduplicate auto buildings that sit right underneath a user-verified footprint (< 3.5 m center distance)
  const userBldgCenters = userBuildings.map((ub) => centerOfRing3763(ub.footprint));
  const keptAutoBuildings = autoContext.buildings.filter((ab) => {
    if (ab.source === 'USER_DEFINED') return false;
    const ac = centerOfRing3763(ab.footprint);
    return !userBldgCenters.some((uc) => Math.hypot(ac[0] - uc[0], ac[1] - uc[1]) <= 3.5);
  });

  const mergedBuildings = [...keptAutoBuildings, ...userBuildings];
  const mergedEasements = [
    ...autoContext.easements.filter((e) => e.source !== 'USER_DEFINED'),
    ...userEasements,
  ];
  const mergedExempts = [
    ...autoContext.exemptFeatures.filter((ex) => ex.source !== 'USER_DEFINED'),
    ...userExempts,
  ];

  const userTotal = userBuildings.length + userEasements.length + userExempts.length;

  return {
    ...autoContext,
    humanVerifiedCount: userTotal,
    buildings: mergedBuildings,
    easements: mergedEasements,
    exemptFeatures: mergedExempts,
    sourceSummaryPt: `${autoContext.sourceSummaryPt} · +${userTotal} elemento(s) validado(s) pelo utilizador`,
  };
}

/**
 * Resets all manual `USER_DEFINED` additions/overrides back to the deterministic baseline cadastre context.
 */
export function resetParcelToAutomaticContext(parcel: ParcelRecord): ParcelRecord {
  const synth = synthesizeDeterministicCadastreContext({
    parcelVertices: parcel.vertices,
    buildingCenter: parcel.buildingCenter,
    hasEredesLine: parcel.hasEredesLine,
    eredesType: parcel.eredesType,
    hasProtectedOaks: parcel.hasProtectedOaks,
  });

  const resetCv: ParcelOrthophotoCvAnalysis | undefined = parcel.cvAnalysis
    ? recomputeCvComplianceSummary({
        ...parcel.cvAnalysis,
        fusedIntoVectorContext: false,
        detectedRoofs: parcel.cvAnalysis.detectedRoofs.map((r) => {
          const copy: DetectedRoofStructure = {
            ...r,
            isUnmappedInOsm: r.reviewStatus === 'ACCEPTED' || r.reviewStatus === 'DISMISSED' ? true : r.isUnmappedInOsm,
          };
          delete copy.reviewStatus;
          return copy;
        }),
        crowns: parcel.cvAnalysis.crowns.map((c) => {
          const copy: DetectedTreeCrown = {
            ...c,
            violationRulePt:
              c.originalViolationRulePt !== undefined
                ? c.originalViolationRulePt
                : c.violationRulePt,
          };
          delete copy.humanOverride;
          return copy;
        }),
      })
    : undefined;

  const nextSpatial = computeParcelFgc({
    vertices: parcel.vertices,
    buildingCenter: parcel.buildingCenter,
    landClass: parcel.landClass,
    hasEredesLine: parcel.hasEredesLine,
    eredesType: parcel.eredesType,
    vectorContext: synth,
  });

  return {
    ...parcel,
    vectorContext: synth,
    cvAnalysis: resetCv,
    spatial: nextSpatial,
  };
}
