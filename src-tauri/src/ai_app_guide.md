# Guia do PontoScan

O PontoScan é um aplicativo de computador para importar espelhos de ponto (PDF) e planilhas de pagamento de turnos, conferir e registrar pagamentos. Tudo fica guardado localmente neste computador. Os textos entre aspas são os rótulos exatos da tela.

## Navegação

Barra lateral, de cima para baixo: "Importar", "Empresas", "Clientes", "Colaboradores", "Funções", "Cartão Ponto", "Pagamentos", "Análises". No rodapé da barra: "Verificação automática" e "Configurações".

O ícone de "Verificação automática" tem uma bolinha de status (passe o mouse para ver o texto): "Verificando agora", "Falha na verificação", "Atualização encontrada", "Configuradas" ou "Nenhuma configurada".

Ordem recomendada na primeira vez: cadastrar "Empresas", depois "Clientes" (precisam de uma empresa), depois "Colaboradores" e "Funções". Depois disso, importar.

Termos usados no app:
- Turno: uma linha de pagamento (colaborador, data, local, função, horário, valor, status).
- Status do turno: "Pendente", "Erro" ou "Pago".
- Competência: o mês de um turno, usado no agrupamento em "Pagamentos".
- Template: a configuração que diz como ler (importação) ou como gerar (exportação) um arquivo.

## Importar

Caminho: "Importar". A tela "Importar dados" oferece três opções: "Espelho de ponto" (PDF), "Pagamentos" (CSV, Excel ou ODS) e "Colaboradores" (CSV, Excel ou ODS).

## Importar espelhos de ponto (PDF)

Caminho: "Importar" → "Espelho de ponto".

1. Escolha "Cliente". Se não houver nenhum, é preciso cadastrar antes em "Clientes". Os colaboradores importados ficam vinculados a ele.
2. "Empresa" é preenchida sozinha se o cliente tiver só uma; se tiver mais de uma, escolha.
3. "Provedor" é o sistema de ponto que gerou o PDF. Hoje só o formato Coalize é suportado.
4. Adicione os PDFs: arraste para a área, ou use "Procurar arquivos" (arquivos individuais ou "Pasta inteira"). Um PDF pode conter vários colaboradores, um por página.
5. Clique em "Processar N PDF(s)".
6. Em "Pré-visualização da Importação", revise, marque o que quer salvar e clique em "Salvar".

Status na pré-visualização:
- "Novo": vem marcado.
- "Sobrescrever": o colaborador já tem dados importados que conflitam com esse período. Vem desmarcado; se marcar e salvar, substitui o registro anterior.
- "CNPJ diferente do cliente selecionado": o CNPJ do PDF não bate com o cliente escolhido. Vem desmarcado, para evitar atribuir o ponto ao cliente errado.
- "Erro no arquivo": aquele PDF falhou, mas os demais do lote continuam.

Arquivo já importado: o app reconhece pelo conteúdo do arquivo, não pelo nome nem pela pasta. Renomear o PDF não engana a verificação. Ele aparece como "Já importado" e fica de fora; para processar de novo clique em "Reprocessar" (fica "Será reprocessado"; "Cancelar" desfaz).

PDFs protegidos por senha não funcionam. Uma cópia do PDF original fica guardada neste computador.

"Histórico" (canto superior) abre "Histórico de importações", com busca por nome do arquivo e selos "Sucesso", "Com alertas" ou "Falha", mais a mensagem do problema. É onde se veem os arquivos com erro. O registro só é criado ao clicar em "Salvar", e inclui todos os arquivos daquele lote, até os que falharam. Se o processamento for cancelado, nada entra no histórico.

## Cartão Ponto

Caminho: "Cartão Ponto". Lista os espelhos importados, com colaborador, empresa, período e data de importação.

- "Filtros": "Colaborador", "Período" (começa no mês atual), "Status no período", "Empresa", "Cliente". "Aplicar filtros" confirma; "Limpar filtros" zera e aplica na hora.
- Botão "PDF": abre o PDF daquele colaborador, com opções "Baixar" e "Ver no explorador de arquivos".
- "Gerar zip": cria um zip com os PDFs de todos os registros que batem com os filtros (não só da página), em pastas por empresa e cliente. O seletor ao lado define "Um PDF por colaborador" ou "Um PDF por cliente" (junta todos num consolidado). Registros sem cliente vinculado ficam de fora.
- Clicar no nome do colaborador abre o "Cartão de Ponto" detalhado.

