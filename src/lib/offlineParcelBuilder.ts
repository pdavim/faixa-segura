import type {
  LandClass,
  LatLon,
  MunicipalityInfo,
  NeighborComplaintRecord,
  ParcelRecord,
  QuoteLead,
} from '../types/domain.ts';
import { MUNICIPALITIES } from '../data/seedCatalog.ts';
import { computeParcelFgc, wgs84ToPtTm06 } from './spatialEngine.ts';

export function buildLocalParcelRecord(params: {
  label: string;
  vertices: LatLon[];
  dico?: string;
  parish?: string;
  matrixArticle?: string;
  bupiRggId?: string;
  landClass?: LandClass;
  avgSlopePct?: number;
  hasEredesLine?: boolean;
  hasProtectedOaks?: boolean;
  municipalities?: MunicipalityInfo[];
  nowMs?: number;
}): ParcelRecord {
  const catalog = params.municipalities?.length ? params.municipalities : MUNICIPALITIES;
  const muni = catalog.find((m) => m.dico === params.dico) ?? catalog[0];
  const landClass: LandClass = params.landClass ?? 'FOREST_SCRUB';
  const hasEredesLine = Boolean(params.hasEredesLine);
  const hasProtectedOaks = Boolean(params.hasProtectedOaks);
  const ts = params.nowMs ?? Date.now();

  const spatial = computeParcelFgc({
    vertices: params.vertices,
    landClass,
    hasEredesLine,
    neighborDistanceOverrideM: 4.6,
  });

  const deterministicSuffix = String((ts % 899999) + 100000);

  return {
    id: `parcel-${ts}`,
    label: params.label.trim(),
    parish: params.parish?.trim() || muni.name,
    municipality: muni.name,
    district: muni.district,
    dico: muni.dico,
    dicofre: muni.dicofreDefault,
    matrixArticle: params.matrixArticle?.trim() || 'Rústico — Art.º 204, Secção D',
    bupiRggId: params.bupiRggId?.trim() || `RGG-${deterministicSuffix}`,
    landClass,
    avgSlopePct: Number(params.avgSlopePct ?? 12.5),
    hasPavedAccess: true,
    roadFrontageM: 24,
    hazardLevel: 4,
    isPriorityParish: muni.isPriorityParishDefault,
    hasProtectedOaks,
    protectedOakNotes: hasProtectedOaks
      ? 'Exemplares de Sobreiro/Azinheira assinalados — corte interdito sem autorização ICNF (DL 169/2001).'
      : 'Sem quercíneas protegidas assinaladas no polígono.',
    vertices: params.vertices,
    buildingCenter: spatial.centroidWgs84,
    hasEredesLine,
    eredesType: hasEredesLine ? 'MT 15kV (Faixa 7m)' : 'Sem linha aérea',
    ndviHistory: [
      { date: '2026-03-15', ndvi: 0.43, ndmi: 0.28, cloudCoverPct: 7 },
      { date: '2026-04-02', ndvi: 0.51, ndmi: 0.23, cloudCoverPct: 10 },
      { date: '2026-04-18', ndvi: 0.57, ndmi: 0.19, cloudCoverPct: 6 },
      { date: '2026-05-04', ndvi: 0.63, ndmi: 0.15, cloudCoverPct: 8 },
    ],
    neighborInfo: {
      bupiRef: 'Confrontação Poente (Titular a apurar pela Câmara)',
      vegetationDescription: 'Mato contínuo e silvado junto à estrema poente',
      shrubHeightM: 1.75,
      dominantSpecies: 'Pinheiro-bravo, Eucalipto e Silvado',
      ndvi: 0.71,
    },
    spatial,
  };
}

export function extractCadernetaOffline(
  rawText: string,
  municipalities: MunicipalityInfo[] = MUNICIPALITIES
): {
  municipality: string;
  dico: string;
  matrixArticle: string;
  suggestedLabel: string;
  hasProtectedOaks: boolean;
  vertices: LatLon[];
} {
  const lower = rawText.toLowerCase();
  const matchedMuni =
    municipalities.find((m) => lower.includes(m.name.toLowerCase())) ?? municipalities[0];

  const artMatch = rawText.match(/artigo\s*(?:matricial)?\s*[:n.º]*\s*([0-9A-Za-z-]+)/i);
  const secMatch = rawText.match(/sec[çc][ãa]o\s*[:]*\s*([A-Z0-9]+)/i);
  const center = matchedMuni.defaultCenter;

  return {
    municipality: matchedMuni.name,
    dico: matchedMuni.dico,
    matrixArticle: `Rústico — Art.º ${artMatch?.[1] || '218'}, Secção ${secMatch?.[1] || 'F'}`,
    suggestedLabel: `Prédio Caderneta · ${matchedMuni.name}`,
    hasProtectedOaks: lower.includes('sobreir') || lower.includes('azinheir'),
    vertices: [
      { lat: Number((center.lat - 0.00034).toFixed(6)), lon: Number((center.lon - 0.00044).toFixed(6)) },
      { lat: Number((center.lat + 0.00036).toFixed(6)), lon: Number((center.lon - 0.00041).toFixed(6)) },
      { lat: Number((center.lat + 0.00038).toFixed(6)), lon: Number((center.lon + 0.00045).toFixed(6)) },
      { lat: Number((center.lat - 0.00032).toFixed(6)), lon: Number((center.lon + 0.00042).toFixed(6)) },
    ],
  };
}

