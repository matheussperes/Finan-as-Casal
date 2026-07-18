# PRD — Painel Finanças do Casal

**Versão:** 1.1 (final — decisões aprovadas)
**Objetivo do ciclo:** deixar o produto pronto para ir ao mercado, com modelo financeiro consistente, visão de patrimônio consolidada, planejamento de projetos de vida e importação automática de extratos.
**Executor previsto:** Claude Code, sprint por sprint.
**Stack de referência:** front vanilla/HTML-CSS-JS, Supabase (banco + auth), Vercel (deploy), GitHub (versionamento).

---

## Como ler este documento

- Cada requisito tem um **ID** (ex: `LAN-01`) para referência direta em código, commit e PR.
- Status: 🆕 Novo · 🔧 Ajuste · ❌ Remoção · ✅ Já está bom (não mexer).
- A seção 2 traz as **decisões arquiteturais aprovadas** — são regra, não sugestão.
- A seção 7 é a **ordem de execução**. Nada num sprint depende de algo que ainda não foi entregue.

---

## 1. Visão geral das mudanças

| Módulo | O que muda | Sprint |
|--------|-----------|--------|
| Lançamentos | Botão duplo, filtros em linha, modal do cartão, ticket de fatura clicável, importação OFX/CSV | 1, 4, 7 |
| Patrimônio | 3 cards (Financeiro / Bens / Dívidas) + telas de detalhe de conta, cartão e investimento | 3, 4 |
| Plano & Orçamento | Categorias editáveis, reserva de emergência vinculada, modelo de investimento dentro da conta | 2 |
| Projetos | Fusão com "eventos patrimoniais futuros", tipos de projeto, seletor de data, projeção de vida | 5 |
| Configurações | Convite do cônjuge por e-mail, conta corrente apenas, remover aba Casal | 1, 6 |

---

## 2. Decisões arquiteturais aprovadas

Estas quatro decisões estão **fechadas** e valem como especificação canônica.

### D1 — Modelo "investimento dentro da conta" ✅ aprovado
Cada conta corrente tem um `saldo_disponivel` e uma ou mais `posições de investimento` (registros-filhos vinculados à conta). Uma transferência para investimento gera **dois lançamentos vinculados**: saída do saldo disponível + entrada na posição de investimento.
**Invariante obrigatória:** para a mesma conta, `saldo_disponivel + total_investido` não muda em uma transferência interna. O patrimônio da conta é sempre `disponível + investido`. A reserva de emergência é apenas uma posição de investimento com etiqueta especial.

### D2 — Financiamentos e bens ✅ aprovado
Financiamento é uma entidade dentro de **Dívidas**, com `valor_total`, `saldo_devedor`, `parcela_mensal`, `taxa`, `prazo`. Ele **gera automaticamente uma saída recorrente (a parcela)** todo mês até a quitação (cálculo Price a partir de valor/taxa/prazo). O bem correspondente entra em **Bens Materiais** com `valor_de_mercado` e pode ser vinculado a um financiamento. **Valor líquido do bem = valor_de_mercado − saldo_devedor do financiamento vinculado.** Nada de ferramenta externa: tudo dentro do painel para não haver digitação dupla.

### D3 — Taxonomia dos projetos ✅ aprovado
Projeto tem um campo único `tipo`:
- **Retirada única** (ex: viagem — R$500k em dez/2040)
- **Despesa recorrente** (ex: filho — +R$3k/mês a partir de jan/2028)
- **Receita recorrente** (ex: renda de aluguel futura)
- **Aporte extra** (ex: 13º direcionado à acumulação)

A classificação "acumulação vs despesa" é **derivada automaticamente** do tipo (retirada única e aporte extra ⇒ acumulação; despesa recorrente ⇒ despesa). Sem campo extra para preencher.

### D4 — Reserva de emergência ✅ aprovado
Cada categoria de despesa ganha um checkbox `essencial`. **Reserva ideal = 6 × soma das despesas essenciais** (o multiplicador 6 é o padrão, editável). A reserva é uma posição de investimento com tipo de lançamento próprio ("Aporte reserva de emergência").

---

## 3. Recomendação técnica sobre financiamentos

Cadastro no próprio painel, em **Dívidas → Financiamentos**, com a parcela virando saída recorrente automática até a quitação, e o bem (carro/casa) amarrado à dívida para o patrimônio líquido ficar honesto (valor de mercado − saldo devedor). Ferramenta externa só criaria digitação dupla e inconsistência entre Patrimônio, Dívidas e fluxo mensal. A parcela é calculada uma única vez na criação do financiamento (fórmula Price) a partir de `valor`, `taxa` e `prazo`.