Detalhe do cartão: totais ("Total Trabalhado", "Horas Extras", "Faltas", "Atrasos", "Saldo do Banco") e uma linha por dia do período, com colunas de entrada e saída. O filtro de dias ("Sem marcação", "Marcação pendente", "Marcação completa", "Horas extras", "Horas faltas", "Horas de atraso", "Horas regulares", "Finais de semana", "Com intervalo") só muda o que é exibido; os totais não mudam. Com alguma opção desmarcada, aparecem os dias que atendem a pelo menos uma das marcadas. "Ver arquivo" abre o PDF (a dica da tela de importação chama isso de "Ver relatório original").

## Importar pagamentos (planilhas)

Caminho: "Importar" → "Pagamentos". É preciso ter um template cadastrado ("Gerenciar templates").

1. "Template": define como ler as colunas e qual empresa/cliente cada linha recebe. Não há escolha de cliente nesta tela; isso vem das regras do template, linha a linha.
2. "Período (opcional)": considera só as linhas cuja data está no intervalo. As de fora nem aparecem. Em branco, o app pede confirmação ("Processar sem filtro de período" → "Processar arquivo inteiro").
3. "Manter registros atualizados manualmente": vem ligado. Veja abaixo.
4. "Arquivos de pagamento": "Arquivo local" (formatos aceitos pelo template; "Procurar arquivos") ou "URL". Só dá para alternar depois de remover os arquivos já escolhidos.
5. "Processar N arquivo(s)", revisar a pré-visualização, "Salvar (N)".

Importar por URL: só .xlsx, .xls ou .ods, com link de download direto e anônimo (sem login). O formato baixado precisa ser aceito pelo template. A caixa "Salvar em Verificação automática" (desligada por padrão, só no modo URL) guarda o link na tela "Verificação automática" ao salvar. Sem ela, o link não fica guardado.

"Histórico" mostra os arquivos de pagamento já importados, e os erros; "Gerenciar templates" leva a "Templates de pagamento".

### Pré-visualização de pagamentos

Só as linhas "Novo" vêm marcadas. Os contadores no topo também são filtros (clique para filtrar; clique de novo para limpar). "Selecionar todos" age só sobre as linhas visíveis no filtro atual.

- "Novo": colaborador encontrado e nenhum turno igual já salvo.
- "Já importado": todas as colunas batem com um turno salvo. Marque se quiser reprocessar (fica "Será reprocessado").
- "Pago — mantido": o turno já foi pago. Não pode ser marcado, em nenhuma hipótese.
- "Editado manualmente — mantido" ou "Dados alterados manualmente — mantido": protegido enquanto "Manter registros atualizados manualmente" estiver ligado.
- "Excluído anteriormente": o turno foi removido em "Pagamentos". Vem desmarcado; se marcar, fica "Será restaurado".
- "Duplicado no arquivo": linha idêntica a outra do mesmo arquivo. Só a primeira é importável.
- "Colaborador não encontrado": não bate com nenhum colaborador daquele cliente e empresa. Opções na linha: "Vincular" (escolher o colaborador certo; o nome da planilha vira um "Possíveis nomes" dele e todas as linhas com esse mesmo nome são resolvidas), "Cadastrar colaborador" (abre o formulário já preenchido; ao voltar, a pré-visualização continua onde estava). Se a pessoa já existe em outro cliente ou empresa, aparece também "Vincular [Nome] a [Cliente] ([Empresa])".
- "Função não encontrada": o texto da função não bate com o cadastro nem com apelidos daquela empresa. Não pode ser importada até usar "Vincular" (vira apelido da função) ou "Cadastrar função".
- "Empresa/cliente não definido": nenhuma regra do template atendeu a linha. Use "Editar regras do template".
- "Data não reconhecida" (contador "linha(s) ignorada(s)"): a coluna de data não pôde ser lida. São consideradas título, cabeçalho ou rodapé.

