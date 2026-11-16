import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Flame,
  HelpCircle,
  Satellite,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Wind,
  XCircle,
} from 'lucide-react';
import type {
  ActiveFireIncident,
  DailyPirForecast,
  ParcelRecord,
  PermissionStatus,
  PirLevel,
  RealtimeHazardFeedMeta,
  UserAppSettings,
} from '../types/domain.ts';
import type { MultiParcelHazardEvaluation } from '../lib/parcelHazardMonitor.ts';
import { getStatutoryDeadlineStatus, PIR_SCALE } from '../lib/pirRules.ts';
import { PirSoilTrendPanel } from './PirSoilTrendPanel.tsx';
import { RegionalFireIncidentsChart } from './RegionalFireIncidentsChart.tsx';
import { ParcelHazardControlPanel } from './ParcelHazardControlPanel.tsx';

interface TodayCockpitViewProps {
  parcels: ParcelRecord[];
  activeParcel: ParcelRecord;
  forecasts: DailyPirForecast[];
  pirSource: string;
  fires: ActiveFireIncident[];
  within15KmCount: number;
  userSettings: UserAppSettings;
  multiParcelEvaluation: MultiParcelHazardEvaluation;
  hazardFeedMeta?: RealtimeHazardFeedMeta;
  hasActiveSimulation: boolean;
  isRefreshingHazards: boolean;
  lastHazardCheckLabel: string;
  notificationPermissionState: 'unsupported' | 'default' | 'granted' | 'denied';
  isAuthenticated: boolean;
  onUpdateSettings: (next: UserAppSettings) => void;
  onRefreshHazards: () => void;
  onSelectParcel: (parcelId: string) => void;
  onFocusParcelOnMap: (parcelId: string) => void;
  onToggleAcknowledgeAlert: (alertId: string) => void;
  onSimulateFireNearParcel: (parcel: ParcelRecord) => void;
  onSimulateStormNearParcel: (parcel: ParcelRecord) => void;
  onClearSimulations: () => void;
  onRequestBrowserNotifications: () => void;
  onLogDecisionToHistory: (payload: {
    pirLevel: PirLevel;
    soilMoisturePct: number;
    verdictLabel: string;
    detail: string;
  }) => Promise<void> | void;
  onOpenHistoryModal: () => void;
  onNavigateTab: (tab: 'today' | 'map' | 'certify' | 'providers' | 'docs', subMode?: string) => void;
}

function StatusRowIcon({ status }: { status: PermissionStatus }) {
  if (status === 'ALLOWED') {
    return <CheckCircle2 className="w-5 h-5 text-[#16A34A] shrink-0" aria-hidden="true" />;
  }
  if (status === 'CONDITIONAL') {
    return <AlertTriangle className="w-5 h-5 text-[#D97706] shrink-0" aria-hidden="true" />;
  }
  return <XCircle className="w-5 h-5 text-[#DC2626] shrink-0" aria-hidden="true" />;
}

function statusLabelPt(status: PermissionStatus): string {
  if (status === 'ALLOWED') return 'Permitido';
  if (status === 'CONDITIONAL') return 'Condicionado';
  return 'Proibido por Lei';
}

