import type { LatLon, ParcelRecord } from '../types/domain.ts';
import { computeParcelLeafletBounds, type ParcelLeafletBounds } from './spatialEngine.ts';

export type MapTileStyle = 'ORTHOPHOTO' | 'VECTOR';

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

export interface EnumeratedMapTile extends TileCoord {
  style: MapTileStyle;
  key: string;
  url: string;
}

export interface CachedTileRecord extends TileCoord {
  key: string;
  style: MapTileStyle;
  url: string;
  parcelId: string | null;
  data: ArrayBuffer;
  mimeType: string;
  byteSize: number;
  cachedAtMs: number;
  lastAccessedMs: number;
}

export interface OfflineParcelMapSnapshot {
  parcelId: string;
  parcelLabel: string;
  municipality: string;
  bupiRggId: string;
  bounds: ParcelLeafletBounds;
  zoomLevels: number[];
  styles: MapTileStyle[];
  tileKeys: string[];
  tileCount: number;
  totalBytes: number;
  createdAtIso: string;
}

export interface SnapshotDownloadProgress {
  parcelId: string;
  completedTiles: number;
  totalTiles: number;
  cachedHits: number;
  networkFetched: number;
  failedTiles: number;
  bytesStored: number;
}

export interface OfflineTileCacheStats {
  tileCount: number;
  totalBytes: number;
  snapshotCount: number;
}

export type TileServeSource = 'CACHE' | 'NETWORK' | 'FALLBACK_SVG';

export interface TileLookupResult {
  data: ArrayBuffer;
  mimeType: string;
  source: 'CACHE' | 'NETWORK';
}

export interface OfflineTileStorageAdapter {
  getTile(key: string): Promise<CachedTileRecord | null>;
  putTile(record: CachedTileRecord): Promise<void>;
  deleteTile(key: string): Promise<void>;
  listTileMetadata(): Promise<
    Array<{ key: string; parcelId: string | null; byteSize: number; lastAccessedMs: number }>
  >;
  clearTiles(): Promise<void>;
  getSnapshots(): Promise<OfflineParcelMapSnapshot[]>;
  putSnapshot(snapshot: OfflineParcelMapSnapshot): Promise<void>;
  deleteSnapshot(parcelId: string): Promise<void>;
  clearSnapshots(): Promise<void>;
}

export const TILE_CACHE_DB_NAME = 'faixasegura_tile_cache_v2';
export const TILE_CACHE_SW_NAME = 'faixasegura-map-tiles-v2';
const LEGACY_V1_TILE_DB_NAME = 'faixasegura_tile_cache_v1';
const LEGACY_V1_TILE_SW_NAME = 'faixasegura-map-tiles-v1';
export const DEFAULT_SNAPSHOT_ZOOMS = [15, 16, 17, 18, 19] as const;
export const DEFAULT_MAX_CACHED_TILES = 850;

const MAX_MERCATOR_LAT = 85.05112878;
const SNAPSHOTS_LS_FALLBACK_KEY = 'faixasegura_tile_snapshots_v2';
let legacyV1PurgeScheduled = false;

/**
 * Projects a WGS84 coordinate (lat, lon) to Slippy Map Web Mercator XYZ tile indices.
 */
