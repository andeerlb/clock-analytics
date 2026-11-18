import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Table2, UploadCloud } from "lucide-react";
import { useState, type DragEvent, type ReactNode, type RefObject } from "react";
import Drawer from "./Drawer";
import { fileNameFromPath } from "../lib/format";
import { PAYMENT_TARGET_FIELD_LABELS, type IdentifierField, type PaymentFileKind } from "../lib/types";

/**
 * The pieces both template wizards (pagamentos and colaboradores) are built
 * from: the side sheet with the steps rail, the "Qual planilha usar de
 * exemplo?" step, the "Quais abas importar?" step and the "Como achar o
 * colaborador?" order.
 */

export interface WizardRailStep {
  key: string;
  label: string;
  /** What was answered there, e.g. "4 de 6 abas"; "—" for steps not reached yet. */
  summary: string;
}

/**
 * The wizard's frame: the app's Drawer (a click outside doesn't close it),
 * a rail of steps on the left (done steps are clickable to go back) and
 * the step's content with its own footer (Voltar · Continuar/Salvar).
 * Nothing floats over it: see `body.wizard-open` in App.css.
 */
export function WizardDrawer({
  open,
  onClose,
  title,
  subtitle,
  steps,
  stepIndex,
  onStep,
  error,
  bodyRef,
  onBack,
  backDisabled,
  next,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle: string;
  steps: WizardRailStep[];
  stepIndex: number;
  onStep: (index: number) => void;
  error: string | null;
  bodyRef?: RefObject<HTMLDivElement | null>;
  onBack: () => void;
  backDisabled: boolean;
  /** The footer's main button (Continuar / Salvar template). */
  next: { label: string; onClick: () => void; disabled?: boolean; title?: string; arrow?: boolean };
  children: ReactNode;
}) {
  const current = steps[stepIndex];
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={title}
      icon={Table2}
      subtitle={subtitle}
      width="min(1040px, calc(100vw - 24px))"
      className="wz-drawer"
      closeOnBackdrop={false}
    >
      <div className="wz">
        <aside className="wz-rail">
          <nav className="wz-steps" aria-label="Passos">
            {steps.map((s, i) => {
              const done = i < stepIndex;
              const isCurrent = i === stepIndex;
              return (
                <button
                  key={s.key}
                  type="button"
                  className={`wz-step${done ? " done" : ""}${isCurrent ? " current" : ""}`}
                  aria-current={isCurrent ? "step" : undefined}
                  disabled={!done}
                  onClick={() => onStep(i)}
                >
                  <i aria-hidden="true">{done ? <Check size={12} strokeWidth={3} /> : i + 1}</i>
                  <span>
                    {s.label}
                    <small>{s.summary}</small>
                  </span>
                </button>
              );
            })}
          </nav>
          <div className="wz-rail-foot">
            <button type="button" className="ghost wz-cancel" onClick={onClose}>
              Cancelar
            </button>
          </div>
        </aside>

        <div className="wz-main">
          <div className="wz-top">
            Passo {stepIndex + 1} de {steps.length} · {current?.label}
          </div>
          <div className="wz-body" ref={bodyRef}>
            {error && <div className="error-box wz-error">{error}</div>}
            {children}
          </div>
          <div className="wz-foot">
            <button
              type="button"
              className="ghost"
              onClick={onBack}
              disabled={stepIndex === 0 || backDisabled}
              style={stepIndex === 0 ? { visibility: "hidden" } : undefined}
            >
              <ChevronLeft size={15} style={{ marginRight: "0.3rem" }} />
              Voltar
            </button>
            <span className="wz-foot-gap" />
            <button type="button" onClick={next.onClick} disabled={next.disabled} title={next.title}>
              {next.label}
              {next.arrow && <ChevronRight size={15} style={{ marginLeft: "0.3rem" }} />}
            </button>
          </div>
        </div>
      </div>
    </Drawer>
  );
}

