-- Ajustes pós-v1 — base de schema

-- (Ajuste 3) Subcategorias: 2 níveis. parent_id null = categoria de topo;
-- parent_id preenchido = subcategoria daquela categoria.
alter table public.categories
  add column if not exists parent_id uuid references public.categories(id) on delete cascade;
create index if not exists idx_categories_parent
  on public.categories(parent_id) where parent_id is not null;

-- A unicidade era global por (household_id, name); com 2 níveis, o nome deve
-- ser único ENTRE categorias de topo e, separadamente, entre subcategorias do
-- mesmo pai (assim "Geral" pode existir sob vários pais).
alter table public.categories drop constraint if exists categories_household_id_name_key;
create unique index if not exists uniq_categories_top
  on public.categories(household_id, name) where parent_id is null;
create unique index if not exists uniq_categories_sub
  on public.categories(household_id, parent_id, name) where parent_id is not null;

-- (Ajuste 3) Subcategoria escolhida no lançamento (classification continua sendo a categoria de topo).
alter table public.transactions
  add column if not exists subcategory text;

-- (Ajuste 2) Investimento "libera limite do cartão": vínculo 1:1 com um cartão.
-- O valor aplicado nessa posição soma no limite efetivo do cartão; resgatar reduz.
alter table public.investment_positions
  add column if not exists linked_card_id uuid references public.credit_cards(id) on delete set null;
create index if not exists idx_positions_linked_card
  on public.investment_positions(linked_card_id) where linked_card_id is not null;

-- (Ajuste 3) Auto-seed: toda categoria de topo existente ganha uma subcategoria "Geral",
-- para que sempre haja uma opção válida (subcategoria vira obrigatória no app).
insert into public.categories (household_id, name, essencial, is_protected, sort_order, parent_id)
select c.household_id, 'Geral', c.essencial, c.is_protected, 0, c.id
from public.categories c
where c.parent_id is null
  and not exists (select 1 from public.categories s where s.parent_id = c.id);
