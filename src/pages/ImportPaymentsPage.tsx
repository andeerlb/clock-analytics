import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Eye,
  FileText,
  FolderOpen,
  PlusCircle,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import ConfirmModal from "../components/ConfirmModal";
import DateRangePicker from "../components/DateRangePicker";
import Pagination from "../components/Pagination";
import {
  applyPaymentTemplate,
  hashPaymentFile,
  pickPaymentFiles,
  type AppliedPaymentRow,
} from "../lib/api";
import { colorForName, initials } from "../lib/avatar";
import {
  findDuplicatePaymentShifts,
  findEmployeeByAttempts,
  getPaymentTemplate,
  listImportFiles,
  listPaymentTemplates,
  logSourceFile,
  markSourceFileSaved,
  savePaymentShifts,
  type EmployeeRow,
  type PaymentShiftInput,
} from "../lib/db";
import {
  formatDate,
  formatDateTime,
  formatMinutesAsTime,
  parseDateWithFormat,
  parseScheduleToMinutes,
  resolvePaymentRoute,
} from "../lib/format";
import type {
  ImportFileRow,
  ImportStatus,
  PaymentTemplateListRow,
  PaymentTemplateRow,
} from "../lib/types";

const STATUS_BADGE: Record<ImportStatus, { className: string; label: string; icon: typeof CheckCircle2 }> = {
  success: { className: "badge ok", label: "Sucesso", icon: CheckCircle2 },
  warning: { className: "badge overwrite", label: "Com alertas", icon: AlertTriangle },
  error: { className: "badge file-error", label: "Falha", icon: AlertCircle },
};

interface PaymentPreviewRow {
  fileHash: string;
  fileName: string;
  sheetName: string | null;
  rowNumber: number;
  employee: EmployeeRow | null;
  local: string;
  role: string;
  /** Raw Horário text, kept only to display when `parseScheduleToMinutes` can't make sense of it. */
  scheduleRaw: string;
  scheduleStartMinutes: number | null;
  scheduleEndMinutes: number | null;
  note: string | null;
  /** Always a valid ISO date — rows whose "data" field doesn't parse are filtered out before this is ever built (see `handleProcess`), not shown as an error row. */
  workDate: string;
  isDuplicate: boolean;
  /** No rule in the template's routing chain matched this row's field value — `employee` is always `null` when this is `true` (the lookup never runs without a resolved client). */
  unresolvedRoute: boolean;
}

interface PaymentFileResult {
  fileHash: string;
  fileName: string;
  rows: PaymentPreviewRow[];
  /** How many physical rows in this file weren't real data — no valid date in the mapped "data" column, so presumed to be a title/header/footer row. */
  skippedCount: number;
  /** How many otherwise-valid rows fell outside the optional período filter. */
  outOfPeriodCount: number;
  error: string | null;
}

type DisplayRow =
  | { kind: "shift"; index: number; row: PaymentPreviewRow }
  | { kind: "error"; fileName: string; message: string };

const PREVIEW_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const HISTORY_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

