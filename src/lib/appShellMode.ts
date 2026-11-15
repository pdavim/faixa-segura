import type { UserAccountProfile } from '../types/domain.ts';

export type EntryExperienceMode = 'WEBVIEW_HOMEPAGE' | 'WEBAPP_ONBOARDING';
export type EntryModeOverride = 'webview' | 'webapp' | null;
export type AuthSessionKind = 'GOOGLE_CLOUD' | 'LOCAL_FIELD';

export interface DetectEntryModeInput {
  search?: string;
  isStandaloneDisplay?: boolean;
  navigatorStandalone?: boolean;
  referrer?: string;
  overrideMode?: EntryModeOverride;
}

export interface OnboardingSlideSpec {
  stepNumber: string;
  title: string;
  subtitle: string;
  legalAnchor: string;
  metricValue: string;
  metricContext: string;
}

export const LOCAL_AUTH_STORAGE_KEY = 'fs_auth_local_session_v1';

export const ONBOARDING_SLIDES: OnboardingSlideSpec[] = [
  {
    stepNumber: '01',
    title: 'Semáforo Operacional antes de ligar maquinaria',
    subtitle:
      'Consulte diariamente o índice IPMA RCM (1 a 5), a humidade estimada do solo e ocorrências ANEPC num raio de 15 km para saber se pode usar lâmina metálica, fio de nylon ou se a intervenção está interdita.',
    legalAnchor: 'Art.º 68.º do Decreto-Lei n.º 82/2021 (SGIFR)',
    metricValue: 'RCM 1–5',
    metricContext: 'Validação diária automática por concelho (DICO)',
  },
  {
    stepNumber: '02',
    title: 'Raio-X métrico das faixas 0–2 m, 2–10 m e 10–50 m',
    subtitle:
      'Visualize o polígono BUPi na projeção oficial ETRS89 / PT-TM06 (EPSG:3763), sobreponha o vigor vegetativo Sentinel-2 (NDVI), deduza servidões E-REDES e exporte os vértices em GeoJSON.',
    legalAnchor: 'Despacho n.º 675/2026 · Cartografia EPSG:3763',
    metricValue: '2 844 m²',
    metricContext: 'Área real exigível auditada num lote tipo de 6 354 m²',
  },
  {
    stepNumber: '03',
    title: 'Auto PDF SHA-256 e continuidade total sem rede',
    subtitle:
      'Emita o certificado A4 de conformidade com selo temporal UTC e hash SHA-256 verificável, peça 3 orçamentos a equipas credenciadas e guarde tudo em IndexedDB com sincronização automática para Firestore.',
    legalAnchor: 'Prova documental verificável · IndexedDB + Cloud',
    metricValue: 'SHA-256',
    metricContext: 'Integridade criptográfica para seguradoras, GNR e município',
  },
];

/**
 * Determines whether an unauthenticated visitor should see the browser Homepage ('WEBVIEW_HOMEPAGE')
 * or the installed PWA / mobile WebApp Splash + Onboarding flow ('WEBAPP_ONBOARDING').
 */
export function detectEntryExperienceMode(input: DetectEntryModeInput): EntryExperienceMode {
  if (input.overrideMode === 'webapp') {
    return 'WEBAPP_ONBOARDING';
  }
  if (input.overrideMode === 'webview') {
    return 'WEBVIEW_HOMEPAGE';
  }

  const rawSearch = (input.search ?? '').trim();
  if (rawSearch) {
    const params = new URLSearchParams(rawSearch.startsWith('?') ? rawSearch : `?${rawSearch}`);
    const modeParam = (params.get('mode') ?? '').toLowerCase();
    if (modeParam === 'webapp' || modeParam === 'pwa' || params.get('pwa') === '1') {
      return 'WEBAPP_ONBOARDING';
    }
    if (modeParam === 'webview' || modeParam === 'web') {
      return 'WEBVIEW_HOMEPAGE';
    }
  }

  if (input.isStandaloneDisplay === true || input.navigatorStandalone === true) {
    return 'WEBAPP_ONBOARDING';
  }

  if ((input.referrer ?? '').startsWith('android-app://')) {
    return 'WEBAPP_ONBOARDING';
  }

  return 'WEBVIEW_HOMEPAGE';
}

/**
 * Supports `?autostart=1` so automated verification or direct deep-links can skip straight
 * to the authenticated workspace using the deterministic demo profile.
 */
