// Guards the SQL migration against accidental edits: RLS on, owner-only policies, limits, and the committed config holds only public values (anon key, never service_role).
import { readFileSync } from 'node:fs';
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const sql = readFileSync('supabase/migrations/20261017000000_child_profiles.sql', 'utf8');
// The COMMITTED config is either empty (feature off) or a Supabase project root URL plus the public anon key. Read it from git so a local override does not matter.
import { execSync } from 'node:child_process';
let cfgText;
try { cfgText = execSync('git show HEAD:src/data/sync.config.json', { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch (e) { cfgText = readFileSync('src/data/sync.config.json', 'utf8'); }
const cfg = JSON.parse(cfgText);
const policies = [...sql.matchAll(/create policy "[^"]+" on public\.child_profiles for (select|insert|update|delete)/g)].map((m) => m[1]).sort();

check('migration: row level security is enabled on child_profiles', /alter table public\.child_profiles enable row level security/.test(sql));
check('migration: exactly one policy per operation (select, insert, update, delete)', policies.join() === 'delete,insert,select,update', policies.join());
check('migration: every policy is limited to the signed-in owner', (sql.match(/owner = \(select auth\.uid\(\)\)/g) || []).length >= 5);
check('migration: the owner column defaults to the caller and cascades on user deletion', /owner\s+uuid not null default auth\.uid\(\) references auth\.users\(id\) on delete cascade/.test(sql));
check('migration: name, kind and data size are constrained', /char_length\(name\) between 1 and 40/.test(sql) && /kind in \('reader','pre'\)/.test(sql) && /octet_length\(data::text\) < 200000/.test(sql));
check('migration: at most 8 profiles per account', /count\(\*\)[^;]*>= 8/.test(sql));
check('migration: no policy is granted to anon', !/to anon/.test(sql));
check('migration: concurrent inserts cannot slip past the 8-profile limit (per-owner advisory lock)', /pg_advisory_xact_lock\(hashtext\(new\.owner::text\)\)/.test(sql));
check('migration: the limit trigger runs with the caller\'s rights (no security definer)', !/security definer/i.test(sql));
check('migration: anon has no privileges on the table', /revoke all on public\.child_profiles from anon/.test(sql));
check('migration: an owner can update only name, data and version (never id or owner)', /revoke update on public\.child_profiles from authenticated/.test(sql) && /grant update \(name, data, version\) on public\.child_profiles to authenticated/.test(sql));
check('migration: every function body has its opening and closing dollar quote', (sql.match(/\$\$/g) || []).length === 4);

// ---- Teachers, classes and link-based access (spec docs/superpowers/specs/2026-11-13-teachers-classes-design.md, sections 2 and 3).
const NEW = 'supabase/migrations/20261113000000_teachers_classes.sql';
let tc = '';
try { tc = readFileSync(NEW, 'utf8'); } catch (e) { /* missing file: every check below fails */ }
check('teachers: the new migration file exists', tc.length > 0, NEW);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TABLES = ['accounts', 'classes', 'class_teachers', 'child_links', 'invites', 'invite_attempts', 'deleted_children', 'role_invites', 'admin_log'];
const READABLE = ['accounts', 'classes', 'class_teachers', 'child_links'];
const SERVER_ONLY = TABLES.filter((t) => !READABLE.includes(t));
const grantsOn = (t) => [...tc.matchAll(new RegExp(`grant ([^;]*?) on (?:table )?public\\.${esc(t)} to ([^;]+);`, 'gi'))].map((m) => ({ privs: m[1].trim().toLowerCase(), to: m[2].trim() }));
// Every function: name, argument list, header (between the arguments and the body) and body.
const fns = [...tc.matchAll(/create (?:or replace )?function ([\w."]+)\(([^)]*)\)([\s\S]*?)\$\$([\s\S]*?)\$\$/gi)].map((m) => ({ name: m[1], header: m[3], body: m[4] }));
const fn = (name) => fns.find((f) => f.name === name);
const definer = (f) => !!f && /security definer/i.test(f.header);
const policy = (table, op) => { const m = new RegExp(`create policy "[^"]+" on public\\.${esc(table)} for ${op} to authenticated([\\s\\S]*?);`, 'i').exec(tc); return m ? m[1] : ''; };

check('teachers: the whole migration runs in one transaction', /^\s*(--[^\n]*\n\s*)*begin;/i.test(tc) && /commit;\s*$/i.test(tc));
check('teachers: no service_role anywhere in the new migration (comments included)', tc.length > 0 && !/service_role/i.test(tc));
check('teachers: every function body has its opening and closing dollar quote (even count)', tc.length > 0 && (tc.match(/\$\$/g) || []).length % 2 === 0);
for (const t of TABLES) check(`teachers: ${t} is created with row level security enabled`, new RegExp(`create table public\\.${esc(t)} \\(`).test(tc) && new RegExp(`alter table public\\.${esc(t)} enable row level security`).test(tc));
for (const t of TABLES) check(`teachers: ${t} starts from zero (revoke all from anon, authenticated)`, new RegExp(`revoke all on public\\.${esc(t)} from anon, authenticated;`).test(tc));
for (const t of SERVER_ONLY) check(`teachers: ${t} has no grant at all (server-only)`, tc.length > 0 && grantsOn(t).length === 0, JSON.stringify(grantsOn(t)));
for (const t of READABLE) { const g = grantsOn(t); check(`teachers: ${t} grants only select, to authenticated`, g.length === 1 && g[0].privs === 'select' && g[0].to === 'authenticated', JSON.stringify(g)); }
check('teachers: no table or function is granted to anon', tc.length > 0 && !/grant [^;]* to [^;]*\banon\b/i.test(tc));
check('teachers: no policy is granted to anon or public', tc.length > 0 && !/create policy [^;]* to (anon|public)\b/i.test(tc));

const HELPERS = ['is_admin', 'current_role', 'is_class_teacher', 'has_link', 'has_any_link', 'is_tombstoned'];
for (const h of HELPERS) { const f = fn('private.' + h); check(`teachers: helper private.${h} exists, security definer and stable`, definer(f) && /\bstable\b/i.test(f.header)); }
check('teachers: helpers take the agreed arguments (p_class, p_child)', /function private\.is_class_teacher\(p_class uuid\)/.test(tc) && ['has_link', 'has_any_link', 'is_tombstoned'].every((h) => new RegExp(`function private\\.${h}\\(p_child uuid\\)`).test(tc)) && /function private\.is_admin\(\)/.test(tc) && /function private\.current_role\(\)/.test(tc));
check('teachers: the private schema exists and only authenticated gets usage', /create schema if not exists private;/.test(tc) && /grant usage on schema private to authenticated;/.test(tc));
check('teachers: is_class_teacher requires role teacher and the acknowledgement', /role = 'teacher'/.test((fn('private.is_class_teacher') || {}).body || '') && /teacher_ack_at is not null/.test((fn('private.is_class_teacher') || {}).body || ''));
const definers = fns.filter(definer);
check('teachers: every security definer function sets an empty search_path', definers.length > 0 && definers.every((f) => /set search_path = ''/.test(f.header)), definers.filter((f) => !/set search_path = ''/.test(f.header)).map((f) => f.name).join());
check('teachers: no function is created in a schema other than private or public', fns.length > 0 && fns.every((f) => /^(private|public)\./.test(f.name)), fns.map((f) => f.name).join());
const revokes = (name) => (tc.match(new RegExp(`revoke execute on function ${esc(name)}\\([^)]*\\) from public, anon;`, 'g')) || []).length;
check('teachers: every function has exactly one revoke execute from public, anon', fns.length > 0 && fns.every((f) => revokes(f.name) === 1), fns.filter((f) => revokes(f.name) !== 1).map((f) => `${f.name}:${revokes(f.name)}`).join());
check('teachers: the trigger that writes child_links is security definer', fns.some((f) => /insert into public\.child_links/.test(f.body)) && fns.filter((f) => /insert into public\.child_links/.test(f.body)).every(definer));
check('teachers: the trigger that writes accounts is security definer', fns.some((f) => /insert into public\.accounts/.test(f.body)) && fns.filter((f) => /insert into public\.accounts/.test(f.body)).every(definer));
check('teachers: a new auth user gets an accounts row (trigger on auth.users)', /after insert on auth\.users\s+for each row execute function private\.\w+\(\)/.test(tc));
check('teachers: a class-less child gets a link for its creator (after insert trigger)', /after insert on public\.child_profiles\s+for each row execute function private\.\w+\(\)/.test(tc) && fns.some((f) => /insert into public\.child_links/.test(f.body) && /class_id is null/.test(f.body)));
check('teachers: accounts.role defaults to parent and is limited to admin, teacher, parent', /role\s+text not null default 'parent' check \(role in \('admin','teacher','parent'\)\)/.test(tc));

check('teachers: existing users and owners are backfilled into accounts and child_links', /insert into public\.accounts \(user_id\) select id from auth\.users/.test(tc) && /insert into public\.child_links \(child_id, user_id\) select id, owner from public\.child_profiles/.test(tc));
check('teachers: child_profiles.owner becomes nullable with on delete set null', /alter table public\.child_profiles alter column owner drop not null;/.test(tc) && /foreign key \(owner\) references auth\.users\(id\) on delete set null/.test(tc));
check('teachers: child_profiles.class_id references classes on delete set null', /add column class_id uuid references public\.classes\(id\) on delete set null/.test(tc));
check('teachers: the old owner policies and the old limit trigger are dropped', ['owner reads', 'owner inserts', 'owner updates', 'owner deletes'].every((p) => tc.includes(`drop policy "${p}" on public.child_profiles;`)) && /drop trigger child_profiles_limit on public\.child_profiles;/.test(tc) && /drop function public\.child_profiles_limit\(\);/.test(tc));
const sel = policy('child_profiles', 'select'), upd = policy('child_profiles', 'update'), ins = policy('child_profiles', 'insert');
const access = /private\.has_link\(id\) or private\.is_class_teacher\(class_id\) or \(owner = \(select auth\.uid\(\)\) and class_id is null and not private\.has_any_link\(id\)\)/;
check('teachers: the select policy is link, class teacher, or just inserted through private.has_any_link', access.test(sel), access.test(sel) ? '' : sel.trim());
check('teachers: the update policy uses the same rule in using and with check', (upd.match(new RegExp(access.source, 'g')) || []).length === 2, (upd.match(new RegExp(access.source, 'g')) || []).length === 2 ? '' : upd.trim());
check('teachers: the insert policy is own owner, class-less or own class, and not tombstoned', /owner = \(select auth\.uid\(\)\)/.test(ins) && /class_id is null or private\.is_class_teacher\(class_id\)/.test(ins) && /not private\.is_tombstoned\(id\)/.test(ins));
check('teachers: child_profiles has no delete policy', tc.length > 0 && !/create policy "[^"]+" on public\.child_profiles for delete/.test(tc));
const rv = tc.indexOf('revoke update, delete on public.child_profiles from authenticated;'), gu = tc.indexOf('grant update (name, data, version, kind) on public.child_profiles to authenticated;');
check('teachers: update and delete are revoked before the column update grant (name, data, version, kind)', rv >= 0 && gu > rv && /grant select, insert on public\.child_profiles to authenticated;/.test(tc));
check('teachers: no grant gives delete on child_profiles', tc.length > 0 && !/grant [^;]*\bdelete\b[^;]* on public\.child_profiles/i.test(tc));
check('teachers: no update grant on child_profiles includes owner, id or class_id', grantsOn('child_profiles').every((g) => !/update/.test(g.privs) || !/\b(owner|id|class_id)\b/.test(g.privs)));
const lim = fns.filter((f) => /check_violation/.test(f.body));
check('teachers: limit triggers are security definer (8 class-less per owner, 60 per class, 1 parent link)', lim.length >= 3 && lim.every(definer) && lim.some((f) => />= 8/.test(f.body) && /class_id is null/.test(f.body)) && lim.some((f) => />= 60/.test(f.body)) && lim.some((f) => /public\.child_links/.test(f.body) && /user_id <> new\.user_id/.test(f.body)));
check('teachers: limit triggers take advisory locks (per owner, per class, per child)', lim.length >= 3 && lim.every((f) => /pg_advisory_xact_lock\(/.test(f.body)));
check('teachers: the class limit runs before insert or update of class_id', /before insert or update of class_id on public\.child_profiles/.test(tc));
check('teachers: data stays capped below 200000 bytes (constraint untouched)', tc.length > 0 && !/octet_length/.test(tc) && !/drop constraint child_profiles_data_check/.test(tc));

const jwtRole = k => { try { return JSON.parse(Buffer.from(String(k).split('.')[1], 'base64url').toString()).role; } catch (e) { return null; } };
check('config: empty (feature off) or a Supabase https URL plus an anon-role JWT, never service_role',
  (cfg.url === '' && cfg.anonKey === '') ||
  (/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(cfg.url) && jwtRole(cfg.anonKey) === 'anon'));
check('config: only the two expected keys exist', Object.keys(cfg).sort().join() === 'anonKey,url');

console.log(failures ? `\n${failures} migration test(s) FAILED` : '\nAll migration tests passed');
process.exit(failures ? 1 : 0);
