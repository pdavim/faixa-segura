import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  Check,
  CloudLightning,
  Eye,
  Flame,
  LocateFixed,
  MapPin,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  Trees,
} from 'lucide-react';
import type {
  ParcelRecord,
  ProximityRadiusKm,
  RealtimeHazardFeedMeta,
  UserAppSettings,
} from '../types/domain.ts';
import {
  formatLandClassPt,
  type MultiParcelHazardEvaluation,
  type ParcelHazardSummary,
  type ParcelProximityAlert,
} from '../lib/parcelHazardMonitor.ts';

type HazardFilterTab = 'ALL' | 'FIRE' | 'STORM';

interface ParcelHazardControlPanelProps {
  parcels: ParcelRecord[];
  activeParcelId: string;
  evaluation: MultiParcelHazardEvaluation;
  userSettings: UserAppSettings;
  feedMeta?: RealtimeHazardFeedMeta;
  hasActiveSimulation: boolean;
  isRefreshing: boolean;
  lastCheckedAtLabel: string;
  notificationPermissionState: 'unsupported' | 'default' | 'granted' | 'denied';
  onUpdateSettings: (next: UserAppSettings) => void;
  onRefreshHazards: () => void;
  onSelectParcel: (parcelId: string) => void;
  onFocusParcelOnMap: (parcelId: string) => void;
  onToggleAcknowledgeAlert: (alertId: string) => void;
  onSimulateFireNearParcel: (parcel: ParcelRecord) => void;
  onSimulateStormNearParcel: (parcel: ParcelRecord) => void;
  onClearSimulations: () => void;
  onRequestBrowserNotifications: () => void;
}

function ParcelStatusIndicator({ summary }: { summary: ParcelHazardSummary }) {
  if (summary.status === 'CRITICAL') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#DC2626] dark:text-rose-400 whitespace-nowrap">
        <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span>Alerta Crítico ({summary.activeAlertsCount})</span>
      </span>
    );
  }
  if (summary.status === 'WARNING') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#B45309] dark:text-[#FBBF24] whitespace-nowrap">
        <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span>Em Vigilância ({summary.activeAlertsCount})</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#14532D] dark:text-[#4ADE80] whitespace-nowrap">
      <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span>Perímetro Seguro</span>
    </span>
  );
}

