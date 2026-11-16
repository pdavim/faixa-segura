/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Download,
  History,
  LogOut,
  Map as MapIcon,
  Moon,
  Share2,
  Sun,
  SunMedium,
  Tractor,
  User as UserIcon,
  WifiOff,
} from 'lucide-react';
import type {
  ActiveFireIncident,
  ComplianceCertificate,
  DailyPirForecast,
  ForestryProvider,
  MunicipalityInfo,
  NeighborComplaintRecord,
  ParcelDocumentRecord,
  ParcelRecord,
  PirLevel,
  QuoteLead,
  UserAccountProfile,
  UserAppSettings,
  UserHistoryCategory,
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
  deleteUserParcelFromCloud,
  ensureUserAnchorAndProfile,
  isFirebaseConfigured,
  onAuthStateChanged,
  saveUserParcelToCloud,
  signInWithGooglePopup,
  signOutCurrentUser,
  subscribeToUserHistory,
  syncHistoryEntryToCloud,
  updateUserContactProfile,
} from './lib/firebase.ts';
import {
  OFFLINE_LOCAL_UID,
  OfflineSyncCoordinator,
  buildLocalHistoryEntry,
  computeEffectivePendingSyncCount,
  createBrowserOfflineStorageAdapter,
  mergeHistoryWithOffline,
  mergeParcelsWithOffline,
  type OfflineSyncOperation,
} from './lib/offlineStorage.ts';
import {
  buildDefaultDemoProfile,
  buildLocalSessionProfile,
  buildParcelShareUrl,
  clearLocalAuthSession,
  copyDeepLinkToClipboard,
  detectEntryExperienceMode,
  extractRequestedParcelId,
  loadLocalAuthSession,
  resolveDeepLinkParcelSelection,
  saveLocalAuthSession,
  shouldAutoStartWorkspace,
  type EntryModeOverride,
} from './lib/appShellMode.ts';
import { findCertificateByScannedPayload } from './lib/qrVerification.ts';
import {
  createBrowserParcelDocumentStorage,
  loadFavoriteProviderIds,
  loadHighContrastPreference,
  loadThemeDarkPreference,
  loadUserAppSettings,
  removeParcelSafely,
  resolveDocumentThemeClasses,
  saveFavoriteProviderIds,
  saveHighContrastPreference,
  saveThemeDarkPreference,
  saveUserAppSettings,
  toggleFavoriteProviderId,
} from './lib/userWorkspaceStore.ts';
import { useOnlineStatus, usePWAInstall } from './hooks/usePWAInstall.ts';
import { TodayCockpitView } from './components/TodayCockpitView.tsx';
import { MapZonesView } from './components/MapZonesView.tsx';
import { CertifyQuotesView } from './components/CertifyQuotesView.tsx';
import { ProvidersGuardianView } from './components/ProvidersGuardianView.tsx';
import { UserManagementView, type UserSubTab } from './components/UserManagementView.tsx';
import { CertificateVerifyModal } from './components/CertificateVerifyModal.tsx';
import { UserHistoryModal } from './components/UserHistoryModal.tsx';
import { PublicWebviewHomepage } from './components/PublicWebviewHomepage.tsx';
import { WebAppOnboardingSplash } from './components/WebAppOnboardingSplash.tsx';

