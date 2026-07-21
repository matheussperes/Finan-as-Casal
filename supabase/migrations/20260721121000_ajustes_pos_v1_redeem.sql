-- Ajuste 2 — Resgate de investimento (espelho de transfer_to_investment).
-- Preserva a invariante D1: saldo_disponivel + total_investido não muda.
-- Resgatar entra na conta (income) e reduz valor_aplicado da posição.
-- Se a posição tiver linked_card_id ("libera limite"), o resgate reduz
-- automaticamente o limite efetivo do cartão (calculado a partir do
-- valor_aplicado — não há coluna redundante a sincronizar).
create or replace function redeem_from_investment(
  p_household_id  uuid,
  p_account_id    uuid,
  p_position_id   uuid,
  p_amount        numeric,
  p_date          date,
  p_description   text default null,
  p_member_id     uuid default null
) returns table (transaction_id uuid) as $$
declare
  v_tx_id     uuid;
  v_group_id  uuid := gen_random_uuid();
  v_applied   numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Valor do resgate deve ser positivo';
  end if;

  select valor_aplicado into v_applied
    from public.investment_positions
   where id = p_position_id and account_id = p_account_id and household_id = p_household_id
   for update;

  if v_applied is null then
    raise exception 'Posição de investimento não pertence a esta conta/household';
  end if;
  if p_amount > v_applied then
    raise exception 'Valor do resgate maior que o valor aplicado na posição';
  end if;

  insert into public.transactions (
    household_id, account_id, member_id, direction, amount, description,
    date, classification, payment_method, linked_position_id, transfer_group_id
  ) values (
    p_household_id, p_account_id, p_member_id, 'income', p_amount,
    coalesce(p_description, 'Resgate de investimento'),
    p_date, 'Classificação neutra', 'transferencia', p_position_id, v_group_id
  ) returning id into v_tx_id;

  update public.investment_positions
     set valor_aplicado = valor_aplicado - p_amount,
         updated_at     = now()
   where id = p_position_id and household_id = p_household_id;

  transaction_id := v_tx_id;
  return next;
end;
$$ language plpgsql security invoker set search_path = '';
