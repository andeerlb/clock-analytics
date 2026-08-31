import { BookOpen, LayoutTemplate } from "lucide-react";
import { useMemo, useState } from "react";
import { PAYMENT_EXPORT_TEMPLATE_EXAMPLES, type PaymentExportTemplateExample } from "../lib/paymentExportTemplateExamples";
import Drawer from "./Drawer";

type HelpTab = "topics" | "examples";

const TOPICS = [
  { title: "1. Como o template vira uma planilha", body: "O editor é um molde. Textos comuns permanecem iguais; campos como {{employeeName}} são substituídos pelos dados reais. Cores, fontes, bordas, alinhamento, dimensões e mesclagens também são levados ao Excel.", tip: "Comece com títulos e uma Linha do Turno. Acrescente grupos e totais depois que a lista básica estiver clara.", examples: ["simple", "styled"] },
  { title: "2. Campos disponíveis", body: "Use Célula → Inserir campo para escolher Empresa, Cliente, Local, Data, Função, Horário, Horas trabalhadas, Diurno/Noturno, Valor, Status ou Colaborador. Data, horas e valor são gravados como tipos reais do Excel.", tip: "Um campo sozinho mantém seu tipo real. Misturado com texto, como “Data: {{workDate}}”, ele vira texto de apresentação.", examples: ["simple", "styled"] },
  { title: "3. Linha do Turno (T)", body: "É a linha repetida uma vez para cada turno exportado. Clique com o botão direito no número e marque Linha do Turno. Só pode existir uma linha T e ela não pode acumular outro papel.", tip: "Assim como o PDF, o Excel ignora turnos sem valor calculado e turnos com valor exatamente zero.", examples: ["simple", "styled"] },
  { title: "4. Separar por", body: "Organiza os registros e define onde um bloco termina. Separar por Colaborador mantém os turnos da pessoa juntos. Empresa + Colaborador cria um bloco para cada combinação; a ordem define a prioridade.", tip: "Separar não cria sozinho uma linha visual. Use G, S, Σ ou grupos recolhíveis para tornar os limites visíveis.", examples: ["employee_header", "company_employee"] },
  { title: "5. Cabeçalho do Bloco (G)", body: "É escrito uma vez antes de cada bloco sem substituir os turnos. Pode mostrar campos do grupo, quantidade e outros resumos. Marque a linha pelo número e use Inserir resumo do bloco nas células.", tip: "Exemplo: Empresa, Colaborador e Quantidade no cabeçalho; Data, Função, Horas e Valor nas linhas T.", examples: ["employee_header", "company_employee"] },
  { title: "6. Agrupamento recolhível", body: "Cria os controles nativos + e − do Excel. Ative em Mais ações → Grupos. Iniciar recolhido abre o arquivo com detalhes escondidos; desativado abre mostrando tudo. Os dados e cálculos não mudam.", tip: "Use uma linha G ou Σ visível para identificar o grupo enquanto as linhas T estiverem recolhidas.", examples: ["collapsible", "collapsed"] },
  { title: "7. Linha Consolidada (C)", body: "Substitui todas as linhas T do bloco por uma única linha-resumo. É ideal para uma linha por colaborador, empresa ou combinação. A linha T ainda define os campos-base, mas não aparece.", tip: "Não marque C quando quiser ver turnos individuais. Cabeçalho G e consolidada C são recursos diferentes.", examples: ["employee_summary", "company_employee_summary", "unique_lists"] },
  { title: "8. Operadores de resumo", body: "Quantidade conta turnos. Soma totaliza Valor ou Horas. Lista reúne valores diferentes sem repetir. Primeiro e Último usam as extremidades do bloco, úteis para início e fim do período. Aparecem nas linhas G ou C.", tip: "Use Lista quando um campo varia. Use o campo direto quando ele é constante dentro do bloco.", examples: ["company_employee_summary", "unique_lists"] },
  { title: "9. Linha de SOMA (Σ)", body: "É escrita depois do conjunto totalizado. Na coluna Valor ou Horas, escolha a soma. Calcular subtotal por é independente de Separar por: detalhes podem ser separados por colaborador e totalizados por empresa.", tip: "Sem campo no agrupamento do subtotal, será gerado um único total geral no final.", examples: ["company_employee", "company_subtotal", "grand_total"] },
  { title: "10. Linha Separadora (S)", body: "Insere uma linha entre blocos. Não calcula e não identifica o grupo; serve para espaço, cor, borda ou texto fixo. O estilo desenhado nela é repetido em cada separação.", tip: "Use com moderação: cabeçalhos e subtotais geralmente já criam divisão visual.", examples: ["visual_separator", "employee_header"] },
  { title: "11. Formatação e estrutura", body: "Selecione células para aplicar fonte, cores, alinhamento e bordas. Mesclar funciona como numa planilha. Arraste cabeçalhos para dimensões ou use Ajustar ao maior registro. Os menus das letras e números inserem e excluem.", tip: "Automático funciona melhor para nomes; tamanho fixo mantém layouts compactos e previsíveis.", examples: ["styled", "company_employee"] },
  { title: "12. Como escolher", body: "Lista operacional: T. Lista organizada: T + Separar. Relatório detalhado: G + T + Σ. Navegável: G + T + recolhimento. Gerencial: C com Quantidade e Somas. Você pode aplicar um exemplo e adaptar.", tip: "Aplicar um exemplo substitui todo o layout, mas não altera o nome do template até você salvar.", examples: ["simple", "collapsible", "employee_summary"] },
] as const;

