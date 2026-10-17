// Verifies row level security on a REAL Supabase project with two throwaway users. Run it after applying the migration:
//   node scripts/check-rls.mjs
// Needs in .env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY (the service key stays in .env, never in git or the app).
// It creates two users with the admin API, signs them in with a password, and deletes them at the end.
import { readFileSync, existsSync } from 'node:fs';

const env = { ...process.env };
if (existsSync('.env')) for (const l of readFileSync('.env', 'utf8').split('\n')) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l); if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const { SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_KEY: service } = env;
if (!url || !anon || !service) { console.error('Faltan SUPABASE_URL, SUPABASE_ANON_KEY o SUPABASE_SERVICE_KEY en .env'); process.exit(2); }

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const j = (h) => ({ 'Content-Type': 'application/json', ...h });
const stamp = Date.now();
const pw = 'T3st-' + Math.random().toString(36).slice(2) + 'Zz9!';
const mk = async (tag) => {
  const email = `rls-${tag}-${stamp}@example.com`;
  const c = await fetch(`${url}/auth/v1/admin/users`, { method: 'POST', headers: j({ apikey: service, Authorization: 'Bearer ' + service }), body: JSON.stringify({ email, password: pw, email_confirm: true }) });
  const u = await c.json();
  const s = await (await fetch(`${url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: j({ apikey: anon }), body: JSON.stringify({ email, password: pw }) })).json();
  return { id: u.id, token: s.access_token };
};
const rest = (u, path, opts = {}) => fetch(`${url}/rest/v1/${path}`, { ...opts, headers: j({ apikey: anon, Authorization: 'Bearer ' + u.token, Prefer: 'return=representation', ...(opts.headers || {}) }) });
const uuid = () => crypto.randomUUID();

const A = await mk('a'), B = await mk('b');
try {
  const id = uuid();
  const ins = await rest(A, 'child_profiles', { method: 'POST', body: JSON.stringify({ id, name: 'Elsa', kind: 'reader', data: { total: 1 } }) });
  const row = (await ins.json())[0];
  check('A can create a profile and the owner is A', ins.status === 201 && row && row.owner === A.id, String(ins.status));
  check("B cannot read A's profile", (await (await rest(B, `child_profiles?id=eq.${id}`)).json()).length === 0);
  const upd = await (await rest(B, `child_profiles?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Hacked' }) })).json();
  check("B cannot update A's profile", Array.isArray(upd) && upd.length === 0);
  const del = await (await rest(B, `child_profiles?id=eq.${id}`, { method: 'DELETE' })).json();
  check("B cannot delete A's profile", Array.isArray(del) && del.length === 0);
  const steal = await rest(B, 'child_profiles', { method: 'POST', body: JSON.stringify({ id: uuid(), owner: A.id, name: 'X', kind: 'reader' }) });
  check('B cannot create a profile owned by A', steal.status >= 400, String(steal.status));
  const anonRead = await fetch(`${url}/rest/v1/child_profiles?select=id`, { headers: { apikey: anon, Authorization: 'Bearer ' + anon } });
  check('a request with only the public key sees nothing', anonRead.status >= 400 || (await anonRead.json()).length === 0, String(anonRead.status));
  const big = await rest(A, 'child_profiles', { method: 'POST', body: JSON.stringify({ id: uuid(), name: 'Big', kind: 'reader', data: { x: 'y'.repeat(250000) } }) });
  check('a profile over 200 KB is rejected', big.status >= 400, String(big.status));
  const bad = await rest(A, 'child_profiles', { method: 'POST', body: JSON.stringify({ id: uuid(), name: 'Bad', kind: 'admin' }) });
  check('an unknown kind is rejected', bad.status >= 400, String(bad.status));
  let created = 1;
  for (let i = 0; i < 9; i++) { const r = await rest(A, 'child_profiles', { method: 'POST', body: JSON.stringify({ id: uuid(), name: 'P' + i, kind: 'pre' }) }); if (r.status === 201) created++; }
  check('an account is limited to 8 profiles', created === 8, String(created));
  const v = await (await rest(A, `child_profiles?id=eq.${id}&version=eq.5`, { method: 'PATCH', body: JSON.stringify({ name: 'Stale', version: 6 }) })).json();
  check('a write with a wrong version changes nothing (optimistic concurrency)', Array.isArray(v) && v.length === 0);
} finally {
  for (const u of [A, B]) await fetch(`${url}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: { apikey: service, Authorization: 'Bearer ' + service } });
}
console.log(failures ? `\n${failures} RLS check(s) FAILED` : '\nAll RLS checks passed');
process.exit(failures ? 1 : 0);
