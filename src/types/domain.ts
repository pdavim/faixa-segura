export type LandClass = 'FOREST_SCRUB' | 'AGRICULTURE' | 'URBAN_BUILT';

export type PirLevel = 1 | 2 | 3 | 4 | 5;

export type PermissionStatus = 'ALLOWED' | 'CONDITIONAL' | 'PROHIBITED';

export interface LatLon {
  lat: number;
  lon: number;
}

export interface PtTm06Coord {
  x: number; // Easting relative to central meridian (meters, EPSG:3763)
  y: number; // Northing relative to origin (meters, EPSG:3763)
}

export interface MunicipalityInfo {
  dico: string;
  dicofreDefault: string;
  name: string;
  district: string;
  regionGroup: 'AML' | 'AMP' | 'CENTRO_NORTE';
  defaultCenter: LatLon;
  basePirToday: PirLevel;
  basePirTomorrow: PirLevel;
  basePirDay2: PirLevel;
  isPriorityParishDefault: boolean;
}

export interface SpatialZoneBreakdown {
  totalAreaM2: number;
  perimeterM: number;
  centroidWgs84: LatLon;
  centroidPtTm06: PtTm06Coord;
  zone1ImmediateM2: number; // 0-2m (#E11D48)
  zone2NearM2: number;      // 2-10m (#EA580C)
  zone3ExtendedM2: number;  // 10-50m/100m (#F59E0B)
  mandatoryCleanAreaM2: number;
  thirdPartyEasementM2: number; // E-REDES / Vias (#06B6D4)
  exemptAreaM2: number;         // Isenta (#4ADE80)
  estimatedEredesSavingsEur: number;
  polygons: {
    parcel: LatLon[];
    buildingFootprint: LatLon[];
    zone1Immediate: LatLon[];
    zone2Near: LatLon[];
    zone3Extended: LatLon[];
    thirdPartyCorridor: LatLon[];
    exemptCore: LatLon[];
    neighborRiskParcel: LatLon[];
  };
  neighborMinDistanceM: number;
  neighborDirection: string;
}

export interface SatelliteObservation {
  date: string;
  ndvi: number;
  ndmi: number;
  cloudCoverPct: number;
}

export interface ParcelRecord {
  id: string;
  label: string;
  parish: string;
  municipality: string;
  district: string;
  dico: string;
  dicofre: string;
  matrixArticle: string;
  bupiRggId: string;
  landClass: LandClass;
  avgSlopePct: number;
  hasPavedAccess: boolean;
  roadFrontageM: number;
  hazardLevel: 1 | 2 | 3 | 4 | 5;
  isPriorityParish: boolean;
  hasProtectedOaks: boolean;
  protectedOakNotes: string;
  userNotes?: string;
  vertices: LatLon[];
  buildingCenter: LatLon;
  hasEredesLine: boolean;
  eredesType: 'MT 15kV (Faixa 7m)' | 'AT 60kV (Faixa 10m)' | 'Sem linha aérea';
  ndviHistory: SatelliteObservation[];
  neighborInfo: {
    bupiRef: string;
    vegetationDescription: string;
    shrubHeightM: number;
    dominantSpecies: string;
    ndvi: number;
  };
  spatial: SpatialZoneBreakdown;
}

export interface DailyPirForecast {
  dateLabel: string;
  isoDate: string;
  pirLevel: PirLevel;
  designation: string;
  tempMaxC: number;
  humidityMinPct: number;
  windKmh: number;
  nylonTrimmer: { status: PermissionStatus; summary: string };
  metalBladeMachinery: { status: PermissionStatus; summary: string };
  debrisBurning: { status: PermissionStatus; summary: string };
  affiliateTip?: {
    title: string;
    reason: string;
    category: string;
  };
}

export interface ActiveFireIncident {
  id: string;
  municipality: string;
  parish: string;
  nature: 'Mato' | 'Povoamento Florestal' | 'Agrícola';
  status: 'Em Curso' | 'Em Resolução' | 'Em Conclusão';
  lat: number;
  lon: number;
  distanceKm: number;
  operatives: number;
  vehicles: number;
  aerialMeans: number;
  startedAt: string;
  source: 'ANEPC / API Aberta' | 'Simulação Preventiva Regional';
}

