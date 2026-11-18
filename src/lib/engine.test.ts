import test from 'node:test';
import assert from 'node:assert/strict';
import {
  wgs84ToPtTm06,
  computeParcelFgc,
  buildMunicipalGtfGeoJson,
  buildMunicipalGtfKml,
  haversineDistanceKm,
} from './spatialEngine.ts';
import { readFileSync as readEnvFileSync } from 'node:fs';
import {
  evaluateOperationalSemaphore,
  buildCanonicalCertificatePayload,
  computeSha256Hex,
  answerLegalFieldQuestion,
} from './pirRules.ts';
import {
  buildCopernicusStatsRequestBody,
  parseCopernicusStatsResponse,
  parseCopernicusOpenCatalogScenes,
  parseEredesOpenDataLines,
  mergeEredesEasementsIntoVectorContext,
  parseDgtCadastreFeatures,
  buildParcelElevationSampleGrid,
  parseElevationApiResponse,
  computeTerrainSlopeFromElevations,
} from './externalGeoConnectors.ts';
import {
  ServerInfraBridge,
  WebPushNotificationHub,
  dispatchTelegramAlert,
  dispatchTransactionalEmailOrWebhook,
} from './serverInfraAndNotifications.ts';

test('PT-TM06 (EPSG:3763) origin projects to (0, 0) meters', () => {
  const origin = wgs84ToPtTm06({ lat: 39.668258333333334, lon: -8.133108333333334 });
  assert.ok(Math.abs(origin.x) < 0.05, `Expected x ~ 0, got ${origin.x}`);
  assert.ok(Math.abs(origin.y) < 0.05, `Expected y ~ 0, got ${origin.y}`);
});

test('computeParcelFgc strictly conserves total parcel area across Despacho 675/2026 zones', () => {
  const vertices = [
    { lat: 38.79805, lon: -9.46258 },
    { lat: 38.79876, lon: -9.46252 },
    { lat: 38.79879, lon: -9.46164 },
    { lat: 38.79802, lon: -9.46168 },
  ];

  const breakdown = computeParcelFgc({
    vertices,
    landClass: 'FOREST_SCRUB',
    hasEredesLine: true,
  });

  assert.ok(breakdown.totalAreaM2 > 5000 && breakdown.totalAreaM2 < 8000);
  assert.ok(breakdown.zone1ImmediateM2 > 0);
  assert.ok(breakdown.zone2NearM2 > 0);
  assert.ok(breakdown.zone3ExtendedM2 > 0);
  assert.ok(breakdown.thirdPartyEasementM2 > 0);

  const sumZones =
    breakdown.zone1ImmediateM2 +
    breakdown.zone2NearM2 +
    breakdown.zone3ExtendedM2 +
    breakdown.thirdPartyEasementM2 +
    breakdown.exemptAreaM2;

  assert.ok(
    Math.abs(sumZones - breakdown.totalAreaM2) < 0.05,
    `Zone sum ${sumZones} should match totalAreaM2 ${breakdown.totalAreaM2}`
  );
  assert.ok(breakdown.estimatedEredesSavingsEur > 50);
});

test('Operational Semaphore prohibits metallic blades and debris burning on PIR levels 4 and 5', () => {
  const level4 = evaluateOperationalSemaphore({
    dateLabel: 'Sábado',
    isoDate: '2026-05-23',
    pirLevel: 4,
    tempMaxC: 31,
    humidityMinPct: 22,
    windKmh: 28,
  });
  assert.equal(level4.metalBladeMachinery.status, 'PROHIBITED');
  assert.equal(level4.debrisBurning.status, 'PROHIBITED');
  assert.equal(level4.nylonTrimmer.status, 'CONDITIONAL');
  assert.ok(level4.affiliateTip);

  const level2 = evaluateOperationalSemaphore({
    dateLabel: 'Domingo',
    isoDate: '2026-05-24',
    pirLevel: 2,
    tempMaxC: 22,
    humidityMinPct: 54,
    windKmh: 12,
  });
  assert.equal(level2.metalBladeMachinery.status, 'ALLOWED');
  assert.equal(level2.nylonTrimmer.status, 'ALLOWED');
});

test('SHA-256 canonical payload produces deterministic 64-char hex digest', async () => {
  const payload = buildCanonicalCertificatePayload({
    shortCode: 'FS-20260524-7D9E',
    parcelId: 'parcel-sintra-colares',
    dico: '1111',
    ownerNif: '218492310',
    cleanedAreaM2: 1850.0,
    pirLevelAtWork: 2,
    issuedAt: '2026-05-24T17:05:00Z',
  });
  const hash1 = await computeSha256Hex(payload);
  const hash2 = await computeSha256Hex(payload);
  assert.equal(hash1.length, 64);
  assert.equal(hash1, hash2);
});

test('Municipal GTF GeoJSON and KML exporters produce valid geospatial structures', () => {
  const poly = [
    { lat: 39.7434, lon: -8.8081 },
    { lat: 39.7441, lon: -8.8081 },
    { lat: 39.7441, lon: -8.8076 },
    { lat: 39.7434, lon: -8.8076 },
  ];
  const geojsonStr = buildMunicipalGtfGeoJson({
    reqCode: 'REQ-20260602-3C1A',
    municipality: 'Leiria',
    dicofre: '100933',
    minDistanceFacadeM: 3.8,
    neighborNdvi: 0.78,
    neighborPolygon: poly,
    buildingPolygon: poly,
  });
  const parsed = JSON.parse(geojsonStr);
  assert.equal(parsed.type, 'FeatureCollection');
  assert.equal(parsed.features.length, 2);

  const kmlStr = buildMunicipalGtfKml({
    reqCode: 'REQ-20260602-3C1A',
    municipality: 'Leiria',
    minDistanceFacadeM: 3.8,
    neighborPolygon: poly,
  });
  assert.ok(kmlStr.includes('<kml'));
  assert.ok(kmlStr.includes('REQ-20260602-3C1A'));
});

test('Legal RAG assistant cites DL 169/2001 on cork oaks and Haversine computes realistic distances', () => {
  const oakReply = answerLegalFieldQuestion('Tenho dois sobreiros perto de casa, posso cortá-los?');
  assert.ok(oakReply.legalBasis.includes('169/2001'));

  const distSintraMafra = haversineDistanceKm(
    { lat: 38.7984, lon: -9.4621 },
    { lat: 38.9482, lon: -9.3185 }
  );
  assert.ok(distSintraMafra > 18 && distSintraMafra < 25);
});

test('2-page A4 PDF generators produce valid PDF binaries with WinAnsi Portuguese accents, UTC timestamp seal, and SHA-256 hash', async () => {
  const { PDFDocument } = await import('pdf-lib');
  const { INITIAL_CERTIFICATES, INITIAL_PARCELS } = await import('../data/seedCatalog.ts');
  const {
    buildCertificateSealMetadata,
    generateComplianceCertificatePdf,
    generateNeighborComplaintPdf,
  } = await import('./pdfTemplates.ts');

  const seedCert = INITIAL_CERTIFICATES[0];
  const exportIso = '2026-11-15T14:55:00.000Z';
  const sealMeta = buildCertificateSealMetadata(seedCert, exportIso);
  assert.ok(sealMeta.timestampSealId.startsWith('TS-UTC-'));
  assert.equal(sealMeta.exportedAtUtcIso, exportIso);
  assert.equal(sealMeta.sha256Hash.length, 64);

  // Verify seedCert SHA-256 matches canonical payload
  const expectedSeedHash = await computeSha256Hex(sealMeta.canonicalPayload);
  assert.equal(seedCert.sha256Hash, expectedSeedHash);

  const certBytes = await generateComplianceCertificatePdf(seedCert, 'https://faixasegura.pt', {
    exportedAtIso: exportIso,
  });
  assert.ok(certBytes.byteLength > 2500);
  const header = Buffer.from(certBytes.slice(0, 5)).toString('ascii');
  assert.equal(header, '%PDF-');

  const parsedPdf = await PDFDocument.load(certBytes);
  assert.equal(parsedPdf.getPageCount(), 2);
  assert.ok(parsedPdf.getSubject()?.includes(seedCert.sha256Hash));
  assert.ok(parsedPdf.getSubject()?.includes(sealMeta.issuedAtUtcIso));
  assert.ok(parsedPdf.getKeywords()?.includes(sealMeta.timestampSealId));

  const parcel = INITIAL_PARCELS[0];
  const reqBytes = await generateNeighborComplaintPdf(
    {
      id: 'req-test',
      reqCode: 'REQ-20260602-3C1A',
      parcelId: parcel.id,
      municipality: 'Sintra',
      parish: 'Colares',
      dicofre: '111105',
      complainantName: 'João Conceição Magalhães',
      complainantNif: '218492310',
      complainantAddress: 'Caminho dos Sobreiros, 18',
      complainantPhone: '912 000 111',
      complainantEmail: 'joao@exemplo.pt',
      ownCertRef: 'FS-20260524-7D9E',
      minDistanceFacadeM: 4.2,
      confrontationSide: 'Poente',
      shrubHeightM: 1.85,
      dominantSpecies: 'Eucalipto e Silvado contínuo',
      neighborNdvi: 0.74,
      hazardClassLabel: 'Classe IV (Alta)',
      formalPetitionText:
        'Constata-se vegetação densa a 4,20 metros da habitação em infração ao Despacho n.º 675/2026 e Art.º 49.º do DL n.º 82/2021.',
      neighborCentroidWgs84: { lat: 38.7984, lon: -9.4629 },
      neighborCentroidPtTm06: { x: -115420.2, y: -95810.4 },
      neighborPolygon: parcel.spatial.polygons.neighborRiskParcel,
      buildingPolygon: parcel.spatial.polygons.buildingFootprint,
      issuedAt: '2026-06-02T10:00:00Z',
    },
    'https://faixasegura.pt'
  );
  assert.ok(reqBytes.byteLength > 2500);
  assert.equal(Buffer.from(reqBytes.slice(0, 5)).toString('ascii'), '%PDF-');
});

test('buildSevenDayPirSoilSeries produces 7 chronological days with bounded PIR (1-5), soil moisture (10-48%), and decision verdicts', async () => {
  const { INITIAL_PARCELS } = await import('../data/seedCatalog.ts');
  const { buildSevenDayPirSoilSeries } = await import('./pirTrendEngine.ts');

  const todayForecast = evaluateOperationalSemaphore({
    dateLabel: 'Hoje · Domingo',
    isoDate: '2026-11-15',
    pirLevel: 4,
    tempMaxC: 29,
    humidityMinPct: 26,
    windKmh: 29,
  });

  const summary = buildSevenDayPirSoilSeries(
    INITIAL_PARCELS[0],
    todayForecast,
    new Date('2026-11-15T12:00:00Z')
  );

  assert.equal(summary.points.length, 7);
  assert.equal(summary.points[6].isToday, true);
  assert.equal(summary.points[6].pirLevel, 4);
  assert.equal(summary.points[6].interventionVerdict, 'INTERDITO');

  for (const pt of summary.points) {
    assert.ok(pt.pirLevel >= 1 && pt.pirLevel <= 5);
    assert.ok(pt.soilMoisturePct >= 10 && pt.soilMoisturePct <= 48);
    assert.ok(pt.interventionScore >= 5 && pt.interventionScore <= 100);
  }
  assert.ok(summary.actionHeadline.includes('RCM 4'));
});

test('buildRegionalThirtyDayIncidents builds 6 regional municipalities, conserves 30d breakdown, and adapts across regions', async () => {
  const { INITIAL_PARCELS } = await import('../data/seedCatalog.ts');
  const { buildRegionalThirtyDayIncidents } = await import('./regionalIncidentsEngine.ts');

  const sintraSummary = buildRegionalThirtyDayIncidents(
    INITIAL_PARCELS[0],
    [
      {
        id: 'inc-live-mafra',
        municipality: 'Mafra',
        parish: 'Venda do Pinheiro',
        nature: 'Mato',
        status: 'Em Curso',
        lat: 38.94,
        lon: -9.31,
        distanceKm: 20.4,
        operatives: 38,
        vehicles: 11,
        aerialMeans: 1,
        startedAt: 'Há 25 min',
        source: 'ANEPC / API Aberta',
      },
    ],
    new Date('2026-07-20T14:00:00Z')
  );

  assert.equal(sintraSummary.points.length, 6);
  assert.equal(sintraSummary.ownMunicipalityPoint.municipality, 'Sintra');
  assert.equal(sintraSummary.ownMunicipalityPoint.isParcelMunicipality, true);

  const mafraPoint = sintraSummary.points.find((p) => p.municipality === 'Mafra');
  assert.ok(mafraPoint, 'Expected Mafra in Sintra regional cluster');
  assert.equal(mafraPoint.activeNowCount, 1);
  assert.equal(mafraPoint.trendDirection, 'RISING');

  let sum30d = 0;
  for (const pt of sintraSummary.points) {
    assert.equal(pt.prev15dIncidents + pt.last15dIncidents, pt.incidents30dTotal);
    assert.equal(pt.forestScrub30d + pt.agricultural30d, pt.incidents30dTotal);
    sum30d += pt.incidents30dTotal;
  }
  assert.equal(sum30d, sintraSummary.totalIncidents30d);

  // Verify switching to Leiria shifts the regional cluster to Centro/Pinhal Interior
  const leiriaSummary = buildRegionalThirtyDayIncidents(
    INITIAL_PARCELS[1],
    [],
    new Date('2026-07-20T14:00:00Z')
  );
  assert.equal(leiriaSummary.ownMunicipalityPoint.municipality, 'Leiria');
  assert.ok(leiriaSummary.points.some((p) => p.municipality === 'Pombal'));
});

test('Docker & Dokploy deployment manifests include valid package-lock.json, resilient Dockerfile npm install fallback, and multi-arch compose setup', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const rootDir = process.cwd();

  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const lock = JSON.parse(fs.readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8')) as {
    lockfileVersion: number;
    packages?: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
  };

  assert.ok(pkg.dependencies['react-is'], 'recharts peer dependency react-is must be explicitly in dependencies when using --legacy-peer-deps');
  assert.ok(lock.lockfileVersion >= 2, 'Expected lockfileVersion >= 2 for npm ci');
  const rootLockEntry = lock.packages?.[''];
  assert.ok(rootLockEntry, 'Expected root package entry in package-lock.json');
  assert.deepEqual(rootLockEntry.dependencies, pkg.dependencies);
  assert.deepEqual(rootLockEntry.devDependencies, pkg.devDependencies);
  assert.ok(lock.packages?.['node_modules/react-is'], 'Expected node_modules/react-is in package-lock.json');

  const dockerfile = fs.readFileSync(path.join(rootDir, 'Dockerfile'), 'utf8');
  assert.ok(dockerfile.includes('NPM_CONFIG_LEGACY_PEER_DEPS=true'), 'Dockerfile should enforce legacy-peer-deps without requiring .npmrc');
  assert.ok(dockerfile.includes('if [ -f package-lock.json ]'), 'Dockerfile should guard missing package-lock.json');
  assert.ok(dockerfile.includes('npm ci --include=dev'), 'Dockerfile should include devDependencies for vite build');
  assert.ok(dockerfile.includes('npm install --include=dev'), 'Dockerfile should fallback to npm install if lockfile is absent');
  assert.ok(dockerfile.includes('ARG VITE_FIREBASE_API_KEY'), 'Dockerfile should accept Vite Firebase build args from Dokploy .env');
  assert.ok(dockerfile.includes('./node_modules/.bin/tsx'), 'Dockerfile CMD should run server.ts via tsx');

  const dockerignore = fs.readFileSync(path.join(rootDir, '.dockerignore'), 'utf8');
  assert.ok(dockerignore.includes('node_modules'));
  assert.ok(dockerignore.includes('dist'));

  const compose = fs.readFileSync(path.join(rootDir, 'docker-compose.yml'), 'utf8');
  assert.ok(!compose.includes('container_name:'), 'Dokploy compose should avoid hardcoded container_name collisions');
  assert.ok(compose.includes('imresamu/postgis:16-3.4-alpine'), 'Compose should default to multi-arch PostGIS image');
  assert.ok(compose.includes('VITE_FIREBASE_API_KEY: ${VITE_FIREBASE_API_KEY:-}'), 'Compose should forward VITE_FIREBASE_API_KEY build arg');
});

test('OfflineSyncCoordinator queues parcels and history offline, coalesces operations, survives mid-sync drops, and auto-syncs to Firestore on reconnect', async () => {
  const { INITIAL_PARCELS } = await import('../data/seedCatalog.ts');
  const { buildLocalParcelRecord, extractCadernetaOffline } = await import('./offlineParcelBuilder.ts');
  const {
    OFFLINE_LOCAL_UID,
    OfflineSyncCoordinator,
    buildLocalHistoryEntry,
    coalesceOutboxOperations,
    createMemoryOfflineStorageAdapter,
    mergeHistoryWithOffline,
    mergeParcelsWithOffline,
  } = await import('./offlineStorage.ts');

  let online = false;
  let failAfterOps: number | null = null;
  const firestoreCalls: Array<{ op: string; uid: string; id: string; status?: string }> = [];
  let backendParcelSyncCount = 0;

  const storage = createMemoryOfflineStorageAdapter();
  const coordinator = new OfflineSyncCoordinator({
    storage,
    isOnline: () => online,
    transport: {
      syncParcelToBackend: async () => {
        backendParcelSyncCount += 1;
      },
      saveParcel: async (uid, parcel) => {
        if (failAfterOps !== null && firestoreCalls.length >= failAfterOps) {
          throw new Error('FirebaseError: Failed to fetch (client is offline)');
        }
        firestoreCalls.push({ op: 'SAVE_PARCEL', uid, id: parcel.id });
      },
      createHistory: async (uid, entry) => {
        if (failAfterOps !== null && firestoreCalls.length >= failAfterOps) {
          throw new Error('FirebaseError: unavailable network timeout');
        }
        firestoreCalls.push({ op: 'CREATE_HISTORY', uid, id: entry.id, status: entry.status });
      },
      archiveHistory: async (uid, entryId) => {
        if (failAfterOps !== null && firestoreCalls.length >= failAfterOps) {
          throw new Error('FirebaseError: network error');
        }
        firestoreCalls.push({ op: 'ARCHIVE_HISTORY', uid, id: entryId });
      },
      deleteHistory: async (uid, entryId) => {
        firestoreCalls.push({ op: 'DELETE_HISTORY', uid, id: entryId });
      },
    },
  });

  // 1. Offline Caderneta extraction + parcel creation while offline
  const extracted = extractCadernetaOffline(
    'Caderneta Predial Rústica — Município de Mafra, Artigo Matricial 412, Secção G, com sobreiros adultos.'
  );
  assert.equal(extracted.municipality, 'Mafra');
  assert.equal(extracted.hasProtectedOaks, true);

  const offlineParcel = buildLocalParcelRecord({
    label: extracted.suggestedLabel,
    dico: extracted.dico,
    matrixArticle: extracted.matrixArticle,
    hasProtectedOaks: extracted.hasProtectedOaks,
    vertices: extracted.vertices,
    nowMs: 1763210000000,
  });

  const entryA = buildLocalHistoryEntry({
    id: 'hist-offline-a',
    uid: OFFLINE_LOCAL_UID,
    category: 'INTERVENTION',
    title: 'Limpeza Faixa Zona 2 com fio nylon',
    parcelId: offlineParcel.id,
    parcelLabel: offlineParcel.label,
    municipality: offlineParcel.municipality,
    referenceCode: 'INT-20261115',
    areaM2: offlineParcel.spatial.mandatoryCleanAreaM2,
    pirLevel: 2,
    soilMoisturePct: 28.4,
    summary: 'Executada limpeza preventiva offline.',
    createdAtIso: '2026-11-15T09:00:00.000Z',
  });

  const entryB = buildLocalHistoryEntry({
    id: 'hist-offline-b',
    uid: OFFLINE_LOCAL_UID,
    category: 'QUOTE',
    title: 'Rascunho temporário a eliminar',
    parcelId: offlineParcel.id,
    parcelLabel: offlineParcel.label,
    municipality: offlineParcel.municipality,
    referenceCode: 'LEAD-TEMP',
    areaM2: 1200,
    pirLevel: 2,
    soilMoisturePct: 28.4,
    summary: 'Criado e apagado ainda sem rede.',
    createdAtIso: '2026-11-15T09:05:00.000Z',
  });

  // 1b + 2. Fire parcel + history creation CONCURRENTLY (just like onCreateParcel in UI) while offline
  const [parcelRecordRes] = await Promise.all([
    coordinator.recordParcel(offlineParcel, null),
    coordinator.recordHistoryCreation(entryA, null),
  ]);
  assert.equal(parcelRecordRes.syncResult.offlineSkipped, true);
  assert.equal(firestoreCalls.length, 0, 'No Firestore calls should happen while offline');

  await coordinator.recordHistoryArchive(entryA.id, null);
  await coordinator.recordHistoryCreation(entryB, null);
  await coordinator.recordHistoryDelete(entryB.id, null);

  const hydratedOffline = await coordinator.hydrateState();
  assert.equal(hydratedOffline.parcels.length, 1);
  assert.equal(hydratedOffline.history.length, 1, 'Deleted offline entryB should be removed locally');
  assert.equal(hydratedOffline.history[0].id, 'hist-offline-a');
  assert.equal(hydratedOffline.history[0].status, 'ARCHIVED');

  // Outbox should have exactly 3 operations: SAVE_PARCEL, CREATE_HISTORY(A), ARCHIVE_HISTORY(A)
  const coalesced = coalesceOutboxOperations(hydratedOffline.outbox);
  assert.deepEqual(
    coalesced.map((o) => `${o.type}:${o.targetId}`),
    [
      `SAVE_PARCEL:${offlineParcel.id}`,
      'CREATE_HISTORY:hist-offline-a',
      'ARCHIVE_HISTORY:hist-offline-a',
    ]
  );

  // Merge helpers annotate offline items as PENDING and prepend custom parcel
  const mergedParcels = mergeParcelsWithOffline(INITIAL_PARCELS, hydratedOffline.parcels);
  assert.equal(mergedParcels[0].id, offlineParcel.id);

  const mergedBeforeSync = mergeHistoryWithOffline({
    remoteItems: [],
    localItems: hydratedOffline.history,
    outbox: hydratedOffline.outbox,
    activeUid: 'user-auth-99',
  });
  assert.equal(mergedBeforeSync.length, 1);
  assert.equal(mergedBeforeSync[0].syncStatus, 'PENDING');
  assert.equal(mergedBeforeSync[0].status, 'ARCHIVED');

  // 3. Simulate transient drop mid-sync after 1 operation
  online = true;
  failAfterOps = 1;
  const partialFlush = await coordinator.flushOutbox('user-auth-99');
  assert.equal(partialFlush.syncedCount, 1);
  assert.equal(partialFlush.remainingCount, 2, 'Remaining FIFO operations must stay queued');

  // 4. Connection fully restored -> automatic flush drains remaining queue in strict order
  failAfterOps = null;
  const fullFlush = await coordinator.flushOutbox('user-auth-99');
  assert.equal(fullFlush.syncedCount, 2);
  assert.equal(fullFlush.remainingCount, 0);
  assert.ok(fullFlush.lastSyncedAtIso);
  assert.equal(backendParcelSyncCount, 1);

  assert.deepEqual(firestoreCalls, [
    { op: 'SAVE_PARCEL', uid: 'user-auth-99', id: offlineParcel.id },
    { op: 'CREATE_HISTORY', uid: 'user-auth-99', id: 'hist-offline-a', status: 'ACTIVE' },
    { op: 'ARCHIVE_HISTORY', uid: 'user-auth-99', id: 'hist-offline-a' },
  ]);

  const hydratedAfterSync = await coordinator.hydrateState();
  assert.equal(hydratedAfterSync.outbox.length, 0);
  const mergedAfterSync = mergeHistoryWithOffline({
    remoteItems: [],
    localItems: hydratedAfterSync.history,
    outbox: hydratedAfterSync.outbox,
    activeUid: 'user-auth-99',
  });
  assert.equal(mergedAfterSync[0].syncStatus, 'SYNCED');
  assert.equal(mergedAfterSync[0].uid, 'user-auth-99');
});

