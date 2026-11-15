/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import {
  BookOpen,
  Download,
  FileCheck2,
  History,
  Map as MapIcon,
  Moon,
  Sun,
  SunMedium,
  Tractor,
  WifiOff,
} from 'lucide-react';
import type {
  ActiveFireIncident,
  ComplianceCertificate,
  DailyPirForecast,
  ForestryProvider,
  MunicipalityInfo,
  NeighborComplaintRecord,
  ParcelRecord,
  PirLevel,
  QuoteLead,
  UserAccountProfile,
  UserHistoryRecord,
} from './types/domain.ts';
import {
  FALLBACK_ACTIVE_FIRES,
  INITIAL_CERTIFICATES,
  INITIAL_PARCELS,
  INITIAL_PROVIDERS,
  INITIAL_QUOTES,
  MUNICIPALITIES,
} from './data/seedCatalog.ts';
import { evaluateOperationalSemaphore } from './lib/pirRules.ts';
import { buildSevenDayPirSoilSeries } from './lib/pirTrendEngine.ts';
import { haversineDistanceKm } from './lib/spatialEngine.ts';
import {
  archiveUserHistoryEntry,
  auth,
  deleteUserHistoryEntry,
  ensureUserAnchorAndProfile,
  onAuthStateChanged,
  recordUserHistoryEntry,
  saveUserParcelToCloud,
  signInWithGooglePopup,
  signOutCurrentUser,
  subscribeToUserHistory,
  updateUserContactProfile,
} from './lib/firebase.ts';
import { useOnlineStatus, usePWAInstall } from './hooks/usePWAInstall.ts';
import { TodayCockpitView } from './components/TodayCockpitView.tsx';
import { MapZonesView } from './components/MapZonesView.tsx';
import { CertifyQuotesView } from './components/CertifyQuotesView.tsx';
import { ProvidersGuardianView } from './components/ProvidersGuardianView.tsx';
import { DocsArchitectureView } from './components/DocsArchitectureView.tsx';
import { CertificateVerifyModal } from './components/CertificateVerifyModal.tsx';
import { UserHistoryModal } from './components/UserHistoryModal.tsx';

type NavTab = 'today' | 'map' | 'certify' | 'providers' | 'docs';