Ao vincular alguém de outro cliente/empresa, a confirmação oferece "Vincular o histórico já importado também". Desligado, só as próximas importações usam o novo vínculo. Ligado, move o histórico (Pagamentos e Cartão Ponto) para esse cliente/empresa: só o que estiver no período escolhido, ou todo o histórico se não houver período.

Em importação por URL, pode aparecer o aviso "N turno(s) que estavam neste arquivo não aparecem mais nesta leitura": turnos importados antes dessa fonte que nenhuma linha atual cobre. Use "Marcar como excluído" nos que realmente saíram.

## Templates de pagamento

Caminho: "Importar" → "Pagamentos" → "Gerenciar templates"; depois "Novo template" (ou "Editar"/"Excluir" na lista). Excluir um template não apaga turnos já importados. O cadastro é feito em etapas, com "Avançar"/"Voltar", e termina em "Salvar".

1. Arquivo de exemplo: envie um arquivo ou use "Ou baixar por URL". Ele só serve para montar o mapeamento agora e não é guardado.
2. Mapeamento: para cada coluna, escolha o campo ("CPF", "Matrícula", "Nome", "Local de trabalho", "Data", "Função", "Horário", "Status") ou deixe "Ignorar". Colunas ignoradas continuam guardadas para consulta na coluna "Extras" de "Pagamentos". Em arquivos com várias abas, selecione as abas usadas; "Espelhar mapeamento" reaproveita o mapeamento de outra aba de mesma estrutura. "Delimitador" vale para CSV.
3. Configurações e regras:
   - "Nome do template", "Formato de data" e "Formatos aceitos" (CSV não pode ser combinado com planilhas).
   - "Filtro de linha válida": uma linha só é válida se a coluna de data puder ser lida no formato configurado.
   - "Prioridade de identificação": tentativas em ordem para achar o colaborador (por exemplo CPF, depois matrícula, depois nome). Cada tentativa é um conjunto de campos que precisam bater juntos; a primeira que achar vence. Há "Ignorar maiúsculas/minúsculas". Pelo menos uma é obrigatória.
   - "Regras de roteamento (Empresa/Cliente)": a partir do valor de um campo ou da aba ("Aba (guia dentro do arquivo)"), define a empresa e o cliente da linha. Em ordem, a primeira que bater vence; "Adicionar "senão"" cobre o resto. Pelo menos uma é obrigatória.
   - "Regras de status": define o status inicial do turno (ex.: coluna com "PAGO"). Opcional; sem regra ou sem correspondência, o turno entra como "Pendente".

## Verificação automática

Caminho: item "Verificação automática" na barra lateral. Acompanha planilhas importadas por URL e guardadas com "Salvar em Verificação automática". "Novo Arquivo" leva a "Importar pagamentos". "Forçar verificação de todas" verifica tudo agora, ignorando os intervalos.

Cada arquivo mostra "Ativo", "Pausado" ou "Sem config.". "REMOVER RASTREAMENTO" apaga o rastreamento, as configurações e o histórico de verificações daquele arquivo; os turnos já importados não são afetados.

Um arquivo pode ter várias configurações ("Adicionar configuração"), cada uma com agenda própria:
- "Template": escolhido ao criar; para trocar, remova e crie de novo.
- "Intervalo (min)": de quanto em quanto tempo verificar. Mínimo 1; o padrão é 5.
- "Modo": "Fixo" usa um "Período Selecionado"; "Relativo a hoje" usa "Início (dias atrás)" e "Fim (dias atrás)". "Período efetivo aplicável" mostra o resultado.
- "Atualizar registros automaticamente": desligado, a verificação só avisa e nada muda nos turnos. Ligado, as mudanças encontradas são aplicadas direto, sem revisão.
- "Sobrescrever edições manuais" e "Sobrescrever turnos já pagos": só valem com a opção acima ligada. Dizem se a aplicação automática pode alterar turnos corrigidos à mão ou já pagos. Numa configuração nova, a primeira vem ligada e a segunda desligada.
- "Manter registros atualizados manualmente": usada quando a reimportação passa pela tela de importação ("Reprocessar agora"), com o mesmo efeito da opção de lá.

Botões: "Salvar configurações", "Reprocessar agora" (abre "Importar pagamentos" já preenchido e processa, mesmo sem mudança detectada), "Forçar verificação" (só esta configuração), "Ativar"/"Desativar", "Remover".