test('buildParcelVerticesGeoJson exports RFC 7946 closed counterclockwise Polygon, EPSG:3763 vertex Points, and clean .geojson filename', async () => {
  const { INITIAL_PARCELS } = await import('../data/seedCatalog.ts');
  const { buildParcelGeoJsonFilename, buildParcelVerticesGeoJson } = await import('./spatialEngine.ts');

  const sintraParcel = INITIAL_PARCELS[0];
  const filename = buildParcelGeoJsonFilename(sintraParcel);
  assert.ok(filename.endsWith('.geojson'), 'Expected .geojson extension');
  assert.ok(/^[a-z0-9._-]+$/.test(filename), `Expected ASCII-safe filename, got ${filename}`);
  assert.ok(filename.includes('sintra'), 'Expected municipality slug in filename');

  const rawJson = buildParcelVerticesGeoJson(sintraParcel, '2026-11-15T16:00:00.000Z');
  const parsed = JSON.parse(rawJson) as {
    type: string;
    bbox: [number, number, number, number];
    crs: { type: string; properties: { name: string } };
    features: Array<{
      id: string;
      type: string;
      properties: Record<string, unknown>;
      geometry: { type: string; coordinates: unknown };
    }>;
  };

  assert.equal(parsed.type, 'FeatureCollection');
  assert.equal(parsed.crs.properties.name, 'urn:ogc:def:crs:OGC:1.3:CRS84');
  assert.equal(parsed.bbox.length, 4);
  assert.ok(parsed.bbox[0] <= parsed.bbox[2] && parsed.bbox[1] <= parsed.bbox[3]);

  const expectedVertexCount = sintraParcel.vertices.length;
  assert.equal(parsed.features.length, 1 + expectedVertexCount);

  const boundaryFeature = parsed.features[0];
  assert.equal(boundaryFeature.geometry.type, 'Polygon');
  assert.equal(boundaryFeature.properties.feature_role, 'PARCEL_BOUNDARY');
  assert.equal(boundaryFeature.properties.parcel_id, sintraParcel.id);
  assert.equal(boundaryFeature.properties.bupi_rgg_id, sintraParcel.bupiRggId);
  assert.equal(boundaryFeature.properties.vertex_count, expectedVertexCount);
  assert.equal(boundaryFeature.properties.exported_at, '2026-11-15T16:00:00.000Z');

  const rings = boundaryFeature.geometry.coordinates as number[][][];
  assert.equal(rings.length, 1);
  const exteriorRing = rings[0];
  assert.equal(exteriorRing.length, expectedVertexCount + 1, 'Polygon ring must have N + 1 coordinates');
  assert.deepEqual(exteriorRing[0], exteriorRing[exteriorRing.length - 1], 'Polygon ring must be explicitly closed');

  // Verify [longitude, latitude] ordering for Continental Portugal (lon < 0, lat > 36) and CCW orientation
  let signedDoubleArea = 0;
  for (let i = 0; i < exteriorRing.length - 1; i++) {
    const [lon1, lat1] = exteriorRing[i];
    const [lon2, lat2] = exteriorRing[i + 1];
    assert.ok(lon1 < -6 && lon1 > -10, `Expected Portuguese longitude, got ${lon1}`);
    assert.ok(lat1 > 36 && lat1 < 43, `Expected Portuguese latitude, got ${lat1}`);
    signedDoubleArea += lon1 * lat2 - lon2 * lat1;
  }
  assert.ok(signedDoubleArea > 0, 'Exterior GeoJSON ring should follow RFC 7946 counterclockwise winding');

  // Verify each exported Point vertex matches original vertices and carries EPSG:3763 metric coordinates
  for (let idx = 0; idx < expectedVertexCount; idx++) {
    const ptFeature = parsed.features[idx + 1];
    assert.equal(ptFeature.geometry.type, 'Point');
    assert.equal(ptFeature.properties.feature_role, 'PARCEL_VERTEX');
    assert.equal(ptFeature.properties.vertex_index, idx + 1);
    const coords = ptFeature.geometry.coordinates as [number, number];
    assert.equal(coords[0], Number(sintraParcel.vertices[idx].lon.toFixed(6)));
    assert.equal(coords[1], Number(sintraParcel.vertices[idx].lat.toFixed(6)));
    assert.equal(typeof ptFeature.properties.pt_tm06_x_m, 'number');
    assert.equal(typeof ptFeature.properties.pt_tm06_y_m, 'number');
  }

  // Verify already-closed input vertices are deduplicated before closing
  const preClosedParcel = {
    ...sintraParcel,
    vertices: [...sintraParcel.vertices, sintraParcel.vertices[0]],
  };
  const dedupParsed = JSON.parse(buildParcelVerticesGeoJson(preClosedParcel)) as typeof parsed;
  assert.equal(dedupParsed.features.length, 1 + expectedVertexCount);
  assert.equal((dedupParsed.features[0].geometry.coordinates as number[][][])[0].length, expectedVertexCount + 1);
});

test('appShellMode separates WebView Homepage vs WebApp Onboarding Splash, validates local sessions, and hardens Redis against vm.overcommit_memory=0', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const {
    ONBOARDING_SLIDES,
    buildLocalSessionProfile,
    clearLocalAuthSession,
    detectEntryExperienceMode,
    loadLocalAuthSession,
    saveLocalAuthSession,
    shouldAutoStartWorkspace,
    validateLocalSessionInput,
  } = await import('./appShellMode.ts');

  // 1. Standard browser webview defaults to Homepage
  assert.equal(detectEntryExperienceMode({}), 'WEBVIEW_HOMEPAGE');
  assert.equal(detectEntryExperienceMode({ search: '?utm_source=partilha' }), 'WEBVIEW_HOMEPAGE');

  // 2. Standalone PWA, iOS navigator.standalone, Android TWA, and ?mode=webapp route to WebApp Onboarding Splash
  assert.equal(detectEntryExperienceMode({ isStandaloneDisplay: true }), 'WEBAPP_ONBOARDING');
  assert.equal(detectEntryExperienceMode({ navigatorStandalone: true }), 'WEBAPP_ONBOARDING');
  assert.equal(detectEntryExperienceMode({ referrer: 'android-app://pt.faixasegura.twa' }), 'WEBAPP_ONBOARDING');
  assert.equal(detectEntryExperienceMode({ search: '?mode=webapp' }), 'WEBAPP_ONBOARDING');
  assert.equal(detectEntryExperienceMode({ search: '?pwa=1' }), 'WEBAPP_ONBOARDING');

  // 3. Explicit override wins over display-mode
  assert.equal(
    detectEntryExperienceMode({ isStandaloneDisplay: true, overrideMode: 'webview' }),
    'WEBVIEW_HOMEPAGE'
  );
  assert.equal(
    detectEntryExperienceMode({ isStandaloneDisplay: false, overrideMode: 'webapp' }),
    'WEBAPP_ONBOARDING'
  );

  // 4. ?autostart=1 detection & onboarding slides integrity
  assert.equal(shouldAutoStartWorkspace(''), false);
  assert.equal(shouldAutoStartWorkspace('?autostart=1'), true);
  assert.equal(shouldAutoStartWorkspace('?mode=webapp&autostart=true'), true);
  assert.equal(ONBOARDING_SLIDES.length, 3);

  // 5. Strict local session validation (never bypasses invalid input) & persistence lifecycle
  assert.equal(validateLocalSessionInput({ displayName: ' ' }).valid, false);
  assert.equal(validateLocalSessionInput({ displayName: 'Ana Costa', nif: '12345' }).valid, false);
  const validRes = validateLocalSessionInput({ displayName: '  Maria   Silva ', nif: '218 492 310' });
  assert.equal(validRes.valid, true);
  assert.equal(validRes.sanitizedName, 'Maria Silva');
  assert.equal(validRes.sanitizedNif, '218492310');

  const memMap = new Map<string, string>();
  const mockStorage = {
    getItem: (k: string) => memMap.get(k) ?? null,
    setItem: (k: string, v: string) => {
      memMap.set(k, v);
    },
    removeItem: (k: string) => {
      memMap.delete(k);
    },
  };
  assert.equal(loadLocalAuthSession(mockStorage), null);
  const createdProfile = buildLocalSessionProfile({
    displayName: 'Maria Silva',
    nif: '218492310',
    preferredDico: '1009',
  });
  saveLocalAuthSession(createdProfile, mockStorage);
  const restored = loadLocalAuthSession(mockStorage);
  assert.ok(restored);
  assert.equal(restored.displayName, 'Maria Silva');
  assert.equal(restored.nif, '218492310');
  assert.equal(restored.preferredDico, '1009');
  clearLocalAuthSession(mockStorage);
  assert.equal(loadLocalAuthSession(mockStorage), null);

  // 6. Verify docker-compose.yml configures Redis without fork BGSAVE snapshots and without forbidden vm.* sysctls
  const compose = fs.readFileSync(path.join(process.cwd(), 'docker-compose.yml'), 'utf8');
  assert.ok(compose.includes('--save ""'), 'Redis should disable RDB fork saves when used as TTL cache');
  assert.ok(compose.includes('--appendonly no'), 'Redis should disable AOF fork rewrites');
  assert.ok(compose.includes('--maxmemory 128mb'), 'Redis should cap memory with allkeys-lru');
  assert.ok(!compose.includes('sysctls:'), 'Compose must not set non-namespaced vm.overcommit_memory sysctl');

  // 7. Verify docs/server-setup.md documents vm.overcommit_memory = 1 in /etc/sysctl.conf and live application for Redis
  const serverSetupPath = path.join(process.cwd(), 'docs', 'server-setup.md');
  assert.ok(fs.existsSync(serverSetupPath), 'docs/server-setup.md must exist');
  const serverSetupDoc = fs.readFileSync(serverSetupPath, 'utf8');
  assert.ok(serverSetupDoc.includes('vm.overcommit_memory = 1'));
  assert.ok(serverSetupDoc.includes('/etc/sysctl.conf'));
  assert.ok(serverSetupDoc.includes('sysctl vm.overcommit_memory=1'));
  assert.ok(serverSetupDoc.includes('jemalloc/issues/1328'));
});

test('userWorkspaceStore handles parcel CRUD, EPSG:3763 spatial recomputation, per-parcel document uploads, favorite providers, settings, and DELETE_PARCEL offline sync', async () => {
  const { INITIAL_PARCELS } = await import('../data/seedCatalog.ts');
  const {
    MAX_PARCEL_DOCUMENT_BYTES,
    applyParcelUpdate,
    buildParcelDocumentRecord,
    createMemoryParcelDocumentStorage,
    filterDocumentsForParcel,
    formatVerticesMultiline,
    loadFavoriteProviderIds,
    loadUserAppSettings,
    parseVerticesMultiline,
    removeParcelSafely,
    saveFavoriteProviderIds,
    saveUserAppSettings,
    toggleFavoriteProviderId,
    validateDocumentUploadInput,
    validateParcelMutationInput,
  } = await import('./userWorkspaceStore.ts');
  const {
    OfflineSyncCoordinator,
    coalesceOutboxOperations,
    createMemoryOfflineStorageAdapter,
    mergeParcelsWithOffline,
  } = await import('./offlineStorage.ts');

  // 1. Parcel validation & multiline vertex parsing
  assert.equal(validateParcelMutationInput({ label: 'A', avgSlopePct: 12 }).valid, false);
  assert.equal(validateParcelMutationInput({ label: 'Quinta Nova', avgSlopePct: 140 }).valid, false);
  assert.equal(validateParcelMutationInput({ label: 'Quinta Nova', avgSlopePct: 18 }).valid, true);

  const badVerts = parseVerticesMultiline('38.7984, -9.4621\n38.7991, -9.4620');
  assert.equal(badVerts.valid, false);

  const baseParcel = INITIAL_PARCELS[0];
  const serializedVerts = formatVerticesMultiline(baseParcel.vertices);
  const parsedVerts = parseVerticesMultiline(serializedVerts);
  assert.equal(parsedVerts.valid, true);
  assert.equal(parsedVerts.vertices.length, baseParcel.vertices.length);

  // 2. applyParcelUpdate recomputes mandatory FGC buffer & E-REDES easement
  const updatedAgri = applyParcelUpdate(baseParcel, {
    label: '  Casal do Pinheiro Renovado  ',
    dico: '1009', // Leiria
    landClass: 'AGRICULTURE',
    hasEredesLine: false,
    hasProtectedOaks: false,
    avgSlopePct: 21.4,
  });
  assert.equal(updatedAgri.label, 'Casal do Pinheiro Renovado');
  assert.equal(updatedAgri.municipality, 'Leiria');
  assert.equal(updatedAgri.dico, '1009');
  assert.equal(updatedAgri.landClass, 'AGRICULTURE');
  assert.equal(updatedAgri.hasEredesLine, false);
  assert.equal(updatedAgri.eredesType, 'Sem linha aérea');
  assert.equal(updatedAgri.spatial.thirdPartyEasementM2, 0);
  assert.equal(updatedAgri.spatial.estimatedEredesSavingsEur, 0);
  // Switching FOREST_SCRUB + E-REDES -> AGRICULTURE without E-REDES changes mandatory clean area
  assert.notEqual(updatedAgri.spatial.mandatoryCleanAreaM2, baseParcel.spatial.mandatoryCleanAreaM2);

  // 3. removeParcelSafely protects last remaining parcel and switches activeParcelId when needed
  const delActive = removeParcelSafely(INITIAL_PARCELS, INITIAL_PARCELS[0].id, INITIAL_PARCELS[0].id);
  assert.equal(delActive.ok, true);
  assert.equal(delActive.nextParcels.length, INITIAL_PARCELS.length - 1);
  assert.equal(delActive.nextActiveParcelId, INITIAL_PARCELS[1].id);

  const singleList = [INITIAL_PARCELS[0]];
  const blockedLast = removeParcelSafely(singleList, INITIAL_PARCELS[0].id, INITIAL_PARCELS[0].id);
  assert.equal(blockedLast.ok, false);
  assert.equal(blockedLast.nextParcels.length, 1);

  // 4. Per-parcel document validation & storage lifecycle
  assert.equal(
    validateDocumentUploadInput({ parcelId: baseParcel.id, fileName: 'caderneta.pdf', sizeBytes: 0 }).valid,
    false
  );
  assert.equal(
    validateDocumentUploadInput({
      parcelId: baseParcel.id,
      fileName: 'huge.pdf',
      sizeBytes: MAX_PARCEL_DOCUMENT_BYTES + 10,
    }).valid,
    false
  );
  assert.equal(
    validateDocumentUploadInput({ parcelId: baseParcel.id, fileName: 'caderneta.pdf', sizeBytes: 24_500 }).valid,
    true
  );

  const docStore = createMemoryParcelDocumentStorage(true);
  const seededDocs = await docStore.loadDocuments();
  assert.equal(seededDocs.length, 2);
  assert.equal(filterDocumentsForParcel(seededDocs, baseParcel.id).length, 2);

  const customDoc = buildParcelDocumentRecord({
    id: 'doc-custom-fatura-1',
    parcelId: INITIAL_PARCELS[1].id,
    fileName: 'Fatura_Limpeza_2026.pdf',
    category: 'FATURA_LIMPEZA',
    mimeType: 'application/pdf',
    sizeBytes: 48_120,
    notes: 'Intervenção concluída na faixa de 50m.',
  });
  await docStore.saveDocument(customDoc);
  assert.equal(filterDocumentsForParcel(await docStore.loadDocuments(), INITIAL_PARCELS[1].id).length, 1);

  await docStore.deleteDocumentsByParcel(baseParcel.id);
  assert.equal(filterDocumentsForParcel(await docStore.loadDocuments(), baseParcel.id).length, 0);
  assert.equal(filterDocumentsForParcel(await docStore.loadDocuments(), INITIAL_PARCELS[1].id).length, 1);

  // 5. Favorite providers & user app settings persistence
  const kvMap = new Map<string, string>();
  const kv = {
    getItem: (k: string) => kvMap.get(k) ?? null,
    setItem: (k: string, v: string) => {
      kvMap.set(k, v);
    },
    removeItem: (k: string) => {
      kvMap.delete(k);
    },
  };
  let favs = loadFavoriteProviderIds(kv);
  assert.equal(favs.length, 1);
  favs = toggleFavoriteProviderId(favs, 'prov-serra-limpa');
  saveFavoriteProviderIds(favs, kv);
  assert.ok(loadFavoriteProviderIds(kv).includes('prov-serra-limpa'));
  favs = toggleFavoriteProviderId(favs, 'prov-serra-limpa');
  saveFavoriteProviderIds(favs, kv);
  assert.ok(!loadFavoriteProviderIds(kv).includes('prov-serra-limpa'));

  const savedSettings = saveUserAppSettings(
    {
      pirAlertThreshold: 3,
      proximityAlertRadiusKm: 25,
      autoDownloadCertificatePdf: true,
      defaultBufferRule: '100M_SETTLEMENT',
      offlineAutoSync: false,
      notifyQuotesWhatsapp: false,
    },
    kv
  );
  assert.equal(savedSettings.pirAlertThreshold, 3);
  assert.equal(loadUserAppSettings(kv).proximityAlertRadiusKm, 25);
  assert.equal(loadUserAppSettings(kv).offlineAutoSync, false);

  // 6. DELETE_PARCEL offline sync & outbox coalescing
  const coalesced = coalesceOutboxOperations([
    {
      opId: '1',
      type: 'SAVE_PARCEL',
      targetId: 'parcel-temp-99',
      parcel: baseParcel,
      createdAtMs: 100,
      attempts: 0,
    },
    {
      opId: '2',
      type: 'DELETE_PARCEL',
      targetId: 'parcel-temp-99',
      createdAtMs: 200,
      attempts: 0,
    },
  ]);
  assert.equal(coalesced.length, 1);
  assert.equal(coalesced[0].type, 'DELETE_PARCEL');

  let online = false;
  const cloudDeleted: string[] = [];
  const backendDeleted: string[] = [];
  const offlineAdapter = createMemoryOfflineStorageAdapter();
  const coordinator = new OfflineSyncCoordinator({
    storage: offlineAdapter,
    isOnline: () => online,
    transport: {
      saveParcel: async () => {},
      deleteParcel: async (_uid, pid) => {
        cloudDeleted.push(pid);
      },
      deleteParcelFromBackend: async (pid) => {
        backendDeleted.push(pid);
      },
      createHistory: async () => {},
      archiveHistory: async () => {},
      deleteHistory: async () => {},
    },
  });

  await coordinator.recordParcelDelete(baseParcel.id, 'uid-owner-1');
  const hydratedOffline = await coordinator.hydrateState();
  assert.ok(hydratedOffline.deletedParcelIds.includes(baseParcel.id));
  assert.equal(hydratedOffline.outbox.length, 1);
  assert.equal(hydratedOffline.outbox[0].type, 'DELETE_PARCEL');

  const mergedAfterDelete = mergeParcelsWithOffline(
    INITIAL_PARCELS,
    hydratedOffline.parcels,
    hydratedOffline.deletedParcelIds
  );
  assert.equal(mergedAfterDelete.some((p) => p.id === baseParcel.id), false);

  online = true;
  const flushRes = await coordinator.flushOutbox('uid-owner-1');
  assert.equal(flushRes.syncedCount, 1);
  assert.deepEqual(cloudDeleted, [baseParcel.id]);
  assert.deepEqual(backendDeleted, [baseParcel.id]);
});

