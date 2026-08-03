import { useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { analyzeDay, formatMinutes } from "../lib/analysis";
import { toCsv } from "../lib/csv";
import { listCompanies, listStoredDayRecords, type CompanyRow } from "../lib/db";
import type { StoredDayRecord } from "../lib/types";

type Bucket = "comBatida" | "semBatida" | "acimaThreshold";

const BUCKET_LABEL: Record<Bucket, string> = {
  comBatida: "Com batida",
  semBatida: "Sem batida",
  acimaThreshold: "Acima do limite",
};

export default function ReportsPage() {
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [companyId, setCompanyId] = useState<string>("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [thresholdHours, setThresholdHours] = useState(8);
  const [days, setDays] = useState<StoredDayRecord[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listCompanies().then(setCompanies);
  }, []);

  const thresholdMinutes = thresholdHours * 60;

  const buckets = useMemo(() => {
    const result: Record<Bucket, StoredDayRecord[]> = {
      comBatida: [],
      semBatida: [],
      acimaThreshold: [],
    };
    if (!days) return result;
    for (const day of days) {
      const a = analyzeDay(day, thresholdMinutes);
      if (a.hasPunch) result.comBatida.push(day);
      else result.semBatida.push(day);
      if (a.exceedsThreshold) result.acimaThreshold.push(day);
    }
    return result;
  }, [days, thresholdMinutes]);

  async function handleGenerate() {
    setError(null);
    setBusy(true);
    try {
      const rows = await listStoredDayRecords({
        companyId: companyId ? Number(companyId) : undefined,
        periodStart: periodStart || undefined,
        periodEnd: periodEnd || undefined,
      });
      setDays(rows);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleExport(bucket: Bucket) {
    const rows = buckets[bucket];
    const csv = toCsv(
      ["Colaborador", "CPF", "Empresa", "Data", "Dia", "Batidas", "Total trabalhado"],
      rows.map((d) => [
        d.employeeName,
        d.employeeCpf,
        d.companyName,
        d.date,
        d.weekday,
        d.punches.join(" / "),
        formatMinutes(d.totalWorkedMinutes),
      ]),
    );

    const path = await save({
      defaultPath: `${bucket}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) return;
    await writeTextFile(path, csv);
  }

  return (
    <div>
      <div className="page-header">
        <h2>Relatórios</h2>
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className="card">
        <div className="field-row">
          <div className="field">
            <label htmlFor="company">Empresa</label>
            <select id="company" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              <option value="">Todas</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="start">De</label>
            <input
              id="start"
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="end">Até</label>
            <input
              id="end"
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="threshold">Limite h/dia</label>
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
          <button type="button" onClick={handleGenerate} disabled={busy}>
            {busy ? "Gerando..." : "Gerar relatório"}
          </button>
        </div>
      </div>

      {days && (
        <div className="summary-row">
          {(Object.keys(buckets) as Bucket[]).map((bucket) => (
            <div className="summary-tile" key={bucket}>
              <div className="value">{buckets[bucket].length}</div>
              <div className="label">{BUCKET_LABEL[bucket]}</div>
              <button
                type="button"
                className="secondary"
                style={{ marginTop: "0.5rem" }}
                disabled={buckets[bucket].length === 0}
                onClick={() => handleExport(bucket)}
              >
                Exportar CSV
              </button>
            </div>
          ))}
        </div>
      )}

      {days && days.length === 0 && <p className="muted">Nenhum dia encontrado para esse filtro.</p>}
    </div>
  );
}
