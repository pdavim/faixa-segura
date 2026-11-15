import type { DailyPirForecast, PirLevel } from '../types/domain.ts';

export interface PirMeta {
  level: PirLevel;
  designation: string;
  colorHex: string;
  badgeBgLight: string;
  badgeTextLight: string;
  shortRule: string;
}

export const PIR_SCALE: Record<PirLevel, PirMeta> = {
  1: {
    level: 1,
    designation: 'Reduzido',
    colorHex: '#16A34A',
    badgeBgLight: '#DCFCE7',
    badgeTextLight: '#14532D',
    shortRule: 'Maquinaria metálica e trabalhos florestais permitidos.',
  },
  2: {
    level: 2,
    designation: 'Moderado',
    colorHex: '#65A30D',
    badgeBgLight: '#ECFCCB',
    badgeTextLight: '#365314',
    shortRule: 'Maquinaria permitida (recomendado meio de 1.ª intervenção no local).',
  },
  3: {
    level: 3,
    designation: 'Elevado',
    colorHex: '#EAB308',
    badgeBgLight: '#FEF9C3',
    badgeTextLight: '#713F12',
    shortRule: 'Condicionado: exige retenção de faúlhas e extintor 2 kg / mochila de água.',
  },
  4: {
    level: 4,
    designation: 'Muito Elevado',
    colorHex: '#EA580C',
    badgeBgLight: '#FFEDD5',
    badgeTextLight: '#7C2D12',
    shortRule: 'PROIBIDO usar lâmina metálica/discos, motosserra de risco e queimas.',
  },
  5: {
    level: 5,
    designation: 'Máximo',
    colorHex: '#991B1B',
    badgeBgLight: '#FEE2E2',
    badgeTextLight: '#7F1D1D',
    shortRule: 'INTERDIÇÃO TOTAL de maquinaria geradora de faísca, queimas e permanência em APPS.',
  },
};

/**
 * Deterministic Operational Semaphore Matrix (DL n.º 82/2021 Art.º 66.º-69.º + ICNF)
 */
export function evaluateOperationalSemaphore(params: {
  dateLabel: string;
  isoDate: string;
  pirLevel: PirLevel;
  tempMaxC: number;
  humidityMinPct: number;
  windKmh: number;
}): DailyPirForecast {
  const { pirLevel } = params;
  const meta = PIR_SCALE[pirLevel];

  if (pirLevel === 1 || pirLevel === 2) {
    return {
      ...params,
      designation: meta.designation,
      nylonTrimmer: {
        status: 'ALLOWED',
        summary: 'PERMITIDO sem restrições horárias especiais.',
      },
      metalBladeMachinery: {
        status: 'ALLOWED',
        summary: 'PERMITIDO usar lâmina metálica, motosserra e grade de discos (recomendado extintor/água).',
      },
      debrisBurning: {
        status: 'CONDITIONAL',
        summary: 'PERMITIDO apenas com Comunicação Prévia obrigatória no portal ICNF (1 nov–31 mai) ou Autorização Camarária.',
      },
    };
  }

  if (pirLevel === 3) {
    return {
      ...params,
      designation: meta.designation,
      nylonTrimmer: {
        status: 'ALLOWED',
        summary: 'PERMITIDO operar motorroçadora com cabeça de fio de nylon.',
      },
      metalBladeMachinery: {
        status: 'CONDITIONAL',
        summary: 'CONDICIONADO: Obrigatório dispositivo de retenção de faúlhas e meio de 1.ª intervenção (extintor 2 kg / pá / água).',
      },
      debrisBurning: {
        status: 'CONDITIONAL',
        summary: 'CONDICIONADO: Apenas fora da época crítica, vento fraco, faixa limpa de 2 m em redor e vigilância permanente.',
      },
      affiliateTip: {
        title: 'Kit Obrigatório de 1.ª Intervenção (Extintor Florestal 2 kg + Cabeça Fio Polímero)',
        reason: 'Exigido em fiscalização GNR/SEPNA para operar maquinaria em dias de risco Elevado.',
        category: 'Segurança Operacional',
      },
    };
  }

  // Levels 4 (Muito Elevado) and 5 (Máximo)
  return {
    ...params,
    designation: meta.designation,
    nylonTrimmer: {
      status: 'CONDITIONAL',
      summary:
        pirLevel === 5
          ? 'EVITAR nas horas de calor; interdito em Áreas Prioritárias de Prevenção e Segurança (APPS).'
          : 'PERMITIDO APENAS fio de nylon (sem peças metálicas de corte), evitando o período 11h00–19h00.',
    },
    metalBladeMachinery: {
      status: 'PROHIBITED',
      summary:
        'PROIBIDO POR LEI operar motorroçadoras com lâminas/discos metálicos, corta-matos e grades de discos (Art.º 68.º DL 82/2021 — contraordenação grave).',
    },
    debrisBurning: {
      status: 'PROHIBITED',
      summary:
        'ESTRITAMENTE PROIBIDO queimar amontoados ou sobrantes (infração muito grave / crime de incêndio rural).',
    },
    affiliateTip: {
      title: 'Cabeça Automática de Fio Nylon Torcido 3.0 mm + Roçadora Brushless 36V s/ Faísca',
      reason: 'Substitui o disco metálico proibido hoje em risco Muito Elevado/Máximo e elimina faúlhas em terreno pedregoso.',
      category: 'Equipamento Sem Faísca',
    },
  };
}

