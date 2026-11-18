import { Copy, Download, ExternalLink, FolderOpen, History, Link2, RotateCcw, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { countImportFiles, listImportFiles, type ImportFileCounts } from "../lib/db";
import { downloadServerFile } from "../lib/files";
import { parseSqliteDateTime, safeDecodeFileName } from "../lib/format";
import type { ImportFileRow, ImportStatus, ImportType } from "../lib/types";
import Drawer from "./Drawer";

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 250;
const SHORT_MONTHS = ["jan.", "fev.", "mar.", "abr.", "maio", "jun.", "jul.", "ago.", "set.", "out.", "nov.", "dez."];

type HistoryFilter = "all" | "link" | "local" | "problems";

const STATUS: Record<ImportStatus, { color: string; label: string }> = {
  success: { color: "var(--success)", label: "Sucesso" },
  warning: { color: "var(--warning)", label: "Com avisos" },
  error: { color: "var(--danger)", label: "Erro" },
};

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Hoje", "Ontem", "30 de out." (with the year when it isn't the current one). */
function dayLabel(d: Date): string {
  const now = new Date();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return "Hoje";
  if (days === 1) return "Ontem";
  return `${d.getDate()} de ${SHORT_MONTHS[d.getMonth()]}${d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function extKind(name: string): { ext: string; kind: string } {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (ext === "pdf") return { ext: "PDF", kind: "pdf" };
  if (ext === "csv") return { ext: "CSV", kind: "csv" };
  return { ext: ext.toUpperCase().slice(0, 4) || "ARQ", kind: "sheet" };
}

/**
 * "Histórico de importações" for one import flow, in the standard side sheet:
 * search (file name or template/provider), filter chips with counts, the list
 * grouped by day with sticky day headers, and infinite scroll (20 at a time).
 * Hovering a row shows its actions: copy/open the link and `onReuseUrl` for a
 * URL import, or "Mostrar na pasta" when a local copy was kept.
 */
export default function ImportHistoryDrawer({
  open,
  onClose,
  importType,
  onReuseUrl,
}: {
  open: boolean;
  onClose: () => void;
  importType: ImportType;
  /** Puts a URL import's link back in the form (only offered when given). */
  onReuseUrl?: (url: string) => void;
}) {
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [rows, setRows] = useState<ImportFileRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [counts, setCounts] = useState<ImportFileCounts | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  // Fresh counts and first page every time the sheet opens.
  useEffect(() => {
    if (!open) return;
    countImportFiles(importType).then(setCounts).catch(() => {});
  }, [open, importType]);

  useEffect(() => {
    setPage(0);
  }, [filter, debouncedSearch, open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    listImportFiles({
      importType,
      search: debouncedSearch,
      source: filter === "link" || filter === "local" ? filter : undefined,
      problemsOnly: filter === "problems",
      page,
      pageSize: PAGE_SIZE,
    })
      .then(({ rows: next, total: t }) => {
        if (cancelled) return;
        setRows((prev) => (page === 0 ? next : [...prev, ...next]));
        setTotal(t);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, importType, filter, debouncedSearch, page]);

  const hasMore = rows.length < total;
  const loadMore = useCallback(() => {
    if (!loading && hasMore) setPage((p) => p + 1);
  }, [loading, hasMore]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!open || !sentinel || !hasMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore();
    }, { rootMargin: "120px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [open, hasMore, loadMore, rows.length]);

  function copyLink(row: ImportFileRow) {
    if (!row.sourceUrl) return;
    navigator.clipboard
      .writeText(row.sourceUrl)
      .then(() => {
        setCopiedId(row.id);
        setTimeout(() => setCopiedId((id) => (id === row.id ? null : id)), 1400);
      })
      .catch(() => {});
  }

  const chips: { id: HistoryFilter; label: string; count: number | undefined; dot?: string }[] = [
    { id: "all", label: "Todos", count: counts?.total },
    ...(counts && counts.link > 0 ? [{ id: "link" as const, label: "Por link", count: counts.link }] : []),
    ...(counts && counts.link > 0 ? [{ id: "local" as const, label: "Arquivo local", count: counts.local }] : []),
    { id: "problems", label: "Com problema", count: counts?.problems, dot: "var(--danger)" },
  ];

  // Day headers count every match of that day, not just the loaded ones —
  // unknown until the whole day is loaded, so only shown once it is.
  let lastDay: number | null = null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Histórico de importações"
      icon={History}
      subtitle={
        counts ? `${counts.total} ${counts.total === 1 ? "arquivo importado" : "arquivos importados"}` : undefined
      }
      className="history-drawer"
      toolbar={
        <div className="history-tools">
          <label className={`preview-search history-search${search ? " preview-search-has-value" : ""}`}>
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por arquivo ou template"
              aria-label="Buscar por arquivo ou template"
            />
            {search && (
              <button
                type="button"
                className="preview-search-clear"
                aria-label="Limpar busca"
                onClick={() => {
                  setSearch("");
                  searchRef.current?.focus();
                }}
              >
                <X size={13} />
              </button>
            )}
          </label>
          <div className="preview-chips">
            {chips.map((chip) => (
              <button
                key={chip.id}
                type="button"
                className="preview-chip"
                aria-pressed={filter === chip.id}
                onClick={() => setFilter(chip.id)}
              >
                {chip.dot && <span className="preview-chip-dot" style={{ background: chip.dot }} />}
                {chip.label}
                {chip.count !== undefined && <b>{chip.count}</b>}
              </button>
            ))}
          </div>
        </div>
      }
      footer={
        <span className="history-footer">
          {total > 0 ? `Mostrando ${rows.length} de ${total}` : ""}
          {hasMore && <span>Role para carregar mais</span>}
        </span>
      }
    >
      <div className="history-list" role="list">
        {rows.map((row) => {
          const date = parseSqliteDateTime(row.importedAt);
          const day = startOfDay(date);
          const header = day !== lastDay ? <div className="history-day">{dayLabel(date)}</div> : null;
          lastDay = day;
          const name = safeDecodeFileName(row.fileName);
          const { ext, kind } = extKind(name);
          const status = STATUS[row.status];
          const canDownload = !row.sourceUrl && Boolean(row.originalPdfPath);
          return (
            <div key={row.id}>
              {header}
              <div className="history-row" role="listitem" tabIndex={0}>
                <span className={`history-ext history-ext-${kind}`}>{ext}</span>
                <div className="history-info">
                  <div className="history-name" title={name}>
                    {name}
                  </div>
                  <div className="history-meta">
                    <span className="history-src">
                      {row.sourceUrl ? <Link2 size={12} /> : <FolderOpen size={12} />}
                      {row.sourceUrl ? hostOf(row.sourceUrl) : "local"}
                    </span>
                    {row.provider && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="history-provider" title={row.provider}>
                          {row.provider}
                        </span>
                      </>
                    )}
                  </div>
                  {row.status !== "success" && row.errorMessage && (
                    <div className={`history-msg history-msg-${row.status}`} title={row.errorMessage}>
                      {row.errorMessage}
                    </div>
                  )}
                </div>
                <div className="history-right">
                  <span className="history-time">
                    {date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span className="history-actions">
                    {row.sourceUrl && (
                      <>
                        <button
                          type="button"
                          className="history-action"
                          title={copiedId === row.id ? "Copiado" : "Copiar link"}
                          aria-label="Copiar link"
                          onClick={() => copyLink(row)}
                        >
                          <Copy size={13} />
                        </button>
                        <button
                          type="button"
                          className="history-action"
                          title="Abrir link"
                          aria-label="Abrir link"
                          onClick={() => window.open(row.sourceUrl!, "_blank", "noopener")}
                        >
                          <ExternalLink size={13} />
                        </button>
                        {onReuseUrl && (
                          <button
                            type="button"
                            className="history-action"
                            title="Usar este link de novo"
                            aria-label="Usar este link de novo"
                            onClick={() => {
                              onReuseUrl(row.sourceUrl!);
                              onClose();
                            }}
                          >
                            <RotateCcw size={13} />
                          </button>
                        )}
                      </>
                    )}
                    {canDownload && (
                      // "Mostrar na pasta" on the desktop; on the web the stored file is downloaded instead.
                      <button
                        type="button"
                        className="history-action"
                        title="Baixar"
                        aria-label="Baixar"
                        onClick={() => downloadServerFile(row.originalPdfPath, name).catch(() => {})}
                      >
                        <Download size={13} />
                      </button>
                    )}
                  </span>
                  <span className="history-status" style={{ background: status.color }} title={status.label} aria-label={status.label} />
                </div>
              </div>
            </div>
          );
        })}

        {!loading && rows.length === 0 && (
          <p className="history-empty">
            {debouncedSearch
              ? `Nenhum arquivo com “${debouncedSearch}”.`
              : filter === "all"
                ? "Nenhum arquivo importado ainda."
                : "Nada neste filtro."}
          </p>
        )}
        {hasMore && (
          <div ref={sentinelRef} className="history-loader">
            <span className="history-spinner" aria-hidden="true" />
            Carregando…
          </div>
        )}
        {!hasMore && rows.length > 0 && <div className="history-end">Fim do histórico</div>}
      </div>
    </Drawer>
  );
}
