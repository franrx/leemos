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
const jwtRole = k => { try { return JSON.parse(Buffer.from(String(k).split('.')[1], 'base64url').toString()).role; } catch (e) { return null; } };
check('config: empty (feature off) or a Supabase https URL plus an anon-role JWT, never service_role',
  (cfg.url === '' && cfg.anonKey === '') ||
  (/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(cfg.url) && jwtRole(cfg.anonKey) === 'anon'));
check('config: only the two expected keys exist', Object.keys(cfg).sort().join() === 'anonKey,url');

console.log(failures ? `\n${failures} migration test(s) FAILED` : '\nAll migration tests passed');
process.exit(failures ? 1 : 0);
