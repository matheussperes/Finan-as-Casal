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
  };
});
