import React, { useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Camera,
  Check,
  CheckCircle2,
  Contrast,
  Download,
  LogIn,
  Moon,
  QrCode,
  ShieldCheck,
  Smartphone,
  Sun,
  UserCheck,
} from 'lucide-react';
import heroFuelbreakImg from '../assets/images/hero_portuguese_fuelbreak_1794766503018.jpg';
import webappPerimeterImg from '../assets/images/webapp_forestry_perimeter_1794766504028.jpg';
import type { ComplianceCertificate } from '../types/domain.ts';
import { validateLocalSessionInput } from '../lib/appShellMode.ts';
import {
  appendQrScanHistory,
  evaluatePublicVerifyCodeInput,
  resolveCertificateFromPayload,
} from '../lib/qrVerification.ts';
import { QrCertificateScannerModal } from './QrCertificateScannerModal.tsx';

interface PublicWebviewHomepageProps {
  darkMode: boolean;
  highContrastMode: boolean;
  isOnline: boolean;
  isFirebaseConfigured: boolean;
  isInstallable: boolean;
  isInstalled: boolean;
  isIOS: boolean;
  certificates: ComplianceCertificate[];
  onVerifyCertificate: (certificate: ComplianceCertificate) => void;
  onToggleDarkMode: () => void;
  onToggleHighContrast: () => void;
  onSignInGoogle: () => Promise<void>;
  onSignInLocalCustom: (params: { displayName: string; nif: string }) => void;
  onSignInDemo: () => void;
  onSwitchToWebAppOnboarding: () => void;
  onInstallPwa: () => Promise<boolean>;
  onOpenIosGuide: () => void;
}

