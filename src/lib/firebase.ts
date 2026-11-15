import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import type {
  ParcelRecord,
  PirLevel,
  UserAccountProfile,
  UserHistoryCategory,
  UserHistoryRecord,
} from '../types/domain.ts';

interface FirebaseAppletConfig {
  projectId: string;
  appId: string;
  apiKey: string;
  authDomain: string;
  firestoreDatabaseId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  measurementId?: string;
  oAuthClientId?: string;
  recaptchaSiteKey?: string;
}

const bundledConfigs = import.meta.glob('../../firebase-applet-config.json', {
  eager: true,
  import: 'default',
}) as Record<string, Partial<FirebaseAppletConfig>>;

const fileConfig: Partial<FirebaseAppletConfig> = Object.values(bundledConfigs)[0] ?? {};
const env = (import.meta.env ?? {}) as Record<string, string | undefined>;

const firebaseConfig: FirebaseAppletConfig = {
  projectId: env.VITE_FIREBASE_PROJECT_ID || fileConfig.projectId || 'demo-faixasegura',
  appId: env.VITE_FIREBASE_APP_ID || fileConfig.appId || '1:000000000000:web:000000000000',
  apiKey: env.VITE_FIREBASE_API_KEY || fileConfig.apiKey || '',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || fileConfig.authDomain || 'localhost',
  firestoreDatabaseId: env.VITE_FIREBASE_DATABASE_ID || fileConfig.firestoreDatabaseId || '(default)',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || fileConfig.storageBucket || '',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || fileConfig.messagingSenderId || '',
};

export const isFirebaseConfigured = Boolean(firebaseConfig.apiKey);

const app = isFirebaseConfigured ? initializeApp(firebaseConfig) : null;
export const db = app
  ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
  : (null as unknown as ReturnType<typeof getFirestore>);
export const auth = app
  ? getAuth(app)
  : (null as unknown as ReturnType<typeof getAuth>);

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Validate connection to Firestore on boot per Firebase Integration specification
async function testConnection(): Promise<void> {
  if (!isFirebaseConfigured || !db) return;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();

// Blueprint-synchronized defensive sanitization helpers
const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

function sanitizeSafeId(raw: string, fallbackPrefix = 'id'): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 128);
  if (cleaned.length >= 1 && SAFE_ID_REGEX.test(cleaned)) {
    return cleaned;
  }
  return `${fallbackPrefix}-${Date.now()}`;
}

function clampString(val: string | undefined | null, minLen: number, maxLen: number, fallback: string): string {
  const trimmed = (val ?? '').trim();
  const base = trimmed.length >= minLen ? trimmed : fallback;
  return base.slice(0, maxLen);
}

function sanitizeDico(raw: string | undefined): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits.length === 4 ? digits : '1111';
}

export function subscribeAuthState(
  authInstance: typeof auth,
  callback: (user: User | null) => void
): Unsubscribe {
  if (!isFirebaseConfigured || !authInstance) {
    queueMicrotask(() => callback(null));
    return () => {};
  }
  return onAuthStateChanged(authInstance, callback);
}

export { subscribeAuthState as onAuthStateChanged, type User };

export async function signInWithGooglePopup(): Promise<User> {
  if (!isFirebaseConfigured || !auth) {
    throw new Error('Autenticação Google não configurada nesta instância Docker (defina VITE_FIREBASE_API_KEY).');
  }
  const cred = await signInWithPopup(auth, googleProvider);
  return cred.user;
}

export async function signOutCurrentUser(): Promise<void> {
  if (!isFirebaseConfigured || !auth) return;
  await signOut(auth);
}

/**
 * Ensures the authenticated user's non-PII anchor (/users/{uid}) and isolated PII
 * document (/users/{uid}/private/profile) exist, returning the hydrated profile.
 */