export default function PaymentExportTemplateHelpDrawer({ open, onClose, onApplyExample }: { open: boolean; onClose: () => void; onApplyExample: (example: PaymentExportTemplateExample) => void }) {
  const [tab, setTab] = useState<HelpTab>("topics");
  const [category, setCategory] = useState("Todos");
  const categories = useMemo(() => ["Todos", ...new Set(PAYMENT_EXPORT_TEMPLATE_EXAMPLES.map((example) => example.category))], []);
  const visible = category === "Todos" ? PAYMENT_EXPORT_TEMPLATE_EXAMPLES : PAYMENT_EXPORT_TEMPLATE_EXAMPLES.filter((example) => example.category === category);

  function exampleLink(id: string) {
    const example = PAYMENT_EXPORT_TEMPLATE_EXAMPLES.find((item) => item.id === id);
    if (!example) return null;
    return <button key={id} type="button" className="secondary" onClick={() => { setCategory(example.category); setTab("examples"); }} style={{ padding: "0.3rem 0.55rem", fontSize: "0.78rem" }}>Ver: {example.title}</button>;
  }

  return <Drawer open={open} onClose={onClose} title="Ajuda para templates de Excel" width="min(780px, 95vw)">
    <div style={{ display: "flex", gap: "0.4rem", marginBottom: "1rem" }}>
      <button type="button" className={tab === "topics" ? "" : "secondary"} onClick={() => setTab("topics")}><BookOpen size={14} /> Consultar tópicos</button>
      <button type="button" className={tab === "examples" ? "" : "secondary"} onClick={() => setTab("examples")}><LayoutTemplate size={14} /> Usar um exemplo</button>
    </div>

    {tab === "topics" && <div>
      <div style={{ padding: "0.85rem", background: "var(--accent-soft)", borderLeft: "3px solid var(--accent)", borderRadius: 6, marginBottom: "1rem", lineHeight: 1.5 }}>Você não precisa aprender tudo antes de começar. Abra um assunto e veja os exemplos relacionados.</div>
      {TOPICS.map((topic, index) => <details key={topic.title} className="card" open={index === 0} style={{ padding: "0.8rem 0.95rem", marginBottom: "0.65rem" }}>
        <summary style={{ cursor: "pointer", fontWeight: 650 }}>{topic.title}</summary>
        <p style={{ margin: "0.8rem 0 0.6rem", lineHeight: 1.65 }}>{topic.body}</p>
        <div style={{ padding: "0.65rem", background: "var(--sidebar-bg)", borderRadius: 6, color: "var(--text-muted)", lineHeight: 1.5 }}><strong>Dica:</strong> {topic.tip}</div>
        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.7rem" }}>{topic.examples.map(exampleLink)}</div>
      </details>)}
    </div>}

    {tab === "examples" && <div>
      <p className="muted" style={{ lineHeight: 1.5 }}>Escolha um modelo completo para montar automaticamente a planilha. Depois, edite qualquer célula normalmente.</p>
      <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", marginBottom: "1rem" }}>{categories.map((item) => <button key={item} type="button" className={category === item ? "" : "secondary"} onClick={() => setCategory(item)} style={{ padding: "0.3rem 0.55rem", fontSize: "0.78rem" }}>{item}</button>)}</div>
      {visible.map((example) => <div key={example.id} className="card" style={{ padding: "0.95rem", marginBottom: "0.8rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "flex-start" }}>
          <div><strong>{example.title}</strong><p className="muted" style={{ margin: "0.35rem 0 0.7rem", lineHeight: 1.5 }}>{example.description}</p></div>
          <button type="button" onClick={() => onApplyExample(example)} style={{ flexShrink: 0 }}>Usar este exemplo</button>
        </div>
        <div style={{ background: "var(--sidebar-bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "0.65rem", fontFamily: "monospace", fontSize: "0.76rem", overflowX: "auto" }}>{example.result.map((line, index) => <div key={index} style={{ whiteSpace: "pre" }}>{line}</div>)}</div>
      </div>)}
    </div>}
  </Drawer>;
}
