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
  NeighborComplaintRecord,
  ParcelRecord,
  PirLevel,
  QuoteLead,
  RealtimeHazardFeedMeta,
  RealtimeHazardsSnapshotPayload,
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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  try {
    const resp = await fetch(`${ollamaCircuit.baseUrl.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    const url = `https://api.ipma.pt/open-data/forecast/meteorology/rcm/rcm-d${dayIndex}.json`;
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

function resolveServerPort(): number {
  const portFlagIndex = process.argv.indexOf('--port');
  if (portFlagIndex !== -1 && process.argv[portFlagIndex + 1]) {
    const parsed = Number(process.argv[portFlagIndex + 1]);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return Number(process.env.PORT || 3000);
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
`;

async function startServer() {
  const app = express();
  const httpServer = createHttpServer(app);
  app.use(express.json({ limit: '6mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'faixasegura', ts: new Date().toISOString() });
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
        const res = await fetch('https://api.apiaberta.pt/v1/anpc/incidents/active', {
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

  // 4. Compute, Save, Update & Delete Custom / Imported Parcel (EPSG:3763)
  app.post('/api/parcels', (req, res) => {
    const body = req.body as Partial<ParcelRecord> & { dico?: string };
    if (!body.label || !Array.isArray(body.vertices) || body.vertices.length < 3) {
      res.status(400).json({ error: 'Indique uma designação e pelo menos 3 vértices geográficos para o lote.' });
      return;
    }

    const muni = MUNICIPALITIES.find((m) => m.dico === body.dico) ?? MUNICIPALITIES[0];
    const landClass = body.landClass ?? 'FOREST_SCRUB';
    const hasEredesLine = Boolean(body.hasEredesLine);
    const spatial = computeParcelFgc({
      vertices: body.vertices,
      landClass,
      hasEredesLine,
      neighborDistanceOverrideM: 4.6,
    });

    const requestedId =
      typeof body.id === 'string' && /^[a-zA-Z0-9_-]{2,128}$/.test(body.id)
        ? body.id
        : `parcel-${Date.now()}`;

    const existingMatch = parcelsStore.find((p) => p.id === requestedId);
    const cleanUserNotes =
      typeof body.userNotes === 'string'
        ? body.userNotes.trim().slice(0, 2000)
        : (existingMatch?.userNotes ?? '');

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
      avgSlopePct: Number(body.avgSlopePct ?? 12.5),
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
      buildingCenter: spatial.centroidWgs84,
      hasEredesLine,
      eredesType: hasEredesLine ? 'MT 15kV (Faixa 7m)' : 'Sem linha aérea',
      ndviHistory: existingMatch?.ndviHistory ?? [
        { date: '2026-03-15', ndvi: 0.43, ndmi: 0.28, cloudCoverPct: 7 },
        { date: '2026-04-02', ndvi: 0.51, ndmi: 0.23, cloudCoverPct: 10 },
        { date: '2026-04-18', ndvi: 0.57, ndmi: 0.19, cloudCoverPct: 6 },
        { date: '2026-05-04', ndvi: 0.63, ndmi: 0.15, cloudCoverPct: 8 },
      ],
      neighborInfo: existingMatch?.neighborInfo ?? {
        bupiRef: 'Confrontação Poente (Titular a apurar pela Câmara)',
        vegetationDescription: 'Mato contínuo e silvado junto à estrema poente',
        shrubHeightM: 1.75,
        dominantSpecies: 'Pinheiro-bravo, Eucalipto e Silvado',
        ndvi: 0.71,
      },
      spatial,
    };

    const existingIdx = parcelsStore.findIndex((p) => p.id === requestedId);
    if (existingIdx !== -1) {
      parcelsStore[existingIdx] = newParcel;
      res.status(200).json(newParcel);
      return;
    }

    parcelsStore.unshift(newParcel);
    res.status(201).json(newParcel);
  });

  app.put('/api/parcels/:id', (req, res) => {
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
    const landClass = body.landClass ?? existing.landClass;
    const hasEredesLine =
      body.hasEredesLine !== undefined ? Boolean(body.hasEredesLine) : existing.hasEredesLine;
    const hasProtectedOaks =
      body.hasProtectedOaks !== undefined ? Boolean(body.hasProtectedOaks) : existing.hasProtectedOaks;

    const spatial = computeParcelFgc({
      vertices,
      landClass,
      hasEredesLine,
      neighborDistanceOverrideM: existing.spatial.neighborMinDistanceM,
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
      eredesType: hasEredesLine ? 'MT 15kV (Faixa 7m)' : 'Sem linha aérea',
      hasProtectedOaks,
      protectedOakNotes: hasProtectedOaks
        ? 'Exemplares de Sobreiro/Azinheira assinalados — corte interdito sem autorização ICNF (DL 169/2001).'
        : 'Sem quercíneas protegidas assinaladas no polígono.',
      userNotes:
        typeof body.userNotes === 'string'
          ? body.userNotes.trim().slice(0, 2000)
          : (existing.userNotes ?? ''),
      vertices,
      buildingCenter: spatial.centroidWgs84,
      spatial,
    };

    parcelsStore[idx] = updated;
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
  app.post('/api/quotes', (req, res) => {
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
    };

    quotesStore.unshift(newLead);
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
    await new Promise<void>((resolve) => {
      httpServer.listen(PORT, '0.0.0.0', () => {
        console.log(`FaixaSegura server listening on http://0.0.0.0:${PORT}`);
        resolve();
      });
    });

    const { createServer: createViteServer } = await import('vite');
    const viteReady = createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        ws: {
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