/**
 * Computes days until next statutory fuel-management deadline (May 31st).
 */
export function getStatutoryDeadlineStatus(referenceDate = new Date()): {
  deadlineLabel: string;
  daysRemaining: number;
  isPostDeadlineWindow: boolean;
  urgencyText: string;
} {
  const year = referenceDate.getFullYear();
  const may31ThisYear = new Date(Date.UTC(year, 4, 31, 23, 59, 59));
  const diffCurrent = Math.ceil(
    (may31ThisYear.getTime() - referenceDate.getTime()) / (1000 * 60 * 60 * 24)
  );

  if (diffCurrent >= 0) {
    return {
      deadlineLabel: `31 de maio de ${year}`,
      daysRemaining: diffCurrent,
      isPostDeadlineWindow: false,
      urgencyText:
        diffCurrent <= 30
          ? `Faltam ${diffCurrent} dias para o termo do prazo anual obrigatório`
          : `${diffCurrent} dias até ao prazo anual de 31 de maio`,
    };
  }

  const nextMay31 = new Date(Date.UTC(year + 1, 4, 31, 23, 59, 59));
  const daysToNext = Math.ceil(
    (nextMay31.getTime() - referenceDate.getTime()) / (1000 * 60 * 60 * 24)
  );

  return {
    deadlineLabel: `31 de maio de ${year + 1}`,
    daysRemaining: daysToNext,
    isPostDeadlineWindow: true,
    urgencyText: `Manutenção pós-época ativa · Próximo prazo legal: 31 mai ${year + 1} (${daysToNext} dias)`,
  };
}

/**
 * Deterministic canonical string builder for SHA-256 certificate hashing.
 */
export function buildCanonicalCertificatePayload(input: {
  shortCode: string;
  parcelId: string;
  dico: string;
  ownerNif: string;
  cleanedAreaM2: number;
  pirLevelAtWork: number;
  issuedAt: string;
}): string {
  return [
    'FAIXASEGURA-SGIFR-V2026',
    input.shortCode.trim().toUpperCase(),
    input.parcelId.trim(),
    input.dico.trim(),
    input.ownerNif.replace(/\s+/g, ''),
    input.cleanedAreaM2.toFixed(2),
    String(input.pirLevelAtWork),
    input.issuedAt,
  ].join('|');
}

/**
 * Computes SHA-256 hex digest using Web Crypto API (works identically in Browser and Node 22).
 */
