const test = require('node:test');
const assert = require('node:assert/strict');
const {
  accountNetWorth,
  applyTransfer,
  essentialReserveTarget,
  pricePayment,
  amortizationSchedule,
  outstandingLoanBalance,
  assetNetWorth,
  monthsBetween,
  annualizedRate,
  investmentProjection,
  projectKind,
  annualToMonthlyRate,
  projectMonthlyContribution,
  projectsToSimulationEvents,
  simulateIndependence,
} = require('../js/finance-model.js');

/* ══════════════════════════════════════════════════════════════════════
   D1 — invariante obrigatória: para a mesma conta,
   saldo_disponivel + total_investido não muda numa transferência interna.
   ══════════════════════════════════════════════════════════════════════ */
test('transferir R$500 para investimento: disponível -500, investido +500, patrimônio da conta inalterado', () => {
  const accountBalanceBefore = 2000;
  const positionBefore = { id: 'pos-1', name: 'CDB Banco X', valor_aplicado: 1000 };
  const netWorthBefore = accountNetWorth(accountBalanceBefore, [positionBefore]);

  const { accountBalance: accountBalanceAfter, position: positionAfter } = applyTransfer({
    accountBalance: accountBalanceBefore,
    position: positionBefore,
    amount: 500,
  });

  assert.equal(accountBalanceAfter, 1500);
  assert.equal(positionAfter.valor_aplicado, 1500);

  const netWorthAfter = accountNetWorth(accountBalanceAfter, [positionAfter]);
  assert.equal(netWorthAfter, netWorthBefore);
  assert.equal(netWorthAfter, 3000);
});

test('applyTransfer não muta o objeto de posição original', () => {
  const position = { id: 'pos-1', valor_aplicado: 100 };
  applyTransfer({ accountBalance: 1000, position, amount: 50 });
  assert.equal(position.valor_aplicado, 100, 'o objeto original não deveria ser alterado');
});

test('applyTransfer rejeita valores inválidos', () => {
  const position = { id: 'pos-1', valor_aplicado: 100 };
  assert.throws(() => applyTransfer({ accountBalance: 1000, position, amount: 0 }));
  assert.throws(() => applyTransfer({ accountBalance: 1000, position, amount: -10 }));
  assert.throws(() => applyTransfer({ accountBalance: 1000, position, amount: NaN }));
});

test('invariante se mantém em sequência de transferências e com múltiplas posições na conta', () => {
  let accountBalance = 5000;
  const posA = { id: 'a', valor_aplicado: 0 };
  const posB = { id: 'b', valor_aplicado: 200 };

  const netWorthBefore = accountNetWorth(accountBalance, [posA, posB]);

  let result = applyTransfer({ accountBalance, position: posA, amount: 300 });
  accountBalance = result.accountBalance;
  const posAAfter1 = result.position;

  result = applyTransfer({ accountBalance, position: posAAfter1, amount: 150 });
  accountBalance = result.accountBalance;
  const posAAfter2 = result.position;

  const netWorthAfter = accountNetWorth(accountBalance, [posAAfter2, posB]);
  assert.equal(netWorthAfter, netWorthBefore);
  assert.equal(accountBalance, 5000 - 300 - 150);
  assert.equal(posAAfter2.valor_aplicado, 450);
});

/* ══════════════════════════════════════════════════════════════════════
   D4 — reserva ideal = multiplicador x soma(despesas essenciais)
   ══════════════════════════════════════════════════════════════════════ */
test('essentialReserveTarget soma só categorias essenciais e aplica o multiplicador', () => {
  const categories = [
    { name: 'Despesas obrigatórias', essencial: true },
    { name: 'Financiamentos', essencial: true },
    { name: 'Dívidas', essencial: true },
    { name: 'Despesas não obrigatórias', essencial: false },
    { name: 'Renda', essencial: false },
  ];
  const budgetLimitsByCategory = {
    'Despesas obrigatórias': 3000,
    'Financiamentos': 1200,
    'Dívidas': 300,
    'Despesas não obrigatórias': 2000,
    'Renda': 10000,
  };

  const target = essentialReserveTarget(categories, budgetLimitsByCategory, 6);
  assert.equal(target, (3000 + 1200 + 300) * 6);
});

test('essentialReserveTarget usa o multiplicador editável, não um valor fixo em 6', () => {
  const categories = [{ name: 'Despesas obrigatórias', essencial: true }];
  const budgetLimitsByCategory = { 'Despesas obrigatórias': 1000 };
  assert.equal(essentialReserveTarget(categories, budgetLimitsByCategory, 12), 12000);
  assert.equal(essentialReserveTarget(categories, budgetLimitsByCategory, 3), 3000);
});

