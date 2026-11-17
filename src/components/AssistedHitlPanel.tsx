import React from 'react';
import {
  Building2,
  Check,
  Home,
  MousePointerClick,
  RefreshCw,
  RotateCcw,
  Trash2,
  Trees,
  Zap,
} from 'lucide-react';
import type { LatLon, ParcelRecord } from '../types/domain.ts';
import {
  countHumanVerifiedEdits,
  EASEMENT_PRESETS,
  ensureParcelVectorContext,
  EXEMPT_PRESETS,
  type AssistedSubTool,
  type BuildingDrawStyle,
  type EasementPresetCode,
  type ExemptPresetCode,
} from '../lib/assistedMapEditor.ts';

interface AssistedHitlPanelProps {
  activeParcel: ParcelRecord;
  subTool: AssistedSubTool;
  onSelectSubTool: (tool: AssistedSubTool) => void;
  buildingDrawStyle: BuildingDrawStyle;
  onChangeBuildingDrawStyle: (style: BuildingDrawStyle) => void;
  buildingCustomLabel: string;
  onChangeBuildingCustomLabel: (val: string) => void;
  easementPreset: EasementPresetCode;
  onChangeEasementPreset: (preset: EasementPresetCode) => void;
  easementHalfWidthM: number;
  onChangeEasementHalfWidthM: (val: number) => void;
  exemptPreset: ExemptPresetCode;
  onChangeExemptPreset: (preset: ExemptPresetCode) => void;
  exemptHalfWidthM: number;
  onChangeExemptHalfWidthM: (val: number) => void;
  draftPoints: LatLon[];
  onClearDraftPoints: () => void;
  onRemoveLastDraftPoint: () => void;
  onCommitDraftGeometry: () => void;
  selectedElementId: string | null;
  onSelectElementId: (id: string | null) => void;
  onFocusMapLatLon: (pt: LatLon) => void;
  onToggleBuildingRole: (buildingId: string) => void;
  onUpdateEasementWidth: (easementId: string, nextHalfWidthM: number) => void;
  onRemoveVectorElement: (kind: 'BUILDING' | 'EASEMENT' | 'EXEMPT', id: string) => void;
  onReviewCvRoof: (
    roofId: string,
    decision: 'ACCEPT_OWN' | 'ACCEPT_NEIGHBOR' | 'DISMISS_FALSE_POSITIVE'
  ) => void;
  onOverrideCvCrown: (
    crownId: string,
    override: 'PROTECTED_QUERCUS' | 'PRUNED_COMPLIANT' | 'CLEAR'
  ) => void;
  undoCount: number;
  onUndoLastEdit: () => void;
  onResetToAutomatic: () => void;
  onRunOrthophotoCv: () => void;
  runningOrthophotoCv: boolean;
  statusFeedbackPt: string | null;
}

function formatProvenancePt(source: string): string {
  if (source === 'USER_DEFINED') return 'Validado manualmente';
  if (source === 'CV_ORTHOPHOTO_25CM') return 'Ortofoto CV 25 cm';
  if (source === 'OSM_OVERPASS') return 'OSM Overpass';
  return 'Cadastro base';
}

