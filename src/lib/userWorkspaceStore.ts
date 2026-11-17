import type {
  LandClass,
  LatLon,
  MunicipalityInfo,
  ParcelDocumentCategory,
  ParcelDocumentRecord,
  ParcelRecord,
  ParcelVectorContext,
  ProximityRadiusKm,
  UserAppSettings,
} from '../types/domain.ts';
import { INITIAL_PARCELS, INITIAL_PROVIDERS, MUNICIPALITIES } from '../data/seedCatalog.ts';
import {
  findMunicipalityByDico,
  resolveMergedMunicipalityCatalog,
} from '../data/portugalAdminCatalog.ts';
import { computeParcelFgc } from './spatialEngine.ts';
import { synthesizeDeterministicCadastreContext } from './vectorContextIngestor.ts';

export interface KeyValueStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const LS_KEY_USER_SETTINGS = 'fs_user_app_settings_v1';
export const LS_KEY_FAVORITE_PROVIDERS = 'fs_favorite_providers_v1';
export const LS_KEY_PARCEL_DOCS_META = 'fs_parcel_docs_meta_v1';
export const LS_KEY_PARCEL_DOCS_SEEDED = 'fs_parcel_docs_seeded_v1';

const DOCS_IDB_NAME = 'faixasegura_user_docs_v1';
const DOCS_IDB_VERSION = 1;
const DOCS_STORE = 'parcel_documents';

export const MAX_PARCEL_DOCUMENT_BYTES = 4 * 1024 * 1024; // 4 MB local limit

export const PARCEL_DOCUMENT_CATEGORY_LABELS: Record<ParcelDocumentCategory, string> = {
  CADERNETA_PREDIAL: 'Caderneta Predial',
  BUPI_RGG: 'Georreferenciação BUPi (RGG)',
  FATURA_LIMPEZA: 'Fatura / Recibo de Limpeza',
  AUTO_CONFORMIDADE: 'Auto SHA-256 / Relatório',
  AUTORIZACAO_ICNF: 'Licença ICNF / Quercíneas',
  OUTRO: 'Outro Documento Técnico',
};

export const DEFAULT_USER_APP_SETTINGS: UserAppSettings = {
  pirAlertThreshold: 4,
  proximityAlertRadiusKm: 15,
  autoDownloadCertificatePdf: false,
  defaultBufferRule: '50M_BUILDING',
  offlineAutoSync: true,
  notifyQuotesWhatsapp: true,
  enableFireProximityAlerts: true,
  enableStormProximityAlerts: true,
  prioritizeForestScrubAlerts: true,
  browserNotificationsEnabled: false,
};

export const DEFAULT_FAVORITE_PROVIDER_IDS: string[] = INITIAL_PROVIDERS[0]
  ? [INITIAL_PROVIDERS[0].id]
  : [];

export interface ParcelMutationInput {
  label: string;
  district?: string;
  dico: string;
  parish?: string;
  matrixArticle?: string;
  bupiRggId?: string;
  landClass: LandClass;
  avgSlopePct: number;
  hasEredesLine: boolean;
  hasProtectedOaks: boolean;
  userNotes?: string;
  vertices?: LatLon[];
}

export interface ParcelLocalLlmNotePayload {
  schemaVersion: 'faixasegura.local-llm-notes.v1';
  parcelId: string;
  label: string;
  district: string;
  municipality: string;
  dico: string;
  parish: string;
  matrixArticle: string;
  bupiRggId: string;
  landClass: LandClass;
  userNotes: string;
  characterCount: number;
  readyForExtraction: boolean;
}

export function buildParcelLocalLlmNotePayload(parcel: ParcelRecord): ParcelLocalLlmNotePayload {
  const cleanNotes = (parcel.userNotes ?? '').trim().slice(0, 2000);
  return {
    schemaVersion: 'faixasegura.local-llm-notes.v1',
    parcelId: parcel.id,
    label: parcel.label,
    district: parcel.district,
    municipality: parcel.municipality,
    dico: parcel.dico,
    parish: parcel.parish,
    matrixArticle: parcel.matrixArticle,
    bupiRggId: parcel.bupiRggId,
    landClass: parcel.landClass,
    userNotes: cleanNotes,
    characterCount: cleanNotes.length,
    readyForExtraction: cleanNotes.length > 0,
  };
}

export function buildDefaultRectangleAroundCenter(center: LatLon): LatLon[] {
  return [
    { lat: Number((center.lat - 0.00035).toFixed(6)), lon: Number((center.lon - 0.00045).toFixed(6)) },
    { lat: Number((center.lat + 0.00035).toFixed(6)), lon: Number((center.lon - 0.00042).toFixed(6)) },
    { lat: Number((center.lat + 0.00037).toFixed(6)), lon: Number((center.lon + 0.00044).toFixed(6)) },
    { lat: Number((center.lat - 0.00033).toFixed(6)), lon: Number((center.lon + 0.00041).toFixed(6)) },
  ];
}

