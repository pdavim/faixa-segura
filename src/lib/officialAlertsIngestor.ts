import type {
  ActiveFireIncident,
  AnepcNationalSummary,
  ParcelRecord,
  StormAlertIncident,
  StormHazardKind,
  StormSeverityLevel,
} from '../types/domain.ts';
import { haversineDistanceKm } from './spatialEngine.ts';

export interface IpmaAreaLocation {
  idAreaAviso: string;
  district: string;
  municipality: string;
  lat: number;
  lon: number;
}

/**
 * Complete official IPMA `idAreaAviso` catalog for Mainland Portugal + Autonomous Regions.
 * Note: IPMA uses `PTO` for Porto and `STB` for Setúbal in `warnings_www.json` & `distrits-islands.json`.
 */
export const DEFAULT_IPMA_AREA_LOCATIONS: Record<string, IpmaAreaLocation> = {
  AVR: { idAreaAviso: 'AVR', district: 'Aveiro', municipality: 'Aveiro', lat: 40.6413, lon: -8.6535 },
  BJA: { idAreaAviso: 'BJA', district: 'Beja', municipality: 'Beja', lat: 38.0151, lon: -7.8632 },
  BRG: { idAreaAviso: 'BRG', district: 'Braga', municipality: 'Braga', lat: 41.5454, lon: -8.4265 },
  BGC: { idAreaAviso: 'BGC', district: 'Bragança', municipality: 'Bragança', lat: 41.8061, lon: -6.7567 },
  CBR: { idAreaAviso: 'CBR', district: 'Castelo Branco', municipality: 'Castelo Branco', lat: 39.8222, lon: -7.4909 },
  COI: { idAreaAviso: 'COI', district: 'Coimbra', municipality: 'Coimbra', lat: 40.2033, lon: -8.4103 },
  EVO: { idAreaAviso: 'EVO', district: 'Évora', municipality: 'Évora', lat: 38.5714, lon: -7.9135 },
  FAR: { idAreaAviso: 'FAR', district: 'Faro', municipality: 'Faro', lat: 37.0194, lon: -7.9304 },
  GUA: { idAreaAviso: 'GUA', district: 'Guarda', municipality: 'Guarda', lat: 40.5373, lon: -7.2658 },
  LRA: { idAreaAviso: 'LRA', district: 'Leiria', municipality: 'Leiria', lat: 39.7436, lon: -8.8071 },
  LSB: { idAreaAviso: 'LSB', district: 'Lisboa', municipality: 'Lisboa', lat: 38.7223, lon: -9.1393 },
  PTG: { idAreaAviso: 'PTG', district: 'Portalegre', municipality: 'Portalegre', lat: 39.2967, lon: -7.4285 },
  PTO: { idAreaAviso: 'PTO', district: 'Porto', municipality: 'Porto', lat: 41.1579, lon: -8.6291 },
  SAN: { idAreaAviso: 'SAN', district: 'Santarém', municipality: 'Santarém', lat: 39.2362, lon: -8.6871 },
  STB: { idAreaAviso: 'STB', district: 'Setúbal', municipality: 'Setúbal', lat: 38.5244, lon: -8.8882 },
  VCT: { idAreaAviso: 'VCT', district: 'Viana do Castelo', municipality: 'Viana do Castelo', lat: 41.6918, lon: -8.8344 },
  VRL: { idAreaAviso: 'VRL', district: 'Vila Real', municipality: 'Vila Real', lat: 41.3006, lon: -7.7441 },
  VIS: { idAreaAviso: 'VIS', district: 'Viseu', municipality: 'Viseu', lat: 40.6566, lon: -7.9125 },
  MCN: { idAreaAviso: 'MCN', district: 'Ilha da Madeira', municipality: 'Costa Norte (Madeira)', lat: 32.815, lon: -17.046 },
  MCS: { idAreaAviso: 'MCS', district: 'Ilha da Madeira', municipality: 'Costa Sul / Funchal', lat: 32.65, lon: -16.908 },
  MRM: { idAreaAviso: 'MRM', district: 'Ilha da Madeira', municipality: 'Regiões Montanhosas (Madeira)', lat: 32.735, lon: -16.948 },
  MPS: { idAreaAviso: 'MPS', district: 'Ilha de Porto Santo', municipality: 'Porto Santo', lat: 33.06, lon: -16.34 },
  AOR: { idAreaAviso: 'AOR', district: 'Açores (Grupo Oriental)', municipality: 'Ponta Delgada', lat: 37.7412, lon: -25.6756 },
  ACE: { idAreaAviso: 'ACE', district: 'Açores (Grupo Central)', municipality: 'Angra do Heroísmo', lat: 38.655, lon: -27.218 },
  AOC: { idAreaAviso: 'AOC', district: 'Açores (Grupo Ocidental)', municipality: 'Santa Cruz das Flores', lat: 39.456, lon: -31.127 },
};