export function latLonToTileXY(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const z = Math.max(0, Math.min(22, Math.floor(zoom)));
  const n = Math.pow(2, z);
  const clampedLat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  const normalizedLon = ((((lon + 180) % 360) + 360) % 360) - 180;

  const rawX = Math.floor(((normalizedLon + 180) / 360) * n);
  const latRad = (clampedLat * Math.PI) / 180;
  const mercatorY =
    (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
  const rawY = Math.floor(mercatorY * n);

  return {
    x: Math.max(0, Math.min(n - 1, rawX)),
    y: Math.max(0, Math.min(n - 1, rawY)),
  };
}

export function buildTileCacheKey(
  style: MapTileStyle,
  z: number,
  x: number,
  y: number
): string {
  return `${style}:${z}:${x}:${y}`;
}

function readMapEnvVar(
  name: string,
  envOverride?: Record<string, string | undefined>
): string {
  if (envOverride && name in envOverride) {
    return (envOverride[name] ?? '').trim();
  }
  const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  if (viteEnv && typeof viteEnv[name] === 'string') {
    return viteEnv[name]!.trim();
  }
  if (typeof process !== 'undefined' && process.env && typeof process.env[name] === 'string') {
    return process.env[name]!.trim();
  }
  return '';
}

/**
 * Resolves the Leaflet `{z}/{x}/{y}` (or `{z}/{y}/{x}`) tile template URL.
 * - `ORTHOPHOTO`: defaults to Esri `World_Imagery` (or `VITE_MAP_ORTHO_TILE_URL`).
 * - `VECTOR`: defaults to watermark-free Esri `World_Topo_Map` / OSM (no API key needed on cloud domains).
 *   If `VITE_MAP_VECTOR_TILE_URL` is set, uses that template; if `VITE_CARTO_API_KEY` is set, uses CARTO Positron with `?key=...`.
 */
export function resolveTileTemplateUrl(
  style: MapTileStyle,
  envOverride?: Record<string, string | undefined>
): string {
  if (style === 'ORTHOPHOTO') {
    const customOrtho = readMapEnvVar('VITE_MAP_ORTHO_TILE_URL', envOverride);
    return (
      customOrtho ||
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
    );
  }

  const customVector = readMapEnvVar('VITE_MAP_VECTOR_TILE_URL', envOverride);
  if (customVector) {
    return customVector;
  }

  const cartoKey = readMapEnvVar('VITE_CARTO_API_KEY', envOverride);
  if (cartoKey) {
    return `https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png?key=${encodeURIComponent(cartoKey)}`;
  }

  return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}';
}

/**
 * Builds deterministic CORS-enabled tile URLs for both Orthophoto and Topographic/Vector basemaps.
 */
export function buildTileUrl(
  style: MapTileStyle,
  z: number,
  x: number,
  y: number,
  envOverride?: Record<string, string | undefined>
): string {
  return resolveTileTemplateUrl(style, envOverride)
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

export interface EnumerateSnapshotOptions {
  zoomLevels?: readonly number[];
  styles?: readonly MapTileStyle[];
  marginTiles?: number;
  maxTiles?: number;
}

/**
 * Enumerates all XYZ tiles covering a parcel's bounding box (plus viewport margin)
 * across target field zoom levels and map styles, capped at maxTiles.
 */
export function enumerateParcelSnapshotTiles(
  bounds: { southWest: LatLon; northEast: LatLon },
  options?: EnumerateSnapshotOptions
): EnumeratedMapTile[] {
  const zoomLevels = options?.zoomLevels ?? DEFAULT_SNAPSHOT_ZOOMS;
  const styles: readonly MapTileStyle[] = options?.styles ?? ['ORTHOPHOTO', 'VECTOR'];
  const maxTiles = options?.maxTiles ?? 280;

  const results: EnumeratedMapTile[] = [];
  const seenKeys = new Set<string>();

  for (const rawZ of zoomLevels) {
    const z = Math.max(6, Math.min(19, Math.floor(rawZ)));
    const maxIndex = Math.pow(2, z) - 1;
    // Adaptive viewport margin so fitBounds padding around parcel is fully covered
    const margin =
      options?.marginTiles !== undefined ? Math.max(0, options.marginTiles) : z <= 16 ? 1 : 2;

    // North-West has minimum Y, South-East has maximum Y in Slippy Map coordinates
    const nw = latLonToTileXY(bounds.northEast.lat, bounds.southWest.lon, z);
    const se = latLonToTileXY(bounds.southWest.lat, bounds.northEast.lon, z);

    const minX = Math.max(0, Math.min(nw.x, se.x) - margin);
    const maxX = Math.min(maxIndex, Math.max(nw.x, se.x) + margin);
    const minY = Math.max(0, Math.min(nw.y, se.y) - margin);
    const maxY = Math.min(maxIndex, Math.max(nw.y, se.y) + margin);

    for (const style of styles) {
      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          if (results.length >= maxTiles) {
            return results;
          }
          const key = buildTileCacheKey(style, z, x, y);
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            results.push({
              style,
              z,
              x,
              y,
              key,
              url: buildTileUrl(style, z, x, y),
            });
          }
        }
      }
    }
  }

  return results;
}