"HISTÓRICO RECENTE" mostra barras das últimas verificações; clique em uma para ver os detalhes, ou em "Ver histórico completo". Resultados: "Mudou", "Sem mudança", "Indeterminado", "Erro".

As verificações só acontecem com o app aberto; para mantê-las com a janela fechada, ligue "Minimizar na bandeja ao fechar". Quando uma mudança real é encontrada e a janela não está em foco, o sistema mostra uma notificação (se a permissão foi concedida).

## Atualizações pendentes

Quando a verificação encontra algo, aparece um cartão flutuante "N atualização(ões) pendente(s)". Clique para abrir o painel "Atualizações pendentes", ou arraste para mudar de lugar. O cartão não aparece na própria tela "Verificação automática", que tem os mesmos detalhes por verificação. O painel se divide em "Pendentes" e "Aplicadas automaticamente", agrupado por arquivo e configuração.

Tipos de aviso:
- Campos alterados (antes → depois): "Aceitar e atualizar" baixa o arquivo de novo e aplica a mudança naquele turno. Aceitar é uma decisão manual: vale mesmo para turno editado à mão ou já pago.
- "Possível novo turno": linha nova na planilha. Use "Reprocessar agora" para importar. Com atualização automática aparece "Criado automaticamente".
- Colaborador ou empresa/cliente não identificado: a linha tem data válida, mas não foi associada a ninguém. Ajuste o cadastro ou os apelidos e reprocesse.
- Turno não encontrado na leitura mais recente: pode ter saído da planilha. "Marcar como excluído" remove o turno. Com atualização automática aparece "Excluído automaticamente".
- Erro: falha ao baixar ou ler o arquivo, ou template removido.

"Visto" (também "Visto neste grupo" e "Visto em todos") apenas reconhece o aviso, sem resolver nada: ele deixa de contar no cartão, mas continua consultável. Se uma verificação futura encontrar exatamente a mesma coisa, ela continua silenciosa; se algo mudar, é um aviso novo. "Reprocessar agora" também marca como visto.

## Pagamentos

Caminho: "Pagamentos". Lista os turnos importados.

- "Filtros": "Colaborador", "Período", "Empresa", "Cliente", "Função", "Local", "Horário", "Diurno/Noturno", "Status" e, em "Exibição", "Agrupar por colaborador". Agrupado, cada linha é um colaborador em uma competência; clique para expandir os turnos.
- Seletor de colunas ("Configurar colunas"): "Colaborador", "Cliente", "Empresa", "Data", "Local", "Função", "Horário", "H/trab.", "Valor", "Status", "Importado em", "Extras". A escolha fica salva.
- "Extras": mostra as "Colunas não mapeadas" e também arquivo, aba e linha de origem. Um escudo indica turno atualizado manualmente.

As ações do turno ficam no clique com o botão direito na linha: "Fazer pagamento" (Pendente ou Erro), "Voltar para pendente" (Pago), "Ver histórico", "Remover turno", e "Ver o que mudou" quando uma atualização automática alterou o turno.

Editar um turno: não há botão; clique direto em "Data", "Local", "Função", "Horário" ou "Valor" de um turno "Pendente" ou "Erro". Enter ou clicar fora confirma; Esc cancela. A função precisa estar cadastrada em "Funções". Toda edição fica no histórico e marca o turno como atualizado manualmente. Em "Valor", deixar vazio volta ao cálculo automático pelas regras.

Fazer pagamento: abre "Fazer pagamento" com dados do turno, "Chaves PIX" do colaborador (clique para copiar) e "Valor" sugerido pelas regras, que pode ser alterado e precisa estar preenchido. Se a verificação detectou mudança, aparece o aviso "Mudança encontrada na fonte desde a importação". "Confirmar pagamento" registra o turno como "Pago"; o app não faz a transferência, só registra.

"Voltar para pendente": cria um novo registro "Pendente"; o registro pago permanece no histórico.

"Remover turno": some de todas as listas, relatórios e exportações. Veja "Por que o app faz isso" sobre o que acontece se ele for reimportado.

