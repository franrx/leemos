// Tests supabase/rollback/20261113000000_teachers_classes.down.sql against the LOCAL Supabase stack in Docker (never a real project):
//   npm run test:rollback   start, db reset (every migration), seed, apply the down file, assert the old state, stop
// Everything goes through `docker exec psql` into the local db container (supabase_db_<project_id>), and `supabase start/db reset/stop`
// act on the local stack only. Nothing here uses --linked or any remote host, and no keys are read or written.
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
  const U = (n) => `00000000-0000-0000-0000-0000000000a${n}`;
  const C = (n) => `00000000-0000-0000-0000-0000000000c${n}`;
  q(`insert into auth.users (id, instance_id, aud, role, email) values
       ('${U(1)}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','a1@example.test'),
       ('${U(2)}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','teacher@example.test'),
       ('${U(3)}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','parent@example.test');
     update public.accounts set role='teacher', teacher_ack_at=now() where user_id='${U(2)}';
     insert into public.classes (id, name) values ('00000000-0000-0000-0000-0000000000d1','Clase');
     insert into public.class_teachers (class_id, teacher_id) values ('00000000-0000-0000-0000-0000000000d1','${U(2)}');
     insert into public.child_profiles (id, owner, name, kind) values ('${C(1)}','${U(1)}','Uno','reader'), ('${C(2)}',null,'SinDueno','reader');
     -- a class child created by the teacher (owner = teacher), later claimed by a parent through a code: only a link is added
     insert into public.child_profiles (id, owner, name, kind, class_id) values ('${C(5)}','${U(2)}','DeClase','reader','00000000-0000-0000-0000-0000000000d1');
     insert into public.child_links (child_id, user_id) values ('${C(5)}','${U(3)}');
     insert into public.invites (code_hash, kind, child_id, created_by, expires_at) values ('h1','to_parent','${C(5)}','${U(2)}', now() + interval '1 day');
     -- an unclaimed class child: its owner is the teacher who created it (maybe since demoted); the old policies would give it to them
     insert into public.child_profiles (id, owner, name, kind, class_id) values ('${C(6)}','${U(2)}','SinFamilia','reader','00000000-0000-0000-0000-0000000000d1');
     insert into public.admin_log (action) values ('seed');
     insert into public.deleted_children (id) values ('${C(9)}');`);
  const down = readFileSync('supabase/rollback/20261113000000_teachers_classes.down.sql', 'utf8');
  const guarded = psql(down);
  check('the guard aborts the rollback while an unlinked child has no owner or a class child has no parent, saying how many', guarded.status !== 0 && /2 child_profiles row\(s\) have no owner, or are class children with no parent link/.test(guarded.stderr), guarded.stderr);
  check('an aborted rollback changes nothing (the new tables are still there)', q(`select to_regclass('public.accounts') is not null`) === 't');

  // Clearing only the owner-less row is not enough: the unclaimed class child (owned by its teacher) still stops it.
  q(`delete from public.child_profiles where owner is null;`);
  const still = psql(down);
  check('the guard still aborts for an unclaimed class child whose owner is its teacher', still.status !== 0 && /1 child_profiles row\(s\) have no owner, or are class children with no parent link/.test(still.stderr), still.stderr);
  check('the unclaimed class child still belongs to nobody but its class (owner unchanged, no link)', q(`select owner from public.child_profiles where id='${C(6)}'`) === U(2));

  // Fran decides: the unclaimed child goes to the parent (a link, as the README says), and the file applies.
  q(`insert into public.child_links (child_id, user_id) values ('${C(6)}','${U(3)}');`);
  const applied = psql(down);
  check('the down file applies cleanly in one transaction', applied.status === 0, applied.stderr);
  if (applied.status !== 0) return 1;

  check('public tables: only child_profiles', same(lines(q(`select tablename from pg_tables where schemaname='public'`)), ['child_profiles']));
  check('the private schema is gone', q(`select count(*) from pg_namespace where nspname='private'`) === '0');
  check('public functions: only the old two (limit, touch)', same(lines(q(`select proname from pg_proc where pronamespace='public'::regnamespace`)), ['child_profiles_limit', 'child_profiles_touch']));
  check('child_profiles policies are exactly the four old ones', same(lines(q(`select policyname from pg_policies where tablename='child_profiles'`)), ['owner reads', 'owner inserts', 'owner updates', 'owner deletes']));
  check('child_profiles triggers are the old two (limit, touch)', same(lines(q(`select tgname from pg_trigger where tgrelid='public.child_profiles'::regclass and not tgisinternal`)), ['child_profiles_limit', 'child_profiles_touch']));
  check('no trigger of the new migration on auth.users', q(`select count(*) from pg_trigger where tgrelid='auth.users'::regclass and tgname in ('accounts_for_new_user','children_of_deleted_user')`) === '0');
  check('child_profiles has no class_id column', q(`select count(*) from information_schema.columns where table_schema='public' and table_name='child_profiles' and column_name='class_id'`) === '0');
  check('owner is NOT NULL with a cascade foreign key', q(`select is_nullable from information_schema.columns where table_schema='public' and table_name='child_profiles' and column_name='owner'`) === 'NO'
    && q(`select confdeltype from pg_constraint where conname='child_profiles_owner_fkey'`) === 'c');
  check('RLS is still enabled on child_profiles', q(`select relrowsecurity from pg_class where oid='public.child_profiles'::regclass`) === 't');
  check('table grants: anon none; authenticated select/insert/delete and no table-level update (other privileges are Supabase defaults, not asserted)',
    q(`select count(*) from information_schema.role_table_grants where table_name='child_profiles' and table_schema='public' and grantee='anon'`) === '0'
    && same(lines(q(`select privilege_type from information_schema.role_table_grants where table_name='child_profiles' and table_schema='public' and grantee='authenticated' and privilege_type in ('SELECT','INSERT','UPDATE','DELETE')`)), ['SELECT', 'INSERT', 'DELETE']));
  check('column grants: authenticated may update name, data and version only (not kind, owner or id)',
    same(lines(q(`select column_name from information_schema.column_privileges where table_name='child_profiles' and table_schema='public' and grantee='authenticated' and privilege_type='UPDATE'`)), ['name', 'data', 'version']));
  check('the rollback deleted no child rows (c1 and the class children are still there)', q(`select count(*) from public.child_profiles where id in ('${C(1)}','${C(5)}','${C(6)}')`) === '3');
  check('the class child claimed by a parent now belongs to that parent', q(`select owner from public.child_profiles where id='${C(5)}'`) === U(3));
  check('the formerly unclaimed class child goes to the person chosen, not to the teacher who created it', q(`select owner from public.child_profiles where id='${C(6)}'`) === U(3));

  // Functional checks with the old semantics, as an authenticated user through RLS (set role + jwt claim).
  const as = (u, sql) => `begin; set local role authenticated; select set_config('request.jwt.claims','{"sub":"${u}","role":"authenticated"}',true); ${sql} rollback;`;
  const count = (u, sql) => { const r = psql(as(u, `with x as (${sql}) select 'N=' || count(*) from x;`)); return r.status === 0 ? (/N=(\d+)/.exec(r.stdout) || [])[1] : `error: ${r.stderr}`; };
  check('an owner reads only their own rows (c1; not the teacher\'s or the parent\'s)', count(U(1), `select 1 from public.child_profiles`) === '1');
  check('an owner inserts a row', count(U(1), `insert into public.child_profiles (id, name, kind) values ('${C(3)}','Dos','pre') returning 1`) === '1');
  check('an owner updates their row (name) and exactly one row changes', count(U(1), `update public.child_profiles set name='Uno b' where id='${C(1)}' returning 1`) === '1');
  check('an owner deletes their row and exactly one row goes', count(U(1), `delete from public.child_profiles where id='${C(1)}' returning 1`) === '1');
  check('an owner cannot update or delete someone else\'s row (0 rows)', count(U(1), `update public.child_profiles set name='x' where id='${C(5)}' returning 1`) === '0' && count(U(1), `delete from public.child_profiles where id='${C(5)}' returning 1`) === '0');
  check('an owner cannot insert a row owned by another EXISTING user', (() => {
    const r = psql(as(U(1), `insert into public.child_profiles (id, owner, name, kind) values ('${C(4)}','${U(2)}','X','reader');`));
    return r.status !== 0 && /row-level security/.test(r.stderr);
  })());
  check('the parent reads and updates the handed-back class child under the old policies', count(U(3), `select 1 from public.child_profiles where id='${C(5)}'`) === '1' && count(U(3), `update public.child_profiles set name='DeClase b' where id='${C(5)}' returning 1`) === '1');
  check('the teacher no longer sees the class child (class access is lost by design)', count(U(2), `select 1 from public.child_profiles where id='${C(5)}'`) === '0');
  check('the old 8-profile limit is back', (() => {
    const r = psql(as(U(1), `insert into public.child_profiles (id, name, kind) select gen_random_uuid(), 'n'||g, 'reader' from generate_series(1,8) g;`));
    return r.status !== 0 && /profile limit reached/.test(r.stderr);
  })());
  return failures ? 1 : 0;
};
let code = 2;
try { code = run(); } finally { cli(['stop'], { stdio: 'inherit' }); }
console.log(code === 0 ? '\nAll rollback checks passed' : '\nRollback checks FAILED');
process.exit(code);