test('parcel share deep-link helpers and computeParcelLeafletBounds resolve shared parcels and exact active parcel bounds', async () => {
  const { INITIAL_PARCELS } = await import('../data/seedCatalog.ts');
  const {
    buildParcelShareUrl,
    copyDeepLinkToClipboard,
    extractRequestedParcelId,
    resolveDeepLinkParcelSelection,
    shouldAutoStartWorkspace,
  } = await import('./appShellMode.ts');
  const { computeParcelLeafletBounds } = await import('./spatialEngine.ts');

  // 1. Deep-link URL generation strips transient params & hashes while encoding ?parcel=<id>
  const secondParcel = INITIAL_PARCELS[1];
  const shareUrl = buildParcelShareUrl(
    'https://faixasegura.pt/?autostart=1&mode=webapp&utm_source=campo#top',
    secondParcel.id
  );
  assert.equal(
    shareUrl,
    `https://faixasegura.pt/?utm_source=campo&parcel=${encodeURIComponent(secondParcel.id)}`
  );

  let writtenClipboardText = '';
  const copiedOk = await copyDeepLinkToClipboard(shareUrl, {
    writeText: async (text: string) => {
      writtenClipboardText = text;
    },
  });
  assert.equal(copiedOk, true);
  assert.equal(writtenClipboardText, shareUrl);

  const rejectedFallback = await copyDeepLinkToClipboard(shareUrl, {
    writeText: async () => {
      throw new Error('NotAllowedError');
    },
  });
  assert.equal(rejectedFallback, false);

  // 2. Extraction, workspace auto-start for recipients, and selection resolution
  const urlObj = new URL(shareUrl);
  assert.equal(extractRequestedParcelId(urlObj.search), secondParcel.id);
  assert.equal(extractRequestedParcelId('?parcel='), null);
  assert.equal(extractRequestedParcelId('?parcel=bad%20space!'), null);
  assert.equal(shouldAutoStartWorkspace(urlObj.search), true);

  const matched = resolveDeepLinkParcelSelection(
    INITIAL_PARCELS,
    secondParcel.id,
    INITIAL_PARCELS[0].id
  );
  assert.equal(matched.matched, true);
  assert.equal(matched.selectedId, secondParcel.id);

  const unmatched = resolveDeepLinkParcelSelection(
    INITIAL_PARCELS,
    'parcel-custom-not-loaded-yet',
    INITIAL_PARCELS[0].id
  );
  assert.equal(unmatched.matched, false);
  assert.equal(unmatched.selectedId, INITIAL_PARCELS[0].id);

  // 3. computeParcelLeafletBounds tightly encloses all parcel vertices and handles degenerate inputs
  for (const parcel of INITIAL_PARCELS) {
    const bounds = computeParcelLeafletBounds(parcel);
    assert.ok(bounds.southWest.lat < bounds.northEast.lat);
    assert.ok(bounds.southWest.lon < bounds.northEast.lon);
    assert.deepEqual(bounds.leafletBounds, [
      [bounds.southWest.lat, bounds.southWest.lon],
      [bounds.northEast.lat, bounds.northEast.lon],
    ]);
    for (const v of parcel.vertices) {
      assert.ok(v.lat >= bounds.southWest.lat - 1e-6 && v.lat <= bounds.northEast.lat + 1e-6);
      assert.ok(v.lon >= bounds.southWest.lon - 1e-6 && v.lon <= bounds.northEast.lon + 1e-6);
    }
  }

  const degenerateParcel = {
    ...INITIAL_PARCELS[0],
    vertices: [],
    spatial: {
      ...INITIAL_PARCELS[0].spatial,
      polygons: {
        ...INITIAL_PARCELS[0].spatial.polygons,
        parcel: [],
      },
    },
  };
  const fallbackBounds = computeParcelLeafletBounds(degenerateParcel);
  assert.ok(fallbackBounds.northEast.lat > fallbackBounds.southWest.lat);
  assert.ok(fallbackBounds.northEast.lon > fallbackBounds.southWest.lon);
});

test('OfflineTileCacheManager enumerates Web Mercator XYZ tiles, pre-downloads Orthophoto + Vector snapshots, serves CacheFirst offline without network, and enforces LRU limits', async () => {
  const { INITIAL_PARCELS } = await import('../data/seedCatalog.ts');
  const { computeParcelLeafletBounds } = await import('./spatialEngine.ts');
  const {
    OfflineTileCacheManager,
    buildOfflineFallbackTileSvgDataUrl,
    buildTileCacheKey,
    buildTileUrl,
    createMemoryTileStorageAdapter,
    enumerateParcelSnapshotTiles,
    formatByteSizePt,
    latLonToTileXY,
  } = await import('./offlineTileCache.ts');

  const sintraParcel = INITIAL_PARCELS[0];
  const bounds = computeParcelLeafletBounds(sintraParcel);

  // 1. Web Mercator Slippy Map tile coordinates & provider URL axis order (Esri z/y/x vs CARTO z/x/y)
  const tile18 = latLonToTileXY(bounds.center.lat, bounds.center.lon, 18);
  assert.ok(tile18.x > 120000 && tile18.x < 130000, `Expected Portuguese Z18 X tile, got ${tile18.x}`);
  assert.ok(tile18.y > 95000 && tile18.y < 105000, `Expected Portuguese Z18 Y tile, got ${tile18.y}`);

  const orthoUrl = buildTileUrl('ORTHOPHOTO', 18, tile18.x, tile18.y, {});
  const vectorUrl = buildTileUrl('VECTOR', 18, tile18.x, tile18.y, {});
  const cartoKeyUrl = buildTileUrl('VECTOR', 18, tile18.x, tile18.y, {
    VITE_CARTO_API_KEY: 'demo_carto_key_123',
  });
  assert.ok(
    orthoUrl.endsWith(`/World_Imagery/MapServer/tile/18/${tile18.y}/${tile18.x}`),
    'Esri World Imagery must format URL as /World_Imagery/MapServer/tile/{z}/{y}/{x}'
  );
  assert.ok(
    vectorUrl.endsWith(`/World_Topo_Map/MapServer/tile/18/${tile18.y}/${tile18.x}`),
    'Default Vector/Topographic basemap must use watermark-free World_Topo_Map /tile/{z}/{y}/{x}'
  );
  assert.ok(
    cartoKeyUrl.includes(`/light_all/18/${tile18.x}/${tile18.y}.png?key=demo_carto_key_123`),
    'Optional VITE_CARTO_API_KEY must enable authenticated CARTO Positron tiles'
  );

  const enumerated = enumerateParcelSnapshotTiles(bounds, {
    zoomLevels: [17, 18],
    styles: ['ORTHOPHOTO', 'VECTOR'],
    marginTiles: 1,
  });
  assert.ok(enumerated.length >= 18, 'Expected multi-zoom Orthophoto + Vector tile coverage');
  assert.ok(
    enumerated.some((t) => t.key === buildTileCacheKey('ORTHOPHOTO', 18, tile18.x, tile18.y))
  );
  assert.ok(
    enumerated.some((t) => t.key === buildTileCacheKey('VECTOR', 18, tile18.x, tile18.y))
  );

  // 2. Snapshot pre-download while online -> switch to offline -> 100% CacheFirst hits with zero network calls
  let online = true;
  let networkFetchCount = 0;
  let clockMs = 1763220000000;
  const storage = createMemoryTileStorageAdapter();

  const capLimit = enumerated.length + 10;
  const manager = new OfflineTileCacheManager({
    storage,
    isOnline: () => online,
    maxCachedTiles: capLimit,
    nowMs: () => {
      clockMs += 10;
      return clockMs;
    },
    fetchFn: async (url) => {
      networkFetchCount += 1;
      const bytes = new TextEncoder().encode(`TILE_BINARY:${url}`);
      return {
        ok: true,
        mimeType: url.endsWith('.png') ? 'image/png' : 'image/jpeg',
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    },
  });

  const progressUpdates: number[] = [];
  const snapshot = await manager.downloadParcelSnapshot(
    sintraParcel,
    (prog) => progressUpdates.push(prog.completedTiles),
    { zoomLevels: [17, 18], marginTiles: 1, concurrency: 4 }
  );

  assert.equal(snapshot.parcelId, sintraParcel.id);
  assert.equal(snapshot.tileCount, enumerated.length);
  assert.equal(networkFetchCount, enumerated.length);
  assert.equal(progressUpdates[progressUpdates.length - 1], enumerated.length);
  assert.ok(formatByteSizePt(snapshot.totalBytes).includes('KB') || formatByteSizePt(snapshot.totalBytes).includes('B'));

  // Go completely offline and verify both ORTHOPHOTO and VECTOR tiles resolve from cache without calling fetchFn
  online = false;
  const fetchesBeforeOfflineReads = networkFetchCount;

  for (const t of enumerated) {
    const served = await manager.getOrFetchTile({
      style: t.style,
      z: t.z,
      x: t.x,
      y: t.y,
      parcelId: sintraParcel.id,
    });
    assert.ok(served, `Expected cached offline tile for ${t.key}`);
    assert.equal(served.source, 'CACHE');
    assert.ok(served.data.byteLength > 0);
  }
  assert.equal(networkFetchCount, fetchesBeforeOfflineReads, 'Zero network calls allowed while offline');

  // Uncached distant tile while offline returns null cleanly and SVG fallback generator produces valid SVG data URI
  const uncachedOffline = await manager.getOrFetchTile({
    style: 'ORTHOPHOTO',
    z: 18,
    x: 10,
    y: 10,
  });
  assert.equal(uncachedOffline, null);
  const svgFallback = buildOfflineFallbackTileSvgDataUrl('ORTHOPHOTO', 18, 10, 10);
  assert.ok(svgFallback.startsWith('data:image/svg+xml;charset=utf-8,'));
  assert.ok(decodeURIComponent(svgFallback).includes('Z18 (10,10)'));

  // Attempting to download a new snapshot while offline rejects cleanly
  await assert.rejects(() => manager.downloadParcelSnapshot(INITIAL_PARCELS[1]));

  // 3. Reconnect online & exceed maxCachedTiles -> opportunistic non-pinned tiles evicted before pinned snapshot tiles
  online = true;
  for (let extraX = 500; extraX < 530; extraX++) {
    await manager.getOrFetchTile({ style: 'VECTOR', z: 16, x: extraX, y: 500, parcelId: null });
  }
  const statsAfterCap = await manager.getStats();
  assert.ok(
    statsAfterCap.tileCount <= capLimit,
    `Expected <= ${capLimit} tiles after LRU cap, got ${statsAfterCap.tileCount}`
  );

  // Pinned Sintra center tile remains intact even after opportunistic overflow
  const stillPinned = await manager.getCachedTile('ORTHOPHOTO', 18, tile18.x, tile18.y);
  assert.ok(stillPinned, 'Pinned parcel snapshot tile must survive opportunistic LRU eviction');

  // 4. Deleting snapshot & clearing cache cleans up tiles and metadata
  await manager.deleteParcelSnapshot(sintraParcel.id);
  assert.equal((await manager.listSnapshots()).length, 0);
  await manager.clearAll();
  const emptyStats = await manager.getStats();
  assert.equal(emptyStats.tileCount, 0);
  assert.equal(emptyStats.snapshotCount, 0);
});

test('userWorkspaceStore persists Dark Mode theme preference and builds the 7-item User thumbnail gallery catalog', async () => {
  const {
    LS_KEY_THEME_DARK,
    buildUserGalleryCatalog,
    loadThemeDarkPreference,
    saveThemeDarkPreference,
  } = await import('./userWorkspaceStore.ts');

  const storeMap = new Map<string, string>();
  const kv = {
    getItem: (k: string) => storeMap.get(k) ?? null,
    setItem: (k: string, v: string) => {
      storeMap.set(k, v);
    },
    removeItem: (k: string) => {
      storeMap.delete(k);
    },
  };

  assert.equal(loadThemeDarkPreference(kv), false);
  assert.equal(saveThemeDarkPreference(true, kv), true);
  assert.equal(storeMap.get(LS_KEY_THEME_DARK), 'true');
  assert.equal(loadThemeDarkPreference(kv), true);
  assert.equal(saveThemeDarkPreference(false, kv), false);
  assert.equal(loadThemeDarkPreference(kv), false);

  const lightCatalog = buildUserGalleryCatalog({
    parcelCount: 3,
    documentCount: 4,
    favoriteProviderCount: 2,
    darkMode: false,
    historyCount: 6,
    certificateCount: 2,
    displayName: 'António Ferreira',
    isCloudSession: false,
  });

  assert.deepEqual(
    lightCatalog.map((item) => item.id),
    ['properties', 'favorites', 'settings', 'theme', 'history', 'docs', 'logout']
  );

  const themeLight = lightCatalog.find((i) => i.id === 'theme');
  assert.ok(themeLight);
  assert.equal(themeLight.actionKind, 'SECTION');
  assert.ok(themeLight.kicker.includes('Modo Solar'));

  const historyCard = lightCatalog.find((i) => i.id === 'history');
  assert.ok(historyCard);
  assert.equal(historyCard.actionKind, 'SECTION');
  assert.equal(historyCard.kicker, '6 registos · 2 autos SHA-256');

  const logoutCard = lightCatalog.find((i) => i.id === 'logout');
  assert.ok(logoutCard);
  assert.equal(logoutCard.actionKind, 'LOGOUT');
  assert.equal(logoutCard.kicker, 'Sessão local ativa');

  const darkCatalog = buildUserGalleryCatalog({
    parcelCount: 3,
    documentCount: 4,
    favoriteProviderCount: 2,
    darkMode: true,
    historyCount: 6,
    certificateCount: 2,
    displayName: 'António Ferreira',
    isCloudSession: true,
  });
  assert.equal(darkCatalog.find((i) => i.id === 'theme')?.kicker, 'Modo Escuro ativo');
  assert.equal(darkCatalog.find((i) => i.id === 'logout')?.kicker, 'Sessão Google Cloud ativa');
});

test('FaixaSegura PWA logo icons meet exact PNG/SVG manifest specs and User gallery resolves 3 vs 2 columns across viewports', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { resolveExpectedUserGalleryColumns } = await import('./userWorkspaceStore.ts');

  // 1. Responsive User gallery column rules:
  // Web & Tablet horizontal -> 3 per row; Mobile & Tablet vertical -> 2 per row
  assert.equal(resolveExpectedUserGalleryColumns(1440, 900), 3); // Web desktop
  assert.equal(resolveExpectedUserGalleryColumns(1280, 800), 3); // Web laptop
  assert.equal(resolveExpectedUserGalleryColumns(1024, 768), 3); // Tablet horizontal (iPad landscape)
  assert.equal(resolveExpectedUserGalleryColumns(1180, 820), 3); // Tablet horizontal (iPad Air landscape)
  assert.equal(resolveExpectedUserGalleryColumns(960, 600), 3);  // Compact tablet horizontal
  assert.equal(resolveExpectedUserGalleryColumns(768, 1024), 2); // Tablet vertical (iPad portrait)
  assert.equal(resolveExpectedUserGalleryColumns(820, 1180), 2); // Tablet vertical (iPad Air portrait)
  assert.equal(resolveExpectedUserGalleryColumns(1024, 1366), 2); // Tablet vertical (iPad Pro portrait)
  assert.equal(resolveExpectedUserGalleryColumns(390, 844), 2);  // Mobile portrait
  assert.equal(resolveExpectedUserGalleryColumns(667, 375), 2);  // Mobile landscape

  // 2. PWA icon binaries & SVG verification
  const rootDir = path.resolve(import.meta.dirname, '../..');
  const svgContent = fs.readFileSync(path.join(rootDir, 'public/icon.svg'), 'utf8');
  assert.ok(svgContent.includes('<polygon'), 'Expected geometric boundary polygons in public/icon.svg');
  assert.ok(svgContent.includes('#14532D'), 'Expected brand forest green #14532D in public/icon.svg');

  const pngExpectations: Array<{ file: string; width: number; height: number }> = [
    { file: 'public/pwa-192x192.png', width: 192, height: 192 },
    { file: 'public/pwa-512x512.png', width: 512, height: 512 },
    { file: 'public/pwa-maskable-512x512.png', width: 512, height: 512 },
    { file: 'public/apple-touch-icon.png', width: 180, height: 180 },
  ];

  for (const spec of pngExpectations) {
    const buf = fs.readFileSync(path.join(rootDir, spec.file));
    // PNG magic signature: 89 50 4E 47 0D 0A 1A 0A
    assert.equal(buf[0], 0x89, `${spec.file} must start with PNG magic byte`);
    assert.equal(buf.toString('ascii', 1, 4), 'PNG', `${spec.file} must be a valid PNG`);
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    assert.equal(width, spec.width, `${spec.file} width must be ${spec.width}`);
    assert.equal(height, spec.height, `${spec.height} height must be ${spec.height}`);
  }

  const manifest = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'public/manifest.json'), 'utf8')
  ) as {
    short_name: string;
    display: string;
    icons: Array<{ src: string; sizes: string; purpose: string }>;
  };
  assert.ok(manifest.short_name.length <= 12);
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((i) => i.sizes === '192x192' && i.purpose === 'any'));
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'any'));
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
});

