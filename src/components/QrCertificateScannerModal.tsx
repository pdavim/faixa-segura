import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ChevronRight,
  History,
  ImageUp,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import type { ComplianceCertificate } from '../types/domain.ts';
import {
  MAX_QR_SCAN_HISTORY_ITEMS,
  appendQrScanHistory,
  clearQrScanHistory,
  decodeQrRgbaFrame,
  describeCameraAccessErrorPt,
  loadQrScanHistory,
  resolveCertificateFromPayload,
  type QrScanSource,
  type QrScannedCertificateEntry,
} from '../lib/qrVerification.ts';

interface NativeBarcodeResult {
  rawValue?: string;
}

interface NativeBarcodeDetector {
  detect: (source: ImageBitmapSource) => Promise<NativeBarcodeResult[]>;
}

interface QrCertificateScannerModalProps {
  isOpen: boolean;
  certificates: ComplianceCertificate[];
  onClose: () => void;
  onCertificateVerified: (certificate: ComplianceCertificate) => void;
}

type CameraPhase = 'STARTING' | 'SCANNING' | 'UNAVAILABLE' | 'PAUSED_AFTER_MISMATCH';
type ScannerModalTab = 'scanner' | 'history';

function formatScanSourcePt(source: QrScanSource): string {
  if (source === 'CAMERA') return 'Câmara';
  if (source === 'IMAGE') return 'Imagem QR';
  return 'Código manual';
}

