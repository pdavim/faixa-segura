import React, { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  BookOpen,
  CheckCircle2,
  Download,
  Edit3,
  FileCheck2,
  FileText,
  FolderOpen,
  History,
  LogOut,
  MapPin,
  Moon,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  Settings,
  Star,
  Sun,
  Trash2,
  Upload,
  User as UserIcon,
} from 'lucide-react';
import type {
  ComplianceCertificate,
  ForestryProvider,
  LandClass,
  MunicipalityInfo,
  ParcelDocumentCategory,
  ParcelDocumentRecord,
  ParcelRecord,
  UserAccountProfile,
  UserAppSettings,
} from '../types/domain.ts';
import type { AnnotatedHistoryRecord } from '../lib/offlineStorage.ts';
import { generateComplianceCertificatePdf } from '../lib/pdfTemplates.ts';
import { buildLocalParcelRecord, extractCadernetaOffline } from '../lib/offlineParcelBuilder.ts';
import {
  DEFAULT_USER_APP_SETTINGS,
  PARCEL_DOCUMENT_CATEGORY_LABELS,
  applyParcelUpdate,
  buildDefaultRectangleAroundCenter,
  buildParcelDocumentRecord,
  filterDocumentsForParcel,
  formatFileSizePt,
  formatVerticesMultiline,
  parseVerticesMultiline,
  validateDocumentUploadInput,
  validateParcelMutationInput,
} from '../lib/userWorkspaceStore.ts';

import { DocsArchitectureView } from './DocsArchitectureView.tsx';

export type UserSubTab = 'properties' | 'favorites' | 'settings' | 'history' | 'docs';

interface UserManagementViewProps {
  initialSubTab?: UserSubTab;
  subTabRequestNonce?: number;
  profile: UserAccountProfile;
  isCloudSession: boolean;
  isFirebaseConfigured: boolean;
  isOnline: boolean;
  darkMode: boolean;
  parcels: ParcelRecord[];
  activeParcel: ParcelRecord;
  municipalities: MunicipalityInfo[];
  providers: ForestryProvider[];
  favoriteProviderIds: string[];
  parcelDocuments: ParcelDocumentRecord[];
  userSettings: UserAppSettings;
  certificates: ComplianceCertificate[];
  historyItems: AnnotatedHistoryRecord[];
  pendingSyncCount: number;
  isSyncing: boolean;
  lastSyncedAtIso: string | null;
  storageBackend: 'indexeddb' | 'localstorage' | 'memory';
  onToggleDarkMode: (nextDark: boolean) => void;
  onSelectParcel: (parcelId: string) => void;
  onCreateParcel: (created: ParcelRecord) => Promise<void> | void;
  onUpdateParcel: (updated: ParcelRecord) => Promise<void> | void;
  onDeleteParcel: (parcelId: string) => Promise<{ ok: boolean; error?: string }>;
  onUploadParcelDocument: (doc: ParcelDocumentRecord) => Promise<void> | void;
  onDeleteParcelDocument: (docId: string) => Promise<void> | void;
  onToggleFavoriteProvider: (providerId: string) => void;
  onUpdateProfile: (params: {
    displayName: string;
    email: string;
    nif: string;
    phone: string;
    preferredDico: string;
  }) => Promise<void>;
  onUpdateSettings: (nextSettings: UserAppSettings) => void;
  onManualSync: () => Promise<void>;
  onSignInGoogle: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onInspectCertificate: (cert: ComplianceCertificate) => void;
  onOpenHistoryModal: () => void;
  onArchiveHistoryEntry: (entryId: string) => Promise<void>;
  onDeleteHistoryEntry: (entryId: string) => Promise<void>;
  onNavigateTab: (
    tab: 'today' | 'map' | 'certify' | 'providers' | 'docs' | 'user',
    subMode?: string
  ) => void;
}

const LAND_CLASS_LABELS: Record<LandClass, string> = {
  FOREST_SCRUB: 'Florestal / Mato Contínuo',
  AGRICULTURE: 'Agrícola / Pomar / Olival',
  URBAN_BUILT: 'Urbano Consolidado / Jardim',
};