/**
 * Generates a crisp 256x256 cartographic coordinate grid fallback SVG data URL
 * when offline and viewing peripheral areas outside pre-downloaded parcel snapshots.
 */
export function buildOfflineFallbackTileSvgDataUrl(
  style: MapTileStyle,
  z: number,
  x: number,
  y: number
): string {
  const isOrtho = style === 'ORTHOPHOTO';
  const bg = isOrtho ? '#16241c' : '#f1f5f9';
  const gridStroke = isOrtho ? '#243b2e' : '#cbd5e1';
  const subStroke = isOrtho ? '#1d3025' : '#e2e8f0';
  const labelColor = isOrtho ? '#648773' : '#64748b';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect width="256" height="256" fill="${bg}"/>
  <path d="M64 0V256M128 0V256M192 0V256M0 64H256M0 128H256M0 192H256" stroke="${subStroke}" stroke-width="1"/>
  <rect x="0.5" y="0.5" width="255" height="255" fill="none" stroke="${gridStroke}" stroke-width="1"/>
  <text x="14" y="24" fill="${labelColor}" font-family="monospace" font-size="10">Offline · Z${z} (${x},${y})</text>
</svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function formatByteSizePt(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

/**
 * Deterministic in-memory storage adapter for unit tests and restricted contexts.
 */
export function createMemoryTileStorageAdapter(): OfflineTileStorageAdapter {
  const tiles = new Map<string, CachedTileRecord>();
  const snapshots = new Map<string, OfflineParcelMapSnapshot>();

  return {
    async getTile(key: string) {
      const found = tiles.get(key);
      if (!found) return null;
      return { ...found, data: found.data.slice(0) };
    },
    async putTile(record: CachedTileRecord) {
      tiles.set(record.key, { ...record, data: record.data.slice(0) });
    },
    async deleteTile(key: string) {
      tiles.delete(key);
    },
    async listTileMetadata() {
      return Array.from(tiles.values()).map((t) => ({
        key: t.key,
        parcelId: t.parcelId,
        byteSize: t.byteSize,
        lastAccessedMs: t.lastAccessedMs,
      }));
    },
    async clearTiles() {
      tiles.clear();
    },
    async getSnapshots() {
      return Array.from(snapshots.values()).sort((a, b) =>
        b.createdAtIso.localeCompare(a.createdAtIso)
      );
    },
    async putSnapshot(snapshot: OfflineParcelMapSnapshot) {
      snapshots.set(snapshot.parcelId, {
        ...snapshot,
        tileKeys: [...snapshot.tileKeys],
        zoomLevels: [...snapshot.zoomLevels],
        styles: [...snapshot.styles],
      });
    },
    async deleteSnapshot(parcelId: string) {
      snapshots.delete(parcelId);
    },
    async clearSnapshots() {
      snapshots.clear();
    },
  };
}

function schedulePurgeLegacyV1WatermarkedCache(): void {
  if (legacyV1PurgeScheduled) return;
  legacyV1PurgeScheduled = true;
  try {
    if (typeof indexedDB !== 'undefined') {
      indexedDB.deleteDatabase(LEGACY_V1_TILE_DB_NAME);
    }
  } catch {
    // Ignore IndexedDB cleanup restrictions
  }
  try {
    if (typeof caches !== 'undefined') {
      void caches.delete(LEGACY_V1_TILE_SW_NAME).catch(() => {});
    }
  } catch {
    // Ignore CacheStorage cleanup restrictions
  }
}

function openTileIndexedDb(): Promise<IDBDatabase> {
  schedulePurgeLegacyV1WatermarkedCache();
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(TILE_CACHE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tiles')) {
        db.createObjectStore('tiles', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('snapshots')) {
        db.createObjectStore('snapshots', { keyPath: 'parcelId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open tile IndexedDB'));
  });
}

/**
 * Browser IndexedDB tile storage adapter with automatic fallback to memory + localStorage metadata.
 */
export function createBrowserTileStorageAdapter(): OfflineTileStorageAdapter {
  const memFallback = createMemoryTileStorageAdapter();
  let dbPromise: Promise<IDBDatabase> | null = null;

  const getDb = (): Promise<IDBDatabase> => {
    if (!dbPromise) {
      dbPromise = openTileIndexedDb().catch((err) => {
        dbPromise = null;
        throw err;
      });
    }
    return dbPromise;
  };

  const syncSnapshotLsFallback = (list: OfflineParcelMapSnapshot[]) => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(SNAPSHOTS_LS_FALLBACK_KEY, JSON.stringify(list));
      }
    } catch {
      // Ignore storage quota errors
    }
  };

  return {
    async getTile(key: string) {
      try {
        const db = await getDb();
        return await new Promise<CachedTileRecord | null>((resolve, reject) => {
          const tx = db.transaction('tiles', 'readonly');
          const req = tx.objectStore('tiles').get(key);
          req.onsuccess = () => resolve((req.result as CachedTileRecord | undefined) ?? null);
          req.onerror = () => reject(req.error);
        });
      } catch {
        return memFallback.getTile(key);
      }
    },

    async putTile(record: CachedTileRecord) {
      try {
        const db = await getDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('tiles', 'readwrite');
          tx.objectStore('tiles').put(record);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch {
        await memFallback.putTile(record);
      }
    },

    async deleteTile(key: string) {
      try {
        const db = await getDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('tiles', 'readwrite');
          tx.objectStore('tiles').delete(key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch {
        await memFallback.deleteTile(key);
      }
    },

    async listTileMetadata() {
      try {
        const db = await getDb();
        return await new Promise<
          Array<{ key: string; parcelId: string | null; byteSize: number; lastAccessedMs: number }>
        >((resolve, reject) => {
          const out: Array<{
            key: string;
            parcelId: string | null;
            byteSize: number;
            lastAccessedMs: number;
          }> = [];
          const tx = db.transaction('tiles', 'readonly');
          const cursorReq = tx.objectStore('tiles').openCursor();
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor) {
              const val = cursor.value as CachedTileRecord;
              out.push({
                key: val.key,
                parcelId: val.parcelId ?? null,
                byteSize: val.byteSize ?? 0,
                lastAccessedMs: val.lastAccessedMs ?? 0,
              });
              cursor.continue();
            } else {
              resolve(out);
            }
          };
          cursorReq.onerror = () => reject(cursorReq.error);
        });
      } catch {
        return memFallback.listTileMetadata();
      }
    },

    async clearTiles() {
      try {
        const db = await getDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('tiles', 'readwrite');
          tx.objectStore('tiles').clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch {
        await memFallback.clearTiles();
      }
    },

    async getSnapshots() {
      try {
        const db = await getDb();
        const rows = await new Promise<OfflineParcelMapSnapshot[]>((resolve, reject) => {
          const tx = db.transaction('snapshots', 'readonly');
          const req = tx.objectStore('snapshots').getAll();
          req.onsuccess = () => resolve((req.result as OfflineParcelMapSnapshot[]) ?? []);
          req.onerror = () => reject(req.error);
        });
        return rows.sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));
      } catch {
        try {
          if (typeof localStorage !== 'undefined') {
            const raw = localStorage.getItem(SNAPSHOTS_LS_FALLBACK_KEY);
            if (raw) {
              return JSON.parse(raw) as OfflineParcelMapSnapshot[];
            }
          }
        } catch {
          // Fall through
        }
        return memFallback.getSnapshots();
      }
    },

    async putSnapshot(snapshot: OfflineParcelMapSnapshot) {
      try {
        const db = await getDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('snapshots', 'readwrite');
          tx.objectStore('snapshots').put(snapshot);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        const all = await this.getSnapshots();
        syncSnapshotLsFallback(all);
      } catch {
        await memFallback.putSnapshot(snapshot);
        syncSnapshotLsFallback(await memFallback.getSnapshots());
      }
    },

    async deleteSnapshot(parcelId: string) {
      try {
        const db = await getDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('snapshots', 'readwrite');
          tx.objectStore('snapshots').delete(parcelId);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        const all = await this.getSnapshots();
        syncSnapshotLsFallback(all);
      } catch {
        await memFallback.deleteSnapshot(parcelId);
        syncSnapshotLsFallback(await memFallback.getSnapshots());
      }
    },

    async clearSnapshots() {
      try {
        const db = await getDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('snapshots', 'readwrite');
          tx.objectStore('snapshots').clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch {
        await memFallback.clearSnapshots();
      }
      syncSnapshotLsFallback([]);
    },
  };
}

