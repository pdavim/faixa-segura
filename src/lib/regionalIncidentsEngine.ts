import type { ActiveFireIncident, LatLon, ParcelRecord, PirLevel } from '../types/domain.ts';
import { haversineDistanceKm } from './spatialEngine.ts';

export type MunicipalTrendDirection = 'RISING' | 'STABLE' | 'FALLING';

export interface RegionalMunicipalitySeed {
  dico: string;
  name: string;
  district: string;
  subRegionLabel: string;
  center: LatLon;
  structuralForestWeight: number; // 0.6 – 1.45 forestry ignition propensity
  basePir30dPeak: PirLevel;
}

export interface MunicipalIncidentBarPoint {
  dico: string;
  municipality: string;
  shortLabel: string;
  district: string;
  distanceKm: number;
  isParcelMunicipality: boolean;
  incidents30dTotal: number;
  forestScrub30d: number;
  agricultural30d: number;
  prev15dIncidents: number;
  last15dIncidents: number;
  activeNowCount: number;
  trendPct: number;
  trendDirection: MunicipalTrendDirection;
  trendLabelPt: string;
  peakPir30d: PirLevel;
  barColorHex: string;
}

export interface RegionalIncidentsSummary {
  subRegionTitle: string;
  windowLabel: string;
  points: MunicipalIncidentBarPoint[];
  totalIncidents30d: number;
  regionalAvgPerMunicipality: number;
  highestTrendMunicipality: MunicipalIncidentBarPoint;
  ownMunicipalityPoint: MunicipalIncidentBarPoint;
  advisoryHeadline: string;
  advisoryDetail: string;
}

/**
 * Representative catalog of Portuguese municipalities across ANEPC sub-regions
 * (Grande Lisboa/Oeste/Setúbal, Área Metropolitana do Porto/Tâmega, Região de Leiria/Centro/Beiras, Minho).
 */
