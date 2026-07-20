-- Sprint 6: marca o convite como aceito no primeiro login do convidado.
create or replace function public.mark_invite_accepted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.members
     set invite_status = 'accepted', updated_at = now()
   where user_id = new.id
     and invite_status = 'pending';
  return new;
end;
$$;

drop trigger if exists on_auth_user_first_signin on auth.users;
create trigger on_auth_user_first_signin
after update on auth.users
for each row
when (old.last_sign_in_at is null and new.last_sign_in_at is not null)
execute function public.mark_invite_accepted();
