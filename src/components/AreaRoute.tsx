import { createContext, useContext, type ReactNode } from "react";
import { useAccess } from "../contexts/AuthContext";
import { AREAS, areaLabel, type Area } from "../lib/access";

/** The area of the page being shown, and whether the profile only lets it be viewed. */
const AreaContext = createContext<{ area: Area | null; readOnly: boolean }>({ area: null, readOnly: false });

/**
 * Wraps a page with its area (Usuários e perfis). Without "Ver" the page is
 * replaced by a notice; with "Ver" only, the page is shown in read-only mode
 * (`useReadOnly()`), and `PageHeader` shows "Somente visualização".
 * `needEdit`: pages that only exist to change something (the import screens)
 * are refused without "Editar" too.
 */
export default function AreaRoute({ area, needEdit = false, children }: { area: Area; needEdit?: boolean; children: ReactNode }) {
  const { canView, canEdit } = useAccess();
  if (!canView(area)) return <AccessDenied title={`Você não tem acesso a ${areaLabel(area)}`} />;
  if (needEdit && !canEdit(area)) return <AccessDenied title={`Seu perfil só permite visualizar ${areaLabel(area)}`} />;
  // Análises has nothing to edit: it's never "view-only" for anyone.
  const editable = AREAS.find((a) => a.id === area)?.editable ?? true;
  return <AreaContext.Provider value={{ area, readOnly: editable && !canEdit(area) }}>{children}</AreaContext.Provider>;
}

export function AccessDenied({ title }: { title: string }) {
  return (
    <div className="access-denied" role="status">
      <strong>{title}</strong>
      <span className="muted">Peça a um admin para mudar seu perfil em Usuários e perfis.</span>
    </div>
  );
}

/**
 * True when the current page's area is view-only for this profile: disable
 * what changes data (and say why with `READ_ONLY_TITLE`). The server refuses
 * those requests anyway; this keeps the screen honest.
 */
export function useReadOnly(): boolean {
  return useContext(AreaContext).readOnly;
}

/** Tooltip for a control disabled by a view-only profile. */
export const READ_ONLY_TITLE = "Seu perfil só permite visualizar";
