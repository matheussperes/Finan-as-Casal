/* Testes do parser de importação OFX/CSV (Sprint 7 — LAN-05).
   Roda com `npm test` (node --test), sem dependências. */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const P = require('../js/import-parser.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8');

/* ── parseAmount: formatos de valor ── */
test('parseAmount cobre formatos BR e internacionais', () => {
  assert.equal(P.parseAmount('1.234,56'), 1234.56);
  assert.equal(P.parseAmount('1234.56'), 1234.56);
  assert.equal(P.parseAmount('-1234,56'), -1234.56);
  assert.equal(P.parseAmount('R$ 1.234,56'), 1234.56);
  assert.equal(P.parseAmount('(123,45)'), -123.45);
  assert.equal(P.parseAmount('1,234.56'), 1234.56);
  assert.equal(P.parseAmount('1.234'), 1234);      // ponto de milhar
  assert.equal(P.parseAmount('12.34'), 12.34);     // ponto decimal
  assert.equal(P.parseAmount('0,5'), 0.5);
  assert.equal(P.parseAmount('abc'), null);
  assert.equal(P.parseAmount(''), null);
});

/* ── datas ── */
test('parseOFXDate aceita data pura, com hora e com timezone', () => {
  assert.equal(P.parseOFXDate('20260715'), '2026-07-15');
  assert.equal(P.parseOFXDate('20260715120000'), '2026-07-15');
  assert.equal(P.parseOFXDate('20260715120000[-3:BRT]'), '2026-07-15');
  assert.equal(P.parseOFXDate('2026-07-15'), null);
  assert.equal(P.parseOFXDate('20261315'), null); // mês 13
});

/* ── OFX ── */
test('parseOFX lê o extrato de conta de exemplo', () => {
  const r = P.parseOFX(fixture('extrato-conta.ofx'));
  assert.equal(r.source, 'bank');
  assert.equal(r.transactions.length, 5);

  const [uber1, aluguel, salario] = r.transactions;
  assert.deepEqual(
    { date: uber1.date, amount: uber1.amount, fitid: uber1.fitid },
    { date: '2026-07-02', amount: -45.9, fitid: '2026070201' }
  );
  // TRNAMT com vírgula decimal (banco BR)
  assert.equal(aluguel.amount, -1234.56);
  // NAME + MEMO concatenados
  assert.match(aluguel.description, /ALUGUEL APARTAMENTO PIX ENVIADO/);
  assert.equal(salario.amount, 8500);
});

