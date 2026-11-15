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

-- Parent links. v1 allows one per child (trigger below). granted_by: the account whose to_parent code made this link (null for a creator's
-- link or a backfilled one). No foreign key on purpose: the provenance must outlive that account, so an admin can still review and undo
-- the grants of a teacher who deleted their own account (private.granted_links, admin_drop_teacher_links).
create table public.child_links (
  child_id    uuid not null references public.child_profiles(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  granted_by  uuid,
  primary key (child_id, user_id)
);
create index child_links_user_idx on public.child_links (user_id);
create index child_links_granted_by_idx on public.child_links (granted_by) where granted_by is not null;

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

-- The caller, only while their account exists. A deleted account's access token stays valid until it expires (PostgREST checks only
-- the signature and expiry), and auth.uid() keeps returning its id: every RPC and the insert policy take the caller from here, so that
-- token acts as no one (forbidden) instead of reaching a foreign key error (which rolled back the redeem rate limit and told a valid
-- code from a wrong one). accounts cascades from auth.users, so a row here means the user exists.
create function private.caller() returns uuid
language sql stable security definer set search_path = '' as $$
  select a.user_id from public.accounts a where a.user_id = (select auth.uid());
$$;
revoke execute on function private.caller() from public, anon;
grant execute on function private.caller() to authenticated;

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

-- A computed column of child_profiles (PostgREST: select=...,has_parent): a boolean per row the caller can already read, so a teacher
-- knows whether a child still needs a code for the parents. It never says who the parent is. The row is looked up again and the
-- predicate of the child_profiles select policy is repeated EXACTLY (link, class teacher, or the creator's one-shot clause), because
-- /rpc/has_parent can also be called with a made-up row and a demoted teacher must get nothing. Keep it identical to that policy.
create function public.has_parent(public.child_profiles) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select private.has_any_link(c.id) from public.child_profiles c
    where c.id = $1.id and (private.has_link(c.id) or private.is_class_teacher(c.class_id)
      or (c.owner = (select auth.uid()) and c.class_id is null and not private.has_any_link(c.id)))), false);
$$;
revoke execute on function public.has_parent(public.child_profiles) from public, anon;
grant execute on function public.has_parent(public.child_profiles) to authenticated;

create function private.is_tombstoned(p_child uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.deleted_children d where d.id = p_child);
$$;
revoke execute on function private.is_tombstoned(uuid) from public, anon;
grant execute on function private.is_tombstoned(uuid) to authenticated;

-- Server secrets, outside the API's schemas and with every privilege revoked: only security definer functions read them.
-- invite_hmac keys the stored hash of the invitation codes. 32^8 codes is about 2^40: an unkeyed SHA-256 of every code takes minutes on
-- one GPU, so a copy of public.invites alone would give back every live code. With the key, that copy is useless without this row.
create table private.secrets (
  name   text primary key,
  value  bytea not null
);
alter table private.secrets enable row level security;
revoke all on private.secrets from public, anon, authenticated;
insert into private.secrets (name, value) values ('invite_hmac', extensions.gen_random_bytes(32));

-- The stored form of a code: HMAC-SHA256 with the secret above, hex. Used by create_invite and redeem_invite only (no grant).
create function private.invite_hash(p_code text) returns text
language sql stable security definer set search_path = '' as $$
  select encode(extensions.hmac(convert_to(p_code, 'UTF8'), (select s.value from private.secrets s where s.name = 'invite_hmac'), 'sha256'), 'hex');
$$;
revoke execute on function private.invite_hash(text) from public, anon;
revoke execute on function private.invite_hash(text) from authenticated;

-- The parent links that came from p_user's redeemed to_parent codes (child_links.granted_by, written by redeem_invite), optionally only
-- for the children now in p_class. A teacher chooses who receives a parent code, and a code cannot be tied to a person: this is what an
-- admin reviews, and may drop, when that teacher is demoted or unassigned, or has deleted their account (granted_by has no foreign key,
-- so it survives the account and its invites). Called only from the admin functions (no grant).
create function private.granted_links(p_user uuid, p_class uuid) returns table (child_id uuid, user_id uuid, class_id uuid)
language sql stable set search_path = '' as $$
  select l.child_id, l.user_id, c.class_id from public.child_links l join public.child_profiles c on c.id = l.child_id
  where l.granted_by = p_user and (p_class is null or c.class_id = p_class);
$$;
revoke execute on function private.granted_links(uuid, uuid) from public, anon;
revoke execute on function private.granted_links(uuid, uuid) from authenticated;

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
  with check (owner = (select private.caller()) and (class_id is null or private.is_class_teacher(class_id)) and not private.is_tombstoned(id));
-- No delete policy: a direct delete is revoked; deletion goes through delete_child, which writes the tombstone.

-- The previous migration's grants stay live unless revoked: start from zero, then grant only what is allowed (no delete).
-- Insert covers class_id (a teacher creates a child inside a class); class_id and owner are never client-updatable.
revoke all on public.child_profiles from authenticated;
grant select, insert on public.child_profiles to authenticated;
grant update (name, data, version, kind) on public.child_profiles to authenticated;