export function shouldAutoStartWorkspace(search: string): boolean {
  const clean = search.trim();
  if (!clean) return false;
  const params = new URLSearchParams(clean.startsWith('?') ? clean : `?${clean}`);
  const val = (params.get('autostart') ?? '').toLowerCase();
  return val === '1' || val === 'true';
}

export function buildDefaultDemoProfile(preferredDico = '1111'): UserAccountProfile {
  const digits = preferredDico.replace(/\D/g, '');
  return {
    uid: 'local-proprietario-demo',
    displayName: 'João Conceição Magalhães',
    email: 'joao.magalhaes@faixasegura.local',
    preferredDico: digits.length === 4 ? digits : '1111',
    nif: '218492310',
    phone: '+351 912 345 678',
  };
}

export interface LocalSessionValidationResult {
  valid: boolean;
  error?: string;
  sanitizedName: string;
  sanitizedNif: string;
}

export function validateLocalSessionInput(params: {
  displayName: string;
  nif?: string;
}): LocalSessionValidationResult {
  const sanitizedName = params.displayName.trim().replace(/\s+/g, ' ');
  const rawNif = (params.nif ?? '').trim();
  const digitsOnlyNif = rawNif.replace(/\D/g, '');

  if (sanitizedName.length < 2) {
    return {
      valid: false,
      error: 'Indique o nome do titular ou responsável (mínimo 2 caracteres).',
      sanitizedName,
      sanitizedNif: digitsOnlyNif,
    };
  }

  if (sanitizedName.length > 100) {
    return {
      valid: false,
      error: 'O nome indicado excede o limite de 100 caracteres.',
      sanitizedName: sanitizedName.slice(0, 100),
      sanitizedNif: digitsOnlyNif,
    };
  }

  if (rawNif.length > 0 && !/^\d{9}$/.test(digitsOnlyNif)) {
    return {
      valid: false,
      error: 'O NIF é opcional, mas quando preenchido deve conter exatamente 9 dígitos numéricos.',
      sanitizedName,
      sanitizedNif: digitsOnlyNif,
    };
  }

  return {
    valid: true,
    sanitizedName,
    sanitizedNif: digitsOnlyNif,
  };
}

export function buildLocalSessionProfile(params: {
  displayName: string;
  nif?: string;
  preferredDico?: string;
}): UserAccountProfile {
  const validated = validateLocalSessionInput({
    displayName: params.displayName,
    nif: params.nif,
  });
  if (!validated.valid) {
    throw new Error(validated.error || 'Dados de sessão local inválidos.');
  }

  const slug = validated.sanitizedName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

  const digitsDico = (params.preferredDico ?? '').replace(/\D/g, '');

  return {
    uid: `local-${slug || 'titular'}`,
    displayName: validated.sanitizedName,
    email: `${slug || 'titular'}@sessao-local.faixasegura.pt`,
    preferredDico: digitsDico.length === 4 ? digitsDico : '1111',
    nif: validated.sanitizedNif,
    phone: '',
  };
}

export interface MinimalKeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function resolveDefaultStorage(): MinimalKeyValueStorage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignore storage security errors in sandboxed contexts
  }
  return null;
}

export function saveLocalAuthSession(
  profile: UserAccountProfile,
  storage: MinimalKeyValueStorage | null = resolveDefaultStorage()
): void {
  if (!storage) return;
  try {
    storage.setItem(LOCAL_AUTH_STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Ignore quota errors
  }
}

export function loadLocalAuthSession(
  storage: MinimalKeyValueStorage | null = resolveDefaultStorage()
): UserAccountProfile | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(LOCAL_AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UserAccountProfile>;
    if (
      typeof parsed?.uid !== 'string' ||
      typeof parsed?.displayName !== 'string' ||
      parsed.displayName.trim().length < 2
    ) {
      return null;
    }
    return {
      uid: parsed.uid,
      displayName: parsed.displayName.trim(),
      email: typeof parsed.email === 'string' ? parsed.email : 'titular@sessao-local.faixasegura.pt',
      preferredDico: typeof parsed.preferredDico === 'string' ? parsed.preferredDico : '1111',
      nif: typeof parsed.nif === 'string' ? parsed.nif : '',
      phone: typeof parsed.phone === 'string' ? parsed.phone : '',
    };
  } catch {
    return null;
  }
}

export function clearLocalAuthSession(
  storage: MinimalKeyValueStorage | null = resolveDefaultStorage()
): void {
  if (!storage) return;
  try {
    storage.removeItem(LOCAL_AUTH_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}
