/**
 * What the signed-in person may do (Usuários e perfis). The server checks
 * every request on its own (`server/src/access.rs`); this only shapes the
 * screens: areas without access leave the menu, view-only areas show their
 * edit buttons disabled.
 */
export type Area = "cadastros" | "espelhos" | "pagamentos" | "analises" | "verificacao" | "configuracoes";
export type Level = "none" | "view" | "edit";

export const AREAS: { id: Area; label: string; desc: string; editable: boolean }[] = [
  { id: "cadastros", label: "Cadastros", desc: "Empresas, clientes, colaboradores, funções", editable: true },
  { id: "espelhos", label: "Espelhos e Cartão Ponto", desc: "Importar espelhos, histórico, cartão ponto", editable: true },
  { id: "pagamentos", label: "Pagamentos", desc: "Importar planilhas, turnos, conferência, modelos", editable: true },
  { id: "analises", label: "Análises", desc: "Só leitura por natureza", editable: false },
  { id: "verificacao", label: "Verificação automática", desc: "Editar: conferir agora, regras, marcar como visto", editable: true },
  { id: "configuracoes", label: "Configurações", desc: "Espaço usado e a chave do assistente com IA", editable: true },
];

export function areaLabel(area: Area): string {
  return AREAS.find((a) => a.id === area)?.label ?? area;
}

export interface Permissions {
  areas: Partial<Record<Area, Level>>;
  export: boolean;
  ai: boolean;
  users: boolean;
}

/** `GET /me`. */
export interface Access {
  email: string;
  /** Configured on the server: always Admin. */
  initialAdmin: boolean;
  profileName: string;
  isAdmin: boolean;
  permissions: Permissions;
}

export function levelOf(access: Access, area: Area): Level {
  if (access.isAdmin) return area === "analises" ? "view" : "edit";
  return access.permissions.areas[area] ?? "none";
}

export function canView(access: Access, area: Area): boolean {
  return levelOf(access, area) !== "none";
}

export function canEdit(access: Access, area: Area): boolean {
  return levelOf(access, area) === "edit";
}