test('parseOFX detecta fatura de cartão (CREDITCARDMSGSRSV1)', () => {
  const ofx = `<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260710
<TRNAMT>99.90
<FITID>c1
<NAME>LOJA X
</STMTTRN>
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
  const r = P.parseOFX(ofx);
  assert.equal(r.source, 'card');
  assert.equal(r.transactions.length, 1);
  assert.equal(r.transactions[0].amount, 99.9);
});

/* ── CSV ── */
test('parseCSV: fatura de cartão com ; e vírgula decimal (DD/MM/YYYY)', () => {
  const r = P.parseCSV(fixture('fatura-cartao.csv'));
  assert.equal(r.delimiter, ';');
  assert.equal(r.transactions.length, 6);
  assert.equal(r.transactions[0].date, '2026-07-02');
  assert.equal(r.transactions[0].amount, 56.9);
  assert.equal(r.transactions[4].amount, -1500); // pagamento (com milhar 1.500,00)
});

test('parseCSV: extrato estilo Nubank com , e ponto decimal + campo com aspas', () => {
  const r = P.parseCSV(fixture('extrato-conta.csv'));
  assert.equal(r.delimiter, ',');
  assert.equal(r.transactions.length, 5);
  assert.equal(r.transactions[0].amount, -120.5);
  assert.equal(r.transactions[0].fitid, 'abc-001'); // coluna Identificador
  // vírgula DENTRO de aspas não quebra a linha
  assert.match(r.transactions[3].description, /Maria, Escola/);
});

test('parseCSV: colunas separadas de débito/crédito', () => {
  const csv = 'Data;Historico;Debito;Credito\n05/07/2026;CONTA DE LUZ;180,55;\n06/07/2026;PIX RECEBIDO;;300,00\n';
  const r = P.parseCSV(csv);
  assert.equal(r.transactions.length, 2);
  assert.equal(r.transactions[0].amount, -180.55);
  assert.equal(r.transactions[1].amount, 300);
});

test('parseCSV: sem cabeçalho, infere colunas pelo conteúdo', () => {
  const csv = '02/07/2026;MERCADO LIVRE;-59,90\n03/07/2026;FARMACIA SAO JOAO;-34,20\n';
  const r = P.parseCSV(csv);
  assert.equal(r.transactions.length, 2);
  assert.equal(r.transactions[0].date, '2026-07-02');
  assert.equal(r.transactions[0].amount, -59.9);
  assert.equal(r.transactions[0].description, 'MERCADO LIVRE');
});

test('parseCSV: datas MM/DD detectadas quando o segundo componente passa de 12', () => {
  const csv = 'Date,Description,Amount\n07/15/2026,STARBUCKS,-8.50\n07/03/2026,MARKET,-12.00\n';
  const r = P.parseCSV(csv);
  assert.equal(r.transactions[0].date, '2026-07-15');
  assert.equal(r.transactions[1].date, '2026-07-03');
});

test('parseCSV: DD/MM é o padrão quando tudo é ambíguo', () => {
  const csv = 'Data;Descricao;Valor\n03/07/2026;ALGO;-10,00\n';
  const r = P.parseCSV(csv);
  assert.equal(r.transactions[0].date, '2026-07-03');
});

test('parseCSV: linhas quebradas viram erro, não lançamento', () => {
  const csv = 'Data;Descricao;Valor\n03/07/2026;OK;-10,00\nlinha invalida sem nada\n04/07/2026;;;\n';
  const r = P.parseCSV(csv);
  assert.equal(r.transactions.length, 1);
  assert.equal(r.errors.length, 2);
});

/* ── parseFile: dispatcher ── */
test('parseFile roteia por extensão e conteúdo', () => {
  assert.equal(P.parseFile('extrato.ofx', fixture('extrato-conta.ofx')).kind, 'ofx');
  assert.equal(P.parseFile('fatura.csv', fixture('fatura-cartao.csv')).kind, 'csv');
  assert.equal(P.parseFile('foto.pdf', '%PDF-').kind, 'unknown');
});

/* ── fingerprint: dedup ── */
test('fingerprint usa FITID quando existe e é estável entre re-importações', () => {
  const tx = { date: '2026-07-02', amount: -45.9, description: 'UBER *TRIP 0702', fitid: '2026070201' };
  const f1 = P.fingerprint(tx, 'acc-1', new Map());
  const f2 = P.fingerprint(tx, 'acc-1', new Map());
  assert.equal(f1, f2);
  assert.match(f1, /^id:acc-1:2026070201$/);
  // mesmo lançamento em OUTRA conta não colide
  assert.notEqual(f1, P.fingerprint(tx, 'acc-2', new Map()));
});

test('fingerprint sem id externo usa data+valor+descrição normalizada', () => {
  const tx = { date: '2026-07-10', amount: -89.9, description: 'PADARIA STELLA 10/07', fitid: null };
  const f = P.fingerprint(tx, 'acc-1', new Map());
  assert.match(f, /^tx:acc-1:2026-07-10:89.90:d:padaria stella$/);
});

test('fingerprint desambigua linhas idênticas no MESMO arquivo, estável entre arquivos', () => {
  const tx = { date: '2026-07-10', amount: -5, description: 'CAFE', fitid: null };
  const seenA = new Map();
  const a1 = P.fingerprint(tx, 'acc-1', seenA);
  const a2 = P.fingerprint(tx, 'acc-1', seenA);
  assert.notEqual(a1, a2);
  assert.match(a2, /#2$/);
  // re-importar o mesmo arquivo gera os MESMOS fingerprints (dedup funciona)
  const seenB = new Map();
  assert.equal(P.fingerprint(tx, 'acc-1', seenB), a1);
  assert.equal(P.fingerprint(tx, 'acc-1', seenB), a2);
});

/* ── categorização aprendida ── */
const history = [
  { description: 'UBER *TRIP 0601', classification: 'Transporte' },
  { description: 'UBER *TRIP 0615', classification: 'Transporte' },
  { description: 'PADARIA STELLA', classification: 'Alimentação' },
  { description: 'AMAZON BR', classification: 'Compras' },
  { description: 'AMAZON BR', classification: 'Presentes' },
  { description: 'POSTO SHELL', classification: 'Classificação neutra' },   // neutra não ensina
  { description: 'IFOOD *X', classification: 'Alimentação', needs_category_review: true }, // pendente não ensina
];

test('origem já categorizada vem preenchida sem perguntar (confident)', () => {
  const model = P.buildCategoryModel(history);
  const s = P.suggestCategory(model, 'UBER *TRIP 0702');
  assert.deepEqual(s, { classification: 'Transporte', confident: true });
  // uma única ocorrência também basta
  const s2 = P.suggestCategory(model, 'Padaria Stella 12/07');
  assert.deepEqual(s2, { classification: 'Alimentação', confident: true });
});

test('histórico conflitante pergunta em vez de chutar', () => {
  const model = P.buildCategoryModel(history);
  const s = P.suggestCategory(model, 'AMAZON BR');
  assert.equal(s.confident, false);
  assert.ok(['Compras', 'Presentes'].includes(s.classification));
});

test('origem desconhecida e neutra/pendente vão para a fila', () => {
  const model = P.buildCategoryModel(history);
  assert.deepEqual(P.suggestCategory(model, 'LOJA NUNCA VISTA'), { classification: null, confident: false });
  assert.deepEqual(P.suggestCategory(model, 'POSTO SHELL'), { classification: null, confident: false });
  assert.deepEqual(P.suggestCategory(model, 'IFOOD *X'), { classification: null, confident: false });
});

test('consistência ≥80% mantém confiança mesmo com um desvio antigo', () => {
  const h = [
    ...Array(8).fill({ description: 'SPOTIFY', classification: 'Assinaturas' }),
    { description: 'SPOTIFY', classification: 'Lazer' },
  ];
  const s = P.suggestCategory(P.buildCategoryModel(h), 'SPOTIFY');
  assert.deepEqual(s, { classification: 'Assinaturas', confident: true });
});

/* ── normalizeKey ── */
test('normalizeKey ignora números, acentos e pontuação', () => {
  assert.equal(P.normalizeKey('UBER *TRIP 1234'), 'uber trip');
  assert.equal(P.normalizeKey('Pão de Açúcar 05/07'), 'pao de acucar');
  assert.equal(P.normalizeKey('NETFLIX.COM'), 'netflix com');
});
