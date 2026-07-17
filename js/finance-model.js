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

  return {
    PROTECTED_CATEGORY_NAMES,
    FALLBACK_CATEGORY_NAME,
    RESERVE_CATEGORY_NAME,
    INVESTMENT_CATEGORY_NAME,
    accountNetWorth,
    applyTransfer,
    essentialReserveTarget,
  };
});
