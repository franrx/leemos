# Accounts and Progress Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An adult can sign in with an email code from the parents' panel, and the children's progress, stickers and profiles then sync across devices, merged by counters, with the app unchanged for anyone who never signs in.

**Architecture:** A pure merge module (`src/merge.js`) and a Supabase client module (`src/sync.js`, plain `fetch`, injected `fetch`/`storage`/`now` so it is testable) are loaded with dynamic `import()` only when a sync config exists. `src/app.js` gains profile `rid`s, reset counters, a fingerprint-based `modAt`, the sync glue, the parents' panel block and a linking dialog. Supabase holds one RLS-protected table.

**Tech Stack:** Vanilla ES modules (no bundler, no SDK), Supabase Auth (email OTP) and PostgREST over `fetch`, jsdom smoke tests, plain Node test scripts printing `PASS`/`FAIL`.

**Spec:** `docs/superpowers/specs/2026-10-17-accounts-sync-design.md` (read it first; this plan argues from it).

## Global Constraints

- No bundler, no framework, no SDK. `app.js` must contain **no `import` statements** (the smoke test evaluates it as text); load modules with `import()` through `window.__leemosImport || (p => import(p))`.
- No tracking, no analytics, no third-party scripts. Only a nickname, progress counters, stickers and Leo's groups ever leave the device (spec section 1).
- Sync is optional: with `src/data/sync.config.json` empty (`url` or `anonKey` blank) the account UI stays hidden and no sync code is loaded. A tablet that never signs in makes **no** request to Supabase.
- Stat keys are never renamed: Spanish keys have no prefix, Catalan keys start `ca:` (CLAUDE.md). `localStorage['leemos-v1']` (Elsa) and `leemos-v1:<id>` keep their names.
- New UI text: keys in **both** `src/data/i18n.es.json` and `src/data/i18n.ca.json` plus `data-i="key"` in the HTML (a test checks parity).
- Touch targets >= 44 px; colors as tokens; `prefers-reduced-motion` respected.
- If the `SHELL` list in `sw.js` changes, bump `VERSION` (currently `leemos-v3`).
- The Supabase **service key** is never committed and never sent to the app; it lives only in `.env` for `scripts/check-rls.mjs`.
- Commit messages end with the trailers `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS`.

## Review Focus

Inputs and conditions the spec implies but no single task's tests fully exercise. The final reviewer checks each deliberately.

1. **Hostile or malformed remote data** (`__proto__` keys, negative or non-numeric counters, a 10 MB string, `stats` as an array): the merge and apply must not crash, pollute prototypes or write garbage to local state. Pinned in Tasks 1 and 4.
2. **Reset then stale device:** device A resets Catalan progress, device B (offline, old) practices Catalan, both sync. A's reset must win and not be resurrected. Pinned in Task 1.
3. **Sign-in as a different account on a device that has linked profiles:** local `rid`s must be dropped before anything is uploaded. Pinned in Task 7.
4. **Never signed in = zero Supabase traffic**, including after opening the parents' panel. Pinned in Tasks 6 and 8.
5. **Failure in the middle of linking** (network drops after the code is verified, the adult closes the dialog): local data untouched, the dialog can be reopened, no half-linked profile uploaded with someone else's data. Pinned in Task 7.

---

## File structure

| File | Responsibility |
|---|---|
| `src/merge.js` (create) | Pure: `mergeData`, `sameData`, `pickSynced`, `applySynced`. No globals. |
| `src/sync.js` (create) | `createSync({url, anonKey, fetch, storage, now})`: auth (code, verify, refresh, sign out) and REST (`listProfiles`, `syncProfile`). Imports `merge.js`. |
| `src/data/sync.config.json` (create) | `{"url": "", "anonKey": ""}`. Empty = feature off. |
| `supabase/migrations/20261017000000_child_profiles.sql` (create) | Table, RLS policies, limit and touch triggers. |
| `scripts/check-rls.mjs` (create) | Runs against a real project with two test users (service key from `.env`). |
| `tests/lib/fake-supabase.mjs` (create) | In-memory Supabase (auth + `child_profiles` REST) shared by tests. |
| `tests/merge.mjs`, `tests/sync.mjs`, `tests/migration.mjs` (create) | Unit/property, protocol and migration-guard tests. |
| `src/app.js` (modify) | `rid` in profiles, `resets`, `modAt` fingerprint, sync glue, account block, linking dialog. |
| `index.html`, `src/styles.css`, `src/data/i18n.{es,ca}.json` (modify) | Account block, link overlay, nickname hint, texts. |
| `sw.js` (modify) | SHELL gains the three new files, `VERSION` bumped. |
| `tests/smoke.mjs`, `tests/sw.mjs`, `package.json` (modify) | New sections and the new test scripts in `npm test`. |
| `CLAUDE.md`, `README.md` (modify) | Architecture lines, persistence notes, Supabase setup steps for Fran. |

---

### Task 1: The merge (pure) and its tests

**Files:**
- Create: `src/merge.js`
- Create: `tests/merge.mjs`
- Modify: `package.json` (append `&& node tests/merge.mjs` to the `test` script)

**Interfaces:**
- Produces: `mergeData(a, b) -> data`, `sameData(a, b) -> boolean`, `pickSynced(state) -> data`, `applySynced(state, data) -> state` (mutates and returns `state`). `data` shape: `{stats, total, stickers, pre:{es,ca}, resets:{es,ca}, level, name, modAt}`.

- [ ] **Step 1: Write the failing test** — create `tests/merge.mjs`:

```js
// Tests for the pure merge of a child's synced state (src/merge.js).
import { mergeData, sameData, pickSynced, applySynced } from '../src/merge.js';

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((q) => [q, x[q]])) : x));
const same = (a, b) => canon(a) === canon(b);

const A = { stats: { 's:ma': { ok: 3, fail: 1 }, 'w:casa': { ok: 1, fail: 0 } }, total: 10, stickers: 2, pre: { es: 1, ca: 0 }, resets: { es: 0, ca: 0 }, level: 1, name: 'Elsa', modAt: 100 };
const B = { stats: { 's:ma': { ok: 2, fail: 4 }, 'ca:s:ma': { ok: 5, fail: 0 } }, total: 12, stickers: 1, pre: { es: 0, ca: 2 }, resets: { es: 0, ca: 0 }, level: 0, name: 'Elsita', modAt: 200 };

const m = mergeData(A, B);
check('merge: each counter takes the highest value', m.stats['s:ma'].ok === 3 && m.stats['s:ma'].fail === 4 && m.total === 12 && m.stickers === 2);
check('merge: keys from either side are kept', !!m.stats['w:casa'] && !!m.stats['ca:s:ma']);
check('merge: unlocked groups take the highest per language', m.pre.es === 1 && m.pre.ca === 2);
check('merge: level and name come from the side changed last', m.level === 0 && m.name === 'Elsita' && m.modAt === 200);
check('merge: it does not change its inputs', A.stats['s:ma'].fail === 1 && B.total === 12);

// reset epochs: a deliberate reset must not be undone by a stale device
const resetCa = { stats: {}, total: 12, stickers: 1, pre: { es: 0, ca: 0 }, resets: { es: 0, ca: 1 }, level: 0, name: 'Elsa', modAt: 300 };
const staleCa = { stats: { 'ca:s:ma': { ok: 9, fail: 9 }, 's:pa': { ok: 2, fail: 0 } }, total: 20, stickers: 1, pre: { es: 0, ca: 0 }, resets: { es: 0, ca: 0 }, level: 0, name: 'Elsa', modAt: 250 };
const r1 = mergeData(resetCa, staleCa), r2 = mergeData(staleCa, resetCa);
check('reset: the stale device does not bring the deleted Catalan counters back', !r1.stats['ca:s:ma'] && same(r1, r2), canon(r1.stats));
check('reset: Spanish counters of the stale device are kept (only Catalan was reset)', r1.stats['s:pa'] && r1.stats['s:pa'].ok === 2);
check('reset: the epoch is the highest of both', r1.resets.ca === 1 && r1.resets.es === 0);

// robustness against malformed or hostile remote data
const evil = JSON.parse('{"stats":{"__proto__":{"polluted":1},"s:ma":{"ok":-5,"fail":"x","extra":2},"constructor":{"ok":1}},"total":"9","stickers":-3,"pre":[1],"resets":null,"level":2.7,"name":123,"modAt":"nope"}');
let evilOut, threw = false;
try { evilOut = mergeData(A, evil); } catch (e) { threw = true; }
check('robust: malformed remote data never throws', !threw);
check('robust: __proto__ and constructor keys are dropped and nothing is polluted', !threw && !({}).polluted && !Object.prototype.hasOwnProperty.call(evilOut.stats, '__proto__') && !Object.prototype.hasOwnProperty.call(evilOut.stats, 'constructor'));
check('robust: negative or non-numeric counters count as zero', !threw && evilOut.stats['s:ma'].ok === 3 && evilOut.stickers === 2 && evilOut.total === 10);
check('robust: a non-object input is treated as empty', same(mergeData(null, undefined), mergeData({}, {})) && mergeData('x', 5).total === 0);
check('robust: a long name is cut to 40 characters', mergeData({ name: 'x'.repeat(500), modAt: 5 }, {}).name.length === 40);
check('robust: the level is a non-negative integer', mergeData({ level: -3, modAt: 1 }, {}).level === 0 && mergeData({ level: 2.7, modAt: 1 }, {}).level === 2);

// property tests with a seeded generator
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (n) => Math.floor(rnd() * n);
const KEYS = ['s:ma', 's:me', 'w:casa', 'snd:m', 'ca:s:ma', 'ca:w:nena', 'ca:snd:m'];
const gen = () => {
  const stats = {};
  KEYS.forEach((k) => { if (rnd() < 0.6) stats[k] = { ok: ri(6), fail: ri(6) }; });
  return { stats, total: ri(50), stickers: ri(5), pre: { es: ri(4), ca: ri(4) }, resets: { es: ri(3), ca: ri(3) }, level: ri(5), name: ['Elsa', 'Leo', 'Ana'][ri(3)], modAt: ri(5) * 100 };
};
let comm = true, assoc = true, idem = true, mono = true;
for (let i = 0; i < 300; i++) {
  const x = gen(), y = gen(), z = gen();
  if (!same(mergeData(x, y), mergeData(y, x))) comm = false;
  if (!same(mergeData(mergeData(x, y), z), mergeData(x, mergeData(y, z)))) assoc = false;
  if (!same(mergeData(x, x), mergeData(x, {}))) idem = false;
  const mm = mergeData(x, y);
  ['es', 'ca'].forEach((L) => {
    if (x.resets[L] === y.resets[L]) KEYS.filter((k) => (k.indexOf('ca:') === 0) === (L === 'ca')).forEach((k) => {
      ['ok', 'fail'].forEach((f) => { const lo = Math.max((x.stats[k] || {})[f] || 0, (y.stats[k] || {})[f] || 0); if (((mm.stats[k] || {})[f] || 0) < lo) mono = false; });
    });
  });
  if (mm.total < Math.max(x.total, y.total) || mm.stickers < Math.max(x.stickers, y.stickers)) mono = false;
}
check('property: the merge is commutative (300 random pairs)', comm);
check('property: the merge is associative (300 random triples)', assoc);
check('property: merging a state with itself changes nothing', idem);
check('property: no counter ever goes down inside the same reset epoch', mono);

// sameData / pickSynced / applySynced
check('sameData: ignores key order and tells different data apart', sameData({ total: 1, stats: { a: { ok: 1 } } }, { stats: { a: { ok: 1 } }, total: 1 }) && !sameData(A, B));
const S = { stats: {}, total: 0, stickers: 0, pre: { es: 0, ca: 0 }, resets: { es: 0, ca: 0 }, level: 0, name: 'Elsa', modAt: 0, theme: 'dark', sound: false, voiceURIs: { es: 'x', ca: '' }, world: 3 };
const snap = pickSynced(S);
check('pickSynced: only the synced fields come out', !('theme' in snap) && !('sound' in snap) && !('voiceURIs' in snap) && !('world' in snap) && snap.name === 'Elsa');
applySynced(S, m);
check('applySynced: synced fields are replaced and device settings are left alone', S.total === 12 && S.level === 0 && S.name === 'Elsita' && S.theme === 'dark' && S.sound === false && S.world === 3);
check('applySynced: an empty remote name does not erase the local one', applySynced({ name: 'Leo' }, { name: '' }).name === 'Leo');

console.log(failures ? `\n${failures} merge test(s) FAILED` : '\nAll merge tests passed');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/merge.mjs`
Expected: FAIL with `Cannot find module '../src/merge.js'` (the module does not exist yet).