export function formatVerticesMultiline(vertices: LatLon[]): string {
  return vertices.map((v) => `${v.lat.toFixed(6)}, ${v.lon.toFixed(6)}`).join('\n');
}

export function normalizeVertexCoord(point: LatLon): LatLon {
  return {
    lat: Number(point.lat.toFixed(6)),
    lon: Number(point.lon.toFixed(6)),
  };
}

export function appendPolygonVertex(vertices: readonly LatLon[], point: LatLon): LatLon[] {
  return [...vertices, normalizeVertexCoord(point)];
}

export function updatePolygonVertexAt(
  vertices: readonly LatLon[],
  index: number,
  point: LatLon
): LatLon[] {
  if (!Number.isInteger(index) || index < 0 || index >= vertices.length) {
    return [...vertices];
  }
  const normalized = normalizeVertexCoord(point);
  return vertices.map((existing, idx) => (idx === index ? normalized : existing));
}

export function removePolygonVertexAt(vertices: readonly LatLon[], index: number): LatLon[] {
  if (!Number.isInteger(index) || index < 0 || index >= vertices.length) {
    return [...vertices];
  }
  return vertices.filter((_, idx) => idx !== index);
}

export function clearAllPolygonVertices(): LatLon[] {
  return [];
}

export function resolveNextSelectedVertexIndexAfterRemoval(
  prevSelectedIndex: number | null,
  removedIndex: number,
  nextLength: number
): number | null {
  if (prevSelectedIndex === null || nextLength <= 0) {
    return null;
  }
  if (prevSelectedIndex === removedIndex) {
    return Math.min(removedIndex, nextLength - 1);
  }
  if (prevSelectedIndex > removedIndex) {
    return prevSelectedIndex - 1;
  }
  return Math.min(prevSelectedIndex, nextLength - 1);
}

export function parseVerticesMultiline(rawText: string): {
  valid: boolean;
  vertices: LatLon[];
  error?: string;
} {
  const lines = rawText
    .split(/\r?\n|;/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 3) {
    return {
      valid: false,
      vertices: [],
      error: 'Indique pelo menos 3 vértices geográficos (um par latitude, longitude por linha).',
    };
  }

  const parsed: LatLon[] = [];
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(/[,\s]+/).filter(Boolean);
    if (parts.length < 2) {
      return {
        valid: false,
        vertices: [],
        error: `Linha ${i + 1} inválida: use o formato "latitude, longitude" (ex.: 38.7984, -9.4621).`,
      };
    }
    const lat = Number(parts[0]);
    const lon = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return {
        valid: false,
        vertices: [],
        error: `Coordenadas fora dos limites geográficos na linha ${i + 1}.`,
      };
    }
    parsed.push({
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
    });
  }

  return { valid: true, vertices: parsed };
}

export function validateParcelMutationInput(input: {
  label: string;
  avgSlopePct: number;
  nif?: string;
}): { valid: boolean; error?: string } {
  const cleanLabel = (input.label ?? '').trim();
  if (cleanLabel.length < 2) {
    return {
      valid: false,
      error: 'Indique uma designação válida para a propriedade (mínimo 2 caracteres).',
    };
  }
  if (cleanLabel.length > 120) {
    return {
      valid: false,
      error: 'A designação da propriedade não pode exceder 120 caracteres.',
    };
  }
  const slope = Number(input.avgSlopePct);
  if (!Number.isFinite(slope) || slope < 0 || slope > 100) {
    return {
      valid: false,
      error: 'O declive médio deve estar compreendido entre 0% e 100%.',
    };
  }
  return { valid: true };
}

/**
 * Pure parcel update reducer: applies user edits and deterministically recomputes
 * EPSG:3763 spatial zones (Despacho n.º 675/2026) whenever landClass, E-REDES,
 * municipality, or vertices change.
 */
