import React, { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ArrowRight, BarChart3, Flame, TrendingDown, TrendingUp } from 'lucide-react';
import type { ActiveFireIncident, ParcelRecord } from '../types/domain.ts';
import {
  buildRegionalThirtyDayIncidents,
  type MunicipalIncidentBarPoint,
} from '../lib/regionalIncidentsEngine.ts';

interface RegionalFireIncidentsChartProps {
  activeParcel: ParcelRecord;
  activeFires: ActiveFireIncident[];
  onNavigateTab: (
    tab: 'today' | 'map' | 'certify' | 'providers' | 'docs',
    subMode?: string
  ) => void;
}

interface CustomMunicipalTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: MunicipalIncidentBarPoint }>;
}

const CustomMunicipalTooltip: React.FC<CustomMunicipalTooltipProps> = ({ active, payload }) => {
  if (!active || !payload || payload.length === 0) return null;
  const item = payload[0].payload;

  return (
    <div className="rounded-xl bg-white/95 dark:bg-[#0F172A]/95 border border-slate-300 dark:border-[#263248] p-3.5 shadow-lg text-xs space-y-1.5 max-w-[270px]">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 dark:border-[#263248] pb-1.5">
        <span className="font-bold text-slate-900 dark:text-white">
          {item.municipality} {item.isParcelMunicipality ? '(Seu Concelho)' : `· ${item.distanceKm} km`}
        </span>
        <span
          className="font-mono font-bold tabular-nums"
          style={{ color: item.barColorHex }}
        >
          {item.trendPct > 0 ? `+${item.trendPct}%` : `${item.trendPct}%`}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono tabular-nums text-slate-700 dark:text-slate-300">
        <span>Total 30 Dias:</span>
        <span className="text-right font-bold text-slate-900 dark:text-white">
          {item.incidents30dTotal} ocorrências
        </span>
        <span>Mato &amp; Floresta:</span>
        <span className="text-right">{item.forestScrub30d}</span>
        <span>Agrícola / Queimas:</span>
        <span className="text-right">{item.agricultural30d}</span>
        <span>Dias 16–30 vs 1–15:</span>
        <span className="text-right">
          {item.prev15dIncidents} → {item.last15dIncidents}
        </span>
        <span>Ativas Agora:</span>
        <span className="text-right font-semibold text-[#DC2626]">
          {item.activeNowCount}
        </span>
      </div>

      <p className="pt-1 border-t border-slate-200 dark:border-[#263248] text-[11px] text-slate-600 dark:text-slate-400">
        Tendência Municipal: <strong className="text-slate-900 dark:text-white">{item.trendLabelPt}</strong> · Pico RCM {item.peakPir30d}
      </p>
    </div>
  );
};

export const RegionalFireIncidentsChart: React.FC<RegionalFireIncidentsChartProps> = ({
  activeParcel,
  activeFires,
  onNavigateTab,
}) => {
  const [viewMode, setViewMode] = useState<'total_risk' | 'fortnight_trend'>('total_risk');

  const summary = useMemo(
    () => buildRegionalThirtyDayIncidents(activeParcel, activeFires),
    [activeParcel, activeFires]
  );

  const [selectedDico, setSelectedDico] = useState<string>(summary.ownMunicipalityPoint.dico);

  useEffect(() => {
    setSelectedDico(summary.ownMunicipalityPoint.dico);
  }, [summary.ownMunicipalityPoint.dico]);

  const focusedPoint = useMemo(
    () =>
      summary.points.find((p) => p.dico === selectedDico) ?? summary.ownMunicipalityPoint,
    [summary.points, summary.ownMunicipalityPoint, selectedDico]
  );

  return (
    <section
      aria-labelledby="regional-incidents-30d-heading"
      data-testid="regional-fire-incidents-chart"
      className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 sm:p-6 space-y-5"
    >
      {/* Header + Segmented Mode Switch */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 pb-4 border-b border-slate-200 dark:border-[#263248]">
        <div>
          <p className="text-xs font-semibold text-[#DC2626] dark:text-[#F87171] flex items-center gap-1.5">
            <Flame className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>Histórico Regional ANEPC · Últimos 30 Dias ({summary.windowLabel})</span>
          </p>
          <h2
            id="regional-incidents-30d-heading"
            className="mt-1 text-base sm:text-lg font-bold text-slate-900 dark:text-white"
            style={{ textWrap: 'balance' }}
          >
            Incidentes de Incêndio na Região &amp; Tendência de Risco por Município
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {summary.subRegionTitle} · Comparação de pressão pirológica nos 6 concelhos envolventes a {activeParcel.municipality}
          </p>
        </div>

        <div
          role="group"
          aria-label="Modo de visualização dos incidentes de 30 dias"
          className="inline-flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248] self-start lg:self-auto"
        >
          <button
            type="button"
            onClick={() => setViewMode('total_risk')}
            className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              viewMode === 'total_risk'
                ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800'
            }`}
          >
            Total 30 Dias &amp; Risco
          </button>
          <button
            type="button"
            onClick={() => setViewMode('fortnight_trend')}
            className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 ${
              viewMode === 'fortnight_trend'
                ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5" aria-hidden="true" />
            Tendência Quinzenal
          </button>
        </div>
      </div>

      {/* 3 Compact Regional KPI Blocks (Tabular Figures, Single-Level Flat Divider Surfaces) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl p-3.5 bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248]">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Total Regional (30 Dias)</span>
            <Flame className="w-3.5 h-3.5 text-[#EA580C]" aria-hidden="true" />
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-xl font-bold font-mono tabular-nums text-slate-900 dark:text-white">
              {summary.totalIncidents30d}
            </span>
            <span className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-400">
              ocorrências · média {summary.regionalAvgPerMunicipality}/mun.
            </span>
          </div>
        </div>

        <div className="rounded-xl p-3.5 bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248]">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Maior Subida Regional</span>
            <TrendingUp className="w-3.5 h-3.5 text-[#DC2626]" aria-hidden="true" />
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-xl font-bold text-slate-900 dark:text-white truncate">
              {summary.highestTrendMunicipality.municipality}
            </span>
            <span className="text-xs font-mono font-semibold tabular-nums text-[#DC2626] dark:text-[#F87171] shrink-0">
              {summary.highestTrendMunicipality.trendPct > 0
                ? `+${summary.highestTrendMunicipality.trendPct}%`
                : `${summary.highestTrendMunicipality.trendPct}%`}{' '}
              (15d)
            </span>
          </div>
        </div>

        <div className="rounded-xl p-3.5 bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248]">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>No Seu Concelho ({summary.ownMunicipalityPoint.municipality})</span>
            {summary.ownMunicipalityPoint.trendDirection === 'FALLING' ? (
              <TrendingDown className="w-3.5 h-3.5 text-[#16A34A]" aria-hidden="true" />
            ) : (
              <TrendingUp className="w-3.5 h-3.5 text-[#D97706]" aria-hidden="true" />
            )}
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-xl font-bold font-mono tabular-nums text-slate-900 dark:text-white">
              {summary.ownMunicipalityPoint.incidents30dTotal} ocorr.
            </span>
            <span className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-400">
              {summary.ownMunicipalityPoint.trendLabelPt} (
              {summary.ownMunicipalityPoint.trendPct > 0
                ? `+${summary.ownMunicipalityPoint.trendPct}%`
                : `${summary.ownMunicipalityPoint.trendPct}%`}
              )
            </span>
          </div>
        </div>
      </div>

      {/* Recharts BarChart Viewport */}
      <div
        className="w-full h-64 sm:h-72 pt-1"
        role="img"
        aria-label="Gráfico de barras Recharts com incidentes de incêndio nos últimos 30 dias na região e tendência por município"
      >
        <ResponsiveContainer width="100%" height="100%">
          {viewMode === 'total_risk' ? (
            <BarChart
              key="chart-total-risk"
              data={summary.points}
              margin={{ top: 10, right: 14, left: -12, bottom: 4 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#94A3B8"
                strokeOpacity={0.25}
                vertical={false}
              />
              <XAxis
                dataKey="shortLabel"
                tick={{ fontSize: 11, fill: '#64748B' }}
                axisLine={{ stroke: '#CBD5E1', strokeOpacity: 0.5 }}
                tickLine={false}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 11, fill: '#64748B' }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                content={<CustomMunicipalTooltip />}
                cursor={{ fill: 'rgba(148, 163, 184, 0.12)' }}
              />
              <ReferenceLine
                y={summary.regionalAvgPerMunicipality}
                stroke="#64748B"
                strokeDasharray="4 4"
                strokeOpacity={0.8}
              />
              <Bar
                dataKey="incidents30dTotal"
                name="Incidentes (30 Dias)"
                barSize={34}
                radius={[6, 6, 0, 0]}
                onClick={(barData) => {
                  const payload = barData?.payload as MunicipalIncidentBarPoint | undefined;
                  if (payload?.dico) {
                    setSelectedDico(payload.dico);
                  }
                }}
              >
                {summary.points.map((entry) => {
                  const isFocused = entry.dico === focusedPoint.dico;
                  return (
                    <Cell
                      key={entry.dico}
                      fill={entry.barColorHex}
                      fillOpacity={isFocused ? 0.96 : 0.76}
                      stroke={entry.isParcelMunicipality ? '#0F172A' : 'none'}
                      strokeWidth={entry.isParcelMunicipality ? 1.5 : 0}
                      className="cursor-pointer"
                    />
                  );
                })}
              </Bar>
            </BarChart>
          ) : (
            <BarChart
              key="chart-fortnight-trend"
              data={summary.points}
              margin={{ top: 10, right: 14, left: -12, bottom: 4 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#94A3B8"
                strokeOpacity={0.25}
                vertical={false}
              />
              <XAxis
                dataKey="shortLabel"
                tick={{ fontSize: 11, fill: '#64748B' }}
                axisLine={{ stroke: '#CBD5E1', strokeOpacity: 0.5 }}
                tickLine={false}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 11, fill: '#64748B' }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                content={<CustomMunicipalTooltip />}
                cursor={{ fill: 'rgba(148, 163, 184, 0.12)' }}
              />
              <Bar
                dataKey="prev15dIncidents"
                name="Quinzena Anterior (D-30 a D-16)"
                fill="#94A3B8"
                fillOpacity={0.75}
                barSize={18}
                radius={[5, 5, 0, 0]}
              />
              <Bar
                dataKey="last15dIncidents"
                name="Últimos 15 Dias (D-15 a Hoje)"
                fill="#EA580C"
                fillOpacity={0.9}
                barSize={18}
                radius={[5, 5, 0, 0]}
              />
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>

      {/* Interactive Municipality Selector Buttons (Accessible Keyboard & Touch Drill-Down) */}
      <div
        role="group"
        aria-label="Selecionar município da região para ver detalhe de 30 dias"
        className="flex flex-wrap items-center gap-1.5"
      >
        {summary.points.map((pt) => {
          const isSelected = pt.dico === focusedPoint.dico;
          return (
            <button
              key={pt.dico}
              type="button"
              onClick={() => setSelectedDico(pt.dico)}
              className={`min-h-[36px] px-3 py-1 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 border ${
                isSelected
                  ? 'bg-slate-900 text-white border-slate-900 dark:bg-slate-100 dark:text-slate-950 dark:border-slate-100'
                  : 'bg-slate-50 dark:bg-[#0B0F17] text-slate-700 dark:text-slate-300 border-slate-200 dark:border-[#263248] hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {pt.isParcelMunicipality ? `★ ${pt.municipality}` : pt.municipality} ·{' '}
              <span className="font-mono tabular-nums">{pt.incidents30dTotal}</span>
            </button>
          );
        })}
      </div>

      {/* Legend + Focused Municipality Detail + Preventive Action CTA */}
      <div className="pt-3 border-t border-slate-200 dark:border-[#263248] flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          {viewMode === 'total_risk' ? (
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-[#DC2626]" aria-hidden="true" />
                Ativo / Subida Forte
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-[#EA580C]" aria-hidden="true" />
                Agravamento Quinzenal
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-[#D97706]" aria-hidden="true" />
                Estável
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-[#16A34A]" aria-hidden="true" />
                Desagravamento
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-3 border-t border-dashed border-slate-500" aria-hidden="true" />
                Média Regional ({summary.regionalAvgPerMunicipality} ocorr.)
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-[#94A3B8]" aria-hidden="true" />
                Quinzena Anterior (Dias 16–30)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-[#EA580C]" aria-hidden="true" />
                Últimos 15 Dias (Tendência Recente)
              </span>
            </div>
          )}

          <p className="text-xs font-bold text-slate-900 dark:text-white pt-1 tabular-nums">
            Detalhe {focusedPoint.municipality}: {focusedPoint.incidents30dTotal} ocorrências em 30 dias ({focusedPoint.forestScrub30d} mato/floresta · {focusedPoint.agricultural30d} agrícola) · Variação quinzenal{' '}
            {focusedPoint.trendPct > 0 ? `+${focusedPoint.trendPct}%` : `${focusedPoint.trendPct}%`} ({focusedPoint.trendLabelPt})
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
            {summary.advisoryDetail}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onNavigateTab('map')}
            className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-300 dark:border-[#263248] hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold text-slate-800 dark:text-slate-200 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0"
          >
            Ver Faixas no Mapa
            <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
};