export default function ImportPaymentsPage() {
  const navigate = useNavigate();

  const [templates, setTemplates] = useState<PaymentTemplateListRow[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<PaymentTemplateRow | null>(null);

  // Optional — filters rows by the template's mapped "data" column. Left
  // empty, processing goes through the whole file (with confirmation, see
  // handleProcessClick).
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [confirmFullImport, setConfirmFullImport] = useState(false);

  const [paths, setPaths] = useState<string[]>([]);
  const [fileHashes, setFileHashes] = useState<Map<string, { hash: string; fileName: string }>>(
    new Map(),
  );

  const [fileResults, setFileResults] = useState<PaymentFileResult[]>([]);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [previewPage, setPreviewPage] = useState(0);
  const [previewPageSize, setPreviewPageSize] = useState(PREVIEW_PAGE_SIZE_OPTIONS[0]);

  const [recentFiles, setRecentFiles] = useState<ImportFileRow[]>([]);
  const [historySearch, setHistorySearch] = useState("");
  const [historyPage, setHistoryPage] = useState(0);
  const [historyPageSize, setHistoryPageSize] = useState(HISTORY_PAGE_SIZE_OPTIONS[0]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    listPaymentTemplates().then(setTemplates);
    refreshRecentFiles();
  }, []);

  function refreshRecentFiles() {
    listImportFiles("payment").then(setRecentFiles);
  }

  // Hash newly picked files (no page-count/duplicate check like timesheets
  // — a payment file has no equivalent to "one PDF, one employee", and the
  // row-level duplicate check further down is the meaningful one here).
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
    getPaymentTemplate(Number(templateId)).then((t) => {
      if (!cancelled) setSelectedTemplate(t);
    });
    return () => {
      cancelled = true;
    };
  }, [templateId]);

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
  }

  function reset() {
    setPaths([]);
    cancelPreview();
    setError(null);
  }

  async function handlePick() {
    setError(null);
    const selected = await pickPaymentFiles();
    if (selected.length > 0) addPaths(selected);
  }

  const shiftRows = useMemo(() => fileResults.flatMap((r) => r.rows), [fileResults]);
  const shiftRowFileHash = useMemo(
    () => fileResults.flatMap((r) => r.rows.map(() => r.fileHash)),
    [fileResults],
  );

  const previewRows = useMemo(() => {
    const out: DisplayRow[] = [];
    let idx = 0;
    for (const result of fileResults) {
      if (result.error) {
        out.push({ kind: "error", fileName: result.fileName, message: result.error });
      } else {
        for (const row of result.rows) {
          out.push({ kind: "shift", index: idx, row });
          idx++;
        }
      }
    }
    return out;
  }, [fileResults]);

  const errorCount = fileResults.filter((r) => r.error).length;
  const duplicateCount = shiftRows.filter((r) => r.isDuplicate).length;
  const skippedCount = fileResults.reduce((sum, r) => sum + r.skippedCount, 0);
  const outOfPeriodCount = fileResults.reduce((sum, r) => sum + r.outOfPeriodCount, 0);

  const previewPageCount = Math.max(1, Math.ceil(previewRows.length / previewPageSize));
  const previewPageItems = useMemo(
    () => previewRows.slice(previewPage * previewPageSize, previewPage * previewPageSize + previewPageSize),
    [previewRows, previewPage, previewPageSize],
  );

  const selectableCount = shiftRows.filter((r) => r.employee).length;
  const allSelected = selectableCount > 0 && shiftRows.every((r, i) => selectedRows.has(i) || !r.employee);

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
      setSelectedRows(new Set(shiftRows.flatMap((r, i) => (r.employee ? [i] : []))));
    }
  }

  const filteredRecentFiles = useMemo(() => {
    const query = historySearch.trim().toLowerCase();
    if (!query) return recentFiles;
    return recentFiles.filter((f) => f.fileName.toLowerCase().includes(query));
  }, [recentFiles, historySearch]);

  useEffect(() => {
    setHistoryPage(0);
  }, [historySearch]);

  const historyPageCount = Math.max(1, Math.ceil(filteredRecentFiles.length / historyPageSize));
  const historyPageItems = useMemo(
    () =>
      filteredRecentFiles.slice(historyPage * historyPageSize, historyPage * historyPageSize + historyPageSize),
    [filteredRecentFiles, historyPage, historyPageSize],
  );

  async function handleProcess() {
    if (!selectedTemplate) return;
    setError(null);
    setBusy(true);
    try {
      const results: PaymentFileResult[] = [];
      for (const path of paths) {
        const info = fileHashes.get(path);
        const fileHash = info?.hash ?? path;
        const fileName = info?.fileName ?? path;
        try {
          const applied: AppliedPaymentRow[] = await applyPaymentTemplate(
            path,
            selectedTemplate.groups.map((g) => ({
              sheetNames: g.sheetNames,
              fieldMappings: g.fieldMappings.map(
                (fm) => [fm.columnLetter, fm.targetField] as [string, string],
              ),
            })),
            selectedTemplate.delimiter,
          );

          const rows: PaymentPreviewRow[] = [];
          let skippedCount = 0;
          let outOfPeriodCount = 0;
          for (const applied_row of applied) {
            // No fixed header row anymore — a physical row is only "real
            // data" if its mapped "data" column actually parses as a
            // date. Anything that doesn't (a title, header, or footer
            // row) is silently skipped here, not shown as an error row.
            const workDateRaw = applied_row.fields.data ?? "";
            const workDate = workDateRaw
              ? parseDateWithFormat(workDateRaw, selectedTemplate.dateFormat)
              : null;
            if (!workDate) {
              skippedCount++;
              continue;
            }

            // Optional período filter, same "data" column/formato já
            // usados acima — rows outside it are excluded but counted
            // separately from skippedCount (those had no valid date at
            // all; these did, just outside the chosen range).
            if ((periodStart && workDate < periodStart) || (periodEnd && workDate > periodEnd)) {
              outOfPeriodCount++;
              continue;
            }

            // Which company/client this row belongs to is resolved here,
            // per row, by walking the template's if/else-if/else rule
            // chain — there's no upfront cliente/empresa choice anymore.
            const route = resolvePaymentRoute(selectedTemplate.rules, applied_row.fields);
            const cpf = applied_row.fields.cpf || null;
            const matricula = applied_row.fields.matricula || null;
            const nome = applied_row.fields.nome || null;
            const employee = route
              ? await findEmployeeByAttempts(route.clientId, selectedTemplate.identifierPriority, {
                  cpf,
                  matricula,
                  nome,
                })
              : null;
            const scheduleRaw = applied_row.fields.horario ?? "";
            const parsedSchedule = parseScheduleToMinutes(scheduleRaw);
            rows.push({
              fileHash,
              fileName,
              sheetName: applied_row.sheetName,
              rowNumber: applied_row.rowNumber,
              employee,
              local: applied_row.fields.local ?? "",
              role: applied_row.fields.funcao ?? "",
              scheduleRaw,
              scheduleStartMinutes: parsedSchedule?.startMinutes ?? null,
              scheduleEndMinutes: parsedSchedule?.endMinutes ?? null,
              note: applied_row.fields.observacao || null,
              workDate,
              isDuplicate: false,
              unresolvedRoute: !route,
            });
          }
          results.push({ fileHash, fileName, rows, skippedCount, outOfPeriodCount, error: null });
        } catch (e) {
          results.push({ fileHash, fileName, rows: [], skippedCount: 0, outOfPeriodCount: 0, error: String(e) });
        }
      }

      const allRows = results.flatMap((r) => r.rows);
      const candidates = allRows.filter((r) => r.employee);
      const dupIndices = await findDuplicatePaymentShifts(
        candidates.map((r) => ({ employeeId: r.employee!.id, workDate: r.workDate, local: r.local })),
      );
      dupIndices.forEach((i) => {
        candidates[i].isDuplicate = true;
      });

      const defaultSelected = new Set<number>();
      allRows.forEach((r, i) => {
        if (r.employee && !r.isDuplicate) defaultSelected.add(i);
      });

      setFileResults(results);
      setSelectedRows(defaultSelected);
      setPreviewPage(0);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  /** No período set means "the whole file" — that's easy to do by accident, so it's confirmed instead of just silently processing everything. */
  function handleProcessClick() {
    if (!periodStart && !periodEnd) {
      setConfirmFullImport(true);
      return;
    }
    handleProcess();
  }

  async function handleSave() {
    if (!selectedTemplate) return;
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
          importType: "payment",
          status: result.error ? "error" : "success",
          errorMessage: result.error,
          originalPdfPath: "",
        });
        sourceFileIdByHash.set(result.fileHash, sourceFileId);
      }

      const shiftInputs: PaymentShiftInput[] = [];
      const savedFileHashes = new Set<string>();
      for (let i = 0; i < shiftRows.length; i++) {
        if (!selectedRows.has(i)) continue;
        const row = shiftRows[i];
        if (!row.employee) continue;
        const fileHash = shiftRowFileHash[i];
        shiftInputs.push({
          employeeId: row.employee.id,
          templateId: selectedTemplate.id,
          sourceFileId: sourceFileIdByHash.get(fileHash) ?? null,
          local: row.local,
          workDate: row.workDate,
          role: row.role,
          scheduleStartMinutes: row.scheduleStartMinutes,
          scheduleEndMinutes: row.scheduleEndMinutes,
          note: row.note,
        });
        savedFileHashes.add(fileHash);
      }
      await savePaymentShifts(shiftInputs);
      for (const fileHash of savedFileHashes) {
        await markSourceFileSaved(fileHash);
      }

      refreshRecentFiles();
      reset();
      setSuccessMessage(
        shiftInputs.length === 1
          ? "1 turno importado com sucesso."
          : `${shiftInputs.length} turnos importados com sucesso.`,
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
        <h2>Importar pagamentos</h2>
        <button type="button" className="secondary" onClick={() => navigate("/import/payments/templates")}>
          <Settings2 size={15} style={{ marginRight: "0.4rem" }} />
          Gerenciar templates
        </button>
      </div>
      <p className="page-subtitle">
        Aplique um template já cadastrado a um arquivo de pagamentos (CSV, Excel ou ODS) e
        associe cada linha ao colaborador correspondente.
      </p>

      {error && <div className="error-box">{error}</div>}
      {successMessage && <div className="success-box">{successMessage}</div>}

      <div className="import-layout">
        <div className="import-main">
          <div className="card">
            <div className="field" style={{ maxWidth: "24rem", marginBottom: "1.2rem" }}>
              <label htmlFor="payment-template">Template</label>
              <select
                id="payment-template"
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
                  <Link to="/import/payments/templates">Cadastre um template</Link>.
                </p>
              ) : (
                <p className="field-hint">
                  Como as colunas do arquivo serão lidas, e as regras que decidem a Empresa/Cliente
                  de cada linha.
                </p>
              )}
            </div>

            <div className="field" style={{ maxWidth: "24rem", marginBottom: "1.2rem" }}>
              <label>Período (opcional)</label>
              <DateRangePicker
                startValue={periodStart}
                endValue={periodEnd}
                onChange={(start, end) => {
                  setPeriodStart(start);
                  setPeriodEnd(end);
                }}
              />
              <p className="field-hint">
                Filtra pela coluna de data do template. Deixe em branco para processar o relatório
                inteiro.
              </p>
            </div>

            <div className="field">
              <label>Arquivos de pagamento</label>
              <div className="dropzone">
                <div className="dropzone-icon">
                  <FileText size={20} />
                </div>
                <h4>Selecione os arquivos</h4>
                <p className="muted" style={{ margin: 0 }}>
                  CSV, Excel ou ODS — suporta múltiplos arquivos com o mesmo template.
                </p>
                <button type="button" className="secondary" onClick={handlePick}>
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
                disabled={paths.length === 0 || !templateId || busy}
                onClick={handleProcessClick}
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
                        Algumas linhas parecem já ter sido importadas antes (mesmo colaborador,
                        data e local). Revise a lista e marque o que você quer salvar.
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
                      {busy ? "Salvando..." : "Salvar"}
                    </button>
                  </div>
                </div>
              </div>

              <div className="card table-card">
                <div className="table-toolbar">
                  <div className="counts">
                    <span>{shiftRows.length} registro(s) encontrado(s)</span>
                    {skippedCount > 0 && (
                      <span className="count-chip" title="Linhas sem uma data válida na coluna mapeada — presumidas título, cabeçalho ou rodapé">
                        {skippedCount} linha(s) ignorada(s)
                      </span>
                    )}
                    {outOfPeriodCount > 0 && (
                      <span className="count-chip" title="Linhas com data válida, mas fora do período selecionado">
                        {outOfPeriodCount} fora do período
                      </span>
                    )}
                    {duplicateCount > 0 && <span className="count-chip">{duplicateCount} possível(is) duplicata(s)</span>}
                    {errorCount > 0 && (
                      <span className="badge file-error">
                        <AlertCircle size={13} />
                        {errorCount} erro(s)
                      </span>
                    )}
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
                        <th>Colaborador</th>
                        <th>Local</th>
                        <th>Data</th>
                        <th>Função</th>
                        <th>Horário</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewPageItems.map((item, i) => {
                        if (item.kind === "error") {
                          return (
                            <tr key={`error-${i}`} className="row-error">
                              <td className="checkbox-cell">
                                <input type="checkbox" disabled aria-label="Não disponível" />
                              </td>
                              <td colSpan={5}>
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
                        const canSelect = Boolean(row.employee);
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
                              {row.employee ? (
                                <div className="person-cell">
                                  <span className="avatar" style={{ background: colorForName(row.employee.name) }}>
                                    {initials(row.employee.name)}
                                  </span>
                                  {row.employee.name}
                                </div>
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                            <td>{row.local}</td>
                            <td>{formatDate(row.workDate)}</td>
                            <td>{row.role}</td>
                            <td>
                              {row.scheduleStartMinutes !== null && row.scheduleEndMinutes !== null ? (
                                `${formatMinutesAsTime(row.scheduleStartMinutes)} – ${formatMinutesAsTime(row.scheduleEndMinutes)}`
                              ) : (
                                <span className="muted" title="Horário não reconhecido">
                                  {row.scheduleRaw || "—"}
                                </span>
                              )}
                            </td>
                            <td>
                              {row.employee && !row.isDuplicate && (
                                <span className="badge ok">
                                  <PlusCircle size={13} />
                                  Novo
                                </span>
                              )}
                              {!row.employee && row.unresolvedRoute && (
                                <div style={{ marginBottom: "0.3rem" }}>
                                  <span className="badge warn">
                                    <AlertTriangle size={13} />
                                    Empresa/cliente não definido
                                  </span>
                                  <div style={{ marginTop: "0.25rem" }}>
                                    <Link to="/import/payments/templates" style={{ fontSize: "0.78rem" }}>
                                      Editar regras do template
                                    </Link>
                                  </div>
                                </div>
                              )}
                              {!row.employee && !row.unresolvedRoute && (
                                <div style={{ marginBottom: "0.3rem" }}>
                                  <span className="badge warn">
                                    <AlertTriangle size={13} />
                                    Colaborador não encontrado
                                  </span>
                                  <div style={{ marginTop: "0.25rem" }}>
                                    <Link to="/employees/new" style={{ fontSize: "0.78rem" }}>
                                      Cadastrar colaborador
                                    </Link>
                                  </div>
                                </div>
                              )}
                              {row.employee && row.isDuplicate && (
                                <span className="badge overwrite">
                                  <AlertTriangle size={13} />
                                  Possível duplicata
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

            {recentFiles.length > 0 && (
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
                    onChange={(e) => setHistorySearch(e.target.value)}
                    placeholder="Buscar por nome do arquivo..."
                    style={{ width: "100%", paddingLeft: "2rem" }}
                  />
                </div>
              </div>
            )}

            {recentFiles.length === 0 && <p className="muted">Nenhum arquivo importado ainda.</p>}
            {recentFiles.length > 0 && filteredRecentFiles.length === 0 && (
              <p className="muted">Nenhum arquivo encontrado.</p>
            )}

            {filteredRecentFiles.length > 0 && (
              <div className="file-list">
                {historyPageItems.map((f) => {
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

            {filteredRecentFiles.length > HISTORY_PAGE_SIZE_OPTIONS[0] && (
              <Pagination
                page={historyPage}
                pageCount={historyPageCount}
                onPageChange={setHistoryPage}
                rangeLabel={`Mostrando ${historyPage * historyPageSize + 1} a ${Math.min(
                  filteredRecentFiles.length,
                  historyPage * historyPageSize + historyPageSize,
                )} de ${filteredRecentFiles.length}`}
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

      {confirmFullImport && (
        <ConfirmModal
          title="Processar sem filtro de período"
          message="Nenhum período foi selecionado — isso vai processar o relatório inteiro, sem limitar por data. Deseja continuar?"
          confirmLabel="Processar arquivo inteiro"
          danger={false}
          onConfirm={() => {
            setConfirmFullImport(false);
            handleProcess();
          }}
          onCancel={() => setConfirmFullImport(false)}
        />
      )}
    </div>
  );
}