---

## 4. Especificação por módulo

### 4.1 Lançamentos

**LAN-01 🔧 — Botão duplo Entrada / Saída**
Substituir "+ Novo lançamento" por dois botões: **Entrada** e **Saída**. O clique abre o formulário já no modo correto.
*Aceite:* "Saída" abre o formulário como saída; "Entrada" como entrada, sem passo intermediário.

**LAN-02 🔧 — Ticket de fatura clicável** *(construir junto do PAT-06, Sprint 4)*
Na aba Faturas, o ticket do mês (mês / fatura aberta / total / vencimento) vira clicável e leva à **tela de detalhe do cartão** (PAT-06), com todos os lançamentos da fatura.
*Aceite:* clicar no ticket abre a fatura detalhada do cartão correspondente.

**LAN-03 🔧 — Filtros em linha única**
Busca + Categoria + Entrada/Saída passam de 3 linhas para **1 linha**: busca ocupando ~metade do espaço; Categoria e Entrada/Saída menores, no canto. Aplicar nas **três visualizações**: Meus, Conjunto, Cônjuge.
*Aceite:* os três filtros lado a lado nas três abas, sem quebrar em telas menores.

**LAN-04 🔧 — Corrigir modal do cartão de crédito**
Ao marcar uma saída como cartão de crédito, o modal estoura a tela. Redimensionar para caber com folga (a seleção de tipo agora vem do topo — LAN-01).
*Aceite:* modal cabe na viewport (desktop e mobile), sem overflow nem scroll horizontal.

**LAN-05 🆕 — Importação OFX/CSV** *(Sprint 7)*
Upload de OFX/CSV de conta e cartão. O sistema lê os lançamentos, cadastra e **categoriza**. Categorização aprende com o histórico; quando incerto, **pergunta** em vez de chutar.
*Aceite:* upload gera lançamentos com categoria sugerida; ambíguos entram na fila "Confirmar categoria"; origem já categorizada antes vem preenchida sem perguntar de novo.

---

### 4.2 Patrimônio

Três cards de resumo no topo, cada um expansível para uma lista embaixo (onde hoje ficam as contas fixadas).

**PAT-01 🆕 — Card "Financeiro"**
Mostra `Saldo em contas` (valor + nº de contas) e `Saldo em investimentos` (valor aplicado + nº de contas). Clique expande a lista de contas embaixo.

**PAT-02 🆕 — Expansão do Financeiro**
Cada conta mostra, resumido: saldo disponível, investido dentro dela e fatura de cartão em aberto vinculada. Ex: *Banco X — R$1.000 disponível · R$2.000 investido · R$1.000 fatura*.

**PAT-03 🆕 — Card "Bens Materiais"**
Total em bens (casa, carro etc.). Permite cadastrar bens. Clique expande a lista; cada bem abre seu ticket. Valor líquido conforme D2.

**PAT-04 🆕 — Card "Dívidas"**
Soma de financiamentos + soma das faturas de cartão em aberto. Clique expande: financiamentos e cartões, com drill-down em cada um. Resumo por cartão: total gasto, fatura atual, limite restante.

**PAT-05 🆕 — Tela de detalhe da Conta**
Saldo atual (só o que está na conta corrente), entradas do mês, saídas do mês. Abaixo: cartões vinculados, aba de investimentos (aplicado dentro da conta — fora do saldo atual) e lista de lançamentos.
*Aceite:* saldo atual nunca inclui o investido; investimentos só na sua aba.

**PAT-06 🆕 — Tela de detalhe do Cartão**
Mesma navegação da conta, três abas: `Fatura atual` · `Total gasto / dívida` · `Limite restante`. Abaixo, todos os lançamentos do cartão. Destino do LAN-02.

**PAT-07 🆕 — Tela de detalhe de Investimentos**
Três resumos: `Valor investido` · `Rendimento acumulado` · `Projeção` (valor no vencimento; para ativos sem vencimento, projeção de 12 meses). Abaixo, lista com: nome, tipo (ex: CDB), vencimento, rendimento (% ao mês/ano), valor aplicado e quanto já rendeu.

---

### 4.3 Plano & Orçamento

> Visão principal (renda do mês / gasto planejado / sobra investível) ✅ está boa — não mexer.

