#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Sprint 6 — Teste de isolamento RLS entre casais.
//
// Cria DOIS casais (dois usuários, dois households) usando somente a
// anon key — exatamente como o browser — e verifica que um casal não
// consegue LER nem ESCREVER dados do outro:
//
//   • SELECT em households / members / accounts / transactions do outro
//   • INSERT de transação no household alheio
//   • Exploit corrigido: INSERT de members com o próprio user_id em
//     household alheio (antes do Sprint 6 isso dava acesso total!)
//   • UPDATE de members.user_id direto pelo cliente (grant revogado)
//   • UPDATE no household alheio
//
// Uso:  node tests/rls-isolation.mjs
// Os dados criados usam e-mails rls.test.*@example.com — limpe depois
// com service role (auth users não podem ser removidos pela anon key).
// ═══════════════════════════════════════════════════════════════════
'use strict';

const SUPABASE_URL = 'https://vvgrnrvvdggosxkjkxaa.supabase.co';
const ANON_KEY = 'sb_publishable_XbWPcxUBV-2R2eH720h7kA_v5zCrvoX';

const ts = Date.now();
const results = [];

function check(label, ok, detail = '') {
  results.push({ label, ok, detail });
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

async function signUp(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`signup ${email}: ${JSON.stringify(j)}`);
  if (!j.access_token) {
    throw new Error(
      `signup ${email} não retornou sessão — confirmação de e-mail está LIGADA; ` +
      'rode o teste com um usuário confirmado ou desative a confirmação.'
    );
  }
  return { token: j.access_token, userId: j.user.id, email };
}

