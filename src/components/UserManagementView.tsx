import React, { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  ArrowRight,
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
  PenTool,
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
  LatLon,
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
  buildParcelLocalLlmNotePayload,
  buildUserGalleryCatalog,
  filterDocumentsForParcel,
  formatFileSizePt,
  formatVerticesMultiline,
  parseVerticesMultiline,
  validateDocumentUploadInput,
  validateParcelMutationInput,
  type UserGalleryItemId,
} from '../lib/userWorkspaceStore.ts';
import {
  CUSTOM_USER_INPUT_VALUE,
  buildBupiCodeOptions,
  buildMatrixArticleOptions,
  findMunicipalityByDico,
  getDistrictsList,
  getMunicipalitiesByDistrict,
  getParishesByMunicipality,
  resolveDropdownOrCustomValue,
  resolveMergedMunicipalityCatalog,
} from '../data/portugalAdminCatalog.ts';

import { DocsArchitectureView } from './DocsArchitectureView.tsx';
import { ParcelPolygonMapModal } from './ParcelPolygonMapModal.tsx';
import faixaSeguraLogoImg from '../assets/images/faixasegura_pwa_logo_1794821062754.jpg';

export type UserSubTab =
  | 'gallery'
  | 'properties'
  | 'favorites'
  | 'settings'
  | 'theme'
  | 'history'
  | 'docs';