const DISTRICT_NORMALIZED_TO_IPMA_CODE: Record<string, string> = {};
for (const area of Object.values(DEFAULT_IPMA_AREA_LOCATIONS)) {
  DISTRICT_NORMALIZED_TO_IPMA_CODE[normalizePortugueseLookupKey(area.district)] = area.idAreaAviso;
}

export function normalizePortugueseLookupKey(value: string | undefined | null): string {
  if (!value) return '';
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function resolveIpmaAreaCodeForDistrict(district: string | undefined | null): string | null {
  const key = normalizePortugueseLookupKey(district);
  return DISTRICT_NORMALIZED_TO_IPMA_CODE[key] ?? null;
}

/**
 * Checks if an official IPMA district-wide meteorological warning applies directly
 * to the administrative district where the user's parcel is located.
 */
export function doesIpmaWarningMatchParcelDistrict(
  storm: Pick<StormAlertIncident, 'district' | 'ipmaAreaCode' | 'isDistrictWideWarning'>,
  parcel: Pick<ParcelRecord, 'district'>
): boolean {
  if (!storm.isDistrictWideWarning) return false;
  const parcelCode = resolveIpmaAreaCodeForDistrict(parcel.district);
  if (parcelCode && storm.ipmaAreaCode && parcelCode === storm.ipmaAreaCode.toUpperCase()) {
    return true;
  }
  const stormDistrictNorm = normalizePortugueseLookupKey(storm.district);
  const parcelDistrictNorm = normalizePortugueseLookupKey(parcel.district);
  return Boolean(stormDistrictNorm && parcelDistrictNorm && stormDistrictNorm === parcelDistrictNorm);
}

/**
 * Enriches the static IPMA area map with live coordinates from
 * `https://api.ipma.pt/open-data/distrits-islands.json`.
 */
export function hydrateIpmaAreaLocations(
  rawDistritsIslandsPayload: unknown
): Record<string, IpmaAreaLocation> {
  const merged: Record<string, IpmaAreaLocation> = { ...DEFAULT_IPMA_AREA_LOCATIONS };
  if (!rawDistritsIslandsPayload || typeof rawDistritsIslandsPayload !== 'object') {
    return merged;
  }
  const data = (rawDistritsIslandsPayload as { data?: unknown }).data;
  if (!Array.isArray(data)) return merged;

  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as {
      idAreaAviso?: string;
      local?: string;
      latitude?: string | number;
      longitude?: string | number;
    };
    const code = String(rec.idAreaAviso || '').trim().toUpperCase();
    const lat = Number(rec.latitude);
    const lon = Number(rec.longitude);
    if (!code || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const existing = merged[code];
    if (existing) {
      merged[code] = {
        ...existing,
        municipality: rec.local?.trim() || existing.municipality,
        lat,
        lon,
      };
    } else {
      const localName = rec.local?.trim() || code;
      merged[code] = {
        idAreaAviso: code,
        district: localName,
        municipality: localName,
        lat,
        lon,
      };
    }
  }

  return merged;
}

export interface RawIpmaWarningItem {
  idAreaAviso?: string;
  awarenessTypeName?: string;
  awarenessLevelID?: string;
  startTime?: string;
  endTime?: string;
  text?: string;
}

function severityRank(level: StormSeverityLevel): number {
  if (level === 'RED') return 3;
  if (level === 'ORANGE') return 2;
  return 1;
}

function formatIpmaValidityWindowPt(startTime?: string, endTime?: string): string {
  const startHm = typeof startTime === 'string' && startTime.length >= 16 ? startTime.slice(11, 16) : '';
  const endHm = typeof endTime === 'string' && endTime.length >= 16 ? endTime.slice(11, 16) : '';
  const endDay = typeof endTime === 'string' && endTime.length >= 10 ? endTime.slice(8, 10) + '/' + endTime.slice(5, 7) : '';
  if (startHm && endHm && endDay) {
    return `${startHm}–${endHm} (${endDay})`;
  }
  if (endHm) {
    return `Até às ${endHm}`;
  }
  return 'Aviso oficial em vigor';
}

/**
 * Parses official IPMA `warnings_www.json` entries into normalized `StormAlertIncident` items.
 * Deduplicates multiple forecast windows per `(idAreaAviso, awarenessTypeName)` keeping the highest severity.
 */
export function parseIpmaWarningsPayload(
  rawWarnings: unknown,
  areaLocations: Record<string, IpmaAreaLocation> = DEFAULT_IPMA_AREA_LOCATIONS,
  nowMs?: number
): StormAlertIncident[] {
  if (!Array.isArray(rawWarnings)) return [];

  const deduped = new Map<string, StormAlertIncident>();

  for (const raw of rawWarnings) {
    if (!raw || typeof raw !== 'object') continue;
    const w = raw as RawIpmaWarningItem;
    const levelRaw = String(w.awarenessLevelID || '').trim().toLowerCase();
    if (levelRaw !== 'yellow' && levelRaw !== 'orange' && levelRaw !== 'red') {
      continue;
    }

    if (typeof nowMs === 'number' && typeof w.endTime === 'string' && w.endTime.trim()) {
      const parsedEnd = Date.parse(w.endTime.endsWith('Z') ? w.endTime : `${w.endTime}Z`);
      if (Number.isFinite(parsedEnd) && parsedEnd < nowMs - 30 * 60_000) {
        continue;
      }
    }

    const code = String(w.idAreaAviso || '').trim().toUpperCase();
    // Normalize legacy aliases if ever encountered
    const normalizedCode = code === 'PRT' ? 'PTO' : code === 'SET' ? 'STB' : code;
    const area = areaLocations[normalizedCode];
    if (!area) continue;

    const rawTypeName = String(w.awarenessTypeName || 'Meteorologia Severa').trim();
    const typeKey = normalizePortugueseLookupKey(rawTypeName);

    // Exclude marine-only surf warnings (Agitação Marítima), which IPMA pins to inland district capitals
    if (typeKey.includes('agitacao maritima') || typeKey.includes('maritima')) {
      continue;
    }

    const isThunder = typeKey.includes('trovoada');
    const isRainOrSnow =
      typeKey.includes('precipitacao') ||
      typeKey.includes('chuva') ||
      typeKey.includes('neve') ||
      typeKey.includes('nevoeiro');
    const isWind = typeKey.includes('vento');
    const isExtremeTemp = typeKey.includes('tempo quente') || typeKey.includes('tempo frio');

    if (!isThunder && !isRainOrSnow && !isWind && !isExtremeTemp) {
      continue;
    }

    const severity: StormSeverityLevel =
      levelRaw === 'red' ? 'RED' : levelRaw === 'orange' ? 'ORANGE' : 'YELLOW';

    let kind: StormHazardKind = 'WINDSTORM';
    if (isThunder) {
      kind = 'DRY_THUNDERSTORM';
    } else if (isRainOrSnow) {
      kind = 'HEAVY_RAIN_FLOOD';
    } else if (isWind && severity !== 'YELLOW') {
      kind = 'EXTREME_GUSTS';
    }

    const levelPt =
      severity === 'RED' ? 'Vermelho' : severity === 'ORANGE' ? 'Laranja' : 'Amarelo';
    const descriptionSuffix = w.text?.trim() ? ` — ${w.text.trim()}` : '';

    const candidate: StormAlertIncident = {
      id: `ipma_${normalizedCode}_${typeKey.replace(/[^a-z0-9]+/g, '_').slice(0, 18)}`,
      title: `Aviso IPMA ${levelPt} de ${rawTypeName}${descriptionSuffix}`,
      kind,
      severity,
      municipality: area.municipality,
      district: area.district,
      lat: area.lat,
      lon: area.lon,
      radiusKm: severity === 'RED' ? 22 : severity === 'ORANGE' ? 18 : 14,
      maxWindKmh: isWind
        ? severity === 'RED'
          ? 115
          : severity === 'ORANGE'
            ? 92
            : 75
        : 48,
      precipitationMmH: isRainOrSnow
        ? severity === 'RED'
          ? 42
          : severity === 'ORANGE'
            ? 26
            : 14
        : 4,
      lightningRisk: isThunder || (isExtremeTemp && typeKey.includes('quente')),
      validUntil: formatIpmaValidityWindowPt(w.startTime, w.endTime),
      source: 'IPMA Avisos Oficiais (Tempo Real)',
      ipmaAreaCode: normalizedCode,
      isDistrictWideWarning: true,
      updatedAtIso: w.startTime || undefined,
    };

    const existing = deduped.get(candidate.id);
    if (!existing || severityRank(candidate.severity) > severityRank(existing.severity)) {
      deduped.set(candidate.id, candidate);
    }
  }

  return Array.from(deduped.values()).sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity)
  );
}

