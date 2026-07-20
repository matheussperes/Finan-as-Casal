-- ════════════════════════════════════════════════════════════════════════
-- Sprint 5 — Projetos & Independência Financeira
-- Implementa PRJ-01 (fusão dos Eventos Patrimoniais Futuros em Projetos)
-- e PRJ-02 (D3 — campo único `tipo` no projeto).
--
-- Depende das migrações dos Sprints 2 e 3 já aplicadas.
--
-- STATUS: aplicada manualmente no SQL Editor do Supabase (projeto
-- vvgrnrvvdggosxkjkxaa) em 2026-07-20, pois o MCP do Supabase ficou
-- indisponível nesta sessão durante o sprint.
--
-- Schema real de `projects` e `independence_events` confirmado por
-- introspecção direta do banco durante o Sprint 2 (via MCP):
--   projects: id, household_id, name, type, priority (check
--     Essencial/Desejo/Sonho), target_amount, allocated_amount,
--     target_date, is_active, notes, created_at, updated_at,
--     project_type, monthly_rate
--   independence_events: id, household_id, description, event_type (check
--     withdrawal/extra_deposit/expense/income), amount, start_date,
--     end_date, created_at, updated_at
-- ════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────
-- 1. PRJ-02 (D3) — campo único `tipo` no projeto.
--    A classificação "acumulação vs despesa" é DERIVADA do tipo no app
--    (js/finance-model.js#projectKind) — sem coluna extra.
--    `end_date` só é usada pelos tipos recorrentes (despesa/receita).
--    Nota: `tipo` (natureza financeira, D3) coexiste com `project_type`
--    (categoria temática: viagem/casa/carro… — PRJ-05); são eixos
--    diferentes do mesmo projeto.
-- ───────────────────────────────────────────────────────────────────────
alter table projects add column if not exists tipo text not null default 'retirada_unica';
alter table projects drop constraint if exists projects_tipo_check;
alter table projects add constraint projects_tipo_check
  check (tipo in ('retirada_unica','despesa_recorrente','receita_recorrente','aporte_extra'));
alter table projects add column if not exists end_date date;

-- `monthly_rate` por projeto fica DEPRECADA (não removida, para não quebrar
-- linhas antigas): com o modelo de pool único (PRJ-03), a taxa usada nos
-- cálculos de aporte passa a ser sempre a do pool
-- (independence_params.real_rate_accumulation), nunca uma taxa por projeto.

-- ───────────────────────────────────────────────────────────────────────
-- 2. PRJ-01 — migrar os Eventos Patrimoniais Futuros existentes para
--    Projetos. O mapeamento é 1:1 com o D3:
--      withdrawal     -> retirada_unica
--      extra_deposit  -> aporte_extra
--      expense        -> despesa_recorrente
--      income         -> receita_recorrente
-- ───────────────────────────────────────────────────────────────────────
insert into projects (
  household_id, name, tipo, project_type, priority,
  target_amount, allocated_amount, target_date, end_date, is_active, notes
)
select
  household_id,
  description,
  case event_type
    when 'withdrawal'    then 'retirada_unica'
    when 'extra_deposit' then 'aporte_extra'
    when 'expense'       then 'despesa_recorrente'
    else                      'receita_recorrente'
  end,
  'outro',
  'Desejo',
  amount,
  0,
  start_date,
  end_date,
  true,
  'Migrado de Eventos Patrimoniais Futuros (Sprint 5 — PRJ-01)'
from independence_events;

-- ───────────────────────────────────────────────────────────────────────
-- 3. PRJ-01 — remover a entidade separada de EPF. Projetos assumem esse
--    papel; a UI correspondente foi removida de futuro.html.
-- ───────────────────────────────────────────────────────────────────────
drop table if exists independence_events;
