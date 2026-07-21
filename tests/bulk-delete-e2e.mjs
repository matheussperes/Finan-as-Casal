// Smoke test E2E da seleção múltipla + exclusão em massa de lançamentos
// (lancamentos.html). Carrega a página real num Chromium headless com um
// stub do Supabase em memória e dirige o fluxo real: marcar checkboxes,
// "selecionar tudo", excluir em massa (incluindo um pagamento de fatura
// is_ignored, que precisa derrubar o invoice_payments e reconciliar a
// fatura, igual à exclusão individual já existente).
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const stubSource = `
window.__db = {
  households: [{ id: 'hh-1', name: 'Casal Teste' }],
  members: [{ id: 'm-me', household_id: 'hh-1', user_id: 'u-me', name: 'Matheus', role: 'primary' }],
  accounts: [{ id: 'acc-1', household_id: 'hh-1', name: 'Nubank', account_type: 'checking', owner_type: 'individual', member_id: 'm-me', balance: 5000, is_active: true, created_at: '2026-01-01' }],
  credit_cards: [{ id: 'card-1', account_id: 'acc-1', name: 'Nubank Cartão', closing_day: 5, due_day: 15, credit_limit: 10000, created_at: '2026-01-01' }],
  categories: (() => {
    const tops = ['Renda','Despesas obrigatórias','Classificação neutra','Transporte','Alimentação']
      .map((name, i) => ({ id: 'cat-' + i, household_id: 'hh-1', name, parent_id: null, sort_order: i, essencial: false, created_at: '2026-01-0' + (i+1) }));
    const subs = tops.map((t, i) => ({ id: 'sub-' + i, household_id: 'hh-1', name: 'Geral', parent_id: t.id, sort_order: 0, essencial: false, created_at: '2026-01-02' }));
    return [...tops, ...subs];
  })(),
  invoices: [
    { id: 'inv-1', credit_card_id: 'card-1', period: '2026-07', status: 'paid', closing_date: '2026-07-05', due_date: '2026-07-15' },
  ],
  invoice_payments: [
    { id: 'ip-1', invoice_id: 'inv-1', transaction_id: 'tx-pay', amount: 300, date: '2026-07-15' },
  ],
  investment_positions: [],
  transactions: [
    { id: 'tx-1', household_id: 'hh-1', account_id: 'acc-1', description: 'Uber', classification: 'Transporte', subcategory: 'Geral', direction: 'expense', amount: 30, date: '2026-07-01', needs_category_review: false, is_ignored: false },
    { id: 'tx-2', household_id: 'hh-1', account_id: 'acc-1', description: 'iFood', classification: 'Alimentação', subcategory: 'Geral', direction: 'expense', amount: 40, date: '2026-07-02', needs_category_review: false, is_ignored: false },
    { id: 'tx-3', household_id: 'hh-1', account_id: 'acc-1', description: 'Salário', classification: 'Renda', subcategory: 'Geral', direction: 'income', amount: 5000, date: '2026-07-03', needs_category_review: false, is_ignored: false },
    { id: 'tx-pay', household_id: 'hh-1', account_id: 'acc-1', description: 'Pagamento fatura Nubank Cartão', classification: 'Classificação neutra', subcategory: 'Geral', direction: 'expense', amount: 300, date: '2026-07-15', needs_category_review: false, is_ignored: true },
    // compra do cartão fora do mês visível (mês anterior) — só existe pra dar saldo à fatura (invoiceComputedTotal), não aparece na tabela do mês corrente
    { id: 'tx-compra', household_id: 'hh-1', account_id: 'acc-1', credit_card_id: 'card-1', invoice_id: 'inv-1', description: 'Compra fatura', classification: 'Alimentação', subcategory: 'Geral', direction: 'expense', amount: 300, date: '2026-06-20', needs_category_review: false, is_ignored: false },
  ],
};

function uuid() { return 'gen-' + Math.random().toString(36).slice(2, 10); }
function matches(row, filters) {
  return filters.every(f => {
    if (f.op === 'eq')  return row[f.col] === f.val;
    if (f.op === 'neq') return row[f.col] !== f.val;
    if (f.op === 'in')  return f.val.includes(row[f.col]);
    if (f.op === 'gte') return row[f.col] >= f.val;
    if (f.op === 'lte') return row[f.col] <= f.val;
    if (f.op === 'notnull') return row[f.col] != null;
    return true;
  });
}
function makeBuilder(table) {
  const st = { table, filters: [], action: 'select', rows: null, returnRows: false, count: false, head: false, orderCol: null, orderAsc: true, limitN: null, updateObj: null };
  const run = () => {
    const db = window.__db;
    const arr = db[st.table] || (db[st.table] = []);
    if (st.action === 'insert') {
      const rows = Array.isArray(st.rows) ? st.rows : [st.rows];
      const inserted = rows.map(r => ({ id: uuid(), needs_category_review: false, source: 'manual', ...r }));
      arr.push(...inserted);
      return { data: st.returnRows ? inserted : null, error: null };
    }
    let sel = arr.filter(r => matches(r, st.filters));
    if (st.action === 'update') { sel.forEach(r => Object.assign(r, st.updateObj)); return { data: null, error: null }; }
    if (st.action === 'delete') { window.__db[st.table] = arr.filter(r => !matches(r, st.filters)); return { data: null, error: null }; }
    if (st.head && st.count) return { count: sel.length, data: null, error: null };
    if (st.orderCol) sel = sel.slice().sort((a,b) => (a[st.orderCol] > b[st.orderCol] ? 1 : -1) * (st.orderAsc ? 1 : -1));
    if (st.limitN) sel = sel.slice(0, st.limitN);
    return { data: sel, error: null, count: st.count ? sel.length : undefined };
  };
  const b = {
    select(_cols, opts) { if (opts && opts.count) st.count = true; if (opts && opts.head) st.head = true; return b; },
    eq(col, val)  { st.filters.push({ op:'eq', col, val }); return b; },
    neq(col, val) { st.filters.push({ op:'neq', col, val }); return b; },
    in(col, val)  { st.filters.push({ op:'in', col, val }); return b; },
    not(col, op, val) { if (op === 'is' && val === null) st.filters.push({ op:'notnull', col }); return b; },
    gte(col, val) { st.filters.push({ op:'gte', col, val }); return b; },
    lte(col, val) { st.filters.push({ op:'lte', col, val }); return b; },
    order(col, o) { st.orderCol = col; st.orderAsc = !o || o.ascending !== false; return b; },
    limit(n)      { st.limitN = n; return b; },
    insert(rows)  { st.action = 'insert'; st.rows = rows; return b; },
    update(obj)   { st.action = 'update'; st.updateObj = obj; return b; },
    delete()      { st.action = 'delete'; return b; },
    maybeSingle() { const r = run(); return Promise.resolve({ data: (r.data && r.data[0]) || null, error: r.error || null }); },
    single()      { return b.maybeSingle(); },
    then(res, rej) { try { const r = run(); return res(r); } catch (e) { return rej ? rej(e) : res({ data:null, error:{ message:String(e) } }); } },
  };
  const origSelect = b.select;
  b.select = function (cols, opts) { if (st.action === 'insert') st.returnRows = true; return origSelect(cols, opts); };
  return b;
}
window.supabase = {
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'u-me', email: 'me@x.com' }, access_token: 't' } } }),
      signOut: async () => ({}),
    },
    from: (table) => makeBuilder(table),
    rpc: async () => ({ data: null, error: null }),
  }),
};
`;

