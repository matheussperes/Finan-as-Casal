-- Sprint 6 (complemento): fechamento de brechas apontadas na auditoria.

-- household_balance era SECURITY DEFINER (padrão de views): qualquer
-- authenticated lia nome e saldos de TODOS os casais. Com
-- security_invoker, a view passa a respeitar a RLS de quem consulta.
alter view public.household_balance set (security_invoker = true);

-- Função de trigger não deve ser executável via RPC.
revoke execute on function public.mark_invite_accepted() from public, anon, authenticated;