export interface ParsedSseFrame {
  event: string;
  data: string;
}

/**
 * Buffers arbitrary UTF-8 stream chunks and extracts only complete SSE frames
 * delimited by `\n\n` (or `\r\n\r\n`). Prevents `JSON.parse` failures on 35KB+ ANEPC frames.
 */
export function consumeSseBuffer(rawBuffer: string): {
  frames: ParsedSseFrame[];
  remainder: string;
} {
  const normalized = rawBuffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const remainder = parts.pop() ?? '';
  const frames: ParsedSseFrame[] = [];

  for (const block of parts) {
    const trimmed = block.trim();
    if (!trimmed || trimmed.startsWith(':')) continue;

    let eventName = 'message';
    const dataLines: string[] = [];

    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim() || 'message';
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    }

    if (dataLines.length > 0) {
      frames.push({
        event: eventName,
        data: dataLines.join('\n'),
      });
    }
  }

  return { frames, remainder };
}

export function parseAnepcCountsPayload(rawData: string | unknown): AnepcNationalSummary | null {
  try {
    const parsed = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.total_ocorrencias !== 'number') return null;
    return {
      totalOccurrences: Number(obj.total_ocorrencias) || 0,
      totalOperatives: Number(obj.total_operacionais) || 0,
      totalVehicles: Number(obj.total_veiculos) || 0,
      totalAerial: Number(obj.total_aereos) || 0,
      totalFires: Number(obj.total_incendios) || 0,
      totalSignificant: Number(obj.total_significativas) || 0,
    };
  } catch {
    return null;
  }
}