test('Public QR certificate scanner decodes real QR RGBA frames, parses ?verify= URLs and hashes, and resolves certificates', async () => {
  const QRCode = (await import('qrcode')).default;
  const { INITIAL_CERTIFICATES } = await import('../data/seedCatalog.ts');
  const {
    decodeQrRgbaFrame,
    describeCameraAccessErrorPt,
    findCertificateByScannedPayload,
    parseCertificateVerifyPayload,
    resolveCertificateFromPayload,
  } = await import('./qrVerification.ts');

  const demoCert = INITIAL_CERTIFICATES[0];

  // 1. Parse diverse QR & manual payload formats
  assert.deepEqual(
    parseCertificateVerifyPayload(`https://faixasegura.pt/?verify=${demoCert.shortCode}`),
    {
      candidateCode: demoCert.shortCode,
      sourceKind: 'VERIFY_QUERY',
      rawTrimmed: `https://faixasegura.pt/?verify=${demoCert.shortCode}`,
    }
  );
  assert.equal(
    parseCertificateVerifyPayload(`https://faixasegura.pt/verify/${demoCert.shortCode}`).candidateCode,
    demoCert.shortCode
  );
  assert.equal(
    parseCertificateVerifyPayload(`#${demoCert.shortCode.toLowerCase()}`).candidateCode,
    demoCert.shortCode
  );
  assert.equal(
    parseCertificateVerifyPayload(demoCert.sha256Hash).sourceKind,
    'SHA256_HASH'
  );
  assert.equal(
    parseCertificateVerifyPayload('https://menu.restaurante-exemplo.pt/carta').sourceKind,
    'UNRELATED_URL'
  );
  assert.equal(
    parseCertificateVerifyPayload('https://menu.restaurante-exemplo.pt/carta').candidateCode,
    null
  );

  // 2. Real end-to-end QR generation -> RGBA frame -> jsQR decode -> certificate match
  const verifyUrl = `http://localhost:3000/?verify=${encodeURIComponent(demoCert.shortCode)}`;
  const qrMatrix = QRCode.create(verifyUrl, { errorCorrectionLevel: 'M' });
  const moduleCount = qrMatrix.modules.size;
  const scale = 6;
  const margin = 4;
  const imgSize = (moduleCount + margin * 2) * scale;
  const rgba = new Uint8ClampedArray(imgSize * imgSize * 4);
  rgba.fill(255);

  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      const isDark = qrMatrix.modules.get(row, col) !== 0;
      if (!isDark) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = (col + margin) * scale + dx;
          const py = (row + margin) * scale + dy;
          const idx = (py * imgSize + px) * 4;
          rgba[idx] = 0;
          rgba[idx + 1] = 0;
          rgba[idx + 2] = 0;
          rgba[idx + 3] = 255;
        }
      }
    }
  }

  const decodedUrl = decodeQrRgbaFrame(rgba, imgSize, imgSize);
  assert.equal(decodedUrl, verifyUrl);

  const matchedLocal = findCertificateByScannedPayload(INITIAL_CERTIFICATES, decodedUrl ?? '');
  assert.ok(matchedLocal.certificate);
  assert.equal(matchedLocal.certificate.shortCode, demoCert.shortCode);

  // 3. Remote fallback & unmatched error reporting
  const remoteResolved = await resolveCertificateFromPayload({
    certificates: [],
    rawPayload: verifyUrl,
    fetchRemoteByCode: async (code) => (code === demoCert.shortCode ? demoCert : null),
  });
  assert.equal(remoteResolved.certificate?.id, demoCert.id);
  assert.equal(remoteResolved.errorPt, null);

  const missingResolved = await resolveCertificateFromPayload({
    certificates: INITIAL_CERTIFICATES,
    rawPayload: 'FS-20990101-DEAD',
    fetchRemoteByCode: async () => null,
  });
  assert.equal(missingResolved.certificate, null);
  assert.ok(missingResolved.errorPt?.includes('FS-20990101-DEAD'));

  // 4. Camera error descriptions in Portuguese
  assert.ok(
    describeCameraAccessErrorPt({ name: 'NotAllowedError' }, true).includes('recusado')
  );
  assert.ok(
    describeCameraAccessErrorPt(null, false).includes('câmara')
  );
});

test('High Contrast sunlight mode persists preference and resolves orthogonal dark + high-contrast root classes', async () => {
  const {
    LS_KEY_THEME_HIGH_CONTRAST,
    loadHighContrastPreference,
    resolveDocumentThemeClasses,
    saveHighContrastPreference,
  } = await import('./userWorkspaceStore.ts');

  const mem = new Map<string, string>();
  const mockStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, v);
    },
    removeItem: (k: string) => {
      mem.delete(k);
    },
  };

  assert.equal(loadHighContrastPreference(mockStorage), false);
  assert.equal(saveHighContrastPreference(true, mockStorage), true);
  assert.equal(mem.get(LS_KEY_THEME_HIGH_CONTRAST), 'true');
  assert.equal(loadHighContrastPreference(mockStorage), true);

  assert.equal(saveHighContrastPreference(false, mockStorage), false);
  assert.equal(loadHighContrastPreference(mockStorage), false);

  // Verify all 4 combinations of (darkMode x highContrastMode)
  assert.deepEqual(resolveDocumentThemeClasses({ darkMode: false, highContrastMode: false }), {
    activeClasses: [],
    inactiveClasses: ['dark', 'high-contrast'],
    dataHighContrast: 'false',
  });
  assert.deepEqual(resolveDocumentThemeClasses({ darkMode: false, highContrastMode: true }), {
    activeClasses: ['high-contrast'],
    inactiveClasses: ['dark'],
    dataHighContrast: 'true',
  });
  assert.deepEqual(resolveDocumentThemeClasses({ darkMode: true, highContrastMode: false }), {
    activeClasses: ['dark'],
    inactiveClasses: ['high-contrast'],
    dataHighContrast: 'false',
  });
  assert.deepEqual(resolveDocumentThemeClasses({ darkMode: true, highContrastMode: true }), {
    activeClasses: ['dark', 'high-contrast'],
    inactiveClasses: [],
    dataHighContrast: 'true',
  });
});

test('QR Scan History retains the last 5 validated certificates, deduplicates re-scans, and wires #public-verify-code-input High Contrast indicator', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { INITIAL_CERTIFICATES, INITIAL_PARCELS } = await import('../data/seedCatalog.ts');
  const {
    LS_KEY_QR_SCAN_HISTORY,
    MAX_QR_SCAN_HISTORY_ITEMS,
    appendQrScanHistory,
    clearQrScanHistory,
    loadQrScanHistory,
    recordScannedCertificateInHistory,
  } = await import('./qrVerification.ts');

  assert.equal(MAX_QR_SCAN_HISTORY_ITEMS, 5);

  const mem = new Map<string, string>();
  const mockStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, v);
    },
    removeItem: (k: string) => {
      mem.delete(k);
    },
  };

  // 1. Empty and corrupted storage resilience
  assert.deepEqual(loadQrScanHistory(mockStorage), []);
  mem.set(LS_KEY_QR_SCAN_HISTORY, '{invalid-json');
  assert.deepEqual(loadQrScanHistory(mockStorage), []);
  mem.set(LS_KEY_QR_SCAN_HISTORY, JSON.stringify([{ bad: true }]));
  assert.deepEqual(loadQrScanHistory(mockStorage), []);

  // 2. Build 6 distinct ComplianceCertificates and verify strict last-5 cap + newest-first order
  const baseCert = INITIAL_CERTIFICATES[0];
  const sixCerts = Array.from({ length: 6 }, (_, idx) => {
    const parcel = INITIAL_PARCELS[idx % INITIAL_PARCELS.length];
    const num = idx + 1;
    return {
      ...baseCert,
      id: `cert-hist-${num}`,
      shortCode: `FS-2026110${num}-A00${num}`,
      parcelId: parcel.id,
      parcelLabel: parcel.label,
      municipality: parcel.municipality,
      parish: parcel.parish,
      sha256Hash: `${String(num).repeat(64)}`.slice(0, 64),
    };
  });

  for (let i = 0; i < sixCerts.length; i++) {
    appendQrScanHistory(sixCerts[i], {
      scannedAtIso: `2026-11-16T10:0${i}:00.000Z`,
      source: i % 2 === 0 ? 'CAMERA' : 'IMAGE',
      storage: mockStorage,
    });
  }

  const afterSix = loadQrScanHistory(mockStorage);
  assert.equal(afterSix.length, 5, 'Scan History must cap strictly at the last 5 scanned certificates');
  assert.deepEqual(
    afterSix.map((e) => e.certificate.shortCode),
    [
      'FS-20261106-A006',
      'FS-20261105-A005',
      'FS-20261104-A004',
      'FS-20261103-A003',
      'FS-20261102-A002',
    ]
  );

  // 3. Re-scanning an existing certificate moves it to index 0 without duplicating
  const rescanned = recordScannedCertificateInHistory(afterSix, sixCerts[2], {
    scannedAtIso: '2026-11-16T10:30:00.000Z',
    source: 'MANUAL_CODE',
  });
  assert.equal(rescanned.length, 5);
  assert.equal(rescanned[0].certificate.shortCode, 'FS-20261103-A003');
  assert.equal(rescanned[0].source, 'MANUAL_CODE');
  assert.deepEqual(
    rescanned.map((e) => e.certificate.shortCode),
    [
      'FS-20261103-A003',
      'FS-20261106-A006',
      'FS-20261105-A005',
      'FS-20261104-A004',
      'FS-20261102-A002',
    ]
  );

  // 4. Clearing scan history empties persisted state
  clearQrScanHistory(mockStorage);
  assert.deepEqual(loadQrScanHistory(mockStorage), []);

  // 5. Verify #public-verify-code-input High Contrast indicator wiring in PublicWebviewHomepage.tsx
  const homepageSrc = fs.readFileSync(
    path.resolve(import.meta.dirname, '../components/PublicWebviewHomepage.tsx'),
    'utf8'
  );
  assert.ok(homepageSrc.includes('id="public-verify-code-input"'));
  assert.ok(homepageSrc.includes('id="public-verify-hc-indicator"'));
  assert.ok(homepageSrc.includes('data-testid="public-verify-hc-badge"'));
  assert.ok(
    homepageSrc.includes("'public-verify-hc-indicator public-verify-code-feedback'")
  );
});

test('Portugal administrative catalog covers all 20 districts, 308 municipalities, cascading parishes, Matrix Article & BUPi custom options, Local LLM notes, and automatic offline/online sync', async () => {
  const {
    CUSTOM_USER_INPUT_VALUE,
    FULL_PORTUGAL_MUNICIPALITIES,
    PORTUGAL_DISTRICTS,
    PORTUGAL_PARISHES_BY_DICO,
    buildBupiCodeOptions,
    buildMatrixArticleOptions,
    findMunicipalityByDico,
    getDistrictsList,
    getMunicipalitiesByDistrict,
    getParishesByMunicipality,
    getTotalPortugalParishesCount,
    resolveDropdownOrCustomValue,
  } = await import('../data/portugalAdminCatalog.ts');
  const { buildLocalParcelRecord } = await import('./offlineParcelBuilder.ts');
  const { applyParcelUpdate, buildParcelLocalLlmNotePayload } = await import('./userWorkspaceStore.ts');
  const {
    OfflineSyncCoordinator,
    computeEffectivePendingSyncCount,
    createMemoryOfflineStorageAdapter,
  } = await import('./offlineStorage.ts');

  // 1. All 20 official districts + 308 Portuguese municipalities with unique 4-digit DICOs
  const districts = getDistrictsList();
  assert.equal(districts.length, 20);
  assert.equal(PORTUGAL_DISTRICTS.length, 20);
  assert.equal(FULL_PORTUGAL_MUNICIPALITIES.length, 308);
  const uniqueDicos = new Set(FULL_PORTUGAL_MUNICIPALITIES.map((m) => m.dico));
  assert.equal(uniqueDicos.size, 308, 'Every Portuguese municipality must have a unique DICO');
  assert.equal(FULL_PORTUGAL_MUNICIPALITIES[0].dico, '1111', 'Sintra remains primary index 0');

  // 2. Strictly filtered municipalities by district & parishes by municipality
  const portoMunis = getMunicipalitiesByDistrict('Porto');
  assert.equal(portoMunis.length, 18);
  assert.ok(portoMunis.every((m) => m.district === 'Porto'));

  const leiriaMunis = getMunicipalitiesByDistrict('Leiria');
  assert.equal(leiriaMunis.length, 16);
  assert.ok(leiriaMunis.every((m) => m.district === 'Leiria'));

  const sintraParishes = getParishesByMunicipality({ dico: '1111', municipalityName: 'Sintra' });
  assert.ok(sintraParishes.includes('Colares'));
  assert.equal(sintraParishes.length, 15, 'Sintra must return all 15 official CAOP parishes');

  const lisboaParishes = getParishesByMunicipality({ dico: '1106', municipalityName: 'Lisboa' });
  assert.equal(lisboaParishes.length, 24, 'Lisboa must return all 24 official CAOP parishes');

  const barcelosParishes = getParishesByMunicipality({ dico: '0302', municipalityName: 'Barcelos' });
  assert.equal(barcelosParishes.length, 65, 'Barcelos must return all 65 official CAOP parishes');

  const pontaDelgadaParishes = getParishesByMunicipality({
    dico: '4203',
    municipalityName: 'Ponta Delgada',
  });
  assert.equal(pontaDelgadaParishes.length, 24, 'Ponta Delgada (Açores) must return all 24 parishes');

  const funchalParishes = getParishesByMunicipality({ dico: '3103', municipalityName: 'Funchal' });
  assert.equal(funchalParishes.length, 10, 'Funchal (Madeira) must return all 10 parishes');

  // Exhaustively verify EVERY SINGLE ONE of the 308 municipalities has complete official CAOP parishes and zero synthetic placeholders
  assert.equal(Object.keys(PORTUGAL_PARISHES_BY_DICO).length, 308);
  assert.equal(getTotalPortugalParishesCount(), 3259);
  for (const muni of FULL_PORTUGAL_MUNICIPALITIES) {
    const list = getParishesByMunicipality({ dico: muni.dico, municipalityName: muni.name });
    assert.ok(list.length >= 1, `Municipality ${muni.name} (${muni.dico}) must have >= 1 parish`);
    assert.ok(
      list.every(
        (p) =>
          !p.includes('(Sede de Concelho)') &&
          !p.includes('Zona Rural Norte') &&
          !p.includes('Zona Florestal Sul')
      ),
      `Municipality ${muni.name} (${muni.dico}) must not contain synthetic fallback placeholders`
    );
  }

  const arouca = findMunicipalityByDico('0104');
  assert.equal(arouca.name, 'Arouca');
  assert.equal(arouca.district, 'Aveiro');
  const aroucaParishes = getParishesByMunicipality({
    dico: arouca.dico,
    municipalityName: arouca.name,
  });
  assert.equal(aroucaParishes.length, 16);
  assert.ok(aroucaParishes.some((p) => p.includes('Arouca')));

  // 3. Artigo Matricial & Código BUPi options include CUSTOM_USER_INPUT_VALUE and resolve custom inputs
  const matrixOpts = buildMatrixArticleOptions({
    landClass: 'FOREST_SCRUB',
    dico: '1009',
    municipalityName: 'Leiria',
  });
  assert.ok(matrixOpts.length >= 5);
  assert.equal(matrixOpts[matrixOpts.length - 1].value, CUSTOM_USER_INPUT_VALUE);
  assert.equal(
    resolveDropdownOrCustomValue({
      selectedOption: CUSTOM_USER_INPUT_VALUE,
      customInput: '  Rústico — Art.º 999, Secção Z  ',
      fallbackValue: 'Fallback',
    }),
    'Rústico — Art.º 999, Secção Z'
  );

  const bupiOpts = buildBupiCodeOptions({
    dico: '1009',
    municipalityName: 'Leiria',
  });
  assert.ok(bupiOpts.length >= 5);
  assert.equal(bupiOpts[bupiOpts.length - 1].value, CUSTOM_USER_INPUT_VALUE);
  assert.equal(
    resolveDropdownOrCustomValue({
      selectedOption: CUSTOM_USER_INPUT_VALUE,
      customInput: '  RGG-CUSTOM-2026-LEI  ',
      fallbackValue: 'Fallback',
    }),
    'RGG-CUSTOM-2026-LEI'
  );

  // 4. Local LLM structured notes envelope + polygon vertex update recalculation
  const created = buildLocalParcelRecord({
    label: 'Pinhal da Barosa Norte',
    district: 'Leiria',
    dico: '1009',
    parish: 'Marrazes e Barosa',
    matrixArticle: 'Rústico — Art.º 999, Secção Z',
    bupiRggId: 'RGG-CUSTOM-2026-LEI',
    landClass: 'FOREST_SCRUB',
    avgSlopePct: 14,
    hasEredesLine: false,
    hasProtectedOaks: true,
    userNotes: 'Acesso por estradão florestal norte; muro de pedra junto ao marco BUPi n.º 4; 3 sobreiros adultos na faixa.',
  });
  assert.equal(created.district, 'Leiria');
  assert.equal(created.municipality, 'Leiria');
  assert.ok(created.userNotes?.includes('marco BUPi'));

  const drawnPolygon = [
    { lat: 39.744, lon: -8.808 },
    { lat: 39.7452, lon: -8.808 },
    { lat: 39.7452, lon: -8.8062 },
    { lat: 39.744, lon: -8.8062 },
  ];
  const updated = applyParcelUpdate(created, {
    vertices: drawnPolygon,
    userNotes: 'Polígono redesenhado no mapa com 4 vértices; entrada de trator a este.',
    recenterVerticesOnMunicipalityChange: false,
  });
  assert.equal(updated.vertices.length, 4);
  assert.notEqual(updated.spatial.totalAreaM2, created.spatial.totalAreaM2);

  const llmEnvelope = buildParcelLocalLlmNotePayload(updated);
  assert.equal(llmEnvelope.schemaVersion, 'faixasegura.local-llm-notes.v1');
  assert.equal(llmEnvelope.district, 'Leiria');
  assert.equal(llmEnvelope.municipality, 'Leiria');
  assert.equal(llmEnvelope.parish, 'Marrazes e Barosa');
  assert.equal(llmEnvelope.bupiRggId, 'RGG-CUSTOM-2026-LEI');
  assert.equal(llmEnvelope.readyForExtraction, true);
  assert.ok(llmEnvelope.userNotes.includes('Polígono redesenhado'));

  // 5. Automatic offline -> online synchronization in both Local and Cloud sessions
  let online = false;
  const backendSaved: string[] = [];
  const cloudSaved: string[] = [];
  const coordinator = new OfflineSyncCoordinator({
    storage: createMemoryOfflineStorageAdapter(),
    isOnline: () => online,
    transport: {
      saveParcel: async (_uid, p) => {
        if (!online) throw new Error('Network offline');
        cloudSaved.push(p.id);
      },
      deleteParcel: async () => {},
      createHistory: async () => {},
      archiveHistory: async () => {},
      deleteHistory: async () => {},
      syncParcelToBackend: async (p) => {
        if (!online) throw new Error('Network offline');
        backendSaved.push(p.id);
      },
    },
  });

  const offlineRes = await coordinator.recordParcel(updated, null);
  assert.equal(offlineRes.syncResult.offlineSkipped, true);
  let hydrated = await coordinator.hydrateState();
  assert.equal(computeEffectivePendingSyncCount(hydrated.outbox, false), 1);
  assert.equal(computeEffectivePendingSyncCount(hydrated.outbox, true), 1);

  // Reconnect in Local session -> backend syncs automatically, local pending drops to 0 while Firestore op remains queued for future Cloud sign-in
  online = true;
  const localReconnectFlush = await coordinator.flushOutbox(null);
  assert.equal(localReconnectFlush.backendSyncedCount, 1);
  assert.ok(localReconnectFlush.lastSyncedAtIso);
  assert.deepEqual(backendSaved, [updated.id]);
  hydrated = await coordinator.hydrateState();
  assert.equal(computeEffectivePendingSyncCount(hydrated.outbox, false), 0);
  assert.equal(computeEffectivePendingSyncCount(hydrated.outbox, true), 1);

  // Subsequent Cloud sign-in flushes remaining Firestore op automatically -> cloud pending drops to 0
  const cloudFlush = await coordinator.flushOutbox('cloud-user-123');
  assert.equal(cloudFlush.syncedCount, 1);
  assert.deepEqual(cloudSaved, [updated.id]);
  hydrated = await coordinator.hydrateState();
  assert.equal(computeEffectivePendingSyncCount(hydrated.outbox, true), 0);
});

test('polygon vertex helpers support individual vertex deletion, clear all, coordinate normalization, selection transitions, and EPSG:3763 recalculation', async () => {
  const {
    appendPolygonVertex,
    clearAllPolygonVertices,
    removePolygonVertexAt,
    resolveNextSelectedVertexIndexAfterRemoval,
    updatePolygonVertexAt,
  } = await import('./userWorkspaceStore.ts');
  const { computePolygonMetrics3763 } = await import('./spatialEngine.ts');

  let vertices = clearAllPolygonVertices();
  assert.deepEqual(vertices, []);

  vertices = appendPolygonVertex(vertices, { lat: 38.7984004, lon: -9.4621004 });
  vertices = appendPolygonVertex(vertices, { lat: 38.7992, lon: -9.4621 });
  vertices = appendPolygonVertex(vertices, { lat: 38.7996, lon: -9.4612 });
  vertices = appendPolygonVertex(vertices, { lat: 38.7992, lon: -9.4603 });
  vertices = appendPolygonVertex(vertices, { lat: 38.7984, lon: -9.4603 });
  assert.equal(vertices.length, 5);
  assert.deepEqual(vertices[0], { lat: 38.7984, lon: -9.4621 });

  const fiveVertexArea = computePolygonMetrics3763(vertices).areaM2;
  assert.ok(fiveVertexArea > 0);

  // Update vertex V3 (index 2)
  const movedVertices = updatePolygonVertexAt(vertices, 2, { lat: 38.7999, lon: -9.4612 });
  assert.equal(movedVertices.length, 5);
  assert.equal(movedVertices[2].lat, 38.7999);
  assert.equal(vertices[2].lat, 38.7996); // Immutability preserved
  assert.ok(computePolygonMetrics3763(movedVertices).areaM2 > fiveVertexArea);

  // Out-of-bounds removal is a safe no-op copy
  assert.equal(removePolygonVertexAt(movedVertices, -1).length, 5);
  assert.equal(removePolygonVertexAt(movedVertices, 99).length, 5);

  // Remove middle vertex V3 (index 2) individually -> remaining 4 vertices form exact rectangle
  const afterRemoveMiddle = removePolygonVertexAt(movedVertices, 2);
  assert.equal(afterRemoveMiddle.length, 4);
  assert.deepEqual(afterRemoveMiddle[2], { lat: 38.7992, lon: -9.4603 });
  assert.ok(computePolygonMetrics3763(afterRemoveMiddle).areaM2 < fiveVertexArea);

  // Selection index transition rules after individual removal
  assert.equal(resolveNextSelectedVertexIndexAfterRemoval(3, 1, 4), 2);
  assert.equal(resolveNextSelectedVertexIndexAfterRemoval(1, 3, 4), 1);
  assert.equal(resolveNextSelectedVertexIndexAfterRemoval(3, 3, 3), 2);
  assert.equal(resolveNextSelectedVertexIndexAfterRemoval(0, 0, 0), null);
  assert.equal(resolveNextSelectedVertexIndexAfterRemoval(null, 0, 3), null);

  // Remove first vertex V1 (index 0) and last vertex individually
  const afterRemoveFirst = removePolygonVertexAt(afterRemoveMiddle, 0);
  assert.equal(afterRemoveFirst.length, 3);
  assert.deepEqual(afterRemoveFirst[0], { lat: 38.7992, lon: -9.4621 });

  // Clear all vertices at once
  const cleared = clearAllPolygonVertices();
  assert.equal(cleared.length, 0);
  assert.equal(computePolygonMetrics3763(cleared).areaM2, 0);
});

