import { CheckCircle2, ListFilter, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Avatar from "../components/Avatar";
import LibraryFiltersPanel, { LibraryFilterChips, useLibraryActiveFilterCount } from "../components/LibraryFiltersPanel";
import Pagination from "../components/Pagination";
import PageHeader from "../components/PageHeader";
import PdfViewerModal from "../components/PdfViewerModal";
import ZipExportButton from "../components/ZipExportButton";
import { LIBRARY_PAGE_SIZE_OPTIONS, useLibraryFilters, type ReportMode } from "../contexts/FiltersContext";
import { generateReportZip } from "../lib/api";
import { listClients, listCompanies, listImports, type ClientRow, type CompanyRow } from "../lib/db";
import {
  fileNameFromPath,
  formatDate,
  formatDateTime,
  formatPeriod,
  formatTimestampForFileName,
  sanitizeFileName,
} from "../lib/format";
import type { ReportZipEntry, StoredImport } from "../lib/types";
import { orAll } from "../lib/filterSets";
import { PERIOD_STATUS_OPTIONS } from "../lib/periodStatus";

const ALL_PERIOD_STATUS_IDS = PERIOD_STATUS_OPTIONS.map((o) => o.id);

/**
 * Groups the matched imports into Empresa/Cliente folders and turns them
 * into the flat entry list the Rust side needs. Always the employee's own
 * split-off PDF (`originalPdfPath`) — never the whole original source
 * file. In "per-client" mode every employee's PDF under a client is merged
 * (via `pdfunite`, on the Rust side) into one consolidated document. Skips
 * anything without a client link (nothing to organize it under), which is a
 * distinct, narrower condition than the table filters above — an import can
 * be worth browsing without being zip-able.
 */
function buildZipEntries(imports: StoredImport[], mode: ReportMode): ReportZipEntry[] {
  const byCompany = new Map<string, Map<string, StoredImport[]>>();
  for (const imp of imports) {
    if (!imp.clientId || !imp.clientName) continue;
    const companyFolder = sanitizeFileName(imp.companyName);
    const clientFolder = sanitizeFileName(imp.clientName);
    let byClient = byCompany.get(companyFolder);
    if (!byClient) {
      byClient = new Map();
      byCompany.set(companyFolder, byClient);
    }
    const list = byClient.get(clientFolder) ?? [];
    list.push(imp);
    byClient.set(clientFolder, list);
  }

  const entries: ReportZipEntry[] = [];
  for (const [companyFolder, byClient] of byCompany) {
    for (const [clientFolder, clientImports] of byClient) {
      const sorted = [...clientImports].sort((a, b) => a.employeeName.localeCompare(b.employeeName));
      if (mode === "per-client") {
        entries.push({
          zipPath: `${companyFolder}/${clientFolder}/${clientFolder} - Consolidado.pdf`,
          sourcePdfPaths: sorted.map((imp) => imp.originalPdfPath),
        });
      } else {
        for (const imp of sorted) {
          const periodLabel = sanitizeFileName(formatPeriod(imp.periodStart, imp.periodEnd));
          entries.push({
            zipPath: `${companyFolder}/${clientFolder}/${sanitizeFileName(imp.employeeName)} - ${periodLabel}.pdf`,
            sourcePdfPaths: [imp.originalPdfPath],
          });
        }
      }
    }
  }
  return entries;
}

const FILTERS_OPEN_KEY = "library-filters-open";

function readFiltersOpen(): boolean {
  try {
    return localStorage.getItem(FILTERS_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export default function LibraryPage() {
  const {
    selectedEmployeeIds,
    selectedCompanyIds,
    selectedClientIds,
    periodStart,
    periodEnd,
    selectedStatuses,
    mode,
    setMode,
    page,
    setPage,
    pageSize,
    setPageSize,
  } = useLibraryFilters();

  const [imports, setImports] = useState<StoredImport[]>([]);
  const [total, setTotal] = useState(0);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewerImport, setViewerImport] = useState<StoredImport | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedZipPath, setGeneratedZipPath] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(readFiltersOpen);
  const activeFilterCount = useLibraryActiveFilterCount();

  function toggleFilters(open: boolean) {
    setFiltersOpen(open);
    try {
      localStorage.setItem(FILTERS_OPEN_KEY, open ? "1" : "0");
    } catch {
      /* only a convenience */
    }
  }

  useEffect(() => {
    Promise.all([listCompanies(), listClients()]).then(([companyRows, clientRows]) => {
      setCompanies(companyRows);
      setClients(clientRows);
    });
  }, []);

  // The table itself — filtered and paginated in SQL, not in memory.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listImports({
      employeeIds: Array.from(selectedEmployeeIds, Number),
      companyIds: Array.from(selectedCompanyIds, Number),
      clientIds: Array.from(selectedClientIds, Number),
      periodStart,
      periodEnd,
      statuses: orAll(selectedStatuses, ALL_PERIOD_STATUS_IDS),
      page,
      pageSize,
    })
      .then(({ rows, total: rowTotal }) => {
        if (cancelled) return;
        setImports(rows);
        setTotal(rowTotal);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedEmployeeIds, selectedCompanyIds, selectedClientIds, periodStart, periodEnd, selectedStatuses, page, pageSize]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // Zip generation needs every matching import, not just the current page
  // — a dedicated unpaginated fetch (same filters) rather than reusing
  // `imports`, which now only ever holds one page's worth.
  async function handleGenerateZip() {
    setError(null);
    setGeneratedZipPath(null);
    setBusy(true);
    try {
      const { rows: allMatching } = await listImports({
        employeeIds: Array.from(selectedEmployeeIds, Number),
        companyIds: Array.from(selectedCompanyIds, Number),
        clientIds: Array.from(selectedClientIds, Number),
        periodStart,
        periodEnd,
        statuses: orAll(selectedStatuses, ALL_PERIOD_STATUS_IDS),
      });
      const entries = buildZipEntries(allMatching, mode);
      if (entries.length === 0) return;

      // The browser downloads the zip (no save dialog on the web).
      const fileName = `relatorio-${formatTimestampForFileName()}.zip`;
      await generateReportZip(entries, fileName);
      setGeneratedZipPath(fileName);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Cartão Ponto"
        subtitle="Espelhos de ponto importados, organizados em pastas por empresa e cliente."
        actions={<ZipExportButton mode={mode} onModeChange={setMode} onGenerate={handleGenerateZip} busy={busy} total={loading ? null : total} />}
      />

      {error && <div className="error-box">{error}</div>}

      <div className="library-bar">
        <button
          type="button"
          className={filtersOpen ? "library-filters-button library-filters-button-on" : "library-filters-button"}
          aria-expanded={filtersOpen}
          onClick={() => toggleFilters(!filtersOpen)}
        >
          <ListFilter size={15} />
          Filtros
          {activeFilterCount > 0 && <span className="library-filters-count">{activeFilterCount}</span>}
        </button>
        <span className="library-bar-sep" aria-hidden="true" />
        <LibraryFilterChips companies={companies} clients={clients} onOpen={() => toggleFilters(true)} />
        <span className="library-bar-count">
          {!loading && (
            <>
              <b>{total}</b> {total === 1 ? "espelho" : "espelhos"}
            </>
          )}
        </span>
      </div>

      {generatedZipPath && (
        <div className="success-box library-zip-done">
          <CheckCircle2 size={16} />
          <span>Zip gerado: {fileNameFromPath(generatedZipPath)}</span>
          <button type="button" className="ghost library-zip-done-close" aria-label="Fechar aviso" onClick={() => setGeneratedZipPath(null)}>
            <X size={15} />
          </button>
        </div>
      )}

      <div className="card table-card">
        {loading && imports.length === 0 && <p className="muted" style={{ padding: "1.4rem" }}>Carregando...</p>}
        {!loading && total === 0 && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhum resultado para os filtros selecionados. Considere ajustar os filtros ou{" "}
            <Link to="/import/timesheet">importar um novo PDF</Link>.
          </p>
        )}
        {total > 0 && (
          <>
            <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Colaborador</th>
                  <th>Empresa</th>
                  <th>Período</th>
                  <th>Importado em</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {imports.map((imp) => (
                  <tr key={imp.importId}>
                    <td>
                      <div className="person-cell">
                        <Avatar name={imp.employeeName} />
                        <Link to={`/employee/${imp.importId}`}>{imp.employeeName}</Link>
                      </div>
                    </td>
                    <td>{imp.companyName}</td>
                    <td>
                      {formatDate(imp.periodStart)} a {formatDate(imp.periodEnd)}
                    </td>
                    <td>{formatDateTime(imp.importedAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setViewerImport(imp)}
                        title="Ver o PDF deste colaborador"
                      >
                        PDF
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>

            <Pagination
              page={page}
              pageCount={pageCount}
              onPageChange={setPage}
              rangeLabel={`Mostrando ${page * pageSize + 1} a ${Math.min(
                total,
                page * pageSize + pageSize,
              )} de ${total} registros`}
              pageSize={pageSize}
              pageSizeOptions={LIBRARY_PAGE_SIZE_OPTIONS}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(0);
              }}
            />
          </>
        )}
      </div>

      <PdfViewerModal
        path={viewerImport?.originalPdfPath ?? null}
        title={viewerImport ? `${viewerImport.employeeName} — ${formatDate(viewerImport.periodStart)} a ${formatDate(viewerImport.periodEnd)}` : undefined}
        onClose={() => setViewerImport(null)}
      />

      <LibraryFiltersPanel
        open={filtersOpen}
        onClose={() => toggleFilters(false)}
        companies={companies}
        clients={clients}
      />
    </div>
  );
}