test('essentialReserveTarget é zero sem categorias essenciais ou sem metas definidas', () => {
  assert.equal(essentialReserveTarget([], {}, 6), 0);
  const categories = [{ name: 'Despesas obrigatórias', essencial: false }];
  assert.equal(essentialReserveTarget(categories, { 'Despesas obrigatórias': 1000 }, 6), 0);
});

/* ══════════════════════════════════════════════════════════════════════
   D2 — Financiamentos: parcela pela fórmula de Price e valor líquido do bem
   ══════════════════════════════════════════════════════════════════════ */
test('pricePayment calcula a parcela pela fórmula de Price (caso de referência)', () => {
  // P=10000, i=1% a.m., n=12 -> PMT ≈ 888.49 (valor de referência conhecido da tabela Price)
  const pmt = pricePayment(10000, 0.01, 12);
  assert.ok(Math.abs(pmt - 888.49) < 0.01, `esperado ~888.49, obtido ${pmt}`);
});

test('pricePayment com taxa zero é uma divisão simples do principal pelo prazo', () => {
  assert.equal(pricePayment(1200, 0, 12), 100);
});

test('pricePayment com prazo zero ou negativo é zero', () => {
  assert.equal(pricePayment(1000, 0.01, 0), 0);
  assert.equal(pricePayment(1000, 0.01, -3), 0);
});

test('amortizationSchedule: soma das amortizações fecha o principal e o saldo final é zero', () => {
  const principal = 50000;
  const schedule = amortizationSchedule(principal, 0.015, 36);
  assert.equal(schedule.length, 36);
  const totalAmortized = schedule.reduce((s, row) => s + row.amortization, 0);
  assert.ok(Math.abs(totalAmortized - principal) < 0.01, `amortização total ${totalAmortized} deveria fechar ${principal}`);
  assert.equal(schedule[schedule.length - 1].balance, 0);
  // saldo devedor é estritamente decrescente parcela a parcela
  for (let i = 1; i < schedule.length; i++) {
    assert.ok(schedule[i].balance <= schedule[i - 1].balance);
  }
});

test('amortizationSchedule com taxa zero: amortização constante = parcela', () => {
  const schedule = amortizationSchedule(1200, 0, 12);
  schedule.forEach(row => {
    assert.equal(row.interest, 0);
    assert.equal(row.amortization, 100);
  });
  assert.equal(schedule[11].balance, 0);
});

test('outstandingLoanBalance: 0 parcelas pagas = principal cheio, >= prazo = quitado', () => {
  const principal = 20000;
  const rate = 0.012;
  const n = 24;
  assert.equal(outstandingLoanBalance(principal, rate, n, 0), principal);
  assert.equal(outstandingLoanBalance(principal, rate, n, n), 0);
  assert.equal(outstandingLoanBalance(principal, rate, n, n + 5), 0);
});

test('outstandingLoanBalance no meio do prazo bate com a tabela de amortização', () => {
  const principal = 20000;
  const rate = 0.012;
  const n = 24;
  const schedule = amortizationSchedule(principal, rate, n);
  assert.equal(outstandingLoanBalance(principal, rate, n, 10), schedule[9].balance);
  assert.ok(outstandingLoanBalance(principal, rate, n, 10) < principal);
  assert.ok(outstandingLoanBalance(principal, rate, n, 10) > 0);
});

test('assetNetWorth = valor de mercado − saldo devedor do financiamento vinculado', () => {
  assert.equal(assetNetWorth(80000, 30000), 50000);
  assert.equal(assetNetWorth(80000, 0), 80000);
  assert.equal(assetNetWorth(80000, null), 80000);
});

/* ══════════════════════════════════════════════════════════════════════
   PAT-07 — Detalhe de investimentos: projeção de valor
   ══════════════════════════════════════════════════════════════════════ */
test('monthsBetween conta meses inteiros e nunca é negativo', () => {
  assert.equal(monthsBetween('2026-07-18', '2027-07-18'), 12);
  assert.equal(monthsBetween('2026-07-18', '2026-10-18'), 3);
  assert.equal(monthsBetween('2026-07-18', '2026-07-18'), 0);
  assert.equal(monthsBetween('2026-07-18', '2026-01-01'), 0, 'data no passado vira 0, nunca negativo');
});

test('annualizedRate converte taxa mensal em anual equivalente (juros compostos)', () => {
  assert.ok(Math.abs(annualizedRate(0.01) - 0.126825) < 0.0001);
  assert.equal(annualizedRate(0), 0);
});

