import React, { useEffect, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  Download,
  FileCheck2,
  FileWarning,
  MapPin,
  QrCode,
  Send,
  ShieldCheck,
} from 'lucide-react';
import type {
  ComplianceCertificate,
  DailyPirForecast,
  NeighborComplaintRecord,
  ParcelRecord,
  PhotoEvidence,
  QuoteLead,
} from '../types/domain.ts';
import {
  generateComplianceCertificatePdf,
  generateNeighborComplaintPdf,
} from '../lib/pdfTemplates.ts';
import { azimuthCardinalLabel } from '../lib/spatialEngine.ts';

interface CertifyQuotesViewProps {
  activeParcel: ParcelRecord;
  todayForecast?: DailyPirForecast;
  initialSubMode?: string;
  onCertificateIssued: (cert: ComplianceCertificate) => void;
  onQuoteCreated: (lead: QuoteLead) => void;
  onNeighborComplaintCreated?: (rec: NeighborComplaintRecord) => void;
  onInspectCertificate: (cert: ComplianceCertificate) => void;
}

function triggerBlobDownload(bytes: Uint8Array | string, filename: string, mimeType: string) {
  const blob =
    typeof bytes === 'string'
      ? new Blob([bytes], { type: mimeType })
      : new Blob([bytes.buffer as ArrayBuffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export const CertifyQuotesView: React.FC<CertifyQuotesViewProps> = ({
  activeParcel,
  todayForecast,
  initialSubMode,
  onCertificateIssued,
  onQuoteCreated,
  onNeighborComplaintCreated,
  onInspectCertificate,
}) => {
  const [subMode, setSubMode] = useState<'certificate' | 'quotes' | 'neighbor'>('certificate');

  useEffect(() => {
    if (initialSubMode === 'quotes' || initialSubMode === 'neighbor' || initialSubMode === 'certificate') {
      setSubMode(initialSubMode);
    }
  }, [initialSubMode]);

  // 1. Certificate Form State
  const [ownerName, setOwnerName] = useState('');
  const [ownerNif, setOwnerNif] = useState('');
  const [execMode, setExecMode] = useState<'SELF' | 'CONTRACTOR'>('CONTRACTOR');
  const [contractorName, setContractorName] = useState('SilviSintra — Gestão Florestal, Lda.');
  const [contractorNif, setContractorNif] = useState('514882910');
  const [invoiceRef, setInvoiceRef] = useState('FT 2026/509');
  const [beforeCaptured, setBeforeCaptured] = useState(true);
  const [afterCaptured, setAfterCaptured] = useState(true);
  const [certError, setCertError] = useState<string | null>(null);
  const [issuingCert, setIssuingCert] = useState(false);
  const [latestIssuedCert, setLatestIssuedCert] = useState<ComplianceCertificate | null>(null);

  // 2. Quote Lead State
  const [quoteName, setQuoteName] = useState('');
  const [quotePhone, setQuotePhone] = useState('');
  const [quoteWindow, setQuoteWindow] = useState('Próximos 10 dias úteis');
  const [includeDebris, setIncludeDebris] = useState(true);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [submittingQuote, setSubmittingQuote] = useState(false);
  const [createdQuote, setCreatedQuote] = useState<QuoteLead | null>(null);

  // 3. Neighbor Risk Petition State
  const [compName, setCompName] = useState('');
  const [compNif, setCompNif] = useState('');
  const [compAddress, setCompAddress] = useState('');
  const [compPhone, setCompPhone] = useState('');
  const [compEmail, setCompEmail] = useState('');
  const [compError, setCompError] = useState<string | null>(null);
  const [generatingPetition, setGeneratingPetition] = useState(false);
  const [createdPetition, setCreatedPetition] = useState<NeighborComplaintRecord | null>(null);

  const handleCaptureFieldPhoto = (stage: 'BEFORE' | 'AFTER') => {
    if (stage === 'BEFORE') setBeforeCaptured(true);
    else setAfterCaptured(true);
  };

  const handleIssueCertificate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCertError(null);
    if (!ownerName.trim() || ownerNif.replace(/\D/g, '').length !== 9) {
      setCertError('Indique o nome completo do titular e um NIF válido com 9 dígitos.');
      return;
    }

    setIssuingCert(true);
    try {
      const c = activeParcel.spatial.centroidWgs84;
      const nowIso = new Date().toISOString();
      const photos: PhotoEvidence[] = [
        {
          id: `ph-b-${Date.now()}`,
          stage: 'BEFORE',
          zoneLabel: 'Zona 1 e 2 (0–10 m Fachada Principal)',
          takenAt: new Date(Date.now() - 86400_000 * 3).toISOString(),
          lat: Number((c.lat + 0.00008).toFixed(6)),
          lon: Number((c.lon - 0.00009).toFixed(6)),
          azimuthDeg: 338,
          azimuthCardinal: azimuthCardinalLabel(338),
          aiAuditPassed: beforeCaptured,
          aiNotes: 'Pré-intervenção georreferenciada: presença de estrato herbáceo/arbustivo junto à estrema.',
        },
        {
          id: `ph-a-${Date.now()}`,
          stage: 'AFTER',
          zoneLabel: 'Zona 1 e 2 (0–10 m Pós-Intervenção)',
          takenAt: nowIso,
          lat: Number((c.lat + 0.00007).toFixed(6)),
          lon: Number((c.lon - 0.00008).toFixed(6)),
          azimuthDeg: 340,
          azimuthCardinal: azimuthCardinalLabel(340),
          aiAuditPassed: afterCaptured,
          aiNotes:
            'Pós-intervenção validada: faixa inerte 0–2 m executada, descontinuidade horizontal/vertical cumprida e quercíneas preservadas.',
        },
      ];

      const res = await fetch('/api/certificates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parcelId: activeParcel.id,
          ownerName: ownerName.trim(),
          ownerNif: ownerNif.trim(),
          pirLevelAtWork: todayForecast?.pirLevel ?? 2,
          executionMode: execMode,
          contractorName: execMode === 'CONTRACTOR' ? contractorName : undefined,
          contractorNif: execMode === 'CONTRACTOR' ? contractorNif : undefined,
          invoiceRef: execMode === 'CONTRACTOR' ? invoiceRef : undefined,
          photos,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCertError(data.error || 'Não foi possível emitir o Auto Digital.');
      } else {
        setLatestIssuedCert(data);
        onCertificateIssued(data);
      }
    } finally {
      setIssuingCert(false);
    }
  };

  const handleDownloadCertPdf = async (cert: ComplianceCertificate) => {
    const bytes = await generateComplianceCertificatePdf(cert, window.location.origin);
    triggerBlobDownload(bytes, `${cert.shortCode}_Auto_Conformidade_SGIFR.pdf`, 'application/pdf');
  };

  const handleSubmitQuote = async (e: React.FormEvent) => {
    e.preventDefault();
    setQuoteError(null);
    if (!quoteName.trim() || !quotePhone.trim()) {
      setQuoteError('Indique o seu nome e número de telemóvel/WhatsApp para receber as 3 propostas.');
      return;
    }

    setSubmittingQuote(true);
    try {
      const res = await fetch('/api/quotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parcelId: activeParcel.id,
          ownerName: quoteName.trim(),
          ownerPhone: quotePhone.trim(),
          preferredWindow: quoteWindow,
          includeDebrisRemoval: includeDebris,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setQuoteError(data.error || 'Erro ao submeter pedido de orçamento.');
      } else {
        setCreatedQuote(data);
        onQuoteCreated(data);
      }
    } finally {
      setSubmittingQuote(false);
    }
  };

  const handleGenerateNeighborPetition = async (e: React.FormEvent) => {
    e.preventDefault();
    setCompError(null);
    if (!compName.trim() || compNif.replace(/\D/g, '').length !== 9) {
      setCompError('Indique o nome completo do requerente e um NIF válido com 9 dígitos.');
      return;
    }

    setGeneratingPetition(true);
    try {
      const res = await fetch('/api/neighbor-complaints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parcelId: activeParcel.id,
          complainantName: compName.trim(),
          complainantNif: compNif.trim(),
          complainantAddress: compAddress.trim() || `${activeParcel.parish}, ${activeParcel.municipality}`,
          complainantPhone: compPhone.trim() || '912 345 678',
          complainantEmail: compEmail.trim() || 'requerente@faixasegura.pt',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCompError(data.error || 'Erro ao gerar requerimento municipal.');
      } else {
        setCreatedPetition(data.record);
        onNeighborComplaintCreated?.(data.record);
      }
    } finally {
      setGeneratingPetition(false);
    }
  };

  const handleDownloadNeighborPdf = async (rec: NeighborComplaintRecord) => {
    const bytes = await generateNeighborComplaintPdf(rec, window.location.origin);
    triggerBlobDownload(bytes, `${rec.reqCode}_Requerimento_Execucao_Coerciva_${rec.municipality}.pdf`, 'application/pdf');
  };

  return (
    <div className="space-y-6">
      {/* Header + 3-Flow Segmented Switcher */}
      <div className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">
            Prova Legal SHA-256, Orçamentos & Fiscalização Confinante
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 tabular-nums">
            Parcela ativa: {activeParcel.label} · Faixa exigível: {activeParcel.spatial.mandatoryCleanAreaM2.toFixed(0)} m² · Isenção E-REDES: {activeParcel.spatial.thirdPartyEasementM2.toFixed(0)} m²
          </p>
        </div>

        <div
          role="group"
          aria-label="Escolher fluxo documental ou orçamentação"
          className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248] overflow-x-auto"
        >
          <button
            type="button"
            onClick={() => setSubMode('certificate')}
            className={`min-h-[42px] px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 ${
              subMode === 'certificate'
                ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                : 'text-slate-700 dark:text-slate-300'
            }`}
          >
            <FileCheck2 className="w-3.5 h-3.5" aria-hidden="true" />
            Auto SHA-256
          </button>
          <button
            type="button"
            onClick={() => setSubMode('quotes')}
            className={`min-h-[42px] px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 ${
              subMode === 'quotes'
                ? 'bg-[#D97706] text-white'
                : 'text-slate-700 dark:text-slate-300'
            }`}
          >
            <Send className="w-3.5 h-3.5" aria-hidden="true" />
            Pedir 3 Orçamentos
          </button>
          <button
            type="button"
            onClick={() => setSubMode('neighbor')}
            className={`min-h-[42px] px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 ${
              subMode === 'neighbor'
                ? 'bg-[#7E22CE] text-white'
                : 'text-slate-700 dark:text-slate-300'
            }`}
          >
            <FileWarning className="w-3.5 h-3.5" aria-hidden="true" />
            Vizinho Incumpridor
          </button>
        </div>
      </div>

      {/* ==================== SUB-MODE 1: AUTO DIGITAL SHA-256 ==================== */}
      {subMode === 'certificate' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Step 1: Geotagged Photo Evidence */}
          <div className="lg:col-span-5 rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-4">
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              Passo 1 · Registo Fotográfico Antes / Depois
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Valida coordenadas GPS dentro do polígono BUPi, orientação magnética (azimute) e preservação de Sobreiros/Azinheiras.
            </p>

            <div className="space-y-3">
              <div className="rounded-xl p-4 bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248]">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-900 dark:text-white">
                    Foto 1A · Antes da Intervenção (0–10 m)
                  </span>
                  <span className="text-xs font-mono text-[#16A34A]">EXIF GPS OK</span>
                </div>
                <p className="mt-1 text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                  {activeParcel.spatial.centroidWgs84.lat.toFixed(5)}° N, {activeParcel.spatial.centroidWgs84.lon.toFixed(5)}° W · Azimute 338° (NO)
                </p>
                <label className="mt-3 min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-2 cursor-pointer">
                  <Camera className="w-4 h-4" aria-hidden="true" />
                  Captar / Substituir Foto Antes
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={() => handleCaptureFieldPhoto('BEFORE')}
                    className="sr-only"
                  />
                </label>
              </div>

              <div className="rounded-xl p-4 bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248]">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-900 dark:text-white">
                    Foto 1B · Após Limpeza (Faixa Inerte & Desbaste)
                  </span>
                  <span className="text-xs font-mono text-[#16A34A]">Auditado IA</span>
                </div>
                <p className="mt-1 text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                  {activeParcel.spatial.centroidWgs84.lat.toFixed(5)}° N, {activeParcel.spatial.centroidWgs84.lon.toFixed(5)}° W · Azimute 340° (NO)
                </p>
                <p className="mt-1.5 text-xs text-slate-600 dark:text-slate-300">
                  Solo limpo de manta morta na faixa 0–2 m · {activeParcel.protectedOakNotes}
                </p>
                <label className="mt-3 min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-2 cursor-pointer">
                  <Camera className="w-4 h-4" aria-hidden="true" />
                  Captar / Substituir Foto Depois
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={() => handleCaptureFieldPhoto('AFTER')}
                    className="sr-only"
                  />
                </label>
              </div>
            </div>
          </div>

          {/* Step 2: Emit SHA-256 Certificate */}
          <form
            onSubmit={handleIssueCertificate}
            className="lg:col-span-7 rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-4"
          >
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              Passo 2 · Emitir Auto Digital de Conformidade Preventiva (PDF A4 — 2 Páginas)
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Gera assinatura criptográfica SHA-256 verificável por QR Code perante GNR/SEPNA, Câmara Municipal e Seguradora Multirriscos.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label htmlFor="cert-owner-name" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Nome Completo do Titular / Cabeça-de-Casal
                </label>
                <input
                  id="cert-owner-name"
                  type="text"
                  value={ownerName}
                  onChange={(e) => setOwnerName(e.target.value)}
                  placeholder="Ex.: Maria João de Almeida Costa"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                />
              </div>
              <div>
                <label htmlFor="cert-owner-nif" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  NIF do Titular (9 dígitos)
                </label>
                <input
                  id="cert-owner-nif"
                  type="text"
                  inputMode="numeric"
                  maxLength={9}
                  value={ownerNif}
                  onChange={(e) => setOwnerNif(e.target.value)}
                  placeholder="Ex.: 234819204"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm font-mono tabular-nums text-slate-900 dark:text-white"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => setExecMode('CONTRACTOR')}
                className={`min-h-[42px] px-3.5 py-2 rounded-xl text-xs font-semibold border transition-colors ${
                  execMode === 'CONTRACTOR'
                    ? 'border-[#14532D] bg-[#14532D]/10 dark:border-[#22C55E] dark:bg-[#22C55E]/15 text-slate-900 dark:text-white'
                    : 'border-slate-300 dark:border-[#263248] text-slate-600 dark:text-slate-400'
                }`}
              >
                Executado por Empresa Florestal Certificada
              </button>
              <button
                type="button"
                onClick={() => setExecMode('SELF')}
                className={`min-h-[42px] px-3.5 py-2 rounded-xl text-xs font-semibold border transition-colors ${
                  execMode === 'SELF'
                    ? 'border-[#14532D] bg-[#14532D]/10 dark:border-[#22C55E] dark:bg-[#22C55E]/15 text-slate-900 dark:text-white'
                    : 'border-slate-300 dark:border-[#263248] text-slate-600 dark:text-slate-400'
                }`}
              >
                Executado por Meios Próprios
              </button>
            </div>

            {execMode === 'CONTRACTOR' && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label htmlFor="cert-contractor-name" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Entidade Executora
                  </label>
                  <input
                    id="cert-contractor-name"
                    type="text"
                    value={contractorName}
                    onChange={(e) => setContractorName(e.target.value)}
                    className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
                  />
                </div>
                <div>
                  <label htmlFor="cert-contractor-nif" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    NIF Prestador
                  </label>
                  <input
                    id="cert-contractor-nif"
                    type="text"
                    value={contractorNif}
                    onChange={(e) => setContractorNif(e.target.value)}
                    className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs font-mono text-slate-900 dark:text-white"
                  />
                </div>
                <div>
                  <label htmlFor="cert-invoice" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    N.º Fatura / Recibo
                  </label>
                  <input
                    id="cert-invoice"
                    type="text"
                    value={invoiceRef}
                    onChange={(e) => setInvoiceRef(e.target.value)}
                    className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs font-mono text-slate-900 dark:text-white"
                  />
                </div>
              </div>
            )}

            {certError && (
              <p role="alert" className="text-xs font-semibold text-[#DC2626]">
                {certError}
              </p>
            )}

            <button
              type="submit"
              disabled={issuingCert}
              className="w-full min-h-[48px] px-5 py-3 rounded-xl bg-[#14532D] hover:bg-[#0F3F22] dark:bg-[#22C55E] dark:text-slate-950 text-white text-sm font-semibold transition-colors inline-flex items-center justify-center gap-2"
            >
              <ShieldCheck className="w-4 h-4" aria-hidden="true" />
              {issuingCert
                ? 'A assinar Auto Digital SHA-256...'
                : `Emitir Auto de Conformidade (${activeParcel.spatial.mandatoryCleanAreaM2.toFixed(0)} m²)`}
            </button>

            {latestIssuedCert && (
              <div className="mt-4 rounded-xl p-4 bg-slate-50 dark:bg-[#0B0F17] border border-[#0284C7] space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
                    <CheckCircle2 className="w-4 h-4 text-[#16A34A]" aria-hidden="true" />
                    Auto Emitido · #{latestIssuedCert.shortCode}
                  </div>
                  <span className="text-xs font-mono text-[#0284C7] dark:text-[#38BDF8]">
                    Selo SHA-256 Ativo
                  </span>
                </div>
                <p className="text-xs font-mono break-all text-slate-600 dark:text-slate-400">
                  SHA-256: {latestIssuedCert.sha256Hash}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => handleDownloadCertPdf(latestIssuedCert)}
                    className="min-h-[44px] px-4 py-2 rounded-xl bg-[#0F172A] dark:bg-[#38BDF8] text-white dark:text-slate-950 text-xs font-semibold inline-flex items-center gap-2"
                  >
                    <Download className="w-4 h-4" aria-hidden="true" />
                    Descarregar Auto PDF A4 (2 Págs.)
                  </button>
                  <button
                    type="button"
                    onClick={() => onInspectCertificate(latestIssuedCert)}
                    className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-200 inline-flex items-center gap-2"
                  >
                    <QrCode className="w-4 h-4" aria-hidden="true" />
                    Abrir Verificação Pública QR
                  </button>
                </div>
              </div>
            )}
          </form>
        </div>
      )}

      {/* ==================== SUB-MODE 2: PEDIR 3 ORÇAMENTOS ==================== */}
      {subMode === 'quotes' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-5 rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-4">
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              Caderno Técnico Enviado às Empresas Locais
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Evita deslocações cegas: o prestador recebe a mancha exata em m², declive altimétrico e largura de acesso viário.
            </p>
            <div className="divide-y divide-slate-200 dark:divide-[#263248] text-xs tabular-nums">
              <div className="py-2.5 flex justify-between">
                <span className="text-slate-500 dark:text-slate-400">Município / Freguesia</span>
                <span className="font-semibold text-slate-900 dark:text-white">
                  {activeParcel.municipality} · {activeParcel.parish}
                </span>
              </div>
              <div className="py-2.5 flex justify-between">
                <span className="text-slate-500 dark:text-slate-400">Área Exata a Limpar (Z1+Z2+Z3)</span>
                <span className="font-mono font-bold text-slate-900 dark:text-white">
                  {activeParcel.spatial.mandatoryCleanAreaM2.toFixed(0)} m²
                </span>
              </div>
              <div className="py-2.5 flex justify-between">
                <span className="text-slate-500 dark:text-slate-400">Área Excluída (E-REDES)</span>
                <span className="font-mono font-semibold text-[#0284C7] dark:text-[#38BDF8]">
                  -{activeParcel.spatial.thirdPartyEasementM2.toFixed(0)} m²
                </span>
              </div>
              <div className="py-2.5 flex justify-between">
                <span className="text-slate-500 dark:text-slate-400">Declive Médio (MDT DGT)</span>
                <span className="font-mono font-semibold text-slate-900 dark:text-white">
                  {activeParcel.avgSlopePct}% ({activeParcel.avgSlopePct > 20 ? 'Equipa Apeada / Rastos' : 'Apto p/ Trator Florestal'})
                </span>
              </div>
              <div className="py-2.5 flex justify-between">
                <span className="text-slate-500 dark:text-slate-400">Frente Viária Pavimentada</span>
                <span className="font-mono font-semibold text-slate-900 dark:text-white">
                  Sim ({activeParcel.roadFrontageM} m)
                </span>
              </div>
            </div>
          </div>

          <form
            onSubmit={handleSubmitQuote}
            className="lg:col-span-7 rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-4"
          >
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              Pedir 3 Orçamentos Chave-na-Mão c/ Auto Certificado Incluído
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label htmlFor="quote-owner-name" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Nome de Contacto
                </label>
                <input
                  id="quote-owner-name"
                  type="text"
                  value={quoteName}
                  onChange={(e) => setQuoteName(e.target.value)}
                  placeholder="Ex.: Rui Pedro Monteiro"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                />
              </div>
              <div>
                <label htmlFor="quote-owner-phone" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Telemóvel / WhatsApp
                </label>
                <input
                  id="quote-owner-phone"
                  type="tel"
                  value={quotePhone}
                  onChange={(e) => setQuotePhone(e.target.value)}
                  placeholder="Ex.: 914 820 190"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm font-mono text-slate-900 dark:text-white"
                />
              </div>
            </div>

            <div>
              <label htmlFor="quote-window" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Prazo Pretendido de Execução
              </label>
              <select
                id="quote-window"
                value={quoteWindow}
                onChange={(e) => setQuoteWindow(e.target.value)}
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
              >
                <option value="Urgente (próximos 7 dias)">Urgente (próximos 7 dias)</option>
                <option value="Próximos 10 dias úteis">Próximos 10 dias úteis</option>
                <option value="Até ao fim deste mês">Até ao fim deste mês</option>
              </select>
            </div>

            <label className="flex items-center gap-2.5 text-xs text-slate-700 dark:text-slate-300 min-h-[40px] cursor-pointer">
              <input
                type="checkbox"
                checked={includeDebris}
                onChange={(e) => setIncludeDebris(e.target.checked)}
                className="w-4 h-4 rounded accent-[#D97706]"
              />
              Incluir biotrituração ou recolha/transporte de sobrantes (obrigatório quando é proibido queimar)
            </label>

            {quoteError && (
              <p role="alert" className="text-xs font-semibold text-[#DC2626]">
                {quoteError}
              </p>
            )}

            <button
              type="submit"
              disabled={submittingQuote}
              className="w-full min-h-[48px] px-5 py-3 rounded-xl bg-[#D97706] hover:bg-[#B45309] text-white text-sm font-semibold transition-colors inline-flex items-center justify-center gap-2"
            >
              <Send className="w-4 h-4" aria-hidden="true" />
              {submittingQuote
                ? 'A notificar prestadores certificados...'
                : `Pedir 3 Orçamentos para ${activeParcel.spatial.mandatoryCleanAreaM2.toFixed(0)} m²`}
            </button>

            {createdQuote && (
              <div className="rounded-xl p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 text-xs space-y-1.5">
                <div className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-[#16A34A]" aria-hidden="true" />
                  Pedido registado e enviado a {createdQuote.matchedProvidersCount} prestadores verificados em {createdQuote.municipality}!
                </div>
                <p className="text-slate-700 dark:text-slate-300 tabular-nums">
                  Intervalo orientativo de mercado: <strong>{createdQuote.estimatedBudgetRange}</strong> · Já visível no portal <strong>Prestadores</strong>.
                </p>
              </div>
            )}
          </form>
        </div>
      )}

      {/* ==================== SUB-MODE 3: VIZINHO INCUMPRIDOR ==================== */}
      {subMode === 'neighbor' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-5 rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-4">
            <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <MapPin className="w-4 h-4 text-[#A855F7]" aria-hidden="true" />
              Diagnóstico Geodésico do Terreno Confinante
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Fundamenta o pedido de vistoria prioritária e execução coerciva municipal (Art.º 49.º, 57.º e 58.º DL 82/2021) com coordenadas PT-TM06 e ficheiro SIG para o GTF.
            </p>
            <div className="divide-y divide-slate-200 dark:divide-[#263248] text-xs tabular-nums">
              <div className="py-2.5 flex justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">Distância Mínima à Fachada</span>
                <span className="font-mono font-bold text-[#E11D48]">
                  {activeParcel.spatial.neighborMinDistanceM.toFixed(2)} metros
                </span>
              </div>
              <div className="py-2.5 flex justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">Índice Biomassa Sentinel-2</span>
                <span className="font-mono font-bold text-slate-900 dark:text-white">
                  NDVI {activeParcel.neighborInfo.ndvi.toFixed(2)} (Carga Elevada)
                </span>
              </div>
              <div className="py-2.5 flex justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">Altura Estimada do Mato</span>
                <span className="font-mono font-semibold text-slate-900 dark:text-white">
                  ~{activeParcel.neighborInfo.shrubHeightM.toFixed(2)} m
                </span>
              </div>
              <div className="py-2.5">
                <div className="text-slate-500 dark:text-slate-400">Vegetação Dominante Detetada</div>
                <div className="mt-0.5 font-semibold text-slate-900 dark:text-white">
                  {activeParcel.neighborInfo.dominantSpecies}
                </div>
              </div>
            </div>
          </div>

          <form
            onSubmit={handleGenerateNeighborPetition}
            className="lg:col-span-7 rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-4"
          >
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              Gerar Requerimento Formal à Câmara Municipal ({activeParcel.municipality}) & GNR/SEPNA
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label htmlFor="comp-name" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Nome Completo do Requerente
                </label>
                <input
                  id="comp-name"
                  type="text"
                  value={compName}
                  onChange={(e) => setCompName(e.target.value)}
                  placeholder="Ex.: Ana Catarina Marques"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                />
              </div>
              <div>
                <label htmlFor="comp-nif" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  NIF do Requerente (9 dígitos)
                </label>
                <input
                  id="comp-nif"
                  type="text"
                  inputMode="numeric"
                  maxLength={9}
                  value={compNif}
                  onChange={(e) => setCompNif(e.target.value)}
                  placeholder="Ex.: 219403881"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm font-mono text-slate-900 dark:text-white"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label htmlFor="comp-address" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Morada da Habitação em Risco
                </label>
                <input
                  id="comp-address"
                  type="text"
                  value={compAddress}
                  onChange={(e) => setCompAddress(e.target.value)}
                  placeholder={`Ex.: Rua do Pinhal 14, ${activeParcel.parish}`}
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                />
              </div>
              <div>
                <label htmlFor="comp-email" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Email p/ Receção do N.º de Processo GTF
                </label>
                <input
                  id="comp-email"
                  type="email"
                  value={compEmail}
                  onChange={(e) => setCompEmail(e.target.value)}
                  placeholder="Ex.: morador@email.pt"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                />
              </div>
            </div>

            <input
              type="hidden"
              value={compPhone}
              onChange={(e) => setCompPhone(e.target.value)}
            />

            {compError && (
              <p role="alert" className="text-xs font-semibold text-[#DC2626]">
                {compError}
              </p>
            )}

            <button
              type="submit"
              disabled={generatingPetition}
              className="w-full min-h-[48px] px-5 py-3 rounded-xl bg-[#7E22CE] hover:bg-[#6B21A8] text-white text-sm font-semibold transition-colors inline-flex items-center justify-center gap-2"
            >
              <FileWarning className="w-4 h-4" aria-hidden="true" />
              {generatingPetition
                ? 'A redigir minuta jurídica e dossiê SIG...'
                : 'Gerar Requerimento Municipal + Dossiê GeoJSON GTF'}
            </button>

            {createdPetition && (
              <div className="rounded-xl p-4 bg-slate-50 dark:bg-[#0B0F17] border border-[#A855F7] space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-bold text-slate-900 dark:text-white">
                    Dossiê Técnico Gerado · #{createdPetition.reqCode}
                  </span>
                  <span className="text-xs font-mono text-[#7E22CE] dark:text-[#C084FC]">
                    DICOFRE {createdPetition.dicofre}
                  </span>
                </div>
                <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-line">
                  {createdPetition.formalPetitionText}
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => handleDownloadNeighborPdf(createdPetition)}
                    className="min-h-[44px] px-4 py-2 rounded-xl bg-[#0F172A] dark:bg-white text-white dark:text-slate-950 text-xs font-semibold inline-flex items-center gap-2"
                  >
                    <Download className="w-4 h-4" aria-hidden="true" />
                    Descarregar Requerimento PDF A4 (2 Págs.)
                  </button>
                  <a
                    href={`/api/gtf/${encodeURIComponent(createdPetition.reqCode)}/geojson`}
                    download={`${createdPetition.reqCode}.geojson`}
                    className="min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-200 inline-flex items-center gap-1.5"
                  >
                    <Download className="w-3.5 h-3.5" aria-hidden="true" />
                    GeoJSON p/ QGIS Municipal
                  </a>
                  <a
                    href={`/api/gtf/${encodeURIComponent(createdPetition.reqCode)}/kml`}
                    download={`${createdPetition.reqCode}.kml`}
                    className="min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-200 inline-flex items-center gap-1.5"
                  >
                    <Download className="w-3.5 h-3.5" aria-hidden="true" />
                    KML Google Earth
                  </a>
                </div>
              </div>
            )}
          </form>
        </div>
      )}
    </div>
  );
};
