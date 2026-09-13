import type { PaymentPdfTemplateConfig, TemplateGridCell, TemplateGridData, TemplateGridMerge } from "./types";

export interface PaymentPdfTemplateExample {
  id: string;
  title: string;
  description: string;
  category: string;
  result: string[];
  config: PaymentPdfTemplateConfig;
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

function grid(rows: Array<Array<string | TemplateGridCell>>, widths?: number[], merges: TemplateGridMerge[] = []): TemplateGridData {
  const columnCount = Math.max(8, ...rows.map((row) => row.length));
  const normalized = rows.map((row) => Array.from({ length: columnCount }, (_, col) => {
    const value = row[col];
    return typeof value === "string" || value === undefined ? cell(value ?? "") : value;
  }));
  while (normalized.length < 14) normalized.push(Array.from({ length: columnCount }, () => cell()));
  return {
    rows: normalized,
    columnWidths: Array.from({ length: columnCount }, (_, col) => widths?.[col] ?? 125),
    // Fixed widths (never auto-fit) — the PDF renderer honors `columnWidths`
    // and scales the whole grid to fit the page, so predictable is better.
    columnAutoFit: Array.from({ length: columnCount }, () => false),
    rowHeights: Array.from({ length: normalized.length }, () => 30),
    merges,
  };
}

const header = (value: string) => cell(value, { bold: true, backgroundColor: "#2d3449", fontColor: "#ffffff", horizontalAlign: "left" });
const group = (value: string) => cell(value, { bold: true, backgroundColor: "#dbeafe", fontColor: "#172554" });
const total = (value: string) => cell(value, { bold: true, backgroundColor: "#e6e6e6", fontColor: "#141414" });

function config(
  rows: Array<Array<string | TemplateGridCell>>,
  options: Partial<PaymentPdfTemplateConfig> & { gridMerges?: TemplateGridMerge[]; gridRowHeights?: number[] } = {},
): PaymentPdfTemplateConfig {
  const { gridMerges = [], gridRowHeights, ...templateOptions } = options;
  const templateGrid = grid(rows, undefined, gridMerges);
  if (gridRowHeights) {
    templateGrid.rowHeights = templateGrid.rowHeights.map((height, index) => gridRowHeights[index] ?? height);
  }
  return {
    grid: templateGrid,
    detailRowIndex: 1,
    groupBy: [],
    groupHeader: null,
    separator: null,
    subtotal: null,
    orientation: "landscape",
    ...templateOptions,
  };
}

export const PAYMENT_PDF_TEMPLATE_EXAMPLES: PaymentPdfTemplateExample[] = [
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
    description: "Lista simples com cabeçalho escuro, alinhamento à direita no valor e página em retrato.",
    result: ["EMPRESA | CLIENTE | COLABORADOR | LOCAL | DATA | VALOR", "Empresa A | Cliente X | Crislan | Loja 12 | 02/08 | R$ 80,00"],
    config: config([
      [header("EMPRESA"), header("CLIENTE"), header("COLABORADOR"), header("LOCAL"), header("DATA"), header("VALOR")],
      ["{{companyName}}", "{{clientName}}", "{{employeeName}}", "{{local}}", "{{workDate}}", cell("{{valor}}", { horizontalAlign: "right" })],
    ], { orientation: "portrait" }),
  },
  {
    id: "employee_header",
    category: "Cabeçalhos de bloco",
    title: "Blocos por colaborador",
    description: "Cada colaborador ganha um cabeçalho com nome, total de turnos e soma antes das suas linhas.",
    result: ["Crislan — 4 turno(s) — R$ 320,00", "  DATA | FUNÇÃO | HORAS | VALOR", "  02/08 | FLV | 06:00 | R$ 80,00"],
    config: config([
      [header("DATA"), header("FUNÇÃO"), header("HORAS"), header("VALOR")],
      ["{{workDate}}", "{{role}}", "{{workedHours}}", "{{valor}}"],
      [group("{{employeeName}}"), group("{{quantidade}} turno(s)"), group(""), group("{{soma:valor}}")],
    ], { groupBy: ["employeeName"], groupHeader: { enabled: true, rowIndex: 2 } }),
  },
  {
    id: "company_employee",
    category: "Cabeçalhos de bloco",
    title: "Blocos por empresa e colaborador",
    description: "Separar por dois campos cria um bloco para cada combinação, na ordem escolhida.",
    result: ["Empresa A — Crislan", "  DATA | FUNÇÃO | VALOR", "Empresa A — Wellinton", "  DATA | FUNÇÃO | VALOR"],
    config: config([
      [header("DATA"), header("FUNÇÃO"), header("VALOR")],
      ["{{workDate}}", "{{role}}", "{{valor}}"],
      [group("{{companyName}} — {{employeeName}}"), group(""), group("")],
    ], { groupBy: ["companyName", "employeeName"], groupHeader: { enabled: true, rowIndex: 2 } }),
  },
  {
    id: "employee_subtotal",
    category: "Subtotais",
    title: "Detalhes com soma por colaborador",
    description: "Mantém todos os turnos e imprime uma linha de SOMA após o bloco de cada colaborador.",
    result: ["Crislan — turno 1", "Crislan — turno 2", "TOTAL | 12:00 | R$ 160,00", "Wellinton — turno 1"],
    config: config([
      [header("COLABORADOR"), header("DATA"), header("HORAS"), header("VALOR")],
      ["{{employeeName}}", "{{workDate}}", "{{workedHours}}", "{{valor}}"],
      ["", total("TOTAL"), total("{{soma:workedHours}}"), total("{{soma:valor}}")],
    ], { groupBy: ["employeeName"], subtotal: { enabled: true, rowIndex: 2 } }),
  },
  {
    id: "grand_total",
    category: "Subtotais",
    title: "Lista com total geral",
    description: "Sem separar por nenhum campo, uma única SOMA fecha tudo no fim do PDF.",
    result: ["todos os turnos...", "TOTAL GERAL | 120:00 | R$ 2.450,00"],
    config: config([
      [header("COLABORADOR"), header("DATA"), header("FUNÇÃO"), header("HORAS"), header("VALOR")],
      ["{{employeeName}}", "{{workDate}}", "{{role}}", "{{workedHours}}", "{{valor}}"],
      ["", "", total("TOTAL GERAL"), total("{{soma:workedHours}}"), total("{{soma:valor}}")],
    ], { groupBy: [], subtotal: { enabled: true, rowIndex: 2 } }),
  },
  {
    id: "group_summary",
    category: "Operadores de resumo",
    title: "Resumo no topo de cada bloco",
    description: "Demonstra Lista, Quantidade e Somas num cabeçalho de bloco: cada colaborador abre com funções, status e total, e os turnos seguem listados abaixo.",
    result: ["CRISLAN | FLV, Mercearia | Pendente, Pago | 4 turnos | R$ 320,00", "  02/08 | FLV | R$ 80,00"],
    config: config([
      [header("COLABORADOR"), header("FUNÇÕES"), header("STATUS"), header("TURNOS"), header("TOTAL")],
      ["{{employeeName}}", "{{role}}", "{{status}}", "{{valor}}", "{{valor}}"],
      [group("{{employeeName}}"), group("{{lista:role}}"), group("{{lista:status}}"), group("{{quantidade}}"), group("{{soma:valor}}")],
    ], { groupBy: ["employeeName"], groupHeader: { enabled: true, rowIndex: 2 } }),
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
    ], { groupBy: ["employeeName"], separator: { enabled: true, rowIndex: 2 } }),
  },
  {
    id: "standard_report",
    category: "Relatórios fixos",
    title: "Relatório por valor",
    description: "Tabela completa com cabeçalho escuro, agrupada por colaborador, com subtotal de horas e valor por pessoa.",
    result: ["RELATÓRIO DE PAGAMENTOS", "Gerado em 13 de setembro de 2026 às 14:11", "LOCAL | DATA | FUNÇÃO | QTD/H | HORÁRIO | VALOR | NOME | STATUS", "Loja 12 | 02/08 | FLV | 06:00 | 07:00 às 13:00 | R$ 78,50 | Crislan | Pendente", "Total | 20:00 | R$ 250,00"],
    config: config([
      [cell("Relatório de pagamentos", { fontSize: 14 })],
      [cell("Gerado em {{generatedAt}}", { fontSize: 9, fontColor: "#787878" })],
      [header("LOCAL"), header("DATA"), header("FUNÇÃO"), header("QTD/H"), header("HORÁRIO"), header("VALOR"), header("NOME"), header("STATUS")],
      ["{{local}}", "{{workDate}}", "{{role}}", "{{workedHours}}", "{{horario}}", cell("{{valor}}"), "{{employeeName}}", "{{status}}"],
      [total(""), total(""), total("Total"), total("{{soma:workedHours}}"), total(""), total("{{soma:valor}}"), total(""), total("")],
    ], { detailRowIndex: 3, groupBy: ["workDate"], subtotal: { enabled: true, rowIndex: 4 }, orientation: "landscape", gridMerges: [{ row: 0, col: 0, rowSpan: 1, colSpan: 8 }, { row: 1, col: 0, rowSpan: 1, colSpan: 8 }], gridRowHeights: [24, 18, 24, 24, 24] }),
  },
  {
    id: "shift_report",
    category: "Relatórios fixos",
    title: "Relatório por turno",
    description: "Lista cada turno individualmente, agrupando por dia e mostrando a quantidade de turnos e a soma dos valores de cada grupo.",
    result: ["RELATÓRIO DE TURNOS", "Gerado em 13 de setembro de 2026 às 14:11", "LOCAL | DATA | FUNÇÃO | HORAS | HORÁRIO | VALOR | NOME | STATUS", "02/Ago/2026 | 2 turnos | R$ 196,75", "Loja 12 | 02/Ago | FLV | 06:00 | 07:00 às 13:00 | R$ 78,50 | Crislan | Pendente"],
    config: config([
      [cell("Relatório de turnos", { fontSize: 14 })],
      [cell("Gerado em {{generatedAt}}", { fontSize: 9, fontColor: "#787878" })],
      [header("LOCAL"), header("DATA"), header("FUNÇÃO"), header("HORAS"), header("HORÁRIO"), header("VALOR"), header("NOME"), header("STATUS")],
      ["{{local}}", "{{workDate}}", "{{role}}", "{{workedHours}}", "{{horario}}", cell("{{valor}}"), "{{employeeName}}", "{{status}}"],
      [total("{{workDate}}"), total("{{quantidade}} turno(s)"), total(""), total(""), total(""), total("{{soma:valor}}"), total(""), total("")],
    ], { detailRowIndex: 3, groupBy: ["workDate"], groupHeader: { enabled: true, rowIndex: 4 }, orientation: "landscape", gridMerges: [{ row: 0, col: 0, rowSpan: 1, colSpan: 8 }, { row: 1, col: 0, rowSpan: 1, colSpan: 8 }], gridRowHeights: [24, 18, 24, 24, 24] }),
  },
];
