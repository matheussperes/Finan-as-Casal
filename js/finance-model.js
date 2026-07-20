/* ══════════════════════════════════════════════════════════════════════
   finance-model.js
   Funções puras do modelo financeiro (D1 — investimento dentro da conta,
   D4 — reserva de emergência). Sem I/O, sem Supabase: só cálculo, para
   poder ser testado isoladamente (tests/finance-model.test.js) e também
   usado pelas páginas (plano.html, lancamentos.html) via <script src>.
   ══════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.FinanceModel = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {

  const PROTECTED_CATEGORY_NAMES = ['Renda', 'Classificação neutra', 'Aporte reserva de emergência'];
  const FALLBACK_CATEGORY_NAME = 'Classificação neutra';
  const RESERVE_CATEGORY_NAME = 'Aporte reserva de emergência';
  const INVESTMENT_CATEGORY_NAME = 'Investimentos';

  /**
   * Patrimônio de uma conta = disponível + soma do valor_aplicado de todas
   * as suas posições de investimento (D1).
   */
  function accountNetWorth(accountBalance, positions) {
    const invested = (positions || []).reduce((s, p) => s + (Number(p.valor_aplicado) || 0), 0);
    return (Number(accountBalance) || 0) + invested;
  }

  /**
   * Simula uma transferência de saldo disponível -> posição de investimento.
   * Espelha exatamente o que a RPC `transfer_to_investment` faz no banco:
   * saldo_disponivel -= amount, posição.valor_aplicado += amount.
   * Lança erro para valores inválidos, não muta os objetos de entrada.
   */
  function applyTransfer({ accountBalance, position, amount }) {
    if (!(amount > 0)) {
      throw new Error('Valor da transferência deve ser positivo');
    }
    return {
      accountBalance: (Number(accountBalance) || 0) - amount,
      position: {
        ...position,
        valor_aplicado: (Number(position.valor_aplicado) || 0) + amount,
      },
    };
  }

  /**
   * Reserva ideal (D4) = multiplicador x soma dos limites mensais das
   * categorias marcadas como essenciais.
   * `budgetLimitsByCategory`: { [categoryName]: monthlyLimit }
   * `categories`: [{ name, essencial }]
   */
  function essentialReserveTarget(categories, budgetLimitsByCategory, multiplier) {
    const essentialSum = (categories || [])
      .filter(c => c.essencial)
      .reduce((s, c) => s + (Number(budgetLimitsByCategory?.[c.name]) || 0), 0);
    return essentialSum * (Number(multiplier) || 0);
  }

  function round2(v) {
    return Math.round((Number(v) || 0) * 100) / 100;
  }

  /* ══════════════════════════════════════════════════════════════════════
     D2 — Financiamentos (Tabela Price) e valor líquido do bem
     ══════════════════════════════════════════════════════════════════════ */

  /**
   * Parcela mensal pela fórmula de Price: PMT = P·i / (1 - (1+i)^-n).
   * `principal`: valor financiado. `rate`: taxa mensal (ex.: 0.01 = 1% a.m.).
   * `n`: número de parcelas. Calculada uma única vez, na criação do
   * financiamento (D2) — não recalcula depois.
   */
  function pricePayment(principal, rate, n) {
    principal = Number(principal) || 0;
    rate = Number(rate) || 0;
    n = Math.round(Number(n) || 0);
    if (n <= 0) return 0;
    if (rate === 0) return round2(principal / n);
    const payment = (principal * rate) / (1 - Math.pow(1 + rate, -n));
    return round2(payment);
  }

  /**
   * Tabela de amortização Price completa: uma linha por parcela, com juros,
   * amortização (parte que abate o principal) e saldo devedor após aquela
   * parcela. A última parcela absorve o resíduo de arredondamento para o
   * saldo fechar exatamente em zero.
   */
  function amortizationSchedule(principal, rate, n) {
    principal = Number(principal) || 0;
    rate = Number(rate) || 0;
    n = Math.round(Number(n) || 0);
    if (n <= 0) return [];

    const payment = pricePayment(principal, rate, n);
    let balance = principal;
    const schedule = [];

    for (let period = 1; period <= n; period++) {
      const interest = round2(balance * rate);
      let amortization = round2(payment - interest);
      let installmentPayment = payment;
      if (period === n) {
        // fecha exatamente no fim, absorvendo o resíduo de arredondamento
        amortization = balance;
        installmentPayment = round2(amortization + interest);
      }
      balance = round2(Math.max(0, balance - amortization));
      schedule.push({ period, payment: installmentPayment, interest, amortization, balance });
    }
    return schedule;
  }

  /**
   * Saldo devedor após `installmentsPaid` parcelas já geradas/pagas.
   * 0 parcelas pagas => saldo = principal. >= prazo => quitado (0).
   */
  function outstandingLoanBalance(principal, rate, n, installmentsPaid) {
    n = Math.round(Number(n) || 0);
    installmentsPaid = Math.round(Number(installmentsPaid) || 0);
    if (installmentsPaid <= 0) return round2(principal);
    if (installmentsPaid >= n) return 0;
    const schedule = amortizationSchedule(principal, rate, n);
    return schedule[installmentsPaid - 1].balance;
  }

  /**
   * Valor líquido do bem (D2) = valor de mercado − saldo devedor do
   * financiamento vinculado (0 se não houver financiamento vinculado).
   */
  function assetNetWorth(marketValue, outstandingLoan) {
    return round2((Number(marketValue) || 0) - (Number(outstandingLoan) || 0));
  }

  /* ══════════════════════════════════════════════════════════════════════
     PAT-07 — Detalhe de investimentos (projeção de valor)
     ══════════════════════════════════════════════════════════════════════ */

  /**
   * Meses inteiros entre duas datas ISO (YYYY-MM-DD), ignorando o dia do
   * mês (aproximação por mês corrente — suficiente para uma projeção).
   * Nunca retorna negativo (datas no passado viram 0).
   */
  function monthsBetween(fromISO, toISO) {
    if (!fromISO || !toISO) return 0;
    const [fy, fm] = fromISO.split('-').map(Number);
    const [ty, tm] = toISO.split('-').map(Number);
    const months = (ty - fy) * 12 + (tm - fm);
    return Math.max(0, months);
  }

  /**
   * Taxa anualizada equivalente a uma taxa mensal (juros compostos):
   * (1+i)^12 - 1. Só para exibição ("% ao mês/ano") — não usada no cálculo
   * da projeção, que sempre compõe mês a mês.
   */
  function annualizedRate(monthlyRate) {
    return Math.pow(1 + (Number(monthlyRate) || 0), 12) - 1;
  }

  /**
   * Projeção de valor (PAT-07): valor atual (aplicado + rendimento já
   * acumulado) composto pela taxa mensal até o vencimento; sem vencimento,
   * projeta 12 meses à frente. `todayISO` é injetado (não usa `new Date()`
   * internamente) para o cálculo ser determinístico e testável.
   */
  function investmentProjection({ valorAplicado, rendimentoAcumulado, taxaMensal, vencimento, todayISO }) {
    const currentTotal = (Number(valorAplicado) || 0) + (Number(rendimentoAcumulado) || 0);
    const months = vencimento ? monthsBetween(todayISO, vencimento) : 12;
    if (months <= 0) return round2(currentTotal);
    const rate = Number(taxaMensal) || 0;
    return round2(currentTotal * Math.pow(1 + rate, months));
  }

  /* ══════════════════════════════════════════════════════════════════════
     D3 / PRJ-01..03 — Projetos como eventos patrimoniais futuros,
     dentro do mesmo pool de independência.

     Princípio anti-dupla-contagem (PRJ-03):
     • O aporte de projeto é um RECORTE do aporte total de independência
       (`monthly_contribution`) — nunca uma soma por cima. A simulação usa
       sempre o aporte total; os PMTs por projeto são apenas etiquetas de
       alocação dentro dele.
     • `jaReservado` (allocated_amount) é um recorte do pool já investido —
       reduz o que falta acumular para o projeto, mas nunca entra como
       patrimônio adicional na simulação (o pool inteiro já é o patrimônio).
     • Na data-alvo, a retirada sai do montante total do pool.
     ══════════════════════════════════════════════════════════════════════ */

  const PROJECT_TIPOS = ['retirada_unica', 'despesa_recorrente', 'receita_recorrente', 'aporte_extra'];

  /**
   * Derivação automática do D3 — sem campo extra para preencher:
   * retirada única e aporte extra ⇒ acumulação; despesa recorrente ⇒
   * despesa; receita recorrente ⇒ receita (o espelho lógico da despesa).
   */
  function projectKind(tipo) {
    if (tipo === 'despesa_recorrente') return 'despesa';
    if (tipo === 'receita_recorrente') return 'receita';
    return 'acumulacao';
  }

  /** Taxa anual real -> taxa mensal equivalente (juros compostos). */
  function annualToMonthlyRate(annualRate) {
    return Math.pow(1 + (Number(annualRate) || 0), 1 / 12) - 1;
  }

  /**
   * Aporte mensal necessário para acumular `valorAlvo` na data-alvo
   * (PRJ-03): PMT = FV·r / ((1+r)^n − 1); com r=0, FV/n. `jaReservado` é o
   * recorte do pool já etiquetado para o projeto. Retorna 0 se já atingido
   * e null se não houver prazo válido (sem data ou data no passado).
   * Ex. do PRD: R$500k em dez/2040 a 0,5% a.m. (173 meses) ⇒ ~R$1.824,95/mês.
   */
  function projectMonthlyContribution({ valorAlvo, jaReservado, monthsRemaining, taxaMensal }) {
    const fv = Math.max(0, (Number(valorAlvo) || 0) - (Number(jaReservado) || 0));
    if (fv <= 0) return 0;
    if (!(monthsRemaining > 0)) return null;
    const r = Number(taxaMensal) || 0;
    if (r === 0) return round2(fv / monthsRemaining);
    return round2((fv * r) / (Math.pow(1 + r, monthsRemaining) - 1));
  }

  /**
   * PRJ-01 — projetos SÃO os eventos patrimoniais futuros. Converte a
   * lista de projetos ativos no formato de evento que a simulação consome:
   * retirada única / aporte extra são pontuais na data-alvo; despesa /
   * receita recorrente valem de `target_date` até `end_date` (ou sempre).
   */
  function projectsToSimulationEvents(projects) {
    return (projects || [])
      .filter(p => p.is_active !== false && PROJECT_TIPOS.includes(p.tipo) && p.target_date)
      .map(p => ({
        tipo: p.tipo,
        amount: Number(p.target_amount) || 0,
        startMonth: String(p.target_date).substring(0, 7),
        endMonth: p.end_date ? String(p.end_date).substring(0, 7) : null,
      }));
  }

  /**
   * Motor de simulação da independência financeira (extraído de
   * futuro.html para ser puro e testável). Simula mês a mês de hoje
   * (startYear/startMonth injetados — determinístico) até maxAge.
   *
   * Semântica por mês (preservada do motor original):
   *   1. eventos pontuais mexem direto no patrimônio (retirada−/aporte+);
   *   2. recorrentes ajustam o fluxo do mês (despesa−/receita+);
   *   3. entra o aporte total (monthlyContrib + fluxo) — SEM somar PMTs de
   *      projeto por cima: eles já são recorte do monthlyContrib;
   *   4. rende a taxa mensal; nunca fica negativo.
   */
  function simulateIndependence(params, events, { startYear, startMonth }) {
    const currentAge = Number(params.currentAge) || 30;
    const targetAge = Number(params.targetAge) || 65;
    const maxAge = Math.max(targetAge + 20, 85);
    const rateAcc = Number(params.rateAcc) || 0;
    const ratePost = Number(params.ratePost) || 0;
    const desiredIncome = Number(params.desiredIncome) || 0;
    const otherIncome = Number(params.otherIncome) || 0;
    const monthlyContrib = Number(params.monthlyContrib) || 0;
    const initialPatrimony = Number(params.initialPatrimony) || 0;

    const monthlyRate = annualToMonthlyRate(rateAcc);
    const netDesired = Math.max(0, desiredIncome - otherIncome);
    const targetPatrimony = ratePost > 0 ? (netDesired * 12) / ratePost : 0;
    const totalMonths = (maxAge - currentAge) * 12;

    /* Lookup de eventos por mês (chave YYYY-MM) */
    const eventMap = {};
    (events || []).forEach(ev => {
      if (!ev.startMonth) return;
      const single = ev.tipo === 'retirada_unica' || ev.tipo === 'aporte_extra';
      if (single) {
        (eventMap[ev.startMonth] = eventMap[ev.startMonth] || []).push(ev);
        return;
      }
      const [sy, sm] = ev.startMonth.split('-').map(Number);
      const [ey, em] = ev.endMonth ? ev.endMonth.split('-').map(Number) : [startYear + maxAge, 12];
      let cy = sy, cm = sm;
      while (cy < ey || (cy === ey && cm <= em)) {
        const key = `${cy}-${String(cm).padStart(2, '0')}`;
        (eventMap[key] = eventMap[key] || []).push(ev);
        cm++;
        if (cm > 12) { cm = 1; cy++; }
        if ((cy - sy) * 12 + (cm - sm) > totalMonths + 12) break;
      }
    });

    const ageLabels = [];
    const wealthCurve = [];
    const targetLine = [];
    const monthlyCurve = [];
    let patrimony = initialPatrimony;
    let ifAge = null;

    for (let m = 0; m <= totalMonths; m++) {
      const cy = startYear + Math.floor((startMonth + m) / 12);
      const cm = ((startMonth + m) % 12) + 1;
      const key = `${cy}-${String(cm).padStart(2, '0')}`;
      const age = currentAge + m / 12;

      let extraContrib = 0;
      (eventMap[key] || []).forEach(ev => {
        const amt = Number(ev.amount) || 0;
        if (ev.tipo === 'retirada_unica') patrimony -= amt;
        if (ev.tipo === 'aporte_extra') patrimony += amt;
        if (ev.tipo === 'despesa_recorrente') extraContrib -= amt;
        if (ev.tipo === 'receita_recorrente') extraContrib += amt;
      });

      patrimony += (monthlyContrib + extraContrib);
      patrimony = patrimony * (1 + monthlyRate);
      patrimony = Math.max(0, patrimony);

      if (ifAge === null && targetPatrimony > 0 && patrimony >= targetPatrimony) {
        ifAge = age;
      }

      monthlyCurve.push(patrimony);
      if (m % 12 === 0) {
        ageLabels.push(Math.floor(age));
        wealthCurve.push(patrimony);
        targetLine.push(targetPatrimony);
      }
    }

    /* PMT necessário p/ atingir a meta na idade alvo (sem eventos) */
    const nMonths = (targetAge - currentAge) * 12;
    let pmtNeeded = null;
    if (nMonths > 0 && targetPatrimony > 0) {
      if (monthlyRate === 0) {
        pmtNeeded = (targetPatrimony - initialPatrimony) / nMonths;
      } else {
        const factor = Math.pow(1 + monthlyRate, nMonths);
        pmtNeeded = ((targetPatrimony - initialPatrimony * factor) * monthlyRate) / (factor - 1);
      }
    }

    return {
      targetPatrimony, pmtNeeded, ifAge, currentAge, targetAge,
      ageLabels, wealthCurve, targetLine, monthlyCurve,
      rateAcc, ratePost, desiredIncome, otherIncome, netDesired, monthlyContrib,
    };
  }

  return {
    PROTECTED_CATEGORY_NAMES,
    FALLBACK_CATEGORY_NAME,
    RESERVE_CATEGORY_NAME,
    INVESTMENT_CATEGORY_NAME,
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
    PROJECT_TIPOS,
    projectKind,
    annualToMonthlyRate,
    projectMonthlyContribution,
    projectsToSimulationEvents,
    simulateIndependence,
  };
});