**ORC-01 🔧 — Categorias editáveis**
Em "Orçamento por classificação", permitir criar, editar e excluir categorias.
*Aceite:* criar/editar/excluir reflete em lançamentos e relatórios.

**ORC-02 🆕 — Reserva de emergência vinculada** *(D4)*
Checkbox `essencial` nas categorias; reserva ideal = 6 × essenciais (multiplicador editável). Reserva entra como investimento (posição dedicada) com tipo de lançamento próprio.

**ORC-03 🆕 — Transferência para investimento dentro da conta** *(D1 — fundação)*
Saída da conta corrente para investimento: sai do saldo disponível, entra na posição de investimento da mesma conta. Dois lançamentos vinculados; patrimônio da conta = disponível + investido.
*Aceite:* após transferir R$500, saldo disponível −R$500, posição de investimento +R$500, patrimônio total da conta inalterado.

---

### 4.4 Projetos & Independência Financeira

**PRJ-01 🔧❌ — Fundir "Eventos Patrimoniais Futuros" em "Projetos"**
Projetos **são** eventos patrimoniais futuros. Remover a aba/entidade separada de EPF; projetos assumem esse papel.

**PRJ-02 🆕 — Tipos de projeto** *(D3)*
Cada projeto declara o tipo: retirada única, despesa recorrente, receita recorrente ou aporte extra. "Acumulação vs despesa" é derivado.

**PRJ-03 🆕 — Projetos dentro do mesmo pool de independência**
O aporte do projeto **é** aporte de independência (mesmo lugar investido). O sistema calcula o aporte mensal necessário para bater a meta na data-alvo (ex: R$1.824,96/mês para R$500k em dez/2040). Na data-alvo, a retirada sai do montante total. **A aba Independência mostra só o agregado; o detalhe por projeto aparece só na aba Projetos.**
*Aceite:* soma dos aportes mensais dos projetos = parte do aporte total de independência, sem dupla contagem; retirada na data-alvo reduz o montante projetado.

**PRJ-04 🔧 — Seletor de data-alvo**
Campo dinâmico e agradável: escolher mês e ano via calendário limpo (o atual está feio/travado).
*Aceite:* mês/ano em ≤2 cliques, com calendário estilizado.

**PRJ-05 🆕 — Escopo de planejamento de vida**
Projetos cobrem casamento, carro, casa, abertura de empresa, cursos, filho, faculdade — cada um com projeção de quanto é preciso e a partir de quando.

---

### 4.5 Configurações

> Dados pessoais ✅ · Segurança ✅ — não mexer.

**CFG-01 🆕 — Convite do cônjuge por e-mail** *(Sprint 6)*
Campo de e-mail na aba Cônjuge. Ao preencher, envia convite automático; o cônjuge define uma senha e acessa a **mesma plataforma**, com a mesma visão.
*Aceite:* e-mail dispara convite; cônjuge cria senha e vê os mesmos dados; acesso protegido por RLS.

**CFG-02 🔧 — Contas bancárias = só conta corrente**
Remover poupança e investimento como tipos de conta. Investimentos ficam vinculados à conta corrente; poupança não é tratada como conta.
*Aceite:* cadastro só permite conta corrente.

**CFG-03 ❌ — Remover aba "Casal"**
Excluir completamente a aba Casal.

---

## 5. Impacto no modelo de dados

- `conta`: `tipo = corrente` fixo; ganha filhos `posicao_investimento` (nome, tipo, vencimento, taxa, valor_aplicado, rendimento_acumulado).
- Transferência = par de `lancamento` vinculados (saída disponível + entrada posição), preservando a invariante D1.
- `divida` (financiamento) gera `lancamento` recorrente até quitação; `bem_material` opcionalmente vinculado a uma `divida` (valor líquido = mercado − saldo devedor).
- `categoria`: flag `essencial`.
- `projeto`: absorve campos de EPF — `tipo`, `data_alvo`, `valor_alvo`, `aporte_mensal_calculado` — apontando para o pool de independência.
- Cônjuge = segundo usuário no mesmo tenant (RLS por casal).

---

## 6. Riscos de execução

