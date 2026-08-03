import { FileText, TrendingDown, TrendingUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { openOriginalPdf } from "../lib/api";
import { formatMinutes, isWeekend, summarizePeriod } from "../lib/analysis";
import { listImports, listStoredDayRecords } from "../lib/db";
import { formatDate, formatDateCompact } from "../lib/format";
import type { StoredDayRecord, StoredImport } from "../lib/types";

// Not user-configurable (no threshold control in this view) — only feeds
// the "Horas Extras" bento metric.
const OVERTIME_THRESHOLD_MINUTES = 8 * 60;

function isEmptyDay(day: Pick<StoredDayRecord, "punches" | "totalWorkedMinutes">): boolean {
  return day.punches.length === 0 && day.totalWorkedMinutes === 0;
}

const WEEKDAY_ABBR = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function weekdayAbbr(isoDate: string): string {
  return WEEKDAY_ABBR[new Date(`${isoDate}T00:00:00Z`).getUTCDay()];
}

/**
 * Every calendar date in [startIso, endIso], inclusive. The day-record rows
 * that actually exist in the DB might not cover the whole period (a
 * malformed source page, for instance) — this is what guarantees every day
 * of the period still shows up, blank if nothing was recorded for it.
 */
function enumeratePeriodDates(startIso: string, endIso: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function blankDay(importInfo: StoredImport, date: string): StoredDayRecord {
  return {
    dayRecordId: -1,
    importId: importInfo.importId,
    employeeId: importInfo.employeeId,
    employeeName: importInfo.employeeName,
    employeeCpf: importInfo.employeeCpf,
    companyId: importInfo.companyId,
    companyName: importInfo.companyName,
    originalPdfPath: importInfo.originalPdfPath,
    date,
    weekday: weekdayAbbr(date),
    totalWorkedMinutes: 0,
    normalHoursMinutes: 0,
    absenceMinutes: 0,
    observation: null,
    punches: [],
  };
}

/** "160h 45min" — bento-tile totals read better spelled out than "160:45". */
function formatHoursMinutes(totalMinutes: number): string {
  const abs = Math.abs(totalMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${totalMinutes < 0 ? "-" : ""}${h}h ${String(m).padStart(2, "0")}min`;
}

export default function EmployeeDetailPage() {
  const { importId } = useParams<{ importId: string }>();
  const [days, setDays] = useState<StoredDayRecord[]>([]);
  const [importInfo, setImportInfo] = useState<StoredImport | null>(null);
  const [hideEmptyDays, setHideEmptyDays] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!importId) return;
    const id = Number(importId);
    setLoading(true);
    Promise.all([
      listStoredDayRecords({ importId: id }),
      listImports().then((imports) => imports.find((i) => i.importId === id) ?? null),
    ])
      .then(([dayRows, imp]) => {
        setDays(dayRows);
        setImportInfo(imp);
      })
      .finally(() => setLoading(false));
  }, [importId]);

  // The full period, one row per calendar day — filled in from the actual
  // day_records where they exist, blank otherwise. Guards against a period
  // whose recorded days don't fully cover it (e.g. a page the parser only
  // partially read).
  const fullDays = useMemo(() => {
    if (!importInfo) return [];
    const byDate = new Map(days.map((d) => [d.date, d]));
    return enumeratePeriodDates(importInfo.periodStart, importInfo.periodEnd).map(
      (date) => byDate.get(date) ?? blankDay(importInfo, date),
    );
  }, [days, importInfo]);

  const summary = useMemo(
    () => summarizePeriod(fullDays, OVERTIME_THRESHOLD_MINUTES),
    [fullDays],
  );
  // Always includes every day from the period by default — this only
  // narrows what's *displayed*, the totals above are unaffected.
  const visibleDays = useMemo(
    () => (hideEmptyDays ? fullDays.filter((d) => !isEmptyDay(d)) : fullDays),
    [fullDays, hideEmptyDays],
  );

  if (loading) return <p className="muted">Carregando...</p>;
  if (!importInfo) return <p className="muted">Import não encontrado.</p>;

  // For a single-page source, the employee's own file *is* the whole
  // original — nothing to tell apart. For a multi-page batch, they're two
  // different PDFs, so both buttons make sense.
  const hasSeparateOriginal =
    importInfo.sourceOriginalPdfPath !== null &&
    importInfo.sourceOriginalPdfPath !== importInfo.originalPdfPath;

  return (
    <div>
      <div className="page-header" style={{ alignItems: "flex-end" }}>
        <div>
          <h2>Cartão de Ponto - {importInfo.employeeName}</h2>
          <p className="muted">
            Período: <strong style={{ color: "var(--text)" }}>{formatDate(importInfo.periodStart)} a{" "}
            {formatDate(importInfo.periodEnd)}</strong>
            <span style={{ margin: "0 0.6rem", color: "var(--border)" }}>|</span>
            Empresa: <strong style={{ color: "var(--text)" }}>{importInfo.companyName}</strong>
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.6rem", flexShrink: 0 }}>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              openOriginalPdf(importInfo.sourceOriginalPdfPath ?? importInfo.originalPdfPath)
            }
          >
            <FileText size={15} style={{ marginRight: "0.4rem" }} />
            Ver arquivo original
          </button>
          {hasSeparateOriginal && (
            <button type="button" onClick={() => openOriginalPdf(importInfo.originalPdfPath)}>
              <FileText size={15} style={{ marginRight: "0.4rem" }} />
              Ver arquivo do colaborador
            </button>
          )}
        </div>
      </div>

      <div className="summary-row">
        <div className="summary-tile">
          <div className="label">Total Trabalhado</div>
          <div className="value">{formatHoursMinutes(summary.totalWorkedMinutes)}</div>
        </div>
        <div className="summary-tile">
          <div className="label">Horas Extras</div>
          <div className="value" style={{ color: "var(--success)" }}>
            {formatHoursMinutes(summary.overtimeMinutes)}
          </div>
        </div>
        <div className="summary-tile">
          <div className="label">Faltas/Atrasos</div>
          <div className="value" style={{ color: "var(--danger)" }}>
            {formatHoursMinutes(summary.absenceMinutes)}
          </div>
        </div>
        <div className="summary-tile">
          <div className="label">Saldo do Banco</div>
          <div
            className="value"
            style={{
              color: summary.balanceMinutes >= 0 ? "var(--accent)" : "var(--danger)",
              display: "flex",
              alignItems: "center",
              gap: "0.3rem",
            }}
          >
            {summary.balanceMinutes >= 0 ? "+" : ""}
            {formatHoursMinutes(summary.balanceMinutes)}
            {summary.balanceMinutes >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.6rem" }}>
        <label
          className="muted"
          style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.9rem" }}
        >
          <input
            type="checkbox"
            checked={hideEmptyDays}
            onChange={(e) => setHideEmptyDays(e.target.checked)}
          />
          Ocultar dias sem registro
        </label>
      </div>

      <div className="card table-card card-flush">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th style={{ textAlign: "center" }}>Entrada 1</th>
                <th style={{ textAlign: "center" }}>Saída 1</th>
                <th style={{ textAlign: "center" }}>Entrada 2</th>
                <th style={{ textAlign: "center" }}>Saída 2</th>
                <th style={{ textAlign: "right" }}>Total Diário</th>
                <th>Observação</th>
              </tr>
            </thead>
            <tbody>
              {visibleDays.map((day) => {
                const weekend = isWeekend(day.weekday);
                const incomplete = day.punches.length % 2 !== 0;
                const rowClass = [weekend ? "row-weekend" : "", incomplete ? "row-incomplete" : ""]
                  .filter(Boolean)
                  .join(" ");
                const empty = isEmptyDay(day);

                return (
                  <tr key={day.date} className={rowClass || undefined}>
                    <td>
                      {formatDateCompact(day.date)} <span className="weekday muted">· {day.weekday}</span>
                    </td>
                    {[0, 1, 2, 3].map((i) => (
                      <td key={i} style={{ textAlign: "center" }}>
                        {day.punches[i] ?? ""}
                      </td>
                    ))}
                    <td
                      style={{
                        textAlign: "right",
                        fontWeight: 600,
                        color: empty ? "var(--text-muted)" : "var(--accent)",
                      }}
                    >
                      {empty ? "" : formatMinutes(day.totalWorkedMinutes)}
                    </td>
                    <td>{day.observation ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