test('investmentProjection com vencimento: compõe valor atual pela taxa mensal até lá', () => {
  const projecao = investmentProjection({
    valorAplicado: 1000,
    rendimentoAcumulado: 0,
    taxaMensal: 0.01,
    vencimento: '2027-07-18',
    todayISO: '2026-07-18',
  });
  // 1000 * 1.01^12 ≈ 1126.83
  assert.ok(Math.abs(projecao - 1126.83) < 0.01, `esperado ~1126.83, obtido ${projecao}`);
});

test('investmentProjection sem vencimento: projeta 12 meses à frente', () => {
  const comVencimento = investmentProjection({
    valorAplicado: 1000, rendimentoAcumulado: 0, taxaMensal: 0.01,
    vencimento: '2027-07-18', todayISO: '2026-07-18',
  });
  const semVencimento = investmentProjection({
    valorAplicado: 1000, rendimentoAcumulado: 0, taxaMensal: 0.01,
    vencimento: null, todayISO: '2026-07-18',
  });
  assert.equal(semVencimento, comVencimento, '12 meses à frente deveria bater com o exemplo de vencimento em 1 ano');
});

test('investmentProjection soma o rendimento já acumulado antes de compor', () => {
  const projecao = investmentProjection({
    valorAplicado: 1000, rendimentoAcumulado: 200, taxaMensal: 0,
    vencimento: '2027-07-18', todayISO: '2026-07-18',
  });
  assert.equal(projecao, 1200, 'taxa zero: projeção = valor atual, sem crescer');
});

test('investmentProjection com vencimento já vencido retorna o valor atual (sem meses a compor)', () => {
  const projecao = investmentProjection({
    valorAplicado: 1000, rendimentoAcumulado: 50, taxaMensal: 0.01,
    vencimento: '2020-01-01', todayISO: '2026-07-18',
  });
  assert.equal(projecao, 1050);
});

/* ══════════════════════════════════════════════════════════════════════
   D3 / PRJ-02 — derivação automática acumulação vs despesa
   ══════════════════════════════════════════════════════════════════════ */
test('projectKind deriva a classificação do tipo, sem campo extra (D3)', () => {
  assert.equal(projectKind('retirada_unica'), 'acumulacao');
  assert.equal(projectKind('aporte_extra'), 'acumulacao');
  assert.equal(projectKind('despesa_recorrente'), 'despesa');
  assert.equal(projectKind('receita_recorrente'), 'receita');
});

/* ══════════════════════════════════════════════════════════════════════
   PRJ-03 — aporte mensal do projeto (exemplo literal do PRD)
   ══════════════════════════════════════════════════════════════════════ */
test('exemplo do PRD: R$500k em dez/2040 a 0,5% a.m. ⇒ ~R$1.824,96/mês', () => {
  // De jul/2026 (data de referência do PRD) a dez/2040 = 173 meses
  const n = monthsBetween('2026-07-18', '2040-12-01');
  assert.equal(n, 173);
  const pmt = projectMonthlyContribution({
    valorAlvo: 500000, jaReservado: 0, monthsRemaining: n, taxaMensal: 0.005,
  });
  assert.ok(Math.abs(pmt - 1824.96) < 0.1, `esperado ~1824.96, obtido ${pmt}`);
});

test('projectMonthlyContribution: jaReservado é recorte do pool e reduz o que falta', () => {
  const cheio = projectMonthlyContribution({ valorAlvo: 12000, jaReservado: 0, monthsRemaining: 12, taxaMensal: 0 });
  const metade = projectMonthlyContribution({ valorAlvo: 12000, jaReservado: 6000, monthsRemaining: 12, taxaMensal: 0 });
  assert.equal(cheio, 1000);
  assert.equal(metade, 500);
  assert.equal(projectMonthlyContribution({ valorAlvo: 12000, jaReservado: 12000, monthsRemaining: 12, taxaMensal: 0 }), 0, 'já atingido');
  assert.equal(projectMonthlyContribution({ valorAlvo: 12000, jaReservado: 0, monthsRemaining: 0, taxaMensal: 0 }), null, 'sem prazo válido');
});

/* ══════════════════════════════════════════════════════════════════════
   PRJ-01 — projetos SÃO os eventos patrimoniais futuros
   ══════════════════════════════════════════════════════════════════════ */