test('evaluatePublicVerifyCodeInput provides live character length feedback, FS-YYYYMMDD-XXXX format preview, and prominent High Contrast badge styling', async () => {
  const {
    CANONICAL_SHA256_LENGTH,
    CANONICAL_SHORT_CODE_LENGTH,
    CANONICAL_SHORT_CODE_TEMPLATE,
    evaluatePublicVerifyCodeInput,
  } = await import('./qrVerification.ts');
  const fs = await import('node:fs');
  const path = await import('node:path');

  // 1. Empty / whitespace input -> IDLE with full template mask and 0/16 counter
  const idle = evaluatePublicVerifyCodeInput('   ');
  assert.equal(idle.status, 'IDLE');
  assert.equal(idle.mode, 'SHORT_CODE');
  assert.equal(idle.isValidToSubmit, false);
  assert.equal(idle.currentLength, 0);
  assert.equal(idle.targetLength, CANONICAL_SHORT_CODE_LENGTH);
  assert.equal(idle.typedPreview, '');
  assert.equal(idle.remainingMask, CANONICAL_SHORT_CODE_TEMPLATE);
  assert.equal(idle.lengthBadgeText, '0/16 carateres');

  // 2. Progressive valid typing -> INCOMPLETE with slot-aligned remaining mask
  const partialPrefix = evaluatePublicVerifyCodeInput('fs');
  assert.equal(partialPrefix.status, 'INCOMPLETE');
  assert.equal(partialPrefix.typedPreview, 'FS');
  assert.equal(partialPrefix.remainingMask, '-YYYYMMDD-XXXX');
  assert.equal(partialPrefix.lengthBadgeText, '2/16 carateres');
  assert.equal(partialPrefix.isValidToSubmit, false);

  const partialDate = evaluatePublicVerifyCodeInput('fs-202605');
  assert.equal(partialDate.status, 'INCOMPLETE');
  assert.equal(partialDate.typedPreview, 'FS-202605');
  assert.equal(partialDate.remainingMask, 'DD-XXXX');
  assert.equal(partialDate.lengthBadgeText, '9/16 carateres');
  assert.equal(partialDate.isValidToSubmit, false);

  // 3. Structural format errors detected immediately as the user types
  const badPrefix = evaluatePublicVerifyCodeInput('AB-20260524-7D9E');
  assert.equal(badPrefix.status, 'INVALID');
  assert.equal(badPrefix.isValidToSubmit, false);
  assert.ok(badPrefix.helperMessagePt.includes('FS-'));

  const missingFirstHyphen = evaluatePublicVerifyCodeInput('FS20260524');
  assert.equal(missingFirstHyphen.status, 'INVALID');
  assert.ok(missingFirstHyphen.helperMessagePt.includes('hífen'));

  const nonDigitDate = evaluatePublicVerifyCodeInput('FS-2026AB');
  assert.equal(nonDigitDate.status, 'INVALID');
  assert.ok(nonDigitDate.helperMessagePt.includes('algarismos'));

  const badMonth = evaluatePublicVerifyCodeInput('FS-20261324-7D9E');
  assert.equal(badMonth.status, 'INVALID');
  assert.ok(badMonth.helperMessagePt.includes('Mês inválido'));

  const badDay = evaluatePublicVerifyCodeInput('FS-20260532-7D9E');
  assert.equal(badDay.status, 'INVALID');
  assert.ok(badDay.helperMessagePt.includes('Dia inválido'));

  const missingSecondHyphen = evaluatePublicVerifyCodeInput('FS-202605247D9E');
  assert.equal(missingSecondHyphen.status, 'INVALID');
  assert.ok(missingSecondHyphen.helperMessagePt.includes('segundo hífen'));

  const overlong = evaluatePublicVerifyCodeInput('FS-20260524-7D9E99');
  assert.equal(overlong.status, 'INVALID');
  assert.equal(overlong.lengthBadgeText, '18/16 carateres');
  assert.equal(overlong.isValidToSubmit, false);

  // 4. Complete valid canonical short code (case-insensitive + optional leading #)
  const validShort = evaluatePublicVerifyCodeInput(' #fs-20260524-7d9e ');
  assert.equal(validShort.status, 'VALID');
  assert.equal(validShort.mode, 'SHORT_CODE');
  assert.equal(validShort.isValidToSubmit, true);
  assert.equal(validShort.normalizedCode, 'FS-20260524-7D9E');
  assert.equal(validShort.typedPreview, 'FS-20260524-7D9E');
  assert.equal(validShort.remainingMask, '');
  assert.equal(validShort.lengthBadgeText, '16/16 carateres');
  assert.equal(validShort.submitErrorPt, null);

  // 5. SHA-256 hex digest (partial vs complete 64 hex chars) + URL payload
  const partialSha = evaluatePublicVerifyCodeInput('9f86d081884c7d659a2feaa0');
  assert.equal(partialSha.status, 'INCOMPLETE');
  assert.equal(partialSha.mode, 'SHA256_HASH');
  assert.equal(partialSha.targetLength, CANONICAL_SHA256_LENGTH);
  assert.equal(partialSha.lengthBadgeText, '24/64 hex');
  assert.equal(partialSha.isValidToSubmit, false);

  const validSha = evaluatePublicVerifyCodeInput('a'.repeat(64));
  assert.equal(validSha.status, 'VALID');
  assert.equal(validSha.mode, 'SHA256_HASH');
  assert.equal(validSha.lengthBadgeText, '64/64 hex');
  assert.equal(validSha.isValidToSubmit, true);

  const validUrl = evaluatePublicVerifyCodeInput(
    'https://faixasegura.gov.pt/?verify=FS-20260524-7D9E'
  );
  assert.equal(validUrl.status, 'VALID');
  assert.equal(validUrl.mode, 'URL_PAYLOAD');
  assert.equal(validUrl.normalizedCode, 'FS-20260524-7D9E');
  assert.equal(validUrl.isValidToSubmit, true);

  // 6. Verify prominent High Contrast badge subtle pulsing CSS animation & live preview test IDs
  const homepageSrc = fs.readFileSync(
    path.resolve(import.meta.dirname, '../components/PublicWebviewHomepage.tsx'),
    'utf8'
  );
  const indexCssSrc = fs.readFileSync(
    path.resolve(import.meta.dirname, '../index.css'),
    'utf8'
  );
  assert.ok(homepageSrc.includes('font-extrabold'));
  assert.ok(homepageSrc.includes('hc-badge-subtle-pulse'));
  assert.ok(homepageSrc.includes('border-[3px]'));
  assert.ok(homepageSrc.includes('Alto Contraste Ativo'));
  assert.ok(homepageSrc.includes('data-testid="public-verify-format-preview"'));
  assert.ok(homepageSrc.includes('data-testid="public-verify-length-counter"'));
  assert.ok(indexCssSrc.includes('@keyframes hc-badge-subtle-pulse'));
  assert.ok(indexCssSrc.includes('@keyframes hc-badge-halo-pulse'));
  assert.ok(indexCssSrc.includes('prefers-reduced-motion: reduce'));
});

test('QrCertificateScannerModal renders inline Recent Scanned Certificates section (last 5) persisted in localStorage with individual removal', async () => {
  const {
    LS_KEY_QR_SCAN_HISTORY,
    MAX_QR_SCAN_HISTORY_ITEMS,
    appendQrScanHistory,
    loadQrScanHistory,
    removeQrScanHistoryItem,
  } = await import('./qrVerification.ts');
  const { INITIAL_CERTIFICATES } = await import('../data/seedCatalog.ts');
  const fs = await import('node:fs');
  const path = await import('node:path');

  const mem = new Map<string, string>();
  const mockStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, v);
    },
    removeItem: (k: string) => {
      mem.delete(k);
    },
  };

  assert.equal(MAX_QR_SCAN_HISTORY_ITEMS, 5);

  // Append 6 certificates and verify only the latest 5 are persisted under LS_KEY_QR_SCAN_HISTORY
  const base = INITIAL_CERTIFICATES[0];
  for (let i = 1; i <= 6; i++) {
    appendQrScanHistory(
      {
        ...base,
        id: `cert-field-${i}`,
        shortCode: `FS-2026111${i}-B00${i}`,
      },
      {
        scannedAtIso: `2026-11-16T12:0${i}:00.000Z`,
        source: 'CAMERA',
        storage: mockStorage,
      }
    );
  }

  const persistedRaw = mockStorage.getItem(LS_KEY_QR_SCAN_HISTORY);
  assert.ok(persistedRaw, 'Scan history must be serialized in localStorage');
  const loaded = loadQrScanHistory(mockStorage);
  assert.equal(loaded.length, 5);
  assert.deepEqual(
    loaded.map((item) => item.certificate.shortCode),
    [
      'FS-20261116-B006',
      'FS-20261115-B005',
      'FS-20261114-B004',
      'FS-20261113-B003',
      'FS-20261112-B002',
    ]
  );

  // Individual removal updates localStorage and preserves remaining entries in order
  const afterRemoveMiddle = removeQrScanHistoryItem('fs-20261114-b004', mockStorage);
  assert.equal(afterRemoveMiddle.length, 4);
  assert.deepEqual(
    loadQrScanHistory(mockStorage).map((item) => item.certificate.shortCode),
    [
      'FS-20261116-B006',
      'FS-20261115-B005',
      'FS-20261113-B003',
      'FS-20261112-B002',
    ]
  );

  // Verify QrCertificateScannerModal exposes the inline Recent Scanned Certificates section in the default view
  const modalSrc = fs.readFileSync(
    path.resolve(import.meta.dirname, '../components/QrCertificateScannerModal.tsx'),
    'utf8'
  );
  assert.ok(modalSrc.includes('data-testid="qr-recent-scans-section"'));
  assert.ok(modalSrc.includes('data-testid="qr-recent-scans-list"'));
  assert.ok(modalSrc.includes('data-testid="qr-recent-scans-empty"'));
  assert.ok(modalSrc.includes('LS_KEY_QR_SCAN_HISTORY'));
});

test('parcelHazardMonitor evaluates wildfires and severe storms across all user parcels, prioritizes forest/scrub properties, and persists acknowledgments & simulations', async () => {
  const {
    FALLBACK_ACTIVE_FIRES,
    FALLBACK_ACTIVE_STORMS,
    INITIAL_PARCELS,
  } = await import('../data/seedCatalog.ts');
  const { haversineDistanceKm } = await import('./spatialEngine.ts');
  const {
    buildSimulatedFireNearParcel,
    buildSimulatedStormNearParcel,
    computeCardinalBearingPt,
    evaluateMultiParcelHazards,
    loadAcknowledgedHazardAlertIds,
    loadSimulatedFieldHazards,
    offsetLatLonByKmAndBearing,
    saveSimulatedFieldHazards,
    toggleAcknowledgeHazardAlertId,
  } = await import('./parcelHazardMonitor.ts');

  // 1. Geodesic bearing & offset math
  const origin = { lat: 39.7438, lon: -8.8072 };
  const nePoint = offsetLatLonByKmAndBearing(origin, 2.3, 45);
  const neDist = haversineDistanceKm(origin, nePoint);
  const neBearing = computeCardinalBearingPt(origin, nePoint);
  assert.ok(Math.abs(neDist - 2.3) < 0.08, `Expected ~2.3 km, got ${neDist}`);
  assert.equal(neBearing.cardinalPt, 'NE');

  const nwPoint = offsetLatLonByKmAndBearing(origin, 3.1, 315);
  assert.equal(computeCardinalBearingPt(origin, nwPoint).cardinalPt, 'NO');

  // 2. Multi-parcel evaluation at default 15 km radius:
  // Active Sintra parcel is SAFE, while remote forest parcels (Leiria & Valongo) trigger CRITICAL alerts!
  const eval15 = evaluateMultiParcelHazards({
    parcels: INITIAL_PARCELS,
    fires: FALLBACK_ACTIVE_FIRES,
    storms: FALLBACK_ACTIVE_STORMS,
    settings: {
      proximityAlertRadiusKm: 15,
      enableFireProximityAlerts: true,
      enableStormProximityAlerts: true,
      prioritizeForestScrubAlerts: true,
    },
  });

  assert.equal(eval15.parcelSummaries['parcel-sintra-colares']?.status, 'SAFE');
  assert.equal(eval15.parcelSummaries['parcel-leiria-pinhal']?.status, 'CRITICAL');
  assert.equal(eval15.parcelSummaries['parcel-valongo-serra']?.status, 'CRITICAL');
  assert.equal(eval15.counts.affectedParcelsCount, 2);
  assert.ok(eval15.counts.fireAlertsCount >= 2);
  assert.ok(eval15.counts.stormAlertsCount >= 2);
  assert.equal(eval15.counts.unacknowledgedCount, eval15.counts.totalAlerts);

  // 3. Narrowing radius to 5 km clears distant regional hazards, and injecting a simulated forest fire triggers immediate CRITICAL alert
  const eval5Safe = evaluateMultiParcelHazards({
    parcels: INITIAL_PARCELS,
    fires: FALLBACK_ACTIVE_FIRES,
    storms: FALLBACK_ACTIVE_STORMS,
    settings: {
      proximityAlertRadiusKm: 5,
      enableFireProximityAlerts: true,
      enableStormProximityAlerts: true,
      prioritizeForestScrubAlerts: true,
    },
  });
  assert.equal(eval5Safe.counts.totalAlerts, 0);
  assert.equal(eval5Safe.parcelSummaries['parcel-leiria-pinhal']?.status, 'SAFE');

  const simFireLeiria = buildSimulatedFireNearParcel(INITIAL_PARCELS[1]);
  const simStormSintra = buildSimulatedStormNearParcel(INITIAL_PARCELS[0]);
  const eval5WithSim = evaluateMultiParcelHazards({
    parcels: INITIAL_PARCELS,
    fires: [simFireLeiria, ...FALLBACK_ACTIVE_FIRES],
    storms: [simStormSintra, ...FALLBACK_ACTIVE_STORMS],
    settings: {
      proximityAlertRadiusKm: 5,
      enableFireProximityAlerts: true,
      enableStormProximityAlerts: true,
      prioritizeForestScrubAlerts: true,
    },
  });
  assert.equal(eval5WithSim.parcelSummaries['parcel-leiria-pinhal']?.status, 'CRITICAL');
  assert.equal(eval5WithSim.parcelSummaries['parcel-sintra-colares']?.status, 'CRITICAL');
  assert.equal(eval5WithSim.counts.affectedParcelsCount, 2);

  // 4. Widening radius to 25 km brings Sintra into surveillance (Mafra fire ~23.4 km & Cascais storm)
  const eval25 = evaluateMultiParcelHazards({
    parcels: INITIAL_PARCELS,
    fires: FALLBACK_ACTIVE_FIRES,
    storms: FALLBACK_ACTIVE_STORMS,
    settings: {
      proximityAlertRadiusKm: 25,
      enableFireProximityAlerts: true,
      enableStormProximityAlerts: true,
      prioritizeForestScrubAlerts: true,
    },
  });
  assert.notEqual(eval25.parcelSummaries['parcel-sintra-colares']?.status, 'SAFE');
  assert.equal(eval25.counts.affectedParcelsCount, 3);

  // 5. Channel toggles & acknowledgment/simulation persistence
  const firesOnly = evaluateMultiParcelHazards({
    parcels: INITIAL_PARCELS,
    fires: FALLBACK_ACTIVE_FIRES,
    storms: FALLBACK_ACTIVE_STORMS,
    settings: {
      proximityAlertRadiusKm: 15,
      enableFireProximityAlerts: true,
      enableStormProximityAlerts: false,
      prioritizeForestScrubAlerts: true,
    },
  });
  assert.equal(firesOnly.counts.stormAlertsCount, 0);
  assert.ok(firesOnly.counts.fireAlertsCount >= 2);

  const mem = new Map<string, string>();
  const kv = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, v);
    },
    removeItem: (k: string) => {
      mem.delete(k);
    },
  };

  const firstAlertId = eval15.alerts[0].alertId;
  const ackedIds = toggleAcknowledgeHazardAlertId([], firstAlertId, kv);
  assert.deepEqual(loadAcknowledgedHazardAlertIds(kv), [firstAlertId]);

  const evalAfterAck = evaluateMultiParcelHazards({
    parcels: INITIAL_PARCELS,
    fires: FALLBACK_ACTIVE_FIRES,
    storms: FALLBACK_ACTIVE_STORMS,
    settings: { proximityAlertRadiusKm: 15 },
    acknowledgedAlertIds: ackedIds,
  });
  assert.equal(evalAfterAck.counts.unacknowledgedCount, eval15.counts.totalAlerts - 1);

  saveSimulatedFieldHazards({ fires: [simFireLeiria], storms: [simStormSintra] }, kv);
  assert.equal(loadSimulatedFieldHazards(kv).fires.length, 1);
  assert.equal(loadSimulatedFieldHazards(kv).storms.length, 1);
  saveSimulatedFieldHazards({ fires: [], storms: [] }, kv);
  assert.equal(loadSimulatedFieldHazards(kv).fires.length, 0);
});

