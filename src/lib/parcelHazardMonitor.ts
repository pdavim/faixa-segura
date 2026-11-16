import type {
  ActiveFireIncident,
  LandClass,
  LatLon,
  ParcelRecord,
  ProximityRadiusKm,
  StormAlertIncident,
  StormHazardKind,
  UserAppSettings,
} from '../types/domain.ts';
import { haversineDistanceKm } from './spatialEngine.ts';
import { doesIpmaWarningMatchParcelDistrict } from './officialAlertsIngestor.ts';
import type { KeyValueStorageLike } from './userWorkspaceStore.ts';

export type CardinalPt = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SO' | 'O' | 'NO';

export type ParcelHazardCategory = 'FIRE' | 'STORM';

export type ParcelAlertUrgency = 'CRITICAL' | 'WARNING';

export type ParcelSafetyStatus = 'CRITICAL' | 'WARNING' | 'SAFE';

export interface ParcelProximityAlert {
  alertId: string;
  category: ParcelHazardCategory;
  urgency: ParcelAlertUrgency;
  parcelId: string;
  parcelLabel: string;
  parcelMunicipality: string;
  parcelParish: string;
  landClass: LandClass;
  isForestScrub: boolean;
  hazardId: string;
  hazardTitle: string;
  hazardLocation: string;
  hazardSource: string;
  isSimulatedTest: boolean;
  inSameWarnedDistrict?: boolean;
  centerDistanceKm: number;
  effectiveEdgeDistanceKm: number;
  bearingDegrees: number;
  cardinalPt: CardinalPt;
  detailLine: string;
  protectiveActionPt: string;
  acknowledged: boolean;
}

export interface ParcelHazardSummary {
  parcelId: string;
  parcelLabel: string;
  municipality: string;
  parish: string;
  landClass: LandClass;
  isForestScrub: boolean;
  status: ParcelSafetyStatus;
  effectiveWatchRadiusKm: number;
  activeAlertsCount: number;
  criticalAlertsCount: number;
  nearestFire: {
    distanceKm: number;
    cardinalPt: CardinalPt;
    municipality: string;
    status: string;
    nature: string;
  } | null;
  nearestStorm: {
    centerDistanceKm: number;
    edgeDistanceKm: number;
    cardinalPt: CardinalPt;
    title: string;
    maxWindKmh: number;
    severity: StormAlertIncident['severity'];
    inSameWarnedDistrict?: boolean;
  } | null;
}

export interface MultiParcelHazardEvaluation {
  alerts: ParcelProximityAlert[];
  unacknowledgedAlerts: ParcelProximityAlert[];
  parcelSummaries: Record<string, ParcelHazardSummary>;
  orderedParcelSummaries: ParcelHazardSummary[];
  counts: {
    totalAlerts: number;
    unacknowledgedCount: number;
    criticalCount: number;
    fireAlertsCount: number;
    stormAlertsCount: number;
    affectedParcelsCount: number;
    forestScrubAlertsCount: number;
  };
}

export interface SimulatedFieldHazardsState {
  fires: Omit<ActiveFireIncident, 'distanceKm'>[];
  storms: StormAlertIncident[];
}

export const LS_KEY_ACKNOWLEDGED_HAZARD_ALERTS = 'fs_acknowledged_hazard_alerts_v1';
export const LS_KEY_SIMULATED_FIELD_HAZARDS = 'fs_simulated_field_hazards_v1';

const CARDINAL_LABELS_PT: CardinalPt[] = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

export function formatLandClassPt(landClass: LandClass): string {
  switch (landClass) {
    case 'FOREST_SCRUB':
      return 'Mato / Floresta';
    case 'AGRICULTURE':
      return 'Agrícola';
    case 'URBAN_BUILT':
      return 'Urbano / Interface';
  }
}