export interface OfflineTileCacheManagerOptions {
  storage?: OfflineTileStorageAdapter;
  isOnline?: () => boolean;
  fetchFn?: (url: string) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer>; mimeType: string; ok: boolean }>;
  maxCachedTiles?: number;
  nowMs?: () => number;
}

async function defaultBrowserTileFetch(url: string): Promise<{
  arrayBuffer: () => Promise<ArrayBuffer>;
  mimeType: string;
  ok: boolean;
}> {
  const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
  const contentType = response.headers.get('content-type') || 'image/jpeg';

  // Mirror into Browser CacheStorage so Service Worker / PWA CacheFirst shares the same binary
  if (response.ok && typeof caches !== 'undefined') {
    try {
      const swCache = await caches.open(TILE_CACHE_SW_NAME);
      await swCache.put(url, response.clone());
    } catch {
      // Ignore CacheStorage quota or security restrictions
    }
  }

  return {
    ok: response.ok,
    mimeType: contentType.split(';')[0].trim(),
    arrayBuffer: () => response.arrayBuffer(),
  };
}

/**
 * Coordinates CacheFirst tile lookups, opportunistic browsing cache, bounded LRU eviction,
 * and multi-zoom offline parcel snapshot pre-downloading.
 */
export class OfflineTileCacheManager {
  private readonly storage: OfflineTileStorageAdapter;
  private readonly isOnline: () => boolean;
  private readonly fetchFn: NonNullable<OfflineTileCacheManagerOptions['fetchFn']>;
  private readonly maxCachedTiles: number;
  private readonly nowMs: () => number;
  private readonly hotMemoryCache = new Map<string, { data: ArrayBuffer; mimeType: string }>();
  private readonly inFlightFetches = new Map<string, Promise<TileLookupResult | null>>();

