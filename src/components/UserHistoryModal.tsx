import React, { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  CheckCircle2,
  CloudOff,
  FileCheck2,
  FileWarning,
  History,
  LogIn,
  LogOut,
  MapPin,
  PlusCircle,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  UserCheck,
  Wrench,
  X,
} from 'lucide-react';
import type {
  DailyPirForecast,
  ParcelRecord,
  PirLevel,
  UserAccountProfile,
  UserHistoryCategory,
} from '../types/domain.ts';
import type { AnnotatedHistoryRecord } from '../lib/offlineStorage.ts';

interface UserHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  authReady: boolean;
  profile: UserAccountProfile | null;
  isCloudSession?: boolean;
  historyItems: AnnotatedHistoryRecord[];
  activeParcel: ParcelRecord;
  todayForecast?: DailyPirForecast;
  currentSoilMoisturePct: number;
  syncError: string | null;
  isOnline: boolean;
  pendingSyncCount: number;
  isSyncing: boolean;
  lastSyncedAtIso: string | null;
  storageBackend: 'indexeddb' | 'localstorage' | 'memory';
  onManualSync: () => Promise<void>;
  onSignInGoogle: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onUpdateProfile: (data: {
    displayName: string;
    nif: string;
    phone: string;
  }) => Promise<void>;
  onCreateIntervention: (data: {
    title: string;
    summary: string;
    pirLevel: PirLevel;
    soilMoisturePct: number;
  }) => Promise<void>;
  onArchiveEntry: (entryId: string) => Promise<void>;
  onDeleteEntry: (entryId: string) => Promise<void>;
}

const CATEGORY_LABELS: Record<UserHistoryCategory, string> = {
  INTERVENTION: 'Intervenção',
  CERTIFICATE: 'Certificado SHA-256',
  QUOTE: 'Orçamento',
  PARCEL: 'Terreno',
  NEIGHBOR: 'Vizinho',
};

const STORAGE_BACKEND_LABELS: Record<'indexeddb' | 'localstorage' | 'memory', string> = {
  indexeddb: 'IndexedDB',
  localstorage: 'localStorage',
  memory: 'Memória Local',
};

function CategoryIcon({ category }: { category: UserHistoryCategory }) {
  switch (category) {
    case 'CERTIFICATE':
      return <FileCheck2 className="w-4 h-4 text-[#16A34A] shrink-0" aria-hidden="true" />;
    case 'QUOTE':
      return <Send className="w-4 h-4 text-[#D97706] shrink-0" aria-hidden="true" />;
    case 'NEIGHBOR':
      return <FileWarning className="w-4 h-4 text-[#A855F7] shrink-0" aria-hidden="true" />;
    case 'PARCEL':
      return <MapPin className="w-4 h-4 text-[#0284C7] shrink-0" aria-hidden="true" />;
    default:
      return <Wrench className="w-4 h-4 text-[#14532D] dark:text-[#22C55E] shrink-0" aria-hidden="true" />;
  }
}

