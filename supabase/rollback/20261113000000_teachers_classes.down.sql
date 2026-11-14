-- Leemos: rollback of 20261113000000_teachers_classes.sql. Lives OUTSIDE supabase/migrations so `db reset` and `db push` never apply it.
-- It does NOT delete child_profiles rows (children deleted through delete_child after the rollout stay deleted).
-- Run it once, in the SQL editor, after checking for rows without an owner (see README). One transaction: a failure leaves nothing half undone.
-- Tested against a local Supabase by `npm run test:rollback` (never run against production by the test).
begin;

-- Guard: the old schema requires an owner on every child. Assign or delete these rows BEFORE running this file (the README says how).
do $$
declare n integer;
begin
  select count(*) into n from public.child_profiles where owner is null;
  if n > 0 then
    raise exception 'rollback aborted: % child_profiles row(s) have no owner. Assign an owner or delete them first (see README).', n;
  end if;
end $$;

-- Policies of the new migration (the ones on child_profiles depend on class_id and on the private helpers).
drop policy "linked or class teacher reads" on public.child_profiles;
drop policy "linked or class teacher updates" on public.child_profiles;
drop policy "creator inserts" on public.child_profiles;

-- Triggers added by the new migration.
drop trigger accounts_for_new_user on auth.users;
drop trigger child_profiles_link_creator on public.child_profiles;
drop trigger child_profiles_owner_limit on public.child_profiles;
drop trigger child_profiles_class_limit on public.child_profiles;

-- Public functions (RPCs and the computed column).
drop function public.has_parent(public.child_profiles);
drop function public.whoami();
drop function public.ack_teacher();
drop function public.create_invite(uuid, text);
drop function public.redeem_invite(text, uuid);
drop function public.leave_class(uuid);
drop function public.unlink_me(uuid);
drop function public.delete_child(uuid);
drop function public.export_my_data();
drop function public.delete_my_account();
drop function public.admin_list_accounts();
drop function public.admin_list_classes();
drop function public.admin_invite_teacher(text);
drop function public.admin_revoke_invite(text);
drop function public.admin_demote_teacher(uuid);
drop function public.admin_create_class(text);
drop function public.admin_rename_class(uuid, text);
drop function public.admin_delete_class(uuid);
drop function public.admin_assign_teacher(uuid, uuid);
drop function public.admin_unassign_teacher(uuid, uuid);

-- Tables (their policies, triggers and indexes go with them), then the private schema (helpers and trigger functions).
drop policy "admin, teacher or family reads" on public.classes; -- reads child_profiles.class_id
alter table public.child_profiles drop column class_id;
drop table public.invites, public.invite_attempts, public.child_links, public.class_teachers, public.role_invites,
  public.admin_log, public.deleted_children, public.classes, public.accounts;
drop schema private cascade;

-- child_profiles exactly as 20261017000000_child_profiles.sql left it.
alter table public.child_profiles drop constraint child_profiles_owner_fkey;
alter table public.child_profiles alter column owner set not null;
alter table public.child_profiles add constraint child_profiles_owner_fkey foreign key (owner) references auth.users(id) on delete cascade;

revoke all on public.child_profiles from anon;
revoke all on public.child_profiles from authenticated;
-- Supabase's default privileges gave authenticated everything except what the old migration revoked (update at table level).
grant select, insert, delete, references, trigger, truncate on public.child_profiles to authenticated;
grant update (name, data, version) on public.child_profiles to authenticated;

create policy "owner reads" on public.child_profiles for select to authenticated
  using (owner = (select auth.uid()));
create policy "owner inserts" on public.child_profiles for insert to authenticated
  with check (owner = (select auth.uid()));
create policy "owner updates" on public.child_profiles for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
create policy "owner deletes" on public.child_profiles for delete to authenticated
  using (owner = (select auth.uid()));

create function public.child_profiles_limit() returns trigger
language plpgsql set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext(new.owner::text));
  if (select count(*) from public.child_profiles where owner = new.owner) >= 8 then
    raise exception 'profile limit reached' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger child_profiles_limit before insert on public.child_profiles
  for each row execute function public.child_profiles_limit();

commit;
