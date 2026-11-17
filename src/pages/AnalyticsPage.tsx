import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  CheckCircle2,
  Clock3,
  Moon,
  Users,
  Activity,
  Filter,
  FileDown,
  FileSpreadsheet,
  Bookmark,
  Settings2,
  RefreshCw,
  ChevronDown,
  MoreHorizontal,
  Search as SearchIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { periodPresets } from "../components/LibraryFiltersPanel";
import PeriodPicker, { formatPeriodShort } from "../components/PeriodPicker";
import PaymentsFiltersDrawer, { type PaymentsFiltersValue } from "../components/PaymentsFiltersDrawer";
import Modal from "../components/Modal";
import PageHeader from "../components/PageHeader";
import ConfirmModal from "../components/ConfirmModal";
import { applyPaymentsFiltersSnapshot, PAYMENT_SHIFT_STATUSES, SHIFT_PERIODS, snapshotPaymentsFilters, usePaymentsFilters, type PaymentsFiltersSnapshot } from "../contexts/FiltersContext";
import { orAll } from "../lib/filterSets";
import { useRemoteFileUpdates } from "../contexts/RemoteFileUpdatesContext";
import { countPaymentShiftsPendingAudit, listAllLatestShiftDiffs, listClients, listCompanies, listDistinctPaymentShiftLocals, listPaymentShiftsForReport, listRolesGlobal, type CheckDiffRow, type ClientRow, type CompanyRow, type ListPaymentShiftSummariesQuery, type PaymentShiftReportRow, type RoleRow } from "../lib/db";
import { toIso, todayUtc } from "../lib/calendar";
import { formatCurrencyBRL, scheduleDurationMinutes } from "../lib/format";
import { buildShiftValueResolver } from "../lib/paymentShiftValue";
import { exportAnalyticsPdf, exportAnalyticsXlsx } from "../lib/analyticsExport";

type Tab = "overview" | "costs" | "journeys" | "audit" | "occurrences";
type Cards = Record<Tab, string[]>;
type SavedView = { id: string; name: string; tab: Tab; start: string; end: string; filters: PaymentsFiltersSnapshot; cards: Cards };
const DEFAULT_CARDS: Cards = { overview: ["total","paid","pending","hours","trend","clients","attention"], costs: ["total","paid","pending","night","companies","roles","employees"], journeys: ["long","short","rest","night","heatmap"], audit: ["audit","errors","missing","analyzed","priorities"], occurrences: ["unseen","changed","unresolved","newShifts","occurrencePriorities","occurrenceSources"] };
const LABELS: Record<string,string> = { total:"Custo total",paid:"Total pago",hours:"Horas previstas",employees:"Colaboradores",trend:"Custo por dia",clients:"Maiores clientes",attention:"Pontos de atenção",pending:"A pagar",night:"Turnos noturnos",companies:"Ranking por empresa",roles:"Ranking por função",long:"Jornadas acima de 12h",short:"Jornadas abaixo de 4h",rest:"Intervalos abaixo de 11h",heatmap:"Mapa de calor",audit:"Pendentes de conferência",errors:"Turnos com erro",missing:"Sem valor definido",analyzed:"Turnos analisados",priorities:"Prioridades",unseen:"Não vistas",changed:"Dados alterados",unresolved:"Não identificados",newShifts:"Novos turnos",occurrencePriorities:"Tipos de ocorrência",occurrenceSources:"Fontes com ocorrências" };
function loadCards(): Cards {
  try {
    const cards: Cards = { ...DEFAULT_CARDS, ...JSON.parse(localStorage.getItem("analytics-visible-cards") || "{}") };
    // Visão geral used to have a "Colaboradores" card (now part of "Horas
    // previstas") and no "A pagar"/"Pontos de atenção": migrate saved choices.
    if (cards.overview.includes("employees")) {
      cards.overview = [...cards.overview.map((id) => (id === "employees" ? "pending" : id)), "attention"];
    }
    return cards;
  } catch {
    return DEFAULT_CARDS;
  }
}