type NavTab = 'today' | 'map' | 'certify' | 'providers' | 'docs' | 'user';

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
  const [userInitialSubTab, setUserInitialSubTab] = useState<UserSubTab>('gallery');
  const [userSubTabNonce, setUserSubTabNonce] = useState<number>(0);
  const [darkMode, setDarkMode] = useState<boolean>(() => loadThemeDarkPreference());
  const [highContrastMode, setHighContrastMode] = useState<boolean>(() =>
    loadHighContrastPreference()
  );

  const updateDarkMode = useCallback((nextValue: boolean | ((prev: boolean) => boolean)) => {
    setDarkMode((prev) => {
      const resolved = typeof nextValue === 'function' ? nextValue(prev) : nextValue;
      return saveThemeDarkPreference(resolved);
    });
  }, []);

  const updateHighContrastMode = useCallback(
    (nextValue: boolean | ((prev: boolean) => boolean)) => {
      setHighContrastMode((prev) => {
        const resolved = typeof nextValue === 'function' ? nextValue(prev) : nextValue;
        return saveHighContrastPreference(resolved);
      });
    },
    []
  );

  // Domain state initialized deterministically so zero-latency rendering works immediately
  const initialDeepLinkParcelId = useMemo(
    () => (typeof window !== 'undefined' ? extractRequestedParcelId(window.location.search) : null),
    []
  );
  const initialParcelResolution = useMemo(
    () =>
      resolveDeepLinkParcelSelection(
        INITIAL_PARCELS,
        initialDeepLinkParcelId,
        INITIAL_PARCELS[0].id
      ),
    [initialDeepLinkParcelId]
  );

  const [municipalities, setMunicipalities] = useState<MunicipalityInfo[]>(MUNICIPALITIES);
  const [parcels, setParcels] = useState<ParcelRecord[]>(INITIAL_PARCELS);
  const [activeParcelId, setActiveParcelId] = useState<string>(initialParcelResolution.selectedId);
  const pendingDeepLinkParcelIdRef = useRef<string | null>(
    initialDeepLinkParcelId && !initialParcelResolution.matched ? initialDeepLinkParcelId : null
  );
  const [shareToast, setShareToast] = useState<{ parcelId: string; shareUrl: string } | null>(null);
  const shareResetTimerRef = useRef<number | null>(null);

  const [certificates, setCertificates] = useState<ComplianceCertificate[]>(INITIAL_CERTIFICATES);
  const [providers, setProviders] = useState<ForestryProvider[]>(INITIAL_PROVIDERS);
  const [quotes, setQuotes] = useState<QuoteLead[]>(INITIAL_QUOTES);
  const [favoriteProviderIds, setFavoriteProviderIds] = useState<string[]>(() =>
    loadFavoriteProviderIds()
  );
  const [userSettings, setUserSettings] = useState<UserAppSettings>(() => loadUserAppSettings());
  const [parcelDocuments, setParcelDocuments] = useState<ParcelDocumentRecord[]>([]);
  const docStorage = useMemo(() => createBrowserParcelDocumentStorage(), []);

  const activeParcel = parcels.find((p) => p.id === activeParcelId) ?? parcels[0];

  const [forecasts, setForecasts] = useState<DailyPirForecast[]>(() =>
    buildInitialForecasts(activeParcel.dico)
  );
  const [pirSource, setPirSource] = useState<string>('IPMA RCM');
  const [fires, setFires] = useState<ActiveFireIncident[]>(() =>
    FALLBACK_ACTIVE_FIRES.map((f) => ({
      ...f,
      distanceKm: haversineDistanceKm(activeParcel.spatial.centroidWgs84, {
        lat: f.lat,
        lon: f.lon,
      }),
    }))
  );
  const [within15KmCount, setWithin15KmCount] = useState<number>(0);
  const [verifyingCert, setVerifyingCert] = useState<ComplianceCertificate | null>(null);
  const [showIosInstallGuide, setShowIosInstallGuide] = useState(false);

  // Firebase Cloud Auth + Persisted Local Field Session + Entry Mode State
  const [authReady, setAuthReady] = useState<boolean>(false);
  const [cloudUserProfile, setCloudUserProfile] = useState<UserAccountProfile | null>(null);
  const [localSessionProfile, setLocalSessionProfile] = useState<UserAccountProfile | null>(() => {
    const existing = loadLocalAuthSession();
    if (existing) return existing;
    if (typeof window !== 'undefined' && shouldAutoStartWorkspace(window.location.search)) {
      const targetParcel =
        INITIAL_PARCELS.find((p) => p.id === initialDeepLinkParcelId) ?? INITIAL_PARCELS[0];
      const demo = buildDefaultDemoProfile(targetParcel.dico);
      saveLocalAuthSession(demo);
      return demo;
    }
    return null;
  });
  const [entryModeOverride, setEntryModeOverride] = useState<EntryModeOverride>(null);
  const [isStandalonePwa, setIsStandalonePwa] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches
    );
  });

  const userProfile = cloudUserProfile ?? localSessionProfile;
  const isCloudSession = Boolean(cloudUserProfile);
  const isAuthenticated = Boolean(userProfile);

  const entryExperienceMode = useMemo(() => {
    const search = typeof window !== 'undefined' ? window.location.search : '';
    const navStandalone =
      typeof window !== 'undefined'
        ? (window.navigator as unknown as { standalone?: boolean }).standalone === true
        : false;
    const referrer = typeof document !== 'undefined' ? document.referrer : '';
    return detectEntryExperienceMode({
      search,
      isStandaloneDisplay: isStandalonePwa,
      navigatorStandalone: navStandalone,
      referrer,
      overrideMode: entryModeOverride,
    });
  }, [isStandalonePwa, entryModeOverride]);

  const [remoteHistory, setRemoteHistory] = useState<UserHistoryRecord[]>([]);
  const [localHistory, setLocalHistory] = useState<UserHistoryRecord[]>([]);
  const [outboxOps, setOutboxOps] = useState<OfflineSyncOperation[]>([]);
  const [offlineParcelsCount, setOfflineParcelsCount] = useState<number>(0);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [lastSyncedAtIso, setLastSyncedAtIso] = useState<string | null>(null);
  const [storageBackend, setStorageBackend] = useState<'indexeddb' | 'localstorage' | 'memory'>('indexeddb');
  const [historySyncError, setHistorySyncError] = useState<string | null>(null);
  const [showHistoryModal, setShowHistoryModal] = useState<boolean>(false);

  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const isOnline = useOnlineStatus();

  // Only flush to Cloud Firestore when authenticated via real Firebase Auth (cloudUserProfile)
  const cloudUidRef = useRef<string | null>(null);
  cloudUidRef.current = cloudUserProfile?.uid ?? null;
  const activeUidRef = useRef<string | null>(null);
  activeUidRef.current = userProfile?.uid ?? null;

  const syncCoordinator = useMemo(() => {
    const storage = createBrowserOfflineStorageAdapter();
    return new OfflineSyncCoordinator({
      storage,
      transport: {
        saveParcel: saveUserParcelToCloud,
        deleteParcel: deleteUserParcelFromCloud,
        createHistory: syncHistoryEntryToCloud,
        archiveHistory: archiveUserHistoryEntry,
        deleteHistory: deleteUserHistoryEntry,
        syncParcelToBackend: async (parcel) => {
          const resp = await fetch('/api/parcels', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: parcel.id,
              label: parcel.label,
              district: parcel.district,
              dico: parcel.dico,
              parish: parcel.parish,
              matrixArticle: parcel.matrixArticle,
              bupiRggId: parcel.bupiRggId,
              avgSlopePct: parcel.avgSlopePct,
              hasProtectedOaks: parcel.hasProtectedOaks,
              userNotes: parcel.userNotes ?? '',
              vertices: parcel.vertices,
              landClass: parcel.landClass,
              hasEredesLine: parcel.hasEredesLine,
            }),
          });
          if (!resp.ok) {
            throw new Error(`Falha HTTP ${resp.status} na sincronização do terreno.`);
          }
        },
        deleteParcelFromBackend: async (parcelId) => {
          const resp = await fetch(`/api/parcels/${encodeURIComponent(parcelId)}`, {
            method: 'DELETE',
          });
          if (!resp.ok && resp.status !== 404) {
            throw new Error(`Falha HTTP ${resp.status} ao remover terreno no servidor.`);
          }
        },
      },
    });
  }, []);

  const refreshOfflineMirror = useCallback(async () => {
    const hydrated = await syncCoordinator.hydrateState();
    setLocalHistory(hydrated.history);
    setOutboxOps(hydrated.outbox);
    setOfflineParcelsCount(hydrated.parcels.length);
    setStorageBackend(syncCoordinator.getStorageBackend());
    if (hydrated.parcels.length > 0 || hydrated.deletedParcelIds.length > 0) {
      setParcels((prev) =>
        mergeParcelsWithOffline(prev, hydrated.parcels, hydrated.deletedParcelIds)
      );
    }
    return hydrated;
  }, [syncCoordinator]);

  const flushPendingToFirestore = useCallback(
    async (explicitCloudUid?: string | null) => {
      const targetUid = explicitCloudUid !== undefined ? explicitCloudUid : cloudUidRef.current;
      setIsSyncing(true);
      try {
        const res = await syncCoordinator.flushOutbox(targetUid);
        if (res.lastSyncedAtIso) {
          setLastSyncedAtIso(res.lastSyncedAtIso);
        }
        if (res.errorMessage) {
          setHistorySyncError(res.errorMessage);
        } else if (!res.offlineSkipped) {
          setHistorySyncError(null);
        }
        await refreshOfflineMirror();
      } finally {
        setIsSyncing(false);
      }
    },
    [syncCoordinator, refreshOfflineMirror]
  );

  const recordParcelOfflineFirst = useCallback(
    async (parcelToSave: ParcelRecord, selectAfterSave = true) => {
      setParcels((prev) => {
        const exists = prev.some((p) => p.id === parcelToSave.id);
        if (exists) {
          return prev.map((p) => (p.id === parcelToSave.id ? parcelToSave : p));
        }
        return mergeParcelsWithOffline(prev, [parcelToSave]);
      });
      if (selectAfterSave) {
        setActiveParcelId(parcelToSave.id);
      }
      setIsSyncing(true);
      try {
        const { syncResult } = await syncCoordinator.recordParcel(
          parcelToSave,
          cloudUidRef.current
        );
        if (syncResult.lastSyncedAtIso) {
          setLastSyncedAtIso(syncResult.lastSyncedAtIso);
        }
        await refreshOfflineMirror();
      } finally {
        setIsSyncing(false);
      }
    },
    [syncCoordinator, refreshOfflineMirror]
  );

  const recordHistoryOfflineFirst = useCallback(
    async (params: {
      category: UserHistoryCategory;
      title: string;
      parcelId: string;
      parcelLabel: string;
      municipality: string;
      referenceCode: string;
      areaM2: number;
      pirLevel: PirLevel;
      soilMoisturePct: number;
      summary: string;
    }) => {
      const entry = buildLocalHistoryEntry({
        ...params,
        uid: activeUidRef.current || OFFLINE_LOCAL_UID,
      });
      setIsSyncing(true);
      try {
        const { syncResult } = await syncCoordinator.recordHistoryCreation(
          entry,
          cloudUidRef.current
        );
        if (syncResult.lastSyncedAtIso) {
          setLastSyncedAtIso(syncResult.lastSyncedAtIso);
        }
        await refreshOfflineMirror();
      } finally {
        setIsSyncing(false);
      }
    },
    [syncCoordinator, refreshOfflineMirror]
  );

  const displayedHistory = useMemo(
    () =>
      mergeHistoryWithOffline({
        remoteItems: remoteHistory,
        localItems: localHistory,
        outbox: outboxOps,
        activeUid: userProfile?.uid,
      }),
    [remoteHistory, localHistory, outboxOps, userProfile?.uid]
  );

  const effectivePendingSyncCount = useMemo(
    () => computeEffectivePendingSyncCount(outboxOps, isCloudSession),
    [outboxOps, isCloudSession]
  );

  const activeHistoryCount = useMemo(
    () => displayedHistory.filter((h) => h.status === 'ACTIVE').length,
    [displayedHistory]
  );

  const currentSoilMoisturePct = buildSevenDayPirSoilSeries(activeParcel, forecasts[0]).currentSoilMoisturePct;

  const pullRemoteBackendState = useCallback(async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    try {
      const r = await fetch('/api/state');
      if (!r.ok) return;
      const data = await r.json();
      if (!data) return;
      const offlineState = await syncCoordinator.hydrateState();
      if (Array.isArray(data.municipalities)) setMunicipalities(data.municipalities);
      if (Array.isArray(data.parcels) && data.parcels.length > 0) {
        setParcels(
          mergeParcelsWithOffline(
            data.parcels,
            offlineState.parcels,
            offlineState.deletedParcelIds
          )
        );
      }
      if (Array.isArray(data.certificates)) setCertificates(data.certificates);
      if (Array.isArray(data.providers)) setProviders(data.providers);
      if (Array.isArray(data.quotes)) setQuotes(data.quotes);

      const params = new URLSearchParams(window.location.search);
      const verifyCode = params.get('verify');
      if (verifyCode && Array.isArray(data.certificates)) {
        const { certificate: found } = findCertificateByScannedPayload(
          data.certificates,
          verifyCode
        );
        if (found) setVerifyingCert(found);
      }
    } catch {
      // Offline-resilient: silent fallback to IndexedDB / localStorage state
    }
  }, [syncCoordinator]);

  // Hydrate offline IndexedDB / localStorage parcels, history, outbox, and parcel documents immediately on boot
  useEffect(() => {
    void refreshOfflineMirror();
  }, [refreshOfflineMirror]);

  useEffect(() => {
    void docStorage.loadDocuments().then((docs) => {
      setParcelDocuments(docs);
    });
  }, [docStorage]);

  // Track standalone display-mode changes dynamically (e.g. when user installs PWA)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(display-mode: standalone)');
    const onChange = (e: MediaQueryListEvent) => setIsStandalonePwa(e.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  // Unconditional automatic offline <-> online synchronization (IndexedDB <-> API & Cloud Firestore)
  useEffect(() => {
    if (!isOnline) return;
    void (async () => {
      await flushPendingToFirestore(cloudUserProfile?.uid ?? null);
      await pullRemoteBackendState();
    })();
  }, [isOnline, cloudUserProfile?.uid, flushPendingToFirestore, pullRemoteBackendState]);

  useEffect(() => {
    const triggerAutoSync = () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      void (async () => {
        await flushPendingToFirestore(cloudUidRef.current);
        await pullRemoteBackendState();
      })();
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        triggerAutoSync();
      }
    };

    window.addEventListener('online', triggerAutoSync);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('online', triggerAutoSync);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [flushPendingToFirestore, pullRemoteBackendState]);

  // Background automatic retry loop while online if any pending sync operations remain
  useEffect(() => {
    if (!isOnline || effectivePendingSyncCount <= 0) return;
    const timer = window.setInterval(() => {
      void flushPendingToFirestore(cloudUidRef.current);
    }, 12_000);
    return () => window.clearInterval(timer);
  }, [isOnline, effectivePendingSyncCount, flushPendingToFirestore]);

  // Listen to Firebase Auth state and attach real-time Firestore listener only when authenticated
  useEffect(() => {
    let unsubscribeHistory: (() => void) | null = null;

    const unsubscribeAuth = onAuthStateChanged(auth, async (fbUser) => {
      if (unsubscribeHistory) {
        unsubscribeHistory();
        unsubscribeHistory = null;
      }

      if (!fbUser) {
        setCloudUserProfile(null);
        setRemoteHistory([]);
        setHistorySyncError(null);
        setAuthReady(true);
        return;
      }

      try {
        const hydrated = await ensureUserAnchorAndProfile(fbUser, activeParcel.dico);
        setCloudUserProfile(hydrated);
        setAuthReady(true);
        void flushPendingToFirestore(hydrated.uid);

        unsubscribeHistory = subscribeToUserHistory(
          hydrated.uid,
          (items) => {
            setRemoteHistory(items);
            setHistorySyncError(null);
            void syncCoordinator
              .cacheRemoteHistorySnapshot(items)
              .then(() => refreshOfflineMirror());
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
  }, [syncCoordinator, refreshOfflineMirror, flushPendingToFirestore]);

  // Sync dark mode and sunlight high-contrast classes on <html>
  useEffect(() => {
    const root = document.documentElement;
    const resolved = resolveDocumentThemeClasses({ darkMode, highContrastMode });
    for (const cls of resolved.activeClasses) {
      root.classList.add(cls);
    }
    for (const cls of resolved.inactiveClasses) {
      root.classList.remove(cls);
    }
    root.setAttribute('data-high-contrast', resolved.dataHighContrast);
  }, [darkMode, highContrastMode]);

  // Resolve pending ?parcel=<id> deep-link if the target parcel arrives asynchronously (API / IndexedDB)
  useEffect(() => {
    const pendingId = pendingDeepLinkParcelIdRef.current;
    if (!pendingId) return;
    const resolution = resolveDeepLinkParcelSelection(parcels, pendingId, activeParcelId);
    if (resolution.matched) {
      setActiveParcelId(resolution.selectedId);
      pendingDeepLinkParcelIdRef.current = null;
    }
  }, [parcels, activeParcelId]);

  // Support browser back/forward navigation across shared ?parcel=<id> URLs
  useEffect(() => {
    const onPopState = () => {
      const reqId = extractRequestedParcelId(window.location.search);
      if (!reqId) return;
      const resolution = resolveDeepLinkParcelSelection(parcels, reqId, activeParcelId);
      if (resolution.matched) {
        setActiveParcelId(resolution.selectedId);
      } else {
        pendingDeepLinkParcelIdRef.current = reqId;
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [parcels, activeParcelId]);

  useEffect(() => {
    return () => {
      if (shareResetTimerRef.current !== null) {
        window.clearTimeout(shareResetTimerRef.current);
      }
    };
  }, []);

  const handleShareActiveParcel = useCallback(async () => {
    if (typeof window === 'undefined') return;
    const shareUrl = buildParcelShareUrl(window.location.href, activeParcel.id);

    try {
      window.history.replaceState(null, '', shareUrl);
    } catch {
      // Ignore history security restrictions in constrained frames
    }

    await copyDeepLinkToClipboard(shareUrl);

    setShareToast({ parcelId: activeParcel.id, shareUrl });
    if (shareResetTimerRef.current !== null) {
      window.clearTimeout(shareResetTimerRef.current);
    }
    shareResetTimerRef.current = window.setTimeout(() => {
      setShareToast(null);
      shareResetTimerRef.current = null;
    }, 2800);
  }, [activeParcel.id]);

  // Initial hydration handled via pullRemoteBackendState on online boot

  // Fetch PIR 3-day semaphore and Active Fires whenever activeParcel changes or connection returns
  useEffect(() => {
    setForecasts(buildInitialForecasts(activeParcel.dico));
    const c = activeParcel.spatial.centroidWgs84;
    const radiusKm = userSettings.proximityAlertRadiusKm;

    if (!isOnline) {
      const localFires = FALLBACK_ACTIVE_FIRES.map((f) => ({
        ...f,
        distanceKm: haversineDistanceKm(c, { lat: f.lat, lon: f.lon }),
      }));
      setFires(localFires);
      setWithin15KmCount(localFires.filter((f) => f.distanceKm <= radiusKm).length);
      return;
    }

    fetch(`/api/pir/${encodeURIComponent(activeParcel.dico)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.forecasts?.length) {
          setForecasts(data.forecasts);
          setPirSource(data.source || 'IPMA RCM');
        }
      })
      .catch(() => {});

    fetch(`/api/fires/active?lat=${c.lat}&lon=${c.lon}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (Array.isArray(data?.incidents)) {
          setFires(data.incidents);
          const countWithinRadius = data.incidents.filter(
            (inc: ActiveFireIncident) => Number(inc.distanceKm) <= radiusKm
          ).length;
          setWithin15KmCount(countWithinRadius);
        }
      })
      .catch(() => {});
  }, [activeParcel.id, activeParcel.dico, isOnline, userSettings.proximityAlertRadiusKm]);

  const handleNavigate = (tab: NavTab, subMode?: string) => {
    if (tab === 'docs') {
      setActiveTab('user');
      setUserInitialSubTab('docs');
      setUserSubTabNonce((n) => n + 1);
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      return;
    }
    setActiveTab(tab);
    if (tab === 'user') {
      setUserInitialSubTab((subMode as UserSubTab | undefined) ?? 'gallery');
      setUserSubTabNonce((n) => n + 1);
    } else if (subMode) {
      setCertifySubMode(subMode);
    }
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  };

  const handleToggleFavoriteProvider = useCallback((providerId: string) => {
    setFavoriteProviderIds((prev) => {
      const next = toggleFavoriteProviderId(prev, providerId);
      saveFavoriteProviderIds(next);
      return next;
    });
  }, []);

  const handleUpdateUserSettings = useCallback((nextSettings: UserAppSettings) => {
    const clean = saveUserAppSettings(nextSettings);
    setUserSettings(clean);
  }, []);

  const handleDeleteParcel = useCallback(
    async (targetParcelId: string): Promise<{ ok: boolean; error?: string }> => {
      const check = removeParcelSafely(parcels, activeParcel.id, targetParcelId);
      if (!check.ok) {
        return { ok: false, error: check.error };
      }

      const removedParcel = parcels.find((p) => p.id === targetParcelId);
      setParcels(check.nextParcels);
      setActiveParcelId(check.nextActiveParcelId);

      await docStorage.deleteDocumentsByParcel(targetParcelId);
      setParcelDocuments(await docStorage.loadDocuments());

      setIsSyncing(true);
      try {
        const { syncResult } = await syncCoordinator.recordParcelDelete(
          targetParcelId,
          cloudUidRef.current
        );
        if (syncResult.lastSyncedAtIso) {
          setLastSyncedAtIso(syncResult.lastSyncedAtIso);
        }
        await refreshOfflineMirror();
      } finally {
        setIsSyncing(false);
      }

      if (removedParcel) {
        void recordHistoryOfflineFirst({
          category: 'PARCEL',
          title: `Propriedade removida: ${removedParcel.label}`,
          parcelId: removedParcel.id,
          parcelLabel: removedParcel.label,
          municipality: removedParcel.municipality,
          referenceCode: removedParcel.bupiRggId,
          areaM2: removedParcel.spatial.mandatoryCleanAreaM2,
          pirLevel: forecasts[0]?.pirLevel ?? 2,
          soilMoisturePct: currentSoilMoisturePct,
          summary: `Propriedade eliminada da carteira pelo utilizador (${removedParcel.matrixArticle}).`,
        });
      }

      return { ok: true };
    },
    [
      parcels,
      activeParcel.id,
      docStorage,
      syncCoordinator,
      refreshOfflineMirror,
      recordHistoryOfflineFirst,
      forecasts,
      currentSoilMoisturePct,
    ]
  );

  const handleSignInLocalCustom = useCallback(
    ({ displayName, nif }: { displayName: string; nif: string }) => {
      const profile = buildLocalSessionProfile({
        displayName,
        nif,
        preferredDico: activeParcel.dico,
      });
      saveLocalAuthSession(profile);
      setLocalSessionProfile(profile);
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    },
    [activeParcel.dico]
  );

  const handleSignInDemo = useCallback(() => {
    const demo = buildDefaultDemoProfile(activeParcel.dico);
    saveLocalAuthSession(demo);
    setLocalSessionProfile(demo);
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, [activeParcel.dico]);

  const handleSignOutAll = useCallback(async () => {
    clearLocalAuthSession();
    setLocalSessionProfile(null);
    setShowHistoryModal(false);
    if (cloudUserProfile) {
      await signOutCurrentUser();
    }
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, [cloudUserProfile]);

  const handlePublicVerifyCertificate = useCallback((cert: ComplianceCertificate) => {
    setVerifyingCert(cert);
    try {
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set('verify', cert.shortCode);
      window.history.replaceState({}, '', nextUrl.toString());
    } catch {
      // Ignore history replace errors in restricted sandboxes
    }
  }, []);

  const handleCloseVerifyModal = useCallback(() => {
    setVerifyingCert(null);
    try {
      const nextUrl = new URL(window.location.href);
      if (nextUrl.searchParams.has('verify')) {
        nextUrl.searchParams.delete('verify');
        window.history.replaceState({}, '', nextUrl.toString());
      }
    } catch {
      // Ignore history replace errors
    }
  }, []);

  // PRE-LOGIN GATEWAY: Standard Browser WebView Homepage vs Standalone WebApp Onboarding Splash
  if (!isAuthenticated) {
    return (
      <>
        {entryExperienceMode === 'WEBAPP_ONBOARDING' ? (
          <WebAppOnboardingSplash
            darkMode={darkMode}
            isOnline={isOnline}
            isFirebaseConfigured={isFirebaseConfigured}
            onToggleDarkMode={() => updateDarkMode((d) => !d)}
            onSignInGoogle={async () => {
              await signInWithGooglePopup();
            }}
            onSignInLocalCustom={handleSignInLocalCustom}
            onSignInDemo={handleSignInDemo}
            onSwitchToWebviewHomepage={() => setEntryModeOverride('webview')}
          />
        ) : (
          <PublicWebviewHomepage
            darkMode={darkMode}
            highContrastMode={highContrastMode}
            isOnline={isOnline}
            isFirebaseConfigured={isFirebaseConfigured}
            isInstallable={isInstallable}
            isInstalled={isInstalled}
            isIOS={isIOS}
            certificates={certificates}
            onVerifyCertificate={handlePublicVerifyCertificate}
            onToggleDarkMode={() => updateDarkMode((d) => !d)}
            onToggleHighContrast={() => updateHighContrastMode((hc) => !hc)}
            onSignInGoogle={async () => {
              await signInWithGooglePopup();
            }}
            onSignInLocalCustom={handleSignInLocalCustom}
            onSignInDemo={handleSignInDemo}
            onSwitchToWebAppOnboarding={() => setEntryModeOverride('webapp')}
            onInstallPwa={install}
            onOpenIosGuide={() => setShowIosInstallGuide(true)}
          />
        )}

        {/* Public SHA-256 QR Verification Modal remains accessible via ?verify= links & QR scanner */}
        <CertificateVerifyModal
          certificate={verifyingCert}
          onClose={handleCloseVerifyModal}
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
                2. Escolha <strong>Adicionar ao Ecrã Principal</strong> para abrir em modo WebApp autónomo no terreno.
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
      </>
    );
  }

  return (
    <div
      data-testid="authenticated-workspace"
      className="min-h-screen flex flex-col bg-[#F8FAFC] dark:bg-[#0B0F17] text-[#0F172A] dark:text-[#F8FAFC] pb-20 lg:pb-10"
    >
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
              onClick={() => handleNavigate('user')}
              className={`py-1 transition-colors whitespace-nowrap shrink-0 hover:text-slate-950 dark:hover:text-white ${
                activeTab === 'user'
                  ? 'text-[#14532D] dark:text-[#22C55E] font-semibold underline underline-offset-8 decoration-2'
                  : ''
              }`}
            >
              User
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
          <div className="flex items-center gap-2 w-full sm:w-auto min-w-0">
            <label htmlFor="workspace-parcel-select" className="text-xs font-semibold text-slate-600 dark:text-slate-400 whitespace-nowrap shrink-0">
              Terreno:
            </label>
            <select
              id="workspace-parcel-select"
              value={activeParcel.id}
              onChange={(e) => {
                const nextId = e.target.value;
                setActiveParcelId(nextId);
                if (typeof window !== 'undefined' && extractRequestedParcelId(window.location.search)) {
                  try {
                    window.history.replaceState(
                      null,
                      '',
                      buildParcelShareUrl(window.location.href, nextId)
                    );
                  } catch {
                    // Ignore history update errors
                  }
                }
              }}
              className="min-h-[42px] flex-1 sm:flex-initial sm:w-60 lg:w-72 min-w-0 px-3 py-1.5 rounded-xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-900 dark:text-white truncate"
            >
              {parcels.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({p.municipality})
                </option>
              ))}
            </select>
            <button
              type="button"
              id="workspace-parcel-share-btn"
              data-testid="share-parcel-button"
              onClick={() => void handleShareActiveParcel()}
              aria-label={`Share deep-link for ${activeParcel.label}`}
              title={`Copy deep-link URL for ${activeParcel.label}`}
              className={`min-h-[42px] min-w-[44px] px-3 py-1.5 rounded-xl border transition-colors inline-flex items-center justify-center shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#14532D] dark:focus-visible:ring-[#22C55E] ${
                shareToast?.parcelId === activeParcel.id
                  ? 'border-[#14532D] dark:border-[#22C55E] bg-[#14532D] dark:bg-[#22C55E] text-white dark:text-slate-950'
                  : 'border-slate-300 dark:border-[#263248] bg-white dark:bg-[#161E2E] text-[#14532D] dark:text-[#22C55E] hover:bg-[#14532D]/10 dark:hover:bg-[#22C55E]/15'
              }`}
            >
              <Share2 className="w-4 h-4 shrink-0" aria-hidden="true" />
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 w-full sm:w-auto">
            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 w-full sm:w-auto justify-end">
              {/* User Account & Consultable History Trigger */}
              <button
                type="button"
                onClick={() => setShowHistoryModal(true)}
                className={`min-h-[40px] px-2.5 sm:px-3 py-1.5 rounded-xl border text-xs font-semibold transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 tabular-nums ${
                  userProfile
                    ? 'border-[#14532D] dark:border-[#22C55E] bg-[#14532D]/10 dark:bg-[#22C55E]/15 text-[#14532D] dark:text-[#22C55E]'
                    : 'border-slate-300 dark:border-[#263248] bg-white dark:bg-[#161E2E] text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
              >
                <History className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">
                  {userProfile
                    ? `Histórico (${activeHistoryCount}) · ${userProfile.displayName.split(' ')[0]}${
                        effectivePendingSyncCount > 0 ? ` · ${effectivePendingSyncCount} pend.` : ''
                      }`
                    : activeHistoryCount > 0 || effectivePendingSyncCount > 0
                    ? `Histórico (${activeHistoryCount})${effectivePendingSyncCount > 0 ? ` · ${effectivePendingSyncCount} pend.` : ''}`
                    : 'Entrar / Histórico'}
                </span>
                <span className="sm:hidden">
                  {`Histórico (${activeHistoryCount})`}
                </span>
              </button>

              {/* PWA Install Button */}
              {!isInstalled && isInstallable && (
                <button
                  type="button"
                  onClick={install}
                  className="min-h-[40px] px-2.5 sm:px-3 py-1.5 rounded-xl border border-[#14532D] dark:border-[#22C55E] text-xs font-semibold text-[#14532D] dark:text-[#22C55E] bg-white dark:bg-[#161E2E] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  Instalar App
                </button>
              )}
              {!isInstalled && !isInstallable && isIOS && (
                <button
                  type="button"
                  onClick={() => setShowIosInstallGuide(true)}
                  className="min-h-[40px] px-2.5 sm:px-3 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-200 bg-white dark:bg-[#161E2E] whitespace-nowrap shrink-0"
                >
                  Instalar no iOS
                </button>
              )}

              {/* Solar Light / Dark Night Mode Switch */}
              <button
                type="button"
                onClick={() => updateDarkMode((d) => !d)}
                className="min-h-[40px] px-2.5 sm:px-3 py-1.5 rounded-xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                {darkMode ? (
                  <>
                    <Sun className="w-3.5 h-3.5 text-[#FACC15]" aria-hidden="true" />
                    <span className="hidden sm:inline">Modo Solar</span>
                    <span className="sm:hidden">Solar</span>
                  </>
                ) : (
                  <>
                    <Moon className="w-3.5 h-3.5 text-slate-600 dark:text-slate-300" aria-hidden="true" />
                    <span className="hidden sm:inline">Modo Noite</span>
                    <span className="sm:hidden">Noite</span>
                  </>
                )}
              </button>

              {/* Sign Out Button */}
              <button
                type="button"
                onClick={() => void handleSignOutAll()}
                aria-label="Terminar sessão"
                className="min-h-[40px] px-2.5 sm:px-3 py-1.5 rounded-xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <LogOut className="w-3.5 h-3.5 text-slate-600 dark:text-slate-300" aria-hidden="true" />
                <span className="hidden sm:inline">Terminar Sessão</span>
                <span className="sm:hidden">Sair</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Offline Mode Indicator with IndexedDB / Outbox Telemetry */}
      {!isOnline && (
        <div
          role="status"
          data-testid="offline-banner"
          className="bg-amber-500 text-slate-950 text-xs font-semibold px-4 py-2 text-center flex flex-wrap items-center justify-center gap-x-2 gap-y-1 tabular-nums"
        >
          <WifiOff className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>
            Modo Offline no Terreno ({storageBackend === 'indexeddb' ? 'IndexedDB' : 'localStorage'}) — {parcels.length} terrenos ({offlineParcelsCount} personalizados) · {effectivePendingSyncCount} operação(ões) em fila para sincronização automática assim que a rede regressar.
          </span>
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
              await recordHistoryOfflineFirst({
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
              void recordParcelOfflineFirst(created);
              void recordHistoryOfflineFirst({
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
              });
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
              void recordHistoryOfflineFirst({
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
              });
            }}
            onQuoteCreated={(lead) => {
              setQuotes((prev) => [lead, ...prev]);
              void recordHistoryOfflineFirst({
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
              });
            }}
            onNeighborComplaintCreated={(rec: NeighborComplaintRecord) => {
              void recordHistoryOfflineFirst({
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
              });
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
            favoriteProviderIds={favoriteProviderIds}
            onToggleFavoriteProvider={handleToggleFavoriteProvider}
            onSelectParcel={(id) => setActiveParcelId(id)}
            onInspectCertificate={(cert) => setVerifyingCert(cert)}
            onProviderRegistered={(prov) => setProviders((prev) => [prov, ...prev])}
            onQuoteUnlocked={(updated) =>
              setQuotes((prev) => prev.map((q) => (q.id === updated.id ? updated : q)))
            }
          />
        )}

        {activeTab === 'user' && userProfile && (
          <UserManagementView
            initialSubTab={userInitialSubTab}
            subTabRequestNonce={userSubTabNonce}
            profile={userProfile}
            isCloudSession={isCloudSession}
            isFirebaseConfigured={isFirebaseConfigured}
            isOnline={isOnline}
            darkMode={darkMode}
            parcels={parcels}
            activeParcel={activeParcel}
            municipalities={municipalities}
            providers={providers}
            favoriteProviderIds={favoriteProviderIds}
            parcelDocuments={parcelDocuments}
            userSettings={userSettings}
            certificates={certificates}
            historyItems={displayedHistory}
            pendingSyncCount={effectivePendingSyncCount}
            isSyncing={isSyncing}
            lastSyncedAtIso={lastSyncedAtIso}
            storageBackend={storageBackend}
            onToggleDarkMode={(nextDark) => updateDarkMode(nextDark)}
            onSelectParcel={(id) => setActiveParcelId(id)}
            onCreateParcel={async (created) => {
              await recordParcelOfflineFirst(created, true);
              void recordHistoryOfflineFirst({
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
              });
            }}
            onUpdateParcel={async (updated) => {
              await recordParcelOfflineFirst(updated, false);
              void recordHistoryOfflineFirst({
                category: 'PARCEL',
                title: `Propriedade atualizada: ${updated.label}`,
                parcelId: updated.id,
                parcelLabel: updated.label,
                municipality: updated.municipality,
                referenceCode: updated.bupiRggId,
                areaM2: updated.spatial.mandatoryCleanAreaM2,
                pirLevel: forecasts[0]?.pirLevel ?? 2,
                soilMoisturePct: currentSoilMoisturePct,
                summary: `Dados cadastrais atualizados · Área obrigatória ${updated.spatial.mandatoryCleanAreaM2.toFixed(0)} m² (${updated.matrixArticle}).`,
              });
            }}
            onDeleteParcel={handleDeleteParcel}
            onUploadParcelDocument={async (docRecord) => {
              await docStorage.saveDocument(docRecord);
              setParcelDocuments(await docStorage.loadDocuments());
            }}
            onDeleteParcelDocument={async (docId) => {
              await docStorage.deleteDocument(docId);
              setParcelDocuments(await docStorage.loadDocuments());
            }}
            onToggleFavoriteProvider={handleToggleFavoriteProvider}
            onUpdateProfile={async ({ displayName, email, nif, phone, preferredDico }) => {
              if (cloudUserProfile) {
                await updateUserContactProfile({
                  uid: cloudUserProfile.uid,
                  displayName,
                  preferredDico,
                  email,
                  nif,
                  phone,
                });
                setCloudUserProfile((prev) =>
                  prev ? { ...prev, displayName, email, nif, phone, preferredDico } : null
                );
              } else {
                const updatedLocal: UserAccountProfile = {
                  ...userProfile,
                  displayName,
                  email,
                  nif,
                  phone,
                  preferredDico,
                };
                saveLocalAuthSession(updatedLocal);
                setLocalSessionProfile(updatedLocal);
              }
            }}
            onUpdateSettings={handleUpdateUserSettings}
            onManualSync={async () => {
              await flushPendingToFirestore(cloudUserProfile?.uid ?? null);
            }}
            onSignInGoogle={async () => {
              await signInWithGooglePopup();
            }}
            onSignOut={handleSignOutAll}
            onInspectCertificate={(cert) => setVerifyingCert(cert)}
            onOpenHistoryModal={() => setShowHistoryModal(true)}
            onArchiveHistoryEntry={async (entryId) => {
              setIsSyncing(true);
              try {
                const { syncResult } = await syncCoordinator.recordHistoryArchive(
                  entryId,
                  cloudUserProfile?.uid ?? null
                );
                if (syncResult.lastSyncedAtIso) {
                  setLastSyncedAtIso(syncResult.lastSyncedAtIso);
                }
                await refreshOfflineMirror();
              } finally {
                setIsSyncing(false);
              }
            }}
            onDeleteHistoryEntry={async (entryId) => {
              setIsSyncing(true);
              try {
                const { syncResult } = await syncCoordinator.recordHistoryDelete(
                  entryId,
                  cloudUserProfile?.uid ?? null
                );
                if (syncResult.lastSyncedAtIso) {
                  setLastSyncedAtIso(syncResult.lastSyncedAtIso);
                }
                await refreshOfflineMirror();
              } finally {
                setIsSyncing(false);
              }
            }}
            onNavigateTab={handleNavigate}
          />
        )}
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

        <button
          type="button"
          onClick={() => handleNavigate('user')}
          className={`min-h-[48px] flex flex-col items-center justify-center transition-colors ${
            activeTab === 'user'
              ? 'text-[#14532D] dark:text-[#22C55E] font-bold'
              : 'text-slate-500 dark:text-slate-400'
          }`}
        >
          <UserIcon className="w-5 h-5" aria-hidden="true" />
          <span className="text-[10px] tracking-tight mt-0.5 whitespace-nowrap">User</span>
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
        isCloudSession={isCloudSession}
        historyItems={displayedHistory}
        activeParcel={activeParcel}
        todayForecast={forecasts[0]}
        currentSoilMoisturePct={currentSoilMoisturePct}
        syncError={historySyncError}
        isOnline={isOnline}
        pendingSyncCount={effectivePendingSyncCount}
        isSyncing={isSyncing}
        lastSyncedAtIso={lastSyncedAtIso}
        storageBackend={storageBackend}
        onManualSync={async () => {
          await flushPendingToFirestore(cloudUserProfile?.uid ?? null);
        }}
        onSignInGoogle={async () => {
          await signInWithGooglePopup();
        }}
        onSignOut={handleSignOutAll}
        onUpdateProfile={async ({ displayName, nif, phone }) => {
          if (!userProfile) return;
          if (cloudUserProfile) {
            await updateUserContactProfile({
              uid: cloudUserProfile.uid,
              displayName,
              preferredDico: activeParcel.dico,
              email: cloudUserProfile.email,
              nif,
              phone,
            });
            setCloudUserProfile((prev) =>
              prev ? { ...prev, displayName, nif, phone, preferredDico: activeParcel.dico } : null
            );
          } else {
            const updatedLocal: UserAccountProfile = {
              ...userProfile,
              displayName,
              nif,
              phone,
              preferredDico: activeParcel.dico,
            };
            saveLocalAuthSession(updatedLocal);
            setLocalSessionProfile(updatedLocal);
          }
        }}
        onCreateIntervention={async ({ title, summary, pirLevel, soilMoisturePct }: { title: string; summary: string; pirLevel: PirLevel; soilMoisturePct: number }) => {
          await recordHistoryOfflineFirst({
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
          setIsSyncing(true);
          try {
            const { syncResult } = await syncCoordinator.recordHistoryArchive(
              entryId,
              cloudUserProfile?.uid ?? null
            );
            if (syncResult.lastSyncedAtIso) {
              setLastSyncedAtIso(syncResult.lastSyncedAtIso);
            }
            await refreshOfflineMirror();
          } finally {
            setIsSyncing(false);
          }
        }}
        onDeleteEntry={async (entryId) => {
          setIsSyncing(true);
          try {
            const { syncResult } = await syncCoordinator.recordHistoryDelete(
              entryId,
              cloudUserProfile?.uid ?? null
            );
            if (syncResult.lastSyncedAtIso) {
              setLastSyncedAtIso(syncResult.lastSyncedAtIso);
            }
            await refreshOfflineMirror();
          } finally {
            setIsSyncing(false);
          }
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

      {/* Deep-Link Share 'Copied!' Toast Notification */}
      {shareToast && (
        <div
          role="status"
          aria-live="polite"
          data-testid="share-copied-toast"
          className="fixed bottom-20 lg:bottom-6 right-4 sm:right-6 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl bg-[#0F172A] dark:bg-[#161E2E] text-white border border-[#14532D] dark:border-[#22C55E] shadow-lg text-xs font-semibold"
        >
          <Check className="w-4 h-4 text-[#22C55E] shrink-0" aria-hidden="true" />
          <span>Copied!</span>
          <span aria-hidden="true" className="text-slate-400">
            ·
          </span>
          <span className="font-mono text-[11px] text-slate-300 max-w-[200px] sm:max-w-[260px] truncate">
            ?parcel={shareToast.parcelId}
          </span>
        </div>
      )}
    </div>
  );
}
