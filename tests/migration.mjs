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
const rv = tc.indexOf('revoke all on public.child_profiles from authenticated;'), gu = tc.indexOf('grant update (name, data, version, kind) on public.child_profiles to authenticated;');
check('teachers: child_profiles grants start from zero (revoke all) before select, insert and the column update grant (name, data, version, kind)', rv >= 0 && gu > rv && /grant select, insert on public\.child_profiles to authenticated;/.test(tc));
check('teachers: no grant gives delete on child_profiles', tc.length > 0 && !/grant [^;]*\bdelete\b[^;]* on public\.child_profiles/i.test(tc));
check('teachers: no update grant on child_profiles includes owner, id or class_id', grantsOn('child_profiles').every((g) => !/update/.test(g.privs) || !/\b(owner|id|class_id)\b/.test(g.privs)));
const clr = fns.filter((f) => /update public\.child_profiles [\s\S]*set owner = null/.test(f.body));
check('teachers: losing the last parent link clears owner (after delete on child_links, security definer, empty search_path)',
  clr.length === 1 && definer(clr[0]) && /set search_path = ''/.test(clr[0].header) && /not exists \(select 1 from public\.child_links/.test(clr[0].body) &&
  new RegExp(`after delete on public\\.child_links\\s+for each row execute function ${esc(clr[0].name)}\\(\\)`).test(tc));
check('teachers: the classes policy lets only acknowledged teachers (is_class_teacher) see their class', /private\.is_class_teacher\(classes\.id\)/.test(policy('classes', 'select')) && !/public\.class_teachers/.test(policy('classes', 'select')));
const lim = fns.filter((f) => /check_violation/.test(f.body));
check('teachers: limit triggers are security definer (8 class-less per owner, 60 per class, 1 parent link)', lim.length >= 3 && lim.every(definer) && lim.some((f) => />= 8/.test(f.body) && /class_id is null/.test(f.body)) && lim.some((f) => />= 60/.test(f.body)) && lim.some((f) => /public\.child_links/.test(f.body) && /user_id <> new\.user_id/.test(f.body)));
check('teachers: limit triggers take advisory locks (per owner, per class, per child)', lim.length >= 3 && lim.every((f) => /pg_advisory_xact_lock\(/.test(f.body)));
check('teachers: the class limit runs before insert or update of class_id', /before insert or update of class_id on public\.child_profiles/.test(tc));
check('teachers: data stays capped below 200000 bytes (constraint untouched)', tc.length > 0 && !/octet_length/.test(tc) && !/drop constraint child_profiles_data_check/.test(tc));

// ---- RPCs (spec sections 1, 4, 5 and 8). Each name with its exact argument list; the clients of later tasks call them by these names.
const RPCS = {
  whoami: '', ack_teacher: '', create_invite: 'p_child uuid, p_kind text', redeem_invite: 'p_code text, p_class uuid default null',
  leave_class: 'p_child uuid', unlink_me: 'p_child uuid', delete_child: 'p_child uuid', export_my_data: '', delete_my_account: '',
  admin_list_accounts: '', admin_list_classes: '', admin_invite_teacher: 'p_email text', admin_revoke_invite: 'p_email text',
  admin_demote_teacher: 'p_user uuid', admin_create_class: 'p_name text', admin_rename_class: 'p_class uuid, p_name text',
  admin_delete_class: 'p_class uuid', admin_assign_teacher: 'p_class uuid, p_user uuid', admin_unassign_teacher: 'p_class uuid, p_user uuid',
};
const argsOf = (name) => { const m = new RegExp(`create function public\\.${esc(name)}\\(([^)]*)\\)`).exec(tc); return m ? m[1].replace(/\s+/g, ' ').trim() : null; };
const bodyOf = (name) => (fn(name) || {}).body || '';
for (const [n, args] of Object.entries(RPCS)) {
  const f = fn('public.' + n);
  check(`rpc: public.${n}(${args}) exists, security definer, returns jsonb`, argsOf(n) === args && definer(f) && /returns jsonb/.test(f.header), String(argsOf(n)));
  check(`rpc: public.${n} revokes execute from public, anon and grants it to authenticated`, revokes('public.' + n) === 1 && new RegExp(`grant execute on function public\\.${esc(n)}\\([^)]*\\) to authenticated;`).test(tc));
}
check('rpc: whoami is volatile and claims through private.claim_role()', /\bvolatile\b/.test((fn('public.whoami') || {}).header || '') && /perform private\.claim_role\(\)/.test(bodyOf('public.whoami')) && definer(fn('private.claim_role')));
check('rpc: claim_role matches the verified, lower-cased email to a pending invitation and deletes it', /email_confirmed_at is not null/.test(bodyOf('private.claim_role')) && /lower\(/.test(bodyOf('private.claim_role')) && /delete from public\.role_invites/.test(bodyOf('private.claim_role')) && /expires_at > now\(\)/.test(bodyOf('private.claim_role')) && /insert into public\.admin_log/.test(bodyOf('private.claim_role')));
check('rpc: claim_role is not granted to anyone (only whoami calls it)', !/grant execute on function private\.claim_role/.test(tc));
const admins = Object.keys(RPCS).filter((n) => n.startsWith('admin_'));
check('rpc: every admin_* function first checks private.is_admin() and answers {error:forbidden}', admins.every((n) => /^\s*(declare[\s\S]*?)?begin\s+if not private\.is_admin\(\) then return jsonb_build_object\('error', 'forbidden'\); end if;/.test(bodyOf('public.' + n))), admins.filter((n) => !/^\s*(declare[\s\S]*?)?begin\s+if not private\.is_admin\(\) then return jsonb_build_object\('error', 'forbidden'\); end if;/.test(bodyOf('public.' + n))).join());
const adminWrites = admins.filter((n) => !/^admin_list_/.test(n));
check('rpc: every admin write inserts into admin_log', adminWrites.every((n) => /insert into public\.admin_log/.test(bodyOf('public.' + n))), adminWrites.filter((n) => !/insert into public\.admin_log/.test(bodyOf('public.' + n))).join());
check('rpc: admin_list_* only read (no insert, update or delete)', admins.filter((n) => /^admin_list_/.test(n)).every((n) => !/\b(insert into|update public|delete from)\b/.test(bodyOf('public.' + n))));
check('rpc: admin_list_accounts lists only teacher and admin accounts (no parent email)', /a\.role in \('teacher', 'admin'\)/.test(bodyOf('public.admin_list_accounts')) && !/'parent'/.test(bodyOf('public.admin_list_accounts')));
const redeem = bodyOf('public.redeem_invite'), create = bodyOf('public.create_invite');
check('rpc: redeem_invite records failed attempts in invite_attempts and never raises', /insert into public\.invite_attempts/.test(redeem) && !/\braise\b/i.test(redeem));
check('rpc: redeem_invite rate-limits at 10 failed attempts per user per hour, under a per-user lock', /interval '1 hour'/.test(redeem) && />= 10/.test(redeem) && /pg_advisory_xact_lock\(hashtext\('redeem:'/.test(redeem) && redeem.indexOf("'rate'") >= 0 && redeem.indexOf("'rate'") < redeem.indexOf('update public.invites'));
check('rpc: redeem_invite consumes the code in one statement (used_at is null and expires_at > now() returning)', /update public\.invites i set used_at = now\(\)[^;]*where[^;]*i\.used_at is null and i\.expires_at > now\(\)[^;]*returning/.test(redeem));
check('rpc: redeem_invite checks the class, ownership and limits before consuming the code', ['already_in_class', 'has_parent', "'limit'", 'created_by = v_uid'].every((s) => redeem.indexOf(s) >= 0 && redeem.indexOf(s) < redeem.indexOf('update public.invites')));
check('rpc: redeem_invite never generates codes; create_invite does, with extensions.gen_random_bytes', !/gen_random_bytes/.test(redeem) && /extensions\.gen_random_bytes\(/.test(create));
const alpha = (/'([A-Za-z0-9]{20,})'/.exec(create) || [])[1] || '';
check('rpc: the code alphabet has 32 distinct unambiguous characters (no 0 O 1 I l)', alpha.length === 32 && new Set(alpha).size === 32 && !/[0O1Il]/.test(alpha), alpha);
check('rpc: codes are 8 characters, live 7 days and are stored only as a SHA-256 hash', /for i in 0\.\.7 loop/.test(create) && /interval '7 days'/.test(create) && /encode\(extensions\.digest\([^;]*'sha256'\), 'hex'\)/.test(create) && /encode\(extensions\.digest\([^;]*'sha256'\), 'hex'\)/.test(redeem) && !/insert into public\.invites \([^)]*\bcode\b(?!_hash)/.test(create));
check('rpc: create_invite allows at most 5 pending codes per child (under a per-child lock)', />= 5/.test(create) && /pg_advisory_xact_lock\(hashtext\('invite:'/.test(create));
check('rpc: delete_child and unlink_me write the tombstone before deleting', ['public.delete_child', 'public.unlink_me'].every((n) => { const b = bodyOf(n); return /insert into public\.deleted_children/.test(b) && b.indexOf('insert into public.deleted_children') < b.indexOf('delete from public.child_profiles'); }));
check('rpc: delete_my_account writes tombstones, refuses the last admin and deletes the auth user', /insert into public\.deleted_children/.test(bodyOf('public.delete_my_account')) && /'last_admin'/.test(bodyOf('public.delete_my_account')) && /delete from auth\.users/.test(bodyOf('public.delete_my_account')));
check('rpc: leave_class refuses a child with no parent link (orphan) and deletes its pending codes', /'orphan'/.test(bodyOf('public.leave_class')) && /delete from public\.invites/.test(bodyOf('public.leave_class')));
check('rpc: admin_delete_class refuses while the class holds children with no parent link (orphans, with the count)', /jsonb_build_object\('error', 'orphans', 'count'/.test(bodyOf('public.admin_delete_class')));
check('rpc: admin_demote_teacher and delete_my_account are never refused for orphans', !/orphan/.test(bodyOf('public.admin_demote_teacher')) && !/orphan/.test(bodyOf('public.delete_my_account')));
// accounts.role is assigned only by the invitation claim and by demotion (the first admin is set by hand, in a comment).
const setsRole = (b) => [...b.matchAll(/update public\.accounts\b[^;]*?\bset\b((?:(?!\bwhere\b)[^;])*)/gi)].some((m) => /\brole\s*=/.test(m[1])) || /insert into public\.accounts\s*\([^)]*\brole\b/.test(b);
check('rpc: only private.claim_role and public.admin_demote_teacher assign accounts.role', fns.filter((f) => setsRole(f.body)).map((f) => f.name).sort().join() === 'private.claim_role,public.admin_demote_teacher', fns.filter((f) => setsRole(f.body)).map((f) => f.name).join());
{ const lockAt = redeem.indexOf('from public.child_profiles c where c.id = v_inv.child_id for update'), recheck = redeem.search(/perform 1 from public\.invites i where i\.id = v_inv\.id and i\.used_at is null and i\.expires_at > now\(\);\s*if not found then v_err := 'invalid'; exit checks; end if;/);
  check('rpc: redeem_invite re-checks the code right after locking the child, before any class or link check (the concurrent loser gets invalid)', lockAt > 0 && recheck > lockAt && ['already_in_class', 'has_parent', 'is_class_teacher('].every((s) => redeem.indexOf(s) > recheck) && !/from public\.invites i\s+where[^;]*for update/.test(redeem)); }
check('rpc: create_invite refuses to_class for a child already in a class (already_in_class)', /if v_class is not null then return jsonb_build_object\('error', 'already_in_class'\)/.test(create));
check('rpc: admin input validation answers bad_input, never invalid (a wrong-code message)', ['public.admin_invite_teacher', 'public.admin_create_class', 'public.admin_rename_class'].every((n) => /'bad_input'/.test(bodyOf(n)) && !/'invalid'/.test(bodyOf(n))));
{ const b = bodyOf('public.admin_delete_class'), lk = b.indexOf('from public.child_profiles c where c.class_id = p_class order by c.id for update');
  check('rpc: admin_delete_class locks the class children (by id) before the class lock and the unclaimed count', lk > 0 && lk < b.indexOf('pg_advisory_xact_lock') && lk < b.indexOf('select count(*)')); }
{ const b = bodyOf('public.delete_my_account'), lk = b.search(/from public\.child_profiles c where c\.id in \(select l\.child_id from public\.child_links l where l\.user_id = v_uid\) order by c\.id for update/);
  check('rpc: delete_my_account locks its linked children before unlinking or deleting them', lk > 0 && lk < b.indexOf('delete from public.child_profiles') && lk < b.indexOf('delete from public.child_links')); }
check('rpc: claim_role logs claim_teacher only when the role actually changed', /set role = 'teacher'[^;]*;\s*(--[^\n]*\n\s*)*if found then\s+insert into public\.admin_log/.test(bodyOf('private.claim_role')));
check('rpc: current_role is always called as private.current_role() (bare current_role is the SQL keyword)', fns.every((f) => !/(?<!private\.)\bcurrent_role\b/.test(f.body) && !/private\.current_role(?!\(\))/.test(f.body)));

const jwtRole = k => { try { return JSON.parse(Buffer.from(String(k).split('.')[1], 'base64url').toString()).role; } catch (e) { return null; } };
check('config: empty (feature off) or a Supabase https URL plus an anon-role JWT, never service_role',
  (cfg.url === '' && cfg.anonKey === '') ||
  (/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(cfg.url) && jwtRole(cfg.anonKey) === 'anon'));
check('config: only the two expected keys exist', Object.keys(cfg).sort().join() === 'anonKey,url');

console.log(failures ? `\n${failures} migration test(s) FAILED` : '\nAll migration tests passed');
process.exit(failures ? 1 : 0);
