import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

interface PaginationProps {
  /** 0-indexed current page */
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  /** e.g. "Mostrando 1 a 10 de 23" */
  rangeLabel: string;
  /** Omit all three to hide the "itens por página" selector. */
  pageSize?: number;
  pageSizeOptions?: number[];
  onPageSizeChange?: (size: number) => void;
  /** Numbered page buttons to show at once — lower this for narrow containers. */
  maxPageButtons?: number;
}

function pageWindow(page: number, pageCount: number, maxButtons = 5): number[] {
  if (pageCount <= maxButtons) return Array.from({ length: pageCount }, (_, i) => i);
  let start = Math.max(0, page - Math.floor(maxButtons / 2));
  let end = start + maxButtons;
  if (end > pageCount) {
    end = pageCount;
    start = end - maxButtons;
  }
  return Array.from({ length: maxButtons }, (_, i) => start + i);
}

export default function Pagination({
  page,
  pageCount,
  onPageChange,
  rangeLabel,
  pageSize,
  pageSizeOptions,
  onPageSizeChange,
  maxPageButtons = 5,
}: PaginationProps) {
  const atStart = page === 0;
  const atEnd = page >= pageCount - 1;

  return (
    <div className="pagination">
      <div className="pagination-info">
        <span className="muted">{rangeLabel}</span>
        {pageSize !== undefined && pageSizeOptions && onPageSizeChange && (
          <label className="pagination-page-size">
            <span className="muted">Itens por página</span>
            <select value={pageSize} onChange={(e) => onPageSizeChange(Number(e.target.value))}>
              {pageSizeOptions.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="pagination-controls">
        <button
          type="button"
          className="secondary"
          disabled={atStart}
          onClick={() => onPageChange(0)}
          aria-label="Primeira página"
        >
          <ChevronsLeft size={16} />
        </button>
        <button
          type="button"
          className="secondary"
          disabled={atStart}
          onClick={() => onPageChange(Math.max(0, page - 1))}
          aria-label="Página anterior"
        >
          <ChevronLeft size={16} />
        </button>
        <div className="pagination-pages">
          {pageWindow(page, pageCount, maxPageButtons).map((p) => (
            <button
              key={p}
              type="button"
              className={p === page ? "" : "secondary"}
              onClick={() => onPageChange(p)}
              aria-current={p === page ? "page" : undefined}
            >
              {p + 1}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="secondary"
          disabled={atEnd}
          onClick={() => onPageChange(Math.min(pageCount - 1, page + 1))}
          aria-label="Próxima página"
        >
          <ChevronRight size={16} />
        </button>
        <button
          type="button"
          className="secondary"
          disabled={atEnd}
          onClick={() => onPageChange(pageCount - 1)}
          aria-label="Última página"
        >
          <ChevronsRight size={16} />
        </button>
      </div>
    </div>
  );
}