export interface RawAnepcSadoIncident {
  id?: string | number;
  dates?: {
    started?: string;
    last_updated?: string;
    finished?: string;
  };
  means_involved?: {
    aerial?: number;
    aquatic?: number;
    man?: number;
    terrain?: number;
    total_meios?: number;
  };
  location?: {
    district?: string;
    county?: string;
    parish?: string;
    locality?: string;
  };
  coordinates?: {
    latitude?: string | number;
    longitude?: string | number;
  };
  occurrence?: {
    status?: string;
    natureza?: string;
    naturezaCode?: string;
    category?: string;
    category_name?: string;
    significant?: boolean;
  };
}

function mapAnepcStatusPt(rawStatus?: string): ActiveFireIncident['status'] {
  const s = normalizePortugueseLookupKey(rawStatus);
  if (s.includes('resolucao')) return 'Em Resolução';
  if (s.includes('conclusao') || s.includes('encerrad')) return 'Em Conclusão';
  if (s.includes('vigilancia')) return 'Vigilância';
  if (s.includes('despacho') || s.includes('chegada')) return 'Despacho';
  return 'Em Curso';
}

function formatAnepcTimeLabel(started?: string, rawStatus?: string): string {
  const statusClean = rawStatus?.trim() || 'Ativo';
  if (typeof started === 'string' && started.length >= 16) {
    const hm = started.slice(11, 16);
    return `Início ${hm} · ${statusClean}`;
  }
  return statusClean;
}

