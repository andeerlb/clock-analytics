import { save } from "@tauri-apps/plugin-dialog";
import { Archive, Building2, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import DatePicker from "../components/DatePicker";
import MultiSelectDropdown from "../components/MultiSelectDropdown";
import Pagination from "../components/Pagination";
import { generateReportZip } from "../lib/api";
import { listClients, listCompanies, listImports, type ClientRow, type CompanyRow } from "../lib/db";
import { formatPeriod, sanitizeFileName } from "../lib/format";
import type { ReportZipEntry, StoredImport } from "../lib/types";

type Mode = "per-employee" | "per-client";

type PeriodStatusId = "overtime" | "absence" | "regular" | "no-punch" | "interval";

/**
 * Mirrors the Cartão de Ponto's per-day status filter, but at the whole
 * import's (fixed) period level, reading the aggregates stored at import
 * time instead of recomputing anything — this screen is a filter over
 * reports that already exist, not a new one being calculated live.
 */
const PERIOD_STATUS_OPTIONS: { id: PeriodStatusId; label: string; matches: (imp: StoredImport) => boolean }[] = [
  { id: "overtime", label: "Horas extras no período", matches: (i) => i.overtimeMinutes > 0 },
  { id: "absence", label: "Horas faltas no período", matches: (i) => i.absenceMinutes > 0 },
  { id: "regular", label: "Com horas regulares no período", matches: (i) => i.regularMinutes > 0 },
  { id: "no-punch", label: "Sem nenhuma marcação no período", matches: (i) => i.totalWorkedMinutes === 0 },
  { id: "interval", label: "Com intervalo no período", matches: (i) => i.intervalMinutes > 0 },
];

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

/**
 * Groups the matched imports into Empresa/Cliente folders and turns them
 * into the flat entry list the Rust side needs. Always the employee's own
 * split-off PDF (`originalPdfPath`) — never the whole original source
 * file. In "per-client" mode every employee's PDF under a client is merged
 * (via `pdfunite`, on the Rust side) into one consolidated document.
 */
function buildZipEntries(imports: StoredImport[], mode: Mode): ReportZipEntry[] {
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

export default function ReportsPage() {
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [imports, setImports] = useState<StoredImport[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedCompanyIds, setSelectedCompanyIds] = useState<Set<string>>(new Set());
  const [selectedClientIds, setSelectedClientIds] = useState<Set<string>>(new Set());
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [selectedStatuses, setSelectedStatuses] = useState<Set<PeriodStatusId>>(
    () => new Set(PERIOD_STATUS_OPTIONS.map((o) => o.id)),
  );
  const [mode, setMode] = useState<Mode>("per-employee");

  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listCompanies(), listClients(), listImports()])
      .then(([companyRows, clientRows, importRows]) => {
        setCompanies(companyRows);
        setClients(clientRows);
        setImports(importRows);
      })
      .finally(() => setLoading(false));
  }, []);

  // `clients` has one row per (client, company) link — scope to the chosen
  // empresas (if any), then dedupe down to one option per client.
  const clientOptions = useMemo(() => {
    const scoped =
      selectedCompanyIds.size > 0
        ? clients.filter((c) => selectedCompanyIds.has(String(c.companyId)))
        : clients;
    const seen = new Map<number, ClientRow>();
    for (const c of scoped) if (!seen.has(c.id)) seen.set(c.id, c);
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [clients, selectedCompanyIds]);

  // Switching empresas changes what's even selectable — start the cliente
  // filter over rather than carry a stale, now-invisible selection.
  useEffect(() => {
    setSelectedClientIds(new Set());
  }, [selectedCompanyIds]);

  useEffect(() => {
    setPage(0);
  }, [selectedCompanyIds, selectedClientIds, periodStart, periodEnd, selectedStatuses]);

  const filteredImports = useMemo(() => {
    return imports.filter((imp) => {
      if (!imp.clientId) return false;
      if (selectedCompanyIds.size > 0 && !selectedCompanyIds.has(String(imp.companyId))) return false;
      if (selectedClientIds.size > 0 && !selectedClientIds.has(String(imp.clientId))) return false;
      if (periodStart && imp.periodEnd < periodStart) return false;
      if (periodEnd && imp.periodStart > periodEnd) return false;
      for (const opt of PERIOD_STATUS_OPTIONS) {
        if (opt.matches(imp) && !selectedStatuses.has(opt.id)) return false;
      }
      return true;
    });
  }, [imports, selectedCompanyIds, selectedClientIds, periodStart, periodEnd, selectedStatuses]);

  const pageCount = Math.max(1, Math.ceil(filteredImports.length / pageSize));
  const pageItems = useMemo(
    () => filteredImports.slice(page * pageSize, page * pageSize + pageSize),
    [filteredImports, page, pageSize],
  );

  async function handleGenerateZip() {
    const entries = buildZipEntries(filteredImports, mode);
    if (entries.length === 0) return;

    setError(null);
    setBusy(true);
    try {
      const destPath = await save({
        defaultPath: "relatorio.zip",
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (!destPath) return;
      await generateReportZip(entries, destPath);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>Relatórios</h2>
      </div>
      <p className="page-subtitle">
        Filtro sobre os espelhos de ponto já importados — gera um zip com os PDFs de cada
        colaborador, organizados em pastas por empresa e cliente.
      </p>

      {error && <div className="error-box">{error}</div>}

      <div className="card">
        <div className="field-row">
          <div className="field">
            <label>Empresa</label>
            <MultiSelectDropdown
              options={companies.map((c) => ({ id: String(c.id), label: c.name }))}
              selected={selectedCompanyIds}
              onToggle={(id) =>
                setSelectedCompanyIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onSelectAll={() => setSelectedCompanyIds(new Set(companies.map((c) => String(c.id))))}
              onSelectNone={() => setSelectedCompanyIds(new Set())}
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
              onToggle={(id) =>
                setSelectedClientIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onSelectAll={() => setSelectedClientIds(new Set(clientOptions.map((c) => String(c.id))))}
              onSelectNone={() => setSelectedClientIds(new Set())}
              icon={Users}
              allLabel="Todos os clientes"
              noneLabel="Todos os clientes"
              countLabel={(n, total) => `${n} de ${total} clientes`}
            />
          </div>
          <div className="field">
            <label htmlFor="start">De</label>
            <DatePicker id="start" value={periodStart} onChange={setPeriodStart} />
          </div>
          <div className="field">
            <label htmlFor="end">Até</label>
            <DatePicker id="end" value={periodEnd} onChange={setPeriodEnd} />
          </div>
          <div className="field">
            <label>Status no período</label>
            <MultiSelectDropdown
              options={PERIOD_STATUS_OPTIONS}
              selected={selectedStatuses}
              onToggle={(id) =>
                setSelectedStatuses((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onSelectAll={() => setSelectedStatuses(new Set(PERIOD_STATUS_OPTIONS.map((o) => o.id)))}
              onSelectNone={() => setSelectedStatuses(new Set())}
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
      </div>

      <div className="card table-card">
        {loading && <p className="muted" style={{ padding: "1.4rem" }}>Carregando...</p>}
        {!loading && filteredImports.length === 0 && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhum registro encontrado para esse filtro.
          </p>
        )}
        {filteredImports.length > 0 && (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Empresa</th>
                    <th>Cliente</th>
                    <th>Colaborador</th>
                    <th>Período</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((imp) => (
                    <tr key={imp.importId}>
                      <td>{imp.companyName}</td>
                      <td>{imp.clientName}</td>
                      <td>{imp.employeeName}</td>
                      <td>{formatPeriod(imp.periodStart, imp.periodEnd)}</td>
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
              pageSizeOptions={PAGE_SIZE_OPTIONS}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(0);
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