  constructor(options?: OfflineTileCacheManagerOptions) {
    this.storage = options?.storage ?? createBrowserTileStorageAdapter();
    this.isOnline =
      options?.isOnline ??
      (() => (typeof navigator !== 'undefined' ? navigator.onLine !== false : true));
    this.fetchFn = options?.fetchFn ?? defaultBrowserTileFetch;
    this.maxCachedTiles = options?.maxCachedTiles ?? DEFAULT_MAX_CACHED_TILES;
    this.nowMs = options?.nowMs ?? (() => Date.now());
  }

  private rememberHot(key: string, data: ArrayBuffer, mimeType: string): void {
    if (this.hotMemoryCache.has(key)) {
      this.hotMemoryCache.delete(key);
    }
    this.hotMemoryCache.set(key, { data, mimeType });
    if (this.hotMemoryCache.size > 240) {
      const oldestKey = this.hotMemoryCache.keys().next().value;
      if (oldestKey) {
        this.hotMemoryCache.delete(oldestKey);
      }
    }
  }

  async getCachedTile(
    style: MapTileStyle,
    z: number,
    x: number,
    y: number
  ): Promise<TileLookupResult | null> {
    const key = buildTileCacheKey(style, z, x, y);
    const expectedUrl = buildTileUrl(style, z, x, y);
    const hot = this.hotMemoryCache.get(key);
    if (hot && hot.data.byteLength > 0) {
      return { data: hot.data, mimeType: hot.mimeType, source: 'CACHE' };
    }

    const stored = await this.storage.getTile(key);
    if (stored && stored.data.byteLength > 0) {
      // Evict stale tiles if provider URL changed (e.g. legacy CARTO tile without key)
      if (stored.url && stored.url !== expectedUrl) {
        await this.storage.deleteTile(key);
      } else {
        this.rememberHot(key, stored.data, stored.mimeType);
        return { data: stored.data, mimeType: stored.mimeType, source: 'CACHE' };
      }
    }

    // Secondary check in Browser CacheStorage if populated by Workbox Service Worker
    if (typeof caches !== 'undefined') {
      try {
        const swCache = await caches.open(TILE_CACHE_SW_NAME);
        const matched = await swCache.match(expectedUrl);
        if (matched && matched.ok) {
          const buf = await matched.arrayBuffer();
          if (buf.byteLength > 0) {
            const mimeType =
              (matched.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
            this.rememberHot(key, buf, mimeType);
            return { data: buf, mimeType, source: 'CACHE' };
          }
        }
      } catch {
        // Ignore CacheStorage lookup errors
      }
    }

    return null;
  }

  async getOrFetchTile(params: {
    style: MapTileStyle;
    z: number;
    x: number;
    y: number;
    parcelId?: string | null;
    skipEviction?: boolean;
  }): Promise<TileLookupResult | null> {
    const { style, z, x, y, parcelId = null, skipEviction = false } = params;
    const cached = await this.getCachedTile(style, z, x, y);
    if (cached) {
      return cached;
    }

    if (!this.isOnline()) {
      return null;
    }

    const key = buildTileCacheKey(style, z, x, y);
    const existingFlight = this.inFlightFetches.get(key);
    if (existingFlight) {
      return existingFlight;
    }

    const url = buildTileUrl(style, z, x, y);
    const fetchPromise = (async (): Promise<TileLookupResult | null> => {
      try {
        const res = await this.fetchFn(url);
        if (!res.ok) return null;
        const buffer = await res.arrayBuffer();
        if (buffer.byteLength === 0) return null;

        const timestamp = this.nowMs();
        const record: CachedTileRecord = {
          key,
          style,
          z,
          x,
          y,
          url,
          parcelId,
          data: buffer,
          mimeType: res.mimeType || (style === 'ORTHOPHOTO' ? 'image/jpeg' : 'image/png'),
          byteSize: buffer.byteLength,
          cachedAtMs: timestamp,
          lastAccessedMs: timestamp,
        };
        this.rememberHot(key, record.data, record.mimeType);
        await this.storage.putTile(record);
        if (!skipEviction) {
          await this.enforceMaxTilesLimit();
        }

        return {
          data: record.data,
          mimeType: record.mimeType,
          source: 'NETWORK',
        };
      } catch {
        return null;
      } finally {
        this.inFlightFetches.delete(key);
      }
    })();

    this.inFlightFetches.set(key, fetchPromise);
    return fetchPromise;
  }

  private async enforceMaxTilesLimit(): Promise<void> {
    const allMeta = await this.storage.listTileMetadata();
    if (allMeta.length <= this.maxCachedTiles) return;

    const snapshots = await this.storage.getSnapshots();
    const pinnedKeys = new Set<string>();
    for (const snap of snapshots) {
      for (const k of snap.tileKeys) {
        pinnedKeys.add(k);
      }
    }

    // Prefer evicting non-snapshot opportunistic tiles oldest-first, then oldest overall
    const sorted = [...allMeta].sort((a, b) => {
      const aPinned = pinnedKeys.has(a.key) ? 1 : 0;
      const bPinned = pinnedKeys.has(b.key) ? 1 : 0;
      if (aPinned !== bPinned) return aPinned - bPinned;
      return a.lastAccessedMs - b.lastAccessedMs;
    });

    const excess = allMeta.length - this.maxCachedTiles;
    for (let i = 0; i < excess; i++) {
      const victim = sorted[i];
      this.hotMemoryCache.delete(victim.key);
      await this.storage.deleteTile(victim.key);
    }
  }

  /**
   * Pre-downloads both Orthophoto and Vector tile pyramids around a parcel's bounds
   * so field teams can inspect, toggle basemaps, zoom, and center with zero internet.
   */
  async downloadParcelSnapshot(
    parcel: ParcelRecord,
    onProgress?: (progress: SnapshotDownloadProgress) => void,
    options?: EnumerateSnapshotOptions & { concurrency?: number }
  ): Promise<OfflineParcelMapSnapshot> {
    if (!this.isOnline()) {
      throw new Error('Sem ligação à internet para descarregar novos mosaicos.');
    }

    const bounds = computeParcelLeafletBounds(parcel);
    const zoomLevels = [...(options?.zoomLevels ?? DEFAULT_SNAPSHOT_ZOOMS)];
    const styles: MapTileStyle[] = [...(options?.styles ?? ['ORTHOPHOTO', 'VECTOR'])];
    const tilesToEnsure = enumerateParcelSnapshotTiles(bounds, {
      zoomLevels,
      styles,
      marginTiles: options?.marginTiles,
      maxTiles: options?.maxTiles ?? 280,
    });

    const progress: SnapshotDownloadProgress = {
      parcelId: parcel.id,
      completedTiles: 0,
      totalTiles: tilesToEnsure.length,
      cachedHits: 0,
      networkFetched: 0,
      failedTiles: 0,
      bytesStored: 0,
    };
    onProgress?.({ ...progress });

    const storedTileKeys: string[] = [];
    const concurrency = Math.max(1, Math.min(12, options?.concurrency ?? 8));
    let cursor = 0;

    const worker = async () => {
      while (cursor < tilesToEnsure.length) {
        const index = cursor++;
        const tile = tilesToEnsure[index];
        const res = await this.getOrFetchTile({
          style: tile.style,
          z: tile.z,
          x: tile.x,
          y: tile.y,
          parcelId: parcel.id,
          skipEviction: true,
        });

        progress.completedTiles += 1;
        if (res) {
          storedTileKeys.push(tile.key);
          progress.bytesStored += res.data.byteLength;
          if (res.source === 'CACHE') {
            progress.cachedHits += 1;
          } else {
            progress.networkFetched += 1;
          }
        } else {
          progress.failedTiles += 1;
        }
        onProgress?.({ ...progress });
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, Math.max(1, tilesToEnsure.length)) },
      () => worker()
    );
    await Promise.all(workers);

    if (storedTileKeys.length === 0 && tilesToEnsure.length > 0) {
      throw new Error('Não foi possível guardar mosaicos cartográficos neste momento.');
    }

    const snapshot: OfflineParcelMapSnapshot = {
      parcelId: parcel.id,
      parcelLabel: parcel.label,
      municipality: parcel.municipality,
      bupiRggId: parcel.bupiRggId,
      bounds,
      zoomLevels,
      styles,
      tileKeys: storedTileKeys,
      tileCount: storedTileKeys.length,
      totalBytes: progress.bytesStored,
      createdAtIso: new Date(this.nowMs()).toISOString(),
    };

    await this.storage.putSnapshot(snapshot);
    await this.enforceMaxTilesLimit();
    return snapshot;
  }

