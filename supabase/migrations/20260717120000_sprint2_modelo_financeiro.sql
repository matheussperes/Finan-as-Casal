-- ════════════════════════════════════════════════════════════════════════
-- Sprint 2 — Fundação do modelo financeiro
-- Implementa D1 (investimento dentro da conta) e D4 (reserva de emergência)
-- e a base de dados para ORC-01 (categorias editáveis).
--
-- STATUS: já aplicada em produção (projeto vvgrnrvvdggosxkjkxaa) em
-- 2026-07-18, via MCP do Supabase, depois de corrigida contra o schema
-- real (ver commit "fix: corrige migrações Sprint 2/3 contra o schema real
-- do Supabase"). Este arquivo fica versionado como registro/documentação e
-- para reaplicar em outro ambiente (staging, outro projeto Supabase) — não
-- precisa ser rodado de novo neste projeto.
--
-- A v1 deste arquivo assumia nomes de coluna e um padrão de RLS que não
-- batiam com o schema real e falhou ao rodar (rollback total, nada foi
-- commitado). Corrigido após introspecção direta do banco:
--   • RLS real: uma única policy `for all` por tabela, usando a função
--     helper `public.user_household_ids()` (security definer, evita
--     recursão de RLS via members) — não 4 policies com subquery inline.
--   • `updated_at` é mantido por trigger (`update_updated_at()` /
--     `handle_updated_at()`), não escrito à mão pelo app.
--   • `emergency_reserve` real: `target_amount`, `current_amount`,
--     `method` ('auto'|'manual'), `months_target` — não
--     `target_months`/`current_balance` como a v1 deste arquivo assumia.
--   • `transfer_to_investment` ganhou `set search_path = ''` (achado do
--     advisor de segurança do Supabase) e referências totalmente
--     qualificadas (`public.tabela`).
-- ════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────
-- 1. CATEGORIAS (base do ORC-01 e do flag `essencial` do D4/ORC-02)
-- ───────────────────────────────────────────────────────────────────────
create table if not exists categories (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  name          text not null,
  essencial     boolean not null default false,
  is_protected  boolean not null default false,   -- 'Renda' e 'Classificação neutra': não podem ser excluídas
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (household_id, name)
);

alter table categories enable row level security;

drop policy if exists categories_all on categories;
create policy categories_all on categories for all
  using (household_id in (select user_household_ids()))
  with check (household_id in (select user_household_ids()));

drop trigger if exists trg_categories_updated_at on categories;
create trigger trg_categories_updated_at
  before update on categories
  for each row execute function update_updated_at();

-- Semeia as 9 classificações atuais como categorias padrão de cada household
-- já existente, preservando o texto usado hoje em transactions/budget_plan.
insert into categories (household_id, name, essencial, is_protected, sort_order)
select h.id, c.name, c.essencial, c.is_protected, c.sort_order
from households h
cross join (values
  ('Renda',                     false, true,  0),
  ('Despesas obrigatórias',     true,  false, 1),
  ('Despesas não obrigatórias', false, false, 2),
  ('Empresa e autônomo',        false, false, 3),
  ('Projetos',                  false, false, 4),
  ('Financiamentos',            true,  false, 5),
  ('Dívidas',                   true,  false, 6),
  ('Investimentos',             false, false, 7),
  ('Classificação neutra',      false, true,  8)
) as c(name, essencial, is_protected, sort_order)
on conflict (household_id, name) do nothing;

-- Categoria dedicada ao aporte de reserva de emergência (D4/ORC-02)
insert into categories (household_id, name, essencial, is_protected, sort_order)
select h.id, 'Aporte reserva de emergência', false, true, 9
from households h
on conflict (household_id, name) do nothing;

-- ───────────────────────────────────────────────────────────────────────
-- 2. POSIÇÕES DE INVESTIMENTO (D1) — filhas de uma conta corrente
-- ───────────────────────────────────────────────────────────────────────
create table if not exists investment_positions (
  id                    uuid primary key default gen_random_uuid(),
  household_id          uuid not null references households(id) on delete cascade,
  account_id            uuid not null references accounts(id) on delete cascade,
  name                  text not null,
  tipo                  text,
  vencimento            date,
  taxa                  numeric,
  valor_aplicado        numeric not null default 0,
  rendimento_acumulado  numeric not null default 0,
  is_reserve            boolean not null default false,  -- "etiqueta especial" da reserva de emergência (D4)
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Só pode existir UMA posição marcada como reserva por household.
create unique index if not exists one_reserve_position_per_household
  on investment_positions (household_id) where (is_reserve);

alter table investment_positions enable row level security;

drop policy if exists investment_positions_all on investment_positions;
create policy investment_positions_all on investment_positions for all
  using (household_id in (select user_household_ids()))
  with check (household_id in (select user_household_ids()));

drop trigger if exists trg_investment_positions_updated_at on investment_positions;
create trigger trg_investment_positions_updated_at
  before update on investment_positions
  for each row execute function update_updated_at();

-- ───────────────────────────────────────────────────────────────────────
-- 3. TRANSFERÊNCIAS LIGADAS (D1) — cada transferência gera:
--    (a) um lançamento de saída em `transactions` (contra o saldo disponível)
--    (b) um registro de aporte em `investment_contributions` (entrada na posição)
-- ───────────────────────────────────────────────────────────────────────
alter table transactions add column if not exists linked_position_id uuid references investment_positions(id);
alter table transactions add column if not exists transfer_group_id uuid;

create table if not exists investment_contributions (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references households(id) on delete cascade,
  position_id     uuid not null references investment_positions(id) on delete cascade,
  transaction_id  uuid references transactions(id) on delete set null,
  amount          numeric not null,   -- positivo = aporte, negativo = resgate
  date            date not null,
  created_at      timestamptz not null default now()
);

alter table investment_contributions enable row level security;

drop policy if exists investment_contributions_all on investment_contributions;
create policy investment_contributions_all on investment_contributions for all
  using (household_id in (select user_household_ids()))
  with check (household_id in (select user_household_ids()));

-- RPC que executa a transferência inteira como uma única transação SQL:
-- se qualquer passo falhar, o Postgres desfaz tudo — é isso que garante a
-- invariante "saldo_disponivel + total_investido não muda" mesmo sob falha
-- de rede no meio do processo.
create or replace function transfer_to_investment(
  p_household_id  uuid,
  p_account_id    uuid,
  p_position_id   uuid,
  p_amount        numeric,
  p_date          date,
  p_classification text,
  p_description   text default null,
  p_member_id     uuid default null
) returns table (transaction_id uuid, contribution_id uuid) as $$
declare
  v_tx_id     uuid;
  v_contrib_id uuid;
  v_group_id  uuid := gen_random_uuid();
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Valor da transferência deve ser positivo';
  end if;

  if not exists (
    select 1 from public.investment_positions
    where id = p_position_id and account_id = p_account_id and household_id = p_household_id
  ) then
    raise exception 'Posição de investimento não pertence a esta conta/household';
  end if;

  insert into public.transactions (
    household_id, account_id, member_id, direction, amount, description,
    date, classification, payment_method, linked_position_id, transfer_group_id
  ) values (
    p_household_id, p_account_id, p_member_id, 'expense', p_amount, p_description,
    p_date, p_classification, 'transferencia', p_position_id, v_group_id
  ) returning id into v_tx_id;

  insert into public.investment_contributions (
    household_id, position_id, transaction_id, amount, date
  ) values (
    p_household_id, p_position_id, v_tx_id, p_amount, p_date
  ) returning id into v_contrib_id;

  update public.investment_positions
     set valor_aplicado = valor_aplicado + p_amount,
         updated_at     = now()
   where id = p_position_id and household_id = p_household_id;

  transaction_id  := v_tx_id;
  contribution_id := v_contrib_id;
  return next;
end;
$$ language plpgsql security invoker set search_path = '';

-- ───────────────────────────────────────────────────────────────────────
-- 4. RESERVA DE EMERGÊNCIA (D4) — deixa de ter saldo digitado manualmente
--    e passa a apontar para uma posição de investimento (is_reserve = true).
--    `multiplier` substitui `months_target` (mesmo conceito: multiplicador
--    padrão 6, editável — "N x soma das despesas essenciais"). `current_amount`,
--    `target_amount` e `method` saem: saldo e meta agora são sempre
--    derivados (posição vinculada + categorias essenciais), nunca digitados
--    ou "modo automático/manual" — só existe o modo derivado.
-- ───────────────────────────────────────────────────────────────────────
alter table emergency_reserve rename column months_target to multiplier;
alter table emergency_reserve add column if not exists investment_position_id uuid references investment_positions(id);
alter table emergency_reserve drop column if exists current_amount;
alter table emergency_reserve drop column if exists target_amount;
alter table emergency_reserve drop column if exists method;