export function formatStormKindPt(kind: StormHazardKind): string {
  switch (kind) {
    case 'DRY_THUNDERSTORM':
      return 'Trovoada Seca e Raios';
    case 'WINDSTORM':
      return 'Tempestade de Vento';
    case 'HEAVY_RAIN_FLOOD':
      return 'Chuva Intensa / Escorrência';
    case 'EXTREME_GUSTS':
      return 'Rajadas Severas';
  }
}

/**
 * Computes initial geographic bearing (0..359°) from `from` (parcel centroid)
 * towards `to` (hazard location) and maps it to Portuguese 8-wind rose labels.
 */
export function computeCardinalBearingPt(
  from: LatLon,
  to: LatLon
): { degrees: number; cardinalPt: CardinalPt } {
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const dLon = ((to.lon - from.lon) * Math.PI) / 180;

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  if (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12) {
    return { degrees: 0, cardinalPt: 'N' };
  }

  const rawDeg = (Math.atan2(y, x) * 180) / Math.PI;
  const degrees = Math.round((rawDeg + 360) % 360) % 360;
  const bucket = Math.round(degrees / 45) % 8;
  return {
    degrees,
    cardinalPt: CARDINAL_LABELS_PT[bucket],
  };
}

/**
 * Computes destination point given origin, distance in km, and bearing in degrees.
 * Used for placing realistic field-test proximity simulations near a user's forest parcel.
 */
export function offsetLatLonByKmAndBearing(
  origin: LatLon,
  distanceKm: number,
  bearingDegrees: number
): LatLon {
  const R = 6371.0088;
  const angDist = distanceKm / R;
  const brng = (bearingDegrees * Math.PI) / 180;
  const lat1 = (origin.lat * Math.PI) / 180;
  const lon1 = (origin.lon * Math.PI) / 180;

  const sinLat2 =
    Math.sin(lat1) * Math.cos(angDist) +
    Math.cos(lat1) * Math.sin(angDist) * Math.cos(brng);
  const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
  const y = Math.sin(brng) * Math.sin(angDist) * Math.cos(lat1);
  const x = Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2);
  const lon2 = lon1 + Math.atan2(y, x);

  return {
    lat: Number(((lat2 * 180) / Math.PI).toFixed(6)),
    lon: Number(((lon2 * 180) / Math.PI).toFixed(6)),
  };
}

export function buildSimulatedFireNearParcel(parcel: ParcelRecord): Omit<ActiveFireIncident, 'distanceKm'> {
  const center = parcel.spatial.centroidWgs84;
  const targetPoint = offsetLatLonByKmAndBearing(center, 2.3, 45); // 2.3 km NE
  return {
    id: `sim_fire_${parcel.id}`,
    municipality: parcel.municipality,
    parish: parcel.parish,
    nature: parcel.landClass === 'FOREST_SCRUB' ? 'Povoamento Florestal' : 'Mato',
    status: 'Em Curso',
    lat: targetPoint.lat,
    lon: targetPoint.lon,
    operatives: 64,
    vehicles: 19,
    aerialMeans: 3,
    startedAt: 'Alerta de Teste (Há 6 min)',
    source: 'Simulação Preventiva Regional',
  };
}

export function buildSimulatedStormNearParcel(parcel: ParcelRecord): StormAlertIncident {
  const center = parcel.spatial.centroidWgs84;
  const targetPoint = offsetLatLonByKmAndBearing(center, 3.1, 315); // 3.1 km NO
  return {
    id: `sim_storm_${parcel.id}`,
    title: `Célula Severa de Trovoada Seca e Vento Forte (${parcel.municipality})`,
    kind: 'DRY_THUNDERSTORM',
    severity: 'RED',
    municipality: parcel.municipality,
    district: parcel.district,
    lat: targetPoint.lat,
    lon: targetPoint.lon,
    radiusKm: 6,
    maxWindKmh: 105,
    precipitationMmH: 18,
    lightningRisk: true,
    validUntil: 'Próximas 3 horas (Simulação)',
    source: 'Teste de Proximidade no Mato',
  };
}

