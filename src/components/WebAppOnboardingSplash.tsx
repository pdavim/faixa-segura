import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  LogIn,
  Moon,
  ShieldCheck,
  Sun,
  UserCheck,
} from 'lucide-react';
import webappPerimeterImg from '../assets/images/webapp_forestry_perimeter_1794766504028.jpg';
import { ONBOARDING_SLIDES, validateLocalSessionInput } from '../lib/appShellMode.ts';

interface WebAppOnboardingSplashProps {
  darkMode: boolean;
  isOnline: boolean;
  isFirebaseConfigured: boolean;
  onToggleDarkMode: () => void;
  onSignInGoogle: () => Promise<void>;
  onSignInLocalCustom: (params: { displayName: string; nif: string }) => void;
  onSignInDemo: () => void;
  onSwitchToWebviewHomepage: () => void;
}

export const WebAppOnboardingSplash: React.FC<WebAppOnboardingSplashProps> = ({
  darkMode,
  isOnline,
  isFirebaseConfigured,
  onToggleDarkMode,
  onSignInGoogle,
  onSignInLocalCustom,
  onSignInDemo,
  onSwitchToWebviewHomepage,
}) => {
  const [stage, setStage] = useState<'splash' | 'onboarding'>(() => {
    if (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return 'onboarding';
    }
    return 'splash';
  });

  const [splashProgress, setSplashProgress] = useState(false);
  const [slideIndex, setSlideIndex] = useState(0);
  const [imgFailed, setImgFailed] = useState(false);

  const [signingInGoogle, setSigningInGoogle] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);

  const [showCustomForm, setShowCustomForm] = useState(false);
  const [ownerName, setOwnerName] = useState('');
  const [ownerNif, setOwnerNif] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (stage !== 'splash') return;
    const raf = window.requestAnimationFrame(() => setSplashProgress(true));
    const timer = window.setTimeout(() => {
      setStage('onboarding');
    }, 850);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [stage]);

  const currentSlide = ONBOARDING_SLIDES[slideIndex] ?? ONBOARDING_SLIDES[0];
  const isLastSlide = slideIndex === ONBOARDING_SLIDES.length - 1;

  const handleGoogleLogin = async () => {
    setGoogleError(null);
    setSigningInGoogle(true);
    try {
      await onSignInGoogle();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('popup-closed-by-user')) {
        setGoogleError('A autenticação Google foi cancelada antes da conclusão.');
      } else if (msg.includes('popup-blocked')) {
        setGoogleError('Janela bloqueada pelo navegador. Utilize o Modo de Campo Local abaixo.');
      } else if (msg.includes('VITE_FIREBASE_API_KEY')) {
        setGoogleError(msg);
      } else {
        setGoogleError('Autenticação Google indisponível. Entre em Modo de Campo Local.');
      }
    } finally {
      setSigningInGoogle(false);
    }
  };

  const handleCustomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    const validation = validateLocalSessionInput({
      displayName: ownerName,
      nif: ownerNif,
    });
    if (!validation.valid) {
      setLocalError(validation.error ?? 'Dados inválidos.');
      return;
    }
    onSignInLocalCustom({
      displayName: validation.sanitizedName,
      nif: validation.sanitizedNif,
    });
  };

  // STAGE A: Dedicated WebApp Splash Screen
  if (stage === 'splash') {
    return (
      <div
        data-testid="webapp-splash-screen"
        className="min-h-screen flex flex-col items-center justify-between bg-[#0B1410] text-white px-6 py-10"
      >
        <div className="w-full max-w-md flex items-center justify-between text-xs text-slate-400 font-mono tabular-nums">
          <span>FaixaSegura WebApp</span>
          <span>ETRS89 / EPSG:3763</span>
        </div>

        <div className="my-auto flex flex-col items-center text-center max-w-md space-y-5">
          <div className="w-20 h-20 rounded-3xl bg-[#14532D] border border-[#22C55E]/40 flex items-center justify-center shadow-lg">
            <ShieldCheck className="w-10 h-10 text-[#4ADE80]" aria-hidden="true" />
          </div>

          <div className="space-y-2">
            <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-white">
              FaixaSegura
            </h1>
            <p className="text-sm text-slate-300 leading-relaxed">
              Gestão de Combustível, Semáforo IPMA e Prova Criptográfica SHA-256 no Terreno
            </p>
          </div>

          {/* Compositor-only transform progress indicator */}
          <div className="w-48 h-1.5 rounded-full bg-white/15 overflow-hidden">
            <div
              className={`h-full w-full bg-[#22C55E] origin-left transition-transform duration-700 ease-out ${
                splashProgress ? 'scale-x-100' : 'scale-x-15'
              }`}
            />
          </div>
        </div>

        <div className="w-full max-w-md flex justify-center">
          <button
            type="button"
            onClick={() => setStage('onboarding')}
            className="min-h-[44px] px-5 py-2.5 rounded-xl border border-white/20 bg-white/10 hover:bg-white/15 text-xs font-semibold text-white transition-colors whitespace-nowrap"
          >
            Avançar para Onboarding
          </button>
        </div>
      </div>
    );
  }

  // STAGE B: Responsive Touch-First WebApp Onboarding + Login
  return (
    <div
      data-testid="webapp-onboarding-screen"
      className="min-h-screen flex flex-col bg-[#F8FAFC] dark:bg-[#0B0F17] text-[#0F172A] dark:text-[#F8FAFC]"
    >
      {/* Compact Mobile/WebApp Top App Bar (h-14 = 56px, well within 15% sticky cap) */}
      <header className="sticky top-0 z-30 h-14 bg-white/90 dark:bg-[#161E2E]/90 backdrop-blur-md border-b border-slate-200 dark:border-[#263248]">
        <div className="max-w-6xl mx-auto h-full px-4 sm:px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <ShieldCheck className="w-5 h-5 text-[#14532D] dark:text-[#22C55E] shrink-0" aria-hidden="true" />
            <span className="font-display text-base sm:text-lg font-bold tracking-tight text-slate-950 dark:text-white truncate">
              FaixaSegura
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onSwitchToWebviewHomepage}
              className="min-h-[44px] px-3 py-1.5 rounded-xl border border-slate-200 dark:border-[#263248] bg-white dark:bg-[#0B0F17] text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <Globe className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Página Web</span>
            </button>

            <button
              type="button"
              onClick={onToggleDarkMode}
              aria-label={darkMode ? 'Ativar Modo Solar' : 'Ativar Modo Noite'}
              className="min-h-[44px] min-w-[44px] rounded-xl border border-slate-200 dark:border-[#263248] bg-white dark:bg-[#0B0F17] text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center justify-center"
            >
              {darkMode ? (
                <Sun className="w-4 h-4 text-[#FACC15]" aria-hidden="true" />
              ) : (
                <Moon className="w-4 h-4 text-slate-600" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Responsive Canvas: Single-hand mobile flow on 390px, balanced 2-column split on lg: 1440px */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-5 lg:py-10 flex flex-col justify-between">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-stretch">
          {/* Left / Top: Onboarding Story & Terrain Visual */}
          <section
            aria-label="Passos de introdução da WebApp"
            className="lg:col-span-7 rounded-3xl border border-slate-200 dark:border-[#263248] bg-white dark:bg-[#161E2E] overflow-hidden flex flex-col justify-between"
          >
            {/* Visual Banner */}
            <div className="relative h-48 sm:h-60 lg:h-64 bg-[#143322] overflow-hidden">
              {!imgFailed ? (
                <img
                  src={webappPerimeterImg}
                  alt="Faixa de gestão de combustível limpa junto a muro rural de pedra e sobreiros ao nascer do sol"
                  referrerPolicy="no-referrer"
                  onError={() => setImgFailed(true)}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#14532D] to-[#0B0F17] text-white p-6">
                  <ShieldCheck className="w-10 h-10 text-[#4ADE80]" aria-hidden="true" />
                </div>
              )}

              <div className="absolute inset-x-0 bottom-0 pt-10 p-4 sm:p-5 bg-gradient-to-t from-black/95 via-black/70 to-transparent text-white flex items-end justify-between gap-3">
                <div>
                  <p className="text-[11px] font-mono tabular-nums text-slate-200">
                    Passo {currentSlide.stepNumber} de 03 · {currentSlide.legalAnchor}
                  </p>
                  <p className="font-display text-lg sm:text-xl font-bold text-white tabular-nums mt-0.5">
                    {currentSlide.metricValue}{' '}
                    <span className="text-xs font-normal text-slate-200">
                      — {currentSlide.metricContext}
                    </span>
                  </p>
                </div>
              </div>
            </div>

            {/* Active Slide Content & Touch Controls */}
            <div className="p-5 sm:p-7 flex-1 flex flex-col justify-between space-y-6">
              <div className="space-y-2.5">
                <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-slate-950 dark:text-white [text-wrap:balance]">
                  {currentSlide.stepNumber}. {currentSlide.title}
                </h1>
                <p className="text-sm sm:text-base text-slate-600 dark:text-slate-300 leading-relaxed">
                  {currentSlide.subtitle}
                </p>
              </div>

              {/* 44px Touch-Target Slide Selector + Previous/Next (wraps cleanly on 375-390px mobile) */}
              <div className="pt-3 border-t border-slate-100 dark:border-[#263248] flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-0.5" role="tablist" aria-label="Selecionar passo de onboarding">
                  {ONBOARDING_SLIDES.map((s, idx) => (
                    <button
                      key={s.stepNumber}
                      type="button"
                      role="tab"
                      aria-selected={idx === slideIndex}
                      aria-label={`Passo ${s.stepNumber}: ${s.title}`}
                      onClick={() => setSlideIndex(idx)}
                      className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl focus-visible:outline-2 focus-visible:outline-[#14532D]"
                    >
                      <span
                        className={`h-2 rounded-full transition-all duration-150 ${
                          idx === slideIndex
                            ? 'w-7 bg-[#14532D] dark:bg-[#22C55E]'
                            : 'w-2.5 bg-slate-300 dark:bg-slate-600'
                        }`}
                      />
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-2 ml-auto">
                  {slideIndex > 0 && (
                    <button
                      type="button"
                      onClick={() => setSlideIndex((i) => Math.max(0, i - 1))}
                      aria-label="Passo anterior"
                      className="min-h-[44px] px-3 py-2 rounded-xl border border-slate-300 dark:border-[#263248] bg-white dark:bg-[#0B0F17] text-xs font-semibold text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5 whitespace-nowrap"
                    >
                      <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
                      Anterior
                    </button>
                  )}

                  {!isLastSlide ? (
                    <button
                      type="button"
                      onClick={() => setSlideIndex((i) => Math.min(ONBOARDING_SLIDES.length - 1, i + 1))}
                      className="min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-950 text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap"
                    >
                      Seguinte
                      <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  ) : (
                    <span className="text-xs font-semibold text-[#14532D] dark:text-[#22C55E] px-2 whitespace-nowrap">
                      Pronto para entrar
                    </span>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* Right / Bottom Natural Thumb Zone: Login & Field Access Sheet */}
          <section
            aria-label="Autenticação da WebApp"
            className="lg:col-span-5 rounded-3xl border border-slate-200 dark:border-[#263248] bg-white dark:bg-[#161E2E] p-5 sm:p-7 flex flex-col justify-between space-y-5"
          >
            <div className="space-y-2">
              <p className="text-xs font-semibold text-[#14532D] dark:text-[#22C55E]">
                Acesso Reservado ao Utilizador
              </p>
              <h2 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-slate-950 dark:text-white">
                Entrar na WebApp de Campo
              </h2>
              <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                Autentique-se para abrir o cockpit diário IPMA, os polígonos cadastrais dos seus terrenos e a emissão de certificados SHA-256.
              </p>
            </div>

            <div className="space-y-3">
              {/* Primary Action: Google Cloud Auth */}
              <button
                type="button"
                disabled={signingInGoogle || !isOnline || !isFirebaseConfigured}
                onClick={handleGoogleLogin}
                className="w-full min-h-[48px] px-4 py-3 rounded-2xl bg-[#14532D] hover:bg-[#0F3F22] disabled:opacity-50 dark:bg-[#22C55E] dark:hover:bg-[#16A34A] text-white dark:text-slate-950 text-sm font-semibold transition-colors inline-flex items-center justify-center gap-2 whitespace-nowrap"
              >
                <LogIn className="w-4 h-4" aria-hidden="true" />
                {!isOnline
                  ? 'Sem rede — utilize Modo de Campo abaixo'
                  : !isFirebaseConfigured
                  ? 'Cloud Auth indisponível — utilize Modo Local'
                  : signingInGoogle
                  ? 'A autenticar...'
                  : 'Entrar com Conta Google'}
              </button>

              {googleError && (
                <p role="alert" className="text-xs font-semibold text-[#DC2626] dark:text-red-400">
                  {googleError}
                </p>
              )}

              {/* Secondary Action: 1-Tap Local Field Demo Session */}
              <button
                type="button"
                onClick={onSignInDemo}
                className="w-full min-h-[48px] px-4 py-3 rounded-2xl border border-slate-300 dark:border-[#263248] bg-slate-50 dark:bg-[#0B0F17] hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-900 dark:text-white text-sm font-semibold transition-colors inline-flex items-center justify-center gap-2 whitespace-nowrap"
              >
                <UserCheck className="w-4 h-4 text-[#14532D] dark:text-[#22C55E]" aria-hidden="true" />
                Entrar em Modo de Campo (Demo Local)
              </button>

              {/* Expandable Custom Titular Form */}
              <div className="pt-2 border-t border-slate-100 dark:border-[#263248]">
                <button
                  type="button"
                  aria-expanded={showCustomForm}
                  onClick={() => setShowCustomForm((v) => !v)}
                  className="w-full min-h-[44px] text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white transition-colors"
                >
                  {showCustomForm
                    ? 'Ocultar formulário de titular personalizado'
                    : 'Ou indicar nome e NIF para sessão local no dispositivo'}
                </button>

                {showCustomForm && (
                  <form onSubmit={handleCustomSubmit} className="mt-3 space-y-3" noValidate>
                    <div>
                      <label
                        htmlFor="webapp-owner-name"
                        className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                      >
                        Nome do Titular
                      </label>
                      <input
                        id="webapp-owner-name"
                        type="text"
                        maxLength={100}
                        value={ownerName}
                        onChange={(e) => setOwnerName(e.target.value)}
                        placeholder="Ex.: António Costa Ribeiro"
                        className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="webapp-owner-nif"
                        className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                      >
                        NIF (Opcional, 9 dígitos)
                      </label>
                      <input
                        id="webapp-owner-nif"
                        type="text"
                        inputMode="numeric"
                        maxLength={9}
                        value={ownerNif}
                        onChange={(e) => setOwnerNif(e.target.value)}
                        placeholder="218492310"
                        className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs font-mono tabular-nums text-slate-900 dark:text-white"
                      />
                    </div>

                    {localError && (
                      <p role="alert" className="text-xs font-semibold text-[#DC2626] dark:text-red-400">
                        {localError}
                      </p>
                    )}

                    <button
                      type="submit"
                      className="w-full min-h-[46px] px-4 py-2.5 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap"
                    >
                      Iniciar Sessão Local Personalizada
                    </button>
                  </form>
                )}
              </div>
            </div>

            <div className="text-[11px] text-slate-500 dark:text-slate-400 flex flex-wrap items-center justify-between gap-2 pt-1">
              <span>Persistência IndexedDB ativa</span>
              <span>DL n.º 82/2021 · Despacho 675/2026</span>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
};