export const UserManagementView: React.FC<UserManagementViewProps> = ({
  initialSubTab = 'properties',
  subTabRequestNonce = 0,
  profile,
  isCloudSession,
  isFirebaseConfigured,
  isOnline,
  darkMode,
  parcels,
  activeParcel,
  municipalities,
  providers,
  favoriteProviderIds,
  parcelDocuments,
  userSettings,
  certificates,
  historyItems,
  pendingSyncCount,
  isSyncing,
  lastSyncedAtIso,
  storageBackend,
  onToggleDarkMode,
  onSelectParcel,
  onCreateParcel,
  onUpdateParcel,
  onDeleteParcel,
  onUploadParcelDocument,
  onDeleteParcelDocument,
  onToggleFavoriteProvider,
  onUpdateProfile,
  onUpdateSettings,
  onManualSync,
  onSignInGoogle,
  onSignOut,
  onInspectCertificate,
  onOpenHistoryModal,
  onArchiveHistoryEntry,
  onDeleteHistoryEntry,
  onNavigateTab,
}) => {
  const [subTab, setSubTab] = useState<UserSubTab>(initialSubTab);

  useEffect(() => {
    if (subTabRequestNonce > 0) {
      setSubTab(initialSubTab);
    }
  }, [initialSubTab, subTabRequestNonce]);

  // ==================== 1. PROPERTY CRUD & PER-PARCEL DOCUMENTS STATE ====================
  const [parcelSearch, setParcelSearch] = useState('');
  const [showAddParcelForm, setShowAddParcelForm] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newDico, setNewDico] = useState(profile.preferredDico || activeParcel.dico || '1111');
  const [newParish, setNewParish] = useState('');
  const [newMatrixArticle, setNewMatrixArticle] = useState('');
  const [newBupiRggId, setNewBupiRggId] = useState('');
  const [newLandClass, setNewLandClass] = useState<LandClass>('FOREST_SCRUB');
  const [newAvgSlope, setNewAvgSlope] = useState<number>(12);
  const [newHasEredes, setNewHasEredes] = useState(false);
  const [newHasOaks, setNewHasOaks] = useState(false);
  const [newCadernetaRaw, setNewCadernetaRaw] = useState('');
  const [newVerticesRaw, setNewVerticesRaw] = useState('');
  const [addParcelError, setAddParcelError] = useState<string | null>(null);
  const [parcelFeedback, setParcelFeedback] = useState<string | null>(null);

  // Inline Edit Parcel State
  const [editingParcelId, setEditingParcelId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editDico, setEditDico] = useState('1111');
  const [editParish, setEditParish] = useState('');
  const [editMatrix, setEditMatrix] = useState('');
  const [editBupi, setEditBupi] = useState('');
  const [editLandClass, setEditLandClass] = useState<LandClass>('FOREST_SCRUB');
  const [editSlope, setEditSlope] = useState<number>(12);
  const [editHasEredes, setEditHasEredes] = useState(false);
  const [editHasOaks, setEditHasOaks] = useState(false);
  const [editVerticesRaw, setEditVerticesRaw] = useState('');
  const [showEditVertices, setShowEditVertices] = useState(false);
  const [editParcelError, setEditParcelError] = useState<string | null>(null);

  // Inline Delete Confirmation State
  const [confirmDeleteParcelId, setConfirmDeleteParcelId] = useState<string | null>(null);
  const [deleteParcelError, setDeleteParcelError] = useState<string | null>(null);

  // Per-Parcel Document Upload State
  const [uploadOpenParcelId, setUploadOpenParcelId] = useState<string | null>(null);
  const [docCategory, setDocCategory] = useState<ParcelDocumentCategory>('CADERNETA_PREDIAL');
  const [docNotes, setDocNotes] = useState('');
  const [docUploadError, setDocUploadError] = useState<string | null>(null);
  const [uploadingParcelId, setUploadingParcelId] = useState<string | null>(null);

  // ==================== 2. FAVORITE PROVIDERS STATE ====================
  const [providerSearch, setProviderSearch] = useState('');

  // ==================== 3. USER PROFILE & SETTINGS STATE ====================
  const [profName, setProfName] = useState(profile.displayName);
  const [profEmail, setProfEmail] = useState(profile.email);
  const [profNif, setProfNif] = useState(profile.nif);
  const [profPhone, setProfPhone] = useState(profile.phone);
  const [profDico, setProfDico] = useState(profile.preferredDico || activeParcel.dico || '1111');
  const [profSaving, setProfSaving] = useState(false);
  const [profError, setProfError] = useState<string | null>(null);
  const [profSavedMsg, setProfSavedMsg] = useState<string | null>(null);
  const [cloudSignInError, setCloudSignInError] = useState<string | null>(null);

  // ==================== 4. HISTORY FILTER STATE ====================
  const [historyQuery, setHistoryQuery] = useState('');

  const filteredParcels = useMemo(() => {
    const q = parcelSearch.trim().toLowerCase();
    if (!q) return parcels;
    return parcels.filter(
      (p) =>
        p.label.toLowerCase().includes(q) ||
        p.municipality.toLowerCase().includes(q) ||
        p.parish.toLowerCase().includes(q) ||
        p.bupiRggId.toLowerCase().includes(q) ||
        p.matrixArticle.toLowerCase().includes(q)
    );
  }, [parcels, parcelSearch]);

  const favoriteProviders = useMemo(
    () => providers.filter((p) => favoriteProviderIds.includes(p.id)),
    [providers, favoriteProviderIds]
  );

  const filteredCatalogProviders = useMemo(() => {
    const q = providerSearch.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter(
      (p) =>
        p.companyName.toLowerCase().includes(q) ||
        p.nif.includes(q) ||
        p.coveredMunicipalities.some((m) => m.toLowerCase().includes(q))
    );
  }, [providers, providerSearch]);

  const filteredHistory = useMemo(() => {
    const q = historyQuery.trim().toLowerCase();
    if (!q) return historyItems;
    return historyItems.filter(
      (h) =>
        h.title.toLowerCase().includes(q) ||
        h.parcelLabel.toLowerCase().includes(q) ||
        h.referenceCode.toLowerCase().includes(q) ||
        h.municipality.toLowerCase().includes(q)
    );
  }, [historyItems, historyQuery]);

  const handleExtractCadernetaIntoNewForm = () => {
    if (!newCadernetaRaw.trim()) {
      setAddParcelError('Cole um excerto da Caderneta Predial para preencher automaticamente os campos.');
      return;
    }
    const extracted = extractCadernetaOffline(newCadernetaRaw, municipalities);
    setNewLabel(extracted.suggestedLabel);
    setNewDico(extracted.dico);
    setNewMatrixArticle(extracted.matrixArticle);
    setNewHasOaks(extracted.hasProtectedOaks);
    setNewVerticesRaw(formatVerticesMultiline(extracted.vertices));
    setAddParcelError(null);
  };

  const handleSubmitNewParcel = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddParcelError(null);
    setParcelFeedback(null);

    const validation = validateParcelMutationInput({
      label: newLabel,
      avgSlopePct: newAvgSlope,
    });
    if (!validation.valid) {
      setAddParcelError(validation.error || 'Dados inválidos.');
      return;
    }

    const muni = municipalities.find((m) => m.dico === newDico) ?? municipalities[0];
    let vertices = buildDefaultRectangleAroundCenter(muni.defaultCenter);
    if (newVerticesRaw.trim()) {
      const parsed = parseVerticesMultiline(newVerticesRaw);
      if (!parsed.valid) {
        setAddParcelError(parsed.error || 'Coordenadas inválidas.');
        return;
      }
      vertices = parsed.vertices;
    }

    const created = buildLocalParcelRecord({
      label: newLabel.trim(),
      dico: muni.dico,
      parish: newParish.trim() || muni.name,
      matrixArticle: newMatrixArticle.trim() || 'Rústico — Art.º 204, Secção D',
      bupiRggId: newBupiRggId.trim() || undefined,
      landClass: newLandClass,
      avgSlopePct: newAvgSlope,
      hasEredesLine: newHasEredes,
      hasProtectedOaks: newHasOaks,
      vertices,
      municipalities,
    });

    await onCreateParcel(created);
    setNewLabel('');
    setNewParish('');
    setNewMatrixArticle('');
    setNewBupiRggId('');
    setNewCadernetaRaw('');
    setNewVerticesRaw('');
    setShowAddParcelForm(false);
    setParcelFeedback(`Propriedade "${created.label}" adicionada com sucesso (${created.spatial.mandatoryCleanAreaM2.toFixed(0)} m² exigíveis).`);
  };

  const startEditingParcel = (p: ParcelRecord) => {
    setEditingParcelId(p.id);
    setConfirmDeleteParcelId(null);
    setDeleteParcelError(null);
    setEditParcelError(null);
    setEditLabel(p.label);
    setEditDico(p.dico);
    setEditParish(p.parish);
    setEditMatrix(p.matrixArticle);
    setEditBupi(p.bupiRggId);
    setEditLandClass(p.landClass);
    setEditSlope(p.avgSlopePct);
    setEditHasEredes(p.hasEredesLine);
    setEditHasOaks(p.hasProtectedOaks);
    setEditVerticesRaw(formatVerticesMultiline(p.vertices));
    setShowEditVertices(false);
  };

  const handleSaveEditedParcel = async (e: React.FormEvent, existing: ParcelRecord) => {
    e.preventDefault();
    setEditParcelError(null);
    setParcelFeedback(null);

    const validation = validateParcelMutationInput({
      label: editLabel,
      avgSlopePct: editSlope,
    });
    if (!validation.valid) {
      setEditParcelError(validation.error || 'Verifique os campos da propriedade.');
      return;
    }

    let nextVertices = existing.vertices;
    let recenterOnMuniChange = true;
    if (showEditVertices && editVerticesRaw.trim()) {
      const parsed = parseVerticesMultiline(editVerticesRaw);
      if (!parsed.valid) {
        setEditParcelError(parsed.error || 'Vértices geográficos inválidos.');
        return;
      }
      nextVertices = parsed.vertices;
      recenterOnMuniChange = false;
    }

    const updated = applyParcelUpdate(
      existing,
      {
        label: editLabel,
        dico: editDico,
        parish: editParish,
        matrixArticle: editMatrix,
        bupiRggId: editBupi,
        landClass: editLandClass,
        avgSlopePct: editSlope,
        hasEredesLine: editHasEredes,
        hasProtectedOaks: editHasOaks,
        vertices: showEditVertices ? nextVertices : undefined,
        recenterVerticesOnMunicipalityChange: recenterOnMuniChange,
      },
      municipalities
    );

    await onUpdateParcel(updated);
    setEditingParcelId(null);
    setParcelFeedback(
      `Propriedade "${updated.label}" atualizada · Faixa obrigatória recalculada: ${updated.spatial.mandatoryCleanAreaM2.toFixed(0)} m².`
    );
  };

  const handleConfirmDeleteParcel = async (parcel: ParcelRecord) => {
    setDeleteParcelError(null);
    setParcelFeedback(null);
    const res = await onDeleteParcel(parcel.id);
    if (!res.ok) {
      setDeleteParcelError(res.error || 'Não foi possível eliminar este terreno.');
      return;
    }
    setConfirmDeleteParcelId(null);
    if (editingParcelId === parcel.id) setEditingParcelId(null);
    if (uploadOpenParcelId === parcel.id) setUploadOpenParcelId(null);
    setParcelFeedback(`Propriedade "${parcel.label}" eliminada da sua carteira.`);
  };

  const handleFileChangeForParcel = async (
    parcel: ParcelRecord,
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setDocUploadError(null);
    const check = validateDocumentUploadInput({
      parcelId: parcel.id,
      fileName: file.name,
      sizeBytes: file.size,
    });
    if (!check.valid) {
      setDocUploadError(check.error || 'Ficheiro inválido.');
      return;
    }

    setUploadingParcelId(parcel.id);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(new Error('Falha ao ler ficheiro local.'));
        reader.readAsDataURL(file);
      });

      const record = buildParcelDocumentRecord({
        parcelId: parcel.id,
        fileName: file.name,
        category: docCategory,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        notes: docNotes,
        dataUrl,
      });

      await onUploadParcelDocument(record);
      setDocNotes('');
      setParcelFeedback(`Documento "${record.fileName}" associado a "${parcel.label}".`);
    } catch {
      setDocUploadError('Não foi possível ler o ficheiro selecionado no dispositivo.');
    } finally {
      setUploadingParcelId(null);
    }
  };

  const handleDownloadParcelDoc = (docRecord: ParcelDocumentRecord) => {
    const href =
      docRecord.dataUrl ||
      `data:text/plain;charset=utf-8,${encodeURIComponent(
        `Documento: ${docRecord.fileName}\nCategoria: ${PARCEL_DOCUMENT_CATEGORY_LABELS[docRecord.category]}\nRegistado em: ${docRecord.uploadedAtIso}\nNotas: ${docRecord.notes || 'Sem notas'}`
      )}`;
    const a = document.createElement('a');
    a.href = href;
    a.download = docRecord.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleDownloadCertificatePdf = async (cert: ComplianceCertificate) => {
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

  const handleSaveUserProfileForm = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfError(null);
    setProfSavedMsg(null);

    const trimmedName = profName.trim();
    if (trimmedName.length < 2) {
      setProfError('Indique o nome completo do titular (mínimo 2 caracteres).');
      return;
    }
    const digitsNif = profNif.replace(/\D/g, '');
    if (digitsNif.length > 0 && digitsNif.length !== 9) {
      setProfError('O NIF deve ter exatamente 9 dígitos numéricos (ou ficar em branco).');
      return;
    }

    setProfSaving(true);
    try {
      await onUpdateProfile({
        displayName: trimmedName,
        email: profEmail.trim() || profile.email,
        nif: digitsNif,
        phone: profPhone.trim(),
        preferredDico: profDico,
      });
      setProfSavedMsg('Informações do utilizador guardadas com sucesso.');
    } catch {
      setProfError('Erro ao guardar os dados do perfil. Tente novamente.');
    } finally {
      setProfSaving(false);
    }
  };

  return (
    <div data-testid="user-management-view" className="space-y-6">
      {/* Workspace Header & Segmented Sub-Navigation */}
      <section className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              <span>{isCloudSession ? 'Conta Google Cloud Sincronizada' : 'Sessão Local no Dispositivo'}</span>
              <span aria-hidden="true"> · </span>
              <span>{parcels.length} propriedades</span>
              <span aria-hidden="true"> · </span>
              <span>{parcelDocuments.length} documentos carregados</span>
              <span aria-hidden="true"> · </span>
              <span>{favoriteProviders.length} prestadores favoritos</span>
            </div>
            <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white tracking-tight">
              Área do Utilizador · {profile.displayName}
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onNavigateTab('certify', 'certificate')}
              className="min-h-[42px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <FileCheck2 className="w-3.5 h-3.5 text-[#14532D] dark:text-[#22C55E]" aria-hidden="true" />
              Emitir Auto SHA-256
            </button>
            <button
              type="button"
              onClick={() => onNavigateTab('map')}
              className="min-h-[42px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <MapPin className="w-3.5 h-3.5 text-[#14532D] dark:text-[#22C55E]" aria-hidden="true" />
              Ver Terreno no Mapa
            </button>
          </div>
        </div>

        <div
          role="tablist"
          aria-label="Secções da Área do Utilizador"
          className="grid grid-cols-2 sm:grid-cols-3 lg:flex items-center gap-1.5 p-1.5 rounded-xl bg-slate-100 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248]"
        >
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'properties'}
            onClick={() => setSubTab('properties')}
            className={`min-h-[42px] px-3 py-2 rounded-lg border text-xs font-semibold transition-colors whitespace-nowrap shrink-0 inline-flex items-center justify-center lg:justify-start gap-1.5 tabular-nums ${
              subTab === 'properties'
                ? 'border-[#14532D] dark:border-[#22C55E] bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                : 'border-transparent bg-transparent text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white'
            }`}
          >
            <MapPin className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">Terrenos & Documentos ({parcels.length})</span>
            <span className="sm:hidden">Terrenos ({parcels.length})</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'favorites'}
            onClick={() => setSubTab('favorites')}
            className={`min-h-[42px] px-3 py-2 rounded-lg border text-xs font-semibold transition-colors whitespace-nowrap shrink-0 inline-flex items-center justify-center lg:justify-start gap-1.5 tabular-nums ${
              subTab === 'favorites'
                ? 'border-[#14532D] dark:border-[#22C55E] bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                : 'border-transparent bg-transparent text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white'
            }`}
          >
            <Star className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">Prestadores Favoritos ({favoriteProviders.length})</span>
            <span className="sm:hidden">Favoritos ({favoriteProviders.length})</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'settings'}
            onClick={() => setSubTab('settings')}
            className={`min-h-[42px] px-3 py-2 rounded-lg border text-xs font-semibold transition-colors whitespace-nowrap shrink-0 inline-flex items-center justify-center lg:justify-start gap-1.5 ${
              subTab === 'settings'
                ? 'border-[#14532D] dark:border-[#22C55E] bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                : 'border-transparent bg-transparent text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white'
            }`}
          >
            <Settings className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">Perfil & Configurações</span>
            <span className="sm:hidden">Configurações</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'history'}
            onClick={() => setSubTab('history')}
            className={`min-h-[42px] px-3 py-2 rounded-lg border text-xs font-semibold transition-colors whitespace-nowrap shrink-0 inline-flex items-center justify-center lg:justify-start gap-1.5 tabular-nums ${
              subTab === 'history'
                ? 'border-[#14532D] dark:border-[#22C55E] bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                : 'border-transparent bg-transparent text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white'
            }`}
          >
            <History className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">Histórico & Autos ({historyItems.length})</span>
            <span className="sm:hidden">Histórico ({historyItems.length})</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'docs'}
            onClick={() => setSubTab('docs')}
            className={`col-span-2 sm:col-span-1 min-h-[42px] px-3 py-2 rounded-lg border text-xs font-semibold transition-colors whitespace-nowrap shrink-0 inline-flex items-center justify-center lg:justify-start gap-1.5 ${
              subTab === 'docs'
                ? 'border-[#14532D] dark:border-[#22C55E] bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                : 'border-transparent bg-transparent text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white'
            }`}
          >
            <BookOpen className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Documentação</span>
          </button>
        </div>
      </section>

      {/* ==================== TAB 1: GESTÃO DE TERRENOS & DOCUMENTOS UPLOADED ==================== */}
      {subTab === 'properties' && (
        <div className="space-y-5">
          {/* Toolbar: Search + Add Property */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="relative flex-1 max-w-md">
              <label htmlFor="user-parcel-search" className="sr-only">
                Pesquisar terrenos por nome, concelho ou código BUPi
              </label>
              <Search
                className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                id="user-parcel-search"
                type="search"
                value={parcelSearch}
                onChange={(e) => setParcelSearch(e.target.value)}
                placeholder="Filtrar terrenos por nome, concelho, artigo ou BUPi..."
                className="w-full min-h-[44px] pl-9 pr-3.5 py-2 rounded-xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onNavigateTab('map')}
                className="min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 dark:border-[#263248] bg-white dark:bg-[#161E2E] text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                Desenhar Polígono no Mapa
              </button>
              <button
                type="button"
                aria-expanded={showAddParcelForm}
                onClick={() => {
                  setShowAddParcelForm((prev) => !prev);
                  setAddParcelError(null);
                }}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-[#14532D] hover:bg-[#166534] dark:bg-[#22C55E] dark:hover:bg-[#16A34A] text-white dark:text-slate-950 text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
              >
                <Plus className="w-4 h-4" aria-hidden="true" />
                {showAddParcelForm ? 'Fechar Formulário' : 'Adicionar Propriedade'}
              </button>
            </div>
          </div>

          {parcelFeedback && (
            <div
              role="status"
              className="rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-400/70 px-4 py-3 text-xs font-semibold text-emerald-900 dark:text-emerald-200 flex items-center justify-between gap-3"
            >
              <span className="inline-flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0 text-[#16A34A]" aria-hidden="true" />
                {parcelFeedback}
              </span>
              <button
                type="button"
                onClick={() => setParcelFeedback(null)}
                className="text-xs underline whitespace-nowrap shrink-0"
              >
                Fechar
              </button>
            </div>
          )}

          {/* Create New Property Panel */}
          {showAddParcelForm && (
            <form
              onSubmit={handleSubmitNewParcel}
              className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-4"
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-200 dark:border-[#263248]">
                <div>
                  <h2 className="text-base font-bold text-slate-900 dark:text-white">
                    Registar Nova Propriedade (BUPi / Matriz Predial)
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Calcula automaticamente as faixas regulamentares EPSG:3763 (Despacho n.º 675/2026) e guarda localmente e na Cloud.
                  </p>
                </div>
              </div>

              {/* Optional Caderneta Quick Extractor */}
              <div className="space-y-2 pb-4 border-b border-slate-200 dark:border-[#263248]">
                <label
                  htmlFor="new-parcel-caderneta"
                  className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
                >
                  Preenchimento Rápido por Texto da Caderneta Predial (Opcional)
                </label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    id="new-parcel-caderneta"
                    type="text"
                    value={newCadernetaRaw}
                    onChange={(e) => setNewCadernetaRaw(e.target.value)}
                    placeholder="Ex.: Prédio Rústico em Mafra, Artigo Matricial 312 Secção B, com sobreiros..."
                    className="flex-1 min-h-[42px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
                  />
                  <button
                    type="button"
                    onClick={handleExtractCadernetaIntoNewForm}
                    className="min-h-[42px] px-3.5 py-2 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                  >
                    Extrair Dados da Caderneta
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <div>
                  <label
                    htmlFor="new-parcel-label"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Designação da Propriedade *
                  </label>
                  <input
                    id="new-parcel-label"
                    type="text"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    placeholder="Ex.: Quinta do Pinhal Velho"
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                  />
                </div>

                <div>
                  <label
                    htmlFor="new-parcel-dico"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Concelho (DICO)
                  </label>
                  <select
                    id="new-parcel-dico"
                    value={newDico}
                    onChange={(e) => setNewDico(e.target.value)}
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                  >
                    {municipalities.map((m) => (
                      <option key={m.dico} value={m.dico}>
                        {m.name} ({m.dico})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="new-parcel-parish"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Freguesia
                  </label>
                  <input
                    id="new-parcel-parish"
                    type="text"
                    value={newParish}
                    onChange={(e) => setNewParish(e.target.value)}
                    placeholder="Ex.: Colares"
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                  />
                </div>

                <div>
                  <label
                    htmlFor="new-parcel-matrix"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Artigo Matricial
                  </label>
                  <input
                    id="new-parcel-matrix"
                    type="text"
                    value={newMatrixArticle}
                    onChange={(e) => setNewMatrixArticle(e.target.value)}
                    placeholder="Ex.: Rústico — Art.º 204, Secção D"
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                  />
                </div>

                <div>
                  <label
                    htmlFor="new-parcel-bupi"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Código BUPi (RGG)
                  </label>
                  <input
                    id="new-parcel-bupi"
                    type="text"
                    value={newBupiRggId}
                    onChange={(e) => setNewBupiRggId(e.target.value)}
                    placeholder="Ex.: RGG-2026-41290"
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm font-mono text-slate-900 dark:text-white"
                  />
                </div>

                <div>
                  <label
                    htmlFor="new-parcel-landclass"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Ocupação do Solo
                  </label>
                  <select
                    id="new-parcel-landclass"
                    value={newLandClass}
                    onChange={(e) => setNewLandClass(e.target.value as LandClass)}
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                  >
                    <option value="FOREST_SCRUB">Florestal / Mato Contínuo</option>
                    <option value="AGRICULTURE">Agrícola / Pomar / Olival</option>
                    <option value="URBAN_BUILT">Urbano Consolidado / Jardim</option>
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="new-parcel-slope"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Declive Médio (%)
                  </label>
                  <input
                    id="new-parcel-slope"
                    type="number"
                    min={0}
                    max={100}
                    step={0.5}
                    value={newAvgSlope}
                    onChange={(e) => setNewAvgSlope(Number(e.target.value))}
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm font-mono tabular-nums text-slate-900 dark:text-white"
                  />
                </div>

                <div className="sm:col-span-2 flex flex-wrap items-center gap-5 pt-5">
                  <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-800 dark:text-slate-200 cursor-pointer min-h-[40px]">
                    <input
                      type="checkbox"
                      checked={newHasEredes}
                      onChange={(e) => setNewHasEredes(e.target.checked)}
                      className="w-4 h-4 rounded accent-[#14532D]"
                    />
                    Linha aérea E-REDES atravessa o lote (deduz servidão)
                  </label>
                  <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-800 dark:text-slate-200 cursor-pointer min-h-[40px]">
                    <input
                      type="checkbox"
                      checked={newHasOaks}
                      onChange={(e) => setNewHasOaks(e.target.checked)}
                      className="w-4 h-4 rounded accent-[#14532D]"
                    />
                    Presença de Sobreiros / Azinheiras protegidos (ICNF)
                  </label>
                </div>
              </div>

              <div>
                <label
                  htmlFor="new-parcel-vertices"
                  className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                >
                  Vértices Geográficos WGS84 (Opcional — 1 par latitude, longitude por linha; se vazio gera polígono padrão no concelho)
                </label>
                <textarea
                  id="new-parcel-vertices"
                  rows={3}
                  value={newVerticesRaw}
                  onChange={(e) => setNewVerticesRaw(e.target.value)}
                  placeholder={'38.798050, -9.462580\n38.798760, -9.462520\n38.798790, -9.461640'}
                  className="w-full px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs font-mono tabular-nums text-slate-900 dark:text-white"
                />
              </div>

              {addParcelError && (
                <p role="alert" className="text-xs font-semibold text-[#DC2626]">
                  {addParcelError}
                </p>
              )}

              <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddParcelForm(false)}
                  className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-300"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="min-h-[44px] px-5 py-2 rounded-xl bg-[#14532D] hover:bg-[#166534] dark:bg-[#22C55E] dark:text-slate-950 text-white text-xs font-semibold whitespace-nowrap"
                >
                  Guardar Nova Propriedade
                </button>
              </div>
            </form>
          )}

          {/* Properties List with Integrated Per-Parcel Document Management */}
          {filteredParcels.length === 0 ? (
            <div className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-8 text-center space-y-3">
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                Nenhuma propriedade corresponde à pesquisa "{parcelSearch}".
              </p>
              <button
                type="button"
                onClick={() => setParcelSearch('')}
                className="min-h-[42px] px-4 py-2 rounded-xl bg-[#14532D] text-white text-xs font-semibold"
              >
                Limpar Filtro
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredParcels.map((parcel) => {
                const isSelected = parcel.id === activeParcel.id;
                const isEditing = editingParcelId === parcel.id;
                const isConfirmingDelete = confirmDeleteParcelId === parcel.id;
                const isUploadOpen = uploadOpenParcelId === parcel.id;
                const docsForParcel = filterDocumentsForParcel(parcelDocuments, parcel.id);

                return (
                  <article
                    key={parcel.id}
                    data-testid={`parcel-card-${parcel.id}`}
                    className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-4"
                  >
                    {/* Top Row: Title, Unboxed Metadata, Actions */}
                    <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
                      <div className="space-y-1 min-w-0">
                        <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span>
                            {parcel.municipality} (DICO {parcel.dico})
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>Freguesia: {parcel.parish}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">{parcel.bupiRggId}</span>
                          <span aria-hidden="true">·</span>
                          <span>{parcel.matrixArticle}</span>
                          {isSelected && (
                            <>
                              <span aria-hidden="true">·</span>
                              <strong className="text-[#14532D] dark:text-[#4ADE80]">
                                Terreno Ativo
                              </strong>
                            </>
                          )}
                        </div>
                        <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                          {parcel.label}
                        </h2>
                        <div className="text-xs text-slate-600 dark:text-slate-300 tabular-nums flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
                          <span>
                            Área Total:{' '}
                            <strong className="font-mono text-slate-900 dark:text-white">
                              {parcel.spatial.totalAreaM2.toFixed(0)} m²
                            </strong>
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>
                            Faixa Obrigatória:{' '}
                            <strong className="font-mono text-[#14532D] dark:text-[#4ADE80]">
                              {parcel.spatial.mandatoryCleanAreaM2.toFixed(0)} m²
                            </strong>
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>Declive: {parcel.avgSlopePct}%</span>
                          <span aria-hidden="true">·</span>
                          <span>{LAND_CLASS_LABELS[parcel.landClass]}</span>
                          {parcel.hasEredesLine && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>Servidão E-REDES ({parcel.spatial.thirdPartyEasementM2.toFixed(0)} m²)</span>
                            </>
                          )}
                          {parcel.hasProtectedOaks && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>Quercíneas Protegidas (DL 169/2001)</span>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Property CRUD Action Buttons */}
                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={isSelected}
                          onClick={() => onSelectParcel(parcel.id)}
                          aria-label={`Selecionar ${parcel.label} como terreno ativo`}
                          className={`min-h-[40px] px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                            isSelected
                              ? 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
                              : 'border border-[#14532D] dark:border-[#22C55E] text-[#14532D] dark:text-[#22C55E] hover:bg-[#14532D]/10'
                          }`}
                        >
                          {isSelected ? 'Selecionado' : 'Definir Ativo'}
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            isEditing ? setEditingParcelId(null) : startEditingParcel(parcel)
                          }
                          aria-label={`Editar propriedade ${parcel.label}`}
                          className="min-h-[40px] px-3 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                        >
                          <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                          {isEditing ? 'Fechar Edição' : 'Editar'}
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            onSelectParcel(parcel.id);
                            onNavigateTab('certify', 'certificate');
                          }}
                          aria-label={`Emitir Auto SHA-256 para ${parcel.label}`}
                          className="min-h-[40px] px-3 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                        >
                          <FileCheck2 className="w-3.5 h-3.5" aria-hidden="true" />
                          Auto SHA-256
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setConfirmDeleteParcelId(isConfirmingDelete ? null : parcel.id);
                            setDeleteParcelError(null);
                          }}
                          aria-label={`Eliminar propriedade ${parcel.label}`}
                          className="min-h-[40px] px-3 py-1.5 rounded-xl border border-rose-300 dark:border-rose-800/70 text-xs font-semibold text-[#DC2626] dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                          Eliminar
                        </button>
                      </div>
                    </div>

                    {/* Inline Delete Confirmation */}
                    {isConfirmingDelete && (
                      <div
                        role="region"
                        aria-label={`Confirmar eliminação de ${parcel.label}`}
                        className="pt-3 border-t border-slate-200 dark:border-[#263248] flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                      >
                        <div className="space-y-1">
                          <p className="text-xs font-semibold text-[#DC2626] dark:text-rose-400">
                            {parcels.length <= 1
                              ? 'Não é possível eliminar o único terreno ativo na conta. Adicione outra propriedade primeiro caso pretenda substituir esta.'
                              : `Confirma a eliminação definitiva de "${parcel.label}" e dos respetivos ${docsForParcel.length} documento(s) local(is)?`}
                          </p>
                          {deleteParcelError && (
                            <p role="alert" className="text-xs text-[#DC2626]">
                              {deleteParcelError}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmDeleteParcelId(null);
                              setDeleteParcelError(null);
                            }}
                            className="min-h-[40px] px-3.5 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-300 whitespace-nowrap"
                          >
                            Cancelar
                          </button>
                          {parcels.length > 1 && (
                            <button
                              type="button"
                              onClick={() => void handleConfirmDeleteParcel(parcel)}
                              className="min-h-[40px] px-4 py-1.5 rounded-xl bg-[#DC2626] hover:bg-red-700 text-white text-xs font-semibold whitespace-nowrap"
                            >
                              Confirmar Eliminação
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Inline Property Edit Form */}
                    {isEditing && (
                      <form
                        onSubmit={(e) => void handleSaveEditedParcel(e, parcel)}
                        className="pt-4 border-t border-slate-200 dark:border-[#263248] space-y-4"
                      >
                        <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                          Editar Dados Cadastrais & Características do Terreno
                        </h3>

                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
                          <div>
                            <label
                              htmlFor={`edit-label-${parcel.id}`}
                              className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                            >
                              Designação da Propriedade
                            </label>
                            <input
                              id={`edit-label-${parcel.id}`}
                              type="text"
                              value={editLabel}
                              onChange={(e) => setEditLabel(e.target.value)}
                              className="w-full min-h-[42px] px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
                            />
                          </div>

                          <div>
                            <label
                              htmlFor={`edit-dico-${parcel.id}`}
                              className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                            >
                              Concelho (DICO)
                            </label>
                            <select
                              id={`edit-dico-${parcel.id}`}
                              value={editDico}
                              onChange={(e) => setEditDico(e.target.value)}
                              className="w-full min-h-[42px] px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
                            >
                              {municipalities.map((m) => (
                                <option key={m.dico} value={m.dico}>
                                  {m.name} ({m.dico})
                                </option>
                              ))}
                            </select>
                          </div>

                          <div>
                            <label
                              htmlFor={`edit-parish-${parcel.id}`}
                              className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                            >
                              Freguesia
                            </label>
                            <input
                              id={`edit-parish-${parcel.id}`}
                              type="text"
                              value={editParish}
                              onChange={(e) => setEditParish(e.target.value)}
                              className="w-full min-h-[42px] px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
                            />
                          </div>

                          <div>
                            <label
                              htmlFor={`edit-matrix-${parcel.id}`}
                              className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                            >
                              Artigo Matricial
                            </label>
                            <input
                              id={`edit-matrix-${parcel.id}`}
                              type="text"
                              value={editMatrix}
                              onChange={(e) => setEditMatrix(e.target.value)}
                              className="w-full min-h-[42px] px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
                            />
                          </div>

                          <div>
                            <label
                              htmlFor={`edit-bupi-${parcel.id}`}
                              className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                            >
                              Código BUPi (RGG)
                            </label>
                            <input
                              id={`edit-bupi-${parcel.id}`}
                              type="text"
                              value={editBupi}
                              onChange={(e) => setEditBupi(e.target.value)}
                              className="w-full min-h-[42px] px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs font-mono text-slate-900 dark:text-white"
                            />
                          </div>

                          <div>
                            <label
                              htmlFor={`edit-landclass-${parcel.id}`}
                              className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                            >
                              Ocupação do Solo
                            </label>
                            <select
                              id={`edit-landclass-${parcel.id}`}
                              value={editLandClass}
                              onChange={(e) => setEditLandClass(e.target.value as LandClass)}
                              className="w-full min-h-[42px] px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
                            >
                              <option value="FOREST_SCRUB">Florestal / Mato Contínuo</option>
                              <option value="AGRICULTURE">Agrícola / Pomar / Olival</option>
                              <option value="URBAN_BUILT">Urbano Consolidado / Jardim</option>
                            </select>
                          </div>

                          <div>
                            <label
                              htmlFor={`edit-slope-${parcel.id}`}
                              className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                            >
                              Declive Médio (%)
                            </label>
                            <input
                              id={`edit-slope-${parcel.id}`}
                              type="number"
                              min={0}
                              max={100}
                              step={0.5}
                              value={editSlope}
                              onChange={(e) => setEditSlope(Number(e.target.value))}
                              className="w-full min-h-[42px] px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs font-mono tabular-nums text-slate-900 dark:text-white"
                            />
                          </div>

                          <div className="sm:col-span-2 flex flex-wrap items-center gap-5 pt-4">
                            <label className="inline-flex items-center gap-2 text-xs text-slate-800 dark:text-slate-200 cursor-pointer min-h-[38px]">
                              <input
                                type="checkbox"
                                checked={editHasEredes}
                                onChange={(e) => setEditHasEredes(e.target.checked)}
                                className="w-4 h-4 rounded accent-[#14532D]"
                              />
                              Linha aérea E-REDES presente
                            </label>
                            <label className="inline-flex items-center gap-2 text-xs text-slate-800 dark:text-slate-200 cursor-pointer min-h-[38px]">
                              <input
                                type="checkbox"
                                checked={editHasOaks}
                                onChange={(e) => setEditHasOaks(e.target.checked)}
                                className="w-4 h-4 rounded accent-[#14532D]"
                              />
                              Sobreiros / Azinheiras protegidos
                            </label>
                            <button
                              type="button"
                              onClick={() => setShowEditVertices((v) => !v)}
                              className="text-xs font-semibold text-[#14532D] dark:text-[#4ADE80] underline whitespace-nowrap"
                            >
                              {showEditVertices
                                ? 'Ocultar Coordenadas dos Vértices'
                                : `Editar Vértices Geográficos (${parcel.vertices.length})`}
                            </button>
                          </div>
                        </div>

                        {showEditVertices && (
                          <div>
                            <label
                              htmlFor={`edit-vertices-${parcel.id}`}
                              className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                            >
                              Vértices WGS84 (latitude, longitude por linha)
                            </label>
                            <textarea
                              id={`edit-vertices-${parcel.id}`}
                              rows={4}
                              value={editVerticesRaw}
                              onChange={(e) => setEditVerticesRaw(e.target.value)}
                              className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs font-mono tabular-nums text-slate-900 dark:text-white"
                            />
                          </div>
                        )}

                        {editParcelError && (
                          <p role="alert" className="text-xs font-semibold text-[#DC2626]">
                            {editParcelError}
                          </p>
                        )}

                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setEditingParcelId(null)}
                            className="min-h-[42px] px-4 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-300"
                          >
                            Cancelar
                          </button>
                          <button
                            type="submit"
                            className="min-h-[42px] px-5 py-1.5 rounded-xl bg-[#14532D] hover:bg-[#166534] dark:bg-[#22C55E] dark:text-slate-950 text-white text-xs font-semibold whitespace-nowrap"
                          >
                            Guardar Alterações da Propriedade
                          </button>
                        </div>
                      </form>
                    )}

                    {/* Integrated Per-Parcel Uploaded Documents Block */}
                    <div className="pt-4 border-t border-slate-200 dark:border-[#263248] space-y-3">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <FolderOpen
                            className="w-4 h-4 text-[#14532D] dark:text-[#22C55E] shrink-0"
                            aria-hidden="true"
                          />
                          <h3 className="text-xs font-bold text-slate-900 dark:text-white tabular-nums">
                            Documentos Carregados deste Terreno ({docsForParcel.length})
                          </h3>
                        </div>

                        <button
                          type="button"
                          aria-expanded={isUploadOpen}
                          aria-label={`Carregar documento em ${parcel.label}`}
                          onClick={() => {
                            setUploadOpenParcelId(isUploadOpen ? null : parcel.id);
                            setDocUploadError(null);
                          }}
                          className="min-h-[38px] px-3 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 self-start sm:self-auto"
                        >
                          <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                          {isUploadOpen ? 'Ocultar Upload' : 'Carregar Documento'}
                        </button>
                      </div>

                      {isUploadOpen && (
                        <div className="pt-2 pb-3 border-b border-slate-200 dark:border-[#263248] space-y-3">
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                            <div>
                              <label
                                htmlFor={`doc-cat-${parcel.id}`}
                                className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                              >
                                Tipo de Documento
                              </label>
                              <select
                                id={`doc-cat-${parcel.id}`}
                                value={docCategory}
                                onChange={(e) =>
                                  setDocCategory(e.target.value as ParcelDocumentCategory)
                                }
                                className="w-full min-h-[42px] px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
                              >
                                {(
                                  Object.keys(
                                    PARCEL_DOCUMENT_CATEGORY_LABELS
                                  ) as ParcelDocumentCategory[]
                                ).map((cat) => (
                                  <option key={cat} value={cat}>
                                    {PARCEL_DOCUMENT_CATEGORY_LABELS[cat]}
                                  </option>
                                ))}
                              </select>
                            </div>

                            <div>
                              <label
                                htmlFor={`doc-notes-${parcel.id}`}
                                className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                              >
                                Notas / Referência (Opcional)
                              </label>
                              <input
                                id={`doc-notes-${parcel.id}`}
                                type="text"
                                value={docNotes}
                                onChange={(e) => setDocNotes(e.target.value)}
                                placeholder="Ex.: Fatura limpeza maio 2026"
                                className="w-full min-h-[42px] px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
                              />
                            </div>

                            <div>
                              <label
                                htmlFor={`doc-file-${parcel.id}`}
                                className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                              >
                                Selecionar Ficheiro (máx. 4 MB)
                              </label>
                              <input
                                id={`doc-file-${parcel.id}`}
                                type="file"
                                disabled={uploadingParcelId === parcel.id}
                                accept=".pdf,.jpg,.jpeg,.png,.webp,.geojson,.kml,.txt,.csv,.doc,.docx"
                                onChange={(e) => void handleFileChangeForParcel(parcel, e)}
                                className="w-full min-h-[42px] px-2.5 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-700 dark:text-slate-300 file:mr-2.5 file:py-1 file:px-2.5 file:rounded-lg file:border-0 file:bg-[#14532D] file:text-white dark:file:bg-[#22C55E] dark:file:text-slate-950 file:text-xs file:font-semibold"
                              />
                            </div>
                          </div>

                          {docUploadError && (
                            <p role="alert" className="text-xs font-semibold text-[#DC2626]">
                              {docUploadError}
                            </p>
                          )}
                        </div>
                      )}

                      {docsForParcel.length === 0 ? (
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          Sem documentos carregados para este terreno. Guarde aqui a Caderneta Predial, o polígono RGG BUPi, faturas de limpeza ou licenças ICNF.
                        </p>
                      ) : (
                        <div className="divide-y divide-slate-200 dark:divide-[#263248]">
                          {docsForParcel.map((docItem) => (
                            <div
                              key={docItem.id}
                              className="py-2.5 first:pt-1 last:pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                            >
                              <div className="min-w-0">
                                <div className="text-xs font-semibold text-slate-900 dark:text-white flex items-center gap-1.5 truncate">
                                  <FileText
                                    className="w-3.5 h-3.5 text-slate-400 shrink-0"
                                    aria-hidden="true"
                                  />
                                  <span className="truncate">{docItem.fileName}</span>
                                </div>
                                <div className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums mt-0.5">
                                  <span>{PARCEL_DOCUMENT_CATEGORY_LABELS[docItem.category]}</span>
                                  <span aria-hidden="true"> · </span>
                                  <span className="font-mono">{formatFileSizePt(docItem.sizeBytes)}</span>
                                  <span aria-hidden="true"> · </span>
                                  <span>
                                    {new Date(docItem.uploadedAtIso).toLocaleDateString('pt-PT')}
                                  </span>
                                  {docItem.notes && (
                                    <>
                                      <span aria-hidden="true"> · </span>
                                      <span>{docItem.notes}</span>
                                    </>
                                  )}
                                </div>
                              </div>

                              <div className="flex items-center gap-2 shrink-0">
                                <button
                                  type="button"
                                  onClick={() => handleDownloadParcelDoc(docItem)}
                                  aria-label={`Transferir documento ${docItem.fileName}`}
                                  className="min-h-[36px] px-2.5 py-1 rounded-lg border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1 whitespace-nowrap"
                                >
                                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                                  Transferir
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void onDeleteParcelDocument(docItem.id)}
                                  aria-label={`Remover documento ${docItem.fileName}`}
                                  className="min-h-[36px] px-2.5 py-1 rounded-lg border border-rose-300 dark:border-rose-800/70 text-xs font-semibold text-[#DC2626] dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 inline-flex items-center gap-1 whitespace-nowrap"
                                >
                                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                                  Remover
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ==================== TAB 2: PRESTADORES FAVORITOS ==================== */}
      {subTab === 'favorites' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Saved Favorites Column */}
          <section className="lg:col-span-7 rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-200 dark:border-[#263248]">
              <div>
                <h2 className="text-base font-bold text-slate-900 dark:text-white tabular-nums">
                  Prestadores Florestais Favoritos ({favoriteProviders.length})
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Empresas credenciadas guardadas para contacto rápido e pedidos de orçamento nos seus terrenos.
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigateTab('certify', 'quotes')}
                className="min-h-[40px] px-3.5 py-1.5 rounded-xl bg-[#D97706] hover:bg-[#B45309] text-white text-xs font-semibold whitespace-nowrap shrink-0"
              >
                Pedir 3 Orçamentos
              </button>
            </div>

            {favoriteProviders.length === 0 ? (
              <div className="py-6 text-center space-y-2">
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                  Ainda não guardou nenhum prestador florestal nos favoritos.
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Selecione empresas credenciadas na lista ao lado ou no separador Prestadores para acesso rápido.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-[#263248]">
                {favoriteProviders.map((prov) => (
                  <div
                    key={prov.id}
                    className="py-4 first:pt-1 last:pb-1 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div className="space-y-1">
                      <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                        {prov.companyName}
                      </h3>
                      <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                        NIF {prov.nif} · CAE {prov.caeCode} · Tel. {prov.phoneWhatsapp} · {prov.completedCertificates} Autos SHA-256
                      </div>
                      <div className="text-xs text-slate-600 dark:text-slate-300">
                        Concelhos: {prov.coveredMunicipalities.join(', ')}
                        {prov.hasIcnfOakCredential ? ' · Credenciado Quercíneas ICNF' : ''}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onNavigateTab('certify', 'quotes')}
                        className="min-h-[40px] px-3 py-1.5 rounded-xl bg-[#14532D] dark:bg-[#22C55E] text-white dark:text-slate-950 text-xs font-semibold whitespace-nowrap"
                      >
                        Pedir Proposta
                      </button>
                      <button
                        type="button"
                        onClick={() => onToggleFavoriteProvider(prov.id)}
                        aria-label={`Remover ${prov.companyName} dos favoritos`}
                        className="min-h-[40px] px-3 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                      >
                        Remover
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Directory Picker Column */}
          <section className="lg:col-span-5 rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-4">
            <div className="space-y-1">
              <h2 className="text-base font-bold text-slate-900 dark:text-white">
                Diretório de Empresas Credenciadas
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Adicione ou remova empresas favoritas por concelho de atuação.
              </p>
            </div>

            <div className="relative">
              <label htmlFor="fav-provider-search" className="sr-only">
                Pesquisar prestadores florestais
              </label>
              <Search
                className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                id="fav-provider-search"
                type="search"
                value={providerSearch}
                onChange={(e) => setProviderSearch(e.target.value)}
                placeholder="Pesquisar empresa ou concelho..."
                className="w-full min-h-[42px] pl-9 pr-3 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
              />
            </div>

            <div className="divide-y divide-slate-200 dark:divide-[#263248]">
              {filteredCatalogProviders.map((prov) => {
                const isFav = favoriteProviderIds.includes(prov.id);
                return (
                  <div
                    key={prov.id}
                    className="py-3 first:pt-1 last:pb-1 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-slate-900 dark:text-white truncate">
                        {prov.companyName}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                        {prov.coveredMunicipalities.join(', ')}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onToggleFavoriteProvider(prov.id)}
                      aria-label={
                        isFav
                          ? `Desmarcar ${prov.companyName} dos favoritos`
                          : `Adicionar ${prov.companyName} aos favoritos`
                      }
                      className={`min-h-[38px] px-3 py-1.5 rounded-lg border text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                        isFav
                          ? 'border-[#D97706] bg-[#D97706]/10 text-[#B45309] dark:text-[#FBBF24]'
                          : 'border-slate-300 dark:border-[#263248] text-slate-700 dark:text-slate-200'
                      }`}
                    >
                      <Star
                        className={`w-3.5 h-3.5 ${isFav ? 'fill-current' : ''}`}
                        aria-hidden="true"
                      />
                      {isFav ? 'Favorito' : 'Adicionar'}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {/* ==================== TAB 3: PERFIL DO UTILIZADOR & CONFIGURAÇÕES DIVERSAS ==================== */}
      {subTab === 'settings' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column: User Personal, Fiscal & Account Info */}
          <div className="lg:col-span-6 space-y-5">
            <form
              onSubmit={(e) => void handleSaveUserProfileForm(e)}
              className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-4"
            >
              <div className="pb-3 border-b border-slate-200 dark:border-[#263248]">
                <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <UserIcon className="w-4 h-4 text-[#14532D] dark:text-[#22C55E]" aria-hidden="true" />
                  Informações do Utilizador & Dados Fiscais
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Estes dados pré-preenchem automaticamente os Autos de Conformidade SHA-256 e requerimentos GTF.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2">
                  <label
                    htmlFor="user-prof-name"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Nome Completo do Titular / Cabeça de Casal
                  </label>
                  <input
                    id="user-prof-name"
                    type="text"
                    value={profName}
                    onChange={(e) => setProfName(e.target.value)}
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                  />
                </div>

                <div>
                  <label
                    htmlFor="user-prof-nif"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                  >
                    NIF (9 dígitos)
                  </label>
                  <input
                    id="user-prof-nif"
                    type="text"
                    inputMode="numeric"
                    maxLength={9}
                    value={profNif}
                    onChange={(e) => setProfNif(e.target.value)}
                    placeholder="Ex.: 218492310"
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm font-mono tabular-nums text-slate-900 dark:text-white"
                  />
                </div>

                <div>
                  <label
                    htmlFor="user-prof-phone"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Telemóvel / WhatsApp
                  </label>
                  <input
                    id="user-prof-phone"
                    type="tel"
                    value={profPhone}
                    onChange={(e) => setProfPhone(e.target.value)}
                    placeholder="Ex.: +351 912 345 678"
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm font-mono tabular-nums text-slate-900 dark:text-white"
                  />
                </div>

                <div>
                  <label
                    htmlFor="user-prof-email"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Email de Notificações
                  </label>
                  <input
                    id="user-prof-email"
                    type="email"
                    value={profEmail}
                    onChange={(e) => setProfEmail(e.target.value)}
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                  />
                </div>

                <div>
                  <label
                    htmlFor="user-prof-dico"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Concelho Preferencial (DICO)
                  </label>
                  <select
                    id="user-prof-dico"
                    value={profDico}
                    onChange={(e) => setProfDico(e.target.value)}
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                  >
                    {municipalities.map((m) => (
                      <option key={m.dico} value={m.dico}>
                        {m.name} ({m.dico})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {profError && (
                <p role="alert" className="text-xs font-semibold text-[#DC2626]">
                  {profError}
                </p>
              )}
              {profSavedMsg && (
                <p role="status" className="text-xs font-semibold text-[#16A34A]">
                  {profSavedMsg}
                </p>
              )}

              <div className="flex justify-end pt-2">
                <button
                  type="submit"
                  disabled={profSaving}
                  className="min-h-[44px] px-5 py-2 rounded-xl bg-[#14532D] hover:bg-[#166534] dark:bg-[#22C55E] dark:text-slate-950 text-white text-xs font-semibold whitespace-nowrap"
                >
                  {profSaving ? 'A guardar...' : 'Guardar Dados do Utilizador'}
                </button>
              </div>
            </form>

            {/* Cloud Sync & Session Security Card */}
            <section className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-3">
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                Sessão, Armazenamento Offline & Sincronização Cloud
              </h2>
              <div className="text-xs text-slate-600 dark:text-slate-300 space-y-1 tabular-nums">
                <p>
                  Motor local ativo:{' '}
                  <strong className="font-mono text-slate-900 dark:text-white">
                    {storageBackend === 'indexeddb' ? 'IndexedDB' : 'localStorage'}
                  </strong>{' '}
                  · Ligação: <strong>{isOnline ? 'Online' : 'Offline no Terreno'}</strong>
                </p>
                <p>
                  Operações pendentes na fila Firestore:{' '}
                  <strong className="font-mono text-slate-900 dark:text-white">
                    {pendingSyncCount}
                  </strong>
                  {lastSyncedAtIso
                    ? ` · Última sincronização: ${new Date(lastSyncedAtIso).toLocaleTimeString('pt-PT')}`
                    : ''}
                </p>
              </div>

              {cloudSignInError && (
                <p role="alert" className="text-xs font-semibold text-[#DC2626]">
                  {cloudSignInError}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2 pt-2">
                <button
                  type="button"
                  disabled={isSyncing || !isOnline}
                  onClick={() => void onManualSync()}
                  className="min-h-[42px] px-3.5 py-2 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`}
                    aria-hidden="true"
                  />
                  {isSyncing ? 'A sincronizar...' : 'Sincronizar Agora'}
                </button>

                {!isCloudSession && isFirebaseConfigured && (
                  <button
                    type="button"
                    onClick={async () => {
                      setCloudSignInError(null);
                      try {
                        await onSignInGoogle();
                      } catch (err) {
                        setCloudSignInError(
                          err instanceof Error ? err.message : 'Não foi possível ligar a conta Google.'
                        );
                      }
                    }}
                    className="min-h-[42px] px-4 py-2 rounded-xl bg-[#0F172A] dark:bg-white text-white dark:text-slate-950 text-xs font-semibold whitespace-nowrap"
                  >
                    Associar Conta Google Cloud
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => void onSignOut()}
                  className="min-h-[42px] px-3.5 py-2 rounded-xl border border-rose-300 dark:border-rose-800/70 text-xs font-semibold text-[#DC2626] dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 inline-flex items-center gap-1.5 whitespace-nowrap"
                >
                  <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
                  Terminar Sessão neste Dispositivo
                </button>
              </div>
            </section>
          </div>

          {/* Right Column: Diverse Application Settings */}
          <section className="lg:col-span-6 rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-5">
            <div className="pb-3 border-b border-slate-200 dark:border-[#263248] flex items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-bold text-slate-900 dark:text-white">
                  Configurações Diversas da Aplicação
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Personalize o modo visual de campo, os alertas meteorológicos IPMA e o comportamento dos dossiês.
                </p>
              </div>
            </div>

            {/* Visual Theme Setting */}
            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                Tema Visual de Leitura no Terreno
              </div>
              <div className="grid grid-cols-2 gap-2 p-1 rounded-xl bg-slate-100 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248]">
                <button
                  type="button"
                  onClick={() => onToggleDarkMode(false)}
                  className={`min-h-[42px] px-3 py-2 rounded-lg border text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap ${
                    !darkMode
                      ? 'bg-white text-slate-900 border-slate-300'
                      : 'bg-transparent border-transparent text-slate-600 dark:text-slate-300'
                  }`}
                >
                  <Sun className="w-3.5 h-3.5 text-amber-500" aria-hidden="true" />
                  Modo Solar (Claro)
                </button>
                <button
                  type="button"
                  onClick={() => onToggleDarkMode(true)}
                  className={`min-h-[42px] px-3 py-2 rounded-lg border text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap ${
                    darkMode
                      ? 'bg-[#161E2E] text-white border-[#263248]'
                      : 'bg-transparent border-transparent text-slate-600 dark:text-slate-300'
                  }`}
                >
                  <Moon className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
                  Modo Noite (Escuro)
                </button>
              </div>
            </div>

            {/* PIR Alert Threshold */}
            <div className="space-y-2 pt-3 border-t border-slate-200 dark:border-[#263248]">
              <label
                htmlFor="setting-pir-threshold"
                className="block text-xs font-semibold text-slate-800 dark:text-slate-200"
              >
                Limiar de Alerta Preventivo de Perigo de Incêndio Rural (IPMA RCM)
              </label>
              <select
                id="setting-pir-threshold"
                value={userSettings.pirAlertThreshold}
                onChange={(e) =>
                  onUpdateSettings({
                    ...userSettings,
                    pirAlertThreshold: Number(e.target.value) === 3 ? 3 : 4,
                  })
                }
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
              >
                <option value={3}>Avisar a partir de RCM 3 — Risco Elevado (prudência reforçada)</option>
                <option value={4}>Avisar a partir de RCM 4 — Risco Muito Elevado / Máximo (interdição legal)</option>
              </select>
            </div>

            {/* Active Fire Radar Radius */}
            <div className="space-y-2 pt-3 border-t border-slate-200 dark:border-[#263248]">
              <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                Raio de Vigia do Radar de Ocorrências Ativas ANEPC
              </div>
              <div className="grid grid-cols-3 gap-2">
                {([10, 15, 25] as const).map((km) => {
                  const active = userSettings.proximityAlertRadiusKm === km;
                  return (
                    <button
                      key={km}
                      type="button"
                      onClick={() =>
                        onUpdateSettings({ ...userSettings, proximityAlertRadiusKm: km })
                      }
                      className={`min-h-[42px] px-3 py-2 rounded-xl border text-xs font-mono font-semibold tabular-nums transition-colors ${
                        active
                          ? 'border-[#14532D] bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                          : 'border-slate-300 dark:border-[#263248] text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      {km} km
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Default FGC Buffer Rule */}
            <div className="space-y-2 pt-3 border-t border-slate-200 dark:border-[#263248]">
              <label
                htmlFor="setting-buffer-rule"
                className="block text-xs font-semibold text-slate-800 dark:text-slate-200"
              >
                Enquadramento Padrão de Faixa (Decreto-Lei n.º 82/2021)
              </label>
              <select
                id="setting-buffer-rule"
                value={userSettings.defaultBufferRule}
                onChange={(e) =>
                  onUpdateSettings({
                    ...userSettings,
                    defaultBufferRule:
                      e.target.value === '100M_SETTLEMENT' ? '100M_SETTLEMENT' : '50M_BUILDING',
                  })
                }
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
              >
                <option value="50M_BUILDING">50 metros — Edificação isolada em solo rústico</option>
                <option value="100M_SETTLEMENT">100 metros — Aglomerado populacional / interface urbana</option>
              </select>
            </div>

            {/* Boolean Operational Switches */}
            <div className="space-y-2.5 pt-3 border-t border-slate-200 dark:border-[#263248]">
              <label className="flex items-center justify-between gap-3 min-h-[40px] cursor-pointer text-xs text-slate-800 dark:text-slate-200">
                <span>Sincronizar automaticamente terrenos e histórico quando a rede regressa</span>
                <input
                  type="checkbox"
                  checked={userSettings.offlineAutoSync}
                  onChange={(e) =>
                    onUpdateSettings({ ...userSettings, offlineAutoSync: e.target.checked })
                  }
                  className="w-4 h-4 rounded accent-[#14532D] shrink-0"
                />
              </label>

              <label className="flex items-center justify-between gap-3 min-h-[40px] cursor-pointer text-xs text-slate-800 dark:text-slate-200">
                <span>Transferir automaticamente o PDF A4 ao emitir um Auto SHA-256</span>
                <input
                  type="checkbox"
                  checked={userSettings.autoDownloadCertificatePdf}
                  onChange={(e) =>
                    onUpdateSettings({
                      ...userSettings,
                      autoDownloadCertificatePdf: e.target.checked,
                    })
                  }
                  className="w-4 h-4 rounded accent-[#14532D] shrink-0"
                />
              </label>

              <label className="flex items-center justify-between gap-3 min-h-[40px] cursor-pointer text-xs text-slate-800 dark:text-slate-200">
                <span>Receber avisos de propostas de prestadores por WhatsApp / SMS</span>
                <input
                  type="checkbox"
                  checked={userSettings.notifyQuotesWhatsapp}
                  onChange={(e) =>
                    onUpdateSettings({
                      ...userSettings,
                      notifyQuotesWhatsapp: e.target.checked,
                    })
                  }
                  className="w-4 h-4 rounded accent-[#14532D] shrink-0"
                />
              </label>
            </div>

            <div className="pt-3 border-t border-slate-200 dark:border-[#263248] flex justify-end">
              <button
                type="button"
                onClick={() => onUpdateSettings({ ...DEFAULT_USER_APP_SETTINGS })}
                className="min-h-[40px] px-3.5 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
              >
                Repor Predefinições
              </button>
            </div>
          </section>
        </div>
      )}

      {/* ==================== TAB 4: HISTÓRICO PESSOAL & AUTOS SHA-256 ==================== */}
      {subTab === 'history' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Personal Timeline */}
          <section className="lg:col-span-7 rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-200 dark:border-[#263248]">
              <div>
                <h2 className="text-base font-bold text-slate-900 dark:text-white tabular-nums">
                  Registo de Intervenções & Histórico Pessoal ({historyItems.length})
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Cronologia auditável de limpezas, terrenos registados, orçamentos e autos emitidos.
                </p>
              </div>
              <button
                type="button"
                onClick={onOpenHistoryModal}
                className="min-h-[40px] px-3.5 py-1.5 rounded-xl bg-[#14532D] dark:bg-[#22C55E] text-white dark:text-slate-950 text-xs font-semibold whitespace-nowrap"
              >
                Registar Intervenção Manual
              </button>
            </div>

            <div className="relative">
              <label htmlFor="user-hist-search" className="sr-only">
                Filtrar histórico pessoal
              </label>
              <Search
                className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                id="user-hist-search"
                type="search"
                value={historyQuery}
                onChange={(e) => setHistoryQuery(e.target.value)}
                placeholder="Pesquisar por título, código ou terreno..."
                className="w-full min-h-[42px] pl-9 pr-3 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
              />
            </div>

            {filteredHistory.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400 py-4 text-center">
                Ainda não existem entradas registadas para este filtro.
              </p>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-[#263248]">
                {filteredHistory.map((item) => (
                  <div
                    key={item.id}
                    className="py-3.5 first:pt-1 last:pb-1 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div className="space-y-0.5 min-w-0">
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                        <span className="font-mono">{item.referenceCode}</span>
                        <span aria-hidden="true"> · </span>
                        <span>{item.parcelLabel}</span>
                        <span aria-hidden="true"> · </span>
                        <span>{new Date(item.createdAtIso).toLocaleDateString('pt-PT')}</span>
                        <span aria-hidden="true"> · </span>
                        <span>{item.status === 'ARCHIVED' ? 'Arquivado' : 'Ativo'}</span>
                      </div>
                      <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                        {item.title}
                      </h3>
                      <p className="text-xs text-slate-600 dark:text-slate-300">{item.summary}</p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {item.status === 'ACTIVE' && (
                        <button
                          type="button"
                          onClick={() => void onArchiveHistoryEntry(item.id)}
                          aria-label={`Arquivar registo ${item.title}`}
                          className="min-h-[38px] px-2.5 py-1 rounded-lg border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-200 inline-flex items-center gap-1 whitespace-nowrap"
                        >
                          <Archive className="w-3.5 h-3.5" aria-hidden="true" />
                          Arquivar
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void onDeleteHistoryEntry(item.id)}
                        aria-label={`Eliminar registo ${item.title}`}
                        className="min-h-[38px] px-2.5 py-1 rounded-lg border border-rose-300 dark:border-rose-800/70 text-xs font-semibold text-[#DC2626] dark:text-rose-400 inline-flex items-center gap-1 whitespace-nowrap"
                      >
                        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                        Eliminar
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Issued SHA-256 Certificates & Dossiers */}
          <section className="lg:col-span-5 rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-200 dark:border-[#263248]">
              <div>
                <h2 className="text-base font-bold text-slate-900 dark:text-white tabular-nums">
                  Autos Digitais SHA-256 ({certificates.length})
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Comprovativos criptográficos para GNR / SEPNA e Seguradoras.
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigateTab('certify', 'neighbor')}
                className="min-h-[38px] px-3 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap"
              >
                Dossiê Vizinho
              </button>
            </div>

            <div className="divide-y divide-slate-200 dark:divide-[#263248]">
              {certificates.map((cert) => (
                <div
                  key={cert.id}
                  className="py-3 first:pt-1 last:pb-1 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
                >
                  <div>
                    <div className="text-xs font-mono font-bold text-slate-900 dark:text-white">
                      #{cert.shortCode} · {cert.municipality}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                      {cert.parcelLabel} · {cert.cleanedAreaM2.toFixed(0)} m² ·{' '}
                      {new Date(cert.issuedAt).toLocaleDateString('pt-PT')}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => onInspectCertificate(cert)}
                      aria-label={`Verificar hash de ${cert.shortCode}`}
                      className="min-h-[38px] px-2.5 py-1 rounded-lg border border-slate-300 dark:border-[#263248] text-xs font-semibold inline-flex items-center gap-1 whitespace-nowrap"
                    >
                      <QrCode className="w-3.5 h-3.5" aria-hidden="true" />
                      Hash
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDownloadCertificatePdf(cert)}
                      aria-label={`Transferir PDF de ${cert.shortCode}`}
                      className="min-h-[38px] px-2.5 py-1 rounded-lg bg-[#0F172A] dark:bg-white text-white dark:text-slate-950 text-xs font-semibold inline-flex items-center gap-1 whitespace-nowrap"
                    >
                      <Download className="w-3.5 h-3.5" aria-hidden="true" />
                      PDF
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* ==================== TAB 5: DOCUMENTAÇÃO TÉCNICA & PRD ==================== */}
      {subTab === 'docs' && <DocsArchitectureView />}
    </div>
  );
};
