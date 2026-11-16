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

/** What the column picker shows for each column: a group, the full name (the table header keeps the short one) and an example of the content. */
export const COLUMN_PICKER_DETAILS: Record<string, { group: string; name?: string; sample: string }> = {
  colaborador: { group: "Quem", sample: "Nome do colaborador" },
  cliente: { group: "Quem", sample: "Cliente do turno" },
  empresa: { group: "Quem", sample: "Empresa do turno" },
  data: { group: "Turno", sample: "10/ago./26" },
  local: { group: "Turno", sample: "Onde o turno foi feito" },
  funcao: { group: "Turno", sample: "Função no turno" },
  horario: { group: "Turno", sample: "08:00 – 17:00" },
  horas: { group: "Turno", name: "Horas trabalhadas", sample: "8h00" },
  valor: { group: "Pagamento", sample: "R$ 84,00" },
  status: { group: "Pagamento", sample: "Pendente, Erro ou Pago" },
  importado: { group: "Mais", sample: "Quando o turno foi importado" },
  extras: { group: "Mais", sample: "Colunas do arquivo que não foram mapeadas" },
};

/** Without it a row doesn't say whose turno it is, so the picker keeps it on. */
export const ALWAYS_VISIBLE_COLUMN_ID = "colaborador";
