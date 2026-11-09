import { listen } from "@tauri-apps/api/event";
import { ArrowRight, ChevronDown, Loader2, Lock, MessageCircle, PanelTop, Plus, SquarePen, ArrowUp, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { applyPaymentsFiltersSnapshot, useLibraryFilters, usePaymentsFilters, type LibraryFilters, type PaymentsFilters } from "../contexts/FiltersContext";
import { aiAsk, aiStatus, type AiAmbiguity, type AiAnswer, type AiScreenLink } from "../lib/api";
import { formatDateSlash } from "../lib/format";
import { PERIOD_STATUS_OPTIONS, type PeriodStatusId } from "../lib/periodStatus";
import type { PaymentShiftStatus } from "../lib/types";

export interface AiShiftTarget {
  shiftId: number;
  employeeId: number;
  employeeName: string;
  workDate: string;
}

type ChatMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; answer: AiAnswer; links: AiScreenLink[] };

interface PendingQuestion {
  question: string;
  shift: AiShiftTarget | null;
  screen: string | null;
  ambiguities: AiAmbiguity[];
  choices: Record<string, number | null>;
}

const ALL_PAYMENT_STATUSES: PaymentShiftStatus[] = ["pendente", "erro", "pago"];
const ALL_SHIFT_PERIODS = 2;
const MIN_PANEL_WIDTH = 400;
const PANEL_WIDTH_KEY = "ai-assistant-width";
const PANEL_WIDTH_STEP = 24;
/** Handle plus the panel's right margin, around its own width. */
const PANEL_COLUMN_EXTRA = 24;
/** Matches `.ai-side`'s width transition. */
const PANEL_TRANSITION_MS = 260;

/** Keeps room for the page: the sidebar plus a usable table. */
function clampPanelWidth(width: number): number {
  const max = Math.max(MIN_PANEL_WIDTH, window.innerWidth - 560);
  return Math.round(Math.min(max, Math.max(MIN_PANEL_WIDTH, width)));
}

function readSavedPanelWidth(): number {
  try {
    const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return saved > 0 ? clampPanelWidth(saved) : MIN_PANEL_WIDTH;
  } catch {
    return MIN_PANEL_WIDTH;
  }
}

/** Longest prefix wins, so a template screen isn't labelled as its parent. */
const SCREEN_LABELS: [string, string][] = [
  ["/payments/export-templates", "Modelos de exportação"],
  ["/payments/pdf-templates", "Modelos de exportação"],
  ["/payments", "Pagamentos"],
  ["/analytics", "Análises"],
  ["/settings", "Configurações"],
  ["/employees", "Colaboradores"],
  ["/employee/", "Cartão de Ponto"],
  ["/companies", "Empresas"],
  ["/clients", "Clientes"],
  ["/roles", "Funções"],
  ["/import/payments/templates", "Modelos de planilha"],
  ["/import/employees/templates", "Modelos de colaboradores"],
  ["/import/payments", "Importar pagamentos"],
  ["/import/employees", "Importar colaboradores"],
  ["/import/timesheet", "Importar ponto"],
  ["/import", "Importar"],
  ["/remote-updates", "Verificação automática"],
];

function screenLabel(pathname: string): string {
  if (pathname === "/") return "Cartão Ponto";
  const matches = SCREEN_LABELS.filter(([prefix]) => pathname.startsWith(prefix));
  matches.sort((a, b) => b[0].length - a[0].length);
  return matches[0]?.[1] ?? "Tela atual";
}