"Ver histórico": mostra os estados anteriores (status, dados, valor), do mais recente ao mais antigo. Fica desabilitado se o turno nunca foi alterado.

Linha amarela: há mudança pendente encontrada pela verificação. Enquanto isso o turno não pode ser editado, pago nem removido; o menu oferece "Revisar alteração" e "Ver histórico". Na revisão aparecem "Campos alterados" e "Aceitar e atualizar", ou "Marcar como excluído". Linha azulada: houve mudança já aplicada automaticamente.

## Conferência de Pagamentos

Caminho: "Pagamentos" → botão "Conferência". Abre em janela própria, para comparar os turnos pagos com o extrato do banco. Começa com os filtros atuais de "Pagamentos"; depois disso, os filtros das duas janelas são independentes, mas os dados se atualizam entre elas. O topo mostra "N pendente(s) de conferência" ou "Tudo conferido".

Ações só em turnos "Pago", pelo clique direito ou teclado (↑/↓ navegar, Enter confirmar, Delete marcar erro, Backspace desfazer):
- "Confirmar": só registra que conferiu; a linha fica verde e o turno não muda.
- "Marcar erro": o extrato não bateu. O turno volta ao status "Erro" e fica novamente editável e pagável em "Pagamentos"; a linha fica vermelha. Conforme os filtros, ele pode sair da lista.
- "Desfazer": volta exatamente ao estado anterior.

## Regras de valor

Caminho: "Empresas" → clique na empresa → "Regras de valor por hora trabalhada". Um cliente pode ter regras próprias em "Clientes" → cliente: se tiver alguma, elas substituem por inteiro as da empresa; sem nenhuma, valem as da empresa.

As regras são avaliadas em ordem e a primeira que bater define o valor:
- "Adicionar regra"; opcionalmente "Condição de coluna" ("Data", "Local", "Função" ou "Horário"). Para os três primeiros, informe um ou mais valores separados por vírgula, sem diferenciar maiúsculas. Para "Horário": "Início antes de", "Início depois de", "Fim antes de", "Fim depois de".
- "Se trabalhou": operador ("Igual a", "Diferente de", "Maior que", "Maior ou igual a", "Menor que", "Menor ou igual a") e duração em horas e minutos.
- "Então [Valor]": o valor em reais.
- "Adicionar "senão"": valor usado se nenhuma regra bater; fica sempre por último.

As regras são opcionais. Sem regra correspondente, ou sem horário no turno, o "Valor" aparece como "—" e pode ser digitado à mão. Sem valor definido, o turno fica fora dos relatórios e exportações.

Como o valor é escolhido: se o turno tem valor gravado (pago ou digitado à mão), vale esse. Caso contrário é calculado na hora pelas regras, então mudar uma regra afeta os turnos não pagos e sem valor manual, e não afeta os pagos.

## Horário noturno

Caminho: "Empresas" → empresa → "Horário noturno": "Início do noturno", "Fim do noturno" e "Considerar noturno quando":
- "Início do turno dentro do intervalo noturno"
- "Fim do turno dentro do intervalo noturno"
- "Início ou fim do turno dentro do intervalo noturno"
- "Qualquer sobreposição do turno com o intervalo noturno"
- "Mais da metade do turno dentro do intervalo noturno"

O cliente usa o da empresa, a menos que "Sobrescrever horário noturno da empresa" esteja ligado no cadastro dele. A classificação alimenta o filtro "Diurno/Noturno", os ícones de lua e sol e os indicadores de "Análises".

## Exportar e relatórios

Todos ficam em "Pagamentos" e consideram os filtros aplicados e todos os turnos que batem com eles, não só a página visível.

- "Exportar": escolha "Excel" ou "PDF" e um template; "Exportar Excel"/"Exportar PDF" gera o arquivo. "Gerenciar templates" abre "Templates de exportação".
- "Relatório por valor" e "Relatório por turno": PDFs de layout fixo, sem template.
- Depois de gerar: "Abrir PDF" e "Abrir no explorador".

Se aparecer "Os turnos encontrados ainda não têm um valor de pagamento definido", é preciso configurar uma regra de valor ou informar o valor em cada turno. Os templates de Excel e PDF também ignoram turnos com valor exatamente zero.

### Templates de exportação