export function applyParcelUpdate(
  existing: ParcelRecord,
  patch: Partial<ParcelMutationInput> & {
    recenterVerticesOnMunicipalityChange?: boolean;
    vectorContext?: ParcelVectorContext;
  },
  municipalities: MunicipalityInfo[] = MUNICIPALITIES
): ParcelRecord {
  const catalog = resolveMergedMunicipalityCatalog(municipalities);
  const targetDico = patch.dico ?? existing.dico;
  const muni = findMunicipalityByDico(targetDico, catalog);
  const dicoChanged = muni.dico !== existing.dico;

  let nextVertices = existing.vertices;
  if (Array.isArray(patch.vertices) && patch.vertices.length >= 3) {
    nextVertices = patch.vertices;
  } else if (dicoChanged && patch.recenterVerticesOnMunicipalityChange) {
    nextVertices = buildDefaultRectangleAroundCenter(muni.defaultCenter);
  }

  const nextLandClass: LandClass = patch.landClass ?? existing.landClass;
  const nextHasEredes =
    patch.hasEredesLine !== undefined ? Boolean(patch.hasEredesLine) : existing.hasEredesLine;
  const nextEredesType: ParcelRecord['eredesType'] = nextHasEredes
    ? existing.eredesType !== 'Sem linha aérea'
      ? existing.eredesType
      : 'MT 15kV (Faixa 7m)'
    : 'Sem linha aérea';
  const nextHasOaks =
    patch.hasProtectedOaks !== undefined ? Boolean(patch.hasProtectedOaks) : existing.hasProtectedOaks;

  const nextSlope =
    patch.avgSlopePct !== undefined
      ? Math.max(0, Math.min(100, Number(Number(patch.avgSlopePct).toFixed(1)) || 0))
      : existing.avgSlopePct;

  const verticesChanged = nextVertices !== existing.vertices;
  const nextVectorContext: ParcelVectorContext | undefined =
    patch.vectorContext !== undefined
      ? patch.vectorContext
      : verticesChanged
        ? synthesizeDeterministicCadastreContext({
            parcelVertices: nextVertices,
            hasEredesLine: nextHasEredes,
            eredesType: nextEredesType,
            hasProtectedOaks: nextHasOaks,
          })
        : existing.vectorContext;

  const spatialNeedsRecompute =
    nextLandClass !== existing.landClass ||
    nextHasEredes !== existing.hasEredesLine ||
    verticesChanged ||
    patch.vectorContext !== undefined;

  const nextSpatial = spatialNeedsRecompute
    ? computeParcelFgc({
        vertices: nextVertices,
        buildingCenter: verticesChanged ? undefined : existing.buildingCenter,
        landClass: nextLandClass,
        hasEredesLine: nextHasEredes,
        eredesType: nextEredesType,
        neighborDistanceOverrideM: existing.spatial.neighborMinDistanceM,
        vectorContext: nextVectorContext,
      })
    : existing.spatial;

  const nextLabel =
    patch.label !== undefined && patch.label.trim().length >= 2
      ? patch.label.trim().slice(0, 120)
      : existing.label;

  const nextParish =
    patch.parish !== undefined && patch.parish.trim().length > 0
      ? patch.parish.trim().slice(0, 180)
      : dicoChanged
        ? muni.name
        : existing.parish;

  const nextDistrict =
    patch.district !== undefined && patch.district.trim().length >= 2
      ? patch.district.trim().slice(0, 80)
      : muni.district;

  const nextMatrix =
    patch.matrixArticle !== undefined && patch.matrixArticle.trim().length > 0
      ? patch.matrixArticle.trim().slice(0, 80)
      : existing.matrixArticle;

  const nextBupi =
    patch.bupiRggId !== undefined && patch.bupiRggId.trim().length > 0
      ? patch.bupiRggId.trim().slice(0, 40)
      : existing.bupiRggId;

  const nextUserNotes =
    patch.userNotes !== undefined
      ? patch.userNotes.trim().slice(0, 2000)
      : (existing.userNotes ?? '');

  return {
    ...existing,
    label: nextLabel,
    parish: nextParish,
    municipality: muni.name,
    district: nextDistrict,
    dico: muni.dico,
    dicofre: dicoChanged ? muni.dicofreDefault : existing.dicofre,
    isPriorityParish: dicoChanged ? muni.isPriorityParishDefault : existing.isPriorityParish,
    matrixArticle: nextMatrix,
    bupiRggId: nextBupi,
    landClass: nextLandClass,
    avgSlopePct: nextSlope,
    hasEredesLine: nextHasEredes,
    eredesType: nextEredesType,
    hasProtectedOaks: nextHasOaks,
    protectedOakNotes: nextHasOaks
      ? 'Exemplares de Sobreiro/Azinheira assinalados — corte interdito sem autorização ICNF (DL 169/2001).'
      : 'Sem quercíneas protegidas assinaladas no polígono.',
    userNotes: nextUserNotes,
    vertices: nextVertices,
    buildingCenter: verticesChanged ? nextSpatial.centroidWgs84 : existing.buildingCenter,
    vectorContext: nextVectorContext,
    spatial: nextSpatial,
  };
}