test('officialAlertsIngestor parses chunked ANEPC SADO SSE streams, classifies Proteção Civil occurrences, maps IPMA PTO/STB warnings, and matches district-wide IPMA alerts to user parcels', async () => {
  const { INITIAL_PARCELS } = await import('../data/seedCatalog.ts');
  const {
    classifyAnepcIncidents,
    consumeSseBuffer,
    doesIpmaWarningMatchParcelDistrict,
    hydrateIpmaAreaLocations,
    mergeSecondaryApiAbertaFires,
    parseAnepcCountsPayload,
    parseIpmaWarningsPayload,
    resolveIpmaAreaCodeForDistrict,
  } = await import('./officialAlertsIngestor.ts');
  const { evaluateMultiParcelHazards } = await import('./parcelHazardMonitor.ts');

  // 1. Official Portuguese District <-> IPMA idAreaAviso resolution (including PTO & STB)
  assert.equal(resolveIpmaAreaCodeForDistrict('Porto'), 'PTO');
  assert.equal(resolveIpmaAreaCodeForDistrict('Setúbal'), 'STB');
  assert.equal(resolveIpmaAreaCodeForDistrict('Setubal'), 'STB');
  assert.equal(resolveIpmaAreaCodeForDistrict('Leiria'), 'LRA');
  assert.equal(resolveIpmaAreaCodeForDistrict('Lisboa'), 'LSB');
  assert.equal(resolveIpmaAreaCodeForDistrict('Évora'), 'EVO');

  // 2. Chunked SSE buffer assembly across arbitrary TCP packet splits
  const sampleIncidentsArray = [
    {
      id: '01a1c67b-ad19-74be-821d-514846e2cf68',
      dates: { started: '2026-11-16T10:00:00', last_updated: '2026-11-16T13:40:36' },
      means_involved: { aerial: 0, aquatic: 0, man: 14, terrain: 4, total_meios: 18 },
      location: {
        district: 'Leiria',
        county: 'Leiria',
        parish: 'Leiria, Pousos, Barreira e Cortes',
      },
      coordinates: { latitude: '39.74917900', longitude: '-8.80283200' },
      occurrence: {
        status: 'Vigilância',
        natureza: 'Situação Crítica',
        naturezaCode: '9999',
        category: 'fire',
        category_name: 'Incêndios',
        significant: false,
      },
    },
    {
      id: 'tree-fall-valongo-1',
      dates: { started: '2026-11-16T12:15:00', last_updated: '2026-11-16T13:42:00' },
      means_involved: { aerial: 0, aquatic: 0, man: 8, terrain: 2, total_meios: 10 },
      location: {
        district: 'Porto',
        county: 'Valongo',
        parish: 'Valongo',
      },
      coordinates: { latitude: '41.186200', longitude: '-8.496100' },
      occurrence: {
        status: 'Em Curso',
        natureza: 'Queda de Árvore',
        naturezaCode: '4301',
        category: 'weather',
        category_name: 'Comprometimento de Segurança ou Serviços',
        significant: false,
      },
    },
    {
      id: 'medical-indoor-ignore',
      dates: { started: '2026-11-16T12:30:00' },
      means_involved: { man: 2, terrain: 1 },
      location: { district: 'Lisboa', county: 'Sintra', parish: 'Colares' },
      coordinates: { latitude: '38.799100', longitude: '-9.462000' },
      occurrence: {
        status: 'Em Curso',
        natureza: 'Assistência em Saúde',
        category: 'health',
        category_name: 'Pré-Hospitalar',
      },
    },
  ];

  const fullSseStream =
    `event: counts\ndata: {"total_ocorrencias":51,"total_operacionais":150,"total_veiculos":61,"total_aereos":0,"total_incendios":1,"total_significativas":0}\n\n` +
    `: keepalive\n\n` +
    `event: incidents\ndata: ${JSON.stringify(sampleIncidentsArray)}\n\n`;

  // Split right in the middle of the JSON array to prove consumeSseBuffer never emits truncated JSON
  const chunk1 = fullSseStream.slice(0, 210);
  const chunk2 = fullSseStream.slice(210);

  const step1 = consumeSseBuffer(chunk1);
  assert.equal(step1.frames.length, 1);
  assert.equal(step1.frames[0].event, 'counts');
  const counts = parseAnepcCountsPayload(step1.frames[0].data);
  assert.ok(counts);
  assert.equal(counts.totalOccurrences, 51);
  assert.equal(counts.totalOperatives, 150);

  const step2 = consumeSseBuffer(step1.remainder + chunk2);
  assert.equal(step2.frames.length, 1);
  assert.equal(step2.frames[0].event, 'incidents');
  assert.equal(step2.remainder, '');

  const classified = classifyAnepcIncidents(step2.frames[0].data);
  assert.equal(classified.fires.length, 1);
  assert.equal(classified.fires[0].source, 'ANEPC Proteção Civil (Tempo Real)');
  assert.equal(classified.fires[0].nature, 'Situação Crítica');
  assert.equal(classified.civilWeatherHazards.length, 1);
  assert.equal(classified.civilWeatherHazards[0].source, 'ANEPC Proteção Civil (Tempo Real)');
  assert.ok(classified.civilWeatherHazards[0].title.includes('Queda de Árvore'));

  // Secondary API Aberta deduplication within 0.75 km
  const mergedFires = mergeSecondaryApiAbertaFires(classified.fires, [
    { id: 999, concelho: 'Leiria', lat: 39.7492, lng: -8.8029, man: 14, terrain: 4 },
    { id: 1001, concelho: 'Mação', freguesia: 'Amêndoa', lat: 39.612, lng: -8.041, man: 32, terrain: 9 },
  ]);
  assert.equal(mergedFires.length, 2);

  // 3. Official IPMA warnings parsing (PTO Porto land warning kept; PTO marine Agitação Marítima excluded for land parcels)
  const hydratedAreas = hydrateIpmaAreaLocations({
    data: [
      { idAreaAviso: 'PTO', local: 'Porto', latitude: '41.1580', longitude: '-8.6294' },
      { idAreaAviso: 'VRL', local: 'Vila Real', latitude: '41.3006', longitude: '-7.7441' },
    ],
  });
  const ipmaWarnings = parseIpmaWarningsPayload(
    [
      {
        idAreaAviso: 'PTO',
        awarenessTypeName: 'Precipitação',
        awarenessLevelID: 'yellow',
        startTime: '2026-11-16T18:00:00',
        endTime: '2026-11-17T06:00:00',
        text: 'Precipitação persistente e por vezes forte, em especial nas serras.',
      },
      {
        idAreaAviso: 'VRL',
        awarenessTypeName: 'Vento',
        awarenessLevelID: 'orange',
        startTime: '2026-11-16T18:00:00',
        endTime: '2026-11-17T06:00:00',
        text: 'Rajadas até 95 km/h nas terras altas.',
      },
      {
        idAreaAviso: 'PTO',
        awarenessTypeName: 'Agitação Marítima',
        awarenessLevelID: 'orange',
        startTime: '2026-11-16T12:00:00',
        endTime: '2026-11-17T12:00:00',
        text: 'Ondas de noroeste com 4 a 5 metros.',
      },
      {
        idAreaAviso: 'LSB',
        awarenessTypeName: 'Vento',
        awarenessLevelID: 'green',
        startTime: '2026-11-16T12:00:00',
        endTime: '2026-11-17T12:00:00',
        text: '',
      },
    ],
    hydratedAreas
  );
  assert.equal(ipmaWarnings.length, 2, 'Marine-only Agitação Marítima and green warnings must be excluded');
  const ptoRain = ipmaWarnings.find((w) => w.id.includes('precipitacao'));
  assert.ok(ptoRain);
  assert.equal(ptoRain.isDistrictWideWarning, true);

  const valongoParcel = INITIAL_PARCELS.find((p) => p.id === 'parcel-valongo-serra')!;
  assert.equal(doesIpmaWarningMatchParcelDistrict(ptoRain, valongoParcel), true);

  // 4a. IPMA Yellow district warning alone puts Valongo in WARNING ('Em Vigilância'), not CRITICAL
  const ipmaOnlyEval = evaluateMultiParcelHazards({
    parcels: INITIAL_PARCELS,
    fires: [],
    storms: ipmaWarnings,
    settings: { proximityAlertRadiusKm: 5 },
  });
  assert.equal(ipmaOnlyEval.parcelSummaries['parcel-valongo-serra']?.status, 'WARNING');
  assert.equal(ipmaOnlyEval.parcelSummaries['parcel-sintra-colares']?.status, 'SAFE');

  // 4b. Combined with live ANEPC occurrences (0.7 km Leiria Situação Crítica + 0.8 km Valongo 8-man Queda de Árvore):
  const liveEval = evaluateMultiParcelHazards({
    parcels: INITIAL_PARCELS,
    fires: classified.fires,
    storms: [...ipmaWarnings, ...classified.civilWeatherHazards],
    settings: {
      proximityAlertRadiusKm: 5,
      enableFireProximityAlerts: true,
      enableStormProximityAlerts: true,
      prioritizeForestScrubAlerts: true,
    },
  });

  assert.equal(liveEval.parcelSummaries['parcel-sintra-colares']?.status, 'SAFE');
  assert.equal(liveEval.parcelSummaries['parcel-leiria-pinhal']?.status, 'CRITICAL');
  assert.equal(liveEval.parcelSummaries['parcel-valongo-serra']?.status, 'CRITICAL');
  const valongoDistrictAlert = liveEval.alerts.find(
    (a) => a.parcelId === 'parcel-valongo-serra' && a.inSameWarnedDistrict === true
  );
  assert.ok(valongoDistrictAlert, 'Valongo parcel in Porto district must receive PTO IPMA land warning');
  assert.equal(valongoDistrictAlert.urgency, 'WARNING');
});

test('Phase 1 Boolean EPSG:3763 engine conserves concave L-shaped parcel area, isolates neighbor-induced obligations, parses Overpass ways/poles, and exports MultiPolygon GeoJSON', async () => {
  const {
    projectWgs84ToPtTm06Exact,
    ptTm06ToWgs84,
    computeBooleanParcelDecomposition,
  } = await import('./booleanSpatialEngine.ts');
  const {
    parseOverpassVectorContext,
    buildOverpassParcelContextQuery,
  } = await import('./vectorContextIngestor.ts');
  const {
    buildParcelLegalDecompositionGeoJson,
    buildParcelLegalGeoJsonFilename,
  } = await import('./spatialEngine.ts');
  const { INITIAL_PARCELS } = await import('../data/seedCatalog.ts');

  // 1. Exact PT-TM06 forward <-> inverse round-trip (< 1e-5 deg error across Portugal)
  const testLocations = [
    { lat: 38.79836, lon: -9.46224 }, // Sintra
    { lat: 39.74376, lon: -8.80724 }, // Leiria
    { lat: 41.18612, lon: -8.50008 }, // Valongo
  ];
  for (const loc of testLocations) {
    const xy = projectWgs84ToPtTm06Exact(loc);
    const inv = ptTm06ToWgs84(xy);
    assert.ok(Math.abs(inv.lat - loc.lat) < 1e-5, `Lat drift too large for ${loc.lat}: ${inv.lat}`);
    assert.ok(Math.abs(inv.lon - loc.lon) < 1e-5, `Lon drift too large for ${loc.lon}: ${inv.lon}`);
  }

  // 2. Concave L-shaped parcel (100m x 100m minus 50m x 50m NE quadrant = 7500 m² exact in EPSG:3763)
  const originX = -95000;
  const originY = -82000;
  const lShapeVertices = [
    ptTm06ToWgs84([originX, originY]),
    ptTm06ToWgs84([originX + 100, originY]),
    ptTm06ToWgs84([originX + 100, originY + 50]),
    ptTm06ToWgs84([originX + 50, originY + 50]),
    ptTm06ToWgs84([originX + 50, originY + 100]),
    ptTm06ToWgs84([originX, originY + 100]),
  ];

  // Own dwelling inside SW wing; external neighbor house 14 m outside East wing; overhead E-REDES + road + riparian stream
  const ownHouse = [
    ptTm06ToWgs84([originX + 15, originY + 15]),
    ptTm06ToWgs84([originX + 25, originY + 15]),
    ptTm06ToWgs84([originX + 25, originY + 25]),
    ptTm06ToWgs84([originX + 15, originY + 25]),
  ];
  const neighborHouseEast = [
    ptTm06ToWgs84([originX + 114, originY + 20]),
    ptTm06ToWgs84([originX + 124, originY + 20]),
    ptTm06ToWgs84([originX + 124, originY + 30]),
    ptTm06ToWgs84([originX + 114, originY + 30]),
  ];

  const overpassMock = {
    elements: [
      {
        type: 'way',
        id: 101,
        tags: { building: 'house' },
        geometry: [...ownHouse, ownHouse[0]],
      },
      {
        type: 'way',
        id: 102,
        tags: { building: 'residential', name: 'Moradia Vizinha Nascente' },
        geometry: [...neighborHouseEast, neighborHouseEast[0]],
      },
      {
        type: 'node',
        id: 201,
        lat: ptTm06ToWgs84([originX - 5, originY + 85]).lat,
        lon: ptTm06ToWgs84([originX - 5, originY + 85]).lon,
        tags: { power: 'pole' },
      },
      {
        type: 'node',
        id: 202,
        lat: ptTm06ToWgs84([originX + 55, originY + 85]).lat,
        lon: ptTm06ToWgs84([originX + 55, originY + 85]).lon,
        tags: { power: 'pole' },
      },
      {
        type: 'way',
        id: 301,
        tags: { highway: 'tertiary', name: 'EM 542' },
        geometry: [
          ptTm06ToWgs84([originX - 10, originY + 1]),
          ptTm06ToWgs84([originX + 110, originY + 1]),
        ],
      },
      {
        type: 'way',
        id: 401,
        tags: { waterway: 'stream', name: 'Ribeira da Mata' },
        geometry: [
          ptTm06ToWgs84([originX + 5, originY + 95]),
          ptTm06ToWgs84([originX + 48, originY + 60]),
        ],
      },
    ],
  };

  const ql = buildOverpassParcelContextQuery(lShapeVertices, 110);
  assert.ok(ql.includes('way["building"]'));
  assert.ok(ql.includes('way["waterway"'));

  const parsedCtx = parseOverpassVectorContext({
    overpassJson: overpassMock,
    parcelVertices: lShapeVertices,
    searchRadiusM: 110,
  });

  assert.equal(parsedCtx.buildings.length, 2);
  assert.equal(parsedCtx.buildings.filter((b) => b.role === 'OWN').length, 1);
  assert.equal(parsedCtx.buildings.filter((b) => b.role === 'NEIGHBOR').length, 1);
  assert.ok(
    parsedCtx.easements.some((e) => e.id === 'osm-poles-reconstructed'),
    'Aligned power poles without way should reconstruct minor E-REDES corridor'
  );
  assert.ok(parsedCtx.easements.some((e) => e.category === 'PUBLIC_ROAD'));
  assert.equal(parsedCtx.exemptFeatures.length, 1);

  const lBreakdown = computeBooleanParcelDecomposition({
    vertices: lShapeVertices,
    landClass: 'FOREST_SCRUB',
    hasEredesLine: true,
    vectorContext: parsedCtx,
  });

  assert.ok(
    Math.abs(lBreakdown.totalAreaM2 - 7500) < 5,
    `Expected ~7500 m² for L-shaped parcel, got ${lBreakdown.totalAreaM2}`
  );

  const sumExclusiveZones =
    lBreakdown.zone1ImmediateM2 +
    lBreakdown.zone2NearM2 +
    lBreakdown.zone3ExtendedM2 +
    lBreakdown.thirdPartyEasementM2 +
    lBreakdown.exemptAreaM2;

  assert.ok(
    Math.abs(sumExclusiveZones - lBreakdown.totalAreaM2) < 0.05,
    `Boolean decomposition must strictly conserve area: sum=${sumExclusiveZones} vs total=${lBreakdown.totalAreaM2}`
  );
  assert.ok((lBreakdown.decompositionMeta?.neighborInducedCleanAreaM2 ?? 0) > 50);
  assert.ok((lBreakdown.decompositionMeta?.eredesEasementM2 ?? 0) > 20);
  assert.ok((lBreakdown.decompositionMeta?.roadEasementM2 ?? 0) > 50);
  assert.ok((lBreakdown.decompositionMeta?.riparianProtectedM2 ?? 0) > 20);
  assert.ok((lBreakdown.decompositionMeta?.neighborOverflowRiskM2 ?? 0) > 100);
  assert.ok((lBreakdown.multiPolygons?.zone3Extended.length ?? 0) >= 1);

  // 3. Multi-layer legal GeoJSON exporter (RFC 7946 MultiPolygon + LineString axes)
  const sintraParcel = INITIAL_PARCELS[0];
  const legalFilename = buildParcelLegalGeoJsonFilename(sintraParcel);
  assert.ok(legalFilename.startsWith('faixasegura-camadas-legais-'));
  assert.ok(legalFilename.endsWith('.geojson'));

  const legalGeoJsonRaw = buildParcelLegalDecompositionGeoJson(
    sintraParcel,
    '2026-11-17T10:00:00Z'
  );
  const legalFc = JSON.parse(legalGeoJsonRaw);
  assert.equal(legalFc.type, 'FeatureCollection');
  assert.ok(legalFc.features.length >= 8);
  const layerCodes = new Set(
    legalFc.features.map((f: { properties?: { layer_code?: string } }) => f.properties?.layer_code)
  );
  assert.ok(layerCodes.has('PARCEL_BOUNDARY'));
  assert.ok(layerCodes.has('ZONE_1_IMMEDIATE_0_2M'));
  assert.ok(layerCodes.has('ZONE_2_NEAR_2_10M'));
  assert.ok(layerCodes.has('ZONE_3_EXTENDED_10_50M'));
  assert.ok(layerCodes.has('THIRD_PARTY_EASEMENT'));
  assert.ok(layerCodes.has('EXEMPT_ZONE'));
  assert.ok(layerCodes.has('DETECTED_EASEMENT_AXIS'));
});

test('Phase 2 Orthophoto 25 cm CV Pipeline: ONNX NCHW float32 tensor, 7-class segmentation, pngjs round-trip, Despacho 675/2026 crown audit, and boolean annex fusion', async () => {
  const pngjsMod = await import('pngjs');
  const PNG =
    (pngjsMod as unknown as { PNG?: typeof pngjsMod.PNG; default?: { PNG: typeof pngjsMod.PNG } })
      .PNG ?? (pngjsMod as unknown as { default: { PNG: typeof pngjsMod.PNG } }).default.PNG;
  const { INITIAL_PARCELS } = await import('../data/seedCatalog.ts');
  const { buildParcelLegalDecompositionGeoJson, computeParcelFgc } = await import(
    './spatialEngine.ts'
  );
  const {
    ORTHOPHOTO_CLASS_ORDER,
    buildNormalizedNchwFloat32Tensor,
    buildOrthophotoInferenceSpec,
    computeParcelCvRasterGrid,
    fuseCvDetectionsIntoVectorContext,
    runOrthophotoPixelPipeline,
    synthesizeDeterministicParcelOrthophotoRgba,
  } = await import('./orthophotoCvPipeline.ts');

  // 1. ONNX microservice spec & NCHW [1, 3, H, W] float32 ImageNet tensor check
  const spec = buildOrthophotoInferenceSpec('yolo11s-seg+segformer-b2-dgt25cm');
  assert.equal(spec.specVersion, 'SGIFR-ORTHOPHOTO-ONNX-V2');
  assert.equal(spec.semanticClasses.length, 7);
  assert.equal(spec.inputTensor.layout, 'NCHW');
  assert.equal(spec.legalThresholds675_2026.minCrownToWallDistanceM, 5.0);
  assert.equal(spec.legalThresholds675_2026.minCrownSpacingResinousForestM, 10.0);

  const parcel = INITIAL_PARCELS[0];
  const grid = computeParcelCvRasterGrid(parcel.vertices, 28, 224);
  assert.equal(grid.width % 8, 0, 'Raster width must be a multiple of 8 for ONNX Runtime');
  assert.equal(grid.height % 8, 0, 'Raster height must be a multiple of 8 for ONNX Runtime');
  assert.ok(grid.gsdMetersPerPx > 0.2 && grid.gsdMetersPerPx < 1.2);

  // 2. Synthesize georeferenced 25 cm orthophoto & verify lossless PNG encode/decode via pngjs
  const rawRgba = synthesizeDeterministicParcelOrthophotoRgba({
    grid,
    parcelVertices: parcel.vertices,
    landClass: parcel.landClass,
    spatial: parcel.spatial,
    vectorContext: parcel.vectorContext,
  });

  const nchwTensor = buildNormalizedNchwFloat32Tensor(rawRgba, grid.width, grid.height);
  assert.equal(nchwTensor.length, 3 * grid.width * grid.height);

  const pngIn = new PNG({ width: grid.width, height: grid.height });
  pngIn.data = Buffer.from(rawRgba.buffer, rawRgba.byteOffset, rawRgba.byteLength);
  const pngBuffer = PNG.sync.write(pngIn);
  assert.ok(pngBuffer.length > 512, 'Encoded orthophoto PNG must be non-trivial');
  const pngDecoded = PNG.sync.read(pngBuffer);
  assert.equal(pngDecoded.width, grid.width);
  assert.equal(pngDecoded.height, grid.height);

  // 3. Run pixel CV + OBIA instance segmentation & Despacho 675/2026 audit
  const out = runOrthophotoPixelPipeline({
    rgba: pngDecoded.data,
    grid,
    parcelVertices: parcel.vertices,
    landClass: parcel.landClass,
    spatial: parcel.spatial,
    vectorContext: parcel.vectorContext,
    imagerySourceLabel: 'Ortofoto Sintética Georreferenciada EPSG:3763',
    engineMode: 'OFFLINE_SYNTHETIC_CV',
    analyzedAtIso: '2026-11-17T12:00:00.000Z',
  });

  const { analysis, overlayRgba } = out;
  assert.equal(overlayRgba.length, grid.width * grid.height * 4);

  const sumClassAreas = ORTHOPHOTO_CLASS_ORDER.reduce(
    (sum, cls) => sum + analysis.classAreasM2[cls],
    0
  );
  assert.ok(
    Math.abs(sumClassAreas - parcel.spatial.totalAreaM2) < 2.0,
    `7-class semantic areas must sum to parcel totalAreaM2 (${sumClassAreas} vs ${parcel.spatial.totalAreaM2})`
  );

  // Must detect individual crowns, <5m facade violation, <10m pine spacing violation, and unmapped rural annex
  assert.ok(analysis.crowns.length >= 5, `Expected >=5 crowns, got ${analysis.crowns.length}`);
  assert.ok(
    analysis.zoneCompliance.zone2CrownsUnder5mCount >= 1,
    'Expected at least 1 crown <5m from building wall'
  );
  assert.ok(
    analysis.zoneCompliance.crownSpacingViolationsCount >= 1,
    'Expected at least 1 resinous crown spacing violation (<10m) in Zona 2/3'
  );
  assert.ok(
    analysis.zoneCompliance.zone2CrownsUnder5mCount +
      analysis.zoneCompliance.crownSpacingViolationsCount <=
      analysis.crowns.length,
    'Total crown violations must never exceed retained crowns count'
  );
  assert.ok(
    analysis.unmappedRoofsCount >= 1,
    `Expected >=1 unmapped rural annex detected by CV, got ${analysis.unmappedRoofsCount}`
  );

  // 4. Fuse unmapped annex into ParcelVectorContext & recompute EPSG:3763 boolean zones
  const beforeOwnCount = parcel.spatial.decompositionMeta?.ownBuildingsCount ?? 1;
  const beforeOwnArea = parcel.spatial.decompositionMeta?.ownBuildingsAreaM2 ?? 0;
  const beforeZ1 = parcel.spatial.zone1ImmediateM2;

  const fused = fuseCvDetectionsIntoVectorContext({
    existingContext: parcel.vectorContext,
    cvAnalysis: analysis,
    parcelVertices: parcel.vertices,
  });
  assert.ok(fused.addedBuildingsCount >= 1);
  assert.ok(
    fused.vectorContext.buildings.some((b) => b.source === 'CV_ORTHOPHOTO_25CM'),
    'Fused building must carry CV_ORTHOPHOTO_25CM provenance'
  );

  const recomputedSpatial = computeParcelFgc({
    vertices: parcel.vertices,
    buildingCenter: parcel.buildingCenter,
    landClass: parcel.landClass,
    hasEredesLine: parcel.hasEredesLine,
    eredesType: parcel.eredesType,
    vectorContext: fused.vectorContext,
  });

  assert.ok(
    (recomputedSpatial.decompositionMeta?.ownBuildingsCount ?? 0) > beforeOwnCount,
    'Own building count must increase after fusing unmapped rural annex'
  );
  assert.ok(
    (recomputedSpatial.decompositionMeta?.ownBuildingsAreaM2 ?? 0) > beforeOwnArea + 8,
    'Own building footprint area must include newly fused annex'
  );
  assert.ok(
    recomputedSpatial.zone1ImmediateM2 > beforeZ1 + 5,
    'Zona 1 (0-2m inert strip) must expand around newly fused rural annex'
  );

  const recomputedSum =
    recomputedSpatial.zone1ImmediateM2 +
    recomputedSpatial.zone2NearM2 +
    recomputedSpatial.zone3ExtendedM2 +
    recomputedSpatial.thirdPartyEasementM2 +
    recomputedSpatial.exemptAreaM2;
  assert.ok(
    Math.abs(recomputedSum - recomputedSpatial.totalAreaM2) < 0.05,
    'Boolean area conservation must hold strictly after CV annex fusion'
  );

  // 5. Legal GeoJSON export includes DETECTED_TREE_CROWN and CV_UNMAPPED_STRUCTURE
  const geoJsonWithCv = JSON.parse(
    buildParcelLegalDecompositionGeoJson({ ...parcel, cvAnalysis: analysis })
  ) as { features: Array<{ properties?: { layer_code?: string } }> };
  const exportedCodes = new Set(geoJsonWithCv.features.map((f) => f.properties?.layer_code));
  assert.ok(exportedCodes.has('DETECTED_TREE_CROWN'));
  assert.ok(exportedCodes.has('CV_UNMAPPED_STRUCTURE'));
});