export async function ensureUserAnchorAndProfile(
  user: User,
  defaultDico = '1111'
): Promise<UserAccountProfile> {
  const uid = sanitizeSafeId(user.uid, 'usr');
  const publicPath = `users/${uid}`;
  const privatePath = `users/${uid}/private/profile`;

  const publicRef = doc(db, 'users', uid);
  const privateRef = doc(db, 'users', uid, 'private', 'profile');

  let publicSnap;
  try {
    publicSnap = await getDoc(publicRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, publicPath);
  }

  const displayName = clampString(
    user.displayName || user.email?.split('@')[0],
    1,
    100,
    'Proprietário FaixaSegura'
  );
  const email = clampString(user.email, 3, 160, 'utilizador@faixasegura.pt');
  const preferredDico = sanitizeDico(defaultDico);

  if (!publicSnap.exists()) {
    try {
      const batch = writeBatch(db);
      batch.set(publicRef, {
        uid,
        displayName,
        preferredDico,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.set(privateRef, {
        uid,
        email,
        nif: '',
        phone: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, publicPath);
    }

    return {
      uid,
      displayName,
      email,
      preferredDico,
      nif: '',
      phone: '',
    };
  }

  let privateSnap;
  try {
    privateSnap = await getDoc(privateRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, privatePath);
  }

  const pubData = publicSnap.data();
  const privData = privateSnap.exists() ? privateSnap.data() : null;

  if (!privData) {
    try {
      await setDoc(privateRef, {
        uid,
        email,
        nif: '',
        phone: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, privatePath);
    }
  }

  return {
    uid,
    displayName: typeof pubData?.displayName === 'string' ? pubData.displayName : displayName,
    preferredDico: typeof pubData?.preferredDico === 'string' ? pubData.preferredDico : preferredDico,
    email: typeof privData?.email === 'string' ? privData.email : email,
    nif: typeof privData?.nif === 'string' ? privData.nif : '',
    phone: typeof privData?.phone === 'string' ? privData.phone : '',
  };
}

export async function updateUserContactProfile(params: {
  uid: string;
  displayName: string;
  preferredDico: string;
  email: string;
  nif: string;
  phone: string;
}): Promise<void> {
  const uid = sanitizeSafeId(params.uid, 'usr');
  const publicPath = `users/${uid}`;
  const privatePath = `users/${uid}/private/profile`;

  const cleanName = clampString(params.displayName, 1, 100, 'Proprietário FaixaSegura');
  const cleanDico = sanitizeDico(params.preferredDico);
  const cleanEmail = clampString(params.email, 3, 160, 'utilizador@faixasegura.pt');
  const cleanNif = params.nif.replace(/\D/g, '').slice(0, 9);
  const cleanPhone = params.phone.trim().slice(0, 24);

  try {
    await updateDoc(doc(db, 'users', uid), {
      displayName: cleanName,
      preferredDico: cleanDico,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, publicPath);
  }

  try {
    await updateDoc(doc(db, 'users', uid, 'private', 'profile'), {
      email: cleanEmail,
      nif: cleanNif,
      phone: cleanPhone,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, privatePath);
  }
}

export interface CreateHistoryEntryInput {
  uid: string;
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
}

export async function recordUserHistoryEntry(input: CreateHistoryEntryInput): Promise<string> {
  const uid = sanitizeSafeId(input.uid, 'usr');
  const entryId = sanitizeSafeId(
    `hist-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    'hist'
  );
  const path = `users/${uid}/history/${entryId}`;

  const payload = {
    uid,
    category: input.category,
    title: clampString(input.title, 2, 140, 'Registo Operacional FaixaSegura'),
    parcelId: sanitizeSafeId(input.parcelId, 'parcel'),
    parcelLabel: clampString(input.parcelLabel, 1, 120, 'Terreno Registado'),
    municipality: clampString(input.municipality, 2, 80, 'Sintra'),
    referenceCode: clampString(input.referenceCode, 1, 64, entryId.slice(0, 16).toUpperCase()),
    areaM2: Math.max(0, Math.min(100_000_000, Number(input.areaM2) || 0)),
    pirLevel: Math.max(1, Math.min(5, Math.round(Number(input.pirLevel) || 2))),
    soilMoisturePct: Math.max(0, Math.min(100, Number(Number(input.soilMoisturePct || 22).toFixed(1)))),
    summary: clampString(input.summary, 2, 500, 'Registo guardado no histórico pessoal.'),
    status: 'ACTIVE' as const,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(doc(db, 'users', uid, 'history', entryId), payload);
    return entryId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function syncHistoryEntryToCloud(
  uidRaw: string,
  entry: UserHistoryRecord
): Promise<void> {
  if (!isFirebaseConfigured || !db) {
    throw new Error('Ligação Firestore indisponível (offline ou configuração ausente).');
  }

  const uid = sanitizeSafeId(uidRaw, 'usr');
  const entryId = sanitizeSafeId(entry.id, 'hist');
  const path = `users/${uid}/history/${entryId}`;
  const entryRef = doc(db, 'users', uid, 'history', entryId);

  let existingSnap;
  try {
    existingSnap = await getDoc(entryRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  if (existingSnap.exists()) {
    return;
  }

  const payload = {
    uid,
    category: entry.category,
    title: clampString(entry.title, 2, 140, 'Registo Operacional FaixaSegura'),
    parcelId: sanitizeSafeId(entry.parcelId, 'parcel'),
    parcelLabel: clampString(entry.parcelLabel, 1, 120, 'Terreno Registado'),
    municipality: clampString(entry.municipality, 2, 80, 'Sintra'),
    referenceCode: clampString(entry.referenceCode, 1, 64, entryId.slice(0, 16).toUpperCase()),
    areaM2: Math.max(0, Math.min(100_000_000, Number(entry.areaM2) || 0)),
    pirLevel: Math.max(1, Math.min(5, Math.round(Number(entry.pirLevel) || 2))),
    soilMoisturePct: Math.max(
      0,
      Math.min(100, Number(Number(entry.soilMoisturePct || 22).toFixed(1)))
    ),
    summary: clampString(entry.summary, 2, 500, 'Registo guardado no histórico pessoal.'),
    status: 'ACTIVE' as const,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(entryRef, payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function saveUserParcelToCloud(uidRaw: string, parcel: ParcelRecord): Promise<void> {
  if (!isFirebaseConfigured || !db) {
    throw new Error('Ligação Firestore indisponível (offline ou configuração ausente).');
  }

  const uid = sanitizeSafeId(uidRaw, 'usr');
  const parcelId = sanitizeSafeId(parcel.id, 'parcel');
  const path = `users/${uid}/parcels/${parcelId}`;
  const parcelRef = doc(db, 'users', uid, 'parcels', parcelId);

  let existingSnap;
  try {
    existingSnap = await getDoc(parcelRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  const label = clampString(parcel.label, 2, 120, 'Parcela BUPi');
  const municipality = clampString(parcel.municipality, 2, 80, 'Sintra');
  const dico = sanitizeDico(parcel.dico);
  const matrixArticle = clampString(parcel.matrixArticle, 1, 80, 'Rústico');
  const bupiRggId = clampString(parcel.bupiRggId, 1, 40, 'RGG-LOCAL');
  const landClass =
    parcel.landClass === 'AGRICULTURE' || parcel.landClass === 'URBAN_BUILT'
      ? parcel.landClass
      : 'FOREST_SCRUB';
  const totalAreaM2 = Math.max(1, Math.min(100_000_000, Number(parcel.spatial.totalAreaM2) || 1000));
  const mandatoryCleanAreaM2 = Math.max(
    0,
    Math.min(100_000_000, Number(parcel.spatial.mandatoryCleanAreaM2) || 0)
  );
  const avgSlopePct = Math.max(0, Math.min(100, Number(parcel.avgSlopePct) || 0));
  const hasEredesLine = Boolean(parcel.hasEredesLine);
  const hasProtectedOaks = Boolean(parcel.hasProtectedOaks);

  if (existingSnap.exists()) {
    try {
      await updateDoc(parcelRef, {
        label,
        municipality,
        dico,
        matrixArticle,
        bupiRggId,
        landClass,
        totalAreaM2,
        mandatoryCleanAreaM2,
        avgSlopePct,
        hasEredesLine,
        hasProtectedOaks,
        updatedAt: serverTimestamp(),
      });
      return;
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
  }

  try {
    await setDoc(parcelRef, {
      uid,
      parcelId,
      label,
      municipality,
      dico,
      matrixArticle,
      bupiRggId,
      landClass,
      totalAreaM2,
      mandatoryCleanAreaM2,
      avgSlopePct,
      hasEredesLine,
      hasProtectedOaks,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function deleteUserParcelFromCloud(
  uidRaw: string,
  parcelIdRaw: string
): Promise<void> {
  if (!isFirebaseConfigured || !db) {
    throw new Error('Ligação Firestore indisponível (offline ou configuração ausente).');
  }

  const uid = sanitizeSafeId(uidRaw, 'usr');
  const parcelId = sanitizeSafeId(parcelIdRaw, 'parcel');
  const path = `users/${uid}/parcels/${parcelId}`;
  const parcelRef = doc(db, 'users', uid, 'parcels', parcelId);

  let existingSnap;
  try {
    existingSnap = await getDoc(parcelRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  if (!existingSnap.exists()) {
    return;
  }

  try {
    await deleteDoc(parcelRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function archiveUserHistoryEntry(uidRaw: string, entryIdRaw: string): Promise<void> {
  if (!isFirebaseConfigured || !db) {
    throw new Error('Ligação Firestore indisponível (offline ou configuração ausente).');
  }

  const uid = sanitizeSafeId(uidRaw, 'usr');
  const entryId = sanitizeSafeId(entryIdRaw, 'hist');
  const path = `users/${uid}/history/${entryId}`;
  const entryRef = doc(db, 'users', uid, 'history', entryId);

  let existingSnap;
  try {
    existingSnap = await getDoc(entryRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  if (!existingSnap.exists() || existingSnap.data()?.status === 'ARCHIVED') {
    return;
  }

  try {
    await updateDoc(entryRef, {
      status: 'ARCHIVED',
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteUserHistoryEntry(uidRaw: string, entryIdRaw: string): Promise<void> {
  if (!isFirebaseConfigured || !db) {
    throw new Error('Ligação Firestore indisponível (offline ou configuração ausente).');
  }

  const uid = sanitizeSafeId(uidRaw, 'usr');
  const entryId = sanitizeSafeId(entryIdRaw, 'hist');
  const path = `users/${uid}/history/${entryId}`;
  const entryRef = doc(db, 'users', uid, 'history', entryId);

  let existingSnap;
  try {
    existingSnap = await getDoc(entryRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  if (!existingSnap.exists()) {
    return;
  }

  try {
    await deleteDoc(entryRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export function subscribeToUserHistory(
  uidRaw: string,
  onItems: (records: UserHistoryRecord[]) => void,
  onErrorCallback?: (message: string) => void
): Unsubscribe {
  const uid = sanitizeSafeId(uidRaw, 'usr');
  const path = `users/${uid}/history`;
  const q = query(
    collection(db, 'users', uid, 'history'),
    where('uid', '==', uid),
    orderBy('createdAt', 'desc'),
    limit(50)
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const items: UserHistoryRecord[] = snapshot.docs.map((d) => {
        const data = d.data();
        const ts = data.createdAt instanceof Timestamp ? data.createdAt.toDate() : new Date();
        return {
          id: d.id,
          uid: String(data.uid ?? uid),
          category: (data.category as UserHistoryCategory) ?? 'INTERVENTION',
          title: String(data.title ?? ''),
          parcelId: String(data.parcelId ?? ''),
          parcelLabel: String(data.parcelLabel ?? ''),
          municipality: String(data.municipality ?? ''),
          referenceCode: String(data.referenceCode ?? ''),
          areaM2: Number(data.areaM2 ?? 0),
          pirLevel: (Math.max(1, Math.min(5, Number(data.pirLevel ?? 2))) as PirLevel),
          soilMoisturePct: Number(data.soilMoisturePct ?? 0),
          summary: String(data.summary ?? ''),
          status: data.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE',
          createdAtIso: ts.toISOString(),
        };
      });
      onItems(items);
    },
    (error) => {
      onErrorCallback?.('Não foi possível sincronizar o histórico em tempo real.');
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch {
        // Structured JSON error logged by handleFirestoreError
      }
    }
  );
}