export const TodayCockpitView: React.FC<TodayCockpitViewProps> = ({
  parcels,
  activeParcel,
  forecasts,
  pirSource,
  fires,
  within15KmCount,
  userSettings,
  multiParcelEvaluation,
  hazardFeedMeta,
  hasActiveSimulation,
  isRefreshingHazards,
  lastHazardCheckLabel,
  notificationPermissionState,
  isAuthenticated,
  onUpdateSettings,
  onRefreshHazards,
  onSelectParcel,
  onFocusParcelOnMap,
  onToggleAcknowledgeAlert,
  onSimulateFireNearParcel,
  onSimulateStormNearParcel,
  onClearSimulations,
  onRequestBrowserNotifications,
  onLogDecisionToHistory,
  onOpenHistoryModal,
  onNavigateTab,
}) => {
  const [selectedDayIdx, setSelectedDayIdx] = useState<number>(0);
  const [legalQuestion, setLegalQuestion] = useState<string>('');
  const [legalReply, setLegalReply] = useState<{
    answer: string;
    legalBasis: string;
    keyAction: string;
    provider?: string;
  } | null>(null);
  const [askingLegal, setAskingLegal] = useState(false);

  const deadline = getStatutoryDeadlineStatus();
  const currentForecast = forecasts[selectedDayIdx] ?? forecasts[0];
  const pirMeta = currentForecast ? PIR_SCALE[currentForecast.pirLevel] : PIR_SCALE[3];
  const latestSat = activeParcel.ndviHistory[activeParcel.ndviHistory.length - 1];

  const handleAskQuestion = async (qText: string) => {
    const query = qText.trim();
    if (!query) return;
    setLegalQuestion(query);
    setAskingLegal(true);
    try {
      const res = await fetch('/api/ai/legal-assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: query }),
      });
      if (res.ok) {
        const data = await res.json();
        setLegalReply(data);
      }
    } finally {
      setAskingLegal(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Hero Anchor: Semáforo Operacional Diário e Fim de Semana */}
      <section
        aria-labelledby="semaforo-heading"
        className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 sm:p-6"
      >
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 pb-5 border-b border-slate-200 dark:border-[#263248]">
          <div>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {activeParcel.municipality} (DICO {activeParcel.dico}) · {pirSource} · {deadline.urgencyText}
            </p>
            <h1
              id="semaforo-heading"
              className="mt-1 text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50"
              style={{ textWrap: 'balance' }}
            >
              Posso trabalhar com maquinaria no terreno?
            </h1>
          </div>

          {/* 3-Day Interactive Day Selector */}
          <div
            role="group"
            aria-label="Previsão de Perigo de Incêndio a 3 dias"
            className="grid grid-cols-3 md:flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248] w-full md:w-auto"
          >
            {forecasts.map((f, idx) => {
              const active = idx === selectedDayIdx;
              const rawPrefix = f.dateLabel.split('·')[0].trim();
              const shortDay =
                idx === 0 ? 'Hoje' : idx === 1 ? 'Amanhã' : rawPrefix.length > 9 ? '+2 Dias' : rawPrefix;
              return (
                <button
                  key={f.isoDate}
                  type="button"
                  onClick={() => setSelectedDayIdx(idx)}
                  className={`min-h-[44px] px-2.5 sm:px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap text-center ${
                    active
                      ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800'
                  }`}
                >
                  {shortDay} · RCM {f.pirLevel}
                </button>
              );
            })}
          </div>
        </div>

        {currentForecast && (
          <div className="mt-5 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left focal status block */}
            <div className="lg:col-span-5 flex flex-col justify-between rounded-xl p-5 bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248]">
              <div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold text-slate-600 dark:text-slate-400">
                    Índice Oficial PIR / IPMA
                  </span>
                  <span className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-400">
                    {currentForecast.isoDate}
                  </span>
                </div>

                <div className="mt-3 flex items-baseline gap-3">
                  <span
                    className="inline-flex items-center justify-center w-11 h-11 rounded-xl text-lg font-bold font-mono text-white shrink-0"
                    style={{ backgroundColor: pirMeta.colorHex }}
                  >
                    {currentForecast.pirLevel}
                  </span>
                  <div>
                    <div className="text-lg font-bold text-slate-900 dark:text-white">
                      Risco {currentForecast.designation}
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">
                      {pirMeta.shortRule}
                    </p>
                  </div>
                </div>

                {/* Meteorology strip */}
                <div className="mt-4 pt-4 border-t border-slate-200 dark:border-[#263248] flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300 tabular-nums">
                  <span className="inline-flex items-center gap-1.5">
                    <Wind className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                    Vento {currentForecast.windKmh} km/h
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>Máx. {currentForecast.tempMaxC} °C</span>
                  <span aria-hidden="true">·</span>
                  <span>Humidade mín. {currentForecast.humidityMinPct}%</span>
                </div>
              </div>

              {currentForecast.affiliateTip && (
                <div className="mt-4 pt-4 border-t border-slate-200 dark:border-[#263248]">
                  <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    Alternativa Legal Recomendada: {currentForecast.affiliateTip.title}
                  </p>
                  <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                    {currentForecast.affiliateTip.reason}
                  </p>
                </div>
              )}
            </div>

            {/* Right deterministic matrix */}
            <div className="lg:col-span-7 divide-y divide-slate-200 dark:divide-[#263248] border border-slate-200 dark:border-[#263248] rounded-xl bg-white dark:bg-[#161E2E]">
              <div className="p-4 flex items-start gap-3.5">
                <StatusRowIcon status={currentForecast.nylonTrimmer.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Motorroçadora com Cabeça de Fio de Nylon
                    </h2>
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                      {statusLabelPt(currentForecast.nylonTrimmer.status)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                    {currentForecast.nylonTrimmer.summary}
                  </p>
                </div>
              </div>

              <div className="p-4 flex items-start gap-3.5">
                <StatusRowIcon status={currentForecast.metalBladeMachinery.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Lâmina Metálica, Disco de Corte, Motosserra ou Grade de Discos
                    </h2>
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                      {statusLabelPt(currentForecast.metalBladeMachinery.status)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                    {currentForecast.metalBladeMachinery.summary}
                  </p>
                </div>
              </div>

              <div className="p-4 flex items-start gap-3.5">
                <StatusRowIcon status={currentForecast.debrisBurning.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Queima de Amontoados (Sobrantes Florestais / Agrícolas)
                    </h2>
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                      {statusLabelPt(currentForecast.debrisBurning.status)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                    {currentForecast.debrisBurning.summary}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* 4-Column Quantitative Strip (Tabular Numerals) */}
      <section aria-label="Indicadores geométricos e legais da parcela" className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Limpeza Obrigatória</span>
            <ShieldAlert className="w-4 h-4 text-[#E11D48]" aria-hidden="true" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-white">
            {activeParcel.spatial.mandatoryCleanAreaM2.toLocaleString('pt-PT')} m²
          </div>
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 tabular-nums">
            De {activeParcel.spatial.totalAreaM2.toLocaleString('pt-PT')} m² totais · Declive {activeParcel.avgSlopePct}%
          </p>
        </div>

        <div className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Isenção Servidão E-REDES</span>
            <ShieldCheck className="w-4 h-4 text-[#0284C7]" aria-hidden="true" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-white">
            {activeParcel.spatial.thirdPartyEasementM2.toLocaleString('pt-PT')} m²
          </div>
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 tabular-nums">
            Poupança est. {activeParcel.spatial.estimatedEredesSavingsEur.toFixed(0)} € · {activeParcel.eredesType}
          </p>
        </div>

        <div className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Prazo Legal Anual</span>
            <CalendarClock className="w-4 h-4 text-[#14532D] dark:text-[#22C55E]" aria-hidden="true" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-white">
            {deadline.daysRemaining} dias
          </div>
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
            Data-limite: {deadline.deadlineLabel}
          </p>
        </div>

        <div className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Biomassa Sentinel-2</span>
            <Satellite className="w-4 h-4 text-[#D97706]" aria-hidden="true" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-white">
            NDVI {latestSat?.ndvi.toFixed(2) ?? '0.62'}
          </div>
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 tabular-nums">
            {(latestSat?.ndvi ?? 0.62) > 0.55 ? 'Mato denso (> 0.55) · Intervir' : 'Estrato controlado'} · NDMI {latestSat?.ndmi.toFixed(2)}
          </p>
        </div>
      </section>

      {/* Multi-Parcel Wildfire & Storm Proximity Control Across All Registered User Properties */}
      <ParcelHazardControlPanel
        parcels={parcels}
        activeParcelId={activeParcel.id}
        evaluation={multiParcelEvaluation}
        userSettings={userSettings}
        feedMeta={hazardFeedMeta}
        hasActiveSimulation={hasActiveSimulation}
        isRefreshing={isRefreshingHazards}
        lastCheckedAtLabel={lastHazardCheckLabel}
        notificationPermissionState={notificationPermissionState}
        onUpdateSettings={onUpdateSettings}
        onRefreshHazards={onRefreshHazards}
        onSelectParcel={onSelectParcel}
        onFocusParcelOnMap={onFocusParcelOnMap}
        onToggleAcknowledgeAlert={onToggleAcknowledgeAlert}
        onSimulateFireNearParcel={onSimulateFireNearParcel}
        onSimulateStormNearParcel={onSimulateStormNearParcel}
        onClearSimulations={onClearSimulations}
        onRequestBrowserNotifications={onRequestBrowserNotifications}
      />

      {/* Recharts 7-Day PIR Meteorological Risk & Soil Moisture Evolution Panel */}
      <PirSoilTrendPanel
        activeParcel={activeParcel}
        todayForecast={forecasts[0]}
        isAuthenticated={isAuthenticated}
        onLogDecisionToHistory={onLogDecisionToHistory}
        onOpenHistoryModal={onOpenHistoryModal}
      />

      {/* Tablet / Desktop 2-Column Split: Sentinel-2 Satellite + Active Fires Radar */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Sentinel-2 NDVI Evolution & Parcel Quick Actions */}
        <section className="lg:col-span-7 rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 flex flex-col justify-between">
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-bold text-slate-900 dark:text-white">
                  Sentinela Satélite Copernicus (NDVI & Secura NDMI)
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Resolução 10 m (Bandas B04/B08/B11) · Limiar de densidade arbustiva crítica: NDVI 0.55
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigateTab('map')}
                className="min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                Abrir Raio-X no Mapa
                <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>

            {/* Clean SVG Bar/Line Chart for NDVI History */}
            <div className="mt-5 grid grid-cols-4 gap-3 pt-2">
              {activeParcel.ndviHistory.map((obs) => {
                const pct = Math.min(100, Math.round(obs.ndvi * 100));
                const isCritical = obs.ndvi >= 0.55;
                return (
                  <div
                    key={obs.date}
                    className="rounded-xl p-3 bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248] flex flex-col justify-between"
                  >
                    <div className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                      {obs.date.slice(5)}
                    </div>
                    <div className="my-3 h-20 w-full bg-slate-200/70 dark:bg-slate-800 rounded-lg flex items-end overflow-hidden p-1">
                      <div
                        className={`w-full rounded-md transition-transform ${
                          isCritical ? 'bg-[#EA580C]' : 'bg-[#16A34A]'
                        }`}
                        style={{ height: `${pct}%` }}
                      />
                    </div>
                    <div>
                      <div className="text-sm font-bold font-mono tabular-nums text-slate-900 dark:text-white">
                        {obs.ndvi.toFixed(2)}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                        NDMI {obs.ndmi.toFixed(2)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Direct Conversion CTA Banner */}
          <div className="mt-5 pt-4 border-t border-slate-200 dark:border-[#263248] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="text-xs text-slate-600 dark:text-slate-300">
              <strong className="text-slate-900 dark:text-white">
                Estrema poente com mato a {activeParcel.spatial.neighborMinDistanceM.toFixed(1)} m da fachada.
              </strong>{' '}
              Pode pedir limpeza certificada ou emitir notificação camarária.
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => onNavigateTab('certify', 'neighbor')}
                className="min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
              >
                Alerta Vizinho
              </button>
              <button
                type="button"
                onClick={() => onNavigateTab('certify', 'quotes')}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-[#D97706] hover:bg-[#B45309] text-white text-xs font-semibold transition-colors whitespace-nowrap"
              >
                Pedir 3 Orçamentos ({activeParcel.spatial.mandatoryCleanAreaM2.toFixed(0)} m²)
              </button>
            </div>
          </div>
        </section>

        {/* ANEPC Active Rural Fires Radar */}
        <section className="lg:col-span-5 rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Flame className="w-4 h-4 text-[#DC2626]" aria-hidden="true" />
                Radar ANEPC · Ocorrências Rurais
              </h2>
              <span className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-400">
                Raio {userSettings.proximityAlertRadiusKm} km: {within15KmCount}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Distância calculada ao centroide de {activeParcel.label}
            </p>

            <div className="mt-4 divide-y divide-slate-200 dark:divide-[#263248]">
              {fires.slice(0, 3).map((inc) => (
                <div key={inc.id} className="py-3 first:pt-0 last:pb-0 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                      {inc.municipality} · {inc.parish}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                      {inc.nature} · {inc.status} · {inc.operatives} operacionais · {inc.vehicles} viaturas
                      {inc.aerialMeans > 0 ? ` · ${inc.aerialMeans} meios aéreos` : ''}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div
                      className={`text-sm font-bold font-mono tabular-nums ${
                        inc.distanceKm <= userSettings.proximityAlertRadiusKm
                          ? 'text-[#DC2626]'
                          : 'text-slate-800 dark:text-slate-200'
                      }`}
                    >
                      {inc.distanceKm.toFixed(1)} km
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      {inc.startedAt}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-200 dark:border-[#263248] text-xs text-slate-500 dark:text-slate-400">
            Vigilância proativa 24/7 via Telegram (@FaixaSeguraBot) incluída no Plano Guardião.
          </div>
        </section>
      </div>

      {/* Recharts 30-Day Regional Fire Incidents & Municipality Risk Trend BarChart */}
      <RegionalFireIncidentsChart
        activeParcel={activeParcel}
        activeFires={fires}
        onNavigateTab={onNavigateTab}
      />

      {/* Field Legal Assistant (DL 82/2021 + Despacho 675/2026) */}
      <section
        aria-labelledby="legal-qa-heading"
        className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h2 id="legal-qa-heading" className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <HelpCircle className="w-4 h-4 text-[#14532D] dark:text-[#22C55E]" aria-hidden="true" />
              Consulta Jurídica Rápida no Terreno (DL n.º 82/2021 & Despacho n.º 675/2026)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Tire dúvidas concretas sobre espécies protegidas, árvores de fruto, muros ou horários de maquinaria.
            </p>
          </div>
        </div>

        {/* Preset field questions */}
        <div className="mt-3 flex flex-wrap gap-2">
          {[
            'Tenho sobreiros nos 50m da casa, posso cortá-los?',
            'Sou obrigado a abater árvores de fruto a 8 metros da parede?',
            'Quem limpa os 7 metros debaixo dos cabos da E-REDES?',
            'O terreno vizinho tem silvado encostado ao meu muro, o que faço?',
          ].map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => handleAskQuestion(preset)}
              className="min-h-[40px] px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-[#0B0F17] hover:bg-slate-200 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-300 transition-colors text-left"
            >
              {preset}
            </button>
          ))}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleAskQuestion(legalQuestion);
          }}
          className="mt-3 flex flex-col sm:flex-row gap-2.5"
        >
          <label htmlFor="legal-field-input" className="sr-only">
            Escreva a sua dúvida legal sobre limpeza de terreno
          </label>
          <input
            id="legal-field-input"
            type="text"
            value={legalQuestion}
            onChange={(e) => setLegalQuestion(e.target.value)}
            placeholder="Ex.: Posso usar motorroçadora com disco metálico às 09h00 em risco Muito Elevado?"
            className="flex-1 min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#14532D]"
          />
          <button
            type="submit"
            disabled={askingLegal}
            className="min-h-[44px] px-5 py-2 rounded-xl bg-[#14532D] hover:bg-[#0F3F22] dark:bg-[#22C55E] dark:hover:bg-[#16A34A] text-white dark:text-slate-950 text-sm font-semibold transition-colors whitespace-nowrap shrink-0 inline-flex items-center justify-center gap-2"
          >
            <Sparkles className="w-4 h-4" aria-hidden="true" />
            {askingLegal ? 'A consultar norma...' : 'Validar Norma Legal'}
          </button>
        </form>

        {legalReply && (
          <div className="mt-4 rounded-xl p-4 bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248] space-y-2">
            <p className="text-sm text-slate-900 dark:text-slate-100 leading-relaxed">
              {legalReply.answer}
            </p>
            <div className="pt-2 border-t border-slate-200 dark:border-[#263248] flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-400">
              <span>
                <strong>Base Legal:</strong> {legalReply.legalBasis}
              </span>
              <span>
                <strong>Ação Recomendada:</strong> {legalReply.keyAction}
              </span>
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
