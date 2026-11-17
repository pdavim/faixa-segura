import jsQR from 'jsqr';
import type { ComplianceCertificate } from '../types/domain.ts';

export type QrPayloadSourceKind =
  | 'VERIFY_QUERY'
  | 'VERIFY_PATH'
  | 'JSON_PAYLOAD'
  | 'SHORT_CODE'
  | 'SHA256_HASH'
  | 'RAW_CODE'
  | 'UNRELATED_URL'
  | 'EMPTY';

export interface ParsedQrVerificationPayload {
  candidateCode: string | null;
  sourceKind: QrPayloadSourceKind;
  rawTrimmed: string;
}

const SHORT_CODE_REGEX = /^#?(FS-[A-Z0-9-]{4,40})$/i;
const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/i;
const SAFE_RAW_CODE_REGEX = /^#?([A-Z0-9][A-Z0-9_-]{3,63})$/i;

function extractFromUrlLike(input: string): ParsedQrVerificationPayload | null {
  const looksLikeUrl =
    /^https?:\/\//i.test(input) ||
    input.startsWith('/?') ||
    input.startsWith('?verify=') ||
    input.startsWith('#verify=') ||
    input.includes('?verify=') ||
    input.includes('&verify=') ||
    /\/verify\/[A-Za-z0-9_-]+/i.test(input);

  if (!looksLikeUrl) {
    return null;
  }

  try {
    const normalized = input.startsWith('#')
      ? `https://faixasegura.local/?${input.slice(1)}`
      : input.startsWith('?')
      ? `https://faixasegura.local/${input}`
      : input.startsWith('/')
      ? `https://faixasegura.local${input}`
      : input;

    const url = new URL(normalized);
    const queryVerify =
      url.searchParams.get('verify') ??
      url.searchParams.get('code') ??
      url.searchParams.get('cert');

    if (queryVerify && queryVerify.trim()) {
      return {
        candidateCode: queryVerify.trim().replace(/^#/, ''),
        sourceKind: 'VERIFY_QUERY',
        rawTrimmed: input,
      };
    }

    if (url.hash) {
      const hashQuery = url.hash.replace(/^#\/?\??/, '');
      const hashParams = new URLSearchParams(hashQuery);
      const hashVerify = hashParams.get('verify') ?? hashParams.get('code');
      if (hashVerify && hashVerify.trim()) {
        return {
          candidateCode: hashVerify.trim().replace(/^#/, ''),
          sourceKind: 'VERIFY_QUERY',
          rawTrimmed: input,
        };
      }
    }

    const pathMatch = url.pathname.match(/\/verify\/([^/?#]+)/i);
    if (pathMatch?.[1]) {
      const decoded = decodeURIComponent(pathMatch[1]).trim().replace(/^#/, '');
      if (decoded) {
        return {
          candidateCode: decoded,
          sourceKind: 'VERIFY_PATH',
          rawTrimmed: input,
        };
      }
    }

    return {
      candidateCode: null,
      sourceKind: 'UNRELATED_URL',
      rawTrimmed: input,
    };
  } catch {
    return {
      candidateCode: null,
      sourceKind: 'UNRELATED_URL',
      rawTrimmed: input,
    };
  }
}

/**
 * Extracts a certificate shortCode or SHA-256 hash from a QR code payload or manual input.
 * Supports full verification URLs (`https://.../?verify=FS-20260524-7D9E`), `/verify/<code>` paths,
 * JSON payloads, bare `FS-...` short codes, and 64-character SHA-256 hashes.
 */
export function parseCertificateVerifyPayload(rawInput: string): ParsedQrVerificationPayload {
  const rawTrimmed = rawInput.trim();
  if (!rawTrimmed) {
    return {
      candidateCode: null,
      sourceKind: 'EMPTY',
      rawTrimmed: '',
    };
  }

  if (rawTrimmed.startsWith('{') && rawTrimmed.endsWith('}')) {
    try {
      const parsedJson = JSON.parse(rawTrimmed) as Record<string, unknown>;
      const rawCandidate =
        parsedJson.shortCode ??
        parsedJson.verify ??
        parsedJson.code ??
        parsedJson.sha256Hash;
      if (typeof rawCandidate === 'string' && rawCandidate.trim()) {
        return {
          candidateCode: rawCandidate.trim().replace(/^#/, ''),
          sourceKind: 'JSON_PAYLOAD',
          rawTrimmed,
        };
      }
    } catch {
      // Fall through to standard token matching
    }
  }

  const urlExtracted = extractFromUrlLike(rawTrimmed);
  if (urlExtracted) {
    return urlExtracted;
  }

  if (SHA256_HEX_REGEX.test(rawTrimmed)) {
    return {
      candidateCode: rawTrimmed.toLowerCase(),
      sourceKind: 'SHA256_HASH',
      rawTrimmed,
    };
  }

  const shortMatch = rawTrimmed.match(SHORT_CODE_REGEX);
  if (shortMatch?.[1]) {
    return {
      candidateCode: shortMatch[1].toUpperCase(),
      sourceKind: 'SHORT_CODE',
      rawTrimmed,
    };
  }

  const rawCodeMatch = rawTrimmed.match(SAFE_RAW_CODE_REGEX);
  if (rawCodeMatch?.[1]) {
    return {
      candidateCode: rawCodeMatch[1].toUpperCase(),
      sourceKind: 'RAW_CODE',
      rawTrimmed,
    };
  }

  return {
    candidateCode: null,
    sourceKind: 'EMPTY',
    rawTrimmed,
  };
}

/**
 * Decodes a QR code string from an RGBA pixel buffer (from `<canvas>` `getImageData`).
 */
export function decodeQrRgbaFrame(
  rgbaData: Uint8ClampedArray,
  width: number,
  height: number
): string | null {
  if (width <= 0 || height <= 0 || rgbaData.length < width * height * 4) {
    return null;
  }
  const decoded = jsQR(rgbaData, width, height, {
    inversionAttempts: 'attemptBoth',
  });
  const text = decoded?.data?.trim();
  return text ? text : null;
}

/**
 * Matches a scanned QR payload or manual code against an array of ComplianceCertificates.
 */
export function findCertificateByScannedPayload(
  certificates: ComplianceCertificate[],
  rawPayload: string
): {
  certificate: ComplianceCertificate | null;
  parsed: ParsedQrVerificationPayload;
} {
  const parsed = parseCertificateVerifyPayload(rawPayload);
  if (!parsed.candidateCode) {
    return { certificate: null, parsed };
  }

  const needle = parsed.candidateCode.toUpperCase();
  const matched =
    certificates.find(
      (cert) =>
        cert.shortCode.toUpperCase() === needle ||
        cert.sha256Hash.toUpperCase() === needle ||
        cert.id.toUpperCase() === needle
    ) ?? null;

  return {
    certificate: matched,
    parsed,
  };
}

/**
 * Resolves a certificate locally first and falls back to `/api/verify/:code` when available.
 */
export async function resolveCertificateFromPayload(params: {
  certificates: ComplianceCertificate[];
  rawPayload: string;
  fetchRemoteByCode?: (candidateCode: string) => Promise<ComplianceCertificate | null>;
}): Promise<{
  certificate: ComplianceCertificate | null;
  parsed: ParsedQrVerificationPayload;
  errorPt: string | null;
}> {
  const local = findCertificateByScannedPayload(params.certificates, params.rawPayload);
  if (local.certificate) {
    return {
      certificate: local.certificate,
      parsed: local.parsed,
      errorPt: null,
    };
  }

  if (local.parsed.sourceKind === 'UNRELATED_URL') {
    return {
      certificate: null,
      parsed: local.parsed,
      errorPt:
        'O código QR lido pertence a um endereço externo e não contém uma referência de Certificado FaixaSegura.',
    };
  }

  if (!local.parsed.candidateCode) {
    return {
      certificate: null,
      parsed: local.parsed,
      errorPt:
        'Introduza ou leia um código de certificado válido (ex.: FS-20260524-7D9E) ou o código QR impresso no Auto PDF.',
    };
  }

  if (params.fetchRemoteByCode) {
    try {
      const remoteCert = await params.fetchRemoteByCode(local.parsed.candidateCode);
      if (remoteCert) {
        return {
          certificate: remoteCert,
          parsed: local.parsed,
          errorPt: null,
        };
      }
    } catch {
      // Ignore network errors and report not found in local/remote registry
    }
  }

  return {
    certificate: null,
    parsed: local.parsed,
    errorPt: `O código "${local.parsed.candidateCode}" não corresponde a nenhum Auto de Conformidade SHA-256 registado.`,
  };
}

/**
 * Maps browser MediaDevices / getUserMedia errors to actionable European Portuguese guidance.
 */
export function describeCameraAccessErrorPt(
  err: unknown,
  hasMediaDevicesApi: boolean
): string {
  if (!hasMediaDevicesApi) {
    return 'Este navegador ou contexto não disponibiliza acesso direto à câmara. Carregue uma fotografia do código QR ou introduza o código do certificado abaixo.';
  }

  const name =
    err && typeof err === 'object' && 'name' in err && typeof err.name === 'string'
      ? err.name
      : '';

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return 'O acesso à câmara foi recusado. Autorize a permissão de câmara no navegador ou valide carregando uma fotografia do código QR.';
  }

  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return 'Não foi detetada nenhuma câmara disponível neste dispositivo. Utilize o botão de carregar imagem QR ou indique o código alfanumérico abaixo.';
  }

  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'A câmara está a ser utilizada por outra aplicação. Feche outras janelas de vídeo ou carregue uma fotografia do código QR.';
  }

  return 'Não foi possível iniciar o vídeo da câmara neste momento. Pode ler uma fotografia do código QR ou introduzir o número do certificado manualmente.';
}

export type QrScanSource = 'CAMERA' | 'IMAGE' | 'MANUAL_CODE';

export interface QrScannedCertificateEntry {
  certificate: ComplianceCertificate;
  scannedAtIso: string;
  source: QrScanSource;
}

export interface QrHistoryStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const LS_KEY_QR_SCAN_HISTORY = 'fs_qr_scan_history_v1';
export const MAX_QR_SCAN_HISTORY_ITEMS = 5;

function resolveDefaultQrStorage(storage?: QrHistoryStorageLike): QrHistoryStorageLike | null {
  if (storage) return storage;
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  return null;
}

function isValidScannedCertificateEntry(candidate: unknown): candidate is QrScannedCertificateEntry {
  if (!candidate || typeof candidate !== 'object') return false;
  const rec = candidate as Record<string, unknown>;
  if (typeof rec.scannedAtIso !== 'string' || !rec.scannedAtIso.trim()) return false;
  if (
    rec.source !== 'CAMERA' &&
    rec.source !== 'IMAGE' &&
    rec.source !== 'MANUAL_CODE'
  ) {
    return false;
  }
  const cert = rec.certificate as Record<string, unknown> | undefined;
  if (!cert || typeof cert !== 'object') return false;
  return (
    typeof cert.id === 'string' &&
    typeof cert.shortCode === 'string' &&
    cert.shortCode.trim().length > 0 &&
    typeof cert.sha256Hash === 'string' &&
    cert.sha256Hash.trim().length > 0 &&
    typeof cert.parcelLabel === 'string' &&
    typeof cert.municipality === 'string'
  );
}

/**
 * Pure reducer that records a newly validated ComplianceCertificate at the top of the scan history,
 * deduplicating previous scans of the same certificate and capping at MAX_QR_SCAN_HISTORY_ITEMS (5).
 */
export function recordScannedCertificateInHistory(
  existing: QrScannedCertificateEntry[],
  certificate: ComplianceCertificate,
  options?: {
    scannedAtIso?: string;
    source?: QrScanSource;
    maxItems?: number;
  }
): QrScannedCertificateEntry[] {
  const maxItems = Math.max(1, options?.maxItems ?? MAX_QR_SCAN_HISTORY_ITEMS);
  const scannedAtIso = options?.scannedAtIso ?? new Date().toISOString();
  const source: QrScanSource = options?.source ?? 'CAMERA';
  const targetShortCode = certificate.shortCode.trim().toUpperCase();

  const deduplicated = existing.filter((item) => {
    const itemShortCode = item.certificate.shortCode.trim().toUpperCase();
    return itemShortCode !== targetShortCode && item.certificate.id !== certificate.id;
  });

  return [
    {
      certificate,
      scannedAtIso,
      source,
    },
    ...deduplicated,
  ].slice(0, maxItems);
}

export function loadQrScanHistory(storage?: QrHistoryStorageLike): QrScannedCertificateEntry[] {
  const store = resolveDefaultQrStorage(storage);
  if (!store) return [];

  try {
    const raw = store.getItem(LS_KEY_QR_SCAN_HISTORY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isValidScannedCertificateEntry)
      .slice(0, MAX_QR_SCAN_HISTORY_ITEMS);
  } catch {
    return [];
  }
}

export function saveQrScanHistory(
  entries: QrScannedCertificateEntry[],
  storage?: QrHistoryStorageLike
): QrScannedCertificateEntry[] {
  const bounded = entries.slice(0, MAX_QR_SCAN_HISTORY_ITEMS);
  const store = resolveDefaultQrStorage(storage);
  if (store) {
    try {
      store.setItem(LS_KEY_QR_SCAN_HISTORY, JSON.stringify(bounded));
    } catch {
      // Ignore quota/sandbox storage write errors
    }
  }
  return bounded;
}

export function appendQrScanHistory(
  certificate: ComplianceCertificate,
  options?: {
    scannedAtIso?: string;
    source?: QrScanSource;
    storage?: QrHistoryStorageLike;
  }
): QrScannedCertificateEntry[] {
  const current = loadQrScanHistory(options?.storage);
  const updated = recordScannedCertificateInHistory(current, certificate, {
    scannedAtIso: options?.scannedAtIso,
    source: options?.source,
    maxItems: MAX_QR_SCAN_HISTORY_ITEMS,
  });
  return saveQrScanHistory(updated, options?.storage);
}

export function removeScannedCertificateFromHistory(
  existing: QrScannedCertificateEntry[],
  shortCodeOrId: string
): QrScannedCertificateEntry[] {
  const needle = shortCodeOrId.trim().toUpperCase();
  if (!needle) return existing.slice(0, MAX_QR_SCAN_HISTORY_ITEMS);
  return existing
    .filter((entry) => {
      const code = entry.certificate.shortCode.trim().toUpperCase();
      const id = entry.certificate.id.trim().toUpperCase();
      return code !== needle && id !== needle;
    })
    .slice(0, MAX_QR_SCAN_HISTORY_ITEMS);
}

export function removeQrScanHistoryItem(
  shortCodeOrId: string,
  storage?: QrHistoryStorageLike
): QrScannedCertificateEntry[] {
  const current = loadQrScanHistory(storage);
  const next = removeScannedCertificateFromHistory(current, shortCodeOrId);
  return saveQrScanHistory(next, storage);
}

export function clearQrScanHistory(storage?: QrHistoryStorageLike): void {
  const store = resolveDefaultQrStorage(storage);
  if (!store) return;
  try {
    store.removeItem(LS_KEY_QR_SCAN_HISTORY);
  } catch {
    // Ignore storage removal errors
  }
}

export const CANONICAL_SHORT_CODE_TEMPLATE = 'FS-YYYYMMDD-XXXX';
export const CANONICAL_SHORT_CODE_LENGTH = 16;
export const CANONICAL_SHA256_LENGTH = 64;
export const PUBLIC_VERIFY_SUCCESS_BORDER_HEX = '#15803D';

export type PublicVerifyCodeStatus = 'IDLE' | 'INCOMPLETE' | 'VALID' | 'INVALID';
export type PublicVerifyCodeInputMode = 'SHORT_CODE' | 'SHA256_HASH' | 'URL_PAYLOAD';
export type PublicVerifyInputBorderState =
  | 'DEFAULT'
  | 'TYPING_EARLY'
  | 'TYPING_NEAR'
  | 'VALID_GREEN'
  | 'INVALID_RED';

export interface PublicVerifyCodeLiveFeedback {
  status: PublicVerifyCodeStatus;
  mode: PublicVerifyCodeInputMode;
  borderState: PublicVerifyInputBorderState;
  isShortCodeFormatSatisfied: boolean;
  isValidToSubmit: boolean;
  normalizedCode: string;
  currentLength: number;
  targetLength: number;
  typedPreview: string;
  remainingMask: string;
  lengthBadgeText: string;
  helperMessagePt: string;
  submitErrorPt: string | null;
}

const STRICT_SHORT_CODE_FULL_REGEX =
  /^FS-(\d{4})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])-([A-Z0-9]{4})$/;

/**
 * Evaluates manual input in `#public-verify-code-input` on every keystroke, providing
 * immediate character length feedback (`N/16 carateres` or `N/64 hex`), a live slot-aligned
 * format preview (`FS-YYYYMMDD-XXXX`), progressive border-color transition states culminating
 * in success green (`#15803D`) once `FS-YYYYMMDD-XXXX` is satisfied, and early error detection.
 */
export function evaluatePublicVerifyCodeInput(rawInput: string): PublicVerifyCodeLiveFeedback {
  const trimmed = rawInput.trim();

  if (!trimmed) {
    return {
      status: 'IDLE',
      mode: 'SHORT_CODE',
      borderState: 'DEFAULT',
      isShortCodeFormatSatisfied: false,
      isValidToSubmit: false,
      normalizedCode: '',
      currentLength: 0,
      targetLength: CANONICAL_SHORT_CODE_LENGTH,
      typedPreview: '',
      remainingMask: CANONICAL_SHORT_CODE_TEMPLATE,
      lengthBadgeText: `0/${CANONICAL_SHORT_CODE_LENGTH} carateres`,
      helperMessagePt:
        'Formato esperado: FS-YYYYMMDD-XXXX (16 carateres) ou hash SHA-256 (64 hex).',
      submitErrorPt:
        'Introduza um código de certificado no formato FS-YYYYMMDD-XXXX (16 carateres) antes de verificar.',
    };
  }

  // 1. Check URL-like verification payloads (?verify=FS-...)
  const urlExtracted = extractFromUrlLike(trimmed);
  if (urlExtracted) {
    if (urlExtracted.candidateCode) {
      const codeUpper = urlExtracted.candidateCode.toUpperCase();
      const satisfiesCanonicalShort = STRICT_SHORT_CODE_FULL_REGEX.test(codeUpper);
      return {
        status: 'VALID',
        mode: 'URL_PAYLOAD',
        borderState: satisfiesCanonicalShort ? 'VALID_GREEN' : 'TYPING_NEAR',
        isShortCodeFormatSatisfied: satisfiesCanonicalShort,
        isValidToSubmit: true,
        normalizedCode: codeUpper,
        currentLength: codeUpper.length,
        targetLength: codeUpper.length,
        typedPreview: codeUpper,
        remainingMask: '',
        lengthBadgeText: `URL · ${codeUpper.length} carateres`,
        helperMessagePt: `Código extraído do endereço (${codeUpper}) — pronto a verificar.`,
        submitErrorPt: null,
      };
    }

    return {
      status: 'INVALID',
      mode: 'URL_PAYLOAD',
      borderState: 'INVALID_RED',
      isShortCodeFormatSatisfied: false,
      isValidToSubmit: false,
      normalizedCode: trimmed,
      currentLength: trimmed.length,
      targetLength: CANONICAL_SHORT_CODE_LENGTH,
      typedPreview: '',
      remainingMask: CANONICAL_SHORT_CODE_TEMPLATE,
      lengthBadgeText: 'URL incompleto',
      helperMessagePt:
        'O endereço colado não contém um parâmetro ?verify=FS-YYYYMMDD-XXXX válido.',
      submitErrorPt:
        'Indique um endereço de verificação válido ou o código FS-YYYYMMDD-XXXX (16 carateres).',
    };
  }

  const withoutHash = trimmed.replace(/^#/, '');
  const upper = withoutHash.toUpperCase();

  // 2. Detect hexadecimal SHA-256 input (does not start with 'FS' and contains only [0-9A-F])
  const looksLikeHexHash = !upper.startsWith('FS') && /^[0-9A-F]+$/.test(upper);
  if (looksLikeHexHash && upper.length <= CANONICAL_SHA256_LENGTH) {
    if (upper.length === CANONICAL_SHA256_LENGTH) {
      return {
        status: 'VALID',
        mode: 'SHA256_HASH',
        borderState: 'TYPING_NEAR',
        isShortCodeFormatSatisfied: false,
        isValidToSubmit: true,
        normalizedCode: upper.toLowerCase(),
        currentLength: upper.length,
        targetLength: CANONICAL_SHA256_LENGTH,
        typedPreview: `${upper.slice(0, 12)}…${upper.slice(-8)}`,
        remainingMask: '',
        lengthBadgeText: `${upper.length}/${CANONICAL_SHA256_LENGTH} hex`,
        helperMessagePt: 'Assinatura SHA-256 completa (64/64 carateres) — pronta a verificar.',
        submitErrorPt: null,
      };
    }

    const remainingHex = CANONICAL_SHA256_LENGTH - upper.length;
    return {
      status: 'INCOMPLETE',
      mode: 'SHA256_HASH',
      borderState: upper.length >= 32 ? 'TYPING_NEAR' : 'TYPING_EARLY',
      isShortCodeFormatSatisfied: false,
      isValidToSubmit: false,
      normalizedCode: upper.toLowerCase(),
      currentLength: upper.length,
      targetLength: CANONICAL_SHA256_LENGTH,
      typedPreview: upper.slice(0, 16),
      remainingMask: `… (+${remainingHex} hex)`,
      lengthBadgeText: `${upper.length}/${CANONICAL_SHA256_LENGTH} hex`,
      helperMessagePt: `A introduzir hash SHA-256 (faltam ${remainingHex} carateres) — ou use o código curto FS-YYYYMMDD-XXXX.`,
      submitErrorPt: `O hash SHA-256 está incompleto (${upper.length}/64 carateres). Complete os 64 carateres ou use FS-YYYYMMDD-XXXX.`,
    };
  }

  // 3. Evaluate against canonical short code template: FS-YYYYMMDD-XXXX (16 chars)
  const len = upper.length;
  const clampedTypedPreview = upper.slice(0, CANONICAL_SHORT_CODE_LENGTH);
  const remainingMask =
    len < CANONICAL_SHORT_CODE_LENGTH ? CANONICAL_SHORT_CODE_TEMPLATE.slice(len) : '';
  const lengthBadgeText = `${len}/${CANONICAL_SHORT_CODE_LENGTH} carateres`;

  if (!/^[A-Z0-9-]+$/.test(upper)) {
    return {
      status: 'INVALID',
      mode: 'SHORT_CODE',
      borderState: 'INVALID_RED',
      isShortCodeFormatSatisfied: false,
      isValidToSubmit: false,
      normalizedCode: upper,
      currentLength: len,
      targetLength: CANONICAL_SHORT_CODE_LENGTH,
      typedPreview: clampedTypedPreview,
      remainingMask,
      lengthBadgeText,
      helperMessagePt:
        'Carateres inválidos: utilize apenas letras, algarismos e hífenes no formato FS-YYYYMMDD-XXXX.',
      submitErrorPt:
        'Remova espaços ou símbolos inválidos. Formato esperado: FS-YYYYMMDD-XXXX (16 carateres).',
    };
  }

  // Validate prefix 'FS-' progressively (indices 0, 1, 2)
  const expectedPrefix = 'FS-';
  const prefixCheckLen = Math.min(len, 3);
  if (upper.slice(0, prefixCheckLen) !== expectedPrefix.slice(0, prefixCheckLen)) {
    const missingFirstHyphen = upper.startsWith('FS') && len >= 3 && upper[2] !== '-';
    const msg = missingFirstHyphen
      ? 'Falta o hífen após "FS" — utilize o formato FS-YYYYMMDD-XXXX.'
      : 'O código do Auto deve começar por "FS-" (ex.: FS-20260524-7D9E).';
    return {
      status: 'INVALID',
      mode: 'SHORT_CODE',
      borderState: 'INVALID_RED',
      isShortCodeFormatSatisfied: false,
      isValidToSubmit: false,
      normalizedCode: upper,
      currentLength: len,
      targetLength: CANONICAL_SHORT_CODE_LENGTH,
      typedPreview: clampedTypedPreview,
      remainingMask,
      lengthBadgeText,
      helperMessagePt: msg,
      submitErrorPt: msg,
    };
  }

  // Validate date digits YYYYMMDD progressively (indices 3..10)
  if (len > 3) {
    const dateSlice = upper.slice(3, Math.min(len, 11));
    if (!/^\d+$/.test(dateSlice)) {
      const msg =
        'As posições de data (YYYYMMDD) após "FS-" devem conter apenas 8 algarismos (ex.: FS-20260524-XXXX).';
      return {
        status: 'INVALID',
        mode: 'SHORT_CODE',
        borderState: 'INVALID_RED',
        isShortCodeFormatSatisfied: false,
        isValidToSubmit: false,
        normalizedCode: upper,
        currentLength: len,
        targetLength: CANONICAL_SHORT_CODE_LENGTH,
        typedPreview: clampedTypedPreview,
        remainingMask,
        lengthBadgeText,
        helperMessagePt: msg,
        submitErrorPt: msg,
      };
    }

    if (dateSlice.length >= 6) {
      const monthNum = Number(dateSlice.slice(4, 6));
      if (monthNum < 1 || monthNum > 12) {
        const msg = `Mês inválido ("${dateSlice.slice(4, 6)}") na data YYYYMMDD — indique um mês entre 01 e 12.`;
        return {
          status: 'INVALID',
          mode: 'SHORT_CODE',
          borderState: 'INVALID_RED',
          isShortCodeFormatSatisfied: false,
          isValidToSubmit: false,
          normalizedCode: upper,
          currentLength: len,
          targetLength: CANONICAL_SHORT_CODE_LENGTH,
          typedPreview: clampedTypedPreview,
          remainingMask,
          lengthBadgeText,
          helperMessagePt: msg,
          submitErrorPt: msg,
        };
      }
    }

    if (dateSlice.length === 8) {
      const dayNum = Number(dateSlice.slice(6, 8));
      if (dayNum < 1 || dayNum > 31) {
        const msg = `Dia inválido ("${dateSlice.slice(6, 8)}") na data YYYYMMDD — indique um dia entre 01 e 31.`;
        return {
          status: 'INVALID',
          mode: 'SHORT_CODE',
          borderState: 'INVALID_RED',
          isShortCodeFormatSatisfied: false,
          isValidToSubmit: false,
          normalizedCode: upper,
          currentLength: len,
          targetLength: CANONICAL_SHORT_CODE_LENGTH,
          typedPreview: clampedTypedPreview,
          remainingMask,
          helperMessagePt: msg,
          lengthBadgeText,
          submitErrorPt: msg,
        };
      }
    }
  }

  // Validate second hyphen at index 11
  if (len >= 12 && upper[11] !== '-') {
    const msg =
      'Falta o segundo hífen após a data (posição 12) — formato esperado: FS-YYYYMMDD-XXXX.';
    return {
      status: 'INVALID',
      mode: 'SHORT_CODE',
      borderState: 'INVALID_RED',
      isShortCodeFormatSatisfied: false,
      isValidToSubmit: false,
      normalizedCode: upper,
      currentLength: len,
      targetLength: CANONICAL_SHORT_CODE_LENGTH,
      typedPreview: clampedTypedPreview,
      remainingMask,
      lengthBadgeText,
      helperMessagePt: msg,
      submitErrorPt: msg,
    };
  }

  // Validate length overflow (> 16 chars)
  if (len > CANONICAL_SHORT_CODE_LENGTH) {
    const extra = len - CANONICAL_SHORT_CODE_LENGTH;
    const msg = `Código demasiado longo (${len}/${CANONICAL_SHORT_CODE_LENGTH} carateres — remova ${extra} caráter${
      extra > 1 ? 'es' : ''
    }).`;
    return {
      status: 'INVALID',
      mode: 'SHORT_CODE',
      borderState: 'INVALID_RED',
      isShortCodeFormatSatisfied: false,
      isValidToSubmit: false,
      normalizedCode: upper,
      currentLength: len,
      targetLength: CANONICAL_SHORT_CODE_LENGTH,
      typedPreview: upper,
      remainingMask: '',
      lengthBadgeText,
      helperMessagePt: msg,
      submitErrorPt: msg,
    };
  }

  // Validate suffix characters (indices 12..15)
  if (len > 12) {
    const suffixSlice = upper.slice(12);
    if (!/^[A-Z0-9]+$/.test(suffixSlice)) {
      const msg =
        'O sufixo final XXXX (últimos 4 carateres) apenas admite letras A–Z e algarismos 0–9.';
      return {
        status: 'INVALID',
        mode: 'SHORT_CODE',
        borderState: 'INVALID_RED',
        isShortCodeFormatSatisfied: false,
        isValidToSubmit: false,
        normalizedCode: upper,
        currentLength: len,
        targetLength: CANONICAL_SHORT_CODE_LENGTH,
        typedPreview: clampedTypedPreview,
        remainingMask,
        lengthBadgeText,
        helperMessagePt: msg,
        submitErrorPt: msg,
      };
    }
  }

  // Exact 16-char canonical match -> border transitions to clear success green (#15803D)!
  if (len === CANONICAL_SHORT_CODE_LENGTH && STRICT_SHORT_CODE_FULL_REGEX.test(upper)) {
    return {
      status: 'VALID',
      mode: 'SHORT_CODE',
      borderState: 'VALID_GREEN',
      isShortCodeFormatSatisfied: true,
      isValidToSubmit: true,
      normalizedCode: upper,
      currentLength: len,
      targetLength: CANONICAL_SHORT_CODE_LENGTH,
      typedPreview: upper,
      remainingMask: '',
      lengthBadgeText,
      helperMessagePt: 'Formato completo válido (16/16 carateres) — pronto a verificar.',
      submitErrorPt: null,
    };
  }

  // Incomplete valid prefix (1..15 chars)
  const remaining = CANONICAL_SHORT_CODE_LENGTH - len;
  let nextPartHint = 'complete o código';
  if (len < 3) {
    nextPartHint = 'escreva o prefixo "FS-"';
  } else if (len < 11) {
    nextPartHint = 'complete a data YYYYMMDD (8 dígitos)';
  } else if (len === 11) {
    nextPartHint = 'adicione o hífen "-" antes dos 4 carateres finais';
  } else {
    nextPartHint = `faltam ${remaining} caráter${remaining > 1 ? 'es' : ''} do sufixo XXXX`;
  }

  return {
    status: 'INCOMPLETE',
    mode: 'SHORT_CODE',
    borderState: len >= 8 ? 'TYPING_NEAR' : 'TYPING_EARLY',
    isShortCodeFormatSatisfied: false,
    isValidToSubmit: false,
    normalizedCode: upper,
    currentLength: len,
    targetLength: CANONICAL_SHORT_CODE_LENGTH,
    typedPreview: clampedTypedPreview,
    remainingMask,
    lengthBadgeText,
    helperMessagePt: `Em preenchimento (faltam ${remaining}): ${nextPartHint}.`,
    submitErrorPt: `Código incompleto (${len}/${CANONICAL_SHORT_CODE_LENGTH} carateres). Complete o formato FS-YYYYMMDD-XXXX antes de verificar.`,
  };
}

export type QrScannerCameraModalPhase =
  | 'CLOSED'
  | 'STARTING'
  | 'SCANNING'
  | 'UNAVAILABLE'
  | 'PAUSED_AFTER_MISMATCH';

export type QrScannerHardwareState =
  | 'PROBING'
  | 'SCANNING_LIVE'
  | 'HID_SCANNER_READY'
  | 'CAMERA_READY'
  | 'OPTICAL_FALLBACK_READY'
  | 'CAMERA_BLOCKED';

export interface QrScannerHardwareSnapshot {
  isProbing: boolean;
  hasMediaDevicesApi: boolean;
  videoInputCount: number;
  cameraPermission: 'granted' | 'prompt' | 'denied' | 'unknown';
  hasNativeBarcodeDetector: boolean;
  modalCameraPhase: QrScannerCameraModalPhase;
  hidScannerDetected: boolean;
  isOnline: boolean;
}

export interface QrScannerHardwareLiveStatus {
  state: QrScannerHardwareState;
  isReadyForFieldUse: boolean;
  statusTextPt: string;
}

/**
 * Detects whether a rapid burst of keystrokes into `#public-verify-code-input` originated
 * from a physical USB/Bluetooth HID 2D QR scanner (typically <= 35 ms per character).
 */
export function detectHidQrScannerBurst(
  keystrokeTimestampsMs: number[],
  currentValueLength: number
): boolean {
  if (currentValueLength < 6 || keystrokeTimestampsMs.length < 6) {
    return false;
  }
  const recent = keystrokeTimestampsMs.slice(-6);
  let totalDeltaMs = 0;
  for (let i = 1; i < recent.length; i += 1) {
    const delta = recent[i] - recent[i - 1];
    if (delta < 0 || delta > 65) {
      return false;
    }
    totalDeltaMs += delta;
  }
  const avgDeltaMs = totalDeltaMs / (recent.length - 1);
  return avgDeltaMs <= 35;
}

/**
 * Pure evaluator producing a live QR scanner hardware readiness status line for outdoor field use.
 */
export function evaluateQrScannerHardwareStatus(
  snapshot: QrScannerHardwareSnapshot
): QrScannerHardwareLiveStatus {
  if (snapshot.modalCameraPhase === 'SCANNING') {
    return {
      state: 'SCANNING_LIVE',
      isReadyForFieldUse: true,
      statusTextPt:
        'Hardware QR ligado em direto — câmara ativa e pronta para uso no terreno sob luz solar.',
    };
  }

  if (snapshot.modalCameraPhase === 'STARTING') {
    return {
      state: 'PROBING',
      isReadyForFieldUse: false,
      statusTextPt:
        'A estabelecer ligação com o hardware ótico QR para leitura no terreno…',
    };
  }

  if (snapshot.hidScannerDetected) {
    return {
      state: 'HID_SCANNER_READY',
      isReadyForFieldUse: true,
      statusTextPt:
        'Leitor físico QR (USB/Bluetooth HID) ligado — pronto para uso imediato no terreno sob luz solar.',
    };
  }

  if (snapshot.isProbing) {
    return {
      state: 'PROBING',
      isReadyForFieldUse: false,
      statusTextPt: 'A verificar ligação do hardware de leitura QR para uso no terreno…',
    };
  }

  if (
    snapshot.cameraPermission === 'denied' ||
    (snapshot.modalCameraPhase === 'UNAVAILABLE' &&
      snapshot.hasMediaDevicesApi &&
      snapshot.videoInputCount > 0)
  ) {
    return {
      state: 'CAMERA_BLOCKED',
      isReadyForFieldUse: false,
      statusTextPt:
        'Câmara ótica bloqueada nas permissões — autorize a câmara ou use leitor externo / código manual no terreno.',
    };
  }

  const offlineSuffix = snapshot.isOnline ? '' : ' · Validação local offline ativa.';

  if (snapshot.hasMediaDevicesApi && snapshot.videoInputCount > 0) {
    const camLabel =
      snapshot.videoInputCount > 1
        ? `${snapshot.videoInputCount} câmaras detetadas`
        : 'câmara ótica detetada';
    const engineLabel = snapshot.hasNativeBarcodeDetector ? ' · motor QR nativo' : '';
    return {
      state: 'CAMERA_READY',
      isReadyForFieldUse: true,
      statusTextPt: `Hardware QR ligado (${camLabel}${engineLabel}) — pronto para uso no terreno sob luz solar.${offlineSuffix}`,
    };
  }

  if (snapshot.hasMediaDevicesApi) {
    return {
      state: 'OPTICAL_FALLBACK_READY',
      isReadyForFieldUse: true,
      statusTextPt: `Hardware QR pronto para uso no terreno — entrada para leitor externo HID e imagem QR ativa.${offlineSuffix}`,
    };
  }

  return {
    state: 'OPTICAL_FALLBACK_READY',
    isReadyForFieldUse: true,
    statusTextPt: `Leitor QR em modo externo HID / código manual pronto para uso no terreno.${offlineSuffix}`,
  };
}

/**
 * Probes browser MediaDevices, videoinput hardware enumeration, camera Permissions API,
 * and native BarcodeDetector support without opening the camera shutter prematurely.
 */
export async function probeQrScannerHardwareBrowser(): Promise<
  Pick<
    QrScannerHardwareSnapshot,
    'hasMediaDevicesApi' | 'videoInputCount' | 'cameraPermission' | 'hasNativeBarcodeDetector'
  >
> {
  const hasMediaDevicesApi =
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');

  const hasNativeBarcodeDetector =
    typeof window !== 'undefined' &&
    typeof (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector === 'function';

  let videoInputCount = 0;
  if (
    hasMediaDevicesApi &&
    typeof navigator.mediaDevices.enumerateDevices === 'function'
  ) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      videoInputCount = devices.filter((d) => d.kind === 'videoinput').length;
    } catch {
      videoInputCount = 0;
    }
  }

  let cameraPermission: QrScannerHardwareSnapshot['cameraPermission'] = 'unknown';
  if (typeof navigator !== 'undefined' && navigator.permissions?.query) {
    try {
      const perm = await navigator.permissions.query({
        name: 'camera' as PermissionName,
      });
      if (perm.state === 'granted' || perm.state === 'prompt' || perm.state === 'denied') {
        cameraPermission = perm.state;
      }
    } catch {
      cameraPermission = 'unknown';
    }
  }

  return {
    hasMediaDevicesApi,
    videoInputCount,
    cameraPermission,
    hasNativeBarcodeDetector,
  };
}