/**
 * Classifies live ANEPC SADO occurrences into:
 * 1. `fires`: Rural/forest/bush/agricultural fires and `category === 'fire'` (`Situação Crítica`).
 * 2. `civilWeatherHazards`: Fallen trees, floods, road hazard clearance, landslides, downed lines,
 *    so rural parcel owners are alerted in real time when Proteção Civil teams operate near their land.
 */
export function classifyAnepcIncidents(rawPayload: string | unknown): {
  fires: Omit<ActiveFireIncident, 'distanceKm'>[];
  civilWeatherHazards: StormAlertIncident[];
} {
  let list: unknown[] = [];
  try {
    const parsed = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
    if (Array.isArray(parsed)) {
      list = parsed;
    }
  } catch {
    return { fires: [], civilWeatherHazards: [] };
  }

  const fires: Omit<ActiveFireIncident, 'distanceKm'>[] = [];
  const civilWeatherHazards: StormAlertIncident[] = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const inc = item as RawAnepcSadoIncident;
    const lat = Number(inc.coordinates?.latitude);
    const lon = Number(inc.coordinates?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < 30 || lat > 44 || lon < -33 || lon > -5) continue;

    const category = normalizePortugueseLookupKey(inc.occurrence?.category);
    const naturezaRaw = String(inc.occurrence?.natureza || 'Ocorrência Proteção Civil').trim();
    const naturezaNorm = normalizePortugueseLookupKey(naturezaRaw);
    const categoryNameNorm = normalizePortugueseLookupKey(inc.occurrence?.category_name);
    const statusRaw = String(inc.occurrence?.status || 'Em Curso').trim();

    const municipality = inc.location?.county?.trim() || inc.location?.district?.trim() || 'Portugal';
    const parish = inc.location?.parish?.trim() || inc.location?.locality?.trim() || municipality;
    const district = inc.location?.district?.trim() || municipality;
    const operatives = Math.max(0, Number(inc.means_involved?.man ?? 0));
    const vehicles = Math.max(0, Number(inc.means_involved?.terrain ?? 0));
    const aerialMeans = Math.max(0, Number(inc.means_involved?.aerial ?? 0));
    const id = `anepc_${String(inc.id ?? `${lat.toFixed(4)}_${lon.toFixed(4)}`)}`;

    const isRuralOrCriticalFire =
      category === 'fire' ||
      categoryNameNorm.includes('incendio') ||
      naturezaNorm.includes('mato') ||
      naturezaNorm.includes('povoamento') ||
      naturezaNorm.includes('florestal') ||
      naturezaNorm.includes('agricola') ||
      naturezaNorm.includes('queima') ||
      naturezaNorm.includes('situacao critica') ||
      (naturezaNorm.includes('incendio') && !naturezaNorm.includes('urbano') && !naturezaNorm.includes('habitacional'));

    if (isRuralOrCriticalFire) {
      let nature: ActiveFireIncident['nature'] = 'Mato';
      if (naturezaNorm.includes('povoamento') || naturezaNorm.includes('florest')) {
        nature = 'Povoamento Florestal';
      } else if (naturezaNorm.includes('agricola')) {
        nature = 'Agrícola';
      } else if (naturezaNorm.includes('situacao critica')) {
        nature = 'Situação Crítica';
      }

      fires.push({
        id,
        municipality,
        parish,
        district,
        nature,
        status: mapAnepcStatusPt(statusRaw),
        lat,
        lon,
        operatives,
        vehicles,
        aerialMeans,
        startedAt: formatAnepcTimeLabel(inc.dates?.started, statusRaw),
        source: 'ANEPC Proteção Civil (Tempo Real)',
        anepcNaturezaCode: inc.occurrence?.naturezaCode,
        updatedAtIso: inc.dates?.last_updated || inc.dates?.started,
      });
      continue;
    }

    const isWeatherOrTerrainHazard =
      naturezaNorm.includes('queda de arvore') ||
      naturezaNorm.includes('inundac') ||
      naturezaNorm.includes('cheia') ||
      naturezaNorm.includes('submersao') ||
      naturezaNorm.includes('deslizamento') ||
      naturezaNorm.includes('desabamento') ||
      naturezaNorm.includes('queda de estrutura') ||
      naturezaNorm.includes('limpeza de via') ||
      naturezaNorm.includes('sinalizacao de perigo') ||
      naturezaNorm.includes('meteorolog') ||
      naturezaNorm.includes('vento') ||
      naturezaNorm.includes('eletric') ||
      categoryNameNorm.includes('comprometimento') ||
      categoryNameNorm.includes('meteorolog');

    if (isWeatherOrTerrainHazard) {
      const isFlood =
        naturezaNorm.includes('inundac') ||
        naturezaNorm.includes('cheia') ||
        naturezaNorm.includes('deslizamento');
      const severity: StormSeverityLevel =
        inc.occurrence?.significant || operatives >= 15
          ? 'RED'
          : operatives >= 6
            ? 'ORANGE'
            : 'YELLOW';

      civilWeatherHazards.push({
        id,
        title: `Proteção Civil: ${naturezaRaw} (${statusRaw})`,
        kind: isFlood ? 'HEAVY_RAIN_FLOOD' : 'WINDSTORM',
        severity,
        municipality,
        district,
        lat,
        lon,
        radiusKm: severity === 'RED' ? 6 : 4,
        maxWindKmh: severity === 'RED' ? 85 : 60,
        precipitationMmH: isFlood ? 22 : 8,
        lightningRisk: naturezaNorm.includes('eletric'),
        validUntil: formatAnepcTimeLabel(inc.dates?.started, statusRaw),
        source: 'ANEPC Proteção Civil (Tempo Real)',
        isDistrictWideWarning: false,
        anepcNaturezaCode: inc.occurrence?.naturezaCode,
        operatives,
        vehicles,
        updatedAtIso: inc.dates?.last_updated || inc.dates?.started,
      });
    }
  }

  return { fires, civilWeatherHazards };
}