test('Phase 3 Assisted Map Editor (Human-in-the-Loop) stamps/draws buildings, easements & exemptions, reviews CV roofs/crowns, preserves USER_DEFINED edits across OSM refreshes, and conserves EPSG:3763 area', async () => {
  const { INITIAL_PARCELS } = await import('../data/seedCatalog.ts');
  const {
    buildParcelLegalDecompositionGeoJson,
    offsetMetersFromWgs84,
  } = await import('./spatialEngine.ts');
  const {
    computeParcelCvRasterGrid,
    runOrthophotoPixelPipeline,
    synthesizeDeterministicParcelOrthophotoRgba,
  } = await import('./orthophotoCvPipeline.ts');
  const { finalizeParcelVectorContext } = await import('./vectorContextIngestor.ts');
  const {
    addAssistedBuildingToParcel,
    addAssistedEasementToParcel,
    addAssistedExemptZoneToParcel,
    buildRectangularFootprintAtWgs84,
    countHumanVerifiedEdits,
    overrideCvCrownStatus,
    removeAssistedVectorElement,
    resetParcelToAutomaticContext,
    reviewCvRoofDetection,
    toggleAssistedBuildingRole,
    updateAssistedEasementWidth,
  } = await import('./assistedMapEditor.ts');

  const assertAreaConservation = (p: (typeof INITIAL_PARCELS)[0], label: string) => {
    const sp = p.spatial;
    const sum =
      sp.zone1ImmediateM2 +
      sp.zone2NearM2 +
      sp.zone3ExtendedM2 +
      sp.thirdPartyEasementM2 +
      sp.exemptAreaM2;
    assert.ok(
      Math.abs(sum - sp.totalAreaM2) < 0.06,
      `[${label}] Boolean zones sum (${sum}) must equal totalAreaM2 (${sp.totalAreaM2})`
    );
  };

  // Start with a parcel that has CV detections ready for human review
  const baseParcel = structuredClone(INITIAL_PARCELS[0]);
  baseParcel.hasProtectedOaks = false;
  const grid = computeParcelCvRasterGrid(baseParcel.vertices, 28, 160);
  const rgba = synthesizeDeterministicParcelOrthophotoRgba({
    grid,
    parcelVertices: baseParcel.vertices,
    landClass: baseParcel.landClass,
    spatial: baseParcel.spatial,
    vectorContext: baseParcel.vectorContext,
  });
  const cvOut = runOrthophotoPixelPipeline({
    rgba,
    grid,
    parcelVertices: baseParcel.vertices,
    landClass: baseParcel.landClass,
    spatial: baseParcel.spatial,
    vectorContext: baseParcel.vectorContext,
    imagerySourceLabel: 'Ortofoto Teste HITL',
    engineMode: 'OFFLINE_SYNTHETIC_CV',
  });
  let parcel: typeof baseParcel = { ...baseParcel, cvAnalysis: cvOut.analysis };

  // 1. 1-Click stamp of a new OWN rural annex inside the parcel expands Zona 1 (0-2m)
  const stampCenter = offsetMetersFromWgs84(parcel.spatial.centroidWgs84, -14, -10);
  const stampFootprint = buildRectangularFootprintAtWgs84(stampCenter, 8.5, 6.5);
  assert.equal(stampFootprint.length, 4);

  const z1BeforeStamp = parcel.spatial.zone1ImmediateM2;
  parcel = addAssistedBuildingToParcel(parcel, {
    id: 'user-annex-1',
    footprint: stampFootprint,
    role: 'OWN',
    label: 'Palheiro Validado pelo Proprietário',
  });
  assert.ok(parcel.spatial.zone1ImmediateM2 > z1BeforeStamp + 8, 'Zona 1 must grow around stamped annex');
  assertAreaConservation(parcel, 'after-own-stamp');

  // 2. Toggle building role OWN -> NEIGHBOR and back
  const ownCountAfterStamp = parcel.spatial.decompositionMeta?.ownBuildingsCount ?? 0;
  const toggledToNeighbor = toggleAssistedBuildingRole(parcel, 'user-annex-1');
  assert.equal(
    toggledToNeighbor.spatial.decompositionMeta?.ownBuildingsCount,
    ownCountAfterStamp - 1
  );
  assertAreaConservation(toggledToNeighbor, 'after-role-toggle');

  // 3. Add a custom E-REDES AT line across the parcel center and widen its corridor
  const easBefore = parcel.spatial.thirdPartyEasementM2;
  const lineStart = offsetMetersFromWgs84(parcel.spatial.centroidWgs84, -45, 2);
  const lineEnd = offsetMetersFromWgs84(parcel.spatial.centroidWgs84, 45, 2);
  parcel = addAssistedEasementToParcel(parcel, {
    id: 'user-power-1',
    centerline: [lineStart, lineEnd],
    preset: 'EREDES_AT',
    bufferHalfWidthM: 5.0,
  });
  assert.ok(
    parcel.spatial.thirdPartyEasementM2 > easBefore + 40,
    'Third-party easement area must increase when user traces an overhead line'
  );
  const easAt5m = parcel.spatial.thirdPartyEasementM2;
  parcel = updateAssistedEasementWidth(parcel, 'user-power-1', 10.0);
  assert.ok(
    parcel.spatial.thirdPartyEasementM2 > easAt5m + 30,
    'Widening easement from ±5m to ±10m must subtract additional corridor area'
  );
  assertAreaConservation(parcel, 'after-easement-widen');

  // 4. Add an irrigated orchard exemption polygon inside the parcel
  const orchardCenter = offsetMetersFromWgs84(parcel.spatial.centroidWgs84, 14, -14);
  const orchardPoly = buildRectangularFootprintAtWgs84(orchardCenter, 14, 12);
  const exemptBefore = parcel.spatial.exemptAreaM2;
  parcel = addAssistedExemptZoneToParcel(parcel, {
    id: 'user-orchard-1',
    points: orchardPoly,
    preset: 'IRRIGATED_AGRICULTURE',
    label: 'Pomar de Citrinos Regado',
  });
  assert.ok(parcel.spatial.exemptAreaM2 > exemptBefore + 20, 'Orchard polygon must expand exemptAreaM2');
  assertAreaConservation(parcel, 'after-orchard-exempt');

  // 5. Human-in-the-Loop CV roof review (ACCEPT_OWN vs DISMISS) and Crown Protected Oak override
  const unmappedRoof = parcel.cvAnalysis?.detectedRoofs.find((r) => r.isUnmappedInOsm);
  assert.ok(unmappedRoof, 'Expected at least 1 unmapped CV roof to review');
  const dismissedParcel = reviewCvRoofDetection(
    parcel,
    unmappedRoof.id,
    'DISMISS_FALSE_POSITIVE'
  );
  assert.equal(dismissedParcel.cvAnalysis?.unmappedRoofsCount, 0);

  parcel = reviewCvRoofDetection(parcel, unmappedRoof.id, 'ACCEPT_OWN');
  assert.equal(parcel.cvAnalysis?.unmappedRoofsCount, 0);
  assert.ok(
    parcel.vectorContext?.buildings.some((b) => b.id === `hitl-${unmappedRoof.id}`),
    'Accepted CV roof must be promoted into vectorContext.buildings with hitl-* id'
  );

  const violatingCrown = parcel.cvAnalysis?.crowns.find((c) => c.violationRulePt !== null);
  assert.ok(violatingCrown, 'Expected a violating CV crown for human override test');
  const violBefore =
    (parcel.cvAnalysis?.zoneCompliance.zone2CrownsUnder5mCount ?? 0) +
    (parcel.cvAnalysis?.zoneCompliance.crownSpacingViolationsCount ?? 0);

  parcel = overrideCvCrownStatus(parcel, violatingCrown.id, 'PROTECTED_QUERCUS');
  assert.equal(parcel.hasProtectedOaks, true, 'Marking protected oak must enable hasProtectedOaks');
  const violAfterOak =
    (parcel.cvAnalysis?.zoneCompliance.zone2CrownsUnder5mCount ?? 0) +
    (parcel.cvAnalysis?.zoneCompliance.crownSpacingViolationsCount ?? 0);
  assert.ok(violAfterOak < violBefore, 'Protected oak override must clear felling spacing violation');

  // Clearing override restores original violation count cleanly
  const clearedCrownParcel = overrideCvCrownStatus(parcel, violatingCrown.id, 'CLEAR');
  const violRestored =
    (clearedCrownParcel.cvAnalysis?.zoneCompliance.zone2CrownsUnder5mCount ?? 0) +
    (clearedCrownParcel.cvAnalysis?.zoneCompliance.crownSpacingViolationsCount ?? 0);
  assert.equal(violRestored, violBefore);

  // 6. Preserving USER_DEFINED elements across automatic OSM Overpass / cadastral refreshes
  assert.ok(countHumanVerifiedEdits(parcel.vectorContext, parcel.cvAnalysis) >= 5);
  const refreshedCtx = finalizeParcelVectorContext({
    liveParsed: null,
    parcelVertices: parcel.vertices,
    buildingCenter: parcel.buildingCenter,
    hasEredesLine: parcel.hasEredesLine,
    eredesType: parcel.eredesType,
    existingContext: parcel.vectorContext,
  });
  assert.ok(refreshedCtx.buildings.some((b) => b.id === 'user-annex-1'));
  assert.ok(refreshedCtx.easements.some((e) => e.id === 'user-power-1'));
  assert.ok(refreshedCtx.exemptFeatures.some((ex) => ex.id === 'user-orchard-1'));

  // 7. Legal GeoJSON export includes USER_VERIFIED_BUILDING, DETECTED_EXEMPT_POLYGON & human_override
  const exported = JSON.parse(buildParcelLegalDecompositionGeoJson(parcel)) as {
    features: Array<{ properties?: Record<string, unknown> }>;
  };
  const layerCodes = new Set(exported.features.map((f) => f.properties?.layer_code));
  assert.ok(layerCodes.has('USER_VERIFIED_BUILDING'));
  assert.ok(layerCodes.has('DETECTED_EXEMPT_POLYGON'));
  assert.ok(
    exported.features.some(
      (f) =>
        f.properties?.layer_code === 'DETECTED_TREE_CROWN' &&
        f.properties?.human_override === 'PROTECTED_QUERCUS'
    )
  );

  // 8. Remove element & full reset back to automatic baseline
  const afterRemove = removeAssistedVectorElement(parcel, 'EASEMENT', 'user-power-1');
  assert.ok(!afterRemove.vectorContext?.easements.some((e) => e.id === 'user-power-1'));
  assertAreaConservation(afterRemove, 'after-remove-easement');

  const resetParcel = resetParcelToAutomaticContext(afterRemove);
  assert.equal(countHumanVerifiedEdits(resetParcel.vectorContext, resetParcel.cvAnalysis), 0);
  assertAreaConservation(resetParcel, 'after-reset');
});

test('External Geo Connectors, .env.example catalog, and ServerInfra/Notifications unit checks', async () => {
  // 1. Verify .env.example documents every required variable without leaked secrets
  const envExample = readEnvFileSync('.env.example', 'utf8');
  const requiredEnvKeys = [
    'APP_URL=',
    'PORT=',
    'DISABLE_HMR=',
    'VITE_FIREBASE_STORAGE_BUCKET=',
    'VITE_FIREBASE_MESSAGING_SENDER_ID=',
    'ORTHOPHOTO_CV_API_KEY=',
    'OLLAMA_API_KEY=',
    'COPERNICUS_CLIENT_ID=',
    'COPERNICUS_CLIENT_SECRET=',
    'COPERNICUS_STATS_URL=',
    'COPERNICUS_CATALOG_URL=',
    'DGT_CADASTRE_OGC_URL=',
    'EREDES_OPENDATA_BASE_URL=',
    'EREDES_OPENDATA_API_KEY=',
    'ELEVATION_API_URL=',
    'VITE_CARTO_API_KEY=',
    'VITE_MAP_ORTHO_TILE_URL=',
    'VITE_MAP_VECTOR_TILE_URL=',
    'TELEGRAM_BOT_TOKEN=',
    'TELEGRAM_DEFAULT_CHAT_ID=',
    'VAPID_PUBLIC_KEY=',
    'VAPID_PRIVATE_KEY=',
    'RESEND_API_KEY=',
    'SMTP_WEBHOOK_URL=',
  ];
  for (const key of requiredEnvKeys) {
    assert.ok(envExample.includes(key), `Missing ${key} in .env.example`);
  }
  assert.ok(!envExample.includes('AIzaSy'), '.env.example must never contain real API keys');

  // 2. Copernicus Sentinel-2 L2A Statistical API & Open Catalog parsers
  const parcelVerts = [
    { lat: 38.79805, lon: -9.46258 },
    { lat: 38.79876, lon: -9.46252 },
    { lat: 38.79879, lon: -9.46164 },
    { lat: 38.79802, lon: -9.46168 },
  ];
  const statsBody = buildCopernicusStatsRequestBody({
    vertices: parcelVerts,
    fromIsoDate: '2026-04-01',
    toIsoDate: '2026-05-15',
  });
  assert.ok(statsBody.input && statsBody.aggregation);

  const statsParsed = parseCopernicusStatsResponse({
    data: [
      {
        interval: { from: '2026-05-01T00:00:00Z', to: '2026-05-12T00:00:00Z' },
        outputs: {
          indices: {
            bands: {
              B0: { stats: { mean: 0.642, sampleCount: 100, noDataCount: 8 } },
              B1: { stats: { mean: 0.184, sampleCount: 100, noDataCount: 8 } },
            },
          },
        },
      },
      {
        interval: { from: '2026-04-18T00:00:00Z', to: '2026-04-30T00:00:00Z' },
        outputs: {
          indices: {
            bands: {
              B0: { stats: { mean: 0.588, sampleCount: 100, noDataCount: 4 } },
              B1: { stats: { mean: 0.221, sampleCount: 100, noDataCount: 4 } },
            },
          },
        },
      },
    ],
  });
  assert.equal(statsParsed.length, 2);
  assert.equal(statsParsed[0].date, '2026-04-30');
  assert.equal(statsParsed[1].date, '2026-05-12');
  assert.equal(statsParsed[1].ndvi, 0.64);
  assert.equal(statsParsed[1].cloudCoverPct, 8);

  const openCatalogParsed = parseCopernicusOpenCatalogScenes({
    rawJson: {
      features: [
        { properties: { startDate: '2026-05-14T11:21:00Z', cloudCover: 6.2 } },
        { properties: { startDate: '2026-05-04T11:21:00Z', cloudCover: 12.8 } },
        { properties: { startDate: '2026-04-24T11:21:00Z', cloudCover: 3.1 } },
      ],
    },
    landClass: 'FOREST_SCRUB',
    centroid: { lat: 38.7984, lon: -9.4621 },
  });
  assert.equal(openCatalogParsed.length, 3);
  assert.equal(openCatalogParsed[2].date, '2026-05-14');
  assert.equal(openCatalogParsed[2].cloudCoverPct, 6);

  // 3. E-REDES Open Data v2.1 parser & 8m deduplication against OSM powerlines
  const eredesLines = parseEredesOpenDataLines({
    results: [
      {
        id: 'LN-30KV-901',
        nivel_tensao: 'MT 30kV',
        geo_shape: {
          geometry: {
            type: 'LineString',
            coordinates: [
              [-9.4626, 38.7981],
              [-9.4616, 38.7987],
            ],
          },
        },
      },
      {
        id: 'LN-60KV-902',
        nivel_tensao: 'AT 60kV',
        geo_shape: {
          geometry: {
            type: 'LineString',
            coordinates: [
              [-9.464, 38.7995],
              [-9.463, 38.8001],
            ],
          },
        },
      },
    ],
  });
  assert.equal(eredesLines.length, 2);
  assert.equal(eredesLines[0].source, 'EREDES_OPENDATA');
  assert.equal(eredesLines[0].bufferHalfWidthM, 4.25);
  assert.equal(eredesLines[1].bufferHalfWidthM, 5.0);

  const mergedOnce = mergeEredesEasementsIntoVectorContext(
    {
      detectedAtIso: '2026-05-15T10:00:00Z',
      sourceMode: 'LIVE_OVERPASS_WFS',
      sourceSummaryPt: 'OSM Overpass',
      searchRadiusM: 120,
      buildings: [],
      easements: [
        {
          ...eredesLines[0],
          id: 'osm-power-existing',
          source: 'OSM_OVERPASS',
        },
      ],
      exemptFeatures: [],
    },
    eredesLines
  );
  // First line is <8 m from osm-power-existing so only the second line is appended
  assert.equal(mergedOnce.addedCount, 1);
  assert.equal(mergedOnce.context.easements.length, 2);

  // 4. Official DGT Cadastre OGC API Features polygon selection & EPSG:3763 area
  const dgtMatch = parseDgtCadastreFeatures(
    {
      type: 'FeatureCollection',
      features: [
        {
          id: 'PT.DGT.CAD.1111',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-9.46258, 38.79805],
                [-9.46168, 38.79802],
                [-9.46164, 38.79879],
                [-9.46252, 38.79876],
                [-9.46258, 38.79805],
              ],
            ],
          },
          properties: {
            nationalCadastralReference: '110509-H-0318',
            inspireId: 'PT.DGT.110509.318',
          },
        },
      ],
    },
    { lat: 38.7984, lon: -9.4621 }
  );
  assert.ok(dgtMatch);
  assert.equal(dgtMatch.containsTargetPoint, true);
  assert.equal(dgtMatch.cadastralReference, '110509-H-0318');
  assert.ok(dgtMatch.areaM2 > 5000 && dgtMatch.areaM2 < 8000);

  // 5. Real DEM / MDT Elevation parser & 3D least-squares slope plane fitting (15% synthetic hillside)
  const sampleGrid = buildParcelElevationSampleGrid(parcelVerts, { lat: 38.7984, lon: -9.4621 });
  assert.ok(sampleGrid.length >= 9);
  const originTm = wgs84ToPtTm06(sampleGrid[0]);
  const syntheticElevations = sampleGrid.map((pt) => {
    const tm = wgs84ToPtTm06(pt);
    // 15% rise eastward (dz/dx = 0.15)
    return 180 + (tm.x - originTm.x) * 0.15;
  });
  const parsedElevs = parseElevationApiResponse({ elevation: syntheticElevations });
  assert.equal(parsedElevs.length, sampleGrid.length);
  const slopeRes = computeTerrainSlopeFromElevations(sampleGrid, parsedElevs);
  assert.ok(
    Math.abs(slopeRes.avgSlopePct - 15.0) < 0.8,
    `Expected ~15% slope, got ${slopeRes.avgSlopePct}%`
  );
  assert.equal(slopeRes.aspectLabelPt, 'Exposição Poente');

  // 6. ServerInfraBridge TTL memory cache, WebPushNotificationHub VAPID keys, and mocked Telegram/Email dispatch
  const infra = new ServerInfraBridge();
  await infra.cacheSetJson('unit:test', { ok: true, count: 7 }, 60);
  const cached = await infra.cacheGetJson<{ ok: boolean; count: number }>('unit:test');
  assert.deepEqual(cached, { ok: true, count: 7 });

  const pushHub = new WebPushNotificationHub({});
  assert.ok(pushHub.getPublicKey().length >= 60);
  assert.equal(pushHub.isEnvConfigured(), false);
  const badSub = pushHub.registerSubscription({ endpoint: '', keys: { p256dh: '', auth: '' } });
  assert.equal(badSub.ok, false);
  const goodSub = pushHub.registerSubscription({
    endpoint: 'https://fcm.googleapis.com/fcm/send/demo-endpoint-1',
    keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQ', auth: 'tBHItJI5svbpez7KI4CCXg' },
  });
  assert.equal(goodSub.ok, true);
  assert.equal(pushHub.getSubscriptionCount(), 1);

  const tgReceipt = await dispatchTelegramAlert({
    botToken: '123456:TEST_TOKEN_UNIT',
    chatId: '-100998877',
    text: 'Teste unitário FaixaSegura',
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });
  assert.equal(tgReceipt.delivered, true);

  const emailReceipt = await dispatchTransactionalEmailOrWebhook({
    resendApiKey: 're_unit_mock',
    toEmails: ['equipa@silvicultura.pt'],
    subject: 'Pedido Orçamento',
    textBody: 'Área obrigatória: 2450 m²',
    fetchImpl: async () => new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }),
  });
  assert.equal(emailReceipt.delivered, true);
});