function buildInitialForecasts(dico: string): DailyPirForecast[] {
  const muni = MUNICIPALITIES.find((m) => m.dico === dico) ?? MUNICIPALITIES[0];
  return [
    evaluateOperationalSemaphore({
      dateLabel: 'Hoje · Sábado',
      isoDate: new Date().toISOString().slice(0, 10),
      pirLevel: muni.basePirToday,
      tempMaxC: 17 + muni.basePirToday * 3,
      humidityMinPct: Math.max(18, 62 - muni.basePirToday * 9),
      windKmh: 9 + muni.basePirToday * 5,
    }),
    evaluateOperationalSemaphore({
      dateLabel: 'Amanhã · Domingo',
      isoDate: new Date(Date.now() + 86400_000).toISOString().slice(0, 10),
      pirLevel: muni.basePirTomorrow,
      tempMaxC: 18 + muni.basePirTomorrow * 3,
      humidityMinPct: Math.max(20, 60 - muni.basePirTomorrow * 8),
      windKmh: 10 + muni.basePirTomorrow * 5,
    }),
    evaluateOperationalSemaphore({
      dateLabel: 'Segunda-feira',
      isoDate: new Date(Date.now() + 172800_000).toISOString().slice(0, 10),
      pirLevel: muni.basePirDay2,
      tempMaxC: 17 + muni.basePirDay2 * 3,
      humidityMinPct: Math.max(22, 64 - muni.basePirDay2 * 8),
      windKmh: 8 + muni.basePirDay2 * 4,
    }),
  ];
}

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('today');
  const [certifySubMode, setCertifySubMode] = useState<string>('certificate');
  const [darkMode, setDarkMode] = useState<boolean>(false);

  // Domain state initialized deterministically so zero-latency rendering works immediately
  const [municipalities, setMunicipalities] = useState<MunicipalityInfo[]>(MUNICIPALITIES);
  const [parcels, setParcels] = useState<ParcelRecord[]>(INITIAL_PARCELS);
  const [activeParcelId, setActiveParcelId] = useState<string>(INITIAL_PARCELS[0].id);
  const [certificates, setCertificates] = useState<ComplianceCertificate[]>(INITIAL_CERTIFICATES);
  const [providers, setProviders] = useState<ForestryProvider[]>(INITIAL_PROVIDERS);
  const [quotes, setQuotes] = useState<QuoteLead[]>(INITIAL_QUOTES);

  const activeParcel = parcels.find((p) => p.id === activeParcelId) ?? parcels[0];

  const [forecasts, setForecasts] = useState<DailyPirForecast[]>(() =>
    buildInitialForecasts(INITIAL_PARCELS[0].dico)
  );
  const [pirSource, setPirSource] = useState<string>('IPMA RCM');
  const [fires, setFires] = useState<ActiveFireIncident[]>(() =>
    FALLBACK_ACTIVE_FIRES.map((f) => ({
      ...f,
      distanceKm: haversineDistanceKm(INITIAL_PARCELS[0].spatial.centroidWgs84, {
        lat: f.lat,
        lon: f.lon,
      }),
    }))
  );
  const [within15KmCount, setWithin15KmCount] = useState<number>(0);
  const [verifyingCert, setVerifyingCert] = useState<ComplianceCertificate | null>(null);
  const [showIosInstallGuide, setShowIosInstallGuide] = useState(false);

  // Firebase Auth + Consultable Personal History State
  const [authReady, setAuthReady] = useState<boolean>(false);
  const [userProfile, setUserProfile] = useState<UserAccountProfile | null>(null);
  const [userHistory, setUserHistory] = useState<UserHistoryRecord[]>([]);
  const [historySyncError, setHistorySyncError] = useState<string | null>(null);
  const [showHistoryModal, setShowHistoryModal] = useState<boolean>(false);

  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const isOnline = useOnlineStatus();

  const currentSoilMoisturePct = buildSevenDayPirSoilSeries(activeParcel, forecasts[0]).currentSoilMoisturePct;

  // Listen to Firebase Auth state and attach real-time Firestore listener only when authenticated
  useEffect(() => {
    let unsubscribeHistory: (() => void) | null = null;

    const unsubscribeAuth = onAuthStateChanged(auth, async (fbUser) => {
      if (unsubscribeHistory) {
        unsubscribeHistory();
        unsubscribeHistory = null;
      }

      if (!fbUser) {
        setUserProfile(null);
        setUserHistory([]);
        setHistorySyncError(null);
        setAuthReady(true);
        return;
      }

      try {
        const hydrated = await ensureUserAnchorAndProfile(fbUser, activeParcel.dico);
        setUserProfile(hydrated);
        setAuthReady(true);

        unsubscribeHistory = subscribeToUserHistory(
          hydrated.uid,
          (items) => {
            setUserHistory(items);
            setHistorySyncError(null);
          },
          (errMsg) => setHistorySyncError(errMsg)
        );
      } catch {
        setAuthReady(true);
      }
    });

    return () => {
      unsubscribeAuth();
      if (unsubscribeHistory) unsubscribeHistory();
    };
  }, []);

  // Sync dark mode class on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [darkMode]);

  // Hydrate live backend state and check ?verify= query param
  useEffect(() => {
    fetch('/api/state')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        if (Array.isArray(data.municipalities)) setMunicipalities(data.municipalities);
        if (Array.isArray(data.parcels) && data.parcels.length > 0) setParcels(data.parcels);
        if (Array.isArray(data.certificates)) setCertificates(data.certificates);
        if (Array.isArray(data.providers)) setProviders(data.providers);
        if (Array.isArray(data.quotes)) setQuotes(data.quotes);

        const params = new URLSearchParams(window.location.search);
        const verifyCode = params.get('verify');
        if (verifyCode && Array.isArray(data.certificates)) {
          const found = data.certificates.find(
            (c: ComplianceCertificate) => c.shortCode.toUpperCase() === verifyCode.toUpperCase()
          );
          if (found) setVerifyingCert(found);
        }
      })
      .catch(() => {});
  }, []);

  // Fetch PIR 3-day semaphore and Active Fires whenever activeParcel changes
  useEffect(() => {
    setForecasts(buildInitialForecasts(activeParcel.dico));

    fetch(`/api/pir/${encodeURIComponent(activeParcel.dico)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.forecasts?.length) {
          setForecasts(data.forecasts);
          setPirSource(data.source || 'IPMA RCM');
        }
      })
      .catch(() => {});

    const c = activeParcel.spatial.centroidWgs84;
    fetch(`/api/fires/active?lat=${c.lat}&lon=${c.lon}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (Array.isArray(data?.incidents)) {
          setFires(data.incidents);
          setWithin15KmCount(Number(data.within15KmCount ?? 0));
        }
      })
      .catch(() => {});
  }, [activeParcel.id, activeParcel.dico]);

  const handleNavigate = (tab: NavTab, subMode?: string) => {
    setActiveTab(tab);
    if (subMode) setCertifySubMode(subMode);
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] dark:bg-[#0B0F17] text-[#0F172A] dark:text-[#F8FAFC] pb-20 lg:pb-10">
      {/* Strict 3-Zone Top Bar Contract (h-12 mobile = 48px, lg:h-16) */}
      <header className="sticky top-0 z-30 h-12 lg:h-16 bg-white/95 dark:bg-[#161E2E]/95 backdrop-blur-md border-b border-slate-200 dark:border-[#263248]">
        <div className="max-w-7xl mx-auto h-full px-4 sm:px-6 flex items-center justify-between gap-8">
          {/* Zone 1: Single text element wordmark */}
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              handleNavigate('today');
            }}
            className="font-display text-lg lg:text-xl font-bold tracking-tight text-[#14532D] dark:text-[#22C55E] whitespace-nowrap shrink-0"
          >
            FaixaSegura
          </a>

          {/* Zone 2: 5 concise single-line text navigation links (Desktop/Landscape Tablet) */}
          <nav
            aria-label="Navegação principal"
            className="hidden lg:flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-300"
          >
            <button
              type="button"
              onClick={() => handleNavigate('today')}
              className={`py-1 transition-colors whitespace-nowrap shrink-0 hover:text-slate-950 dark:hover:text-white ${
                activeTab === 'today'
                  ? 'text-[#14532D] dark:text-[#22C55E] font-semibold underline underline-offset-8 decoration-2'
                  : ''
              }`}
            >
              Hoje
            </button>
            <button
              type="button"
              onClick={() => handleNavigate('map')}
              className={`py-1 transition-colors whitespace-nowrap shrink-0 hover:text-slate-950 dark:hover:text-white ${
                activeTab === 'map'
                  ? 'text-[#14532D] dark:text-[#22C55E] font-semibold underline underline-offset-8 decoration-2'
                  : ''
              }`}
            >
              Mapa & Faixas
            </button>
            <button
              type="button"
              onClick={() => handleNavigate('certify', 'certificate')}
              className={`py-1 transition-colors whitespace-nowrap shrink-0 hover:text-slate-950 dark:hover:text-white ${
                activeTab === 'certify'
                  ? 'text-[#14532D] dark:text-[#22C55E] font-semibold underline underline-offset-8 decoration-2'
                  : ''
              }`}
            >
              Certificar
            </button>
            <button
              type="button"
              onClick={() => handleNavigate('providers')}
              className={`py-1 transition-colors whitespace-nowrap shrink-0 hover:text-slate-950 dark:hover:text-white ${
                activeTab === 'providers'
                  ? 'text-[#14532D] dark:text-[#22C55E] font-semibold underline underline-offset-8 decoration-2'
                  : ''
              }`}
            >
              Prestadores
            </button>
            <button
              type="button"
              onClick={() => handleNavigate('docs')}
              className={`py-1 transition-colors whitespace-nowrap shrink-0 hover:text-slate-950 dark:hover:text-white ${
                activeTab === 'docs'
                  ? 'text-[#14532D] dark:text-[#22C55E] font-semibold underline underline-offset-8 decoration-2'
                  : ''
              }`}
            >
              Documentação
            </button>
          </nav>

          {/* Zone 3: 1 primary CTA action */}
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={() => handleNavigate('certify', 'quotes')}
              className="min-h-[38px] lg:min-h-[42px] px-3.5 lg:px-4 py-1.5 rounded-xl bg-[#D97706] hover:bg-[#B45309] text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
            >
              Pedir 3 Orçamentos
            </button>
          </div>
        </div>
      </header>

      {/* Non-sticky Workspace Context Toolbar (Parcel Switcher, Solar/Dark Theme, PWA Install) */}
      <div className="border-b border-slate-200 dark:border-[#263248] bg-slate-100/70 dark:bg-[#0F1624]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5">
          <div className="flex items-center gap-2.5 w-full sm:w-auto min-w-0">
            <label htmlFor="workspace-parcel-select" className="text-xs font-semibold text-slate-600 dark:text-slate-400 whitespace-nowrap shrink-0">
              Terreno:
            </label>
            <select
              id="workspace-parcel-select"
              value={activeParcel.id}
              onChange={(e) => setActiveParcelId(e.target.value)}
              className="min-h-[42px] flex-1 sm:flex-initial sm:w-72 min-w-0 px-3 py-1.5 rounded-xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-900 dark:text-white truncate"
            >
              {parcels.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({p.municipality})
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center justify-between sm:justify-end gap-2 w-full sm:w-auto">
            {/* Mobile/Tablet Docs shortcut */}
            <button
              type="button"
              onClick={() => handleNavigate('docs')}
              className={`lg:hidden min-h-[42px] px-3 py-1.5 rounded-xl border text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap ${
                activeTab === 'docs'
                  ? 'border-[#14532D] bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                  : 'border-slate-300 dark:border-[#263248] bg-white dark:bg-[#161E2E] text-slate-700 dark:text-slate-200'
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
              PRD & Docs
            </button>

            <div className="flex items-center gap-2 ml-auto sm:ml-0">
              {/* User Account & Consultable History Trigger */}
              <button
                type="button"
                onClick={() => setShowHistoryModal(true)}
                className={`min-h-[42px] px-3 py-1.5 rounded-xl border text-xs font-semibold transition-colors inline-flex items-center gap-1.5 whitespace-nowrap ${
                  userProfile
                    ? 'border-[#14532D] dark:border-[#22C55E] bg-[#14532D]/10 dark:bg-[#22C55E]/15 text-[#14532D] dark:text-[#22C55E]'
                    : 'border-slate-300 dark:border-[#263248] bg-white dark:bg-[#161E2E] text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
              >
                <History className="w-3.5 h-3.5" aria-hidden="true" />
                {userProfile
                  ? `Histórico (${userHistory.filter((h) => h.status === 'ACTIVE').length}) · ${userProfile.displayName.split(' ')[0]}`
                  : 'Entrar / Histórico'}
              </button>

              {/* PWA Install Button */}
              {!isInstalled && isInstallable && (
                <button
                  type="button"
                  onClick={install}
                  className="min-h-[42px] px-3 py-1.5 rounded-xl border border-[#14532D] dark:border-[#22C55E] text-xs font-semibold text-[#14532D] dark:text-[#22C55E] bg-white dark:bg-[#161E2E] inline-flex items-center gap-1.5 whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  Instalar App
                </button>
              )}
              {!isInstalled && !isInstallable && isIOS && (
                <button
                  type="button"
                  onClick={() => setShowIosInstallGuide(true)}
                  className="min-h-[42px] px-3 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-200 bg-white dark:bg-[#161E2E] whitespace-nowrap"
                >
                  Instalar no iOS
                </button>
              )}

              {/* Solar Light / Dark Night Mode Switch */}
              <button
                type="button"
                onClick={() => setDarkMode((d) => !d)}
                className="min-h-[42px] px-3 py-1.5 rounded-xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                {darkMode ? (
                  <>
                    <Sun className="w-3.5 h-3.5 text-[#FACC15]" aria-hidden="true" />
                    Modo Solar
                  </>
                ) : (
                  <>
                    <Moon className="w-3.5 h-3.5 text-slate-600" aria-hidden="true" />
                    Modo Noite
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Offline Mode Indicator */}
      {!isOnline && (
        <div className="bg-amber-500 text-slate-950 text-xs font-semibold px-4 py-2 text-center flex items-center justify-center gap-2">
          <WifiOff className="w-4 h-4" aria-hidden="true" />
          Modo Offline no Terreno — A utilizar polígonos e matriz legal em cache local.
        </div>
      )}

      {/* Main Content Workspace */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6">
        {activeTab === 'today' && (
          <TodayCockpitView
            activeParcel={activeParcel}
            forecasts={forecasts}
            pirSource={pirSource}
            fires={fires}
            within15KmCount={within15KmCount}
            isAuthenticated={Boolean(userProfile)}
            onOpenHistoryModal={() => setShowHistoryModal(true)}
            onLogDecisionToHistory={async ({ pirLevel, soilMoisturePct, verdictLabel, detail }) => {
              if (!userProfile) return;
              await recordUserHistoryEntry({
                uid: userProfile.uid,
                category: 'INTERVENTION',
                title: verdictLabel,
                parcelId: activeParcel.id,
                parcelLabel: activeParcel.label,
                municipality: activeParcel.municipality,
                referenceCode: `DEC-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
                areaM2: activeParcel.spatial.mandatoryCleanAreaM2,
                pirLevel,
                soilMoisturePct,
                summary: detail,
              });
            }}
            onNavigateTab={handleNavigate}
          />
        )}

        {activeTab === 'map' && (
          <MapZonesView
            parcels={parcels}
            activeParcel={activeParcel}
            municipalities={municipalities}
            fires={fires}
            onSelectParcel={(id) => setActiveParcelId(id)}
            onCreateParcel={(created) => {
              setParcels((prev) => [created, ...prev]);
              setActiveParcelId(created.id);
              if (userProfile) {
                void saveUserParcelToCloud(userProfile.uid, created).catch(() => {});
                void recordUserHistoryEntry({
                  uid: userProfile.uid,
                  category: 'PARCEL',
                  title: `Terreno registado: ${created.label}`,
                  parcelId: created.id,
                  parcelLabel: created.label,
                  municipality: created.municipality,
                  referenceCode: created.bupiRggId,
                  areaM2: created.spatial.mandatoryCleanAreaM2,
                  pirLevel: forecasts[0]?.pirLevel ?? 2,
                  soilMoisturePct: currentSoilMoisturePct,
                  summary: `Área total ${created.spatial.totalAreaM2.toFixed(0)} m² · Limpeza exigível ${created.spatial.mandatoryCleanAreaM2.toFixed(0)} m² (${created.matrixArticle}).`,
                }).catch(() => {});
              }
            }}
            onNavigateTab={handleNavigate}
          />
        )}

        {activeTab === 'certify' && (
          <CertifyQuotesView
            activeParcel={activeParcel}
            certificates={certificates}
            todayForecast={forecasts[0]}
            defaultOwnerName={userProfile?.displayName}
            defaultOwnerNif={userProfile?.nif}
            initialSubMode={certifySubMode}
            onCertificateIssued={(cert) => {
              setCertificates((prev) => [cert, ...prev]);
              if (userProfile) {
                void recordUserHistoryEntry({
                  uid: userProfile.uid,
                  category: 'CERTIFICATE',
                  title: `Auto SHA-256 Emitido (${cert.shortCode})`,
                  parcelId: cert.parcelId,
                  parcelLabel: cert.parcelLabel,
                  municipality: cert.municipality,
                  referenceCode: cert.shortCode,
                  areaM2: cert.cleanedAreaM2,
                  pirLevel: cert.pirLevelAtWork,
                  soilMoisturePct: currentSoilMoisturePct,
                  summary: `Certificado criptográfico SHA-256 (${cert.sha256Hash.slice(0, 16)}...) para ${cert.ownerName}.`,
                }).catch(() => {});
              }
            }}
            onQuoteCreated={(lead) => {
              setQuotes((prev) => [lead, ...prev]);
              if (userProfile) {
                void recordUserHistoryEntry({
                  uid: userProfile.uid,
                  category: 'QUOTE',
                  title: `Pedido de 3 Orçamentos (${lead.estimatedBudgetRange})`,
                  parcelId: lead.parcelId,
                  parcelLabel: lead.parcelLabel,
                  municipality: lead.municipality,
                  referenceCode: lead.id.toUpperCase().slice(0, 18),
                  areaM2: lead.mandatoryCleanAreaM2,
                  pirLevel: forecasts[0]?.pirLevel ?? 2,
                  soilMoisturePct: currentSoilMoisturePct,
                  summary: `Janela preferencial: ${lead.preferredWindow} · Declive ${lead.avgSlopePct}% · ${lead.matchedProvidersCount} empresas notificadas.`,
                }).catch(() => {});
              }
            }}
            onNeighborComplaintCreated={(rec: NeighborComplaintRecord) => {
              if (userProfile) {
                void recordUserHistoryEntry({
                  uid: userProfile.uid,
                  category: 'NEIGHBOR',
                  title: `Dossiê Vizinho Incumpridor (${rec.reqCode})`,
                  parcelId: rec.parcelId,
                  parcelLabel: activeParcel.label,
                  municipality: rec.municipality,
                  referenceCode: rec.reqCode,
                  areaM2: activeParcel.spatial.mandatoryCleanAreaM2,
                  pirLevel: forecasts[0]?.pirLevel ?? 3,
                  soilMoisturePct: currentSoilMoisturePct,
                  summary: `Confrontação ${rec.confrontationSide} a ${rec.minDistanceFacadeM.toFixed(1)} m da fachada · NDVI ${rec.neighborNdvi.toFixed(2)}.`,
                }).catch(() => {});
              }
            }}
            onInspectCertificate={(cert) => setVerifyingCert(cert)}
          />
        )}

        {activeTab === 'providers' && (
          <ProvidersGuardianView
            parcels={parcels}
            activeParcel={activeParcel}
            certificates={certificates}
            providers={providers}
            quotes={quotes}
            municipalities={municipalities}
            onSelectParcel={(id) => setActiveParcelId(id)}
            onInspectCertificate={(cert) => setVerifyingCert(cert)}
            onProviderRegistered={(prov) => setProviders((prev) => [prov, ...prev])}
            onQuoteUnlocked={(updated) =>
              setQuotes((prev) => prev.map((q) => (q.id === updated.id ? updated : q)))
            }
          />
        )}

        {activeTab === 'docs' && <DocsArchitectureView />}
      </main>

      {/* Quiet Institutional Footer (Desktop) */}
      <footer className="hidden lg:block border-t border-slate-200 dark:border-[#263248] py-5 text-xs text-slate-500 dark:text-slate-400">
        <div className="max-w-7xl mx-auto px-6 flex items-center justify-between">
          <span>
            FaixaSegura · Enquadramento Técnico: Decreto-Lei n.º 82/2021 (SGIFR) & Despacho n.º 675/2026
          </span>
          <span>Cartografia Métrica Oficial ETRS89 / PT-TM06 (EPSG:3763)</span>
        </div>
      </footer>

      {/* Mobile & Portrait Tablet Fixed Bottom 4-Tab Thumb Bar (h-14 = 56px; total sticky <= 12.5% of 844px) */}
      <nav
        aria-label="Navegação móvel de campo"
        className="lg:hidden fixed bottom-0 left-0 right-0 z-40 h-14 bg-white/95 dark:bg-[#161E2E]/95 backdrop-blur-md border-t border-slate-200 dark:border-[#263248] grid grid-cols-4 items-center"
      >
        <button
          type="button"
          onClick={() => handleNavigate('today')}
          className={`min-h-[48px] flex flex-col items-center justify-center transition-colors ${
            activeTab === 'today'
              ? 'text-[#14532D] dark:text-[#22C55E] font-bold'
              : 'text-slate-500 dark:text-slate-400'
          }`}
        >
          <SunMedium className="w-5 h-5" aria-hidden="true" />
          <span className="text-[10px] tracking-tight mt-0.5 whitespace-nowrap">Hoje</span>
        </button>

        <button
          type="button"
          onClick={() => handleNavigate('map')}
          className={`min-h-[48px] flex flex-col items-center justify-center transition-colors ${
            activeTab === 'map'
              ? 'text-[#14532D] dark:text-[#22C55E] font-bold'
              : 'text-slate-500 dark:text-slate-400'
          }`}
        >
          <MapIcon className="w-5 h-5" aria-hidden="true" />
          <span className="text-[10px] tracking-tight mt-0.5 whitespace-nowrap">Mapa & Faixas</span>
        </button>

        <button
          type="button"
          onClick={() => handleNavigate('certify', 'certificate')}
          className={`min-h-[48px] flex flex-col items-center justify-center transition-colors ${
            activeTab === 'certify'
              ? 'text-[#14532D] dark:text-[#22C55E] font-bold'
              : 'text-slate-500 dark:text-slate-400'
          }`}
        >
          <FileCheck2 className="w-5 h-5" aria-hidden="true" />
          <span className="text-[10px] tracking-tight mt-0.5 whitespace-nowrap">Certificar</span>
        </button>

        <button
          type="button"
          onClick={() => handleNavigate('providers')}
          className={`min-h-[48px] flex flex-col items-center justify-center transition-colors ${
            activeTab === 'providers'
              ? 'text-[#14532D] dark:text-[#22C55E] font-bold'
              : 'text-slate-500 dark:text-slate-400'
          }`}
        >
          <Tractor className="w-5 h-5" aria-hidden="true" />
          <span className="text-[10px] tracking-tight mt-0.5 whitespace-nowrap">Prestadores</span>
        </button>
      </nav>

      {/* Public SHA-256 Verification Modal */}
      <CertificateVerifyModal
        certificate={verifyingCert}
        onClose={() => setVerifyingCert(null)}
      />

      {/* User Login & Consultable Personal History Modal */}
      <UserHistoryModal
        isOpen={showHistoryModal}
        onClose={() => setShowHistoryModal(false)}
        authReady={authReady}
        profile={userProfile}
        historyItems={userHistory}
        activeParcel={activeParcel}
        todayForecast={forecasts[0]}
        currentSoilMoisturePct={currentSoilMoisturePct}
        syncError={historySyncError}
        onSignInGoogle={async () => {
          await signInWithGooglePopup();
        }}
        onSignOut={async () => {
          await signOutCurrentUser();
        }}
        onUpdateProfile={async ({ displayName, nif, phone }) => {
          if (!userProfile) return;
          await updateUserContactProfile({
            uid: userProfile.uid,
            displayName,
            preferredDico: activeParcel.dico,
            email: userProfile.email,
            nif,
            phone,
          });
          setUserProfile((prev) =>
            prev ? { ...prev, displayName, nif, phone, preferredDico: activeParcel.dico } : null
          );
        }}
        onCreateIntervention={async ({ title, summary, pirLevel, soilMoisturePct }: { title: string; summary: string; pirLevel: PirLevel; soilMoisturePct: number }) => {
          if (!userProfile) return;
          await recordUserHistoryEntry({
            uid: userProfile.uid,
            category: 'INTERVENTION',
            title,
            parcelId: activeParcel.id,
            parcelLabel: activeParcel.label,
            municipality: activeParcel.municipality,
            referenceCode: `INT-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
            areaM2: activeParcel.spatial.mandatoryCleanAreaM2,
            pirLevel,
            soilMoisturePct,
            summary,
          });
        }}
        onArchiveEntry={async (entryId) => {
          if (!userProfile) return;
          await archiveUserHistoryEntry(userProfile.uid, entryId);
        }}
        onDeleteEntry={async (entryId) => {
          if (!userProfile) return;
          await deleteUserHistoryEntry(userProfile.uid, entryId);
        }}
      />

      {/* iOS Safari Install Instructions Dialog */}
      {showIosInstallGuide && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Instruções de instalação no iOS"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-[#161E2E] p-5 border border-slate-300 dark:border-[#263248] space-y-3">
            <h3 className="text-base font-bold text-slate-900 dark:text-white">
              Instalar FaixaSegura no iPhone / iPad
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              1. Toque no botão <strong>Partilhar</strong> na barra do Safari.<br />
              2. Escolha <strong>Adicionar ao Ecrã Principal</strong> para acesso rápido offline no terreno.
            </p>
            <button
              type="button"
              onClick={() => setShowIosInstallGuide(false)}
              className="w-full min-h-[44px] rounded-xl bg-[#14532D] text-white text-xs font-semibold"
            >
              Entendido
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