export function removeParcelSafely(
  parcels: ParcelRecord[],
  activeParcelId: string,
  targetParcelId: string
): {
  ok: boolean;
  nextParcels: ParcelRecord[];
  nextActiveParcelId: string;
  error?: string;
} {
  const exists = parcels.some((p) => p.id === targetParcelId);
  if (!exists) {
    return {
      ok: false,
      nextParcels: parcels,
      nextActiveParcelId: activeParcelId,
      error: 'O terreno selecionado já não se encontra na lista.',
    };
  }

  if (parcels.length <= 1) {
    return {
      ok: false,
      nextParcels: parcels,
      nextActiveParcelId: activeParcelId,
      error:
        'Deve manter pelo menos um terreno registado na conta. Adicione primeiro outro terreno se pretender substituir este.',
    };
  }

  const nextParcels = parcels.filter((p) => p.id !== targetParcelId);
  const nextActiveParcelId =
    activeParcelId === targetParcelId ? nextParcels[0].id : activeParcelId;

  return {
    ok: true,
    nextParcels,
    nextActiveParcelId,
  };
}

// ==================== FAVORITE PROVIDERS ====================

export function toggleFavoriteProviderId(currentIds: string[], providerId: string): string[] {
  const trimmed = (providerId ?? '').trim();
  if (!trimmed) return currentIds;
  if (currentIds.includes(trimmed)) {
    return currentIds.filter((id) => id !== trimmed);
  }
  return [trimmed, ...currentIds];
}

