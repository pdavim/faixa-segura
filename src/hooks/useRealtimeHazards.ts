import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ActiveFireIncident,
  LatLon,
  RealtimeHazardFeedMeta,
  RealtimeHazardsSnapshotPayload,
  StormAlertIncident,
} from '../types/domain.ts';
import {
  FALLBACK_ACTIVE_FIRES,
  FALLBACK_ACTIVE_STORMS,
} from '../data/seedCatalog.ts';

function dedupeById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function formatUpdatedClockPt(isoStr?: string): string {
  try {
    const dt = isoStr ? new Date(isoStr) : new Date();
    const hm = dt.toLocaleTimeString('pt-PT', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    return `Hoje às ${hm}`;
  } catch {
    return 'Agora mesmo';
  }
}

const DEFAULT_OFFLINE_META: RealtimeHazardFeedMeta = {
  connected: false,
  transport: 'offline',
  anepcLive: false,
  ipmaLive: false,
  anepcSourceLabel: 'Contingência Regional Offline',
  ipmaSourceLabel: 'Contingência Meteorológica Regional',
  anepcNational: null,
  ipmaActiveWarningsCount: 0,
  activeFireIncidentsCount: FALLBACK_ACTIVE_FIRES.length,
  activeWeatherIncidentsCount: FALLBACK_ACTIVE_STORMS.length,
  lastUpdatedIso: new Date().toISOString(),
};

export function useRealtimeHazards(params: {
  isOnline: boolean;
  referenceCoord: LatLon;
}) {
  const { isOnline, referenceCoord } = params;
  const refCoordRef = useRef<LatLon>(referenceCoord);
  refCoordRef.current = referenceCoord;

  const [rawFires, setRawFires] = useState<Omit<ActiveFireIncident, 'distanceKm'>[]>(
    () => FALLBACK_ACTIVE_FIRES
  );
  const [rawStorms, setRawStorms] = useState<StormAlertIncident[]>(
    () => FALLBACK_ACTIVE_STORMS
  );
  const [feedMeta, setFeedMeta] = useState<RealtimeHazardFeedMeta>(() => DEFAULT_OFFLINE_META);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [lastCheckedAtLabel, setLastCheckedAtLabel] = useState<string>('A sincronizar...');

  const wsRef = useRef<WebSocket | null>(null);

  const applyAuthoritativeSnapshot = useCallback(
    (
      payload: Partial<RealtimeHazardsSnapshotPayload> & {
        fires?: Array<ActiveFireIncident | Omit<ActiveFireIncident, 'distanceKm'>>;
        storms?: StormAlertIncident[];
      },
      transportOverride?: RealtimeHazardFeedMeta['transport']
    ) => {
      if (Array.isArray(payload.fires)) {
        const stripped = payload.fires.map((f) => {
          const { distanceKm: _omit, ...rest } = f as ActiveFireIncident;
          return rest;
        });
        setRawFires(dedupeById(stripped));
      }

      if (Array.isArray(payload.storms)) {
        setRawStorms(dedupeById(payload.storms));
      }

      const updatedIso = payload.updatedAtIso || payload.meta?.lastUpdatedIso || new Date().toISOString();
      setLastCheckedAtLabel(formatUpdatedClockPt(updatedIso));

      if (payload.meta) {
        setFeedMeta((prev) => ({
          ...payload.meta!,
          connected: true,
          transport:
            transportOverride ??
            (prev.transport === 'websocket' || prev.transport === 'sse'
              ? prev.transport
              : payload.meta!.transport),
        }));
      }
    },
    []
  );

  const fetchHttpSnapshot = useCallback(async () => {
    if (!isOnline) {
      setRawFires(FALLBACK_ACTIVE_FIRES);
      setRawStorms(FALLBACK_ACTIVE_STORMS);
      setFeedMeta({ ...DEFAULT_OFFLINE_META, lastUpdatedIso: new Date().toISOString() });
      setLastCheckedAtLabel('Modo Offline (cache regional)');
      return;
    }

    try {
      const c = refCoordRef.current;
      const resp = await fetch(`/api/hazards/active?lat=${c.lat}&lon=${c.lon}`);
      if (resp.ok) {
        const data = (await resp.json()) as RealtimeHazardsSnapshotPayload;
        applyAuthoritativeSnapshot(data);
      }
    } catch {
      // Keep last known authoritative snapshot on transient error
    }
  }, [isOnline, applyAuthoritativeSnapshot]);

  const forceRefresh = useCallback(async () => {
    if (!isOnline) {
      setLastCheckedAtLabel('Modo Offline (cache regional)');
      return;
    }

    setIsRefreshing(true);
    try {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(JSON.stringify({ type: 'hazards:refresh' }));
        } catch {
          // Proceed with HTTP refresh as authoritative confirmation
        }
      }

      const c = refCoordRef.current;
      const resp = await fetch('/api/hazards/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: c.lat, lon: c.lon }),
      });
      if (resp.ok) {
        const data = (await resp.json()) as RealtimeHazardsSnapshotPayload;
        applyAuthoritativeSnapshot(data);
      }
    } catch {
      // Silent resilience
    } finally {
      setIsRefreshing(false);
    }
  }, [isOnline, applyAuthoritativeSnapshot]);

  useEffect(() => {
    if (!isOnline || typeof window === 'undefined') {
      setFeedMeta((prev) => ({ ...prev, connected: false, transport: 'offline' }));
      setLastCheckedAtLabel('Modo Offline (cache regional)');
      return;
    }

    let disposed = false;
    let reconnectTimer: number | null = null;
    let eventSource: EventSource | null = null;
    let wsFailures = 0;

    // 1. Immediate HTTP bootstrap so UI renders live IPMA + ANEPC data without waiting
    void fetchHttpSnapshot();

    const closeAllTransports = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (wsRef.current) {
        try {
          wsRef.current.onclose = null;
          wsRef.current.onerror = null;
          wsRef.current.onmessage = null;
          wsRef.current.close();
        } catch {
          // Ignore close errors
        }
        wsRef.current = null;
      }
      if (eventSource) {
        try {
          eventSource.close();
        } catch {
          // Ignore close errors
        }
        eventSource = null;
      }
    };

    const connectSseFallback = () => {
      if (disposed || typeof EventSource === 'undefined') return;
      try {
        const es = new EventSource('/api/hazards/stream');
        eventSource = es;

        es.addEventListener('hazards:snapshot', (ev) => {
          if (disposed) return;
          try {
            const parsed = JSON.parse((ev as MessageEvent).data) as RealtimeHazardsSnapshotPayload;
            applyAuthoritativeSnapshot(parsed, 'sse');
          } catch {
            // Ignore malformed SSE frame
          }
        });

        es.onopen = () => {
          if (disposed) return;
          setFeedMeta((prev) => ({ ...prev, connected: true, transport: 'sse' }));
        };

        es.onerror = () => {
          if (disposed) return;
          es.close();
          eventSource = null;
          reconnectTimer = window.setTimeout(() => {
            if (!disposed) connectWebSocket();
          }, 6000);
        };
      } catch {
        // Fallback to periodic HTTP sync if EventSource unavailable
      }
    };

    const connectWebSocket = () => {
      if (disposed) return;
      try {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${window.location.host}/ws/hazards`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (disposed) return;
          wsFailures = 0;
          setFeedMeta((prev) => ({ ...prev, connected: true, transport: 'websocket' }));
        };

        ws.onmessage = (event) => {
          if (disposed) return;
          try {
            const msg = JSON.parse(String(event.data)) as {
              type?: string;
              payload?: RealtimeHazardsSnapshotPayload;
            };
            if (msg?.type === 'hazards:snapshot' && msg.payload) {
              applyAuthoritativeSnapshot(msg.payload, 'websocket');
            }
          } catch {
            // Ignore non-JSON frames
          }
        };

        ws.onclose = () => {
          if (disposed) return;
          wsRef.current = null;
          wsFailures += 1;
          if (wsFailures >= 2) {
            connectSseFallback();
            return;
          }
          const delay = Math.min(12_000, 2000 * wsFailures);
          reconnectTimer = window.setTimeout(() => {
            if (!disposed) connectWebSocket();
          }, delay);
        };

        ws.onerror = () => {
          try {
            ws.close();
          } catch {
            // Handled by onclose
          }
        };
      } catch {
        connectSseFallback();
      }
    };

    connectWebSocket();

    return () => {
      disposed = true;
      closeAllTransports();
    };
  }, [isOnline, fetchHttpSnapshot, applyAuthoritativeSnapshot]);

  return {
    rawFires,
    rawStorms,
    feedMeta,
    isRefreshing,
    lastCheckedAtLabel,
    forceRefresh,
  };
}
