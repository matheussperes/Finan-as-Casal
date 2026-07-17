-- ════════════════════════════════════════════════════════════════════════
-- Sprint 2 — Fundação do modelo financeiro
-- Implementa D1 (investimento dentro da conta) e D4 (reserva de emergência)
-- e a base de dados para ORC-01 (categorias editáveis).
--
-- COMO APLICAR
-- Este projeto não tem Supabase CLI nem service-role configurados no
-- ambiente de execução do agente — não é possível rodar `supabase db push`
-- a partir daqui. Cole este arquivo inteiro no SQL Editor do painel do
-- Supabase (projeto vvgrnrvvdggosxkjkxaa) e rode uma vez.
--
-- PREMISSAS (não confirmadas por introspecção do banco real — revise antes
-- de rodar em produção):
--   • Todas as tabelas existentes (households, members, accounts,
--     transactions, budget_plan, emergency_reserve, credit_cards, invoices)
--     usam chave primária `id uuid default gen_random_uuid()`.
--   • RLS já está habilitado nessas tabelas com uma policy no formato
--     "household_id in (select household_id from members where user_id =
--     auth.uid())". As policies novas abaixo replicam esse padrão — ajuste
--     se o seu padrão real for diferente.
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

drop policy if exists categories_select on categories;
create policy categories_select on categories for select
  using (household_id in (select household_id from members where user_id = auth.uid()));

drop policy if exists categories_insert on categories;
create policy categories_insert on categories for insert
  with check (household_id in (select household_id from members where user_id = auth.uid()));

drop policy if exists categories_update on categories;
create policy categories_update on categories for update
  using (household_id in (select household_id from members where user_id = auth.uid()));

drop policy if exists categories_delete on categories;
create policy categories_delete on categories for delete
  using (
    household_id in (select household_id from members where user_id = auth.uid())
    and is_protected = false
  );

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

drop policy if exists investment_positions_select on investment_positions;
create policy investment_positions_select on investment_positions for select
  using (household_id in (select household_id from members where user_id = auth.uid()));

drop policy if exists investment_positions_insert on investment_positions;
create policy investment_positions_insert on investment_positions for insert
  with check (household_id in (select household_id from members where user_id = auth.uid()));

drop policy if exists investment_positions_update on investment_positions;
create policy investment_positions_update on investment_positions for update
  using (household_id in (select household_id from members where user_id = auth.uid()));

drop policy if exists investment_positions_delete on investment_positions;
create policy investment_positions_delete on investment_positions for delete
  using (household_id in (select household_id from members where user_id = auth.uid()));

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

drop policy if exists investment_contributions_select on investment_contributions;
create policy investment_contributions_select on investment_contributions for select
  using (household_id in (select household_id from members where user_id = auth.uid()));

drop policy if exists investment_contributions_insert on investment_contributions;
create policy investment_contributions_insert on investment_contributions for insert
  with check (household_id in (select household_id from members where user_id = auth.uid()));

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
    select 1 from investment_positions
    where id = p_position_id and account_id = p_account_id and household_id = p_household_id
  ) then
    raise exception 'Posição de investimento não pertence a esta conta/household';
  end if;

  insert into transactions (
    household_id, account_id, member_id, direction, amount, description,
    date, classification, payment_method, linked_position_id, transfer_group_id
  ) values (
    p_household_id, p_account_id, p_member_id, 'expense', p_amount, p_description,
    p_date, p_classification, 'transferencia', p_position_id, v_group_id
  ) returning id into v_tx_id;

  insert into investment_contributions (
    household_id, position_id, transaction_id, amount, date
  ) values (
    p_household_id, p_position_id, v_tx_id, p_amount, p_date
  ) returning id into v_contrib_id;

  update investment_positions
     set valor_aplicado = valor_aplicado + p_amount,
         updated_at     = now()
   where id = p_position_id and household_id = p_household_id;

  transaction_id  := v_tx_id;
  contribution_id := v_contrib_id;
  return next;
end;
$$ language plpgsql security invoker;

-- ───────────────────────────────────────────────────────────────────────
-- 4. RESERVA DE EMERGÊNCIA (D4) — deixa de ter saldo digitado manualmente
--    e passa a apontar para uma posição de investimento (is_reserve = true).
--    `multiplier` substitui `target_months` (mesmo conceito: multiplicador
--    padrão 6, editável — "N x soma das despesas essenciais").
-- ───────────────────────────────────────────────────────────────────────
alter table emergency_reserve rename column target_months to multiplier;
alter table emergency_reserve add column if not exists investment_position_id uuid references investment_positions(id);
alter table emergency_reserve drop column if exists current_balance;
