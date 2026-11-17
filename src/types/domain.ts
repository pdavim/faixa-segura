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

export type LatLonMultiPolygon = LatLon[][][];

export interface DetectedVectorBuilding {
  id: string;
  role: 'OWN' | 'NEIGHBOR';
  label: string;
  source: 'OSM_OVERPASS' | 'CADASTRO_SEED' | 'USER_DEFINED' | 'CV_ORTHOPHOTO_25CM';
  footprint: LatLon[];
  areaM2: number;
  distanceToParcelEdgeM: number;
}

export type EasementCategory =
  | 'EREDES_MT_AT'
  | 'REN_MAT'
  | 'PUBLIC_ROAD'
  | 'RAILWAY';

export interface DetectedLinearEasement {
  id: string;
  category: EasementCategory;
  label: string;
  operatorLabel: string;
  bufferHalfWidthM: number;
  centerline: LatLon[];
  source: 'OSM_OVERPASS' | 'EREDES_OPENDATA' | 'CADASTRO_SEED' | 'USER_DEFINED';
}

export type ExemptFeatureCategory =
  | 'RIPARIAN_WATERWAY'
  | 'IRRIGATED_AGRICULTURE'
  | 'IMPERVIOUS_WATER';

export interface DetectedExemptFeature {
  id: string;
  category: ExemptFeatureCategory;
  label: string;
  legalBasis: string;
  bufferHalfWidthM?: number;
  centerline?: LatLon[];
  polygon?: LatLon[];
  source: 'OSM_OVERPASS' | 'COS_DGT' | 'CADASTRO_SEED' | 'USER_DEFINED';
}

