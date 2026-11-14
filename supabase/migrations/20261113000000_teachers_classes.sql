-- Leemos: teachers, classes and children shared between a teacher and parents.
-- Spec: docs/superpowers/specs/2026-11-13-teachers-classes-design.md (sections 2, 3 and 7).
-- The one rule: an account sees only the children it is linked to, as a parent (a child_links row) or as a teacher (the child is in one
-- of their classes). The role grants nothing by itself. The previous migration is not edited; this one replaces its policies and grants.
-- Grants start from zero: Supabase's default privileges give anon and authenticated ALL on new tables, so every table revokes them first.
begin;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------------------------------

-- One row per auth user (trigger below). The role is never written by a client: there is no insert/update grant.
-- The first admin is set by hand: update public.accounts set role = 'admin' where user_id = (select id from auth.users where email = '...');
create table public.accounts (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  role            text not null default 'parent' check (role in ('admin','teacher','parent')),
  teacher_ack_at  timestamptz,
  created_at      timestamptz not null default now()
);

create table public.classes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 40),
  created_at  timestamptz not null default now()
);

create table public.class_teachers (
  class_id    uuid not null references public.classes(id) on delete cascade,
  teacher_id  uuid not null references auth.users(id) on delete cascade,
  primary key (class_id, teacher_id)
);
create index class_teachers_teacher_idx on public.class_teachers (teacher_id);

