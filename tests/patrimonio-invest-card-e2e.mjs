// Smoke test E2E do card de Investimentos no detalhe da conta (patrimonio.html).
// Verifica que o card tem o mesmo formato do widget de cartão, aparece lado a
// lado com ele no mesmo grid, e que clicar nele abre a página de
// investimentos (PAT-07) filtrada para aquela conta — com "Voltar" retornando
// para o detalhe da conta (não para a visão geral).
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const stubSource = `
window.__db = {
  households: [{ id: 'hh-1', name: 'Casal Teste' }],
  members: [{ id: 'm-me', household_id: 'hh-1', user_id: 'u-me', name: 'Matheus', role: 'primary' }],
  accounts: [
    { id: 'acc-1', household_id: 'hh-1', name: 'Nubank', account_type: 'checking', owner_type: 'joint', member_id: null, balance: 5000, is_active: true, created_at: '2026-01-01' },
  ],
  credit_cards: [
    { id: 'card-1', account_id: 'acc-1', name: 'Nubank Cartão', closing_day: 5, due_day: 15, credit_limit: 10000, created_at: '2026-01-01' },
  ],
  investment_positions: [
    { id: 'pos-1', household_id: 'hh-1', account_id: 'acc-1', tipo: 'CDB', name: 'CDB Liquidez Diária', valor_aplicado: 3000, rendimento_acumulado: 100, taxa: 0.009, vencimento: null, linked_card_id: null, created_at: '2026-01-01' },
    { id: 'pos-2', household_id: 'hh-1', account_id: 'acc-1', tipo: 'libera_limite_cartao', name: 'Reforço de limite', valor_aplicado: 2000, rendimento_acumulado: 0, taxa: 0, vencimento: null, linked_card_id: 'card-1', created_at: '2026-01-02' },
  ],
  transactions: [],
  loans: [],
  assets: [],
  invoices: [],
  invoice_payments: [],
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
      const inserted = rows.map(r => ({ id: uuid(), ...r }));
      arr.push(...inserted);
      return { data: st.returnRows ? inserted : null, error: null };
    }
    let sel = arr.filter(r => matches(r, st.filters));
    if (st.action === 'update') { sel.forEach(r => Object.assign(r, st.updateObj)); return { data: null, error: null }; }
    if (st.action === 'delete') { window.__db[st.table] = arr.filter(r => !matches(r, st.filters)); return { data: null, error: null }; }
    if (st.orderCol) sel = sel.slice().sort((a,b) => (a[st.orderCol] > b[st.orderCol] ? 1 : -1) * (st.orderAsc ? 1 : -1));
    if (st.limitN) sel = sel.slice(0, st.limitN);
    return { data: sel, error: null };
  };
  const b = {
    select() { return b; },
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
  b.select = function () { if (st.action === 'insert') st.returnRows = true; return origSelect(); };
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

await page.goto('file://' + path.join(ROOT, 'patrimonio.html'));
await page.waitForTimeout(900);

await page.evaluate(() => window.openDetail('acc-1'));
await page.waitForTimeout(200);

check('detalhe da conta abriu', await page.locator('#detail-view').isVisible());

const cardClasses = await page.$$eval('#detail-cards > *', els => els.map(el => el.className));
check('2 itens no grid de #detail-cards (cartão + investimentos)', cardClasses.length === 2, JSON.stringify(cardClasses));
check('ambos os itens têm a classe cc-widget (mesmo formato retangular)',
  cardClasses.every(c => /\bcc-widget\b/.test(c)), JSON.stringify(cardClasses));

const investTotal = await page.locator('#detail-cards .invest-card-stats').locator('.invest-card-stat-value').first().textContent();
check('card de investimentos mostra Total investido = R$ 5.000,00 (3000 + 2000)', /5\.000,00/.test(investTotal), investTotal);

// clicar no card de investimentos (2º item do grid)
await page.locator('#detail-cards > *').nth(1).click();
await page.waitForTimeout(200);

check('página de investimentos abriu', await page.locator('#investments-view').isVisible());
check('detalhe da conta ficou escondido', !(await page.locator('#detail-view').isVisible()));
const title = await page.locator('#investments-title').textContent();
check('título mostra o nome da conta', /Nubank/.test(title), title);
const posRows = await page.locator('#investments-positions-list .panel-row').count();
check('lista mostra as 2 posições de investimento da conta', posRows === 2, `${posRows}`);
const linkedBadge = await page.locator('#investments-positions-list').textContent();
check('posição "libera limite" mostra o cartão vinculado', /libera limite/i.test(linkedBadge) && /Nubank Cartão/.test(linkedBadge));

// Voltar deve retornar para o DETALHE DA CONTA, não para a visão geral
await page.click('#btn-back-investments');
await page.waitForTimeout(200);
check('"Voltar" retorna para o detalhe da conta (não para a visão geral)',
  await page.locator('#detail-view').isVisible() && !(await page.locator('#overview-view').isVisible()));

check('nenhum erro de JS na página', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();

const fails = results.filter(r => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} checagens passaram.`);
if (fails.length) process.exit(1);
