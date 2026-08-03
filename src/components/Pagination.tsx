import { ChevronLeft, ChevronRight } from "lucide-react";

interface PaginationProps {
  /** 0-indexed current page */
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  /** e.g. "Mostrando 1 a 10 de 23" */
  rangeLabel: string;
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

export default function Pagination({ page, pageCount, onPageChange, rangeLabel }: PaginationProps) {
  return (
    <div className="pagination">
      <span className="muted">{rangeLabel}</span>
      <div className="pagination-controls">
        <button
          type="button"
          className="secondary"
          disabled={page === 0}
          onClick={() => onPageChange(Math.max(0, page - 1))}
          aria-label="Página anterior"
        >
          <ChevronLeft size={16} />
        </button>
        <div className="pagination-pages">
          {pageWindow(page, pageCount).map((p) => (
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
          disabled={page >= pageCount - 1}
          onClick={() => onPageChange(Math.min(pageCount - 1, page + 1))}
          aria-label="Próxima página"
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