const results = [];
const check = (label, ok, detail = '') => { results.push({ label, ok, detail }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/net::|Failed to load|lucide/i.test(m.text())) pageErrors.push(m.text()); });

await page.route('**/*', async route => {
  const url = route.request().url();
  if (url.includes('supabase-js')) return route.fulfill({ contentType: 'application/javascript', body: stubSource });
  if (url.includes('unpkg.com') || url.includes('cdn.jsdelivr')) return route.fulfill({ contentType: 'application/javascript', body: 'window.lucide={createIcons(){}};' });
  if (url.startsWith('file://')) return route.continue();
  return route.abort();
});

await page.goto('file://' + path.join(ROOT, 'lancamentos.html'));
await page.waitForTimeout(900);

const rows0 = await page.locator('#tx-tbody tr[data-id]').count();
check('4 lançamentos carregados no mês', rows0 === 4, `${rows0}`);
check('barra de ações em massa começa escondida', !(await page.locator('#bulk-actions-bar').isVisible()));

/* ── 1. Marcar 2 checkboxes individualmente ── */
await page.locator('#tx-tbody tr[data-id="tx-1"] .tx-select-checkbox').check();
await page.locator('#tx-tbody tr[data-id="tx-2"] .tx-select-checkbox').check();
check('barra de ações em massa aparece com 2 selecionados', /2 selecionado/.test(await page.locator('#bulk-actions-count').textContent()));
check('"selecionar tudo" fica indeterminado (parcial)', await page.locator('#tx-select-all').evaluate(el => el.indeterminate));