export const ParcelHazardControlPanel: React.FC<ParcelHazardControlPanelProps> = ({
  parcels,
  activeParcelId,
  evaluation,
  userSettings,
  feedMeta,
  hasActiveSimulation,
  isRefreshing,
  lastCheckedAtLabel,
  notificationPermissionState,
  onUpdateSettings,
  onRefreshHazards,
  onSelectParcel,
  onFocusParcelOnMap,
  onToggleAcknowledgeAlert,
  onSimulateFireNearParcel,
  onSimulateStormNearParcel,
  onClearSimulations,
  onRequestBrowserNotifications,
}) => {
  const [filterTab, setFilterTab] = useState<HazardFilterTab>('ALL');
  const [showAcknowledged, setShowAcknowledged] = useState<boolean>(false);
  const [simulationTargetId, setSimulationTargetId] = useState<string>(() => {
    const firstForest = parcels.find((p) => p.landClass === 'FOREST_SCRUB');
    return firstForest?.id ?? parcels[0]?.id ?? activeParcelId;
  });

  const resolvedSimParcel = useMemo(
    () =>
      parcels.find((p) => p.id === simulationTargetId) ??
      parcels.find((p) => p.id === activeParcelId) ??
      parcels[0],
    [parcels, simulationTargetId, activeParcelId]
  );

  const [dispatchingExternal, setDispatchingExternal] = useState(false);
  const [externalDispatchFeedback, setExternalDispatchFeedback] = useState<string | null>(null);

  const handleDispatchExternalAlert = async (targetParcel: ParcelRecord) => {
    setDispatchingExternal(true);
    setExternalDispatchFeedback(null);
    try {
      const resp = await fetch('/api/notifications/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parcelId: targetParcel.id,
        }),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { summaryPt?: string };
        setExternalDispatchFeedback(
          data.summaryPt || `Despacho externo processado para ${targetParcel.label}.`
        );
      } else {
        setExternalDispatchFeedback('Não foi possível despachar alerta externo neste momento.');
      }
    } catch {
      setExternalDispatchFeedback('Sem ligação ao servidor de despacho externo.');
    } finally {
      setDispatchingExternal(false);
    }
  };

  const visibleAlerts = useMemo(() => {
    return evaluation.alerts.filter((alert) => {
      if (!showAcknowledged && alert.acknowledged) return false;
      if (filterTab === 'FIRE') return alert.category === 'FIRE';
      if (filterTab === 'STORM') return alert.category === 'STORM';
      return true;
    });
  }, [evaluation.alerts, filterTab, showAcknowledged]);

  const acknowledgedCount = evaluation.counts.totalAlerts - evaluation.counts.unacknowledgedCount;
  const fireEnabled = userSettings.enableFireProximityAlerts !== false;
  const stormEnabled = userSettings.enableStormProximityAlerts !== false;
  const isRealtimeStreamActive = Boolean(
    feedMeta?.connected && (feedMeta.anepcLive || feedMeta.ipmaLive)
  );
  const transportLabelPt =
    feedMeta?.transport === 'websocket'
      ? 'WebSocket em Tempo Real'
      : feedMeta?.transport === 'sse'
        ? 'Stream SSE em Tempo Real'
        : feedMeta?.transport === 'http'
          ? 'Ligação Direta HTTP'
          : 'Contingência Offline';

  const renderAlertRow = (alert: ParcelProximityAlert) => {
    const isCritical = alert.urgency === 'CRITICAL';
    const isFire = alert.category === 'FIRE';
    return (
      <div
        key={alert.alertId}
        data-testid={`parcel-proximity-alert-${alert.parcelId}-${alert.category.toLowerCase()}`}
        className={`py-4 first:pt-0 last:pb-0 flex flex-col lg:flex-row lg:items-start justify-between gap-4 ${
          alert.acknowledged ? 'opacity-65' : ''
        }`}
      >
        <div className="min-w-0 space-y-1.5">
          {/* Unboxed semantic kicker line (Zero-Pill Discipline) */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums">
            <span
              className={`inline-flex items-center gap-1 font-semibold ${
                isCritical
                  ? 'text-[#DC2626] dark:text-rose-400'
                  : 'text-[#B45309] dark:text-[#FBBF24]'
              }`}
            >
              {isFire ? (
                <Flame className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <CloudLightning className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              )}
              <span>{isCritical ? 'Alerta Crítico' : 'Aviso Oficial'}</span>
            </span>
            <span aria-hidden="true" className="text-slate-400">
              ·
            </span>
            <span className="font-semibold text-slate-900 dark:text-white">
              {alert.parcelLabel} ({alert.parcelMunicipality})
            </span>
            {alert.isForestScrub && (
              <>
                <span aria-hidden="true" className="text-slate-400">
                  ·
                </span>
                <span className="inline-flex items-center gap-1 font-medium text-[#14532D] dark:text-[#4ADE80]">
                  <Trees className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>Terreno em Mato / Floresta</span>
                </span>
              </>
            )}
            <span aria-hidden="true" className="text-slate-400">
              ·
            </span>
            <span className="font-mono font-bold text-slate-900 dark:text-slate-100">
              {alert.inSameWarnedDistrict
                ? 'No distrito do terreno'
                : `${alert.centerDistanceKm.toFixed(1)} km (${alert.cardinalPt})`}
            </span>
          </div>

          <h3 className="text-sm font-bold text-slate-900 dark:text-white">
            {alert.hazardTitle} — {alert.hazardLocation}
          </h3>

          <p className="text-xs text-slate-600 dark:text-slate-300 tabular-nums">
            {alert.detailLine}
            <span aria-hidden="true"> · </span>
            <span>Fonte: {alert.hazardSource}</span>
          </p>

          <p className="text-xs text-slate-700 dark:text-slate-200 leading-relaxed">
            <strong className="font-semibold text-slate-900 dark:text-white">
              Recomendação preventiva:
            </strong>{' '}
            {alert.protectiveActionPt}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            data-testid={`alert-focus-map-${alert.parcelId}`}
            onClick={() => onFocusParcelOnMap(alert.parcelId)}
            className="min-h-[40px] px-3.5 py-2 rounded-xl bg-[#14532D] hover:bg-[#0F3F22] dark:bg-[#22C55E] dark:hover:bg-[#16A34A] text-white dark:text-slate-950 text-xs font-semibold transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <MapPin className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Ver Terreno no Mapa</span>
          </button>

          <button
            type="button"
            data-testid={`alert-ack-${alert.alertId}`}
            onClick={() => onToggleAcknowledgeAlert(alert.alertId)}
            className="min-h-[40px] px-3 py-2 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            {alert.acknowledged ? (
              <>
                <Eye className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>Reativar Alerta</span>
              </>
            ) : (
              <>
                <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>Marcar como Visto</span>
              </>
            )}
          </button>
        </div>
      </div>
    );
  };

  return (
    <section
      aria-labelledby="parcel-hazard-control-heading"
      data-testid="parcel-hazard-control-panel"
      className="scroll-mt-20 rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 sm:p-6 space-y-5"
    >
      {/* Top Header & Real-Time Official Feeds Status (IPMA + Proteção Civil ANEPC) */}
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4 pb-4 border-b border-slate-200 dark:border-[#263248]">
        <div className="space-y-1.5">
          <div
            data-testid="official-realtime-feed-status"
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600 dark:text-slate-300 tabular-nums"
          >
            <span className="inline-flex items-center gap-1.5 font-semibold text-slate-900 dark:text-white">
              <span
                aria-hidden="true"
                className={`w-2 h-2 rounded-full shrink-0 ${
                  isRealtimeStreamActive ? 'bg-[#16A34A]' : 'bg-amber-500'
                }`}
              />
              <span>
                {isRealtimeStreamActive
                  ? `Ligado à Proteção Civil & IPMA (${transportLabelPt})`
                  : transportLabelPt}
              </span>
            </span>
            <span aria-hidden="true" className="text-slate-400">
              ·
            </span>
            <span>Raio {userSettings.proximityAlertRadiusKm} km (+20% vigia em mato)</span>
            <span aria-hidden="true" className="text-slate-400">
              ·
            </span>
            <span>Sincronizado: {lastCheckedAtLabel}</span>
          </div>

          <h2
            id="parcel-hazard-control-heading"
            className="scroll-mt-20 text-base sm:text-lg font-bold text-slate-900 dark:text-white"
          >
            Controlo em Tempo Real — Proteção Civil (ANEPC) & Avisos IPMA
          </h2>

          <p className="text-xs text-slate-600 dark:text-slate-300 max-w-3xl leading-relaxed">
            Subscreve em tempo real as ocorrências ativas SADO da Autoridade Nacional de Emergência e Proteção Civil e os avisos meteorológicos oficiais do IPMA por distrito e coordenadas, vigiando todas as suas {parcels.length} propriedades registadas.
          </p>

          {feedMeta && (feedMeta.anepcLive || feedMeta.ipmaLive) && (
            <div
              data-testid="official-national-telemetry-line"
              className="pt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums"
            >
              <span>
                {feedMeta.anepcNational
                  ? `ANEPC País: ${feedMeta.anepcNational.totalOccurrences} ocorrências ativas · ${feedMeta.anepcNational.totalOperatives} operacionais · ${feedMeta.anepcNational.totalVehicles} viaturas`
                  : `${feedMeta.anepcSourceLabel}: ${feedMeta.activeFireIncidentsCount} ocorrências monitorizadas`}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                IPMA Oficial: {feedMeta.ipmaActiveWarningsCount} aviso(s) amarelo/laranja/vermelho em vigor
              </span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {notificationPermissionState !== 'unsupported' && (
            <button
              type="button"
              data-testid="hazard-browser-notify-btn"
              onClick={onRequestBrowserNotifications}
              className={`min-h-[40px] px-3 py-2 rounded-xl border text-xs font-semibold transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                userSettings.browserNotificationsEnabled && notificationPermissionState === 'granted'
                  ? 'border-[#14532D] bg-[#14532D]/10 dark:border-[#22C55E] dark:bg-[#22C55E]/15 text-[#14532D] dark:text-[#4ADE80]'
                  : 'border-slate-300 dark:border-[#263248] text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <Bell className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>
                {userSettings.browserNotificationsEnabled && notificationPermissionState === 'granted'
                  ? 'Notificações Ativas'
                  : 'Ativar Alertas no Dispositivo'}
              </span>
            </button>
          )}

          <button
            type="button"
            data-testid="hazard-refresh-radar-btn"
            disabled={isRefreshing}
            onClick={onRefreshHazards}
            className="min-h-[40px] px-3.5 py-2 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 shrink-0 ${isRefreshing ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span>{isRefreshing ? 'A sincronizar...' : 'Sincronizar Agora'}</span>
          </button>
        </div>
      </div>

      {/* Interactive Filter Tabs + Proximity Radius Selector + Channel Switches */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Segmented Category Filter */}
          <div
            role="group"
            aria-label="Filtrar alertas por tipo de risco"
            className="inline-flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248]"
          >
            <button
              type="button"
              data-testid="hazard-filter-all"
              onClick={() => setFilterTab('ALL')}
              className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 tabular-nums ${
                filterTab === 'ALL'
                  ? 'bg-white dark:bg-[#161E2E] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              Todos ({evaluation.counts.totalAlerts})
            </button>
            <button
              type="button"
              data-testid="hazard-filter-fire"
              onClick={() => setFilterTab('FIRE')}
              className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 tabular-nums ${
                filterTab === 'FIRE'
                  ? 'bg-white dark:bg-[#161E2E] text-[#DC2626] dark:text-rose-400 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Flame className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>Incêndios ({evaluation.counts.fireAlertsCount})</span>
            </button>
            <button
              type="button"
              data-testid="hazard-filter-storm"
              onClick={() => setFilterTab('STORM')}
              className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 tabular-nums ${
                filterTab === 'STORM'
                  ? 'bg-white dark:bg-[#161E2E] text-sky-700 dark:text-sky-400 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <CloudLightning className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>Tempestades ({evaluation.counts.stormAlertsCount})</span>
            </button>
          </div>

          {/* Radius Selector */}
          <div
            role="group"
            aria-label="Raio de alerta de proximidade em quilómetros"
            className="inline-flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248]"
          >
            <span className="px-2 text-xs font-medium text-slate-500 dark:text-slate-400 whitespace-nowrap">
              Raio:
            </span>
            {([5, 10, 15, 25] as ProximityRadiusKm[]).map((km) => {
              const active = userSettings.proximityAlertRadiusKm === km;
              return (
                <button
                  key={km}
                  type="button"
                  data-testid={`hazard-radius-${km}km`}
                  onClick={() =>
                    onUpdateSettings({
                      ...userSettings,
                      proximityAlertRadiusKm: km,
                    })
                  }
                  className={`min-h-[36px] px-2.5 py-1 rounded-lg text-xs font-mono font-semibold tabular-nums transition-colors whitespace-nowrap shrink-0 ${
                    active
                      ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                      : 'text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {km} km
                </button>
              );
            })}
          </div>
        </div>

        {/* Toggle Fire / Storm Channels & Field Test Simulation */}
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300 cursor-pointer whitespace-nowrap">
            <input
              type="checkbox"
              checked={fireEnabled}
              onChange={(e) =>
                onUpdateSettings({
                  ...userSettings,
                  enableFireProximityAlerts: e.target.checked,
                })
              }
              className="w-4 h-4 rounded accent-[#14532D]"
            />
            <span>Vigiar Incêndios</span>
          </label>
          <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">
            ·
          </span>
          <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300 cursor-pointer whitespace-nowrap">
            <input
              type="checkbox"
              checked={stormEnabled}
              onChange={(e) =>
                onUpdateSettings({
                  ...userSettings,
                  enableStormProximityAlerts: e.target.checked,
                })
              }
              className="w-4 h-4 rounded accent-[#14532D]"
            />
            <span>Vigiar Tempestades</span>
          </label>
        </div>
      </div>

      {/* Per-Parcel Matrix Across ALL Registered User Properties */}
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            Estado de Segurança por Terreno ({evaluation.counts.affectedParcelsCount} de {parcels.length} com alerta próximo)
          </h3>
          {acknowledgedCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAcknowledged((v) => !v)}
              className="text-xs font-semibold text-[#14532D] dark:text-[#4ADE80] hover:underline whitespace-nowrap"
            >
              {showAcknowledged
                ? 'Ocultar alertas já vistos'
                : `Mostrar alertas vistos (${acknowledgedCount})`}
            </button>
          )}
        </div>

        <div className="overflow-x-auto border border-slate-200 dark:border-[#263248] rounded-xl">
          <table
            data-testid="multi-parcel-hazard-table"
            className="w-full text-left border-collapse text-xs"
          >
            <thead>
              <tr className="bg-slate-50 dark:bg-[#0B0F17] border-b border-slate-200 dark:border-[#263248] text-slate-600 dark:text-slate-400">
                <th className="py-2.5 px-3.5 font-semibold whitespace-nowrap">Terreno / Concelho</th>
                <th className="py-2.5 px-3.5 font-semibold whitespace-nowrap">Ocupação</th>
                <th className="py-2.5 px-3.5 font-semibold text-right whitespace-nowrap">
                  Incêndio Mais Próximo
                </th>
                <th className="py-2.5 px-3.5 font-semibold text-right whitespace-nowrap">
                  Tempestade Mais Próxima
                </th>
                <th className="py-2.5 px-3.5 font-semibold whitespace-nowrap">Estado</th>
                <th className="py-2.5 px-3.5 font-semibold text-right whitespace-nowrap">Ação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-[#263248]">
              {evaluation.orderedParcelSummaries.map((row) => {
                const isSelected = row.parcelId === activeParcelId;
                return (
                  <tr
                    key={row.parcelId}
                    data-testid={`parcel-hazard-row-${row.parcelId}`}
                    className={`transition-colors hover:bg-slate-50/80 dark:hover:bg-slate-800/40 ${
                      isSelected ? 'bg-[#14532D]/5 dark:bg-[#22C55E]/10' : ''
                    }`}
                  >
                    <td className="py-2.5 px-3.5 font-semibold text-slate-900 dark:text-white">
                      <div className="flex items-center gap-2">
                        <span className="truncate max-w-[220px]">{row.parcelLabel}</span>
                        {isSelected && (
                          <span className="text-[11px] font-normal text-[#14532D] dark:text-[#4ADE80] whitespace-nowrap">
                            · Ativo
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] font-normal text-slate-500 dark:text-slate-400">
                        {row.municipality} · {row.parish}
                      </div>
                    </td>

                    <td className="py-2.5 px-3.5 text-slate-700 dark:text-slate-300 whitespace-nowrap">
                      {formatLandClassPt(row.landClass)}
                    </td>

                    <td className="py-2.5 px-3.5 text-right font-mono tabular-nums whitespace-nowrap">
                      {row.nearestFire ? (
                        <span
                          className={
                            row.nearestFire.distanceKm <= row.effectiveWatchRadiusKm
                              ? 'font-bold text-[#DC2626] dark:text-rose-400'
                              : 'text-slate-700 dark:text-slate-300'
                          }
                        >
                          {row.nearestFire.distanceKm.toFixed(1)} km ({row.nearestFire.cardinalPt}) ·{' '}
                          {row.nearestFire.municipality}
                        </span>
                      ) : (
                        <span className="text-slate-400">Sem ocorrências</span>
                      )}
                    </td>

                    <td className="py-2.5 px-3.5 text-right font-mono tabular-nums whitespace-nowrap">
                      {row.nearestStorm ? (
                        <span
                          className={
                            row.nearestStorm.inSameWarnedDistrict ||
                            row.nearestStorm.edgeDistanceKm <= userSettings.proximityAlertRadiusKm
                              ? 'font-bold text-[#B45309] dark:text-[#FBBF24]'
                              : 'text-slate-700 dark:text-slate-300'
                          }
                        >
                          {row.nearestStorm.inSameWarnedDistrict
                            ? `No distrito · Aviso ${
                                row.nearestStorm.severity === 'RED'
                                  ? 'Vermelho'
                                  : row.nearestStorm.severity === 'ORANGE'
                                    ? 'Laranja'
                                    : 'Amarelo'
                              }`
                            : `${row.nearestStorm.centerDistanceKm.toFixed(1)} km (${row.nearestStorm.cardinalPt}) · ${row.nearestStorm.maxWindKmh} km/h`}
                        </span>
                      ) : (
                        <span className="text-slate-400">Sem avisos</span>
                      )}
                    </td>

                    <td className="py-2.5 px-3.5 whitespace-nowrap">
                      <ParcelStatusIndicator summary={row} />
                    </td>

                    <td className="py-2.5 px-3.5 text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        {!isSelected && (
                          <button
                            type="button"
                            onClick={() => onSelectParcel(row.parcelId)}
                            className="min-h-[34px] px-2.5 py-1 rounded-lg border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                          >
                            Selecionar
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => onFocusParcelOnMap(row.parcelId)}
                          className="min-h-[34px] px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:hover:bg-white text-white dark:text-slate-950 text-xs font-semibold inline-flex items-center gap-1 whitespace-nowrap shrink-0"
                        >
                          <LocateFixed className="w-3 h-3 shrink-0" aria-hidden="true" />
                          <span>Mapa</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Active Proximity Alerts List */}
      <div className="pt-2 border-t border-slate-200 dark:border-[#263248]">
        {visibleAlerts.length > 0 ? (
          <div
            data-testid="active-proximity-alerts-list"
            className="divide-y divide-slate-200 dark:divide-[#263248]"
          >
            {visibleAlerts.map(renderAlertRow)}
          </div>
        ) : (
          <div
            data-testid="no-proximity-alerts-state"
            className="py-6 text-center space-y-2"
          >
            <ShieldCheck
              className="w-7 h-7 text-[#16A34A] mx-auto"
              aria-hidden="true"
            />
            <p className="text-sm font-semibold text-slate-900 dark:text-white">
              Nenhum alerta ativo no raio de {userSettings.proximityAlertRadiusKm} km para o filtro selecionado
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 max-w-lg mx-auto">
              Todos os seus terrenos encontram-se fora do perímetro imediato de incêndios ou tempestades registados. Pode alargar o raio para 25 km ou simular um alerta preventivo abaixo.
            </p>
          </div>
        )}
      </div>

      {/* Field Simulation Bar (Test Alert on Any Remote / Forest Parcel) */}
      <div className="pt-4 border-t border-slate-200 dark:border-[#263248] flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <label
            htmlFor="hazard-sim-parcel-select"
            className="font-semibold text-slate-700 dark:text-slate-300 whitespace-nowrap"
          >
            Testar alerta num terreno:
          </label>
          <select
            id="hazard-sim-parcel-select"
            value={resolvedSimParcel?.id ?? ''}
            onChange={(e) => setSimulationTargetId(e.target.value)}
            className="min-h-[38px] px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs font-medium text-slate-900 dark:text-white max-w-[260px] truncate"
          >
            {parcels.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} ({formatLandClassPt(p.landClass)})
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {resolvedSimParcel && (
            <>
              <button
                type="button"
                data-testid="simulate-fire-alert-btn"
                onClick={() => onSimulateFireNearParcel(resolvedSimParcel)}
                className="min-h-[38px] px-3 py-1.5 rounded-xl border border-rose-300 dark:border-rose-800/70 text-xs font-semibold text-[#DC2626] dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <Flame className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>Simular Incêndio (2,3 km)</span>
              </button>
              <button
                type="button"
                data-testid="simulate-storm-alert-btn"
                onClick={() => onSimulateStormNearParcel(resolvedSimParcel)}
                className="min-h-[38px] px-3 py-1.5 rounded-xl border border-amber-300 dark:border-amber-800/70 text-xs font-semibold text-[#B45309] dark:text-[#FBBF24] hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <CloudLightning className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>Simular Tempestade (3,1 km)</span>
              </button>
              <button
                type="button"
                data-testid="dispatch-external-alert-btn"
                disabled={dispatchingExternal}
                onClick={() => void handleDispatchExternalAlert(resolvedSimParcel)}
                className="min-h-[38px] px-3 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                <Send className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>{dispatchingExternal ? 'A enviar...' : 'Testar Envio Externo'}</span>
              </button>
            </>
          )}

          {hasActiveSimulation && (
            <button
              type="button"
              data-testid="clear-simulated-hazards-btn"
              onClick={onClearSimulations}
              className="min-h-[38px] px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:hover:bg-white text-white dark:text-slate-950 text-xs font-semibold transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>Repor Simulação</span>
            </button>
          )}
        </div>
      </div>

      {externalDispatchFeedback && (
        <p
          role="status"
          aria-live="polite"
          data-testid="external-dispatch-feedback"
          className="text-xs text-slate-600 dark:text-slate-300 tabular-nums"
        >
          {externalDispatchFeedback}
        </p>
      )}
    </section>
  );
};
