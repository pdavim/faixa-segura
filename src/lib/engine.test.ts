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