| Risco | Gatilho | Contingência |
|-------|---------|--------------|
| Dupla contagem no patrimônio ao investir | Patrimônio total muda ao transferir p/ investimento | Teste da invariante D1 antes de seguir para Patrimônio |
| Categorização OFX imprecisa no onboarding | Muitos itens em "Confirmar categoria" | Regras simples + fila de confirmação; aprendizado incremental |
| Vazamento de dado entre casais | Query sem filtro de tenant | RLS obrigatória e testada antes do release do Sprint 6 |
| Projeção de projetos divergir da independência | Soma dos projetos ≠ recorte do pool | Fonte única de verdade: o pool; projeto é recorte etiquetado |

---

## 7. Roadmap de Sprints

Ordem: (a) wins visíveis rápido, (b) fundação do modelo financeiro antes das telas que dependem dele, (c) OFX/CSV por último, com lançamentos e categorias já estáveis.

| Sprint | Nome | Requisitos | Depende de |
|--------|------|-----------|-----------|
| 1 | Ajustes rápidos de UI/config | LAN-01, LAN-03, LAN-04, PRJ-04, CFG-02, CFG-03 | — |
| 2 | Fundação do modelo financeiro | ORC-03, ORC-02, ORC-01 | D1, D4 |
| 3 | Aba Patrimônio | PAT-01, PAT-02, PAT-03, PAT-04 | Sprint 2, D2 |
| 4 | Telas de detalhe | PAT-05, PAT-06, PAT-07, LAN-02 | Sprint 3 |
| 5 | Projetos & Independência | PRJ-01, PRJ-02, PRJ-03, PRJ-05 | Sprint 2, D3 |
| 6 | Acesso compartilhado (cônjuge) | CFG-01 | Modelo estável + RLS |
| 7 | Importação OFX/CSV | LAN-05 | Sprints 1–4 |

---

## 8. Sprint 2 — Notas de implementação (o que realmente foi encontrado e decidido)

Ao iniciar o Sprint 2, o schema real divergia bastante do que este documento assume — não havia
`docs/PRD.md` no repositório, nem tabela de categorias, nem qualquer modelo de investimento dentro
da conta. Estas são as divergências encontradas e as decisões tomadas com o usuário antes de migrar
(ver commit do Sprint 2 para o SQL completo):

1. **Categorias não existiam como dado.** "Classificação" era uma lista fixa de 9 strings, hard-coded
   em `plano.html` (`CLASSIFICATIONS`/`CAT_META`) e duplicada como `<option>` em `lancamentos.html`.
   `transactions.classification` / `budget_plan.classification` sempre foram texto livre, sem tabela
   nem id. **Decisão:** nova tabela `categories` (household-scoped), semeada com as 9 classificações
   atuais + a categoria interna "Aporte reserva de emergência"; `classification` continua texto livre
   nas transações/orçamento, mas agora validado/alimentado pela tabela. Exclusão de categoria em uso
   reatribui os lançamentos para "Classificação neutra" automaticamente (nunca bloqueia).

2. **Investimento era só outro `account_type`.** Não existia "posição dentro da conta" — cada
   investimento era uma conta 100% separada (`account_type = 'investment'`), com seu próprio saldo.
   **Decisão:** o modelo novo (`investment_positions`, filha de uma conta corrente + RPC
   `transfer_to_investment` fazendo as duas escritas ligadas numa única transação SQL) foi construído
   do zero. As contas `investment`/`savings` antigas ficam intocadas como legado — a migração delas
   fica para quando o CFG-02 (Sprint 1) remover esses tipos de conta.

3. **Reserva de emergência tinha saldo digitado manualmente.** `emergency_reserve.current_balance`
   era um número que o usuário editava direto no modal, sem relação com nenhuma conta/investimento.
   **Decisão:** cutover completo — a coluna `current_balance` foi removida; o saldo da reserva agora
   é sempre o `valor_aplicado` da `investment_position` com `is_reserve = true`, alimentada só por
   transferências com classificação "Aporte reserva de emergência" (mesma RPC do item 2).
   `target_months` foi renomeado para `multiplier` (mesmo conceito: multiplicador × despesas
   essenciais, não mais "meses de gasto total").

**Onde está o quê:**
- `supabase/migrations/20260717120000_sprint2_modelo_financeiro.sql` — schema completo, RLS e a RPC
  `transfer_to_investment`. **Precisa ser rodado manualmente no SQL Editor do Supabase** — o ambiente
  de execução do agente não tem CLI nem service-role configurados para aplicar migrações direto.
- `js/finance-model.js` — funções puras do modelo (cálculo da transferência e da meta de reserva),
  compartilhadas entre as páginas e os testes.