test('projectsToSimulationEvents converte os 4 tipos e ignora inativos/sem tipo', () => {
  const events = projectsToSimulationEvents([
    { tipo: 'retirada_unica', target_amount: 500000, target_date: '2040-12-01', is_active: true },
    { tipo: 'aporte_extra', target_amount: 10000, target_date: '2027-01-01' },
    { tipo: 'despesa_recorrente', target_amount: 3000, target_date: '2028-01-01', end_date: '2046-01-01' },
    { tipo: 'receita_recorrente', target_amount: 2000, target_date: '2030-06-01' },
    { tipo: 'retirada_unica', target_amount: 999, target_date: '2030-01-01', is_active: false }, // pausado: fora
    { target_amount: 999, target_date: '2030-01-01' },                                            // sem tipo (legado): fora
  ]);
  assert.equal(events.length, 4);
  assert.deepEqual(events[0], { tipo: 'retirada_unica', amount: 500000, startMonth: '2040-12', endMonth: null });
  assert.deepEqual(events[2], { tipo: 'despesa_recorrente', amount: 3000, startMonth: '2028-01', endMonth: '2046-01' });
});

/* ══════════════════════════════════════════════════════════════════════
   PRJ-03 — simulação: retirada sai do montante total na data-alvo,
   e NUNCA há dupla contagem (aporte de projeto é recorte, não soma).
   Com taxa 0 a aritmética é exata e qualquer dupla contagem apareceria.
   ══════════════════════════════════════════════════════════════════════ */
const baseParams = {
  currentAge: 30, targetAge: 65, rateAcc: 0, ratePost: 0.035,
  desiredIncome: 10000, otherIncome: 0, monthlyContrib: 1000, initialPatrimony: 50000,
};
const simStart = { startYear: 2026, startMonth: 6 }; // jul/2026 (0-indexado)

test('retirada única sai do montante total exatamente na data-alvo', () => {
  const withdrawal = { tipo: 'retirada_unica', amount: 5000, startMonth: '2027-07', endMonth: null };
  const semProjeto = simulateIndependence(baseParams, [], simStart);
  const comProjeto = simulateIndependence(baseParams, [withdrawal], simStart);

  // jul/2027 é o mês de índice 12 da simulação que começa em jul/2026
  const k = 12;
  for (let m = 0; m < k; m++) {
    assert.equal(comProjeto.monthlyCurve[m], semProjeto.monthlyCurve[m],
      `antes da data-alvo (mês ${m}) as curvas devem ser idênticas — aporte de projeto não soma por cima`);
  }
  for (let m = k; m < comProjeto.monthlyCurve.length; m++) {
    assert.ok(Math.abs((semProjeto.monthlyCurve[m] - comProjeto.monthlyCurve[m]) - 5000) < 1e-6,
      `após a retirada (mês ${m}) a diferença deve ser exatamente os R$5.000 retirados do pool`);
  }
});

test('sem dupla contagem: patrimônio final = P0 + aportes totais − retiradas − despesas recorrentes (taxa 0)', () => {
  const events = [
    { tipo: 'retirada_unica', amount: 5000, startMonth: '2027-07', endMonth: null },
    { tipo: 'despesa_recorrente', amount: 200, startMonth: '2027-01', endMonth: '2027-06' }, // 6 meses
  ];
  const sim = simulateIndependence(baseParams, events, simStart);
  const nAportes = sim.monthlyCurve.length; // um aporte por mês simulado
  const esperado = 50000 + nAportes * 1000 - 5000 - 6 * 200;
  const final = sim.monthlyCurve[sim.monthlyCurve.length - 1];
  assert.ok(Math.abs(final - esperado) < 1e-6,
    `final ${final} deveria ser exatamente ${esperado} — qualquer excedente indicaria PMT de projeto somado por cima do aporte total`);
});

test('aporte extra e receita recorrente entram no pool (acumulação/receita)', () => {
  const events = [
    { tipo: 'aporte_extra', amount: 10000, startMonth: '2026-12', endMonth: null },
    { tipo: 'receita_recorrente', amount: 500, startMonth: '2027-01', endMonth: '2027-03' }, // 3 meses
  ];
  const sem = simulateIndependence(baseParams, [], simStart);
  const com = simulateIndependence(baseParams, events, simStart);
  const finalSem = sem.monthlyCurve[sem.monthlyCurve.length - 1];
  const finalCom = com.monthlyCurve[com.monthlyCurve.length - 1];
  assert.ok(Math.abs((finalCom - finalSem) - (10000 + 3 * 500)) < 1e-6);
});

test('simulateIndependence: meta de patrimônio = renda líquida anual / taxa pós-IF', () => {
  const sim = simulateIndependence(baseParams, [], simStart);
  assert.ok(Math.abs(sim.targetPatrimony - (10000 * 12) / 0.035) < 0.01);
});

test('annualToMonthlyRate é o inverso composto de annualizedRate', () => {
  const monthly = annualToMonthlyRate(0.04);
  assert.ok(Math.abs(annualizedRate(monthly) - 0.04) < 1e-10);
});