function periodLabel(start: string, end: string): string | null {
  if (!start && !end) return null;
  if (start && start === end) return formatDateSlash(start);
  if (start && end) {
    const [year, month, day] = start.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (day === 1 && end === `${start.slice(0, 8)}${String(lastDay).padStart(2, "0")}`) {
      const name = new Intl.DateTimeFormat("pt-BR", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
      return `${name}/${year}`;
    }
    return `${formatDateSlash(start)} a ${formatDateSlash(end)}`;
  }
  return start ? `desde ${formatDateSlash(start)}` : `até ${formatDateSlash(end)}`;
}

function filterSummary(period: string | null, activeCount: number, onlyEmployees: boolean, employeeCount: number): string {
  const parts: string[] = [];
  if (period) parts.push(period);
  if (onlyEmployees) parts.push(`${employeeCount} ${employeeCount === 1 ? "colaborador" : "colaboradores"}`);
  else if (activeCount > 0) parts.push(`${activeCount} ${activeCount === 1 ? "filtro" : "filtros"}`);
  return parts.join(", ");
}

function listFilter(name: string, values: Iterable<string>): string | null {
  const list = Array.from(values);
  return list.length > 0 ? `${name}: ${list.join(", ")}` : null;
}

function countRow(label: string, values: Set<string>): ContextRow | null {
  return values.size > 0 ? { label, value: `${values.size} ${values.size === 1 ? "selecionado" : "selecionados"}` } : null;
}

function presentRows(rows: (ContextRow | null)[]): ContextRow[] {
  return rows.filter((row): row is ContextRow => row !== null);
}

/** "1 colaborador, 14/08/2026": what a "ver na tela" button will filter by. */
function linkSummary(link: AiScreenLink): string {
  const parts: string[] = [];
  if (link.employeeIds.length > 0) parts.push(`${link.employeeIds.length} ${link.employeeIds.length === 1 ? "colaborador" : "colaboradores"}`);
  const period = periodLabel(link.periodStart ?? "", link.periodEnd ?? "");
  if (period) parts.push(period);
  if (link.screen === "payments" && link.statuses.length > 0) parts.push(link.statuses.join(", "));
  return parts.join(", ");
}

interface ContextRow {
  label: string;
  value: string;
}

interface ScreenContext {
  label: string;
  detail: string;
  /** The breakdown shown when the context chip is opened. */
  rows: ContextRow[];
  /** What the model is told about this screen. */
  forAi: string;
}

function paymentsContext(pathname: string, label: string, f: PaymentsFilters): ScreenContext {
  const statuses = f.selectedStatuses.size < ALL_PAYMENT_STATUSES.length ? listFilter("status", f.selectedStatuses) : null;
  const periods = f.selectedShiftPeriods.size < ALL_SHIFT_PERIODS ? listFilter("turno", f.selectedShiftPeriods) : null;
  const filters = [
    listFilter("employee_id", f.selectedEmployeeIds),
    listFilter("company_id", f.selectedCompanyIds),
    listFilter("client_id", f.selectedClientIds),
    listFilter("role_id", f.selectedRoleIds),
    listFilter("local", f.selectedLocals),
    statuses,
    periods,
    f.scheduleTimeFilter ? "filtro de horário ativo" : null,
  ].filter((v): v is string => v !== null);
  const period = periodLabel(f.periodStart, f.periodEnd);
  const onlyEmployees = filters.length === 1 && f.selectedEmployeeIds.size > 0;
  const range = f.periodStart || f.periodEnd ? `work_date de ${f.periodStart || "início"} até ${f.periodEnd || "hoje"}` : "sem filtro de data";
  return {
    label,
    detail: filterSummary(period, filters.length, onlyEmployees, f.selectedEmployeeIds.size),
    rows: presentRows([
      { label: "Tela", value: label },
      period ? { label: "Período", value: period } : null,
      countRow("Colaboradores", f.selectedEmployeeIds),
      countRow("Empresas", f.selectedCompanyIds),
      countRow("Clientes", f.selectedClientIds),
      countRow("Funções", f.selectedRoleIds),
      countRow("Locais", f.selectedLocals),
      statuses ? { label: "Status", value: Array.from(f.selectedStatuses).join(", ") } : null,
      periods ? { label: "Turno", value: Array.from(f.selectedShiftPeriods).join(", ") } : null,
      f.scheduleTimeFilter ? { label: "Horário", value: "Filtro ativo" } : null,
    ]),
    forAi: `${label} (${pathname}). Filtros ativos: ${[range, ...filters].join("; ")}.`,
  };
}

function libraryContext(pathname: string, label: string, f: LibraryFilters): ScreenContext {
  const statuses = f.selectedStatuses.size < PERIOD_STATUS_OPTIONS.length ? listFilter("status", f.selectedStatuses) : null;
  const filters = [
    listFilter("employee_id", f.selectedEmployeeIds),
    listFilter("company_id", f.selectedCompanyIds),
    listFilter("client_id", f.selectedClientIds),
    statuses,
  ].filter((v): v is string => v !== null);
  const onlyEmployees = filters.length === 1 && f.selectedEmployeeIds.size > 0;
  const period = periodLabel(f.periodStart, f.periodEnd);
  return {
    label,
    detail: filterSummary(period, filters.length, onlyEmployees, f.selectedEmployeeIds.size),
    rows: presentRows([
      { label: "Tela", value: label },
      period ? { label: "Período", value: period } : null,
      countRow("Colaboradores", f.selectedEmployeeIds),
      countRow("Empresas", f.selectedCompanyIds),
      countRow("Clientes", f.selectedClientIds),
      statuses ? { label: "Status", value: `${f.selectedStatuses.size} de ${PERIOD_STATUS_OPTIONS.length}` } : null,
    ]),
    forAi: `${label} (${pathname}). Filtros ativos: ${[`importações que encostam em ${f.periodStart} a ${f.periodEnd}`, ...filters].join("; ")}.`,
  };
}

function toIds(ids: number[]): Set<string> {
  return new Set(ids.map(String));
}

const AiAssistantContext = createContext<{ askAboutShift: (target: AiShiftTarget) => void } | null>(null);

export function useAiAssistant() {
  const value = useContext(AiAssistantContext);
  if (!value) throw new Error("useAiAssistant must be used inside AiAssistantProvider");
  return value;
}

/**
 * The assistant, available on every screen of the main window: a discreet
 * round button that opens a fixed side panel next to the page, so it never
 * covers the data being asked about. Answers are rendered as plain text on
 * purpose: they're model output built partly from imported files, so they
 * must never be interpreted as HTML.
 */
export function AiAssistantProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const paymentsFilters = usePaymentsFilters();
  const libraryFilters = useLibraryFilters();
  const [open, setOpen] = useState(false);
  // Stays mounted through the closing slide; `visible` is what drives it.
  const [rendered, setRendered] = useState(false);
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversation, setConversation] = useState<unknown[]>([]);
  const [draft, setDraft] = useState("");
  const [shift, setShift] = useState<AiShiftTarget | null>(null);
  const [useScreen, setUseScreen] = useState(true);
  const [pending, setPending] = useState<PendingQuestion | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [unseenAnswer, setUnseenAnswer] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(readSavedPanelWidth);
  const contextRef = useRef<HTMLDivElement>(null);
  // "Nova conversa" during a run makes its late result land nowhere.
  const currentRun = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const label = screenLabel(pathname);
  const screen: ScreenContext =
    pathname === "/payments"
      ? paymentsContext(pathname, label, paymentsFilters)
      : pathname === "/"
        ? libraryContext(pathname, label, libraryFilters)
        : { label, detail: "", rows: [{ label: "Tela", value: label }], forAi: `${label} (${pathname}).` };

  useEffect(() => {
    if (open) {
      setRendered(true);
      return;
    }
    setVisible(false);
    const timeout = setTimeout(() => setRendered(false), PANEL_TRANSITION_MS);
    return () => clearTimeout(timeout);
  }, [open]);

  // Same reason as `Drawer`: the panel has to paint once at width 0 before
  // `visible` flips, or the browser merges both and nothing animates.
  useEffect(() => {
    if (!open || !rendered) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setVisible(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [open, rendered]);

  useEffect(() => {
    if (!open || !rendered) return;
    setUnseenAnswer(false);
    inputRef.current?.focus({ preventScroll: true });
    aiStatus()
      .then((status) => setReady(status.claudeCode || status.apiKey))
      .catch((e) => setError(String(e)));
    // Also re-checked on navigation, to pick up a key just saved in Configurações.
  }, [open, rendered, pathname]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, running, pending, error]);

  useEffect(() => {
    if (!running) return;
    const unlisten = listen<string>("ai-assistant-progress", (event) => setProgress(event.payload));
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [running]);

  useEffect(() => {
    if (!contextOpen) return;
    function closeOnOutsidePress(event: globalThis.PointerEvent) {
      if (!contextRef.current?.contains(event.target as Node)) setContextOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [contextOpen]);

  useEffect(() => {
    function refit() {
      setPanelWidth((width) => clampPanelWidth(width));
    }
    window.addEventListener("resize", refit);
    return () => window.removeEventListener("resize", refit);
  }, []);

  function savePanelWidth(width: number) {
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(width));
    } catch {
      /* only a remembered preference */
    }
  }

  function handleResizeStart(e: PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add("ai-resizing");
  }

  function handleResizeMove(e: PointerEvent<HTMLDivElement>) {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    // The panel's right edge sits 12px in from the window's (`.ai-side` padding).
    setPanelWidth(clampPanelWidth(window.innerWidth - 12 - e.clientX));
  }

  function handleResizeEnd(e: PointerEvent<HTMLDivElement>) {
    document.body.classList.remove("ai-resizing");
    if (e.currentTarget.hasPointerCapture(e.pointerId)) savePanelWidth(panelWidth);
  }

  function handleResizeKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = clampPanelWidth(panelWidth + (e.key === "ArrowLeft" ? PANEL_WIDTH_STEP : -PANEL_WIDTH_STEP));
    setPanelWidth(next);
    savePanelWidth(next);
  }

  const askAboutShift = useCallback((target: AiShiftTarget) => {
    setShift(target);
    setDraft("Por que existe mais de um turno para este colaborador neste dia?");
    setOpen(true);
  }, []);
  const contextValue = useMemo(() => ({ askAboutShift }), [askAboutShift]);

  async function submit(question: string, target: AiShiftTarget | null, screenForAi: string | null, choices: Record<string, number | null>) {
    const run = ++currentRun.current;
    setRunning(true);
    setProgress("Iniciando");
    setError(null);
    setPending(null);
    try {
      const outcome = await aiAsk({
        conversation,
        question,
        screen: screenForAi,
        shift: target && { shiftId: target.shiftId, employeeId: target.employeeId, workDate: target.workDate },
        nameChoices: choices,
      });
      if (run !== currentRun.current) return;
      if (outcome.kind === "needsChoice") {
        setPending({ question, shift: target, screen: screenForAi, ambiguities: outcome.ambiguities, choices });
      } else {
        setConversation(outcome.conversation);
        setMessages((prev) => [...prev, { role: "assistant", answer: outcome.answer, links: outcome.links }]);
        setShift(null);
        if (!openRef.current) setUnseenAnswer(true);
      }
    } catch (e) {
      if (run === currentRun.current) setError(String(e));
    } finally {
      if (run === currentRun.current) setRunning(false);
    }
  }

  function handleSend() {
    const question = draft.trim();
    if (!question || running || pending) return;
    setDraft("");
    setMessages((prev) => [...prev, { role: "user", text: question }]);
    void submit(question, shift, useScreen ? screen.forAi : null, {});
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleChoose(key: string, value: number | null) {
    if (!pending) return;
    const choices = { ...pending.choices, [key]: value };
    if (pending.ambiguities.some((a) => !(a.key in choices))) {
      setPending({ ...pending, choices });
    } else {
      void submit(pending.question, pending.shift, pending.screen, choices);
    }
  }

  /** Replaces the whole filter set, so a filter left on from before can't hide rows the answer counted. */
  function openLink(link: AiScreenLink) {
    if (link.screen === "payments") {
      applyPaymentsFiltersSnapshot(paymentsFilters, {
        employeeIds: link.employeeIds.map(String),
        companyIds: link.companyIds.map(String),
        clientIds: link.clientIds.map(String),
        roleIds: link.roleIds.map(String),
        locals: link.locals,
        periodStart: link.periodStart ?? "",
        periodEnd: link.periodEnd ?? "",
        statuses: link.statuses.length > 0 ? (link.statuses as PaymentShiftStatus[]) : ALL_PAYMENT_STATUSES,
        shiftPeriods: ["diurno", "noturno"],
        scheduleTimeFilter: null,
        grouped: false,
      });
      paymentsFilters.setPage(0);
      navigate("/payments");
    } else {
      libraryFilters.setSelectedEmployeeIds(toIds(link.employeeIds));
      libraryFilters.setSelectedCompanyIds(toIds(link.companyIds));
      libraryFilters.setSelectedClientIds(toIds(link.clientIds));
      libraryFilters.setPeriod(link.periodStart ?? "", link.periodEnd ?? "");
      libraryFilters.setSelectedStatuses(new Set(link.statuses.length > 0 ? (link.statuses as PeriodStatusId[]) : PERIOD_STATUS_OPTIONS.map((o) => o.id)));
      libraryFilters.setPage(0);
      navigate("/");
    }
  }

  function handleNewConversation() {
    currentRun.current += 1;
    setRunning(false);
    setMessages([]);
    setConversation([]);
    setPending(null);
    setShift(null);
    setError(null);
    setDraft("");
  }

  const nextAmbiguity = pending?.ambiguities.find((a) => !(a.key in pending.choices));

  return (
    <AiAssistantContext.Provider value={contextValue}>
      <div className="ai-layout">
        <div className="ai-layout-main">{children}</div>
        {rendered && (
          <div className={visible ? "ai-side ai-side-visible" : "ai-side"} style={{ width: visible ? panelWidth + PANEL_COLUMN_EXTRA : 0 }}>
            <div
              className="ai-resize-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label="Redimensionar assistente"
              aria-valuenow={panelWidth}
              aria-valuemin={MIN_PANEL_WIDTH}
              tabIndex={0}
              onPointerDown={handleResizeStart}
              onPointerMove={handleResizeMove}
              onPointerUp={handleResizeEnd}
              onPointerCancel={handleResizeEnd}
              onKeyDown={handleResizeKey}
            />
            <section className="ai-panel" aria-label="Assistente" style={{ width: panelWidth }}>
              <header className="ai-panel-header">
                <span className="ai-panel-title">Assistente</span>
                <div className="ai-panel-header-actions">
                  <span className="ai-tooltip-anchor">
                    <button type="button" className="ai-icon-button" aria-label="Nome, CPF e PIX não são enviados">
                      <Lock size={16} />
                    </button>
                    <span className="ai-tooltip" aria-hidden="true">
                      Nome, CPF e PIX não são enviados
                    </span>
                  </span>
                  <button type="button" className="ai-icon-button" aria-label="Nova conversa" title="Nova conversa" onClick={handleNewConversation} disabled={messages.length === 0 && !shift}>
                    <SquarePen size={16} />
                  </button>
                  <button type="button" className="ai-icon-button" aria-label="Fechar assistente" title="Fechar" onClick={() => setOpen(false)}>
                    <X size={16} />
                  </button>
                </div>
              </header>

              <div className="ai-panel-messages" aria-live="polite">
                {messages.length === 0 && !pending && ready !== false && (
                  <p className="ai-muted">Pergunte sobre qualquer tela, configuração ou dado do aplicativo. O assistente só responde: ele não altera nada.</p>
                )}
                {ready === false && (
                  <p className="ai-muted">
                    Para usar o assistente, faça login no Claude Code neste computador ou cadastre uma chave de API em{" "}
                    <Link to="/settings">Configurações</Link>.
                  </p>
                )}

                {messages.map((message, index) =>
                  message.role === "user" ? (
                    <div key={index} className="ai-question">
                      {message.text}
                    </div>
                  ) : (
                    <div key={index} className="ai-answer">
                      {message.answer.conclusion && <p className="ai-conclusion">{message.answer.conclusion}</p>}
                      {message.answer.facts.length > 0 && (
                        <div className="ai-facts">
                          {message.answer.facts.map((fact, factIndex) => (
                            <div key={factIndex} className="ai-fact">
                              <span className="ai-fact-label">{fact.label}</span>
                              <span className="ai-fact-value">{fact.value}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {message.answer.body && <p className="ai-body">{message.answer.body}</p>}
                      {message.answer.hypothesis && <p className="ai-body ai-hypothesis">Hipótese: {message.answer.hypothesis}</p>}
                      {message.links.map((link, linkIndex) => (
                        <button key={linkIndex} type="button" className="ai-link" onClick={() => openLink(link)}>
                          <span className="ai-link-text">
                            <span className="ai-link-label">{link.label}</span>
                            {linkSummary(link) && <span className="ai-link-summary">{linkSummary(link)}</span>}
                          </span>
                          <ArrowRight size={16} />
                        </button>
                      ))}
                    </div>
                  ),
                )}

                {nextAmbiguity && (
                  <div className="ai-answer">
                    <span>Quem é "{nextAmbiguity.term}"?</span>
                    <div className="ai-choices">
                      {nextAmbiguity.candidates.map((candidate) => (
                        <button key={candidate.id} type="button" className="ai-choice" onClick={() => handleChoose(nextAmbiguity.key, candidate.id)}>
                          {candidate.name}
                        </button>
                      ))}
                      <button type="button" className="ai-choice" onClick={() => handleChoose(nextAmbiguity.key, null)}>
                        Não é uma pessoa
                      </button>
                    </div>
                  </div>
                )}
                {running && (
                  <p className="ai-muted" role="status">
                    {progress}...
                  </p>
                )}
                {error && <div className="ai-error">{error}</div>}
                <div ref={endRef} />
              </div>

              <footer className="ai-panel-footer">
                <div className="ai-composer">
                  <div className="ai-chips" ref={contextRef}>
                    {contextOpen && (
                      <div className="ai-context-detail" onKeyDown={(e) => e.key === "Escape" && setContextOpen(false)}>
                        <span className="ai-context-title">Esta pergunta vai considerar</span>
                        {screen.rows.map((row) => (
                          <div key={row.label} className="ai-context-row">
                            <span className="ai-fact-label">{row.label}</span>
                            <span className="ai-fact-value">{row.value}</span>
                          </div>
                        ))}
                        <button
                          type="button"
                          className="ai-context-off"
                          onClick={() => {
                            setUseScreen(false);
                            setContextOpen(false);
                          }}
                        >
                          Não usar esta tela
                        </button>
                      </div>
                    )}
                    {useScreen ? (
                      <button type="button" className="ai-chip" aria-expanded={contextOpen} onClick={() => setContextOpen((value) => !value)}>
                        <PanelTop size={13} />
                        <span>{screen.label}</span>
                        {screen.detail && <span className="ai-chip-detail">{screen.detail}</span>}
                        <ChevronDown size={12} className="ai-chip-caret" />
                      </button>
                    ) : (
                      <button type="button" className="ai-chip ai-chip-off" onClick={() => setUseScreen(true)}>
                        <Plus size={13} />
                        Usar {screen.label} como base
                      </button>
                    )}
                    {shift && (
                      <span className="ai-chip">
                        <span>
                          Turno de {shift.employeeName}, {formatDateSlash(shift.workDate)}
                        </span>
                        <button type="button" className="ai-chip-remove" aria-label="Remover turno selecionado" onClick={() => setShift(null)}>
                          <X size={12} />
                        </button>
                      </span>
                    )}
                  </div>
                  <textarea
                    ref={inputRef}
                    rows={2}
                    aria-label="Sua pergunta"
                    placeholder="Pergunte sobre esta tela ou sobre seus dados"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={ready === false}
                  />
                  <div className="ai-composer-actions">
                    <button type="button" className="ai-send" aria-label="Enviar pergunta" onClick={handleSend} disabled={!draft.trim() || running || pending !== null || ready === false}>
                      <ArrowUp size={16} />
                    </button>
                  </div>
                </div>
              </footer>
            </section>
          </div>
        )}
      </div>
      {!open && (
        <button type="button" className="ai-launcher" aria-label="Abrir assistente" title="Assistente" onClick={() => setOpen(true)}>
          {running ? <Loader2 size={20} className="ai-spin" /> : <MessageCircle size={20} />}
          {unseenAnswer && <span className="ai-launcher-dot" />}
        </button>
      )}
    </AiAssistantContext.Provider>
  );
}