Caminho: "Pagamentos" → "Exportar" → "Gerenciar templates". Há uma seção Excel ("Novo template Excel") e uma PDF ("Novo template PDF"), com "Editar", "Clonar" e "Excluir".

O editor funciona como uma planilha-molde: texto fixo, cores, fontes, bordas, mesclagens e campos com dados reais ("Inserir campo": empresa, cliente, local, data, função, horário, horas, diurno/noturno, valor, status, colaborador). O botão direito no número da linha define o papel dela:
- Linha do Turno (T): repetida uma vez por turno; só pode existir uma.
- Cabeçalho do Bloco (G): escrito antes de cada bloco.
- Linha de SOMA (Σ): totais de valor ou horas.
- Linha Separadora (S): só visual, entre blocos.
- Linha Consolidada (C), só Excel: substitui as linhas do bloco por uma linha-resumo.

"Separar por" define os blocos (por exemplo, por colaborador). Os resumos disponíveis incluem quantidade, soma, lista de valores únicos, primeiro e último registro. No Excel há agrupamento recolhível. No PDF, as linhas acima da Linha do Turno viram o cabeçalho repetido em cada página, e "Orientação da página" oferece "Paisagem" ou "Retrato".

O painel de ajuda do editor tem "Consultar tópicos" e "Usar um exemplo". Aplicar um exemplo troca todo o layout, mas nada é gravado até clicar em "Salvar".

## Empresas

Caminho: "Empresas" → "Nova empresa", ou clique no nome para editar. Campos: "Nome", "CNPJ", "Horário noturno" e "Regras de valor por hora trabalhada". Não há opção de excluir empresa nessa tela.

## Clientes

Caminho: "Clientes" → "Novo cliente", ou clique no nome. Campos: "Empresas vinculadas", "Nome", "CNPJ", e opcionalmente horário noturno e regras de valor próprios. O CNPJ do cliente é único: cadastrar o mesmo CNPJ para outra empresa só vincula o cliente existente a ela. O cliente precisa continuar com pelo menos uma empresa, e não dá para retirar uma empresa que tenha colaboradores desse cliente. Não há opção de excluir cliente nessa tela.

## Colaboradores

Caminho: "Colaboradores" → "Novo colaborador", ou clique no nome. Busca por nome e filtros de empresa e cliente na lista.

- "Nome", "CPF" e "Matrícula (opcional)". O CPF é único no sistema inteiro: a mesma pessoa é um único cadastro, vinculado a vários clientes e empresas.
- "Clientes e empresas vinculados": cada vínculo tem matrícula própria. É preciso manter ao menos um.
- "Chaves PIX": pode haver várias, de tipos "CPF", "CNPJ", "Telefone", "E-mail", "Aleatória" ou "Outro". O tipo é detectado na importação e pode ser corrigido aqui. Elas aparecem para copiar em "Fazer pagamento".
- "Possíveis nomes" (apelidos): outras grafias do nome que podem aparecer nas planilhas. Valem junto com o nome cadastrado na busca durante a importação. Um mesmo nome só pode estar vinculado a um colaborador por vez.
- "Excluir colaborador": permanente, apaga turnos, cartões de ponto, chaves PIX e apelidos. É preciso digitar o nome para confirmar. Se ele já recebeu pagamentos, há um segundo aviso ("Excluir mesmo assim"), e uma cópia do banco é salva antes na pasta `backups/` dos dados do app.

## Funções

Caminho: "Funções" → "Nova função", ou clique no nome. Cada função pertence a uma empresa, que não pode ser trocada depois. "Possíveis nomes" guarda outras grafias lidas da coluna Função (ex.: "Op. de Caixa" para "Caixa"); um nome só pode estar ligado a uma função dentro da mesma empresa. "Excluir função" remove do cadastro: turnos já importados não são apagados, só perdem o vínculo.

## Importar colaboradores

Caminho: "Importar" → "Colaboradores". Escolha "Template", um ou mais "Cliente" e "Empresa", os arquivos e processe. Colaborador sem cadastro é criado; o já encontrado pela "Prioridade de identificação" do template recebe status "Atualizar" e muda só nos campos mapeados. Linhas com CPF repetido no arquivo aparecem como "Duplicado no arquivo". Linhas sem colaborador identificado e sem CPF e nome válidos ficam como ignoradas. "Gerenciar templates" abre "Templates de colaboradores", com cadastro em etapas parecido ao de pagamentos, campos "CPF", "Matrícula", "Nome" e "PIX", e "Linha do cabeçalho" para marcar onde o cabeçalho termina.

