import { save } from "@tauri-apps/plugin-dialog";
import { Archive, Building2, CheckCircle2, FolderOpen, Search, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import DateRangePicker from "../components/DateRangePicker";
import MultiSelectDropdown from "../components/MultiSelectDropdown";
import Pagination from "../components/Pagination";
import PdfViewerModal from "../components/PdfViewerModal";
import { LIBRARY_PAGE_SIZE_OPTIONS, useLibraryFilters, type ReportMode } from "../contexts/FiltersContext";
import { generateReportZip, revealInFileManager } from "../lib/api";
import { colorForName, initials } from "../lib/avatar";
import { listClients, listCompanies, listImports, type ClientRow, type CompanyRow } from "../lib/db";
import {
  fileNameFromPath,
  formatDate,
  formatDateTime,
  formatPeriod,
  formatTimestampForFileName,
  sanitizeFileName,
} from "../lib/format";
import { matchesSelectedStatuses, PERIOD_STATUS_OPTIONS, type PeriodStatusId } from "../lib/periodStatus";
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
    search,
    setSearch,
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
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewerImport, setViewerImport] = useState<StoredImport | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedZipPath, setGeneratedZipPath] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listImports(), listCompanies(), listClients()])
      .then(([importsRows, companyRows, clientRows]) => {
        setImports(importsRows);
        setCompanies(companyRows);
        setClients(clientRows);
      })
      .finally(() => setLoading(false));
  }, []);

  // `listClients` has one row per (client, company) link — scope to the
  // chosen empresas (if any), then dedupe down to one option per client.
  const clientOptions = useMemo(() => {
    const scoped =
      selectedCompanyIds.size > 0
        ? clients.filter((c) => selectedCompanyIds.has(String(c.companyId)))
        : clients;
    const seen = new Map<number, ClientRow>();
    for (const c of scoped) if (!seen.has(c.id)) seen.set(c.id, c);
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [clients, selectedCompanyIds]);

  // Each setter below resets whatever it invalidates itself (rather than
  // reacting via an effect), so a filter restored as-is from
  // `FiltersProvider` on remount never gets treated as a "change": empresa
  // narrows cliente, and any of these resets back to page 1.
  function updateSearch(v: string) {
    setSearch(v);
    setPage(0);
  }
  function updateSelectedCompanyIds(next: Set<string>) {
    setSelectedCompanyIds(next);
    setSelectedClientIds(new Set());
    setPage(0);
  }
  function toggleCompany(id: string) {
    const next = new Set(selectedCompanyIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    updateSelectedCompanyIds(next);
  }
  function updateSelectedClientIds(next: Set<string>) {
    setSelectedClientIds(next);
    setPage(0);
  }
  function toggleClient(id: string) {
    const next = new Set(selectedClientIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    updateSelectedClientIds(next);
  }
  function updatePeriod(s: string, e: string) {
    setPeriod(s, e);
    setPage(0);
  }
  function toggleStatus(id: PeriodStatusId) {
    setSelectedStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setPage(0);
  }
  function selectAllStatuses() {
    setSelectedStatuses(new Set(PERIOD_STATUS_OPTIONS.map((o) => o.id)));
    setPage(0);
  }
  function selectNoneStatuses() {
    setSelectedStatuses(new Set());
    setPage(0);
  }

  const filteredImports = useMemo(() => {
    const query = search.trim().toLowerCase();
    return imports.filter((imp) => {
      if (selectedCompanyIds.size > 0 && !selectedCompanyIds.has(String(imp.companyId))) return false;
      if (selectedClientIds.size > 0 && !selectedClientIds.has(String(imp.clientId))) return false;
      if (query && !imp.employeeName.toLowerCase().includes(query)) {
        return false;
      }
      if (imp.periodEnd < periodStart || imp.periodStart > periodEnd) return false;
      if (!matchesSelectedStatuses(imp, selectedStatuses)) return false;
      return true;
    });
  }, [imports, search, selectedCompanyIds, selectedClientIds, periodStart, periodEnd, selectedStatuses]);

  const pageCount = Math.max(1, Math.ceil(filteredImports.length / pageSize));
  const pageItems = useMemo(
    () => filteredImports.slice(page * pageSize, page * pageSize + pageSize),
    [filteredImports, page, pageSize],
  );

  const hasFilters = Boolean(
    search ||
      selectedCompanyIds.size > 0 ||
      selectedClientIds.size > 0 ||
      selectedStatuses.size !== PERIOD_STATUS_OPTIONS.length,
  );

  async function handleReveal(path: string) {
    try {
      await revealInFileManager(path);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleGenerateZip() {
    const entries = buildZipEntries(filteredImports, mode);
    if (entries.length === 0) return;

    setError(null);
    setGeneratedZipPath(null);
    setBusy(true);
    try {
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
        <h2>Colaboradores</h2>
      </div>
      <p className="page-subtitle">
        Colaboradores com espelhos de ponto importados — filtre e gere um zip com os PDFs de cada
        um, organizados em pastas por empresa e cliente.
      </p>

      {error && <div className="error-box">{error}</div>}

      {imports.length > 0 && (
        <div className="card">
          <div className="field-row" style={{ marginBottom: 0 }}>
            <div className="field" style={{ flex: "2 1 240px" }}>
              <label htmlFor="search">Buscar</label>
              <div style={{ position: "relative" }}>
                <Search
                  size={14}
                  style={{
                    position: "absolute",
                    left: "0.65rem",
                    top: "50%",
                    transform: "translateY(-50%)",
                    color: "var(--text-muted)",
                  }}
                />
                <input
                  id="search"
                  type="text"
                  value={search}
                  onChange={(e) => updateSearch(e.target.value)}
                  placeholder="Nome do colaborador..."
                  style={{ width: "100%", paddingLeft: "2rem" }}
                />
              </div>
            </div>
            <div className="field">
              <label>Empresa</label>
              <MultiSelectDropdown
                options={companies.map((c) => ({ id: String(c.id), label: c.name }))}
                selected={selectedCompanyIds}
                onToggle={toggleCompany}
                onSelectAll={() => updateSelectedCompanyIds(new Set(companies.map((c) => String(c.id))))}
                onSelectNone={() => updateSelectedCompanyIds(new Set())}
                icon={Building2}
                allLabel="Todas as empresas"
                noneLabel="Todas as empresas"
                countLabel={(n, total) => `${n} de ${total} empresas`}
              />
            </div>
            <div className="field">
              <label>Cliente</label>
              <MultiSelectDropdown
                options={clientOptions.map((c) => ({ id: String(c.id), label: c.name }))}
                selected={selectedClientIds}
                onToggle={toggleClient}
                onSelectAll={() => updateSelectedClientIds(new Set(clientOptions.map((c) => String(c.id))))}
                onSelectNone={() => updateSelectedClientIds(new Set())}
                icon={Users}
                allLabel="Todos os clientes"
                noneLabel="Todos os clientes"
                countLabel={(n, total) => `${n} de ${total} clientes`}
              />
            </div>
            <div className="field">
              <label>Período</label>
              <DateRangePicker
                startValue={periodStart}
                endValue={periodEnd}
                onChange={updatePeriod}
                allowClear={false}
              />
            </div>
            <div className="field">
              <label>Status no período</label>
              <MultiSelectDropdown
                options={PERIOD_STATUS_OPTIONS}
                selected={selectedStatuses}
                onToggle={toggleStatus}
                onSelectAll={selectAllStatuses}
                onSelectNone={selectNoneStatuses}
                allLabel="Todos os status"
                noneLabel="Nenhum filtro selecionado"
                countLabel={(n, total) => `${n} de ${total} filtros`}
              />
            </div>
          </div>

          <div className="field-row" style={{ marginTop: "1rem", marginBottom: 0 }}>
            <div className="field">
              <label>Modo de geração</label>
              <div style={{ display: "flex", gap: "1.2rem", alignItems: "center", height: "2.5rem" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.9rem", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === "per-employee"}
                    onChange={() => setMode("per-employee")}
                  />
                  Um PDF por colaborador
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.9rem", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === "per-client"}
                    onChange={() => setMode("per-client")}
                  />
                  Um PDF por cliente
                </label>
              </div>
            </div>
            <button
              type="button"
              style={{ marginLeft: "auto" }}
              onClick={handleGenerateZip}
              disabled={busy || filteredImports.length === 0}
            >
              <Archive size={15} style={{ marginRight: "0.4rem" }} />
              {busy ? "Gerando..." : "Gerar zip"}
            </button>
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
      )}

      <div className="card table-card">
        {loading && <p className="muted" style={{ padding: "1.4rem" }}>Carregando...</p>}
        {!loading && imports.length === 0 && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhum importe ainda. <Link to="/import/timesheet">Comece importando um PDF</Link>.
          </p>
        )}
        {!loading && imports.length > 0 && filteredImports.length === 0 && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            {hasFilters ? "Nenhum colaborador encontrado para esse filtro." : "Nenhum registro."}
          </p>
        )}
        {filteredImports.length > 0 && (
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
                {pageItems.map((imp) => (
                  <tr key={imp.importId}>
                    <td>
                      <div className="person-cell">
                        <span className="avatar" style={{ background: colorForName(imp.employeeName) }}>
                          {initials(imp.employeeName)}
                        </span>
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
                filteredImports.length,
                page * pageSize + pageSize,
              )} de ${filteredImports.length} registros`}
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
    </div>
  );
}
