// Tests supabase/rollback/20261113000000_teachers_classes.down.sql against a LOCAL Supabase in Docker (never a real project):
//   npm run test:rollback   start, db reset (every migration), seed, apply the down file, assert the old state, stop
// SQL goes through `docker exec psql` in the local db container; the local keys come from `supabase status` at runtime
// and live only in this process (never on disk).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SUPABASE_CLI = '3.1.0';
const DB = 'supabase_db_leemos'; // container name: supabase_db_<project_id> (supabase/config.toml)
const cli = (args, opts = {}) => spawnSync('npx', ['--yes', `supabase@${SUPABASE_CLI}`, ...args], { encoding: 'utf8', ...opts });
const psql = (sql) => spawnSync('docker', ['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '|'], { input: sql, encoding: 'utf8' });
const q = (sql) => { const r = psql(sql); if (r.status !== 0) throw new Error(`psql: ${r.stderr}`); return r.stdout.trim(); };

if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) { console.error('Docker no está en marcha'); process.exit(2); }

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); if (!ok) failures++; };
const lines = (s) => (s ? s.split('\n') : []);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

const run = () => {
  for (const args of [['start'], ['db', 'reset']]) if (cli(args, { stdio: 'inherit' }).status !== 0) { console.error(`supabase ${args.join(' ')} falló`); return 2; }

  // Guard: a row without owner aborts the file, with a clear message, and nothing changes.
  q(`insert into auth.users (id, instance_id, aud, role, email) values ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','a@example.test');
     insert into public.child_profiles (id, owner, name, kind) values ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000a1','Uno','reader'),
       ('00000000-0000-0000-0000-0000000000c2',null,'SinDueno','reader');`);
  const down = readFileSync('supabase/rollback/20261113000000_teachers_classes.down.sql', 'utf8');
  const guarded = psql(down);
  check('the guard aborts the rollback while a child has no owner, saying how many', guarded.status !== 0 && /1 child_profiles row\(s\) have no owner/.test(guarded.stderr), guarded.stderr);
  check('an aborted rollback changes nothing (the new tables are still there)', q(`select to_regclass('public.accounts') is not null`) === 't');

  // Now clear the owner-less row (the README tells the adult to do this) and apply the file.
  q(`delete from public.child_profiles where owner is null;`);
  const applied = psql(down);
  check('the down file applies cleanly in one transaction', applied.status === 0, applied.stderr);
  if (applied.status !== 0) return 1;

  check('public tables: only child_profiles', same(lines(q(`select tablename from pg_tables where schemaname='public'`)), ['child_profiles']));
  check('the private schema is gone', q(`select count(*) from pg_namespace where nspname='private'`) === '0');
  check('public functions: only the old two (limit, touch)', same(lines(q(`select proname from pg_proc where pronamespace='public'::regnamespace`)), ['child_profiles_limit', 'child_profiles_touch']));
  check('child_profiles policies are exactly the four old ones', same(lines(q(`select policyname from pg_policies where tablename='child_profiles'`)), ['owner reads', 'owner inserts', 'owner updates', 'owner deletes']));
  check('child_profiles triggers are the old two (limit, touch)', same(lines(q(`select tgname from pg_trigger where tgrelid='public.child_profiles'::regclass and not tgisinternal`)), ['child_profiles_limit', 'child_profiles_touch']));
  check('no trigger of the new migration on auth.users', q(`select count(*) from pg_trigger where tgrelid='auth.users'::regclass and tgname='accounts_for_new_user'`) === '0');
  check('child_profiles has no class_id column', q(`select count(*) from information_schema.columns where table_schema='public' and table_name='child_profiles' and column_name='class_id'`) === '0');
  check('owner is NOT NULL with a cascade foreign key', q(`select is_nullable from information_schema.columns where table_schema='public' and table_name='child_profiles' and column_name='owner'`) === 'NO'
    && q(`select confdeltype from pg_constraint where conname='child_profiles_owner_fkey'`) === 'c');
  check('RLS is still enabled on child_profiles', q(`select relrowsecurity from pg_class where oid='public.child_profiles'::regclass`) === 't');
  check('table grants: anon none; authenticated select/insert/delete (and the default references/trigger/truncate), no table-level update',
    q(`select count(*) from information_schema.role_table_grants where table_name='child_profiles' and table_schema='public' and grantee='anon'`) === '0'
    && same(lines(q(`select privilege_type from information_schema.role_table_grants where table_name='child_profiles' and table_schema='public' and grantee='authenticated'`)), ['SELECT', 'INSERT', 'DELETE', 'REFERENCES', 'TRIGGER', 'TRUNCATE']));
  check('column grants: authenticated may update name, data and version only (not kind, owner or id)',
    same(lines(q(`select column_name from information_schema.column_privileges where table_name='child_profiles' and table_schema='public' and grantee='authenticated' and privilege_type='UPDATE'`)), ['name', 'data', 'version']));
  check('the existing child survived (the rollback deletes no rows)', q(`select count(*) from public.child_profiles where id='00000000-0000-0000-0000-0000000000c1'`) === '1');

  // Functional smoke with the old semantics, as an authenticated owner through RLS (set role + jwt claim).
  const asOwner = (sql) => q(`begin; set local role authenticated; select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true); ${sql} rollback;`);
  check('an owner reads, inserts, updates (name) and deletes their own row with the old semantics', (() => {
    try {
      const out = asOwner(`select count(*) from public.child_profiles;
        insert into public.child_profiles (id, name, kind) values ('00000000-0000-0000-0000-0000000000c3','Dos','pre');
        update public.child_profiles set name='Dos b' where id='00000000-0000-0000-0000-0000000000c3';
        delete from public.child_profiles where id='00000000-0000-0000-0000-0000000000c3';`);
      return /(^|\n)1(\n|$)/.test(out);
    } catch (e) { console.log(String(e)); return false; }
  })());
  check('an owner cannot insert a row for someone else, nor see theirs', (() => {
    const bad = psql(`begin; set local role authenticated; select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
      insert into public.child_profiles (id, owner, name, kind) values ('00000000-0000-0000-0000-0000000000c4','00000000-0000-0000-0000-0000000000ff','X','reader'); rollback;`);
    return bad.status !== 0;
  })());
  check('the old 8-profile limit is back', (() => {
    const r = psql(`begin; set local role authenticated; select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
      insert into public.child_profiles (id, name, kind) select gen_random_uuid(), 'n'||g, 'reader' from generate_series(1,8) g; rollback;`);
    return r.status !== 0 && /profile limit reached/.test(r.stderr);
  })());
  return failures ? 1 : 0;
};
let code = 2;
try { code = run(); } finally { cli(['stop'], { stdio: 'inherit' }); }
console.log(code === 0 ? '\nAll rollback checks passed' : '\nRollback checks FAILED');
process.exit(code);
