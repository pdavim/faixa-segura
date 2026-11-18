import express from 'express';
import { createServer as createHttpServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  ActiveFireIncident,
  AnepcNationalSummary,
  ComplianceCertificate,
  DailyPirForecast,
  ForestryProvider,
  LandClass,
  LatLon,
  NeighborComplaintRecord,
  ParcelOrthophotoCvAnalysis,
  ParcelRecord,
  ParcelVectorContext,
  PirLevel,
  QuoteLead,
  RealtimeHazardFeedMeta,
  RealtimeHazardsSnapshotPayload,
  SatelliteObservation,
  StormAlertIncident,
} from './src/types/domain.ts';
import {
  FALLBACK_ACTIVE_FIRES,
  FALLBACK_ACTIVE_STORMS,
  INITIAL_CERTIFICATES,
  INITIAL_PARCELS,
  INITIAL_PROVIDERS,
  INITIAL_QUOTES,
  MUNICIPALITIES,
} from './src/data/seedCatalog.ts';
import { getParishesByMunicipality } from './src/data/portugalAdminCatalog.ts';
import {
  buildMunicipalGtfGeoJson,
  buildMunicipalGtfKml,
  computeParcelFgc,
  haversineDistanceKm,
  wgs84ToPtTm06,
} from './src/lib/spatialEngine.ts';
import {
  answerLegalFieldQuestion,
  buildCanonicalCertificatePayload,
  computeSha256Hex,
  evaluateOperationalSemaphore,
} from './src/lib/pirRules.ts';
import {
  DEFAULT_IPMA_AREA_LOCATIONS,
  classifyAnepcIncidents,
  consumeSseBuffer,
  hydrateIpmaAreaLocations,
  mergeSecondaryApiAbertaFires,
  parseAnepcCountsPayload,
  parseIpmaWarningsPayload,
  type IpmaAreaLocation,
} from './src/lib/officialAlertsIngestor.ts';
import {
  buildOverpassParcelContextQuery,
  computePaddedBoundingBoxWgs84,
  finalizeParcelVectorContext,
  parseOverpassVectorContext,
  synthesizeDeterministicCadastreContext,
} from './src/lib/vectorContextIngestor.ts';
import {
  buildOrthophotoInferenceSpec,
  computeParcelCvRasterGrid,
  fuseCvDetectionsIntoVectorContext,
} from './src/lib/orthophotoCvPipeline.ts';
import {
  executeRemoteOrthophotoInference,
  probeOrthophotoServiceHealth,
  resolveConfiguredOrthophotoServiceUrl,
  resolveOrthophotoServiceEndpoints,
  type PixelCropRect,
} from './src/lib/orthophotoInferenceService.ts';
import {
  buildCopernicusOpenCatalogUrl,
  buildCopernicusStatsRequestBody,
  buildDgtCadastreOgcUrl,
  buildEredesOpenDataUrl,
  buildParcelElevationSampleGrid,
  computeTerrainSlopeFromElevations,
  mergeEredesEasementsIntoVectorContext,
  parseCopernicusOpenCatalogScenes,
  parseCopernicusStatsResponse,
  parseDgtCadastreFeatures,
  parseElevationApiResponse,
  parseEredesOpenDataLines,
} from './src/lib/externalGeoConnectors.ts';
import {
  ServerInfraBridge,
  WebPushNotificationHub,
  dispatchTelegramAlert,
  dispatchTransactionalEmailOrWebhook,
  formatTelegramHazardAlertPt,
  type ExternalChannelReceipt,
  type ServerIntegrationCapabilities,
} from './src/lib/serverInfraAndNotifications.ts';
import type { PushSubscription } from 'web-push';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Non-blocking PostgreSQL/PostGIS + Redis bridge & RFC 8291 Web Push VAPID Hub
const infraBridge = new ServerInfraBridge();
void infraBridge.initializeFromEnv().catch(() => {});
const webPushHub = new WebPushNotificationHub();

let copernicusTokenCache: { accessToken: string; expiresAtMs: number } | null = null;

async function fetchEredesOpenDataForParcel(
  vertices: LatLon[],
  timeoutMs = 3600
) {
  const url = buildEredesOpenDataUrl({
    baseUrl: process.env.EREDES_OPENDATA_BASE_URL,
    dataset: process.env.EREDES_OPENDATA_DATASET,
    vertices,
    paddingM: 120,
    limit: 25,
  });
  const apiKey = process.env.EREDES_OPENDATA_API_KEY?.trim();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'FaixaSegura-SGIFR/2.0',
  };
  if (apiKey) {
    headers.Authorization = `Apikey ${apiKey}`;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers, signal: ctrl.signal });
    if (!resp.ok) return [];
    const json = await resp.json();
    return parseEredesOpenDataLines(json);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRealParcelTerrainSlope(params: {
  vertices: LatLon[];
  centroid?: LatLon;
  timeoutMs?: number;
}): Promise<{
  avgSlopePct: number;
  elevationMeta: NonNullable<ParcelRecord['elevationMeta']>;
} | null> {
  const sampleGrid = buildParcelElevationSampleGrid(params.vertices, params.centroid);
  const cacheKey = `dem:${sampleGrid[0].lat.toFixed(4)},${sampleGrid[0].lon.toFixed(4)}:${sampleGrid.length}`;
  const cached = await infraBridge.cacheGetJson<{
    avgSlopePct: number;
    elevationMeta: NonNullable<ParcelRecord['elevationMeta']>;
  }>(cacheKey);
  if (cached) return cached;

  const baseElevationUrl =
    process.env.ELEVATION_API_URL?.trim() || 'https://api.open-meteo.com/v1/elevation';
  const url = new URL(baseElevationUrl);
  if (baseElevationUrl.includes('opentopodata.org')) {
    url.searchParams.set(
      'locations',
      sampleGrid.map((p) => `${p.lat},${p.lon}`).join('|')
    );
  } else {
    url.searchParams.set('latitude', sampleGrid.map((p) => p.lat).join(','));
    url.searchParams.set('longitude', sampleGrid.map((p) => p.lon).join(','));
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), params.timeoutMs ?? 3500);
  try {
    const resp = await fetch(url.toString(), {
      headers: { Accept: 'application/json', 'User-Agent': 'FaixaSegura-SGIFR/2.0' },
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const rawJson = await resp.json();
    const elevations = parseElevationApiResponse(rawJson);
    if (elevations.length < 3) return null;

    const computed = computeTerrainSlopeFromElevations(sampleGrid, elevations);
    const result = {
      avgSlopePct: computed.avgSlopePct,
      elevationMeta: {
        minElevationM: computed.minElevationM,
        maxElevationM: computed.maxElevationM,
        reliefM: computed.reliefM,
        aspectLabelPt: computed.aspectLabelPt,
        sourceLabel: baseElevationUrl.includes('open-meteo.com')
          ? 'Copernicus DEM GLO-90 / MDT 30 m (Open-Meteo)'
          : 'MDT Altimétrico Oficial (ELEVATION_API_URL)',
        sampledPointsCount: Math.min(sampleGrid.length, elevations.length),
      },
    };
    await infraBridge.cacheSetJson(cacheKey, result, 12 * 3600);
    return result;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getCopernicusOAuthToken(): Promise<string | null> {
  const clientId = process.env.COPERNICUS_CLIENT_ID?.trim();
  const clientSecret = process.env.COPERNICUS_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;

  if (copernicusTokenCache && copernicusTokenCache.expiresAtMs > Date.now() + 30_000) {
    return copernicusTokenCache.accessToken;
  }

  const tokenUrl =
    process.env.COPERNICUS_TOKEN_URL?.trim() ||
    'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4500);
  try {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });
    const resp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) return null;
    copernicusTokenCache = {
      accessToken: json.access_token,
      expiresAtMs: Date.now() + Math.max(60, Number(json.expires_in ?? 600)) * 1000,
    };
    return json.access_token;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCopernicusSentinel2Observations(params: {
  vertices: LatLon[];
  centroid: LatLon;
  landClass: LandClass;
  existingHistory?: SatelliteObservation[];
  forceRefresh?: boolean;
}): Promise<{ observations: SatelliteObservation[]; sourceLabel: string }> {
  const cacheKey = `s2:${params.centroid.lat.toFixed(4)},${params.centroid.lon.toFixed(4)}:${params.landClass}`;
  if (!params.forceRefresh) {
    const cached = await infraBridge.cacheGetJson<{
      observations: SatelliteObservation[];
      sourceLabel: string;
    }>(cacheKey);
    if (cached && cached.observations.length > 0) return cached;
  }

  const now = new Date();
  const fromDate = new Date(now.getTime() - 65 * 24 * 3600_000).toISOString().slice(0, 10);
  const toDate = now.toISOString().slice(0, 10);

  // 1. Authenticated Copernicus Data Space Statistical API (B04/B08/B11 10m polygon stats)
  const accessToken = await getCopernicusOAuthToken();
  if (accessToken && params.vertices.length >= 3) {
    const statsUrl =
      process.env.COPERNICUS_STATS_URL?.trim() ||
      'https://sh.dataspace.copernicus.eu/api/v1/statistics';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6500);
    try {
      const resp = await fetch(statsUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(
          buildCopernicusStatsRequestBody({
            vertices: params.vertices,
            fromIsoDate: fromDate,
            toIsoDate: toDate,
          })
        ),
        signal: ctrl.signal,
      });
      if (resp.ok) {
        const rawJson = await resp.json();
        const statsObs = parseCopernicusStatsResponse(rawJson, 4);
        if (statsObs.length >= 2) {
          const out = {
            observations: statsObs,
            sourceLabel: 'Copernicus Sentinel-2 L2A (Statistical API OAuth2 · 10 m)',
          };
          await infraBridge.cacheSetJson(cacheKey, out, 6 * 3600);
          return out;
        }
      }
    } catch {
      // Fall through to Open Catalog
    } finally {
      clearTimeout(timer);
    }
  }

  // 2. Unauthenticated Copernicus Data Space Open Catalog (Real Sentinel-2 L2A overpass dates & cloud cover)
  const catalogUrl = buildCopernicusOpenCatalogUrl({
    catalogBaseUrl: process.env.COPERNICUS_CATALOG_URL,
    centroid: params.centroid,
    startDateIso: fromDate,
    completionDateIso: toDate,
    maxRecords: 24,
  });
  const catCtrl = new AbortController();
  const catTimer = setTimeout(() => catCtrl.abort(), 4800);
  try {
    const catResp = await fetch(catalogUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'FaixaSegura-SGIFR/2.0' },
      signal: catCtrl.signal,
    });
    if (catResp.ok) {
      const catJson = await catResp.json();
      const catalogObs = parseCopernicusOpenCatalogScenes({
        rawJson: catJson,
        landClass: params.landClass,
        centroid: params.centroid,
        existingHistory: params.existingHistory,
        maxCount: 4,
      });
      if (catalogObs.length >= 2) {
        const out = {
          observations: catalogObs,
          sourceLabel: 'Copernicus Data Space · Passagens Reais Sentinel-2 L2A',
        };
        await infraBridge.cacheSetJson(cacheKey, out, 3 * 3600);
        return out;
      }
    }
  } catch {
    // Fall through to deterministic seasonal curve
  } finally {
    clearTimeout(catTimer);
  }

  // 3. Offline / Hermetic Fallback
  const fallbackObs: SatelliteObservation[] =
    params.existingHistory && params.existingHistory.length > 0
      ? params.existingHistory
      : [
          { date: '2026-03-15', ndvi: 0.44, ndmi: 0.27, cloudCoverPct: 7 },
          { date: '2026-04-02', ndvi: 0.51, ndmi: 0.22, cloudCoverPct: 9 },
          { date: '2026-04-18', ndvi: 0.57, ndmi: 0.18, cloudCoverPct: 6 },
          { date: '2026-05-04', ndvi: 0.62, ndmi: 0.15, cloudCoverPct: 8 },
        ];
  return {
    observations: fallbackObs,
    sourceLabel: 'Série Multiespectral Regional Sentinel-2 (Contingência Local)',
  };
}

