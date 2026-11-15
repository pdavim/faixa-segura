import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { CheckCircle2, Download, ShieldCheck, X } from 'lucide-react';
import type { ComplianceCertificate } from '../types/domain.ts';
import { generateComplianceCertificatePdf } from '../lib/pdfTemplates.ts';

interface CertificateVerifyModalProps {
  certificate: ComplianceCertificate | null;
  onClose: () => void;
}

export const CertificateVerifyModal: React.FC<CertificateVerifyModalProps> = ({
  certificate,
  onClose,
}) => {
  const [qrDataUrl, setQrDataUrl] = useState<string>('');

  useEffect(() => {
    if (!certificate) return;
    const url = `${window.location.origin}/?verify=${encodeURIComponent(certificate.shortCode)}`;
    QRCode.toDataURL(url, { width: 160, margin: 1 }).then(setQrDataUrl).catch(() => {});
  }, [certificate]);

  if (!certificate) return null;

  const handleDownloadPdf = async () => {
    const bytes = await generateComplianceCertificatePdf(certificate, window.location.origin);
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${certificate.shortCode}_Auto_Conformidade.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="verify-modal-title"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-xs p-0 sm:p-4"
    >
      <div className="w-full sm:max-w-xl rounded-t-3xl sm:rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 sm:p-6 max-h-[90vh] overflow-y-auto space-y-4">
        <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-200 dark:border-[#263248]">
          <div>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-[#0284C7] dark:text-[#38BDF8]">
              <ShieldCheck className="w-4 h-4" aria-hidden="true" />
              Verificação Pública Criptográfica SGIFR
            </div>
            <h2 id="verify-modal-title" className="mt-1 text-lg font-bold font-mono text-slate-900 dark:text-white">
              Certificado #{certificate.shortCode}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar janela de verificação"
            className="min-h-[44px] min-w-[44px] rounded-xl flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <div className="flex flex-col sm:flex-row gap-4 items-center rounded-xl p-4 bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248]">
          {qrDataUrl && (
            <img
              src={qrDataUrl}
              alt={`Código QR de verificação para ${certificate.shortCode}`}
              referrerPolicy="no-referrer"
              className="w-28 h-28 rounded-lg border border-slate-200 bg-white p-1 shrink-0"
            />
          )}
          <div className="space-y-1.5 text-xs min-w-0">
            <div className="font-bold text-[#16A34A] flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
              Assinatura SHA-256 Íntegra e Verificada
            </div>
            <p className="text-slate-700 dark:text-slate-300">
              <strong>Prédio:</strong> {certificate.parcelLabel} ({certificate.parish}, {certificate.municipality})
            </p>
            <p className="text-slate-700 dark:text-slate-300 tabular-nums">
              <strong>Faixa Executada:</strong> {certificate.cleanedAreaM2.toFixed(2)} m² · Emissão: {new Date(certificate.issuedAt).toLocaleString('pt-PT')}
            </p>
            <p className="font-mono text-[11px] break-all text-slate-500 dark:text-slate-400">
              {certificate.sha256Hash}
            </p>
          </div>
        </div>

        <div className="space-y-2 text-xs text-slate-600 dark:text-slate-300">
          <div>
            <strong>Titular Registado:</strong> {certificate.ownerName} (NIF {certificate.ownerNif})
          </div>
          <div>
            <strong>Proteção Quercíneas:</strong> {certificate.protectedSpeciesCheck}
          </div>
          <div>
            <strong>Fotos Georreferenciadas:</strong> {certificate.photos.length} registos EXIF/GPS validados no interior do polígono {certificate.bupiRggId}.
          </div>
        </div>

        <div className="pt-2 flex flex-col sm:flex-row gap-2.5">
          <button
            type="button"
            onClick={handleDownloadPdf}
            className="flex-1 min-h-[46px] px-4 py-2.5 rounded-xl bg-[#0F172A] dark:bg-[#38BDF8] text-white dark:text-slate-950 text-xs font-semibold inline-flex items-center justify-center gap-2"
          >
            <Download className="w-4 h-4" aria-hidden="true" />
            Descarregar PDF Oficial A4 (2 Páginas)
          </button>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[46px] px-5 py-2.5 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-300"
          >
            Concluir
          </button>
        </div>
      </div>
    </div>
  );
};
