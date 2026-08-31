import type { PaymentExportTemplateConfig, TemplateGridCell, TemplateGridData } from "./types";

export interface PaymentExportTemplateExample {
  id: string;
  title: string;
  description: string;
  category: string;
  result: string[];
  config: PaymentExportTemplateConfig;
}

function cell(value = "", options: Partial<TemplateGridCell> = {}): TemplateGridCell {
  return {
    value,
    backgroundColor: null,
    fontColor: null,
    bold: false,
    italic: false,
    fontFamily: null,
    fontSize: null,
    border: { top: null, right: null, bottom: null, left: null },
    horizontalAlign: null,
    verticalAlign: null,
    ...options,
  };
}

function grid(rows: Array<Array<string | TemplateGridCell>>, widths?: number[]): TemplateGridData {
  const columnCount = Math.max(8, ...rows.map((row) => row.length));
  const normalized = rows.map((row) => Array.from({ length: columnCount }, (_, col) => {
    const value = row[col];
    return typeof value === "string" || value === undefined ? cell(value ?? "") : value;
  }));
  while (normalized.length < 14) normalized.push(Array.from({ length: columnCount }, () => cell()));
  return {
    rows: normalized,
    columnWidths: Array.from({ length: columnCount }, (_, col) => widths?.[col] ?? 125),
    columnAutoFit: Array.from({ length: columnCount }, () => true),
    rowHeights: Array.from({ length: normalized.length }, () => 30),
    merges: [],
  };
}

const header = (value: string) => cell(value, { bold: true, backgroundColor: "#1e293b", fontColor: "#ffffff", horizontalAlign: "center" });
const group = (value: string) => cell(value, { bold: true, backgroundColor: "#dbeafe", fontColor: "#172554" });
const total = (value: string) => cell(value, { bold: true, backgroundColor: "#e5e7eb", fontColor: "#111827" });

function config(
  rows: Array<Array<string | TemplateGridCell>>,
  options: Partial<PaymentExportTemplateConfig> = {},
): PaymentExportTemplateConfig {
  return {
    grid: grid(rows),
    detailRowIndex: 1,
    groupBy: [],
    groupHeader: null,
    consolidated: null,
    outline: { enabled: false, collapsed: false },
    separator: null,
    subtotal: null,
    subtotalGroupBy: [],
    ...options,
  };
}

