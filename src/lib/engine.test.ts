import test from 'node:test';
import assert from 'node:assert/strict';
import {
  wgs84ToPtTm06,
  computeParcelFgc,
  buildMunicipalGtfGeoJson,
  buildMunicipalGtfKml,
  haversineDistanceKm,
} from './spatialEngine.ts';
import {
  evaluateOperationalSemaphore,
  buildCanonicalCertificatePayload,
  computeSha256Hex,
  answerLegalFieldQuestion,
} from './pirRules.ts';

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

  const orthoUrl = buildTileUrl('ORTHOPHOTO', 18, tile18.x, tile18.y);
  const vectorUrl = buildTileUrl('VECTOR', 18, tile18.x, tile18.y);
  assert.ok(
    orthoUrl.endsWith(`/tile/18/${tile18.y}/${tile18.x}`),
    'Esri World Imagery must format URL as /tile/{z}/{y}/{x}'
  );
  assert.ok(
    vectorUrl.endsWith(`/light_all/18/${tile18.x}/${tile18.y}.png`),
    'CARTO Vector must format URL as /light_all/{z}/{x}/{y}.png'
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
