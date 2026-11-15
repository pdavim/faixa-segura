import React, { useState } from 'react';
import {
  Award,
  BellRing,
  Briefcase,
  CheckCircle2,
  Download,
  LockOpen,
  QrCode,
  ShieldCheck,
  Star,
  Tractor,
} from 'lucide-react';
import type {
  ComplianceCertificate,
  ForestryProvider,
  MunicipalityInfo,
  ParcelRecord,
  QuoteLead,
} from '../types/domain.ts';
import { generateComplianceCertificatePdf } from '../lib/pdfTemplates.ts';

interface ProvidersGuardianViewProps {
  parcels: ParcelRecord[];
  activeParcel: ParcelRecord;
  certificates: ComplianceCertificate[];
  providers: ForestryProvider[];
  quotes: QuoteLead[];
  municipalities: MunicipalityInfo[];
  favoriteProviderIds?: string[];
  onToggleFavoriteProvider?: (providerId: string) => void;
  onSelectParcel: (parcelId: string) => void;
  onInspectCertificate: (cert: ComplianceCertificate) => void;
  onProviderRegistered: (provider: ForestryProvider) => void;
  onQuoteUnlocked: (updated: QuoteLead) => void;
}

const MACHINERY_OPTIONS = [
  'Equipa Apeada (Motorroçadoras / Motosserras)',
  'Trator Florestal de Rodas c/ Capinadeira',
  'Máquina de Rastos / Giratória Florestal c/ Destroçador',
  'Biotriturador / Recolha e Transporte de Sobrantes',
];

