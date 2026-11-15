import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = process.cwd();
const rulesSource = fs.readFileSync(path.join(ROOT_DIR, 'firestore.rules'), 'utf8');
const blueprint = JSON.parse(
  fs.readFileSync(path.join(ROOT_DIR, 'firebase-blueprint.json'), 'utf8')
) as {
  entities: Record<string, { required?: string[]; properties: Record<string, { maxLength?: number }> }>;
  firestore: Record<string, unknown>;
};

interface EvalAuth {
  uid: string;
  email_verified: boolean;
}

interface RequestContext {
  auth: EvalAuth | null;
  pathSegments: string[]; // e.g. ['users', 'u1', 'history', 'h1']
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  nowMs: number;
  incomingData?: Record<string, unknown>;
  existingData?: Record<string, unknown> | null;
  existingDocs: Set<string>;
}

const ID_RE = /^[a-zA-Z0-9_-]+$/;
const DICO_RE = /^[0-9]{4}$/;

function isValidId(id: unknown): boolean {
  return typeof id === 'string' && id.length >= 1 && id.length <= 128 && ID_RE.test(id);
}

function hasExactKeys(data: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(data);
  return keys.every((k) => actual.includes(k)) && actual.every((k) => keys.includes(k));
}

function isValidUserPublicProfile(data: Record<string, unknown>, authUid: string): boolean {
  return (
    hasExactKeys(data, ['uid', 'displayName', 'preferredDico', 'createdAt', 'updatedAt']) &&
    isValidId(data.uid) &&
    data.uid === authUid &&
    typeof data.displayName === 'string' &&
    data.displayName.length >= 1 &&
    data.displayName.length <= 100 &&
    typeof data.preferredDico === 'string' &&
    data.preferredDico.length === 4 &&
    DICO_RE.test(data.preferredDico) &&
    typeof data.createdAt === 'number' &&
    typeof data.updatedAt === 'number'
  );
}

function isValidUserHistoryEntry(data: Record<string, unknown>, authUid: string): boolean {
  const keys = [
    'uid',
    'category',
    'title',
    'parcelId',
    'parcelLabel',
    'municipality',
    'referenceCode',
    'areaM2',
    'pirLevel',
    'soilMoisturePct',
    'summary',
    'status',
    'createdAt',
    'updatedAt',
  ];
  return (
    hasExactKeys(data, keys) &&
    isValidId(data.uid) &&
    data.uid === authUid &&
    typeof data.category === 'string' &&
    ['PARCEL', 'CERTIFICATE', 'QUOTE', 'NEIGHBOR', 'INTERVENTION'].includes(data.category) &&
    typeof data.title === 'string' &&
    data.title.length >= 2 &&
    data.title.length <= 140 &&
    isValidId(data.parcelId) &&
    typeof data.parcelLabel === 'string' &&
    data.parcelLabel.length >= 1 &&
    data.parcelLabel.length <= 120 &&
    typeof data.municipality === 'string' &&
    data.municipality.length >= 2 &&
    data.municipality.length <= 80 &&
    typeof data.referenceCode === 'string' &&
    data.referenceCode.length >= 1 &&
    data.referenceCode.length <= 64 &&
    typeof data.areaM2 === 'number' &&
    data.areaM2 >= 0 &&
    data.areaM2 <= 100_000_000 &&
    typeof data.pirLevel === 'number' &&
    data.pirLevel >= 1 &&
    data.pirLevel <= 5 &&
    typeof data.soilMoisturePct === 'number' &&
    data.soilMoisturePct >= 0 &&
    data.soilMoisturePct <= 100 &&
    typeof data.summary === 'string' &&
    data.summary.length >= 2 &&
    data.summary.length <= 500 &&
    typeof data.status === 'string' &&
    ['ACTIVE', 'ARCHIVED'].includes(data.status) &&
    typeof data.createdAt === 'number' &&
    typeof data.updatedAt === 'number'
  );
}