export const PublicWebviewHomepage: React.FC<PublicWebviewHomepageProps> = ({
  darkMode,
  highContrastMode,
  isOnline,
  isFirebaseConfigured,
  isInstallable,
  isInstalled,
  isIOS,
  certificates,
  onVerifyCertificate,
  onToggleDarkMode,
  onToggleHighContrast,
  onSignInGoogle,
  onSignInLocalCustom,
  onSignInDemo,
  onSwitchToWebAppOnboarding,
  onInstallPwa,
  onOpenIosGuide,
}) => {
  const [heroImgFailed, setHeroImgFailed] = useState(false);
  const [fieldImgFailed, setFieldImgFailed] = useState(false);

  const [signingInGoogle, setSigningInGoogle] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);

  const [ownerName, setOwnerName] = useState('');
  const [ownerNif, setOwnerNif] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const [isQrScannerOpen, setIsQrScannerOpen] = useState(false);
  const [publicVerifyCode, setPublicVerifyCode] = useState('');
  const [publicVerifyError, setPublicVerifyError] = useState<string | null>(null);
  const [isCheckingPublicCode, setIsCheckingPublicCode] = useState(false);

  const scrollToLogin = () => {
    const target = document.getElementById('acesso');
    if (target) {
      target.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const verifyCodeFeedback = evaluatePublicVerifyCodeInput(publicVerifyCode);

  const handlePublicVerifySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPublicVerifyError(null);

    if (!verifyCodeFeedback.isValidToSubmit) {
      setPublicVerifyError(
        verifyCodeFeedback.submitErrorPt ??
          'Introduza um código de certificado válido no formato FS-YYYYMMDD-XXXX.'
      );
      return;
    }

    setIsCheckingPublicCode(true);
    try {
      const res = await resolveCertificateFromPayload({
        certificates,
        rawPayload: publicVerifyCode.trim(),
        fetchRemoteByCode: async (candidateCode) => {
          const resp = await fetch(`/api/verify/${encodeURIComponent(candidateCode)}`);
          if (!resp.ok) return null;
          return (await resp.json()) as ComplianceCertificate;
        },
      });

      if (!res.certificate) {
        setPublicVerifyError(
          res.errorPt ?? 'Não foi encontrado nenhum certificado correspondente.'
        );
        return;
      }

      appendQrScanHistory(res.certificate, { source: 'MANUAL_CODE' });
      onVerifyCertificate(res.certificate);
    } finally {
      setIsCheckingPublicCode(false);
    }
  };

  const handleGoogleLogin = async () => {
    setGoogleError(null);
    setSigningInGoogle(true);
    try {
      await onSignInGoogle();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('popup-closed-by-user')) {
        setGoogleError('A janela de autenticação Google foi encerrada antes de concluir o acesso.');
      } else if (msg.includes('popup-blocked')) {
        setGoogleError('O navegador bloqueou a janela de login. Permita popups ou entre em Sessão Local ao lado.');
      } else if (msg.includes('VITE_FIREBASE_API_KEY')) {
        setGoogleError(msg);
      } else {
        setGoogleError('Não foi possível autenticar via Google neste momento. Utilize o acesso local de terreno.');
      }
    } finally {
      setSigningInGoogle(false);
    }
  };

  const handleLocalSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    const validation = validateLocalSessionInput({
      displayName: ownerName,
      nif: ownerNif,
    });
    if (!validation.valid) {
      setLocalError(validation.error ?? 'Verifique os dados introduzidos.');
      return;
    }
    onSignInLocalCustom({
      displayName: validation.sanitizedName,
      nif: validation.sanitizedNif,
    });
  };

  return (
    <div
      id="top"
      data-testid="public-webview-homepage"
      data-high-contrast={highContrastMode ? 'true' : 'false'}
      className="min-h-screen flex flex-col bg-[#F8FAFC] dark:bg-[#0B0F17] hc:bg-white hc:dark:bg-black text-[#0F172A] dark:text-[#F8FAFC] hc:text-black hc:dark:text-white"
    >
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-30 h-14 lg:h-16 bg-white/95 dark:bg-[#161E2E]/95 hc:bg-white hc:dark:bg-black backdrop-blur-md hc:backdrop-blur-none border-b border-slate-200 dark:border-[#263248] hc:border-b-2 hc:border-black hc:dark:border-white">
        <div className="max-w-7xl mx-auto h-full px-4 sm:px-6 flex items-center justify-between gap-8">
          {/* Zone 1: Single text element wordmark */}
          <a
            href="#top"
            className="font-display text-lg lg:text-xl font-bold tracking-tight text-[#14532D] dark:text-[#22C55E] hc:text-[#0A3619] hc:dark:text-[#4ADE80] whitespace-nowrap shrink-0"
          >
            FaixaSegura
          </a>

          {/* Zone 2: 5 concise single-line navigation links */}
          <nav
            aria-label="Navegação institucional"
            className="hidden md:flex items-center gap-6 text-sm font-medium hc:font-bold text-slate-600 dark:text-slate-300 hc:text-black hc:dark:text-white"
          >
            <a
              href="#funcionalidades"
              className="py-1 hover:text-slate-950 dark:hover:text-white hover:underline hc:underline underline-offset-8 whitespace-nowrap shrink-0"
            >
              Funcionalidades
            </a>
            <a
              href="#impacto"
              className="py-1 hover:text-slate-950 dark:hover:text-white hover:underline hc:underline underline-offset-8 whitespace-nowrap shrink-0"
            >
              Impacto
            </a>
            <a
              href="#verificar"
              className="py-1 hover:text-slate-950 dark:hover:text-white hover:underline hc:underline underline-offset-8 whitespace-nowrap shrink-0"
            >
              Verificar Auto
            </a>
            <a
              href="#modo-campo"
              className="py-1 hover:text-slate-950 dark:hover:text-white hover:underline hc:underline underline-offset-8 whitespace-nowrap shrink-0"
            >
              WebApp Campo
            </a>
            <a
              href="#acesso"
              className="py-1 hover:text-slate-950 dark:hover:text-white hover:underline hc:underline underline-offset-8 whitespace-nowrap shrink-0"
            >
              Acesso
            </a>
          </nav>

          {/* Zone 3: 1 primary CTA action */}
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={scrollToLogin}
              className="min-h-[40px] lg:min-h-[42px] px-4 py-2 rounded-xl bg-[#14532D] hover:bg-[#0F3F22] dark:bg-[#22C55E] dark:hover:bg-[#16A34A] hc:bg-[#0A3619] hc:hover:bg-black hc:dark:bg-[#4ADE80] hc:dark:hover:bg-[#86EFAC] text-white dark:text-slate-950 hc:dark:text-black hc:border-2 hc:border-black hc:dark:border-white text-xs font-semibold hc:font-bold whitespace-nowrap shrink-0"
            >
              Entrar na Plataforma
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* 1. HERO SECTION: Proposition + High-Impact 16:9 Visual Carrier */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-8 pb-12 lg:pt-14 lg:pb-16">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10 items-stretch">
            {/* Left Copy & Primary Conversion */}
            <div className="lg:col-span-6 flex flex-col justify-between space-y-6">
              <div className="space-y-5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium hc:font-bold text-slate-600 dark:text-slate-400 hc:text-black hc:dark:text-white">
                  <span>Decreto-Lei n.º 82/2021 (SGIFR)</span>
                  <span aria-hidden="true">·</span>
                  <span>Despacho n.º 675/2026</span>
                  <span aria-hidden="true">·</span>
                  <span>ETRS89 / PT-TM06</span>
                </div>

                <h1 className="font-display text-[clamp(2.25rem,4vw,3.5rem)] font-bold tracking-tight leading-[1.08] text-slate-950 dark:text-white hc:text-black hc:dark:text-white [text-wrap:balance]">
                  Gestão métrica de faixas de combustível e prova legal para proprietários rurais.
                </h1>

                <p className="text-base text-slate-600 dark:text-slate-300 hc:text-black hc:dark:text-white hc:font-medium leading-relaxed max-w-xl">
                  Calcule ao metro quadrado a área efetivamente exigível do seu terreno BUPi, valide o semáforo diário IPMA antes de ligar maquinaria e emita o Auto PDF A4 com assinatura criptográfica SHA-256 na sua área reservada.
                </p>
              </div>

              <div className="space-y-4 pt-1">
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={scrollToLogin}
                    className="min-h-[48px] px-5 py-2.5 rounded-xl bg-[#14532D] hover:bg-[#0F3F22] dark:bg-[#22C55E] dark:hover:bg-[#16A34A] hc:bg-[#0A3619] hc:hover:bg-black hc:dark:bg-[#4ADE80] hc:dark:hover:bg-[#86EFAC] text-white dark:text-slate-950 hc:dark:text-black hc:border-2 hc:border-black hc:dark:border-white text-sm font-semibold hc:font-bold inline-flex items-center gap-2 whitespace-nowrap"
                  >
                    <span>Aceder à Área do Proprietário</span>
                    <ArrowRight className="w-4 h-4" aria-hidden="true" />
                  </button>

                  <button
                    type="button"
                    data-testid="hero-open-qr-scanner-btn"
                    onClick={() => setIsQrScannerOpen(true)}
                    className="min-h-[48px] px-4 py-2.5 rounded-xl border border-slate-300 dark:border-[#263248] hc:border-2 hc:border-black hc:dark:border-white bg-white dark:bg-[#161E2E] hc:bg-white hc:dark:bg-black hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-900 dark:text-slate-100 hc:text-black hc:dark:text-white text-sm font-semibold hc:font-bold inline-flex items-center gap-2 whitespace-nowrap"
                  >
                    <QrCode className="w-4 h-4 text-[#14532D] dark:text-[#22C55E] hc:text-black hc:dark:text-[#4ADE80]" aria-hidden="true" />
                    <span>Verificar Certificado por QR</span>
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500 dark:text-slate-400 hc:text-black hc:dark:text-white">
                  <button
                    type="button"
                    onClick={onSignInDemo}
                    className="font-semibold hc:font-bold text-slate-700 dark:text-slate-200 hc:text-black hc:dark:text-white hover:underline hc:underline underline-offset-4 whitespace-nowrap"
                  >
                    Explorar Sessão Demonstrativa
                  </button>
                  <span aria-hidden="true">·</span>
                  <button
                    type="button"
                    onClick={onSwitchToWebAppOnboarding}
                    className="font-semibold hc:font-bold text-[#14532D] dark:text-[#22C55E] hc:text-[#0A3619] hc:dark:text-[#4ADE80] hover:underline hc:underline underline-offset-4 whitespace-nowrap"
                  >
                    Abrir Onboarding Mobile / WebApp
                  </button>
                </div>
              </div>
            </div>

            {/* Right 16:9 / Stretch Editorial Visual Carrier */}
            <div className="lg:col-span-6">
              <div className="relative h-full min-h-[300px] sm:min-h-[360px] rounded-2xl overflow-hidden border border-slate-200 dark:border-[#263248] hc:border-2 hc:border-black hc:dark:border-white bg-[#143322]">
                {!heroImgFailed ? (
                  <img
                    src={heroFuelbreakImg}
                    alt="Propriedade rural portuguesa em Sintra rodeada por faixa de gestão de combustível limpa de 50 metros junto a sobreiros e pinhal"
                    referrerPolicy="no-referrer"
                    onError={() => setHeroImgFailed(true)}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full min-h-[340px] flex flex-col items-center justify-center p-8 text-center bg-gradient-to-br from-[#14532D] via-[#0F291E] to-[#0B0F17] text-white">
                    <ShieldCheck className="w-12 h-12 text-[#4ADE80] mb-3" aria-hidden="true" />
                    <p className="font-display text-lg font-bold">
                      Faixa de Gestão de Combustível (0–2 m · 2–10 m · 10–50 m)
                    </p>
                    <p className="text-xs text-slate-300 mt-1 max-w-md">
                      Cartografia métrica ETRS89 / PT-TM06 (EPSG:3763) com diagnóstico de stress hídrico Sentinel-2.
                    </p>
                  </div>
                )}

                {/* Measured Contrast Scrim */}
                <div className="absolute inset-x-0 bottom-0 p-5 sm:p-6 bg-gradient-to-t from-black/85 via-black/45 hc:from-black/95 hc:via-black/80 to-transparent text-white">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono tabular-nums text-slate-200 hc:text-white hc:font-bold">
                    <span>Sintra · Colares (DICO 1111)</span>
                    <span>EPSG:3763 · Raio-X 0–50 m</span>
                  </div>
                  <p className="mt-1 text-sm sm:text-base font-semibold text-white">
                    Delimitação rigorosa entre zona inerte (0–2 m), interface próxima (2–10 m) e servidões isentas.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Full-width 4-Column Quantitative Proof Row Below Hero Split */}
          <div
            id="impacto"
            className="mt-8 pt-8 border-t border-slate-200 dark:border-[#263248] hc:border-t-2 hc:border-black hc:dark:border-white grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6"
          >
            <div className="space-y-1">
              <p className="font-display text-2xl sm:text-3xl font-bold text-slate-950 dark:text-white hc:text-black hc:dark:text-white tabular-nums">
                2 844 m²
              </p>
              <p className="text-xs text-slate-600 dark:text-slate-400 hc:text-black hc:dark:text-white hc:font-medium leading-relaxed">
                Área efetivamente exigível apurada num prédio rústico tipo de 6 354 m² após descontar zonas isentas.
              </p>
            </div>

            <div className="space-y-1">
              <p className="font-display text-2xl sm:text-3xl font-bold text-[#14532D] dark:text-[#22C55E] hc:text-[#0A3619] hc:dark:text-[#4ADE80] tabular-nums">
                ~181 €
              </p>
              <p className="text-xs text-slate-600 dark:text-slate-400 hc:text-black hc:dark:text-white hc:font-medium leading-relaxed">
                Poupança média estimada por limpeza ao isolar corredores de responsabilidade exclusiva da E-REDES.
              </p>
            </div>

            <div className="space-y-1">
              <p className="font-display text-2xl sm:text-3xl font-bold text-slate-950 dark:text-white hc:text-black hc:dark:text-white tabular-nums">
                RCM 1–5
              </p>
              <p className="text-xs text-slate-600 dark:text-slate-400 hc:text-black hc:dark:text-white hc:font-medium leading-relaxed">
                Semáforo diário IPMA cruzado com fogos ativos ANEPC num raio de 15 km e tendência municipal a 30 dias.
              </p>
            </div>

            <div className="space-y-1">
              <p className="font-display text-2xl sm:text-3xl font-bold text-slate-950 dark:text-white hc:text-black hc:dark:text-white tabular-nums">
                SHA-256
              </p>
              <p className="text-xs text-slate-600 dark:text-slate-400 hc:text-black hc:dark:text-white hc:font-medium leading-relaxed">
                Auto oficial A4 de 2 páginas com selo de tempo UTC e código QR público para auditoria GNR ou seguradoras.
              </p>
            </div>
          </div>
        </section>

        {/* 2. CAPABILITIES SECTION: Asymmetric Bento Grid with Clean Editorial Numbering */}
        <section
          id="funcionalidades"
          className="border-t border-slate-200 dark:border-[#263248] hc:border-t-2 hc:border-black hc:dark:border-white bg-white dark:bg-[#0F1624] hc:bg-white hc:dark:bg-black py-14 lg:py-16"
        >
          <div className="max-w-7xl mx-auto px-4 sm:px-6 space-y-8">
            <div className="max-w-2xl space-y-2">
              <p className="text-xs font-semibold hc:font-bold text-[#14532D] dark:text-[#22C55E] hc:text-[#0A3619] hc:dark:text-[#4ADE80]">
                Área Reservada após Autenticação
              </p>
              <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-950 dark:text-white hc:text-black hc:dark:text-white [text-wrap:balance]">
                Quatro instrumentos técnicos reunidos na conta pessoal do proprietário.
              </h2>
              <p className="text-sm text-slate-600 dark:text-slate-300 hc:text-black hc:dark:text-white hc:font-medium leading-relaxed">
                Toda a cartografia cadastral, histórico de intervenções, orçamentos e certificados SHA-256 ficam isolados por utilizador autenticado.
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
              {/* Span 2 Marquee Capability */}
              <article className="lg:col-span-2 rounded-2xl border border-slate-200 dark:border-[#263248] hc:border-2 hc:border-black hc:dark:border-white bg-[#F8FAFC] dark:bg-[#161E2E] hc:bg-white hc:dark:bg-black p-6 sm:p-7 flex flex-col justify-between space-y-4">
                <div className="space-y-2.5">
                  <h3 className="font-display text-lg sm:text-xl font-bold text-slate-950 dark:text-white hc:text-black hc:dark:text-white">
                    01. Cockpit Diário IPMA RCM &amp; Tendência Regional a 30 Dias
                  </h3>
                  <p className="text-sm text-slate-600 dark:text-slate-300 hc:text-black hc:dark:text-white hc:font-medium leading-relaxed max-w-2xl">
                    Antes de deslocar equipas ou utilizar motorroçadoras de lâmina metálica, verifique em segundos o risco de incêndio rural do seu concelho, a humidade estimada do solo nos últimos 7 dias e o gráfico comparativo de ocorrências ativas nos 6 municípios vizinhos.
                  </p>
                </div>
                <div className="pt-3 border-t border-slate-200/80 dark:border-[#263248] hc:border-black hc:dark:border-white flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 hc:text-black hc:dark:text-white hc:font-semibold">
                  <span>Art.º 68.º DL n.º 82/2021</span>
                  <span aria-hidden="true">·</span>
                  <span>Previsão 72 horas</span>
                  <span aria-hidden="true">·</span>
                  <span>Monitorização ANEPC 15 km</span>
                </div>
              </article>

              {/* Span 1 Capability */}
              <article className="lg:col-span-1 rounded-2xl border border-slate-200 dark:border-[#263248] hc:border-2 hc:border-black hc:dark:border-white bg-[#F8FAFC] dark:bg-[#161E2E] hc:bg-white hc:dark:bg-black p-6 sm:p-7 flex flex-col justify-between space-y-4">
                <div className="space-y-2.5">
                  <h3 className="font-display text-lg font-bold text-slate-950 dark:text-white hc:text-black hc:dark:text-white">
                    02. Cartografia BUPi, NDVI &amp; GeoJSON
                  </h3>
                  <p className="text-sm text-slate-600 dark:text-slate-300 hc:text-black hc:dark:text-white hc:font-medium leading-relaxed">
                    Inspecione as faixas graduadas 0–2 m, 2–10 m e 10–50 m em coordenadas métricas EPSG:3763, ative a grelha Sentinel-2 NDVI de stress hídrico e exporte os vértices em GeoJSON RFC 7946.
                  </p>
                </div>
                <div className="pt-3 border-t border-slate-200/80 dark:border-[#263248] hc:border-black hc:dark:border-white text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 hc:text-black hc:dark:text-white hc:font-semibold">
                  QGIS · ArcGIS · BUPi RGG
                </div>
              </article>

              {/* Span 1 Capability */}
              <article className="lg:col-span-1 rounded-2xl border border-slate-200 dark:border-[#263248] hc:border-2 hc:border-black hc:dark:border-white bg-[#F8FAFC] dark:bg-[#161E2E] hc:bg-white hc:dark:bg-black p-6 sm:p-7 flex flex-col justify-between space-y-4">
                <div className="space-y-2.5">
                  <h3 className="font-display text-lg font-bold text-slate-950 dark:text-white hc:text-black hc:dark:text-white">
                    03. Auto PDF Oficial SHA-256
                  </h3>
                  <p className="text-sm text-slate-600 dark:text-slate-300 hc:text-black hc:dark:text-white hc:font-medium leading-relaxed">
                    Gere e transfira o relatório oficial A4 com selo temporal UTC, hash SHA-256 determinístico, requerimento formal para terrenos vizinhos em infração e pedido simultâneo de 3 orçamentos.
                  </p>
                </div>
                <div className="pt-3 border-t border-slate-200/80 dark:border-[#263248] hc:border-black hc:dark:border-white text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 hc:text-black hc:dark:text-white hc:font-semibold">
                  PDF 2 páginas · QR Verificável
                </div>
              </article>

              {/* Span 2 Capability */}
              <article className="lg:col-span-2 rounded-2xl border border-slate-200 dark:border-[#263248] hc:border-2 hc:border-black hc:dark:border-white bg-[#F8FAFC] dark:bg-[#161E2E] hc:bg-white hc:dark:bg-black p-6 sm:p-7 flex flex-col justify-between space-y-4">
                <div className="space-y-2.5">
                  <h3 className="font-display text-lg sm:text-xl font-bold text-slate-950 dark:text-white hc:text-black hc:dark:text-white">
                    04. Operação Offline em IndexedDB com Retoma Automática para Firestore
                  </h3>
                  <p className="text-sm text-slate-600 dark:text-slate-300 hc:text-black hc:dark:text-white hc:font-medium leading-relaxed max-w-2xl">
                    Em zonas florestais sem cobertura móvel, todos os terrenos desenhados e intervenções registadas ficam guardados localmente no dispositivo e sincronizam por ordem estrita assim que a ligação é restabelecida.
                  </p>
                </div>
                <div className="pt-3 border-t border-slate-200/80 dark:border-[#263248] hc:border-black hc:dark:border-white flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 hc:text-black hc:dark:text-white hc:font-semibold">
                  <span>IndexedDB + localStorage</span>
                  <span aria-hidden="true">·</span>
                  <span>Fila FIFO resiliente</span>
                  <span aria-hidden="true">·</span>
                  <span>Isolamento RGPD de PII</span>
                </div>
              </article>
            </div>
          </div>
        </section>

        {/* 3. PUBLIC QR COMPLIANCE VERIFICATION SECTION (#verificar) */}
        <section
          id="verificar"
          aria-labelledby="public-qr-verify-heading"
          className="border-t border-slate-200 dark:border-[#263248] hc:border-t-2 hc:border-black hc:dark:border-white py-14 lg:py-16"
        >
          <div className="max-w-7xl mx-auto px-4 sm:px-6 grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10 items-center">
            <div className="lg:col-span-6 space-y-4">
              <p className="text-xs font-semibold hc:font-bold text-[#14532D] dark:text-[#22C55E] hc:text-[#0A3619] hc:dark:text-[#4ADE80]">
                Consulta Pública sem Autenticação · GNR / SEPNA, Municípios e Seguradoras
              </p>
              <h2
                id="public-qr-verify-heading"
                className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-950 dark:text-white hc:text-black hc:dark:text-white [text-wrap:balance]"
              >
                Verifique na hora um Certificado de Conformidade com a câmara do dispositivo.
              </h2>
              <p className="text-sm text-slate-600 dark:text-slate-300 hc:text-black hc:dark:text-white hc:font-medium leading-relaxed max-w-xl">
                Qualquer fiscal, seguradora ou proprietário confinante pode apontar a câmara ao código QR impresso no Auto PDF Oficial A4 para confirmar a integridade da assinatura criptográfica SHA-256, a área executada e a data de emissão UTC.
              </p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400 hc:text-black hc:dark:text-white hc:font-semibold">
                <span>Leitura direta por câmara</span>
                <span aria-hidden="true">·</span>
                <span>Suporte para fotografia QR</span>
                <span aria-hidden="true">·</span>
                <span>Hash SHA-256 auditável</span>
              </div>
            </div>

            <div className="lg:col-span-6 rounded-2xl border border-slate-200 dark:border-[#263248] hc:border-2 hc:border-black hc:dark:border-white bg-white dark:bg-[#161E2E] hc:bg-white hc:dark:bg-black p-6 sm:p-7 space-y-5">
              <div className="space-y-3">
                <div className="space-y-1">
                  <h3 className="font-display text-lg font-bold text-slate-950 dark:text-white hc:text-black hc:dark:text-white">
                    Leitor Ótico de Código QR
                  </h3>
                  <p className="text-xs text-slate-600 dark:text-slate-300 hc:text-black hc:dark:text-white hc:font-medium leading-relaxed">
                    Inicie a câmara traseira ou frontal do seu telemóvel, tablet ou portátil para ler automaticamente o código QR do certificado.
                  </p>
                </div>

                <button
                  type="button"
                  data-testid="section-open-qr-scanner-btn"
                  onClick={() => setIsQrScannerOpen(true)}
                  className="w-full min-h-[48px] px-5 py-3 rounded-xl bg-[#14532D] hover:bg-[#0F3F22] dark:bg-[#22C55E] dark:hover:bg-[#16A34A] hc:bg-[#0A3619] hc:hover:bg-black hc:dark:bg-[#4ADE80] hc:dark:hover:bg-[#86EFAC] text-white dark:text-slate-950 hc:dark:text-black hc:border-2 hc:border-black hc:dark:border-white text-sm font-semibold hc:font-bold inline-flex items-center justify-center gap-2 whitespace-nowrap"
                >
                  <Camera className="w-4 h-4" aria-hidden="true" />
                  <span>Ler Código QR com Câmara</span>
                </button>
              </div>

              <form
                onSubmit={(e) => void handlePublicVerifySubmit(e)}
                className="pt-4 border-t border-slate-200 dark:border-[#263248] hc:border-t-2 hc:border-black hc:dark:border-white space-y-2.5"
                noValidate
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    htmlFor="public-verify-code-input"
                    className="text-xs font-semibold hc:font-bold text-slate-700 dark:text-slate-300 hc:text-black hc:dark:text-white"
                  >
                    Ou consulte pelo código alfanumérico do Auto
                  </label>
                  {certificates[0] && (
                    <button
                      type="button"
                      onClick={() => {
                        setPublicVerifyCode(certificates[0].shortCode);
                        setPublicVerifyError(null);
                      }}
                      className="text-xs font-mono tabular-nums font-semibold hc:font-bold text-[#14532D] dark:text-[#22C55E] hc:text-[#0A3619] hc:dark:text-[#4ADE80] hover:underline hc:underline underline-offset-4 whitespace-nowrap"
                    >
                      Testar {certificates[0].shortCode}
                    </button>
                  )}
                </div>

                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
                  <div className="flex items-center gap-2.5 flex-1 min-w-0">
                    <input
                      id="public-verify-code-input"
                      type="text"
                      value={publicVerifyCode}
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={
                        verifyCodeFeedback.status === 'INVALID' || Boolean(publicVerifyError)
                      }
                      aria-describedby={
                        highContrastMode
                          ? 'public-verify-hc-indicator public-verify-code-feedback'
                          : 'public-verify-code-feedback'
                      }
                      onChange={(e) => {
                        setPublicVerifyCode(e.target.value);
                        if (publicVerifyError) setPublicVerifyError(null);
                      }}
                      placeholder="FS-YYYYMMDD-XXXX (ex.: FS-20260524-7D9E)"
                      className={`flex-1 min-w-0 min-h-[44px] px-3.5 py-2 rounded-xl bg-[#F8FAFC] dark:bg-[#0B0F17] hc:bg-white hc:dark:bg-black hc:border-2 text-xs font-mono tabular-nums text-slate-900 dark:text-white hc:text-black hc:dark:text-white hc:font-bold hc:placeholder:text-slate-700 hc:dark:placeholder:text-slate-300 ${
                        verifyCodeFeedback.status === 'INVALID' || Boolean(publicVerifyError)
                          ? 'border-2 border-[#DC2626] dark:border-red-400 hc:border-[#B91C1C] hc:dark:border-red-400'
                          : verifyCodeFeedback.status === 'VALID'
                          ? 'border-2 border-[#15803D] dark:border-[#22C55E] hc:border-black hc:dark:border-[#4ADE80]'
                          : 'border border-slate-300 dark:border-[#263248] hc:border-black hc:dark:border-[#FACC15]'
                      }`}
                    />
                    {highContrastMode && (
                      <span
                        id="public-verify-hc-indicator"
                        role="status"
                        data-testid="public-verify-hc-badge"
                        title="Modo de Alto Contraste ativo para inspeção sob luz solar intensa no terreno"
                        className="hc-badge-subtle-pulse min-h-[44px] px-3 py-2 rounded-xl border-[3px] border-black dark:border-white bg-[#FACC15] text-black text-xs font-extrabold tracking-tight ring-2 ring-black/30 dark:ring-[#FACC15]/75 shadow-sm inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                      >
                        <Contrast className="w-4 h-4 stroke-[2.75] shrink-0" aria-hidden="true" />
                        <span>Alto Contraste Ativo</span>
                      </span>
                    )}
                  </div>
                  <button
                    type="submit"
                    disabled={isCheckingPublicCode}
                    className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-300 dark:border-[#263248] hc:border-2 hc:border-black hc:dark:border-white bg-[#F8FAFC] dark:bg-[#0B0F17] hc:bg-white hc:dark:bg-black hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-900 dark:text-slate-100 hc:text-black hc:dark:text-white text-xs font-semibold hc:font-bold inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0"
                  >
                    <CheckCircle2 className="w-4 h-4 text-[#14532D] dark:text-[#22C55E] hc:text-black hc:dark:text-[#4ADE80]" aria-hidden="true" />
                    <span>Verificar Código</span>
                  </button>
                </div>

                <div
                  id="public-verify-code-feedback"
                  data-testid="public-verify-code-feedback"
                  aria-live="polite"
                  className="pt-0.5 space-y-1 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-slate-600 dark:text-slate-400 hc:text-black hc:dark:text-white">
                    <div className="inline-flex items-center gap-1.5 min-w-0">
                      <span className="font-medium hc:font-bold">Máscara:</span>
                      <span
                        data-testid="public-verify-format-preview"
                        className="font-mono tabular-nums tracking-wide"
                      >
                        {verifyCodeFeedback.typedPreview && (
                          <span
                            className={
                              verifyCodeFeedback.status === 'INVALID'
                                ? 'font-bold text-[#DC2626] dark:text-red-400 hc:text-[#B91C1C] hc:dark:text-red-300'
                                : verifyCodeFeedback.status === 'VALID'
                                ? 'font-bold text-[#14532D] dark:text-[#4ADE80] hc:text-[#0A3619] hc:dark:text-[#4ADE80]'
                                : 'font-bold text-slate-950 dark:text-white hc:text-black hc:dark:text-[#FACC15]'
                            }
                          >
                            {verifyCodeFeedback.typedPreview}
                          </span>
                        )}
                        {verifyCodeFeedback.remainingMask && (
                          <span className="text-slate-400 dark:text-slate-500 hc:text-slate-700 hc:dark:text-slate-300 hc:font-semibold">
                            {verifyCodeFeedback.remainingMask}
                          </span>
                        )}
                      </span>
                    </div>

                    <div className="inline-flex items-center gap-1.5 font-mono tabular-nums">
                      <span aria-hidden="true" className="hidden sm:inline">
                        ·
                      </span>
                      <span
                        data-testid="public-verify-length-counter"
                        className={
                          verifyCodeFeedback.status === 'INVALID'
                            ? 'font-bold text-[#DC2626] dark:text-red-400 hc:text-[#B91C1C] hc:dark:text-red-300'
                            : verifyCodeFeedback.status === 'VALID'
                            ? 'font-bold text-[#14532D] dark:text-[#4ADE80] hc:text-[#0A3619] hc:dark:text-[#4ADE80]'
                            : 'font-semibold hc:font-bold text-slate-700 dark:text-slate-300 hc:text-black hc:dark:text-white'
                        }
                      >
                        {verifyCodeFeedback.lengthBadgeText}
                      </span>
                    </div>
                  </div>

                  <p
                    data-testid="public-verify-helper-message"
                    className={`inline-flex items-center gap-1.5 leading-snug ${
                      verifyCodeFeedback.status === 'INVALID'
                        ? 'font-semibold hc:font-bold text-[#DC2626] dark:text-red-400 hc:text-[#B91C1C] hc:dark:text-red-300'
                        : verifyCodeFeedback.status === 'VALID'
                        ? 'font-semibold hc:font-bold text-[#14532D] dark:text-[#22C55E] hc:text-[#0A3619] hc:dark:text-[#4ADE80]'
                        : 'text-slate-500 dark:text-slate-400 hc:text-black hc:dark:text-white hc:font-semibold'
                    }`}
                  >
                    {verifyCodeFeedback.status === 'VALID' && (
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    )}
                    {verifyCodeFeedback.status === 'INVALID' && (
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    )}
                    <span>{verifyCodeFeedback.helperMessagePt}</span>
                  </p>
                </div>

                {publicVerifyError && (
                  <p role="alert" className="text-xs font-semibold hc:font-bold text-[#DC2626] dark:text-red-400">
                    {publicVerifyError}
                  </p>
                )}
              </form>
            </div>
          </div>
        </section>

        {/* 4. WEBAPP FIELD MODE SHOWCASE (#modo-campo) */}
        <section
          id="modo-campo"
          className="border-t border-slate-200 dark:border-[#263248] hc:border-t-2 hc:border-black hc:dark:border-white bg-white dark:bg-[#0F1624] hc:bg-white hc:dark:bg-black py-14 lg:py-16"
        >
          <div className="max-w-7xl mx-auto px-4 sm:px-6 grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10 items-center">
            <div className="lg:col-span-5">
              <div className="rounded-2xl overflow-hidden border border-slate-200 dark:border-[#263248] bg-[#143322] aspect-[4/3]">
                {!fieldImgFailed ? (
                  <img
                    src={webappPerimeterImg}
                    alt="Muro de pedra rural e corredor limpo de gestão de combustível junto a sobreiros ao amanhecer"
                    referrerPolicy="no-referrer"
                    onError={() => setFieldImgFailed(true)}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center p-6 text-center text-white bg-gradient-to-br from-[#14532D] to-[#0B0F17]">
                    <Smartphone className="w-10 h-10 text-[#4ADE80] mb-2" aria-hidden="true" />
                    <p className="font-display text-base font-bold">Modo WebApp de Terreno</p>
                  </div>
                )}
              </div>
            </div>

            <div className="lg:col-span-7 space-y-5">
              <div className="space-y-2">
                <p className="text-xs font-semibold hc:font-bold text-[#14532D] dark:text-[#22C55E] hc:text-[#0A3619] hc:dark:text-[#4ADE80]">
                  Dupla Experiência · WebView &amp; WebApp Instalável
                </p>
                <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-950 dark:text-white hc:text-black hc:dark:text-white [text-wrap:balance]">
                  No navegador tem esta página institucional; instalada no telemóvel abre como WebApp de campo com Splash &amp; Onboarding.
                </h2>
                <p className="text-sm text-slate-600 dark:text-slate-300 hc:text-black hc:dark:text-white hc:font-medium leading-relaxed">
                  Ao instalar a aplicação no ecrã principal (Android, iOS ou computador), o arranque autónomo apresenta o ecrã de boas-vindas tátil pensado para uso com uma mão no terreno antes da autenticação.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                {!isInstalled && isInstallable && (
                  <button
                    type="button"
                    onClick={() => void onInstallPwa()}
                    className="min-h-[44px] px-4 py-2 rounded-xl bg-[#D97706] hover:bg-[#B45309] hc:bg-[#92400E] hc:border-2 hc:border-black hc:dark:border-white text-white text-xs font-semibold hc:font-bold inline-flex items-center gap-2 whitespace-nowrap"
                  >
                    <Download className="w-4 h-4" aria-hidden="true" />
                    Instalar WebApp no Dispositivo
                  </button>
                )}

                {!isInstalled && !isInstallable && isIOS && (
                  <button
                    type="button"
                    onClick={onOpenIosGuide}
                    className="min-h-[44px] px-4 py-2 rounded-xl bg-[#D97706] hover:bg-[#B45309] hc:bg-[#92400E] hc:border-2 hc:border-black hc:dark:border-white text-white text-xs font-semibold hc:font-bold inline-flex items-center gap-2 whitespace-nowrap"
                  >
                    <Download className="w-4 h-4" aria-hidden="true" />
                    Como Instalar no iPhone / iPad
                  </button>
                )}

                <button
                  type="button"
                  onClick={onSwitchToWebAppOnboarding}
                  className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-300 dark:border-[#263248] hc:border-2 hc:border-black hc:dark:border-white bg-white dark:bg-[#161E2E] hc:bg-white hc:dark:bg-black hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-semibold hc:font-bold text-slate-900 dark:text-slate-100 hc:text-black hc:dark:text-white inline-flex items-center gap-2 whitespace-nowrap"
                >
                  <Smartphone className="w-4 h-4 text-[#14532D] dark:text-[#22C55E] hc:text-black hc:dark:text-[#4ADE80]" aria-hidden="true" />
                  Ver Onboarding da WebApp
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* 5. AUTHENTICATION GATEWAY SECTION (#acesso) */}
        <section
          id="acesso"
          aria-labelledby="login-gateway-heading"
          className="border-t border-slate-200 dark:border-[#263248] hc:border-t-2 hc:border-black hc:dark:border-white py-14 lg:py-16"
        >
          <div className="max-w-7xl mx-auto px-4 sm:px-6 space-y-8">
            <div className="max-w-2xl space-y-2">
              <p className="text-xs font-semibold hc:font-bold text-[#14532D] dark:text-[#22C55E] hc:text-[#0A3619] hc:dark:text-[#4ADE80]">
                Autenticação Obrigatória para Consulta Operacional
              </p>
              <h2
                id="login-gateway-heading"
                className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-950 dark:text-white hc:text-black hc:dark:text-white [text-wrap:balance]"
              >
                Inicie sessão para aceder aos seus terrenos, mapas e certificados.
              </h2>
              <p className="text-sm text-slate-600 dark:text-slate-300 hc:text-black hc:dark:text-white hc:font-medium leading-relaxed">
                Escolha a sincronização na nuvem via Conta Google ou inicie uma sessão local persistente neste dispositivo para operação autónoma ou sem rede.
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
              {/* Option A: Cloud Google Sign-In */}
              <div className="lg:col-span-6 rounded-2xl border border-slate-200 dark:border-[#263248] hc:border-2 hc:border-black hc:dark:border-white bg-white dark:bg-[#161E2E] hc:bg-white hc:dark:bg-black p-6 sm:p-7 flex flex-col justify-between space-y-6">
                <div className="space-y-3">
                  <div className="text-xs font-semibold hc:font-bold text-[#14532D] dark:text-[#22C55E] hc:text-[#0A3619] hc:dark:text-[#4ADE80]">
                    Sincronização Cloud Firestore · Recomendado
                  </div>
                  <h3 className="font-display text-xl font-bold text-slate-950 dark:text-white hc:text-black hc:dark:text-white">
                    Entrar com Conta Google
                  </h3>
                  <p className="text-sm text-slate-600 dark:text-slate-300 hc:text-black hc:dark:text-white hc:font-medium leading-relaxed">
                    Sincroniza automaticamente os seus polígonos BUPi, registos de intervenção e histórico de autos SHA-256 entre computador, tablet e telemóvel, isolando dados fiscais (NIF e telefone) em subcoleção privada RGPD.
                  </p>
                </div>

                <div className="space-y-3">
                  <button
                    type="button"
                    disabled={signingInGoogle || !isOnline || !isFirebaseConfigured}
                    onClick={handleGoogleLogin}
                    className="w-full min-h-[48px] px-5 py-3 rounded-xl bg-[#14532D] hover:bg-[#0F3F22] disabled:opacity-50 dark:bg-[#22C55E] dark:hover:bg-[#16A34A] hc:bg-[#0A3619] hc:hover:bg-black hc:dark:bg-[#4ADE80] hc:dark:hover:bg-[#86EFAC] text-white dark:text-slate-950 hc:dark:text-black hc:border-2 hc:border-black hc:dark:border-white text-sm font-semibold hc:font-bold inline-flex items-center justify-center gap-2 whitespace-nowrap"
                  >
                    <LogIn className="w-4 h-4" aria-hidden="true" />
                    {!isOnline
                      ? 'Sem rede — utilize a Sessão Local ao lado'
                      : !isFirebaseConfigured
                      ? 'Cloud Auth não configurada nesta instância'
                      : signingInGoogle
                      ? 'A autenticar com Google...'
                      : 'Entrar com Conta Google'}
                  </button>

                  {googleError && (
                    <p role="alert" className="text-xs font-semibold hc:font-bold text-[#DC2626] dark:text-red-400">
                      {googleError}
                    </p>
                  )}

                  <p className="text-xs text-slate-500 dark:text-slate-400 hc:text-black hc:dark:text-white hc:font-medium">
                    Autenticação OAuth segura · Sem partilha pública de contactos
                  </p>
                </div>
              </div>

              {/* Option B: Local Field / Demo Session */}
              <div className="lg:col-span-6 rounded-2xl border border-slate-200 dark:border-[#263248] hc:border-2 hc:border-black hc:dark:border-white bg-white dark:bg-[#161E2E] hc:bg-white hc:dark:bg-black p-6 sm:p-7 flex flex-col justify-between space-y-5">
                <div className="space-y-2">
                  <div className="text-xs font-semibold hc:font-bold text-slate-600 dark:text-slate-400 hc:text-black hc:dark:text-white">
                    Persistência IndexedDB no Dispositivo · Funciona Offline
                  </div>
                  <h3 className="font-display text-xl font-bold text-slate-950 dark:text-white hc:text-black hc:dark:text-white">
                    Iniciar Sessão Local de Proprietário
                  </h3>
                  <p className="text-sm text-slate-600 dark:text-slate-300 hc:text-black hc:dark:text-white hc:font-medium leading-relaxed">
                    Ideal para trabalho imediato no terreno, instâncias Docker próprias ou validação técnica com dados guardados localmente no navegador.
                  </p>
                </div>

                <form onSubmit={handleLocalSubmit} className="space-y-3.5" noValidate>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="sm:col-span-2">
                      <label
                        htmlFor="homepage-owner-name"
                        className="block text-xs font-semibold hc:font-bold text-slate-700 dark:text-slate-300 hc:text-black hc:dark:text-white mb-1"
                      >
                        Nome do Titular
                      </label>
                      <input
                        id="homepage-owner-name"
                        type="text"
                        maxLength={100}
                        value={ownerName}
                        onChange={(e) => setOwnerName(e.target.value)}
                        placeholder="Ex.: Maria Fernanda Silva"
                        className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-white dark:bg-[#0B0F17] hc:bg-white hc:dark:bg-black border border-slate-300 dark:border-[#263248] hc:border-2 hc:border-black hc:dark:border-white text-xs text-slate-900 dark:text-white hc:text-black hc:dark:text-white hc:font-semibold"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="homepage-owner-nif"
                        className="block text-xs font-semibold hc:font-bold text-slate-700 dark:text-slate-300 hc:text-black hc:dark:text-white mb-1"
                      >
                        NIF (Opcional)
                      </label>
                      <input
                        id="homepage-owner-nif"
                        type="text"
                        inputMode="numeric"
                        maxLength={9}
                        value={ownerNif}
                        onChange={(e) => setOwnerNif(e.target.value)}
                        placeholder="218492310"
                        className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-white dark:bg-[#0B0F17] hc:bg-white hc:dark:bg-black border border-slate-300 dark:border-[#263248] hc:border-2 hc:border-black hc:dark:border-white text-xs font-mono tabular-nums text-slate-900 dark:text-white hc:text-black hc:dark:text-white hc:font-semibold"
                      />
                    </div>
                  </div>

                  {localError && (
                    <p role="alert" className="text-xs font-semibold hc:font-bold text-[#DC2626] dark:text-red-400">
                      {localError}
                    </p>
                  )}

                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 pt-1">
                    <button
                      type="submit"
                      className="flex-1 min-h-[46px] px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 dark:bg-white dark:hover:bg-slate-200 hc:bg-black hc:dark:bg-white hc:border-2 hc:border-black hc:dark:border-white text-white dark:text-slate-950 hc:text-white hc:dark:text-black text-xs font-semibold hc:font-bold inline-flex items-center justify-center gap-2 whitespace-nowrap"
                    >
                      <UserCheck className="w-4 h-4" aria-hidden="true" />
                      Entrar com Estes Dados
                    </button>

                    <button
                      type="button"
                      onClick={onSignInDemo}
                      className="min-h-[46px] px-4 py-2.5 rounded-xl border border-slate-300 dark:border-[#263248] hc:border-2 hc:border-black hc:dark:border-white bg-white dark:bg-[#0B0F17] hc:bg-white hc:dark:bg-black hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 hc:text-black hc:dark:text-white text-xs font-semibold hc:font-bold whitespace-nowrap"
                    >
                      Entrar com Perfil Demo
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Quiet Institutional Footer */}
      <footer className="border-t border-slate-200 dark:border-[#263248] hc:border-t-2 hc:border-black hc:dark:border-white py-6 text-xs text-slate-500 dark:text-slate-400 hc:text-black hc:dark:text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <p className="font-semibold hc:font-bold text-slate-800 dark:text-slate-200 hc:text-black hc:dark:text-white">
              FaixaSegura · Gestão de Combustível &amp; Prova Legal
            </p>
            <p className="hc:font-medium">
              Decreto-Lei n.º 82/2021 (SGIFR) · Despacho n.º 675/2026 · Cartografia ETRS89 / PT-TM06 (EPSG:3763)
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onSwitchToWebAppOnboarding}
              className="min-h-[40px] px-3 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] hc:border-2 hc:border-black hc:dark:border-white bg-white dark:bg-[#161E2E] hc:bg-white hc:dark:bg-black text-xs font-semibold hc:font-bold text-slate-700 dark:text-slate-200 hc:text-black hc:dark:text-white hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              Modo WebApp
            </button>

            <button
              type="button"
              onClick={onToggleDarkMode}
              className="min-h-[40px] px-3 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] hc:border-2 hc:border-black hc:dark:border-white bg-white dark:bg-[#161E2E] hc:bg-white hc:dark:bg-black text-xs font-semibold hc:font-bold text-slate-700 dark:text-slate-200 hc:text-black hc:dark:text-white hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              {darkMode ? (
                <>
                  <Sun className="w-3.5 h-3.5 text-[#FACC15]" aria-hidden="true" />
                  Modo Solar
                </>
              ) : (
                <>
                  <Moon className="w-3.5 h-3.5 text-slate-600 hc:text-black" aria-hidden="true" />
                  Modo Noite
                </>
              )}
            </button>

            <button
              type="button"
              data-testid="homepage-high-contrast-toggle"
              aria-pressed={highContrastMode}
              onClick={onToggleHighContrast}
              className={`min-h-[40px] px-3 py-1.5 rounded-xl text-xs inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                highContrastMode
                  ? 'border-2 border-black dark:border-[#FACC15] bg-black dark:bg-[#FACC15] text-white dark:text-black font-bold'
                  : 'border border-slate-300 dark:border-[#263248] bg-white dark:bg-[#161E2E] text-slate-700 dark:text-slate-200 font-semibold hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              <Contrast className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>
                {highContrastMode ? 'Modo de Alto Contraste (Ativo)' : 'Modo de Alto Contraste'}
              </span>
              {highContrastMode && <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
            </button>
          </div>
        </div>
      </footer>
      <QrCertificateScannerModal
        isOpen={isQrScannerOpen}
        certificates={certificates}
        onClose={() => setIsQrScannerOpen(false)}
        onCertificateVerified={onVerifyCertificate}
      />
    </div>
  );
};