/**
 * Merges secondary `api.apiaberta.pt/v1/anpc/incidents/active` rural fires without duplicating
 * incidents already ingested from the primary ANEPC SADO real-time stream.
 */
export function mergeSecondaryApiAbertaFires(
  primaryFires: Omit<ActiveFireIncident, 'distanceKm'>[],
  rawApiAbertaData: unknown
): Omit<ActiveFireIncident, 'distanceKm'>[] {
  if (!Array.isArray(rawApiAbertaData) || rawApiAbertaData.length === 0) {
    return primaryFires;
  }

  const merged = [...primaryFires];
  for (const raw of rawApiAbertaData) {
    if (!raw || typeof raw !== 'object') continue;
    const it = raw as {
      id?: string | number;
      concelho?: string;
      freguesia?: string;
      natureza?: string;
      estado?: string;
      lat?: number;
      lng?: number;
      man?: number;
      terrain?: number;
      aerial?: number;
    };
    const lat = Number(it.lat);
    const lon = Number(it.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const alreadyPresent = merged.some(
      (f) =>
        f.id === `anepc_${String(it.id)}` ||
        haversineDistanceKm({ lat: f.lat, lon: f.lon }, { lat, lon }) < 0.75
    );
    if (alreadyPresent) continue;

    merged.push({
      id: `apiaberta_${String(it.id ?? `${lat.toFixed(4)}_${lon.toFixed(4)}`)}`,
      municipality: it.concelho?.trim() || 'Portugal',
      parish: it.freguesia?.trim() || 'Freguesia',
      nature: it.natureza?.toLowerCase().includes('florest') ? 'Povoamento Florestal' : 'Mato',
      status: mapAnepcStatusPt(it.estado),
      lat,
      lon,
      operatives: Math.max(0, Number(it.man ?? 0)),
      vehicles: Math.max(0, Number(it.terrain ?? 0)),
      aerialMeans: Math.max(0, Number(it.aerial ?? 0)),
      startedAt: it.estado?.trim() || 'Ativo ANEPC',
      source: 'ANEPC / API Aberta',
    });
  }

  return merged;
}