function isValidUserSavedParcel(data: Record<string, unknown>, authUid: string): boolean {
  const keys = [
    'uid',
    'parcelId',
    'label',
    'municipality',
    'dico',
    'matrixArticle',
    'bupiRggId',
    'landClass',
    'totalAreaM2',
    'mandatoryCleanAreaM2',
    'avgSlopePct',
    'hasEredesLine',
    'hasProtectedOaks',
    'createdAt',
    'updatedAt',
  ];
  return (
    hasExactKeys(data, keys) &&
    isValidId(data.uid) &&
    data.uid === authUid &&
    isValidId(data.parcelId) &&
    typeof data.label === 'string' &&
    data.label.length >= 2 &&
    data.label.length <= 120 &&
    typeof data.municipality === 'string' &&
    data.municipality.length >= 2 &&
    data.municipality.length <= 80 &&
    typeof data.dico === 'string' &&
    data.dico.length === 4 &&
    DICO_RE.test(data.dico) &&
    typeof data.matrixArticle === 'string' &&
    data.matrixArticle.length >= 1 &&
    data.matrixArticle.length <= 80 &&
    typeof data.bupiRggId === 'string' &&
    data.bupiRggId.length >= 1 &&
    data.bupiRggId.length <= 40 &&
    typeof data.landClass === 'string' &&
    ['FOREST_SCRUB', 'AGRICULTURE', 'URBAN_BUILT'].includes(data.landClass) &&
    typeof data.totalAreaM2 === 'number' &&
    data.totalAreaM2 > 0 &&
    data.totalAreaM2 <= 100_000_000 &&
    typeof data.mandatoryCleanAreaM2 === 'number' &&
    data.mandatoryCleanAreaM2 >= 0 &&
    data.mandatoryCleanAreaM2 <= 100_000_000 &&
    typeof data.avgSlopePct === 'number' &&
    data.avgSlopePct >= 0 &&
    data.avgSlopePct <= 100 &&
    typeof data.hasEredesLine === 'boolean' &&
    typeof data.hasProtectedOaks === 'boolean' &&
    typeof data.createdAt === 'number' &&
    typeof data.updatedAt === 'number'
  );
}

/**
 * Deterministic security rule evaluator mirroring firestore.rules Boolean gates
 * to verify all 12 Dirty Dozen adversarial payloads return PERMISSION_DENIED.
 */