/**
 * Evaluates EVERY parcel registered by the user against active rural fires and severe storms,
 * applying extra protective sensitivity for `FOREST_SCRUB` ("terreno no meio do mato") parcels.
 */
export function evaluateMultiParcelHazards(params: {
  parcels: ParcelRecord[];
  fires: Array<Omit<ActiveFireIncident, 'distanceKm'> | ActiveFireIncident>;
  storms: StormAlertIncident[];
  settings?: Partial<
    Pick<
      UserAppSettings,
      | 'proximityAlertRadiusKm'
      | 'enableFireProximityAlerts'
      | 'enableStormProximityAlerts'
      | 'prioritizeForestScrubAlerts'
    >
  >;
  acknowledgedAlertIds?: readonly string[];
}): MultiParcelHazardEvaluation {
  const baseRadiusKm: ProximityRadiusKm =
    params.settings?.proximityAlertRadiusKm === 5 ||
    params.settings?.proximityAlertRadiusKm === 10 ||
    params.settings?.proximityAlertRadiusKm === 25
      ? params.settings.proximityAlertRadiusKm
      : 15;

  const fireEnabled = params.settings?.enableFireProximityAlerts !== false;
  const stormEnabled = params.settings?.enableStormProximityAlerts !== false;
  const prioritizeForestScrub = params.settings?.prioritizeForestScrubAlerts !== false;
  const ackSet = new Set(params.acknowledgedAlertIds ?? []);

  const alerts: ParcelProximityAlert[] = [];
  const parcelSummaries: Record<string, ParcelHazardSummary> = {};
  const orderedParcelSummaries: ParcelHazardSummary[] = [];

  for (const parcel of params.parcels) {
    const centroid = parcel.spatial.centroidWgs84;
    const isForestScrub = parcel.landClass === 'FOREST_SCRUB';
    // Forest/scrub parcels get a 20% early-warning buffer when forest priority is enabled
    const effectiveWatchRadiusKm = Number(
      (isForestScrub && prioritizeForestScrub ? baseRadiusKm * 1.2 : baseRadiusKm).toFixed(1)
    );

    let nearestFire: ParcelHazardSummary['nearestFire'] = null;
    let nearestStorm: ParcelHazardSummary['nearestStorm'] = null;
    let parcelActiveAlerts = 0;
    let parcelCriticalAlerts = 0;

    for (const fire of params.fires) {
      const distKm = haversineDistanceKm(centroid, { lat: fire.lat, lon: fire.lon });
      const bearing = computeCardinalBearingPt(centroid, { lat: fire.lat, lon: fire.lon });

      if (!nearestFire || distKm < nearestFire.distanceKm) {
        nearestFire = {
          distanceKm: distKm,
          cardinalPt: bearing.cardinalPt,
          municipality: fire.municipality,
          status: fire.status,
          nature: fire.nature,
        };
      }

      if (fireEnabled && distKm <= effectiveWatchRadiusKm) {
        const isSimulatedTest = fire.id.startsWith('sim_fire_');
        const criticalDistanceLimit = isForestScrub && prioritizeForestScrub
          ? Math.max(8, baseRadiusKm * 0.65)
          : Math.max(5, baseRadiusKm * 0.5);

        const isCritical =
          distKm <= criticalDistanceLimit ||
          (fire.status === 'Em Curso' && distKm <= baseRadiusKm && isForestScrub);

        const urgency: ParcelAlertUrgency = isCritical ? 'CRITICAL' : 'WARNING';
        const alertId = `alert:fire:${parcel.id}:${fire.id}`;
        const acknowledged = ackSet.has(alertId);

        parcelActiveAlerts += 1;
        if (urgency === 'CRITICAL') {
          parcelCriticalAlerts += 1;
        }

        const aerialNote =
          fire.aerialMeans > 0 ? ` · ${fire.aerialMeans} meio(s) aéreo(s)` : '';
        const fireTitle =
          fire.nature === 'Situação Crítica'
            ? `Ocorrência ANEPC: Situação Crítica (${fire.status})`
            : `Incêndio em ${fire.nature} (${fire.status})`;

        alerts.push({
          alertId,
          category: 'FIRE',
          urgency,
          parcelId: parcel.id,
          parcelLabel: parcel.label,
          parcelMunicipality: parcel.municipality,
          parcelParish: parcel.parish,
          landClass: parcel.landClass,
          isForestScrub,
          hazardId: fire.id,
          hazardTitle: fireTitle,
          hazardLocation: `${fire.municipality} · ${fire.parish}`,
          hazardSource: fire.source,
          isSimulatedTest,
          centerDistanceKm: distKm,
          effectiveEdgeDistanceKm: distKm,
          bearingDegrees: bearing.degrees,
          cardinalPt: bearing.cardinalPt,
          detailLine: `${fire.operatives} operacionais · ${fire.vehicles} viaturas${aerialNote} · ${fire.startedAt}`,
          protectiveActionPt: isForestScrub
            ? 'Terreno em zona de mato/floresta: suspenda deslocações ou máquinas no lote, desimpeça portões de acesso para bombeiros e acompanhe avisos ANEPC / 112.'
            : 'Mantenha acessos desimpedidos, feche gás/rega exterior se aplicável e acompanhe a evolução do vento junto à estrema.',
          acknowledged,
        });
      }
    }

    for (const storm of params.storms) {
      const centerDistKm = haversineDistanceKm(centroid, { lat: storm.lat, lon: storm.lon });
      const inSameWarnedDistrict = doesIpmaWarningMatchParcelDistrict(storm, parcel);
      const edgeDistKm = inSameWarnedDistrict
        ? 0
        : Number(Math.max(0, centerDistKm - storm.radiusKm).toFixed(2));
      const bearing = computeCardinalBearingPt(centroid, { lat: storm.lat, lon: storm.lon });

      if (!nearestStorm || edgeDistKm < nearestStorm.edgeDistanceKm) {
        nearestStorm = {
          centerDistanceKm: centerDistKm,
          edgeDistanceKm: edgeDistKm,
          cardinalPt: bearing.cardinalPt,
          title: storm.title,
          maxWindKmh: storm.maxWindKmh,
          severity: storm.severity,
          inSameWarnedDistrict,
        };
      }

      if (
        stormEnabled &&
        (inSameWarnedDistrict ||
          edgeDistKm <= baseRadiusKm ||
          centerDistKm <= effectiveWatchRadiusKm)
      ) {
        const isSimulatedTest = storm.id.startsWith('sim_storm_');
        const insidePointCell = !storm.isDistrictWideWarning && centerDistKm <= storm.radiusKm;
        const isCritical =
          storm.severity === 'RED' ||
          (insidePointCell && storm.severity !== 'YELLOW') ||
          (storm.severity === 'ORANGE' && (inSameWarnedDistrict || edgeDistKm <= baseRadiusKm * 0.5)) ||
          (storm.lightningRisk && isForestScrub && (inSameWarnedDistrict || edgeDistKm <= baseRadiusKm * 0.75));

        const urgency: ParcelAlertUrgency = isCritical ? 'CRITICAL' : 'WARNING';
        const alertId = `alert:storm:${parcel.id}:${storm.id}`;
        const acknowledged = ackSet.has(alertId);

        parcelActiveAlerts += 1;
        if (urgency === 'CRITICAL') {
          parcelCriticalAlerts += 1;
        }

        const lightningLabel = storm.lightningRisk ? ' · Risco de descargas elétricas (ignição)' : '';
        const isAnepcWeatherDispatch = storm.source === 'ANEPC Proteção Civil (Tempo Real)';
        const detailLine = isAnepcWeatherDispatch
          ? `Meios Proteção Civil: ${storm.operatives ?? 0} operacionais · ${storm.vehicles ?? 0} viaturas · ${storm.validUntil}`
          : `${formatStormKindPt(storm.kind)} · Rajadas até ${storm.maxWindKmh} km/h · Precipitação ${storm.precipitationMmH} mm/h${lightningLabel} · ${storm.validUntil}`;

        alerts.push({
          alertId,
          category: 'STORM',
          urgency,
          parcelId: parcel.id,
          parcelLabel: parcel.label,
          parcelMunicipality: parcel.municipality,
          parcelParish: parcel.parish,
          landClass: parcel.landClass,
          isForestScrub,
          hazardId: storm.id,
          hazardTitle: storm.title,
          hazardLocation: inSameWarnedDistrict
            ? `Distrito de ${storm.district} (${storm.ipmaAreaCode || storm.municipality})`
            : `${storm.municipality} (${storm.district})`,
          hazardSource: storm.source,
          isSimulatedTest,
          inSameWarnedDistrict,
          centerDistanceKm: centerDistKm,
          effectiveEdgeDistanceKm: edgeDistKm,
          bearingDegrees: bearing.degrees,
          cardinalPt: bearing.cardinalPt,
          detailLine,
          protectiveActionPt:
            storm.lightningRisk && isForestScrub
              ? 'Trovoada próxima de terreno florestal/mato: risco elevado de ignição por raio e queda de ramos secos. Evite permanecer sob copas ou linhas aéreas.'
              : isAnepcWeatherDispatch
                ? 'Ocorrência ativa da Proteção Civil próxima da propriedade: verifique se existem árvores caídas, cabos ou vias condicionadas nos acessos ao terreno.'
                : 'Vento/precipitação severa no perímetro ou distrito do terreno: evite trabalhos com motosserra, verifique queda de árvores nos acessos e linhas aéreas confinantes.',
          acknowledged,
        });
      }
    }

    const status: ParcelSafetyStatus =
      parcelCriticalAlerts > 0
        ? 'CRITICAL'
        : parcelActiveAlerts > 0
          ? 'WARNING'
          : 'SAFE';

    const summary: ParcelHazardSummary = {
      parcelId: parcel.id,
      parcelLabel: parcel.label,
      municipality: parcel.municipality,
      parish: parcel.parish,
      landClass: parcel.landClass,
      isForestScrub,
      status,
      effectiveWatchRadiusKm,
      activeAlertsCount: parcelActiveAlerts,
      criticalAlertsCount: parcelCriticalAlerts,
      nearestFire,
      nearestStorm,
    };

    parcelSummaries[parcel.id] = summary;
    orderedParcelSummaries.push(summary);
  }

  // Sort alerts: unacknowledged first -> CRITICAL before WARNING -> forest scrub first -> closest effective distance
  alerts.sort((a, b) => {
    if (a.acknowledged !== b.acknowledged) {
      return a.acknowledged ? 1 : -1;
    }
    if (a.urgency !== b.urgency) {
      return a.urgency === 'CRITICAL' ? -1 : 1;
    }
    if (a.isForestScrub !== b.isForestScrub) {
      return a.isForestScrub ? -1 : 1;
    }
    return a.effectiveEdgeDistanceKm - b.effectiveEdgeDistanceKm;
  });

  // Sort parcel summaries: CRITICAL -> WARNING -> SAFE, then closest hazard
  orderedParcelSummaries.sort((a, b) => {
    const rank = (s: ParcelSafetyStatus) => (s === 'CRITICAL' ? 0 : s === 'WARNING' ? 1 : 2);
    if (rank(a.status) !== rank(b.status)) {
      return rank(a.status) - rank(b.status);
    }
    const minDistA = Math.min(
      a.nearestFire?.distanceKm ?? Number.POSITIVE_INFINITY,
      a.nearestStorm?.edgeDistanceKm ?? Number.POSITIVE_INFINITY
    );
    const minDistB = Math.min(
      b.nearestFire?.distanceKm ?? Number.POSITIVE_INFINITY,
      b.nearestStorm?.edgeDistanceKm ?? Number.POSITIVE_INFINITY
    );
    return minDistA - minDistB;
  });

  const unacknowledgedAlerts = alerts.filter((a) => !a.acknowledged);
  const affectedParcelSet = new Set(alerts.map((a) => a.parcelId));

  return {
    alerts,
    unacknowledgedAlerts,
    parcelSummaries,
    orderedParcelSummaries,
    counts: {
      totalAlerts: alerts.length,
      unacknowledgedCount: unacknowledgedAlerts.length,
      criticalCount: alerts.filter((a) => a.urgency === 'CRITICAL').length,
      fireAlertsCount: alerts.filter((a) => a.category === 'FIRE').length,
      stormAlertsCount: alerts.filter((a) => a.category === 'STORM').length,
      affectedParcelsCount: affectedParcelSet.size,
      forestScrubAlertsCount: alerts.filter((a) => a.isForestScrub).length,
    },
  };
}

