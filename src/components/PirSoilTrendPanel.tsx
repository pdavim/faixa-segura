import React, { useMemo, useState } from 'react';
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CheckCircle2, CloudRain, Droplets, Flame, History, SlidersHorizontal } from 'lucide-react';
import type { DailyPirForecast, ParcelRecord } from '../types/domain.ts';
import {
  buildSevenDayPirSoilSeries,
  type PirSoilTrendPoint,
} from '../lib/pirTrendEngine.ts';

interface PirSoilTrendPanelProps {
  activeParcel: ParcelRecord;
  todayForecast?: DailyPirForecast;
  isAuthenticated: boolean;
  onLogDecisionToHistory: (payload: {
    pirLevel: PirSoilTrendPoint['pirLevel'];
    soilMoisturePct: number;
    verdictLabel: string;
    detail: string;
  }) => Promise<void> | void;
  onOpenHistoryModal: () => void;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: PirSoilTrendPoint }>;
}

const CustomTrendTooltip: React.FC<CustomTooltipProps> = ({ active, payload }) => {
  if (!active || !payload || payload.length === 0) return null;
  const pt = payload[0].payload;

  return (
    <div className="rounded-xl bg-white/95 dark:bg-[#0F172A]/95 border border-slate-300 dark:border-[#263248] p-3.5 shadow-lg text-xs space-y-1.5 max-w-[260px]">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 dark:border-[#263248] pb-1.5">
        <span className="font-bold text-slate-900 dark:text-white">
          {pt.weekdayShort} · {pt.shortDate}
        </span>
        <span
          className="px-2 py-0.5 rounded font-mono font-bold text-white"
          style={{ backgroundColor: pt.pirColorHex }}
        >
          RCM {pt.pirLevel} ({pt.pirLabel})
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono tabular-nums text-slate-700 dark:text-slate-300">
        <span>Humidade Solo:</span>
        <span className="text-right font-semibold text-[#0284C7] dark:text-[#38BDF8]">
          {pt.soilMoisturePct.toFixed(1)}%
        </span>
        <span>Humidade Ar:</span>
        <span className="text-right">{pt.airHumidityMinPct}%</span>
        <span>Temp. Máx / Vento:</span>
        <span className="text-right">
          {pt.tempMaxC}°C · {pt.windKmh} km/h
        </span>
        <span>Adequação Limpeza:</span>
        <span className="text-right font-semibold text-slate-900 dark:text-white">
          {pt.interventionScore}/100
        </span>
      </div>
      <p className="pt-1 border-t border-slate-200 dark:border-[#263248] text-[11px] text-slate-600 dark:text-slate-400 leading-snug">
        {pt.allowedToolSummary}
      </p>
    </div>
  );
};

export const PirSoilTrendPanel: React.FC<PirSoilTrendPanelProps> = ({
  activeParcel,
  todayForecast,
  isAuthenticated,
  onLogDecisionToHistory,
  onOpenHistoryModal,
}) => {
  const [chartMode, setChartMode] = useState<'pir_moisture' | 'suitability'>('pir_moisture');
  const [savingDecision, setSavingDecision] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  const summary = useMemo(
    () => buildSevenDayPirSoilSeries(activeParcel, todayForecast),
    [activeParcel, todayForecast]
  );

  const todayPoint = summary.points[summary.points.length - 1];

  const handleRecordDecision = async () => {
    if (!isAuthenticated) {
      onOpenHistoryModal();
      return;
    }
    setSavingDecision(true);
    try {
      await onLogDecisionToHistory({
        pirLevel: todayPoint.pirLevel,
        soilMoisturePct: todayPoint.soilMoisturePct,
        verdictLabel: summary.actionHeadline,
        detail: summary.actionDetail,
      });
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 3000);
    } finally {
      setSavingDecision(false);
    }
  };

  return (
    <section
      aria-labelledby="pir-soil-trend-heading"
      data-testid="pir-soil-trend-panel"
      className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 sm:p-6 space-y-5"
    >
      {/* Header + Segmented View Switcher */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 pb-4 border-b border-slate-200 dark:border-[#263248]">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-[#14532D] dark:text-[#22C55E]">
            <Droplets className="w-4 h-4 text-[#0284C7]" aria-hidden="true" />
            <span>Apoio à Decisão de Intervenção nas Faixas (Últimos 7 Dias)</span>
          </div>
          <h2
            id="pir-soil-trend-heading"
            className="mt-1 text-base sm:text-lg font-bold text-slate-900 dark:text-white"
          >
            Tendência Meteorológica PIR (RCM 1–5) &amp; Evolução da Humidade do Solo
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Cruzamento diário IPMA ({activeParcel.municipality}) com índice hídrico NDMI Sentinel-2 e drenagem por declive ({activeParcel.avgSlopePct}%)
          </p>
        </div>

        <div
          role="group"
          aria-label="Modo de visualização do gráfico de 7 dias"
          className="inline-flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248] self-start lg:self-auto"
        >
          <button
            type="button"
            onClick={() => setChartMode('pir_moisture')}
            className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
              chartMode === 'pir_moisture'
                ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800'
            }`}
          >
            Risco PIR + Humidade Solo
          </button>
          <button
            type="button"
            onClick={() => setChartMode('suitability')}
            className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap inline-flex items-center gap-1.5 ${
              chartMode === 'suitability'
                ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" />
            Adequação &amp; Vento
          </button>
        </div>
      </div>

      {/* 3 Compact Decision KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl p-3.5 bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248]">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Média Risco PIR (7 Dias)</span>
            <Flame className="w-3.5 h-3.5 text-[#EA580C]" aria-hidden="true" />
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-xl font-bold font-mono tabular-nums text-slate-900 dark:text-white">
              RCM {summary.avgPir7d.toFixed(1)}
            </span>
            <span className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-400">
              ({summary.pirDelta7d > 0 ? `+${summary.pirDelta7d}` : summary.pirDelta7d} vs há 7d)
            </span>
          </div>
        </div>

        <div className="rounded-xl p-3.5 bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248]">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Humidade Volumétrica do Solo</span>
            <CloudRain className="w-3.5 h-3.5 text-[#0284C7]" aria-hidden="true" />
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-xl font-bold font-mono tabular-nums text-[#0284C7] dark:text-[#38BDF8]">
              {summary.currentSoilMoisturePct.toFixed(1)}%
            </span>
            <span className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-400">
              ({summary.soilMoistureDelta7d > 0 ? `+${summary.soilMoistureDelta7d}` : summary.soilMoistureDelta7d}% em 7d)
            </span>
          </div>
        </div>

        <div className="rounded-xl p-3.5 bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248]">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Melhor Janela Registada</span>
            <CheckCircle2 className="w-3.5 h-3.5 text-[#16A34A]" aria-hidden="true" />
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-xl font-bold font-mono tabular-nums text-slate-900 dark:text-white">
              {summary.bestDay.weekdayShort} ({summary.bestDay.shortDate})
            </span>
            <span className="text-xs font-mono tabular-nums text-[#16A34A]">
              {summary.bestDay.interventionScore}/100
            </span>
          </div>
        </div>
      </div>

      {/* Recharts 7-Day Visualization */}
      <div className="w-full h-64 sm:h-72 pt-1" role="img" aria-label="Gráfico Recharts da tendência de risco meteorológico PIR e humidade do solo nos últimos 7 dias">
        <ResponsiveContainer width="100%" height="100%">
          {chartMode === 'pir_moisture' ? (
            <ComposedChart key="composed-pir-moisture" data={summary.points} margin={{ top: 10, right: 12, left: -12, bottom: 0 }}>
              <defs>
                <linearGradient id="soilMoistureFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#0284C7" stopOpacity={0.28} />
                  <stop offset="95%" stopColor="#0284C7" stopOpacity={0.03} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#94A3B8" strokeOpacity={0.25} vertical={false} />
              <XAxis
                dataKey="weekdayShort"
                tickFormatter={(val, idx) => {
                  const pt = summary.points[idx];
                  return pt ? `${val} ${pt.shortDate}` : String(val);
                }}
                tick={{ fontSize: 11, fill: '#64748B' }}
                axisLine={{ stroke: '#CBD5E1', strokeOpacity: 0.5 }}
                tickLine={false}
              />
              <YAxis
                yAxisId="pir"
                domain={[0, 5]}
                ticks={[1, 2, 3, 4, 5]}
                tickFormatter={(v) => `RCM ${v}`}
                tick={{ fontSize: 11, fill: '#64748B' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                yAxisId="moisture"
                orientation="right"
                domain={[0, 55]}
                tickFormatter={(v) => `${v}%`}
                tick={{ fontSize: 11, fill: '#0284C7' }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip content={<CustomTrendTooltip />} />
              <ReferenceLine
                yAxisId="pir"
                y={4}
                stroke="#EA580C"
                strokeDasharray="4 4"
                strokeOpacity={0.8}
              />
              <Area
                yAxisId="moisture"
                type="monotone"
                dataKey="soilMoisturePct"
                name="Humidade do Solo (%)"
                stroke="#0284C7"
                strokeWidth={2.5}
                fill="url(#soilMoistureFill)"
                activeDot={{ r: 5, fill: '#0284C7' }}
              />
              <Bar
                yAxisId="pir"
                dataKey="pirLevel"
                name="Índice PIR (1–5)"
                barSize={26}
                radius={[6, 6, 0, 0]}
              >
                {summary.points.map((entry) => (
                  <Cell key={entry.isoDate} fill={entry.pirColorHex} fillOpacity={0.86} />
                ))}
              </Bar>
            </ComposedChart>
          ) : (
            <ComposedChart key="composed-suitability" data={summary.points} margin={{ top: 10, right: 12, left: -12, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#94A3B8" strokeOpacity={0.25} vertical={false} />
              <XAxis
                dataKey="weekdayShort"
                tickFormatter={(val, idx) => {
                  const pt = summary.points[idx];
                  return pt ? `${val} ${pt.shortDate}` : String(val);
                }}
                tick={{ fontSize: 11, fill: '#64748B' }}
                axisLine={{ stroke: '#CBD5E1', strokeOpacity: 0.5 }}
                tickLine={false}
              />
              <YAxis
                yAxisId="score"
                domain={[0, 100]}
                tickFormatter={(v) => `${v}`}
                tick={{ fontSize: 11, fill: '#16A34A' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                yAxisId="wind"
                orientation="right"
                domain={[0, 50]}
                tickFormatter={(v) => `${v} km/h`}
                tick={{ fontSize: 11, fill: '#64748B' }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip content={<CustomTrendTooltip />} />
              <ReferenceLine
                yAxisId="score"
                y={60}
                stroke="#16A34A"
                strokeDasharray="4 4"
                strokeOpacity={0.7}
              />
              <Bar
                yAxisId="score"
                dataKey="interventionScore"
                name="Índice de Adequação (0-100)"
                barSize={26}
                fill="#16A34A"
                fillOpacity={0.8}
                radius={[6, 6, 0, 0]}
              />
              <Line
                yAxisId="wind"
                type="monotone"
                dataKey="windKmh"
                name="Vento (km/h)"
                stroke="#D97706"
                strokeWidth={2.5}
                dot={{ r: 4, fill: '#D97706' }}
              />
            </ComposedChart>
          )}
        </ResponsiveContainer>
      </div>

      {/* Legend + Actionable Decision Recommendation Strip */}
      <div className="pt-3 border-t border-slate-200 dark:border-[#263248] flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          {chartMode === 'pir_moisture' ? (
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-[#16A34A]" aria-hidden="true" />
                Barras: Índice Diário PIR (RCM 1–5)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#0284C7]" aria-hidden="true" />
                Curva Azul: Humidade do Solo (%)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-3 border-t border-dashed border-[#EA580C]" aria-hidden="true" />
                Limiar Restrição Lâmina Metálica (RCM ≥ 4)
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-[#16A34A]" aria-hidden="true" />
                Barras Verdes: Índice de Adequação (0–100)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#D97706]" aria-hidden="true" />
                Linha Âmbar: Vento Máximo (km/h)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-3 border-t border-dashed border-[#16A34A]" aria-hidden="true" />
                Limiar Janela Recomendada (≥ 60/100)
              </span>
            </div>
          )}
          <p className="text-xs font-bold text-slate-900 dark:text-white pt-1">
            Decisão Recomendada: {summary.actionHeadline}
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
            {summary.actionDetail}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={savingDecision}
            onClick={handleRecordDecision}
            className="min-h-[44px] px-4 py-2 rounded-xl bg-[#14532D] hover:bg-[#0F3F22] dark:bg-[#22C55E] dark:hover:bg-[#16A34A] text-white dark:text-slate-950 text-xs font-semibold transition-colors inline-flex items-center gap-2 whitespace-nowrap"
          >
            <History className="w-4 h-4" aria-hidden="true" />
            {savedNotice
              ? 'Registado no Histórico!'
              : savingDecision
              ? 'A guardar...'
              : isAuthenticated
              ? 'Guardar Avaliação no Histórico'
              : 'Entrar p/ Guardar no Histórico'}
          </button>
        </div>
      </div>
    </section>
  );
};