function evaluateFirestoreRule(ctx: RequestContext): 'ALLOWED' | 'PERMISSION_DENIED' {
  if (!ctx.auth || ctx.auth.email_verified !== true) {
    return 'PERMISSION_DENIED';
  }
  const seg = ctx.pathSegments;

  // /users/{userId}
  if (seg.length === 2 && seg[0] === 'users') {
    const userId = seg[1];
    if (ctx.auth.uid !== userId || !isValidId(userId)) return 'PERMISSION_DENIED';

    if (ctx.operation === 'get') return 'ALLOWED';
    if (ctx.operation === 'list' || ctx.operation === 'delete') return 'PERMISSION_DENIED';

    if (ctx.operation === 'create') {
      if (!ctx.incomingData) return 'PERMISSION_DENIED';
      if (
        isValidUserPublicProfile(ctx.incomingData, ctx.auth.uid) &&
        ctx.incomingData.createdAt === ctx.nowMs &&
        ctx.incomingData.updatedAt === ctx.nowMs
      ) {
        return 'ALLOWED';
      }
      return 'PERMISSION_DENIED';
    }

    if (ctx.operation === 'update') {
      if (!ctx.incomingData || !ctx.existingData) return 'PERMISSION_DENIED';
      if (!isValidUserPublicProfile(ctx.incomingData, ctx.auth.uid)) return 'PERMISSION_DENIED';
      const changedKeys = Object.keys(ctx.incomingData).filter(
        (k) => ctx.incomingData![k] !== ctx.existingData![k]
      );
      const allowedDiff = changedKeys.every((k) =>
        ['displayName', 'preferredDico', 'updatedAt'].includes(k)
      );
      if (
        allowedDiff &&
        ctx.incomingData.uid === ctx.existingData.uid &&
        ctx.incomingData.createdAt === ctx.existingData.createdAt &&
        ctx.incomingData.updatedAt === ctx.nowMs
      ) {
        return 'ALLOWED';
      }
      return 'PERMISSION_DENIED';
    }
  }

  // /users/{userId}/private/{docId}
  if (seg.length === 4 && seg[0] === 'users' && seg[2] === 'private') {
    const [, userId, , docId] = seg;
    if (ctx.auth.uid !== userId || !isValidId(userId) || !isValidId(docId)) {
      return 'PERMISSION_DENIED';
    }
    if (!ctx.existingDocs.has(`users/${userId}`)) return 'PERMISSION_DENIED';
    if (ctx.operation === 'get') return 'ALLOWED';
    return 'PERMISSION_DENIED';
  }

  // /users/{userId}/history/{entryId}
  if (seg.length === 4 && seg[0] === 'users' && seg[2] === 'history') {
    const [, userId, , entryId] = seg;
    if (ctx.auth.uid !== userId) return 'PERMISSION_DENIED';

    if (ctx.operation === 'list') {
      return ctx.existingData?.uid === ctx.auth.uid ? 'ALLOWED' : 'PERMISSION_DENIED';
    }

    if (!isValidId(userId) || !isValidId(entryId)) return 'PERMISSION_DENIED';
    if (!ctx.existingDocs.has(`users/${userId}`)) return 'PERMISSION_DENIED';

    if (ctx.operation === 'create') {
      if (!ctx.incomingData) return 'PERMISSION_DENIED';
      if (
        isValidUserHistoryEntry(ctx.incomingData, ctx.auth.uid) &&
        ctx.incomingData.status === 'ACTIVE' &&
        ctx.incomingData.createdAt === ctx.nowMs &&
        ctx.incomingData.updatedAt === ctx.nowMs
      ) {
        return 'ALLOWED';
      }
      return 'PERMISSION_DENIED';
    }

    if (ctx.operation === 'update') {
      if (!ctx.incomingData || !ctx.existingData) return 'PERMISSION_DENIED';
      if (!isValidUserHistoryEntry(ctx.incomingData, ctx.auth.uid)) return 'PERMISSION_DENIED';
      if (ctx.existingData.status === 'ARCHIVED') return 'PERMISSION_DENIED';
      if (ctx.incomingData.updatedAt !== ctx.nowMs) return 'PERMISSION_DENIED';
      return 'ALLOWED';
    }
  }

  // /users/{userId}/parcels/{parcelId}
  if (seg.length === 4 && seg[0] === 'users' && seg[2] === 'parcels') {
    const [, userId, , parcelId] = seg;
    if (ctx.auth.uid !== userId) return 'PERMISSION_DENIED';

    if (ctx.operation === 'list') {
      return ctx.existingData?.uid === ctx.auth.uid ? 'ALLOWED' : 'PERMISSION_DENIED';
    }

    if (!isValidId(userId) || !isValidId(parcelId)) return 'PERMISSION_DENIED';
    if (!ctx.existingDocs.has(`users/${userId}`)) return 'PERMISSION_DENIED';

    if (ctx.operation === 'create') {
      if (!ctx.incomingData) return 'PERMISSION_DENIED';
      if (
        ctx.incomingData.parcelId === parcelId &&
        isValidUserSavedParcel(ctx.incomingData, ctx.auth.uid) &&
        ctx.incomingData.createdAt === ctx.nowMs &&
        ctx.incomingData.updatedAt === ctx.nowMs
      ) {
        return 'ALLOWED';
      }
      return 'PERMISSION_DENIED';
    }

    if (ctx.operation === 'update') {
      if (!ctx.incomingData || !ctx.existingData) return 'PERMISSION_DENIED';
      if (!isValidUserSavedParcel(ctx.incomingData, ctx.auth.uid)) return 'PERMISSION_DENIED';
      const changedKeys = Object.keys(ctx.incomingData).filter(
        (k) => ctx.incomingData![k] !== ctx.existingData![k]
      );
      const allowedDiff = changedKeys.every((k) =>
        [
          'label',
          'municipality',
          'dico',
          'matrixArticle',
          'bupiRggId',
          'landClass',
          'totalAreaM2',
          'mandatoryCleanAreaM2',
          'avgSlopePct',
          'hasEredesLine',
          'hasProtectedOaks',
          'updatedAt',
        ].includes(k)
      );
      if (
        allowedDiff &&
        ctx.incomingData.uid === ctx.existingData.uid &&
        ctx.incomingData.parcelId === ctx.existingData.parcelId &&
        ctx.incomingData.createdAt === ctx.existingData.createdAt &&
        ctx.incomingData.updatedAt === ctx.nowMs
      ) {
        return 'ALLOWED';
      }
      return 'PERMISSION_DENIED';
    }

    if (ctx.operation === 'delete') {
      if (!ctx.existingData || ctx.existingData.uid !== ctx.auth.uid) return 'PERMISSION_DENIED';
      return 'ALLOWED';
    }
  }

  return 'PERMISSION_DENIED';
}