-- version is the optimistic-lock token, now writable by lower-trust accounts (a class teacher, a code's redeemer): the server controls it.
-- A new row starts at 1; an update moves it at most one step up (the client writes row.version + 1 under version=eq.<row.version>), so
-- nobody can plant 2147483647 and make every later write overflow the integer (which would break that child's sync for every account).
-- A plain trigger (no definer): it reads only old and new. The step is computed in bigint: on a row already at the maximum (planted
-- before the server controlled it) old.version + 1 would overflow the integer even when the client writes 1 to start again.
create function private.child_profiles_version() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
  elsif new.version is distinct from old.version then
    new.version := least(new.version::bigint, old.version::bigint + 1)::integer;
  end if;
  return new;
end $$;
revoke execute on function private.child_profiles_version() from public, anon;
create trigger child_profiles_version before insert or update on public.child_profiles
  for each row execute function private.child_profiles_version();

-- The merge tokens inside data are server-owned too (src/merge.js trusts them on every family device): a class teacher or a code's
-- redeemer could otherwise plant end-of-time stamps or capped counters that pin level, name and language and disable "Borrar progreso",
-- and they would outlive leave_class. Every write: data.modAt, data.session.at and each data.prefs.*.at at most now() + 10 min (epoch
-- ms; a device clock a little ahead still passes); data.level at most 4, the last index of src/data/levels.{es,ca}.json (5 levels;
-- tests/migration.mjs checks it); data.resets.es/ca at most old + 1 per update ("Borrar progreso" adds 1) and at most 1000 on insert.
-- On update a counter never goes down: when the old one is a safe integer (0..2^53-1), the stored value is
-- greatest(floor(old), least(new, floor(old) + 1)), and a write without a numeric value (or without a resets object, or with non-object
-- data) keeps the old one. No client lowers it (src/sync.js capResets pushes at least the row's counter), so this only stops a writer
-- from lowering or dropping it, which would make a stale family device's older stats win again after leave_class.
-- A writer can still raise resets by 1 per write, any number of times, but src/merge.js puts no reachable cap on them (any safe
-- integer, 2^53 writes away), so repetition only makes the family's next reset one higher: it never reaches a state that defeats it.
-- Only numbers are touched: other keys with odd types are left alone (merge.js ignores them), so no write ever fails here.
create function private.child_profiles_data() returns trigger
language plpgsql set search_path = '' as $$
declare
  d jsonb := new.data;
  cap numeric := floor(extract(epoch from now()) * 1000) + 600000;
  p jsonb;
  lang text;
  allowed numeric;
  keep jsonb := '{}'::jsonb;
  o numeric;
begin
  -- the old counters a write may not lower: safe integers >= 0 (anything else keeps the plain upper bound below)
  if tg_op = 'UPDATE' and jsonb_typeof(old.data) = 'object' and jsonb_typeof(old.data->'resets') = 'object' then
    foreach lang in array array['es', 'ca'] loop
      if jsonb_typeof(old.data->'resets'->lang) = 'number' and (old.data->'resets'->>lang)::numeric between 0 and 9007199254740991 then
        keep := keep || jsonb_build_object(lang, floor((old.data->'resets'->>lang)::numeric));
      end if;
    end loop;
  end if;
  if keep <> '{}'::jsonb and (d is null or jsonb_typeof(d) <> 'object') then d := '{}'::jsonb; end if;
  if d is null or jsonb_typeof(d) <> 'object' then return new; end if;
  if keep <> '{}'::jsonb and jsonb_typeof(d->'resets') is distinct from 'object' then d := jsonb_set(d, '{resets}', '{}'::jsonb); end if;
  if jsonb_typeof(d->'modAt') = 'number' and (d->>'modAt')::numeric > cap then d := jsonb_set(d, '{modAt}', to_jsonb(cap)); end if;
  if jsonb_typeof(d->'session') = 'object' and jsonb_typeof(d->'session'->'at') = 'number' and (d->'session'->>'at')::numeric > cap then
    d := jsonb_set(d, '{session,at}', to_jsonb(cap));
  end if;
  if jsonb_typeof(d->'prefs') = 'object' then
    select coalesce(jsonb_object_agg(e.key, case when jsonb_typeof(e.value) = 'object' and jsonb_typeof(e.value->'at') = 'number'
                                                  and (e.value->>'at')::numeric > cap then jsonb_set(e.value, '{at}', to_jsonb(cap)) else e.value end), '{}'::jsonb)
      into p from jsonb_each(d->'prefs') e;
    d := jsonb_set(d, '{prefs}', p);
  end if;
  if jsonb_typeof(d->'level') = 'number' and (d->>'level')::numeric > 4 then d := jsonb_set(d, '{level}', '4'::jsonb); end if;
  if jsonb_typeof(d->'resets') = 'object' then
    foreach lang in array array['es', 'ca'] loop
      if keep ? lang then
        o := (keep->>lang)::numeric;
        if jsonb_typeof(d->'resets'->lang) = 'number' then o := greatest(o, least((d->'resets'->>lang)::numeric, o + 1)); end if;
        if d->'resets'->lang is distinct from to_jsonb(o) then d := jsonb_set(d, array['resets', lang], to_jsonb(o)); end if;
        continue;
      end if;
      continue when jsonb_typeof(d->'resets'->lang) is distinct from 'number';
      allowed := 1000;
      if tg_op = 'UPDATE' then
        allowed := 1;
        if jsonb_typeof(old.data->'resets'->lang) = 'number' then allowed := greatest(0, floor((old.data->'resets'->>lang)::numeric)) + 1; end if;
      end if;
      if (d->'resets'->>lang)::numeric > allowed then d := jsonb_set(d, array['resets', lang], to_jsonb(allowed)); end if;
    end loop;
  end if;
  new.data := d;
  return new;
end $$;
revoke execute on function private.child_profiles_data() from public, anon;
create trigger child_profiles_data before insert or update on public.child_profiles
  for each row execute function private.child_profiles_data();

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

-- A user deleted outside the app (the Supabase dashboard, the Auth admin API: the usual way to answer an emailed erasure request) gets
-- what delete_my_account does: their linked children without a class are deleted with tombstones; classed ones stay in their class,
-- unlinked (the links cascade), and their pending codes are voided. Without it those children would be left with no owner, class or
-- link, unreachable by anyone.
-- delete_my_account has already done this when it deletes the user, so there it finds nothing. security definer: auth deletes the user.
create function private.children_of_deleted_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.child_profiles c where c.id in (select l.child_id from public.child_links l where l.user_id = old.id) order by c.id for update;
  insert into public.deleted_children (id)
    select c.id from public.child_profiles c join public.child_links l on l.child_id = c.id
    where l.user_id = old.id and c.class_id is null
      and not exists (select 1 from public.child_links o where o.child_id = c.id and o.user_id <> old.id)
    on conflict do nothing;
  delete from public.child_profiles c using public.child_links l
    where l.child_id = c.id and l.user_id = old.id and c.class_id is null
      and not exists (select 1 from public.child_links o where o.child_id = c.id and o.user_id <> old.id);
  -- The classed children lose their parent with the cascade below: no pending code of theirs may outlive it and claim them again.
  delete from public.invites i using public.child_links l where i.child_id = l.child_id and l.user_id = old.id and i.used_at is null;
  -- Parent links this account granted with its to_parent codes stay (they are other families' links, never dropped silently) and keep
  -- granted_by; the admin is told, so they can be reviewed and undone with admin_drop_teacher_links(<this id>).
  insert into public.admin_log (actor, action, detail)
    select null, 'granter_deleted', jsonb_build_object('user_id', old.id,
      'parent_links', count(*) filter (where c.class_id is not null), 'outside_class', count(*) filter (where c.class_id is null),
      'child_ids', jsonb_agg(l.child_id order by l.child_id))
    from public.child_links l join public.child_profiles c on c.id = l.child_id
    where l.granted_by = old.id and l.user_id <> old.id
    having count(*) > 0;
  return old;
end $$;
revoke execute on function private.children_of_deleted_user() from public, anon;
create trigger children_of_deleted_user before delete on auth.users
  for each row execute function private.children_of_deleted_user();

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
grant select (child_id, user_id) on public.child_links to authenticated; -- not granted_by: who granted a link is for the admin only
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
-- RPCs (public, security definer). Each one checks the caller inside the function and fails closed. Expected failures are a value,
-- {"error":"<code>"}, never a raised error; success is {"ok":true,...}. Codes: forbidden, invalid, rate, already_in_class, has_parent,
-- orphan, orphans, limit, not_found, last_admin, bad_input. A child the caller cannot see answers not_found, like a child that does not exist.
-- ---------------------------------------------------------------------------------------------------------------------------------

-- The teacher invitation claim (section 1). Called only from whoami(): no grant. The verified email of the signed-in user (auth.users,
-- confirmed) is matched lower-cased against a pending, unexpired invitation; a parent becomes teacher and the invitation is deleted.
create function private.claim_role() returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_inv public.role_invites;
begin
  if v_uid is null then return; end if;
  select lower(u.email) into v_email from auth.users u where u.id = v_uid and u.email_confirmed_at is not null;
  if v_email is null then return; end if;
  delete from public.role_invites r where r.email = v_email and r.expires_at > now() returning r.* into v_inv;
  if v_inv.email is null then return; end if;
  update public.accounts a set role = 'teacher' where a.user_id = v_uid and a.role = 'parent';
  -- Logged only when the role changed (an admin who was also invited keeps their role; the invitation is still consumed).
  if found then
    insert into public.admin_log (actor, action, detail)
      values (v_uid, 'claim_teacher', jsonb_build_object('email', v_inv.email, 'invited_by', v_inv.created_by));
  end if;
end $$;
revoke execute on function private.claim_role() from public, anon;

-- Volatile: it may claim an invitation. The client calls it after every sign-in and at app start.
create function public.whoami() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_res jsonb;
begin
  if private.caller() is null then return jsonb_build_object('error', 'forbidden'); end if;
  perform private.claim_role();
  select jsonb_build_object('role', a.role, 'teacher_ack_at', a.teacher_ack_at) into v_res from public.accounts a where a.user_id = auth.uid();
  return coalesce(v_res, jsonb_build_object('role', 'parent', 'teacher_ack_at', null));
end $$;
revoke execute on function public.whoami() from public, anon;
grant execute on function public.whoami() to authenticated;

-- The teacher acknowledgement (section 8.2): until it is set, is_class_teacher() is false and the teacher reads no class child.
create function public.ack_teacher() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_at timestamptz;
begin
  if private.current_role() is distinct from 'teacher' then return jsonb_build_object('error', 'forbidden'); end if;
  update public.accounts a set teacher_ack_at = coalesce(a.teacher_ack_at, now()) where a.user_id = auth.uid() returning a.teacher_ack_at into v_at;
  return jsonb_build_object('ok', true, 'teacher_ack_at', v_at);
end $$;
revoke execute on function public.ack_teacher() from public, anon;
grant execute on function public.ack_teacher() to authenticated;

-- An invitation code (section 4): to_class by the linked parent of a class-less child, to_parent by a teacher of the child's class for a
-- child with no parent link. 8 characters from 32 unambiguous ones (256 is a multiple of 32: no bias), 7 days, at most 5 pending per
-- child. Only the keyed hash (private.invite_hash: HMAC-SHA256 with a server secret) is stored; the code is returned once.
create function public.create_invite(p_child uuid, p_kind text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.caller();
  v_alpha constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_class uuid;
  v_bytes bytea;
  v_code text;
  v_id uuid;
  v_exp timestamptz := now() + interval '7 days';
begin
  if v_uid is null or p_kind is null or p_kind not in ('to_class', 'to_parent') then return jsonb_build_object('error', 'forbidden'); end if;
  perform pg_advisory_xact_lock(hashtext('invite:' || p_child::text));
  select c.class_id into v_class from public.child_profiles c where c.id = p_child;
  if not found or not (private.has_link(p_child) or private.is_class_teacher(v_class)) then return jsonb_build_object('error', 'not_found'); end if;
  if p_kind = 'to_class' then
    if not private.has_link(p_child) then return jsonb_build_object('error', 'forbidden'); end if;
    if v_class is not null then return jsonb_build_object('error', 'already_in_class'); end if;
  else
    if not private.is_class_teacher(v_class) then return jsonb_build_object('error', 'forbidden'); end if;
    if private.has_any_link(p_child) then return jsonb_build_object('error', 'has_parent'); end if;
  end if;
  if (select count(*) from public.invites i where i.child_id = p_child and i.used_at is null and i.expires_at > now()) >= 5 then
    return jsonb_build_object('error', 'limit');
  end if;
  loop
    v_bytes := extensions.gen_random_bytes(8);
    v_code := '';
    for i in 0..7 loop
      v_code := v_code || substr(v_alpha, (get_byte(v_bytes, i) % 32) + 1, 1);
    end loop;
    insert into public.invites (code_hash, kind, child_id, created_by, expires_at)
      values (private.invite_hash(v_code), p_kind, p_child, v_uid, v_exp)
      on conflict (code_hash) do nothing returning id into v_id;
    exit when v_id is not null;
  end loop;
  return jsonb_build_object('ok', true, 'code', v_code, 'expires_at', v_exp);
end $$;
revoke execute on function public.create_invite(uuid, text) from public, anon;
grant execute on function public.create_invite(uuid, text) to authenticated;

-- Redeems a code (section 4). Order: rate limit; find the code (wrong, used, expired, void and own codes all answer 'invalid'); the
-- role, class, ownership and limit checks; and only then the single-statement consume, so a refused redeem never uses up a code.
-- Every failure is recorded in invite_attempts and returned as a value: an error would roll the record back with the transaction.
-- The child row is locked (for update) so two codes for one child cannot both move it.
create function public.redeem_invite(p_code text, p_class uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.caller();
  v_inv public.invites;
  v_child public.child_profiles;
  v_used uuid;
  v_err text;
begin
  if v_uid is null then return jsonb_build_object('error', 'forbidden'); end if;
  -- Hold the caller's user row: a deletion running now waits for this redeem (so the failure record below never meets a vanished user),
  -- and one that already committed answers the same forbidden as a deleted account, before any code is looked at.
  perform 1 from auth.users u where u.id = v_uid for key share;
  if not found then return jsonb_build_object('error', 'forbidden'); end if;
  perform pg_advisory_xact_lock(hashtext('redeem:' || v_uid::text));
  delete from public.invite_attempts t where t.user_id = v_uid and t.at < now() - interval '1 hour';
  if (select count(*) from public.invite_attempts t where t.user_id = v_uid and t.at > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('error', 'rate');
  end if;

  <<checks>>
  begin
    select i.* into v_inv from public.invites i
      where i.code_hash = private.invite_hash(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')))
        and i.used_at is null and i.expires_at > now();
    if v_inv.id is null or v_inv.created_by = v_uid then v_err := 'invalid'; exit checks; end if;
    select c.* into v_child from public.child_profiles c where c.id = v_inv.child_id for update;
    if v_child.id is null then v_err := 'invalid'; exit checks; end if;
    -- Re-check the code under the child lock: a concurrent redeem of the same code that won while we waited has moved or linked the
    -- child, and the loser must get the uniform 'invalid', not a class or link error. Lock order: child, then invite.
    perform 1 from public.invites i where i.id = v_inv.id and i.used_at is null and i.expires_at > now();
    if not found then v_err := 'invalid'; exit checks; end if;
    -- The class box takes only to_class codes: a to_parent code with a class is refused and stays valid for the family (a teacher must
    -- never end up as the parent of a child through a colleague's code). Same uniform answer as any other bad code.
    if v_inv.kind = 'to_parent' and p_class is not null then v_err := 'invalid'; exit checks; end if;
    -- Void: the creator lost the right to make this code.
    if v_inv.kind = 'to_class' and not exists (select 1 from public.child_links l where l.child_id = v_child.id and l.user_id = v_inv.created_by) then
      v_err := 'invalid'; exit checks;
    end if;
    if v_inv.kind = 'to_parent' and not exists (
      select 1 from public.class_teachers ct join public.accounts a on a.user_id = ct.teacher_id
      where ct.class_id = v_child.class_id and ct.teacher_id = v_inv.created_by and a.role = 'teacher' and a.teacher_ack_at is not null) then
      v_err := 'invalid'; exit checks;
    end if;
    if v_inv.kind = 'to_class' then
      if not private.is_class_teacher(p_class) then v_err := 'forbidden'; exit checks; end if;
      if v_child.class_id is not null then v_err := 'already_in_class'; exit checks; end if;
      perform pg_advisory_xact_lock(hashtext('class:' || p_class::text));
      -- Re-check under the class lock: the class may have been deleted (or the caller unassigned) while we waited. Uniform answer,
      -- never a foreign key error from the move below.
      if not private.is_class_teacher(p_class) or not exists (select 1 from public.classes k where k.id = p_class) then v_err := 'invalid'; exit checks; end if;
      if (select count(*) from public.child_profiles c where c.class_id = p_class) >= 60 then v_err := 'limit'; exit checks; end if;
    else
      if private.has_any_link(v_child.id) then v_err := 'has_parent'; exit checks; end if;
      -- The redeemer's own 8: a parent links at most 8 children (the same per-account lock as the creation limit).
      perform pg_advisory_xact_lock(hashtext(v_uid::text));
      if (select count(*) from public.child_links l where l.user_id = v_uid) >= 8 then v_err := 'limit'; exit checks; end if;
    end if;
    update public.invites i set used_at = now(), used_by = v_uid
      where i.id = v_inv.id and i.used_at is null and i.expires_at > now() returning i.id into v_used;
    if v_used is null then v_err := 'invalid'; exit checks; end if;
  end checks;

  if v_err is not null then
    insert into public.invite_attempts (user_id) values (v_uid);
    return jsonb_build_object('error', v_err);
  end if;
  if v_inv.kind = 'to_class' then
    update public.child_profiles c set class_id = p_class where c.id = v_child.id;
  else
    insert into public.child_links (child_id, user_id, granted_by) values (v_child.id, v_uid, v_inv.created_by);
    -- The child has its parent now: the other parent codes would only answer has_parent, and would claim it again if that parent
    -- ever went away (account deleted, unlinked). They go. A to_parent code is a grant the admin may need to review: log it.
    delete from public.invites i where i.child_id = v_child.id and i.kind = 'to_parent' and i.used_at is null;
    insert into public.admin_log (actor, action, detail)
      values (v_uid, 'redeem_to_parent', jsonb_build_object('child_id', v_child.id, 'teacher', v_inv.created_by, 'invite_id', v_inv.id));
  end if;
  return jsonb_build_object('ok', true, 'child_id', v_child.id);
end $$;
revoke execute on function public.redeem_invite(text, uuid) from public, anon;
grant execute on function public.redeem_invite(text, uuid) to authenticated;

-- Takes a child out of its class (section 5): its linked parent or a teacher of the class. Refused for a child with no parent link
-- (nobody could see it afterwards). Deletes the child's pending codes.
create function public.leave_class(p_child uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_class uuid;
begin
  if private.caller() is null then return jsonb_build_object('error', 'forbidden'); end if;
  select c.class_id into v_class from public.child_profiles c where c.id = p_child for update;
  if not found or not (private.has_link(p_child) or private.is_class_teacher(v_class)) then return jsonb_build_object('error', 'not_found'); end if;
  if v_class is null then return jsonb_build_object('ok', true); end if;
  if not private.has_any_link(p_child) then return jsonb_build_object('error', 'orphan'); end if;
  update public.child_profiles c set class_id = null where c.id = p_child;
  delete from public.invites i where i.child_id = p_child and i.used_at is null;
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.leave_class(uuid) from public, anon;
grant execute on function public.leave_class(uuid) to authenticated;

-- Removes the caller's own parent link and the child's pending codes. A child left with no link and no class is deleted (tombstone).
create function public.unlink_me(p_child uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_class uuid;
  v_deleted boolean := false;
begin
  if private.caller() is null then return jsonb_build_object('error', 'forbidden'); end if;
  select c.class_id into v_class from public.child_profiles c where c.id = p_child for update;
  if not found or not private.has_link(p_child) then return jsonb_build_object('error', 'not_found'); end if;
  delete from public.child_links l where l.child_id = p_child and l.user_id = auth.uid();
  delete from public.invites i where i.child_id = p_child and i.used_at is null;
  if v_class is null and not private.has_any_link(p_child) then
    insert into public.deleted_children (id) values (p_child) on conflict do nothing;
    delete from public.child_profiles c where c.id = p_child;
    v_deleted := true;
  end if;
  return jsonb_build_object('ok', true, 'deleted', v_deleted);
end $$;
revoke execute on function public.unlink_me(uuid) from public, anon;
grant execute on function public.unlink_me(uuid) to authenticated;

-- Deletes a child and writes its tombstone (section 5): a child with a parent link only by that parent; one with none only by a
-- teacher of its class.
create function public.delete_child(p_child uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_class uuid;
begin
  if private.caller() is null then return jsonb_build_object('error', 'forbidden'); end if;
  select c.class_id into v_class from public.child_profiles c where c.id = p_child for update;
  if not found or not (private.has_link(p_child) or private.is_class_teacher(v_class)) then return jsonb_build_object('error', 'not_found'); end if;
  if private.has_any_link(p_child) then
    if not private.has_link(p_child) then return jsonb_build_object('error', 'forbidden'); end if;
  elsif not private.is_class_teacher(v_class) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  insert into public.deleted_children (id) values (p_child) on conflict do nothing;
  delete from public.child_profiles c where c.id = p_child;
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.delete_child(uuid) from public, anon;
grant execute on function public.delete_child(uuid) to authenticated;

-- Everything the caller can see (section 8.3): the account, its classes (taught, or of a linked child) and every accessible child.
create function public.export_my_data() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.caller();
begin
  if v_uid is null then return jsonb_build_object('error', 'forbidden'); end if;
  return jsonb_build_object(
    'account', (select jsonb_build_object('email', u.email, 'role', a.role) from auth.users u left join public.accounts a on a.user_id = u.id where u.id = v_uid),
    'classes', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name) order by k.name) from public.classes k
      where private.is_class_teacher(k.id)
         or exists (select 1 from public.child_profiles c join public.child_links l on l.child_id = c.id where c.class_id = k.id and l.user_id = v_uid)), '[]'::jsonb),
    'children', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'kind', c.kind, 'class_id', c.class_id,
        'linked', private.has_link(c.id), 'data', c.data) order by c.name) from public.child_profiles c
      where private.has_link(c.id) or private.is_class_teacher(c.class_id)), '[]'::jsonb));
end $$;
revoke execute on function public.export_my_data() from public, anon;
grant execute on function public.export_my_data() to authenticated;

-- Deletes the caller's account (section 8.5). Refused for the last admin. Linked children in a class stay there, unlinked, with their
-- pending codes voided (the class teachers can delete them under the no-parent rule); linked children without a class are deleted with
-- tombstones. Children the
-- account only created keep going (owner is set null by the foreign key). Then the auth user goes, and its rows cascade.
create function public.delete_my_account() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.caller();
begin
  if v_uid is null then return jsonb_build_object('error', 'forbidden'); end if;
  perform pg_advisory_xact_lock(hashtext('admins'));
  if private.current_role() = 'admin' and (select count(*) from public.accounts a where a.role = 'admin') <= 1 then
    return jsonb_build_object('error', 'last_admin');
  end if;
  -- Lock the linked children first (same order as the other functions) so none changes class or links while it is unlinked.
  perform 1 from public.child_profiles c where c.id in (select l.child_id from public.child_links l where l.user_id = v_uid) order by c.id for update;
  insert into public.deleted_children (id)
    select c.id from public.child_profiles c join public.child_links l on l.child_id = c.id
    where l.user_id = v_uid and c.class_id is null
      and not exists (select 1 from public.child_links o where o.child_id = c.id and o.user_id <> v_uid)
    on conflict do nothing;
  delete from public.child_profiles c using public.child_links l
    where l.child_id = c.id and l.user_id = v_uid and c.class_id is null
      and not exists (select 1 from public.child_links o where o.child_id = c.id and o.user_id <> v_uid);
  -- The classed children stay without a parent: no pending code of theirs may claim them again (as unlink_me does).
  delete from public.invites i using public.child_links l where i.child_id = l.child_id and l.user_id = v_uid and i.used_at is null;
  delete from public.child_links l where l.user_id = v_uid;
  delete from auth.users u where u.id = v_uid;
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- ---- Admin (section 3). Each starts with private.is_admin(). No function returns a child or a parent's email.

create function public.admin_list_accounts() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  return jsonb_build_object(
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('user_id', a.user_id, 'email', u.email, 'role', a.role) order by a.role, u.email)
      from public.accounts a join auth.users u on u.id = a.user_id where a.role in ('teacher', 'admin')), '[]'::jsonb),
    'invites', coalesce((select jsonb_agg(jsonb_build_object('email', r.email, 'expires_at', r.expires_at) order by r.email)
      from public.role_invites r where r.expires_at > now()), '[]'::jsonb),
    -- Accounts that no longer exist but whose to_parent codes made parent links still in place (a teacher who deleted their account):
    -- only an id and two counts, so the admin can undo them with admin_drop_teacher_links (the same counts as a demotion).
    'former', coalesce((select jsonb_agg(jsonb_build_object('user_id', g.granted_by, 'parent_links', g.n_in, 'outside_class', g.n_out) order by g.granted_by)
      from (select l.granted_by, count(*) filter (where c.class_id is not null) as n_in, count(*) filter (where c.class_id is null) as n_out
        from public.child_links l join public.child_profiles c on c.id = l.child_id
        where l.granted_by is not null and not exists (select 1 from auth.users u where u.id = l.granted_by)
        group by l.granted_by) g), '[]'::jsonb));
end $$;
revoke execute on function public.admin_list_accounts() from public, anon;
grant execute on function public.admin_list_accounts() to authenticated;

-- Classes with their teachers and two counts (children, and those with no parent link); never a child's name.
create function public.admin_list_classes() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  return jsonb_build_object('classes', coalesce((select jsonb_agg(jsonb_build_object(
      'id', k.id, 'name', k.name,
      'teachers', coalesce((select jsonb_agg(jsonb_build_object('user_id', ct.teacher_id, 'email', u.email) order by u.email)
        from public.class_teachers ct join auth.users u on u.id = ct.teacher_id where ct.class_id = k.id), '[]'::jsonb),
      'children', (select count(*) from public.child_profiles c where c.class_id = k.id),
      'unclaimed', (select count(*) from public.child_profiles c where c.class_id = k.id
        and not exists (select 1 from public.child_links l where l.child_id = c.id))) order by k.name)
    from public.classes k), '[]'::jsonb));
end $$;
revoke execute on function public.admin_list_classes() from public, anon;
grant execute on function public.admin_list_classes() to authenticated;

-- A teacher invitation by email (section 1), valid 30 days; inviting again renews it. The answer never says whether the email has an account.
create function public.admin_invite_teacher(p_email text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_exp timestamptz := now() + interval '30 days';
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  if position('@' in v_email) <= 1 or char_length(v_email) > 254 then return jsonb_build_object('error', 'bad_input'); end if;
  insert into public.role_invites (email, created_by, created_at, expires_at) values (v_email, auth.uid(), now(), v_exp)
    on conflict (email) do update set created_by = excluded.created_by, created_at = excluded.created_at, expires_at = excluded.expires_at;
  insert into public.admin_log (actor, action, detail) values (auth.uid(), 'invite_teacher', jsonb_build_object('email', v_email));
  return jsonb_build_object('ok', true, 'email', v_email, 'expires_at', v_exp);
end $$;
revoke execute on function public.admin_invite_teacher(text) from public, anon;
grant execute on function public.admin_invite_teacher(text) to authenticated;

create function public.admin_revoke_invite(p_email text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  delete from public.role_invites r where r.email = v_email;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  insert into public.admin_log (actor, action, detail) values (auth.uid(), 'revoke_invite', jsonb_build_object('email', v_email));
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.admin_revoke_invite(text) from public, anon;
grant execute on function public.admin_revoke_invite(text) to authenticated;

-- Back to parent: loses every class and the acknowledgement; their pending to_parent codes go. Never refused because a class is left
-- without a teacher: the children stay, and the admin assigns a teacher. The answer counts the parent links that came from this
-- teacher's codes (parent_links: children still in a class, which admin_drop_teacher_links can undo; outside_class: children their
-- parent has taken out of every class, which it cannot): a code is not tied to a person, so the admin decides whether they stay.
create function public.admin_demote_teacher(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_in int;
  v_out int;
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  update public.accounts a set role = 'parent', teacher_ack_at = null where a.user_id = p_user and a.role = 'teacher';
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  delete from public.class_teachers ct where ct.teacher_id = p_user;
  delete from public.invites i where i.created_by = p_user and i.kind = 'to_parent' and i.used_at is null;
  select count(*) filter (where g.class_id is not null), count(*) filter (where g.class_id is null) into v_in, v_out
    from private.granted_links(p_user, null) g;
  insert into public.admin_log (actor, action, detail) values (auth.uid(), 'demote_teacher',
    jsonb_build_object('user_id', p_user, 'parent_links', v_in, 'outside_class', v_out));
  return jsonb_build_object('ok', true, 'parent_links', v_in, 'outside_class', v_out);
end $$;
revoke execute on function public.admin_demote_teacher(uuid) from public, anon;
grant execute on function public.admin_demote_teacher(uuid) to authenticated;

create function public.admin_create_class(p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := trim(coalesce(p_name, ''));
  v_id uuid;
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  if char_length(v_name) not between 1 and 40 then return jsonb_build_object('error', 'bad_input'); end if;
  insert into public.classes (name) values (v_name) returning id into v_id;
  insert into public.admin_log (actor, action, detail) values (auth.uid(), 'create_class', jsonb_build_object('class_id', v_id, 'name', v_name));
  return jsonb_build_object('ok', true, 'id', v_id, 'name', v_name);
end $$;
revoke execute on function public.admin_create_class(text) from public, anon;
grant execute on function public.admin_create_class(text) to authenticated;

create function public.admin_rename_class(p_class uuid, p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := trim(coalesce(p_name, ''));
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  if char_length(v_name) not between 1 and 40 then return jsonb_build_object('error', 'bad_input'); end if;
  update public.classes k set name = v_name where k.id = p_class;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  insert into public.admin_log (actor, action, detail) values (auth.uid(), 'rename_class', jsonb_build_object('class_id', p_class, 'name', v_name));
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.admin_rename_class(uuid, text) from public, anon;
grant execute on function public.admin_rename_class(uuid, text) to authenticated;

-- Refused while the class holds children with no parent link: deleting it would leave them class-less with no link, and the creator's
-- just-inserted read would hand them back to the teacher who made them. Linked children go class-less and keep their parent.
create function public.admin_delete_class(p_class uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_unclaimed int;
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  -- The class lock first: a redeem that holds a class-less child and waits on it cannot slip that child in after the children below
  -- were locked (it re-checks the class after the lock and answers invalid). Then the children (none gains or loses a link meanwhile),
  -- then the class row. No cycle: a redeem waits on this lock only for a child with no class, which this function never locks.
  perform pg_advisory_xact_lock(hashtext('class:' || p_class::text));
  perform 1 from public.child_profiles c where c.class_id = p_class order by c.id for update;
  perform 1 from public.classes k where k.id = p_class for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  select count(*) into v_unclaimed from public.child_profiles c
    where c.class_id = p_class and not exists (select 1 from public.child_links l where l.child_id = c.id);
  if v_unclaimed > 0 then return jsonb_build_object('error', 'orphans', 'count', v_unclaimed); end if;
  delete from public.invites i using public.child_profiles c where i.child_id = c.id and c.class_id = p_class and i.used_at is null;
  delete from public.classes k where k.id = p_class;
  insert into public.admin_log (actor, action, detail) values (auth.uid(), 'delete_class', jsonb_build_object('class_id', p_class));
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.admin_delete_class(uuid) from public, anon;
grant execute on function public.admin_delete_class(uuid) to authenticated;

-- Only an account whose role is teacher can be assigned (a parent's account answers not_found: there is no lookup of parents).
create function public.admin_assign_teacher(p_class uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  if not exists (select 1 from public.classes k where k.id = p_class)
     or not exists (select 1 from public.accounts a where a.user_id = p_user and a.role = 'teacher') then
    return jsonb_build_object('error', 'not_found');
  end if;
  insert into public.class_teachers (class_id, teacher_id) values (p_class, p_user) on conflict do nothing;
  insert into public.admin_log (actor, action, detail) values (auth.uid(), 'assign_teacher', jsonb_build_object('class_id', p_class, 'user_id', p_user));
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.admin_assign_teacher(uuid, uuid) from public, anon;
grant execute on function public.admin_assign_teacher(uuid, uuid) to authenticated;

-- Removes a teacher from a class; their pending to_parent codes for that class's children go with it. Like admin_demote_teacher, the
-- answer counts the parent links of this class's children that came from this teacher's codes (outside_class is always 0 here: a child
-- taken out of the class is no longer this class's).
create function public.admin_unassign_teacher(p_class uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_in int;
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  delete from public.class_teachers ct where ct.class_id = p_class and ct.teacher_id = p_user;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  delete from public.invites i using public.child_profiles c
    where i.child_id = c.id and c.class_id = p_class and i.created_by = p_user and i.kind = 'to_parent' and i.used_at is null;
  select count(*) into v_in from private.granted_links(p_user, p_class) g;
  insert into public.admin_log (actor, action, detail) values (auth.uid(), 'unassign_teacher',
    jsonb_build_object('class_id', p_class, 'user_id', p_user, 'parent_links', v_in));
  return jsonb_build_object('ok', true, 'parent_links', v_in, 'outside_class', 0);
end $$;
revoke execute on function public.admin_unassign_teacher(uuid, uuid) from public, anon;
grant execute on function public.admin_unassign_teacher(uuid, uuid) to authenticated;

-- Undoes the parent links that came from p_user's to_parent codes (all, or only for the children now in p_class). Only children still
-- in a class: they stay there, unclaimed, and a teacher of the class can give the right family a new code. A child its parent has taken
-- out of every class is not touched (with no link and no class nobody could reach it). The children are locked first, then the links
-- go (the owner is cleared by child_links_clear_owner) with the children's pending codes.
create function public.admin_drop_teacher_links(p_user uuid, p_class uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_kids uuid[];
  v_n int;
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  perform 1 from public.child_profiles c
    where c.id in (select g.child_id from private.granted_links(p_user, p_class) g where g.class_id is not null) order by c.id for update;
  select coalesce(array_agg(g.child_id), '{}') into v_kids from private.granted_links(p_user, p_class) g where g.class_id is not null;
  delete from public.child_links l where l.child_id = any(v_kids)
    and exists (select 1 from private.granted_links(p_user, p_class) g where g.child_id = l.child_id and g.user_id = l.user_id);
  get diagnostics v_n = row_count;
  delete from public.invites i where i.child_id = any(v_kids) and i.used_at is null;
  insert into public.admin_log (actor, action, detail) values (auth.uid(), 'drop_teacher_links',
    jsonb_build_object('user_id', p_user, 'class_id', p_class, 'dropped', v_n));
  return jsonb_build_object('ok', true, 'dropped', v_n);
end $$;
revoke execute on function public.admin_drop_teacher_links(uuid, uuid) from public, anon;
grant execute on function public.admin_drop_teacher_links(uuid, uuid) to authenticated;

commit;