## Análises

Caminho: "Análises". Abas: "Visão geral", "Custos e pagamentos", "Jornadas", "Auditoria", "Ocorrências". Tem seletor de "Período", "Filtros", "Configurar cards" (escolhe os cards; "Restaurar padrão") e "Visões favoritas" (salva combinações com nome).

Os totais usam o mesmo valor mostrado em "Pagamentos": turnos pendentes entram pelo valor estimado pelas regras, e turnos sem valor ficam fora do total financeiro. Em "Jornadas" há "Jornadas acima de 12h", "Jornadas abaixo de 4h", "Intervalos abaixo de 11h" e um mapa de calor. "Auditoria" mostra pagamentos aguardando conferência, turnos com erro e turnos sem valor. "Ocorrências" resume os avisos da verificação automática e não depende do período selecionado. Vários cards abrem "Pagamentos" já filtrado, com a faixa "Filtro da análise"; aplicar novos filtros retira esse filtro.

## Configurações

Caminho: "Configurações".

- "Geral" → "Minimizar na bandeja ao fechar": o botão de fechar só esconde a janela, e o app continua rodando no ícone da bandeja, mantendo as verificações automáticas. Clique no ícone ou em "Abrir PontoScan" para voltar; "Sair" encerra de verdade. O ícone muda e o texto dele avisa quando há arquivos com mudança ou erro.
- "Ferramentas de PDF (Poppler)": veja a seção seguinte.
- "Armazenamento": tamanho de "Banco de dados", "Arquivos importados" e "Total". Clique nos dois primeiros para ver o detalhe.
- "Manutenção":
  - "Compactar banco de dados": recupera espaço de registros apagados, sem remover dados.
  - "Remover originais redundantes": apaga o PDF original de lote quando todas as páginas já foram salvas por colaborador.
  - "Abrir pasta de dados": abre a pasta do banco e dos PDFs.
  - "Exportar banco de dados": salva uma cópia completa do banco num arquivo `.db`, sem mudar nada no app.
- "Sobre": versão, "Procurar atualização" e "Ver no GitHub".

### Zona de risco: "Apagar tudo"

Sempre apaga o histórico de importações e todos os PDFs salvos. Antes de apagar, opcionalmente mantém:
- "Manter empresas", "Manter clientes", "Manter colaboradores". Manter colaboradores exige manter clientes e empresas; manter clientes exige manter empresas.
- "Manter turnos de pagamento atualizados manualmente (...)": exige manter colaboradores. Preserva apenas turnos com edição manual de dados. Um turno só pago ou revertido, sem nenhum campo corrigido à mão, não é preservado.
- "Manter templates de pagamento" e "Manter templates de colaboradores": ligadas por padrão.

Backup: "Banco" e "PDFs" (ligados por padrão) geram um zip antes de apagar, e o app pergunta onde salvar. É preciso digitar APAGAR TUDO.

### Zona de risco: "Importar banco de dados"

Substitui todo o banco atual pelo arquivo `.db` escolhido. É preciso digitar SUBSTITUIR BANCO. O arquivo é validado e o app mostra "Banco pronto para restauração", com contagem de 30 segundos até reiniciar; dá para usar "Reiniciar agora" ou "Cancelar importação". Se houver erro, o banco atual é mantido. Depois de reiniciar, o app mostra "Restauração concluída" ou "Restauração não realizada".

## Poppler (ferramentas de PDF)

Importar e exportar PDFs depende de quatro ferramentas: pdfinfo, pdftotext, pdfseparate e pdfunite. Elas não vêm com o app. Se faltar alguma, aparece um aviso no topo com link para "Configurações".

- Linux (Debian/Ubuntu): `sudo apt-get install poppler-utils`.
- macOS: `brew install poppler`.
- Windows: não é suportado atualmente.