- `tests/finance-model.test.js` (`npm test`) — cobre a invariante obrigatória do D1 (transferir R$500:
  disponível −500, investido +500, patrimônio da conta inalterado) e o cálculo da reserva (D4).
- `plano.html` — CRUD de categorias (ORC-01) com flag `essencial` (ORC-02); card de reserva agora
  mostra saldo somente-leitura e permite configurar multiplicador + conta da reserva.
- `lancamentos.html` — categorias carregadas do banco; ao escolher "Investimentos" ou "Aporte reserva
  de emergência" como classificação, o formulário vira uma transferência (ORC-03): pede/cria a posição
  de investimento e chama a RPC em vez de um insert comum.

---

## 9. Sprint 3 — Notas de implementação (Patrimônio, D2)

Branch stackada sobre a do Sprint 2 (`claude/sprint-2-modelo-financeiro-ru934l`), não sobre `main` —
nem o PR do Sprint 1 nem o do Sprint 2 estavam mesclados quando este sprint começou, e Patrimônio
depende do modelo de categorias/investimento que o Sprint 2 introduziu (`categories`,
`investment_positions`). Ver PRs para a ordem de merge correta.

**O que foi construído:**

1. **Financiamentos (D2).** Nova tabela `loans`: `valor_total`, `taxa` (mensal), `prazo`,
   `parcela_mensal` (Price, calculada uma única vez na criação — `js/finance-model.js#pricePayment`),
   `saldo_devedor`, `data_inicio`, conta de origem e titularidade (mesma convenção `owner_type`/
   `member_id` das contas). **Decisão de projeto:** `saldo_devedor` nunca é editado à mão nem
   decrementado de forma ad-hoc — é sempre derivado da tabela de amortização Price
   (`js/finance-model.js#outstandingLoanBalance`) a partir de quantas parcelas já foram geradas como
   lançamento (`transactions.loan_id`). Isso evita deriva de arredondamento e mantém uma única fonte
   de verdade (a mesma lógica que calculou a parcela na criação também sabe o saldo a qualquer momento).

2. **Parcela como saída recorrente automática.** Sem backend/cron neste projeto (é só front-end +
   Supabase), a "geração automática todo mês" é feita por criação preguiçosa ao carregar a página —
   mesmo padrão já usado para faturas de cartão em `lancamentos.html` (`getOrCreateInvoices`). A cada
   carregamento de `patrimonio.html`, `ensureLoanInstallments()` compara quantas parcelas já deveriam
   existir (contando meses de `data_inicio` até hoje) contra quantas já foram geradas, e insere as que
   faltam como `transactions` (classificação "Financiamentos", já semeada no Sprint 2). Um financiamento
   só pode ser excluído enquanto nenhuma parcela foi gerada (`ON DELETE RESTRICT` de `transactions.loan_id`
   → `loans.id`, com a mensagem de erro tratada na UI).

3. **Bens materiais (D2).** Nova tabela `assets`: nome, categoria (texto livre), `valor_mercado`,
   financiamento vinculado opcional (`loan_id`, um bem por financiamento — índice único parcial) e
   titularidade. Valor líquido = `valor_mercado − saldo_devedor` do financiamento vinculado
   (`js/finance-model.js#assetNetWorth`), calculado sempre no cliente, nunca persistido.

4. **UI do Patrimônio (PAT-01..04).** A antiga faixa de 3 KPIs + grade de contas foi substituída por
   3 cards clicáveis (Financeiro / Bens Materiais / Dívidas) que alternam um único painel de expansão
   abaixo — mantendo as abas Minhas/Do parceiro/Conjuntas já existentes. Bens e financiamentos abrem
   um "ticket" (modal de detalhe) com editar/excluir; cartões dentro de Dívidas reaproveitam a tela de
   detalhe da conta já existente como "drill-down" em vez de duplicar essa UI (ela já mostra fatura
   atual/limite/vencimento por cartão) — a tela de detalhe dedicada ao cartão é o PAT-06 do Sprint 4.

**Onde está o quê:**
- `supabase/migrations/20260717130000_sprint3_patrimonio.sql` — tabelas `loans`/`assets`,
  `transactions.loan_id`, RLS. Depende da migração do Sprint 2 já ter rodado. **Também precisa ser
  colada manualmente no SQL Editor do Supabase.**
- `js/finance-model.js` — `pricePayment`, `amortizationSchedule`, `outstandingLoanBalance`,
  `assetNetWorth` (funções puras, sem I/O).
