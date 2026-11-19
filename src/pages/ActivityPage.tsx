import { RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import OptionPicker from "../components/OptionPicker";
import PageHeader from "../components/PageHeader";
import { colorForName, initials } from "../lib/avatar";
import { listActivity, listActivityFilters, type ActivityChange, type ActivityRow } from "../lib/db";
import { formatDateTime, parseSqliteDateTime } from "../lib/format";

/**
 * "Atividade": everything that changed in Tá Pago, newest first, by whom
 * and when. A line opens to the before → after of each field (or the
 * records a bulk action touched). Consecutive actions of one person on
 * many turnos ("marcou como pago" twelve times) read as one line.
 * `?entityType=company&entityId=3` narrows it to one record ("Ver
 * alterações" in the cadastros).
 */

const PAGE_SIZE = 100;
/** Same person, same action on turnos, this close together: one line. */
const GROUP_WINDOW_MS = 15 * 60 * 1000;

type Period = "today" | "7" | "30" | "all";
const PERIODS: { id: Period; label: string }[] = [
  { id: "today", label: "Hoje" },
  { id: "7", label: "Últimos 7 dias" },
  { id: "30", label: "Últimos 30 dias" },
  { id: "all", label: "Todo o período" },
];

/** How a batch of the same action on turnos reads: "marcou como pagos 12 turnos". */
const GROUP_VERB: Record<string, string> = {
  markPaymentShiftPaid: "marcou como pagos",
  revertPaymentShiftToPending: "voltou para pendente",
  editPaymentShift: "editou",
  recordPaymentAudit: "conferiu o pagamento de",
  deletePaymentAudit: "desfez a conferência de",
  deletePaymentShift: "excluiu",
  markPaymentShiftAuditError: "marcou erro na conferência de",
  undoPaymentShiftAuditError: "desfez o erro da conferência de",
  applyAutoSyncedFieldUpdate: "atualizou com a planilha",
  acceptShiftChange: "aceitou a alteração da planilha em",
};

function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function periodStart(period: Period): string | null {
  if (period === "all") return null;
  const d = new Date();
  if (period !== "today") d.setDate(d.getDate() - Number(period) + 1);
  // `at` is UTC; the local midnight in UTC.
  const local = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return local.toISOString().slice(0, 19).replace("T", " ");
}

function dayLabel(date: Date): string {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (isoDay(date) === isoDay(today)) return "Hoje";
  if (isoDay(date) === isoDay(yesterday)) return "Ontem";
  return new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" }).format(date);
}

function timeOf(date: Date): string {
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(date);
}

/** Where a record lives in the app; `null` when there's no screen for it (or it was deleted). */
function linkFor(row: ActivityRow): { to: string; label: string } | null {
  if (!row.entityType || !row.entityId || row.action.startsWith("delete") || row.action === "removeAppUser") return null;
  const id = row.entityId;
  switch (row.entityType) {
    case "shift":
      return { to: `/payments?shift=${id}`, label: "Abrir turno" };
    case "employee":
      return { to: `/employees/${id}`, label: "Abrir colaborador" };
    case "company":
      return { to: `/companies/${id}`, label: "Abrir empresa" };
    case "client":
      return { to: `/clients/${id}`, label: "Abrir cliente" };
    case "role":
      return { to: `/roles/${id}`, label: "Abrir função" };
    case "paymentTemplate":
      return { to: "/import/payments/templates", label: "Ver templates de pagamento" };
    case "employeeTemplate":
      return { to: "/import/employees/templates", label: "Ver templates de colaboradores" };
    case "exportTemplate":
      return { to: `/payments/export-templates/${id}`, label: "Abrir template" };
    case "pdfTemplate":
      return { to: `/payments/pdf-templates/${id}`, label: "Abrir template" };
    case "reimportConfig":
      return { to: "/remote-updates/imports", label: "Ver verificação automática" };
    case "appUser":
    case "profile":
      return { to: "/users", label: "Ver usuários e perfis" };
    case "import":
      return { to: `/employee/${id}`, label: "Abrir espelho" };
    default:
      return null;
  }
}

/** A line on screen: one action, or several of the same on turnos in a row. */
interface Line {
  key: string;
  rows: ActivityRow[];
  date: Date;
}

function groupLines(rows: ActivityRow[]): Line[] {
  const lines: Line[] = [];
  for (const row of rows) {
    const date = parseSqliteDateTime(row.at);
    const last = lines[lines.length - 1];
    const head = last?.rows[0];
    if (
      last &&
      head.entityType === "shift" &&
      row.entityType === "shift" &&
      head.action === row.action &&
      head.actorEmail === row.actorEmail &&
      GROUP_VERB[row.action] &&
      isoDay(last.date) === isoDay(date) &&
      last.rows[last.rows.length - 1] &&
      parseSqliteDateTime(last.rows[last.rows.length - 1].at).getTime() - date.getTime() <= GROUP_WINDOW_MS
    ) {
      last.rows.push(row);
      continue;
    }
    lines.push({ key: String(row.id), rows: [row], date });
  }
  return lines;
}

function ActorAvatar({ row }: { row: ActivityRow }) {
  if (!row.actorEmail) {
    return (
      <span className="act-avatar act-avatar-system" aria-hidden="true">
        <RefreshCw size={14} />
      </span>
    );
  }
  return (
    <span className="act-avatar" style={{ background: colorForName(row.actorEmail) }} aria-hidden="true">
      {initials(row.actorName)}
    </span>
  );
}

function ChangesTable({ changes }: { changes: ActivityChange[] }) {
  return (
    <table className="act-diff">
      <thead>
        <tr>
          <th>Campo</th>
          <th>Antes</th>
          <th>Depois</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((c) => (
          <tr key={c.field}>
            <td>{c.field}</td>
            <td className="act-old">{c.before || "—"}</td>
            <td className="act-new">{c.after || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function ActivityPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const entityType = searchParams.get("entityType");
  const entityId = searchParams.get("entityId");

  const [actor, setActor] = useState<string | null>(null);
  const [area, setArea] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>(entityType ? "all" : "30");
  const [filters, setFilters] = useState<{ people: { email: string; name: string }[]; hasSystem: boolean; areas: string[] }>({ people: [], hasSystem: false, areas: [] });

  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    listActivityFilters().then(setFilters).catch(() => {});
  }, []);

  const query = useMemo(
    () => ({ actor, area, from: periodStart(period), entityType, entityId, limit: PAGE_SIZE }),
    [actor, area, period, entityType, entityId],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listActivity(query)
      .then((r) => {
        if (cancelled) return;
        setRows(r.rows);
        setHasMore(r.hasMore);
      })
      .catch((e) => !cancelled && setError(String(e instanceof Error ? e.message : e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [query]);

  async function loadMore() {
    if (rows.length === 0) return;
    setLoadingMore(true);
    try {
      const r = await listActivity({ ...query, beforeId: rows[rows.length - 1].id });
      setRows((prev) => [...prev, ...r.rows]);
      setHasMore(r.hasMore);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoadingMore(false);
    }
  }

  const lines = useMemo(() => groupLines(rows), [rows]);
  const personOptions = [
    { id: "", label: "Todas as pessoas" },
    ...filters.people.map((p) => ({ id: p.email, label: p.name || p.email, meta: p.name && p.name !== p.email ? p.email : undefined })),
    ...(filters.hasSystem ? [{ id: "system", label: "Verificação automática" }] : []),
  ];
  const areaOptions = [{ id: "", label: "Todas as áreas" }, ...filters.areas.map((a) => ({ id: a, label: a }))];
  const entityLabel = entityType && rows.length > 0 ? rows[0].entityLabel : null;

  let lastDay = "";
  return (
    <div>
      <PageHeader title="Atividade" subtitle="Tudo o que foi alterado no Tá Pago, por quem e quando." />

      <div className="act-filters">
        <div className="act-filter">
          <OptionPicker
            single
            showTiles={false}
            align="left"
            options={personOptions}
            selected={new Set([actor ?? ""])}
            onToggle={(id) => setActor(id || null)}
            title="Pessoa"
            allPlaceholder="Todas as pessoas"
            searchPlaceholder="Buscar pessoa"
          />
        </div>
        <div className="act-filter">
          <OptionPicker
            single
            showTiles={false}
            align="left"
            options={areaOptions}
            selected={new Set([area ?? ""])}
            onToggle={(id) => setArea(id || null)}
            title="Área"
            allPlaceholder="Todas as áreas"
            searchPlaceholder="Buscar área"
          />
        </div>
        <div className="act-filter">
          <OptionPicker
            single
            showTiles={false}
            align="left"
            options={PERIODS}
            selected={new Set([period])}
            onToggle={(id) => setPeriod(id as Period)}
            title="Período"
            allPlaceholder="Período"
            searchPlaceholder="Buscar"
          />
        </div>
        {entityType && (
          <span className="act-entity-chip">
            Só as alterações de <b>{entityLabel ?? "este registro"}</b>
            <button type="button" aria-label="Ver todas as alterações" onClick={() => setSearchParams({})}>
              <X size={13} />
            </button>
          </span>
        )}
      </div>

      {error && <div className="error-box">{error}</div>}
      {loading && <p className="muted">Carregando...</p>}
      {!loading && lines.length === 0 && !error && <p className="muted">Nenhuma alteração com esses filtros.</p>}

      <div className="act-list">
        {lines.map((line) => {
          const head = line.rows[0];
          const day = dayLabel(line.date);
          const showDay = day !== lastDay;
          lastDay = day;
          const isGroup = line.rows.length > 1;
          const expandable = isGroup || head.changes.length > 0 || head.items.length > 0;
          const isOpen = open === line.key && expandable;
          const link = isGroup ? null : linkFor(head);
          return (
            <div key={line.key}>
              {showDay && <div className="act-day">{day}</div>}
              <div className={`act-line${isOpen ? " open" : ""}`}>
                <button
                  type="button"
                  className="act-row"
                  onClick={() => setOpen(isOpen ? null : line.key)}
                  aria-expanded={expandable ? isOpen : undefined}
                  disabled={!expandable && !link}
                >
                  <ActorAvatar row={head} />
                  <span className="act-what">
                    <b>{head.actorName}</b>{" "}
                    {isGroup ? (
                      <>
                        {GROUP_VERB[head.action]} <b>{line.rows.length} turnos</b>
                      </>
                    ) : (
                      <>
                        {head.verb} {head.entityLabel && <span className="act-obj">{head.entityLabel}</span>}
                        {head.summary && <span className="act-summary"> · {head.summary}</span>}
                      </>
                    )}
                  </span>
                  <span className="act-meta">
                    <span className="act-tag">{head.area}</span>
                    <span title={formatDateTime(head.at)}>{timeOf(line.date)}</span>
                  </span>
                </button>
                {(isOpen || (!expandable && link && open === line.key)) && (
                  <div className="act-detail">
                    {isGroup ? (
                      <div className="act-group">
                        {line.rows.map((r) => (
                          <div key={r.id} className="act-group-row">
                            <Link to={linkFor(r)?.to ?? "#"} className="act-group-label">
                              {r.entityLabel}
                            </Link>
                            <span className="act-group-changes">
                              {r.changes.map((c) => (
                                <span key={c.field}>
                                  {c.field}: <s>{c.before || "—"}</s> → <ins>{c.after || "—"}</ins>
                                </span>
                              ))}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <>
                        {head.changes.length > 0 && <ChangesTable changes={head.changes} />}
                        {head.items.length > 0 && (
                          <div className="act-items">
                            {head.items.slice(0, 40).map((it) => (
                              <span key={it.id}>{it.label}</span>
                            ))}
                            {head.items.length > 40 && <span>+{head.items.length - 40}</span>}
                          </div>
                        )}
                      </>
                    )}
                    {link && (
                      <Link to={link.to} className="act-link">
                        {link.label}
                      </Link>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {hasMore && !loading && (
        <div className="act-more">
          <button type="button" className="secondary" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Carregando..." : "Carregar mais"}
          </button>
        </div>
      )}
    </div>
  );
}
