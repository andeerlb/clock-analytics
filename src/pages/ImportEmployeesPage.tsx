import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Eye,
  FileText,
  FolderOpen,
  ListChecks,
  PlusCircle,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Avatar from "../components/Avatar";
import Pagination from "../components/Pagination";
import { applyPaymentTemplate, hashPaymentFile, pickPaymentFiles, type AppliedPaymentRow } from "../lib/api";
import {
  createEmployeesFromImport,
  findEmployeeByAttempts,
  getEmployeeTemplate,
  listClients,
  listEmployeeTemplates,
  listImportFiles,
  logSourceFile,
  markSourceFileSaved,
  type ClientRow,
  type EmployeeImportRow,
  type EmployeeRow,
} from "../lib/db";
import { fileNameFromPath, formatCpf, formatDateTime, normalizeCpf } from "../lib/format";
import type {
  EmployeeTemplateListRow,
  EmployeeTemplateRow,
  ImportFileRow,
  ImportStatus,
  PaymentFileKind,
} from "../lib/types";

const STATUS_BADGE: Record<ImportStatus, { className: string; label: string; icon: typeof CheckCircle2 }> = {
  success: { className: "badge ok", label: "Sucesso", icon: CheckCircle2 },
  warning: { className: "badge overwrite", label: "Com alertas", icon: AlertTriangle },
  error: { className: "badge file-error", label: "Falha", icon: AlertCircle },
};

const FILE_KIND_LABELS: Record<PaymentFileKind, string> = {
  csv: "CSV",
  xlsx: "Excel (XLSX)",
  xls: "Excel (XLS)",
  ods: "ODS",
};

/**
 * Every row lands in exactly one bucket. "valid" is the only one with no
 * match against an already-registered employee, so it's the only
 * selectable category — a "duplicate" match is flagged for manual review
 * (see `/employees/:id`), never auto-created or auto-updated.
 */
type RowCategory = "valid" | "duplicate" | "duplicate-in-file" | "skipped";
type RowFilter = RowCategory | "error" | "all" | "selected";

interface EmployeePreviewRow {
  fileHash: string;
  fileName: string;
  sheetName: string | null;
  rowNumber: number;
  cpfRaw: string;
  matriculaRaw: string;
  nameRaw: string;
  /** Set only for category "duplicate" — the already-registered employee found via `findEmployeeByAttempts`. */
  match: EmployeeRow | null;
  category: RowCategory;
}

interface EmployeeFileResult {
  fileHash: string;
  fileName: string;
  rows: EmployeePreviewRow[];
  error: string | null;
}

type DisplayRow =
  | { kind: "row"; index: number; row: EmployeePreviewRow }
  | { kind: "error"; fileName: string; message: string };

const PREVIEW_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const HISTORY_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