function formatScanTimestampPt(isoString: string): string {
  const parsed = new Date(isoString);
  if (Number.isNaN(parsed.getTime())) return isoString;
  return parsed.toLocaleString('pt-PT', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const QrCertificateScannerModal: React.FC<QrCertificateScannerModalProps> = ({
  isOpen,
  certificates,
  onClose,
  onCertificateVerified,
}) => {
  const [activeTab, setActiveTab] = useState<ScannerModalTab>('scanner');
  const [scanHistory, setScanHistory] = useState<QrScannedCertificateEntry[]>(() =>
    loadQrScanHistory()
  );
  const [cameraPhase, setCameraPhase] = useState<CameraPhase>('STARTING');
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [manualCodeInput, setManualCodeInput] = useState('');
  const [isVerifyingPayload, setIsVerifyingPayload] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const lastFrameScanMsRef = useRef<number>(0);
  const isResolvingScanRef = useRef<boolean>(false);
  const certificatesRef = useRef<ComplianceCertificate[]>(certificates);
  const nativeDetectorRef = useRef<NativeBarcodeDetector | null | undefined>(undefined);

  useEffect(() => {
    certificatesRef.current = certificates;
  }, [certificates]);

  const stopCameraResources = useCallback(() => {
    if (rafIdRef.current !== null) {
      window.cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const fetchRemoteCertificate = useCallback(
    async (candidateCode: string): Promise<ComplianceCertificate | null> => {
      const resp = await fetch(`/api/verify/${encodeURIComponent(candidateCode)}`);
      if (!resp.ok) return null;
      const data = (await resp.json()) as ComplianceCertificate;
      return data && typeof data.shortCode === 'string' ? data : null;
    },
    []
  );

  const handleDecodedPayload = useCallback(
    async (rawPayload: string, source: QrScanSource) => {
      if (isResolvingScanRef.current) return;
      isResolvingScanRef.current = true;
      setIsVerifyingPayload(true);
      setScanError(null);

      try {
        const result = await resolveCertificateFromPayload({
          certificates: certificatesRef.current,
          rawPayload,
          fetchRemoteByCode: fetchRemoteCertificate,
        });

        if (result.certificate) {
          const updatedHistory = appendQrScanHistory(result.certificate, { source });
          setScanHistory(updatedHistory);
          stopCameraResources();
          onCertificateVerified(result.certificate);
          onClose();
          return;
        }

        setScanError(
          result.errorPt ??
            'Código QR lido, mas não corresponde a nenhum certificado registado.'
        );
        if (source === 'CAMERA') {
          stopCameraResources();
          setCameraPhase('PAUSED_AFTER_MISMATCH');
        }
      } finally {
        setIsVerifyingPayload(false);
        isResolvingScanRef.current = false;
      }
    },
    [fetchRemoteCertificate, onCertificateVerified, onClose, stopCameraResources]
  );

  const startCameraScanner = useCallback(
    async (preferredFacing: 'environment' | 'user') => {
      stopCameraResources();
      setCameraError(null);
      setScanError(null);
      setCameraPhase('STARTING');
      isResolvingScanRef.current = false;

      const hasMediaDevices =
        typeof navigator !== 'undefined' &&
        Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');

      if (!hasMediaDevices) {
        setCameraPhase('UNAVAILABLE');
        setCameraError(describeCameraAccessErrorPt(null, false));
        return;
      }

      try {
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              facingMode: { ideal: preferredFacing },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
          });
        } catch (primaryErr) {
          const errName =
            primaryErr && typeof primaryErr === 'object' && 'name' in primaryErr
              ? String((primaryErr as { name?: unknown }).name)
              : '';
          if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
            throw primaryErr;
          }
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: true,
          });
        }

        streamRef.current = stream;
        const videoEl = videoRef.current;
        if (!videoEl) {
          stopCameraResources();
          return;
        }

        videoEl.srcObject = stream;
        try {
          await videoEl.play();
        } catch {
          // Autoplay with muted + playsInline resolves on loadedmetadata in some engines
        }

        if (nativeDetectorRef.current === undefined) {
          const globalWin = window as unknown as {
            BarcodeDetector?: new (opts: { formats: string[] }) => NativeBarcodeDetector;
          };
          if (typeof globalWin.BarcodeDetector === 'function') {
            try {
              nativeDetectorRef.current = new globalWin.BarcodeDetector({
                formats: ['qr_code'],
              });
            } catch {
              nativeDetectorRef.current = null;
            }
          } else {
            nativeDetectorRef.current = null;
          }
        }

        setCameraPhase('SCANNING');

        const scanFrame = async (timestampMs: number) => {
          if (!streamRef.current || isResolvingScanRef.current) {
            return;
          }

          if (timestampMs - lastFrameScanMsRef.current >= 95) {
            lastFrameScanMsRef.current = timestampMs;
            const v = videoRef.current;
            const c = canvasRef.current;

            if (
              v &&
              c &&
              v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
              v.videoWidth > 0 &&
              v.videoHeight > 0
            ) {
              // 1. Try hardware/native BarcodeDetector fast-path if present
              let detectedValue: string | null = null;
              if (nativeDetectorRef.current) {
                try {
                  const codes = await nativeDetectorRef.current.detect(v);
                  const firstRaw = codes[0]?.rawValue?.trim();
                  if (firstRaw) {
                    detectedValue = firstRaw;
                  }
                } catch {
                  // Fall back to jsQR canvas path
                }
              }

              // 2. Universal jsQR canvas RGBA decode
              if (!detectedValue) {
                const maxSide = 640;
                const scale = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
                const targetW = Math.max(1, Math.floor(v.videoWidth * scale));
                const targetH = Math.max(1, Math.floor(v.videoHeight * scale));

                if (c.width !== targetW) c.width = targetW;
                if (c.height !== targetH) c.height = targetH;

                const ctx = c.getContext('2d', { willReadFrequently: true });
                if (ctx) {
                  ctx.drawImage(v, 0, 0, targetW, targetH);
                  const imgData = ctx.getImageData(0, 0, targetW, targetH);
                  detectedValue = decodeQrRgbaFrame(imgData.data, targetW, targetH);
                }
              }

              if (detectedValue) {
                await handleDecodedPayload(detectedValue, 'CAMERA');
                return;
              }
            }
          }

          if (streamRef.current && !isResolvingScanRef.current) {
            rafIdRef.current = window.requestAnimationFrame((ts) => {
              void scanFrame(ts);
            });
          }
        };

        rafIdRef.current = window.requestAnimationFrame((ts) => {
          void scanFrame(ts);
        });
      } catch (err) {
        stopCameraResources();
        setCameraPhase('UNAVAILABLE');
        setCameraError(describeCameraAccessErrorPt(err, true));
      }
    },
    [handleDecodedPayload, stopCameraResources]
  );

  useEffect(() => {
    if (!isOpen) {
      stopCameraResources();
      return;
    }

    setActiveTab('scanner');
    setScanHistory(loadQrScanHistory());
    setManualCodeInput('');
    setScanError(null);
  }, [isOpen, stopCameraResources]);

  useEffect(() => {
    if (!isOpen || activeTab !== 'scanner') {
      stopCameraResources();
      return;
    }

    void startCameraScanner(facingMode);

    return () => {
      stopCameraResources();
    };
  }, [isOpen, activeTab, facingMode, startCameraScanner, stopCameraResources]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        stopCameraResources();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose, stopCameraResources]);

  if (!isOpen) return null;

  const handleCloseModal = () => {
    stopCameraResources();
    onClose();
  };

  const handleFlipCamera = () => {
    setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'));
  };

  const handleQrImageFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setScanError(null);
    setIsVerifyingPayload(true);

    try {
      const objectUrl = URL.createObjectURL(file);
      try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = () => reject(new Error('Falha ao carregar imagem'));
          el.src = objectUrl;
        });

        const c = canvasRef.current ?? document.createElement('canvas');
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          setScanError('Não foi possível processar a imagem neste navegador.');
          return;
        }

        let decodedText: string | null = null;
        for (const maxDimension of [1024, 600, 1400]) {
          const scale = Math.min(
            1,
            maxDimension / Math.max(img.naturalWidth || 1, img.naturalHeight || 1)
          );
          const w = Math.max(1, Math.floor((img.naturalWidth || 300) * scale));
          const h = Math.max(1, Math.floor((img.naturalHeight || 300) * scale));
          c.width = w;
          c.height = h;
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          const imageData = ctx.getImageData(0, 0, w, h);
          decodedText = decodeQrRgbaFrame(imageData.data, w, h);
          if (decodedText) break;
        }

        if (!decodedText) {
          setScanError(
            'Não foi detetado nenhum código QR legível na imagem selecionada. Certifique-se de que o código QR está nítido e bem enquadrado.'
          );
          return;
        }

        await handleDecodedPayload(decodedText, 'IMAGE');
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch {
      setScanError('O ficheiro selecionado não pôde ser lido como imagem de código QR.');
    } finally {
      setIsVerifyingPayload(false);
    }
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await handleDecodedPayload(manualCodeInput, 'MANUAL_CODE');
  };

  const handleRevisitCertificate = (certificate: ComplianceCertificate) => {
    stopCameraResources();
    onCertificateVerified(certificate);
    onClose();
  };

  const handleClearHistory = () => {
    clearQrScanHistory();
    setScanHistory([]);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="qr-scanner-modal-title"
      data-testid="qr-certificate-scanner-modal"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-xs p-0 sm:p-4"
    >
      <div className="w-full sm:max-w-lg rounded-t-3xl sm:rounded-2xl bg-white dark:bg-[#161E2E] hc:bg-white hc:dark:bg-black border border-slate-300 dark:border-[#263248] hc:border-2 hc:border-black hc:dark:border-white p-5 sm:p-6 max-h-[92vh] overflow-y-auto space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-200 dark:border-[#263248] hc:border-b-2 hc:border-black hc:dark:border-white">
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-[#14532D] dark:text-[#22C55E]">
              <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>Auditoria Pública Criptográfica SHA-256</span>
            </div>
            <h2
              id="qr-scanner-modal-title"
              className="font-display text-lg sm:text-xl font-bold text-slate-950 dark:text-white"
            >
              Verificar Certificado por Código QR
            </h2>
          </div>

          <button
            type="button"
            onClick={handleCloseModal}
            aria-label="Fechar leitor de código QR"
            className="min-h-[44px] min-w-[44px] rounded-xl flex items-center justify-center text-slate-500 hc:text-black hc:dark:text-white hover:bg-slate-100 dark:hover:bg-slate-800 hc:border-2 hc:border-black hc:dark:border-white"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Modal Mode Tabs: Scanner vs Scan History (Last 5) */}
        <div
          role="tablist"
          aria-label="Secções do verificador de certificados"
          className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-slate-100 dark:bg-[#0B0F17] hc:bg-white hc:dark:bg-black border border-slate-200 dark:border-[#263248] hc:border-2 hc:border-black hc:dark:border-white"
        >
          <button
            id="qr-scanner-tab-btn"
            type="button"
            role="tab"
            data-testid="qr-modal-tab-scanner"
            aria-selected={activeTab === 'scanner'}
            aria-controls="qr-scanner-tabpanel"
            onClick={() => setActiveTab('scanner')}
            className={`min-h-[40px] px-3 py-2 rounded-lg text-xs inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 transition-colors ${
              activeTab === 'scanner'
                ? 'bg-white dark:bg-[#161E2E] hc:bg-black hc:dark:bg-[#FACC15] text-slate-950 dark:text-white hc:text-white hc:dark:text-black font-bold shadow-xs'
                : 'text-slate-600 dark:text-slate-300 hc:text-black hc:dark:text-white font-semibold hover:text-slate-950 dark:hover:text-white'
            }`}
          >
            <Camera className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Ler QR</span>
          </button>

          <button
            id="qr-history-tab-btn"
            type="button"
            role="tab"
            data-testid="qr-modal-tab-history"
            aria-selected={activeTab === 'history'}
            aria-controls="qr-history-tabpanel"
            onClick={() => {
              setScanHistory(loadQrScanHistory());
              setActiveTab('history');
            }}
            className={`min-h-[40px] px-3 py-2 rounded-lg text-xs inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 transition-colors ${
              activeTab === 'history'
                ? 'bg-white dark:bg-[#161E2E] hc:bg-black hc:dark:bg-[#FACC15] text-slate-950 dark:text-white hc:text-white hc:dark:text-black font-bold shadow-xs'
                : 'text-slate-600 dark:text-slate-300 hc:text-black hc:dark:text-white font-semibold hover:text-slate-950 dark:hover:text-white'
            }`}
          >
            <History className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="tabular-nums">
              Histórico ({scanHistory.length}/{MAX_QR_SCAN_HISTORY_ITEMS})
            </span>
          </button>
        </div>

        {activeTab === 'scanner' ? (
          <div
            id="qr-scanner-tabpanel"
            role="tabpanel"
            aria-labelledby="qr-scanner-tab-btn"
            className="space-y-4"
          >
            {/* Live Camera Viewfinder */}
            <div className="space-y-2.5">
          <div
            data-testid="qr-camera-viewport"
            data-camera-phase={cameraPhase}
            className="relative aspect-[4/3] w-full rounded-2xl overflow-hidden bg-[#0B0F17] border border-slate-300 dark:border-[#263248]"
          >
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              aria-label="Pré-visualização em direto da câmara para leitura de código QR"
              className={`w-full h-full object-cover ${
                cameraPhase === 'SCANNING' ? 'opacity-100' : 'opacity-0'
              }`}
            />

            {/* Geometric Viewfinder Frame (Visible during active scan) */}
            {cameraPhase === 'SCANNING' && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 flex flex-col items-center justify-between p-4 bg-gradient-to-t from-black/70 via-transparent to-black/35"
              >
                <div className="w-full flex items-center justify-between text-xs font-medium text-white">
                  <span>Câmara ativa · Leitura automática</span>
                  <span className="font-mono tabular-nums">
                    {facingMode === 'environment' ? 'Traseira' : 'Frontal'}
                  </span>
                </div>

                <div className="relative w-44 h-44 sm:w-52 sm:h-52">
                  <span className="absolute top-0 left-0 w-7 h-7 border-t-3 border-l-3 border-[#4ADE80] rounded-tl-lg" />
                  <span className="absolute top-0 right-0 w-7 h-7 border-t-3 border-r-3 border-[#4ADE80] rounded-tr-lg" />
                  <span className="absolute bottom-0 left-0 w-7 h-7 border-b-3 border-l-3 border-[#4ADE80] rounded-bl-lg" />
                  <span className="absolute bottom-0 right-0 w-7 h-7 border-b-3 border-r-3 border-[#4ADE80] rounded-br-lg" />
                </div>

                <p className="text-xs font-medium text-white text-center">
                  Enquadre o código QR impresso no canto do Auto PDF Oficial A4
                </p>
              </div>
            )}

            {/* Starting State */}
            {cameraPhase === 'STARTING' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center text-white space-y-2">
                <Camera className="w-9 h-9 text-[#4ADE80]" aria-hidden="true" />
                <p className="text-sm font-semibold">A iniciar câmara do dispositivo...</p>
                <p className="text-xs text-slate-300 max-w-xs">
                  Aceite o pedido de permissão do navegador para validar o código QR em direto.
                </p>
              </div>
            )}

            {/* Camera Unavailable / Permission Denied State */}
            {cameraPhase === 'UNAVAILABLE' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center text-white space-y-3">
                <AlertTriangle className="w-9 h-9 text-[#FACC15]" aria-hidden="true" />
                <p className="text-sm font-semibold">Leitura vídeo em direto indisponível</p>
                <p className="text-xs text-slate-300 max-w-sm leading-relaxed">
                  {cameraError}
                </p>
                <button
                  type="button"
                  onClick={() => void startCameraScanner(facingMode)}
                  className="min-h-[40px] px-4 py-2 rounded-xl bg-white/15 hover:bg-white/25 text-white text-xs font-semibold inline-flex items-center gap-2 whitespace-nowrap"
                >
                  <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                  Tentar Câmara Novamente
                </button>
              </div>
            )}

            {/* Paused After Unmatched Scan */}
            {cameraPhase === 'PAUSED_AFTER_MISMATCH' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center text-white space-y-3">
                <AlertTriangle className="w-9 h-9 text-[#FACC15]" aria-hidden="true" />
                <p className="text-sm font-semibold">Código QR não reconhecido no registo</p>
                <button
                  type="button"
                  onClick={() => void startCameraScanner(facingMode)}
                  className="min-h-[42px] px-4 py-2 rounded-xl bg-[#22C55E] hover:bg-[#16A34A] text-slate-950 text-xs font-semibold inline-flex items-center gap-2 whitespace-nowrap"
                >
                  <Camera className="w-4 h-4" aria-hidden="true" />
                  Ler Outro Código QR
                </button>
              </div>
            )}
          </div>

          <canvas ref={canvasRef} className="hidden" aria-hidden="true" />

          {/* Camera & Image Upload Controls */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <input
              ref={fileInputRef}
              id="qr-image-upload-input"
              data-testid="qr-image-upload-input"
              type="file"
              accept="image/*"
              onChange={(e) => void handleQrImageFileChange(e)}
              className="sr-only"
            />

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isVerifyingPayload}
              className="min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 dark:border-[#263248] bg-[#F8FAFC] dark:bg-[#0B0F17] hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 text-xs font-semibold inline-flex items-center gap-2 whitespace-nowrap"
            >
              <ImageUp className="w-4 h-4 text-[#14532D] dark:text-[#22C55E]" aria-hidden="true" />
              <span>Ler Imagem com Código QR</span>
            </button>

            {cameraPhase === 'SCANNING' && (
              <button
                type="button"
                onClick={handleFlipCamera}
                aria-label="Alternar entre câmara traseira e frontal"
                className="min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 dark:border-[#263248] bg-white dark:bg-[#0B0F17] hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-semibold inline-flex items-center gap-2 whitespace-nowrap"
              >
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Alternar Câmara</span>
              </button>
            )}
          </div>
        </div>

            {/* Validation / Scan Feedback */}
            {scanError && (
              <div
                role="alert"
                className="rounded-xl border border-red-300 dark:border-red-900/60 hc:border-2 hc:border-black hc:dark:border-white bg-red-50 dark:bg-red-950/30 hc:bg-white hc:dark:bg-black p-3 text-xs font-medium hc:font-bold text-[#DC2626] dark:text-red-300"
              >
                {scanError}
              </div>
            )}

            {/* Manual ShortCode / Hash Verification Fallback */}
            <form
              onSubmit={(e) => void handleManualSubmit(e)}
              className="pt-3 border-t border-slate-200 dark:border-[#263248] hc:border-t-2 hc:border-black hc:dark:border-white space-y-2"
              noValidate
            >
              <label
                htmlFor="qr-manual-code-input"
                className="block text-xs font-semibold hc:font-bold text-slate-700 dark:text-slate-300 hc:text-black hc:dark:text-white"
              >
                Ou valide introduzindo o código do Auto PDF
              </label>
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <input
                  id="qr-manual-code-input"
                  type="text"
                  value={manualCodeInput}
                  onChange={(e) => {
                    setManualCodeInput(e.target.value);
                    if (scanError) setScanError(null);
                  }}
                  placeholder="Ex.: FS-20260524-7D9E"
                  className="flex-1 min-h-[44px] px-3.5 py-2 rounded-xl bg-[#F8FAFC] dark:bg-[#0B0F17] hc:bg-white hc:dark:bg-black border border-slate-300 dark:border-[#263248] hc:border-2 hc:border-black hc:dark:border-white text-xs font-mono tabular-nums text-slate-900 dark:text-white hc:text-black hc:dark:text-white hc:font-bold"
                />
                <button
                  type="submit"
                  disabled={isVerifyingPayload}
                  className="min-h-[44px] px-4 py-2 rounded-xl bg-[#14532D] hover:bg-[#0F3F22] dark:bg-[#22C55E] dark:hover:bg-[#16A34A] hc:bg-[#0A3619] hc:dark:bg-[#4ADE80] hc:border-2 hc:border-black hc:dark:border-white text-white dark:text-slate-950 hc:dark:text-black text-xs font-semibold hc:font-bold inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
                >
                  <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                  <span>Validar Código</span>
                </button>
              </div>
            </form>
          </div>
        ) : (
          <div
            id="qr-history-tabpanel"
            role="tabpanel"
            aria-labelledby="qr-history-tab-btn"
            data-testid="qr-scan-history-panel"
            className="space-y-3"
          >
            <div className="flex items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-300 hc:text-black hc:dark:text-white">
              <span className="font-medium hc:font-bold tabular-nums">
                Últimos {scanHistory.length} de {MAX_QR_SCAN_HISTORY_ITEMS} certificados validados
              </span>
              {scanHistory.length > 0 && (
                <button
                  type="button"
                  data-testid="qr-clear-history-btn"
                  onClick={handleClearHistory}
                  className="min-h-[36px] px-2.5 py-1 rounded-lg text-xs font-semibold hc:font-bold text-slate-600 dark:text-slate-300 hc:text-black hc:dark:text-white hover:text-[#DC2626] dark:hover:text-red-400 hover:underline hc:underline underline-offset-4 inline-flex items-center gap-1 whitespace-nowrap shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>Limpar histórico</span>
                </button>
              )}
            </div>

            {scanHistory.length === 0 ? (
              <div
                data-testid="qr-scan-history-empty"
                className="rounded-2xl border border-slate-200 dark:border-[#263248] hc:border-2 hc:border-black hc:dark:border-white bg-[#F8FAFC] dark:bg-[#0B0F17] hc:bg-white hc:dark:bg-black p-6 text-center space-y-3"
              >
                <History
                  className="w-8 h-8 mx-auto text-slate-400 dark:text-slate-500 hc:text-black hc:dark:text-white"
                  aria-hidden="true"
                />
                <div className="space-y-1">
                  <p className="text-sm font-bold text-slate-900 dark:text-white hc:text-black hc:dark:text-white">
                    Sem leituras recentes neste dispositivo
                  </p>
                  <p className="text-xs text-slate-600 dark:text-slate-300 hc:text-black hc:dark:text-white hc:font-medium max-w-sm mx-auto leading-relaxed">
                    Os últimos 5 Certificados de Conformidade validados por câmara, imagem QR ou código ficam guardados aqui para consulta imediata no terreno.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('scanner')}
                  className="min-h-[42px] px-4 py-2 rounded-xl bg-[#14532D] hover:bg-[#0F3F22] dark:bg-[#22C55E] dark:hover:bg-[#16A34A] hc:bg-[#0A3619] hc:dark:bg-[#4ADE80] hc:border-2 hc:border-black hc:dark:border-white text-white dark:text-slate-950 hc:dark:text-black text-xs font-semibold hc:font-bold inline-flex items-center gap-1.5 whitespace-nowrap"
                >
                  <Camera className="w-4 h-4" aria-hidden="true" />
                  <span>Iniciar Leitura QR</span>
                </button>
              </div>
            ) : (
              <ul
                data-testid="qr-scan-history-list"
                className="space-y-2.5"
              >
                {scanHistory.map((entry) => {
                  const cert = entry.certificate;
                  return (
                    <li key={cert.shortCode}>
                      <button
                        type="button"
                        data-testid={`qr-history-item-${cert.shortCode}`}
                        onClick={() => handleRevisitCertificate(cert)}
                        className="w-full text-left rounded-xl border border-slate-200 dark:border-[#263248] hc:border-2 hc:border-black hc:dark:border-white bg-[#F8FAFC] dark:bg-[#0B0F17] hc:bg-white hc:dark:bg-black hover:bg-slate-100 dark:hover:bg-slate-800/80 p-3.5 transition-colors space-y-1.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono tabular-nums text-xs sm:text-sm font-bold text-slate-950 dark:text-white hc:text-black hc:dark:text-white">
                            #{cert.shortCode}
                          </span>
                          <span className="inline-flex items-center gap-1 text-xs font-semibold hc:font-bold text-[#14532D] dark:text-[#22C55E] hc:text-[#0A3619] hc:dark:text-[#4ADE80] whitespace-nowrap shrink-0">
                            <span>Abrir Auto</span>
                            <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                          </span>
                        </div>

                        <p className="text-xs font-semibold text-slate-800 dark:text-slate-200 hc:text-black hc:dark:text-white truncate">
                          {cert.parcelLabel} · {cert.municipality}
                        </p>

                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400 hc:text-black hc:dark:text-white hc:font-semibold">
                          <span>{cert.cleanedAreaM2.toFixed(0)} m²</span>
                          <span aria-hidden="true">·</span>
                          <span>SHA-256 {cert.sha256Hash.slice(0, 10)}…</span>
                          <span aria-hidden="true">·</span>
                          <span>{formatScanSourcePt(entry.source)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{formatScanTimestampPt(entry.scannedAtIso)}</span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