test('QR scanner hardware live connection status & #public-verify-code-input #15803D border-color transition animation', async () => {
  const {
    PUBLIC_VERIFY_SUCCESS_BORDER_HEX,
    detectHidQrScannerBurst,
    evaluatePublicVerifyCodeInput,
    evaluateQrScannerHardwareStatus,
  } = await import('./qrVerification.ts');
  const fs = await import('node:fs');
  const path = await import('node:path');

  assert.equal(PUBLIC_VERIFY_SUCCESS_BORDER_HEX, '#15803D');

  // 1. Progressive borderState transitions as the user types FS-YYYYMMDD-XXXX
  const idle = evaluatePublicVerifyCodeInput('');
  assert.equal(idle.borderState, 'DEFAULT');
  assert.equal(idle.isShortCodeFormatSatisfied, false);

  const early = evaluatePublicVerifyCodeInput('FS-20');
  assert.equal(early.borderState, 'TYPING_EARLY');
  assert.equal(early.isShortCodeFormatSatisfied, false);

  const near = evaluatePublicVerifyCodeInput('FS-20260524-7');
  assert.equal(near.borderState, 'TYPING_NEAR');
  assert.equal(near.isShortCodeFormatSatisfied, false);

  const satisfied = evaluatePublicVerifyCodeInput('FS-20260524-7D9E');
  assert.equal(satisfied.borderState, 'VALID_GREEN');
  assert.equal(satisfied.isShortCodeFormatSatisfied, true);

  const invalidCode = evaluatePublicVerifyCodeInput('FS-20261324-7D9E');
  assert.equal(invalidCode.borderState, 'INVALID_RED');
  assert.equal(invalidCode.isShortCodeFormatSatisfied, false);

  // SHA-256 hex valid input does NOT falsely claim FS-YYYYMMDD-XXXX short-code satisfaction
  const validHex = evaluatePublicVerifyCodeInput('b'.repeat(64));
  assert.equal(validHex.isShortCodeFormatSatisfied, false);
  assert.equal(validHex.borderState, 'TYPING_NEAR');

  // 2. Live QR scanner hardware connection evaluator across outdoor field states
  const probing = evaluateQrScannerHardwareStatus({
    isProbing: true,
    hasMediaDevicesApi: true,
    videoInputCount: 0,
    cameraPermission: 'unknown',
    hasNativeBarcodeDetector: true,
    modalCameraPhase: 'CLOSED',
    hidScannerDetected: false,
    isOnline: true,
  });
  assert.equal(probing.state, 'PROBING');
  assert.equal(probing.isReadyForFieldUse, false);

  const cameraReady = evaluateQrScannerHardwareStatus({
    isProbing: false,
    hasMediaDevicesApi: true,
    videoInputCount: 2,
    cameraPermission: 'granted',
    hasNativeBarcodeDetector: true,
    modalCameraPhase: 'CLOSED',
    hidScannerDetected: false,
    isOnline: true,
  });
  assert.equal(cameraReady.state, 'CAMERA_READY');
  assert.equal(cameraReady.isReadyForFieldUse, true);
  assert.ok(cameraReady.statusTextPt.includes('2 câmaras detetadas'));
  assert.ok(cameraReady.statusTextPt.includes('pronto para uso no terreno'));

  const scanningLive = evaluateQrScannerHardwareStatus({
    isProbing: false,
    hasMediaDevicesApi: true,
    videoInputCount: 1,
    cameraPermission: 'granted',
    hasNativeBarcodeDetector: false,
    modalCameraPhase: 'SCANNING',
    hidScannerDetected: false,
    isOnline: true,
  });
  assert.equal(scanningLive.state, 'SCANNING_LIVE');
  assert.equal(scanningLive.isReadyForFieldUse, true);
  assert.ok(scanningLive.statusTextPt.includes('pronta para uso no terreno'));

  const blocked = evaluateQrScannerHardwareStatus({
    isProbing: false,
    hasMediaDevicesApi: true,
    videoInputCount: 1,
    cameraPermission: 'denied',
    hasNativeBarcodeDetector: true,
    modalCameraPhase: 'CLOSED',
    hidScannerDetected: false,
    isOnline: true,
  });
  assert.equal(blocked.state, 'CAMERA_BLOCKED');
  assert.equal(blocked.isReadyForFieldUse, false);

  const hidActive = evaluateQrScannerHardwareStatus({
    isProbing: false,
    hasMediaDevicesApi: true,
    videoInputCount: 0,
    cameraPermission: 'unknown',
    hasNativeBarcodeDetector: false,
    modalCameraPhase: 'CLOSED',
    hidScannerDetected: true,
    isOnline: false,
  });
  assert.equal(hidActive.state, 'HID_SCANNER_READY');
  assert.equal(hidActive.isReadyForFieldUse, true);
  assert.ok(hidActive.statusTextPt.includes('HID'));

  // 3. HID QR scanner burst detector distinguishes hardware scanner (<35ms/char) from human typing
  assert.equal(detectHidQrScannerBurst([100, 112, 123, 135, 146, 158], 10), true);
  assert.equal(detectHidQrScannerBurst([100, 240, 390, 510, 680, 830], 10), false);
  assert.equal(detectHidQrScannerBurst([100, 110, 120], 3), false);

  // 4. Verify DOM & CSS contract in PublicWebviewHomepage.tsx and src/index.css
  const homepageSrc = fs.readFileSync(
    path.resolve(import.meta.dirname, '../components/PublicWebviewHomepage.tsx'),
    'utf8'
  );
  const indexCssSrc = fs.readFileSync(
    path.resolve(import.meta.dirname, '../index.css'),
    'utf8'
  );
  assert.ok(homepageSrc.includes('id="public-verify-qr-hardware-status"'));
  assert.ok(homepageSrc.includes('data-testid="public-verify-qr-hardware-status"'));
  assert.ok(homepageSrc.includes('data-border-state={effectiveBorderState}'));
  assert.ok(homepageSrc.includes('verify-code-input'));
  assert.ok(indexCssSrc.includes('.verify-code-input[data-border-state="VALID_GREEN"]'));
  assert.ok(indexCssSrc.includes('border-color: #15803D;'));
  assert.ok(indexCssSrc.includes('@keyframes verify-input-success-border'));
});

test('OrthophotoInferenceService resolves KVM4/SegFormer endpoints, encodes 3-channel RGB24 crops, decodes SegFormer masks/logits & OrthoSeg LOCAL_PIXEL_METRIC polygons, and updates cvAnalysis state', async () => {
  const {
    DEFAULT_ORTHOPHOTO_CV_SERVICE_URL,
    decodeSegFormerMaskPayload,
    encodeRgbaToRgb24PngBuffer,
    executeRemoteOrthophotoInference,
    mapSegFormerLabelOrIdToSgifrClassIndex,
    prepareUploadedOrthophotoCrop,
    processRemoteInferencePayloadToCvAnalysis,
    resolveConfiguredOrthophotoServiceUrl,
    resolveOrthophotoServiceEndpoints,
  } = await import('./orthophotoInferenceService.ts');
  const { INITIAL_PARCELS } = await import('../data/seedCatalog.ts');
  const { synthesizeDeterministicCadastreContext } = await import('./vectorContextIngestor.ts');
  const { synthesizeDeterministicParcelOrthophotoRgba } = await import('./orthophotoCvPipeline.ts');

  // 1. Endpoint resolution for the live sslip.io Hostinger KVM 4 URL & contract variants
  assert.equal(
    resolveConfiguredOrthophotoServiceUrl(''),
    DEFAULT_ORTHOPHOTO_CV_SERVICE_URL
  );
  assert.equal(resolveConfiguredOrthophotoServiceUrl('local'), '');

  const kvmEndpoints = resolveOrthophotoServiceEndpoints(
    'https://goat-orthosegkv4service-8bwzr9-ae82ec-45-133-178-58.sslip.io/'
  );
  assert.equal(
    kvmEndpoints.baseOriginUrl,
    'https://goat-orthosegkv4service-8bwzr9-ae82ec-45-133-178-58.sslip.io'
  );
  assert.equal(
    kvmEndpoints.healthzUrl,
    'https://goat-orthosegkv4service-8bwzr9-ae82ec-45-133-178-58.sslip.io/healthz'
  );
  assert.equal(
    kvmEndpoints.multipartAnalyzeUrl,
    'https://goat-orthosegkv4service-8bwzr9-ae82ec-45-133-178-58.sslip.io/v1/analyze'
  );
  assert.equal(
    kvmEndpoints.segformerContractUrl,
    'https://goat-orthosegkv4service-8bwzr9-ae82ec-45-133-178-58.sslip.io/api/analyze-contract'
  );
  assert.equal(kvmEndpoints.preferredProtocol, 'MULTIPART_ANALYZE');

  const contractEndpoints = resolveOrthophotoServiceEndpoints(
    'https://goat-orthosegkv4service-8bwzr9-ae82ec-45-133-178-58.sslip.io/api/analyze-contract'
  );
  assert.equal(contractEndpoints.preferredProtocol, 'JSON_CONTRACT');

  // 2. 24-bit 3-channel RGB PNG encoding (`colorType === 2` at PNG IHDR offset 25) + sub-crop bbox math
  const sampleParcel = INITIAL_PARCELS[0];
  const vectorCtx = synthesizeDeterministicCadastreContext({
    parcelVertices: sampleParcel.vertices,
    buildingCenter: sampleParcel.buildingCenter,
    hasEredesLine: sampleParcel.hasEredesLine,
    eredesType: sampleParcel.eredesType,
  });

  const baseGrid = {
    width: 160,
    height: 160,
    bbox3763: [-98000, -90000, -97920, -89920] as [number, number, number, number],
    bboxWgs84: [-9.464, 38.797, -9.462, 38.799] as [number, number, number, number],
    leafletBounds: [
      [38.797, -9.464],
      [38.799, -9.462],
    ] as [[number, number], [number, number]],
    gsdMetersPerPx: 0.5,
    pixelAreaM2: 0.25,
    nw3763: [-98000, -89920] as [number, number],
    ne3763: [-97920, -89920] as [number, number],
    sw3763: [-98000, -90000] as [number, number],
    se3763: [-97920, -90000] as [number, number],
  };
  const synthRgba = synthesizeDeterministicParcelOrthophotoRgba({
    grid: baseGrid,
    parcelVertices: sampleParcel.vertices,
    landClass: sampleParcel.landClass,
    spatial: sampleParcel.spatial,
    vectorContext: vectorCtx,
  });
  const rgb24Buf = encodeRgbaToRgb24PngBuffer(synthRgba, 160, 160);
  // PNG signature (8 bytes) + IHDR length/type (8 bytes) + width (4) + height (4) + bitDepth (1) -> byte 25 is colorType (2 = truecolor RGB)
  assert.equal(rgb24Buf[25], 2, 'Encoded PNG must use colorType=2 (3-channel 24-bit RGB without alpha)');

  const croppedPrep = prepareUploadedOrthophotoCrop({
    imageBase64: `data:image/png;base64,${rgb24Buf.toString('base64')}`,
    parcelVertices: sampleParcel.vertices,
    bboxWgs84: [-9.464, 38.797, -9.462, 38.799],
    cropRect: { x: 40, y: 40, width: 80, height: 80 },
  });
  assert.equal(croppedPrep.width, 80);
  assert.equal(croppedPrep.height, 80);
  assert.equal(croppedPrep.wasCropped, true);
  assert.equal(croppedPrep.imageBuffer[25], 2);
  assert.deepEqual(croppedPrep.grid.bboxWgs84, [-9.4635, 38.7975, -9.4625, 38.7985]);

  // 3. SegFormer semantic label mapping & NCHW logits / 2D mask decoding
  assert.equal(mapSegFormerLabelOrIdToSgifrClassIndex('building'), 2);
  assert.equal(mapSegFormerLabelOrIdToSgifrClassIndex('coniferous'), 5);
  assert.equal(mapSegFormerLabelOrIdToSgifrClassIndex('brushwood'), 4);
  assert.equal(mapSegFormerLabelOrIdToSgifrClassIndex('impervious surface'), 1);
  assert.equal(mapSegFormerLabelOrIdToSgifrClassIndex('bare_soil'), 0);
  assert.equal(mapSegFormerLabelOrIdToSgifrClassIndex('water'), 6);

  // Build 4x4 SegFormer logits `[1, 3, 4, 4]` with id2label mapping `{ "0": "bare_soil", "1": "brushwood", "2": "tree" }`
  const plane = 16;
  const logits = new Array<number>(3 * plane).fill(-1.0);
  for (let i = 0; i < plane; i++) {
    const winningCh = i < 4 ? 0 : i < 10 ? 1 : 2;
    logits[winningCh * plane + i] = 4.5;
  }
  const decodedFromLogits = decodeSegFormerMaskPayload(
    {
      logits,
      logitsShape: [1, 3, 4, 4],
      id2label: { '0': 'bare_soil', '1': 'brushwood', '2': 'tree' },
    },
    8,
    8
  );
  assert.ok(decodedFromLogits);
  assert.equal(decodedFromLogits.length, 64);
  assert.equal(decodedFromLogits[0], 0); // bare_soil -> MINERAL_INERT_BARE
  assert.equal(decodedFromLogits[32], 4); // brushwood -> SHRUB_SCRUB_FUEL
  assert.equal(decodedFromLogits[63], 5); // tree -> TREE_CANOPY_CROWN

  // 4. OrthoSeg KVM `LOCAL_PIXEL_METRIC` (`0.08 m/px`) GeoJSON FeatureCollection -> ParcelOrthophotoCvAnalysis
  const parcelGrid = prepareUploadedOrthophotoCrop({
    rawImageBuffer: rgb24Buf,
    parcelVertices: sampleParcel.vertices,
  }).grid;

  const mockOrthoSegGeoJson = {
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'LOCAL_PIXEL_METRIC' } },
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          // Pixels [76..84, 76..84] * 0.08 = [6.08..6.72, -6.72..-6.08] near center of parcel
          coordinates: [
            [
              [6.08, -6.72],
              [6.72, -6.72],
              [6.72, -6.08],
              [6.08, -6.08],
              [6.08, -6.72],
            ],
          ],
        },
        properties: {
          class: 'tree_crown',
          confidence: 0.91,
          source_model: 'deepforest-retinanet',
        },
      },
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          // Unmapped annex at pixels [105..118, 92..102] * 0.08 = [8.40..9.44, -8.16..-7.36]
          coordinates: [
            [
              [8.4, -8.16],
              [9.44, -8.16],
              [9.44, -7.36],
              [8.4, -7.36],
              [8.4, -8.16],
            ],
          ],
        },
        properties: {
          class: 'building',
          confidence: 0.88,
          source_model: 'aerial-building-onnx',
        },
      },
    ],
    metadata: {
      crowns_detected: 1,
      buildings_detected: 1,
      elapsed_ms: 1420,
    },
  };

  const processedNeural = processRemoteInferencePayloadToCvAnalysis({
    remotePayload: mockOrthoSegGeoJson,
    grid: parcelGrid,
    rgba: new Uint8Array(synthRgba.buffer, synthRgba.byteOffset, synthRgba.byteLength),
    parcelVertices: sampleParcel.vertices,
    landClass: sampleParcel.landClass,
    spatial: sampleParcel.spatial,
    vectorContext: vectorCtx,
    imagerySourceLabel: 'DGT Ortofotos 25 cm · OrthoSeg KVM',
    configuredModelProfile: 'yolo11s-seg+segformer-b2-dgt25cm',
  });
  assert.equal(processedNeural.cvAnalysis.engineMode, 'ONNX_MICROSERVICE');
  assert.ok(processedNeural.cvAnalysis.modelProfile.includes('deepforest-retinanet'));
  assert.ok(processedNeural.cvAnalysis.crowns.length >= 1);
  assert.ok(processedNeural.cvAnalysis.detectedRoofs.length >= 1);
  assert.ok(processedNeural.cvAnalysis.overlayDataUrl?.startsWith('data:image/png;base64,'));

  // 5. End-to-end `executeRemoteOrthophotoInference` with mocked fetch (Multipart success + 502 fallback)
  const calledUrls: string[] = [];
  let sawAuthHeader = false;
  const mockSuccessFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(input);
    calledUrls.push(urlStr);
    const hdrs = (init?.headers ?? {}) as Record<string, string>;
    if (hdrs.Authorization === 'Bearer test-kvm-secret') {
      sawAuthHeader = true;
    }
    if (urlStr.endsWith('/healthz')) {
      return new Response(
        JSON.stringify({
          status: 'ok',
          workers: 3,
          workers_warmed: true,
          execution_mode: 'cpu_avx512',
          compat_endpoint: '/v1/analyze',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify(mockOrthoSegGeoJson), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const e2eSuccess = await executeRemoteOrthophotoInference({
    parcelVertices: sampleParcel.vertices,
    landClass: sampleParcel.landClass,
    spatial: sampleParcel.spatial,
    vectorContext: vectorCtx,
    rawImageBuffer: rgb24Buf,
    serviceUrl: 'https://goat-orthosegkv4service-8bwzr9-ae82ec-45-133-178-58.sslip.io/',
    apiKey: 'test-kvm-secret',
    fetchImpl: mockSuccessFetch,
  });
  assert.equal(e2eSuccess.telemetry.usedRemoteService, true);
  assert.equal(e2eSuccess.telemetry.protocolUsed, 'MULTIPART_ANALYZE');
  assert.equal(e2eSuccess.telemetry.executionMode, 'cpu_avx512');
  assert.equal(e2eSuccess.cvAnalysis.engineMode, 'ONNX_MICROSERVICE');
  assert.equal(sawAuthHeader, true);
  assert.ok(calledUrls.some((u) => u.endsWith('/v1/analyze')));

  // Verify resilient fallback to local OBIA when remote returns HTTP 502
  const mockFailFetch = async () => new Response('Bad Gateway', { status: 502 });
  const e2eFallback = await executeRemoteOrthophotoInference({
    parcelVertices: sampleParcel.vertices,
    landClass: sampleParcel.landClass,
    spatial: sampleParcel.spatial,
    vectorContext: vectorCtx,
    rawImageBuffer: rgb24Buf,
    serviceUrl: 'https://unreachable-orthoseg.example.com/',
    fetchImpl: mockFailFetch,
  });
  assert.equal(e2eFallback.telemetry.usedRemoteService, false);
  assert.equal(e2eFallback.telemetry.protocolUsed, 'LOCAL_OBIA_FALLBACK');
  assert.ok(e2eFallback.cvAnalysis.crowns.length >= 1);
});