export default function ImportEmployeesPage() {
  const navigate = useNavigate();

  const [templates, setTemplates] = useState<EmployeeTemplateListRow[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<EmployeeTemplateRow | null>(null);

  const [clients, setClients] = useState<ClientRow[]>([]);
  const [clientId, setClientId] = useState("");
  const [companyId, setCompanyId] = useState("");

  const [rowFilter, setRowFilter] = useState<RowFilter>("all");
  const [nameSearch, setNameSearch] = useState("");

  const [paths, setPaths] = useState<string[]>([]);
  const [fileHashes, setFileHashes] = useState<Map<string, { hash: string; fileName: string }>>(new Map());

  const [fileResults, setFileResults] = useState<EmployeeFileResult[]>([]);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [previewPage, setPreviewPage] = useState(0);
  const [previewPageSize, setPreviewPageSize] = useState(PREVIEW_PAGE_SIZE_OPTIONS[0]);

  const [recentFiles, setRecentFiles] = useState<ImportFileRow[]>([]);
  const [recentFilesTotal, setRecentFilesTotal] = useState(0);
  const [historySearch, setHistorySearch] = useState("");
  const [historyPage, setHistoryPage] = useState(0);
  const [historyPageSize, setHistoryPageSize] = useState(HISTORY_PAGE_SIZE_OPTIONS[0]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    listEmployeeTemplates().then(setTemplates);
    listClients().then(setClients);
  }, []);

  // History panel — filtered and paginated in SQL, not in memory.
  useEffect(() => {
    refreshRecentFiles();
  }, [historySearch, historyPage, historyPageSize]);

  function refreshRecentFiles() {
    listImportFiles({ importType: "employee", search: historySearch, page: historyPage, pageSize: historyPageSize }).then(
      ({ rows, total }) => {
        setRecentFiles(rows);
        setRecentFilesTotal(total);
      },
    );
  }

  useEffect(() => {
    if (paths.length === 0) {
      setFileHashes(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(paths.map((p) => hashPaymentFile(p)));
      if (cancelled) return;
      setFileHashes(new Map(entries.map((e) => [e.path, { hash: e.hash, fileName: e.fileName }])));
    })();
    return () => {
      cancelled = true;
    };
  }, [paths]);

  useEffect(() => {
    if (!templateId) {
      setSelectedTemplate(null);
      return;
    }
    let cancelled = false;
    getEmployeeTemplate(Number(templateId)).then((t) => {
      if (!cancelled) setSelectedTemplate(t);
    });
    return () => {
      cancelled = true;
    };
  }, [templateId]);

  // `clients` has one row per (client, company) link, so grab the first
  // match just for the client's own identity (name/cnpj) — those are the
  // same across every row for a given client.
  const selectedClient = useMemo(() => clients.find((c) => String(c.id) === clientId) ?? null, [clients, clientId]);

  // Every company the selected client is linked to — this is what the
  // "Empresa" select offers, since a client can be tied to more than one.
  const clientCompanies = useMemo(() => clients.filter((c) => String(c.id) === clientId), [clients, clientId]);

  // Auto-select the company when the client only has one; otherwise force
  // an explicit choice (and clear any stale choice from a previous client).
  useEffect(() => {
    if (clientCompanies.length === 1) {
      setCompanyId(String(clientCompanies[0].companyId));
    } else {
      setCompanyId("");
    }
  }, [clientCompanies]);

  function addPaths(newPaths: string[]) {
    setPaths((prev) => Array.from(new Set([...prev, ...newPaths])));
    cancelPreview();
    setSuccessMessage(null);
  }

  function removePath(path: string) {
    setPaths((prev) => prev.filter((p) => p !== path));
  }

  function cancelPreview() {
    setFileResults([]);
    setSelectedRows(new Set());
    setPreviewPage(0);
    setRowFilter("all");
    setNameSearch("");
  }

  function reset() {
    setPaths([]);
    cancelPreview();
    setError(null);
  }

  async function handlePick() {
    if (!selectedTemplate) return;
    setError(null);
    const selected = await pickPaymentFiles([selectedTemplate.fileKind]);
    if (selected.length === 0) return;

    // The OS dialog is already filtered to the template's format, but
    // that's a soft filter on some platforms — checked again here so a
    // mismatched file never silently gets treated as if it matched.
    const suffix = `.${selectedTemplate.fileKind}`;
    const valid = selected.filter((p) => p.toLowerCase().endsWith(suffix));
    const invalid = selected.filter((p) => !p.toLowerCase().endsWith(suffix));
    if (invalid.length > 0) {
      setError(
        `O template "${selectedTemplate.name}" espera arquivos ${FILE_KIND_LABELS[selectedTemplate.fileKind]}. Ignorado(s) por formato incompatível: ${invalid.map(fileNameFromPath).join(", ")}`,
      );
    }
    if (valid.length > 0) addPaths(valid);
  }

  const employeeRows = useMemo(() => fileResults.flatMap((r) => r.rows), [fileResults]);
  const employeeRowFileHash = useMemo(() => fileResults.flatMap((r) => r.rows.map(() => r.fileHash)), [fileResults]);

  const previewRows = useMemo(() => {
    const query = nameSearch.trim().toLowerCase();
    const out: DisplayRow[] = [];
    let idx = 0;
    for (const result of fileResults) {
      if (result.error) {
        if (!query && (rowFilter === "all" || rowFilter === "error")) {
          out.push({ kind: "error", fileName: result.fileName, message: result.error });
        }
        continue;
      }
      for (const row of result.rows) {
        const matchesFilter =
          rowFilter === "all" || (rowFilter === "selected" ? selectedRows.has(idx) : rowFilter === row.category);
        const matchesName = !query || row.nameRaw.toLowerCase().includes(query);
        if (matchesFilter && matchesName) out.push({ kind: "row", index: idx, row });
        idx++;
      }
    }
    return out;
  }, [fileResults, rowFilter, selectedRows, nameSearch]);

  const categoryCounts = useMemo(() => {
    const counts: Record<RowCategory, number> = { valid: 0, duplicate: 0, "duplicate-in-file": 0, skipped: 0 };
    for (const r of employeeRows) counts[r.category]++;
    return counts;
  }, [employeeRows]);

  const errorCount = fileResults.filter((r) => r.error).length;
  const duplicateCount = categoryCounts.duplicate;
  const duplicateInFileCount = categoryCounts["duplicate-in-file"];
  const skippedCount = categoryCounts.skipped;

  const previewPageCount = Math.max(1, Math.ceil(previewRows.length / previewPageSize));
  const previewPageItems = useMemo(
    () => previewRows.slice(previewPage * previewPageSize, previewPage * previewPageSize + previewPageSize),
    [previewRows, previewPage, previewPageSize],
  );

  const isSelectable = (r: EmployeePreviewRow) => r.category === "valid";
  const selectableCount = employeeRows.filter(isSelectable).length;
  const allSelected = selectableCount > 0 && employeeRows.every((r, i) => selectedRows.has(i) || !isSelectable(r));

  function toggleRowFilter(category: RowFilter) {
    setRowFilter((prev) => (prev === category ? "all" : category));
    setPreviewPage(0);
  }

  function toggleRow(index: number) {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function toggleAll() {
    if (allSelected) {
      setSelectedRows(new Set());
    } else {
      setSelectedRows(new Set(employeeRows.flatMap((r, i) => (isSelectable(r) ? [i] : []))));
    }
  }

  const historyPageCount = Math.max(1, Math.ceil(recentFilesTotal / historyPageSize));

  async function handleProcess() {
    if (!selectedTemplate || !selectedClient) return;
    setError(null);
    setBusy(true);
    try {
      // Which group (sheet, or the implicit csv one) a parsed row's
      // `sheetName` belongs to, and that group's configured header row —
      // `null` when no header row is marked for it, so nothing is skipped.
      function headerRowForSheet(sheetName: string | null): number | null {
        const group = selectedTemplate!.groups.find((g) =>
          sheetName === null ? g.sheetNames.length === 0 : g.sheetNames.includes(sheetName),
        );
        return group?.headerRow ?? null;
      }

      const results: EmployeeFileResult[] = [];
      for (const path of paths) {
        const info = fileHashes.get(path);
        const fileHash = info?.hash ?? path;
        const fileName = info?.fileName ?? path;
        try {
          const applied: AppliedPaymentRow[] = await applyPaymentTemplate(
            path,
            selectedTemplate.groups.map((g) => ({
              sheetNames: g.sheetNames,
              fieldMappings: g.fieldMappings.map((fm) => [fm.columnLetter, fm.targetField] as [string, string]),
            })),
            selectedTemplate.delimiter,
          );

          const rows: EmployeePreviewRow[] = [];
          for (const applied_row of applied) {
            const headerRow = headerRowForSheet(applied_row.sheetName);
            if (headerRow !== null && applied_row.rowNumber <= headerRow) continue;

            const cpfRaw = applied_row.fields.cpf ?? "";
            const matriculaRaw = applied_row.fields.matricula ?? "";
            const nameRaw = applied_row.fields.nome ?? "";
            const base = {
              fileHash,
              fileName,
              sheetName: applied_row.sheetName,
              rowNumber: applied_row.rowNumber,
              cpfRaw,
              matriculaRaw,
              nameRaw,
            };

            const cpfDigits = cpfRaw ? normalizeCpf(cpfRaw) : "";
            if (cpfDigits.length !== 11 || !nameRaw.trim()) {
              rows.push({ ...base, match: null, category: "skipped" });
              continue;
            }

            const match = await findEmployeeByAttempts(selectedClient.id, Number(companyId), selectedTemplate.identifierPriority, {
              cpf: cpfRaw,
              matricula: matriculaRaw || null,
              nome: nameRaw || null,
            });
            rows.push({ ...base, match, category: match ? "duplicate" : "valid" });
          }
          results.push({ fileHash, fileName, rows, error: null });
        } catch (e) {
          results.push({ fileHash, fileName, rows: [], error: String(e) });
        }
      }

      // Within this same batch, two "valid" rows sharing a CPF are the same
      // colaborador repeated in the source file — only the first stays
      // importable.
      const allRows = results.flatMap((r) => r.rows);
      const seenCpf = new Set<string>();
      for (const r of allRows) {
        if (r.category !== "valid") continue;
        const key = normalizeCpf(r.cpfRaw);
        if (seenCpf.has(key)) {
          r.category = "duplicate-in-file";
        } else {
          seenCpf.add(key);
        }
      }

      const defaultSelected = new Set<number>();
      allRows.forEach((r, i) => {
        if (r.category === "valid") defaultSelected.add(i);
      });

      setFileResults(results);
      setSelectedRows(defaultSelected);
      setPreviewPage(0);
      setRowFilter("all");
      setNameSearch("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    if (!selectedTemplate || !selectedClient || !companyId) return;
    setBusy(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const sourceFileIdByHash = new Map<string, number>();
      for (const result of fileResults) {
        const sourceFileId = await logSourceFile({
          fileHash: result.fileHash,
          fileName: result.fileName,
          pageCount: 1,
          provider: selectedTemplate.name,
          importType: "employee",
          status: result.error ? "error" : "success",
          errorMessage: result.error,
          originalPdfPath: "",
        });
        sourceFileIdByHash.set(result.fileHash, sourceFileId);
      }

      const importRows: EmployeeImportRow[] = [];
      const savedFileHashes = new Set<string>();
      for (let i = 0; i < employeeRows.length; i++) {
        if (!selectedRows.has(i)) continue;
        const row = employeeRows[i];
        if (row.category !== "valid") continue;
        importRows.push({
          clientId: selectedClient.id,
          companyId: Number(companyId),
          name: row.nameRaw.trim(),
          cpf: row.cpfRaw,
          matricula: row.matriculaRaw.trim() || null,
        });
        savedFileHashes.add(employeeRowFileHash[i]);
      }
      await createEmployeesFromImport(importRows);
      for (const fileHash of savedFileHashes) {
        await markSourceFileSaved(fileHash);
      }

      refreshRecentFiles();
      reset();
      setSuccessMessage(
        importRows.length === 1
          ? "1 colaborador importado com sucesso."
          : `${importRows.length} colaboradores importados com sucesso.`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Link to="/import" className="back-link">
        <ArrowLeft size={14} />
        Importar
      </Link>
      <div className="page-header">
        <h2>Importar colaboradores</h2>
        <button type="button" className="secondary" onClick={() => navigate("/import/employees/templates")}>
          <Settings2 size={15} style={{ marginRight: "0.4rem" }} />
          Gerenciar templates
        </button>
      </div>
      <p className="page-subtitle">
        Aplique um template já cadastrado a um arquivo de colaboradores (CSV, Excel ou ODS) e
        cadastre cada linha para o cliente selecionado.
      </p>

      {error && <div className="error-box">{error}</div>}
      {successMessage && <div className="success-box">{successMessage}</div>}

      <div className="import-layout">
        <div className="import-main">
          <div className="card">
            <div className="field-row" style={{ marginBottom: "1.2rem" }}>
              <div className="field" style={{ flex: "1 1 220px" }}>
                <label htmlFor="employee-template">Template</label>
                <select
                  id="employee-template"
                  value={templateId}
                  onChange={(e) => setTemplateId(e.target.value)}
                  disabled={templates.length === 0}
                >
                  <option value="">Selecione um template</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                {templates.length === 0 ? (
                  <p className="field-hint">
                    Nenhum template disponível.{" "}
                    <Link to="/import/employees/templates">Cadastre um template</Link>.
                  </p>
                ) : (
                  <p className="field-hint">Como as colunas do arquivo serão lidas.</p>
                )}
              </div>
              <div className="field" style={{ flex: "1 1 220px" }}>
                <label htmlFor="employee-client">Cliente</label>
                <select
                  id="employee-client"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  disabled={clients.length === 0}
                >
                  <option value="">Selecione um cliente</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {clients.length === 0 ? (
                  <p className="field-hint">
                    Nenhum cliente cadastrado. <Link to="/clients">Cadastre um cliente</Link> antes de
                    importar.
                  </p>
                ) : (
                  <p className="field-hint">Os colaboradores importados ficam vinculados a ele.</p>
                )}
              </div>
              <div className="field" style={{ flex: "1 1 180px" }}>
                <label htmlFor="employee-company">Empresa</label>
                <select
                  id="employee-company"
                  value={companyId}
                  onChange={(e) => setCompanyId(e.target.value)}
                  disabled={clientCompanies.length <= 1}
                >
                  {clientCompanies.length !== 1 && <option value="">Selecione uma empresa</option>}
                  {clientCompanies.map((c) => (
                    <option key={c.companyId} value={c.companyId}>
                      {c.companyName}
                    </option>
                  ))}
                </select>
                <p className="field-hint">
                  {clientCompanies.length > 1
                    ? "Esse cliente está vinculado a mais de uma empresa — escolha uma."
                    : "Definida automaticamente pelo cliente selecionado."}
                </p>
              </div>
            </div>

            <div className="field">
              <label>Arquivos de colaboradores</label>
              <div className="dropzone">
                <div className="dropzone-icon">
                  <FileText size={20} />
                </div>
                <h4>Selecione os arquivos</h4>
                <p className="muted" style={{ margin: 0 }}>
                  {selectedTemplate
                    ? `Formato do template: ${FILE_KIND_LABELS[selectedTemplate.fileKind]} — suporta múltiplos arquivos.`
                    : "Selecione um template para saber o formato aceito."}
                </p>
                <button
                  type="button"
                  className="secondary"
                  onClick={handlePick}
                  disabled={!selectedTemplate}
                  title={selectedTemplate ? undefined : "Selecione um template primeiro"}
                >
                  <FolderOpen size={15} style={{ marginRight: "0.4rem" }} />
                  Procurar arquivos
                </button>
              </div>

              {paths.length > 0 && (
                <div className="file-list">
                  {paths.map((p) => {
                    const info = fileHashes.get(p);
                    return (
                      <div className="file-row" key={p}>
                        <div className="file-row-icon">
                          <FileText size={18} />
                        </div>
                        <div className="file-row-info">
                          <div className="file-name">{info?.fileName ?? p}</div>
                        </div>
                        <div className="file-row-actions">
                          <button
                            type="button"
                            className="ghost"
                            style={{ padding: "0.3rem" }}
                            onClick={() => removePath(p)}
                            aria-label="Remover"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="card-footer">
              <button
                type="button"
                disabled={paths.length === 0 || !templateId || !clientId || !companyId || busy}
                onClick={handleProcess}
              >
                {busy ? "Processando..." : `Processar ${paths.length || ""} arquivo(s)`}
              </button>
            </div>
          </div>

          {fileResults.length > 0 && (
            <>
              <div className="card card-flush">
                <div className="page-header" style={{ marginBottom: 0, alignItems: "flex-end" }}>
                  <div>
                    <h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <Eye size={18} />
                      Pré-visualização da Importação
                    </h3>
                    {duplicateCount > 0 ? (
                      <p className="muted" style={{ maxWidth: "42rem" }}>
                        Algumas linhas batem com um colaborador já cadastrado — não são importadas
                        automaticamente. Use "Ver colaborador" para revisar manualmente.
                      </p>
                    ) : (
                      <p className="muted">Revise os dados antes de confirmar.</p>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: "0.6rem", flexShrink: 0 }}>
                    <button type="button" className="outline" onClick={cancelPreview} disabled={busy}>
                      Cancelar
                    </button>
                    <button type="button" onClick={handleSave} disabled={busy || selectedRows.size === 0}>
                      {busy ? "Salvando..." : `Salvar (${selectedRows.size})`}
                    </button>
                  </div>
                </div>
              </div>

              <div className="card table-card">
                <div className="table-toolbar">
                  <div className="counts">
                    <span>{employeeRows.length} registro(s) encontrado(s)</span>
                    <button
                      type="button"
                      className={`badge ok chip-filter${rowFilter === "selected" ? " active" : ""}`}
                      onClick={() => toggleRowFilter("selected")}
                      title="Linhas marcadas — vão ser importadas ao salvar. Clique para filtrar."
                    >
                      <ListChecks size={13} />
                      {selectedRows.size} a importar
                    </button>
                    <button
                      type="button"
                      className={`badge info chip-filter${rowFilter === "valid" ? " active" : ""}`}
                      onClick={() => toggleRowFilter("valid")}
                      title="Colaborador novo, ainda não cadastrado. Clique para filtrar."
                    >
                      <CheckCircle2 size={13} />
                      {categoryCounts.valid} novo(s)
                    </button>
                    {duplicateCount > 0 && (
                      <button
                        type="button"
                        className={`badge warn chip-filter${rowFilter === "duplicate" ? " active" : ""}`}
                        onClick={() => toggleRowFilter("duplicate")}
                        title="Já existe um colaborador cadastrado com esse identificador. Clique para filtrar."
                      >
                        <AlertTriangle size={13} />
                        {duplicateCount} já cadastrado(s)
                      </button>
                    )}
                    {duplicateInFileCount > 0 && (
                      <button
                        type="button"
                        className={`count-chip chip-filter${rowFilter === "duplicate-in-file" ? " active" : ""}`}
                        onClick={() => toggleRowFilter("duplicate-in-file")}
                        title="Mesmo CPF de outra linha já importável deste mesmo arquivo. Clique para filtrar."
                      >
                        {duplicateInFileCount} duplicado(s) no arquivo
                      </button>
                    )}
                    {skippedCount > 0 && (
                      <button
                        type="button"
                        className={`count-chip chip-filter${rowFilter === "skipped" ? " active" : ""}`}
                        onClick={() => toggleRowFilter("skipped")}
                        title="Linhas sem CPF válido ou sem nome — presumidas título, cabeçalho ou rodapé. Clique para filtrar."
                      >
                        {skippedCount} linha(s) ignorada(s)
                      </button>
                    )}
                    {errorCount > 0 && (
                      <button
                        type="button"
                        className={`badge file-error chip-filter${rowFilter === "error" ? " active" : ""}`}
                        onClick={() => toggleRowFilter("error")}
                        title="Clique para filtrar"
                      >
                        <AlertCircle size={13} />
                        {errorCount} erro(s)
                      </button>
                    )}
                  </div>
                  <div style={{ position: "relative", flexShrink: 0 }}>
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
                      type="text"
                      value={nameSearch}
                      onChange={(e) => {
                        setNameSearch(e.target.value);
                        setPreviewPage(0);
                      }}
                      placeholder="Buscar por nome..."
                      style={{ paddingLeft: "2rem", width: "13rem" }}
                    />
                  </div>
                </div>

                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th className="checkbox-cell">
                          <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={toggleAll}
                            disabled={selectableCount === 0}
                            aria-label="Selecionar todos"
                          />
                        </th>
                        <th>Linha</th>
                        <th>CPF</th>
                        <th>Matrícula</th>
                        <th>Nome</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.length === 0 && rowFilter !== "all" && (
                        <tr>
                          <td colSpan={6} className="muted" style={{ textAlign: "center", padding: "1.4rem" }}>
                            Nenhuma linha nesta categoria.
                          </td>
                        </tr>
                      )}
                      {previewPageItems.map((item, i) => {
                        if (item.kind === "error") {
                          return (
                            <tr key={`error-${i}`} className="row-error">
                              <td className="checkbox-cell">
                                <input type="checkbox" disabled aria-label="Não disponível" />
                              </td>
                              <td colSpan={4}>
                                <div className="file-name">{item.fileName}</div>
                                <div className="muted">{item.message}</div>
                              </td>
                              <td>
                                <span className="badge file-error">
                                  <AlertCircle size={13} />
                                  Erro no arquivo
                                </span>
                              </td>
                            </tr>
                          );
                        }

                        const { row, index } = item;
                        const canSelect = row.category === "valid";
                        return (
                          <tr key={index}>
                            <td className="checkbox-cell">
                              <input
                                type="checkbox"
                                checked={selectedRows.has(index)}
                                onChange={() => toggleRow(index)}
                                disabled={!canSelect}
                                aria-label={`Selecionar linha ${row.rowNumber}`}
                              />
                            </td>
                            <td>
                              {row.rowNumber}
                              {row.sheetName && <div className="muted" style={{ fontSize: "0.78rem" }}>{row.sheetName}</div>}
                            </td>
                            <td>{row.cpfRaw ? formatCpf(row.cpfRaw) : "—"}</td>
                            <td>{row.matriculaRaw || "—"}</td>
                            <td>
                              <div className="person-cell">
                                <Avatar name={row.nameRaw || "?"} />
                                {row.nameRaw || "—"}
                              </div>
                            </td>
                            <td>
                              {row.category === "valid" && (
                                <span className="badge ok">
                                  <PlusCircle size={13} />
                                  Novo
                                </span>
                              )}
                              {row.category === "duplicate" && (
                                <div style={{ marginBottom: "0.3rem" }}>
                                  <span className="badge warn">
                                    <AlertTriangle size={13} />
                                    Já cadastrado
                                  </span>
                                  {row.match && (
                                    <div style={{ marginTop: "0.25rem" }}>
                                      <Link to={`/employees/${row.match.id}`} style={{ fontSize: "0.78rem" }}>
                                        Ver colaborador
                                      </Link>
                                    </div>
                                  )}
                                </div>
                              )}
                              {row.category === "duplicate-in-file" && (
                                <span
                                  className="badge neutral"
                                  title="Mesmo CPF de outra linha deste mesmo arquivo — só a primeira ocorrência é importável."
                                >
                                  Duplicado no arquivo
                                </span>
                              )}
                              {row.category === "skipped" && (
                                <span className="badge neutral" title="CPF inválido ou Nome ausente nesta linha">
                                  CPF ou nome ausente
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {previewRows.length > PREVIEW_PAGE_SIZE_OPTIONS[0] && (
                  <Pagination
                    page={previewPage}
                    pageCount={previewPageCount}
                    onPageChange={setPreviewPage}
                    rangeLabel={`Mostrando ${previewPage * previewPageSize + 1} a ${Math.min(
                      previewRows.length,
                      previewPage * previewPageSize + previewPageSize,
                    )} de ${previewRows.length}`}
                    pageSize={previewPageSize}
                    pageSizeOptions={PREVIEW_PAGE_SIZE_OPTIONS}
                    onPageSizeChange={(size) => {
                      setPreviewPageSize(size);
                      setPreviewPage(0);
                    }}
                  />
                )}
              </div>
            </>
          )}
        </div>

        <div className="import-side">
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Histórico de importações</h3>

            {!(recentFilesTotal === 0 && !historySearch.trim()) && (
              <div className="field" style={{ marginBottom: "0.8rem" }}>
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
                    type="text"
                    value={historySearch}
                    onChange={(e) => {
                      setHistorySearch(e.target.value);
                      setHistoryPage(0);
                    }}
                    placeholder="Buscar por nome do arquivo..."
                    style={{ width: "100%", paddingLeft: "2rem" }}
                  />
                </div>
              </div>
            )}

            {recentFilesTotal === 0 && !historySearch.trim() && (
              <p className="muted">Nenhum arquivo importado ainda.</p>
            )}
            {recentFilesTotal === 0 && historySearch.trim() && <p className="muted">Nenhum arquivo encontrado.</p>}

            {recentFilesTotal > 0 && (
              <div className="file-list">
                {recentFiles.map((f) => {
                  const badge = STATUS_BADGE[f.status];
                  const BadgeIcon = badge.icon;
                  return (
                    <div className="file-row" key={f.id}>
                      <div className="file-row-icon">
                        <FileText size={18} />
                      </div>
                      <div className="file-row-info">
                        <div className="file-name" title={f.fileName}>
                          {f.fileName}
                        </div>
                        <div className="file-meta">
                          {f.provider || "—"} · {formatDateTime(f.importedAt)}
                        </div>
                        {f.status !== "success" && f.errorMessage && (
                          <div className="muted" style={{ fontSize: "0.75rem", marginTop: "0.15rem" }}>
                            {f.errorMessage}
                          </div>
                        )}
                      </div>
                      <div className="file-row-actions">
                        <span className={badge.className}>
                          <BadgeIcon size={13} />
                          {badge.label}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {recentFilesTotal > HISTORY_PAGE_SIZE_OPTIONS[0] && (
              <Pagination
                page={historyPage}
                pageCount={historyPageCount}
                onPageChange={setHistoryPage}
                rangeLabel={`Mostrando ${historyPage * historyPageSize + 1} a ${Math.min(
                  recentFilesTotal,
                  historyPage * historyPageSize + historyPageSize,
                )} de ${recentFilesTotal}`}
                pageSize={historyPageSize}
                pageSizeOptions={HISTORY_PAGE_SIZE_OPTIONS}
                onPageSizeChange={(size) => {
                  setHistoryPageSize(size);
                  setHistoryPage(0);
                }}
                maxPageButtons={3}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
