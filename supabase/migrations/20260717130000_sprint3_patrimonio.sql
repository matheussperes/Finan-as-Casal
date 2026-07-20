-- ════════════════════════════════════════════════════════════════════════
-- Sprint 3 — Aba Patrimônio
-- Implementa D2 (financiamentos e bens materiais) e a base de dados para
-- PAT-01..04 (cards Financeiro / Bens Materiais / Dívidas).
--
-- Depende do Sprint 2 (categories, investment_positions, user_household_ids())
-- — rode a migração 20260717120000_sprint2_modelo_financeiro.sql ANTES desta.
--
-- STATUS: já aplicada em produção (projeto vvgrnrvvdggosxkjkxaa) em
-- 2026-07-18, via MCP do Supabase. Fica versionada como registro/documentação
-- e para reaplicar em outro ambiente — não precisa ser rodada de novo aqui.
--
-- RLS e updated_at seguem o padrão real do projeto (confirmado por
-- introspecção via MCP do Supabase): uma única policy `for all` usando
-- `public.user_household_ids()`, e trigger `update_updated_at()`.
-- ════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────
-- 1. FINANCIAMENTOS (D2) — entidade dentro de Dívidas.
--    parcela_mensal é calculada UMA VEZ na criação (fórmula Price, ver
--    js/finance-model.js#pricePayment). saldo_devedor é recalculado pelo
--    app a cada geração de parcela (js/finance-model.js#outstandingLoanBalance),
--    nunca digitado à mão.
-- ───────────────────────────────────────────────────────────────────────
create table if not exists loans (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references households(id) on delete cascade,
  account_id      uuid not null references accounts(id) on delete restrict, -- de onde sai a parcela mensal
  name            text not null,
  valor_total     numeric not null,          -- principal financiado
  taxa            numeric not null default 0, -- taxa mensal (ex.: 0.0135 = 1,35% a.m.)
  prazo           integer not null,           -- número de parcelas
  parcela_mensal  numeric not null,           -- Price, calculada 1x na criação
  saldo_devedor   numeric not null,           -- recalculado a cada parcela gerada
  data_inicio     date not null,              -- referência da 1ª parcela
  owner_type      text not null default 'joint' check (owner_type in ('individual','joint')),
  member_id       uuid references members(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table loans enable row level security;

drop policy if exists loans_all on loans;
create policy loans_all on loans for all
  using (household_id in (select user_household_ids()))
  with check (household_id in (select user_household_ids()));

drop trigger if exists trg_loans_updated_at on loans;
create trigger trg_loans_updated_at
  before update on loans
  for each row execute function update_updated_at();

-- ───────────────────────────────────────────────────────────────────────
-- 2. BENS MATERIAIS (D2) — valor líquido = valor_mercado − saldo_devedor
--    do financiamento vinculado (calculado no app, não é coluna).
-- ───────────────────────────────────────────────────────────────────────
create table if not exists assets (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references households(id) on delete cascade,
  name            text not null,
  category        text,                       -- ex.: "Imóvel", "Veículo" — texto livre
  valor_mercado   numeric not null default 0,
  loan_id         uuid references loans(id) on delete set null,
  owner_type      text not null default 'joint' check (owner_type in ('individual','joint')),
  member_id       uuid references members(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Um financiamento só pode estar amarrado a um bem por vez (D2: "pode ser vinculado a um financiamento")
create unique index if not exists one_asset_per_loan on assets (loan_id) where (loan_id is not null);

alter table assets enable row level security;

drop policy if exists assets_all on assets;
create policy assets_all on assets for all
  using (household_id in (select user_household_ids()))
  with check (household_id in (select user_household_ids()));

drop trigger if exists trg_assets_updated_at on assets;
create trigger trg_assets_updated_at
  before update on assets
  for each row execute function update_updated_at();

-- ───────────────────────────────────────────────────────────────────────
-- 3. PARCELA COMO SAÍDA RECORRENTE — transactions ganha loan_id.
--    `on delete restrict` (padrão) impede excluir um financiamento que já
--    gerou parcelas — a UI só permite excluir financiamentos sem parcelas
--    geradas ainda.
-- ───────────────────────────────────────────────────────────────────────
alter table transactions add column if not exists loan_id uuid references loans(id);
