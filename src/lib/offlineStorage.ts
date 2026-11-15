import type {
  ParcelRecord,
  PirLevel,
  UserHistoryCategory,
  UserHistoryRecord,
} from '../types/domain.ts';

export const OFFLINE_LOCAL_UID = 'local-offline-owner';

export type OfflineSyncOpType =
  | 'SAVE_PARCEL'
  | 'CREATE_HISTORY'
  | 'ARCHIVE_HISTORY'
  | 'DELETE_HISTORY';

export type ItemSyncStatus = 'SYNCED' | 'PENDING';

export interface AnnotatedHistoryRecord extends UserHistoryRecord {
  syncStatus: ItemSyncStatus;
}

export interface OfflineSyncOperation {
  opId: string;
  type: OfflineSyncOpType;
  targetId: string;
  uid?: string;
  parcel?: ParcelRecord;
  historyEntry?: UserHistoryRecord;
  backendSynced?: boolean;
  createdAtMs: number;
  attempts: number;
  lastError?: string;
}

export interface OfflineStorageAdapter {
  loadParcels(): Promise<ParcelRecord[]>;
  saveParcel(parcel: ParcelRecord): Promise<void>;
  loadHistory(): Promise<UserHistoryRecord[]>;
  saveHistoryItem(item: UserHistoryRecord): Promise<void>;
  deleteHistoryItem(entryId: string): Promise<void>;
  loadOutbox(): Promise<OfflineSyncOperation[]>;
  saveOutbox(ops: OfflineSyncOperation[]): Promise<void>;
  getBackendType(): 'indexeddb' | 'localstorage' | 'memory';
}

export interface FirestoreSyncTransport {
  saveParcel: (uid: string, parcel: ParcelRecord) => Promise<void>;
  createHistory: (uid: string, entry: UserHistoryRecord) => Promise<void>;
  archiveHistory: (uid: string, entryId: string) => Promise<void>;
  deleteHistory: (uid: string, entryId: string) => Promise<void>;
  syncParcelToBackend?: (parcel: ParcelRecord) => Promise<void>;
}

export interface SyncFlushResult {
  syncedCount: number;
  remainingCount: number;
  offlineSkipped: boolean;
  awaitingAuthCount: number;
  lastSyncedAtIso?: string;
  errorMessage?: string;
}

const DB_NAME = 'faixasegura_offline_v1';
const DB_VERSION = 1;
const STORE_PARCELS = 'parcels';
const STORE_HISTORY = 'history';
const STORE_OUTBOX = 'outbox';

const LS_KEY_PARCELS = 'fs_offline_parcels_v1';
const LS_KEY_HISTORY = 'fs_offline_history_v1';
const LS_KEY_OUTBOX = 'fs_offline_outbox_v1';

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

