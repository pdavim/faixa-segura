import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import QRCode from 'qrcode';
import type {
  ComplianceCertificate,
  NeighborComplaintRecord,
} from '../types/domain.ts';
import { PIR_SCALE } from './pirRules.ts';

/**
 * Ensures text only contains characters supported by WinAnsiEncoding (StandardFonts.Helvetica),
 * preserving all Portuguese diacritics (ã, õ, ç, á, é, í, ó, ú, â, ê, º, ª, °, €).
 */
export function sanitizeWinAnsi(input: string): string {
  return input
    .replace(/—/g, '-')
    .replace(/–/g, '-')
    .replace(/•/g, '-')
    .replace(/·/g, '|')
    .replace(/→|->/g, '->')
    .replace(/↑/g, 'N')
    .replace(/±/g, '+/-')
    .replace(/[^\x20-\x7E\xA0-\xFF€]/g, '');
}

function wrapTextLines(text: string, maxCharsPerLine: number): string[] {
  const clean = sanitizeWinAnsi(text);
  const paragraphs = clean.split('\n');
  const lines: string[] = [];

  for (const para of paragraphs) {
    if (!para.trim()) {
      lines.push('');
      continue;
    }
    const words = para.trim().split(/\s+/);
    let current = '';
    for (const word of words) {
      if ((current + ' ' + word).trim().length <= maxCharsPerLine) {
        current = (current + ' ' + word).trim();
      } else {
        if (current) lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

/**
 * Template #1: Auto Digital de Conformidade Preventiva (PDF A4 — 2 Páginas Vetoriais)
 */
export async function generateComplianceCertificatePdf(
  cert: ComplianceCertificate,
  publicBaseUrl: string
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const fontReg = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontMono = await pdfDoc.embedFont(StandardFonts.Courier);

  const verifyUrl = `${publicBaseUrl.replace(/\/$/, '')}/?verify=${encodeURIComponent(cert.shortCode)}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl, { margin: 1, width: 160 });
  const qrImage = await pdfDoc.embedPng(qrDataUrl);

  // ==================== PÁGINA 1 ====================
  const p1 = pdfDoc.addPage([595.28, 841.89]); // A4
  const { width, height } = p1.getSize();

  // Institutional Slate Header (#0F172A)
  p1.drawRectangle({ x: 0, y: height - 78, width, height: 78, color: rgb(0.06, 0.09, 0.16) });
  p1.drawRectangle({ x: 0, y: height - 82, width, height: 4, color: rgb(0.08, 0.33, 0.18) }); // Pine accent

  p1.drawText(sanitizeWinAnsi('FAIXASEGURA | REGISTO TÉCNICO AUDITÁVEL DE GESTÃO DE COMBUSTÍVEL (SGIFR)'), {
    x: 36,
    y: height - 30,
    size: 9,
    font: fontBold,
    color: rgb(0.29, 0.87, 0.5),
  });
  p1.drawText(sanitizeWinAnsi('AUTO DIGITAL DE CONFORMIDADE PREVENTIVA'), {
    x: 36,
    y: height - 50,
    size: 15,
    font: fontBold,
    color: rgb(1, 1, 1),
  });
  p1.drawText(sanitizeWinAnsi(`CERT: #${cert.shortCode}`), {
    x: width - 175,
    y: height - 48,
    size: 11,
    font: fontMono,
    color: rgb(0.98, 0.8, 0.08),
  });
  p1.drawText(sanitizeWinAnsi('Decreto-Lei n.º 82/2021 + Despacho n.º 675/2026, de 21 de janeiro'), {
    x: 36,
    y: height - 66,
    size: 8.5,
    font: fontReg,
    color: rgb(0.75, 0.82, 0.9),
  });

  let y = height - 108;

  // Section 1
  p1.drawText(sanitizeWinAnsi('1. IDENTIFICAÇÃO DO PRÉDIO E ENQUADRAMENTO CADASTRAL'), {
    x: 36,
    y,
    size: 10.5,
    font: fontBold,
    color: rgb(0.08, 0.33, 0.18),
  });
  y -= 16;

  const s1Rows = [
    ['Designação / Local:', `${cert.parcelLabel} (${cert.parish})`],
    ['Município / Códigos:', `${cert.municipality} (DICO: ${cert.dico} | DICOFRE: ${cert.dicofre})`],
    ['Artigo Matricial / BUPi:', `${cert.matrixArticle} | ID BUPi: ${cert.bupiRggId}`],
    [
      'Centroide Oficial:',
      `${cert.spatialSnapshot.centroidWgs84.lat.toFixed(6)}° N, ${cert.spatialSnapshot.centroidWgs84.lon.toFixed(6)}° W (ETRS89 X:${cert.spatialSnapshot.centroidPtTm06.x}m Y:${cert.spatialSnapshot.centroidPtTm06.y}m)`,
    ],
    ['Titular / Detentor:', `${cert.ownerName} | NIF: ${cert.ownerNif}`],
  ];

  for (const [label, val] of s1Rows) {
    p1.drawText(sanitizeWinAnsi(label), { x: 42, y, size: 9, font: fontBold, color: rgb(0.28, 0.33, 0.41) });
    p1.drawText(sanitizeWinAnsi(val), { x: 168, y, size: 9, font: fontReg, color: rgb(0.06, 0.09, 0.16) });
    y -= 14;
  }

  y -= 10;
  p1.drawText(sanitizeWinAnsi('2. AUDITORIA GEOMÉTRICA DE FAIXAS (DL n.º 82/2021 + DESPACHO n.º 675/2026)'), {
    x: 36,
    y,
    size: 10.5,
    font: fontBold,
    color: rgb(0.08, 0.33, 0.18),
  });
  y -= 18;

  // Table header
  p1.drawRectangle({ x: 36, y: y - 4, width: width - 72, height: 18, color: rgb(0.94, 0.96, 0.98) });
  p1.drawText(sanitizeWinAnsi('ZONA DE INTERVENÇÃO LEGALMENTE EXIGÍVEL'), { x: 44, y, size: 8.5, font: fontBold });
  p1.drawText(sanitizeWinAnsi('ÁREA (m²)'), { x: 365, y, size: 8.5, font: fontBold });
  p1.drawText(sanitizeWinAnsi('ESTADO'), { x: 455, y, size: 8.5, font: fontBold });
  y -= 18;

  const sp = cert.spatialSnapshot;
  const zoneRows = [
    ['Zona 1: Interface Imediata (0-2 m da alvenaria - Faixa Inerte)', sp.zone1ImmediateM2.toFixed(2), 'EXECUTADA', rgb(0.88, 0.11, 0.28)],
    ['Zona 2: Interface Próxima (2-10 m edifícios - Desbaste)', sp.zone2NearM2.toFixed(2), 'EXECUTADA', rgb(0.92, 0.35, 0.05)],
    ['Zona 3: Interface Alargada (10-50 m solo florestal/mato)', sp.zone3ExtendedM2.toFixed(2), 'EXECUTADA', rgb(0.85, 0.47, 0.02)],
    ['Servidão de Terceiros (Rede Aérea E-REDES / Vias)', sp.thirdPartyEasementM2.toFixed(2), 'EXCLUÍDA (*)', rgb(0.02, 0.52, 0.78)],
    ['Zona Interior Isenta de Obrigação Legal', sp.exemptAreaM2.toFixed(2), 'ISENTA', rgb(0.09, 0.64, 0.29)],
  ] as const;

  for (const [zName, zArea, zState, zColor] of zoneRows) {
    p1.drawRectangle({ x: 42, y: y + 1, width: 6, height: 6, color: zColor });
    p1.drawText(sanitizeWinAnsi(zName), { x: 54, y, size: 8.5, font: fontReg, color: rgb(0.1, 0.12, 0.18) });
    p1.drawText(sanitizeWinAnsi(zArea), { x: 365, y, size: 8.5, font: fontMono, color: rgb(0.1, 0.12, 0.18) });
    p1.drawText(sanitizeWinAnsi(zState), { x: 455, y, size: 8.5, font: fontBold, color: zColor });
    p1.drawLine({ start: { x: 36, y: y - 4 }, end: { x: width - 36, y: y - 4 }, thickness: 0.4, color: rgb(0.85, 0.88, 0.92) });
    y -= 16;
  }

  p1.drawText(
    sanitizeWinAnsi(
      `Área Total da Parcela: ${sp.totalAreaM2.toFixed(2)} m² | Total Limpeza Executada: ${cert.cleanedAreaM2.toFixed(2)} m² | (*) Art. 49.º DL 82/2021`
    ),
    { x: 36, y: y - 2, size: 8, font: fontReg, color: rgb(0.35, 0.4, 0.48) }
  );

  y -= 24;

  // Static Vector Cartography Diagram Box (EPSG:3763 Schematic)
  const mapBoxH = 175;
  p1.drawRectangle({
    x: 36,
    y: y - mapBoxH,
    width: width - 72,
    height: mapBoxH,
    color: rgb(0.11, 0.18, 0.13),
    borderColor: rgb(0.75, 0.8, 0.86),
    borderWidth: 1,
  });

  // Parcel dashed yellow frame
  const mx = 70;
  const my = y - mapBoxH + 28;
  const mw = width - 220;
  const mh = mapBoxH - 48;
  p1.drawRectangle({
    x: mx,
    y: my,
    width: mw,
    height: mh,
    color: rgb(0.16, 0.28, 0.2),
    borderColor: rgb(0.98, 0.8, 0.08),
    borderWidth: 2,
  });
  // Zone 3 Amber
  p1.drawCircle({ x: mx + mw * 0.4, y: my + mh * 0.48, size: 54, color: rgb(0.96, 0.62, 0.04), opacity: 0.35 });
  // Zone 2 Orange
  p1.drawCircle({ x: mx + mw * 0.4, y: my + mh * 0.48, size: 30, color: rgb(0.92, 0.35, 0.05), opacity: 0.5 });
  // Zone 1 Crimson
  p1.drawCircle({ x: mx + mw * 0.4, y: my + mh * 0.48, size: 17, color: rgb(0.88, 0.11, 0.28), opacity: 0.75 });
  // Building white footprint
  p1.drawRectangle({ x: mx + mw * 0.4 - 9, y: my + mh * 0.48 - 7, width: 18, height: 14, color: rgb(1, 1, 1) });
  // E-REDES Cyan corridor strip
  if (sp.thirdPartyEasementM2 > 0) {
    p1.drawRectangle({
      x: mx,
      y: my + mh - 18,
      width: mw,
      height: 18,
      color: rgb(0.02, 0.71, 0.83),
      opacity: 0.55,
    });
  }

  // Map Legend on the right of diagram
  const lx = mx + mw + 16;
  let ly = y - 24;
  p1.drawText(sanitizeWinAnsi('CARTOGRAFIA EPSG:3763'), { x: lx, y: ly, size: 8, font: fontBold, color: rgb(1, 1, 1) });
  ly -= 16;
  const legendItems = [
    ['Limite Prédio (BUPi)', rgb(0.98, 0.8, 0.08)],
    ['Z1 Inerte (0-2 m)', rgb(0.88, 0.11, 0.28)],
    ['Z2 Próxima (2-10 m)', rgb(0.92, 0.35, 0.05)],
    ['Z3 Alargada (10-50 m)', rgb(0.96, 0.62, 0.04)],
    ['Servidão E-REDES', rgb(0.02, 0.71, 0.83)],
  ] as const;
  for (const [lbl, col] of legendItems) {
    p1.drawRectangle({ x: lx, y: ly + 1, width: 8, height: 8, color: col });
    p1.drawText(sanitizeWinAnsi(lbl), { x: lx + 12, y: ly + 1, size: 7.5, font: fontReg, color: rgb(0.9, 0.94, 0.98) });
    ly -= 14;
  }
  p1.drawText(sanitizeWinAnsi('Escala: 0 ___ 25m ___ 50m | Norte N'), {
    x: mx,
    y: y - mapBoxH + 10,
    size: 7.5,
    font: fontMono,
    color: rgb(0.85, 0.9, 0.88),
  });

  y = y - mapBoxH - 22;

  // Section 3: Operational Conditions
  p1.drawText(sanitizeWinAnsi('3. CONDIÇÕES DE SEGURANÇA OPERACIONAL NA DATA DOS TRABALHOS'), {
    x: 36,
    y,
    size: 10.5,
    font: fontBold,
    color: rgb(0.08, 0.33, 0.18),
  });
  y -= 16;
  const pirMeta = PIR_SCALE[cert.pirLevelAtWork];
  const s3Rows = [
    ['Data/Hora de Registo:', new Date(cert.issuedAt).toLocaleString('pt-PT')],
    ['Índice PIR / IPMA (rcm):', `Nível ${cert.pirLevelAtWork} - ${pirMeta.designation.toUpperCase()} (Concelho DICO ${cert.dico})`],
    ['Conformidade Maquinaria:', 'Operação executada em conformidade com o Art.º 68.º do DL n.º 82/2021'],
    [
      'Entidade Executora:',
      cert.executionMode === 'CONTRACTOR'
        ? `Prestador Registado: ${cert.contractorName ?? 'Parceiro'} | NIF: ${cert.contractorNif ?? '-'} | Doc: ${cert.invoiceRef ?? '-'}`
        : 'Execução por Meios Próprios do Titular',
    ],
  ];
  for (const [lbl, val] of s3Rows) {
    p1.drawText(sanitizeWinAnsi(lbl), { x: 42, y, size: 9, font: fontBold, color: rgb(0.28, 0.33, 0.41) });
    p1.drawText(sanitizeWinAnsi(val), { x: 168, y, size: 9, font: fontReg, color: rgb(0.06, 0.09, 0.16) });
    y -= 14;
  }

  p1.drawText(sanitizeWinAnsi(`Página 1 de 2 | Certificado #${cert.shortCode}`), {
    x: 36,
    y: 26,
    size: 8,
    font: fontMono,
    color: rgb(0.45, 0.5, 0.58),
  });

  // ==================== PÁGINA 2 ====================
  const p2 = pdfDoc.addPage([595.28, 841.89]);
  p2.drawRectangle({ x: 0, y: height - 58, width, height: 58, color: rgb(0.06, 0.09, 0.16) });
  p2.drawText(sanitizeWinAnsi('EVIDÊNCIA FOTOGRÁFICA GEORREFERENCIADA E SELO CRIPTOGRÁFICO SHA-256'), {
    x: 36,
    y: height - 30,
    size: 11,
    font: fontBold,
    color: rgb(1, 1, 1),
  });
  p2.drawText(sanitizeWinAnsi(`Certificado #${cert.shortCode} | Página 2 de 2`), {
    x: 36,
    y: height - 45,
    size: 8.5,
    font: fontMono,
    color: rgb(0.75, 0.82, 0.9),
  });

  let y2 = height - 84;
  p2.drawText(sanitizeWinAnsi('4. REGISTO FOTOGRÁFICO COMPARATIVO COM TELEMETRIA EXIF / GPS VALIDADA'), {
    x: 36,
    y: y2,
    size: 10.5,
    font: fontBold,
    color: rgb(0.08, 0.33, 0.18),
  });
  y2 -= 18;

  for (const photo of cert.photos) {
    const cardH = 84;
    p2.drawRectangle({
      x: 36,
      y: y2 - cardH,
      width: width - 72,
      height: cardH,
      color: rgb(0.97, 0.98, 0.99),
      borderColor: rgb(0.8, 0.84, 0.9),
      borderWidth: 0.8,
    });
    const stageLabel = photo.stage === 'BEFORE' ? 'ANTES DA INTERVENÇÃO' : 'APÓS INTERVENÇÃO (VALIDADO)';
    p2.drawText(sanitizeWinAnsi(`[${stageLabel}] ${photo.zoneLabel}`), {
      x: 48,
      y: y2 - 18,
      size: 9.5,
      font: fontBold,
      color: photo.stage === 'AFTER' ? rgb(0.08, 0.33, 0.18) : rgb(0.55, 0.25, 0.04),
    });
    p2.drawText(
      sanitizeWinAnsi(
        `Timestamp: ${new Date(photo.takenAt).toLocaleString('pt-PT')} | GPS: ${photo.lat.toFixed(5)}° N, ${photo.lon.toFixed(5)}° W | Azimute: ${photo.azimuthDeg}° (${photo.azimuthCardinal})`
      ),
      { x: 48, y: y2 - 34, size: 8, font: fontMono, color: rgb(0.25, 0.3, 0.38) }
    );
    const noteLines = wrapTextLines(`Parecer Técnico: ${photo.aiNotes}`, 86);
    noteLines.slice(0, 2).forEach((ln, idx) => {
      p2.drawText(ln, { x: 48, y: y2 - 50 - idx * 12, size: 8.5, font: fontReg, color: rgb(0.12, 0.16, 0.22) });
    });
    y2 -= cardH + 12;
  }

  y2 -= 8;
  p2.drawText(sanitizeWinAnsi('5. LISTA DE VERIFICAÇÃO TÉCNICA (DESPACHO N.º 675/2026 & QUERCÍNEAS)'), {
    x: 36,
    y: y2,
    size: 10.5,
    font: fontBold,
    color: rgb(0.08, 0.33, 0.18),
  });
  y2 -= 18;

  const checks = [
    '[X] Faixa Inerte (0-2 m): Solo mineral / pavimento livre de ervas secas e manta morta.',
    '[X] Descontinuidade Horizontal: Estrato arbustivo cortado (< 20 cm de altura nos termos técnicos).',
    '[X] Descontinuidade Vertical: Desramação efetuada (50% da altura da árvore / mín. 4 m acima do solo).',
    '[X] Afastamento a Edifícios: Ausência de projeção de copas sobre telhados e afastamento > 5 metros.',
    `[X] Proteção Legal de Quercíneas: ${cert.protectedSpeciesCheck}`,
  ];
  for (const chk of checks) {
    const lines = wrapTextLines(chk, 92);
    for (const ln of lines) {
      p2.drawText(ln, { x: 42, y: y2, size: 8.8, font: fontReg, color: rgb(0.1, 0.14, 0.2) });
      y2 -= 14;
    }
  }

  // Seal Box with QR Code & SHA-256
  const sealY = 92;
  p2.drawRectangle({
    x: 36,
    y: sealY,
    width: width - 72,
    height: 112,
    color: rgb(0.94, 0.97, 1.0),
    borderColor: rgb(0.01, 0.52, 0.78),
    borderWidth: 1.2,
  });
  p2.drawImage(qrImage, { x: 48, y: sealY + 12, width: 88, height: 88 });

  p2.drawText(sanitizeWinAnsi('CERTIFICAÇÃO PÚBLICA IMUTÁVEL (AUTORIDADES GNR/SEPNA, CÂMARA E SEGURADORAS)'), {
    x: 148,
    y: sealY + 88,
    size: 8.8,
    font: fontBold,
    color: rgb(0.01, 0.4, 0.63),
  });
  p2.drawText(sanitizeWinAnsi(`URL de Verificação: ${verifyUrl}`), {
    x: 148,
    y: sealY + 70,
    size: 8,
    font: fontMono,
    color: rgb(0.06, 0.09, 0.16),
  });
  p2.drawText(sanitizeWinAnsi('Assinatura Canónica SHA-256:'), {
    x: 148,
    y: sealY + 52,
    size: 8,
    font: fontBold,
    color: rgb(0.25, 0.3, 0.38),
  });
  p2.drawText(sanitizeWinAnsi(cert.sha256Hash), {
    x: 148,
    y: sealY + 38,
    size: 7.5,
    font: fontMono,
    color: rgb(0.06, 0.09, 0.16),
  });
  p2.drawText(
    sanitizeWinAnsi(
      'Nota Jurídica: Prova documental privada de diligência preventiva georreferenciada. Não substitui vistoria oficial GTF/SEPNA.'
    ),
    { x: 148, y: sealY + 18, size: 7.2, font: fontReg, color: rgb(0.35, 0.4, 0.48) }
  );

  return pdfDoc.save();
}

/**
 * Template #2: Requerimento Formal "Vizinho Incumpridor" (PDF A4 — 2 Páginas)
 */
export async function generateNeighborComplaintPdf(
  record: NeighborComplaintRecord,
  publicBaseUrl: string
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const fontReg = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontMono = await pdfDoc.embedFont(StandardFonts.Courier);

  const gtfUrl = `${publicBaseUrl.replace(/\/$/, '')}/api/gtf/${encodeURIComponent(record.reqCode)}/geojson`;
  const qrDataUrl = await QRCode.toDataURL(gtfUrl, { margin: 1, width: 160 });
  const qrImage = await pdfDoc.embedPng(qrDataUrl);

  const p1 = pdfDoc.addPage([595.28, 841.89]);
  const { width, height } = p1.getSize();

  p1.drawRectangle({ x: 0, y: height - 76, width, height: 76, color: rgb(0.06, 0.09, 0.16) });
  p1.drawRectangle({ x: 0, y: height - 80, width, height: 4, color: rgb(0.66, 0.33, 0.97) }); // Violet alert accent

  p1.drawText(sanitizeWinAnsi('PARTICIPAÇÃO TÉCNICA FUNDAMENTADA | GESTÃO DE COMBUSTÍVEL EM PRÉDIO CONFINANTE'), {
    x: 36,
    y: height - 28,
    size: 8.8,
    font: fontBold,
    color: rgb(0.84, 0.7, 0.99),
  });
  p1.drawText(sanitizeWinAnsi('REQUERIMENTO DE FISCALIZAÇÃO E EXECUÇÃO COERCIVA'), {
    x: 36,
    y: height - 48,
    size: 14,
    font: fontBold,
    color: rgb(1, 1, 1),
  });
  p1.drawText(sanitizeWinAnsi(`Artigos 49.º, 57.º e 58.º do DL n.º 82/2021 | Ref: ${record.reqCode}`), {
    x: 36,
    y: height - 64,
    size: 8.5,
    font: fontMono,
    color: rgb(0.8, 0.85, 0.92),
  });

  let y = height - 104;
  p1.drawText(sanitizeWinAnsi(`Exmo.(a) Senhor(a) Presidente da Câmara Municipal de ${record.municipality}`), {
    x: 36,
    y,
    size: 10.5,
    font: fontBold,
    color: rgb(0.06, 0.09, 0.16),
  });
  y -= 14;
  p1.drawText(
    sanitizeWinAnsi(
      'C/ Conhecimento: Gabinete Técnico Florestal (GTF) / SMPC e Guarda Nacional Republicana (Núcleo SEPNA)'
    ),
    { x: 36, y, size: 8.5, font: fontReg, color: rgb(0.3, 0.35, 0.42) }
  );

  y -= 24;
  p1.drawText(sanitizeWinAnsi('1. IDENTIFICAÇÃO DO REQUERENTE (PROPRIETÁRIO / MORADOR EM RISCO)'), {
    x: 36,
    y,
    size: 10,
    font: fontBold,
    color: rgb(0.08, 0.33, 0.18),
  });
  y -= 15;

  const reqRows = [
    ['Nome Completo / NIF:', `${record.complainantName} | NIF: ${record.complainantNif}`],
    ['Morada do Edifício:', `${record.complainantAddress} (${record.parish}, ${record.municipality})`],
    ['Contactos p/ Notificação:', `Tel: ${record.complainantPhone} | Email: ${record.complainantEmail}`],
    ['Diligência Própria:', record.ownCertRef ? `Faixa própria executada e certificada (#${record.ownCertRef})` : 'Propriedade habitacional confinante mantida limpa'],
  ];
  for (const [lbl, val] of reqRows) {
    p1.drawText(sanitizeWinAnsi(lbl), { x: 42, y, size: 8.8, font: fontBold, color: rgb(0.28, 0.33, 0.41) });
    p1.drawText(sanitizeWinAnsi(val), { x: 168, y, size: 8.8, font: fontReg, color: rgb(0.06, 0.09, 0.16) });
    y -= 14;
  }

  y -= 12;
  p1.drawText(sanitizeWinAnsi('2. IDENTIFICAÇÃO GEORREFERENCIADA DO PRÉDIO EM INCUMPRIMENTO (VIZINHO)'), {
    x: 36,
    y,
    size: 10,
    font: fontBold,
    color: rgb(0.48, 0.18, 0.78),
  });
  y -= 15;

  const nbRows = [
    ['Freguesia / DICOFRE:', `${record.parish}, ${record.municipality} (DICOFRE: ${record.dicofre})`],
    ['Confrontação Relativa:', `Estrema ${record.confrontationSide} da habitação do Requerente`],
    [
      'Coordenadas WGS84:',
      `${record.neighborCentroidWgs84.lat.toFixed(6)}° N, ${record.neighborCentroidWgs84.lon.toFixed(6)}° W`,
    ],
    [
      'Coordenadas PT-TM06:',
      `X: ${record.neighborCentroidPtTm06.x.toFixed(1)} m, Y: ${record.neighborCentroidPtTm06.y.toFixed(1)} m (EPSG:3763 Oficial)`,
    ],
    [
      'Cota Mínima à Fachada:',
      `VEGETAÇÃO CONTÍNUA A ${record.minDistanceFacadeM.toFixed(2)} METROS DA PAREDE EXTERIOR`,
    ],
    [
      'Biomassa / Espécies:',
      `${record.dominantSpecies} (Altura est.: ${record.shrubHeightM.toFixed(2)} m | Satélite Sentinel-2 NDVI: ${record.neighborNdvi.toFixed(2)})`,
    ],
  ];
  for (const [lbl, val] of nbRows) {
    p1.drawText(sanitizeWinAnsi(lbl), { x: 42, y, size: 8.8, font: fontBold, color: rgb(0.28, 0.33, 0.41) });
    p1.drawText(sanitizeWinAnsi(val), { x: 168, y, size: 8.8, font: fontReg, color: rgb(0.06, 0.09, 0.16) });
    y -= 14;
  }

  y -= 14;
  // Vector distance diagram
  const diagH = 115;
  p1.drawRectangle({
    x: 36,
    y: y - diagH,
    width: width - 72,
    height: diagH,
    color: rgb(0.11, 0.14, 0.2),
    borderColor: rgb(0.66, 0.33, 0.97),
    borderWidth: 1,
  });
  // Purple neighbor polygon on left
  p1.drawRectangle({
    x: 64,
    y: y - diagH + 22,
    width: 165,
    height: diagH - 44,
    color: rgb(0.66, 0.33, 0.97),
    opacity: 0.45,
    borderColor: rgb(0.84, 0.7, 0.99),
    borderWidth: 1.5,
  });
  p1.drawText(sanitizeWinAnsi('PRÉDIO CONFINANTE EM INFRAÇÃO'), {
    x: 74,
    y: y - 46,
    size: 7.5,
    font: fontBold,
    color: rgb(1, 1, 1),
  });
  p1.drawText(sanitizeWinAnsi(`NDVI Satélite: ${record.neighborNdvi.toFixed(2)} (Carga Alta)`), {
    x: 74,
    y: y - 60,
    size: 7.5,
    font: fontMono,
    color: rgb(0.92, 0.85, 1),
  });

  // White building on right + red distance line
  p1.drawRectangle({ x: 315, y: y - diagH + 34, width: 70, height: 46, color: rgb(1, 1, 1) });
  p1.drawText(sanitizeWinAnsi('HABITAÇÃO'), { x: 325, y: y - diagH + 54, size: 7.5, font: fontBold, color: rgb(0.06, 0.09, 0.16) });
  p1.drawLine({
    start: { x: 229, y: y - diagH + 57 },
    end: { x: 315, y: y - diagH + 57 },
    thickness: 2,
    color: rgb(0.95, 0.25, 0.35),
  });
  p1.drawText(sanitizeWinAnsi(`${record.minDistanceFacadeM.toFixed(2)} m`), {
    x: 254,
    y: y - diagH + 64,
    size: 9,
    font: fontBold,
    color: rgb(0.98, 0.8, 0.08),
  });
  p1.drawText(sanitizeWinAnsi('Faixa obrigatória 50 m (DL 82/2021)'), {
    x: 400,
    y: y - diagH + 54,
    size: 8,
    font: fontReg,
    color: rgb(0.85, 0.9, 0.96),
  });

  y = y - diagH - 22;
  p1.drawText(sanitizeWinAnsi('3. FUNDAMENTAÇÃO FACTUAL E ENQUADRAMENTO JURÍDICO'), {
    x: 36,
    y,
    size: 10,
    font: fontBold,
    color: rgb(0.08, 0.33, 0.18),
  });
  y -= 16;

  const bodyLines = wrapTextLines(record.formalPetitionText, 92);
  const p1Body = bodyLines.slice(0, 12);
  const p2Body = bodyLines.slice(12);

  for (const ln of p1Body) {
    p1.drawText(ln, { x: 36, y, size: 8.8, font: fontReg, color: rgb(0.1, 0.14, 0.2) });
    y -= 13;
  }

  p1.drawText(sanitizeWinAnsi(`Página 1 de 2 | Dossiê GTF #${record.reqCode}`), {
    x: 36,
    y: 26,
    size: 8,
    font: fontMono,
    color: rgb(0.45, 0.5, 0.58),
  });

  // ==================== PÁGINA 2 ====================
  const p2 = pdfDoc.addPage([595.28, 841.89]);
  p2.drawRectangle({ x: 0, y: height - 54, width, height: 54, color: rgb(0.06, 0.09, 0.16) });
  p2.drawText(sanitizeWinAnsi(`CONTINUAÇÃO DO REQUERIMENTO E DOSSIÊ SIG MUNICIPAL | #${record.reqCode}`), {
    x: 36,
    y: height - 32,
    size: 10.5,
    font: fontBold,
    color: rgb(1, 1, 1),
  });

  let y2 = height - 80;
  for (const ln of p2Body) {
    p2.drawText(ln, { x: 36, y: y2, size: 9, font: fontReg, color: rgb(0.1, 0.14, 0.2) });
    y2 -= 13.5;
  }

  y2 -= 14;
  p2.drawText(sanitizeWinAnsi('4. PEDIDO DE INTERVENÇÃO URGENTE (EXECUÇÃO COERCIVA)'), {
    x: 36,
    y: y2,
    size: 10,
    font: fontBold,
    color: rgb(0.08, 0.33, 0.18),
  });
  y2 -= 16;

  const pedidos = [
    'a) A realização de vistoria técnica prioritária pelo Gabinete Técnico Florestal (GTF) ou patrulha GNR/SEPNA;',
    'b) A notificação imediata do(s) proprietário(s) (via acesso autárquico à matriz AT/BUPi ou edital de 5 dias);',
    'c) Mantendo-se o incumprimento, a EXECUÇÃO COERCIVA imediata dos trabalhos pela Câmara Municipal, a expensas do infrator (Art.º 58.º DL 82/2021);',
    'd) A comunicação ao Requerente, por via eletrónica, do número de registo do processo administrativo.',
  ];
  for (const item of pedidos) {
    for (const ln of wrapTextLines(item, 92)) {
      p2.drawText(ln, { x: 42, y: y2, size: 8.8, font: fontReg, color: rgb(0.1, 0.14, 0.2) });
      y2 -= 13.5;
    }
    y2 -= 3;
  }

  y2 -= 24;
  p2.drawText(
    sanitizeWinAnsi(`Pede deferimento,   ${record.municipality}, ${new Date(record.issuedAt).toLocaleDateString('pt-PT')}`),
    { x: 36, y: y2, size: 9.5, font: fontBold, color: rgb(0.06, 0.09, 0.16) }
  );
  y2 -= 32;
  p2.drawText(sanitizeWinAnsi('Assinatura do Requerente: _______________________________________________________'), {
    x: 36,
    y: y2,
    size: 9,
    font: fontReg,
    color: rgb(0.2, 0.25, 0.32),
  });

  // Municipal GTF GeoJSON QR Footer
  const boxY = 86;
  p2.drawRectangle({
    x: 36,
    y: boxY,
    width: width - 72,
    height: 106,
    color: rgb(0.96, 0.94, 1.0),
    borderColor: rgb(0.66, 0.33, 0.97),
    borderWidth: 1.2,
  });
  p2.drawImage(qrImage, { x: 48, y: boxY + 9, width: 88, height: 88 });
  p2.drawText(sanitizeWinAnsi('DOSSIÊ GEOGRÁFICO DIGITAL P/ GABINETE TÉCNICO FLORESTAL (SIG / QGIS / ARCGIS)'), {
    x: 148,
    y: boxY + 82,
    size: 8.5,
    font: fontBold,
    color: rgb(0.42, 0.13, 0.66),
  });
  p2.drawText(sanitizeWinAnsi('O técnico municipal pode descarregar diretamente o polígono GeoJSON / KML em:'), {
    x: 148,
    y: boxY + 64,
    size: 8.2,
    font: fontReg,
    color: rgb(0.15, 0.18, 0.25),
  });
  p2.drawText(sanitizeWinAnsi(gtfUrl), {
    x: 148,
    y: boxY + 46,
    size: 7.5,
    font: fontMono,
    color: rgb(0.06, 0.09, 0.16),
  });
  p2.drawText(sanitizeWinAnsi('Sistema de Coordenadas: CRS84 (WGS84) + Atributos Métricos PT-TM06 (EPSG:3763).'), {
    x: 148,
    y: boxY + 24,
    size: 7.5,
    font: fontReg,
    color: rgb(0.35, 0.4, 0.48),
  });

  return pdfDoc.save();
}