/** "Qual planilha usar de exemplo?": drop or pick a file, or download one by link; once read, a card with its sheets and "Trocar". */
export function SampleFileStep({
  filePath,
  fileKind,
  loading,
  sheets,
  onPick,
  onDrop,
  onReset,
  onDownload,
}: {
  filePath: string | null;
  fileKind: PaymentFileKind | null;
  loading: boolean;
  sheets: string[];
  onPick: () => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  onReset: () => void;
  /** Downloads the file behind a link; rejects with a message to show. */
  onDownload: (url: string) => Promise<void>;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [url, setUrl] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);

  async function download() {
    const target = url.trim();
    if (!target || downloading) return;
    setUrlError(null);
    setDownloading(true);
    try {
      await onDownload(target);
    } catch (e) {
      setUrlError(String(e instanceof Error ? e.message : e));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="tmap">
      <h2 className="tmap-title">Qual planilha usar de exemplo?</h2>
      <p className="tmap-lead">Ela serve só para montar o template e não fica guardada.</p>

      {filePath || loading ? (
        <div className="tfile-card">
          <span className="tfile-kind">{(fileKind ?? "").toUpperCase()}</span>
          <div className="tfile-info">
            <b>{filePath ? fileNameFromPath(filePath) : "Planilha"}</b>
            {loading ? (
              <>
                <span>Lendo a planilha…</span>
                <span className="tfile-bar" aria-hidden="true">
                  <i />
                </span>
              </>
            ) : (
              <span>{fileKind === "csv" ? "Arquivo CSV" : `${sheets.length} ${sheets.length === 1 ? "aba encontrada" : "abas encontradas"}`}</span>
            )}
          </div>
          {!loading && (
            <button type="button" className="secondary" onClick={onReset}>
              Trocar
            </button>
          )}
        </div>
      ) : (
        <>
          <div
            className={`tfile-drop${dragOver ? " over" : ""}`}
            onClick={onPick}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              setDragOver(false);
              onDrop(e);
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onPick();
              }
            }}
          >
            <span className="tfile-icon" aria-hidden="true">
              <UploadCloud size={20} />
            </span>
            <div className="tfile-info">
              <b>Arraste a planilha aqui</b>
              <span>.xlsx, .xls, .ods ou .csv</span>
            </div>
            <button
              type="button"
              className="secondary"
              onClick={(e) => {
                e.stopPropagation();
                onPick();
              }}
            >
              Escolher arquivo
            </button>
          </div>

          <div className="tfile-or">ou pelo link</div>
          <div className="tfile-url">
            <input
              type="url"
              className="tdet-input"
              placeholder="Cole o link de download (OneDrive, Google Drive, …)"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") download();
              }}
              disabled={downloading}
              aria-label="Link da planilha"
            />
            <button type="button" className="secondary" onClick={download} disabled={!url.trim() || downloading}>
              {downloading ? "Baixando…" : "Baixar"}
            </button>
          </div>
          {urlError ? <div className="error-box">{urlError}</div> : <p className="tfile-hint">O link precisa abrir o arquivo sem pedir login.</p>}
        </>
      )}

      {filePath && !loading && fileKind !== "csv" && sheets.length > 0 && (
        <div className="tfile-tabs">
          {sheets.map((s) => (
            <span key={s}>{s}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Quais abas importar?": a checkbox per sheet, "Remover" on hover, "+ Adicionar aba", double-click to rename. */
export function SheetsStep({
  sheets,
  included,
  onToggle,
  onRemove,
  onAdd,
  onRename,
}: {
  sheets: string[];
  included: Set<string>;
  onToggle: (sheet: string) => void;
  onRemove: (sheet: string) => void;
  /** Adds a sheet and returns its name, which then opens for renaming. */
  onAdd: () => string;
  /** `false` when the new name can't be used (the sheet stays in rename mode). */
  onRename: (oldName: string, newName: string) => boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  function start(sheet: string) {
    setEditing(sheet);
    setDraft(sheet);
  }
  function commit(sheet: string) {
    if (onRename(sheet, draft)) setEditing(null);
  }

  return (
    <div className="tmap">
      <h2 className="tmap-title">Quais abas importar?</h2>
      <p className="tmap-lead">
        {included.size} de {sheets.length} {sheets.length === 1 ? "aba marcada" : "abas marcadas"}. Dois cliques no nome para renomear.
      </p>
      <div className="tmap-sheets">
        {sheets.map((s) => {
          const on = included.has(s);
          return (
            <div key={s} className={`tmap-sheet${on ? "" : " off"}`} onClick={() => onToggle(s)}>
              <input
                type="checkbox"
                checked={on}
                onChange={() => onToggle(s)}
                onClick={(e) => e.stopPropagation()}
                aria-label={on ? `Não importar "${s}"` : `Importar "${s}"`}
              />
              {editing === s ? (
                <input
                  autoFocus
                  type="text"
                  className="tmap-rename"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commit(s)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commit(s);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setEditing(null);
                    }
                  }}
                />
              ) : (
                <span
                  className="tmap-sheet-name"
                  title="Dois cliques para renomear"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    start(s);
                  }}
                >
                  {s}
                </span>
              )}
              <button
                type="button"
                className="tmap-remove"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(s);
                }}
                aria-label={`Remover "${s}"`}
              >
                Remover
              </button>
            </div>
          );
        })}
        <button type="button" className="tmap-addline" onClick={() => start(onAdd())}>
          + Adicionar aba
        </button>
      </div>
    </div>
  );
}

/** "Como achar o colaborador?": the identifier columns the template answers, tried in order (one only → a sentence). */
export function IdentifierOrderSection({
  title,
  order,
  onMove,
}: {
  title: string;
  /** Already narrowed to the answered identifier columns. */
  order: IdentifierField[];
  onMove: (index: number, dir: -1 | 1) => void;
}) {
  return (
    <section className="tdet-section">
      <h3>{title}</h3>
      {order.length === 1 ? (
        <p className="tdet-once">
          {order[0] === "matricula" ? "Pela" : "Pelo"} <b>{PAYMENT_TARGET_FIELD_LABELS[order[0]]}</b>, a única coluna de colaborador respondida em Colunas.
        </p>
      ) : (
        <>
          <p className="tdet-sub">Tenta na ordem e para no primeiro que encontrar alguém. Maiúsculas não importam.</p>
          <div className="tdet-ids">
            {order.map((f, i) => (
              <div key={f} className="tdet-id">
                <span className="vr-num">{i + 1}</span>
                <span className="tdet-id-text">
                  {i === 0 ? "Procurar" : "Se não achar,"} {f === "matricula" ? "pela" : "pelo"} <b>{PAYMENT_TARGET_FIELD_LABELS[f]}</b>
                </span>
                <button type="button" className="vr-icon" aria-label="Subir" title="Subir" disabled={i === 0} onClick={() => onMove(i, -1)}>
                  <ChevronUp size={14} />
                </button>
                <button type="button" className="vr-icon" aria-label="Descer" title="Descer" disabled={i === order.length - 1} onClick={() => onMove(i, 1)}>
                  <ChevronDown size={14} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** Moves one entry of the shown (answered) order and keeps the unanswered fields after it. */
export function moveIdentifier(full: IdentifierField[], shown: IdentifierField[], index: number, dir: -1 | 1): IdentifierField[] {
  const next = [...shown];
  [next[index], next[index + dir]] = [next[index + dir], next[index]];
  return [...next, ...full.filter((f) => !next.includes(f))];
}
