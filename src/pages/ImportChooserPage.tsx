import { ArrowRight, Banknote, FileText, RefreshCw, Users, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import { useAccess } from "../contexts/AuthContext";
import type { Area } from "../lib/access";
import { listAllLatestShiftDiffs, listImportFiles } from "../lib/db";
import { parseSqliteDateTime, safeDecodeFileName } from "../lib/format";
import type { ImportFileRow, ImportStatus, ImportType } from "../lib/types";

interface Choice {
  to: string;
  /** Importing needs "Editar" here. */
  area: Area;
  importType: ImportType;
  title: string;
  description: string;
  tags: string[];
  icon: LucideIcon;
  /** Icon tint — one per import type, so each card is recognizable at a glance. */
  color: string;
}

const CHOICES: Choice[] = [
  {
    to: "/import/timesheet",
    area: "espelhos",
    importType: "timesheet",
    title: "Espelhos de ponto",
    description: "Extraia as marcações dos espelhos gerados pelo seu provedor de ponto.",
    tags: ["PDF"],
    icon: FileText,
    color: "#93c5fd",
  },
  {
    to: "/import/payments",
    area: "pagamentos",
    importType: "payment",
    title: "Pagamentos",
    description: "Aplique um template à planilha e associe cada linha a um colaborador.",
    tags: ["CSV", "XLSX", "XLS", "ODS", "Link"],
    icon: Banknote,
    color: "#34d399",
  },
  {
    to: "/import/employees",
    area: "cadastros",
    importType: "employee",
    title: "Colaboradores",
    description: "Cadastre ou atualize colaboradores a partir de uma planilha.",
    tags: ["CSV", "XLSX", "XLS", "ODS"],
    icon: Users,
    color: "#c4b5fd",
  },
];

const STATUS_COLOR: Record<ImportStatus, string> = {
  success: "var(--success)",
  warning: "var(--warning)",
  error: "var(--danger)",
};

/** "hoje, 09:42", "ontem, 18:10", "há 3 dias", or the date for anything older than a week. */
function formatWhen(sqliteDatetime: string): string {
  const date = parseSqliteDateTime(sqliteDatetime);
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  const time = date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (days <= 0) return `hoje, ${time}`;
  if (days === 1) return `ontem, ${time}`;
  if (days < 7) return `há ${days} dias`;
  return date.toLocaleDateString("pt-BR");
}

export default function ImportChooserPage() {
  const navigate = useNavigate();
  const [lastByType, setLastByType] = useState<Partial<Record<ImportType, ImportFileRow | null>>>({});
  const [pendingCount, setPendingCount] = useState(0);
  const { canEdit, canView } = useAccess();
  const choices = CHOICES.filter((choice) => canEdit(choice.area));
  const seesPending = canView("verificacao") || canView("pagamentos") || canView("analises");

  useEffect(() => {
    let cancelled = false;
    for (const choice of CHOICES.filter((c) => canEdit(c.area))) {
      listImportFiles({ importType: choice.importType, search: "", page: 0, pageSize: 1 })
        .then(({ rows }) => {
          if (!cancelled) setLastByType((prev) => ({ ...prev, [choice.importType]: rows[0] ?? null }));
        })
        .catch(() => {});
    }
    // Same count as the floating "atualizações pendentes" card.
    if (seesPending) listAllLatestShiftDiffs()
      .then((rows) => {
        if (!cancelled) setPendingCount(rows.filter((r) => r.dismissedAt === null).length);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <PageHeader title="Importar dados" subtitle="Escolha o que você quer trazer para o PontoScan." />

      <div className="choice-grid">
        {choices.length === 0 && <p className="muted">Seu perfil não permite importar nada. Peça a um admin para mudar seu perfil.</p>}
        {choices.map((choice) => {
          const Icon = choice.icon;
          const last = lastByType[choice.importType];
          return (
            <Link key={choice.to} to={choice.to} className="choice-card">
              <div className="choice-card-top">
                <span className="choice-card-icon" style={{ color: choice.color, background: `color-mix(in srgb, ${choice.color} 12%, transparent)` }}>
                  <Icon size={20} />
                </span>
                <span className="choice-card-go" aria-hidden="true">
                  <ArrowRight size={15} />
                </span>
              </div>
              <div>
                <h3>{choice.title}</h3>
                <p>{choice.description}</p>
              </div>
              <div className="page-head-tags" style={{ marginTop: 0 }}>
                {choice.tags.map((tag) => (
                  <span key={tag} className="page-head-tag">
                    {tag}
                  </span>
                ))}
              </div>
              <div className="choice-card-last">
                {last === undefined ? (
                  <span className="choice-card-last-text">&nbsp;</span>
                ) : last === null ? (
                  <>
                    <span className="choice-card-dot" style={{ background: "var(--text-muted)" }} />
                    <span className="choice-card-last-text">Nenhuma importação ainda</span>
                  </>
                ) : (
                  <>
                    <span className="choice-card-dot" style={{ background: STATUS_COLOR[last.status] }} />
                    <span className="choice-card-last-text" title={safeDecodeFileName(last.fileName)}>
                      Última: <b>{safeDecodeFileName(last.fileName)}</b> · {formatWhen(last.importedAt)}
                    </span>
                  </>
                )}
              </div>
            </Link>
          );
        })}
      </div>

      {pendingCount > 0 && (
        <div className="choice-pending">
          <div className="choice-pending-main">
            <span className="choice-pending-icon">
              <RefreshCw size={16} />
            </span>
            <div>
              <strong>
                {pendingCount} {pendingCount === 1 ? "atualização pendente" : "atualizações pendentes"}
              </strong>
              <p>Planilhas importadas por link mudaram desde a última leitura.</p>
            </div>
          </div>
          <button type="button" className="outline" onClick={() => navigate("/remote-updates/imports")}>
            Abrir Verificação automática
            <ArrowRight size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
