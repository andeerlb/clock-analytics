import type { PaymentPdfTemplateConfig, TemplateGridCell, TemplateGridData } from "./types";

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
    // Fixed widths (never auto-fit) — the PDF renderer honors `columnWidths`
    // and scales the whole grid to fit the page, so predictable is better.
    columnAutoFit: Array.from({ length: columnCount }, () => false),
    rowHeights: Array.from({ length: normalized.length }, () => 30),
    merges: [],
  };
}

const header = (value: string) => cell(value, { bold: true, backgroundColor: "#1e293b", fontColor: "#ffffff", horizontalAlign: "center" });
const group = (value: string) => cell(value, { bold: true, backgroundColor: "#dbeafe", fontColor: "#172554" });
const total = (value: string) => cell(value, { bold: true, backgroundColor: "#e5e7eb", fontColor: "#111827" });

function config(
  rows: Array<Array<string | TemplateGridCell>>,
  options: Partial<PaymentPdfTemplateConfig> = {},
): PaymentPdfTemplateConfig {
  return {
    grid: grid(rows),
    detailRowIndex: 1,
    groupBy: [],
    groupHeader: null,
    separator: null,
    subtotal: null,
    orientation: "landscape",
    ...options,
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
];