export const UserHistoryModal: React.FC<UserHistoryModalProps> = ({
  isOpen,
  onClose,
  authReady,
  profile,
  isCloudSession = false,
  historyItems,
  activeParcel,
  todayForecast,
  currentSoilMoisturePct,
  syncError,
  isOnline,
  pendingSyncCount,
  isSyncing,
  lastSyncedAtIso,
  storageBackend,
  onManualSync,
  onSignInGoogle,
  onSignOut,
  onUpdateProfile,
  onCreateIntervention,
  onArchiveEntry,
  onDeleteEntry,
}) => {
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Filter & search state
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | UserHistoryCategory>('ALL');
  const [searchTerm, setSearchTerm] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  // Manual intervention logger state
  const [showNewForm, setShowNewForm] = useState(false);
  const [intTitle, setIntTitle] = useState('');
  const [intSummary, setIntSummary] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [savingEntry, setSavingEntry] = useState(false);

  // Profile editor state
  const [showProfileEdit, setShowProfileEdit] = useState(false);
  const [editName, setEditName] = useState('');
  const [editNif, setEditNif] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);

  useEffect(() => {
    if (profile) {
      setEditName(profile.displayName);
      setEditNif(profile.nif);
      setEditPhone(profile.phone);
    }
  }, [profile]);

  const filteredHistory = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return historyItems.filter((item) => {
      if (!showArchived && item.status === 'ARCHIVED') return false;
      if (categoryFilter !== 'ALL' && item.category !== categoryFilter) return false;
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.parcelLabel.toLowerCase().includes(q) ||
        item.municipality.toLowerCase().includes(q) ||
        item.referenceCode.toLowerCase().includes(q) ||
        item.summary.toLowerCase().includes(q)
      );
    });
  }, [historyItems, showArchived, categoryFilter, searchTerm]);

  if (!isOpen) return null;

  const handleLoginClick = async () => {
    setAuthError(null);
    setSigningIn(true);
    try {
      await onSignInGoogle();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('popup-closed-by-user')) {
        setAuthError('A janela de autenticação Google foi fechada antes de concluir o acesso.');
      } else if (msg.includes('popup-blocked')) {
        setAuthError('O navegador bloqueou a janela de login. Permita popups para este endereço.');
      } else {
        setAuthError('Não foi possível concluir a autenticação Google. Tente novamente.');
      }
    } finally {
      setSigningIn(false);
    }
  };

  const handleSubmitIntervention = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const cleanTitle = intTitle.trim();
    const cleanSummary = intSummary.trim();

    if (cleanTitle.length < 2 || cleanTitle.length > 140) {
      setFormError('Indique um título entre 2 e 140 caracteres para a intervenção.');
      return;
    }
    if (cleanSummary.length < 2 || cleanSummary.length > 500) {
      setFormError('Descreva os trabalhos ou observações (entre 2 e 500 caracteres).');
      return;
    }

    setSavingEntry(true);
    try {
      await onCreateIntervention({
        title: cleanTitle,
        summary: cleanSummary,
        pirLevel: todayForecast?.pirLevel ?? 2,
        soilMoisturePct: currentSoilMoisturePct,
      });
      setIntTitle('');
      setIntSummary('');
      setShowNewForm(false);
    } catch {
      setFormError('Erro ao guardar registo localmente. Verifique o espaço disponível.');
    } finally {
      setSavingEntry(false);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editName.trim() || editName.trim().length > 100) return;
    setSavingProfile(true);
    try {
      await onUpdateProfile({
        displayName: editName.trim(),
        nif: editNif.replace(/\D/g, '').slice(0, 9),
        phone: editPhone.trim().slice(0, 24),
      });
      setProfileSaved(true);
      setTimeout(() => {
        setProfileSaved(false);
        setShowProfileEdit(false);
      }, 1500);
    } finally {
      setSavingProfile(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="user-history-dialog-title"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/65 backdrop-blur-xs p-0 sm:p-4"
    >
      <div className="w-full sm:max-w-3xl max-h-[92vh] rounded-t-2xl sm:rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] flex flex-col overflow-hidden shadow-2xl">
        {/* Top Modal Header */}
        <div className="px-5 py-4 border-b border-slate-200 dark:border-[#263248] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <History className="w-5 h-5 text-[#14532D] dark:text-[#22C55E] shrink-0" aria-hidden="true" />
            <h2
              id="user-history-dialog-title"
              className="text-base sm:text-lg font-bold text-slate-900 dark:text-white truncate"
            >
              Conta &amp; Histórico Consultável do Proprietário
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar janela de conta e histórico"
            className="min-h-[40px] min-w-[40px] rounded-xl border border-slate-200 dark:border-[#263248] inline-flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto space-y-5 flex-1">
          {/* Offline Storage & Firestore Sync Status Strip */}
          <div
            data-testid="offline-sync-status-bar"
            className="rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248] p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          >
            <div className="space-y-0.5 text-xs">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold text-slate-900 dark:text-white">
                {!isOnline ? (
                  <>
                    <CloudOff className="w-4 h-4 text-[#D97706] shrink-0" aria-hidden="true" />
                    <span>Modo Offline Ativo</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-[#16A34A] shrink-0" aria-hidden="true" />
                    <span>Ligação Online Ativa</span>
                  </>
                )}
                <span aria-hidden="true" className="text-slate-400">·</span>
                <span className="font-mono tabular-nums text-slate-600 dark:text-slate-300">
                  Motor local: {STORAGE_BACKEND_LABELS[storageBackend]}
                </span>
              </div>
              <p className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                {!isOnline
                  ? `${pendingSyncCount} operação(ões) guardada(s) em ${STORAGE_BACKEND_LABELS[storageBackend]} — sincronização Firestore retoma automaticamente ao recuperar rede.`
                  : isSyncing
                  ? 'A sincronizar fila local com Cloud Firestore...'
                  : pendingSyncCount > 0
                  ? profile
                    ? `${pendingSyncCount} registo(s) na fila de sincronização Cloud Firestore.`
                    : `${pendingSyncCount} registo(s) salvos localmente em ${STORAGE_BACKEND_LABELS[storageBackend]} · Inicie sessão Google para sincronizar na cloud.`
                  : lastSyncedAtIso
                  ? `Sincronizado com Firestore às ${lastSyncedAtIso.slice(11, 19)} UTC`
                  : 'Persistência local ativa com retoma automática para Firestore.'}
              </p>
            </div>

            {isOnline && profile && pendingSyncCount > 0 && (
              <button
                type="button"
                disabled={isSyncing}
                onClick={() => void onManualSync()}
                className="min-h-[40px] px-3.5 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] bg-white dark:bg-[#161E2E] text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} aria-hidden="true" />
                {isSyncing ? 'A sincronizar...' : 'Sincronizar Agora'}
              </button>
            )}
          </div>

          {!authReady ? (
            <div className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
              A verificar sessão segura...
            </div>
          ) : !profile ? (
            /* COMPACT GOOGLE CLOUD SYNC CARD (Signed-out users can still consult & log offline history below) */
            <div className="rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248] p-4 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="space-y-1">
                  <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#14532D] dark:text-[#22C55E]">
                    <ShieldCheck className="w-4 h-4" aria-hidden="true" />
                    <span>Sincronização Cloud Firestore &amp; Isolamento RGPD</span>
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                    Os seus terrenos e intervenções já ficam salvos localmente neste dispositivo ({STORAGE_BACKEND_LABELS[storageBackend]}). Inicie sessão Google para sincronizar automaticamente com o Cloud Firestore entre telemóvel, tablet e computador.
                  </p>
                </div>

                <button
                  type="button"
                  disabled={signingIn || !isOnline}
                  onClick={handleLoginClick}
                  className="min-h-[42px] px-4 py-2 rounded-xl bg-[#14532D] hover:bg-[#0F3F22] disabled:opacity-50 dark:bg-[#22C55E] dark:hover:bg-[#16A34A] text-white dark:text-slate-950 text-xs font-semibold transition-colors inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0"
                >
                  <LogIn className="w-4 h-4" aria-hidden="true" />
                  {!isOnline
                    ? 'Login Google requer rede'
                    : signingIn
                    ? 'A autenticar...'
                    : 'Entrar com Conta Google'}
                </button>
              </div>

              {authError && (
                <p role="alert" className="text-xs font-semibold text-[#DC2626]">
                  {authError}
                </p>
              )}
            </div>
          ) : (
            /* SIGNED-IN ACCOUNT BAR */
            <>
              <div className="rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-[#14532D] dark:bg-[#22C55E] text-white dark:text-slate-950 font-bold text-sm flex items-center justify-center shrink-0">
                    {profile.displayName.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-slate-900 dark:text-white truncate">
                        {profile.displayName}
                      </span>
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#16A34A]">
                        <UserCheck className="w-3.5 h-3.5" aria-hidden="true" />
                        {isCloudSession ? 'Sessão Cloud Google' : 'Sessão Local no Dispositivo'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 truncate tabular-nums">
                      {profile.email}
                      {profile.nif ? ` · NIF ${profile.nif}` : ''}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {!isCloudSession && isOnline && (
                    <button
                      type="button"
                      disabled={signingIn}
                      onClick={handleLoginClick}
                      className="min-h-[40px] px-3 py-1.5 rounded-xl bg-[#14532D] hover:bg-[#0F3F22] dark:bg-[#22C55E] dark:hover:bg-[#16A34A] text-white dark:text-slate-950 text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap"
                    >
                      <LogIn className="w-3.5 h-3.5" aria-hidden="true" />
                      {signingIn ? 'A ligar...' : 'Ligar Google Cloud'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowProfileEdit((v) => !v)}
                    className="min-h-[40px] px-3 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                  >
                    {showProfileEdit ? 'Fechar Dados' : 'Dados Fiscais / Contacto'}
                  </button>
                  <button
                    type="button"
                    onClick={onSignOut}
                    className="min-h-[40px] px-3 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
                    Terminar Sessão
                  </button>
                </div>
              </div>
              {authError && (
                <p role="alert" className="text-xs font-semibold text-[#DC2626]">
                  {authError}
                </p>
              )}

              {/* Optional Isolated PII Contact Editor */}
              {showProfileEdit && (
                <form
                  onSubmit={handleSaveProfile}
                  className="rounded-xl bg-white dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] p-4 space-y-3"
                >
                  <h3 className="text-xs font-bold text-slate-900 dark:text-white">
                    Dados Privados do Titular (Guardados em Subcoleção Isolada)
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label htmlFor="prof-name" className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                        Nome do Titular
                      </label>
                      <input
                        id="prof-name"
                        type="text"
                        maxLength={100}
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="w-full min-h-[40px] px-3 py-1.5 rounded-lg bg-slate-50 dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
                      />
                    </div>
                    <div>
                      <label htmlFor="prof-nif" className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                        NIF (Opcional, 9 dígitos)
                      </label>
                      <input
                        id="prof-nif"
                        type="text"
                        inputMode="numeric"
                        maxLength={9}
                        value={editNif}
                        onChange={(e) => setEditNif(e.target.value)}
                        placeholder="Ex.: 234819204"
                        className="w-full min-h-[40px] px-3 py-1.5 rounded-lg bg-slate-50 dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] text-xs font-mono tabular-nums text-slate-900 dark:text-white"
                      />
                    </div>
                    <div>
                      <label htmlFor="prof-phone" className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                        Telefone / WhatsApp
                      </label>
                      <input
                        id="prof-phone"
                        type="tel"
                        maxLength={24}
                        value={editPhone}
                        onChange={(e) => setEditPhone(e.target.value)}
                        placeholder="+351 910 000 000"
                        className="w-full min-h-[40px] px-3 py-1.5 rounded-lg bg-slate-50 dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] text-xs font-mono tabular-nums text-slate-900 dark:text-white"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={savingProfile || (isCloudSession && !isOnline)}
                      className="min-h-[40px] px-4 py-1.5 rounded-xl bg-[#14532D] disabled:opacity-50 text-white dark:bg-[#22C55E] dark:text-slate-950 text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap"
                    >
                      {profileSaved ? (
                        <>
                          <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                          Guardado
                        </>
                      ) : savingProfile ? (
                        'A guardar...'
                      ) : (
                        'Guardar Dados do Titular'
                      )}
                    </button>
                  </div>
                </form>
              )}
            </>
          )}

          {/* Action Toolbar: Search + New Intervention (Available Online & Offline) */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
              <label htmlFor="history-search-input" className="sr-only">
                Pesquisar no histórico pessoal
              </label>
              <input
                id="history-search-input"
                type="search"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Pesquisar por terreno, concelho, código SHA-256 ou nota..."
                className="w-full min-h-[42px] pl-9 pr-3 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
              />
            </div>
            <button
              type="button"
              onClick={() => setShowNewForm((v) => !v)}
              className="min-h-[42px] px-4 py-2 rounded-xl bg-[#14532D] hover:bg-[#0F3F22] dark:bg-[#22C55E] dark:hover:bg-[#16A34A] text-white dark:text-slate-950 text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <PlusCircle className="w-4 h-4" aria-hidden="true" />
              {showNewForm ? 'Cancelar Registo' : 'Registar Intervenção'}
            </button>
          </div>

          {/* Manual Field Intervention Form */}
          {showNewForm && (
            <form
              onSubmit={handleSubmitIntervention}
              className="rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] p-4 space-y-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-bold text-slate-900 dark:text-white">
                  Novo Registo Operacional em {activeParcel.label}
                </h3>
                <span className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                  RCM {todayForecast?.pirLevel ?? 2} · Solo {currentSoilMoisturePct.toFixed(1)}% · {activeParcel.spatial.mandatoryCleanAreaM2.toFixed(0)} m²
                </span>
              </div>

              <div>
                <label htmlFor="int-title-input" className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Título da Intervenção / Vistoria
                </label>
                <input
                  id="int-title-input"
                  type="text"
                  maxLength={140}
                  value={intTitle}
                  onChange={(e) => setIntTitle(e.target.value)}
                  placeholder="Ex.: Corte de mato com fio de nylon na Zona 2 (2–10 m)"
                  className="w-full min-h-[40px] px-3 py-1.5 rounded-lg bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
                />
              </div>

              <div>
                <label htmlFor="int-summary-input" className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Descrição Técnica &amp; Maquinaria Utilizada
                </label>
                <textarea
                  id="int-summary-input"
                  rows={2}
                  maxLength={500}
                  value={intSummary}
                  onChange={(e) => setIntSummary(e.target.value)}
                  placeholder="Ex.: Limpeza efetuada entre as 07h30 e as 10h30 com roçadora elétrica sem faísca; sobreiros preservados."
                  className="w-full p-2.5 rounded-lg bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
                />
              </div>

              {formError && (
                <p role="alert" className="text-xs font-semibold text-[#DC2626]">
                  {formError}
                </p>
              )}

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={savingEntry}
                  className="min-h-[40px] px-4 py-1.5 rounded-xl bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950 text-xs font-semibold whitespace-nowrap"
                >
                  {savingEntry ? 'A guardar...' : 'Guardar no Histórico'}
                </button>
              </div>
            </form>
          )}

          {/* Category Filter Strip */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filtrar histórico por categoria">
              {(
                [
                  ['ALL', 'Todos'],
                  ['INTERVENTION', 'Intervenções'],
                  ['CERTIFICATE', 'Certificados'],
                  ['QUOTE', 'Orçamentos'],
                  ['PARCEL', 'Terrenos'],
                  ['NEIGHBOR', 'Vizinho'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setCategoryFilter(key)}
                  className={`min-h-[36px] px-3 py-1 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                    categoryFilter === key
                      ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                      : 'bg-slate-100 dark:bg-[#0B0F17] text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400 cursor-pointer">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="rounded border-slate-300"
              />
              Mostrar arquivados
            </label>
          </div>

          {syncError && isOnline && (
            <p role="alert" className="text-xs font-semibold text-[#D97706]">
              {syncError}
            </p>
          )}

          {/* Timeline List */}
          {filteredHistory.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 dark:border-[#263248] p-8 text-center space-y-3">
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                Ainda não existem registos nesta vista do seu histórico.
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                Sempre que emitir um Auto SHA-256, pedir 3 orçamentos, desenhar um terreno ou guardar uma avaliação meteorológica (mesmo sem rede), o registo fica imediatamente consultável aqui.
              </p>
              <button
                type="button"
                onClick={() => setShowNewForm(true)}
                className="min-h-[40px] px-4 py-2 rounded-xl bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950 text-xs font-semibold whitespace-nowrap"
              >
                Registar Primeira Intervenção
              </button>
            </div>
          ) : (
            <div className="divide-y divide-slate-200 dark:divide-[#263248] border border-slate-200 dark:border-[#263248] rounded-xl overflow-hidden">
              {filteredHistory.map((item) => (
                <div
                  key={item.id}
                  className={`p-4 bg-white dark:bg-[#161E2E] flex flex-col sm:flex-row sm:items-start justify-between gap-3 ${
                    item.status === 'ARCHIVED' ? 'opacity-60' : ''
                  }`}
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="mt-0.5">
                      <CategoryIcon category={item.category} />
                    </div>
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-xs font-bold text-slate-900 dark:text-white">
                          {item.title}
                        </span>
                        <span aria-hidden="true" className="text-xs text-slate-400">·</span>
                        <span className="text-[11px] font-mono tabular-nums text-slate-600 dark:text-slate-300">
                          {CATEGORY_LABELS[item.category]} / {item.referenceCode}
                        </span>
                      </div>
                      <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                        {item.summary}
                      </p>
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                        <span>{item.createdAtIso.slice(0, 16).replace('T', ' ')}</span>
                        <span aria-hidden="true">·</span>
                        <span>{item.parcelLabel} ({item.municipality})</span>
                        <span aria-hidden="true">·</span>
                        <span>{item.areaM2.toFixed(0)} m²</span>
                        <span aria-hidden="true">·</span>
                        <span>RCM {item.pirLevel}</span>
                        <span aria-hidden="true">·</span>
                        <span>Solo {item.soilMoisturePct.toFixed(1)}%</span>
                        <span aria-hidden="true">·</span>
                        <span
                          className={
                            item.syncStatus === 'PENDING'
                              ? 'text-[#D97706] dark:text-[#FBBF24] font-semibold'
                              : 'text-[#16A34A] dark:text-[#22C55E]'
                          }
                        >
                          {item.syncStatus === 'PENDING' ? 'Pendente offline' : 'Sincronizado'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-start">
                    {item.status === 'ACTIVE' && (
                      <button
                        type="button"
                        onClick={() => void onArchiveEntry(item.id)}
                        aria-label={`Arquivar registo ${item.title}`}
                        title="Arquivar registo"
                        className="min-h-[40px] min-w-[40px] rounded-lg border border-slate-200 dark:border-[#263248] inline-flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                      >
                        <Archive className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void onDeleteEntry(item.id)}
                      aria-label={`Eliminar registo ${item.title}`}
                      title="Eliminar registo"
                      className="min-h-[40px] min-w-[40px] rounded-lg border border-slate-200 dark:border-[#263248] inline-flex items-center justify-center text-[#DC2626] hover:bg-red-50 dark:hover:bg-red-950/30"
                    >
                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