function resolveStorage(explicitStorage?: KeyValueStorageLike | null): KeyValueStorageLike | null {
  if (explicitStorage !== undefined) return explicitStorage;
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

export function loadAcknowledgedHazardAlertIds(
  explicitStorage?: KeyValueStorageLike | null
): string[] {
  const store = resolveStorage(explicitStorage);
  if (!store) return [];
  try {
    const raw = store.getItem(LS_KEY_ACKNOWLEDGED_HAZARD_ALERTS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return Array.from(
      new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0))
    ).slice(0, 120);
  } catch {
    return [];
  }
}

export function saveAcknowledgedHazardAlertIds(
  ids: readonly string[],
  explicitStorage?: KeyValueStorageLike | null
): string[] {
  const clean = Array.from(
    new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))
  ).slice(0, 120);
  const store = resolveStorage(explicitStorage);
  if (store) {
    try {
      store.setItem(LS_KEY_ACKNOWLEDGED_HAZARD_ALERTS, JSON.stringify(clean));
    } catch {
      // Ignore quota errors
    }
  }
  return clean;
}

export function toggleAcknowledgeHazardAlertId(
  currentIds: readonly string[],
  alertId: string,
  explicitStorage?: KeyValueStorageLike | null
): string[] {
  const exists = currentIds.includes(alertId);
  const next = exists ? currentIds.filter((id) => id !== alertId) : [...currentIds, alertId];
  return saveAcknowledgedHazardAlertIds(next, explicitStorage);
}