/* ── 2. Desmarcar um, "Limpar seleção" zera tudo ── */
await page.click('#btn-bulk-clear');
check('limpar seleção esconde a barra', !(await page.locator('#bulk-actions-bar').isVisible()));
check('checkboxes desmarcados após limpar', !(await page.locator('#tx-tbody tr[data-id="tx-1"] .tx-select-checkbox').isChecked()));

/* ── 3. "Selecionar tudo" marca todas as linhas visíveis ── */
await page.check('#tx-select-all');
check('selecionar tudo marca as 4 linhas', /4 selecionado/.test(await page.locator('#bulk-actions-count').textContent()));
const allChecked = await page.$$eval('#tx-tbody .tx-select-checkbox', els => els.every(el => el.checked));
check('todas as checkboxes ficam marcadas', allChecked);

/* Desmarca o pagamento de fatura (tx-pay) pra excluir só 3 primeiro, valida exclusão simples em massa */
await page.locator('#tx-tbody tr[data-id="tx-pay"] .tx-select-checkbox').uncheck();
check('barra mostra 3 selecionados após desmarcar 1', /3 selecionado/.test(await page.locator('#bulk-actions-count').textContent()));

await page.click('#btn-bulk-delete');
check('modal de confirmação em massa abre', await page.locator('#modal-bulk-delete').isVisible());
check('modal avisa "3 lançamentos"', /3 lançamentos/.test(await page.locator('#bulk-delete-desc-preview').textContent()));
await page.click('#modal-bulk-delete-confirm');
await page.waitForTimeout(400);

const remaining = await page.evaluate(() => window.__db.transactions.map(t => t.id));
check('as 3 linhas selecionadas foram excluídas do banco', !remaining.includes('tx-1') && !remaining.includes('tx-2') && !remaining.includes('tx-3'));
check('o pagamento de fatura (não selecionado) continua no banco', remaining.includes('tx-pay'));
check('seleção zera após excluir em massa', !(await page.locator('#bulk-actions-bar').isVisible()));

/* ── 4. Excluir em massa um pagamento de fatura (is_ignored) derruba invoice_payments e reconcilia ── */
await page.locator('#tx-tbody tr[data-id="tx-pay"] .tx-select-checkbox').check();
await page.click('#btn-bulk-delete');
await page.click('#modal-bulk-delete-confirm');
await page.waitForTimeout(400);

const paysAfter = await page.evaluate(() => window.__db.invoice_payments);
check('invoice_payments do pagamento excluído em massa some junto', paysAfter.length === 0, JSON.stringify(paysAfter));
const invAfter = await page.evaluate(() => window.__db.invoices.find(i => i.id === 'inv-1'));
check('fatura volta a "closed" (reconciliada) após excluir o pagamento em massa', invAfter.status === 'closed', invAfter.status);

check('nenhum erro de JS na página', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();

const fails = results.filter(r => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} checagens passaram.`);
if (fails.length) process.exit(1);
