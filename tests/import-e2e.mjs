// Smoke test E2E da importação OFX/CSV (Sprint 7 — LAN-05).
// Carrega lancamentos.html num Chromium headless com um stub do Supabase em
// memória e dirige o fluxo real da página: upload → preview → confirmar,
// dedup na 2ª importação, fila "Confirmar categoria", e import de cartão.
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const ofx = readFileSync(path.join(__dirname, 'fixtures', 'extrato-conta.ofx'), 'utf-8');
const csvCard = readFileSync(path.join(__dirname, 'fixtures', 'fatura-cartao.csv'), 'utf-8');
const ofxCardCredits = readFileSync(path.join(__dirname, 'fixtures', 'fatura-cartao-creditos.ofx'), 'utf-8');

/* Stub do Supabase: DB em memória com um query-builder thenable que cobre os
   encadeamentos usados pela página (select/eq/in/gte/lte/order/limit/insert/
   update/maybeSingle + count head), incluindo o índice único de dedup. */
const stubSource = `
window.__db = {
  households: [{ id: 'hh-1', name: 'Casal Teste' }],
  members: [{ id: 'm-me', household_id: 'hh-1', user_id: 'u-me', name: 'Matheus', role: 'primary' }],
  accounts: [{ id: 'acc-1', household_id: 'hh-1', name: 'Nubank', account_type: 'checking', owner_type: 'joint', member_id: null, balance: 5000, is_active: true, created_at: '2026-01-01' }],
  credit_cards: [{ id: 'card-1', account_id: 'acc-1', name: 'Nubank Cartão', closing_day: 5, due_day: 15, credit_limit: 10000, created_at: '2026-01-01' }],
  categories: (() => {
    // Categorias de topo (Ajuste 3: 2 níveis) + subcategorias usadas no teste.
    const tops = ['Renda','Despesas obrigatórias','Classificação neutra','Transporte','Alimentação','Moradia','Lazer','Investimentos','Aporte reserva de emergência']
      .map((name, i) => ({ id: 'cat-' + i, household_id: 'hh-1', name, parent_id: null, sort_order: i, essencial: false, created_at: '2026-01-0' + (i+1) }));
    const subsByParent = {
      'cat-0': ['Salário', 'Geral'],
      'cat-1': ['Geral'],
      'cat-2': ['Geral'],
      'cat-3': ['App', 'Geral'],
      'cat-4': ['Restaurante', 'Padaria', 'Geral'],
      'cat-5': ['Aluguel', 'Geral'],
      'cat-6': ['Geral'],
      'cat-7': ['Geral'],
      'cat-8': ['Geral'],
    };
    const subs = [];
    let n = 0;
    for (const [parentId, names] of Object.entries(subsByParent)) {
      names.forEach(name => subs.push({ id: 'sub-' + (n++), household_id: 'hh-1', name, parent_id: parentId, sort_order: 0, essencial: false, created_at: '2026-01-02' }));
    }
    return [...tops, ...subs];
  })(),
  invoices: [],
  invoice_payments: [],
  investment_positions: [],
  transactions: [
    // histórico que ensina a categorização (origem já categorizada, com subcategoria)
    { id: 't1', household_id: 'hh-1', description: 'UBER *TRIP 0601', classification: 'Transporte', subcategory: 'App', direction: 'expense', amount: 30, date: '2026-06-01', needs_category_review: false },
    { id: 't2', household_id: 'hh-1', description: 'UBER *TRIP 0620', classification: 'Transporte', subcategory: 'App', direction: 'expense', amount: 25, date: '2026-06-20', needs_category_review: false },
    { id: 't3', household_id: 'hh-1', description: 'ALUGUEL APARTAMENTO PIX ENVIADO IMOBILIARIA CENTRAL', classification: 'Moradia', subcategory: 'Aluguel', direction: 'expense', amount: 1234.56, date: '2026-06-03', needs_category_review: false },
    { id: 't4', household_id: 'hh-1', description: 'SALARIO EMPRESA XYZ', classification: 'Renda', subcategory: 'Salário', direction: 'income', amount: 8500, date: '2026-06-05', needs_category_review: false },
    { id: 't5', household_id: 'hh-1', description: 'IFOOD *RESTAURANTE BOM', classification: 'Alimentação', subcategory: 'Restaurante', direction: 'expense', amount: 40, date: '2026-06-10', needs_category_review: false },
    // PADARIA STELLA NÃO ensinada de propósito → vai para a fila
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
      // índice único (household_id, import_fingerprint)
      for (const r of rows) {
        if (r.import_fingerprint != null &&
            arr.some(x => x.household_id === r.household_id && x.import_fingerprint === r.import_fingerprint)) {
          return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
      }
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
    then(res, rej) { try { const r = run(); if (st.returnRows === false && st.action==='insert') return res(r); return res(r); } catch (e) { return rej ? rej(e) : res({ data:null, error:{ message:String(e) } }); } },
  };
  // insert(...).select() deve devolver as linhas inseridas
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

// Helper para injetar um arquivo no <input type=file>
async function setFile(name, content) {
  await page.setInputFiles('#import-file', { name, mimeType: 'text/plain', buffer: Buffer.from(content, 'utf-8') });
  await page.waitForTimeout(150);
}

/* ── 1. Importar OFX de conta ── */
await page.click('#btn-import');
await page.waitForTimeout(150);
check('modal de importação abre', await page.locator('#modal-import').isVisible());
await page.selectOption('#import-account', 'acc-1');
await setFile('extrato-conta.ofx', ofx);
check('botão "Ler arquivo" habilita após escolher arquivo', !(await page.locator('#btn-import-parse').isDisabled()));
await page.click('#btn-import-parse');
await page.waitForTimeout(300);

const previewRows = await page.locator('#import-preview-body tr').count();
check('preview mostra 5 lançamentos do OFX', previewRows === 5, `${previewRows} linhas`);
const summary = await page.locator('#import-summary').textContent();
check('resumo: 5 novos', /5 novo/.test(summary), summary.trim());
check('resumo: 0 duplicados', /0 duplicado/.test(summary));
check('resumo: 1 sem categoria (Padaria não ensinada)', /1 sem categoria/.test(summary));

// Categoria E subcategoria sugeridas com confiança para o Uber (origem já vista)
const uberCat = await page.$eval('#import-preview-body tr:first-child .imp-cat-select[data-role="cat"]', el => el.value).catch(() => null);
const uberSub = await page.$eval('#import-preview-body tr:first-child .imp-cat-select[data-role="sub"]', el => el.value).catch(() => null);
check('Uber vem pré-categorizado como Transporte', uberCat === 'Transporte', String(uberCat));
check('Uber vem com subcategoria App (Ajuste 3 — 2 níveis)', uberSub === 'App', String(uberSub));

// Estabelecimento preenchido no preview (coluna 3 = input establishment)
const uberEst = await page.$eval('#import-preview-body tr:first-child .imp-edit[data-f="establishment"]', el => el.value).catch(() => null);
check('estabelecimento preenchido no preview', uberEst === 'UBER *TRIP 0702', String(uberEst));

// Editar a descrição do Uber antes de confirmar (deve persistir)
await page.fill('#import-preview-body tr:first-child .imp-edit[data-f="description"]', 'UBER CORRIGIDO NA VALIDACAO');

await page.click('#btn-import-confirm');
await page.waitForTimeout(400);

const imported = await page.evaluate(() => window.__db.transactions.filter(t => t.source && t.source.startsWith('import')));
check('5 lançamentos importados no banco', imported.length === 5, `${imported.length}`);
const salario = imported.find(t => /SALARIO/.test(t.description));
check('Salário importado como entrada (income)', salario && salario.direction === 'income', salario && salario.direction);
const aluguel = imported.find(t => /ALUGUEL/.test(t.description));
check('Aluguel importado como saída (expense), categoria Moradia e subcategoria Aluguel',
  aluguel && aluguel.direction === 'expense' && aluguel.classification === 'Moradia' && aluguel.subcategory === 'Aluguel');
check('estabelecimento gravado na transação', aluguel && aluguel.establishment === 'ALUGUEL APARTAMENTO', aluguel && aluguel.establishment);
const uberEdited = imported.find(t => t.establishment === 'UBER *TRIP 0702' && t.date === '2026-07-02');
check('descrição editada no preview foi persistida', uberEdited && uberEdited.description === 'UBER CORRIGIDO NA VALIDACAO', uberEdited && uberEdited.description);
const padaria = imported.find(t => /PADARIA/.test(t.description));
check('Padaria caiu na fila (needs_category_review + neutra)', padaria && padaria.needs_category_review === true && padaria.classification === 'Classificação neutra');
check('todos os importados têm import_fingerprint', imported.every(t => !!t.import_fingerprint));

/* ── 2. Reimportar o MESMO OFX → tudo duplicado ── */
await page.click('#btn-import');
await page.waitForTimeout(150);
await page.selectOption('#import-account', 'acc-1');
await setFile('extrato-conta.ofx', ofx);
await page.click('#btn-import-parse');
await page.waitForTimeout(300);
const summary2 = await page.locator('#import-summary').textContent();
check('reimportação detecta 5 duplicados', /5 duplicado/.test(summary2), summary2.trim());
check('reimportação mostra 0 novos', /0 novo/.test(summary2));
check('botão importar desabilitado quando nada novo', await page.locator('#btn-import-confirm').isDisabled());
await page.click('#btn-import-back');
await page.click('#modal-import-cancel');
const countAfterReimport = await page.evaluate(() => window.__db.transactions.filter(t => t.source && t.source.startsWith('import')).length);
check('nenhuma linha nova criada na reimportação', countAfterReimport === 5, `${countAfterReimport}`);

/* ── 3. Fila "Confirmar categoria" ── */
check('banner de revisão visível', await page.locator('#review-banner').isVisible());
const bannerTxt = await page.locator('#review-banner-count').textContent();
check('banner conta 1 lançamento', /1 lançamento/.test(bannerTxt), bannerTxt);
await page.click('#btn-open-review');
await page.waitForTimeout(200);
const reviewRows = await page.locator('#review-body tr').count();
check('modal de revisão lista 1 item', reviewRows === 1, `${reviewRows}`);
await page.selectOption('#review-body tr:first-child .imp-cat-select[data-role="cat"]', 'Alimentação');
await page.selectOption('#review-body tr:first-child .imp-cat-select[data-role="sub"]', 'Padaria');
await page.click('#btn-review-save');
await page.waitForTimeout(300);
const padariaAfter = await page.evaluate(() => window.__db.transactions.find(t => /PADARIA/.test(t.description)));
check('após revisão, Padaria = Alimentação/Padaria e sem review',
  padariaAfter.classification === 'Alimentação' && padariaAfter.subcategory === 'Padaria' && padariaAfter.needs_category_review === false);
check('banner some quando a fila esvazia', !(await page.locator('#review-banner').isVisible()));

/* ── 4. Importar CSV de fatura de cartão (Ajuste 1 — bug: crédito era descartado) ──
   fatura-cartao.csv: 5 linhas positivas (compras) + 1 negativa (-1.500,00,
   "PAGAMENTO RECEBIDO" = crédito). Convenção explícita do cartão: sem sinal
   = compra/saída; "−" na frente = crédito/entrada. TODAS devem ser lançadas. */
await page.click('#btn-import');
await page.waitForTimeout(150);
await page.click('.import-dest-btn[data-dest="card"]');
await page.selectOption('#import-card', 'card-1');
await setFile('fatura-cartao.csv', csvCard);
await page.click('#btn-import-parse');
await page.waitForTimeout(300);
const cardSummary = await page.locator('#import-summary').textContent();
check('CSV de cartão: 6 novos (5 compras + 1 crédito, nenhum descartado)', /6 novo/.test(cardSummary), cardSummary.trim());
check('resumo avisa 1 crédito do cartão que abate a fatura', /1 crédito.*abatem a fatura/i.test(cardSummary), cardSummary.trim());
await page.click('#btn-import-confirm');
await page.waitForTimeout(400);
const cardTx = await page.evaluate(() => window.__db.transactions.filter(t => t.credit_card_id === 'card-1'));
check('as 6 linhas foram importadas — crédito NÃO foi descartado (bug corrigido)', cardTx.length === 6, `${cardTx.length}`);
const creditTx = cardTx.find(t => t.description.includes('PAGAMENTO RECEBIDO'));
check('crédito (valor negativo) importado como entrada (income)', creditTx && creditTx.direction === 'income', creditTx && creditTx.direction);
check('compras (sem sinal) importadas como saída (expense)', cardTx.filter(t => t.direction === 'expense').length === 5);
check('todas as linhas do cartão têm invoice_id (compra e crédito)', cardTx.every(t => t.invoice_id));
const invoicesCreated = await page.evaluate(() => window.__db.invoices.length);
check('faturas foram criadas', invoicesCreated >= 1, `${invoicesCreated}`);

/* ── 5. Fatura de cartão com créditos explícitos (estorno/IOF devolvido) ──
   fatura-cartao-creditos.ofx: 4 compras (sem sinal) + 2 créditos ("−"). */
await page.evaluate(() => { window.__db.transactions = window.__db.transactions.filter(t => t.credit_card_id !== 'card-1'); });
await page.click('#btn-import');
await page.waitForTimeout(150);
await page.click('.import-dest-btn[data-dest="card"]');
await page.selectOption('#import-card', 'card-1');
await setFile('fatura-cartao-creditos.ofx', ofxCardCredits);
await page.click('#btn-import-parse');
await page.waitForTimeout(300);
const dirLabels = await page.$$eval('#import-preview-body .imp-dir', els => els.map(e => e.textContent.trim()));
const saidas = dirLabels.filter(l => l === 'Saída').length;
const entradas = dirLabels.filter(l => l === 'Entrada').length;
check('4 compras aparecem como Saída e 2 créditos como Entrada', saidas === 4 && entradas === 2, `${saidas} saídas, ${entradas} entradas`);
await page.click('#btn-import-confirm');
await page.waitForTimeout(400);
const cardCreditTx = await page.evaluate(() => window.__db.transactions.filter(t => t.credit_card_id === 'card-1'));
check('todas as 6 linhas importadas (nenhum crédito descartado)', cardCreditTx.length === 6, `${cardCreditTx.length}`);
check('4 compras como expense', cardCreditTx.filter(t => t.direction === 'expense').length === 4);
check('2 créditos (estorno/IOF) como income', cardCreditTx.filter(t => t.direction === 'income').length === 2);
const estorno = cardCreditTx.find(t => /ESTORNO/.test(t.description));
check('estorno abate a fatura (entra como income vinculado à invoice)', estorno && estorno.direction === 'income' && !!estorno.invoice_id);

/* ── 6. Caminho de reimportação (Ajuste 1) ──
   Simula o estado ANTERIOR ao bug corrigido: um casal já tinha importado
   esta fatura quando o sistema descartava créditos, então só as 4 compras
   estão no banco (com o import_fingerprint que o parser gera de verdade —
   FITID). Reimportar o MESMO arquivo deve: reconhecer as 4 compras como
   duplicadas (não duplicar) e trazer só os 2 créditos que faltavam. */
await page.evaluate(() => {
  window.__db.transactions = window.__db.transactions.filter(t => t.credit_card_id !== 'card-1');
  const preExisting = [
    { fitid: 'c2026070201', amount: 56.90 },
    { fitid: 'c2026070501', amount: 250.00 },
    { fitid: 'c2026070801', amount: 44.90 },
    { fitid: 'c2026071001', amount: 189.99 },
  ];
  preExisting.forEach((r, i) => {
    window.__db.transactions.push({
      id: 'old-' + i, household_id: 'hh-1', account_id: 'acc-1', credit_card_id: 'card-1',
      direction: 'expense', amount: r.amount, date: '2026-07-0' + (i + 2),
      description: 'compra antiga', classification: 'Classificação neutra',
      source: 'import_ofx', import_fingerprint: 'id:card-1:' + r.fitid, needs_category_review: true,
    });
  });
});
await page.click('#btn-import');
await page.waitForTimeout(150);
await page.click('.import-dest-btn[data-dest="card"]');
await page.selectOption('#import-card', 'card-1');
await setFile('fatura-cartao-creditos.ofx', ofxCardCredits);
await page.click('#btn-import-parse');
await page.waitForTimeout(300);
const reimportSummary = await page.locator('#import-summary').textContent();
check('reimportação reconhece as 4 compras antigas como duplicadas', /4 duplicado/.test(reimportSummary), reimportSummary.trim());
check('reimportação traz só os 2 créditos que faltavam como novos', /2 novo/.test(reimportSummary), reimportSummary.trim());
await page.click('#btn-import-confirm');
await page.waitForTimeout(400);
const afterReimport = await page.evaluate(() => window.__db.transactions.filter(t => t.credit_card_id === 'card-1'));
check('total final = 6 (4 antigas + 2 créditos recuperados, sem duplicar)', afterReimport.length === 6, `${afterReimport.length}`);
check('créditos recuperados entraram como income', afterReimport.filter(t => t.direction === 'income').length === 2);

if (pageErrors.length) { console.log('\nErros de página:'); pageErrors.forEach(e => console.log('  ' + e)); }
await browser.close();

const fails = results.filter(r => !r.ok).length + (pageErrors.length ? 1 : 0);
console.log(`\n${results.filter(r => r.ok).length}/${results.length} checagens passaram.`);
process.exit(fails ? 1 : 0);