export const ProvidersGuardianView: React.FC<ProvidersGuardianViewProps> = ({
  parcels,
  activeParcel,
  certificates,
  providers,
  quotes,
  municipalities,
  favoriteProviderIds = [],
  onToggleFavoriteProvider,
  onSelectParcel,
  onInspectCertificate,
  onProviderRegistered,
  onQuoteUnlocked,
}) => {
  const [section, setSection] = useState<'leads' | 'register' | 'guardian'>('leads');

  // 3-Step B2B Registration Wizard State
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(1);
  const [companyName, setCompanyName] = useState('');
  const [nif, setNif] = useState('');
  const [caeCode, setCaeCode] = useState<'02400' | '81300'>('02400');
  const [phoneWhatsapp, setPhoneWhatsapp] = useState('');
  const [email, setEmail] = useState('');
  const [hasRcInsurance, setHasRcInsurance] = useState(true);
  const [hasSparkArrestor, setHasSparkArrestor] = useState(true);
  const [hasIcnfOakCredential, setHasIcnfOakCredential] = useState(false);
  const [selectedMachinery, setSelectedMachinery] = useState<string[]>([MACHINERY_OPTIONS[0]]);
  const [selectedDicos, setSelectedDicos] = useState<string[]>(['1111', '1009']);
  const [minAreaM2, setMinAreaM2] = useState(500);
  const [regError, setRegError] = useState<string | null>(null);
  const [regSuccess, setRegSuccess] = useState<ForestryProvider | null>(null);

  // Guardian Plan & Telegram Bot Alert State
  const [guardianActive, setGuardianActive] = useState(false);
  const [telegramHandle, setTelegramHandle] = useState('');
  const [telegramSaved, setTelegramSaved] = useState(false);

  const toggleMachinery = (item: string) => {
    setSelectedMachinery((prev) =>
      prev.includes(item) ? prev.filter((x) => x !== item) : [...prev, item]
    );
  };

  const toggleDico = (dico: string) => {
    setSelectedDicos((prev) =>
      prev.includes(dico) ? prev.filter((d) => d !== dico) : [...prev, dico]
    );
  };

  const handleUnlockLead = async (leadId: string) => {
    const res = await fetch(`/api/quotes/${encodeURIComponent(leadId)}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: providers[0]?.id }),
    });
    if (res.ok) {
      const updated = await res.json();
      onQuoteUnlocked(updated);
    }
  };

  const handleRegisterProvider = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegError(null);
    if (!companyName.trim() || nif.replace(/\D/g, '').length !== 9 || !phoneWhatsapp.trim()) {
      setRegError('Preencha Nome Comercial, NIF válido (9 dígitos) e WhatsApp no Passo 1.');
      setWizardStep(1);
      return;
    }
    if (!hasRcInsurance) {
      setRegError('Seguro de Responsabilidade Civil de Exploração válido é obrigatório.');
      setWizardStep(1);
      return;
    }

    const res = await fetch('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyName: companyName.trim(),
        nif: nif.trim(),
        caeCode,
        phoneWhatsapp: phoneWhatsapp.trim(),
        email: email.trim(),
        hasRcInsurance,
        hasSparkArrestor,
        hasIcnfOakCredential,
        machinery: selectedMachinery,
        coveredDicos: selectedDicos,
        minAreaM2,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setRegError(data.error || 'Erro ao registar prestador florestal.');
    } else {
      setRegSuccess(data);
      onProviderRegistered(data);
    }
  };

  const handleDownloadCert = async (cert: ComplianceCertificate) => {
    const bytes = await generateComplianceCertificatePdf(cert, window.location.origin);
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${cert.shortCode}_Auto_SGIFR.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  return (
    <div className="space-y-6">
      {/* Header & Section Switcher */}
      <div className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">
            Marketplace Florestal (/prestadores), Arquivo SHA-256 & Guardião
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Cobertura ativa: AML, AMP e 7 Distritos Críticos (Leiria, Coimbra, Aveiro, Santarém, Viseu, Castelo Branco e Braga)
          </p>
        </div>

        <div
          role="group"
          aria-label="Secções de prestadores e carteira de terrenos"
          className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248] overflow-x-auto"
        >
          <button
            type="button"
            onClick={() => setSection('leads')}
            className={`min-h-[42px] px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 ${
              section === 'leads'
                ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                : 'text-slate-700 dark:text-slate-300'
            }`}
          >
            <Briefcase className="w-3.5 h-3.5" aria-hidden="true" />
            Pedidos & Empresas ({quotes.length})
          </button>
          <button
            type="button"
            onClick={() => setSection('register')}
            className={`min-h-[42px] px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 ${
              section === 'register'
                ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                : 'text-slate-700 dark:text-slate-300'
            }`}
          >
            <Tractor className="w-3.5 h-3.5" aria-hidden="true" />
            Registar Prestador (3 Passos)
          </button>
          <button
            type="button"
            onClick={() => setSection('guardian')}
            className={`min-h-[42px] px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 ${
              section === 'guardian'
                ? 'bg-[#D97706] text-white'
                : 'text-slate-700 dark:text-slate-300'
            }`}
          >
            <Award className="w-3.5 h-3.5" aria-hidden="true" />
            Terrenos & Plano Guardião
          </button>
        </div>
      </div>

      {/* ==================== SECTION 1: B2B LEADS & DIRECTORY ==================== */}
      {section === 'leads' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Qualified Leads Feed (/prestadores/pedidos) */}
          <div className="lg:col-span-7 space-y-4">
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              Pedidos Qualificados Prontos a Orçamentar (/prestadores/pedidos)
            </h2>
            {quotes.map((lead) => {
              const unlocked = lead.unlockedByProviderIds.length > 0;
              return (
                <div
                  key={lead.id}
                  className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {lead.municipality} (DICO {lead.dico}) · {lead.preferredWindow}
                      </div>
                      <h3 className="text-base font-bold text-slate-900 dark:text-white mt-0.5">
                        {lead.parcelLabel}
                      </h3>
                    </div>
                    <span className="text-sm font-bold font-mono tabular-nums text-[#14532D] dark:text-[#4ADE80]">
                      {lead.mandatoryCleanAreaM2.toFixed(0)} m² obrigatórios
                    </span>
                  </div>

                  <div className="text-xs text-slate-600 dark:text-slate-300 tabular-nums">
                    Lote total: {lead.totalAreaM2.toFixed(0)} m² · Declive médio: {lead.avgSlopePct}% · Frente pavimentada: {lead.roadFrontageM} m · Biomassa NDVI: {lead.ndvi.toFixed(2)}
                    {lead.includeDebrisRemoval ? ' · Inclui recolha/biotrituração' : ''}
                  </div>

                  <div className="pt-3 border-t border-slate-200 dark:border-[#263248] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="text-xs tabular-nums text-slate-600 dark:text-slate-400">
                      {unlocked ? (
                        <span className="text-slate-900 dark:text-white font-semibold">
                          Contacto Desbloqueado: {lead.ownerName} · Tel. {lead.ownerPhone}
                        </span>
                      ) : (
                        <span>Referência estimada: {lead.estimatedBudgetRange}</span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleUnlockLead(lead.id)}
                      disabled={unlocked}
                      className={`min-h-[42px] px-4 py-2 rounded-xl text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap ${
                        unlocked
                          ? 'bg-slate-100 dark:bg-slate-800 text-slate-500'
                          : 'bg-[#D97706] hover:bg-[#B45309] text-white'
                      }`}
                    >
                      <LockOpen className="w-3.5 h-3.5" aria-hidden="true" />
                      {unlocked ? 'Contacto Desbloqueado' : 'Desbloquear Contacto & Enviar Orçamento'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Verified Contractors Directory */}
          <div className="lg:col-span-5 space-y-4">
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              Empresas Florestais Credenciadas ({providers.length})
            </h2>
            {providers.map((prov) => {
              const isFav = favoriteProviderIds.includes(prov.id);
              return (
                <div
                  key={prov.id}
                  className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-4 space-y-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                        {prov.companyName}
                      </h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                        NIF {prov.nif} · CAE {prov.caeCode} · Mín. {prov.minAreaM2} m²
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs font-mono font-bold tabular-nums text-[#14532D] dark:text-[#4ADE80]">
                        {prov.completedCertificates} Autos
                      </span>
                      {onToggleFavoriteProvider && (
                        <button
                          type="button"
                          onClick={() => onToggleFavoriteProvider(prov.id)}
                          aria-label={
                            isFav
                              ? `Remover ${prov.companyName} dos prestadores favoritos`
                              : `Guardar ${prov.companyName} nos prestadores favoritos`
                          }
                          className={`min-h-[38px] px-2.5 py-1 rounded-lg border text-xs font-semibold inline-flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 ${
                            isFav
                              ? 'border-[#D97706] bg-[#D97706]/10 text-[#B45309] dark:text-[#FBBF24]'
                              : 'border-slate-300 dark:border-[#263248] text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                          }`}
                        >
                          <Star
                            className={`w-3.5 h-3.5 ${isFav ? 'fill-current' : ''}`}
                            aria-hidden="true"
                          />
                          {isFav ? 'Favorito' : 'Guardar'}
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-300">
                    <strong>Concelhos:</strong> {prov.coveredMunicipalities.join(', ')}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Seguro RC Ativo
                    {prov.hasSparkArrestor ? ' · Retenção de Faúlhas' : ''}
                    {prov.hasIcnfOakCredential ? ' · Credenciado Quercíneas ICNF' : ''}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ==================== SECTION 2: 3-STEP B2B CONTRACTOR REGISTRATION ==================== */}
      {section === 'register' && (
        <form
          onSubmit={handleRegisterProvider}
          className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 sm:p-6 space-y-5 max-w-4xl"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-200 dark:border-[#263248]">
            <div>
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                Credenciação de Prestador Florestal / Jardinagem (/prestadores/registo)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Receba pedidos com ortofoto DGT, área exata em m² e declive via WhatsApp ou @FaixaSeguraParceirosBot.
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              {([1, 2, 3] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setWizardStep(st)}
                  className={`min-h-[40px] px-3 py-1.5 rounded-lg text-xs font-semibold ${
                    wizardStep === st
                      ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                      : 'bg-slate-100 dark:bg-[#0B0F17] text-slate-600 dark:text-slate-400'
                  }`}
                >
                  Passo {st}
                </button>
              ))}
            </div>
          </div>

          {wizardStep === 1 && (
            <div className="space-y-4">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                Passo 1 · Identificação Empresarial & Seguro Obrigatório
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="b2b-name" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Nome Comercial da Empresa / ENI
                  </label>
                  <input
                    id="b2b-name"
                    type="text"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    placeholder="Ex.: FlorestaLimpa Centro, Lda."
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                  />
                </div>
                <div>
                  <label htmlFor="b2b-nif" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    NIF Empresarial (9 dígitos)
                  </label>
                  <input
                    id="b2b-nif"
                    type="text"
                    inputMode="numeric"
                    maxLength={9}
                    value={nif}
                    onChange={(e) => setNif(e.target.value)}
                    placeholder="Ex.: 515902341"
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm font-mono text-slate-900 dark:text-white"
                  />
                </div>
                <div>
                  <label htmlFor="b2b-cae" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    CAE Principal
                  </label>
                  <select
                    id="b2b-cae"
                    value={caeCode}
                    onChange={(e) => setCaeCode(e.target.value as '02400' | '81300')}
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                  >
                    <option value="02400">02400 — Serviços relacionados com a silvicultura</option>
                    <option value="81300">81300 — Plantação e manutenção de jardins</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="b2b-phone" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Telemóvel / WhatsApp Operacional
                  </label>
                  <input
                    id="b2b-phone"
                    type="tel"
                    value={phoneWhatsapp}
                    onChange={(e) => setPhoneWhatsapp(e.target.value)}
                    placeholder="Ex.: +351 916 402 118"
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm font-mono text-slate-900 dark:text-white"
                  />
                </div>
              </div>

              <div className="space-y-2 pt-2">
                <label className="flex items-center gap-2.5 text-xs text-slate-800 dark:text-slate-200 min-h-[40px] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={hasRcInsurance}
                    onChange={(e) => setHasRcInsurance(e.target.checked)}
                    className="w-4 h-4 rounded accent-[#14532D]"
                  />
                  Seguro de Responsabilidade Civil de Exploração válido (obrigatório)
                </label>
                <label className="flex items-center gap-2.5 text-xs text-slate-800 dark:text-slate-200 min-h-[40px] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={hasSparkArrestor}
                    onChange={(e) => setHasSparkArrestor(e.target.checked)}
                    className="w-4 h-4 rounded accent-[#14532D]"
                  />
                  Equipamento homologado com retenção de faúlhas e kit de 1.ª intervenção
                </label>
                <label className="flex items-center gap-2.5 text-xs text-slate-800 dark:text-slate-200 min-h-[40px] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={hasIcnfOakCredential}
                    onChange={(e) => setHasIcnfOakCredential(e.target.checked)}
                    className="w-4 h-4 rounded accent-[#14532D]"
                  />
                  Técnico habilitado p/ intervenção em quercíneas (Sobreiro/Azinheira) c/ Manifesto ICNF
                </label>
              </div>

              <input type="hidden" value={email} onChange={(e) => setEmail(e.target.value)} />

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setWizardStep(2)}
                  className="min-h-[44px] px-5 py-2 rounded-xl bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950 text-xs font-semibold"
                >
                  Seguinte: Parque de Maquinaria
                </button>
              </div>
            </div>
          )}

          {wizardStep === 2 && (
            <div className="space-y-4">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                Passo 2 · Capacidade Operacional & Maquinaria (Matching por Declive)
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {MACHINERY_OPTIONS.map((opt) => {
                  const checked = selectedMachinery.includes(opt);
                  return (
                    <label
                      key={opt}
                      className={`p-3.5 rounded-xl border text-xs font-medium cursor-pointer flex items-center gap-3 min-h-[52px] ${
                        checked
                          ? 'border-[#14532D] bg-[#14532D]/10 dark:border-[#22C55E] dark:bg-[#22C55E]/15 text-slate-900 dark:text-white'
                          : 'border-slate-300 dark:border-[#263248] text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleMachinery(opt)}
                        className="w-4 h-4 rounded accent-[#14532D]"
                      />
                      <span>{opt}</span>
                    </label>
                  );
                })}
              </div>
              <div className="flex justify-between pt-2">
                <button
                  type="button"
                  onClick={() => setWizardStep(1)}
                  className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold"
                >
                  Anterior
                </button>
                <button
                  type="button"
                  onClick={() => setWizardStep(3)}
                  className="min-h-[44px] px-5 py-2 rounded-xl bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950 text-xs font-semibold"
                >
                  Seguinte: Concelhos DICO
                </button>
              </div>
            </div>
          )}

          {wizardStep === 3 && (
            <div className="space-y-4">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                Passo 3 · Cobertura Geográfica por Concelho (DICO) & Área Mínima
              </h3>
              <div className="flex flex-wrap gap-2">
                {municipalities.map((m) => {
                  const active = selectedDicos.includes(m.dico);
                  return (
                    <button
                      key={m.dico}
                      type="button"
                      onClick={() => toggleDico(m.dico)}
                      className={`min-h-[40px] px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors ${
                        active
                          ? 'border-[#14532D] bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                          : 'border-slate-300 dark:border-[#263248] text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      {m.name} ({m.dico})
                    </button>
                  );
                })}
              </div>

              <div className="max-w-xs">
                <label htmlFor="b2b-min-area" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Área Mínima de Deslocação (m²)
                </label>
                <input
                  id="b2b-min-area"
                  type="number"
                  min={100}
                  step={100}
                  value={minAreaM2}
                  onChange={(e) => setMinAreaM2(Number(e.target.value))}
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm font-mono tabular-nums text-slate-900 dark:text-white"
                />
              </div>

              {regError && (
                <p role="alert" className="text-xs font-semibold text-[#DC2626]">
                  {regError}
                </p>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setWizardStep(2)}
                  className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold"
                >
                  Anterior
                </button>
                <button
                  type="submit"
                  className="min-h-[46px] px-6 py-2.5 rounded-xl bg-[#D97706] hover:bg-[#B45309] text-white text-sm font-semibold"
                >
                  Concluir Credenciação B2B (3 Primeiras Leads Gratuitas)
                </button>
              </div>
            </div>
          )}

          {regSuccess && (
            <div className="rounded-xl p-4 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-400 text-xs flex items-center justify-between gap-3">
              <div>
                <strong className="text-slate-900 dark:text-white">
                  Empresa {regSuccess.companyName} credenciada com sucesso!
                </strong>{' '}
                Ativa nos concelhos {regSuccess.coveredMunicipalities.join(', ')}.
              </div>
              <button
                type="button"
                onClick={() => setSection('leads')}
                className="min-h-[40px] px-3 py-1.5 rounded-lg bg-[#14532D] text-white text-xs font-semibold whitespace-nowrap"
              >
                Ver Bolsa de Pedidos
              </button>
            </div>
          )}
        </form>
      )}

      {/* ==================== SECTION 3: PARCELS, ARCHIVE & PLANO GUARDIÃO ==================== */}
      {section === 'guardian' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Family Parcels & SHA-256 Archive */}
            <div className="lg:col-span-7 space-y-5">
              <div className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-3">
                <h2 className="text-base font-bold text-slate-900 dark:text-white">
                  Carteira de Terrenos Vigiados ({parcels.length}/10 no Plano Guardião)
                </h2>
                <div className="divide-y divide-slate-200 dark:divide-[#263248]">
                  {parcels.map((p) => {
                    const isSelected = p.id === activeParcel.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => onSelectParcel(p.id)}
                        className="w-full py-3 first:pt-1 last:pb-1 flex items-center justify-between gap-3 text-left min-h-[54px]"
                      >
                        <div>
                          <div className="text-sm font-bold text-slate-900 dark:text-white">
                            {p.label} {isSelected ? '· Ativo' : ''}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                            {p.municipality} (DICO {p.dico}) · {p.bupiRggId} · Faixa {p.spatial.mandatoryCleanAreaM2.toFixed(0)} m²
                          </div>
                        </div>
                        <span className="text-xs font-mono font-semibold text-[#14532D] dark:text-[#4ADE80] shrink-0">
                          Selecionar
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Immutable SHA-256 Certificates Archive */}
              <div className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-3">
                <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-[#0284C7]" aria-hidden="true" />
                  Arquivo Imutável de Autos Digitais SHA-256 ({certificates.length})
                </h2>
                <div className="divide-y divide-slate-200 dark:divide-[#263248]">
                  {certificates.map((cert) => (
                    <div key={cert.id} className="py-3 first:pt-1 last:pb-1 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-bold font-mono text-slate-900 dark:text-white">
                          #{cert.shortCode} · {cert.municipality}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                          {cert.parcelLabel} · {cert.cleanedAreaM2.toFixed(0)} m² · {new Date(cert.issuedAt).toLocaleDateString('pt-PT')}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => onInspectCertificate(cert)}
                          className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 dark:border-[#263248] text-xs font-semibold inline-flex items-center gap-1.5"
                        >
                          <QrCode className="w-3.5 h-3.5" aria-hidden="true" />
                          Verificar Hash
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDownloadCert(cert)}
                          className="min-h-[40px] px-3 py-1.5 rounded-lg bg-[#0F172A] dark:bg-white text-white dark:text-slate-950 text-xs font-semibold inline-flex items-center gap-1.5"
                        >
                          <Download className="w-3.5 h-3.5" aria-hidden="true" />
                          PDF A4
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Plano Guardião (14,90 €/ano) & Telegram Bot */}
            <div className="lg:col-span-5 space-y-5">
              <div className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-4">
                <div className="flex items-baseline justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                      Para famílias e heranças indivisas
                    </div>
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                      Plano Guardião
                    </h2>
                  </div>
                  <div className="text-right font-mono tabular-nums">
                    <span className="text-2xl font-bold text-slate-900 dark:text-white">14,90 €</span>
                    <span className="text-xs text-slate-500"> / ano</span>
                  </div>
                </div>

                <div className="divide-y divide-slate-200 dark:divide-[#263248] text-xs">
                  <div className="py-2 flex justify-between">
                    <span className="text-slate-600 dark:text-slate-300">Terrenos vigiados (BUPi / Matriz)</span>
                    <span className="font-semibold text-slate-900 dark:text-white">Até 10 lotes (vs. 1 grátis)</span>
                  </div>
                  <div className="py-2 flex justify-between">
                    <span className="text-slate-600 dark:text-slate-300">Semáforo IPMA Fim de Semana</span>
                    <span className="font-semibold text-slate-900 dark:text-white">3 dias + Alerta 6.ª feira</span>
                  </div>
                  <div className="py-2 flex justify-between">
                    <span className="text-slate-600 dark:text-slate-300">Radar Fogo Ativo ANEPC (15 km)</span>
                    <span className="font-semibold text-slate-900 dark:text-white">Telegram + Push 24/7</span>
                  </div>
                  <div className="py-2 flex justify-between">
                    <span className="text-slate-600 dark:text-slate-300">Autos PDF SHA-256 + Minuta GTF</span>
                    <span className="font-semibold text-slate-900 dark:text-white">Emissão ilimitada</span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setGuardianActive(true)}
                  className={`w-full min-h-[46px] px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
                    guardianActive
                      ? 'bg-[#14532D] text-white'
                      : 'bg-[#D97706] hover:bg-[#B45309] text-white'
                  }`}
                >
                  {guardianActive ? 'Plano Guardião Ativo na Conta' : 'Ativar Plano Guardião · 14,90 €/ano'}
                </button>
              </div>

              {/* Telegram Bot Alert Configuration */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (telegramHandle.trim()) setTelegramSaved(true);
                }}
                className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-3"
              >
                <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <BellRing className="w-4 h-4 text-[#14532D] dark:text-[#22C55E]" aria-hidden="true" />
                  Alertas Familiares no Telegram (@FaixaSeguraBot)
                </h3>
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  Notifica imediatamente quando um fogo rural entra num raio de 15 km ou quando o NDVI satélite ultrapassa 0.55.
                </p>
                <div className="flex gap-2">
                  <label htmlFor="tg-handle" className="sr-only">
                    Utilizador Telegram
                  </label>
                  <input
                    id="tg-handle"
                    type="text"
                    value={telegramHandle}
                    onChange={(e) => {
                      setTelegramHandle(e.target.value);
                      setTelegramSaved(false);
                    }}
                    placeholder="@utilizador_familia"
                    className="flex-1 min-h-[44px] px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs font-mono text-slate-900 dark:text-white"
                  />
                  <button
                    type="submit"
                    className="min-h-[44px] px-4 py-2 rounded-xl bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950 text-xs font-semibold whitespace-nowrap"
                  >
                    Associar
                  </button>
                </div>
                {telegramSaved && (
                  <p className="text-xs text-[#16A34A] font-semibold flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                    Canal {telegramHandle} ligado à vigia de {activeParcel.label}.
                  </p>
                )}
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