export function sanitizeOfflineId(raw: string, prefix = 'item'): string {
  const cleaned = (raw ?? '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 128);
  if (cleaned.length >= 1 && SAFE_ID_RE.test(cleaned)) {
    return cleaned;
  }
  return `${prefix}-${Date.now()}`;
}

export function buildLocalHistoryEntry(params: {
  id?: string;
  uid?: string;
  category: UserHistoryCategory;
  title: string;
  parcelId: string;
  parcelLabel: string;
  municipality: string;
  referenceCode: string;
  areaM2: number;
  pirLevel: PirLevel;
  soilMoisturePct: number;
  summary: string;
  createdAtIso?: string;
}): UserHistoryRecord {
  const id = sanitizeOfflineId(
    params.id || `hist-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    'hist'
  );
  const uid = sanitizeOfflineId(params.uid || OFFLINE_LOCAL_UID, 'usr');
  const clamp = (val: string, min: number, max: number, fb: string) => {
    const t = (val ?? '').trim();
    return (t.length >= min ? t : fb).slice(0, max);
  };

  return {
    id,
    uid,
    category: params.category,
    title: clamp(params.title, 2, 140, 'Registo Operacional FaixaSegura'),
    parcelId: sanitizeOfflineId(params.parcelId, 'parcel'),
    parcelLabel: clamp(params.parcelLabel, 1, 120, 'Terreno Registado'),
    municipality: clamp(params.municipality, 2, 80, 'Sintra'),
    referenceCode: clamp(params.referenceCode, 1, 64, id.slice(0, 16).toUpperCase()),
    areaM2: Math.max(0, Math.min(100_000_000, Number(params.areaM2) || 0)),
    pirLevel: Math.max(1, Math.min(5, Math.round(Number(params.pirLevel) || 2))) as PirLevel,
    soilMoisturePct: Math.max(0, Math.min(100, Number(Number(params.soilMoisturePct || 22).toFixed(1)))),
    summary: clamp(params.summary, 2, 500, 'Registo guardado localmente no terreno.'),
    status: 'ACTIVE',
    createdAtIso: params.createdAtIso || new Date().toISOString(),
  };
}

/**
 * Pure outbox coalescer:
 * - Preserves CREATE_HISTORY (ACTIVE) -> ARCHIVE_HISTORY order so Firestore security rules
 *   (which require status == 'ACTIVE' on create and Action: ArchiveEntry on update) pass 100%.
 * - Cancels unsynced CREATE_HISTORY + ARCHIVE_HISTORY + DELETE_HISTORY altogether if deleted
 *   before ever reaching Firestore.
 * - Deduplicates repeated SAVE_PARCEL or ARCHIVE_HISTORY operations for the same targetId.
 */
export function coalesceOutboxOperations(ops: OfflineSyncOperation[]): OfflineSyncOperation[] {
  const sorted = [...ops].sort((a, b) => a.createdAtMs - b.createdAtMs);
  const result: OfflineSyncOperation[] = [];

  for (const op of sorted) {
    if (op.type === 'SAVE_PARCEL') {
      const existingIdx = result.findIndex(
        (r) => r.type === 'SAVE_PARCEL' && r.targetId === op.targetId
      );
      if (existingIdx !== -1) {
        result[existingIdx] = {
          ...result[existingIdx],
          ...op,
          createdAtMs: result[existingIdx].createdAtMs,
        };
      } else {
        result.push({ ...op });
      }
      continue;
    }

    if (op.type === 'CREATE_HISTORY') {
      const existingIdx = result.findIndex(
        (r) => r.type === 'CREATE_HISTORY' && r.targetId === op.targetId
      );
      if (existingIdx !== -1) {
        result[existingIdx] = { ...result[existingIdx], ...op };
      } else {
        result.push({ ...op });
      }
      continue;
    }

    if (op.type === 'ARCHIVE_HISTORY') {
      const alreadyQueuedArchive = result.some(
        (r) => r.type === 'ARCHIVE_HISTORY' && r.targetId === op.targetId
      );
      const alreadyQueuedDelete = result.some(
        (r) => r.type === 'DELETE_HISTORY' && r.targetId === op.targetId
      );
      if (!alreadyQueuedArchive && !alreadyQueuedDelete) {
        result.push({ ...op });
      }
      continue;
    }

    if (op.type === 'DELETE_HISTORY') {
      const unsyncedCreateIdx = result.findIndex(
        (r) => r.type === 'CREATE_HISTORY' && r.targetId === op.targetId
      );
      // Remove any pending archive for this entry regardless
      for (let i = result.length - 1; i >= 0; i--) {
        if (result[i].targetId === op.targetId && result[i].type === 'ARCHIVE_HISTORY') {
          result.splice(i, 1);
        }
      }
      if (unsyncedCreateIdx !== -1) {
        // Entry never reached Firestore -> drop CREATE_HISTORY and skip network DELETE
        const currentCreateIdx = result.findIndex(
          (r) => r.type === 'CREATE_HISTORY' && r.targetId === op.targetId
        );
        if (currentCreateIdx !== -1) {
          result.splice(currentCreateIdx, 1);
        }
      } else {
        const alreadyQueuedDelete = result.some(
          (r) => r.type === 'DELETE_HISTORY' && r.targetId === op.targetId
        );
        if (!alreadyQueuedDelete) {
          result.push({ ...op });
        }
      }
    }
  }

  return result;
}

export function mergeParcelsWithOffline(
  baseParcels: ParcelRecord[],
  offlineParcels: ParcelRecord[]
): ParcelRecord[] {
  const byId = new Map<string, ParcelRecord>();
  for (const p of offlineParcels) {
    byId.set(p.id, p);
  }
  const merged: ParcelRecord[] = [];
  const seen = new Set<string>();

  // Offline-created custom parcels first so newly created parcels appear at top of selector
  for (const p of offlineParcels) {
    if (!baseParcels.some((b) => b.id === p.id)) {
      merged.push(p);
      seen.add(p.id);
    }
  }

  for (const b of baseParcels) {
    if (seen.has(b.id)) continue;
    merged.push(byId.get(b.id) ?? b);
    seen.add(b.id);
  }

  return merged;
}

export function mergeHistoryWithOffline(params: {
  remoteItems: UserHistoryRecord[];
  localItems: UserHistoryRecord[];
  outbox: OfflineSyncOperation[];
  activeUid?: string | null;
}): AnnotatedHistoryRecord[] {
  const { remoteItems, localItems, outbox, activeUid } = params;
  const pendingIds = new Set(
    outbox
      .filter((op) => op.type !== 'SAVE_PARCEL')
      .map((op) => op.targetId)
  );
  const deletedPendingIds = new Set(
    outbox.filter((op) => op.type === 'DELETE_HISTORY').map((op) => op.targetId)
  );
  const archivedPendingIds = new Set(
    outbox.filter((op) => op.type === 'ARCHIVE_HISTORY').map((op) => op.targetId)
  );

  const mergedMap = new Map<string, AnnotatedHistoryRecord>();

  for (const r of remoteItems) {
    if (deletedPendingIds.has(r.id)) continue;
    mergedMap.set(r.id, {
      ...r,
      status: archivedPendingIds.has(r.id) ? 'ARCHIVED' : r.status,
      syncStatus: pendingIds.has(r.id) ? 'PENDING' : 'SYNCED',
    });
  }

  for (const l of localItems) {
    if (deletedPendingIds.has(l.id)) continue;
    const belongsToActiveSession =
      !activeUid || l.uid === activeUid || l.uid === OFFLINE_LOCAL_UID;
    if (!belongsToActiveSession) continue;

    if (!mergedMap.has(l.id)) {
      const isPending = pendingIds.has(l.id) || !activeUid || l.uid === OFFLINE_LOCAL_UID;
      mergedMap.set(l.id, {
        ...l,
        uid: activeUid || l.uid,
        status: archivedPendingIds.has(l.id) ? 'ARCHIVED' : l.status,
        syncStatus: isPending ? 'PENDING' : 'SYNCED',
      });
    }
  }

  return Array.from(mergedMap.values()).sort((a, b) =>
    b.createdAtIso.localeCompare(a.createdAtIso)
  );
}

export function isTransientConnectivityError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  return (
    msg.includes('offline') ||
    msg.includes('unavailable') ||
    msg.includes('network') ||
    msg.includes('failed to fetch') ||
    msg.includes('load failed') ||
    msg.includes('aborted') ||
    msg.includes('timeout')
  );
}

function readLocalStorageJson<T>(key: string, fallback: T): T {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeLocalStorageJson<T>(key: string, value: T): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota or private-mode restrictions
  }
}

/**
 * In-memory adapter used both for deterministic unit tests and as an ultimate fallback
 * if both IndexedDB and localStorage are restricted in a sandboxed iframe.
 */
export function createMemoryOfflineStorageAdapter(): OfflineStorageAdapter {
  const parcelsMap = new Map<string, ParcelRecord>();
  const historyMap = new Map<string, UserHistoryRecord>();
  let outboxList: OfflineSyncOperation[] = [];

  return {
    getBackendType: () => 'memory',
    async loadParcels() {
      return Array.from(parcelsMap.values());
    },
    async saveParcel(parcel) {
      parcelsMap.set(parcel.id, structuredClone(parcel));
    },
    async loadHistory() {
      return Array.from(historyMap.values());
    },
    async saveHistoryItem(item) {
      historyMap.set(item.id, structuredClone(item));
    },
    async deleteHistoryItem(entryId) {
      historyMap.delete(entryId);
    },
    async loadOutbox() {
      return structuredClone(outboxList);
    },
    async saveOutbox(ops) {
      outboxList = structuredClone(ops);
    },
  };
}

/**
 * Browser storage adapter using native IndexedDB ('faixasegura_offline_v1') as primary
 * high-capacity database with write-through localStorage fallback for restricted contexts.
 */
export function createBrowserOfflineStorageAdapter(): OfflineStorageAdapter {
  let dbPromise: Promise<IDBDatabase | null> | null = null;
  let activeBackend: 'indexeddb' | 'localstorage' | 'memory' =
    typeof indexedDB !== 'undefined'
      ? 'indexeddb'
      : typeof localStorage !== 'undefined'
        ? 'localstorage'
        : 'memory';

  const memFallback = createMemoryOfflineStorageAdapter();

  function getDb(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') {
      activeBackend = typeof localStorage !== 'undefined' ? 'localstorage' : 'memory';
      return Promise.resolve(null);
    }
    if (dbPromise) return dbPromise;

    dbPromise = new Promise<IDBDatabase | null>((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_PARCELS)) {
            db.createObjectStore(STORE_PARCELS, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(STORE_HISTORY)) {
            db.createObjectStore(STORE_HISTORY, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
            db.createObjectStore(STORE_OUTBOX, { keyPath: 'opId' });
          }
        };
        req.onsuccess = () => {
          activeBackend = 'indexeddb';
          resolve(req.result);
        };
        req.onerror = () => {
          activeBackend = typeof localStorage !== 'undefined' ? 'localstorage' : 'memory';
          resolve(null);
        };
      } catch {
        activeBackend = typeof localStorage !== 'undefined' ? 'localstorage' : 'memory';
        resolve(null);
      }
    });

    return dbPromise;
  }

  function idbGetAll<T>(db: IDBDatabase, storeName: string): Promise<T[] | null> {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.getAll();
        req.onsuccess = () => resolve((req.result as T[]) ?? []);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  function idbPut<T>(db: IDBDatabase, storeName: string, value: T): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(value);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  function idbDelete(db: IDBDatabase, storeName: string, key: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  function idbReplaceAll<T>(db: IDBDatabase, storeName: string, items: T[]): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        store.clear();
        for (const item of items) {
          store.put(item);
        }
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  return {
    getBackendType: () => activeBackend,

    async loadParcels() {
      const db = await getDb();
      if (db) {
        const rows = await idbGetAll<ParcelRecord>(db, STORE_PARCELS);
        if (rows && rows.length > 0) return rows;
      }
      const lsRows = readLocalStorageJson<ParcelRecord[]>(LS_KEY_PARCELS, []);
      if (lsRows.length > 0) return lsRows;
      return memFallback.loadParcels();
    },

    async saveParcel(parcel) {
      await memFallback.saveParcel(parcel);
      const existingLs = readLocalStorageJson<ParcelRecord[]>(LS_KEY_PARCELS, []);
      const nextLs = [parcel, ...existingLs.filter((p) => p.id !== parcel.id)];
      writeLocalStorageJson(LS_KEY_PARCELS, nextLs);

      const db = await getDb();
      if (db) {
        await idbPut(db, STORE_PARCELS, parcel);
      }
    },

    async loadHistory() {
      const db = await getDb();
      if (db) {
        const rows = await idbGetAll<UserHistoryRecord>(db, STORE_HISTORY);
        if (rows && rows.length > 0) return rows;
      }
      const lsRows = readLocalStorageJson<UserHistoryRecord[]>(LS_KEY_HISTORY, []);
      if (lsRows.length > 0) return lsRows;
      return memFallback.loadHistory();
    },

    async saveHistoryItem(item) {
      await memFallback.saveHistoryItem(item);
      const existingLs = readLocalStorageJson<UserHistoryRecord[]>(LS_KEY_HISTORY, []);
      const nextLs = [item, ...existingLs.filter((h) => h.id !== item.id)];
      writeLocalStorageJson(LS_KEY_HISTORY, nextLs);

      const db = await getDb();
      if (db) {
        await idbPut(db, STORE_HISTORY, item);
      }
    },

    async deleteHistoryItem(entryId) {
      await memFallback.deleteHistoryItem(entryId);
      const existingLs = readLocalStorageJson<UserHistoryRecord[]>(LS_KEY_HISTORY, []);
      writeLocalStorageJson(
        LS_KEY_HISTORY,
        existingLs.filter((h) => h.id !== entryId)
      );

      const db = await getDb();
      if (db) {
        await idbDelete(db, STORE_HISTORY, entryId);
      }
    },

    async loadOutbox() {
      const db = await getDb();
      if (db) {
        const rows = await idbGetAll<OfflineSyncOperation>(db, STORE_OUTBOX);
        if (rows) {
          if (rows.length > 0) {
            return rows.sort((a, b) => a.createdAtMs - b.createdAtMs);
          }
          const lsRows = readLocalStorageJson<OfflineSyncOperation[]>(LS_KEY_OUTBOX, []);
          return lsRows.sort((a, b) => a.createdAtMs - b.createdAtMs);
        }
      }
      const lsRows = readLocalStorageJson<OfflineSyncOperation[]>(LS_KEY_OUTBOX, []);
      if (lsRows.length > 0) return lsRows.sort((a, b) => a.createdAtMs - b.createdAtMs);
      return memFallback.loadOutbox();
    },

    async saveOutbox(ops) {
      const coalesced = coalesceOutboxOperations(ops);
      await memFallback.saveOutbox(coalesced);
      writeLocalStorageJson(LS_KEY_OUTBOX, coalesced);

      const db = await getDb();
      if (db) {
        await idbReplaceAll(db, STORE_OUTBOX, coalesced);
      }
    },
  };
}

/**
 * Stateful Offline Sync Coordinator decoupling storage + outbox queue + automatic
 * reconnection draining to Firestore.
 */
export class OfflineSyncCoordinator {
  private storage: OfflineStorageAdapter;
  private transport: FirestoreSyncTransport;
  private isOnlineCheck: () => boolean;
  private inFlightFlush: Promise<SyncFlushResult> | null = null;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(params: {
    storage: OfflineStorageAdapter;
    transport: FirestoreSyncTransport;
    isOnline?: () => boolean;
  }) {
    this.storage = params.storage;
    this.transport = params.transport;
    this.isOnlineCheck =
      params.isOnline ??
      (() => (typeof navigator !== 'undefined' ? navigator.onLine !== false : true));
  }

  getStorageBackend(): 'indexeddb' | 'localstorage' | 'memory' {
    return this.storage.getBackendType();
  }

  async hydrateState(): Promise<{
    parcels: ParcelRecord[];
    history: UserHistoryRecord[];
    outbox: OfflineSyncOperation[];
  }> {
    const [parcels, history, outbox] = await Promise.all([
      this.storage.loadParcels(),
      this.storage.loadHistory(),
      this.storage.loadOutbox(),
    ]);
    return { parcels, history, outbox };
  }

  private enqueueMutation<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn);
    this.mutationQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async recordParcel(parcel: ParcelRecord, uid?: string | null): Promise<{
    outbox: OfflineSyncOperation[];
    syncResult: SyncFlushResult;
  }> {
    await this.enqueueMutation(async () => {
      await this.storage.saveParcel(parcel);
      const currentOutbox = await this.storage.loadOutbox();
      const op: OfflineSyncOperation = {
        opId: `op-parcel-${parcel.id}`,
        type: 'SAVE_PARCEL',
        targetId: parcel.id,
        uid: uid || undefined,
        parcel,
        createdAtMs: Date.now(),
        attempts: 0,
      };
      const nextOutbox = coalesceOutboxOperations([...currentOutbox, op]);
      await this.storage.saveOutbox(nextOutbox);
    });

    const syncResult = await this.flushOutbox(uid);
    const updatedOutbox = await this.storage.loadOutbox();
    return { outbox: updatedOutbox, syncResult };
  }

  async recordHistoryCreation(
    entry: UserHistoryRecord,
    uid?: string | null
  ): Promise<{
    entry: UserHistoryRecord;
    outbox: OfflineSyncOperation[];
    syncResult: SyncFlushResult;
  }> {
    const normalized: UserHistoryRecord = {
      ...entry,
      uid: uid ? sanitizeOfflineId(uid, 'usr') : entry.uid,
    };

    await this.enqueueMutation(async () => {
      await this.storage.saveHistoryItem(normalized);
      const currentOutbox = await this.storage.loadOutbox();
      const op: OfflineSyncOperation = {
        opId: `op-hist-create-${normalized.id}`,
        type: 'CREATE_HISTORY',
        targetId: normalized.id,
        uid: uid || undefined,
        historyEntry: normalized,
        createdAtMs: Date.now(),
        attempts: 0,
      };
      const nextOutbox = coalesceOutboxOperations([...currentOutbox, op]);
      await this.storage.saveOutbox(nextOutbox);
    });

    const syncResult = await this.flushOutbox(uid);
    const updatedOutbox = await this.storage.loadOutbox();
    return { entry: normalized, outbox: updatedOutbox, syncResult };
  }

  async recordHistoryArchive(
    entryIdRaw: string,
    uid?: string | null
  ): Promise<{
    outbox: OfflineSyncOperation[];
    syncResult: SyncFlushResult;
  }> {
    const entryId = sanitizeOfflineId(entryIdRaw, 'hist');

    await this.enqueueMutation(async () => {
      const localHistory = await this.storage.loadHistory();
      const match = localHistory.find((h) => h.id === entryId);
      if (match) {
        await this.storage.saveHistoryItem({ ...match, status: 'ARCHIVED' });
      }

      const currentOutbox = await this.storage.loadOutbox();
      const op: OfflineSyncOperation = {
        opId: `op-hist-archive-${entryId}`,
        type: 'ARCHIVE_HISTORY',
        targetId: entryId,
        uid: uid || undefined,
        createdAtMs: Date.now(),
        attempts: 0,
      };
      const nextOutbox = coalesceOutboxOperations([...currentOutbox, op]);
      await this.storage.saveOutbox(nextOutbox);
    });

    const syncResult = await this.flushOutbox(uid);
    const updatedOutbox = await this.storage.loadOutbox();
    return { outbox: updatedOutbox, syncResult };
  }

  async recordHistoryDelete(
    entryIdRaw: string,
    uid?: string | null
  ): Promise<{
    outbox: OfflineSyncOperation[];
    syncResult: SyncFlushResult;
  }> {
    const entryId = sanitizeOfflineId(entryIdRaw, 'hist');

    await this.enqueueMutation(async () => {
      await this.storage.deleteHistoryItem(entryId);
      const currentOutbox = await this.storage.loadOutbox();
      const op: OfflineSyncOperation = {
        opId: `op-hist-delete-${entryId}`,
        type: 'DELETE_HISTORY',
        targetId: entryId,
        uid: uid || undefined,
        createdAtMs: Date.now(),
        attempts: 0,
      };
      const nextOutbox = coalesceOutboxOperations([...currentOutbox, op]);
      await this.storage.saveOutbox(nextOutbox);
    });

    const syncResult = await this.flushOutbox(uid);
    const updatedOutbox = await this.storage.loadOutbox();
    return { outbox: updatedOutbox, syncResult };
  }

  async cacheRemoteHistorySnapshot(items: UserHistoryRecord[]): Promise<void> {
    const outbox = await this.storage.loadOutbox();
    const pendingTargetIds = new Set(outbox.map((op) => op.targetId));

    for (const item of items) {
      if (pendingTargetIds.has(item.id)) continue;
      await this.storage.saveHistoryItem(item);
    }
  }

  async flushOutbox(activeUid?: string | null): Promise<SyncFlushResult> {
    const run = () => this.executeFlush(activeUid);
    const next = this.inFlightFlush ? this.inFlightFlush.then(run, run) : run();
    this.inFlightFlush = next;
    return next.finally(() => {
      if (this.inFlightFlush === next) {
        this.inFlightFlush = null;
      }
    });
  }

  private async executeFlush(activeUid?: string | null): Promise<SyncFlushResult> {
    let queue = coalesceOutboxOperations(await this.storage.loadOutbox());

    if (!this.isOnlineCheck()) {
      await this.storage.saveOutbox(queue);
      return {
        syncedCount: 0,
        remainingCount: queue.length,
        offlineSkipped: true,
        awaitingAuthCount: activeUid ? 0 : queue.length,
      };
    }

    let syncedCount = 0;
    let awaitingAuthCount = 0;
    let errorMessage: string | undefined;
    const remaining: OfflineSyncOperation[] = [];

    for (let i = 0; i < queue.length; i++) {
      const op = { ...queue[i] };
      const effectiveUid = activeUid || (op.uid && op.uid !== OFFLINE_LOCAL_UID ? op.uid : null);

      try {
        if (op.type === 'SAVE_PARCEL' && op.parcel) {
          if (!op.backendSynced && this.transport.syncParcelToBackend) {
            try {
              await this.transport.syncParcelToBackend(op.parcel);
              op.backendSynced = true;
            } catch {
              // Non-fatal if Express in-memory endpoint is unreachable while Firestore is up
            }
          }

          if (!effectiveUid) {
            awaitingAuthCount += 1;
            remaining.push(op);
            continue;
          }

          await this.transport.saveParcel(effectiveUid, op.parcel);
          syncedCount += 1;
          continue;
        }

        if (!effectiveUid) {
          awaitingAuthCount += 1;
          remaining.push(op);
          continue;
        }

        if (op.type === 'CREATE_HISTORY' && op.historyEntry) {
          const adoptedEntry: UserHistoryRecord = {
            ...op.historyEntry,
            uid: sanitizeOfflineId(effectiveUid, 'usr'),
          };
          await this.transport.createHistory(effectiveUid, adoptedEntry);
          await this.storage.saveHistoryItem(adoptedEntry);
          syncedCount += 1;
          continue;
        }

        if (op.type === 'ARCHIVE_HISTORY') {
          await this.transport.archiveHistory(effectiveUid, op.targetId);
          syncedCount += 1;
          continue;
        }

        if (op.type === 'DELETE_HISTORY') {
          await this.transport.deleteHistory(effectiveUid, op.targetId);
          syncedCount += 1;
          continue;
        }
      } catch (err) {
        const errText = err instanceof Error ? err.message : String(err);
        op.attempts += 1;
        op.lastError = errText.slice(0, 240);
        remaining.push(op);

        if (isTransientConnectivityError(err) || !this.isOnlineCheck()) {
          // Connection dropped mid-sync: preserve remaining FIFO order untouched
          for (let j = i + 1; j < queue.length; j++) {
            remaining.push(queue[j]);
          }
          break;
        }

        errorMessage = 'Alguns registos aguardam nova tentativa de sincronização.';
      }
    }

    await this.storage.saveOutbox(remaining);

    return {
      syncedCount,
      remainingCount: remaining.length,
      offlineSkipped: false,
      awaitingAuthCount,
      lastSyncedAtIso: syncedCount > 0 ? new Date().toISOString() : undefined,
      errorMessage,
    };
  }
}
