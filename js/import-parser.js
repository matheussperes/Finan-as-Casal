/* ══════════════════════════════════════════════════════════════════════
   import-parser.js  (Sprint 7 — LAN-05)
   Parser puro de extratos OFX/CSV + categorização aprendida do histórico.
   Sem I/O, sem Supabase: recebe texto/linhas, devolve lançamentos
   normalizados — testável isolado (tests/import-parser.test.js) e usado
   por lancamentos.html via <script src>.

   Convenções de saída:
   - date   : 'YYYY-MM-DD'
   - amount : Number COM SINAL (negativo = saída no extrato de conta;
              em fatura de cartão, positivo = compra). Quem decide a
              direction final é a página, conforme o destino.
   - knownDirection: 'expense'|'income'|null — quando o CSV tem colunas
              Débito/Crédito separadas, a direção já é inequívoca (não
              depende da origem) e vem pré-computada aqui; amount nesse
              caso é sempre positivo. null quando a direção depende da
              convenção por origem (coluna única de valor com sinal, ou OFX).
   - description: texto original limpo (colapsa espaços)
   ══════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.ImportParser = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ────────────────────────────────────────────
     Decodificação de arquivo (OFX de banco BR é
     frequentemente Windows-1252/Latin-1)
  ───────────────────────────────────────────── */
  function decodeBuffer(arrayBufferOrBytes) {
    const bytes = arrayBufferOrBytes instanceof Uint8Array
      ? arrayBufferOrBytes
      : new Uint8Array(arrayBufferOrBytes);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_) {
      text = new TextDecoder('windows-1252').decode(bytes);
      return text;
    }
    return text;
  }

  /* ────────────────────────────────────────────
     Utilidades
  ───────────────────────────────────────────── */
  function cleanText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  /** Chave de aprendizado: minúsculas, sem acento, sem dígitos/pontuação. */
  function normalizeKey(desc) {
    return cleanText(desc)
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[0-9]/g, ' ')
      .replace(/[^a-z\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** '20260715120000[-3:BRT]' | '20260715' → '2026-07-15' */
  function parseOFXDate(raw) {
    const m = String(raw || '').trim().match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    const [, y, mo, d] = m;
    if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
    return `${y}-${mo}-${d}`;
  }

  /**
   * Valor monetário em qualquer formato comum:
   * '1.234,56' | '1234.56' | '-1234,56' | 'R$ 1.234,56' | '(123,45)' → Number
   */
  function parseAmount(raw) {
    let s = cleanText(raw).replace(/R\$\s?/i, '');
    if (!s) return null;
    let negative = false;
    if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
    // aceita hífen ASCII e os travessões/sinal de menos tipográficos (−, –, —)
    if (/^[-‐-―−]/.test(s)) { negative = true; s = s.slice(1); }
    if (/^\+/.test(s)) { s = s.slice(1); }
    s = s.replace(/\s/g, '');
    if (!/^[\d.,]+$/.test(s)) return null;

    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma >= 0 && lastDot >= 0) {
      // o separador que aparece por último é o decimal
      if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (lastComma >= 0) {
      // só vírgula: decimal se 1-2 dígitos no fim; senão é milhar
      const after = s.length - lastComma - 1;
      if (after <= 2 && s.indexOf(',') === lastComma) s = s.replace(',', '.');
      else s = s.replace(/,/g, '');
    }
    // só ponto: já é decimal padrão (ou milhar puro tipo '1.234' — assumimos decimal
    // apenas quando há 1-2 casas; '1.234' com 3 casas é milhar)
    else if (lastDot >= 0) {
      const after = s.length - lastDot - 1;
      const onlyOneDot = s.indexOf('.') === lastDot;
      if (onlyOneDot && after === 3 && s.length > 4) s = s.replace(/\./g, '');
    }
    const n = Number(s);
    if (!isFinite(n)) return null;
    return negative ? -n : n;
  }

  /* ────────────────────────────────────────────
     OFX (SGML 1.x e XML 2.x)
  ───────────────────────────────────────────── */
  function ofxTag(block, tag) {
    // valor vai até a próxima tag ou fim de linha (SGML não fecha tags)
    const m = block.match(new RegExp('<' + tag + '>([^<\\r\\n]*)', 'i'));
    return m ? cleanText(m[1]) : '';
  }

  function parseOFX(text) {
    const errors = [];
    const src = String(text || '');
    const source = /<CREDITCARDMSGSRSV1>|<CCSTMTRS>/i.test(src) ? 'card'
      : (/<BANKMSGSRSV1>|<STMTRS>/i.test(src) ? 'bank' : 'unknown');

    const blocks = src.match(/<STMTTRN>[\s\S]*?(?=<STMTTRN>|<\/BANKTRANLIST>|<\/STMTTRN>\s*$|$)/gi) || [];
    const transactions = [];
    for (const b of blocks) {
      const date = parseOFXDate(ofxTag(b, 'DTPOSTED'));
      const amount = parseAmount(ofxTag(b, 'TRNAMT'));
      const name = ofxTag(b, 'NAME');
      const memo = ofxTag(b, 'MEMO');
      const fitid = ofxTag(b, 'FITID');
      const description = cleanText(name && memo && name !== memo ? `${name} ${memo}` : (name || memo));
      // Estabelecimento = o payee (NAME); se só houver MEMO, usa a própria descrição.
      const establishment = cleanText(name || memo);
      if (!date || amount === null || amount === 0 || !description) {
        errors.push('Lançamento OFX ignorado (campos incompletos): ' + cleanText(b).slice(0, 80));
        continue;
      }
      transactions.push({ date, amount, description, establishment, fitid: fitid || null, type: ofxTag(b, 'TRNTYPE') || null });
    }
    if (blocks.length === 0) errors.push('Nenhum <STMTTRN> encontrado no OFX.');
    return { kind: 'ofx', source, transactions, errors };
  }

  /* ────────────────────────────────────────────
     CSV
  ───────────────────────────────────────────── */
  function detectDelimiter(lines) {
    const cands = [';', ',', '\t'];
    let best = ';', bestScore = -1;
    for (const d of cands) {
      const counts = lines.slice(0, 10).map(l => splitCSVLine(l, d).length);
      const cols = Math.max(...counts);
      const consistent = counts.every(c => c === counts[0]) ? 1 : 0;
      const score = (cols > 1 ? cols : 0) * 2 + consistent;
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  function splitCSVLine(line, delim) {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === delim) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(cleanText);
  }

  const DATE_RES = [
    { re: /^(\d{4})-(\d{2})-(\d{2})/, order: 'ymd' },
    { re: /^(\d{4})\/(\d{2})\/(\d{2})/, order: 'ymd' },
    { re: /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/, order: 'dmy?' },
    { re: /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})$/, order: 'dmy?2' },
  ];

  function dateLikeness(v) {
    return DATE_RES.some(d => d.re.test(cleanText(v))) ? 1 : 0;
  }

  /**
   * Resolve DD/MM vs MM/DD olhando o ARQUIVO INTEIRO:
   * se algum primeiro componente >12 → DD/MM; se algum segundo >12 → MM/DD;
   * ambíguo de ponta a ponta → DD/MM (padrão pt-BR).
   */
  function resolveDayMonthOrder(values) {
    let sawFirstGt12 = false, sawSecondGt12 = false;
    for (const v of values) {
      const m = cleanText(v).match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.]\d{2,4}$/);
      if (!m) continue;
      if (+m[1] > 12) sawFirstGt12 = true;
      if (+m[2] > 12) sawSecondGt12 = true;
    }
    if (sawFirstGt12 && !sawSecondGt12) return 'dmy';
    if (sawSecondGt12 && !sawFirstGt12) return 'mdy';
    return 'dmy';
  }

  function parseCSVDate(v, dmOrder) {
    const s = cleanText(v);
    let m = s.match(/^(\d{4})[-\/](\d{2})[-\/](\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (!m) return null;
    let [, a, b, y] = m;
    if (y.length === 2) y = (+y > 70 ? '19' : '20') + y;
    let day, month;
    if (dmOrder === 'mdy') { month = a; day = b; } else { day = a; month = b; }
    day = String(day).padStart(2, '0');
    month = String(month).padStart(2, '0');
    if (+month < 1 || +month > 12 || +day < 1 || +day > 31) return null;
    return `${y}-${month}-${day}`;
  }

  const HEADER_ALIASES = {
    date: ['data', 'date', 'dt', 'data lancamento', 'data de lancamento', 'data compra', 'data da compra', 'data mov', 'dia'],
    amount: ['valor', 'amount', 'value', 'valor (r$)', 'valor r$', 'quantia', 'montante'],
    debit: ['debito', 'debit', 'saida', 'saidas', 'valor debito'],
    credit: ['credito', 'credit', 'entrada', 'entradas', 'valor credito'],
    description: ['descricao', 'historico', 'description', 'memo', 'lancamento', 'title', 'titulo', 'detalhes', 'movimentacao', 'transacao', 'nome'],
    establishment: ['estabelecimento', 'estabelecimento descricao', 'local', 'merchant', 'loja', 'favorecido', 'beneficiario'],
    id: ['identifier', 'id', 'identificador', 'codigo', 'document', 'documento', 'num doc'],
  };

  function headerRole(cell) {
    const key = normalizeKey(cell);
    for (const [role, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(key)) return role;
    }
    // prefixo (ex.: "Data Lançamento" → data)
    for (const [role, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.some(a => key.startsWith(a) || a.startsWith(key) && key.length >= 4)) return role;
    }
    return null;
  }

  function parseCSV(text) {
    const errors = [];
    const rawLines = String(text || '').split(/\r\n|\n|\r/).filter(l => cleanText(l) !== '');
    if (rawLines.length === 0) return { kind: 'csv', transactions: [], errors: ['Arquivo vazio.'] };

    const delimiter = detectDelimiter(rawLines);
    let rows = rawLines.map(l => splitCSVLine(l, delimiter));

    // Cabeçalho?
    const headRoles = rows[0].map(headerRole);
    const hasHeader = headRoles.some(r => r !== null) && rows[0].every(c => parseAmount(c) === null || headerRole(c) !== null);

    let colMap = {};
    if (hasHeader) {
      headRoles.forEach((role, i) => { if (role && colMap[role] === undefined) colMap[role] = i; });
      rows = rows.slice(1);
    }

    // Sem cabeçalho (ou cabeçalho incompleto): inferir colunas pelo conteúdo
    if (colMap.date === undefined || (colMap.amount === undefined && colMap.debit === undefined)) {
      const nCols = Math.max(...rows.map(r => r.length));
      const dateScore = Array(nCols).fill(0), numScore = Array(nCols).fill(0), textLen = Array(nCols).fill(0);
      for (const r of rows.slice(0, 50)) {
        for (let i = 0; i < nCols; i++) {
          const v = r[i] || '';
          dateScore[i] += dateLikeness(v);
          if (parseAmount(v) !== null && !dateLikeness(v)) numScore[i] += 1;
          textLen[i] += v.length;
        }
      }
      if (colMap.date === undefined) colMap.date = dateScore.indexOf(Math.max(...dateScore));
      if (colMap.amount === undefined && colMap.debit === undefined) {
        let bi = -1, bs = -1;
        for (let i = 0; i < nCols; i++) {
          if (i === colMap.date) continue;
          if (numScore[i] > bs) { bs = numScore[i]; bi = i; }
        }
        colMap.amount = bi;
      }
      if (colMap.description === undefined) {
        let bi = -1, bl = -1;
        for (let i = 0; i < nCols; i++) {
          if (i === colMap.date || i === colMap.amount) continue;
          if (textLen[i] > bl) { bl = textLen[i]; bi = i; }
        }
        if (bi >= 0) colMap.description = bi;
      }
    }

    if (colMap.date === undefined || colMap.date < 0) {
      return { kind: 'csv', transactions: [], errors: ['Não foi possível identificar a coluna de data.'], delimiter };
    }

    const dmOrder = resolveDayMonthOrder(rows.map(r => r[colMap.date]));
    const transactions = [];
    rows.forEach((r, idx) => {
      const date = parseCSVDate(r[colMap.date], dmOrder);
      let amount = null;
      // Colunas Débito/Crédito separadas são inequívocas (débito = saída,
      // crédito = entrada) independente da origem (conta ou cartão) — ao
      // contrário de uma única coluna de valor com sinal, cuja leitura
      // depende da convenção por origem decidida na tela (Ajuste 1).
      let knownDirection = null;
      if (colMap.debit !== undefined || colMap.credit !== undefined) {
        const deb = colMap.debit !== undefined ? parseAmount(r[colMap.debit]) : null;
        const cred = colMap.credit !== undefined ? parseAmount(r[colMap.credit]) : null;
        if (deb !== null && deb !== 0) { amount = Math.abs(deb); knownDirection = 'expense'; }
        else if (cred !== null && cred !== 0) { amount = Math.abs(cred); knownDirection = 'income'; }
      } else if (colMap.amount !== undefined && colMap.amount >= 0) {
        amount = parseAmount(r[colMap.amount]);
      }
      const descCol = colMap.description !== undefined ? cleanText(r[colMap.description]) : '';
      const estCol  = colMap.establishment !== undefined ? cleanText(r[colMap.establishment]) : '';
      // Descrição e estabelecimento se completam: se falta um, usa o outro.
      const description = descCol || estCol;
      const establishment = estCol || descCol;
      const extId = colMap.id !== undefined ? cleanText(r[colMap.id]) : '';
      if (!date || amount === null || amount === 0 || !description) {
        errors.push(`Linha ${idx + (hasHeader ? 2 : 1)} ignorada (data/valor/descrição não reconhecidos).`);
        return;
      }
      transactions.push({ date, amount, description, establishment, fitid: extId || null, type: null, knownDirection });
    });

    return { kind: 'csv', transactions, errors, delimiter, hasHeader, colMap, dmOrder };
  }

  /** Dispatcher por extensão + conteúdo. */
  function parseFile(filename, text) {
    const ext = String(filename || '').toLowerCase().split('.').pop();
    if (ext === 'ofx' || /<OFX>/i.test(text)) return parseOFX(text);
    if (ext === 'csv' || ext === 'txt') return parseCSV(text);
    return { kind: 'unknown', transactions: [], errors: ['Formato não suportado — envie um arquivo .ofx ou .csv.'] };
  }

  /* ────────────────────────────────────────────
     Dedup
  ───────────────────────────────────────────── */
  /**
   * Fingerprint estável por destino (conta ou cartão):
   * - OFX/CSV com id externo (FITID/Identifier): usa o id — é único por origem;
   * - senão: data + valor + descrição normalizada.
   * `seen` (Map) desambigua linhas idênticas DENTRO do mesmo arquivo (#2, #3…),
   * mantendo estabilidade entre re-importações do mesmo arquivo.
   */
  function fingerprint(tx, destId, seen) {
    let base;
    if (tx.fitid) base = `id:${destId}:${tx.fitid}`;
    else {
      const isDebit = tx.knownDirection ? tx.knownDirection === 'expense' : tx.amount < 0;
      base = `tx:${destId}:${tx.date}:${Math.abs(tx.amount).toFixed(2)}:${isDebit ? 'd' : 'c'}:${normalizeKey(tx.description)}`;
    }
    if (seen) {
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      if (n > 1) base += `#${n}`;
    }
    return base;
  }

  /* ────────────────────────────────────────────
     Categorização aprendida (LAN-05)
  ───────────────────────────────────────────── */
  const NEUTRAL_CLASSIFICATION = 'Classificação neutra';

  /**
   * Constrói o modelo a partir do histórico já categorizado do casal.
   * Aprende DOIS níveis: chave (descrição normalizada) → categoria → {count, subs}.
   * key -> Map(categoria -> { count, subs: Map(subcategoria -> count) })
   */
  function buildCategoryModel(historyTxs) {
    const model = new Map();
    for (const t of historyTxs || []) {
      const cls = t.classification;
      if (!cls || cls === NEUTRAL_CLASSIFICATION) continue;
      if (t.needs_category_review) continue;
      const key = normalizeKey(t.description);
      if (!key) continue;
      if (!model.has(key)) model.set(key, new Map());
      const byCat = model.get(key);
      if (!byCat.has(cls)) byCat.set(cls, { count: 0, subs: new Map() });
      const entry = byCat.get(cls);
      entry.count += 1;
      const sub = t.subcategory;
      if (sub) entry.subs.set(sub, (entry.subs.get(sub) || 0) + 1);
    }
    return model;
  }

  /**
   * Sugestão de categoria E subcategoria para uma descrição:
   * - só vem preenchida sem perguntar (confident:true) quando AMBOS os níveis
   *   são consistentes (uma única opção, ou ≥80% das ocorrências) e há uma
   *   subcategoria conhecida — como ambos são obrigatórios, sem subcategoria
   *   confiável o item vai para a fila;
   * - caso contrário sugere o que der e pergunta (confident:false);
   * - origem nunca vista → pergunta (classification/subcategory: null).
   */
  function suggestCategory(model, description) {
    const key = normalizeKey(description);
    const byCat = key ? model.get(key) : null;
    if (!byCat || byCat.size === 0) return { classification: null, subcategory: null, confident: false };
    let top = null, topCount = 0, total = 0, topEntry = null;
    for (const [cls, entry] of byCat) {
      total += entry.count;
      if (entry.count > topCount) { topCount = entry.count; top = cls; topEntry = entry; }
    }
    const catConfident = byCat.size === 1 || (topCount / total) >= 0.8;

    let sub = null, subCount = 0, subTotal = 0;
    for (const [s, c] of topEntry.subs) { subTotal += c; if (c > subCount) { subCount = c; sub = s; } }
    const subConfident = topEntry.subs.size === 1 || (subTotal > 0 && (subCount / subTotal) >= 0.8);

    return {
      classification: top,
      subcategory: sub,
      confident: catConfident && subConfident && !!sub,
    };
  }

  return {
    decodeBuffer,
    cleanText,
    normalizeKey,
    parseOFXDate,
    parseAmount,
    parseOFX,
    parseCSV,
    parseFile,
    fingerprint,
    buildCategoryModel,
    suggestCategory,
    NEUTRAL_CLASSIFICATION,
  };
});