/** "1 turno" / "15 turnos". */
function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("pt-BR")} ${n === 1 ? one : many}`;
}
function loadViews(): SavedView[] { try { const x=JSON.parse(localStorage.getItem("analytics-saved-views")||"[]"); return Array.isArray(x)?x:[]; } catch { return []; } }

function currentMonth(): [string, string] {
  const today = todayUtc();
  return [toIso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))), toIso(today)];
}

/** Same horas trabalhadas as every other screen (`scheduleDurationMinutes`), 0 for a shift with no horário. */
function durationMinutes(row: PaymentShiftReportRow): number {
  return scheduleDurationMinutes(row) ?? 0;
}

/**
 * `amount` is only recorded once a shift is paid (or typed by hand) — a
 * pending one has `null` there. Swaps in each row's Valor as Pagamentos and
 * its exports show it (`buildShiftValueResolver`: the recorded amount, else
 * the value-rule estimate), so every total, ranking and export on this page
 * counts pending shifts at their estimated cost instead of R$ 0.
 */
async function withShiftValues(rows: PaymentShiftReportRow[]): Promise<PaymentShiftReportRow[]> {
  const value = await buildShiftValueResolver(rows);
  return rows.map((r) => ({ ...r, amount: value(r) }));
}

function formatHours(minutes: number): string {
  return `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(minutes / 60)} h`;
}

function StatCard({ icon, label, value, detail, tone = "accent", onClick }: {
  icon: ReactNode; label: string; value: string; detail: string; tone?: "accent" | "success" | "warning" | "danger"; onClick?:()=>void;
}) {
  return (
    <article className={`analytics-stat analytics-stat-${tone}${onClick?" clickable":""}`} role={onClick?"button":undefined} tabIndex={onClick?0:undefined} onClick={onClick} onKeyDown={(e)=>{if(onClick&&(e.key==="Enter"||e.key===" "))onClick();}}>
      <div className="analytics-stat-icon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}

/** Overview KPI: label (+ optional delta pill), big value, optional progress bar, detail line and link. */
function KpiCard({ label, delta, value, valueColor, bar, detail, action }: {
  label: string; delta?: string; value: string; valueColor?: string; bar?: { pct: number; color: string }; detail: ReactNode; action?: { label: string; onClick: () => void };
}) {
  return (
    <article className="analytics-kpi">
      <span className="analytics-kpi-label">{label}{delta && <span className="analytics-kpi-delta">{delta}</span>}</span>
      <strong className="analytics-kpi-value" style={valueColor ? { color: valueColor } : undefined}>{value}</strong>
      {bar && <span className="analytics-kpi-bar"><span style={{ width: `${Math.min(100, Math.max(0, bar.pct))}%`, background: bar.color }} /></span>}
      <span className="analytics-kpi-detail">{detail}</span>
      {action && <button type="button" className="analytics-kpi-link" onClick={action.onClick}>{action.label} <ArrowRight size={13} /></button>}
    </article>
  );
}

const MONTH_SHORT = ["jan.", "fev.", "mar.", "abr.", "maio", "jun.", "jul.", "ago.", "set.", "out.", "nov.", "dez."];

/**
 * Cost per day as stacked bars (paid / a pagar) — one bar for every day of
 * the period, empty days included, so a single busy day reads as one bar
 * instead of the triangle a line between two zeros used to draw. Periods
 * longer than ~2 months group by week.
 */
function DailyBars({ rows, start, end }: { rows: PaymentShiftReportRow[]; start: string; end: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const buckets = useMemo(() => {
    const startMs = Date.parse(`${start}T00:00:00Z`), endMs = Date.parse(`${end}T00:00:00Z`);
    const dayCount = Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);
    const step = dayCount > 62 ? 7 : 1;
    const list: { from: number; paid: number; pending: number; shifts: number }[] = [];
    for (let i = 0; i < dayCount; i += step) list.push({ from: startMs + i * 86400000, paid: 0, pending: 0, shifts: 0 });
    rows.forEach((r) => {
      const idx = Math.floor((Date.parse(`${r.workDate}T00:00:00Z`) - startMs) / 86400000 / step);
      const b = list[idx];
      if (!b) return;
      if (r.status === "pago") b.paid += r.amount ?? 0; else b.pending += r.amount ?? 0;
      b.shifts++;
    });
    return { list, step };
  }, [rows, start, end]);
  if (!rows.length) return <EmptyChart />;
  const W = 640, H = 220, padL = 52, padB = 22, padT = 8;
  const rawMax = Math.max(...buckets.list.map((b) => b.paid + b.pending), 1);
  const magnitude = 10 ** Math.floor(Math.log10(rawMax));
  const niceMax = Math.ceil(rawMax / magnitude) * magnitude;
  const ticks = [0, niceMax / 2, niceMax];
  const bw = (W - padL) / buckets.list.length;
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / niceMax);
  const labelEvery = Math.ceil(buckets.list.length / 9);
  const fmtDay = (ms: number) => { const d = new Date(ms); return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
  const fmtTick = (v: number) => v === 0 ? "0" : v >= 1000 ? `R$ ${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(v / 1000)} mil` : `R$ ${Math.round(v)}`;
  const hovered = hover !== null ? buckets.list[hover] : null;
  return (
    <div className="analytics-daily">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Custo por dia no período">
        {ticks.map((t) => <g key={t}><line x1={padL} x2={W} y1={y(t)} y2={y(t)} stroke="var(--border-soft)" /><text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize="10" fill="var(--text-muted)">{fmtTick(t)}</text></g>)}
        {buckets.list.map((b, i) => {
          const x = padL + i * bw + bw * 0.18, w = Math.max(1, bw * 0.64), total = b.paid + b.pending;
          const d = new Date(b.from);
          return <g key={b.from}>
            {total === 0
              ? <rect x={x} y={y(0) - 2} width={w} height={2} rx={1} fill="var(--border-soft)" />
              : <><rect x={x} y={y(b.paid)} width={w} height={y(0) - y(b.paid)} rx={2} fill="var(--success)" /><rect x={x} y={y(total)} width={w} height={y(b.paid) - y(total)} rx={2} fill="#6b6b75" /></>}
            <rect x={padL + i * bw} y={padT} width={bw} height={H - padT - padB} fill="transparent" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
            {i % labelEvery === 0 && <text x={x + w / 2} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--text-muted)">{buckets.step === 1 ? fmtDay(b.from) : `${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]}`}</text>}
          </g>;
        })}
      </svg>
      {hovered && hover !== null && (
        <div className="analytics-daily-tip" style={{ left: `${((padL + (hover + 0.5) * bw) / W) * 100}%` }}>
          <b>{buckets.step === 1 ? fmtDay(hovered.from) : `Semana de ${fmtDay(hovered.from)}`}</b>
          {hovered.shifts === 0 ? <span>Nenhum turno</span> : <><span>Pago {formatCurrencyBRL(hovered.paid)}</span><span>A pagar {formatCurrencyBRL(hovered.pending)}</span><span>{plural(hovered.shifts, "turno", "turnos")}</span></>}
        </div>
      )}
    </div>
  );
}

/** A header button that opens a small menu below it (Exportar, "⋯"). */
function MenuButton({ label, icon, iconOnly, items }: { label: string; icon: ReactNode; iconOnly?: boolean; items: ({ label: string; icon: ReactNode; onClick: () => void; disabled?: boolean } | "sep")[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className="analytics-menu-wrap" ref={ref}>
      <button type="button" className={`outline${iconOnly ? " analytics-icon-button" : ""}`} aria-haspopup="menu" aria-expanded={open} aria-label={iconOnly ? label : undefined} title={iconOnly ? label : undefined} onClick={() => setOpen((o) => !o)}>
        {icon}{!iconOnly && <>{label}<ChevronDown size={13} /></>}
      </button>
      {open && <div className="analytics-menu" role="menu">
        {items.map((item, i) => item === "sep" ? <div key={`sep-${i}`} className="analytics-menu-sep" /> : (
          <button key={item.label} type="button" role="menuitem" disabled={item.disabled} onClick={() => { setOpen(false); item.onClick(); }}>{item.icon}{item.label}</button>
        ))}
      </div>}
    </div>
  );
}

function EmptyChart() {
  return <div className="analytics-empty">Não há dados no período selecionado.</div>;
}

function CostBars({ rows, onSelect, showRank = true }: { rows: { label: string; value: number; detail?: string }[]; onSelect?:(i:number)=>void; showRank?: boolean }) {
  const max = Math.max(...rows.map((r) => r.value), 0);
  if (!rows.length) return <EmptyChart />;
  return (
    <div className="analytics-bars">
      {rows.map((row, index) => (
        <button type="button" className={`analytics-bar-row${onSelect?" clickable":""}`} disabled={!onSelect} onClick={()=>onSelect?.(index)} key={row.label}>
          {showRank && <span className="analytics-bar-rank">{index + 1}</span>}
          <div className="analytics-bar-main">
            <div className="analytics-bar-label"><span title={row.label}>{row.label}</span><strong>{formatCurrencyBRL(row.value)}</strong></div>
            <div className="analytics-bar-track"><span style={{ width: `${max ? Math.max(3, row.value / max * 100) : 0}%` }} /></div>
            {row.detail && <small>{row.detail}</small>}
          </div>
        </button>
      ))}
    </div>
  );
}

function aggregate(rows: PaymentShiftReportRow[], key: (r: PaymentShiftReportRow) => string) {
  const groups = new Map<string, { value: number; shifts: number }>();
  rows.forEach((r) => {
    const label = key(r) || "Não informado";
    const current = groups.get(label) ?? { value: 0, shifts: 0 };
    current.value += r.amount ?? 0;
    current.shifts++;
    groups.set(label, current);
  });
  return Array.from(groups, ([label, value]) => ({ label, ...value }))
    .sort((a, b) => b.value - a.value || b.shifts - a.shifts);
}

export default function AnalyticsPage() {
  const navigate = useNavigate();
  const paymentFilters = usePaymentsFilters();
  const { trackedFiles } = useRemoteFileUpdates();
  const [[periodStart, periodEnd], setPeriod] = useState<[string,string]>(()=>paymentFilters.periodStart&&paymentFilters.periodEnd?[paymentFilters.periodStart,paymentFilters.periodEnd]:currentMonth());
  const [tab, setTab] = useState<Tab>("overview");
  const [rows, setRows] = useState<PaymentShiftReportRow[]>([]);
  const [previousRows, setPreviousRows] = useState<PaymentShiftReportRow[]>([]);
  const [pendingAudit, setPendingAudit] = useState(0);
  const [occurrenceRows, setOccurrenceRows] = useState<CheckDiffRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exportError,setExportError]=useState<string|null>(null); const [exporting,setExporting]=useState(false);
  const [filtersOpen,setFiltersOpen]=useState(false); const [cardsOpen,setCardsOpen]=useState(false); const [viewsOpen,setViewsOpen]=useState(false); const [deleteView,setDeleteView]=useState<SavedView|null>(null);
  const [cards,setCards]=useState<Cards>(loadCards); const [views,setViews]=useState<SavedView[]>(loadViews); const [viewName,setViewName]=useState(""); const [selectedView,setSelectedView]=useState("");
  const [catalogs,setCatalogs]=useState<{companies:CompanyRow[];clients:ClientRow[];roles:RoleRow[];locals:string[]}>({companies:[],clients:[],roles:[],locals:[]});
  const visible=(id:string)=>cards[tab].includes(id);

  useEffect(()=>{Promise.all([listCompanies(),listClients(),listRolesGlobal(),listDistinctPaymentShiftLocals()]).then(([companies,clients,roles,locals])=>setCatalogs({companies,clients,roles,locals})).catch(()=>{});},[]);
  // The background checker replaces `trackedFiles` after each completed
  // batch, so the dashboard refreshes while it is open without polling.
  useEffect(()=>{listAllLatestShiftDiffs().then(setOccurrenceRows).catch(()=>{});},[trackedFiles]);
  useEffect(()=>{if(views.length||!localStorage.getItem("analytics-saved-view"))return;try{const old=JSON.parse(localStorage.getItem("analytics-saved-view")!);if(old?.start&&old?.end){const v:SavedView={id:crypto.randomUUID(),name:"Visão migrada",tab:old.tab||"overview",start:old.start,end:old.end,filters:snapshotPaymentsFilters(paymentFilters),cards};setViews([v]);localStorage.setItem("analytics-saved-views",JSON.stringify([v]));}}catch{/* fallback seguro */}},[]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query: Omit<ListPaymentShiftSummariesQuery, "page" | "pageSize"> = {
      employeeIds:Array.from(paymentFilters.selectedEmployeeIds,Number), companyIds:Array.from(paymentFilters.selectedCompanyIds,Number), clientIds:Array.from(paymentFilters.selectedClientIds,Number), roleIds:Array.from(paymentFilters.selectedRoleIds,Number), locals:Array.from(paymentFilters.selectedLocals),
      periodStart,
      periodEnd,
      statuses: orAll(paymentFilters.selectedStatuses, PAYMENT_SHIFT_STATUSES),
      shiftPeriods: orAll(paymentFilters.selectedShiftPeriods, SHIFT_PERIODS), scheduleTimeFilter:paymentFilters.scheduleTimeFilter,
    };
    const start=new Date(`${periodStart}T00:00:00Z`),end=new Date(`${periodEnd}T00:00:00Z`),days=Math.round((end.getTime()-start.getTime())/86400000)+1,previousEnd=new Date(start.getTime()-86400000),previousStart=new Date(previousEnd.getTime()-(days-1)*86400000);
    Promise.all([listPaymentShiftsForReport(query).then(withShiftValues), countPaymentShiftsPendingAudit(query),listPaymentShiftsForReport({...query,periodStart:toIso(previousStart),periodEnd:toIso(previousEnd)}).then(withShiftValues)])
      .then(([nextRows, nextPending,previous]) => { if (!cancelled) { setRows(nextRows); setPendingAudit(nextPending); setPreviousRows(previous); } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [periodStart, periodEnd,paymentFilters.selectedEmployeeIds,paymentFilters.selectedCompanyIds,paymentFilters.selectedClientIds,paymentFilters.selectedRoleIds,paymentFilters.selectedLocals,paymentFilters.selectedStatuses,paymentFilters.selectedShiftPeriods,paymentFilters.scheduleTimeFilter]);

  const metrics = useMemo(() => {
    const paidRows = rows.filter((r) => r.status === "pago");
    const pendingRows = rows.filter((r) => r.status === "pendente");
    return {
      total: rows.reduce((sum, r) => sum + (r.amount ?? 0), 0),
      paid: paidRows.reduce((sum, r) => sum + (r.amount ?? 0), 0),
      pending: pendingRows.reduce((sum, r) => sum + (r.amount ?? 0), 0),
      minutes: rows.reduce((sum, r) => sum + durationMinutes(r), 0),
      employees: new Set(rows.map((r) => r.employeeId)).size,
      night: rows.filter((r) => r.shiftPeriod === "noturno").length,
      errors: rows.filter((r) => r.status === "erro").length,
      missingAmount: rows.filter((r) => r.amount === null).length,
    };
  }, [rows]);
  const clients = useMemo(() => aggregate(rows, (r) => r.clientName), [rows]);
  const companies = useMemo(() => aggregate(rows, (r) => r.companyName), [rows]);
  const roles = useMemo(() => aggregate(rows, (r) => r.role), [rows]);
  const employees = useMemo(() => aggregate(rows, (r) => r.employeeName), [rows]);
  const previousTotal=previousRows.reduce((sum,r)=>sum+(r.amount??0),0),variation=previousTotal?(metrics.total-previousTotal)/previousTotal*100:null;
  const previousRange=useMemo(()=>{const start=Date.parse(`${periodStart}T00:00:00Z`),end=Date.parse(`${periodEnd}T00:00:00Z`),days=Math.round((end-start)/86400000)+1,prevEnd=start-86400000,prevStart=prevEnd-(days-1)*86400000;return formatPeriodShort(toIso(new Date(prevStart)),toIso(new Date(prevEnd)));},[periodStart,periodEnd]);
  const presets=useMemo(()=>periodPresets(),[]);
  const long=rows.filter(r=>durationMinutes(r)>720), short=rows.filter(r=>durationMinutes(r)>0&&durationMinutes(r)<240);
  const restIds=useMemo(()=>{const a=[...rows].filter(r=>r.scheduleStartMinutes!==null&&r.scheduleEndMinutes!==null).sort((x,y)=>x.employeeId-y.employeeId||x.workDate.localeCompare(y.workDate)||x.scheduleStartMinutes!-y.scheduleStartMinutes!);const ids:number[]=[];for(let i=1;i<a.length;i++){const p=a[i-1],c=a[i];if(p.employeeId!==c.employeeId)continue;const pe=new Date(`${p.workDate}T00:00:00Z`).getTime()+(p.scheduleEndMinutes!+(p.scheduleEndMinutes!<p.scheduleStartMinutes!?1440:0))*60000,cs=new Date(`${c.workDate}T00:00:00Z`).getTime()+c.scheduleStartMinutes!*60000;if(cs>=pe&&cs-pe<39600000)ids.push(c.id);}return ids;},[rows]);
  const occurrences=useMemo(()=>{
    // A field change can produce several DB rows for one turno. The dashboard
    // counts the actionable occurrence once, while the detail screen keeps
    // showing every changed field.
    const groups=new Map<string,CheckDiffRow[]>();
    occurrenceRows.forEach(r=>{const identity=r.matchedShiftId!==null?`shift:${r.matchedShiftId}`:`row:${r.configId}:${r.sheetName}:${r.rowNumber}:${r.employeeName}:${r.workDate}`;const key=`${r.checkLogId}:${r.changeKind}:${identity}`;groups.set(key,[...(groups.get(key)??[]),r]);});
    const items=Array.from(groups.values());
    const count=(kind:CheckDiffRow["changeKind"])=>items.filter(g=>g[0].changeKind===kind).length;
    const unseen=items.filter(g=>g.some(r=>r.dismissedAt===null));
    const bySource=new Map<string,{label:string;count:number;unseen:number}>();
    items.forEach(g=>{const first=g[0],key=first.configId===null?first.sourceUrl:`${first.sourceUrl}:${first.configId}`,current=bySource.get(key)??{label:first.configLabel||first.sourceUrl,count:0,unseen:0};current.count++;if(g.some(r=>r.dismissedAt===null))current.unseen++;bySource.set(key,current);});
    return {total:items.length,unseen:unseen.length,field:count("field"),unresolved:count("unresolved"),newShift:count("new-shift"),removed:count("removed"),errors:count("error"),applied:items.filter(g=>g.some(r=>r.applied)).length,sources:Array.from(bySource.values()).sort((a,b)=>b.unseen-a.unseen||b.count-a.count).slice(0,8)};
  },[occurrenceRows]);
  const activeFilterCount=[paymentFilters.selectedEmployeeIds.size,paymentFilters.selectedCompanyIds.size,paymentFilters.selectedClientIds.size,paymentFilters.selectedRoleIds.size,paymentFilters.selectedLocals.size,paymentFilters.selectedStatuses.size>0,paymentFilters.selectedShiftPeriods.size>0,paymentFilters.scheduleTimeFilter!==null].filter(Boolean).length;
  const filterDescription=useMemo(()=>{const parts:string[]=[];const names=(ids:Set<string>,source:{id:number;name:string}[])=>Array.from(ids).map(id=>source.find(x=>String(x.id)===id)?.name||id).join(", ");if(paymentFilters.selectedCompanyIds.size)parts.push(`Empresas: ${names(paymentFilters.selectedCompanyIds,catalogs.companies)}`);if(paymentFilters.selectedClientIds.size)parts.push(`Clientes: ${names(paymentFilters.selectedClientIds,catalogs.clients)}`);if(paymentFilters.selectedRoleIds.size)parts.push(`Funções: ${names(paymentFilters.selectedRoleIds,catalogs.roles)}`);if(paymentFilters.selectedEmployeeIds.size)parts.push(`Colaboradores selecionados: ${paymentFilters.selectedEmployeeIds.size}`);if(paymentFilters.selectedLocals.size)parts.push(`Locais: ${Array.from(paymentFilters.selectedLocals).join(", ")}`);if(paymentFilters.selectedStatuses.size>0)parts.push(`Status: ${Array.from(paymentFilters.selectedStatuses).join(", ")}`);if(paymentFilters.selectedShiftPeriods.size>0)parts.push(`Diurno/noturno: ${Array.from(paymentFilters.selectedShiftPeriods).join(", ")}`);if(paymentFilters.scheduleTimeFilter)parts.push("Horário personalizado ativo");return parts.length?parts.join("; "):"Nenhum filtro adicional";},[paymentFilters.selectedCompanyIds,paymentFilters.selectedClientIds,paymentFilters.selectedRoleIds,paymentFilters.selectedEmployeeIds,paymentFilters.selectedLocals,paymentFilters.selectedStatuses,paymentFilters.selectedShiftPeriods,paymentFilters.scheduleTimeFilter,catalogs]);

  function preparePaymentsNavigation(statuses?: ("pendente" | "erro" | "pago")[],scope?:{employeeId?:number;companyId?:number;clientId?:number;roleId?:number},path="") {
    paymentFilters.setPeriod(periodStart, periodEnd);
    if(statuses)paymentFilters.setSelectedStatuses(new Set(statuses.length===PAYMENT_SHIFT_STATUSES.length?[]:statuses));
    if(scope?.employeeId)paymentFilters.setSelectedEmployeeIds(new Set([String(scope.employeeId)])); if(scope?.companyId)paymentFilters.setSelectedCompanyIds(new Set([String(scope.companyId)])); if(scope?.clientId)paymentFilters.setSelectedClientIds(new Set([String(scope.clientId)])); if(scope?.roleId)paymentFilters.setSelectedRoleIds(new Set([String(scope.roleId)]));
    paymentFilters.setGrouped(false);
    paymentFilters.setPage(0);
    navigate(`/payments${path}`);
  }
  function applyFilters(v:PaymentsFiltersValue){paymentFilters.setSelectedEmployeeIds(v.employeeIds);paymentFilters.setSelectedCompanyIds(v.companyIds);paymentFilters.setSelectedClientIds(v.clientIds);paymentFilters.setSelectedRoleIds(v.roleIds);paymentFilters.setSelectedLocals(v.locals);paymentFilters.setSelectedStatuses(v.statuses.size===PAYMENT_SHIFT_STATUSES.length?new Set():v.statuses);paymentFilters.setSelectedShiftPeriods(v.shiftPeriods.size===SHIFT_PERIODS.length?new Set():v.shiftPeriods);paymentFilters.setScheduleTimeFilter(v.scheduleTimeFilter);if(v.periodStart&&v.periodEnd)setPeriod([v.periodStart,v.periodEnd]);paymentFilters.setPage(0);setFiltersOpen(false);}
  function persistCards(next:Cards){setCards(next);localStorage.setItem("analytics-visible-cards",JSON.stringify(next));}
  function saveView(id?:string,explicitName?:string){const name=(explicitName??viewName).trim();if(!name)return;const v:SavedView={id:id||crypto.randomUUID(),name,tab,start:periodStart,end:periodEnd,filters:{...snapshotPaymentsFilters(paymentFilters),periodStart,periodEnd},cards};const next=id?views.map(x=>x.id===id?v:x):[...views,v];setViews(next);setSelectedView(v.id);setViewName(name);localStorage.setItem("analytics-saved-views",JSON.stringify(next));}
  function openView(v:SavedView){applyPaymentsFiltersSnapshot(paymentFilters,v.filters);setPeriod([v.start,v.end]);setTab(v.tab);persistCards({...DEFAULT_CARDS,...v.cards});setViewsOpen(false);}
  async function doExport(kind:"pdf"|"xlsx"){setExportError(null);setExporting(true);try{if(kind==="pdf")await exportAnalyticsPdf(rows,periodStart,periodEnd,filterDescription);else await exportAnalyticsXlsx(rows,periodStart,periodEnd,filterDescription);}catch(e){setExportError(e instanceof Error?e.message:String(e));}finally{setExporting(false);}}

  return (
    <div className="analytics-page">
      <PageHeader
        title="Análises"
        subtitle="Custos, operação e pontos de atenção do período."
        actions={
          <>
            <div className="analytics-period-picker">
              <PeriodPicker start={periodStart} end={periodEnd} onChange={(start, end) => { if (start && end) setPeriod([start, end]); }} presets={presets} />
            </div>
            <button type="button" className="outline" onClick={() => setFiltersOpen(true)}>
              <Filter size={15} />
              Filtros
              {activeFilterCount > 0 && <span className="analytics-count">{activeFilterCount}</span>}
            </button>
            <MenuButton
              label="Exportar"
              icon={<FileDown size={15} />}
              items={[
                { label: "Relatório em PDF", icon: <FileDown size={15} />, onClick: () => doExport("pdf"), disabled: exporting },
                { label: "Planilha Excel", icon: <FileSpreadsheet size={15} />, onClick: () => doExport("xlsx"), disabled: exporting },
              ]}
            />
            <MenuButton
              label="Mais opções"
              iconOnly
              icon={<MoreHorizontal size={16} />}
              items={[
                { label: views.length ? `Visões salvas (${views.length})` : "Visões salvas", icon: <Bookmark size={15} />, onClick: () => setViewsOpen(true) },
                "sep",
                { label: "Escolher cards desta aba", icon: <Settings2 size={15} />, onClick: () => setCardsOpen(true) },
              ]}
            />
          </>
        }
      />

      <div className="analytics-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab==="overview"} className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>Visão geral</button>
        <button type="button" role="tab" aria-selected={tab==="costs"} className={tab === "costs" ? "active" : ""} onClick={() => setTab("costs")}>Custos e pagamentos</button>
        <button type="button" role="tab" aria-selected={tab==="journeys"} className={tab === "journeys" ? "active" : ""} onClick={() => setTab("journeys")}>Jornadas</button>
        <button type="button" role="tab" aria-selected={tab==="audit"} className={tab === "audit" ? "active" : ""} onClick={() => setTab("audit")}><span>Auditoria</span>{pendingAudit + metrics.errors > 0 && <b>{pendingAudit + metrics.errors}</b>}</button>
        <button type="button" role="tab" aria-selected={tab==="occurrences"} className={tab === "occurrences" ? "active" : ""} onClick={() => setTab("occurrences")}><span>Ocorrências</span>{occurrences.unseen > 0 && <b>{occurrences.unseen}</b>}</button>
      </div>

      {error && <div className="error-box">Não foi possível carregar as análises: {error}</div>}
      {exportError && <div className="error-box">Não foi possível exportar: {exportError}</div>}
      {loading ? <div className="card analytics-loading">Carregando indicadores...</div> : (
        <>
          {tab === "overview" && <>
            <section className="analytics-kpis">
              {visible("total")&&<KpiCard
                label="Custo no período"
                delta={variation===null?undefined:`${variation>=0?"+":"−"}${Math.abs(variation).toFixed(1).replace(".",",")}%`}
                value={formatCurrencyBRL(metrics.total)}
                detail={variation===null?plural(rows.length,"turno no período","turnos no período"):<>vs. <b>{formatCurrencyBRL(previousTotal)}</b> em {previousRange}</>}
              />}
              {visible("paid")&&<KpiCard
                label="Pago"
                value={formatCurrencyBRL(metrics.paid)}
                bar={{ pct: metrics.total ? metrics.paid / metrics.total * 100 : 0, color: "var(--success)" }}
                detail={<><b>{metrics.total ? Math.round(metrics.paid / metrics.total * 100) : 0}%</b> do custo · {plural(rows.filter((r) => r.status === "pago").length,"turno","turnos")}</>}
              />}
              {visible("pending")&&<KpiCard
                label="A pagar"
                value={formatCurrencyBRL(metrics.pending)}
                valueColor={metrics.pending > 0 ? "var(--warning)" : undefined}
                detail={plural(rows.filter((r) => r.status === "pendente").length,"turno pendente","turnos pendentes")}
                action={rows.some((r) => r.status === "pendente") ? { label: "Ver em Pagamentos", onClick: () => preparePaymentsNavigation(["pendente"]) } : undefined}
              />}
              {visible("hours")&&<KpiCard
                label="Horas previstas"
                value={formatHours(metrics.minutes)}
                detail={<><b>{plural(rows.length,"turno","turnos")}</b> · {plural(metrics.employees,"colaborador","colaboradores")} · {plural(metrics.night,"noturno","noturnos")}</>}
              />}
            </section>
            <section className="analytics-grid analytics-grid-main">
              {visible("trend")&&<div className="card analytics-panel">
                <header>
                  <div><h3>Custo por dia</h3><p className="analytics-panel-sub">Cada barra é um dia do período, inclusive os sem turno.</p></div>
                  <div className="analytics-legend"><span><i style={{ background: "var(--success)" }} />Pago</span><span><i style={{ background: "#6b6b75" }} />A pagar</span></div>
                </header>
                <DailyBars rows={rows} start={periodStart} end={periodEnd} />
              </div>}
              {visible("clients")&&<div className="card analytics-panel">
                <header><div><h3>Maiores clientes</h3><p className="analytics-panel-sub">Participação no custo do período</p></div></header>
                <CostBars showRank={false} rows={clients.slice(0, 5).map((r) => ({ ...r, detail: `${metrics.total ? Math.round(r.value / metrics.total * 100) : 0}% · ${plural(r.shifts, "turno", "turnos")}` }))} onSelect={i=>{const r=rows.find(x=>x.clientName===clients[i].label);if(r)preparePaymentsNavigation(undefined,{clientId:r.clientId});}}/>
              </div>}
            </section>
            {visible("attention")&&<section className="card analytics-panel analytics-attention">
              <header><div><h3>Pontos de atenção</h3><p className="analytics-panel-sub">O que pede uma ação neste período</p></div></header>
              {(() => {
                const items = [
                  { show: pendingAudit > 0, icon: <SearchIcon size={15} />, color: "var(--warning)", bg: "var(--warning-soft)", title: plural(pendingAudit, "pagamento aguardando conferência", "pagamentos aguardando conferência"), text: "Confira contra o extrato e registre o resultado.", action: "Abrir Auditoria", onClick: () => setTab("audit") },
                  { show: metrics.errors > 0, icon: <AlertTriangle size={15} />, color: "var(--danger)", bg: "var(--danger-soft)", title: plural(metrics.errors, "turno com erro", "turnos com erro"), text: "Corrija os dados antes de pagar.", action: "Ver em Pagamentos", onClick: () => preparePaymentsNavigation(["erro"]) },
                  { show: occurrences.unseen > 0, icon: <RefreshCw size={15} />, color: "#93c5fd", bg: "rgba(147, 197, 253, 0.12)", title: plural(occurrences.unseen, "atualização pendente", "atualizações pendentes"), text: "Planilhas por link mudaram desde a última leitura.", action: "Revisar", onClick: () => navigate("/remote-updates/imports") },
                ].filter((item) => item.show);
                if (!items.length) return <p className="analytics-attention-empty"><CheckCircle2 size={15} /> Nada pedindo ação neste período.</p>;
                return items.map((item) => (
                  <div className="analytics-attention-row" key={item.title}>
                    <span className="analytics-attention-icon" style={{ color: item.color, background: item.bg }}>{item.icon}</span>
                    <div><strong>{item.title}</strong><p>{item.text}</p></div>
                    <button type="button" className="analytics-kpi-link" onClick={item.onClick}>{item.action} <ArrowRight size={13} /></button>
                  </div>
                ));
              })()}
            </section>}
          </>}

          {tab === "costs" && <>
            <section className="analytics-stats">
              {visible("total")&&<StatCard icon={<Banknote size={21}/>} label="Custo total" value={formatCurrencyBRL(metrics.total)} detail="Valores definidos nos turnos" />}
              {visible("paid")&&<StatCard icon={<CheckCircle2 size={21}/>} label="Pago" value={formatCurrencyBRL(metrics.paid)} detail={metrics.total ? `${Math.round(metrics.paid / metrics.total * 100)}% do custo total` : "Sem custo registrado"} tone="success" />}
              {visible("pending")&&<StatCard icon={<Clock3 size={21}/>} label="Pendente" value={formatCurrencyBRL(metrics.pending)} detail={plural(rows.filter((r) => r.status === "pendente").length, "turno", "turnos")} tone="warning" />}
              {visible("night")&&<StatCard icon={<Moon size={21}/>} label="Turnos noturnos" value={String(metrics.night)} detail={`${rows.length ? Math.round(metrics.night / rows.length * 100) : 0}% dos turnos`} />}
            </section>
            <section className="analytics-grid">
              {visible("companies")&&<div className="card analytics-panel"><header><div><span className="analytics-eyebrow">Ranking</span><h3>Por empresa</h3></div></header><CostBars rows={companies.slice(0, 7).map((r) => ({ ...r, detail: plural(r.shifts, "turno", "turnos") }))} onSelect={i=>{const r=rows.find(x=>x.companyName===companies[i].label);if(r)preparePaymentsNavigation(undefined,{companyId:r.companyId});}}/></div>}
              {visible("roles")&&<div className="card analytics-panel"><header><div><span className="analytics-eyebrow">Ranking</span><h3>Por função</h3></div></header><CostBars rows={roles.slice(0, 7).map((r) => ({ ...r, detail: plural(r.shifts, "turno", "turnos") }))} onSelect={i=>{const r=rows.find(x=>x.role===roles[i].label);if(r?.roleId)preparePaymentsNavigation(undefined,{roleId:r.roleId});}}/></div>}
              {visible("employees")&&<div className="card analytics-panel analytics-wide"><header><div><span className="analytics-eyebrow">Pessoas</span><h3>Maiores custos por colaborador</h3></div></header><CostBars rows={employees.slice(0, 8).map((r) => ({ ...r, detail: plural(r.shifts, "turno", "turnos") }))} onSelect={i=>{const r=rows.find(x=>x.employeeName===employees[i].label);if(r)preparePaymentsNavigation(undefined,{employeeId:r.employeeId});}}/></div>}
            </section>
          </>}

          {tab === "journeys" && <>
            <section className="analytics-stats">
              {visible("long")&&<StatCard icon={<Clock3 size={21}/>} label="Jornadas acima de 12h" value={String(long.length)} detail="Possível excesso de jornada" tone="danger" onClick={()=>preparePaymentsNavigation(undefined,undefined,"?analytics=journey-over-12h")}/>}
              {visible("short")&&<StatCard icon={<Clock3 size={21}/>} label="Jornadas abaixo de 4h" value={String(short.length)} detail="Turnos fora do padrão" tone="warning" onClick={()=>preparePaymentsNavigation(undefined,undefined,"?analytics=journey-under-4h")}/>}
              {visible("rest")&&<StatCard icon={<Activity size={21}/>} label="Intervalos abaixo de 11h" value={String(restIds.length)} detail="Entre jornadas consecutivas" tone="danger" onClick={()=>preparePaymentsNavigation(undefined,undefined,`?analytics=rest-under-11h&ids=${restIds.join(",")}`)}/>}
              {visible("night")&&<StatCard icon={<Moon size={21}/>} label="Jornadas noturnas" value={String(metrics.night)} detail="Turnos classificados como noturnos"/>}
            </section>
            {visible("heatmap")&&<div className="card analytics-panel"><header><div><span className="analytics-eyebrow">Mapa de calor</span><h3>Turnos por dia e faixa de início</h3></div></header><div className="analytics-heatmap"><span/>{["00–06","06–12","12–18","18–24"].map(h=><strong key={h}>{h}</strong>)}{["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"].flatMap((day,weekday)=>{const counts=[0,1,2,3].map(bucket=>rows.filter(r=>new Date(`${r.workDate}T00:00:00Z`).getUTCDay()===weekday&&r.scheduleStartMinutes!==null&&Math.floor(r.scheduleStartMinutes/360)===bucket).length),max=Math.max(1,...counts);return [<strong key={`${day}-label`}>{day}</strong>,...counts.map((count,bucket)=><button type="button" key={`${day}-${bucket}`} style={{background:`rgba(246,246,248,${.06+count/max*.44})`}} aria-label={`${day}, ${bucket*6} a ${bucket*6+6} horas: ${count} turnos`} onClick={()=>preparePaymentsNavigation(undefined,undefined,`?analytics=heatmap&weekday=${weekday}&bucket=${bucket}`)}>{count}</button>)]})}</div></div>}
          </>}

          {tab === "audit" && <>
            <section className="analytics-stats">
              {visible("audit")&&<StatCard icon={<AlertTriangle size={21}/>} label="Pendentes de conferência" value={String(pendingAudit)} detail="Pagamentos ainda não auditados" tone="warning" />}
              {visible("errors")&&<StatCard icon={<AlertTriangle size={21}/>} label="Turnos com erro" value={String(metrics.errors)} detail="Exigem correção ou reprocessamento" tone="danger" />}
              {visible("missing")&&<StatCard icon={<Banknote size={21}/>} label="Sem valor definido" value={String(metrics.missingAmount)} detail="Não entram no total financeiro" tone="warning" />}
              {visible("analyzed")&&<StatCard icon={<CheckCircle2 size={21}/>} label="Turnos analisados" value={String(rows.length)} detail="Base dos indicadores do período" tone="success" />}
            </section>
            {visible("priorities")&&<div className="card analytics-panel analytics-audit-list">
              <header><div><span className="analytics-eyebrow">Prioridades</span><h3>O que precisa de atenção</h3></div></header>
              {[
                { label: "Pagamentos aguardando conferência", value: pendingAudit, text: "Confira os pagamentos contra o extrato e registre o resultado.", tone: "warning", to: "/payments?attention=pending-audit", statuses: ["pago"] as const },
                { label: "Turnos marcados com erro", value: metrics.errors, text: "Revise a mensagem de erro e corrija os dados antes de pagar.", tone: "danger", to: "/payments", statuses: ["erro"] as const },
                { label: "Turnos sem valor", value: metrics.missingAmount, text: "Configure uma regra de valor ou informe o valor manualmente.", tone: "warning", to: "/payments?attention=missing-amount", statuses: ["pendente", "erro", "pago"] as const },
              ].map((item) => <div className={`analytics-audit-item ${item.tone}`} key={item.label}><span className="analytics-audit-count">{item.value}</span><div><strong>{item.label}</strong><p>{item.text}</p></div><Link to={item.to} onClick={() => preparePaymentsNavigation([...item.statuses])} aria-label={`Abrir ${item.label}`}><ArrowRight size={18}/></Link></div>)}
            </div>}
          </>}
          {tab === "occurrences" && <>
            <div className="analytics-occurrence-note">
              <RefreshCw size={15}/>
              Estado atual das fontes com verificação automática. Estes indicadores são globais e não usam o período financeiro acima.
            </div>
            <section className="analytics-stats">
              {visible("unseen")&&<StatCard icon={<AlertTriangle size={21}/>} label="Não vistas" value={String(occurrences.unseen)} detail={`${plural(occurrences.total, "ocorrência", "ocorrências")} no estado atual`} tone={occurrences.unseen?"danger":"success"} onClick={()=>navigate("/remote-updates/imports")}/>}
              {visible("changed")&&<StatCard icon={<Activity size={21}/>} label="Dados alterados" value={String(occurrences.field)} detail={`${plural(occurrences.applied, "ocorrência já aplicada", "ocorrências já aplicadas")}`} tone="warning" onClick={()=>navigate("/remote-updates/imports")}/>}
              {visible("unresolved")&&<StatCard icon={<Users size={21}/>} label="Não identificados" value={String(occurrences.unresolved)} detail="Colaboradores que precisam ser vinculados" tone="danger" onClick={()=>navigate("/remote-updates/imports")}/>}
              {visible("newShifts")&&<StatCard icon={<Clock3 size={21}/>} label="Possíveis novos turnos" value={String(occurrences.newShift)} detail="Linhas novas encontradas nas fontes" tone="warning" onClick={()=>navigate("/remote-updates/imports")}/>}
            </section>
            <section className="analytics-grid analytics-grid-main">
              {visible("occurrencePriorities")&&<div className="card analytics-panel analytics-audit-list">
                <header><div><span className="analytics-eyebrow">Diagnóstico</span><h3>Tipos de ocorrência</h3></div></header>
                {[
                  {label:"Colaborador não identificado",value:occurrences.unresolved,text:"Cadastre o colaborador ou ajuste seus identificadores e reprocese.",tone:"danger"},
                  {label:"Erro de verificação",value:occurrences.errors,text:"A fonte, template ou arquivo não pôde ser processado.",tone:"danger"},
                  {label:"Campos alterados",value:occurrences.field,text:"Dados de turnos existentes mudaram na planilha de origem.",tone:"warning"},
                  {label:"Possíveis novos turnos",value:occurrences.newShift,text:"Novas linhas foram encontradas e precisam ser revisadas.",tone:"warning"},
                  {label:"Possíveis remoções",value:occurrences.removed,text:"Turnos existentes deixaram de aparecer na fonte.",tone:"warning"},
                ].map(item=><div className={`analytics-audit-item ${item.tone}`} key={item.label}><span className="analytics-audit-count">{item.value}</span><div><strong>{item.label}</strong><p>{item.text}</p></div><Link to="/remote-updates/imports" aria-label={`Revisar ${item.label}`}><ArrowRight size={18}/></Link></div>)}
              </div>}
              {visible("occurrenceSources")&&<div className="card analytics-panel">
                <header><div><span className="analytics-eyebrow">Origem</span><h3>Fontes com ocorrências</h3></div></header>
                {!occurrences.sources.length?<EmptyChart/>:<div className="analytics-occurrence-sources">{occurrences.sources.map((source,index)=><Link to="/remote-updates/imports" key={`${source.label}-${index}`}><span><b>{index+1}</b><span title={source.label}>{source.label}</span></span><strong>{source.unseen?plural(source.unseen,"nova","novas"):plural(source.count,"vista","vistas")}</strong></Link>)}</div>}
              </div>}
            </section>
          </>}
          <div className="analytics-footer-link"><Link to="/payments">Ver todos os turnos em Pagamentos <ArrowRight size={15}/></Link></div>
        </>
      )}
      {!cards[tab].length&&<div className="card analytics-empty">Nenhum card visível. Use “Escolher cards desta aba”, no menu ⋯, para restaurar o padrão.</div>}
      <PaymentsFiltersDrawer open={filtersOpen} onClose={()=>setFiltersOpen(false)} value={{employeeIds:paymentFilters.selectedEmployeeIds,companyIds:paymentFilters.selectedCompanyIds,clientIds:paymentFilters.selectedClientIds,roleIds:paymentFilters.selectedRoleIds,locals:paymentFilters.selectedLocals,periodStart,periodEnd,statuses:new Set(orAll(paymentFilters.selectedStatuses,PAYMENT_SHIFT_STATUSES)),shiftPeriods:new Set(orAll(paymentFilters.selectedShiftPeriods,SHIFT_PERIODS)),scheduleTimeFilter:paymentFilters.scheduleTimeFilter,grouped:false}} onApply={applyFilters} companies={catalogs.companies} clients={catalogs.clients} roles={catalogs.roles} locals={catalogs.locals} showGroupedToggle={false}/>
      {cardsOpen&&<Modal title="Escolher cards desta aba" onClose={()=>setCardsOpen(false)} footer={<><button type="button" onClick={()=>setCardsOpen(false)}>Concluir</button><button type="button" className="ghost" onClick={()=>persistCards({...cards,[tab]:[...DEFAULT_CARDS[tab]]})}>Restaurar padrão</button></>}><div className="analytics-card-options">{DEFAULT_CARDS[tab].map(id=><label key={id}><input type="checkbox" checked={cards[tab].includes(id)} onChange={()=>persistCards({...cards,[tab]:cards[tab].includes(id)?cards[tab].filter(x=>x!==id):[...cards[tab],id]})}/>{LABELS[id]}</label>)}</div></Modal>}
      {viewsOpen&&<Modal title="Visões favoritas" onClose={()=>setViewsOpen(false)} maxHeight="80vh"><div className="analytics-view-form"><label>Nome<input value={viewName} onChange={e=>setViewName(e.target.value)} placeholder="Ex.: Fechamento mensal"/></label><button type="button" disabled={!viewName.trim()} onClick={()=>saveView()}>Criar com estado atual</button></div><div className="analytics-view-list">{!views.length&&<p className="muted">Nenhuma visão salva.</p>}{views.map(v=><div key={v.id} className={selectedView===v.id?"active":""} onClick={()=>{setSelectedView(v.id);setViewName(v.name);}}><span><strong>{v.name}</strong><small>{v.start} a {v.end}</small></span><span><button type="button" className="secondary" onClick={e=>{e.stopPropagation();openView(v);}}>Abrir</button><button type="button" className="secondary" onClick={e=>{e.stopPropagation();saveView(v.id,v.name);}}>Atualizar</button><button type="button" className="danger" aria-label={`Excluir ${v.name}`} onClick={e=>{e.stopPropagation();setDeleteView(v);}}>×</button></span></div>)}</div>{selectedView&&<button type="button" disabled={!viewName.trim()} onClick={()=>saveView(selectedView)}>Renomear / atualizar selecionada</button>}</Modal>}
      {deleteView&&<ConfirmModal title="Excluir visão" message={`Excluir a visão “${deleteView.name}”?`} confirmLabel="Excluir" onCancel={()=>setDeleteView(null)} onConfirm={()=>{const next=views.filter(v=>v.id!==deleteView.id);setViews(next);localStorage.setItem("analytics-saved-views",JSON.stringify(next));setDeleteView(null);setSelectedView("");}}/>}
    </div>
  );
}