export interface ParcelVectorContext {
  detectedAtIso: string;
  sourceMode: 'LIVE_OVERPASS_WFS' | 'SYNTHESIZED_CADASTRE';
  sourceSummaryPt: string;
  searchRadiusM: number;
  isSettlementInterface100m?: boolean;
  settlementName?: string;
  humanVerifiedCount?: number;
  buildings: DetectedVectorBuilding[];
  easements: DetectedLinearEasement[];
  exemptFeatures: DetectedExemptFeature[];
  neighborParcels?: Array<{
    id: string;
    label: string;
    bupiRef: string;
    polygon: LatLon[];
    ndvi: number;
  }>;
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
  multiPolygons?: {
    ownBuildings: LatLonMultiPolygon;
    neighborBuildings: LatLonMultiPolygon;
    zone1Immediate: LatLonMultiPolygon;
    zone2Near: LatLonMultiPolygon;
    zone3Extended: LatLonMultiPolygon;
    neighborInducedObligation: LatLonMultiPolygon;
    thirdPartyCorridor: LatLonMultiPolygon;
    riparianAndAgriExempt: LatLonMultiPolygon;
    exemptCore: LatLonMultiPolygon;
    neighborRiskOverflow: LatLonMultiPolygon;
  };
  decompositionMeta?: {
    engineVersion: 'BOOLEAN_EPSG3763_V2';
    outerBufferRadiusM: 10 | 50 | 100;
    ownBuildingsCount: number;
    ownBuildingsAreaM2: number;
    neighborBuildingsWithin50mCount: number;
    neighborInducedCleanAreaM2: number;
    eredesEasementM2: number;
    roadEasementM2: number;
    riparianProtectedM2: number;
    neighborOverflowRiskM2: number;
    vectorSourceLabel: string;
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

export type OrthophotoSemanticClass =
  | 'MINERAL_INERT_BARE'
  | 'PAVED_ROAD_IMPERVIOUS'
  | 'BUILT_ROOF_STRUCTURE'
  | 'LOW_HERBACEOUS_CLEARED'
  | 'SHRUB_SCRUB_FUEL'
  | 'TREE_CANOPY_CROWN'
  | 'WATER_RIPARIAN';

export interface DetectedTreeCrown {
  id: string;
  centerWgs84: LatLon;
  centerPtTm06: PtTm06Coord;
  areaM2: number;
  diameterM: number;
  polygonWgs84: LatLon[];
  speciesGroup: 'RESINOUS_EUCALYPT' | 'BROADLEAF_QUERCUS';
  distanceToBuildingWallM: number;
  nearestCrownDistanceM: number;
  zoneCode: 'ZONE_1' | 'ZONE_2' | 'ZONE_3' | 'EASEMENT' | 'EXEMPT' | 'OUTSIDE';
  violationRulePt: string | null;
  originalViolationRulePt?: string | null;
  humanOverride?: 'PROTECTED_QUERCUS' | 'PRUNED_COMPLIANT';
}

export interface DetectedRoofStructure {
  id: string;
  label: string;
  centerWgs84: LatLon;
  areaM2: number;
  footprintWgs84: LatLon[];
  confidence: number;
  isUnmappedInOsm: boolean;
  role: 'OWN' | 'NEIGHBOR';
  distanceToParcelEdgeM: number;
  reviewStatus?: 'UNREVIEWED' | 'ACCEPTED' | 'DISMISSED';
}

export interface ZoneCvComplianceMetrics {
  zone1BareMineralPct: number;
  zone1Compliant: boolean;
  zone2CanopyPct: number;
  zone2ShrubPct: number;
  zone2CrownsUnder5mCount: number;
  zone3CanopyPct: number;
  zone3ShrubPct: number;
  zone3MeanCrownSpacingM: number;
  crownSpacingViolationsCount: number;
  easementCanopyIntrusionPct: number;
  overallStatus: 'COMPLIANT' | 'ATTENTION' | 'NON_COMPLIANT';
  auditSummaryPt: string;
}

export interface ParcelOrthophotoCvAnalysis {
  analyzedAtIso: string;
  engineMode: 'ONNX_MICROSERVICE' | 'REAL_ORTHOPHOTO_PIXEL_CV' | 'OFFLINE_SYNTHETIC_CV';
  imagerySourceLabel: string;
  modelProfile: string;
  rasterWidthPx: number;
  rasterHeightPx: number;
  gsdMetersPerPx: number;
  bboxWgs84: [number, number, number, number];
  leafletBounds: [[number, number], [number, number]];
  overlayDataUrl?: string;
  classAreasM2: Record<OrthophotoSemanticClass, number>;
  crowns: DetectedTreeCrown[];
  detectedRoofs: DetectedRoofStructure[];
  unmappedRoofsCount: number;
  fusedIntoVectorContext?: boolean;
  zoneCompliance: ZoneCvComplianceMetrics;
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
  satelliteSourceLabel?: string;
  elevationMeta?: {
    minElevationM: number;
    maxElevationM: number;
    reliefM: number;
    aspectLabelPt: string;
    sourceLabel: string;
    sampledPointsCount?: number;
  };
  neighborInfo: {
    bupiRef: string;
    vegetationDescription: string;
    shrubHeightM: number;
    dominantSpecies: string;
    ndvi: number;
  };
  vectorContext?: ParcelVectorContext;
  cvAnalysis?: ParcelOrthophotoCvAnalysis;
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
  district?: string;
  nature: 'Mato' | 'Povoamento Florestal' | 'Agrícola' | 'Situação Crítica';
  status: 'Em Curso' | 'Em Resolução' | 'Em Conclusão' | 'Vigilância' | 'Despacho';
  lat: number;
  lon: number;
  distanceKm: number;
  operatives: number;
  vehicles: number;
  aerialMeans: number;
  startedAt: string;
  source:
    | 'ANEPC Proteção Civil (Tempo Real)'
    | 'ANEPC / API Aberta'
    | 'Simulação Preventiva Regional';
  anepcNaturezaCode?: string;
  updatedAtIso?: string;
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
  dispatchReceiptPt?: string;
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

export type ProximityRadiusKm = 5 | 10 | 15 | 25;

export type StormHazardKind =
  | 'WINDSTORM'
  | 'DRY_THUNDERSTORM'
  | 'HEAVY_RAIN_FLOOD'
  | 'EXTREME_GUSTS';

export type StormSeverityLevel = 'YELLOW' | 'ORANGE' | 'RED';

export interface StormAlertIncident {
  id: string;
  title: string;
  kind: StormHazardKind;
  severity: StormSeverityLevel;
  municipality: string;
  district: string;
  lat: number;
  lon: number;
  radiusKm: number;
  maxWindKmh: number;
  precipitationMmH: number;
  lightningRisk: boolean;
  validUntil: string;
  source:
    | 'IPMA Avisos Oficiais (Tempo Real)'
    | 'ANEPC Proteção Civil (Tempo Real)'
    | 'IPMA Avisos Meteorológicos'
    | 'Simulação Preventiva Regional'
    | 'Teste de Proximidade no Mato';
  ipmaAreaCode?: string;
  isDistrictWideWarning?: boolean;
  anepcNaturezaCode?: string;
  operatives?: number;
  vehicles?: number;
  updatedAtIso?: string;
}

export type RealtimeTransportMode = 'websocket' | 'sse' | 'http' | 'offline';

export interface AnepcNationalSummary {
  totalOccurrences: number;
  totalOperatives: number;
  totalVehicles: number;
  totalAerial: number;
  totalFires: number;
  totalSignificant: number;
}

export interface RealtimeHazardFeedMeta {
  connected: boolean;
  transport: RealtimeTransportMode;
  anepcLive: boolean;
  ipmaLive: boolean;
  anepcSourceLabel: string;
  ipmaSourceLabel: string;
  anepcNational: AnepcNationalSummary | null;
  ipmaActiveWarningsCount: number;
  activeFireIncidentsCount: number;
  activeWeatherIncidentsCount: number;
  lastUpdatedIso: string;
}

export interface RealtimeHazardsSnapshotPayload {
  updatedAtIso: string;
  fires: Omit<ActiveFireIncident, 'distanceKm'>[];
  storms: StormAlertIncident[];
  meta: RealtimeHazardFeedMeta;
}

export interface UserAppSettings {
  pirAlertThreshold: 3 | 4;
  proximityAlertRadiusKm: ProximityRadiusKm;
  autoDownloadCertificatePdf: boolean;
  defaultBufferRule: '50M_BUILDING' | '100M_SETTLEMENT';
  offlineAutoSync: boolean;
  notifyQuotesWhatsapp: boolean;
  enableFireProximityAlerts?: boolean;
  enableStormProximityAlerts?: boolean;
  prioritizeForestScrubAlerts?: boolean;
  browserNotificationsEnabled?: boolean;
}
