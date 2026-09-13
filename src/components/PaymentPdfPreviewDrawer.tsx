import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

const RENDER_SCALE = 1.5;

/**
 * In-editor preview: renders freshly generated PDF bytes (from
 * `buildPaymentPdfPreviewBytes` — the template drawn with FAKE data) in an
 * embedded panel, so the user checks layout, colors, grouping and orientation
 * while editing. Much simpler than `PdfViewerModal` on purpose: preview
 * documents are tiny (a handful of fake turnos), so every page renders
 * eagerly onto its own canvas — no lazy intersection-observer machinery, no
 * download/reveal actions (there's no file on disk to reveal).
 */
export default function PaymentPdfPreviewDrawer({
  bytes,
}: {
  /** A NEW array identity re-renders the preview. */
  bytes: Uint8Array | null;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!bytes) {
      setDoc(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDoc(null);
    // pdf.js transfers the buffer — hand it a copy so the caller's array (and
    // any later preview built from fresh bytes) stays intact.
    pdfjsLib
      .getDocument({ data: new Uint8Array(bytes) })
      .promise.then((pdf) => {
        if (!cancelled) setDoc(pdf);
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
  }, [bytes]);

  useEffect(() => {
    if (!doc || !containerRef.current) return;
    let cancelled = false;
    const container = containerRef.current;
    (async () => {
      for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
        if (cancelled) return;
        const page = await doc.getPage(pageNum);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: RENDER_SCALE });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = "100%";
        canvas.style.maxWidth = `${viewport.width}px`;
        canvas.style.background = "#ffffff";
        canvas.style.borderRadius = "4px";
        canvas.style.boxShadow = "0 1px 6px rgba(0,0,0,.25)";
        container.appendChild(canvas);
        await page.render({ canvas, viewport }).promise;
      }
    })();
    return () => {
      cancelled = true;
      container.replaceChildren();
    };
  }, [doc]);

  return (
    <section className="pdf-preview-panel" aria-label="Pré-visualização do PDF">
      <h3>Pré-visualização</h3>
      <p className="muted" style={{ marginTop: 0, lineHeight: 1.5 }}>
        Como o PDF vai sair — gerado com <strong>dados de exemplo</strong> (3 colaboradores, 7
        turnos), passando pelo mesmo renderizador da exportação real.
      </p>
      {!bytes && <p className="muted">Marque uma linha como Linha do Turno para visualizar o PDF.</p>}
      {error && <div className="error-box">{error}</div>}
      {loading && <p className="muted">Renderizando...</p>}
      <div ref={containerRef} style={{ display: "grid", gap: "1rem", justifyItems: "center" }} />
      {!loading && !error && doc && (
        <p className="muted" style={{ fontSize: "0.8rem", marginBottom: 0 }}>
          {doc.numPages} página(s)
        </p>
      )}
    </section>
  );
}
