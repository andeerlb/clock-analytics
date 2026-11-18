import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useReadOnly } from "./AreaRoute";

/**
 * The standard top of every page: an optional square "voltar" button stuck
 * to the left of the title, the title, a short one-line subtitle, optional
 * small tags under it (e.g. the file formats an import accepts) and the
 * page's actions on the right.
 *
 * Back behavior:
 * - `backTo`: always goes to that route (a fixed parent, e.g. "/import").
 * - `backFallback`: goes back one history entry when there is one, else to
 *   this route — for pages reachable from more than one parent.
 *
 * In an area the profile can only view (see `AreaRoute`), a "Somente
 * visualização" tag shows next to the title.
 *
 * Actions convention: the page's main action is a regular (filled) button;
 * secondary actions are `className="outline"`; the least important ones
 * (e.g. "Histórico") are `className="ghost"`.
 */
export default function PageHeader({
  title,
  subtitle,
  tags,
  actions,
  backTo,
  backFallback,
  backLabel = "Voltar",
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  tags?: string[];
  actions?: ReactNode;
  backTo?: string;
  backFallback?: string;
  /** Tooltip/aria-label of the back button, e.g. "Voltar para Importar". */
  backLabel?: string;
}) {
  const navigate = useNavigate();
  const readOnly = useReadOnly();
  const hasBack = backTo !== undefined || backFallback !== undefined;

  function goBack() {
    if (backTo !== undefined) {
      navigate(backTo);
    } else if ((window.history.state?.idx ?? 0) > 0) {
      navigate(-1);
    } else {
      navigate(backFallback ?? "/");
    }
  }

  return (
    <header className="page-head">
      <div className="page-head-main">
        <div className="page-head-title">
          {hasBack && (
            <button type="button" className="page-head-back" onClick={goBack} aria-label={backLabel} title={backLabel}>
              <ArrowLeft size={16} />
            </button>
          )}
          <h2>{title}</h2>
          {readOnly && (
            <span className="page-head-readonly" title="Seu perfil permite ver esta área, mas não alterar">
              Somente visualização
            </span>
          )}
        </div>
        {subtitle && <p className="page-head-subtitle">{subtitle}</p>}
        {tags && tags.length > 0 && (
          <div className="page-head-tags">
            {tags.map((tag) => (
              <span key={tag} className="page-head-tag">
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </header>
  );
}
