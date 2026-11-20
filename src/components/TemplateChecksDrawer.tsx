import { ChevronRight, RefreshCw } from "lucide-react";
import Drawer from "./Drawer";
import type { ReimportConfig } from "../lib/db";
import { formatDate, formatTimeAgo, resolveReimportConfigLabel } from "../lib/format";

/**
 * "Verificações automáticas" of one payment template: every reimport config
 * (Verificação automática rule) that reads its file through this template,
 * active ones first. Opened from the count on the Templates de pagamento
 * list; a card opens that rule on the Verificação automática page.
 */
export default function TemplateChecksDrawer({
  open,
  onClose,
  templateName,
  configs,
  fileNameOf,
  onOpenConfig,
  onOpenPage,
}: {
  open: boolean;
  onClose: () => void;
  templateName: string;
  configs: ReimportConfig[];
  fileNameOf: (sourceUrl: string) => string;
  /** `null` when the person can't open Verificação automática: the cards are then plain, not links. */
  onOpenConfig: ((config: ReimportConfig) => void) | null;
  onOpenPage: (() => void) | null;
}) {
  const active = configs.filter((c) => !c.checkDisabled);
  const paused = configs.filter((c) => c.checkDisabled);
  const card = (c: ReimportConfig) => {
    const body = (
      <>
        <span className="tcd-top">
          <span className="tcd-file-icon" aria-hidden="true">
            XLS
          </span>
          <span className="tcd-name">
            <b>{resolveReimportConfigLabel(c)}</b>
            <span>{fileNameOf(c.sourceUrl)}</span>
          </span>
          <span className={c.checkDisabled ? "tcd-pill tcd-pill-off" : "tcd-pill tcd-pill-on"}>{c.checkDisabled ? "Pausada" : "Ativa"}</span>
          {onOpenConfig && <ChevronRight size={15} className="tcd-chev" aria-hidden="true" />}
        </span>
        <span className="tcd-kvs">
          <span className="k">Período</span>
          <span className="v">{describeReimportPeriod(c)}</span>
          {!c.checkDisabled && (
            <>
              <span className="k">Confere</span>
              <span className="v">{describeInterval(c.checkIntervalMinutes)}</span>
            </>
          )}
          <span className="k">Última conferência</span>
          <span className="v">{c.lastCheckedAt ? formatTimeAgo(c.lastCheckedAt) : "ainda não conferiu"}</span>
          <span className="k">Quando acha mudança</span>
          <span className="v">
            <span className={c.autoApplyEnabled ? "tcd-tag tcd-tag-auto" : "tcd-tag"}>{c.autoApplyEnabled ? "atualiza sozinha" : "espera você revisar"}</span>
          </span>
        </span>
      </>
    );
    const className = `tcd-card${c.checkDisabled ? " is-off" : ""}`;
    return onOpenConfig ? (
      <button key={c.id} type="button" className={className} onClick={() => onOpenConfig(c)} title="Abrir na Verificação automática">
        {body}
      </button>
    ) : (
      <div key={c.id} className={className}>
        {body}
      </div>
    );
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Verificações automáticas"
      icon={RefreshCw}
      subtitle={`${configs.length} ${configs.length === 1 ? "usa" : "usam"} o template ${templateName}`}
      width="min(480px, calc(100vw - 24px))"
      footer={
        onOpenPage ? (
          <>
            <span className="sa-spacer" />
            <button type="button" className="outline" style={{ whiteSpace: "nowrap" }} onClick={onOpenPage}>
              Ir para Verificação automática
            </button>
          </>
        ) : undefined
      }
    >
      <div className="tcd-list">
        {active.length > 0 && <div className="tcd-section">Ativas</div>}
        {active.map(card)}
        {paused.length > 0 && <div className="tcd-section">Pausadas</div>}
        {paused.map(card)}
        <p className="tcd-hint">Para criar outra, importe o arquivo pela URL e marque “Rastrear atualizações”.</p>
      </div>
    </Drawer>
  );
}

/** "só o dia de hoje", "de 7 dias atrás até hoje", "01/10/2026 a 31/10/2026"... */
export function describeReimportPeriod(c: Pick<ReimportConfig, "dateMode" | "periodStart" | "periodEnd" | "startOffsetDays" | "endOffsetDays">): string {
  if (c.dateMode === "month") return "do dia 1º do mês até hoje";
  if (c.dateMode === "relative") {
    const { startOffsetDays: start, endOffsetDays: end } = c;
    if (start === 0 && end === 0) return "só o dia de hoje";
    if (start === 1 && end === 1) return "só ontem";
    if (start !== null && end === 0) return `de ${start} ${start === 1 ? "dia" : "dias"} atrás até hoje`;
    if (start !== null && end !== null) return `de ${start} a ${end} dias atrás`;
    return "personalizado";
  }
  if (c.periodStart && c.periodEnd) return c.periodStart === c.periodEnd ? `só ${formatDate(c.periodStart)}` : `${formatDate(c.periodStart)} a ${formatDate(c.periodEnd)}`;
  if (c.periodStart) return `de ${formatDate(c.periodStart)} em diante`;
  if (c.periodEnd) return `até ${formatDate(c.periodEnd)}`;
  return "todo o relatório";
}

/** 15 → "a cada 15 minutos", 60 → "a cada 1 hora", 90 → "a cada 1 h 30 min". */
export function describeInterval(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `a cada ${m} ${m === 1 ? "minuto" : "minutos"}`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (rest === 0) return `a cada ${h} ${h === 1 ? "hora" : "horas"}`;
  return `a cada ${h} h ${rest} min`;
}