-- Parent links. v1 allows one per child (trigger below).
create table public.child_links (
  child_id  uuid not null references public.child_profiles(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  primary key (child_id, user_id)
);
create index child_links_user_idx on public.child_links (user_id);

-- Teacher invitations by email (section 1); claimed by whoami() at the invited person's sign-in.
create table public.role_invites (
  email       text primary key check (email = lower(email) and position('@' in email) > 1),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '30 days'
);

-- Every admin invitation, demotion and assignment; no client grant, read by SQL.
create table public.admin_log (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  actor   uuid references auth.users(id) on delete set null,
  action  text not null,
  detail  jsonb not null default '{}'::jsonb
);

-- Invitation codes (section 4), stored hashed.
create table public.invites (
  id          uuid primary key default gen_random_uuid(),
  code_hash   text not null unique,
  kind        text not null check (kind in ('to_class','to_parent')),
  child_id    uuid not null references public.child_profiles(id) on delete cascade,
  created_by  uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  used_by     uuid references auth.users(id) on delete set null
);
create index invites_child_idx on public.invites (child_id);
create index invites_created_by_idx on public.invites (created_by);

-- Failed redeems, for the rate limit.
create table public.invite_attempts (
  id       bigint generated always as identity primary key,
  user_id  uuid not null references auth.users(id) on delete cascade,
  at       timestamptz not null default now()
);
create index invite_attempts_user_at_idx on public.invite_attempts (user_id, at);

-- Tombstones (section 5): a deleted child's id can never be inserted again.
create table public.deleted_children (
  id          uuid primary key,
  deleted_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Existing data: every user gets an account (parent) and every child a link to its owner. Nothing else is rewritten.
-- ---------------------------------------------------------------------------------------------------------------------------------
insert into public.accounts (user_id) select id from auth.users on conflict do nothing;
insert into public.child_links (child_id, user_id) select id, owner from public.child_profiles where owner is not null on conflict do nothing;

-- owner becomes informational ("who created the row"): nullable, and deleting that account no longer deletes children others use.
alter table public.child_profiles alter column owner drop not null;
alter table public.child_profiles drop constraint child_profiles_owner_fkey;
alter table public.child_profiles add constraint child_profiles_owner_fkey foreign key (owner) references auth.users(id) on delete set null;
-- A child is in one class or none.
alter table public.child_profiles add column class_id uuid references public.classes(id) on delete set null;
create index child_profiles_class_idx on public.child_profiles (class_id);

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Helpers for the policies. A non-exposed schema (not in the API's schema list), so they are not reachable at /rest/v1/rpc.
-- security definer so policies can read other tables without recursive RLS; empty search_path and fully-qualified names.
-- ---------------------------------------------------------------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.accounts a where a.user_id = (select auth.uid()) and a.role = 'admin');
$$;
revoke execute on function private.is_admin() from public, anon;
grant execute on function private.is_admin() to authenticated;

-- The caller's role; the stable twin of the public whoami(), which may claim an invitation.
create function private.current_role() returns text
language sql stable security definer set search_path = '' as $$
  select a.role from public.accounts a where a.user_id = (select auth.uid());
$$;
revoke execute on function private.current_role() from public, anon;
grant execute on function private.current_role() to authenticated;

-- A teacher of the class who is still a teacher and has accepted the acknowledgement (section 8.2).
create function private.is_class_teacher(p_class uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_class is not null and exists (
    select 1 from public.class_teachers ct join public.accounts a on a.user_id = ct.teacher_id
    where ct.class_id = p_class and ct.teacher_id = (select auth.uid()) and a.role = 'teacher' and a.teacher_ack_at is not null);
$$;
revoke execute on function private.is_class_teacher(uuid) from public, anon;
grant execute on function private.is_class_teacher(uuid) to authenticated;

-- The caller has a parent link to the child.
create function private.has_link(p_child uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.child_links l where l.child_id = p_child and l.user_id = (select auth.uid()));
$$;
revoke execute on function private.has_link(uuid) from public, anon;
grant execute on function private.has_link(uuid) to authenticated;

-- The child has any parent link at all, whoever's (under RLS a plain subquery on child_links would see only the caller's rows).
create function private.has_any_link(p_child uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.child_links l where l.child_id = p_child);
$$;
revoke execute on function private.has_any_link(uuid) from public, anon;
grant execute on function private.has_any_link(uuid) to authenticated;

create function private.is_tombstoned(p_child uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.deleted_children d where d.id = p_child);
$$;
revoke execute on function private.is_tombstoned(uuid) from public, anon;
grant execute on function private.is_tombstoned(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- child_profiles: link-based policies replace the owner-only ones.
-- ---------------------------------------------------------------------------------------------------------------------------------
drop policy "owner reads" on public.child_profiles;
drop policy "owner inserts" on public.child_profiles;
drop policy "owner updates" on public.child_profiles;
drop policy "owner deletes" on public.child_profiles;
drop trigger child_profiles_limit on public.child_profiles;
drop function public.child_profiles_limit();

-- The last clause is the creator's right to see a row they just inserted: with Prefer: return=representation the select policy is
-- checked on the new row before the after-insert trigger writes the creator's link. It stops applying once any link exists or the
-- child is in a class.
create policy "linked or class teacher reads" on public.child_profiles for select to authenticated
  using (private.has_link(id) or private.is_class_teacher(class_id) or (owner = (select auth.uid()) and class_id is null and not private.has_any_link(id)));
create policy "linked or class teacher updates" on public.child_profiles for update to authenticated
  using (private.has_link(id) or private.is_class_teacher(class_id) or (owner = (select auth.uid()) and class_id is null and not private.has_any_link(id)))
  with check (private.has_link(id) or private.is_class_teacher(class_id) or (owner = (select auth.uid()) and class_id is null and not private.has_any_link(id)));
create policy "creator inserts" on public.child_profiles for insert to authenticated
  with check (owner = (select auth.uid()) and (class_id is null or private.is_class_teacher(class_id)) and not private.is_tombstoned(id));
-- No delete policy: a direct delete is revoked; deletion goes through delete_child, which writes the tombstone.

-- The previous migration's grants stay live unless revoked: start from zero, then grant only what is allowed (no delete).
-- Insert covers class_id (a teacher creates a child inside a class); class_id and owner are never client-updatable.
revoke all on public.child_profiles from authenticated;
grant select, insert on public.child_profiles to authenticated;
grant update (name, data, version, kind) on public.child_profiles to authenticated;

-- A class-less child gets a parent link for its creator. security definer: the caller has no write grant on child_links.
create function private.child_profiles_link_creator() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.class_id is null and new.owner is not null then
    insert into public.child_links (child_id, user_id) values (new.id, new.owner) on conflict do nothing;
  end if;
  return null;
end $$;
revoke execute on function private.child_profiles_link_creator() from public, anon;
create trigger child_profiles_link_creator after insert on public.child_profiles
  for each row execute function private.child_profiles_link_creator();

-- At most 8 class-less children created per account. security definer: under the new RLS a creator may not see all their own rows.
-- The per-owner advisory lock serialises one owner's concurrent inserts.
create function private.child_profiles_owner_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.class_id is null and new.owner is not null then
    perform pg_advisory_xact_lock(hashtext(new.owner::text));
    if (select count(*) from public.child_profiles c where c.owner = new.owner and c.class_id is null) >= 8 then
      raise exception 'profile limit reached' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
revoke execute on function private.child_profiles_owner_limit() from public, anon;
create trigger child_profiles_owner_limit before insert on public.child_profiles
  for each row execute function private.child_profiles_owner_limit();

-- At most 60 children per class, on insert and when a child is moved into a class (a code moves it with an UPDATE).
create function private.child_profiles_class_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.class_id is not null and (tg_op = 'INSERT' or new.class_id is distinct from old.class_id) then
    perform pg_advisory_xact_lock(hashtext('class:' || new.class_id::text));
    if (select count(*) from public.child_profiles c where c.class_id = new.class_id) >= 60 then
      raise exception 'class limit reached' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
revoke execute on function private.child_profiles_class_limit() from public, anon;
create trigger child_profiles_class_limit before insert or update of class_id on public.child_profiles
  for each row execute function private.child_profiles_class_limit();

-- One parent link per child in v1 (a second parent is out of scope, section 11).
create function private.child_links_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext('link:' || new.child_id::text));
  if exists (select 1 from public.child_links l where l.child_id = new.child_id and l.user_id <> new.user_id) then
    raise exception 'parent link limit reached' using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke execute on function private.child_links_limit() from public, anon;
create trigger child_links_limit before insert on public.child_links
  for each row execute function private.child_links_limit();

-- The creator's "just inserted" read is one-shot: once a child has no parent link left (unlink, a deleted parent account, a manual
-- delete), its owner is cleared so the select/update clause cannot hand the row back to whoever created it. When the child itself is
-- being deleted (links cascade), the update finds no row and does nothing.
create function private.child_links_clear_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.child_profiles c set owner = null
    where c.id = old.child_id and c.owner is not null
      and not exists (select 1 from public.child_links l where l.child_id = old.child_id);
  return null;
end $$;
revoke execute on function private.child_links_clear_owner() from public, anon;
create trigger child_links_clear_owner after delete on public.child_links
  for each row execute function private.child_links_clear_owner();

-- Every new auth user gets an accounts row with role parent. security definer: auth inserts the user, not the account owner.
create function private.accounts_for_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.accounts (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;
revoke execute on function private.accounts_for_new_user() from public, anon;
create trigger accounts_for_new_user after insert on auth.users
  for each row execute function private.accounts_for_new_user();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- New tables: RLS on, all default privileges revoked, then only the select grants of section 3. No client writes anywhere.
-- ---------------------------------------------------------------------------------------------------------------------------------
alter table public.accounts enable row level security;
revoke all on public.accounts from anon, authenticated;
grant select on public.accounts to authenticated;
create policy "own account reads" on public.accounts for select to authenticated
  using (user_id = (select auth.uid()));

alter table public.classes enable row level security;
revoke all on public.classes from anon, authenticated;
grant select on public.classes to authenticated;
-- An admin, an acknowledged teacher of the class, or anyone who can see a child in it (the subquery runs under the caller's child_profiles RLS).
create policy "admin, teacher or family reads" on public.classes for select to authenticated
  using (private.is_admin()
    or private.is_class_teacher(classes.id)
    or exists (select 1 from public.child_profiles c where c.class_id = classes.id));

alter table public.class_teachers enable row level security;
revoke all on public.class_teachers from anon, authenticated;
grant select on public.class_teachers to authenticated;
create policy "own class rows read" on public.class_teachers for select to authenticated
  using (teacher_id = (select auth.uid()));

alter table public.child_links enable row level security;
revoke all on public.child_links from anon, authenticated;
grant select on public.child_links to authenticated;
create policy "own links read" on public.child_links for select to authenticated
  using (user_id = (select auth.uid()));

-- Server-only tables: RLS on, no policy, no grant. Only the security definer functions read and write them.
alter table public.invites enable row level security;
revoke all on public.invites from anon, authenticated;
alter table public.invite_attempts enable row level security;
revoke all on public.invite_attempts from anon, authenticated;
alter table public.deleted_children enable row level security;
revoke all on public.deleted_children from anon, authenticated;
alter table public.role_invites enable row level security;
revoke all on public.role_invites from anon, authenticated;
alter table public.admin_log enable row level security;
revoke all on public.admin_log from anon, authenticated;
-- Default privileges also cover the identity sequences.
revoke all on sequence public.admin_log_id_seq, public.invite_attempts_id_seq from anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- RPCs (public, security definer): next section.
-- ---------------------------------------------------------------------------------------------------------------------------------

commit;
