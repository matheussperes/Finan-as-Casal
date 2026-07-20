-- ═══════════════════════════════════════════════════════════════════
-- Sprint 6 · CFG-01 — Acesso compartilhado com o cônjuge
--
-- 1) Colunas de status do convite em members
-- 2) Correção de RLS: members_insert_own permitia INSERT em QUALQUER
--    household (bastava saber o UUID) — vazamento entre casais.
-- 3) members_insert_household não pode vincular user_id de terceiros;
--    o vínculo do cônjuge é feito exclusivamente pela service role
--    (Edge Function invite-partner).
-- 4) Cliente não pode alterar members.user_id via UPDATE (grants por
--    coluna) — impede "sequestro" de vínculo por SQL direto no browser.
-- 5) Policies que estavam com role {public} passam para {authenticated}.
-- ═══════════════════════════════════════════════════════════════════

-- 1) Status do convite do cônjuge
alter table public.members
  add column if not exists invite_status text not null default 'none'
    constraint members_invite_status_check
    check (invite_status in ('none', 'pending', 'accepted')),
  add column if not exists invited_at timestamptz;

-- Membros já vinculados a um usuário contam como 'accepted'
update public.members set invite_status = 'accepted' where user_id is not null;

-- 2) INSERT do próprio membro: só no household que o usuário criou
drop policy if exists members_insert_own on public.members;
create policy members_insert_own on public.members
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and household_id in (
      select id from public.households where created_by = auth.uid()
    )
  );

-- 3) INSERT de outros membros do casal: só no próprio household e
--    nunca vinculando outro auth user
drop policy if exists members_insert_household on public.members;
create policy members_insert_household on public.members
  for insert to authenticated
  with check (
    household_id in (select public.user_household_ids())
    and (user_id is null or user_id = auth.uid())
  );

-- 4) UPDATE de members: cliente só pode alterar campos de perfil.
--    user_id, household_id, role e invite_status ficam fora do grant —
--    somente a service role (Edge Function) mexe neles.
revoke update on table public.members from authenticated, anon;
grant update (name, email, birth_date, monthly_income, updated_at)
  on public.members to authenticated;

-- 5) Policies com role public → authenticated (anon nunca acessa)
alter policy assets_all                   on public.assets                   to authenticated;
alter policy categories_all               on public.categories               to authenticated;
alter policy loans_all                    on public.loans                    to authenticated;
alter policy investment_positions_all     on public.investment_positions     to authenticated;
alter policy investment_contributions_all on public.investment_contributions to authenticated;