export const PAYMENT_EXPORT_TEMPLATE_EXAMPLES: PaymentExportTemplateExample[] = [
  {
    id: "simple",
    category: "Primeiros passos",
    title: "Lista simples de turnos",
    description: "O ponto de partida: títulos fixos e uma linha repetida para cada turno.",
    result: ["COLABORADOR | DATA | FUNÇÃO | HORAS | VALOR | STATUS", "Crislan | 02/08/2026 | FLV | 06:00 | R$ 80,00 | Pendente"],
    config: config([
      [header("COLABORADOR"), header("DATA"), header("FUNÇÃO"), header("HORAS"), header("VALOR"), header("STATUS")],
      ["{{employeeName}}", "{{workDate}}", "{{role}}", "{{workedHours}}", "{{valor}}", "{{status}}"],
    ]),
  },
  {
    id: "styled",
    category: "Formatação",
    title: "Lista corporativa formatada",
    description: "Lista simples com cabeçalho escuro, alinhamento, moeda e larguras automáticas.",
    result: ["EMPRESA | CLIENTE | COLABORADOR | LOCAL | DATA | VALOR", "Empresa A | Cliente X | Crislan | Loja 12 | 02/08 | R$ 80,00"],
    config: config([
      [header("EMPRESA"), header("CLIENTE"), header("COLABORADOR"), header("LOCAL"), header("DATA"), header("VALOR")],
      ["{{companyName}}", "{{clientName}}", "{{employeeName}}", "{{local}}", "{{workDate}}", "{{valor}}"],
    ]),
  },
  {
    id: "employee_header",
    category: "Cabeçalho de bloco",
    title: "Turnos por colaborador",
    description: "Abre cada bloco com o nome e a quantidade de turnos, mantendo todos os detalhes.",
    result: ["CRISLAN · 4 TURNOS", "  02/08 | FLV | 06:00 | R$ 80,00", "  03/08 | Mercearia | 06:00 | R$ 90,00"],
    config: config([
      [header("DATA"), header("FUNÇÃO"), header("HORAS"), header("VALOR"), header("STATUS")],
      ["{{workDate}}", "{{role}}", "{{workedHours}}", "{{valor}}", "{{status}}"],
      [group("{{employeeName}}"), group("{{quantidade}} turnos")],
    ], { groupBy: ["employeeName"], groupHeader: { enabled: true, rowIndex: 2 }, subtotalGroupBy: ["employeeName"] }),
  },
  {
    id: "company_employee",
    category: "Agrupamento combinado",
    title: "Empresa + colaborador com subtotal",
    description: "Cria um bloco para cada combinação e totaliza horas e valores ao final.",
    result: ["EMPRESA A · CRISLAN · 2 TURNOS", "  detalhes...", "SUBTOTAL | 12:00 | R$ 170,00"],
    config: config([
      [header("DATA"), header("LOCAL"), header("FUNÇÃO"), header("HORAS"), header("VALOR")],
      ["{{workDate}}", "{{local}}", "{{role}}", "{{workedHours}}", "{{valor}}"],
      [group("{{companyName}}"), group("{{employeeName}}"), group("{{quantidade}} turnos")],
      [total("SUBTOTAL"), "", "", total("{{soma:workedHours}}"), total("{{soma:valor}}")],
    ], { groupBy: ["companyName", "employeeName"], groupHeader: { enabled: true, rowIndex: 2 }, subtotal: { enabled: true, rowIndex: 3 }, subtotalGroupBy: ["companyName", "employeeName"] }),
  },
  {
    id: "collapsible",
    category: "Grupos recolhíveis",
    title: "Colaborador recolhível",
    description: "Mostra o cabeçalho e permite abrir ou fechar os turnos com + e − no Excel.",
    result: ["− CRISLAN · 4 TURNOS", "    turno 1", "    turno 2", "  SUBTOTAL"],
    config: config([
      [header("DATA"), header("FUNÇÃO"), header("HORAS"), header("VALOR")],
      ["{{workDate}}", "{{role}}", "{{workedHours}}", "{{valor}}"],
      [group("{{employeeName}}"), group("{{quantidade}} turnos")],
      [total("SUBTOTAL"), "", total("{{soma:workedHours}}"), total("{{soma:valor}}")],
    ], { groupBy: ["employeeName"], groupHeader: { enabled: true, rowIndex: 2 }, outline: { enabled: true, collapsed: false }, subtotal: { enabled: true, rowIndex: 3 }, subtotalGroupBy: ["employeeName"] }),
  },
  {
    id: "collapsed",
    category: "Grupos recolhíveis",
    title: "Resumo inicialmente recolhido",
    description: "Igual ao agrupamento recolhível, mas abre o arquivo mostrando apenas os cabeçalhos e subtotais.",
    result: ["+ CRISLAN · 4 TURNOS | R$ 320,00", "+ WELLINTON · 2 TURNOS | R$ 180,00"],
    config: config([
      [header("DATA"), header("FUNÇÃO"), header("HORAS"), header("VALOR")],
      ["{{workDate}}", "{{role}}", "{{workedHours}}", "{{valor}}"],
      [group("{{employeeName}}"), group("{{quantidade}} turnos")],
      [total("SUBTOTAL"), "", total("{{soma:workedHours}}"), total("{{soma:valor}}")],
    ], { groupBy: ["employeeName"], groupHeader: { enabled: true, rowIndex: 2 }, outline: { enabled: true, collapsed: true }, subtotal: { enabled: true, rowIndex: 3 }, subtotalGroupBy: ["employeeName"] }),
  },
  {
    id: "employee_summary",
    category: "Linha consolidada",
    title: "Uma linha por colaborador",
    description: "Substitui os turnos individuais por quantidade, horas e valor total.",
    result: ["COLABORADOR | TURNOS | HORAS | TOTAL", "Crislan | 4 | 24:00 | R$ 320,00"],
    config: config([
      [header("COLABORADOR"), header("TURNOS"), header("HORAS"), header("TOTAL")],
      ["{{employeeName}}", "{{workDate}}", "{{workedHours}}", "{{valor}}"],
      ["{{employeeName}}", "{{quantidade}}", "{{soma:workedHours}}", "{{soma:valor}}"],
    ], { groupBy: ["employeeName"], consolidated: { enabled: true, rowIndex: 2 }, subtotalGroupBy: ["employeeName"] }),
  },
  {
    id: "company_employee_summary",
    category: "Linha consolidada",
    title: "Resumo por empresa e colaborador",
    description: "Uma linha para cada combinação, com período, funções, horas e total.",
    result: ["EMPRESA | COLABORADOR | DE | ATÉ | FUNÇÕES | TURNOS | TOTAL", "Empresa A | Crislan | 02/08 | 20/08 | FLV, Mercearia | 4 | R$ 320,00"],
    config: config([
      [header("EMPRESA"), header("COLABORADOR"), header("DE"), header("ATÉ"), header("FUNÇÕES"), header("TURNOS"), header("HORAS"), header("TOTAL")],
      ["{{companyName}}", "{{employeeName}}", "{{workDate}}", "{{workDate}}", "{{role}}", "", "{{workedHours}}", "{{valor}}"],
      ["{{companyName}}", "{{employeeName}}", "{{primeiro:workDate}}", "{{ultimo:workDate}}", "{{lista:role}}", "{{quantidade}}", "{{soma:workedHours}}", "{{soma:valor}}"],
    ], { groupBy: ["companyName", "employeeName"], consolidated: { enabled: true, rowIndex: 2 }, subtotalGroupBy: ["companyName", "employeeName"] }),
  },
  {
    id: "unique_lists",
    category: "Operadores de resumo",
    title: "Funções e status sem repetição",
    description: "Demonstra Lista: valores repetidos aparecem apenas uma vez no resumo.",
    result: ["CRISLAN | FLV, Mercearia | Pendente, Pago | 4 turnos"],
    config: config([
      [header("COLABORADOR"), header("FUNÇÕES"), header("STATUS"), header("TURNOS")],
      ["{{employeeName}}", "{{role}}", "{{status}}", "{{valor}}"],
      ["{{employeeName}}", "{{lista:role}}", "{{lista:status}}", "{{quantidade}}"],
    ], { groupBy: ["employeeName"], consolidated: { enabled: true, rowIndex: 2 }, subtotalGroupBy: ["employeeName"] }),
  },
  {
    id: "company_subtotal",
    category: "Subtotais",
    title: "Detalhes por colaborador, total por empresa",
    description: "Os blocos são separados por colaborador, mas a soma acumula todos os colaboradores da mesma empresa.",
    result: ["Empresa A / Crislan — detalhes", "Empresa A / Wellinton — detalhes", "TOTAL EMPRESA A | R$ 490,00"],
    config: config([
      [header("EMPRESA"), header("COLABORADOR"), header("DATA"), header("VALOR")],
      ["{{companyName}}", "{{employeeName}}", "{{workDate}}", "{{valor}}"],
      ["", "", total("TOTAL DA EMPRESA"), total("{{soma:valor}}")],
    ], { groupBy: ["companyName", "employeeName"], subtotal: { enabled: true, rowIndex: 2 }, subtotalGroupBy: ["companyName"] }),
  },
  {
    id: "grand_total",
    category: "Subtotais",
    title: "Lista com total geral",
    description: "Mantém todos os turnos e imprime uma única soma no fim do arquivo.",
    result: ["todos os turnos...", "TOTAL GERAL | 120:00 | R$ 2.450,00"],
    config: config([
      [header("COLABORADOR"), header("DATA"), header("FUNÇÃO"), header("HORAS"), header("VALOR")],
      ["{{employeeName}}", "{{workDate}}", "{{role}}", "{{workedHours}}", "{{valor}}"],
      ["", "", total("TOTAL GERAL"), total("{{soma:workedHours}}"), total("{{soma:valor}}")],
    ], { subtotal: { enabled: true, rowIndex: 2 }, subtotalGroupBy: [] }),
  },
  {
    id: "visual_separator",
    category: "Separadores",
    title: "Blocos com espaço visual",
    description: "Insere uma linha vazia entre colaboradores, sem adicionar cabeçalho ou subtotal.",
    result: ["Crislan — turno 1", "Crislan — turno 2", "", "Wellinton — turno 1"],
    config: config([
      [header("COLABORADOR"), header("DATA"), header("FUNÇÃO"), header("VALOR")],
      ["{{employeeName}}", "{{workDate}}", "{{role}}", "{{valor}}"],
      [cell("", { backgroundColor: "#f1f5f9" })],
    ], { groupBy: ["employeeName"], separator: { enabled: true, rowIndex: 2 }, subtotalGroupBy: ["employeeName"] }),
  },
];