async function rest(token, method, path, body, headers = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

async function createCouple(tag) {
  const user = await signUp(`rls.test.${tag}.${ts}@example.com`, `Rls-Test-${ts}!`);

  const hh = await rest(user.token, 'POST', 'households', {
    name: `RLS Test ${tag.toUpperCase()} ${ts}`,
    created_by: user.userId,
  }, { Prefer: 'return=representation' });
  if (!hh.ok) throw new Error(`household ${tag}: ${JSON.stringify(hh.data)}`);
  const householdId = hh.data[0].id;

  const mem = await rest(user.token, 'POST', 'members', {
    household_id: householdId,
    user_id: user.userId,
    name: `Titular ${tag.toUpperCase()}`,
    email: user.email,
    role: 'primary',
  }, { Prefer: 'return=representation' });
  if (!mem.ok) throw new Error(`member ${tag}: ${JSON.stringify(mem.data)}`);

  const acc = await rest(user.token, 'POST', 'accounts', {
    household_id: householdId,
    name: `Conta ${tag.toUpperCase()}`,
    owner_type: 'joint',
    account_type: 'checking',
    balance: 1000,
  }, { Prefer: 'return=representation' });
  if (!acc.ok) throw new Error(`account ${tag}: ${JSON.stringify(acc.data)}`);

  const tx = await rest(user.token, 'POST', 'transactions', {
    household_id: householdId,
    account_id: acc.data[0].id,
    direction: 'expense',
    amount: 123.45,
    description: `Segredo do casal ${tag.toUpperCase()}`,
  }, { Prefer: 'return=representation' });
  if (!tx.ok) throw new Error(`transaction ${tag}: ${JSON.stringify(tx.data)}`);

  return {
    ...user,
    householdId,
    memberId: mem.data[0].id,
    accountId: acc.data[0].id,
    txId: tx.data[0].id,
  };
}

async function main() {
  console.log('── Criando casal A e casal B (via anon key, como o browser) ──');
  const A = await createCouple('a');
  const B = await createCouple('b');
  console.log(`Casal A: household ${A.householdId}`);
  console.log(`Casal B: household ${B.householdId}\n`);

  console.log('── Leitura cruzada (A tentando ler B, e vice-versa) ──');
  for (const [me, other, tagMe, tagOther] of [[A, B, 'A', 'B'], [B, A, 'B', 'A']]) {
    let r = await rest(me.token, 'GET', `households?id=eq.${other.householdId}&select=*`);
    check(`${tagMe} não lê o household de ${tagOther}`, r.ok && r.data.length === 0, `${r.data.length ?? '?'} linhas`);

    r = await rest(me.token, 'GET', `members?household_id=eq.${other.householdId}&select=*`);
    check(`${tagMe} não lê os members de ${tagOther}`, r.ok && r.data.length === 0, `${r.data.length ?? '?'} linhas`);

    r = await rest(me.token, 'GET', `accounts?household_id=eq.${other.householdId}&select=*`);
    check(`${tagMe} não lê as accounts de ${tagOther}`, r.ok && r.data.length === 0, `${r.data.length ?? '?'} linhas`);

    r = await rest(me.token, 'GET', `transactions?household_id=eq.${other.householdId}&select=*`);
    check(`${tagMe} não lê as transactions de ${tagOther}`, r.ok && r.data.length === 0, `${r.data.length ?? '?'} linhas`);

    r = await rest(me.token, 'GET', `households?select=*`);
    const onlyMine = r.ok && r.data.every(h => h.id === me.householdId);
    check(`${tagMe} listando todos os households só vê o próprio`, onlyMine, `${r.data.length} household(s)`);
  }

  console.log('\n── Escrita cruzada ──');
  let r = await rest(A.token, 'POST', 'transactions', {
    household_id: B.householdId, direction: 'expense', amount: 1, description: 'invasão',
  });
  check('A não insere transação no casal B', r.status === 403 || r.status === 401, `status ${r.status}`);

  r = await rest(A.token, 'PATCH', `households?id=eq.${B.householdId}`, { name: 'hackeado' }, { Prefer: 'return=representation' });
  check('A não altera o household de B', (r.ok && r.data.length === 0) || r.status === 403, `status ${r.status}, ${Array.isArray(r.data) ? r.data.length : '?'} linha(s)`);

  console.log('\n── Exploit corrigido no Sprint 6 ──');
  r = await rest(A.token, 'POST', 'members', {
    household_id: B.householdId, user_id: A.userId, name: 'Invasor', role: 'partner',
  });
  check('A não consegue se inserir como membro do casal B (members_insert_own)', r.status === 403, `status ${r.status}`);

  r = await rest(A.token, 'POST', 'members', {
    household_id: A.householdId, user_id: B.userId, name: 'Marionete', role: 'partner',
  });
  check('A não consegue vincular o auth user de B ao próprio casal (members_insert_household)', r.status === 403, `status ${r.status}`);

  r = await rest(A.token, 'PATCH', `members?id=eq.${A.memberId}`, { user_id: B.userId });
  check('Cliente não altera members.user_id via UPDATE (grant por coluna)', r.status === 401 || r.status === 403 || r.status === 400, `status ${r.status}`);

  r = await rest(A.token, 'PATCH', `members?id=eq.${A.memberId}`, { name: 'Titular A ok' }, { Prefer: 'return=representation' });
  check('Cliente ainda edita o próprio perfil (name)', r.ok && r.data.length === 1, `status ${r.status}`);

  console.log('\n── Resumo ──');
  const fails = results.filter(x => !x.ok);
  console.log(`${results.length - fails.length}/${results.length} verificações passaram.`);
  console.log('\nDados de teste criados (limpar com service role):');
  console.log(`  households: ${A.householdId}, ${B.householdId}`);
  console.log(`  auth users: rls.test.a.${ts}@example.com, rls.test.b.${ts}@example.com`);
  if (fails.length) {
    console.error('\n⚠️  HÁ FALHAS DE ISOLAMENTO — NÃO FAÇA DEPLOY.');
    process.exit(1);
  }
  console.log('\n🎉 Isolamento entre casais confirmado.');
}

main().catch(err => { console.error('Erro no teste:', err.message); process.exit(1); });
