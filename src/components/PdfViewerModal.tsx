import { save } from "@tauri-apps/plugin-dialog";
import { ChevronLeft, ChevronRight, Download, FolderOpen, X } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import { copyPdfTo, readPdfBytes, revealInFileManager } from "../lib/api";
import { sanitizeFileName } from "../lib/format";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

const RENDER_SCALE = 1.5;

/**
 * Renders a PDF inside the app instead of handing it off to the OS's
 * default viewer — pdf.js does the rendering (onto a canvas) so this works
 * the same on every platform regardless of whatever PDF support (or lack
 * of it) the system webview has built in.
 *
 * Continuous-scroll, like Chrome's/Drive's built-in viewer: every page gets
 * its own canvas stacked in one scrollable column, rendered lazily as it
 * nears the viewport (not all 90+ pages at once) — scrolling moves through
 * the document normally, the page counter tracks whichever page is most
 * visible, and Prev/Next (or the ↑/↓ arrow keys) jump straight to a page
 * instead of just nudging the scroll position.
 */
export default function PdfViewerModal({
  path,
  title,
  allowDownload = true,
  onClose,
}: {
  /** `null` keeps the modal unmounted/closed. */
  path: string | null;
  title?: string;
  /** Hide "Baixar" — for a file whose save location the user already picked themselves (e.g. a just-generated report), where downloading a second copy would be redundant. "Ver no explorador" still makes sense there, to locate what was already saved. */
  allowDownload?: boolean;
  onClose: () => void;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pageElRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const canvasElRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const renderedPages = useRef<Set<number>>(new Set());
  // Persists across IntersectionObserver callbacks — each callback only reports
  // entries whose intersection *changed*, so the "most visible page" has to be
  // recomputed from this full accumulated map, not just the current batch.
  const intersectionRatios = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    if (!path) {
      setDoc(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDownloadError(null);
    setCurrentPage(1);
    setPageSize(null);
    renderedPages.current = new Set();
    pageElRef.current = new Map();
    canvasElRef.current = new Map();
    intersectionRatios.current = new Map();
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

  // Every page in a PDF is almost always the same size — used as a
  // placeholder for pages that haven't rendered yet, so the scrollbar
  // doesn't jump around as blank 0×0 canvases fill in while scrolling.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    doc.getPage(1).then((page) => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      setPageSize({ width: viewport.width, height: viewport.height });
    });
    return () => {
      cancelled = true;
    };
  }, [doc]);

  async function renderPage(pageNum: number) {
    if (!doc || renderedPages.current.has(pageNum)) return;
    const canvas = canvasElRef.current.get(pageNum);
    if (!canvas) return;
    renderedPages.current.add(pageNum);
    try {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvas, viewport }).promise;
    } catch {
      renderedPages.current.delete(pageNum);
    }
  }

  // Renders pages as they scroll near the viewport, and tracks whichever
  // page is currently most visible to drive the "Página X de Y" counter.
  // Gated on `pageSize`: page containers only get their real dimensions
  // (via the `minWidth`/`minHeight` below) once it's known, and only mount
  // at all once it's known — observing them any earlier would see every
  // page collapsed to ~0 height and stacked together, so the observer would
  // report all of them "intersecting" at once instead of just what's near
  // the viewport.
  useEffect(() => {
    if (!doc || !scrollRef.current || !pageSize) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNum = Number((entry.target as HTMLElement).dataset.pageNumber);
          intersectionRatios.current.set(pageNum, entry.isIntersecting ? entry.intersectionRatio : 0);
          if (entry.isIntersecting) renderPage(pageNum);
        }
        let bestPage: number | null = null;
        let bestRatio = 0;
        for (const [pageNum, ratio] of intersectionRatios.current) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestPage = pageNum;
          }
        }
        if (bestPage !== null) setCurrentPage(bestPage);
      },
      { root: scrollRef.current, rootMargin: "300px 0px", threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    for (const el of pageElRef.current.values()) observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, doc?.numPages, pageSize]);

  function goToPage(target: number) {
    if (!doc) return;
    const clamped = Math.min(Math.max(target, 1), doc.numPages);
    pageElRef.current.get(clamped)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Esc closes, same as clicking the backdrop; ↑/↓ (and PageUp/PageDown)
  // jump a page directly instead of nudging the scroll position, like a
  // dedicated PDF reader rather than a plain scrollable page.
  useEffect(() => {
    if (!path) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowDown" || e.key === "PageDown") {
        e.preventDefault();
        goToPage(currentPage + 1);
      } else if (e.key === "ArrowUp" || e.key === "PageUp") {
        e.preventDefault();
        goToPage(currentPage - 1);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, onClose, currentPage, doc]);

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

  async function handleReveal() {
    if (!path) return;
    setRevealing(true);
    setDownloadError(null);
    try {
      await revealInFileManager(path);
    } catch (e) {
      setDownloadError(String(e));
    } finally {
      setRevealing(false);
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
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage <= 1}
                aria-label="Página anterior"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="muted" style={{ fontSize: "0.85rem" }}>
                Página {currentPage} de {doc.numPages}
              </span>
              <button
                type="button"
                className="ghost"
                style={{ padding: "0.3rem" }}
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage >= doc.numPages}
                aria-label="Próxima página"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
          <button
            type="button"
            className="secondary"
            onClick={handleReveal}
            disabled={revealing || !doc}
            title="Ver no explorador de arquivos"
          >
            <FolderOpen size={15} style={{ marginRight: "0.4rem" }} />
            Ver no explorador
          </button>
          {allowDownload && (
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
          )}
          <button type="button" className="ghost" style={{ padding: "0.3rem" }} onClick={onClose} aria-label="Fechar">
            <X size={18} />
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", alignItems: "center", padding: "1.5rem", gap: "1.2rem" }}
        onClick={onClose}
      >
        {(loading || (doc && !pageSize)) && <p className="muted">Carregando...</p>}
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
        {!error &&
          doc &&
          pageSize &&
          Array.from({ length: doc.numPages }, (_, i) => i + 1).map((pageNum) => (
            <div
              key={pageNum}
              data-page-number={pageNum}
              ref={(el) => {
                if (el) pageElRef.current.set(pageNum, el);
                else pageElRef.current.delete(pageNum);
              }}
              onClick={(e) => e.stopPropagation()}
              style={{
                boxShadow: "0 10px 30px rgba(0, 0, 0, 0.5)",
                minWidth: pageSize.width,
                minHeight: pageSize.height,
                flexShrink: 0,
              }}
            >
              <canvas
                ref={(el) => {
                  if (el) canvasElRef.current.set(pageNum, el);
                  else canvasElRef.current.delete(pageNum);
                }}
                style={{ display: "block", height: "fit-content" }}
              />
            </div>
          ))}
      </div>
    </div>
  );
}