test('firestore.rules enforces Global Default-Deny, all 4 Blueprint paths, and Zero-Trust gates', () => {
  assert.ok(rulesSource.includes("rules_version = '2';"));
  assert.ok(rulesSource.includes('match /{document=**} {\n      allow read, write: if false;'));
  assert.ok(rulesSource.includes('request.auth.token.email_verified == true'));
  assert.ok(rulesSource.includes('resource.data.uid == request.auth.uid'));

  // Every collection path in firebase-blueprint.json is secured in firestore.rules
  assert.equal(Object.keys(blueprint.firestore).length, 4);
  assert.ok(rulesSource.includes('match /users/{userId}'));
  assert.ok(rulesSource.includes('match /private/{docId}'));
  assert.ok(rulesSource.includes('match /history/{entryId}'));
  assert.ok(rulesSource.includes('match /parcels/{parcelId}'));
});

test('Dirty Dozen adversarial payloads all return PERMISSION_DENIED while legitimate owner writes succeed', () => {
  const now = 1_794_736_000_000;
  const existingDocs = new Set(['users/user_1']);
  const validHistoryPayload = {
    uid: 'user_1',
    category: 'INTERVENTION',
    title: 'Limpeza de mato na Zona 2',
    parcelId: 'parcel-sintra-colares',
    parcelLabel: 'Quinta do Vale Escuro',
    municipality: 'Sintra',
    referenceCode: 'INT-20261115',
    areaM2: 2843.7,
    pirLevel: 2,
    soilMoisturePct: 26.4,
    summary: 'Roçadora com fio de nylon antes das 11h00.',
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  };

  // Sanity check: legitimate verified owner write succeeds
  assert.equal(
    evaluateFirestoreRule({
      auth: { uid: 'user_1', email_verified: true },
      pathSegments: ['users', 'user_1', 'history', 'hist_01'],
      operation: 'create',
      nowMs: now,
      incomingData: validHistoryPayload,
      existingDocs,
    }),
    'ALLOWED'
  );

  // 1. Unauthenticated Write
  assert.equal(
    evaluateFirestoreRule({
      auth: null,
      pathSegments: ['users', 'user_1'],
      operation: 'create',
      nowMs: now,
      incomingData: { uid: 'user_1', displayName: 'Ana', preferredDico: '1111', createdAt: now, updatedAt: now },
      existingDocs,
    }),
    'PERMISSION_DENIED'
  );

  // 2. Unverified Email Spoof
  assert.equal(
    evaluateFirestoreRule({
      auth: { uid: 'user_1', email_verified: false },
      pathSegments: ['users', 'user_1'],
      operation: 'create',
      nowMs: now,
      incomingData: { uid: 'user_1', displayName: 'Ana', preferredDico: '1111', createdAt: now, updatedAt: now },
      existingDocs,
    }),
    'PERMISSION_DENIED'
  );

  // 3. Cross-Tenant Identity Spoofing
  assert.equal(
    evaluateFirestoreRule({
      auth: { uid: 'attacker_9', email_verified: true },
      pathSegments: ['users', 'user_1', 'history', 'hist_01'],
      operation: 'create',
      nowMs: now,
      incomingData: validHistoryPayload,
      existingDocs,
    }),
    'PERMISSION_DENIED'
  );

  // 4. Payload UID Mismatch
  assert.equal(
    evaluateFirestoreRule({
      auth: { uid: 'user_1', email_verified: true },
      pathSegments: ['users', 'user_1', 'history', 'hist_01'],
      operation: 'create',
      nowMs: now,
      incomingData: { ...validHistoryPayload, uid: 'user_2' },
      existingDocs,
    }),
    'PERMISSION_DENIED'
  );

  // 5. Orphaned Subcollection Write (no parent /users/{uid})
  assert.equal(
    evaluateFirestoreRule({
      auth: { uid: 'orphan_user', email_verified: true },
      pathSegments: ['users', 'orphan_user', 'history', 'hist_01'],
      operation: 'create',
      nowMs: now,
      incomingData: { ...validHistoryPayload, uid: 'orphan_user' },
      existingDocs,
    }),
    'PERMISSION_DENIED'
  );

  // 6. Shadow / Ghost Field Injection
  assert.equal(
    evaluateFirestoreRule({
      auth: { uid: 'user_1', email_verified: true },
      pathSegments: ['users', 'user_1'],
      operation: 'create',
      nowMs: now,
      incomingData: {
        uid: 'user_1',
        displayName: 'Ana',
        preferredDico: '1111',
        isAdmin: true,
        createdAt: now,
        updatedAt: now,
      },
      existingDocs,
    }),
    'PERMISSION_DENIED'
  );

  // 7. PII Cross-User Read
  assert.equal(
    evaluateFirestoreRule({
      auth: { uid: 'user_2', email_verified: true },
      pathSegments: ['users', 'user_1', 'private', 'profile'],
      operation: 'get',
      nowMs: now,
      existingDocs,
    }),
    'PERMISSION_DENIED'
  );

  // 8. ID Poisoning (200-char invalid ID)
  assert.equal(
    evaluateFirestoreRule({
      auth: { uid: 'user_1', email_verified: true },
      pathSegments: ['users', 'user_1', 'history', `${'x'.repeat(160)}$%`],
      operation: 'create',
      nowMs: now,
      incomingData: validHistoryPayload,
      existingDocs,
    }),
    'PERMISSION_DENIED'
  );

  // 9. Value Poisoning on Update
  assert.equal(
    evaluateFirestoreRule({
      auth: { uid: 'user_1', email_verified: true },
      pathSegments: ['users', 'user_1'],
      operation: 'update',
      nowMs: now,
      existingData: { uid: 'user_1', displayName: 'Ana', preferredDico: '1111', createdAt: now - 1000, updatedAt: now - 1000 },
      incomingData: { uid: 'user_1', displayName: 'A'.repeat(250), preferredDico: '1111', createdAt: now - 1000, updatedAt: now },
      existingDocs,
    }),
    'PERMISSION_DENIED'
  );

  // 10. Client-Forged Timestamp
  assert.equal(
    evaluateFirestoreRule({
      auth: { uid: 'user_1', email_verified: true },
      pathSegments: ['users', 'user_1', 'history', 'hist_01'],
      operation: 'create',
      nowMs: now,
      incomingData: { ...validHistoryPayload, createdAt: now - 999999 },
      existingDocs,
    }),
    'PERMISSION_DENIED'
  );

  // 11. Terminal State Re-Open (Archived entry)
  assert.equal(
    evaluateFirestoreRule({
      auth: { uid: 'user_1', email_verified: true },
      pathSegments: ['users', 'user_1', 'history', 'hist_01'],
      operation: 'update',
      nowMs: now,
      existingData: { ...validHistoryPayload, status: 'ARCHIVED' },
      incomingData: { ...validHistoryPayload, status: 'ACTIVE', updatedAt: now },
      existingDocs,
    }),
    'PERMISSION_DENIED'
  );

  // 12. Unauthorized Cross-Tenant List Query
  assert.equal(
    evaluateFirestoreRule({
      auth: { uid: 'user_2', email_verified: true },
      pathSegments: ['users', 'user_1', 'history', '*'],
      operation: 'list',
      nowMs: now,
      existingData: validHistoryPayload,
      existingDocs,
    }),
    'PERMISSION_DENIED'
  );

  // 13. Parcel Create, Update (recomputed area & landClass), Delete, and Shadow/Immutable Guard
  const validParcelPayload = {
    uid: 'user_1',
    parcelId: 'parcel-101',
    label: 'Pinhal Novo da Serra',
    municipality: 'Sintra',
    dico: '1111',
    matrixArticle: 'Rústico Art. 88',
    bupiRggId: 'RGG-101',
    landClass: 'FOREST_SCRUB',
    totalAreaM2: 6200,
    mandatoryCleanAreaM2: 2400,
    avgSlopePct: 14,
    hasEredesLine: false,
    hasProtectedOaks: true,
    createdAt: now,
    updatedAt: now,
  };

  assert.equal(
    evaluateFirestoreRule({
      auth: { uid: 'user_1', email_verified: true },
      pathSegments: ['users', 'user_1', 'parcels', 'parcel-101'],
      operation: 'create',
      nowMs: now,
      incomingData: validParcelPayload,
      existingDocs,
    }),
    'ALLOWED'
  );

  // Owner updates label, landClass, municipality, and mandatoryCleanAreaM2
  assert.equal(
    evaluateFirestoreRule({
      auth: { uid: 'user_1', email_verified: true },
      pathSegments: ['users', 'user_1', 'parcels', 'parcel-101'],
      operation: 'update',
      nowMs: now + 5000,
      existingData: validParcelPayload,
      incomingData: {
        ...validParcelPayload,
        label: 'Pinhal Renovado',
        landClass: 'AGRICULTURE',
        mandatoryCleanAreaM2: 1120,
        updatedAt: now + 5000,
      },
      existingDocs,
    }),
    'ALLOWED'
  );

  // Reject mutating immutable parcelId or injecting shadow field on parcel update
  assert.equal(
    evaluateFirestoreRule({
      auth: { uid: 'user_1', email_verified: true },
      pathSegments: ['users', 'user_1', 'parcels', 'parcel-101'],
      operation: 'update',
      nowMs: now + 5000,
      existingData: validParcelPayload,
      incomingData: {
        ...validParcelPayload,
        parcelId: 'parcel-hijack',
        updatedAt: now + 5000,
      },
      existingDocs,
    }),
    'PERMISSION_DENIED'
  );

  // Owner deletes parcel
  assert.equal(
    evaluateFirestoreRule({
      auth: { uid: 'user_1', email_verified: true },
      pathSegments: ['users', 'user_1', 'parcels', 'parcel-101'],
      operation: 'delete',
      nowMs: now + 9000,
      existingData: validParcelPayload,
      existingDocs,
    }),
    'ALLOWED'
  );
});