export interface PhotoEvidence {
  id: string;
  stage: 'BEFORE' | 'AFTER';
  zoneLabel: string;
  takenAt: string;
  lat: number;
  lon: number;
  azimuthDeg: number;
  azimuthCardinal: string;
  aiAuditPassed: boolean;
  aiNotes: string;
  previewDataUrl?: string;
}

export interface ComplianceCertificate {
  id: string;
  shortCode: string;
  parcelId: string;
  parcelLabel: string;
  municipality: string;
  parish: string;
  dico: string;
  dicofre: string;
  matrixArticle: string;
  bupiRggId: string;
  ownerName: string;
  ownerNif: string;
  cleanedAreaM2: number;
  pirLevelAtWork: PirLevel;
  executionMode: 'CONTRACTOR' | 'SELF';
  contractorName?: string;
  contractorNif?: string;
  invoiceRef?: string;
  photos: PhotoEvidence[];
  protectedSpeciesCheck: string;
  sha256Hash: string;
  issuedAt: string;
  spatialSnapshot: SpatialZoneBreakdown;
}

export interface NeighborComplaintRecord {
  id: string;
  reqCode: string;
  parcelId: string;
  municipality: string;
  parish: string;
  dicofre: string;
  complainantName: string;
  complainantNif: string;
  complainantAddress: string;
  complainantPhone: string;
  complainantEmail: string;
  ownCertRef?: string;
  minDistanceFacadeM: number;
  confrontationSide: string;
  shrubHeightM: number;
  dominantSpecies: string;
  neighborNdvi: number;
  hazardClassLabel: string;
  formalPetitionText: string;
  neighborCentroidWgs84: LatLon;
  neighborCentroidPtTm06: PtTm06Coord;
  neighborPolygon: LatLon[];
  buildingPolygon: LatLon[];
  issuedAt: string;
}

export interface ForestryProvider {
  id: string;
  nif: string;
  companyName: string;
  caeCode: '02400' | '81300';
  phoneWhatsapp: string;
  email: string;
  hasRcInsurance: boolean;
  hasSparkArrestor: boolean;
  hasIcnfOakCredential: boolean;
  machinery: string[];
  coveredDicos: string[];
  coveredMunicipalities: string[];
  minAreaM2: number;
  rating: number;
  completedCertificates: number;
  verified: boolean;
}

export interface QuoteLead {
  id: string;
  parcelId: string;
  parcelLabel: string;
  municipality: string;
  dico: string;
  mandatoryCleanAreaM2: number;
  totalAreaM2: number;
  avgSlopePct: number;
  landClass: LandClass;
  hasPavedAccess: boolean;
  roadFrontageM: number;
  ndvi: number;
  ownerName: string;
  ownerPhone: string;
  preferredWindow: string;
  includeDebrisRemoval: boolean;
  estimatedBudgetRange: string;
  matchedProvidersCount: number;
  unlockedByProviderIds: string[];
  status: 'OPEN' | 'QUOTED' | 'COMPLETED';
  createdAt: string;
}

export type UserHistoryCategory =
  | 'PARCEL'
  | 'CERTIFICATE'
  | 'QUOTE'
  | 'NEIGHBOR'
  | 'INTERVENTION';

export interface UserHistoryRecord {
  id: string;
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
  status: 'ACTIVE' | 'ARCHIVED';
  createdAtIso: string;
}

export interface UserAccountProfile {
  uid: string;
  displayName: string;
  email: string;
  preferredDico: string;
  nif: string;
  phone: string;
}

export type ParcelDocumentCategory =
  | 'CADERNETA_PREDIAL'
  | 'BUPI_RGG'
  | 'FATURA_LIMPEZA'
  | 'AUTO_CONFORMIDADE'
  | 'AUTORIZACAO_ICNF'
  | 'OUTRO';

export interface ParcelDocumentRecord {
  id: string;
  parcelId: string;
  fileName: string;
  category: ParcelDocumentCategory;
  mimeType: string;
  sizeBytes: number;
  notes: string;
  uploadedAtIso: string;
  dataUrl?: string;
}

export interface UserAppSettings {
  pirAlertThreshold: 3 | 4;
  proximityAlertRadiusKm: 10 | 15 | 25;
  autoDownloadCertificatePdf: boolean;
  defaultBufferRule: '50M_BUILDING' | '100M_SETTLEMENT';
  offlineAutoSync: boolean;
  notifyQuotesWhatsapp: boolean;
}


