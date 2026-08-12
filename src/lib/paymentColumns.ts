import type { MultiSelectOption } from "../components/MultiSelectDropdown";

/**
 * Every column a turno row can show — shared between the Pagamentos page's
 * own "Configurar colunas" picker and the "Conferência de Pagamentos" modal
 * (which keeps its own, independent visible-columns selection instead of
 * sharing `payment_settings.visible_columns_json`).
 */
export const FLAT_COLUMNS: MultiSelectOption<string>[] = [
  { id: "colaborador", label: "Colaborador" },
  { id: "cliente", label: "Cliente" },
  { id: "empresa", label: "Empresa" },
  { id: "data", label: "Data" },
  { id: "local", label: "Local" },
  { id: "funcao", label: "Função" },
  { id: "horario", label: "Horário" },
  { id: "horas", label: "H/trab." },
  { id: "valor", label: "Valor" },
  { id: "status", label: "Status" },
  { id: "importado", label: "Importado em" },
  { id: "extras", label: "Extras" },
];

export const ALL_COLUMN_IDS = FLAT_COLUMNS.map((c) => c.id);