// In-memory state store (mirrors PostgreSQL faixasegura schema + Redis TTL cache)
const parcelsStore: ParcelRecord[] = structuredClone(INITIAL_PARCELS);
const certificatesStore: ComplianceCertificate[] = structuredClone(INITIAL_CERTIFICATES);
const neighborComplaintsStore: NeighborComplaintRecord[] = [];
const providersStore: ForestryProvider[] = structuredClone(INITIAL_PROVIDERS);
const quotesStore: QuoteLead[] = structuredClone(INITIAL_QUOTES);

interface PirCacheEntry {
  expiresAt: number;
  forecasts: DailyPirForecast[];
  source: 'IPMA Open Data (rcm)' | 'Cache Determinístico Regional IPMA';
}
const pirRedisCache = new Map<string, PirCacheEntry>();

interface OverpassCacheEntry {
  expiresAt: number;
  parsed: ParcelVectorContext;
}
const overpassContextCache = new Map<string, OverpassCacheEntry>();

interface OrthophotoCvCacheEntry {
  expiresAt: number;
  analysis: ParcelOrthophotoCvAnalysis;
}
const orthophotoCvCache = new Map<string, OrthophotoCvCacheEntry>();

async function fetchLiveParcelVectorContext(params: {
  vertices: LatLon[];
  buildingCenter?: LatLon;
  hasEredesLine: boolean;
  eredesType?: ParcelRecord['eredesType'];
  hasProtectedOaks?: boolean;
  existingContext?: ParcelVectorContext;
  forceRefresh?: boolean;
  timeoutMs?: number;
}): Promise<ParcelVectorContext> {
  const bboxKey = computePaddedBoundingBoxWgs84(params.vertices, 110).join(',');
  const cached = !params.forceRefresh ? overpassContextCache.get(bboxKey) : undefined;
  if (cached && cached.expiresAt > Date.now()) {
    return finalizeParcelVectorContext({
      liveParsed: cached.parsed,
      parcelVertices: params.vertices,
      buildingCenter: params.buildingCenter,
      hasEredesLine: params.hasEredesLine,
      eredesType: params.eredesType,
      hasProtectedOaks: params.hasProtectedOaks,
      existingContext: params.existingContext,
    });
  }

  const query = buildOverpassParcelContextQuery(params.vertices, 110);
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter',
  ];
  const perEndpointTimeout = Math.max(2000, params.timeoutMs ?? 5200);

  const eredesPromise = fetchEredesOpenDataForParcel(
    params.vertices,
    Math.min(3600, perEndpointTimeout)
  );

  let overpassParsed: ParcelVectorContext | null = null;
  for (const endpoint of endpoints) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), perEndpointTimeout);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: 'application/json',
          'User-Agent': 'FaixaSegura-SGIFR/1.0',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const json = await res.json();
      overpassParsed = parseOverpassVectorContext({
        overpassJson: json,
        parcelVertices: params.vertices,
        searchRadiusM: 110,
      });
      break;
    } catch {
      clearTimeout(timer);
    }
  }

  const eredesLines = await eredesPromise;
  let mergedLive = overpassParsed;
  if (mergedLive && eredesLines.length > 0) {
    mergedLive = mergeEredesEasementsIntoVectorContext(mergedLive, eredesLines).context;
  }

  if (mergedLive) {
    overpassContextCache.set(bboxKey, {
      expiresAt: Date.now() + 30 * 60_000,
      parsed: mergedLive,
    });
  }

  const finalized = finalizeParcelVectorContext({
    liveParsed: mergedLive,
    parcelVertices: params.vertices,
    buildingCenter: params.buildingCenter,
    hasEredesLine: params.hasEredesLine || eredesLines.length > 0,
    eredesType: params.eredesType,
    hasProtectedOaks: params.hasProtectedOaks,
    existingContext: params.existingContext,
  });

  if (!mergedLive && eredesLines.length > 0) {
    return mergeEredesEasementsIntoVectorContext(finalized, eredesLines).context;
  }
  return finalized;
}

// Circuit breaker state for ollama.innovaive.com
const ollamaCircuit = {
  baseUrl: process.env.OLLAMA_BASE_URL || 'https://ollama.innovaive.com',
  visionModel: process.env.OLLAMA_VISION_MODEL || 'gemma3:4b',
  textModel: process.env.OLLAMA_TEXT_MODEL || 'qwen3:4b',
  failures: 0,
  openUntil: 0,
};

async function callOllamaWithFallback(prompt: string, model: string): Promise<{ text: string | null; provider: string }> {
  if (Date.now() < ollamaCircuit.openUntil) {
    return { text: null, provider: 'Fallback Determinístico SGIFR (Circuit Breaker Ativo)' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.OLLAMA_TIMEOUT_MS || 4500));
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const ollamaApiKey = process.env.OLLAMA_API_KEY?.trim();
  if (ollamaApiKey) {
    headers.Authorization = `Bearer ${ollamaApiKey}`;
  }
  try {
    const resp = await fetch(`${ollamaCircuit.baseUrl.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as { response?: string };
    ollamaCircuit.failures = 0;
    return { text: data.response?.trim() || null, provider: `Ollama Privado (${model})` };
  } catch {
    clearTimeout(timeout);
    ollamaCircuit.failures += 1;
    if (ollamaCircuit.failures >= 2) {
      ollamaCircuit.openUntil = Date.now() + 120_000;
    }
    return { text: null, provider: 'Motor Determinístico SGIFR (RGPD Local)' };
  }
}

async function fetchIpmaRcmLevel(dayIndex: 0 | 1, dico: string): Promise<PirLevel | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3200);
  try {
    const baseUrl = (
      process.env.IPMA_RCM_BASE_URL?.trim() ||
      'https://api.ipma.pt/open-data/forecast/meteorology/rcm'
    ).replace(/\/$/, '');
    const url = `${baseUrl}/rcm-d${dayIndex}.json`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      local?: Record<string, { data?: { rcm?: number } }>;
    };
    const rcm = json?.local?.[dico]?.data?.rcm;
    if (typeof rcm === 'number' && rcm >= 1 && rcm <= 5) {
      return rcm as PirLevel;
    }
    return null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

function formatDayPt(offsetDays: number): { label: string; isoDate: string } {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const weekday = d.toLocaleDateString('pt-PT', { weekday: 'long' });
  const capWeekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  const prefix = offsetDays === 0 ? 'Hoje' : offsetDays === 1 ? 'Amanhã' : 'Depois de Amanhã';
  return {
    label: `${prefix} · ${capWeekday}`,
    isoDate: d.toISOString().slice(0, 10),
  };
}

function resolveServerPort(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv
): number {
  // 1. Explicit CLI `--port 3000` or `--port=3000`
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    if (arg.startsWith('--port=')) {
      const parsed = Number(arg.slice('--port='.length));
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }

  // 2. npm flag forwarding (`npm run dev --port 3000` without `--`)
  if (env.npm_config_port) {
    const parsed = Number(env.npm_config_port);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  // 3. Explicit APP_PORT override
  if (env.APP_PORT) {
    const parsed = Number(env.APP_PORT);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  // 4. In non-production containers where Nginx owns NGINX_PORT (e.g. PORT=8080, DEFAULT_APP_PORT=3000),
  //    avoid EADDRINUSE against Nginx and bind to DEFAULT_APP_PORT (3000).
  const isProd = env.NODE_ENV === 'production';
  if (!isProd && env.DEFAULT_APP_PORT) {
    const defaultAppPort = Number(env.DEFAULT_APP_PORT);
    const rawPort = Number(env.PORT || 0);
    const nginxPort = Number(env.NGINX_PORT || 0);
    if (
      Number.isFinite(defaultAppPort) &&
      defaultAppPort > 0 &&
      (!rawPort || (nginxPort > 0 && rawPort === nginxPort))
    ) {
      return defaultAppPort;
    }
  }

  const envPort = Number(env.PORT || 3000);
  return Number.isFinite(envPort) && envPort > 0 ? envPort : 3000;
}

const DEV_SERVICE_WORKER_JS = `self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('workbox-') || k.includes('precache'))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/@vite') || url.pathname.startsWith('/src/') || url.pathname.startsWith('/node_modules/')) {
    return;
  }
});