  async listSnapshots(): Promise<OfflineParcelMapSnapshot[]> {
    return this.storage.getSnapshots();
  }

  async deleteParcelSnapshot(parcelId: string): Promise<void> {
    const snapshots = await this.storage.getSnapshots();
    const target = snapshots.find((s) => s.parcelId === parcelId);
    const otherSnapshots = snapshots.filter((s) => s.parcelId !== parcelId);

    const sharedKeys = new Set<string>();
    for (const other of otherSnapshots) {
      for (const k of other.tileKeys) {
        sharedKeys.add(k);
      }
    }

    if (target) {
      for (const key of target.tileKeys) {
        if (!sharedKeys.has(key)) {
          this.hotMemoryCache.delete(key);
          await this.storage.deleteTile(key);
        }
      }
    }
    await this.storage.deleteSnapshot(parcelId);
  }

  async clearAll(): Promise<void> {
    this.hotMemoryCache.clear();
    await this.storage.clearTiles();
    await this.storage.clearSnapshots();
    if (typeof caches !== 'undefined') {
      try {
        await caches.delete(TILE_CACHE_SW_NAME);
      } catch {
        // Ignore CacheStorage errors
      }
    }
  }

  async getStats(): Promise<OfflineTileCacheStats> {
    const [meta, snapshots] = await Promise.all([
      this.storage.listTileMetadata(),
      this.storage.getSnapshots(),
    ]);
    const totalBytes = meta.reduce((acc, item) => acc + (item.byteSize || 0), 0);
    return {
      tileCount: meta.length,
      totalBytes,
      snapshotCount: snapshots.length,
    };
  }
}

let sharedBrowserTileCacheManager: OfflineTileCacheManager | null = null;

export function getSharedOfflineTileCacheManager(): OfflineTileCacheManager {
  if (!sharedBrowserTileCacheManager) {
    sharedBrowserTileCacheManager = new OfflineTileCacheManager();
  }
  return sharedBrowserTileCacheManager;
}
