-- Leemos: one row per child profile, owned by an authenticated adult. Spec: docs/superpowers/specs/2026-10-17-accounts-sync-design.md
create table public.child_profiles (
  id          uuid primary key,
  owner       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 40),
  kind        text not null check (kind in ('reader','pre')),
  data        jsonb not null default '{}'::jsonb check (octet_length(data::text) < 200000),
  version     integer not null default 1 check (version >= 1),
  updated_at  timestamptz not null default now()
);

create index child_profiles_owner_idx on public.child_profiles (owner);

alter table public.child_profiles enable row level security;

create policy "owner reads" on public.child_profiles for select to authenticated
  using (owner = (select auth.uid()));
create policy "owner inserts" on public.child_profiles for insert to authenticated
  with check (owner = (select auth.uid()));
create policy "owner updates" on public.child_profiles for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
create policy "owner deletes" on public.child_profiles for delete to authenticated
  using (owner = (select auth.uid()));

-- At most 8 child profiles per account.
create function public.child_profiles_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.child_profiles where owner = new.owner) >= 8 then
    raise exception 'profile limit reached' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger child_profiles_limit before insert on public.child_profiles
  for each row execute function public.child_profiles_limit();

create function public.child_profiles_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end $$;
create trigger child_profiles_touch before update on public.child_profiles
  for each row execute function public.child_profiles_touch();