- `tests/finance-model.test.js` — cobre a parcela Price contra um valor de referência conhecido, que a
  soma das amortizações fecha o principal com saldo final exatamente zero, e o valor líquido do bem.
- `patrimonio.html` — os 3 cards de resumo, os painéis de expansão, cadastro/ticket de bem, cadastro/
  ticket de financiamento (com pré-visualização da parcela Price ao digitar) e a geração preguiçosa de
  parcelas.

---

## 10. Sprint 4 — Notas de implementação (telas de detalhe)

Branch stackada sobre a do Sprint 3 (`claude/sprint-3-patrimonio-b85dcc`), pelo mesmo motivo dos
sprints anteriores: PAT-05/06/07 dependem do modelo de contas/cartões/investimentos/financiamentos já
existente, e nenhuma das branches anteriores estava mesclada em `main` quando este sprint começou.

**O que foi construído (majoritariamente apresentação sobre o modelo já existente, como o próprio
sprint descreveu):**

1. **PAT-05 — aba "Investimentos" dentro do detalhe da conta.** A tela de detalhe da conta já existia
   (de um trabalho anterior aos sprints deste PRD); ganhou uma sub-aba nova ("Lançamentos" /
   "Investimentos") que lista as posições de investimento daquela conta especificamente — sempre
   separado do saldo atual, nunca somado a ele (D1: saldo atual = só `accounts.balance` + movimentações
   sem cartão; investido mora só na sua aba).

2. **PAT-07 — projeção de valor de investimento.** Como não havia nenhuma forma de setar `taxa` ou
   `rendimento_acumulado` de uma posição em nenhum sprint anterior (só nome/tipo/vencimento, na criação,
   via transferência em Lançamentos), este sprint adicionou um modal de edição de posição (nome, tipo,
   vencimento, taxa mensal, rendimento acumulado — `valor_aplicado` continua só de leitura, muda
   somente por transferência). A "Projeção" pedida pelo PAT-07 (`js/finance-model.js#investmentProjection`)
   compõe `valor_aplicado + rendimento_acumulado` pela taxa mensal até o vencimento (ou 12 meses, se a
   posição não tiver vencimento) — mesma função usada tanto na aba da conta (PAT-05) quanto na visão
   geral de investimentos, nova e household-wide (alcançada por um link "Ver detalhes" no card
   Financeiro do Patrimônio).

3. **PAT-06 — tela de detalhe do cartão.** Nova, com as 3 abas pedidas (Fatura atual / Total gasto e
   dívida / Limite restante) e a lista de lançamentos do cartão abaixo, com um filtro opcional de
   fatura. Alcançável de três lugares: linha do cartão na expansão de Dívidas, o widget do cartão dentro
   do detalhe da conta (agora clicável), e via querystring (`?view=card&cardId=X&period=Y`).

4. **LAN-02 — ticket de fatura clicável.** O ticket de cada fatura no modal "Faturas" de
   `lancamentos.html` agora navega para `patrimonio.html?view=card&cardId=...&period=...`, abrindo
   direto o detalhe do cartão (PAT-06) já com o filtro de lançamentos naquela fatura pré-selecionado.

**Teste de navegação:** como o ambiente do agente não tem acesso à internet nem ao Supabase real, a
navegação entre as 5 telas de `patrimonio.html` (visão geral, detalhe de conta, detalhe de cartão,
investimentos, mais os 4 modais) e o link do ticket de fatura em `lancamentos.html` foi testada de
ponta a ponta num Chromium headless local com um stub mínimo do cliente Supabase (dados fixos, sem
rede) — cobrindo: abrir/fechar cada view, trocar de sub-aba e aba, os dois deep-links via querystring,
e conferindo que os números calculados (parcela Price, saldo devedor, projeção de investimento, filtro
de fatura) batem com o esperado. Sem erros de JS em nenhum passo.

**Onde está o quê:**
- `js/finance-model.js` — `monthsBetween`, `annualizedRate`, `investmentProjection`.
- `tests/finance-model.test.js` — cobre a projeção com/sem vencimento, taxa zero, vencimento já passado.
- `patrimonio.html` — sub-abas do detalhe da conta, modal de edição de posição, view "Investimentos"
  (PAT-07), view "Detalhe do Cartão" (PAT-06), parsing de querystring no init.
- `lancamentos.html` — ticket de fatura agora navega para o PAT-06 (LAN-02).
