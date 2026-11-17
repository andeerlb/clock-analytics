import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Filter,
  Bookmark,
  RefreshCw,
  ChevronDown,
  MoreHorizontal,
  Search as SearchIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { periodPresets } from "../components/LibraryFiltersPanel";
import PeriodPicker, { formatPeriodShort } from "../components/PeriodPicker";
import PaymentsFiltersPanel, { usePaymentsActiveFilterCount } from "../components/PaymentsFiltersPanel";
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
import { openReconciliationWindow } from "../lib/api";

type Tab = "overview" | "costs" | "journeys" | "audit";
const TABS: Tab[] = ["overview", "costs", "journeys", "audit"];
/** `cards` is a leftover from the removed "Escolher cards" — still present in older saved views, ignored. */
type SavedView = { id: string; name: string; tab: Tab; start: string; end: string; filters: PaymentsFiltersSnapshot; cards?: unknown };
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
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry.contentRect.width))));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
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
  const W = width, H = 240, padL = 64, padB = 24, padT = 10;
  const rawMax = Math.max(...buckets.list.map((b) => b.paid + b.pending), 1);
  const magnitude = 10 ** Math.floor(Math.log10(rawMax));
  const niceMax = Math.ceil(rawMax / magnitude) * magnitude;
  const ticks = [0, niceMax / 2, niceMax];
  const bw = (W - padL) / buckets.list.length;
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / niceMax);
  const labelEvery = Math.max(1, Math.ceil(buckets.list.length / Math.max(2, Math.floor((W - padL) / 56))));
  const fmtDay = (ms: number) => { const d = new Date(ms); return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
  const fmtTick = (v: number) => v === 0 ? "0" : v >= 1000 ? `R$ ${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(v / 1000)} mil` : `R$ ${Math.round(v)}`;
  const hovered = hover !== null ? buckets.list[hover] : null;
  return (
    <div className="analytics-daily" ref={boxRef}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Custo por dia no período">
        {ticks.map((t) => <g key={t}><line x1={padL} x2={W} y1={y(t)} y2={y(t)} stroke="var(--border-soft)" /><text x={padL - 10} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)">{fmtTick(t)}</text></g>)}
        {buckets.list.map((b, i) => {
          const x = padL + i * bw + bw * 0.18, w = Math.max(1, bw * 0.64), total = b.paid + b.pending;
          const d = new Date(b.from);
          return <g key={b.from}>
            {total === 0
              ? <rect x={x} y={y(0) - 2} width={w} height={2} rx={1} fill="var(--border-soft)" />
              : <><rect x={x} y={y(b.paid)} width={w} height={y(0) - y(b.paid)} rx={2} fill="var(--success)" /><rect x={x} y={y(total)} width={w} height={y(b.paid) - y(total)} rx={2} fill="#6b6b75" /></>}
            <rect x={padL + i * bw} y={padT} width={bw} height={H - padT - padB} fill="transparent" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
            {i % labelEvery === 0 && <text x={x + w / 2} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--text-muted)">{buckets.step === 1 ? fmtDay(b.from) : `${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]}`}</text>}
          </g>;
        })}
      </svg>
      {hovered && hover !== null && (
        <div className="analytics-daily-tip" style={{ left: Math.min(W - 90, Math.max(padL + 90, padL + (hover + 0.5) * bw)) }}>
          <b>{buckets.step === 1 ? fmtDay(hovered.from) : `Semana de ${fmtDay(hovered.from)}`}</b>
          {hovered.shifts === 0 ? <span>Nenhum turno</span> : <><span>Pago {formatCurrencyBRL(hovered.paid)}</span><span>A pagar {formatCurrencyBRL(hovered.pending)}</span><span>{plural(hovered.shifts, "turno", "turnos")}</span></>}
        </div>
      )}
    </div>
  );
}

/** A header button that opens a small menu below it (the "⋯" menu). */
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

/** Like `aggregate`, but also splits each group's value into paid / a pagar, and keeps one sample row to drill into Pagamentos. */
function aggregateSplit(rows: PaymentShiftReportRow[], key: (r: PaymentShiftReportRow) => string) {
  const groups = new Map<string, { value: number; paid: number; shifts: number; sample: PaymentShiftReportRow }>();
  rows.forEach((r) => {
    const label = key(r) || "Não informado";
    const current = groups.get(label) ?? { value: 0, paid: 0, shifts: 0, sample: r };
    current.value += r.amount ?? 0;
    if (r.status === "pago") current.paid += r.amount ?? 0;
    current.shifts++;
    groups.set(label, current);
  });
  return Array.from(groups, ([label, value]) => ({ label, ...value })).sort((a, b) => b.value - a.value || b.shifts - a.shifts);
}

type RankBy = "company" | "role" | "employee" | "local";
const RANK_LABELS: Record<RankBy, string> = { company: "Empresa", role: "Função", employee: "Colaborador", local: "Local" };

/** Duration buckets for the Jornadas histogram (minutes, upper bound exclusive). */
const DURATION_BUCKETS: { label: string; min: number; max: number; tone?: "warning" | "danger"; analytics?: string }[] = [
  { label: "< 4h", min: 1, max: 240, tone: "warning", analytics: "journey-under-4h" },
  { label: "4–6h", min: 240, max: 360 },
  { label: "6–8h", min: 360, max: 480 },
  { label: "8–10h", min: 480, max: 600 },
  { label: "10–12h", min: 600, max: 721 },
  { label: "> 12h", min: 721, max: Infinity, tone: "danger", analytics: "journey-over-12h" },
];

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
  // Período lives in the shared Pagamentos filters (same as the Filtros panel
  // edits), so the header picker, the panel and "Ver em Pagamentos" always
  // agree. Análises needs a concrete range: an empty one falls back to the
  // current month.
  const fallbackPeriod = useMemo(currentMonth, []);
  const hasPeriod = Boolean(paymentFilters.periodStart && paymentFilters.periodEnd);
  const periodStart = hasPeriod ? paymentFilters.periodStart : fallbackPeriod[0];
  const periodEnd = hasPeriod ? paymentFilters.periodEnd : fallbackPeriod[1];
  const setPeriod = ([start, end]: [string, string]) => paymentFilters.setPeriod(start, end);
  useEffect(() => {
    if (!hasPeriod) paymentFilters.setPeriod(fallbackPeriod[0], fallbackPeriod[1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPeriod]);
  const [tab, setTab] = useState<Tab>("overview");
  const [rows, setRows] = useState<PaymentShiftReportRow[]>([]);
  const [previousRows, setPreviousRows] = useState<PaymentShiftReportRow[]>([]);
  const [pendingAudit, setPendingAudit] = useState(0);
  const [occurrenceRows, setOccurrenceRows] = useState<CheckDiffRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtersOpen,setFiltersOpen]=useState(false); const [viewsOpen,setViewsOpen]=useState(false); const [deleteView,setDeleteView]=useState<SavedView|null>(null);
  const [views,setViews]=useState<SavedView[]>(loadViews); const [viewName,setViewName]=useState(""); const [selectedView,setSelectedView]=useState("");
  const [rankBy,setRankBy]=useState<RankBy>("company");
  const [catalogs,setCatalogs]=useState<{companies:CompanyRow[];clients:ClientRow[];roles:RoleRow[];locals:string[]}>({companies:[],clients:[],roles:[],locals:[]});

  useEffect(()=>{Promise.all([listCompanies(),listClients(),listRolesGlobal(),listDistinctPaymentShiftLocals()]).then(([companies,clients,roles,locals])=>setCatalogs({companies,clients,roles,locals})).catch(()=>{});},[]);
  // The background checker replaces `trackedFiles` after each completed
  // batch, so the dashboard refreshes while it is open without polling.
  useEffect(()=>{listAllLatestShiftDiffs().then(setOccurrenceRows).catch(()=>{});},[trackedFiles]);
  useEffect(()=>{if(views.length||!localStorage.getItem("analytics-saved-view"))return;try{const old=JSON.parse(localStorage.getItem("analytics-saved-view")!);if(old?.start&&old?.end){const v:SavedView={id:crypto.randomUUID(),name:"Visão migrada",tab:TABS.includes(old.tab)?old.tab:"overview",start:old.start,end:old.end,filters:snapshotPaymentsFilters(paymentFilters)};setViews([v]);localStorage.setItem("analytics-saved-views",JSON.stringify([v]));}}catch{/* fallback seguro */}},[]);

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
  const previousTotal=previousRows.reduce((sum,r)=>sum+(r.amount??0),0),variation=previousTotal?(metrics.total-previousTotal)/previousTotal*100:null;
  const previousRange=useMemo(()=>{const start=Date.parse(`${periodStart}T00:00:00Z`),end=Date.parse(`${periodEnd}T00:00:00Z`),days=Math.round((end-start)/86400000)+1,prevEnd=start-86400000,prevStart=prevEnd-(days-1)*86400000;return formatPeriodShort(toIso(new Date(prevStart)),toIso(new Date(prevEnd)));},[periodStart,periodEnd]);
  const presets=useMemo(()=>periodPresets(),[]);
  const paidCount=rows.filter(r=>r.status==="pago").length;
  const avgCost=rows.length?metrics.total/rows.length:0, previousAvg=previousRows.length?previousTotal/previousRows.length:null;
  const nightCost=rows.filter(r=>r.shiftPeriod==="noturno").reduce((sum,r)=>sum+(r.amount??0),0);
  const timedRows=rows.filter(r=>durationMinutes(r)>0);
  const avgDuration=timedRows.length?timedRows.reduce((sum,r)=>sum+durationMinutes(r),0)/timedRows.length:0;
  const pct=(n:number,of:number)=>of?`${new Intl.NumberFormat("pt-BR",{maximumFractionDigits:1}).format(n/of*100)}%`:"0%";
  const ranking=useMemo(()=>aggregateSplit(rows,(r)=>rankBy==="company"?r.companyName:rankBy==="role"?r.role:rankBy==="employee"?r.employeeName:r.local),[rows,rankBy]);
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
  const activeFilterCount=usePaymentsActiveFilterCount(true);

  function applyScopeToPaymentFilters(statuses?: ("pendente" | "erro" | "pago")[],scope?:{employeeId?:number;companyId?:number;clientId?:number;roleId?:number;local?:string}) {
    paymentFilters.setPeriod(periodStart, periodEnd);
    if(statuses)paymentFilters.setSelectedStatuses(new Set(statuses.length===PAYMENT_SHIFT_STATUSES.length?[]:statuses));
    if(scope?.employeeId)paymentFilters.setSelectedEmployeeIds(new Set([String(scope.employeeId)])); if(scope?.companyId)paymentFilters.setSelectedCompanyIds(new Set([String(scope.companyId)])); if(scope?.clientId)paymentFilters.setSelectedClientIds(new Set([String(scope.clientId)])); if(scope?.roleId)paymentFilters.setSelectedRoleIds(new Set([String(scope.roleId)])); if(scope?.local)paymentFilters.setSelectedLocals(new Set([scope.local]));
    paymentFilters.setGrouped(false);
    paymentFilters.setPage(0);
  }
  function preparePaymentsNavigation(statuses?: ("pendente" | "erro" | "pago")[],scope?:{employeeId?:number;companyId?:number;clientId?:number;roleId?:number;local?:string},path="") {
    applyScopeToPaymentFilters(statuses,scope);
    navigate(`/payments${path}`);
  }
  /** "Conferência de Pagamentos" reads Pagamentos' filters — set them to this screen's period/filters first. */
  function openConference() {
    applyScopeToPaymentFilters(["pago"]);
    openReconciliationWindow().catch(() => {});
  }
    function saveView(id?:string,explicitName?:string){const name=(explicitName??viewName).trim();if(!name)return;const v:SavedView={id:id||crypto.randomUUID(),name,tab,start:periodStart,end:periodEnd,filters:{...snapshotPaymentsFilters(paymentFilters),periodStart,periodEnd}};const next=id?views.map(x=>x.id===id?v:x):[...views,v];setViews(next);setSelectedView(v.id);setViewName(name);localStorage.setItem("analytics-saved-views",JSON.stringify(next));}
  function openView(v:SavedView){applyPaymentsFiltersSnapshot(paymentFilters,v.filters);setPeriod([v.start,v.end]);setTab(TABS.includes(v.tab)?v.tab:"overview");setViewsOpen(false);}

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
            <button type="button" className="outline" onClick={() => setFiltersOpen((o) => !o)} aria-pressed={filtersOpen}>
              <Filter size={15} />
              Filtros
              {activeFilterCount > 0 && <span className="analytics-count">{activeFilterCount}</span>}
            </button>
            <MenuButton
              label="Mais opções"
              iconOnly
              icon={<MoreHorizontal size={16} />}
              items={[
                { label: views.length ? `Visões salvas (${views.length})` : "Visões salvas", icon: <Bookmark size={15} />, onClick: () => setViewsOpen(true) },
              ]}
            />
          </>
        }
      />

      <div className="analytics-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab==="overview"} className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>Visão geral</button>
        <button type="button" role="tab" aria-selected={tab==="costs"} className={tab === "costs" ? "active" : ""} onClick={() => setTab("costs")}>Custos</button>
        <button type="button" role="tab" aria-selected={tab==="journeys"} className={tab === "journeys" ? "active" : ""} onClick={() => setTab("journeys")}>Jornadas</button>
        <button type="button" role="tab" aria-selected={tab==="audit"} className={tab === "audit" ? "active" : ""} onClick={() => setTab("audit")}><span>Conferência</span>{pendingAudit + metrics.errors > 0 && <b>{pendingAudit + metrics.errors}</b>}</button>
      </div>

      {error && <div className="error-box">Não foi possível carregar as análises: {error}</div>}
      {loading ? <div className="card analytics-loading">Carregando indicadores...</div> : (
        <>
          {tab === "overview" && <>
            <section className="analytics-kpis">
              {<KpiCard
                label="Custo no período"
                delta={variation===null?undefined:`${variation>=0?"+":"−"}${Math.abs(variation).toFixed(1).replace(".",",")}%`}
                value={formatCurrencyBRL(metrics.total)}
                detail={variation===null?plural(rows.length,"turno no período","turnos no período"):<>vs. <b>{formatCurrencyBRL(previousTotal)}</b> em {previousRange}</>}
              />}
              {<KpiCard
                label="Pago"
                value={formatCurrencyBRL(metrics.paid)}
                bar={{ pct: metrics.total ? metrics.paid / metrics.total * 100 : 0, color: "var(--success)" }}
                detail={<><b>{metrics.total ? Math.round(metrics.paid / metrics.total * 100) : 0}%</b> do custo · {plural(rows.filter((r) => r.status === "pago").length,"turno","turnos")}</>}
              />}
              {<KpiCard
                label="A pagar"
                value={formatCurrencyBRL(metrics.pending)}
                valueColor={metrics.pending > 0 ? "var(--warning)" : undefined}
                detail={plural(rows.filter((r) => r.status === "pendente").length,"turno pendente","turnos pendentes")}
                action={rows.some((r) => r.status === "pendente") ? { label: "Ver em Pagamentos", onClick: () => preparePaymentsNavigation(["pendente"]) } : undefined}
              />}
              {<KpiCard
                label="Horas previstas"
                value={formatHours(metrics.minutes)}
                detail={<><b>{plural(rows.length,"turno","turnos")}</b> · {plural(metrics.employees,"colaborador","colaboradores")} · {plural(metrics.night,"noturno","noturnos")}</>}
              />}
            </section>
            <section className="analytics-grid analytics-grid-main">
              {<div className="card analytics-panel">
                <header>
                  <div><h3>Custo por dia</h3><p className="analytics-panel-sub">Cada barra é um dia do período, inclusive os sem turno.</p></div>
                  <div className="analytics-legend"><span><i style={{ background: "var(--success)" }} />Pago</span><span><i style={{ background: "#6b6b75" }} />A pagar</span></div>
                </header>
                <DailyBars rows={rows} start={periodStart} end={periodEnd} />
              </div>}
              {<div className="card analytics-panel">
                <header><div><h3>Maiores clientes</h3><p className="analytics-panel-sub">Participação no custo do período</p></div></header>
                <CostBars showRank={false} rows={clients.slice(0, 5).map((r) => ({ ...r, detail: `${metrics.total ? Math.round(r.value / metrics.total * 100) : 0}% · ${plural(r.shifts, "turno", "turnos")}` }))} onSelect={i=>{const r=rows.find(x=>x.clientName===clients[i].label);if(r)preparePaymentsNavigation(undefined,{clientId:r.clientId});}}/>
              </div>}
            </section>
            {<section className="card analytics-panel analytics-attention">
              <header><div><h3>Pontos de atenção</h3><p className="analytics-panel-sub">O que pede uma ação neste período</p></div></header>
              {(() => {
                const items = [
                  { show: pendingAudit > 0, icon: <SearchIcon size={15} />, color: "var(--warning)", bg: "var(--warning-soft)", title: plural(pendingAudit, "pagamento aguardando conferência", "pagamentos aguardando conferência"), text: "Confira contra o extrato e registre o resultado.", action: "Abrir Conferência", onClick: () => setTab("audit") },
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
            <section className="analytics-kpis">
              <KpiCard
                label="Custo médio por turno"
                value={formatCurrencyBRL(avgCost)}
                detail={previousAvg === null ? plural(rows.length, "turno no período", "turnos no período") : <>vs. <b>{formatCurrencyBRL(previousAvg)}</b> em {previousRange}</>}
              />
              <KpiCard
                label="Custo por hora prevista"
                value={metrics.minutes ? formatCurrencyBRL(metrics.total / (metrics.minutes / 60)) : "—"}
                detail={`${formatHours(metrics.minutes)} no período`}
              />
              <KpiCard
                label="Turnos noturnos"
                value={formatCurrencyBRL(nightCost)}
                bar={{ pct: metrics.total ? nightCost / metrics.total * 100 : 0, color: "#c4b5fd" }}
                detail={<><b>{pct(nightCost, metrics.total)}</b> do custo · {plural(metrics.night, "turno", "turnos")}</>}
              />
              <KpiCard
                label="Sem valor definido"
                value={plural(metrics.missingAmount, "turno", "turnos")}
                valueColor={metrics.missingAmount > 0 ? "var(--warning)" : undefined}
                detail={metrics.missingAmount > 0 ? "Fora dos totais até ter um valor" : "Todos os turnos têm valor"}
                action={metrics.missingAmount > 0 ? { label: "Ver em Pagamentos", onClick: () => preparePaymentsNavigation(["pendente", "erro", "pago"], undefined, "?attention=missing-amount") } : undefined}
              />
            </section>
            <section className="card analytics-panel">
              <header>
                <div><h3>Ranking de custo</h3><p className="analytics-panel-sub">Pago e a pagar, com a participação de cada um no total</p></div>
                <div className="analytics-seg" role="group" aria-label="Agrupar por">
                  {(Object.keys(RANK_LABELS) as RankBy[]).map((key) => (
                    <button key={key} type="button" aria-pressed={rankBy === key} onClick={() => setRankBy(key)}>{RANK_LABELS[key]}</button>
                  ))}
                </div>
              </header>
              <div className="analytics-legend" style={{ marginBottom: "0.9rem" }}><span><i style={{ background: "var(--success)" }} />Pago</span><span><i style={{ background: "#6b6b75" }} />A pagar</span></div>
              {!ranking.length ? <EmptyChart /> : (
                <div className="analytics-bars">
                  {ranking.slice(0, 8).map((item) => {
                    const max = ranking[0].value || 1;
                    const scope = rankBy === "company" ? { companyId: item.sample.companyId } : rankBy === "role" ? (item.sample.roleId ? { roleId: item.sample.roleId } : undefined) : rankBy === "employee" ? { employeeId: item.sample.employeeId } : (item.sample.local ? { local: item.sample.local } : undefined);
                    return (
                      <button key={item.label} type="button" className="analytics-rank-row" disabled={!scope} onClick={() => scope && preparePaymentsNavigation(undefined, scope)}>
                        <span className="analytics-rank-label" title={item.label}>{item.label}</span>
                        <strong>{formatCurrencyBRL(item.value)}</strong>
                        <span className="analytics-rank-track">
                          <span style={{ width: `${item.paid / max * 100}%`, background: "var(--success)" }} />
                          <span style={{ width: `${(item.value - item.paid) / max * 100}%`, background: "#6b6b75" }} />
                        </span>
                        <small>{pct(item.value, metrics.total)} do custo · {plural(item.shifts, "turno", "turnos")} · {pct(item.paid, item.value)} pago</small>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          </>}

          {tab === "journeys" && <>
            <section className="analytics-kpis">
              <KpiCard label="Acima de 12h" value={plural(long.length, "turno", "turnos")} valueColor={long.length ? "var(--danger)" : undefined} detail={`${pct(long.length, rows.length)} dos turnos · possível excesso`} action={long.length ? { label: "Ver turnos", onClick: () => preparePaymentsNavigation(undefined, undefined, "?analytics=journey-over-12h") } : undefined} />
              <KpiCard label="Descanso abaixo de 11h" value={plural(restIds.length, "turno", "turnos")} valueColor={restIds.length ? "var(--danger)" : undefined} detail="Entre jornadas do mesmo colaborador" action={restIds.length ? { label: "Ver turnos", onClick: () => preparePaymentsNavigation(undefined, undefined, `?analytics=rest-under-11h&ids=${restIds.join(",")}`) } : undefined} />
              <KpiCard label="Abaixo de 4h" value={plural(short.length, "turno", "turnos")} valueColor={short.length ? "var(--warning)" : undefined} detail={`${pct(short.length, rows.length)} dos turnos · fora do padrão`} action={short.length ? { label: "Ver turnos", onClick: () => preparePaymentsNavigation(undefined, undefined, "?analytics=journey-under-4h") } : undefined} />
              <KpiCard label="Jornada média" value={timedRows.length ? formatHours(avgDuration) : "—"} detail="Sem contar turnos sem horário" />
            </section>
            <section className="analytics-grid">
              <div className="card analytics-panel">
                <header><div><h3>Duração das jornadas</h3><p className="analytics-panel-sub">Quantos turnos em cada faixa</p></div></header>
                {!timedRows.length ? <EmptyChart /> : (() => {
                  const counts = DURATION_BUCKETS.map((b) => timedRows.filter((r) => { const m = durationMinutes(r); return m >= b.min && m < b.max; }).length);
                  const max = Math.max(1, ...counts);
                  return (
                    <div className="analytics-hist">
                      {DURATION_BUCKETS.map((b, i) => (
                        <button key={b.label} type="button" className="analytics-hist-col" disabled={!b.analytics || !counts[i]} onClick={() => b.analytics && preparePaymentsNavigation(undefined, undefined, `?analytics=${b.analytics}`)} aria-label={`${b.label}: ${plural(counts[i], "turno", "turnos")}`}>
                          <span className="analytics-hist-count">{counts[i]}</span>
                          <span className="analytics-hist-bar" style={{ height: `${Math.max(2, counts[i] / max * 100)}%`, background: b.tone === "danger" ? "var(--danger)" : b.tone === "warning" ? "var(--warning)" : "#6b6b75" }} />
                          <span className="analytics-hist-label">{b.label}</span>
                        </button>
                      ))}
                    </div>
                  );
                })()}
              </div>
              <div className="card analytics-panel">
                <header><div><h3>Início dos turnos</h3><p className="analytics-panel-sub">Dia da semana × horário de início (faixas de 2h)</p></div></header>
                {(() => {
                  const days = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
                  const grid = days.map((_, weekday) => Array.from({ length: 12 }, (_, bucket) => rows.filter((r) => new Date(`${r.workDate}T00:00:00Z`).getUTCDay() === weekday && r.scheduleStartMinutes !== null && Math.floor(r.scheduleStartMinutes / 120) === bucket).length));
                  const max = Math.max(1, ...grid.flat());
                  return (
                    <div className="analytics-heat">
                      <span />
                      {Array.from({ length: 12 }, (_, bucket) => <span key={`h-${bucket}`} className="analytics-heat-col">{bucket % 2 === 0 ? String(bucket * 2).padStart(2, "0") : ""}</span>)}
                      {days.map((day, weekday) => [
                        <span key={`${day}-label`} className="analytics-heat-row">{day}</span>,
                        ...grid[weekday].map((count, bucket) => (
                          <button key={`${day}-${bucket}`} type="button" className="analytics-heat-cell" disabled={!count} style={{ background: `rgba(246,246,248,${count ? 0.15 + count / max * 0.75 : 0.04})` }} title={`${day}, ${bucket * 2}h–${bucket * 2 + 2}h: ${plural(count, "turno", "turnos")}`} aria-label={`${day}, ${bucket * 2} a ${bucket * 2 + 2} horas: ${plural(count, "turno", "turnos")}`} onClick={() => preparePaymentsNavigation(undefined, undefined, `?analytics=heatmap&weekday=${weekday}&bucket=${bucket}`)}>{count || ""}</button>
                        )),
                      ])}
                    </div>
                  );
                })()}
              </div>
            </section>
          </>}

          {tab === "audit" && <>
            <section className="analytics-kpis">
              <KpiCard
                label="Conferidos"
                value={`${Math.max(0, paidCount - pendingAudit)} de ${paidCount}`}
                bar={{ pct: paidCount ? (paidCount - pendingAudit) / paidCount * 100 : 0, color: "var(--success)" }}
                detail="Pagamentos do período"
              />
              <KpiCard
                label="Aguardando conferência"
                value={String(pendingAudit)}
                valueColor={pendingAudit ? "var(--warning)" : undefined}
                detail={pendingAudit ? "Pagos e ainda não conferidos contra o extrato" : "Tudo conferido"}
              />
              <KpiCard
                label="Turnos com erro"
                value={String(metrics.errors)}
                valueColor={metrics.errors ? "var(--danger)" : undefined}
                detail={metrics.errors ? "Corrija antes de pagar" : "Nada para corrigir"}
              />
            </section>
            <section className="card analytics-panel">
              <header><div><h3>O que fazer agora</h3><p className="analytics-panel-sub">Cada item abre onde ele se resolve</p></div></header>
              {(() => {
                const items = [
                  { show: pendingAudit > 0, icon: <SearchIcon size={15} />, color: "var(--warning)", bg: "var(--warning-soft)", title: `Conferir ${plural(pendingAudit, "pagamento", "pagamentos")} contra o extrato`, text: "Abre a Conferência de Pagamentos com o período e os filtros desta tela.", action: "Abrir Conferência", onClick: openConference },
                  { show: metrics.errors > 0, icon: <AlertTriangle size={15} />, color: "var(--danger)", bg: "var(--danger-soft)", title: `Corrigir ${plural(metrics.errors, "turno com erro", "turnos com erro")}`, text: "Revise a mensagem de erro antes de pagar.", action: "Ver em Pagamentos", onClick: () => preparePaymentsNavigation(["erro"]) },
                ].filter((item) => item.show);
                if (!items.length) return <p className="analytics-attention-empty"><CheckCircle2 size={15} /> Tudo conferido e sem erros neste período.</p>;
                return items.map((item) => (
                  <div className="analytics-attention-row" key={item.title}>
                    <span className="analytics-attention-icon" style={{ color: item.color, background: item.bg }}>{item.icon}</span>
                    <div><strong>{item.title}</strong><p>{item.text}</p></div>
                    <button type="button" className="analytics-kpi-link" onClick={item.onClick}>{item.action} <ArrowRight size={13} /></button>
                  </div>
                ));
              })()}
            </section>
          </>}
          <div className="analytics-footer-link"><Link to="/payments">Ver todos os turnos em Pagamentos <ArrowRight size={15}/></Link></div>
        </>
      )}
      <PaymentsFiltersPanel
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        companies={catalogs.companies}
        clients={catalogs.clients}
        roles={catalogs.roles}
        locals={catalogs.locals}
        includeStatus
      />
      {viewsOpen&&<Modal title="Visões favoritas" onClose={()=>setViewsOpen(false)} maxHeight="80vh"><div className="analytics-view-form"><label>Nome<input value={viewName} onChange={e=>setViewName(e.target.value)} placeholder="Ex.: Fechamento mensal"/></label><button type="button" disabled={!viewName.trim()} onClick={()=>saveView()}>Criar com estado atual</button></div><div className="analytics-view-list">{!views.length&&<p className="muted">Nenhuma visão salva.</p>}{views.map(v=><div key={v.id} className={selectedView===v.id?"active":""} onClick={()=>{setSelectedView(v.id);setViewName(v.name);}}><span><strong>{v.name}</strong><small>{v.start} a {v.end}</small></span><span><button type="button" className="secondary" onClick={e=>{e.stopPropagation();openView(v);}}>Abrir</button><button type="button" className="secondary" onClick={e=>{e.stopPropagation();saveView(v.id,v.name);}}>Atualizar</button><button type="button" className="danger" aria-label={`Excluir ${v.name}`} onClick={e=>{e.stopPropagation();setDeleteView(v);}}>×</button></span></div>)}</div>{selectedView&&<button type="button" disabled={!viewName.trim()} onClick={()=>saveView(selectedView)}>Renomear / atualizar selecionada</button>}</Modal>}
      {deleteView&&<ConfirmModal title="Excluir visão" message={`Excluir a visão “${deleteView.name}”?`} confirmLabel="Excluir" onCancel={()=>setDeleteView(null)} onConfirm={()=>{const next=views.filter(v=>v.id!==deleteView.id);setViews(next);localStorage.setItem("analytics-saved-views",JSON.stringify(next));setDeleteView(null);setSelectedView("");}}/>}
    </div>
  );
}
