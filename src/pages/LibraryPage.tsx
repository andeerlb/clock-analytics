import { save } from "@tauri-apps/plugin-dialog";
import { Archive, CheckCircle2, Filter, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Avatar from "../components/Avatar";
import LibraryFiltersDrawer, { type LibraryFiltersValue } from "../components/LibraryFiltersDrawer";
import Pagination from "../components/Pagination";
import PdfViewerModal from "../components/PdfViewerModal";
import { LIBRARY_PAGE_SIZE_OPTIONS, useLibraryFilters, type ReportMode } from "../contexts/FiltersContext";
import { generateReportZip, revealInFileManager } from "../lib/api";
import { listClients, listCompanies, listImports, type ClientRow, type CompanyRow } from "../lib/db";
import {
  fileNameFromPath,
  formatDate,
  formatDateTime,
  formatPeriod,
  formatTimestampForFileName,
  sanitizeFileName,
} from "../lib/format";
import { PERIOD_STATUS_OPTIONS } from "../lib/periodStatus";
import type { ReportZipEntry, StoredImport } from "../lib/types";

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

export default function LibraryPage() {
  const {
    selectedEmployeeIds,
    setSelectedEmployeeIds,
    selectedCompanyIds,
    setSelectedCompanyIds,
    selectedClientIds,
    setSelectedClientIds,
    periodStart,
    periodEnd,
    setPeriod,
    selectedStatuses,
    setSelectedStatuses,
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
  const [filtersDrawerOpen, setFiltersDrawerOpen] = useState(false);

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
      statuses: Array.from(selectedStatuses),
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

  /** Applied from the "Filtros" Drawer — every field commits together, same as Pagamentos' own `handleApplyFilters`. */
  function handleApplyFilters(next: LibraryFiltersValue) {
    setSelectedEmployeeIds(next.employeeIds);
    setSelectedCompanyIds(next.companyIds);
    setSelectedClientIds(next.clientIds);
    setPeriod(next.periodStart, next.periodEnd);
    setSelectedStatuses(next.statuses);
    setPage(0);
    setFiltersDrawerOpen(false);
  }

  /** How many filter categories are currently applied — shown as a count badge on the "Filtros" button, same as Pagamentos. Período is excluded since it always defaults to the current month rather than "empty". */
  const activeFilterCount = [
    selectedEmployeeIds.size > 0,
    selectedCompanyIds.size > 0,
    selectedClientIds.size > 0,
    selectedStatuses.size < PERIOD_STATUS_OPTIONS.length,
  ].filter(Boolean).length;

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  async function handleReveal(path: string) {
    try {
      await revealInFileManager(path);
    } catch (e) {
      setError(String(e));
    }
  }

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
        statuses: Array.from(selectedStatuses),
      });
      const entries = buildZipEntries(allMatching, mode);
      if (entries.length === 0) return;

      const destPath = await save({
        defaultPath: `relatorio-${formatTimestampForFileName()}.zip`,
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (!destPath) return;
      await generateReportZip(entries, destPath);
      setGeneratedZipPath(destPath);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>Cartão Ponto</h2>
      </div>
      <p className="page-subtitle">
        Espelhos de ponto importados — filtre e gere um zip com os PDFs de cada colaborador,
        organizados em pastas por empresa e cliente.
      </p>

      {error && <div className="error-box">{error}</div>}

      <div className="card">
        <div className="field-row" style={{ marginBottom: 0, alignItems: "center" }}>
          <button type="button" className="secondary" onClick={() => setFiltersDrawerOpen(true)}>
            <Filter size={15} style={{ marginRight: "0.4rem" }} />
            {activeFilterCount > 0 ? `Filtros (${activeFilterCount})` : "Filtros"}
          </button>
          <div style={{ marginLeft: "auto", display: "flex", gap: "0.6rem", alignItems: "center" }}>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as ReportMode)}
              title="Modo de geração do zip"
            >
              <option value="per-employee">Um PDF por colaborador</option>
              <option value="per-client">Um PDF por cliente</option>
            </select>
            <button type="button" onClick={handleGenerateZip} disabled={busy || total === 0}>
              <Archive size={15} style={{ marginRight: "0.4rem" }} />
              {busy ? "Gerando..." : "Gerar zip"}
            </button>
          </div>
        </div>

        {generatedZipPath && (
          <div
            className="success-box"
            style={{
              marginTop: "1rem",
              marginBottom: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "1rem",
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <CheckCircle2 size={16} />
              Zip gerado com sucesso: {fileNameFromPath(generatedZipPath)}
            </span>
            <button type="button" className="outline" onClick={() => handleReveal(generatedZipPath)}>
              <FolderOpen size={15} style={{ marginRight: "0.4rem" }} />
              Abrir no explorador de arquivos
            </button>
          </div>
        )}
      </div>

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

      <LibraryFiltersDrawer
        open={filtersDrawerOpen}
        onClose={() => setFiltersDrawerOpen(false)}
        value={{ employeeIds: selectedEmployeeIds, companyIds: selectedCompanyIds, clientIds: selectedClientIds, periodStart, periodEnd, statuses: selectedStatuses }}
        onApply={handleApplyFilters}
        companies={companies}
        clients={clients}
      />
    </div>
  );
}
