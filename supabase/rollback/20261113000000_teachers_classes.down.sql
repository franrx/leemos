-- Leemos: rollback of 20261113000000_teachers_classes.sql. Lives OUTSIDE supabase/migrations so `db reset` and `db push` never apply it.
-- It does NOT delete child_profiles rows. One transaction: a failure leaves nothing half undone.
-- Lost BY DESIGN: tombstones (an old client that still has a deleted child locally can insert it again), teachers' access to classes,
-- parent links, invites, the admin log and the code secret. Children with a parent link are handed back to that parent (owner = the
-- linked parent). Unclaimed class children stop it (see the guard): someone must decide who gets them.
-- If you roll back after publishing the new client, un-publish it first: it calls whoami and the other RPCs, which disappear here.
-- Tested against a local Supabase by `npm run test:rollback` (the script only ever talks to the local Docker database).
begin;

-- The old policies give a child to its owner, so a child with a parent link goes back to that parent (v1: at most one link per child).
-- Without this, a class child created by a teacher (owner = teacher) and claimed by a parent would stay with the teacher.
update public.child_profiles c set owner = l.user_id from public.child_links l where l.child_id = c.id and c.owner is distinct from l.user_id;

-- Guard: the old schema requires an owner on every child, and gives the child to that owner. Two kinds of row need a person's decision
-- BEFORE running this file (the README says how): rows still without an owner (unlinked), and class children nobody has claimed (no
-- parent link): their owner is the teacher who created them, maybe one since demoted or unassigned, and the old policies would hand
-- them back to that teacher while the class's current teacher loses them.
do $$
declare n integer;
begin
  select count(*) into n from public.child_profiles c
    where c.owner is null or (c.class_id is not null and not exists (select 1 from public.child_links l where l.child_id = c.id));
  if n > 0 then
    raise exception 'rollback aborted: % child_profiles row(s) have no owner, or are class children with no parent link. Decide who gets each one (an owner for a class-less row, a parent link for a class child) or delete them first (see README).', n;
  end if;
end $$;

-- Policies of the new migration (the ones on child_profiles depend on class_id and on the private helpers).
drop policy "linked or class teacher reads" on public.child_profiles;
drop policy "linked or class teacher updates" on public.child_profiles;
drop policy "creator inserts" on public.child_profiles;

-- Triggers added by the new migration.
drop trigger accounts_for_new_user on auth.users;
drop trigger children_of_deleted_user on auth.users;
drop trigger child_profiles_link_creator on public.child_profiles;
drop trigger child_profiles_owner_limit on public.child_profiles;
drop trigger child_profiles_class_limit on public.child_profiles;
drop trigger child_profiles_version on public.child_profiles;
drop trigger child_profiles_data on public.child_profiles;

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
drop function public.admin_drop_teacher_links(uuid, uuid);

-- Tables (their policies, triggers and indexes go with them; child_links takes its granted_by column), then the private schema (helpers and trigger functions).
drop policy "admin, teacher or family reads" on public.classes; -- reads child_profiles.class_id
alter table public.child_profiles drop column class_id;
drop table public.invites, public.invite_attempts, public.child_links, public.class_teachers, public.role_invites,
  public.admin_log, public.deleted_children, public.classes, public.accounts;
drop function private.caller();
drop function private.is_admin();
drop function private.current_role();
drop function private.is_class_teacher(uuid);
drop function private.has_link(uuid);
drop function private.has_any_link(uuid);
drop function private.is_tombstoned(uuid);
drop function private.child_profiles_link_creator();
drop function private.child_profiles_owner_limit();
drop function private.child_profiles_class_limit();
drop function private.child_profiles_version();
drop function private.child_profiles_data();
drop function private.child_links_limit();
drop function private.child_links_clear_owner();
drop function private.accounts_for_new_user();
drop function private.children_of_deleted_user();
drop function private.claim_role();
drop function private.invite_hash(text);
drop function private.granted_links(uuid, uuid);
drop table private.secrets;
drop schema private; -- no cascade: an omission above fails loudly

-- child_profiles exactly as 20261017000000_child_profiles.sql left it.
alter table public.child_profiles drop constraint child_profiles_owner_fkey;
alter table public.child_profiles alter column owner set not null;
alter table public.child_profiles add constraint child_profiles_owner_fkey foreign key (owner) references auth.users(id) on delete cascade;

revoke all on public.child_profiles from anon;
revoke all on public.child_profiles from authenticated;
grant select, insert, delete on public.child_profiles to authenticated;
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