Em "Configurações" → "Ferramentas de PDF (Poppler)" cada ferramenta aparece como encontrada ou "não encontrado". Se o app não achar sozinho, informe a pasta em "Pasta dos binários do Poppler (opcional)" (ou "Escolher pasta") e clique em "Salvar e testar".

## Atualizações do app

Ao abrir, o app procura versão nova e, se houver, mostra "Nova versão disponível" com "Atualizar agora" (baixa, instala e reinicia) ou "Depois". Também dá para checar em "Configurações" → "Sobre" → "Procurar atualização". A atualização automática pode falhar em instalações .deb ou .rpm; nesse caso aparece "Abrir no GitHub" para baixar manualmente.

## Por que o app faz isso

**Por que a linha aparece como já importada?** Em pagamentos, dois turnos são "o mesmo" quando colaborador, data, local, função e horário coincidem. O status não entra nessa comparação. Mesmo colaborador, dia e local com outro horário é tratado como outro turno. A checagem é feita linha a linha, tanto dentro do arquivo quanto contra o que já está salvo. Em espelhos de ponto, a checagem é pelo conteúdo do PDF, independentemente do nome do arquivo.

**Por que minha correção manual não foi sobrescrita?** Com "Manter registros atualizados manualmente" ligado, um turno cujos dados foram corrigidos à mão não pode ser reprocessado na importação. Mesmo que a correção tenha mudado data, local, função ou horário, o app reconhece pelo histórico que é o mesmo turno e não cria um segundo. Desligue a opção na tela de importação (ou na configuração, em "Verificação automática") para permitir. A ajuda da tela cita também turnos revertidos, mas "Voltar para pendente" sozinho não protege: só protege se algum campo já tiver sido corrigido à mão.

**Por que não consigo editar um turno pago?** O registro pago é o histórico do que foi realmente pago, então fica congelado: sem edição direta e sem reprocessamento pela importação, independentemente de qualquer opção. Para corrigir, use "Voltar para pendente", edite e pague de novo; o registro pago anterior continua no histórico. As únicas exceções são decisões explícitas: "Aceitar e atualizar" numa mudança detectada, ou "Sobrescrever turnos já pagos" ligado com atualização automática.

**Por que cada ação cria um registro novo?** Pagar, reverter, editar e reprocessar não apagam o estado anterior; criam uma nova versão ligada a ele, e é isso que aparece em "Ver histórico".

**Por que um turno removido voltou a aparecer?** Remover tira o turno de todas as listas, mas o app se lembra que ele existiu. Se o mesmo turno vier numa reimportação, aparece como "Excluído anteriormente" e desmarcado, para você decidir: deixar de fora ou marcar para restaurar ("Será restaurado"). Assim ele não volta sozinho nem é recriado sem aviso.

## Assistente

O ícone redondo no canto inferior direito abre o assistente em um painel fixo ao lado da tela, em qualquer tela. Dentro do campo de pergunta, um rótulo mostra a tela e os filtros usados como base; clicando nele dá para ver os detalhes e escolher "Não usar esta tela", e a pergunta passa a valer para todos os dados. A borda esquerda do painel pode ser arrastada para aumentar ou diminuir a largura. Ele também abre pelo botão direito em um turno de "Pagamentos", na opção "Perguntar à IA". Ele só responde e não altera nenhum dado. Ele funciona sozinho quando o Claude Code está instalado e logado no computador, e o uso entra no limite do plano da pessoa. Sem isso, é preciso cadastrar uma chave de API da Anthropic em "Configurações", no cartão "Assistente com IA", e o uso é cobrado nessa conta.

O app guarda tudo neste computador, mas o assistente é a exceção: para responder, ele consulta o banco e envia os resultados à Anthropic. Nome, CPF, PIX e matrícula dos colaboradores, clientes, empresas e arquivos não são enviados; locais, funções, datas, valores e observações são, com nomes e documentos reconhecidos ocultados. Se um primeiro nome servir para mais de um colaborador, o assistente pergunta quem é antes de enviar. Quando a resposta vem de uma lista que "Pagamentos" ou "Cartão Ponto" conseguem mostrar, aparece um botão abaixo dela que abre a tela já com os filtros aplicados, substituindo os filtros que estavam lá. "Nova conversa" limpa o histórico do chat.
