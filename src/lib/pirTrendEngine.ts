import type { DailyPirForecast, ParcelRecord, PirLevel } from '../types/domain.ts';
import { PIR_SCALE } from './pirRules.ts';

export interface PirSoilTrendPoint {
  isoDate: string;
  shortDate: string;
  weekdayShort: string;
  isToday: boolean;
  pirLevel: PirLevel;
  pirLabel: string;
  pirColorHex: string;
  soilMoisturePct: number; // Volumetric soil moisture (%) derived from NDMI, slope & meteorology
  airHumidityMinPct: number;
  tempMaxC: number;
  windKmh: number;
  precipitationMm: number;
  interventionScore: number; // 0-100 suitability score for safe fuel-break clearing
  interventionVerdict: 'IDEAL' | 'CONDICIONADO' | 'INTERDITO';
  allowedToolSummary: string;
}

export interface SevenDayInterventionSummary {
  points: PirSoilTrendPoint[];
  avgPir7d: number;
  pirDelta7d: number;
  currentSoilMoisturePct: number;
  soilMoistureDelta7d: number;
  bestDay: PirSoilTrendPoint;
  actionHeadline: string;
  actionDetail: string;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function deterministicDaySeed(dico: string, dayOffset: number): number {
  const numericDico = parseInt(dico.replace(/\D/g, '') || '1111', 10);
  const x = Math.sin(numericDico * 17.3 + (dayOffset + 10) * 31.7) * 10000;
  return x - Math.floor(x);
}

/**
 * Builds a deterministic 7-day meteorological risk (PIR 1-5) and volumetric soil moisture (%)
 * series anchored to the active parcel's DICO, slope, Sentinel-2 NDMI, and live IPMA today forecast.
 */
export function buildSevenDayPirSoilSeries(
  parcel: ParcelRecord,
  todayForecast?: DailyPirForecast,
  referenceDate: Date = new Date()
): SevenDayInterventionSummary {
  const latestSat = parcel.ndviHistory[parcel.ndviHistory.length - 1];
  const baseNdmi = latestSat?.ndmi ?? 0.18;
  // Convert Sentinel-2 NDMI (-0.2 to +0.5) + slope drainage into realistic volumetric soil moisture (10% - 48%)
  const slopeDrainagePenalty = Math.min(8, parcel.avgSlopePct * 0.28);
  const anchorSoilMoisture = clamp(
    Math.round(24 + baseNdmi * 52 - slopeDrainagePenalty),
    11,
    46
  );
  const anchorPir: PirLevel = todayForecast?.pirLevel ?? (parcel.hazardLevel >= 4 ? 3 : 2);

  const rawPoints: Array<{
    isoDate: string;
    shortDate: string;
    weekdayShort: string;
    isToday: boolean;
    pirLevel: PirLevel;
    tempMaxC: number;
    airHumidityMinPct: number;
    windKmh: number;
    precipitationMm: number;
    soilMoisturePct: number;
  }> = [];

  // Generate D-6 through D0 (Today = last point of the 7-day window)
  let rollingMoisture = clamp(anchorSoilMoisture + 5, 12, 48);

  for (let offset = -6; offset <= 0; offset += 1) {
    const d = new Date(referenceDate.getTime() + offset * 86_400_000);
    const isoDate = d.toISOString().slice(0, 10);
    const shortDate = `${isoDate.slice(8, 10)}/${isoDate.slice(5, 7)}`;
    const rawWd = d.toLocaleDateString('pt-PT', { weekday: 'short' }).replace('.', '');
    const weekdayShort = rawWd.charAt(0).toUpperCase() + rawWd.slice(1, 3);
    const isToday = offset === 0;

    const seed = deterministicDaySeed(parcel.dico, offset);
    const seed2 = deterministicDaySeed(parcel.id, offset * 2);

    let pirLevel: PirLevel;
    let tempMaxC: number;
    let airHumidityMinPct: number;
    let windKmh: number;
    let precipitationMm: number;

    if (isToday && todayForecast) {
      pirLevel = todayForecast.pirLevel;
      tempMaxC = todayForecast.tempMaxC;
      airHumidityMinPct = todayForecast.humidityMinPct;
      windKmh = todayForecast.windKmh;
      precipitationMm = pirLevel === 1 && seed > 0.55 ? Number((seed * 4.5).toFixed(1)) : 0;
    } else {
      const wave = Math.round(Math.sin((offset + 6) * 0.95 + seed * 1.6) * 1.35);
      pirLevel = clamp(anchorPir + wave, 1, 5) as PirLevel;
      tempMaxC = Math.round(16 + pirLevel * 3.1 + (seed2 - 0.5) * 3);
      airHumidityMinPct = clamp(Math.round(66 - pirLevel * 9.5 + (seed - 0.5) * 6), 14, 82);
      windKmh = Math.max(6, Math.round(8 + pirLevel * 4.6 + (seed2 - 0.4) * 6));
      precipitationMm =
        pirLevel <= 2 && seed > 0.48 ? Number(((seed - 0.42) * 11).toFixed(1)) : 0;
    }

    if (isToday) {
      rollingMoisture = anchorSoilMoisture;
    } else {
      const evapLoss = (tempMaxC - 14) * 0.16 + windKmh * 0.05;
      const rainGain = precipitationMm * 1.35;
      rollingMoisture = clamp(
        Number((rollingMoisture - evapLoss + rainGain).toFixed(1)),
        10,
        48
      );
    }

    rawPoints.push({
      isoDate,
      shortDate,
      weekdayShort: isToday ? 'Hoje' : weekdayShort,
      isToday,
      pirLevel,
      tempMaxC,
      airHumidityMinPct,
      windKmh,
      precipitationMm,
      soilMoisturePct: Number(rollingMoisture.toFixed(1)),
    });
  }

  const points: PirSoilTrendPoint[] = rawPoints.map((pt) => {
    const pirMeta = PIR_SCALE[pt.pirLevel];
    // Suitability score: rewards low PIR (1-2) and soil moisture >= 22% (reduces spark & dust ignition risk)
    const pirScore = (6 - pt.pirLevel) * 15; // 15..75
    const moistureBonus = clamp((pt.soilMoisturePct - 12) * 0.85, 0, 25); // 0..25
    const interventionScore = clamp(Math.round(pirScore + moistureBonus), 5, 100);

    let interventionVerdict: 'IDEAL' | 'CONDICIONADO' | 'INTERDITO';
    let allowedToolSummary: string;

    if (pt.pirLevel <= 2 && pt.soilMoisturePct >= 20) {
      interventionVerdict = 'IDEAL';
      allowedToolSummary = 'Janela ótima: disco metálico, motosserra e trituração permitidos.';
    } else if (pt.pirLevel <= 3) {
      interventionVerdict = 'CONDICIONADO';
      allowedToolSummary =
        pt.pirLevel === 3
          ? 'Risco Elevado: preferir fio de nylon/polímero antes das 11h00.'
          : 'Solo seco (<20%): vigiar faúlhas em pedras com lâmina metálica.';
    } else {
      interventionVerdict = 'INTERDITO';
      allowedToolSummary =
        pt.pirLevel === 4
          ? 'Proibido disco metálico: apenas fio de nylon fora das 11h–19h.'
          : 'Risco Máximo (RCM 5): interdição total de maquinaria na faixa.';
    }

    return {
      ...pt,
      pirLabel: pirMeta.designation,
      pirColorHex: pirMeta.colorHex,
      interventionScore,
      interventionVerdict,
      allowedToolSummary,
    };
  });

  const avgPir7d = Number(
    (points.reduce((acc, p) => acc + p.pirLevel, 0) / points.length).toFixed(1)
  );
  const pirDelta7d = points[points.length - 1].pirLevel - points[0].pirLevel;
  const currentSoilMoisturePct = points[points.length - 1].soilMoisturePct;
  const soilMoistureDelta7d = Number(
    (currentSoilMoisturePct - points[0].soilMoisturePct).toFixed(1)
  );

  // Best day in the 7-day profile (prioritizing today if suitable, else highest suitability)
  const bestDay = [...points].sort((a, b) => b.interventionScore - a.interventionScore)[0];
  const todayPt = points[points.length - 1];

  let actionHeadline: string;
  let actionDetail: string;

  if (todayPt.interventionVerdict === 'IDEAL') {
    actionHeadline = `Condições favoráveis hoje (RCM ${todayPt.pirLevel} · Solo ${todayPt.soilMoisturePct}%)`;
    actionDetail = `Humidade do solo adequada (${todayPt.soilMoisturePct}%) e perigo ${todayPt.pirLabel.toLowerCase()} permitem limpeza mecânica integral nas Zonas 1–3 (${parcel.spatial.mandatoryCleanAreaM2.toFixed(0)} m²).`;
  } else if (todayPt.pirLevel === 3 || todayPt.pirLevel === 4) {
    actionHeadline = `Intervenção condicionada hoje (RCM ${todayPt.pirLevel} · Solo ${todayPt.soilMoisturePct}%)`;
    actionDetail =
      soilMoistureDelta7d < 0
        ? `O solo perdeu ${Math.abs(soilMoistureDelta7d).toFixed(1)} p.p. de humidade nos últimos 7 dias. Utilize exclusivamente cabeça de fio de nylon no período matinal (07h00–11h00).`
        : `Mantenha trabalhos com fio de polímero fora das horas de calor e evite lâminas metálicas devido ao índice RCM ${todayPt.pirLevel}.`;
  } else {
    actionHeadline = `Suspender maquinaria hoje (RCM ${todayPt.pirLevel} · Solo seco ${todayPt.soilMoisturePct}%)`;
    actionDetail = `Índice RCM Máximo combinado com baixa retenção hídrica superficial. Agende equipa credenciada assim que o índice desça para RCM ≤ 3.`;
  }

  return {
    points,
    avgPir7d,
    pirDelta7d,
    currentSoilMoisturePct,
    soilMoistureDelta7d,
    bestDay,
    actionHeadline,
    actionDetail,
  };
}