function resolveDefaultStorage(explicit?: KeyValueStorageLike | null): KeyValueStorageLike | null {
  if (explicit !== undefined) return explicit;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadFavoriteProviderIds(explicitStorage?: KeyValueStorageLike | null): string[] {
  const store = resolveDefaultStorage(explicitStorage);
  if (!store) return [...DEFAULT_FAVORITE_PROVIDER_IDS];
  try {
    const raw = store.getItem(LS_KEY_FAVORITE_PROVIDERS);
    if (raw === null) {
      return [...DEFAULT_FAVORITE_PROVIDER_IDS];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_FAVORITE_PROVIDER_IDS];
    return parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
  } catch {
    return [...DEFAULT_FAVORITE_PROVIDER_IDS];
  }
}

export function saveFavoriteProviderIds(
  ids: string[],
  explicitStorage?: KeyValueStorageLike | null
): void {
  const store = resolveDefaultStorage(explicitStorage);
  if (!store) return;
  try {
    const dedup = Array.from(new Set(ids.filter((x) => typeof x === 'string' && x.length > 0)));
    store.setItem(LS_KEY_FAVORITE_PROVIDERS, JSON.stringify(dedup));
  } catch {
    // Ignore storage quota restrictions
  }
}

// ==================== USER APP SETTINGS ====================

export function sanitizeUserAppSettings(raw: Partial<UserAppSettings> | null | undefined): UserAppSettings {
  const src = raw ?? {};
  const pirAlertThreshold: 3 | 4 = src.pirAlertThreshold === 3 ? 3 : 4;
  const proximityAlertRadiusKm: ProximityRadiusKm =
    src.proximityAlertRadiusKm === 5 ||
    src.proximityAlertRadiusKm === 10 ||
    src.proximityAlertRadiusKm === 25
      ? src.proximityAlertRadiusKm
      : 15;
  const defaultBufferRule: '50M_BUILDING' | '100M_SETTLEMENT' =
    src.defaultBufferRule === '100M_SETTLEMENT' ? '100M_SETTLEMENT' : '50M_BUILDING';

  return {
    pirAlertThreshold,
    proximityAlertRadiusKm,
    autoDownloadCertificatePdf:
      typeof src.autoDownloadCertificatePdf === 'boolean'
        ? src.autoDownloadCertificatePdf
        : DEFAULT_USER_APP_SETTINGS.autoDownloadCertificatePdf,
    defaultBufferRule,
    offlineAutoSync:
      typeof src.offlineAutoSync === 'boolean'
        ? src.offlineAutoSync
        : DEFAULT_USER_APP_SETTINGS.offlineAutoSync,
    notifyQuotesWhatsapp:
      typeof src.notifyQuotesWhatsapp === 'boolean'
        ? src.notifyQuotesWhatsapp
        : DEFAULT_USER_APP_SETTINGS.notifyQuotesWhatsapp,
    enableFireProximityAlerts:
      typeof src.enableFireProximityAlerts === 'boolean'
        ? src.enableFireProximityAlerts
        : true,
    enableStormProximityAlerts:
      typeof src.enableStormProximityAlerts === 'boolean'
        ? src.enableStormProximityAlerts
        : true,
    prioritizeForestScrubAlerts:
      typeof src.prioritizeForestScrubAlerts === 'boolean'
        ? src.prioritizeForestScrubAlerts
        : true,
    browserNotificationsEnabled:
      typeof src.browserNotificationsEnabled === 'boolean'
        ? src.browserNotificationsEnabled
        : false,
  };
}

export function loadUserAppSettings(explicitStorage?: KeyValueStorageLike | null): UserAppSettings {
  const store = resolveDefaultStorage(explicitStorage);
  if (!store) return { ...DEFAULT_USER_APP_SETTINGS };
  try {
    const raw = store.getItem(LS_KEY_USER_SETTINGS);
    if (!raw) return { ...DEFAULT_USER_APP_SETTINGS };
    return sanitizeUserAppSettings(JSON.parse(raw) as Partial<UserAppSettings>);
  } catch {
    return { ...DEFAULT_USER_APP_SETTINGS };
  }
}

export function saveUserAppSettings(
  settings: UserAppSettings,
  explicitStorage?: KeyValueStorageLike | null
): UserAppSettings {
  const clean = sanitizeUserAppSettings(settings);
  const store = resolveDefaultStorage(explicitStorage);
  if (store) {
    try {
      store.setItem(LS_KEY_USER_SETTINGS, JSON.stringify(clean));
    } catch {
      // Ignore quota restrictions
    }
  }
  return clean;
}

// ==================== PER-PARCEL UPLOADED DOCUMENTS ====================

export function formatFileSizePt(sizeBytes: number): string {
  const bytes = Math.max(0, Number(sizeBytes) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function validateDocumentUploadInput(params: {
  parcelId: string;
  fileName: string;
  sizeBytes: number;
}): { valid: boolean; error?: string } {
  if (!(params.parcelId ?? '').trim()) {
    return { valid: false, error: 'Selecione um terreno válido para associar o documento.' };
  }
  const cleanName = (params.fileName ?? '').trim();
  if (cleanName.length < 2) {
    return { valid: false, error: 'Selecione um ficheiro válido do seu dispositivo.' };
  }
  if (!Number.isFinite(params.sizeBytes) || params.sizeBytes <= 0) {
    return { valid: false, error: 'O ficheiro selecionado está vazio (0 bytes).' };
  }
  if (params.sizeBytes > MAX_PARCEL_DOCUMENT_BYTES) {
    return {
      valid: false,
      error: 'O ficheiro excede o limite local de 4,00 MB por documento. Comprima o PDF ou imagem antes de carregar.',
    };
  }
  return { valid: true };
}

export function buildParcelDocumentRecord(params: {
  id?: string;
  parcelId: string;
  fileName: string;
  category: ParcelDocumentCategory;
  mimeType?: string;
  sizeBytes: number;
  notes?: string;
  dataUrl?: string;
  uploadedAtIso?: string;
}): ParcelDocumentRecord {
  const id =
    params.id ||
    `doc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    parcelId: params.parcelId.trim(),
    fileName: params.fileName.trim().slice(0, 140),
    category: params.category,
    mimeType: (params.mimeType || 'application/octet-stream').slice(0, 100),
    sizeBytes: Math.max(1, Math.round(params.sizeBytes)),
    notes: (params.notes ?? '').trim().slice(0, 240),
    uploadedAtIso: params.uploadedAtIso || new Date().toISOString(),
    dataUrl: params.dataUrl,
  };
}

export function filterDocumentsForParcel(
  docs: ParcelDocumentRecord[],
  parcelId: string
): ParcelDocumentRecord[] {
  return docs
    .filter((d) => d.parcelId === parcelId)
    .sort((a, b) => b.uploadedAtIso.localeCompare(a.uploadedAtIso));
}

export function buildInitialSeedParcelDocuments(): ParcelDocumentRecord[] {
  const firstParcel = INITIAL_PARCELS[0];
  if (!firstParcel) return [];

  const cadernetaTxt = [
    'AUTORIDADE TRIBUTÁRIA E ADUANEIRA — CADERNETA PREDIAL RÚSTICA',
    `Prédio: ${firstParcel.label}`,
    `Concelho: ${firstParcel.municipality} (DICO ${firstParcel.dico}) · Freguesia: ${firstParcel.parish}`,
    `Artigo Matricial: ${firstParcel.matrixArticle}`,
    `Identificador BUPi: ${firstParcel.bupiRggId}`,
    `Área Total Registada: ${firstParcel.spatial.totalAreaM2.toFixed(1)} m²`,
  ].join('\n');

  const bupiJson = JSON.stringify(
    {
      type: 'Feature',
      properties: {
        bupi_rgg_id: firstParcel.bupiRggId,
        label: firstParcel.label,
        municipality: firstParcel.municipality,
      },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            ...firstParcel.vertices.map((v) => [v.lon, v.lat]),
            [firstParcel.vertices[0].lon, firstParcel.vertices[0].lat],
          ],
        ],
      },
    },
    null,
    2
  );

  const encodeTextDataUrl = (mime: string, text: string) =>
    `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;

  return [
    {
      id: 'doc-seed-caderneta-colares',
      parcelId: firstParcel.id,
      fileName: 'Caderneta_Predial_Art148_Colares.txt',
      category: 'CADERNETA_PREDIAL',
      mimeType: 'text/plain',
      sizeBytes: 1840,
      notes: 'Extrato matricial rústico validado para emissão de Auto SGIFR.',
      uploadedAtIso: '2026-05-10T10:15:00.000Z',
      dataUrl: encodeTextDataUrl('text/plain', cadernetaTxt),
    },
    {
      id: 'doc-seed-bupi-colares',
      parcelId: firstParcel.id,
      fileName: `${firstParcel.bupiRggId}_Poligono_Oficial.geojson`,
      category: 'BUPI_RGG',
      mimeType: 'application/geo+json',
      sizeBytes: 2420,
      notes: 'Representação Gráfica Georreferenciada submetida no Balcão Único do Prédio.',
      uploadedAtIso: '2026-05-12T15:30:00.000Z',
      dataUrl: encodeTextDataUrl('application/geo+json', bupiJson),
    },
  ];
}

export interface ParcelDocumentStorageAdapter {
  loadDocuments(): Promise<ParcelDocumentRecord[]>;
  saveDocument(docRecord: ParcelDocumentRecord): Promise<void>;
  deleteDocument(docId: string): Promise<void>;
  deleteDocumentsByParcel(parcelId: string): Promise<void>;
}

export function createMemoryParcelDocumentStorage(
  seedInitial = false
): ParcelDocumentStorageAdapter {
  const map = new Map<string, ParcelDocumentRecord>();
  if (seedInitial) {
    for (const d of buildInitialSeedParcelDocuments()) {
      map.set(d.id, structuredClone(d));
    }
  }
  return {
    async loadDocuments() {
      return Array.from(map.values()).sort((a, b) =>
        b.uploadedAtIso.localeCompare(a.uploadedAtIso)
      );
    },
    async saveDocument(docRecord) {
      map.set(docRecord.id, structuredClone(docRecord));
    },
    async deleteDocument(docId) {
      map.delete(docId);
    },
    async deleteDocumentsByParcel(parcelId) {
      for (const [k, v] of map.entries()) {
        if (v.parcelId === parcelId) {
          map.delete(k);
        }
      }
    },
  };
}

/**
 * Browser IndexedDB adapter for per-parcel uploaded documents (keeps binary/DataURL payloads
 * strictly in local IndexedDB with compact metadata mirror in localStorage, respecting Firestore 1MB/no-media limits).
 */
export function createBrowserParcelDocumentStorage(): ParcelDocumentStorageAdapter {
  let dbPromise: Promise<IDBDatabase | null> | null = null;
  const memFallback = createMemoryParcelDocumentStorage(false);

  function getDb(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    if (dbPromise) return dbPromise;

    dbPromise = new Promise<IDBDatabase | null>((resolve) => {
      try {
        const req = indexedDB.open(DOCS_IDB_NAME, DOCS_IDB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(DOCS_STORE)) {
            db.createObjectStore(DOCS_STORE, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return dbPromise;
  }

  function stripLargeDataUrlForLocalStorage(docRecord: ParcelDocumentRecord): ParcelDocumentRecord {
    if (docRecord.dataUrl && docRecord.dataUrl.length > 64_000) {
      const { dataUrl: _omitted, ...metaOnly } = docRecord;
      return metaOnly;
    }
    return docRecord;
  }

  function readLsMeta(): ParcelDocumentRecord[] {
    try {
      if (typeof localStorage === 'undefined') return [];
      const raw = localStorage.getItem(LS_KEY_PARCEL_DOCS_META);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ParcelDocumentRecord[]) : [];
    } catch {
      return [];
    }
  }

  function writeLsMeta(docs: ParcelDocumentRecord[]): void {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(
        LS_KEY_PARCEL_DOCS_META,
        JSON.stringify(docs.map(stripLargeDataUrlForLocalStorage))
      );
    } catch {
      // Ignore quota errors
    }
  }

  function isAlreadySeeded(): boolean {
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem(LS_KEY_PARCEL_DOCS_SEEDED) === '1';
    } catch {
      return false;
    }
  }

  function markSeeded(): void {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(LS_KEY_PARCEL_DOCS_SEEDED, '1');
      }
    } catch {
      // Ignore
    }
  }

  async function idbGetAll(db: IDBDatabase): Promise<ParcelDocumentRecord[] | null> {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(DOCS_STORE, 'readonly');
        const req = tx.objectStore(DOCS_STORE).getAll();
        req.onsuccess = () => resolve((req.result as ParcelDocumentRecord[]) ?? []);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async function idbPut(db: IDBDatabase, item: ParcelDocumentRecord): Promise<void> {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(DOCS_STORE, 'readwrite');
        tx.objectStore(DOCS_STORE).put(item);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async function idbDelete(db: IDBDatabase, id: string): Promise<void> {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(DOCS_STORE, 'readwrite');
        tx.objectStore(DOCS_STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  return {
    async loadDocuments() {
      const db = await getDb();
      let docs: ParcelDocumentRecord[] = [];

      if (db) {
        const rows = await idbGetAll(db);
        if (rows && rows.length > 0) {
          docs = rows;
        }
      }
      if (docs.length === 0) {
        const lsDocs = readLsMeta();
        if (lsDocs.length > 0) {
          docs = lsDocs;
        } else {
          docs = await memFallback.loadDocuments();
        }
      }

      if (docs.length === 0 && !isAlreadySeeded()) {
        const seeds = buildInitialSeedParcelDocuments();
        markSeeded();
        writeLsMeta(seeds);
        for (const s of seeds) {
          await memFallback.saveDocument(s);
          if (db) await idbPut(db, s);
        }
        return seeds.sort((a, b) => b.uploadedAtIso.localeCompare(a.uploadedAtIso));
      }

      markSeeded();
      return docs.sort((a, b) => b.uploadedAtIso.localeCompare(a.uploadedAtIso));
    },

    async saveDocument(docRecord) {
      markSeeded();
      await memFallback.saveDocument(docRecord);
      const currentLs = readLsMeta().filter((d) => d.id !== docRecord.id);
      writeLsMeta([docRecord, ...currentLs]);
      const db = await getDb();
      if (db) {
        await idbPut(db, docRecord);
      }
    },

    async deleteDocument(docId) {
      markSeeded();
      await memFallback.deleteDocument(docId);
      writeLsMeta(readLsMeta().filter((d) => d.id !== docId));
      const db = await getDb();
      if (db) {
        await idbDelete(db, docId);
      }
    },

    async deleteDocumentsByParcel(parcelId) {
      markSeeded();
      await memFallback.deleteDocumentsByParcel(parcelId);
      const existing = await this.loadDocuments();
      const targets = existing.filter((d) => d.parcelId === parcelId);
      writeLsMeta(readLsMeta().filter((d) => d.parcelId !== parcelId));
      const db = await getDb();
      if (db) {
        for (const t of targets) {
          await idbDelete(db, t.id);
        }
      }
    },
  };
}

export const LS_KEY_THEME_DARK = 'fs_user_theme_dark_v1';
export const LS_KEY_THEME_HIGH_CONTRAST = 'fs_user_theme_high_contrast_v1';

export function loadThemeDarkPreference(storage?: KeyValueStorageLike | null): boolean {
  const target =
    storage !== undefined
      ? storage
      : typeof localStorage !== 'undefined'
        ? localStorage
        : null;
  if (!target) return false;
  try {
    return target.getItem(LS_KEY_THEME_DARK) === 'true';
  } catch {
    return false;
  }
}

export function saveThemeDarkPreference(
  darkMode: boolean,
  storage?: KeyValueStorageLike | null
): boolean {
  const target =
    storage !== undefined
      ? storage
      : typeof localStorage !== 'undefined'
        ? localStorage
        : null;
  if (target) {
    try {
      target.setItem(LS_KEY_THEME_DARK, darkMode ? 'true' : 'false');
    } catch {
      // Ignore storage quota restrictions
    }
  }
  return darkMode;
}

export function loadHighContrastPreference(storage?: KeyValueStorageLike | null): boolean {
  const target =
    storage !== undefined
      ? storage
      : typeof localStorage !== 'undefined'
        ? localStorage
        : null;
  if (!target) return false;
  try {
    return target.getItem(LS_KEY_THEME_HIGH_CONTRAST) === 'true';
  } catch {
    return false;
  }
}

export function saveHighContrastPreference(
  highContrastMode: boolean,
  storage?: KeyValueStorageLike | null
): boolean {
  const target =
    storage !== undefined
      ? storage
      : typeof localStorage !== 'undefined'
        ? localStorage
        : null;
  if (target) {
    try {
      target.setItem(LS_KEY_THEME_HIGH_CONTRAST, highContrastMode ? 'true' : 'false');
    } catch {
      // Ignore storage quota restrictions
    }
  }
  return highContrastMode;
}

export function resolveDocumentThemeClasses(params: {
  darkMode: boolean;
  highContrastMode: boolean;
}): {
  activeClasses: Array<'dark' | 'high-contrast'>;
  inactiveClasses: Array<'dark' | 'high-contrast'>;
  dataHighContrast: 'true' | 'false';
} {
  const activeClasses: Array<'dark' | 'high-contrast'> = [];
  const inactiveClasses: Array<'dark' | 'high-contrast'> = [];

  if (params.darkMode) {
    activeClasses.push('dark');
  } else {
    inactiveClasses.push('dark');
  }

  if (params.highContrastMode) {
    activeClasses.push('high-contrast');
  } else {
    inactiveClasses.push('high-contrast');
  }

  return {
    activeClasses,
    inactiveClasses,
    dataHighContrast: params.highContrastMode ? 'true' : 'false',
  };
}

export type UserGalleryItemId =
  | 'properties'
  | 'favorites'
  | 'settings'
  | 'theme'
  | 'history'
  | 'docs'
  | 'logout';

export interface UserGalleryCardDescriptor {
  id: UserGalleryItemId;
  title: string;
  shortTitle: string;
  kicker: string;
  description: string;
  actionKind: 'SECTION' | 'LOGOUT';
}

export function buildUserGalleryCatalog(params: {
  parcelCount: number;
  documentCount: number;
  favoriteProviderCount: number;
  darkMode: boolean;
  historyCount: number;
  certificateCount: number;
  displayName: string;
  isCloudSession: boolean;
}): UserGalleryCardDescriptor[] {
  const {
    parcelCount,
    documentCount,
    favoriteProviderCount,
    darkMode,
    historyCount,
    certificateCount,
    displayName,
    isCloudSession,
  } = params;

  return [
    {
      id: 'properties',
      title: 'Terrenos & Documentos',
      shortTitle: 'Terrenos & Docs',
      kicker: `${parcelCount} terrenos · ${documentCount} documentos`,
      description:
        'Adicione, atualize ou elimine propriedades BUPi e gira os documentos associados a cada terreno.',
      actionKind: 'SECTION',
    },
    {
      id: 'favorites',
      title: 'Prestadores Favoritos',
      shortTitle: 'Favoritos',
      kicker: `${favoriteProviderCount} prestadores guardados`,
      description:
        'Acesso rápido às equipas florestais certificadas ICNF preferidas para pedidos de orçamento.',
      actionKind: 'SECTION',
    },
    {
      id: 'settings',
      title: 'Perfil & Configurações',
      shortTitle: 'Configurações',
      kicker: `Titular: ${displayName.split(' ')[0] || 'Utilizador'}`,
      description:
        'Dados fiscais para Autos SHA-256, limiares de alerta IPMA RCM, raio ANEPC e sincronização.',
      actionKind: 'SECTION',
    },
    {
      id: 'theme',
      title: 'Tema & Modo Escuro',
      shortTitle: 'Tema & Escuro',
      kicker: darkMode ? 'Modo Escuro ativo' : 'Modo Solar (Claro) ativo',
      description:
        'Alterne entre o Modo Escuro de descanso visual e o Modo Solar de alto contraste no terreno.',
      actionKind: 'SECTION',
    },
    {
      id: 'history',
      title: 'Histórico & Autos',
      shortTitle: 'Histórico',
      kicker: `${historyCount} registos · ${certificateCount} autos SHA-256`,
      description:
        'Consulte intervenções realizadas, cronologia de conformidade e comprovativos PDF emitidos.',
      actionKind: 'SECTION',
    },
    {
      id: 'docs',
      title: 'Documentação Técnica',
      shortTitle: 'Documentação',
      kicker: 'DL 82/2021 · EPSG:3763 · Servidor',
      description:
        'Arquitetura geoespacial, enquadramento legal SGIFR e guia de configuração Linux/Redis.',
      actionKind: 'SECTION',
    },
    {
      id: 'logout',
      title: 'Terminar Sessão',
      shortTitle: 'Logout',
      kicker: isCloudSession ? 'Sessão Google Cloud ativa' : 'Sessão local ativa',
      description:
        'Encerre em segurança a sessão atual neste dispositivo e regresse ao ecrã inicial.',
      actionKind: 'LOGOUT',
    },
  ];
}

/**
 * Computes the expected number of thumbnail columns in UserManagementView:
 * - Web mode (width >= 1280px) or Tablet horizontal mode (width >= 768px and landscape width > height): 3 per row
 * - Mobile mode (width < 768px) or Tablet vertical mode (768px <= width < 1280px and portrait height >= width): 2 per row
 */
export function resolveExpectedUserGalleryColumns(widthPx: number, heightPx: number): 2 | 3 {
  if (widthPx >= 1280) return 3;
  if (widthPx >= 768 && widthPx > heightPx) return 3;
  return 2;
}