export function buildLocalQuoteLead(params: {
  parcel: ParcelRecord;
  ownerName: string;
  ownerPhone: string;
  preferredWindow: string;
  includeDebrisRemoval: boolean;
  matchedProvidersCount?: number;
  nowMs?: number;
}): QuoteLead {
  const ts = params.nowMs ?? Date.now();
  const cleanM2 = params.parcel.spatial.mandatoryCleanAreaM2;
  const slopeFactor = params.parcel.avgSlopePct > 20 ? 0.48 : 0.34;
  const debrisFactor = params.includeDebrisRemoval ? 0.14 : 0;
  const lowEst = Math.round(cleanM2 * (slopeFactor + debrisFactor));
  const highEst = Math.round(lowEst * 1.38);

  return {
    id: `lead-${ts}`,
    parcelId: params.parcel.id,
    parcelLabel: params.parcel.label,
    municipality: params.parcel.municipality,
    dico: params.parcel.dico,
    mandatoryCleanAreaM2: cleanM2,
    totalAreaM2: params.parcel.spatial.totalAreaM2,
    avgSlopePct: params.parcel.avgSlopePct,
    landClass: params.parcel.landClass,
    hasPavedAccess: params.parcel.hasPavedAccess,
    roadFrontageM: params.parcel.roadFrontageM,
    ndvi: params.parcel.ndviHistory[params.parcel.ndviHistory.length - 1]?.ndvi ?? 0.65,
    ownerName: params.ownerName.trim(),
    ownerPhone: params.ownerPhone.trim(),
    preferredWindow: params.preferredWindow || 'Próximos 15 dias',
    includeDebrisRemoval: Boolean(params.includeDebrisRemoval),
    estimatedBudgetRange: `${lowEst} € – ${highEst} €`,
    matchedProvidersCount: Math.max(params.matchedProvidersCount ?? 2, 2),
    unlockedByProviderIds: [],
    status: 'OPEN',
    createdAt: new Date(ts).toISOString(),
  };
}

export function buildLocalNeighborComplaint(params: {
  parcel: ParcelRecord;
  complainantName: string;
  complainantNif: string;
  complainantAddress?: string;
  complainantPhone?: string;
  complainantEmail?: string;
  ownCertRef?: string;
  nowMs?: number;
}): NeighborComplaintRecord {
  const ts = params.nowMs ?? Date.now();
  const issuedAt = new Date(ts).toISOString();
  const reqCode = `REQ-${issuedAt.slice(0, 10).replace(/-/g, '')}-${Math.random()
    .toString(16)
    .slice(2, 6)
    .toUpperCase()}`;

  const nbPoly = params.parcel.spatial.polygons.neighborRiskParcel;
  const nbLat = nbPoly.reduce((s, p) => s + p.lat, 0) / nbPoly.length;
  const nbLon = nbPoly.reduce((s, p) => s + p.lon, 0) / nbPoly.length;
  const neighborCentroidWgs84 = {
    lat: Number(nbLat.toFixed(6)),
    lon: Number(nbLon.toFixed(6)),
  };
  const neighborCentroidPtTm06 = wgs84ToPtTm06(neighborCentroidWgs84);

  const formalPetitionText =
    `1. O prédio confinante identificado nas coordenadas oficiais ETRS89 / PT-TM06 (X: ${neighborCentroidPtTm06.x} m, Y: ${neighborCentroidPtTm06.y} m), freguesia de ${params.parcel.parish} (DICOFRE ${params.parcel.dicofre}), encontra-se integralmente abrangido pela Faixa de Gestão de Combustível obrigatória de 50 metros medida a partir da alvenaria exterior da habitação do Requerente, em área classificada com Perigosidade de Incêndio Rural Classe ${params.parcel.hazardLevel} (ICNF).\n\n` +
    `2. Constata-se no local a presença contínua de ${params.parcel.neighborInfo.dominantSpecies}, com estrato arbustivo seco de altura estimada em ${params.parcel.neighborInfo.shrubHeightM.toFixed(2)} m a apenas ${params.parcel.spatial.neighborMinDistanceM.toFixed(2)} metros da fachada habitacional, em violação direta dos critérios de interface imediata (0-2 m), próxima (2-10 m) e alargada estatuídos no Despacho n.º 675/2026, de 21 de janeiro, e no Artigo 49.º do Decreto-Lei n.º 82/2021. A leitura multiespectral Copernicus Sentinel-2 confirma elevada densidade de carga combustível (NDVI: ${params.parcel.neighborInfo.ndvi.toFixed(2)}).`;

  return {
    id: `req-${ts}`,
    reqCode,
    parcelId: params.parcel.id,
    municipality: params.parcel.municipality,
    parish: params.parcel.parish,
    dicofre: params.parcel.dicofre,
    complainantName: params.complainantName.trim(),
    complainantNif: params.complainantNif.replace(/\s+/g, ''),
    complainantAddress:
      params.complainantAddress?.trim() || `Lugar de ${params.parcel.parish}, ${params.parcel.municipality}`,
    complainantPhone: params.complainantPhone?.trim() || '910 000 000',
    complainantEmail: params.complainantEmail?.trim() || 'proprietario@faixasegura.pt',
    ownCertRef: params.ownCertRef,
    minDistanceFacadeM: params.parcel.spatial.neighborMinDistanceM,
    confrontationSide: 'Poente / Noroeste',
    shrubHeightM: params.parcel.neighborInfo.shrubHeightM,
    dominantSpecies: params.parcel.neighborInfo.dominantSpecies,
    neighborNdvi: params.parcel.neighborInfo.ndvi,
    hazardClassLabel: `Classe ${params.parcel.hazardLevel} (Alta/Muito Alta ICNF)`,
    formalPetitionText,
    neighborCentroidWgs84,
    neighborCentroidPtTm06,
    neighborPolygon: nbPoly,
    buildingPolygon: params.parcel.spatial.polygons.buildingFootprint,
    issuedAt,
  };
}
