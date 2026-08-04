import { save } from "@tauri-apps/plugin-dialog";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import { copyPdfTo, readPdfBytes } from "../lib/api";
import { sanitizeFileName } from "../lib/format";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

/**
 * Renders a PDF inside the app instead of handing it off to the OS's
 * default viewer — pdf.js does the rendering (onto a canvas) so this works
 * the same on every platform regardless of whatever PDF support (or lack
 * of it) the system webview has built in.
 */
export default function PdfViewerModal({
  path,
  title,
  onClose,
}: {
  /** `null` keeps the modal unmounted/closed. */
  path: string | null;
  title?: string;
  onClose: () => void;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!path) {
      setDoc(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDownloadError(null);
    setPageNum(1);
    readPdfBytes(path)
      .then((buffer) => pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise)
      .then((pdf) => {
        if (cancelled) return;
        setDoc(pdf);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    let renderTask: RenderTask | null = null;

    doc.getPage(pageNum).then((page) => {
      if (cancelled || !canvasRef.current) return;
      const canvas = canvasRef.current;
      const viewport = page.getViewport({ scale: 1.5 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      renderTask = page.render({ canvas, viewport });
      renderTask.promise.catch(() => {});
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [doc, pageNum]);

  // Closes on Esc, same as clicking the backdrop.
  useEffect(() => {
    if (!path) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [path, onClose]);

  async function handleDownload() {
    if (!path) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const destPath = await save({
        defaultPath: `${sanitizeFileName(title ?? "documento")}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!destPath) return;
      await copyPdfTo(path, destPath);
    } catch (e) {
      setDownloadError(String(e));
    } finally {
      setDownloading(false);
    }
  }

  if (!path) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.7)",
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
      }}
      onClick={onClose}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0.8rem 1.2rem",
          background: "var(--card-bg)",
          borderBottom: "1px solid var(--border)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <strong style={{ fontSize: "0.95rem" }}>{title ?? "Documento"}</strong>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          {doc && doc.numPages > 1 && (
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <button
                type="button"
                className="ghost"
                style={{ padding: "0.3rem" }}
                onClick={() => setPageNum((p) => Math.max(1, p - 1))}
                disabled={pageNum <= 1}
                aria-label="Página anterior"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="muted" style={{ fontSize: "0.85rem" }}>
                Página {pageNum} de {doc.numPages}
              </span>
              <button
                type="button"
                className="ghost"
                style={{ padding: "0.3rem" }}
                onClick={() => setPageNum((p) => Math.min(doc.numPages, p + 1))}
                disabled={pageNum >= doc.numPages}
                aria-label="Próxima página"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
          <button
            type="button"
            className="secondary"
            onClick={handleDownload}
            disabled={downloading || !doc}
            title="Baixar"
          >
            <Download size={15} style={{ marginRight: "0.4rem" }} />
            {downloading ? "Baixando..." : "Baixar"}
          </button>
          <button type="button" className="ghost" style={{ padding: "0.3rem" }} onClick={onClose} aria-label="Fechar">
            <X size={18} />
          </button>
        </div>
      </div>

      <div
        style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", alignItems: "center", padding: "1.5rem" }}
        onClick={onClose}
      >
        {loading && <p className="muted">Carregando...</p>}
        {error && (
          <div className="error-box" onClick={(e) => e.stopPropagation()}>
            {error}
          </div>
        )}
        {downloadError && (
          <div className="error-box" style={{ marginBottom: "1rem" }} onClick={(e) => e.stopPropagation()}>
            {downloadError}
          </div>
        )}
        {!error && (
          <canvas
            ref={canvasRef}
            onClick={(e) => e.stopPropagation()}
            style={{ boxShadow: "0 10px 30px rgba(0, 0, 0, 0.5)", height: "fit-content" }}
          />
        )}
      </div>
    </div>
  );
}