export function loadSimulatedFieldHazards(
  explicitStorage?: KeyValueStorageLike | null
): SimulatedFieldHazardsState {
  const store = resolveStorage(explicitStorage);
  if (!store) return { fires: [], storms: [] };
  try {
    const raw = store.getItem(LS_KEY_SIMULATED_FIELD_HAZARDS);
    if (!raw) return { fires: [], storms: [] };
    const parsed = JSON.parse(raw) as Partial<SimulatedFieldHazardsState>;
    return {
      fires: Array.isArray(parsed.fires) ? parsed.fires : [],
      storms: Array.isArray(parsed.storms) ? parsed.storms : [],
    };
  } catch {
    return { fires: [], storms: [] };
  }
}

export function saveSimulatedFieldHazards(
  state: SimulatedFieldHazardsState,
  explicitStorage?: KeyValueStorageLike | null
): SimulatedFieldHazardsState {
  const clean: SimulatedFieldHazardsState = {
    fires: Array.isArray(state.fires) ? state.fires.slice(0, 10) : [],
    storms: Array.isArray(state.storms) ? state.storms.slice(0, 10) : [],
  };
  const store = resolveStorage(explicitStorage);
  if (store) {
    try {
      if (clean.fires.length === 0 && clean.storms.length === 0) {
        store.removeItem(LS_KEY_SIMULATED_FIELD_HAZARDS);
      } else {
        store.setItem(LS_KEY_SIMULATED_FIELD_HAZARDS, JSON.stringify(clean));
      }
    } catch {
      // Ignore quota errors
    }
  }
  return clean;
}
