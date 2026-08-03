import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { openOriginalPdf } from "../lib/api";
import { analyzeDay, formatMinutes } from "../lib/analysis";
import { listImports, listStoredDayRecords } from "../lib/db";
import { formatDate, formatDayShort } from "../lib/format";
import type { StoredDayRecord, StoredImport } from "../lib/types";

export default function EmployeeDetailPage() {
  const { importId } = useParams<{ importId: string }>();
  const [days, setDays] = useState<StoredDayRecord[]>([]);
  const [importInfo, setImportInfo] = useState<StoredImport | null>(null);
  const [thresholdHours, setThresholdHours] = useState(8);
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

  const thresholdMinutes = thresholdHours * 60;

  const summary = useMemo(() => {
    let comBatida = 0;
    let semBatida = 0;
    let acimaThreshold = 0;
    for (const day of days) {
      const a = analyzeDay(day, thresholdMinutes);
      if (a.hasPunch) comBatida++;
      else semBatida++;
      if (a.exceedsThreshold) acimaThreshold++;
    }
    return { comBatida, semBatida, acimaThreshold };
  }, [days, thresholdMinutes]);

  if (loading) return <p className="muted">Carregando...</p>;
  if (!importInfo) return <p className="muted">Import não encontrado.</p>;

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>{importInfo.employeeName}</h2>
          <p className="muted">
            {importInfo.companyName} · {formatDate(importInfo.periodStart)} a{" "}
            {formatDate(importInfo.periodEnd)}
          </p>
        </div>
        <button
          type="button"
          className="secondary"
          onClick={() => openOriginalPdf(importInfo.originalPdfPath)}
        >
          Ver relatório original
        </button>
      </div>

      <div className="summary-row">
        <div className="summary-tile">
          <div className="value">{summary.comBatida}</div>
          <div className="label">dias com batida</div>
        </div>
        <div className="summary-tile">
          <div className="value">{summary.semBatida}</div>
          <div className="label">dias sem batida</div>
        </div>
        <div className="summary-tile">
          <div className="value">{summary.acimaThreshold}</div>
          <div className="label">dias acima de {thresholdHours}h</div>
        </div>
      </div>

      <div className="card">
        <div className="field-row">
          <div className="field">
            <label htmlFor="threshold">Limite de horas/dia</label>
            <input
              id="threshold"
              type="number"
              min={1}
              step={0.5}
              value={thresholdHours}
              onChange={(e) => setThresholdHours(Number(e.target.value))}
              style={{ width: "5rem" }}
            />
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Data</th>
              <th>Dia</th>
              <th>Ent. 1</th>
              <th>Saí. 1</th>
              <th>Ent. 2</th>
              <th>Saí. 2</th>
              <th>Total</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => {
              const a = analyzeDay(day, thresholdMinutes);
              return (
                <tr key={day.dayRecordId}>
                  <td>{formatDayShort(day.date)}</td>
                  <td>{day.weekday}</td>
                  <td>{day.punches[0] ?? "—"}</td>
                  <td>{day.punches[1] ?? "—"}</td>
                  <td>{day.punches[2] ?? "—"}</td>
                  <td>{day.punches[3] ?? "—"}</td>
                  <td>{formatMinutes(day.totalWorkedMinutes)}</td>
                  <td>
                    {!a.hasPunch && <span className="badge warn">Sem batida</span>}
                    {a.hasPunch && a.isIncomplete && (
                      <span className="badge warn">Incompleto</span>
                    )}
                    {a.exceedsThreshold && <span className="badge info">Acima de {thresholdHours}h</span>}
                    {a.hasPunch && !a.isIncomplete && !a.exceedsThreshold && (
                      <span className="badge ok">OK</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