export const AssistedHitlPanel: React.FC<AssistedHitlPanelProps> = ({
  activeParcel,
  subTool,
  onSelectSubTool,
  buildingDrawStyle,
  onChangeBuildingDrawStyle,
  buildingCustomLabel,
  onChangeBuildingCustomLabel,
  easementPreset,
  onChangeEasementPreset,
  easementHalfWidthM,
  onChangeEasementHalfWidthM,
  exemptPreset,
  onChangeExemptPreset,
  exemptHalfWidthM,
  onChangeExemptHalfWidthM,
  draftPoints,
  onClearDraftPoints,
  onRemoveLastDraftPoint,
  onCommitDraftGeometry,
  selectedElementId,
  onSelectElementId,
  onFocusMapLatLon,
  onToggleBuildingRole,
  onUpdateEasementWidth,
  onRemoveVectorElement,
  onReviewCvRoof,
  onOverrideCvCrown,
  undoCount,
  onUndoLastEdit,
  onResetToAutomatic,
  onRunOrthophotoCv,
  runningOrthophotoCv,
  statusFeedbackPt,
}) => {
  const ctx = ensureParcelVectorContext(activeParcel);
  const cv = activeParcel.cvAnalysis;
  const humanEditsCount = countHumanVerifiedEdits(ctx, cv);

  const unreviewedRoofs = (cv?.detectedRoofs ?? []).filter(
    (r) => r.isUnmappedInOsm && r.reviewStatus !== 'DISMISSED' && r.reviewStatus !== 'ACCEPTED'
  );
  const priorityCrowns = (cv?.crowns ?? [])
    .filter((c) => c.violationRulePt !== null || Boolean(c.humanOverride))
    .slice(0, 4);

  const isMultiPointMode =
    ((subTool === 'OWN_BUILDING' || subTool === 'NEIGHBOR_BUILDING') &&
      buildingDrawStyle === 'POLYGON') ||
    subTool === 'EASEMENT_LINE' ||
    subTool === 'EXEMPT_ZONE';

  const requiredMinPoints =
    subTool === 'EASEMENT_LINE'
      ? 2
      : subTool === 'EXEMPT_ZONE'
        ? EXEMPT_PRESETS[exemptPreset].minPoints
        : 3;

  return (
    <section
      aria-label="Edição assistida e validação humana no mapa"
      data-testid="assisted-hitl-panel"
      className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-4"
    >
      {/* Header & Undo / Reset Bar */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-slate-900 dark:text-white">
            Edição Assistida no Mapa
          </h2>
          <p
            data-testid="hitl-summary-telemetry"
            className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-0.5"
          >
            <span>Validados: {humanEditsCount}</span>
            <span aria-hidden="true"> · </span>
            <span>Edifícios: {ctx.buildings.length}</span>
            <span aria-hidden="true"> · </span>
            <span>Servidões: {ctx.easements.length}</span>
            <span aria-hidden="true"> · </span>
            <span>Isenções: {ctx.exemptFeatures.length}</span>
          </p>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            data-testid="hitl-undo-btn"
            disabled={undoCount === 0}
            onClick={onUndoLastEdit}
            title="Anular última alteração na parcela"
            className="min-h-[38px] px-2.5 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-45 inline-flex items-center gap-1 whitespace-nowrap shrink-0 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="tabular-nums">Anular ({undoCount})</span>
          </button>

          <button
            type="button"
            data-testid="hitl-reset-btn"
            disabled={humanEditsCount === 0}
            onClick={onResetToAutomatic}
            title="Repor deteção automática base sem edições manuais"
            className="min-h-[38px] px-2.5 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-45 inline-flex items-center gap-1 whitespace-nowrap shrink-0 transition-colors"
          >
            <span>Repor Base</span>
          </button>
        </div>
      </div>

      {/* Sub-Tool Selector */}
      <div
        role="group"
        aria-label="Selecionar tipo de elemento a editar no mapa"
        className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 p-1 rounded-xl bg-slate-100 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248]"
      >
        <button
          type="button"
          data-testid="hitl-tool-review"
          onClick={() => onSelectSubTool('REVIEW')}
          className={`min-h-[38px] px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 ${
            subTool === 'REVIEW'
              ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
              : 'text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          <MousePointerClick className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Rever / Selecionar</span>
        </button>

        <button
          type="button"
          data-testid="hitl-tool-own-bldg"
          onClick={() => onSelectSubTool('OWN_BUILDING')}
          className={`min-h-[38px] px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 ${
            subTool === 'OWN_BUILDING'
              ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
              : 'text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          <Home className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Anexo Próprio</span>
        </button>

        <button
          type="button"
          data-testid="hitl-tool-neighbor-bldg"
          onClick={() => onSelectSubTool('NEIGHBOR_BUILDING')}
          className={`min-h-[38px] px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 ${
            subTool === 'NEIGHBOR_BUILDING'
              ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
              : 'text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          <Building2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Casa Vizinha</span>
        </button>

        <button
          type="button"
          data-testid="hitl-tool-easement"
          onClick={() => onSelectSubTool('EASEMENT_LINE')}
          className={`min-h-[38px] px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 ${
            subTool === 'EASEMENT_LINE'
              ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
              : 'text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          <Zap className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Linha / Estrada</span>
        </button>

        <button
          type="button"
          data-testid="hitl-tool-exempt"
          onClick={() => onSelectSubTool('EXEMPT_ZONE')}
          className={`min-h-[38px] px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 col-span-2 sm:col-span-2 ${
            subTool === 'EXEMPT_ZONE'
              ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
              : 'text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          <Trees className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Ribeira / Pomar Isento</span>
        </button>
      </div>

      {/* Active Sub-Tool Instructions & Parameters */}
      {subTool === 'REVIEW' && (
        <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
          Clique num edifício, linha aérea, ribeira, cobertura CV ou copa diretamente no mapa — ou ajuste abaixo o papel (Próprio/Vizinho), largura de servidão e estatuto ICNF. Todas as alterações recalculam imediatamente os anéis booleanos em EPSG:3763.
        </p>
      )}

      {(subTool === 'OWN_BUILDING' || subTool === 'NEIGHBOR_BUILDING') && (
        <div className="pt-2 border-t border-slate-200 dark:border-[#263248] space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
              {subTool === 'OWN_BUILDING'
                ? 'Marcar Habitação / Anexo na Parcela (gera Zona 1–2–3)'
                : 'Marcar Edifício Vizinho Confinante (projeta faixa de 50 m)'}
            </span>

            <div
              role="group"
              aria-label="Modo de desenho da edificação"
              className="inline-flex items-center gap-1 p-0.5 rounded-lg bg-slate-100 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248]"
            >
              <button
                type="button"
                data-testid="hitl-bldg-style-stamp"
                onClick={() => onChangeBuildingDrawStyle('STAMP_1CLICK')}
                className={`min-h-[32px] px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  buildingDrawStyle === 'STAMP_1CLICK'
                    ? 'bg-white dark:bg-[#161E2E] text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                1-Clique (8.5×6.5 m)
              </button>
              <button
                type="button"
                data-testid="hitl-bldg-style-poly"
                onClick={() => onChangeBuildingDrawStyle('POLYGON')}
                className={`min-h-[32px] px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  buildingDrawStyle === 'POLYGON'
                    ? 'bg-white dark:bg-[#161E2E] text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                Polígono (≥3 pts)
              </button>
            </div>
          </div>

          <div>
            <label
              htmlFor="hitl-bldg-label"
              className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1"
            >
              Designação opcional
            </label>
            <input
              id="hitl-bldg-label"
              type="text"
              value={buildingCustomLabel}
              onChange={(e) => onChangeBuildingCustomLabel(e.target.value)}
              placeholder={
                subTool === 'OWN_BUILDING'
                  ? 'Ex.: Palheiro Agrícola / Casa de Arrumos'
                  : 'Ex.: Moradia Vizinha Nascente'
              }
              className="w-full min-h-[40px] px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
            />
          </div>

          {buildingDrawStyle === 'STAMP_1CLICK' && (
            <p className="text-xs text-[#14532D] dark:text-[#4ADE80]">
              Toque diretamente sobre o telhado na ortofoto para posicionar a implantação num só clique e recalcular as faixas.
            </p>
          )}
        </div>
      )}

      {subTool === 'EASEMENT_LINE' && (
        <div className="pt-2 border-t border-slate-200 dark:border-[#263248] space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <div className="sm:col-span-2">
              <label
                htmlFor="hitl-easement-preset"
                className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1"
              >
                Tipo de infraestrutura linear
              </label>
              <select
                id="hitl-easement-preset"
                data-testid="hitl-easement-preset-select"
                value={easementPreset}
                onChange={(e) => {
                  const nextPreset = e.target.value as EasementPresetCode;
                  onChangeEasementPreset(nextPreset);
                  onChangeEasementHalfWidthM(EASEMENT_PRESETS[nextPreset].defaultHalfWidthM);
                }}
                className="w-full min-h-[40px] px-2.5 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
              >
                <option value="EREDES_MT">Linha Aérea E-REDES MT (15–30 kV · ±4.25 m)</option>
                <option value="EREDES_AT">Linha Aérea E-REDES AT (60 kV · ±5.0 m)</option>
                <option value="REN_MAT">Linha REN Muito Alta Tensão (±14.0 m)</option>
                <option value="PUBLIC_ROAD">Estrada / Caminho Municipal (±5.0 m)</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="hitl-easement-width"
                className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1"
              >
                Meia-faixa (m)
              </label>
              <input
                id="hitl-easement-width"
                type="number"
                step="0.5"
                min="1.5"
                max="30"
                value={easementHalfWidthM}
                onChange={(e) => onChangeEasementHalfWidthM(Number(e.target.value) || 4.25)}
                className="w-full min-h-[40px] px-2.5 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs font-mono tabular-nums text-slate-900 dark:text-white"
              />
            </div>
          </div>

          <p className="text-xs text-slate-600 dark:text-slate-400">
            Clique nos apoios/postes visíveis na ortofoto (mínimo 2 pontos) e prima Guardar Traçado para subtrair a servidão à sua área de limpeza.
          </p>
        </div>
      )}

      {subTool === 'EXEMPT_ZONE' && (
        <div className="pt-2 border-t border-slate-200 dark:border-[#263248] space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <div className="sm:col-span-2">
              <label
                htmlFor="hitl-exempt-preset"
                className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1"
              >
                Regime de proteção ambiental / agrícola
              </label>
              <select
                id="hitl-exempt-preset"
                data-testid="hitl-exempt-preset-select"
                value={exemptPreset}
                onChange={(e) => onChangeExemptPreset(e.target.value as ExemptPresetCode)}
                className="w-full min-h-[40px] px-2.5 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
              >
                <option value="RIPARIAN_WATERWAY">Ribeira / Linha de Água (≥2 pontos)</option>
                <option value="IRRIGATED_AGRICULTURE">Pomar / Olival / Horta Regada (≥3 pontos)</option>
              </select>
            </div>

            {exemptPreset === 'RIPARIAN_WATERWAY' && (
              <div>
                <label
                  htmlFor="hitl-exempt-width"
                  className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1"
                >
                  Galeria (±m)
                </label>
                <input
                  id="hitl-exempt-width"
                  type="number"
                  step="1"
                  min="2"
                  max="20"
                  value={exemptHalfWidthM}
                  onChange={(e) => onChangeExemptHalfWidthM(Number(e.target.value) || 5)}
                  className="w-full min-h-[40px] px-2.5 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs font-mono tabular-nums text-slate-900 dark:text-white"
                />
              </div>
            )}
          </div>

          <p className="text-xs text-slate-600 dark:text-slate-400">
            {exemptPreset === 'RIPARIAN_WATERWAY'
              ? 'Marque 2 ou mais pontos ao longo do leito da linha de água para proteger a galeria ripícola (Art.º 49.º DL 82/2021).'
              : 'Marque 3 ou mais cantos do pomar, vinha ou cultura agrícola regada isenta de corte florestal.'}
          </p>
        </div>
      )}

      {/* Multi-Point Draft Commit Controls */}
      {isMultiPointMode && (
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <span className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-400">
            Pontos marcados: {draftPoints.length} / mín. {requiredMinPoints}
          </span>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={draftPoints.length === 0}
              onClick={onRemoveLastDraftPoint}
              className="min-h-[36px] px-2.5 py-1 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-45 whitespace-nowrap shrink-0"
            >
              Apagar Último
            </button>
            <button
              type="button"
              disabled={draftPoints.length === 0}
              onClick={onClearDraftPoints}
              className="min-h-[36px] px-2.5 py-1 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-45 whitespace-nowrap shrink-0"
            >
              Limpar
            </button>
            <button
              type="button"
              data-testid="hitl-commit-geometry-btn"
              disabled={draftPoints.length < requiredMinPoints}
              onClick={onCommitDraftGeometry}
              className="min-h-[38px] px-3.5 py-1.5 rounded-xl bg-[#14532D] hover:bg-[#0F3F22] dark:bg-[#22C55E] dark:hover:bg-[#16A34A] text-white dark:text-slate-950 text-xs font-semibold disabled:opacity-45 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
            >
              <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>Guardar Traçado</span>
            </button>
          </div>
        </div>
      )}

      {statusFeedbackPt && (
        <p
          role="status"
          aria-live="polite"
          data-testid="hitl-status-feedback"
          className="text-xs text-[#14532D] dark:text-[#4ADE80] flex items-center gap-1.5 tabular-nums"
        >
          <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>{statusFeedbackPt}</span>
        </p>
      )}

      {/* CV 25cm Human Validation Queue (Roofs & Tree Crowns) */}
      <div
        data-testid="hitl-cv-review-queue"
        className="pt-3 border-t border-slate-200 dark:border-[#263248] space-y-2.5"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
            Fila de Validação CV 25 cm (IA → Humano)
          </div>
          {!cv && (
            <button
              type="button"
              data-testid="hitl-trigger-cv-btn"
              disabled={runningOrthophotoCv}
              onClick={onRunOrthophotoCv}
              className="min-h-[34px] px-2.5 py-1 rounded-lg border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 shrink-0 ${runningOrthophotoCv ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span>{runningOrthophotoCv ? 'A analisar...' : 'Detetar Copas & Anexos'}</span>
            </button>
          )}
        </div>

        {!cv ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Execute a segmentação 25 cm para rever coberturas omissas no OSM e validar sobreiros protegidos ou copas já desramadas.
          </p>
        ) : unreviewedRoofs.length === 0 && priorityCrowns.length === 0 ? (
          <p className="text-xs text-[#14532D] dark:text-[#4ADE80]">
            Todas as deteções automáticas de ortofoto foram revistas e encontram-se conformes.
          </p>
        ) : (
          <div className="divide-y divide-slate-200 dark:divide-[#263248] text-xs">
            {unreviewedRoofs.map((roof) => (
              <div
                key={roof.id}
                className={`py-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${
                  selectedElementId === roof.id ? 'bg-slate-50 dark:bg-[#0B0F17] px-2 rounded-lg' : ''
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    onSelectElementId(roof.id);
                    onFocusMapLatLon(roof.centerWgs84);
                  }}
                  className="text-left min-w-0"
                >
                  <div className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                    {roof.label}
                  </div>
                  <div className="text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                    <span>{roof.areaM2.toFixed(1)} m²</span>
                    <span aria-hidden="true"> · </span>
                    <span>Confiança {Math.round(roof.confidence * 100)}%</span>
                    <span aria-hidden="true"> · </span>
                    <span>{roof.role === 'OWN' ? 'Interior do lote' : 'Exterior vizinho'}</span>
                  </div>
                </button>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    data-testid={`hitl-accept-own-${roof.id}`}
                    onClick={() => onReviewCvRoof(roof.id, 'ACCEPT_OWN')}
                    className={`min-h-[34px] px-2.5 py-1 rounded-lg font-semibold whitespace-nowrap shrink-0 ${
                      roof.role === 'OWN'
                        ? 'bg-[#14532D] hover:bg-[#0F3F22] dark:bg-[#22C55E] dark:text-slate-950 text-white'
                        : 'border border-slate-300 dark:border-[#263248] text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {roof.role === 'OWN' ? 'Validar Próprio' : 'Próprio'}
                  </button>
                  <button
                    type="button"
                    data-testid={`hitl-accept-neighbor-${roof.id}`}
                    onClick={() => onReviewCvRoof(roof.id, 'ACCEPT_NEIGHBOR')}
                    className={`min-h-[34px] px-2.5 py-1 rounded-lg font-semibold whitespace-nowrap shrink-0 ${
                      roof.role === 'NEIGHBOR'
                        ? 'bg-[#14532D] hover:bg-[#0F3F22] dark:bg-[#22C55E] dark:text-slate-950 text-white'
                        : 'border border-slate-300 dark:border-[#263248] text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {roof.role === 'NEIGHBOR' ? 'Validar Vizinho' : 'Vizinho'}
                  </button>
                  <button
                    type="button"
                    data-testid={`hitl-dismiss-${roof.id}`}
                    onClick={() => onReviewCvRoof(roof.id, 'DISMISS_FALSE_POSITIVE')}
                    className="min-h-[34px] px-2 py-1 rounded-lg border border-rose-300 dark:border-rose-800/60 text-[#DC2626] dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 font-semibold whitespace-nowrap shrink-0"
                  >
                    Descartar
                  </button>
                </div>
              </div>
            ))}

            {priorityCrowns.map((crown) => (
              <div
                key={crown.id}
                className={`py-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${
                  selectedElementId === crown.id ? 'bg-slate-50 dark:bg-[#0B0F17] px-2 rounded-lg' : ''
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    onSelectElementId(crown.id);
                    onFocusMapLatLon(crown.centerWgs84);
                  }}
                  className="text-left min-w-0"
                >
                  <div className="font-semibold text-slate-900 dark:text-slate-100 font-mono tabular-nums">
                    <span>Copa {crown.id}</span>
                    <span aria-hidden="true"> · </span>
                    <span>Ø {crown.diameterM.toFixed(1)} m</span>
                    <span aria-hidden="true"> · </span>
                    <span>Parede {crown.distanceToBuildingWallM.toFixed(1)} m</span>
                  </div>
                  <div className="text-slate-500 dark:text-slate-400 truncate">
                    {crown.humanOverride === 'PROTECTED_QUERCUS'
                      ? 'Validada: Sobreiro / Azinheira Protegida (DL 169/2001)'
                      : crown.humanOverride === 'PRUNED_COMPLIANT'
                        ? 'Validada: Copa já desramada / conforme no terreno'
                        : crown.violationRulePt}
                  </div>
                </button>

                <div className="flex items-center gap-1.5 shrink-0">
                  {crown.humanOverride ? (
                    <button
                      type="button"
                      data-testid={`hitl-crown-clear-${crown.id}`}
                      onClick={() => onOverrideCvCrown(crown.id, 'CLEAR')}
                      className="min-h-[34px] px-2.5 py-1 rounded-lg border border-slate-300 dark:border-[#263248] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 font-semibold whitespace-nowrap shrink-0"
                    >
                      Repor Regra CV
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        data-testid={`hitl-crown-quercus-${crown.id}`}
                        onClick={() => onOverrideCvCrown(crown.id, 'PROTECTED_QUERCUS')}
                        className="min-h-[34px] px-2.5 py-1 rounded-lg border border-amber-400 dark:border-amber-700 text-amber-900 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30 font-semibold whitespace-nowrap shrink-0"
                      >
                        Sobreiro ICNF
                      </button>
                      <button
                        type="button"
                        data-testid={`hitl-crown-pruned-${crown.id}`}
                        onClick={() => onOverrideCvCrown(crown.id, 'PRUNED_COMPLIANT')}
                        className="min-h-[34px] px-2.5 py-1 rounded-lg border border-[#14532D]/40 dark:border-[#22C55E]/40 text-[#14532D] dark:text-[#4ADE80] hover:bg-[#14532D]/10 dark:hover:bg-[#22C55E]/15 font-semibold whitespace-nowrap shrink-0"
                      >
                        Já Podada
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Active Vector Elements Inspector (Buildings, Easements, Exemptions) */}
      <div
        data-testid="hitl-active-elements-list"
        className="pt-3 border-t border-slate-200 dark:border-[#263248] space-y-2"
      >
        <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
          Elementos Ativos na Decomposição ({ctx.buildings.length + ctx.easements.length + ctx.exemptFeatures.length})
        </div>

        <div className="max-h-[240px] overflow-y-auto divide-y divide-slate-200 dark:divide-[#263248] text-xs pr-0.5">
          {ctx.buildings.map((bldg) => (
            <div
              key={bldg.id}
              className={`py-2 flex items-center justify-between gap-2 ${
                selectedElementId === bldg.id ? 'bg-slate-50 dark:bg-[#0B0F17] px-2 rounded-lg' : ''
              }`}
            >
              <button
                type="button"
                onClick={() => {
                  onSelectElementId(bldg.id);
                  if (bldg.footprint[0]) onFocusMapLatLon(bldg.footprint[0]);
                }}
                className="text-left min-w-0"
              >
                <div className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                  {bldg.label}
                </div>
                <div className="text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                  <span>{bldg.role === 'OWN' ? 'Próprio' : `Vizinho (${bldg.distanceToParcelEdgeM.toFixed(1)} m)`}</span>
                  <span aria-hidden="true"> · </span>
                  <span>{bldg.areaM2.toFixed(0)} m²</span>
                  <span aria-hidden="true"> · </span>
                  <span>{formatProvenancePt(bldg.source)}</span>
                </div>
              </button>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  data-testid={`hitl-toggle-bldg-${bldg.id}`}
                  onClick={() => onToggleBuildingRole(bldg.id)}
                  title="Alternar classificação entre Edifício Próprio e Edifício Vizinho"
                  className="min-h-[34px] px-2 py-1 rounded-lg border border-slate-300 dark:border-[#263248] text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 font-semibold whitespace-nowrap shrink-0"
                >
                  {bldg.role === 'OWN' ? '→ Vizinho' : '→ Próprio'}
                </button>
                <button
                  type="button"
                  data-testid={`hitl-remove-bldg-${bldg.id}`}
                  aria-label={`Remover edifício ${bldg.label}`}
                  onClick={() => onRemoveVectorElement('BUILDING', bldg.id)}
                  className="min-h-[34px] min-w-[34px] px-2 rounded-lg border border-slate-200 dark:border-[#263248] text-slate-500 hover:text-[#DC2626] dark:text-slate-400 dark:hover:text-rose-400 inline-flex items-center justify-center transition-colors shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>
          ))}

          {ctx.easements.map((eas) => (
            <div
              key={eas.id}
              className={`py-2 flex items-center justify-between gap-2 ${
                selectedElementId === eas.id ? 'bg-slate-50 dark:bg-[#0B0F17] px-2 rounded-lg' : ''
              }`}
            >
              <button
                type="button"
                onClick={() => {
                  onSelectElementId(eas.id);
                  if (eas.centerline[0]) onFocusMapLatLon(eas.centerline[0]);
                }}
                className="text-left min-w-0"
              >
                <div className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                  {eas.label}
                </div>
                <div className="text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                  <span>±{eas.bufferHalfWidthM} m</span>
                  <span aria-hidden="true"> · </span>
                  <span>{eas.operatorLabel}</span>
                  <span aria-hidden="true"> · </span>
                  <span>{formatProvenancePt(eas.source)}</span>
                </div>
              </button>

              <div className="flex items-center gap-1.5 shrink-0">
                <select
                  aria-label={`Largura da servidão ${eas.label}`}
                  data-testid={`hitl-easement-width-${eas.id}`}
                  value={String(eas.bufferHalfWidthM)}
                  onChange={(e) => onUpdateEasementWidth(eas.id, Number(e.target.value))}
                  className="min-h-[34px] px-1.5 py-1 rounded-lg bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] font-mono tabular-nums text-slate-900 dark:text-white"
                >
                  {[3.5, 4.0, 4.25, 5.0, 7.0, 10.0, 14.0].map((val) => (
                    <option key={val} value={String(val)}>
                      ±{val} m
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  data-testid={`hitl-remove-eas-${eas.id}`}
                  aria-label={`Remover servidão ${eas.label}`}
                  onClick={() => onRemoveVectorElement('EASEMENT', eas.id)}
                  className="min-h-[34px] min-w-[34px] px-2 rounded-lg border border-slate-200 dark:border-[#263248] text-slate-500 hover:text-[#DC2626] dark:text-slate-400 dark:hover:text-rose-400 inline-flex items-center justify-center transition-colors shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>
          ))}

          {ctx.exemptFeatures.map((ex) => {
            const focusPt = ex.centerline?.[0] ?? ex.polygon?.[0];
            return (
              <div
                key={ex.id}
                className={`py-2 flex items-center justify-between gap-2 ${
                  selectedElementId === ex.id ? 'bg-slate-50 dark:bg-[#0B0F17] px-2 rounded-lg' : ''
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    onSelectElementId(ex.id);
                    if (focusPt) onFocusMapLatLon(focusPt);
                  }}
                  className="text-left min-w-0"
                >
                  <div className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                    {ex.label}
                  </div>
                  <div className="text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                    <span>{ex.bufferHalfWidthM ? `±${ex.bufferHalfWidthM} m` : 'Polígono agrícola'}</span>
                    <span aria-hidden="true"> · </span>
                    <span>{formatProvenancePt(ex.source)}</span>
                  </div>
                </button>

                <button
                  type="button"
                  data-testid={`hitl-remove-exempt-${ex.id}`}
                  aria-label={`Remover zona isenta ${ex.label}`}
                  onClick={() => onRemoveVectorElement('EXEMPT', ex.id)}
                  className="min-h-[34px] min-w-[34px] px-2 rounded-lg border border-slate-200 dark:border-[#263248] text-slate-500 hover:text-[#DC2626] dark:text-slate-400 dark:hover:text-rose-400 inline-flex items-center justify-center transition-colors shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};