const REGIONAL_MUNICIPALITY_CATALOG: RegionalMunicipalitySeed[] = [
  // Grande Lisboa, Oeste & Península de Setúbal
  {
    dico: '1111',
    name: 'Sintra',
    district: 'Lisboa',
    subRegionLabel: 'Grande Lisboa, Oeste & Setúbal',
    center: { lat: 38.7984, lon: -9.4621 },
    structuralForestWeight: 1.18,
    basePir30dPeak: 4,
  },
  {
    dico: '1109',
    name: 'Mafra',
    district: 'Lisboa',
    subRegionLabel: 'Grande Lisboa, Oeste & Setúbal',
    center: { lat: 38.9482, lon: -9.3185 },
    structuralForestWeight: 1.24,
    basePir30dPeak: 4,
  },
  {
    dico: '1105',
    name: 'Cascais',
    district: 'Lisboa',
    subRegionLabel: 'Grande Lisboa, Oeste & Setúbal',
    center: { lat: 38.7223, lon: -9.4315 },
    structuralForestWeight: 0.92,
    basePir30dPeak: 4,
  },
  {
    dico: '1107',
    name: 'Loures',
    district: 'Lisboa',
    subRegionLabel: 'Grande Lisboa, Oeste & Setúbal',
    center: { lat: 38.8309, lon: -9.1684 },
    structuralForestWeight: 1.05,
    basePir30dPeak: 3,
  },
  {
    dico: '1113',
    name: 'Torres Vedras',
    district: 'Lisboa',
    subRegionLabel: 'Grande Lisboa, Oeste & Setúbal',
    center: { lat: 39.0911, lon: -9.2586 },
    structuralForestWeight: 1.12,
    basePir30dPeak: 3,
  },
  {
    dico: '1508',
    name: 'Palmela',
    district: 'Setúbal',
    subRegionLabel: 'Grande Lisboa, Oeste & Setúbal',
    center: { lat: 38.5688, lon: -8.9012 },
    structuralForestWeight: 1.15,
    basePir30dPeak: 4,
  },

  // Área Metropolitana do Porto, Tâmega & Entre Douro e Vouga
  {
    dico: '1315',
    name: 'Valongo',
    district: 'Porto',
    subRegionLabel: 'Área Metropolitana do Porto & Tâmega',
    center: { lat: 41.1862, lon: -8.4988 },
    structuralForestWeight: 1.28,
    basePir30dPeak: 4,
  },
  {
    dico: '1310',
    name: 'Paredes',
    district: 'Porto',
    subRegionLabel: 'Área Metropolitana do Porto & Tâmega',
    center: { lat: 41.2054, lon: -8.3308 },
    structuralForestWeight: 1.36,
    basePir30dPeak: 4,
  },
  {
    dico: '1304',
    name: 'Gondomar',
    district: 'Porto',
    subRegionLabel: 'Área Metropolitana do Porto & Tâmega',
    center: { lat: 41.1442, lon: -8.5322 },
    structuralForestWeight: 1.22,
    basePir30dPeak: 4,
  },
  {
    dico: '1311',
    name: 'Penafiel',
    district: 'Porto',
    subRegionLabel: 'Área Metropolitana do Porto & Tâmega',
    center: { lat: 41.2083, lon: -8.2848 },
    structuralForestWeight: 1.31,
    basePir30dPeak: 4,
  },
  {
    dico: '1309',
    name: 'Paços de Ferreira',
    district: 'Porto',
    subRegionLabel: 'Área Metropolitana do Porto & Tâmega',
    center: { lat: 41.2764, lon: -8.3758 },
    structuralForestWeight: 1.04,
    basePir30dPeak: 3,
  },
  {
    dico: '1314',
    name: 'Santo Tirso',
    district: 'Porto',
    subRegionLabel: 'Área Metropolitana do Porto & Tâmega',
    center: { lat: 41.3426, lon: -8.4775 },
    structuralForestWeight: 1.09,
    basePir30dPeak: 3,
  },
  {
    dico: '0310',
    name: 'Terras de Bouro',
    district: 'Braga',
    subRegionLabel: 'Cávado, Ave & Alto Minho',
    center: { lat: 41.7168, lon: -8.3092 },
    structuralForestWeight: 1.26,
    basePir30dPeak: 3,
  },
  {
    dico: '0313',
    name: 'Vila Verde',
    district: 'Braga',
    subRegionLabel: 'Cávado, Ave & Alto Minho',
    center: { lat: 41.6482, lon: -8.4356 },
    structuralForestWeight: 1.16,
    basePir30dPeak: 3,
  },
  {
    dico: '1601',
    name: 'Arcos de Valdevez',
    district: 'Viana do Castelo',
    subRegionLabel: 'Cávado, Ave & Alto Minho',
    center: { lat: 41.8467, lon: -8.4191 },
    structuralForestWeight: 1.33,
    basePir30dPeak: 4,
  },

  // Região de Leiria, Pinhal Interior, Coimbra & Beiras
  {
    dico: '1009',
    name: 'Leiria',
    district: 'Leiria',
    subRegionLabel: 'Região de Leiria, Pinhal Interior & Centro',
    center: { lat: 39.7438, lon: -8.8071 },
    structuralForestWeight: 1.25,
    basePir30dPeak: 5,
  },
  {
    dico: '1015',
    name: 'Pombal',
    district: 'Leiria',
    subRegionLabel: 'Região de Leiria, Pinhal Interior & Centro',
    center: { lat: 39.9154, lon: -8.6281 },
    structuralForestWeight: 1.32,
    basePir30dPeak: 5,
  },
  {
    dico: '1008',
    name: 'Figueiró dos Vinhos',
    district: 'Leiria',
    subRegionLabel: 'Região de Leiria, Pinhal Interior & Centro',
    center: { lat: 39.9018, lon: -8.2764 },
    structuralForestWeight: 1.38,
    basePir30dPeak: 5,
  },
  {
    dico: '1010',
    name: 'Marinha Grande',
    district: 'Leiria',
    subRegionLabel: 'Região de Leiria, Pinhal Interior & Centro',
    center: { lat: 39.7478, lon: -8.9322 },
    structuralForestWeight: 1.08,
    basePir30dPeak: 4,
  },
  {
    dico: '1419',
    name: 'Tomar',
    district: 'Santarém',
    subRegionLabel: 'Região de Leiria, Pinhal Interior & Centro',
    center: { lat: 39.6035, lon: -8.4092 },
    structuralForestWeight: 1.21,
    basePir30dPeak: 4,
  },
  {
    dico: '0508',
    name: 'Proença-a-Nova',
    district: 'Castelo Branco',
    subRegionLabel: 'Região de Leiria, Pinhal Interior & Centro',
    center: { lat: 39.7495, lon: -7.9238 },
    structuralForestWeight: 1.42,
    basePir30dPeak: 5,
  },
  {
    dico: '0603',
    name: 'Coimbra',
    district: 'Coimbra',
    subRegionLabel: 'Região de Coimbra & Beiras',
    center: { lat: 40.2185, lon: -8.3962 },
    structuralForestWeight: 1.11,
    basePir30dPeak: 4,
  },
  {
    dico: '0101',
    name: 'Águeda',
    district: 'Aveiro',
    subRegionLabel: 'Região de Aveiro & Viseu Dão Lafões',
    center: { lat: 40.5744, lon: -8.4481 },
    structuralForestWeight: 1.27,
    basePir30dPeak: 4,
  },
  {
    dico: '1823',
    name: 'Viseu',
    district: 'Viseu',
    subRegionLabel: 'Região de Aveiro & Viseu Dão Lafões',
    center: { lat: 40.661, lon: -7.9097 },
    structuralForestWeight: 1.24,
    basePir30dPeak: 4,
  },
];