- [ ] **Step 3: Write the implementation** — create `src/merge.js`:

```js
// Pure merge of the synced part of a child's saved state. Spec: docs/superpowers/specs/2026-10-17-accounts-sync-design.md.
// No globals: tests, the sync module and the app (through import()) all use it.
const LANGS = ['es', 'ca'];
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const unsafe = (k) => k === '__proto__' || k === 'constructor' || k === 'prototype';
const langOf = (k) => (k.indexOf('ca:') === 0 ? 'ca' : 'es');
const pair = (o) => ({ es: num(isObj(o) ? o.es : 0), ca: num(isObj(o) ? o.ca : 0) });
const lvl = (x) => Math.floor(num(x && x.level));
const nm = (x) => (x && typeof x.name === 'string' ? x.name.trim().slice(0, 40) : '');

const cleanStat = (s) => {
  const o = {};
  if (isObj(s)) for (const f of Object.keys(s)) if (!unsafe(f) && typeof s[f] === 'number' && Number.isFinite(s[f]) && s[f] >= 0) o[f] = s[f];
  return o;
};
const statsOf = (d, L) => {
  const out = {};
  if (isObj(d.stats)) for (const k of Object.keys(d.stats)) if (!unsafe(k) && langOf(k) === L) out[k] = cleanStat(d.stats[k]);
  return out;
};
const maxStat = (x, y) => {
  const o = {};
  for (const f of new Set([...Object.keys(x || {}), ...Object.keys(y || {})])) o[f] = Math.max(num(x && x[f]), num(y && y[f]));
  return o;
};

export function mergeData(a, b) {
  a = isObj(a) ? a : {};
  b = isObj(b) ? b : {};
  const ra = pair(a.resets), rb = pair(b.resets);
  const stats = {};
  for (const L of LANGS) {
    const sa = statsOf(a, L), sb = statsOf(b, L);
    if (ra[L] > rb[L]) Object.assign(stats, sa); // a deliberate reset wins over an older device
    else if (ra[L] < rb[L]) Object.assign(stats, sb);
    else for (const k of new Set([...Object.keys(sa), ...Object.keys(sb)])) stats[k] = maxStat(sa[k], sb[k]);
  }
  const pa = pair(a.pre), pb = pair(b.pre);
  const ta = num(a.modAt), tb = num(b.modAt);
  // current position (level, name): the side changed last; ties by (level, name) so the argument order never matters
  const aWins = ta !== tb ? ta > tb : lvl(a) !== lvl(b) ? lvl(a) > lvl(b) : nm(a) >= nm(b);
  const w = aWins ? a : b;
  return {
    stats,
    total: Math.max(num(a.total), num(b.total)),
    stickers: Math.max(num(a.stickers), num(b.stickers)),
    pre: { es: Math.max(pa.es, pb.es), ca: Math.max(pa.ca, pb.ca) },
    resets: { es: Math.max(ra.es, rb.es), ca: Math.max(ra.ca, rb.ca) },
    level: lvl(w),
    name: nm(w),
    modAt: Math.max(ta, tb),
  };
}

const canon = (v) => JSON.stringify(v, (k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((q) => [q, x[q]])) : x));
export const sameData = (a, b) => canon(a) === canon(b);

// The synced fields of a saved state (device settings such as theme, voice or sound never leave the device).
export const pickSynced = (state) => mergeData(state, {});

// Put merged data into a saved state; returns the state. An empty name never erases the local one.
export function applySynced(state, data) {
  const d = mergeData(data, {});
  state.stats = d.stats;
  state.total = d.total;
  state.stickers = d.stickers;
  state.pre = d.pre;
  state.resets = d.resets;
  state.level = d.level;
  state.modAt = d.modAt;
  if (d.name) state.name = d.name;
  return state;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/merge.mjs`
Expected: every line `PASS`, final line `All merge tests passed`. If `robust: __proto__ ...` fails, check that `statsOf` uses `unsafe()` on both the stat key and the field names.

- [ ] **Step 5: Add to the suite and commit**

```bash
sed -i.bak 's#&& node tests/levels.mjs"#\&\& node tests/levels.mjs \&\& node tests/merge.mjs"#' package.json && rm package.json.bak
npm test 2>&1 | grep -E "FAIL|merge tests passed"
git add src/merge.js tests/merge.mjs package.json
git commit -m "feat(sync): pure merge of a child's synced state, with reset epochs

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS"
```
Expected: `All merge tests passed`, no `FAIL`.

---

### Task 2: Database migration, RLS check script and config file

**Files:**
- Create: `supabase/migrations/20261017000000_child_profiles.sql`
- Create: `scripts/check-rls.mjs`
- Create: `src/data/sync.config.json`
- Create: `tests/migration.mjs`
- Modify: `package.json` (append `&& node tests/migration.mjs`), `.env.example`

**Interfaces:**
- Produces: table `public.child_profiles(id uuid pk, owner uuid default auth.uid(), name, kind, data jsonb, version int, updated_at)`; config file shape `{"url": string, "anonKey": string}`.

- [ ] **Step 1: Write the failing guard test** — create `tests/migration.mjs`:

```js
// Guards the SQL migration against accidental edits: RLS on, owner-only policies, limits, and the config stays empty in git.
import { readFileSync } from 'node:fs';
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const sql = readFileSync('supabase/migrations/20261017000000_child_profiles.sql', 'utf8');
const cfg = JSON.parse(readFileSync('src/data/sync.config.json', 'utf8'));
const policies = [...sql.matchAll(/create policy "[^"]+" on public\.child_profiles for (select|insert|update|delete)/g)].map((m) => m[1]).sort();

check('migration: row level security is enabled on child_profiles', /alter table public\.child_profiles enable row level security/.test(sql));
check('migration: exactly one policy per operation (select, insert, update, delete)', policies.join() === 'delete,insert,select,update', policies.join());
check('migration: every policy is limited to the signed-in owner', (sql.match(/owner = \(select auth\.uid\(\)\)/g) || []).length >= 5);
check('migration: the owner column defaults to the caller and cascades on user deletion', /owner\s+uuid not null default auth\.uid\(\) references auth\.users\(id\) on delete cascade/.test(sql));
check('migration: name, kind and data size are constrained', /char_length\(name\) between 1 and 40/.test(sql) && /kind in \('reader','pre'\)/.test(sql) && /octet_length\(data::text\) < 200000/.test(sql));
check('migration: at most 8 profiles per account', /count\(\*\)[^;]*>= 8/.test(sql));
check('migration: no policy is granted to anon', !/to anon/.test(sql));
check('config: the committed sync config is empty (the feature is off until Fran fills it in locally)', cfg.url === '' && cfg.anonKey === '');
check('config: only the two expected keys exist', Object.keys(cfg).sort().join() === 'anonKey,url');

console.log(failures ? `\n${failures} migration test(s) FAILED` : '\nAll migration tests passed');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/migration.mjs`
Expected: FAIL with `ENOENT ... child_profiles.sql`.

- [ ] **Step 3: Create the files**

`supabase/migrations/20261017000000_child_profiles.sql`:

```sql
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
```

`src/data/sync.config.json`:

```json
{ "url": "", "anonKey": "" }
```

`scripts/check-rls.mjs`:

```js
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
```

Append to `.env.example`:

```
# Only for scripts/check-rls.mjs (a real Supabase project). The service key is secret: never commit it, never put it in the app.
# SUPABASE_URL=
# SUPABASE_ANON_KEY=
# SUPABASE_SERVICE_KEY=
```

- [ ] **Step 4: Run the guard test and wire it in**

```bash
sed -i.bak 's#&& node tests/merge.mjs"#\&\& node tests/merge.mjs \&\& node tests/migration.mjs"#' package.json && rm package.json.bak
node tests/migration.mjs
node --check scripts/check-rls.mjs && echo "check-rls syntax ok"
```
Expected: every line `PASS`, `All migration tests passed`, `check-rls syntax ok`. (`check-rls.mjs` itself runs only against a real project; Fran runs it as part of the Task 8 handoff.)

- [ ] **Step 5: Commit**

```bash
git add supabase scripts/check-rls.mjs src/data/sync.config.json tests/migration.mjs package.json .env.example
git commit -m "feat(sync): Supabase migration with owner-only RLS, RLS check script, empty sync config

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS"
```

---

### Task 3: Fake Supabase server and the sync client's authentication

**Files:**
- Create: `tests/lib/fake-supabase.mjs`
- Create: `src/sync.js` (auth part)
- Create: `tests/sync.mjs`
- Modify: `package.json` (append `&& node tests/sync.mjs`)

**Interfaces:**
- Consumes: nothing from earlier tasks yet (`sync.js` imports `merge.js` for Task 4; the import is added now so the file is complete).
- Produces: `createSync({url, anonKey, fetch, storage, now}) -> { requestCode(email), verifyCode(email, code) -> session, session() -> session|null, signOut(), userId() -> string|null }`; `class SyncError extends Error { kind: 'offline'|'auth'|'code'|'http'|'conflict', status }`; fake server `createFakeSupabase({code}) -> { fetch, setOffline(b), expireAccessTokens(), revokeRefreshTokens(), rows (Map), log (string[]), userByEmail(email) }`; `memoryStorage(initial)`.
- Storage keys: `leemos-auth` (session JSON `{access_token, refresh_token, expires_at, user:{id,email}}`), `leemos-auth-user` (last user id; written by the app in Task 6/7).

- [ ] **Step 1: Write the fake server** — create `tests/lib/fake-supabase.mjs`:

```js
// In-memory stand-in for Supabase (auth + the child_profiles table) used by tests/sync.mjs and tests/smoke.mjs.
// It enforces what the real project enforces: owner-only rows, the 8-profile limit, optimistic version filters, JWT expiry.
export function createFakeSupabase({ code = '123456', ttlSeconds = 3600 } = {}) {
  const users = new Map();      // email -> {id, email}
  const asked = new Set();      // emails that requested a code
  const access = new Map();     // access token -> {uid, exp}
  const refresh = new Map();    // refresh token -> uid
  const rows = new Map();       // id -> row
  const log = [];
  let offline = false, n = 0;
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  const session = (u) => {
    const at = 'at-' + ++n, rt = 'rt-' + n;
    access.set(at, { uid: u.id, exp: Date.now() + ttlSeconds * 1000 });
    refresh.set(rt, u.id);
    return { access_token: at, refresh_token: rt, expires_in: ttlSeconds, user: { id: u.id, email: u.email } };
  };
  const filters = (u) => {
    const f = {};
    for (const [k, v] of u.searchParams) { const m = /^eq\.(.*)$/.exec(v); if (m) f[k] = m[1]; }
    return f;
  };
  async function fetch(url, opts = {}) {
    if (offline) throw new TypeError('fetch failed');
    const u = new URL(url), method = (opts.method || 'GET').toUpperCase();
    log.push(`${method} ${u.pathname}${u.search}`);
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (u.pathname === '/auth/v1/otp') { asked.add(body.email); return res(200, {}); }
    if (u.pathname === '/auth/v1/verify') {
      if (!asked.has(body.email) || body.token !== code) return res(403, { msg: 'Token has expired or is invalid' });
      let user = users.get(body.email);
      if (!user) { user = { id: 'user-' + (users.size + 1), email: body.email }; users.set(body.email, user); }
      return res(200, session(user));
    }
    if (u.pathname === '/auth/v1/token') {
      const uid = refresh.get(body.refresh_token);
      if (!uid) return res(400, { msg: 'Invalid Refresh Token' });
      refresh.delete(body.refresh_token);
      const user = [...users.values()].find((x) => x.id === uid);
      return res(200, session(user));
    }
    if (u.pathname === '/rest/v1/child_profiles') {
      const h = opts.headers || {};
      const tok = access.get(String(h.Authorization || h.authorization || '').replace('Bearer ', ''));
      if (!tok || tok.exp < Date.now()) return res(401, { message: 'JWT expired' });
      const f = filters(u);
      const mine = (r) => r.owner === tok.uid;
      if (method === 'GET') return res(200, [...rows.values()].filter((r) => mine(r) && (!f.id || r.id === f.id)).map((r) => ({ ...r })));
      if (method === 'POST') {
        if (rows.has(body.id)) return res(409, { message: 'duplicate key' });
        if ([...rows.values()].filter(mine).length >= 8) return res(400, { message: 'profile limit reached' });
        const row = { id: body.id, owner: tok.uid, name: body.name, kind: body.kind, data: body.data || {}, version: 1 };
        rows.set(row.id, row);
        return res(201, [{ ...row }]);
      }
      if (method === 'PATCH') {
        const r = rows.get(f.id);
        if (!r || !mine(r) || (f.version && String(r.version) !== f.version)) return res(200, []);
        Object.assign(r, { name: body.name ?? r.name, data: body.data ?? r.data, version: body.version ?? r.version + 1 });
        return res(200, [{ ...r }]);
      }
    }
    return res(404, { message: 'not found: ' + u.pathname });
  }
  return {
    fetch, rows, log,
    setOffline: (b) => { offline = b; },
    expireAccessTokens: () => access.forEach((t) => { t.exp = Date.now() - 1000; }),
    revokeRefreshTokens: () => refresh.clear(),
    userByEmail: (e) => users.get(e),
  };
}

// A tiny localStorage stand-in for tests that run outside jsdom.
export function memoryStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, _map: m };
}
```

- [ ] **Step 2: Write the failing auth tests** — create `tests/sync.mjs`:

```js
// Tests for the Supabase client (src/sync.js) against the in-memory fake: authentication, then the profile sync protocol (Task 4).
import { createSync, SyncError } from '../src/sync.js';
import { createFakeSupabase, memoryStorage } from './lib/fake-supabase.mjs';

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const URL_ = 'https://x.supabase.co';
const mk = (opts = {}) => {
  const srv = opts.srv || createFakeSupabase();
  const storage = opts.storage || memoryStorage();
  const sync = createSync({ url: URL_, anonKey: 'anon-key', fetch: srv.fetch, storage, now: opts.now || Date.now });
  return { srv, storage, sync };
};

// ---------- authentication ----------
{
  const { srv, storage, sync } = mk();
  await sync.requestCode('mama@example.com');
  check('auth: asking for a code posts the email and creates the user if needed', srv.log.includes('POST /auth/v1/otp'));
  const s = await sync.verifyCode('mama@example.com', '123456');
  check('auth: a correct code returns and stores a session', !!s.access_token && s.user.email === 'mama@example.com' && !!JSON.parse(storage.getItem('leemos-auth')).refresh_token);
  check('auth: userId reflects the stored session', sync.userId() === srv.userByEmail('mama@example.com').id);
  check('auth: session() returns the stored session while it is fresh', (await sync.session()).access_token === s.access_token);
  sync.signOut();
  check('auth: sign out removes the session', (await sync.session()) === null && sync.userId() === null);
}
{
  const { sync } = mk();
  await sync.requestCode('a@b.c');
  const e = await rejects(sync.verifyCode('a@b.c', '000000'));
  check('auth: a wrong code is a "code" error, not a crash', e instanceof SyncError && e.kind === 'code', e && e.kind);
  const e2 = await rejects(sync.verifyCode('never-asked@b.c', '123456'));
  check('auth: a code for an email that never asked is refused', e2 instanceof SyncError && e2.kind === 'code');
}
{
  const { srv, sync } = mk();
  srv.setOffline(true);
  const e = await rejects(sync.requestCode('a@b.c'));
  check('auth: no connection is an "offline" error', e instanceof SyncError && e.kind === 'offline', e && e.kind);
}
{
  // refresh: the access token is renewed before it expires, and a revoked refresh token signs the user out without touching anything else
  let t = Date.now();
  const { srv, storage, sync } = mk({ now: () => t });
  await sync.requestCode('m@e.c');
  const s1 = await sync.verifyCode('m@e.c', '123456');
  t += 3600 * 1000 - 30 * 1000; // 30 s before expiry
  const s2 = await sync.session();
  check('auth: a token near expiry is refreshed transparently', s2.access_token !== s1.access_token && s2.user.id === s1.user.id, s2.access_token);
  srv.revokeRefreshTokens();
  t += 3600 * 1000;
  const e = await rejects(sync.session());
  check('auth: a revoked refresh token is an "auth" error and the session is cleared', e instanceof SyncError && e.kind === 'auth' && storage.getItem('leemos-auth') === null, e && e.kind);
}
{
  const { sync } = mk({ storage: memoryStorage({ 'leemos-auth': '{not json' }) });
  check('auth: a corrupted stored session counts as signed out', (await sync.session()) === null && sync.userId() === null);
}

// ---------- profile sync: Task 4 adds its tests here ----------

console.log(failures ? `\n${failures} sync test(s) FAILED` : '\nAll sync tests passed');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node tests/sync.mjs`
Expected: FAIL with `Cannot find module '../src/sync.js'`.

- [ ] **Step 4: Write the auth implementation** — create `src/sync.js`:

```js
// Supabase client for accounts and progress sync: plain fetch, no SDK. Loaded with import() only when sync is configured.
// Spec: docs/superpowers/specs/2026-10-17-accounts-sync-design.md. Endpoint names: re-check against the current Supabase docs when changing them.
import { mergeData, sameData } from './merge.js';

export class SyncError extends Error {
  constructor(kind, message, status) { super(message || kind); this.kind = kind; this.status = status; }
}

const SESSION_KEY = 'leemos-auth';

export function createSync({ url, anonKey, fetch: doFetch = globalThis.fetch, storage = globalThis.localStorage, now = Date.now }) {
  const base = String(url).replace(/\/+$/, '');
  const read = (k) => { try { return JSON.parse(storage.getItem(k)); } catch (e) { return null; } };
  const write = (k, v) => { try { storage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked: the session just will not persist */ } };
  const headers = (token) => ({ apikey: anonKey, 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || anonKey) });

  async function raw(path, opts) {
    try { return await doFetch(base + path, opts); } catch (e) { throw new SyncError('offline', 'network error'); }
  }
  const toSession = (j, fallbackUser) => ({
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: now() + (Number(j.expires_in) || 3600) * 1000,
    user: { id: (j.user && j.user.id) || (fallbackUser && fallbackUser.id) || null, email: (j.user && j.user.email) || (fallbackUser && fallbackUser.email) || '' },
  });

  const signOut = () => { try { storage.removeItem(SESSION_KEY); } catch (e) { /* nothing to clear */ } };

  async function requestCode(email) {
    const r = await raw('/auth/v1/otp', { method: 'POST', headers: headers(), body: JSON.stringify({ email, create_user: true }) });
    if (!r.ok) throw new SyncError('http', 'could not send the code', r.status);
  }

  async function verifyCode(email, code) {
    const r = await raw('/auth/v1/verify', { method: 'POST', headers: headers(), body: JSON.stringify({ type: 'email', email, token: String(code).trim() }) });
    if (!r.ok) throw new SyncError([400, 401, 403, 422].includes(r.status) ? 'code' : 'http', 'could not verify the code', r.status);
    const s = toSession(await r.json());
    write(SESSION_KEY, s);
    return s;
  }

  async function refresh(old) {
    const r = await raw('/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: headers(), body: JSON.stringify({ refresh_token: old.refresh_token }) });
    if (!r.ok) {
      if ([400, 401, 403].includes(r.status)) { signOut(); throw new SyncError('auth', 'session expired', r.status); }
      throw new SyncError('http', 'could not refresh the session', r.status);
    }
    const s = toSession(await r.json(), old.user);
    write(SESSION_KEY, s);
    return s;
  }

  // The stored session, refreshed when it is about to expire. null when signed out.
  async function session() {
    const s = read(SESSION_KEY);
    if (!s || typeof s.access_token !== 'string' || typeof s.refresh_token !== 'string') return null;
    return s.expires_at - now() < 60000 ? refresh(s) : s;
  }
  const userId = () => { const s = read(SESSION_KEY); return s && s.user && s.user.id ? s.user.id : null; };

  // Task 4 adds the data API (listProfiles, syncProfile) here.

  return { requestCode, verifyCode, session, signOut, userId };
}
```