const USER_SECTION_LABELS: Record<Exclude<UserSubTab, 'gallery'>, string> = {
  properties: 'Terrenos & Documentos',
  favorites: 'Prestadores Favoritos',
  settings: 'Perfil & Configurações',
  theme: 'Tema & Modo Escuro',
  history: 'Histórico & Autos SHA-256',
  docs: 'Documentação Técnica',
};

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
  initialSubTab = 'gallery',
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

  const allMunicipalities = useMemo(
    () => resolveMergedMunicipalityCatalog(municipalities),
    [municipalities]
  );
  const districtsList = useMemo(() => getDistrictsList(), []);

  // ==================== 1. PROPERTY CRUD & PER-PARCEL DOCUMENTS STATE ====================
  const initialNewMuni = useMemo(
    () =>
      findMunicipalityByDico(
        profile.preferredDico || activeParcel.dico || '1111',
        allMunicipalities
      ),
    [profile.preferredDico, activeParcel.dico, allMunicipalities]
  );

  const [parcelSearch, setParcelSearch] = useState('');
  const [showAddParcelForm, setShowAddParcelForm] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newDistrict, setNewDistrict] = useState<string>(initialNewMuni.district);
  const [newDico, setNewDico] = useState<string>(initialNewMuni.dico);
  const [newParishOption, setNewParishOption] = useState<string>(
    () =>
      getParishesByMunicipality({
        dico: initialNewMuni.dico,
        municipalityName: initialNewMuni.name,
      })[0] ?? initialNewMuni.name
  );
  const [newParishCustom, setNewParishCustom] = useState('');
  const [newMatrixOption, setNewMatrixOption] = useState<string>(
    () =>
      buildMatrixArticleOptions({
        landClass: 'FOREST_SCRUB',
        dico: initialNewMuni.dico,
        municipalityName: initialNewMuni.name,
        existingParcels: parcels,
      })[0]?.value ?? 'Rústico — Art.º 204, Secção D'
  );
  const [newMatrixCustom, setNewMatrixCustom] = useState('');
  const [newBupiOption, setNewBupiOption] = useState<string>(
    () =>
      buildBupiCodeOptions({
        dico: initialNewMuni.dico,
        municipalityName: initialNewMuni.name,
        existingParcels: parcels,
      })[0]?.value ?? ''
  );
  const [newBupiCustom, setNewBupiCustom] = useState('');
  const [newLandClass, setNewLandClass] = useState<LandClass>('FOREST_SCRUB');
  const [newAvgSlope, setNewAvgSlope] = useState<number>(12);
  const [newHasEredes, setNewHasEredes] = useState(false);
  const [newHasOaks, setNewHasOaks] = useState(false);
  const [newUserNotes, setNewUserNotes] = useState('');
  const [newCadernetaRaw, setNewCadernetaRaw] = useState('');
  const [newVerticesRaw, setNewVerticesRaw] = useState('');
  const [addParcelError, setAddParcelError] = useState<string | null>(null);
  const [parcelFeedback, setParcelFeedback] = useState<string | null>(null);

  // Inline Edit Parcel State
  const [editingParcelId, setEditingParcelId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editDistrict, setEditDistrict] = useState('Lisboa');
  const [editDico, setEditDico] = useState('1111');
  const [editParishOption, setEditParishOption] = useState('');
  const [editParishCustom, setEditParishCustom] = useState('');
  const [editMatrixOption, setEditMatrixOption] = useState('');
  const [editMatrixCustom, setEditMatrixCustom] = useState('');
  const [editBupiOption, setEditBupiOption] = useState('');
  const [editBupiCustom, setEditBupiCustom] = useState('');
  const [editLandClass, setEditLandClass] = useState<LandClass>('FOREST_SCRUB');
  const [editSlope, setEditSlope] = useState<number>(12);
  const [editHasEredes, setEditHasEredes] = useState(false);
  const [editHasOaks, setEditHasOaks] = useState(false);
  const [editUserNotes, setEditUserNotes] = useState('');
  const [editVerticesRaw, setEditVerticesRaw] = useState('');
  const [editVerticesTouched, setEditVerticesTouched] = useState(false);
  const [showEditVertices, setShowEditVertices] = useState(true);
  const [editParcelError, setEditParcelError] = useState<string | null>(null);

  // Interactive Polygon Map Modal State ('new' form or 'edit' existing parcel)
  const [polygonMapTarget, setPolygonMapTarget] = useState<
    { mode: 'new' } | { mode: 'edit'; parcel: ParcelRecord } | null
  >(null);

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

  // Derived Cascading Options for Create New Parcel Form
  const newMunicipalitiesForDistrict = useMemo(
    () => getMunicipalitiesByDistrict(newDistrict, allMunicipalities),
    [newDistrict, allMunicipalities]
  );
  const selectedNewMuni = useMemo(
    () => findMunicipalityByDico(newDico, allMunicipalities),
    [newDico, allMunicipalities]
  );
  const newParishesForMuni = useMemo(
    () =>
      getParishesByMunicipality({
        dico: selectedNewMuni.dico,
        municipalityName: selectedNewMuni.name,
      }),
    [selectedNewMuni.dico, selectedNewMuni.name]
  );
  const newMatrixOptions = useMemo(
    () =>
      buildMatrixArticleOptions({
        landClass: newLandClass,
        dico: selectedNewMuni.dico,
        municipalityName: selectedNewMuni.name,
        existingParcels: parcels,
        currentValue:
          newMatrixOption !== CUSTOM_USER_INPUT_VALUE ? newMatrixOption : undefined,
      }),
    [newLandClass, selectedNewMuni.dico, selectedNewMuni.name, parcels, newMatrixOption]
  );
  const newBupiOptions = useMemo(
    () =>
      buildBupiCodeOptions({
        dico: selectedNewMuni.dico,
        municipalityName: selectedNewMuni.name,
        existingParcels: parcels,
        currentValue:
          newBupiOption !== CUSTOM_USER_INPUT_VALUE ? newBupiOption : undefined,
      }),
    [selectedNewMuni.dico, selectedNewMuni.name, parcels, newBupiOption]
  );

  // Derived Cascading Options for Edit Existing Parcel Form
  const editMunicipalitiesForDistrict = useMemo(
    () => getMunicipalitiesByDistrict(editDistrict, allMunicipalities),
    [editDistrict, allMunicipalities]
  );
  const selectedEditMuni = useMemo(
    () => findMunicipalityByDico(editDico, allMunicipalities),
    [editDico, allMunicipalities]
  );
  const editingParcelObj = useMemo(
    () => (editingParcelId ? parcels.find((p) => p.id === editingParcelId) ?? null : null),
    [editingParcelId, parcels]
  );
  const editParishesForMuni = useMemo(
    () =>
      getParishesByMunicipality({
        dico: selectedEditMuni.dico,
        municipalityName: selectedEditMuni.name,
        currentParish:
          editingParcelObj && editingParcelObj.dico === selectedEditMuni.dico
            ? editingParcelObj.parish
            : undefined,
      }),
    [selectedEditMuni.dico, selectedEditMuni.name, editingParcelObj]
  );
  const editMatrixOptions = useMemo(
    () =>
      buildMatrixArticleOptions({
        landClass: editLandClass,
        dico: selectedEditMuni.dico,
        municipalityName: selectedEditMuni.name,
        existingParcels: parcels,
        currentValue:
          editMatrixOption !== CUSTOM_USER_INPUT_VALUE ? editMatrixOption : undefined,
      }),
    [editLandClass, selectedEditMuni.dico, selectedEditMuni.name, parcels, editMatrixOption]
  );
  const editBupiOptions = useMemo(
    () =>
      buildBupiCodeOptions({
        dico: selectedEditMuni.dico,
        municipalityName: selectedEditMuni.name,
        existingParcels: parcels,
        currentValue:
          editBupiOption !== CUSTOM_USER_INPUT_VALUE ? editBupiOption : undefined,
      }),
    [selectedEditMuni.dico, selectedEditMuni.name, parcels, editBupiOption]
  );

  const handleNewDistrictChange = (nextDistrict: string) => {
    setNewDistrict(nextDistrict);
    const munis = getMunicipalitiesByDistrict(nextDistrict, allMunicipalities);
    const firstMuni = munis[0] ?? allMunicipalities[0];
    setNewDico(firstMuni.dico);
    const parishes = getParishesByMunicipality({
      dico: firstMuni.dico,
      municipalityName: firstMuni.name,
    });
    setNewParishOption(parishes[0] ?? firstMuni.name);
    setNewParishCustom('');
    if (newMatrixOption !== CUSTOM_USER_INPUT_VALUE) {
      const mOpts = buildMatrixArticleOptions({
        landClass: newLandClass,
        dico: firstMuni.dico,
        municipalityName: firstMuni.name,
        existingParcels: parcels,
      });
      setNewMatrixOption(mOpts[0]?.value ?? 'Rústico — Art.º 204, Secção D');
    }
    if (newBupiOption !== CUSTOM_USER_INPUT_VALUE) {
      const bOpts = buildBupiCodeOptions({
        dico: firstMuni.dico,
        municipalityName: firstMuni.name,
        existingParcels: parcels,
      });
      setNewBupiOption(bOpts[0]?.value ?? '');
    }
  };

  const handleNewDicoChange = (nextDico: string) => {
    const muni = findMunicipalityByDico(nextDico, allMunicipalities);
    setNewDistrict(muni.district);
    setNewDico(muni.dico);
    const parishes = getParishesByMunicipality({
      dico: muni.dico,
      municipalityName: muni.name,
    });
    setNewParishOption(parishes[0] ?? muni.name);
    setNewParishCustom('');
    if (newMatrixOption !== CUSTOM_USER_INPUT_VALUE) {
      const mOpts = buildMatrixArticleOptions({
        landClass: newLandClass,
        dico: muni.dico,
        municipalityName: muni.name,
        existingParcels: parcels,
      });
      setNewMatrixOption(mOpts[0]?.value ?? 'Rústico — Art.º 204, Secção D');
    }
    if (newBupiOption !== CUSTOM_USER_INPUT_VALUE) {
      const bOpts = buildBupiCodeOptions({
        dico: muni.dico,
        municipalityName: muni.name,
        existingParcels: parcels,
      });
      setNewBupiOption(bOpts[0]?.value ?? '');
    }
  };

  const handleEditDistrictChange = (nextDistrict: string) => {
    setEditDistrict(nextDistrict);
    const munis = getMunicipalitiesByDistrict(nextDistrict, allMunicipalities);
    const firstMuni = munis[0] ?? allMunicipalities[0];
    setEditDico(firstMuni.dico);
    const parishes = getParishesByMunicipality({
      dico: firstMuni.dico,
      municipalityName: firstMuni.name,
    });
    setEditParishOption(parishes[0] ?? firstMuni.name);
    setEditParishCustom('');
    if (!editVerticesTouched) {
      setEditVerticesRaw(
        formatVerticesMultiline(buildDefaultRectangleAroundCenter(firstMuni.defaultCenter))
      );
    }
  };

  const handleEditDicoChange = (nextDico: string) => {
    const muni = findMunicipalityByDico(nextDico, allMunicipalities);
    setEditDistrict(muni.district);
    setEditDico(muni.dico);
    const parishes = getParishesByMunicipality({
      dico: muni.dico,
      municipalityName: muni.name,
    });
    setEditParishOption(parishes[0] ?? muni.name);
    setEditParishCustom('');
    if (!editVerticesTouched) {
      setEditVerticesRaw(
        formatVerticesMultiline(buildDefaultRectangleAroundCenter(muni.defaultCenter))
      );
    }
  };

  const filteredParcels = useMemo(() => {
    const q = parcelSearch.trim().toLowerCase();
    if (!q) return parcels;
    return parcels.filter(
      (p) =>
        p.label.toLowerCase().includes(q) ||
        (p.district ?? '').toLowerCase().includes(q) ||
        p.municipality.toLowerCase().includes(q) ||
        p.parish.toLowerCase().includes(q) ||
        p.bupiRggId.toLowerCase().includes(q) ||
        p.matrixArticle.toLowerCase().includes(q) ||
        (p.userNotes ?? '').toLowerCase().includes(q)
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
    const extracted = extractCadernetaOffline(newCadernetaRaw, allMunicipalities);
    const muni = findMunicipalityByDico(extracted.dico, allMunicipalities);
    const parishes = getParishesByMunicipality({
      dico: muni.dico,
      municipalityName: muni.name,
    });
    setNewLabel(extracted.suggestedLabel);
    setNewDistrict(muni.district);
    setNewDico(muni.dico);
    setNewParishOption(parishes[0] ?? muni.name);
    setNewParishCustom('');
    setNewMatrixOption(extracted.matrixArticle);
    setNewMatrixCustom('');
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

    if (newParishOption === CUSTOM_USER_INPUT_VALUE && !newParishCustom.trim()) {
      setAddParcelError('Indique o nome da freguesia no campo personalizado.');
      return;
    }
    if (newMatrixOption === CUSTOM_USER_INPUT_VALUE && !newMatrixCustom.trim()) {
      setAddParcelError('Indique o Artigo Matricial personalizado ou selecione uma opção da lista.');
      return;
    }
    if (newBupiOption === CUSTOM_USER_INPUT_VALUE && !newBupiCustom.trim()) {
      setAddParcelError('Indique o código BUPi personalizado ou selecione uma opção da lista.');
      return;
    }

    const muni = findMunicipalityByDico(newDico, allMunicipalities);
    let vertices = buildDefaultRectangleAroundCenter(muni.defaultCenter);
    if (newVerticesRaw.trim()) {
      const parsed = parseVerticesMultiline(newVerticesRaw);
      if (!parsed.valid) {
        setAddParcelError(parsed.error || 'Coordenadas inválidas.');
        return;
      }
      vertices = parsed.vertices;
    }

    const resolvedParish = resolveDropdownOrCustomValue({
      selectedOption: newParishOption,
      customInput: newParishCustom,
      fallbackValue: muni.name,
    });
    const resolvedMatrix = resolveDropdownOrCustomValue({
      selectedOption: newMatrixOption,
      customInput: newMatrixCustom,
      fallbackValue: 'Rústico — Art.º 204, Secção D',
    });
    const resolvedBupi = resolveDropdownOrCustomValue({
      selectedOption: newBupiOption,
      customInput: newBupiCustom,
      fallbackValue: '',
    });

    const created = buildLocalParcelRecord({
      label: newLabel.trim(),
      district: newDistrict || muni.district,
      dico: muni.dico,
      parish: resolvedParish,
      matrixArticle: resolvedMatrix,
      bupiRggId: resolvedBupi || undefined,
      landClass: newLandClass,
      avgSlopePct: newAvgSlope,
      hasEredesLine: newHasEredes,
      hasProtectedOaks: newHasOaks,
      userNotes: newUserNotes.trim() || undefined,
      vertices,
      municipalities: allMunicipalities,
    });

    await onCreateParcel(created);
    setNewLabel('');
    setNewParishCustom('');
    setNewMatrixCustom('');
    setNewBupiCustom('');
    setNewUserNotes('');
    setNewCadernetaRaw('');
    setNewVerticesRaw('');
    setShowAddParcelForm(false);
    setParcelFeedback(
      `Propriedade "${created.label}" adicionada em ${created.district} · ${created.municipality} (${created.spatial.mandatoryCleanAreaM2.toFixed(0)} m² exigíveis).`
    );
  };

  const startEditingParcel = (p: ParcelRecord) => {
    const muni = findMunicipalityByDico(p.dico, allMunicipalities);
    const resolvedDistrict = p.district?.trim() || muni.district;
    const parishes = getParishesByMunicipality({
      dico: muni.dico,
      municipalityName: muni.name,
      currentParish: p.parish,
    });
    const matrixOpts = buildMatrixArticleOptions({
      landClass: p.landClass,
      dico: muni.dico,
      municipalityName: muni.name,
      existingParcels: parcels,
      currentValue: p.matrixArticle,
    });
    const bupiOpts = buildBupiCodeOptions({
      dico: muni.dico,
      municipalityName: muni.name,
      existingParcels: parcels,
      currentValue: p.bupiRggId,
    });

    setEditingParcelId(p.id);
    setConfirmDeleteParcelId(null);
    setDeleteParcelError(null);
    setEditParcelError(null);
    setEditLabel(p.label);
    setEditDistrict(resolvedDistrict);
    setEditDico(muni.dico);
    setEditParishOption(p.parish?.trim() || parishes[0] || muni.name);
    setEditParishCustom('');
    setEditMatrixOption(
      p.matrixArticle?.trim() || matrixOpts[0]?.value || 'Rústico — Art.º 204, Secção D'
    );
    setEditMatrixCustom('');
    setEditBupiOption(p.bupiRggId?.trim() || bupiOpts[0]?.value || '');
    setEditBupiCustom('');
    setEditLandClass(p.landClass);
    setEditSlope(p.avgSlopePct);
    setEditHasEredes(p.hasEredesLine);
    setEditHasOaks(p.hasProtectedOaks);
    setEditUserNotes(p.userNotes ?? '');
    setEditVerticesRaw(formatVerticesMultiline(p.vertices));
    setEditVerticesTouched(false);
    setShowEditVertices(true);
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

    if (editParishOption === CUSTOM_USER_INPUT_VALUE && !editParishCustom.trim()) {
      setEditParcelError('Indique o nome da freguesia no campo personalizado.');
      return;
    }
    if (editMatrixOption === CUSTOM_USER_INPUT_VALUE && !editMatrixCustom.trim()) {
      setEditParcelError(
        'Indique o Artigo Matricial personalizado ou selecione uma opção da lista.'
      );
      return;
    }
    if (editBupiOption === CUSTOM_USER_INPUT_VALUE && !editBupiCustom.trim()) {
      setEditParcelError('Indique o código BUPi personalizado ou selecione uma opção da lista.');
      return;
    }

    const muni = findMunicipalityByDico(editDico, allMunicipalities);
    const resolvedParish = resolveDropdownOrCustomValue({
      selectedOption: editParishOption,
      customInput: editParishCustom,
      fallbackValue: existing.parish || muni.name,
    });
    const resolvedMatrix = resolveDropdownOrCustomValue({
      selectedOption: editMatrixOption,
      customInput: editMatrixCustom,
      fallbackValue: existing.matrixArticle,
    });
    const resolvedBupi = resolveDropdownOrCustomValue({
      selectedOption: editBupiOption,
      customInput: editBupiCustom,
      fallbackValue: existing.bupiRggId,
    });

    let nextVertices: LatLon[] | undefined = undefined;
    const recenterOnMuniChange = !editVerticesTouched;

    if (editVerticesTouched || (showEditVertices && editVerticesRaw.trim())) {
      const parsed = parseVerticesMultiline(editVerticesRaw);
      if (!parsed.valid) {
        setEditParcelError(parsed.error || 'Vértices geográficos inválidos.');
        return;
      }
      if (editVerticesTouched || editDico === existing.dico) {
        nextVertices = parsed.vertices;
      }
    }

    const updated = applyParcelUpdate(
      existing,
      {
        label: editLabel,
        district: editDistrict || muni.district,
        dico: muni.dico,
        parish: resolvedParish,
        matrixArticle: resolvedMatrix,
        bupiRggId: resolvedBupi,
        landClass: editLandClass,
        avgSlopePct: editSlope,
        hasEredesLine: editHasEredes,
        hasProtectedOaks: editHasOaks,
        userNotes: editUserNotes,
        vertices: nextVertices,
        recenterVerticesOnMunicipalityChange: recenterOnMuniChange,
      },
      allMunicipalities
    );

    await onUpdateParcel(updated);
    setEditingParcelId(null);
    setParcelFeedback(
      `Propriedade "${updated.label}" atualizada (${updated.district} · ${updated.municipality}) · Faixa obrigatória recalculada: ${updated.spatial.mandatoryCleanAreaM2.toFixed(0)} m².`
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

  const galleryItems = useMemo(
    () =>
      buildUserGalleryCatalog({
        parcelCount: parcels.length,
        documentCount: parcelDocuments.length,
        favoriteProviderCount: favoriteProviders.length,
        darkMode,
        historyCount: historyItems.length,
        certificateCount: certificates.length,
        displayName: profile.displayName,
        isCloudSession,
      }),
    [
      parcels.length,
      parcelDocuments.length,
      favoriteProviders.length,
      darkMode,
      historyItems.length,
      certificates.length,
      profile.displayName,
      isCloudSession,
    ]
  );

  const renderGalleryThumbnailIcon = (id: UserGalleryItemId) => {
    switch (id) {
      case 'properties':
        return <MapPin className="w-6 h-6 sm:w-7 sm:h-7 text-[#14532D] dark:text-[#22C55E]" aria-hidden="true" />;
      case 'favorites':
        return <Star className="w-6 h-6 sm:w-7 sm:h-7 text-[#D97706] dark:text-[#FACC15]" aria-hidden="true" />;
      case 'settings':
        return <Settings className="w-6 h-6 sm:w-7 sm:h-7 text-slate-700 dark:text-slate-200" aria-hidden="true" />;
      case 'theme':
        return darkMode ? (
          <Moon className="w-6 h-6 sm:w-7 sm:h-7 text-sky-400" aria-hidden="true" />
        ) : (
          <Sun className="w-6 h-6 sm:w-7 sm:h-7 text-amber-500" aria-hidden="true" />
        );
      case 'history':
        return <History className="w-6 h-6 sm:w-7 sm:h-7 text-[#14532D] dark:text-[#4ADE80]" aria-hidden="true" />;
      case 'docs':
        return <BookOpen className="w-6 h-6 sm:w-7 sm:h-7 text-sky-700 dark:text-sky-400" aria-hidden="true" />;
      case 'logout':
        return <LogOut className="w-6 h-6 sm:w-7 sm:h-7 text-[#DC2626] dark:text-rose-400" aria-hidden="true" />;
    }
  };

  return (
    <div data-testid="user-management-view" className="space-y-5 sm:space-y-6">
      {/* Workspace Header & Contextual Breadcrumb */}
      <section className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-4 sm:p-5 space-y-3.5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3.5">
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-2xl bg-[#14532D] border border-slate-300 dark:border-[#263248] overflow-hidden flex items-center justify-center shrink-0">
              <img
                src={faixaSeguraLogoImg}
                alt="Logótipo FaixaSegura"
                data-testid="faixasegura-user-pwa-logo"
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
                onError={(e) => {
                  e.currentTarget.classList.add('hidden');
                }}
              />
            </div>
            <div className="space-y-0.5 min-w-0">
              <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums truncate">
                <span>{isCloudSession ? 'Conta Google Cloud Sincronizada' : 'Sessão Local no Dispositivo'}</span>
                <span aria-hidden="true"> · </span>
                <span>{parcels.length} propriedades</span>
                <span aria-hidden="true"> · </span>
                <span>{parcelDocuments.length} documentos carregados</span>
                <span aria-hidden="true"> · </span>
                <span>{favoriteProviders.length} prestadores favoritos</span>
              </div>
              <h1 className="text-lg sm:text-2xl font-bold text-slate-900 dark:text-white tracking-tight truncate">
                Área do Utilizador · {profile.displayName}
              </h1>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onNavigateTab('certify', 'certificate')}
              className="min-h-[42px] px-3 sm:px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <FileCheck2 className="w-3.5 h-3.5 text-[#14532D] dark:text-[#22C55E]" aria-hidden="true" />
              Emitir Auto SHA-256
            </button>
            <button
              type="button"
              onClick={() => onNavigateTab('map')}
              className="min-h-[42px] px-3 sm:px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <MapPin className="w-3.5 h-3.5 text-[#14532D] dark:text-[#22C55E]" aria-hidden="true" />
              <span className="sm:hidden">Ver Mapa</span>
              <span className="hidden sm:inline">Ver Terreno no Mapa</span>
            </button>
          </div>
        </div>

        {subTab !== 'gallery' && (
          <div className="pt-3 border-t border-slate-200 dark:border-[#263248] flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              data-testid="back-to-user-gallery-btn"
              onClick={() => setSubTab('gallery')}
              className="min-h-[42px] px-3.5 py-2 rounded-xl bg-slate-100 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-900 dark:text-white hover:bg-slate-200/70 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <ArrowLeft className="w-3.5 h-3.5 text-[#14532D] dark:text-[#22C55E]" aria-hidden="true" />
              Voltar à Galeria User
            </button>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              <span>Galeria User</span>
              <span aria-hidden="true"> / </span>
              <span className="font-semibold text-slate-900 dark:text-white">
                {USER_SECTION_LABELS[subTab]}
              </span>
            </div>
          </div>
        )}
      </section>

      {/* ==================== GALERIA DE ÍCONES (3/LINHA EM WEB & TABLET HORIZONTAL · 2/LINHA EM MOBILE & TABLET VERTICAL) ==================== */}
      {subTab === 'gallery' && (
        <section
          aria-label="Galeria da Área do Utilizador"
          data-testid="user-thumbnail-gallery"
          className="grid grid-cols-2 md:landscape:grid-cols-3 xl:grid-cols-3 gap-3 sm:gap-5"
        >
          {galleryItems.map((item) => {
            const isLogout = item.actionKind === 'LOGOUT';
            return (
              <button
                key={item.id}
                type="button"
                data-testid={`user-gallery-card-${item.id}`}
                onClick={() => {
                  if (isLogout) {
                    void onSignOut();
                  } else if (item.id !== 'logout') {
                    setSubTab(item.id);
                  }
                }}
                className={`group text-left rounded-2xl bg-white dark:bg-[#161E2E] border overflow-hidden flex flex-col focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14532D] dark:focus-visible:outline-[#22C55E] ${
                  isLogout
                    ? 'border-slate-300 dark:border-[#263248] hover:border-rose-400 dark:hover:border-rose-700'
                    : 'border-slate-300 dark:border-[#263248] hover:border-[#14532D] dark:hover:border-[#22C55E]'
                }`}
              >
                <div
                  data-testid={`user-gallery-icon-stage-${item.id}`}
                  className={`relative h-24 sm:h-28 w-full overflow-hidden border-b flex items-center justify-center ${
                    isLogout
                      ? 'bg-rose-50/60 dark:bg-[#191118] border-rose-200/80 dark:border-rose-950/60'
                      : 'bg-slate-100/80 dark:bg-[#0B0F17] border-slate-200 dark:border-[#263248]'
                  }`}
                >
                  <svg
                    viewBox="0 0 160 100"
                    fill="none"
                    aria-hidden="true"
                    className="absolute inset-0 w-full h-full opacity-35 dark:opacity-25 pointer-events-none"
                  >
                    <polygon
                      points="58,10 102,10 130,38 130,62 102,90 58,90 30,62 30,38"
                      stroke="currentColor"
                      strokeWidth="1"
                      className={
                        isLogout
                          ? 'text-rose-400 dark:text-rose-600'
                          : 'text-slate-300 dark:text-slate-600'
                      }
                    />
                    <polygon
                      points="64,20 96,20 118,42 118,58 96,80 64,80 42,58 42,42"
                      stroke="currentColor"
                      strokeWidth="1"
                      className={
                        isLogout
                          ? 'text-rose-300 dark:text-rose-700'
                          : 'text-[#14532D]/30 dark:text-[#22C55E]/35'
                      }
                    />
                  </svg>

                  <div
                    className={`relative z-10 w-12 h-12 sm:w-14 sm:h-14 rounded-2xl border flex items-center justify-center group-hover:scale-105 transition-transform duration-150 ${
                      isLogout
                        ? 'bg-white dark:bg-[#161E2E] border-rose-300 dark:border-rose-800/70'
                        : 'bg-white dark:bg-[#161E2E] border-slate-300 dark:border-[#263248] group-hover:border-[#14532D] dark:group-hover:border-[#22C55E]'
                    }`}
                  >
                    {renderGalleryThumbnailIcon(item.id)}
                  </div>
                </div>

                <div className="p-3 sm:p-4 flex-1 flex flex-col justify-between gap-1.5">
                  <div className="space-y-1 min-w-0">
                    <div className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400 tabular-nums truncate">
                      {item.kicker}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`text-sm sm:text-base font-bold tracking-tight truncate ${
                          isLogout
                            ? 'text-[#DC2626] dark:text-rose-400'
                            : 'text-slate-900 dark:text-white'
                        }`}
                      >
                        <span className="sm:hidden">{item.shortTitle}</span>
                        <span className="hidden sm:inline">{item.title}</span>
                      </span>
                      {isLogout ? (
                        <LogOut
                          className="w-4 h-4 shrink-0 text-[#DC2626] dark:text-rose-400"
                          aria-hidden="true"
                        />
                      ) : (
                        <ArrowRight
                          className="w-4 h-4 shrink-0 text-slate-400 group-hover:text-[#14532D] dark:group-hover:text-[#22C55E]"
                          aria-hidden="true"
                        />
                      )}
                    </div>
                  </div>
                  <p className="hidden sm:block text-xs text-slate-600 dark:text-slate-300 line-clamp-2 leading-relaxed">
                    {item.description}
                  </p>
                </div>
              </button>
            );
          })}
        </section>
      )}

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
                data-testid="toolbar-draw-polygon-map-btn"
                onClick={() => {
                  const currentEditParcel = editingParcelId
                    ? parcels.find((p) => p.id === editingParcelId)
                    : null;
                  if (currentEditParcel) {
                    setPolygonMapTarget({ mode: 'edit', parcel: currentEditParcel });
                  } else {
                    setShowAddParcelForm(true);
                    setAddParcelError(null);
                    setPolygonMapTarget({ mode: 'new' });
                  }
                }}
                className="min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 dark:border-[#263248] bg-white dark:bg-[#161E2E] text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
              >
                <PenTool className="w-3.5 h-3.5 text-[#14532D] dark:text-[#22C55E]" aria-hidden="true" />
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
                    Calcula automaticamente as faixas regulamentares EPSG:3763 (Despacho n.º 675/2026) com sincronização offline/online automática.
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
                    htmlFor="new-parcel-district"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Distrito
                  </label>
                  <select
                    id="new-parcel-district"
                    value={newDistrict}
                    onChange={(e) => handleNewDistrictChange(e.target.value)}
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                  >
                    {districtsList.map((dist) => (
                      <option key={dist} value={dist}>
                        {dist}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="new-parcel-dico"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Concelho (DICO · {newMunicipalitiesForDistrict.length} no distrito)
                  </label>
                  <select
                    id="new-parcel-dico"
                    value={newDico}
                    onChange={(e) => handleNewDicoChange(e.target.value)}
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                  >
                    {newMunicipalitiesForDistrict.map((m) => (
                      <option key={m.dico} value={m.dico}>
                        {m.name} ({m.dico})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-2">
                  <div>
                    <label
                      htmlFor="new-parcel-parish"
                      className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                    >
                      Freguesia ({selectedNewMuni.name} · {newParishesForMuni.length} no concelho)
                    </label>
                    <select
                      id="new-parcel-parish"
                      value={newParishOption}
                      onChange={(e) => setNewParishOption(e.target.value)}
                      className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                    >
                      {newParishesForMuni.map((parishName) => (
                        <option key={parishName} value={parishName}>
                          {parishName}
                        </option>
                      ))}
                      <option value={CUSTOM_USER_INPUT_VALUE}>
                        Input do utilizador (inserir manualmente)
                      </option>
                    </select>
                  </div>
                  {newParishOption === CUSTOM_USER_INPUT_VALUE && (
                    <div>
                      <label
                        htmlFor="new-parcel-parish-custom"
                        className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1"
                      >
                        Freguesia (Input do utilizador)
                      </label>
                      <input
                        id="new-parcel-parish-custom"
                        type="text"
                        value={newParishCustom}
                        onChange={(e) => setNewParishCustom(e.target.value)}
                        placeholder={`Ex.: Freguesia em ${selectedNewMuni.name}`}
                        className="w-full min-h-[42px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                      />
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <div>
                    <label
                      htmlFor="new-parcel-matrix"
                      className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                    >
                      Artigo Matricial
                    </label>
                    <select
                      id="new-parcel-matrix"
                      value={newMatrixOption}
                      onChange={(e) => setNewMatrixOption(e.target.value)}
                      className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                    >
                      {newMatrixOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {newMatrixOption === CUSTOM_USER_INPUT_VALUE && (
                    <div>
                      <label
                        htmlFor="new-parcel-matrix-custom"
                        className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1"
                      >
                        Artigo Matricial (Input do utilizador)
                      </label>
                      <input
                        id="new-parcel-matrix-custom"
                        type="text"
                        value={newMatrixCustom}
                        onChange={(e) => setNewMatrixCustom(e.target.value)}
                        placeholder="Ex.: Rústico — Art.º 508, Secção E"
                        className="w-full min-h-[42px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                      />
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <div>
                    <label
                      htmlFor="new-parcel-bupi"
                      className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                    >
                      Código BUPi (RGG)
                    </label>
                    <select
                      id="new-parcel-bupi"
                      value={newBupiOption}
                      onChange={(e) => setNewBupiOption(e.target.value)}
                      className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm font-mono text-slate-900 dark:text-white"
                    >
                      {newBupiOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {newBupiOption === CUSTOM_USER_INPUT_VALUE && (
                    <div>
                      <label
                        htmlFor="new-parcel-bupi-custom"
                        className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1"
                      >
                        Código BUPi (Input do utilizador)
                      </label>
                      <input
                        id="new-parcel-bupi-custom"
                        type="text"
                        value={newBupiCustom}
                        onChange={(e) => setNewBupiCustom(e.target.value)}
                        placeholder="Ex.: RGG-2026-41290"
                        className="w-full min-h-[42px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm font-mono text-slate-900 dark:text-white"
                      />
                    </div>
                  )}
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
                    step={0.1}
                    value={newAvgSlope}
                    onChange={(e) => setNewAvgSlope(Number(e.target.value))}
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm font-mono tabular-nums text-slate-900 dark:text-white"
                  />
                </div>

                <div className="flex flex-col justify-center gap-2 pt-2">
                  <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-800 dark:text-slate-200 cursor-pointer min-h-[36px]">
                    <input
                      type="checkbox"
                      checked={newHasEredes}
                      onChange={(e) => setNewHasEredes(e.target.checked)}
                      className="w-4 h-4 rounded accent-[#14532D]"
                    />
                    Linha aérea E-REDES atravessa o lote (deduz servidão)
                  </label>
                  <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-800 dark:text-slate-200 cursor-pointer min-h-[36px]">
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

              {/* Vertices WGS84 + Interactive Map Polygon Drawer */}
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    htmlFor="new-parcel-vertices"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
                  >
                    Vértices WGS84 (latitude, longitude por linha)
                  </label>
                  <button
                    type="button"
                    data-testid="open-new-polygon-map-btn"
                    onClick={() => setPolygonMapTarget({ mode: 'new' })}
                    className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#14532D]/10 dark:bg-[#22C55E]/15 border border-[#14532D] dark:border-[#22C55E] text-xs font-semibold text-[#14532D] dark:text-[#4ADE80] hover:bg-[#14532D]/20 dark:hover:bg-[#22C55E]/25 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                  >
                    <PenTool className="w-3.5 h-3.5" aria-hidden="true" />
                    Desenhar Propriedade no Mapa
                  </button>
                </div>
                <textarea
                  id="new-parcel-vertices"
                  rows={4}
                  value={newVerticesRaw}
                  onChange={(e) => setNewVerticesRaw(e.target.value)}
                  placeholder={'38.798050, -9.462580\n38.798760, -9.462520\n38.798790, -9.461640'}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs font-mono tabular-nums text-slate-900 dark:text-white"
                />
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Pode introduzir coordenadas manualmente ou abrir o mapa interativo para clicar e arrastar os vértices da propriedade (se ficar vazio gera polígono padrão em {selectedNewMuni.name}).
                </p>
              </div>

              {/* User Notes for Downstream Local LLM Extraction & Processing */}
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    htmlFor="new-parcel-user-notes"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
                  >
                    Notas do Utilizador (Extração & Tratamento por Local LLM)
                  </label>
                  <span className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                    {newUserNotes.length} / 2000 carateres
                  </span>
                </div>
                <textarea
                  id="new-parcel-user-notes"
                  rows={3}
                  maxLength={2000}
                  value={newUserNotes}
                  onChange={(e) => setNewUserNotes(e.target.value)}
                  placeholder="Registe confrontações, acessos de trator, muros de pedra, marcos cadastrais, espécies observadas ou condicionantes no terreno para extração estruturada por modelo local (Local LLM)..."
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white leading-relaxed"
                />
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Guardado localmente (IndexedDB) e sincronizado automaticamente para posterior extração estruturada por Local LLM no dispositivo, sem envio para chatbots externos.
                </p>
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
                            Distrito: {parcel.district || findMunicipalityByDico(parcel.dico, allMunicipalities).district}
                          </span>
                          <span aria-hidden="true">·</span>
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
                        {parcel.userNotes?.trim() && (
                          <div
                            data-testid={`parcel-llm-notes-${parcel.id}`}
                            className="pt-2 text-xs text-slate-600 dark:text-slate-300 leading-relaxed"
                          >
                            <span className="font-semibold text-slate-800 dark:text-slate-200">
                              Notas de Campo (Local LLM ·{' '}
                              <span className="font-mono">
                                {buildParcelLocalLlmNotePayload(parcel).schemaVersion}
                              </span>
                              ):
                            </span>{' '}
                            <span>{parcel.userNotes}</span>
                          </div>
                        )}
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
                              htmlFor={`edit-district-${parcel.id}`}
                              className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                            >
                              Distrito
                            </label>
                            <select
                              id={`edit-district-${parcel.id}`}
                              value={editDistrict}
                              onChange={(e) => handleEditDistrictChange(e.target.value)}
                              className="w-full min-h-[42px] px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
                            >
                              {districtsList.map((dist) => (
                                <option key={dist} value={dist}>
                                  {dist}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div>
                            <label
                              htmlFor={`edit-dico-${parcel.id}`}
                              className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                            >
                              Concelho (DICO · {editMunicipalitiesForDistrict.length} no distrito)
                            </label>
                            <select
                              id={`edit-dico-${parcel.id}`}
                              value={editDico}
                              onChange={(e) => handleEditDicoChange(e.target.value)}
                              className="w-full min-h-[42px] px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
                            >
                              {editMunicipalitiesForDistrict.map((m) => (
                                <option key={m.dico} value={m.dico}>
                                  {m.name} ({m.dico})
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="space-y-2">
                            <div>
                              <label
                                htmlFor={`edit-parish-${parcel.id}`}
                                className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                              >
                                Freguesia ({selectedEditMuni.name} · {editParishesForMuni.length} no concelho)
                              </label>
                              <select
                                id={`edit-parish-${parcel.id}`}
                                value={editParishOption}
                                onChange={(e) => setEditParishOption(e.target.value)}
                                className="w-full min-h-[42px] px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
                              >
                                {editParishesForMuni.map((parishName) => (
                                  <option key={parishName} value={parishName}>
                                    {parishName}
                                  </option>
                                ))}
                                <option value={CUSTOM_USER_INPUT_VALUE}>
                                  Input do utilizador (inserir manualmente)
                                </option>
                              </select>
                            </div>
                            {editParishOption === CUSTOM_USER_INPUT_VALUE && (
                              <div>
                                <label
                                  htmlFor={`edit-parish-custom-${parcel.id}`}
                                  className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1"
                                >
                                  Freguesia (Input do utilizador)
                                </label>
                                <input
                                  id={`edit-parish-custom-${parcel.id}`}
                                  type="text"
                                  value={editParishCustom}
                                  onChange={(e) => setEditParishCustom(e.target.value)}
                                  placeholder={`Ex.: Freguesia em ${selectedEditMuni.name}`}
                                  className="w-full min-h-[40px] px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
                                />
                              </div>
                            )}
                          </div>

                          <div className="space-y-2">
                            <div>
                              <label
                                htmlFor={`edit-matrix-${parcel.id}`}
                                className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                              >
                                Artigo Matricial
                              </label>
                              <select
                                id={`edit-matrix-${parcel.id}`}
                                value={editMatrixOption}
                                onChange={(e) => setEditMatrixOption(e.target.value)}
                                className="w-full min-h-[42px] px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
                              >
                                {editMatrixOptions.map((opt) => (
                                  <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                            {editMatrixOption === CUSTOM_USER_INPUT_VALUE && (
                              <div>
                                <label
                                  htmlFor={`edit-matrix-custom-${parcel.id}`}
                                  className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1"
                                >
                                  Artigo Matricial (Input do utilizador)
                                </label>
                                <input
                                  id={`edit-matrix-custom-${parcel.id}`}
                                  type="text"
                                  value={editMatrixCustom}
                                  onChange={(e) => setEditMatrixCustom(e.target.value)}
                                  placeholder="Ex.: Rústico — Art.º 508, Secção E"
                                  className="w-full min-h-[40px] px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
                                />
                              </div>
                            )}
                          </div>

                          <div className="space-y-2">
                            <div>
                              <label
                                htmlFor={`edit-bupi-${parcel.id}`}
                                className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                              >
                                Código BUPi (RGG)
                              </label>
                              <select
                                id={`edit-bupi-${parcel.id}`}
                                value={editBupiOption}
                                onChange={(e) => setEditBupiOption(e.target.value)}
                                className="w-full min-h-[42px] px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs font-mono text-slate-900 dark:text-white"
                              >
                                {editBupiOptions.map((opt) => (
                                  <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                            {editBupiOption === CUSTOM_USER_INPUT_VALUE && (
                              <div>
                                <label
                                  htmlFor={`edit-bupi-custom-${parcel.id}`}
                                  className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1"
                                >
                                  Código BUPi (Input do utilizador)
                                </label>
                                <input
                                  id={`edit-bupi-custom-${parcel.id}`}
                                  type="text"
                                  value={editBupiCustom}
                                  onChange={(e) => setEditBupiCustom(e.target.value)}
                                  placeholder="Ex.: RGG-2026-41290"
                                  className="w-full min-h-[40px] px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs font-mono text-slate-900 dark:text-white"
                                />
                              </div>
                            )}
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
                              step={0.1}
                              value={editSlope}
                              onChange={(e) => setEditSlope(Number(e.target.value))}
                              className="w-full min-h-[42px] px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs font-mono tabular-nums text-slate-900 dark:text-white"
                            />
                          </div>

                          <div className="flex flex-col justify-center gap-1.5 pt-2">
                            <label className="inline-flex items-center gap-2 text-xs text-slate-800 dark:text-slate-200 cursor-pointer min-h-[34px]">
                              <input
                                type="checkbox"
                                checked={editHasEredes}
                                onChange={(e) => setEditHasEredes(e.target.checked)}
                                className="w-4 h-4 rounded accent-[#14532D]"
                              />
                              Linha aérea E-REDES presente
                            </label>
                            <label className="inline-flex items-center gap-2 text-xs text-slate-800 dark:text-slate-200 cursor-pointer min-h-[34px]">
                              <input
                                type="checkbox"
                                checked={editHasOaks}
                                onChange={(e) => setEditHasOaks(e.target.checked)}
                                className="w-4 h-4 rounded accent-[#14532D]"
                              />
                              Sobreiros / Azinheiras protegidos
                            </label>
                          </div>
                        </div>

                        {/* Vértices WGS84 + Desenhar / Editar Propriedade no Mapa */}
                        <div className="space-y-1.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <label
                              htmlFor={`edit-vertices-${parcel.id}`}
                              className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
                            >
                              Vértices WGS84 (latitude, longitude por linha)
                            </label>
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                data-testid={`open-edit-polygon-map-${parcel.id}`}
                                onClick={() => setPolygonMapTarget({ mode: 'edit', parcel })}
                                className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#14532D]/10 dark:bg-[#22C55E]/15 border border-[#14532D] dark:border-[#22C55E] text-xs font-semibold text-[#14532D] dark:text-[#4ADE80] hover:bg-[#14532D]/20 dark:hover:bg-[#22C55E]/25 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                              >
                                <PenTool className="w-3.5 h-3.5" aria-hidden="true" />
                                Desenhar / Editar Propriedade no Mapa
                              </button>
                              <button
                                type="button"
                                onClick={() => setShowEditVertices((v) => !v)}
                                className="text-xs font-semibold text-slate-600 dark:text-slate-400 underline whitespace-nowrap"
                              >
                                {showEditVertices ? 'Ocultar lista' : 'Mostrar lista'}
                              </button>
                            </div>
                          </div>
                          {showEditVertices && (
                            <textarea
                              id={`edit-vertices-${parcel.id}`}
                              rows={4}
                              value={editVerticesRaw}
                              onChange={(e) => {
                                setEditVerticesRaw(e.target.value);
                                setEditVerticesTouched(true);
                              }}
                              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs font-mono tabular-nums text-slate-900 dark:text-white"
                            />
                          )}
                        </div>

                        {/* User Notes for Downstream Local LLM Extraction & Processing */}
                        <div className="space-y-1.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <label
                              htmlFor={`edit-user-notes-${parcel.id}`}
                              className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
                            >
                              Notas do Utilizador (Extração & Tratamento por Local LLM)
                            </label>
                            <span className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                              {editUserNotes.length} / 2000 carateres
                            </span>
                          </div>
                          <textarea
                            id={`edit-user-notes-${parcel.id}`}
                            rows={3}
                            maxLength={2000}
                            value={editUserNotes}
                            onChange={(e) => setEditUserNotes(e.target.value)}
                            placeholder="Registe notas de terreno, confrontações, marcos BUPi, obstáculos de acesso ou vegetação para extração e tratamento posterior por Local LLM..."
                            className="w-full px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white leading-relaxed"
                          />
                        </div>

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
                    {allMunicipalities.map((m) => (
                      <option key={m.dico} value={m.dico}>
                        {m.name} ({m.district} · {m.dico})
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
                Sessão, Armazenamento Offline & Sincronização Automática
              </h2>
              <div className="text-xs text-slate-600 dark:text-slate-300 space-y-1 tabular-nums">
                <p>
                  Motor local ativo:{' '}
                  <strong className="font-mono text-slate-900 dark:text-white">
                    {storageBackend === 'indexeddb' ? 'IndexedDB' : 'localStorage'}
                  </strong>{' '}
                  · Ligação: <strong>{isOnline ? 'Online (Sincronia Automática Ativa)' : 'Offline no Terreno (Fila Automática)'}</strong>
                </p>
                <p>
                  Operações pendentes na fila de sincronia:{' '}
                  <strong className="font-mono text-slate-900 dark:text-white">
                    {pendingSyncCount}
                  </strong>
                  {lastSyncedAtIso
                    ? ` · Última sincronização automática: ${new Date(lastSyncedAtIso).toLocaleTimeString('pt-PT')}`
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

            {/* Quick Link to Dedicated Theme & Dark Mode Setting */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248] p-3.5">
              <div className="space-y-0.5">
                <div className="text-xs font-semibold text-slate-900 dark:text-white">
                  Tema Visual · {darkMode ? 'Modo Escuro ativo' : 'Modo Solar (Claro) ativo'}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Configure o Modo Escuro na definição dedicada de Tema da Galeria User.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSubTab('theme')}
                className="min-h-[40px] px-3.5 py-2 rounded-xl border border-slate-300 dark:border-[#263248] bg-white dark:bg-[#161E2E] text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                {darkMode ? (
                  <Moon className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
                ) : (
                  <Sun className="w-3.5 h-3.5 text-amber-500" aria-hidden="true" />
                )}
                Abrir Definição de Tema
              </button>
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
              <div className="flex items-center justify-between gap-3 min-h-[40px] text-xs text-slate-800 dark:text-slate-200">
                <span>Sincronia offline/online automática (IndexedDB, API & Cloud)</span>
                <span className="font-mono font-semibold text-[#14532D] dark:text-[#4ADE80] shrink-0">
                  Permanente
                </span>
              </div>

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

      {/* ==================== SETTING DEDICADO: TEMA & MODO ESCURO ==================== */}
      {subTab === 'theme' && (
        <div
          data-testid="user-theme-settings-panel"
          className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start"
        >
          <section className="lg:col-span-7 rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-5">
            <div className="pb-3 border-b border-slate-200 dark:border-[#263248] space-y-1">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Preferência guardada automaticamente neste dispositivo ·{' '}
                <span className="font-semibold text-slate-900 dark:text-white">
                  {darkMode ? 'Modo Escuro ativo' : 'Modo Solar (Claro) ativo'}
                </span>
              </div>
              <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
                Tema da Aplicação & Modo Escuro
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                Escolha entre o Modo Escuro para trabalho em gabinete, vigia noturna e menor fadiga
                ocular, ou o Modo Solar de alto contraste para leitura direta no terreno sob sol intenso.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <button
                type="button"
                data-testid="theme-select-light-btn"
                aria-pressed={!darkMode}
                onClick={() => onToggleDarkMode(false)}
                className={`text-left rounded-xl p-4 border space-y-2.5 min-h-[124px] flex flex-col justify-between ${
                  !darkMode
                    ? 'border-[#14532D] dark:border-[#22C55E] bg-slate-50 dark:bg-[#0B0F17]'
                    : 'border-slate-300 dark:border-[#263248] bg-white dark:bg-[#161E2E] hover:border-slate-400 dark:hover:border-slate-600'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
                    <Sun className="w-4 h-4 text-amber-500 shrink-0" aria-hidden="true" />
                    Modo Solar (Claro)
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 text-xs font-semibold ${
                      !darkMode
                        ? 'text-[#14532D] dark:text-[#22C55E]'
                        : 'text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    {!darkMode && <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />}
                    {!darkMode ? 'Ativo' : 'Selecionar'}
                  </span>
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                  Fundo claro de elevada luminância otimizado para inspeção de faixas no exterior sob
                  luz solar direta.
                </p>
              </button>

              <button
                type="button"
                data-testid="theme-select-dark-btn"
                aria-pressed={darkMode}
                onClick={() => onToggleDarkMode(true)}
                className={`text-left rounded-xl p-4 border space-y-2.5 min-h-[124px] flex flex-col justify-between ${
                  darkMode
                    ? 'border-[#14532D] dark:border-[#22C55E] bg-slate-50 dark:bg-[#0B0F17]'
                    : 'border-slate-300 dark:border-[#263248] bg-white dark:bg-[#161E2E] hover:border-slate-400 dark:hover:border-slate-600'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
                    <Moon className="w-4 h-4 text-sky-400 shrink-0" aria-hidden="true" />
                    Modo Escuro (Noite)
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 text-xs font-semibold ${
                      darkMode
                        ? 'text-[#14532D] dark:text-[#22C55E]'
                        : 'text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    {darkMode && <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />}
                    {darkMode ? 'Ativo' : 'Selecionar'}
                  </span>
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                  Superfícies ardósia escura (#0B0F17 / #161E2E) com compensação ótica para conforto
                  noturno e autonomia em ecrãs OLED.
                </p>
              </button>
            </div>

            <div className="pt-4 border-t border-slate-200 dark:border-[#263248] flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-0.5">
                <div className="text-xs font-semibold text-slate-900 dark:text-white">
                  Alternar Modo Escuro Imediatamente
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Aplica-se a todas as vistas (Hoje, Mapa & Faixas, Prestadores e Área do Utilizador).
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="toggle-dark-mode-setting-btn"
                  onClick={() => onToggleDarkMode(!darkMode)}
                  className="min-h-[42px] px-4 py-2 rounded-xl bg-[#14532D] dark:bg-[#22C55E] text-white dark:text-slate-950 text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  {darkMode ? (
                    <>
                      <Sun className="w-3.5 h-3.5" aria-hidden="true" />
                      Mudar para Modo Solar
                    </>
                  ) : (
                    <>
                      <Moon className="w-3.5 h-3.5" aria-hidden="true" />
                      Ativar Modo Escuro
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
                      onToggleDarkMode(window.matchMedia('(prefers-color-scheme: dark)').matches);
                    }
                  }}
                  className="min-h-[42px] px-3.5 py-2 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                >
                  Sincronizar com Sistema
                </button>
              </div>
            </div>
          </section>

          <section className="lg:col-span-5 rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] overflow-hidden">
            <div className="h-44 w-full bg-slate-100 dark:bg-[#0B0F17] border-b border-slate-200 dark:border-[#263248] flex flex-col items-center justify-center gap-2.5 p-4">
              <div className="w-20 h-20 rounded-2xl bg-[#14532D] border border-[#22C55E]/40 overflow-hidden flex items-center justify-center">
                <img
                  src={faixaSeguraLogoImg}
                  alt="Ícone PWA FaixaSegura com perímetros geométricos"
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    e.currentTarget.classList.add('hidden');
                  }}
                />
              </div>
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                Ícone PWA FaixaSegura · Limites Geométricos SGIFR
              </span>
            </div>
            <div className="p-5 space-y-3">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                Identidade Visual & Calibração Cromática (WCAG AA)
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                As cores semânticas oficiais do semáforo IPMA (RCM 1–5) e as faixas concêntricas de
                0–2 m, 2–10 m e 10–50 m/100 m mantêm contraste mínimo de 4.5:1 tanto em Modo Solar
                como em Modo Escuro.
              </p>
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

      {/* Interactive Leaflet Map Modal for Drawing & Editing Parcel Polygon Vertices */}
      {polygonMapTarget && (
        <ParcelPolygonMapModal
          isOpen={Boolean(polygonMapTarget)}
          parcelId={
            polygonMapTarget.mode === 'edit' ? polygonMapTarget.parcel.id : 'new-parcel-draft'
          }
          parcelLabel={
            polygonMapTarget.mode === 'edit'
              ? editLabel.trim() || polygonMapTarget.parcel.label
              : newLabel.trim() || 'Nova Propriedade em Registo'
          }
          municipality={
            polygonMapTarget.mode === 'edit' ? selectedEditMuni : selectedNewMuni
          }
          landClass={polygonMapTarget.mode === 'edit' ? editLandClass : newLandClass}
          hasEredesLine={polygonMapTarget.mode === 'edit' ? editHasEredes : newHasEredes}
          initialVertices={(() => {
            if (polygonMapTarget.mode === 'edit') {
              if (editVerticesRaw.trim()) {
                const parsed = parseVerticesMultiline(editVerticesRaw);
                if (parsed.valid) return parsed.vertices;
              }
              return polygonMapTarget.parcel.vertices;
            }
            if (newVerticesRaw.trim()) {
              const parsed = parseVerticesMultiline(newVerticesRaw);
              if (parsed.valid) return parsed.vertices;
            }
            return buildDefaultRectangleAroundCenter(selectedNewMuni.defaultCenter);
          })()}
          onClose={() => setPolygonMapTarget(null)}
          onApplyVertices={(appliedVertices) => {
            const formatted = formatVerticesMultiline(appliedVertices);
            if (polygonMapTarget.mode === 'edit') {
              setEditVerticesRaw(formatted);
              setEditVerticesTouched(true);
              setShowEditVertices(true);
              setEditParcelError(null);
            } else {
              setNewVerticesRaw(formatted);
              setAddParcelError(null);
            }
            setPolygonMapTarget(null);
          }}
        />
      )}
    </div>
  );
};