function deterministicHash(seedStr: string): number {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function formatShortDatePt(d: Date): string {
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}`;
}

function abbreviateMunicipality(name: string): string {
  if (name === 'Figueiró dos Vinhos') return 'Figueiró V.';
  if (name === 'Paços de Ferreira') return 'Paços Ferr.';
  if (name === 'Proença-a-Nova') return 'Proença-N.';
  if (name === 'Terras de Bouro') return 'T. Bouro';
  if (name === 'Arcos de Valdevez') return 'Arcos Vald.';
  if (name === 'Marinha Grande') return 'Marinha Gr.';
  if (name === 'Torres Vedras') return 'T. Vedras';
  if (name === 'Santo Tirso') return 'Sto. Tirso';
  return name;
}

/**
 * Builds a deterministic 30-day regional rural fire incident summary across the 6 nearest
 * municipalities in the active parcel's sub-region, enriched with live ANEPC incidents (`fires`).
 */
export function buildRegionalThirtyDayIncidents(
  parcel: ParcelRecord,
  activeFires: ActiveFireIncident[] = [],
  referenceDate: Date = new Date()
): RegionalIncidentsSummary {
  const centroid = parcel.spatial.centroidWgs84;
  const monthIdx = referenceDate.getUTCMonth(); // 0..11
  // Seasonal factor in Portugal: peak Jun–Sep (1.55), shoulder Apr–May & Oct (1.15), autumn/winter Nov–Mar (0.72)
  const seasonalFactor =
    monthIdx >= 5 && monthIdx <= 8
      ? 1.55
      : monthIdx === 3 || monthIdx === 4 || monthIdx === 9
      ? 1.15
      : 0.78;

  // Ensure the parcel's own municipality exists in the candidate pool
  const hasOwnInCatalog = REGIONAL_MUNICIPALITY_CATALOG.some(
    (m) => m.dico === parcel.dico || m.name.toLowerCase() === parcel.municipality.toLowerCase()
  );

  const candidates: RegionalMunicipalitySeed[] = hasOwnInCatalog
    ? [...REGIONAL_MUNICIPALITY_CATALOG]
    : [
        {
          dico: parcel.dico,
          name: parcel.municipality,
          district: parcel.district,
          subRegionLabel: `Sub-Região de ${parcel.district}`,
          center: centroid,
          structuralForestWeight: 1.15,
          basePir30dPeak: parcel.hazardLevel,
        },
        ...REGIONAL_MUNICIPALITY_CATALOG,
      ];

  // Rank by proximity to parcel centroid so the 6 municipalities represent its contiguous region
  const ranked = candidates
    .map((m) => {
      const isOwn =
        m.dico === parcel.dico || m.name.toLowerCase() === parcel.municipality.toLowerCase();
      const distanceKm = isOwn ? 0 : Number(haversineDistanceKm(centroid, m.center).toFixed(1));
      return { seed: m, isOwn, distanceKm };
    })
    .sort((a, b) => {
      if (a.isOwn && !b.isOwn) return -1;
      if (!a.isOwn && b.isOwn) return 1;
      return a.distanceKm - b.distanceKm;
    })
    .slice(0, 6);

  const anchorSubRegion = ranked[0]?.seed.subRegionLabel ?? `Região de ${parcel.district}`;
  const isoBucket = `${referenceDate.getUTCFullYear()}-${String(monthIdx + 1).padStart(2, '0')}`;

  const start30d = new Date(referenceDate.getTime() - 29 * 86_400_000);
  const windowLabel = `${formatShortDatePt(start30d)} – ${formatShortDatePt(referenceDate)}`;

  const points: MunicipalIncidentBarPoint[] = ranked.map(({ seed, isOwn, distanceKm }) => {
    const h1 = deterministicHash(`${seed.dico}-${isoBucket}-prev15`);
    const h2 = deterministicHash(`${seed.dico}-${isoBucket}-last15`);

    const activeNowCount = activeFires.filter(
      (f) => f.municipality.toLowerCase() === seed.name.toLowerCase()
    ).length;

    const basePrev = Math.max(
      2,
      Math.round((3.4 + (h1 % 5)) * seed.structuralForestWeight * seasonalFactor)
    );
    const drift = ((h2 % 7) - 3) * 0.14; // -42% to +42% fortnightly shift
    const rawLast = Math.round(basePrev * (1 + drift)) + activeNowCount;
    const last15dIncidents = Math.max(1, rawLast);
    const prev15dIncidents = basePrev;
    const incidents30dTotal = prev15dIncidents + last15dIncidents;

    const forestRatio = 0.58 + ((h1 % 18) / 100); // 58%–75% forest/scrub
    const forestScrub30d = Math.max(1, Math.round(incidents30dTotal * forestRatio));
    const agricultural30d = Math.max(0, incidents30dTotal - forestScrub30d);

    const trendPct = Math.round(
      ((last15dIncidents - prev15dIncidents) / Math.max(1, prev15dIncidents)) * 100
    );

    let trendDirection: MunicipalTrendDirection = 'STABLE';
    let trendLabelPt = 'Estável';
    let barColorHex = '#D97706'; // Amber moderate baseline

    if (trendPct >= 15 || activeNowCount > 0) {
      trendDirection = 'RISING';
      trendLabelPt = activeNowCount > 0 ? 'Ativo / Agravamento' : 'Agravamento';
      barColorHex = trendPct >= 28 || activeNowCount > 0 ? '#DC2626' : '#EA580C';
    } else if (trendPct <= -12) {
      trendDirection = 'FALLING';
      trendLabelPt = 'Desagravamento';
      barColorHex = '#16A34A';
    }

    return {
      dico: seed.dico,
      municipality: seed.name,
      shortLabel: isOwn ? `★ ${abbreviateMunicipality(seed.name)}` : abbreviateMunicipality(seed.name),
      district: seed.district,
      distanceKm,
      isParcelMunicipality: isOwn,
      incidents30dTotal,
      forestScrub30d,
      agricultural30d,
      prev15dIncidents,
      last15dIncidents,
      activeNowCount,
      trendPct,
      trendDirection,
      trendLabelPt,
      peakPir30d: seed.basePir30dPeak,
      barColorHex,
    };
  });

  // Order bars from highest 30-day incident count to lowest for immediate visual hierarchy in bar chart
  const sortedPoints = [...points].sort((a, b) => {
    if (b.incidents30dTotal !== a.incidents30dTotal) {
      return b.incidents30dTotal - a.incidents30dTotal;
    }
    return b.trendPct - a.trendPct;
  });

  const totalIncidents30d = sortedPoints.reduce((acc, p) => acc + p.incidents30dTotal, 0);
  const regionalAvgPerMunicipality = Number(
    (totalIncidents30d / Math.max(1, sortedPoints.length)).toFixed(1)
  );

  const highestTrendMunicipality = [...sortedPoints].sort((a, b) => b.trendPct - a.trendPct)[0];
  const ownMunicipalityPoint =
    sortedPoints.find((p) => p.isParcelMunicipality) ?? sortedPoints[0];

  const risingCount = sortedPoints.filter((p) => p.trendDirection === 'RISING').length;
  const advisoryHeadline =
    ownMunicipalityPoint.trendDirection === 'RISING'
      ? `Pressão crescente em ${ownMunicipalityPoint.municipality} (${
          ownMunicipalityPoint.trendPct >= 0 ? `+${ownMunicipalityPoint.trendPct}%` : `${ownMunicipalityPoint.trendPct}%`
        } nos últimos 15 dias)`
      : risingCount >= 2
      ? `${risingCount} municípios vizinhos em tendência de subida (${highestTrendMunicipality.municipality} em destaque)`
      : `Pressão regional controlada na sub-região (${totalIncidents30d} ocorrências em 30 dias)`;

  const advisoryDetail =
    ownMunicipalityPoint.trendDirection === 'RISING'
      ? `Foram registadas ${ownMunicipalityPoint.incidents30dTotal} ocorrências rurais em ${ownMunicipalityPoint.municipality} nos últimos 30 dias (${ownMunicipalityPoint.forestScrub30d} em mato/floresta). Priorize a revisão da Zona 1–2 (0–10 m) e evite queimas de sobrantes.`
      : `No seu município (${ownMunicipalityPoint.municipality}) registaram-se ${ownMunicipalityPoint.incidents30dTotal} ocorrências em 30 dias, enquanto ${highestTrendMunicipality.municipality} apresenta a variação mais acentuada (${
          highestTrendMunicipality.trendPct >= 0
            ? `+${highestTrendMunicipality.trendPct}%`
            : `${highestTrendMunicipality.trendPct}%`
        }). Aproveite janelas de menor pressão para concluir a gestão da faixa.`;

  return {
    subRegionTitle: anchorSubRegion,
    windowLabel,
    points: sortedPoints,
    totalIncidents30d,
    regionalAvgPerMunicipality,
    highestTrendMunicipality,
    ownMunicipalityPoint,
    advisoryHeadline,
    advisoryDetail,
  };
}