(`mergeData` and `sameData` are imported now and used from Task 4; an unused import is fine until then.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node tests/sync.mjs`
Expected: all `PASS`, final `All sync tests passed`.

- [ ] **Step 6: Wire into the suite and commit**

```bash
sed -i.bak 's#&& node tests/migration.mjs"#\&\& node tests/migration.mjs \&\& node tests/sync.mjs"#' package.json && rm package.json.bak
npm test 2>&1 | grep -E "FAIL|sync tests passed"
git add src/sync.js tests/lib tests/sync.mjs package.json
git commit -m "feat(sync): Supabase client authentication (email code, refresh, sign out) and a fake server for tests

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS"
```

---

### Task 4: The sync client's profile protocol (pull, merge, push)

**Files:**
- Modify: `src/sync.js` (add REST helpers, `listProfiles`, `syncProfile`)
- Modify: `tests/sync.mjs` (replace the line `// ---------- profile sync: Task 4 adds its tests here ----------` with the tests below)

**Interfaces:**
- Consumes: `createSync` internals from Task 3 (`raw`, `headers`, `refresh`, `session`, `signOut`), `mergeData`, `sameData` from Task 1.
- Produces: `sync.listProfiles() -> Promise<Row[]>` where `Row = {id, name, kind, data, version}`; `sync.syncProfile({rid, name, kind, data}) -> Promise<{data, version}>` (pull-merge-push with up to 5 conflict retries; creates the row when missing; skips the write when nothing changed; throws `SyncError('conflict')` after 5 conflicts, `'offline'`, `'auth'`, `'http'`).

- [ ] **Step 1: Write the failing tests** — in `tests/sync.mjs` replace the Task 4 marker line with:

```js
// ---------- profile sync ----------
const RID = '11111111-1111-4111-8111-111111111111';
const data = (over = {}) => ({ stats: { 's:ma': { ok: 2, fail: 0 } }, total: 5, stickers: 1, pre: { es: 0, ca: 0 }, resets: { es: 0, ca: 0 }, level: 0, name: 'Elsa', modAt: 100, ...over });
const signedIn = async () => { const x = mk(); await x.sync.requestCode('m@e.c'); await x.sync.verifyCode('m@e.c', '123456'); return x; };
{
  const { srv, sync } = await signedIn();
  const r = await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() });
  check('profiles: a profile that does not exist yet is created', srv.rows.has(RID) && r.version === 1 && r.data.total === 5, JSON.stringify(srv.log.slice(-2)));
  const before = srv.log.length;
  const again = await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() });
  check('profiles: syncing unchanged data writes nothing', !srv.log.slice(before).some((l) => l.startsWith('PATCH') || l.startsWith('POST')) && again.version === 1);
  const up = await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data({ total: 9, modAt: 200 }) });
  check('profiles: newer local data is pushed and the version goes up', srv.rows.get(RID).data.total === 9 && up.version === 2 && srv.rows.get(RID).version === 2);
  const down = await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data({ total: 1, stats: {}, modAt: 50 }) });
  check('profiles: an older device receives the merged remote counters', down.data.total === 9 && down.data.stats['s:ma'].ok === 2);
  const list = await sync.listProfiles();
  check("profiles: listProfiles returns the account's rows", list.length === 1 && list[0].id === RID && list[0].name === 'Elsa');
}
{
  // another device writes between our read and our write: version conflict, then a retry that keeps both sides' progress
  const srv = createFakeSupabase(), storage = memoryStorage();
  const sync = createSync({ url: URL_, anonKey: 'k', fetch: srv.fetch, storage });
  await sync.requestCode('m@e.c'); await sync.verifyCode('m@e.c', '123456');
  await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() });
  let injected = false;
  const racing = createSync({
    url: URL_, anonKey: 'k', storage,
    fetch: async (u, o = {}) => {
      if (!injected && (o.method || 'GET') === 'PATCH') { injected = true; const row = srv.rows.get(RID); row.version += 1; row.data = { ...row.data, total: 50, stats: { ...row.data.stats, 's:pa': { ok: 7, fail: 0 } } }; }
      return srv.fetch(u, o);
    },
  });
  const r = await racing.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data({ total: 6, modAt: 300, stats: { 's:ma': { ok: 4, fail: 1 } } }) });
  const row = srv.rows.get(RID);
  check("conflict: a write that lost the race is retried and keeps both devices' progress", injected && row.data.total === 50 && row.data.stats['s:pa'].ok === 7 && row.data.stats['s:ma'].ok === 4 && row.data.stats['s:ma'].fail === 1, JSON.stringify(row.data));
  check('conflict: the final version moved past the one that won the race', row.version === 3 && r.version === 3, String(row.version));
  let n = 0;
  const hostile = createSync({ url: URL_, anonKey: 'k', storage, fetch: async (u, o = {}) => { if ((o.method || 'GET') === 'PATCH') { n++; srv.rows.get(RID).version += 1; } return srv.fetch(u, o); } });
  const e = await rejects(hostile.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data({ total: 999, modAt: 999 }) }));
  check('conflict: after 5 lost races it gives up with a "conflict" error instead of looping', e instanceof SyncError && e.kind === 'conflict' && n === 5, `${e && e.kind} ${n}`);
}
{
  const { srv, sync } = await signedIn();
  srv.setOffline(true);
  const e = await rejects(sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() }));
  check('offline: syncing without a connection is an "offline" error and creates nothing', e instanceof SyncError && e.kind === 'offline' && srv.rows.size === 0);
  srv.setOffline(false);
  await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() });
  check('offline: the next attempt works', srv.rows.has(RID));
}
{
  const { srv, sync } = await signedIn();
  srv.expireAccessTokens();
  const r = await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() });
  check('auth: an access token the server rejected is refreshed once and the request succeeds', srv.rows.has(RID) && r.version === 1 && srv.log.some((l) => l.includes('grant_type=refresh_token')), srv.log.join(' | '));
}
{
  const { srv, sync } = await signedIn();
  srv.expireAccessTokens(); srv.revokeRefreshTokens();
  const e = await rejects(sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() }));
  check('auth: when the session cannot be renewed the error is "auth"', e instanceof SyncError && e.kind === 'auth', e && e.kind);
  const none = mk();
  const e2 = await rejects(none.sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() }));
  check('auth: syncing while signed out is an "auth" error and sends nothing to the data API', e2 instanceof SyncError && e2.kind === 'auth' && !none.srv.log.length);
}
{
  const { srv, sync } = await signedIn();
  for (let i = 0; i < 8; i++) await sync.syncProfile({ rid: crypto.randomUUID(), name: 'P' + i, kind: 'pre', data: data() });
  const e = await rejects(sync.syncProfile({ rid: crypto.randomUUID(), name: 'Nine', kind: 'pre', data: data() }));
  check('limits: the ninth profile is refused with an "http" error', e instanceof SyncError && e.kind === 'http' && srv.rows.size === 8, e && e.kind);
}
{
  const { srv, sync } = await signedIn();
  srv.rows.set(RID, { id: RID, owner: srv.userByEmail('m@e.c').id, name: 'Elsa', kind: 'reader', data: { stats: [1, 2], total: 'lots' }, version: 4 });
  const r = await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() });
  check('remote data: a malformed remote row is merged as if empty and never crashes', r.data.total === 5 && r.version === 5);
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `node tests/sync.mjs`
Expected: the auth tests pass; the profile tests FAIL with `sync.syncProfile is not a function`.

- [ ] **Step 3: Implement** — in `src/sync.js` replace the line `// Task 4 adds the data API (listProfiles, syncProfile) here.` with:

```js
  // ---------- data API (PostgREST) ----------
  async function api(path, opts = {}) {
    let s = await session();
    if (!s) throw new SyncError('auth', 'not signed in');
    const go = (tok) => raw('/rest/v1/' + path, { ...opts, headers: { ...headers(tok), Prefer: 'return=representation', ...(opts.headers || {}) } });
    let r = await go(s.access_token);
    if (r.status === 401) { s = await refresh(s); r = await go(s.access_token); } // the server rejected the token: renew once
    if (r.status === 401) { signOut(); throw new SyncError('auth', 'not authorised', 401); }
    return r;
  }
  const rows = async (r) => { try { const j = await r.json(); return Array.isArray(j) ? j : []; } catch (e) { return []; } };
  const SELECT = 'select=id,name,kind,data,version';

  async function listProfiles() {
    const r = await api(`child_profiles?${SELECT}&order=id`);
    if (!r.ok) throw new SyncError('http', 'could not list profiles', r.status);
    return rows(r);
  }
  async function getProfile(rid) {
    const r = await api(`child_profiles?${SELECT}&id=eq.${encodeURIComponent(rid)}`);
    if (!r.ok) throw new SyncError('http', 'could not read the profile', r.status);
    return (await rows(r))[0] || null;
  }

  // Pull, merge, push one profile. `data` is the local synced snapshot. Returns the merged data and the server version.
  async function syncProfile({ rid, name, kind, data }) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await getProfile(rid);
      if (!row) {
        const c = await api('child_profiles', { method: 'POST', body: JSON.stringify({ id: rid, name, kind, data: mergeData(data, {}) }) });
        if (c.status === 409) continue; // another device created it first: read it and merge
        if (!c.ok) throw new SyncError('http', 'could not create the profile', c.status);
        return { data: mergeData(data, {}), version: 1 };
      }
      const merged = mergeData(data, row.data);
      if (sameData(merged, mergeData(row.data, {})) && row.name === name) return { data: merged, version: row.version };
      const p = await api(`child_profiles?id=eq.${encodeURIComponent(rid)}&version=eq.${row.version}`, { method: 'PATCH', body: JSON.stringify({ name, data: merged, version: row.version + 1 }) });
      if (!p.ok) throw new SyncError('http', 'could not save the profile', p.status);
      if ((await rows(p)).length) return { data: merged, version: row.version + 1 };
      // empty result: someone else wrote first, go again from the read
    }
    throw new SyncError('conflict', 'too many concurrent writes');
  }
```

and change the final return line to:

```js
  return { requestCode, verifyCode, session, signOut, userId, listProfiles, syncProfile };
```

- [ ] **Step 4: Run the tests**

Run: `node tests/sync.mjs`
Expected: all `PASS`. If `conflict: ... final version` fails, check that the retry re-reads the row (its `version` is now 2) and writes `version: 3`.

- [ ] **Step 5: Full suite and commit**

```bash
npm test 2>&1 | grep -E "FAIL|sync tests passed"
git add src/sync.js tests/sync.mjs
git commit -m "feat(sync): pull-merge-push of a profile with version conflicts, offline, refresh and limits

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS"
```

---

### Task 5: App state — profile `rid`, reset counters and fingerprint-based `modAt`

**Files:**
- Modify: `src/app.js` (the `cleanProfiles` function near line 37; the state line 65; `save` near line 64; the reset handler near line 576)
- Modify: `tests/smoke.mjs` (add section 22 before the final `console.log`)

**Interfaces:**
- Consumes: nothing from sync yet.
- Produces: profile list entries may carry `rid` (a uuid string, preserved through `cleanProfiles`/`saveProfiles`); saved state has `resets: {es, ca}` (default zeros) and `modAt` (ms, 0 by default); `save()` sets `S.modAt = Date.now()` only when the synced fields (`stats, total, stickers, pre, resets, level, name`) changed since the last save; `onProgressChange` (a reassignable binding, a no-op until Task 6) is called in that case; `S.resets[S.lang]` increments on "Borrar progreso". `fpOf` and `lastFp` are module-level bindings used by Task 6.

- [ ] **Step 1: Write the failing tests** — append to `tests/smoke.mjs` before the final `console.log(...)` line. Use the `boot`, `until` helpers already defined; check the real ids with `grep -n 'id="themeBtn"\|id="pfAdd"\|id="pfName"\|id="resetBtn"\|id="sessionSel"' index.html` and adapt if they differ:

```js
// ---------- 22. state for sync: profile rid, reset counters, modAt only when progress changes ----------
const RID1 = '11111111-1111-4111-8111-111111111111';
a = await boot({ storage: { 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader', rid: RID1 }, { id: 'leo', name: 'Leo', kind: 'pre', rid: 'not-a-uuid' }] } } });
a.$('pfName').value = 'Ana'; a.$('pfAdd').click(); // adding a child saves the profile list (and reloads the page, which jsdom ignores)
const savedList = JSON.parse(a.w.localStorage.getItem('leemos-profiles')).list;
check('sync state: a valid rid survives loading and saving the profile list', savedList.find((p) => p.id === 'elsa').rid === RID1, JSON.stringify(savedList));
check('sync state: an invalid rid is dropped', !savedList.some((p) => p.rid === 'not-a-uuid') && !('rid' in savedList.find((p) => p.id === 'leo')), JSON.stringify(savedList));

a = await boot();
a.$('joinBtn').click(); a.$('okBtn').click();
const st1 = JSON.parse(a.w.localStorage.getItem('leemos-v1'));
check('sync state: answering stamps modAt and the counters', st1.modAt > 0 && st1.total === 1, JSON.stringify({ m: st1.modAt, t: st1.total }));
a.$('themeBtn').click();
check('sync state: changing the theme does not touch modAt', JSON.parse(a.w.localStorage.getItem('leemos-v1')).modAt === st1.modAt);
a.$('sessionSel').value = '15'; a.$('sessionSel').dispatchEvent(new a.w.Event('change'));
check('sync state: changing the session length does not touch modAt', JSON.parse(a.w.localStorage.getItem('leemos-v1')).modAt === st1.modAt);
a.$('resetBtn').click(); a.$('resetBtn').click();
const st3 = JSON.parse(a.w.localStorage.getItem('leemos-v1'));
check('sync state: "Borrar progreso" counts a reset for the current language only', st3.resets.es === 1 && st3.resets.ca === 0 && st3.modAt >= st1.modAt, JSON.stringify(st3.resets));
check('sync state: the reset deleted the Spanish counters', !Object.keys(st3.stats).some((k) => k.indexOf('ca:') !== 0));
a = await boot({ storage: { 'leemos-v1': { name: 'Elsa', total: 3, stats: { 's:ma': { ok: 1, fail: 0 } }, modAt: 0 } } });
const old = JSON.parse(a.w.localStorage.getItem('leemos-v1') || '{}');
check('sync state: loading an old saved state does not stamp modAt by itself', !old.modAt);
```

- [ ] **Step 2: Run to verify they fail**

Run: `node tests/smoke.mjs 2>&1 | grep -E "sync state|FAILED"`
Expected: `a valid rid survives` FAIL (rid stripped), `answering stamps modAt` FAIL (`modAt` undefined), `reset counts` FAIL.

- [ ] **Step 3: Implement** — edits in `src/app.js`:

(a) In `cleanProfiles`, replace the `list.push(...)` line with:

```js
    list.push({id:x.id,name:typeof x.name==='string'&&x.name.trim()?x.name.trim():x.id,kind:x.kind==='pre'?'pre':'reader',
      ...(typeof x.rid==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x.rid)?{rid:x.rid}:{})});
```

(b) In the `Object.assign(` defaults of `S` (line 65), add `resets:{es:0,ca:0},modAt:0,` right after `pre:{es:0,ca:0}`. Immediately after that `const S=...` statement add:

```js
// Progress-change detection for sync: modAt is stamped only when a synced field changed (not for theme, voice, session length...).
const fpOf=()=>JSON.stringify([S.stats,S.total,S.stickers,S.pre,S.resets,S.level,S.name]);
let lastFp=fpOf();
let onProgressChange=()=>{}; // replaced by the sync glue (Task 6)
```

(c) Replace the `save` definition `const save=()=>{try{localStorage.setItem(KEY,JSON.stringify(S))}catch(e){}};` with:

```js
const save=()=>{
  const fp=fpOf();
  if(fp!==lastFp){lastFp=fp;S.modAt=Date.now();onProgressChange()}
  try{localStorage.setItem(KEY,JSON.stringify(S))}catch(e){}
};
```
`save` is defined before `S`, `fpOf` and `lastFp` exist (temporal dead zone); it is only *called* later. Verify with `grep -n "save()" src/app.js | head -3` that no call happens before the `let lastFp` line runs; if one does, move the three new lines above it.

(d) In the reset handler (`$('resetBtn').onclick`), before `save();`, add the counter update so the line reads:

```js
  Object.keys(S.stats).forEach(k=>{if((S.lang==='ca')===(k.indexOf('ca:')===0))delete S.stats[k]});S.resets=Object.assign({es:0,ca:0},S.resets);S.resets[S.lang]=(S.resets[S.lang]||0)+1;save();resetArmed=false;
```
(keep the rest of that line, `e.target.textContent=t('resetBtn');renderLevels();...`, as it is).

- [ ] **Step 4: Run**

Run: `node tests/smoke.mjs 2>&1 | grep -E "sync state|FAILED|All tests"`
Expected: all `sync state` lines PASS and `All tests passed`.

- [ ] **Step 5: Full suite and commit**

```bash
npm test 2>&1 | grep -E "FAIL|FAILED"
git add src/app.js tests/smoke.mjs
git commit -m "feat(sync): profile rid, per-language reset counters, modAt stamped only on progress changes

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS"
```
Expected: no output from the grep (no failures).

---

### Task 6: Parents' panel account block, config gate and the sync glue

**Files:**
- Modify: `index.html` (account block inside `<details id="parents">`; nickname hint under `#nm`)
- Modify: `src/styles.css` (`.acct`, a few rules)
- Modify: `src/data/i18n.es.json`, `src/data/i18n.ca.json` (new keys)
- Modify: `src/app.js` (sync glue, account UI handlers)
- Modify: `sw.js` (SHELL + VERSION)
- Modify: `tests/sw.mjs`, `tests/smoke.mjs`

**Interfaces:**
- Consumes: `createSync`/`SyncError` (Tasks 3-4), `mergeData`/`pickSynced`/`applySynced`/`sameData` (Task 1), `onProgressChange`, `fpOf`/`lastFp` (Task 5).
- Produces in `app.js` (internal functions, no exports): `syncInit() -> Promise<sync|null>`, `stateOf(id)`, `storeState(id, data)`, `syncAll()`, `schedSync()`, `renderAcct()`, `acctMsg(key, vars)`, `uuid()`, `afterSignIn(user)` (a first simple version; Task 7 replaces it). DOM ids: `acct`, `acctOut`, `acctIn`, `acctEmail`, `acctConsent`, `acctSend`, `acctCodeRow`, `acctCode`, `acctVerify`, `acctWho`, `acctStatus`, `acctSync`, `acctOutBtn`, `acctMsg`.
- Test seam: tests provide the fake server through `window.__leemosSyncFetch` (used as the `fetch` for `createSync` when defined) and the config through the mock `fetch` response for `src/data/sync.config.json`.

- [ ] **Step 1: Extend `boot()` in `tests/smoke.mjs`.** First read the mock fetch it installs (`grep -n "fetch" tests/smoke.mjs | head`). Add two options: `syncConfig` (an object served as the body for URLs ending `src/data/sync.config.json`; default `{url:'',anonKey:''}`) and `supa` (a fake Supabase; when given, set `w.__leemosSyncFetch = supa.fetch` in `beforeParse`). Add at the top of the file: `import { createFakeSupabase } from './lib/fake-supabase.mjs';`. Make sure the existing mock does not return 404 for the new config file in other tests (it should serve the default empty config).

- [ ] **Step 2: Write the failing tests** — append as section 23 in `tests/smoke.mjs`:

```js
// ---------- 23. account block: hidden without config, zero Supabase traffic until the adult signs in ----------
const CFG = { url: 'https://x.supabase.co', anonKey: 'anon' };
let supa = createFakeSupabase();
a = await boot({ supa });
a.$('parents').open = true; a.$('parents').dispatchEvent(new a.w.Event('toggle'));
await sleep(30);
check('account: with an empty config the account block stays hidden', a.$('acct').hidden);
check('account: and nothing was sent to Supabase', supa.log.length === 0);

supa = createFakeSupabase();
a = await boot({ supa, syncConfig: CFG });
check('account: a configured app that was never signed in sends nothing at start', supa.log.length === 0);
a.$('parents').open = true; a.$('parents').dispatchEvent(new a.w.Event('toggle'));
await until(() => !a.$('acct').hidden);
check("account: opening the parents' panel shows the sign-in block", !a.$('acct').hidden && !a.$('acctOut').hidden && a.$('acctIn').hidden);
check('account: and still nothing was sent to Supabase', supa.log.length === 0, supa.log.join(' | '));

a.$('acctEmail').value = 'mama@example.com';
a.$('acctSend').click();
await sleep(20);
check('account: sending a code without accepting the consent is refused and sends nothing', supa.log.length === 0 && a.$('acctMsg').textContent.length > 0 && a.$('acctCodeRow').hidden);
a.$('acctEmail').value = 'not-an-email';
a.$('acctConsent').checked = true;
a.$('acctSend').click();
await sleep(20);
check('account: an invalid email is refused locally', supa.log.length === 0 && a.$('acctCodeRow').hidden);
a.$('acctEmail').value = 'mama@example.com';
a.$('acctSend').click();
await until(() => !a.$('acctCodeRow').hidden);
check('account: a valid email and consent request the code and reveal the code field', supa.log.includes('POST /auth/v1/otp') && !a.$('acctCodeRow').hidden);
a.$('acctCode').value = '000000';
a.$('acctVerify').click();
await sleep(30);
check('account: a wrong code shows a message and stays signed out', a.$('acctIn').hidden && /código/i.test(a.$('acctMsg').textContent), a.$('acctMsg').textContent);
a.$('acctCode').value = '123456';
a.$('acctVerify').click();
await until(() => !a.$('acctIn').hidden);
check('account: the right code signs in and shows the email', !a.$('acctIn').hidden && a.$('acctOut').hidden && a.$('acctWho').textContent.includes('mama@example.com'));
await until(() => supa.rows.size === 1, 3000);
check('account: the first sign-in uploads the local profile', supa.rows.size === 1 && JSON.parse(a.w.localStorage.getItem('leemos-profiles')).list[0].rid === [...supa.rows.keys()][0]);
a.$('acctOutBtn').click();
await sleep(20);
check('account: sign out returns to the sign-in view and keeps local progress and the link', !a.$('acctOut').hidden && a.$('acctIn').hidden && !!JSON.parse(a.w.localStorage.getItem('leemos-profiles')).list[0].rid && a.w.localStorage.getItem('leemos-auth') === null);

const swText = readFileSync(join(ROOT, 'sw.js'), 'utf8');
check('account: the service worker pre-caches the sync modules and config', ['src/merge.js', 'src/sync.js', 'src/data/sync.config.json'].every((f) => swText.includes(`'${f}'`)));
check('account: the nickname hint is present under the name field', !!a.d.querySelector('[data-i="nickHint"]'));
```

In `tests/sw.mjs`, add a test that a `fetch` event for another origin (for example `https://x.supabase.co/rest/v1/child_profiles`) is not handled by the service worker (`respondWith` is never called). Read `sed -n 1,60p tests/sw.mjs` first and mirror its harness; if it already has an "other origin is ignored" check for a different host, add the Supabase URL as a second case.

- [ ] **Step 3: Run to verify failure**

Run: `node tests/smoke.mjs 2>&1 | grep -E "account:|FAILED"`
Expected: FAIL (`$('acct')` is null) until the markup exists.

- [ ] **Step 4: Implement the markup** — in `index.html`, inside `<details id="parents">`, right after the `<input type="text" id="nm" ...>` row (`<div class="row">...</div>` that contains `nm`), add:

```html
    <p class="small" data-i="nickHint">Usa un apodo, no el nombre completo.</p>
```

and add this block right before `<p class="small" id="voiceInfo"></p>`:

```html
    <div class="acct" id="acct" hidden>
      <div class="row"><strong data-i="acctTitle">Guardar mi progreso</strong></div>
      <div id="acctOut">
        <p class="small" data-i="acctIntro">Entra con tu email para ver el progreso y las pegatinas en todos tus dispositivos. Lo haces tú, no ella.</p>
        <div class="row">
          <label for="acctEmail" data-i="acctEmail">Email</label>
          <input type="email" id="acctEmail" autocomplete="email" maxlength="120">
        </div>
        <label class="row acct-consent"><input type="checkbox" id="acctConsent"> <span data-i="acctConsent">Soy el padre, la madre o tutor y acepto la política de privacidad.</span></label>
        <div class="row"><button class="icon-btn" id="acctSend" data-i="acctSend">Enviar código</button></div>
        <div class="row" id="acctCodeRow" hidden>
          <label for="acctCode" data-i="acctCode">Código</label>
          <input type="text" id="acctCode" inputmode="numeric" maxlength="8" autocomplete="one-time-code">
          <button class="icon-btn" id="acctVerify" data-i="acctVerify">Entrar</button>
        </div>
      </div>
      <div id="acctIn" hidden>
        <p id="acctWho"></p>
        <p class="small" id="acctStatus" aria-live="polite"></p>
        <div class="row">
          <button class="icon-btn" id="acctSync" data-i="acctSync">Sincronizar ahora</button>
          <button class="icon-btn" id="acctOutBtn" data-i="acctSignOut">Cerrar sesión</button>
        </div>
      </div>
      <p class="small" id="acctMsg" aria-live="polite"></p>
    </div>
```

Also add the same `<p class="small" data-i="nickHint">...</p>` line under the `pfName` row in the profiles overlay.

CSS in `src/styles.css` (near the other `#parents` rules):

```css
.acct{margin-top:14px;padding-top:12px;border-top:2px dashed var(--line)}
.acct input[type=email],.acct input[type=text]{flex:1;min-width:0;min-height:44px;padding:8px 10px;font:inherit;border:2px solid var(--line);border-radius:12px;background:var(--panel);color:inherit}
.acct-consent{align-items:flex-start;gap:10px;min-height:44px}
.acct-consent input{width:24px;height:24px;flex:none;margin-top:2px}
```

i18n keys, add to both files before the closing `}` (add a comma to the previous last entry). Spanish:

```json
  "nickHint": "Usa un apodo, no el nombre completo.",
  "acctTitle": "Guardar mi progreso",
  "acctIntro": "Entra con tu email para ver el progreso y las pegatinas en todos tus dispositivos. Lo haces tú, no ella.",
  "acctEmail": "Email",
  "acctConsent": "Soy el padre, la madre o tutor y acepto la política de privacidad.",
  "acctSend": "Enviar código",
  "acctCode": "Código",
  "acctVerify": "Entrar",
  "acctWho": "Sesión iniciada como {e}",
  "acctSynced": "Sincronizado {m}",
  "acctNever": "Aún no sincronizado",
  "acctSyncing": "Sincronizando…",
  "acctOffline": "Sin conexión: se sincronizará más tarde",
  "acctSync": "Sincronizar ahora",
  "acctSignOut": "Cerrar sesión",
  "acctBadEmail": "Escribe un email válido.",
  "acctNeedConsent": "Marca la casilla para continuar.",
  "acctSent": "Te hemos enviado un código por email. Escríbelo aquí.",
  "acctBadCode": "Código incorrecto o caducado. Pide uno nuevo.",
  "acctNetwork": "No hay conexión. Inténtalo de nuevo.",
  "acctError": "No se pudo completar. Inténtalo de nuevo.",
  "acctExpired": "La sesión ha caducado. Vuelve a entrar.",
  "acctMinAgo": "hace {n} min",
  "acctJustNow": "ahora mismo"
```
Catalan:
```json
  "nickHint": "Fes servir un sobrenom, no el nom complet.",
  "acctTitle": "Guardar el meu progrés",
  "acctIntro": "Entra amb el teu correu per veure el progrés i les enganxines a tots els teus dispositius. Ho fas tu, no ella.",
  "acctEmail": "Correu electrònic",
  "acctConsent": "Sóc el pare, la mare o tutor i accepto la política de privadesa.",
  "acctSend": "Enviar codi",
  "acctCode": "Codi",
  "acctVerify": "Entrar",
  "acctWho": "Sessió iniciada com a {e}",
  "acctSynced": "Sincronitzat {m}",
  "acctNever": "Encara no sincronitzat",
  "acctSyncing": "Sincronitzant…",
  "acctOffline": "Sense connexió: se sincronitzarà més tard",
  "acctSync": "Sincronitzar ara",
  "acctSignOut": "Tancar la sessió",
  "acctBadEmail": "Escriu un correu vàlid.",
  "acctNeedConsent": "Marca la casella per continuar.",
  "acctSent": "T'hem enviat un codi per correu. Escriu-lo aquí.",
  "acctBadCode": "Codi incorrecte o caducat. Demana'n un de nou.",
  "acctNetwork": "No hi ha connexió. Torna-ho a provar.",
  "acctError": "No s'ha pogut completar. Torna-ho a provar.",
  "acctExpired": "La sessió ha caducat. Torna a entrar.",
  "acctMinAgo": "fa {n} min",
  "acctJustNow": "ara mateix"
```

- [ ] **Step 5: Implement the glue** — in `src/app.js`, add this section after the profile helpers (`saveProfiles`, `keyFor`, `profileSlug`), after `loadJSON` and the `S` state exist, and above the startup lines near `applyTheme();applyCase();...` (it must be defined before it is used at startup):

```js
// ---------- accounts and sync (optional; spec: docs/superpowers/specs/2026-10-17-accounts-sync-design.md) ----------
let sync=null,mergeMod=null,syncBusy=false,syncTimer=null,syncState='idle'; // idle | syncing | offline | error
const AUTH_USER_KEY='leemos-auth-user',SYNC_AT_KEY='leemos-sync-at';
const uuid=()=>(window.crypto&&crypto.randomUUID)?crypto.randomUUID():'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return (c==='x'?r:(r&3|8)).toString(16)});
// Loads the sync modules only when the config has a project; with an empty config nothing is loaded and no request is made.
async function syncInit(){
  if(sync)return sync;
  try{
    const cfg=await loadJSON('src/data/sync.config.json');
    if(!cfg||!cfg.url||!cfg.anonKey)return null;
    const imp=window.__leemosImport||(p=>import(p));
    const [sm,mm]=await Promise.all([imp('./sync.js'),imp('./merge.js')]);
    mergeMod=mm;
    sync=sm.createSync({url:cfg.url,anonKey:cfg.anonKey,fetch:window.__leemosSyncFetch||undefined});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)syncAll()});
    window.addEventListener('pagehide',()=>syncAll());
    return sync;
  }catch(e){return null}
}
const stateOf=id=>{
  if(id===PROFILE.id)return S;
  try{return JSON.parse(localStorage.getItem(keyFor(id)))||{}}catch(e){return {}}
};
// Write merged data into a profile (the active one lives in S; the others only in localStorage).
function storeState(id,data){
  if(id===PROFILE.id){
    mergeMod.applySynced(S,data);
    if(S.level>=LEVELS.length)S.level=0;
    lastFp=fpOf(); // data that came from the server is not a local change: no modAt stamp, no new sync
    save();renderLevels();renderHard();updateHello();
  }else{
    const cur=stateOf(id);mergeMod.applySynced(cur,data);
    try{localStorage.setItem(keyFor(id),JSON.stringify(cur))}catch(e){}
  }
}
function schedSync(){if(!sync)return;clearTimeout(syncTimer);syncTimer=setTimeout(()=>syncAll(),5000)}
onProgressChange=schedSync;
async function syncAll(){
  if(syncBusy||!sync)return;
  let ok=false;
  try{ok=!!(await sync.session())}catch(e){renderAcct();return}
  if(!ok)return;
  syncBusy=true;syncState='syncing';renderAcct();
  try{
    for(const p of PROFILES.list){
      if(!p.rid)continue;
      const r=await sync.syncProfile({rid:p.rid,name:p.name,kind:p.kind,data:mergeMod.pickSynced(stateOf(p.id))});
      storeState(p.id,r.data);
    }
    syncState='idle';
    try{localStorage.setItem(SYNC_AT_KEY,String(Date.now()))}catch(e){}
  }catch(e){syncState=e&&e.kind==='offline'?'offline':'error';if(e&&e.kind==='auth')acctMsg('acctExpired')}
  finally{syncBusy=false;renderAcct()}
}
function acctMsg(key,vars){$('acctMsg').textContent=key?t(key,vars):''}
function renderAcct(){
  if(!sync)return;
  $('acct').hidden=false;
  let email='';try{const s=JSON.parse(localStorage.getItem('leemos-auth'));email=s&&s.user&&s.user.email||''}catch(e){}
  const signedIn=!!email&&!!sync.userId();
  $('acctOut').hidden=signedIn;$('acctIn').hidden=!signedIn;
  if(!signedIn)return;
  $('acctWho').textContent=t('acctWho',{e:email});
  const at=Number(localStorage.getItem(SYNC_AT_KEY))||0;
  const mins=Math.max(0,Math.round((Date.now()-at)/60000));
  $('acctStatus').textContent=syncState==='syncing'?t('acctSyncing'):syncState==='offline'?t('acctOffline'):!at?t('acctNever'):t('acctSynced',{m:mins<1?t('acctJustNow'):t('acctMinAgo',{n:mins})});
}
$('parents').addEventListener('toggle',async()=>{if($('parents').open&&await syncInit())renderAcct()});
$('acctSend').onclick=async()=>{
  const email=$('acctEmail').value.trim();
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){acctMsg('acctBadEmail');return}
  if(!$('acctConsent').checked){acctMsg('acctNeedConsent');return}
  const sy=await syncInit();if(!sy)return;
  try{await sy.requestCode(email);$('acctCodeRow').hidden=false;acctMsg('acctSent');$('acctCode').focus()}
  catch(e){acctMsg(e&&e.kind==='offline'?'acctNetwork':'acctError')}
};
$('acctVerify').onclick=async()=>{
  const sy=await syncInit();if(!sy)return;
  try{
    const s=await sy.verifyCode($('acctEmail').value.trim(),$('acctCode').value);
    acctMsg('');$('acctCode').value='';$('acctCodeRow').hidden=true;
    await afterSignIn(s.user);
  }catch(e){acctMsg(e&&e.kind==='code'?'acctBadCode':e&&e.kind==='offline'?'acctNetwork':'acctError')}
};
$('acctSync').onclick=()=>syncAll();
$('acctOutBtn').onclick=()=>{if(sync)sync.signOut();syncState='idle';acctMsg('');renderAcct()};
// First version: every local profile without a rid gets one and is uploaded. Task 7 replaces this with the linking dialog.
async function afterSignIn(user){
  try{localStorage.setItem(AUTH_USER_KEY,user.id)}catch(e){}
  PROFILES.list.forEach(p=>{if(!p.rid)p.rid=uuid()});
  saveProfiles();
  await syncAll();
}
// A session from an earlier visit: sync at start (only if signed in; otherwise nothing is loaded or sent).
try{if(localStorage.getItem('leemos-auth'))syncInit().then(sy=>{if(sy){renderAcct();syncAll()}})}catch(e){}
```

`onProgressChange=schedSync;` reassigns the `let` declared in Task 5.

- [ ] **Step 6: Service worker** — in `sw.js`: add `'src/merge.js', 'src/sync.js', 'src/data/sync.config.json',` to the `SHELL` array and change `const VERSION = 'leemos-v3';` to `'leemos-v4'`. Update any test in `tests/sw.mjs` that asserts the `VERSION` string or the SHELL list.

- [ ] **Step 7: Run everything**

```bash
node tests/smoke.mjs 2>&1 | grep -E "account:|FAILED|All tests"
node tests/sw.mjs 2>&1 | tail -3
npm test 2>&1 | grep -E "FAIL|FAILED"
```
Expected: all `account:` lines PASS; no failures anywhere.

- [ ] **Step 8: Commit**

```bash
git add index.html src sw.js tests
git commit -m "feat(sync): parents' panel sign-in with email code, sync glue, sync modules in the service worker shell

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS"
```

---

### Task 7: First sign-in linking dialog and "different account on this device"

**Files:**
- Modify: `index.html` (link overlay), `src/data/i18n.{es,ca}.json`, `src/app.js` (`afterSignIn` rewritten, `askLink` added), `tests/smoke.mjs`

**Interfaces:**
- Consumes: `sync.listProfiles()`, `syncAll()`, `uuid()`, `AUTH_USER_KEY`, `saveProfiles`, `keyFor`, `profileSlug`, `mergeMod` (Tasks 3-6).
- Produces: `afterSignIn(user)` implements spec section 4; `askLink(local, candidates) -> Promise<string|null>` (resolves with a remote id or `null` for "new child"; rejects with `Error('cancelled')` when the adult closes the dialog); overlay ids `link`, `linkTitle`, `linkAsk`, `linkOpts`, `linkCancel`; i18n keys `linkTitle`, `linkAsk` (`{n}`), `linkNew`, `linkCancel`.

- [ ] **Step 1: Write the failing tests** — append as section 24 in `tests/smoke.mjs`:

```js
// ---------- 24. linking on first sign-in, other account on the same device ----------
const signInUi = async (app, email) => {
  app.$('parents').open = true; app.$('parents').dispatchEvent(new app.w.Event('toggle'));
  await until(() => !app.$('acct').hidden);
  app.$('acctEmail').value = email; app.$('acctConsent').checked = true; app.$('acctSend').click();
  await until(() => !app.$('acctCodeRow').hidden);
  app.$('acctCode').value = '123456'; app.$('acctVerify').click();
};
const LINK_PROFILES = { 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader' }, { id: 'leo', name: 'Leo', kind: 'pre' }] } };
const withAccount = async (rows) => { // a fake project whose account already has children created by another device
  const s = createFakeSupabase();
  await s.fetch('https://x/auth/v1/otp', { method: 'POST', body: JSON.stringify({ email: 'mama@example.com' }) });
  await s.fetch('https://x/auth/v1/verify', { method: 'POST', body: JSON.stringify({ email: 'mama@example.com', token: '123456', type: 'email' }) });
  const uid = s.userByEmail('mama@example.com').id;
  rows.forEach(([id, name, kind, d]) => s.rows.set(id, { id, owner: uid, name, kind, data: d, version: 1 }));
  return s;
};
const dat = (o = {}) => ({ stats: {}, total: 0, stickers: 0, pre: { es: 0, ca: 0 }, resets: { es: 0, ca: 0 }, level: 0, name: '', modAt: 1, ...o });
const RID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', RID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const linkButtons = (app) => [...app.$('linkOpts').querySelectorAll('button')];

// 24a: empty account: every local profile is uploaded, no questions
supa = createFakeSupabase();
a = await boot({ supa, syncConfig: CFG, storage: LINK_PROFILES });
await signInUi(a, 'mama@example.com');
await until(() => supa.rows.size === 2, 3000);
check('link: an empty account receives every local profile without asking', supa.rows.size === 2 && a.$('link').hidden);

// 24b: the account already has "Elsa" from another tablet: ask, and linking merges both sides' progress
supa = await withAccount([[RID_A, 'Elsa', 'reader', dat({ stats: { 's:pa': { ok: 6, fail: 0 } }, total: 20, stickers: 2, level: 1, name: 'Elsa', modAt: 5 })]]);
a = await boot({ supa, syncConfig: CFG, storage: { ...LINK_PROFILES, 'leemos-v1': { name: 'Elsa', total: 3, stickers: 1, stats: { 's:ma': { ok: 2, fail: 1 } } } } });
await signInUi(a, 'mama@example.com');
await until(() => !a.$('link').hidden);
check('link: with account profiles present the adult is asked about the first local profile', !a.$('link').hidden && /Elsa/.test(a.$('linkAsk').textContent), a.$('linkAsk').textContent);
check('link: the options are the account profiles plus "add as a new child"', linkButtons(a).length === 2 && /Elsa/.test(linkButtons(a)[0].textContent), linkButtons(a).map((b) => b.textContent).join('|'));
linkButtons(a)[0].click(); // yes, same child as the account's Elsa
await until(() => !a.$('link').hidden && /Leo/.test(a.$('linkAsk').textContent), 3000);
check('link: then it asks about the next local profile', !a.$('link').hidden && /Leo/.test(a.$('linkAsk').textContent), a.$('linkAsk').textContent);
linkButtons(a).pop().click(); // Leo: add as a new child
await until(() => supa.rows.size === 2 && supa.rows.get(RID_A).data.stats['s:ma'], 3000);
const merged = supa.rows.get(RID_A).data;
check('link: linking keeps the progress of both devices', merged.total === 20 && merged.stats['s:pa'].ok === 6 && merged.stats['s:ma'].ok === 2 && merged.stickers === 2, JSON.stringify(merged));
check('link: the local profile now points at the account profile', JSON.parse(a.w.localStorage.getItem('leemos-profiles')).list.find((p) => p.id === 'elsa').rid === RID_A);
check('link: "add as a new child" creates a second account profile for Leo', supa.rows.size === 2 && [...supa.rows.values()].some((r) => r.name === 'Leo'));

// 24c: account profiles that no local profile claimed are added to this device
supa = await withAccount([[RID_A, 'Elsa', 'reader', dat({ total: 4, stickers: 1, name: 'Elsa' })], [RID_B, 'Mateo', 'reader', dat({ stats: { 's:ma': { ok: 3, fail: 0 } }, total: 8, level: 2, name: 'Mateo', modAt: 2 })]]);
a = await boot({ supa, syncConfig: CFG });
await signInUi(a, 'mama@example.com');
await until(() => !a.$('link').hidden);
linkButtons(a)[0].click(); // local Elsa = account Elsa
await until(() => JSON.parse(a.w.localStorage.getItem('leemos-profiles')).list.length === 2, 3000);
const lp = JSON.parse(a.w.localStorage.getItem('leemos-profiles')).list;
const mateo = lp.find((p) => p.rid === RID_B);
check('link: a child that exists only in the account is added to this device', !!mateo && mateo.name === 'Mateo' && mateo.kind === 'reader', JSON.stringify(lp));
const mst = JSON.parse(a.w.localStorage.getItem('leemos-v1:' + mateo.id));
check("link: and arrives with the account's progress", mst.total === 8 && mst.stats['s:ma'].ok === 3 && mst.level === 2, JSON.stringify(mst));

// 24d: a different account on the same device: old rids are dropped before anything is uploaded
supa = createFakeSupabase();
a = await boot({ supa, syncConfig: CFG, storage: { 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader', rid: RID_A }] }, 'leemos-auth-user': 'user-from-another-account' } });
await signInUi(a, 'otra@example.com');
await until(() => supa.rows.size === 1, 3000);
const newRid = [...supa.rows.keys()][0];
check('other account: the old link is dropped and the profile is uploaded under a new id', newRid !== RID_A && JSON.parse(a.w.localStorage.getItem('leemos-profiles')).list[0].rid === newRid);
check('other account: the new user id is remembered', a.w.localStorage.getItem('leemos-auth-user') === supa.userByEmail('otra@example.com').id);

// 24e: the network drops after the adult chose: local data is untouched and nothing is half-linked
supa = await withAccount([[RID_A, 'Elsa', 'reader', dat({ total: 1, name: 'Elsa' })]]);
a = await boot({ supa, syncConfig: CFG, storage: { ...LINK_PROFILES, 'leemos-v1': { name: 'Elsa', total: 3, stats: { 's:ma': { ok: 2, fail: 1 } } } } });
await signInUi(a, 'mama@example.com');
await until(() => !a.$('link').hidden);
supa.setOffline(true);
linkButtons(a)[0].click();
await sleep(100);
const afterDrop = JSON.parse(a.w.localStorage.getItem('leemos-v1'));
check('network drop: local progress is untouched', afterDrop.total === 3 && afterDrop.stats['s:ma'].ok === 2);
check('network drop: nothing was uploaded and there was no error', supa.rows.get(RID_A).data.total === 1 && a.errors.length === 0, a.errors.join(' | '));

// 24f: closing the dialog cancels the linking and leaves the profiles as they were
supa = await withAccount([[RID_A, 'Elsa', 'reader', dat({ total: 1, name: 'Elsa' })]]);
a = await boot({ supa, syncConfig: CFG, storage: LINK_PROFILES });
await signInUi(a, 'mama@example.com');
await until(() => !a.$('link').hidden);
a.$('linkCancel').click();
await sleep(60);
const listAfterCancel = JSON.parse(a.w.localStorage.getItem('leemos-profiles')).list;
check('cancel: closing the dialog links nothing and uploads nothing', a.$('link').hidden && listAfterCancel.every((p) => !p.rid) && supa.rows.size === 1);
```

- [ ] **Step 2: Run to verify failure**

Run: `node tests/smoke.mjs 2>&1 | grep -E "link:|other account|network drop|cancel:|FAILED"`
Expected: FAIL (`$('link')` is null, and `afterSignIn` still links blindly).

- [ ] **Step 3: Implement** — markup in `index.html` (next to the other overlays, before `<div class="overlay" id="end" hidden>`):

```html
<div class="overlay" id="link" hidden>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="linkTitle">
    <h2 id="linkTitle" data-i="linkTitle">Unir con tu cuenta</h2>
    <p id="linkAsk"></p>
    <div class="worlds" id="linkOpts"></div>
    <div class="actions"><button class="btn" id="linkCancel" data-i="linkCancel">Ahora no</button></div>
  </div>
</div>
```

i18n (both files; Spanish then Catalan):

```json
  "linkTitle": "Unir con tu cuenta",
  "linkAsk": "¿«{n}» de esta tablet es el mismo niño o niña que alguno de tu cuenta?",
  "linkNew": "No, añadir como nuevo",
  "linkCancel": "Ahora no",
```
```json
  "linkTitle": "Unir amb el teu compte",
  "linkAsk": "«{n}» d'aquesta tauleta és el mateix infant que algun del teu compte?",
  "linkNew": "No, afegir com a nou",
  "linkCancel": "Ara no",
```

Replace the first-version `afterSignIn` in `src/app.js` with:

```js
// Asks which account profile (if any) a local profile is. Resolves with a remote id, or null for "add as a new child".
// Closing the dialog ("Ahora no") rejects, and the caller leaves everything as it was.
function askLink(local,candidates){
  return new Promise((resolve,reject)=>{
    $('linkAsk').textContent=t('linkAsk',{n:local.name});
    const box=$('linkOpts');box.innerHTML='';
    const done=v=>{$('link').hidden=true;v===undefined?reject(new Error('cancelled')):resolve(v)};
    candidates.forEach(r=>{const b=document.createElement('button');b.className='wbtn';b.textContent=r.name;b.onclick=()=>done(r.id);box.appendChild(b)});
    const nb=document.createElement('button');nb.className='wbtn';nb.textContent=t('linkNew');nb.onclick=()=>done(null);box.appendChild(nb);
    $('linkCancel').onclick=()=>done(undefined);
    $('link').hidden=false;
  });
}
// First sign-in on this device (spec section 4): link the local profiles to the account's, upload the new ones, bring the rest here.
async function afterSignIn(user){
  const prev=localStorage.getItem(AUTH_USER_KEY);
  const snapshot=JSON.stringify(PROFILES.list);
  try{
    if(prev&&prev!==user.id)PROFILES.list.forEach(p=>{delete p.rid}); // another account used this tablet: never upload its children into this one unasked
    const remote=await sync.listProfiles();
    const known=new Set(remote.map(r=>r.id));
    const claimed=new Set(PROFILES.list.filter(p=>p.rid&&known.has(p.rid)).map(p=>p.rid));
    for(const p of PROFILES.list.filter(x=>!x.rid)){
      const cands=remote.filter(r=>!claimed.has(r.id));
      const pick=cands.length?await askLink(p,cands):null;
      p.rid=pick||uuid();
      if(pick)claimed.add(pick);
    }
    for(const r of remote){
      if(claimed.has(r.id)||PROFILES.list.some(p=>p.rid===r.id))continue;
      const base=profileSlug(r.name)||'nino';let id=base,i=2;
      while(PROFILES.list.some(x=>x.id===id))id=base+'-'+i++;
      PROFILES.list.push({id,name:r.name,kind:r.kind==='pre'?'pre':'reader',rid:r.id});
      const st=mergeMod.applySynced({},r.data);
      try{localStorage.setItem(keyFor(id),JSON.stringify(st))}catch(e){}
    }
    saveProfiles();
    try{localStorage.setItem(AUTH_USER_KEY,user.id)}catch(e){}
  }catch(e){
    PROFILES.list.splice(0,PROFILES.list.length,...JSON.parse(snapshot)); // cancelled or failed half way: nothing stays half-linked
    $('link').hidden=true;
    acctMsg(e&&e.kind==='offline'?'acctNetwork':e&&e.message==='cancelled'?'':'acctError');
    renderAcct();
    return;
  }
  await syncAll();
}
```
In test 24e the adult has already chosen when the network drops: `syncAll` then fails with `offline`, the `rid` links stay (they point at the account profile) and the next sync merges. Local state and the remote row stay as the test checks.

- [ ] **Step 4: Run**

```bash
node tests/smoke.mjs 2>&1 | grep -E "link:|other account|network drop|cancel:|FAILED|All tests"
npm test 2>&1 | grep -E "FAIL|FAILED"
```
Expected: all lines PASS and no failures. If `link: the options ...` fails because the button count differs, check that candidate buttons are generated only for unclaimed account profiles.

- [ ] **Step 5: Commit**

```bash
git add index.html src tests
git commit -m "feat(sync): first sign-in linking dialog, remote children added to the device, other-account guard

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS"
```

---

### Task 8: Triggers, documentation, final verification and the handoff to Fran

**Files:**
- Modify: `tests/smoke.mjs` (section 25), `CLAUDE.md`, `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: documented behavior; a final report listing what Fran must do (the prerequisites).

- [ ] **Step 1: Write the tests for the triggers** — append as section 25:

```js
// ---------- 25. when it syncs: at start (signed in), after progress changes, when the page is hidden ----------
supa = createFakeSupabase();
await supa.fetch('https://x/auth/v1/otp', { method: 'POST', body: JSON.stringify({ email: 'mama@example.com' }) });
const sess = await (await supa.fetch('https://x/auth/v1/verify', { method: 'POST', body: JSON.stringify({ email: 'mama@example.com', token: '123456', type: 'email' }) })).json();
const authStored = { access_token: sess.access_token, refresh_token: sess.refresh_token, expires_at: Date.now() + 3600 * 1000, user: sess.user };
supa.log.length = 0;
a = await boot({ supa, syncConfig: CFG, storage: { 'leemos-auth': authStored, 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader', rid: RID_A }] }, 'leemos-v1': { name: 'Elsa', total: 2, stats: { 's:ma': { ok: 1, fail: 0 } }, modAt: 10 } } });
await until(() => supa.rows.has(RID_A), 3000);
check('triggers: a signed-in app syncs at start', supa.rows.has(RID_A) && supa.rows.get(RID_A).data.total === 2);
const row = supa.rows.get(RID_A); // another device moves ahead meanwhile
row.data = { ...row.data, total: 40, stickers: 3, modAt: 99999999999999 }; row.version++;
a.$('joinBtn').click(); a.$('okBtn').click();
Object.defineProperty(a.d, 'hidden', { value: true, configurable: true });
a.d.dispatchEvent(new a.w.Event('visibilitychange'));
await until(() => JSON.parse(a.w.localStorage.getItem('leemos-v1')).total >= 40, 3000);
const afterHide = JSON.parse(a.w.localStorage.getItem('leemos-v1'));
check("triggers: hiding the page syncs, and the answer plus the other device's progress are both kept", afterHide.total >= 40 && afterHide.stickers === 3 && supa.rows.get(RID_A).data.stats['s:ma'].ok >= 1, JSON.stringify({ t: afterHide.total, s: afterHide.stickers }));
const writes = () => supa.log.filter((l) => l.startsWith('PATCH') || l.startsWith('POST /rest')).length;
const w0 = writes();
await sleep(200);
check('triggers: data that came from the server does not start another round of writes', writes() === w0, String(w0));
const before = supa.log.length;
a = await boot({ supa, syncConfig: CFG, storage: { 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader' }] } } });
await sleep(60);
check('triggers: a signed-out app makes no request to Supabase at start', supa.log.length === before && a.errors.length === 0, supa.log.slice(before).join(' | '));
```

- [ ] **Step 2: Run**

Run: `node tests/smoke.mjs 2>&1 | grep -E "triggers|FAILED"`
Expected: PASS. A real failure here means a bug in the Task 6 glue (fix `src/app.js`, not the test); common causes: the `visibilitychange` listener registered on `document` before `document.hidden` is overridden (the listener reads `document.hidden` at call time, so it is fine), or `syncAll` returning early because `syncBusy` is still true from the start-up sync (wait for it with `until`).

- [ ] **Step 3: Documentation**

`CLAUDE.md`:
- In the architecture block add: `src/merge.js` (pure merge of the synced state), `src/sync.js` (Supabase client, plain fetch), `src/data/sync.config.json` (empty = feature off), `supabase/migrations/` (table + RLS), `scripts/check-rls.mjs`, `tests/merge.mjs`, `tests/sync.mjs`, `tests/migration.mjs`, `tests/lib/fake-supabase.mjs`.
- In "Persistencia": `leemos-profiles` entries may have `rid` (uuid of the account profile); `leemos-auth` (session), `leemos-auth-user` (last user id), `leemos-sync-at`; state gains `resets {es,ca}` and `modAt`; synced fields and merge rules (counters take the highest, `level`/`name` by `modAt`, a reset wins over older devices); device settings are never synced.
- Replace the sentence "No hay servidor, cuentas ni analítica..." with: "Cuentas **opcionales** con Supabase (solo adultos; el niño nunca inicia sesión): solo se sincronizan apodo, contadores, pegatinas y grupos de Leo. Sigue sin haber analítica ni seguimiento, y sin config (`sync.config.json` vacío) no hay ninguna petición a terceros."
- In "Pendientes", item 7 becomes: "Sincronizar perfil entre dispositivos: **hecho** (subproyecto 1). Faltan el subproyecto 2 (política de privacidad, consentimiento, exportar y borrar la cuenta; **imprescindible antes de abrirlo a otras familias**) y el 3 (hosting https, proveedor de email, límites)."

`README.md` — add a section "Cuentas y sincronización (opcional)" with the setup steps for Fran:
1. Create a Supabase project in an EU region.
2. Run `supabase/migrations/20261017000000_child_profiles.sql` in the SQL editor.
3. Authentication → Providers → Email: enable it, and edit the "Magic Link" and "Confirm signup" email templates to show `{{ .Token }}` (the 6-digit code) instead of a link.
4. Put the Project URL and the `anon` key in `src/data/sync.config.json` (the anon key is public by design; never the service key).
5. Add `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` to `.env` and run `node scripts/check-rls.mjs`; every line must PASS.
6. Supabase's built-in email sender is limited to a few emails per hour: for real use set up custom SMTP (Authentication → SMTP Settings).

- [ ] **Step 4: Full verification**

```bash
npm test 2>&1 | grep -E "FAIL|FAILED"; echo "(no lines above = no failures)"
npm test 2>&1 | grep -cE "passed"
npm run audio:plan 2>&1 | grep "Por generar"
git status --short
```
Expected: no `FAIL` lines; at least 11 `passed` lines (the 8 old suites plus merge, migration and sync); `Por generar: 0`; only the planned files modified before the commit below.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs+test(sync): sync trigger tests, CLAUDE.md and README for accounts

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS"
```

- [ ] **Step 6: Tell Fran what is left for them** (short, no verbosity): the feature is off until they fill `src/data/sync.config.json` (README steps 1-5); they run `node scripts/check-rls.mjs` once; real use needs a custom email sender and https hosting (sub-project 3); sub-project 2 (privacy policy, consent review, export and delete) is mandatory before other families use it; the account block was tested only against a fake server, so the first real sign-in on a tablet is the real test.

---

## Self-Review

**Spec coverage**
- Section 1 data model, RLS, limits, size cap, synced fields and merge rules incl. reset epochs: Tasks 1, 2, 5.
- Section 2 authentication (otp, verify, refresh, sign out, consent checkbox, config gate): Tasks 3, 6.
- Section 3 protocol (pull-merge-push, versions, triggers, 409, missing row, fingerprint `modAt`, service worker, SHELL): Tasks 4, 5, 6, 8.
- Section 4 linking (empty account, ask, auto-add, different account, cancel): Task 7.
- Section 5 UI and i18n parity, nickname guidance: Tasks 6, 7.
- Section 6 security notes: setup steps in README (Task 8); no code needed.
- Section 7 testing: `merge`, `sync`, `migration`, smoke sections, `check-rls.mjs` (run by Fran).
- Section 8 failure modes: version conflict (T4), long offline (T4/T8), revoked refresh (T3/T4), malformed remote (T1/T4), wrong code or email (T6), network drop and cancel while linking (T7).
- Section 9 prerequisites: README steps (Task 8).

**Placeholder scan:** Task 6 Step 1 tells the executor to read the live mock `fetch` in `tests/smoke.mjs` before extending it, and Step 2 says to read `tests/sw.mjs` before adding its test; those two files' exact text is not reproduced here. Task 5 says to confirm element ids with a `grep`. Everything else shows its code.

**Type consistency:** `createSync` returns `{requestCode, verifyCode, session, signOut, userId, listProfiles, syncProfile}` (Task 4 final return) and the app uses exactly those. `mergeData`/`sameData`/`pickSynced`/`applySynced` names match between Tasks 1, 4 and 6. Storage keys `leemos-auth`, `leemos-auth-user`, `leemos-sync-at` are the same in every task. The profile `rid` regex accepts the uuids used in tests (`11111111-1111-4111-8111-111111111111`, `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`).

**Known risks the plan cannot remove:** the auth and REST endpoint names and response shapes were written from knowledge of Supabase and a fake server that mirrors them; only a real project proves them (the first real sign-in and `check-rls.mjs`). jsdom's `crypto.randomUUID`, the `toggle` event and `document.hidden` overriding may need small test adjustments.