export async function computeSha256Hex(canonicalPayload: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(canonicalPayload);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Deterministic RAG Legal Knowledge Base for DL n.º 82/2021, Despacho n.º 675/2026 & DL n.º 169/2001.
 */
export function answerLegalFieldQuestion(question: string): {
  answer: string;
  legalBasis: string;
  keyAction: string;
} {
  const q = question.toLowerCase();

  if (q.includes('sobreiro') || q.includes('azinheira') || q.includes('cortiça')) {
    return {
      answer:
        'Não pode abater nem podar intensivamente sobreiros (Quercus suber) ou azinheiras (Quercus rotundifolia) sem autorização expressa prévia do ICNF, mesmo dentro da faixa de 50 metros. Deve apenas limpar o estrato arbustivo/ervas secas sob a copa e remover ramos secos inferiores com corte cuidado.',
      legalBasis: 'Decreto-Lei n.º 169/2001 (Proteção do Sobreiro e Azinheira) conjugado com o DL n.º 82/2021',
      keyAction: 'Preservar os exemplares e registar a sua conservação no Auto Digital de Conformidade.',
    };
  }

  if (q.includes('fruto') || q.includes('limoeiro') || q.includes('figueira') || q.includes('oliveira') || q.includes('jardim') || q.includes('ornament')) {
    return {
      answer:
        'Árvores de fruto isoladas, oliveiras produtivas e espécies ornamentais de jardim não exigem abate obrigatório, desde que assegurada a descontinuidade vertical (ausência de ervas secas ou silvado contínuo debaixo da copa) e que os ramos não se projetem sobre o telhado nem a menos de 5 metros de chaminés/paredes na Zona Próxima.',
      legalBasis: 'Despacho n.º 675/2026, de 21 de janeiro + Critérios Técnicos SGIFR (DL n.º 82/2021)',
      keyAction: 'Manter o solo mineral/relva curta sob a copa e afastar ramos da cobertura da casa.',
    };
  }

  if (q.includes('vizinho') || q.includes('abandonad') || q.includes('muro') || q.includes('estrema')) {
    return {
      answer:
        'A obrigação da faixa de 50 metros mede-se a partir da parede exterior da sua habitação, projetando-se para dentro do terreno vizinho. Se o proprietário confinante não limpar até ao prazo legal, a Câmara Municipal tem competência para notificar (mesmo por edital de 5 dias quando o dono é desconhecido) e realizar execução coerciva a expensas do infrator.',
      legalBasis: 'Artigos 49.º, 57.º e 58.º do Decreto-Lei n.º 82/2021 (Execução Coerciva Municipal)',
      keyAction: 'Emitir o Requerimento Formal "Vizinho Incumpridor" com ortofoto e ficheiro GeoJSON para o GTF da Câmara.',
    };
  }

  if (q.includes('e-redes') || q.includes('eletric') || q.includes('elétric') || q.includes('poste') || q.includes('linha') || q.includes('tensão')) {
    return {
      answer:
        'Nas linhas aéreas de Média Tensão (faixa mínima de 7 m para cada lado do eixo) e Alta Tensão (10 m para cada lado), a responsabilidade legal e o custo da gestão de combustível cabem à entidade exploradora da rede (E-REDES), e não ao proprietário do solo.',
      legalBasis: 'Artigo 49.º do Decreto-Lei n.º 82/2021 (Redes de Transporte e Distribuição de Energia)',
      keyAction: 'Descontar a faixa azul do seu orçamento de limpeza privada.',
    };
  }

  if (q.includes('roçadora') || q.includes('disco') || q.includes('motosserra') || q.includes('sábado') || q.includes('domingo') || q.includes('horário')) {
    return {
      answer:
        'Nos dias em que o IPMA classifica o concelho com Perigo de Incêndio Rural (PIR) Muito Elevado (Nível 4) ou Máximo (Nível 5), é proibido usar motorroçadoras com lâminas ou discos metálicos, corta-matos e grades de discos. Nesses dias, apenas cabeças de fio de nylon (polímero não metálico) podem ser usadas com precaução fora das horas de maior calor.',
      legalBasis: 'Artigo 68.º e 69.º do Decreto-Lei n.º 82/2021 (Maquinaria e Equipamentos)',
      keyAction: 'Consultar sempre o Semáforo Operacional Diário antes de ligar equipamento no fim de semana.',
    };
  }

  return {
    answer:
      'O Despacho n.º 675/2026 estrutura a envolvente dos edifícios em solo florestal/rústico (50 m) em três coroas: Zona 1 Imediata (0–2 m, faixa inerte sem vegetação), Zona 2 Próxima (2–10 m, desbaste rigoroso e zero copas a menos de 5 m da fachada) e Zona 3 Alargada (10–50 m, mato rasteiro e copas afastadas 4 m, ou 10 m no caso de pinheiro-bravo e eucalipto).',
    legalBasis: 'Decreto-Lei n.º 82/2021 + Despacho n.º 675/2026, de 21 de janeiro',
    keyAction: 'Verificar no separador Mapa & Faixas as áreas exatas de cada coroa no seu polígono.',
  };
}