self.addEventListener('push', (event) => {
  let payload = {
    title: 'FaixaSegura — Alerta Operacional',
    body: 'Nova ocorrência detetada na proximidade dos seus terrenos.',
    url: '/?autostart=1',
    tag: 'faixasegura-hazard',
  };
  if (event.data) {
    try {
      const parsed = event.data.json();
      if (parsed && typeof parsed === 'object') payload = Object.assign(payload, parsed);
    } catch {
      payload.body = event.data.text() || payload.body;
    }
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/pwa-192x192.png',
      badge: '/pwa-192x192.png',
      tag: payload.tag || 'faixasegura-hazard',
      data: { url: payload.url || '/?autostart=1' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/?autostart=1';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
`;

async function startServer() {
  const app = express();
  const httpServer = createHttpServer(app);
  app.use(express.json({ limit: '12mb' }));

  app.get('/api/health', (_req, res) => {
    const integrations: ServerIntegrationCapabilities = {
      postgresConfigured: Boolean(process.env.DATABASE_URL?.trim()),
      postgresConnected: infraBridge.isPostgresConnected(),
      redisConfigured: Boolean(process.env.REDIS_URL?.trim()),
      redisConnected: infraBridge.isRedisConnected(),
      copernicusOAuthConfigured: Boolean(
        process.env.COPERNICUS_CLIENT_ID?.trim() && process.env.COPERNICUS_CLIENT_SECRET?.trim()
      ),
      eredesApiKeyConfigured: Boolean(process.env.EREDES_OPENDATA_API_KEY?.trim()),
      orthophotoCvMicroserviceConfigured: Boolean(resolveConfiguredOrthophotoServiceUrl()),
      ollamaApiKeyConfigured: Boolean(process.env.OLLAMA_API_KEY?.trim()),
      telegramBotConfigured: Boolean(
        process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_DEFAULT_CHAT_ID?.trim()
      ),
      webPushVapidReady: Boolean(webPushHub.getPublicKey()),
      vapidEnvConfigured: webPushHub.isEnvConfigured(),
      emailDispatchConfigured: Boolean(
        process.env.RESEND_API_KEY?.trim() || process.env.SMTP_WEBHOOK_URL?.trim()
      ),
    };
    res.json({
      status: 'ok',
      service: 'faixasegura',
      ts: new Date().toISOString(),
      integrations,
    });
  });

  // 1. Snapshot of full application state
  app.get('/api/state', (_req, res) => {
    res.json({
      municipalities: MUNICIPALITIES,
      parcels: parcelsStore,
      certificates: certificatesStore,
      neighborComplaints: neighborComplaintsStore,
      providers: providersStore,
      quotes: quotesStore,
    });
  });

  app.get('/api/parishes/:dico', (req, res) => {
    const rawDico = String(req.params.dico || '1111').trim().padStart(4, '0');
    const muni = MUNICIPALITIES.find((m) => m.dico === rawDico);
    if (!muni) {
      res.status(404).json({ error: 'Concelho DICO não encontrado.' });
      return;
    }
    const parishes = getParishesByMunicipality({
      dico: muni.dico,
      municipalityName: muni.name,
    });
    res.json({
      dico: muni.dico,
      municipality: muni.name,
      district: muni.district,
      count: parishes.length,
      parishes,
    });
  });

  // 2. IPMA PIR 3-Day Operational Semaphore (with 1h TTL cache)
  app.get('/api/pir/:dico', async (req, res) => {
    const dico = req.params.dico || '1111';
    const cached = pirRedisCache.get(dico);
    if (cached && cached.expiresAt > Date.now()) {
      res.json({ dico, source: cached.source, forecasts: cached.forecasts });
      return;
    }

    const muni = MUNICIPALITIES.find((m) => m.dico === dico) ?? MUNICIPALITIES[0];
    const [liveD0, liveD1] = await Promise.all([
      fetchIpmaRcmLevel(0, dico),
      fetchIpmaRcmLevel(1, dico),
    ]);

    const d0 = formatDayPt(0);
    const d1 = formatDayPt(1);
    const d2 = formatDayPt(2);

    const p0 = liveD0 ?? muni.basePirToday;
    const p1 = liveD1 ?? muni.basePirTomorrow;
    const p2 = muni.basePirDay2;

    const forecasts: DailyPirForecast[] = [
      evaluateOperationalSemaphore({
        dateLabel: d0.label,
        isoDate: d0.isoDate,
        pirLevel: p0,
        tempMaxC: 17 + p0 * 3,
        humidityMinPct: Math.max(16, 62 - p0 * 9),
        windKmh: 9 + p0 * 5,
      }),
      evaluateOperationalSemaphore({
        dateLabel: d1.label,
        isoDate: d1.isoDate,
        pirLevel: p1,
        tempMaxC: 18 + p1 * 3,
        humidityMinPct: Math.max(18, 60 - p1 * 8),
        windKmh: 10 + p1 * 5,
      }),
      evaluateOperationalSemaphore({
        dateLabel: d2.label,
        isoDate: d2.isoDate,
        pirLevel: p2,
        tempMaxC: 17 + p2 * 3,
        humidityMinPct: Math.max(22, 64 - p2 * 8),
        windKmh: 8 + p2 * 4,
      }),
    ];

    const source = liveD0 !== null ? 'IPMA Open Data (rcm)' : 'Cache Determinístico Regional IPMA';
    pirRedisCache.set(dico, {
      expiresAt: Date.now() + 3600_000,
      forecasts,
      source,
    });

    res.json({ dico, municipality: muni.name, source, forecasts });
  });

  // 3. Server-Authoritative Real-Time IPMA & Proteção Civil (ANEPC) Aggregator Hub
  interface SseSubscriber {
    id: string;
    res: express.Response;
  }

  class RealtimeOfficialHazardsHub {
    private ipmaAreaLocations: Record<string, IpmaAreaLocation> = {
      ...DEFAULT_IPMA_AREA_LOCATIONS,
    };
    private ipmaAreasFetchedAt = 0;

    private anepcSseFires: Omit<ActiveFireIncident, 'distanceKm'>[] = [];
    private anepcSseWeatherHazards: StormAlertIncident[] = [];
    private apiAbertaFires: Omit<ActiveFireIncident, 'distanceKm'>[] = [];
    private ipmaWarnings: StormAlertIncident[] = [];

    private anepcNational: AnepcNationalSummary | null = null;
    private anepcStreamConnected = false;
    private anepcEverReceived = false;
    private apiAbertaOk = false;
    private ipmaOk = false;
    private lastUpdatedIso = new Date().toISOString();
    private lastDigest = '';

    private sseClients = new Map<string, SseSubscriber>();
    private wss: WebSocketServer;
    private initialSyncPromise: Promise<void> | null = null;
    private initialSyncResolve: (() => void) | null = null;
    private upstreamAbort: AbortController | null = null;
    private reconnectDelayMs = 3000;

    constructor(wss: WebSocketServer) {
      this.wss = wss;
      this.initialSyncPromise = new Promise<void>((resolve) => {
        this.initialSyncResolve = resolve;
      });
    }

    public start(): void {
      // Kick off initial IPMA + API Aberta sync and persistent ANEPC SADO SSE stream in parallel
      void this.refreshUpstreamOnce().finally(() => {
        this.markInitialReady();
      });
      void this.connectAnepcSadoStreamLoop();

      // Refresh IPMA warnings & API Aberta every 60s on the server and broadcast any real changes
      setInterval(() => {
        void this.refreshUpstreamOnce();
      }, 60_000);

      // Keep SSE & WebSocket connections healthy through proxies
      setInterval(() => {
        for (const sub of this.sseClients.values()) {
          try {
            sub.res.write(': keepalive\n\n');
          } catch {
            this.sseClients.delete(sub.id);
          }
        }
        for (const ws of this.wss.clients) {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.ping();
            } catch {
              // Ignore ping errors on closing sockets
            }
          }
        }
      }, 22_000);
    }

    private markInitialReady(): void {
      if (this.initialSyncResolve) {
        const fn = this.initialSyncResolve;
        this.initialSyncResolve = null;
        fn();
      }
    }

    public async waitUntilReady(timeoutMs = 3200): Promise<void> {
      if (!this.initialSyncPromise || !this.initialSyncResolve) return;
      await Promise.race([
        this.initialSyncPromise,
        new Promise<void>((r) => setTimeout(r, timeoutMs)),
      ]);
    }

    private async ensureIpmaAreaLocations(): Promise<void> {
      if (Date.now() - this.ipmaAreasFetchedAt < 6 * 3600_000) return;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3500);
      try {
        const res = await fetch('https://api.ipma.pt/open-data/distrits-islands.json', {
          headers: { Accept: 'application/json', 'User-Agent': 'FaixaSegura/1.0' },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (res.ok) {
          const json = await res.json();
          this.ipmaAreaLocations = hydrateIpmaAreaLocations(json);
          this.ipmaAreasFetchedAt = Date.now();
        }
      } catch {
        clearTimeout(timer);
      }
    }

    public async refreshUpstreamOnce(): Promise<RealtimeHazardsSnapshotPayload> {
      await this.ensureIpmaAreaLocations();

      const [ipmaResult, apiAbertaResult] = await Promise.allSettled([
        this.fetchIpmaWarningsOnce(),
        this.fetchApiAbertaOnce(),
      ]);

      if (ipmaResult.status === 'fulfilled' && ipmaResult.value !== null) {
        this.ipmaWarnings = ipmaResult.value;
        this.ipmaOk = true;
      }
      if (apiAbertaResult.status === 'fulfilled' && apiAbertaResult.value !== null) {
        this.apiAbertaFires = apiAbertaResult.value;
        this.apiAbertaOk = true;
      }

      // If the persistent ANEPC SSE stream hasn't delivered its initial frame yet (or dropped),
      // perform a fast bounded 1-shot SSE burst read so manual refreshes immediately pull SADO too.
      if (!this.anepcStreamConnected && !this.anepcEverReceived) {
        await this.pullSingleAnepcBurst(2600);
      }

      this.broadcastIfChanged(true);
      return this.buildSnapshot('http');
    }

    private async fetchIpmaWarningsOnce(): Promise<StormAlertIncident[] | null> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      try {
        const res = await fetch(
          'https://api.ipma.pt/open-data/forecast/warnings/warnings_www.json',
          {
            headers: { Accept: 'application/json', 'User-Agent': 'FaixaSegura/1.0' },
            signal: ctrl.signal,
          }
        );
        clearTimeout(timer);
        if (!res.ok) return null;
        const raw = await res.json();
        return parseIpmaWarningsPayload(raw, this.ipmaAreaLocations);
      } catch {
        clearTimeout(timer);
        return null;
      }
    }

    private async fetchApiAbertaOnce(): Promise<Omit<ActiveFireIncident, 'distanceKm'>[] | null> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3500);
      try {
        const apiAbertaUrl =
          process.env.ANEPC_API_ABERTA_URL?.trim() ||
          'https://api.apiaberta.pt/v1/anpc/incidents/active';
        const res = await fetch(apiAbertaUrl, {
          headers: { Accept: 'application/json', 'User-Agent': 'FaixaSegura/1.0' },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) return null;
        const json = (await res.json()) as { data?: unknown };
        return mergeSecondaryApiAbertaFires([], json?.data);
      } catch {
        clearTimeout(timer);
        return null;
      }
    }

    private async pullSingleAnepcBurst(maxDurationMs: number): Promise<void> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), maxDurationMs);
      try {
        const res = await fetch('https://ocorrenciasativas.pt/api/gw/site/incidents/stream', {
          headers: {
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
            'User-Agent': 'Mozilla/5.0 (compatible; FaixaSegura/1.0)',
          },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          clearTimeout(timer);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let gotIncidents = false;

        while (!gotIncidents) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { frames, remainder } = consumeSseBuffer(buffer);
          buffer = remainder;
          for (const frame of frames) {
            if (this.applyAnepcFrame(frame.event, frame.data) && frame.event === 'incidents') {
              gotIncidents = true;
            }
          }
        }
        ctrl.abort();
      } catch {
        // Expected on abort or offline network
      } finally {
        clearTimeout(timer);
      }
    }

    private applyAnepcFrame(eventName: string, dataStr: string): boolean {
      if (eventName === 'counts') {
        const counts = parseAnepcCountsPayload(dataStr);
        if (counts) {
          this.anepcNational = counts;
          this.anepcEverReceived = true;
          return true;
        }
        return false;
      }
      if (eventName === 'incidents') {
        const classified = classifyAnepcIncidents(dataStr);
        this.anepcSseFires = classified.fires;
        this.anepcSseWeatherHazards = classified.civilWeatherHazards;
        this.anepcEverReceived = true;
        this.markInitialReady();
        return true;
      }
      return false;
    }

    private async connectAnepcSadoStreamLoop(): Promise<void> {
      while (true) {
        const ctrl = new AbortController();
        this.upstreamAbort = ctrl;
        let idleWatchdog: ReturnType<typeof setTimeout> | null = null;
        const resetWatchdog = () => {
          if (idleWatchdog) clearTimeout(idleWatchdog);
          idleWatchdog = setTimeout(() => ctrl.abort(), 95_000);
        };

        try {
          resetWatchdog();
          const res = await fetch('https://ocorrenciasativas.pt/api/gw/site/incidents/stream', {
            headers: {
              Accept: 'text/event-stream',
              'Cache-Control': 'no-cache',
              'User-Agent': 'Mozilla/5.0 (compatible; FaixaSegura/1.0)',
            },
            signal: ctrl.signal,
          });

          if (!res.ok || !res.body) {
            throw new Error(`ANEPC SSE HTTP ${res.status}`);
          }

          this.anepcStreamConnected = true;
          this.reconnectDelayMs = 3000;
          const reader = res.body.getReader();
          const decoder = new TextDecoder('utf-8');
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            resetWatchdog();
            buffer += decoder.decode(value, { stream: true });
            const { frames, remainder } = consumeSseBuffer(buffer);
            buffer = remainder;
            let mutated = false;
            for (const frame of frames) {
              if (this.applyAnepcFrame(frame.event, frame.data)) {
                mutated = true;
              }
            }
            if (mutated) {
              this.broadcastIfChanged(false);
            }
          }
        } catch {
          // Stream closed or timed out — reconnect with bounded backoff
        } finally {
          if (idleWatchdog) clearTimeout(idleWatchdog);
          this.anepcStreamConnected = false;
          this.upstreamAbort = null;
        }

        await new Promise<void>((r) => setTimeout(r, this.reconnectDelayMs));
        this.reconnectDelayMs = Math.min(30_000, Math.round(this.reconnectDelayMs * 1.8));
      }
    }

    public buildSnapshot(
      transport: RealtimeHazardFeedMeta['transport'] = 'websocket'
    ): RealtimeHazardsSnapshotPayload {
      const anepcLive = this.anepcEverReceived || this.apiAbertaOk;
      const ipmaLive = this.ipmaOk;

      const liveFires = mergeSecondaryApiAbertaFires(this.anepcSseFires, this.apiAbertaFires);
      // Only fall back to regional demo fires if ALL ANEPC live feeds are unreachable
      const fires: Omit<ActiveFireIncident, 'distanceKm'>[] = anepcLive
        ? liveFires
        : structuredClone(FALLBACK_ACTIVE_FIRES);

      const liveStorms: StormAlertIncident[] = [
        ...this.ipmaWarnings,
        ...this.anepcSseWeatherHazards,
      ];
      // Only fall back to regional demo storms if BOTH IPMA and ANEPC live feeds are unreachable
      const storms: StormAlertIncident[] =
        ipmaLive || anepcLive ? liveStorms : structuredClone(FALLBACK_ACTIVE_STORMS);

      const anepcSourceLabel = this.anepcStreamConnected
        ? 'ANEPC SADO (Stream Direto Ativo)'
        : this.anepcEverReceived
          ? 'ANEPC SADO (Sincronizado)'
          : this.apiAbertaOk
            ? 'ANEPC / API Aberta'
            : 'Contingência Regional Offline';

      const ipmaSourceLabel = ipmaLive
        ? 'IPMA Open Data (Avisos Oficiais)'
        : 'Contingência Meteorológica Regional';

      return {
        updatedAtIso: this.lastUpdatedIso,
        fires,
        storms,
        meta: {
          connected: true,
          transport,
          anepcLive,
          ipmaLive,
          anepcSourceLabel,
          ipmaSourceLabel,
          anepcNational: this.anepcNational,
          ipmaActiveWarningsCount: this.ipmaWarnings.length,
          activeFireIncidentsCount: fires.length,
          activeWeatherIncidentsCount: storms.length,
          lastUpdatedIso: this.lastUpdatedIso,
        },
      };
    }

    private broadcastIfChanged(forceTimestampUpdate: boolean): void {
      const digestPayload = JSON.stringify({
        fires: this.anepcSseFires.map((f) => [f.id, f.status, f.operatives, f.vehicles, f.aerialMeans]),
        apiFires: this.apiAbertaFires.map((f) => [f.id, f.status]),
        ipma: this.ipmaWarnings.map((w) => [w.id, w.severity, w.validUntil]),
        weatherAnepc: this.anepcSseWeatherHazards.map((w) => [w.id, w.validUntil, w.operatives]),
        counts: this.anepcNational,
        anepcConn: this.anepcStreamConnected,
        ipmaOk: this.ipmaOk,
      });

      if (!forceTimestampUpdate && digestPayload === this.lastDigest) {
        return;
      }

      this.lastDigest = digestPayload;
      this.lastUpdatedIso = new Date().toISOString();

      // 1. Push to WebSocket clients
      const wsSnapshot = this.buildSnapshot('websocket');
      const wsMessage = JSON.stringify({
        type: 'hazards:snapshot',
        payload: wsSnapshot,
      });
      for (const client of this.wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          try {
            client.send(wsMessage);
          } catch {
            // Ignore transient socket write error
          }
        }
      }

      // 2. Push to SSE clients
      const sseSnapshot = this.buildSnapshot('sse');
      const sseFrame = `event: hazards:snapshot\ndata: ${JSON.stringify(sseSnapshot)}\n\n`;
      for (const sub of this.sseClients.values()) {
        try {
          sub.res.write(sseFrame);
        } catch {
          this.sseClients.delete(sub.id);
        }
      }
    }

    public registerSseClient(req: express.Request, res: express.Response): void {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const clientId = `sse_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.sseClients.set(clientId, { id: clientId, res });

      const initialSnapshot = this.buildSnapshot('sse');
      res.write(`event: hazards:snapshot\ndata: ${JSON.stringify(initialSnapshot)}\n\n`);

      req.on('close', () => {
        this.sseClients.delete(clientId);
      });
    }
  }

  const hazardsWss = new WebSocketServer({ noServer: true });
  const hazardsHub = new RealtimeOfficialHazardsHub(hazardsWss);
  hazardsHub.start();

  httpServer.on('upgrade', (request, socket, head) => {
    try {
      const urlObj = new URL(request.url || '/', 'http://localhost');
      if (urlObj.pathname === '/ws/hazards') {
        hazardsWss.handleUpgrade(request, socket, head, (ws) => {
          hazardsWss.emit('connection', ws, request);
        });
      }
    } catch {
      // Leave non-hazard upgrade paths untouched (e.g., Vite dev middleware)
    }
  });

  hazardsWss.on('connection', (ws) => {
    void hazardsHub.waitUntilReady(2500).then(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'hazards:snapshot',
            payload: hazardsHub.buildSnapshot('websocket'),
          })
        );
      }
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string };
        if (msg?.type === 'hazards:refresh') {
          void hazardsHub.refreshUpstreamOnce();
        } else if (msg?.type === 'hazards:ping') {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'hazards:pong', ts: new Date().toISOString() }));
          }
        }
      } catch {
        // Ignore malformed client frames
      }
    });
  });

  // 3a. Active Rural Fires Radar (ANEPC Real-Time Hub + Geospatial Proximity)
  app.get('/api/fires/active', async (req, res) => {
    const refLat = Number(req.query.lat) || 38.798412;
    const refLon = Number(req.query.lon) || -9.462108;

    await hazardsHub.waitUntilReady(2800);
    const snapshot = hazardsHub.buildSnapshot('http');

    const incidents: ActiveFireIncident[] = snapshot.fires
      .map((f) => ({
        ...f,
        distanceKm: haversineDistanceKm({ lat: refLat, lon: refLon }, { lat: f.lat, lon: f.lon }),
      }))
      .sort((a, b) => a.distanceKm - b.distanceKm);

    res.json({
      within15KmCount: incidents.filter((i) => i.distanceKm <= 15).length,
      incidents,
      meta: snapshot.meta,
    });
  });

  // 3b. Real-Time SSE Stream for Official IPMA + Proteção Civil (ANEPC) Alerts
  app.get('/api/hazards/stream', async (req, res) => {
    await hazardsHub.waitUntilReady(2500);
    hazardsHub.registerSseClient(req, res);
  });

  // 3c. Unified Multi-Parcel Wildfire + Severe Storm Snapshot (ANEPC + IPMA Warnings)
  app.get('/api/hazards/active', async (req, res) => {
    const refLat = Number(req.query.lat) || 38.798412;
    const refLon = Number(req.query.lon) || -9.462108;

    await hazardsHub.waitUntilReady(3200);
    const snapshot = hazardsHub.buildSnapshot('http');

    const firesWithDistance: ActiveFireIncident[] = snapshot.fires
      .map((f) => ({
        ...f,
        distanceKm: haversineDistanceKm({ lat: refLat, lon: refLon }, { lat: f.lat, lon: f.lon }),
      }))
      .sort((a, b) => a.distanceKm - b.distanceKm);

    res.json({
      updatedAtIso: snapshot.updatedAtIso,
      fires: firesWithDistance,
      storms: snapshot.storms,
      meta: snapshot.meta,
    });
  });

  // 3d. Force Immediate Live Sync with IPMA & Proteção Civil and Broadcast to All Clients
  app.post('/api/hazards/refresh', async (req, res) => {
    const refLat = Number(req.body?.lat ?? req.query.lat) || 38.798412;
    const refLon = Number(req.body?.lon ?? req.query.lon) || -9.462108;

    const snapshot = await hazardsHub.refreshUpstreamOnce();
    const firesWithDistance: ActiveFireIncident[] = snapshot.fires
      .map((f) => ({
        ...f,
        distanceKm: haversineDistanceKm({ lat: refLat, lon: refLon }, { lat: f.lat, lon: f.lon }),
      }))
      .sort((a, b) => a.distanceKm - b.distanceKm);

    res.json({
      updatedAtIso: snapshot.updatedAtIso,
      fires: firesWithDistance,
      storms: snapshot.storms,
      meta: snapshot.meta,
    });
  });

  // 4. Phase 1 Spatial Vector Context Ingestion (Live OSM Overpass + Cadastral Fallback) & Parcel CRUD
  app.post('/api/spatial/vector-context', async (req, res) => {
    const body = req.body as {
      parcelId?: string;
      vertices?: LatLon[];
      buildingCenter?: LatLon;
      landClass?: LandClass;
      hasEredesLine?: boolean;
      eredesType?: ParcelRecord['eredesType'];
      hasProtectedOaks?: boolean;
      existingContext?: ParcelVectorContext;
      resetUserEdits?: boolean;
      forceRefresh?: boolean;
    };

    const existing = body.parcelId
      ? parcelsStore.find((p) => p.id === body.parcelId)
      : undefined;
    const vertices =
      Array.isArray(body.vertices) && body.vertices.length >= 3
        ? body.vertices
        : existing?.vertices;

    if (!vertices || vertices.length < 3) {
      res.status(400).json({ error: 'Indique pelo menos 3 vértices geográficos para analisar o contexto vetorial.' });
      return;
    }

    const landClass: LandClass = body.landClass ?? existing?.landClass ?? 'FOREST_SCRUB';
    const hasEredesInput =
      body.hasEredesLine !== undefined
        ? Boolean(body.hasEredesLine)
        : (existing?.hasEredesLine ?? false);
    const eredesTypeInput =
      body.eredesType ??
      existing?.eredesType ??
      (hasEredesInput ? 'MT 15kV (Faixa 7m)' : 'Sem linha aérea');
    const hasProtectedOaks =
      body.hasProtectedOaks !== undefined
        ? Boolean(body.hasProtectedOaks)
        : (existing?.hasProtectedOaks ?? false);

    const preservedContext = body.resetUserEdits
      ? undefined
      : (body.existingContext ?? existing?.vectorContext);

    const vectorContext = await fetchLiveParcelVectorContext({
      vertices,
      buildingCenter: body.buildingCenter ?? existing?.buildingCenter,
      hasEredesLine: hasEredesInput,
      eredesType: eredesTypeInput,
      hasProtectedOaks,
      existingContext: preservedContext,
      forceRefresh: Boolean(body.forceRefresh),
      timeoutMs: 5200,
    });

    const detectedPowerEasement = vectorContext.easements.some(
      (e) => e.category === 'EREDES_MT_AT' || e.category === 'REN_MAT'
    );
    const effectiveHasEredes = hasEredesInput || detectedPowerEasement;
    const effectiveEredesType: ParcelRecord['eredesType'] = effectiveHasEredes
      ? eredesTypeInput !== 'Sem linha aérea'
        ? eredesTypeInput
        : 'MT 15kV (Faixa 7m)'
      : 'Sem linha aérea';

    const spatial = computeParcelFgc({
      vertices,
      buildingCenter: body.buildingCenter ?? existing?.buildingCenter,
      landClass,
      hasEredesLine: effectiveHasEredes,
      eredesType: effectiveEredesType,
      vectorContext,
    });

    if (existing) {
      const idx = parcelsStore.findIndex((p) => p.id === existing.id);
      if (idx !== -1) {
        parcelsStore[idx] = {
          ...parcelsStore[idx],
          hasEredesLine: effectiveHasEredes,
          eredesType: effectiveEredesType,
          vectorContext,
          spatial,
        };
      }
    }

    res.json({
      vectorContext,
      spatial,
      hasDetectedPowerEasement: detectedPowerEasement,
      effectiveHasEredes,
      effectiveEredesType,
    });
  });

  // Phase 2A: ONNX Runtime / CV Microservice Tensor & Class Specification Contract
  app.get('/api/spatial/orthophoto-cv/spec', (_req, res) => {
    const profile =
      process.env.ORTHOPHOTO_ONNX_PROFILE?.trim() || 'yolo11s-seg+segformer-b2-dgt25cm';
    const resolvedUrl = resolveConfiguredOrthophotoServiceUrl();
    const endpoints = resolvedUrl ? resolveOrthophotoServiceEndpoints(resolvedUrl) : null;
    res.json({
      ...buildOrthophotoInferenceSpec(profile),
      externalMicroserviceConfigured: Boolean(resolvedUrl),
      remoteProtocol: endpoints?.preferredProtocol ?? null,
    });
  });

  // Phase 2A-Health: Live Probe of Configured Remote OrthoSeg KVM / SegFormer Service
  app.get('/api/spatial/orthophoto-cv/health', async (req, res) => {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const health = await probeOrthophotoServiceHealth({ forceRefresh });
    res.json({
      reachable: health.reachable,
      configured: health.configured,
      status: health.status,
      workers: health.workers,
      workersWarmed: health.workersWarmed,
      executionMode: health.executionMode,
      buildingModelSource: health.buildingModelSource,
      latencyMs: health.latencyMs,
      checkedAtIso: health.checkedAtIso,
      errorMessage: health.errorMessage,
    });
  });

  // Shared handler for Parcel BBox Crop & Client Cropped-Image Orthophoto Inference
  const handleOrthophotoCvInferenceRequest = async (
    req: express.Request,
    res: express.Response
  ) => {
    const isRawBinary = Buffer.isBuffer(req.body);
    const body = (isRawBinary ? {} : req.body ?? {}) as {
      parcelId?: string;
      vertices?: LatLon[];
      buildingCenter?: LatLon;
      landClass?: LandClass;
      hasEredesLine?: boolean;
      eredesType?: ParcelRecord['eredesType'];
      vectorContext?: ParcelVectorContext;
      croppedImageBase64?: string;
      imageBase64?: string;
      bboxWgs84?: [number, number, number, number];
      cropRect?: PixelCropRect;
      fuseIntoBoolean?: boolean;
      forceRefresh?: boolean;
    };

    const parcelId =
      body.parcelId ?? (typeof req.query.parcelId === 'string' ? req.query.parcelId : undefined);
    const existing = parcelId ? parcelsStore.find((p) => p.id === parcelId) : undefined;
    const vertices =
      Array.isArray(body.vertices) && body.vertices.length >= 3
        ? body.vertices
        : (existing?.vertices ?? []);

    if (vertices.length < 3) {
      res.status(400).json({
        error: 'Indique pelo menos 3 vértices geográficos ou um parcelId válido para analisar a ortofoto.',
      });
      return;
    }

    let queryBbox: [number, number, number, number] | undefined = body.bboxWgs84;
    if (!queryBbox && typeof req.query.bboxWgs84 === 'string') {
      const parts = req.query.bboxWgs84.split(',').map((n) => Number(n.trim()));
      if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
        queryBbox = [parts[0], parts[1], parts[2], parts[3]];
      }
    }

    const croppedImageBase64 = body.croppedImageBase64 ?? body.imageBase64;
    const rawImageBuffer = isRawBinary && (req.body as Buffer).length > 0 ? (req.body as Buffer) : undefined;
    const hasCustomCropInput = Boolean(
      rawImageBuffer || (croppedImageBase64 && croppedImageBase64.trim()) || body.cropRect || queryBbox
    );

    const landClass = body.landClass ?? existing?.landClass ?? 'FOREST_SCRUB';
    const hasEredesLine =
      body.hasEredesLine !== undefined
        ? Boolean(body.hasEredesLine)
        : (existing?.hasEredesLine ?? false);
    const eredesType: ParcelRecord['eredesType'] = hasEredesLine
      ? (body.eredesType ?? existing?.eredesType ?? 'MT 15kV (Faixa 7m)')
      : 'Sem linha aérea';

    let vectorContext = body.vectorContext ?? existing?.vectorContext;
    if (!vectorContext) {
      vectorContext = synthesizeDeterministicCadastreContext({
        parcelVertices: vertices,
        buildingCenter: body.buildingCenter ?? existing?.buildingCenter,
        hasEredesLine,
        eredesType,
      });
    }

    let spatial = computeParcelFgc({
      vertices,
      buildingCenter: body.buildingCenter ?? existing?.buildingCenter,
      landClass,
      hasEredesLine,
      eredesType,
      vectorContext,
    });

    const gridForKey = computeParcelCvRasterGrid(vertices, 20, 400);
    const cacheKey = `${gridForKey.bboxWgs84.join(',')}:${landClass}:${vectorContext.buildings.length}`;
    const modelProfile =
      process.env.ORTHOPHOTO_ONNX_PROFILE?.trim() || 'yolo11s-seg+segformer-b2-dgt25cm';

    let cvAnalysis: ParcelOrthophotoCvAnalysis | null = null;
    let inferenceTelemetry: Awaited<
      ReturnType<typeof executeRemoteOrthophotoInference>
    >['telemetry'] | null = null;

    const cachedCv =
      !body.forceRefresh && !hasCustomCropInput ? orthophotoCvCache.get(cacheKey) : undefined;
    if (cachedCv && cachedCv.expiresAt > Date.now() && !body.fuseIntoBoolean) {
      cvAnalysis = cachedCv.analysis;
    }

    if (!cvAnalysis) {
      try {
        const result = await executeRemoteOrthophotoInference({
          parcelVertices: vertices,
          landClass,
          spatial,
          vectorContext,
          croppedImageBase64,
          rawImageBuffer,
          bboxWgs84: queryBbox,
          cropRect: body.cropRect,
          modelProfile,
        });
        cvAnalysis = result.cvAnalysis;
        inferenceTelemetry = result.telemetry;

        if (!hasCustomCropInput) {
          orthophotoCvCache.set(cacheKey, {
            expiresAt: Date.now() + 10 * 60_000,
            analysis: cvAnalysis,
          });
        }
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? err.message
              : 'Falha ao processar o recorte da ortofoto no serviço de inferência.',
        });
        return;
      }
    }

    let addedBuildingsCount = 0;
    const fuseFlag =
      Boolean(body.fuseIntoBoolean) ||
      req.query.fuseIntoBoolean === '1' ||
      req.query.fuseIntoBoolean === 'true';

    if (fuseFlag) {
      const fused = fuseCvDetectionsIntoVectorContext({
        existingContext: vectorContext,
        cvAnalysis,
        parcelVertices: vertices,
      });
      vectorContext = fused.vectorContext;
      addedBuildingsCount = fused.addedBuildingsCount;
      spatial = computeParcelFgc({
        vertices,
        buildingCenter: body.buildingCenter ?? existing?.buildingCenter,
        landClass,
        hasEredesLine,
        eredesType,
        vectorContext,
      });
      cvAnalysis = {
        ...cvAnalysis,
        fusedIntoVectorContext: true,
      };
    }

    let updatedParcel: ParcelRecord | undefined;
    if (existing) {
      const idx = parcelsStore.findIndex((p) => p.id === existing.id);
      if (idx !== -1) {
        updatedParcel = {
          ...parcelsStore[idx],
          vectorContext,
          cvAnalysis,
          spatial,
        };
        parcelsStore[idx] = updatedParcel;
        void infraBridge.persistParcelPostgis(updatedParcel);
      }
    }

    res.json({
      cvAnalysis,
      vectorContext,
      spatial,
      addedBuildingsCount,
      parcel: updatedParcel,
      telemetry: inferenceTelemetry,
    });
  };

  // Phase 2B: 25 cm Aerial Orthophoto Acquisition + Remote SegFormer / OrthoSeg KVM Inference
  app.post('/api/spatial/orthophoto-cv', handleOrthophotoCvInferenceRequest);

  // Phase 2C: Explicit Cropped Orthophoto Upload Endpoint (JSON base64 + cropRect OR raw binary PNG/JPEG)
  app.post(
    '/api/spatial/orthophoto-cv/crop',
    express.raw({
      type: ['image/png', 'image/jpeg', 'application/octet-stream'],
      limit: '12mb',
    }),
    handleOrthophotoCvInferenceRequest
  );

  // Official DGT / BUPi Cadastre OGC API Features Lookup around map target point
  app.post('/api/spatial/official-cadastre', async (req, res) => {
    const body = req.body as {
      targetPoint?: LatLon;
      searchHalfSpanM?: number;
    };
    const pt = body.targetPoint;
    if (!pt || !Number.isFinite(pt.lat) || !Number.isFinite(pt.lon)) {
      res.status(400).json({ error: 'Indique coordenadas válidas (lat/lon) para consultar o cadastro oficial DGT.' });
      return;
    }

    const url = buildDgtCadastreOgcUrl({
      baseUrl: process.env.DGT_CADASTRE_OGC_URL,
      targetPoint: pt,
      searchHalfSpanM: body.searchHalfSpanM ?? 140,
      limit: 15,
    });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5200);
    try {
      const resp = await fetch(url, {
        headers: { Accept: 'application/geo+json,application/json', 'User-Agent': 'FaixaSegura-SGIFR/2.0' },
        signal: ctrl.signal,
      });
      if (resp.ok) {
        const rawJson = await resp.json();
        const match = parseDgtCadastreFeatures(rawJson, pt);
        if (match) {
          res.json({ found: true, match });
          return;
        }
      }
      res.json({
        found: false,
        match: null,
        fallbackNotePt:
          'Sem geometria aberta publicada pela DGT/BUPi neste ponto exato (concelho fora do Cadastro Predial aberto ou RGG reservado). Desenhe o polígono ou cole a Caderneta Predial.',
      });
    } catch {
      res.json({
        found: false,
        match: null,
        fallbackNotePt:
          'Serviço OGC da DGT temporariamente indisponível — utilize Desenhar Lote ou importação de Caderneta AT.',
      });
    } finally {
      clearTimeout(timer);
    }
  });

  // Real Digital Elevation Model (DEM / MDT) Topographic Slope Calculation in EPSG:3763
  app.post('/api/spatial/elevation-slope', async (req, res) => {
    const body = req.body as {
      parcelId?: string;
      vertices?: LatLon[];
    };
    const existing = body.parcelId ? parcelsStore.find((p) => p.id === body.parcelId) : undefined;
    const vertices =
      Array.isArray(body.vertices) && body.vertices.length >= 3
        ? body.vertices
        : (existing?.vertices ?? []);

    if (vertices.length < 3) {
      res.status(400).json({ error: 'Indique pelo menos 3 vértices para calcular o declive altimétrico MDT.' });
      return;
    }

    const slopeData = await fetchRealParcelTerrainSlope({
      vertices,
      centroid: existing?.spatial.centroidWgs84,
      timeoutMs: 4200,
    });

    const resolvedSlope = slopeData?.avgSlopePct ?? existing?.avgSlopePct ?? 12.5;
    const resolvedMeta: NonNullable<ParcelRecord['elevationMeta']> =
      slopeData?.elevationMeta ?? {
        minElevationM: 112,
        maxElevationM: 126,
        reliefM: 14,
        aspectLabelPt: 'Exposição Sudoeste',
        sourceLabel: 'Modelo Altimétrico Regional EPSG:3763 (Contingência Local)',
        sampledPointsCount: vertices.length,
      };

    if (existing) {
      const idx = parcelsStore.findIndex((p) => p.id === existing.id);
      if (idx !== -1) {
        parcelsStore[idx] = {
          ...parcelsStore[idx],
          avgSlopePct: resolvedSlope,
          elevationMeta: resolvedMeta,
        };
        void infraBridge.persistParcelPostgis(parcelsStore[idx]);
      }
    }

    res.json({
      avgSlopePct: resolvedSlope,
      elevationMeta: resolvedMeta,
    });
  });

  // Copernicus Data Space Sentinel-2 L2A (10 m NDVI & NDMI) Live Refresh
  app.post('/api/satellite/sentinel2', async (req, res) => {
    const body = req.body as {
      parcelId?: string;
      vertices?: LatLon[];
      centroid?: LatLon;
      landClass?: LandClass;
      existingHistory?: SatelliteObservation[];
      forceRefresh?: boolean;
    };

    const existing = body.parcelId ? parcelsStore.find((p) => p.id === body.parcelId) : undefined;
    const vertices =
      Array.isArray(body.vertices) && body.vertices.length >= 3
        ? body.vertices
        : (existing?.vertices ?? []);
    const centroid =
      body.centroid ??
      existing?.spatial.centroidWgs84 ??
      (vertices.length > 0
        ? {
            lat: vertices.reduce((s, v) => s + v.lat, 0) / vertices.length,
            lon: vertices.reduce((s, v) => s + v.lon, 0) / vertices.length,
          }
        : { lat: 38.7984, lon: -9.4621 });
    const landClass = body.landClass ?? existing?.landClass ?? 'FOREST_SCRUB';

    const result = await fetchCopernicusSentinel2Observations({
      vertices,
      centroid,
      landClass,
      existingHistory: body.existingHistory ?? existing?.ndviHistory,
      forceRefresh: Boolean(body.forceRefresh),
    });

    if (existing) {
      const idx = parcelsStore.findIndex((p) => p.id === existing.id);
      if (idx !== -1) {
        parcelsStore[idx] = {
          ...parcelsStore[idx],
          ndviHistory: result.observations,
          satelliteSourceLabel: result.sourceLabel,
        };
        void infraBridge.persistParcelPostgis(parcelsStore[idx]);
      }
    }

    res.json(result);
  });

  // External 24/7 Notifications: Web Push VAPID (RFC 8291), Telegram Bot API & Transactional Email
  app.get('/api/notifications/webpush/vapid-public-key', (_req, res) => {
    res.json({
      publicKey: webPushHub.getPublicKey(),
      vapidEnvConfigured: webPushHub.isEnvConfigured(),
      activeSubscriptionsCount: webPushHub.getSubscriptionCount(),
    });
  });

  app.post('/api/notifications/webpush/subscribe', (req, res) => {
    const subscription = req.body?.subscription as PushSubscription | undefined;
    if (!subscription?.endpoint) {
      res.status(400).json({ error: 'Subscrição PushManager inválida.' });
      return;
    }
    const outcome = webPushHub.registerSubscription(subscription);
    res.json({
      ok: outcome.ok,
      activeSubscriptionsCount: outcome.count,
    });
  });

  app.post('/api/notifications/dispatch', async (req, res) => {
    const body = req.body as {
      parcelId?: string;
      headline?: string;
      detail?: string;
      chatId?: string;
      recipientEmail?: string;
    };
    const parcel =
      (body.parcelId ? parcelsStore.find((p) => p.id === body.parcelId) : undefined) ??
      parcelsStore[0];
    const headline =
      body.headline?.trim() ||
      `Vigilância preventiva ativa para ${parcel.label} (${parcel.municipality})`;
    const detail =
      body.detail?.trim() ||
      `Faixa exigível ${parcel.spatial.mandatoryCleanAreaM2.toFixed(0)} m² · Declive ${parcel.avgSlopePct}% · NDVI ${(parcel.ndviHistory[parcel.ndviHistory.length - 1]?.ndvi ?? 0.62).toFixed(2)}.`;
    const appUrl = `${(process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')}/?parcel=${encodeURIComponent(parcel.id)}`;

    const telegramText = formatTelegramHazardAlertPt({
      parcelLabel: parcel.label,
      municipality: parcel.municipality,
      headline,
      detail,
      appUrl,
    });

    const receipts: ExternalChannelReceipt[] = await Promise.all([
      webPushHub.broadcastPush({
        title: `FaixaSegura · ${parcel.label}`,
        body: `${headline} — ${detail}`,
        url: `/?parcel=${encodeURIComponent(parcel.id)}&autostart=1`,
        tag: `faixasegura-${parcel.id}`,
      }),
      dispatchTelegramAlert({
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: body.chatId || process.env.TELEGRAM_DEFAULT_CHAT_ID,
        text: telegramText,
      }),
      ...(body.recipientEmail?.trim()
        ? [
            dispatchTransactionalEmailOrWebhook({
              resendApiKey: process.env.RESEND_API_KEY,
              fromEmail: process.env.RESEND_FROM_EMAIL,
              smtpWebhookUrl: process.env.SMTP_WEBHOOK_URL,
              toEmails: [body.recipientEmail.trim()],
              subject: `[FaixaSegura] Alerta de Terreno — ${parcel.label}`,
              textBody: `${headline}\n${detail}\n\nAbrir Raio-X: ${appUrl}`,
            }),
          ]
        : []),
    ]);

    const deliveredChannels = receipts.filter((r) => r.delivered).length;
    const summaryPt =
      deliveredChannels > 0
        ? `Alerta expedido com sucesso em ${deliveredChannels}/${receipts.length} canal(is) externo(s).`
        : receipts.map((r) => `${r.channel}: ${r.detailPt}`).join(' · ');

    res.json({
      parcelId: parcel.id,
      deliveredChannels,
      receipts,
      summaryPt,
    });
  });

  app.post('/api/parcels', async (req, res) => {
    const body = req.body as Partial<ParcelRecord> & { dico?: string };
    if (!body.label || !Array.isArray(body.vertices) || body.vertices.length < 3) {
      res.status(400).json({ error: 'Indique uma designação e pelo menos 3 vértices geográficos para o lote.' });
      return;
    }

    const muni = MUNICIPALITIES.find((m) => m.dico === body.dico) ?? MUNICIPALITIES[0];
    const landClass = body.landClass ?? 'FOREST_SCRUB';
    const hasEredesInput = Boolean(body.hasEredesLine);
    const eredesTypeInput: ParcelRecord['eredesType'] = hasEredesInput
      ? body.eredesType && body.eredesType !== 'Sem linha aérea'
        ? body.eredesType
        : 'MT 15kV (Faixa 7m)'
      : 'Sem linha aérea';

    const requestedId =
      typeof body.id === 'string' && /^[a-zA-Z0-9_-]{2,128}$/.test(body.id)
        ? body.id
        : `parcel-${Date.now()}`;

    const existingMatch = parcelsStore.find((p) => p.id === requestedId);
    const vectorContext =
      body.vectorContext ??
      (await fetchLiveParcelVectorContext({
        vertices: body.vertices,
        buildingCenter: body.buildingCenter ?? existingMatch?.buildingCenter,
        hasEredesLine: hasEredesInput,
        eredesType: eredesTypeInput,
        hasProtectedOaks: Boolean(body.hasProtectedOaks),
        timeoutMs: 3200,
      }));

    const detectedPower = vectorContext.easements.some(
      (e) => e.category === 'EREDES_MT_AT' || e.category === 'REN_MAT'
    );
    const hasEredesLine = hasEredesInput || detectedPower;
    const eredesType: ParcelRecord['eredesType'] = hasEredesLine
      ? eredesTypeInput !== 'Sem linha aérea'
        ? eredesTypeInput
        : 'MT 15kV (Faixa 7m)'
      : 'Sem linha aérea';

    const spatial = computeParcelFgc({
      vertices: body.vertices,
      buildingCenter: body.buildingCenter ?? existingMatch?.buildingCenter,
      landClass,
      hasEredesLine,
      eredesType,
      vectorContext,
    });

    const cleanUserNotes =
      typeof body.userNotes === 'string'
        ? body.userNotes.trim().slice(0, 2000)
        : (existingMatch?.userNotes ?? '');

    let computedSlopePct =
      body.avgSlopePct !== undefined ? Number(body.avgSlopePct) : existingMatch?.avgSlopePct;
    let resolvedElevationMeta = body.elevationMeta ?? existingMatch?.elevationMeta;
    if (computedSlopePct === undefined || Number.isNaN(computedSlopePct)) {
      const liveSlope = await fetchRealParcelTerrainSlope({
        vertices: body.vertices,
        centroid: spatial.centroidWgs84,
        timeoutMs: 2800,
      });
      computedSlopePct = liveSlope?.avgSlopePct ?? 12.5;
      resolvedElevationMeta = liveSlope?.elevationMeta ?? resolvedElevationMeta;
    }

    const newParcel: ParcelRecord = {
      id: requestedId,
      label: body.label.trim(),
      parish: body.parish?.trim() || existingMatch?.parish || muni.name,
      municipality: muni.name,
      district: body.district?.trim() || muni.district,
      dico: muni.dico,
      dicofre: muni.dicofreDefault,
      matrixArticle: body.matrixArticle?.trim() || 'Rústico — Art.º 204, Secção D',
      bupiRggId: body.bupiRggId?.trim() || `RGG-${Math.floor(100000 + Math.random() * 899999)}`,
      landClass,
      avgSlopePct: computedSlopePct,
      elevationMeta: resolvedElevationMeta,
      hasPavedAccess: true,
      roadFrontageM: 24,
      hazardLevel: 4,
      isPriorityParish: muni.isPriorityParishDefault,
      hasProtectedOaks: Boolean(body.hasProtectedOaks),
      protectedOakNotes: body.hasProtectedOaks
        ? 'Exemplares de Sobreiro/Azinheira assinalados — corte interdito sem autorização ICNF (DL 169/2001).'
        : 'Sem quercíneas protegidas assinaladas no polígono.',
      userNotes: cleanUserNotes,
      vertices: body.vertices,
      buildingCenter: body.buildingCenter ?? existingMatch?.buildingCenter ?? spatial.centroidWgs84,
      hasEredesLine,
      eredesType,
      ndviHistory:
        Array.isArray(body.ndviHistory) && body.ndviHistory.length > 0
          ? body.ndviHistory
          : existingMatch?.ndviHistory ?? [
              { date: '2026-03-15', ndvi: 0.43, ndmi: 0.28, cloudCoverPct: 7 },
              { date: '2026-04-02', ndvi: 0.51, ndmi: 0.23, cloudCoverPct: 10 },
              { date: '2026-04-18', ndvi: 0.57, ndmi: 0.19, cloudCoverPct: 6 },
              { date: '2026-05-04', ndvi: 0.63, ndmi: 0.15, cloudCoverPct: 8 },
            ],
      satelliteSourceLabel: body.satelliteSourceLabel ?? existingMatch?.satelliteSourceLabel,
      neighborInfo: existingMatch?.neighborInfo ?? {
        bupiRef: 'Confrontação Poente (Titular a apurar pela Câmara)',
        vegetationDescription: 'Mato contínuo e silvado junto à estrema poente',
        shrubHeightM: 1.75,
        dominantSpecies: 'Pinheiro-bravo, Eucalipto e Silvado',
        ndvi: 0.71,
      },
      vectorContext,
      cvAnalysis: body.cvAnalysis ?? existingMatch?.cvAnalysis,
      spatial,
    };

    void infraBridge.persistParcelPostgis(newParcel);

    const existingIdx = parcelsStore.findIndex((p) => p.id === requestedId);
    if (existingIdx !== -1) {
      parcelsStore[existingIdx] = newParcel;
      res.status(200).json(newParcel);
      return;
    }

    parcelsStore.unshift(newParcel);
    res.status(201).json(newParcel);
  });

  app.put('/api/parcels/:id', async (req, res) => {
    const targetId = req.params.id;
    const idx = parcelsStore.findIndex((p) => p.id === targetId);
    if (idx === -1) {
      res.status(404).json({ error: 'Terreno não encontrado no servidor.' });
      return;
    }
    const existing = parcelsStore[idx];
    const body = req.body as Partial<ParcelRecord> & { dico?: string };
    const muni = MUNICIPALITIES.find((m) => m.dico === (body.dico ?? existing.dico)) ?? MUNICIPALITIES[0];
    const vertices =
      Array.isArray(body.vertices) && body.vertices.length >= 3
        ? body.vertices
        : existing.vertices;
    const verticesChanged = vertices !== existing.vertices;
    const landClass = body.landClass ?? existing.landClass;
    const hasEredesLine =
      body.hasEredesLine !== undefined ? Boolean(body.hasEredesLine) : existing.hasEredesLine;
    const eredesType: ParcelRecord['eredesType'] = hasEredesLine
      ? existing.eredesType !== 'Sem linha aérea'
        ? existing.eredesType
        : 'MT 15kV (Faixa 7m)'
      : 'Sem linha aérea';
    const hasProtectedOaks =
      body.hasProtectedOaks !== undefined ? Boolean(body.hasProtectedOaks) : existing.hasProtectedOaks;

    const vectorContext =
      body.vectorContext ??
      (verticesChanged
        ? await fetchLiveParcelVectorContext({
            vertices,
            hasEredesLine,
            eredesType,
            hasProtectedOaks,
            timeoutMs: 3200,
          })
        : existing.vectorContext);

    const spatial = computeParcelFgc({
      vertices,
      buildingCenter: verticesChanged ? undefined : existing.buildingCenter,
      landClass,
      hasEredesLine,
      eredesType,
      vectorContext,
    });

    const updated: ParcelRecord = {
      ...existing,
      label: body.label?.trim() || existing.label,
      parish: body.parish?.trim() || existing.parish,
      municipality: muni.name,
      district: body.district?.trim() || muni.district,
      dico: muni.dico,
      dicofre: muni.dico !== existing.dico ? muni.dicofreDefault : existing.dicofre,
      matrixArticle: body.matrixArticle?.trim() || existing.matrixArticle,
      bupiRggId: body.bupiRggId?.trim() || existing.bupiRggId,
      landClass,
      avgSlopePct: body.avgSlopePct !== undefined ? Number(body.avgSlopePct) : existing.avgSlopePct,
      hasEredesLine,
      eredesType,
      hasProtectedOaks,
      protectedOakNotes: hasProtectedOaks
        ? 'Exemplares de Sobreiro/Azinheira assinalados — corte interdito sem autorização ICNF (DL 169/2001).'
        : 'Sem quercíneas protegidas assinaladas no polígono.',
      userNotes:
        typeof body.userNotes === 'string'
          ? body.userNotes.trim().slice(0, 2000)
          : (existing.userNotes ?? ''),
      vertices,
      buildingCenter: verticesChanged ? spatial.centroidWgs84 : existing.buildingCenter,
      vectorContext,
      cvAnalysis: body.cvAnalysis ?? (verticesChanged ? undefined : existing.cvAnalysis),
      elevationMeta: body.elevationMeta ?? existing.elevationMeta,
      satelliteSourceLabel: body.satelliteSourceLabel ?? existing.satelliteSourceLabel,
      spatial,
    };

    parcelsStore[idx] = updated;
    void infraBridge.persistParcelPostgis(updated);
    res.json(updated);
  });

  app.delete('/api/parcels/:id', (req, res) => {
    const targetId = req.params.id;
    const idx = parcelsStore.findIndex((p) => p.id === targetId);
    if (idx === -1) {
      res.status(204).end();
      return;
    }
    if (parcelsStore.length <= 1) {
      res.status(400).json({ error: 'Deve manter pelo menos um terreno ativo.' });
      return;
    }
    parcelsStore.splice(idx, 1);
    res.status(204).end();
  });

  // 5. Issue SHA-256 Compliance Certificate
  app.post('/api/certificates', async (req, res) => {
    const {
      parcelId,
      ownerName,
      ownerNif,
      pirLevelAtWork,
      executionMode,
      contractorName,
      contractorNif,
      invoiceRef,
      photos,
    } = req.body as {
      parcelId?: string;
      ownerName?: string;
      ownerNif?: string;
      pirLevelAtWork?: PirLevel;
      executionMode?: 'CONTRACTOR' | 'SELF';
      contractorName?: string;
      contractorNif?: string;
      invoiceRef?: string;
      photos?: ComplianceCertificate['photos'];
    };

    if (!parcelId || !ownerName?.trim() || !ownerNif?.trim() || ownerNif.replace(/\D/g, '').length !== 9) {
      res.status(400).json({ error: 'Preencha o nome completo do titular e um NIF válido de 9 dígitos.' });
      return;
    }

    const parcel = parcelsStore.find((p) => p.id === parcelId) ?? parcelsStore[0];
    const issuedAt = new Date().toISOString();
    const dateCompact = issuedAt.slice(0, 10).replace(/-/g, '');
    const randHex = Math.random().toString(16).slice(2, 6).toUpperCase();
    const shortCode = `FS-${dateCompact}-${randHex}`;
    const pir = pirLevelAtWork ?? 2;

    const canonical = buildCanonicalCertificatePayload({
      shortCode,
      parcelId: parcel.id,
      dico: parcel.dico,
      ownerNif,
      cleanedAreaM2: parcel.spatial.mandatoryCleanAreaM2,
      pirLevelAtWork: pir,
      issuedAt,
    });
    const sha256Hash = await computeSha256Hex(canonical);

    const cert: ComplianceCertificate = {
      id: `cert-${Date.now()}`,
      shortCode,
      parcelId: parcel.id,
      parcelLabel: parcel.label,
      municipality: parcel.municipality,
      parish: parcel.parish,
      dico: parcel.dico,
      dicofre: parcel.dicofre,
      matrixArticle: parcel.matrixArticle,
      bupiRggId: parcel.bupiRggId,
      ownerName: ownerName.trim(),
      ownerNif: ownerNif.replace(/\s+/g, ''),
      cleanedAreaM2: parcel.spatial.mandatoryCleanAreaM2,
      pirLevelAtWork: pir,
      executionMode: executionMode ?? 'SELF',
      contractorName: contractorName?.trim(),
      contractorNif: contractorNif?.trim(),
      invoiceRef: invoiceRef?.trim(),
      photos:
        Array.isArray(photos) && photos.length > 0
          ? photos
          : INITIAL_CERTIFICATES[0].photos,
      protectedSpeciesCheck: parcel.protectedOakNotes,
      sha256Hash,
      issuedAt,
      spatialSnapshot: parcel.spatial,
    };

    certificatesStore.unshift(cert);
    void infraBridge.persistCertificate(cert);
    res.status(201).json(cert);
  });

  // Public Certificate Verification (/api/verify/:shortCode)
  app.get('/api/verify/:shortCode', (req, res) => {
    const code = req.params.shortCode.trim().replace(/^#/, '').toUpperCase();
    const cert = certificatesStore.find(
      (c) =>
        c.shortCode.toUpperCase() === code ||
        c.sha256Hash.toUpperCase() === code ||
        c.id.toUpperCase() === code
    );
    if (!cert) {
      res.status(404).json({ error: 'Certificado não encontrado no registo criptográfico.' });
      return;
    }
    res.json(cert);
  });

  // 6. Generate Formal Neighbor Risk Petition + Municipal GTF SIG Dossier
  app.post('/api/neighbor-complaints', async (req, res) => {
    const {
      parcelId,
      complainantName,
      complainantNif,
      complainantAddress,
      complainantPhone,
      complainantEmail,
    } = req.body as Record<string, string>;

    if (!complainantName?.trim() || !complainantNif?.trim() || complainantNif.replace(/\D/g, '').length !== 9) {
      res.status(400).json({ error: 'Indique o nome completo do requerente e um NIF válido de 9 dígitos.' });
      return;
    }

    const parcel = parcelsStore.find((p) => p.id === parcelId) ?? parcelsStore[0];
    const issuedAt = new Date().toISOString();
    const reqCode = `REQ-${issuedAt.slice(0, 10).replace(/-/g, '')}-${Math.random().toString(16).slice(2, 6).toUpperCase()}`;

    const nbPoly = parcel.spatial.polygons.neighborRiskParcel;
    const nbLat = nbPoly.reduce((s, p) => s + p.lat, 0) / nbPoly.length;
    const nbLon = nbPoly.reduce((s, p) => s + p.lon, 0) / nbPoly.length;
    const neighborCentroidWgs84 = { lat: Number(nbLat.toFixed(6)), lon: Number(nbLon.toFixed(6)) };
    const neighborCentroidPtTm06 = wgs84ToPtTm06(neighborCentroidWgs84);

    const prompt = `Redige em Português Europeu formal e conciso (máx 2 parágrafos) a exposição técnica de requerimento camarário ao abrigo dos Artigos 49.º, 57.º e 58.º do DL n.º 82/2021 e Despacho n.º 675/2026 para o município de ${parcel.municipality} (DICOFRE ${parcel.dicofre}), reportando prédio confinante a Poente nas coordenadas ${neighborCentroidWgs84.lat}, ${neighborCentroidWgs84.lon} com ${parcel.neighborInfo.dominantSpecies} a ${parcel.spatial.neighborMinDistanceM} metros da fachada habitacional e NDVI Sentinel-2 de ${parcel.neighborInfo.ndvi}.`;

    const aiDraft = await callOllamaWithFallback(prompt, ollamaCircuit.visionModel);

    const deterministicText =
      `1. O prédio confinante identificado nas coordenadas oficiais ETRS89 / PT-TM06 (X: ${neighborCentroidPtTm06.x} m, Y: ${neighborCentroidPtTm06.y} m), freguesia de ${parcel.parish} (DICOFRE ${parcel.dicofre}), encontra-se integralmente abrangido pela Faixa de Gestão de Combustível obrigatória de 50 metros medida a partir da alvenaria exterior da habitação do Requerente, em área classificada com Perigosidade de Incêndio Rural Classe ${parcel.hazardLevel} (ICNF).\n\n` +
      `2. Constata-se no local a presença contínua de ${parcel.neighborInfo.dominantSpecies}, com estrato arbustivo seco de altura estimada em ${parcel.neighborInfo.shrubHeightM.toFixed(2)} m a apenas ${parcel.spatial.neighborMinDistanceM.toFixed(2)} metros da fachada habitacional, em violação direta dos critérios de interface imediata (0-2 m), próxima (2-10 m) e alargada estatuídos no Despacho n.º 675/2026, de 21 de janeiro, e no Artigo 49.º do Decreto-Lei n.º 82/2021. A leitura multiespectral Copernicus Sentinel-2 confirma elevada densidade de carga combustível (NDVI: ${parcel.neighborInfo.ndvi.toFixed(2)}).`;

    const ownCert = certificatesStore.find((c) => c.parcelId === parcel.id);

    const record: NeighborComplaintRecord = {
      id: `req-${Date.now()}`,
      reqCode,
      parcelId: parcel.id,
      municipality: parcel.municipality,
      parish: parcel.parish,
      dicofre: parcel.dicofre,
      complainantName: complainantName.trim(),
      complainantNif: complainantNif.replace(/\s+/g, ''),
      complainantAddress: complainantAddress?.trim() || `Lugar de ${parcel.parish}, ${parcel.municipality}`,
      complainantPhone: complainantPhone?.trim() || '910 000 000',
      complainantEmail: complainantEmail?.trim() || 'proprietario@faixasegura.pt',
      ownCertRef: ownCert?.shortCode,
      minDistanceFacadeM: parcel.spatial.neighborMinDistanceM,
      confrontationSide: 'Poente / Noroeste',
      shrubHeightM: parcel.neighborInfo.shrubHeightM,
      dominantSpecies: parcel.neighborInfo.dominantSpecies,
      neighborNdvi: parcel.neighborInfo.ndvi,
      hazardClassLabel: `Classe ${parcel.hazardLevel} (Alta/Muito Alta ICNF)`,
      formalPetitionText: aiDraft.text || deterministicText,
      neighborCentroidWgs84,
      neighborCentroidPtTm06,
      neighborPolygon: nbPoly,
      buildingPolygon: parcel.spatial.polygons.buildingFootprint,
      issuedAt,
    };

    neighborComplaintsStore.unshift(record);
    res.status(201).json({ record, aiProvider: aiDraft.provider });
  });

  // Municipal GTF 1-click GeoJSON & KML endpoints
  app.get('/api/gtf/:reqCode/geojson', (req, res) => {
    const rec = neighborComplaintsStore.find((r) => r.reqCode === req.params.reqCode);
    const fallbackParcel = parcelsStore[0];
    const geojson = buildMunicipalGtfGeoJson({
      reqCode: rec?.reqCode ?? req.params.reqCode,
      municipality: rec?.municipality ?? fallbackParcel.municipality,
      dicofre: rec?.dicofre ?? fallbackParcel.dicofre,
      minDistanceFacadeM: rec?.minDistanceFacadeM ?? fallbackParcel.spatial.neighborMinDistanceM,
      neighborNdvi: rec?.neighborNdvi ?? fallbackParcel.neighborInfo.ndvi,
      neighborPolygon: rec?.neighborPolygon ?? fallbackParcel.spatial.polygons.neighborRiskParcel,
      buildingPolygon: rec?.buildingPolygon ?? fallbackParcel.spatial.polygons.buildingFootprint,
    });
    res.setHeader('Content-Type', 'application/geo+json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.reqCode}.geojson"`);
    res.send(geojson);
  });

  app.get('/api/gtf/:reqCode/kml', (req, res) => {
    const rec = neighborComplaintsStore.find((r) => r.reqCode === req.params.reqCode);
    const fallbackParcel = parcelsStore[0];
    const kml = buildMunicipalGtfKml({
      reqCode: rec?.reqCode ?? req.params.reqCode,
      municipality: rec?.municipality ?? fallbackParcel.municipality,
      minDistanceFacadeM: rec?.minDistanceFacadeM ?? fallbackParcel.spatial.neighborMinDistanceM,
      neighborPolygon: rec?.neighborPolygon ?? fallbackParcel.spatial.polygons.neighborRiskParcel,
    });
    res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.reqCode}.kml"`);
    res.send(kml);
  });

  // 7. Private Caderneta Predial Extraction & Legal Field Assistant (ollama.innovaive.com + Fallback)
  app.post('/api/ai/caderneta', async (req, res) => {
    const { rawText } = req.body as { rawText?: string };
    if (!rawText?.trim()) {
      res.status(400).json({ error: 'Cole o texto ou dados da Caderneta Predial para extração.' });
      return;
    }

    const lower = rawText.toLowerCase();
    const matchedMuni =
      MUNICIPALITIES.find((m) => lower.includes(m.name.toLowerCase())) ?? MUNICIPALITIES[0];

    const artMatch = rawText.match(/artigo\s*(?:matricial)?\s*[:n.º]*\s*([0-9A-Za-z-]+)/i);
    const secMatch = rawText.match(/sec[çc][ãa]o\s*[:]*\s*([A-Z0-9]+)/i);

    const center = matchedMuni.defaultCenter;
    const extractedVertices = [
      { lat: Number((center.lat - 0.00034).toFixed(6)), lon: Number((center.lon - 0.00044).toFixed(6)) },
      { lat: Number((center.lat + 0.00036).toFixed(6)), lon: Number((center.lon - 0.00041).toFixed(6)) },
      { lat: Number((center.lat + 0.00038).toFixed(6)), lon: Number((center.lon + 0.00045).toFixed(6)) },
      { lat: Number((center.lat - 0.00032).toFixed(6)), lon: Number((center.lon + 0.00042).toFixed(6)) },
    ];

    res.json({
      district: matchedMuni.district,
      municipality: matchedMuni.name,
      dico: matchedMuni.dico,
      matrixArticle: `Rústico — Art.º ${artMatch?.[1] || '218'}, Secção ${secMatch?.[1] || 'F'}`,
      suggestedLabel: `Prédio Caderneta · ${matchedMuni.name}`,
      hasProtectedOaks: lower.includes('sobreir') || lower.includes('azinheir'),
      vertices: extractedVertices,
      rgpdNote: 'Processamento efémero concluído sem retenção externa de dados fiscais.',
    });
  });

  app.post('/api/ai/legal-assistant', async (req, res) => {
    const { question } = req.body as { question?: string };
    if (!question?.trim()) {
      res.status(400).json({ error: 'Escreva uma dúvida concreta sobre limpeza de terrenos ou maquinaria.' });
      return;
    }

    const deterministic = answerLegalFieldQuestion(question);
    const ollamaResp = await callOllamaWithFallback(
      `Responde em Português de Portugal de forma curta e rigorosa citando o Decreto-Lei n.º 82/2021 e Despacho n.º 675/2026 à pergunta de um proprietário rural: "${question}"`,
      ollamaCircuit.textModel
    );

    res.json({
      answer: ollamaResp.text || deterministic.answer,
      legalBasis: deterministic.legalBasis,
      keyAction: deterministic.keyAction,
      provider: ollamaResp.provider,
    });
  });

  // 8. Marketplace Quotes & B2B Forestry Providers (/prestadores)
  app.post('/api/quotes', async (req, res) => {
    const { parcelId, ownerName, ownerPhone, preferredWindow, includeDebrisRemoval } = req.body as {
      parcelId?: string;
      ownerName?: string;
      ownerPhone?: string;
      preferredWindow?: string;
      includeDebrisRemoval?: boolean;
    };

    if (!ownerName?.trim() || !ownerPhone?.trim()) {
      res.status(400).json({ error: 'Indique o seu nome e contacto telefónico/WhatsApp para receber as 3 propostas.' });
      return;
    }

    const parcel = parcelsStore.find((p) => p.id === parcelId) ?? parcelsStore[0];
    const cleanM2 = parcel.spatial.mandatoryCleanAreaM2;
    const slopeFactor = parcel.avgSlopePct > 20 ? 0.48 : 0.34;
    const debrisFactor = includeDebrisRemoval ? 0.14 : 0;
    const lowEst = Math.round(cleanM2 * (slopeFactor + debrisFactor));
    const highEst = Math.round(lowEst * 1.38);

    const matchingProviders = providersStore.filter((pr) => pr.coveredDicos.includes(parcel.dico));
    const providerEmails = matchingProviders.map((pr) => pr.email).filter(Boolean);

    const emailReceipt = await dispatchTransactionalEmailOrWebhook({
      resendApiKey: process.env.RESEND_API_KEY,
      fromEmail: process.env.RESEND_FROM_EMAIL,
      smtpWebhookUrl: process.env.SMTP_WEBHOOK_URL,
      toEmails: providerEmails.length > 0 ? providerEmails : ['bolsa@faixasegura.pt'],
      subject: `[FaixaSegura Parceiros] Novo Pedido de Limpeza — ${parcel.municipality} (${cleanM2.toFixed(0)} m²)`,
      textBody:
        `Terreno: ${parcel.label} (${parcel.municipality} · ${parcel.parish})\n` +
        `Área obrigatória (Z1+Z2+Z3): ${cleanM2.toFixed(0)} m² · Declive MDT: ${parcel.avgSlopePct}%\n` +
        `Janela pretendida: ${preferredWindow || 'Próximos 15 dias'}\n` +
        `Estimativa orientativa: ${lowEst} € – ${highEst} €`,
    });

    if (process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_DEFAULT_CHAT_ID?.trim()) {
      void dispatchTelegramAlert({
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_DEFAULT_CHAT_ID,
        text:
          `🌲 *Novo Pedido na Bolsa FaixaSegura (${process.env.TELEGRAM_PARTNERS_BOT_HANDLE || '@FaixaSeguraParceirosBot'})*\n` +
          `Concelho: *${parcel.municipality}* · Área: *${cleanM2.toFixed(0)} m²* · Declive: *${parcel.avgSlopePct}%*\n` +
          `Intervalo: ${lowEst} € – ${highEst} € (${preferredWindow || 'Próximos 15 dias'})`,
      });
    }

    const newLead: QuoteLead = {
      id: `lead-${Date.now()}`,
      parcelId: parcel.id,
      parcelLabel: parcel.label,
      municipality: parcel.municipality,
      dico: parcel.dico,
      mandatoryCleanAreaM2: cleanM2,
      totalAreaM2: parcel.spatial.totalAreaM2,
      avgSlopePct: parcel.avgSlopePct,
      landClass: parcel.landClass,
      hasPavedAccess: parcel.hasPavedAccess,
      roadFrontageM: parcel.roadFrontageM,
      ndvi: parcel.ndviHistory[parcel.ndviHistory.length - 1]?.ndvi ?? 0.65,
      ownerName: ownerName.trim(),
      ownerPhone: ownerPhone.trim(),
      preferredWindow: preferredWindow || 'Próximos 15 dias',
      includeDebrisRemoval: Boolean(includeDebrisRemoval),
      estimatedBudgetRange: `${lowEst} € – ${highEst} €`,
      matchedProvidersCount: Math.max(matchingProviders.length, 2),
      unlockedByProviderIds: [],
      status: 'OPEN',
      createdAt: new Date().toISOString(),
      dispatchReceiptPt: emailReceipt.detailPt,
    };

    quotesStore.unshift(newLead);
    void infraBridge.persistQuoteLead(newLead);
    res.status(201).json(newLead);
  });

  app.post('/api/quotes/:id/unlock', (req, res) => {
    const lead = quotesStore.find((q) => q.id === req.params.id);
    if (!lead) {
      res.status(404).json({ error: 'Pedido de orçamento não encontrado.' });
      return;
    }
    const providerId = (req.body as { providerId?: string })?.providerId || providersStore[0].id;
    if (!lead.unlockedByProviderIds.includes(providerId)) {
      lead.unlockedByProviderIds.push(providerId);
    }
    lead.status = 'QUOTED';
    res.json(lead);
  });

  app.post('/api/providers', (req, res) => {
    const {
      nif,
      companyName,
      caeCode,
      phoneWhatsapp,
      email,
      hasRcInsurance,
      hasSparkArrestor,
      hasIcnfOakCredential,
      machinery,
      coveredDicos,
      minAreaM2,
    } = req.body as Partial<ForestryProvider>;

    if (!companyName?.trim() || !nif?.trim() || nif.replace(/\D/g, '').length !== 9 || !phoneWhatsapp?.trim()) {
      res.status(400).json({ error: 'Preencha o Nome Comercial, NIF empresarial válido (9 dígitos) e WhatsApp.' });
      return;
    }
    if (!hasRcInsurance) {
      res.status(400).json({ error: 'Seguro de Responsabilidade Civil de Exploração ativo é obrigatório para credenciação.' });
      return;
    }

    const dicos = Array.isArray(coveredDicos) && coveredDicos.length > 0 ? coveredDicos : ['1111'];
    const coveredMunicipalities = MUNICIPALITIES.filter((m) => dicos.includes(m.dico)).map((m) => m.name);

    const created: ForestryProvider = {
      id: `prov-${Date.now()}`,
      nif: nif.replace(/\s+/g, ''),
      companyName: companyName.trim(),
      caeCode: caeCode === '81300' ? '81300' : '02400',
      phoneWhatsapp: phoneWhatsapp.trim(),
      email: email?.trim() || 'contacto@prestadorflorestal.pt',
      hasRcInsurance: true,
      hasSparkArrestor: Boolean(hasSparkArrestor),
      hasIcnfOakCredential: Boolean(hasIcnfOakCredential),
      machinery:
        Array.isArray(machinery) && machinery.length > 0
          ? machinery
          : ['Equipa Apeada (Motorroçadoras / Motosserras)'],
      coveredDicos: dicos,
      coveredMunicipalities,
      minAreaM2: Number(minAreaM2) || 500,
      rating: 5.0,
      completedCertificates: 0,
      verified: true,
    };

    providersStore.unshift(created);
    res.status(201).json(created);
  });

  const PORT = resolveServerPort();

  if (process.env.NODE_ENV !== 'production') {
    // Serve a clean, non-blocking dev Service Worker that purges any stale Workbox warmup caches
    app.get('/sw.js', (_req, res) => {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.send(DEV_SERVICE_WORKER_JS);
    });
    app.get('/registerSW.js', (_req, res) => {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.send("if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {}); }\n");
    });

    let viteMiddleware: express.RequestHandler | null = null;
    let viteInitError: unknown = null;

    // Bind port 3000 immediately so reverse-proxy readiness probes never hit 502 during cold boot
    await new Promise<void>((resolve, reject) => {
      const onListenError = (err: NodeJS.ErrnoException) => {
        console.error(
          `[FaixaSegura] Falha ao abrir porta ${PORT} (${err.code ?? 'ERR'}): verifique conflitos de PORT no .env.`
        );
        reject(err);
      };
      httpServer.once('error', onListenError);
      httpServer.listen(PORT, '0.0.0.0', () => {
        httpServer.removeListener('error', onListenError);
        console.log(`FaixaSegura server listening on http://0.0.0.0:${PORT}`);
        resolve();
      });
    });

    const { createServer: createViteServer } = await import('vite');
    const viteReady = createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr:
          process.env.DISABLE_HMR === 'true'
            ? false
            : {
                server: httpServer,
              },
      },
      appType: 'spa',
    })
      .then((vite) => {
        viteMiddleware = vite.middlewares;
      })
      .catch((err) => {
        viteInitError = err;
        console.error('Failed to initialize Vite dev middleware:', err);
      });

    app.use(async (req, res, next) => {
      if (!viteMiddleware && !viteInitError) {
        await viteReady;
      }
      if (viteMiddleware) {
        viteMiddleware(req, res, next);
        return;
      }
      res.status(500).send('Erro ao inicializar servidor de desenvolvimento.');
    });
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
    httpServer.listen(PORT, '0.0.0.0', () => {
      console.log(`FaixaSegura production server listening on http://0.0.0.0:${PORT}`);
    });
  }
}

startServer();
