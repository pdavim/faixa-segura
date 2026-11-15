import type {
  LandClass,
  LatLon,
  MunicipalityInfo,
  ParcelDocumentCategory,
  ParcelDocumentRecord,
  ParcelRecord,
  UserAppSettings,
} from '../types/domain.ts';
import { INITIAL_PARCELS, INITIAL_PROVIDERS, MUNICIPALITIES } from '../data/seedCatalog.ts';
import { computeParcelFgc } from './spatialEngine.ts';

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
};

export const DEFAULT_FAVORITE_PROVIDER_IDS: string[] = INITIAL_PROVIDERS[0]
  ? [INITIAL_PROVIDERS[0].id]
  : [];

export interface ParcelMutationInput {
  label: string;
  dico: string;
  parish?: string;
  matrixArticle?: string;
  bupiRggId?: string;
  landClass: LandClass;
  avgSlopePct: number;
  hasEredesLine: boolean;
  hasProtectedOaks: boolean;
  vertices?: LatLon[];
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
  patch: Partial<ParcelMutationInput> & { recenterVerticesOnMunicipalityChange?: boolean },
  municipalities: MunicipalityInfo[] = MUNICIPALITIES
): ParcelRecord {
  const catalog = municipalities.length > 0 ? municipalities : MUNICIPALITIES;
  const targetDico = patch.dico ?? existing.dico;
  const muni = catalog.find((m) => m.dico === targetDico) ?? catalog[0];
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
  const nextHasOaks =
    patch.hasProtectedOaks !== undefined ? Boolean(patch.hasProtectedOaks) : existing.hasProtectedOaks;

  const nextSlope =
    patch.avgSlopePct !== undefined
      ? Math.max(0, Math.min(100, Number(Number(patch.avgSlopePct).toFixed(1)) || 0))
      : existing.avgSlopePct;

  const spatialNeedsRecompute =
    nextLandClass !== existing.landClass ||
    nextHasEredes !== existing.hasEredesLine ||
    nextVertices !== existing.vertices;

  const nextSpatial = spatialNeedsRecompute
    ? computeParcelFgc({
        vertices: nextVertices,
        landClass: nextLandClass,
        hasEredesLine: nextHasEredes,
        neighborDistanceOverrideM: existing.spatial.neighborMinDistanceM,
      })
    : existing.spatial;

  const nextLabel =
    patch.label !== undefined && patch.label.trim().length >= 2
      ? patch.label.trim().slice(0, 120)
      : existing.label;

  const nextParish =
    patch.parish !== undefined && patch.parish.trim().length > 0
      ? patch.parish.trim().slice(0, 80)
      : dicoChanged
        ? muni.name
        : existing.parish;

  const nextMatrix =
    patch.matrixArticle !== undefined && patch.matrixArticle.trim().length > 0
      ? patch.matrixArticle.trim().slice(0, 80)
      : existing.matrixArticle;

  const nextBupi =
    patch.bupiRggId !== undefined && patch.bupiRggId.trim().length > 0
      ? patch.bupiRggId.trim().slice(0, 40)
      : existing.bupiRggId;

  return {
    ...existing,
    label: nextLabel,
    parish: nextParish,
    municipality: muni.name,
    district: muni.district,
    dico: muni.dico,
    dicofre: dicoChanged ? muni.dicofreDefault : existing.dicofre,
    isPriorityParish: dicoChanged ? muni.isPriorityParishDefault : existing.isPriorityParish,
    matrixArticle: nextMatrix,
    bupiRggId: nextBupi,
    landClass: nextLandClass,
    avgSlopePct: nextSlope,
    hasEredesLine: nextHasEredes,
    eredesType: nextHasEredes
      ? existing.eredesType !== 'Sem linha aérea'
        ? existing.eredesType
        : 'MT 15kV (Faixa 7m)'
      : 'Sem linha aérea',
    hasProtectedOaks: nextHasOaks,
    protectedOakNotes: nextHasOaks
      ? 'Exemplares de Sobreiro/Azinheira assinalados — corte interdito sem autorização ICNF (DL 169/2001).'
      : 'Sem quercíneas protegidas assinaladas no polígono.',
    vertices: nextVertices,
    buildingCenter: nextSpatial.centroidWgs84,
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
  const proximityAlertRadiusKm: 10 | 15 | 25 =
    src.proximityAlertRadiusKm === 10 || src.proximityAlertRadiusKm === 25
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
