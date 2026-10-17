# Sticker Sets per World Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each of the 16 worlds has its own set of 6 stickers; a finished session drops a sticker into the set of the world being played; the world picker and the album show the progress.

**Architecture:** `worlds.json` gains `stk` (6 emoji per world). Saved state gains `S.stk = {worldId: n}` (the first `n` of the set are owned); `S.stickers` stays as the total. `src/merge.js` migrates the old counter (`stkOf`) and merges `stk` per world by maximum. One `earnSticker()` in `src/app.js` replaces the two copies (reader and Leo's `sounds.js`).

**Tech Stack:** vanilla JS ES modules, no bundler; jsdom smoke tests (`tests/*.mjs`, run with `npm test`).

**Spec:** `docs/superpowers/specs/2026-10-17-world-stickers-design.md` (read it first).

## Global Constraints

- No framework, no bundler. `src/app.js` has no `import` statements (the smoke test evaluates it as text); `merge.js` and `sync.js` are loaded with `import()` only when sync is configured, so **app.js cannot call merge.js**: the migration exists twice (merge.js and app.js) and tests prove they agree.
- Every UI text: key in `src/data/i18n.es.json` **and** `src/data/i18n.ca.json` (same keys; `npm test` checks).
- `S.stickers` must always equal the sum of `min(S.stk[id], set length)` over the existing worlds.
- The migration must run **before** `lastFp=fpOf()` in `app.js`, so loading an old state never stamps `modAt` (that stamp decides `level` and `name` in the sync).
- `PREF_KEYS` is duplicated in `merge.js` and `app.js`; do not touch it.
- If you change the `SHELL` list in `sw.js`, bump `VERSION` (this plan does not change it).
- Code comments in English, `CLAUDE.md` in Spanish. Commit messages end with the two attribution lines given by the harness (`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and the `Claude-Session:` URL).
- Do not touch `src/data/sync.config.json`.

## Review Focus

- A state with a counter that is huge, negative, fractional, `NaN` or above 24 (old saves, hostile server data): clamped, never crashes, `S.stickers` consistent (Task 2 merge tests; Task 3 boot test with `stk: {bosque: 500}`).
- A device on the old version pushes only `stickers` while another device already has `stk`: no sticker lost on either side (Task 2 merge test; Task 3 pull test).
- `S.world` out of range (a world list that changed): the sticker goes to the clamped current world (Task 3 test with `world: 99`).
- Every set complete: no reward, no crash, counters stay at 96 (Task 3 test).
- The reward and the album while a set is complete and the sticker comes from another world: the child sees where it went (Task 4 tests).

---

### Task 1: Sticker sets in `worlds.json` and the data test

**Files:**
- Modify: `src/data/worlds.json` (one `"stk"` array added to each of the 16 lines)
- Create: `tests/stickers.mjs`
- Modify: `package.json` (add the new test to the `test` script)

**Interfaces:**
- Produces: `worlds.json[i].stk`: array of 6 unique emoji strings. The 24 old animals (`src/data/stickers.json`, unchanged) appear first in their world's set, in their old relative order. World order stays as in the file (bosque, playa, nubes, montana, espacio, mar, granja, selva, desierto, nieve, castillo, circo, dino, jardin, musica, ciudad).

- [ ] **Step 1: Write the failing test** — create `tests/stickers.mjs`:

```js
// Tests for the sticker sets per world (data only). Spec: docs/superpowers/specs/2026-10-17-world-stickers-design.md.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };

const WORLDS = readJSON('src/data/worlds.json');
const OLD = readJSON('src/data/stickers.json');
const all = WORLDS.flatMap((w) => w.stk || []);

check('stickers: 16 worlds, each with exactly 6 stickers', WORLDS.length === 16 && WORLDS.every((w) => Array.isArray(w.stk) && w.stk.length === 6));
check('stickers: no emoji is repeated inside or across worlds (96 different)', all.length === 96 && new Set(all).size === 96 && all.every((e) => typeof e === 'string' && e.length > 0));
check('stickers: the 24 old animals all belong to some world', OLD.length === 24 && OLD.every((e) => all.includes(e)));
let prefix = true;
for (const w of WORLDS) { const old = OLD.filter((e) => (w.stk || []).includes(e)); if (!w.stk || w.stk.slice(0, old.length).join() !== old.join()) prefix = false; }
check('stickers: in each world the old animals come first, in their old order (owned ones are always a prefix)', prefix);
check('stickers: world ids are what the merge accepts (/^[a-z]{2,20}$/)', WORLDS.every((w) => /^[a-z]{2,20}$/.test(w.id)));

console.log(failures ? `\n${failures} sticker test(s) FAILED` : '\nAll sticker tests passed');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run it to see it fail**

Run: `node tests/stickers.mjs`
Expected: FAIL on the first four checks (no `stk` yet), exit code 1.

- [ ] **Step 3: Add the sets** — run this once from the repo root (it edits `worlds.json` line by line and keeps its format):

```bash
node -e '
const fs=require("fs");
const SETS={
 bosque:["🦊","🦉","🐨","🦌","🦔","🍄"],
 playa:["🐢","🦀","🐚","🦞","🦭","🏄"],
 nubes:["🌈","🪁","🎈","🕊️","🦢","🌙"],
 montana:["🐼","🐐","🦅","🦙","🐻","🧗"],
 espacio:["🚀","🛸","👽","🪐","🌠","🌍"],
 mar:["🐙","🐬","🐳","🐠","🦈","🐡"],
 granja:["🐰","🐶","🐖","🐔","🐑","🐴"],
 selva:["🦁","🦒","🦜","🐘","🐒","🐅"],
 desierto:["🐪","🦂","🦎","🐍","🦗","🌞"],
 nieve:["🐧","🧊","🥶","🛷","🎿","🐺"],
 castillo:["🦄","👑","🐉","👸","🤴","🧙"],
 circo:["🤡","🤹","🎠","🎡","🎩","🥁"],
 dino:["🦖","🦕","🥚","🦴","🌋","🐊"],
 jardin:["🦋","🐸","🐝","🐞","🐌","🌻"],
 musica:["🎸","🎹","🎺","🎻","🎷","🎤"],
 ciudad:["🐱","🚌","🚲","🚒","🚕","🚦"]};
const f="src/data/worlds.json";
const out=fs.readFileSync(f,"utf8").split("\n").map(l=>{
  const m=l.match(/"id":"([a-z]+)"/); if(!m) return l;
  if(!SETS[m[1]]) throw new Error("no set for "+m[1]);
  return l.replace(/\}(,?)\s*$/, ",\"stk\":"+JSON.stringify(SETS[m[1]])+"}$1");
}).join("\n");
JSON.parse(out); fs.writeFileSync(f,out); console.log("ok");'
```

- [ ] **Step 4: Run the test to see it pass**

Run: `node tests/stickers.mjs`
Expected: 5 PASS, `All sticker tests passed`.

- [ ] **Step 5: Add the test to `npm test`** — in `package.json`, append ` && node tests/stickers.mjs` to the end of the `"test"` script (after `node tests/sync.mjs`). Run `npm test`; expected: every suite passes (nothing reads `stk` yet).

- [ ] **Step 6: Commit**

```bash
git add src/data/worlds.json tests/stickers.mjs package.json
git commit -m "feat(stickers): a set of 6 stickers per world (data and data test)"
```

---

### Task 2: Merge — migration from the old counter and per-world maximum

**Files:**
- Modify: `src/merge.js` (add `LEGACY_WORLD`, `stkOf`; `mergeData` and `applySynced` use them)
- Modify: `tests/merge.mjs`

**Interfaces:**
- Consumes: Task 1's `worlds.json` and the unchanged `stickers.json` (only in the agreement test).
- Produces (exports from `src/merge.js`): `LEGACY_WORLD` (array of 24 world ids in the old sticker order); `stkOf(d)` returns `{worldId: n}` (only n>0, n ≤ 24, ids matching `/^[a-z]{2,20}$/`, at most 32 keys; from `d.stk` when it is a plain object, otherwise migrated from `d.stickers`). `mergeData` result gains `stk` and `stickers` = sum of `stk`. `applySynced` writes `state.stk` and `state.stickers`.

- [ ] **Step 1: Write the failing tests** — in `tests/merge.mjs` change the import line to
`import { mergeData, sameData, pickSynced, applySynced, PREF_KEYS, stkOf, LEGACY_WORLD } from '../src/merge.js';`
then add this block **above** the final `console.log(failures ? ...` line (`rnd`, `ri`, `same`, `check` already exist in the file above it):

```js
// ---------- stickers per world (spec: 2026-10-17-world-stickers-design.md) ----------
import { readFileSync } from 'node:fs';
const WORLDS = JSON.parse(readFileSync(new URL('../src/data/worlds.json', import.meta.url), 'utf8'));
const OLD_STK = JSON.parse(readFileSync(new URL('../src/data/stickers.json', import.meta.url), 'utf8'));
const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);
check('stk: LEGACY_WORLD agrees with stickers.json and worlds.json', LEGACY_WORLD.length === 24 && OLD_STK.every((e, i) => WORLDS.find((w) => w.stk.includes(e)).id === LEGACY_WORLD[i]));
check('stk: an empty or missing counter owns nothing', same(stkOf({}), {}) && same(stkOf({ stickers: 0 }), {}) && same(stkOf(null), {}));
check('stk: 7 old stickers land in their worlds', same(stkOf({ stickers: 7 }), { bosque: 1, montana: 1, castillo: 1, mar: 2, jardin: 1, ciudad: 1 }));
check('stk: all 24 old stickers are placed, none lost', total(stkOf({ stickers: 24 })) === 24 && stkOf({ stickers: 24 }).selva === 4 && stkOf({ stickers: 24 }).jardin === 4);
check('stk: more than 24, negative, fractional, NaN, Infinity and strings are clamped to a valid count',
  total(stkOf({ stickers: 99 })) === 24 && same(stkOf({ stickers: -3 }), {}) && same(stkOf({ stickers: NaN }), {}) && same(stkOf({ stickers: Infinity }), {}) && same(stkOf({ stickers: '5' }), {}) && total(stkOf({ stickers: 2.9 })) === 2);
check('stk: when stk is present the old counter is ignored', same(stkOf({ stickers: 9, stk: { circo: 2 } }), { circo: 2 }));
const hostile = JSON.parse('{"stk":{"circo":1e300,"BAD":2,"x":1,"__proto__":{"a":1},"constructor":3,"dino":-2,"mar":1.9,"musica":"x"}}');
check('stk: hostile stk entries are dropped or capped', same(stkOf(hostile), { circo: 24, mar: 1 }), JSON.stringify(stkOf(hostile)));
check('stk: an array or a string is not a stk (falls back to the counter)', same(stkOf({ stk: [1, 2], stickers: 1 }), { bosque: 1 }) && same(stkOf({ stk: 'x', stickers: 1 }), { bosque: 1 }));
check('stk: at most 32 keys are read', Object.keys(stkOf({ stk: Object.fromEntries(Array.from({ length: 50 }, (_, i) => ['w' + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26)), 1])) })).length <= 32);
const mkd = (stk, stickers) => ({ stats: {}, total: 0, stickers, stk, pre: { es: 0, ca: 0 }, resets: { es: 0, ca: 0 }, level: 0, name: 'Elsa', modAt: 1 });
const mS = mergeData(mkd({ circo: 2, mar: 1 }, 3), mkd({ circo: 1, dino: 4 }, 5));
check('stk: merge takes the maximum per world and the total is their sum', same(mS.stk, { circo: 2, mar: 1, dino: 4 }) && mS.stickers === 7, JSON.stringify([mS.stk, mS.stickers]));
const mL = mergeData(mkd({ circo: 2 }, 2), { stats: {}, stickers: 3 }); // the other device is on the old version: only the counter
check('stk: a device with only the old counter loses nothing and takes nothing away', same(mL.stk, { bosque: 1, montana: 1, castillo: 1, circo: 2 }) && mL.stickers === 5, JSON.stringify(mL.stk));
check('stk: applySynced and pickSynced carry stk and keep stickers equal to its sum', (() => { const st = applySynced({ stats: {}, stickers: 0 }, mkd({ mar: 2, granja: 1 }, 99)); return same(st.stk, { mar: 2, granja: 1 }) && st.stickers === 3 && same(pickSynced(st).stk, { mar: 2, granja: 1 }); })());
let kc = true, ka = true, ki = true, kmono = true;
const genK = () => { const o = {}; ['bosque', 'mar', 'circo', 'dino'].forEach((w) => { if (rnd() < 0.6) o[w] = ri(7); }); return rnd() < 0.4 ? { stats: {}, stickers: ri(26) } : { stats: {}, stk: o }; };
for (let i = 0; i < 300; i++) {
  const x = genK(), y = genK(), z = genK();
  if (!same(mergeData(x, y), mergeData(y, x))) kc = false;
  if (!same(mergeData(mergeData(x, y), z), mergeData(x, mergeData(y, z)))) ka = false;
  if (!same(mergeData(x, x), mergeData(x, {}))) ki = false;
  if (mergeData(x, y).stickers < Math.max(total(stkOf(x)), total(stkOf(y)))) kmono = false;
}
check('property: stk merge is commutative, associative, idempotent and never loses stickers (300 random, old and new states mixed)', kc && ka && ki && kmono, JSON.stringify([kc, ka, ki, kmono]));
```

- [ ] **Step 2: Run to see it fail**

Run: `node tests/merge.mjs`
Expected: the module fails to load (`stkOf` / `LEGACY_WORLD` are not exported yet) — the suite cannot run. That is the RED.

- [ ] **Step 3: Implement** — in `src/merge.js`, after the line `const nm = (x) => ...` add:

```js
// ---------- stickers per world (spec: 2026-10-17-world-stickers-design.md) ----------
// The 24 stickers that existed before the per-world sets, in their old order, and the world each one moved to. merge.js cannot
// read the data files, so tests/merge.mjs checks this list against stickers.json and worlds.json.
export const LEGACY_WORLD = ['bosque', 'montana', 'castillo', 'mar', 'jardin', 'mar', 'ciudad', 'playa', 'bosque', 'granja', 'jardin', 'selva', 'nieve', 'jardin', 'selva', 'jardin', 'mar', 'bosque', 'selva', 'granja', 'playa', 'selva', 'nubes', 'espacio'];
const WORLD_ID = /^[a-z]{2,20}$/;
const CAP_STK = 24; // the app clamps to the real size of each set when it shows them
// How many stickers of each world's set a saved state owns (the first n of the set). A state from before the sets, or from a
// device that is not updated yet, has only the old counter: its stickers are the first ones of the old order.
export function stkOf(d) {
  const out = {};
  if (d && isObj(d.stk)) {
    for (const k of Object.keys(d.stk).slice(0, 32)) {
      if (unsafe(k) || !WORLD_ID.test(k)) continue;
      const n = Math.min(CAP_STK, num(d.stk[k]));
      if (n) out[k] = n;
    }
    return out;
  }
  const n = Math.min(LEGACY_WORLD.length, num(d && d.stickers));
  for (let i = 0; i < n; i++) out[LEGACY_WORLD[i]] = (out[LEGACY_WORLD[i]] || 0) + 1;
  return out;
}
const stkSum = (o) => Object.values(o).reduce((s, n) => s + n, 0);
```

In `mergeData`, just before the `return {` line add:

```js
  const ka = stkOf(a), kb = stkOf(b), stk = {};
  for (const id of new Set([...Object.keys(ka), ...Object.keys(kb)])) stk[id] = Math.max(ka[id] || 0, kb[id] || 0);
```

and replace the line `    stickers: Math.max(num(a.stickers), num(b.stickers)),` with:

```js
    stk,
    stickers: stkSum(stk),
```

In `applySynced`, replace `  state.stickers = d.stickers;` with:

```js
  state.stk = d.stk;
  state.stickers = d.stickers;
```

- [ ] **Step 4: Run to see it pass**

Run: `node tests/merge.mjs`
Expected: all PASS including the new `stk:` checks. Old checks about `stickers` keep their meaning (`huge.stickers === 0` for `Infinity` still holds). Never weaken a test to pass: fix the code, or if an expectation is genuinely obsolete record a `Ruling:` in the ledger.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all suites pass. A failure in `tests/sync.mjs` or `tests/smoke.mjs` that compares pushed data with an exact object means the data now also carries `stk`: update that expectation to include it (ledger a `Ruling:`).

- [ ] **Step 6: Commit**

```bash
git add src/merge.js tests/merge.mjs
git commit -m "feat(stickers): merge per-world sticker counts and migrate the old counter"
```

---

### Task 3: The app — state, migration and earning, one function for reader and Leo

**Files:**
- Modify: `src/app.js` (migration before `fpOf`; `fpOf`; `earnSticker`; `record()`; the `createSounds` context)
- Modify: `src/sounds.js` (line ~152)
- Modify: `tests/smoke.mjs` (new section appended before the final `console.log(failures ? ...`)

**Interfaces:**
- Consumes: Task 1's `WORLDS[i].stk`; Task 2's behavior (mirrored here, not imported).
- Produces in `app.js`: `S.stk`; `stkTotal()` (sum over existing worlds of `min(S.stk[id]||0, set length)`); `earnSticker()` returns the emoji or `null` and sets the module variable `rewardFrom` (`''`, or `'<icon> <world name>'` when the sticker came from a world other than the one being played). `sounds.js` ctx has `earnSticker` instead of `stickers`.

- [ ] **Step 1: Write the failing tests** — append to `tests/smoke.mjs`, above the final `console.log(failures ? ...`:

```js
// ---------- 33. sticker sets per world ----------
{
  const st = (app, key = 'leemos-v1') => JSON.parse(app.w.localStorage.getItem(key));
  const WSTK = (id) => worlds.find((w) => w.id === id).stk;
  const full = (ids) => Object.fromEntries(ids.map((id) => [id, 6]));
  let x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', stickers: 7, world: 0, sessionLen: 5 } } });
  check('world stickers: an old counter of 7 still shows 7 after the migration', x.$('albumCount').textContent === '7');
  x.$('joinBtn').click(); await sleep(0); x.$('okBtn').click(); await sleep(5);
  let s = st(x);
  check('world stickers: the 7 old stickers land in their worlds', JSON.stringify(s.stk) === JSON.stringify({ bosque: 1, montana: 1, castillo: 1, mar: 2, jardin: 1, ciudad: 1 }) && s.stickers === 7, JSON.stringify(s.stk));
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', stickers: 7, modAt: 55, total: 3 } } });
  x.$('themeBtn').click(); await sleep(5); // a save() that is not a progress change
  check('world stickers: loading an old state does not stamp modAt (it decides level and name in the sync)', st(x).modAt === 55, String(st(x).modAt));
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', world: 0, sessionLen: 5 } } });
  await playSession(x, 5);
  s = st(x);
  check('world stickers: finishing a session adds a sticker to the world being played', s.stk.bosque === 1 && s.stickers === 1 && x.$('rewardEmoji').textContent === WSTK('bosque')[0], JSON.stringify(s.stk));
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', world: 3, sessionLen: 5 } } });
  await playSession(x, 5);
  check('world stickers: another world gets its own first sticker', st(x).stk.montana === 1 && x.$('rewardEmoji').textContent === WSTK('montana')[0]);
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', sessionLen: 5 } } });
  await playSession(x, 5);
  s = st(x);
  check('world stickers: with Sorpresa exactly one world gets the sticker', Object.keys(s.stk).length === 1 && Object.values(s.stk)[0] === 1 && s.stickers === 1, JSON.stringify(s.stk));
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', world: 99, sessionLen: 5 } } });
  await playSession(x, 5);
  check('world stickers: a world number out of range uses the last world', st(x).stk.ciudad === 1 && x.$('rewardEmoji').textContent === WSTK('ciudad')[0]);
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', world: 0, sessionLen: 5, stk: full(['bosque']), stickers: 6 } } });
  await playSession(x, 5);
  s = st(x);
  check('world stickers: a complete set passes the sticker to the first incomplete world', s.stk.bosque === 6 && s.stk.playa === 1 && s.stickers === 7 && x.$('rewardEmoji').textContent === WSTK('playa')[0], JSON.stringify(s.stk));
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', world: 0, sessionLen: 5, stk: full(worlds.map((w) => w.id)), stickers: 96 } } });
  await playSession(x, 5);
  s = st(x);
  check('world stickers: with every set complete no sticker drops and nothing breaks', x.$('reward').hidden && s.stickers === 96 && Object.values(s.stk).every((n) => n === 6) && x.errors.length === 0, x.errors.join(' | '));
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', stk: { bosque: 500 }, stickers: 500 } } });
  check('world stickers: a hostile count is clamped to the size of the set', x.$('albumCount').textContent === '6' && x.errors.length === 0, x.$('albumCount').textContent);
  // Leo goes through the same function
  x = await bootLeo({ storage: { ...LEO, 'leemos-v1:leo': { name: 'Leo', world: 0 } } });
  x.$('prePlay').click(); await playPre(x, 5); await sleep(10);
  s = st(x, 'leemos-v1:leo');
  check('world stickers: Leo earns his sticker in the world being played too', s.stk && s.stk.bosque === 1 && x.$('albumCount').textContent === '1', JSON.stringify(s.stk));
  // another device pushes per-world stickers: they arrive in the counter without a reload
  const { s: supa, app } = await signedBoot({ syncEvery: 120 });
  const r = supa.rows.get(RID_A); r.data = { ...r.data, stk: { circo: 2 }, stickers: 2 }; r.version++;
  await until(() => (JSON.parse(app.w.localStorage.getItem('leemos-v1')).stk || {}).circo === 2, 3000);
  await sleep(40);
  check('world stickers: per-world stickers from another device arrive without a reload', st(app).stickers === 2 && app.$('albumCount').textContent === '2', app.$('albumCount').textContent);
}
```

- [ ] **Step 2: Run to see it fail**

Run: `node tests/smoke.mjs 2>&1 | grep -E "FAIL|world stickers" | head -30`
Expected: the `world stickers` checks FAIL (no `stk` in the saved state; `S.stk` undefined).

- [ ] **Step 3: Implement in `src/app.js`**

(a) Between the `const S=Object.assign(...)` line and the `const fpOf=` line, insert:

```js
// Stickers are collected per world (spec: 2026-10-17-world-stickers-design.md): S.stk = {worldId: n} owns the first n of that world's set.
// An old save has only the counter S.stickers: its stickers are the first ones of the old order, each in its world's set.
// Runs before lastFp is taken, so loading an old state is not a progress change (modAt decides level and name in the sync).
const stkTotal=()=>WORLDS.reduce((n,w)=>n+Math.min(Math.max(0,Math.floor(Number(S.stk[w.id]))||0),w.stk.length),0);
if(!S.stk||typeof S.stk!=='object'||Array.isArray(S.stk)){
  const stk={};
  for(let i=0;i<Math.min(Math.max(0,Math.floor(Number(S.stickers))||0),STICKERS.length);i++){
    const w=WORLDS.find(x=>x.stk.includes(STICKERS[i]));
    if(w)stk[w.id]=(stk[w.id]||0)+1;
  }
  S.stk=stk;
}
S.stickers=stkTotal();
```

(b) Change the `fpOf` line to include the per-world counts:

```js
const fpOf=()=>JSON.stringify([S.stats,S.total,S.stickers,S.stk,S.pre,S.resets,S.level,S.name]);
```

(c) Just above `function record(ok){` add:

```js
// A sticker goes to the set of the world being played; a complete set passes it to the first incomplete world (none when all are done).
let rewardFrom=''; // '<icon> <name>' of the world the last sticker came from when it was not the one being played
function earnSticker(){
  const playing=WORLDS[worldNow()];
  const room=w=>(Math.floor(Number(S.stk[w.id]))||0)<w.stk.length;
  const w=room(playing)?playing:WORLDS.find(room);
  if(!w)return null;
  const n=Math.min(Math.max(0,Math.floor(Number(S.stk[w.id]))||0),w.stk.length)+1;
  S.stk[w.id]=n;S.stickers=stkTotal();
  rewardFrom=w===playing?'':w.icon+' '+wn(w);
  return w.stk[n-1];
}
```

(d) In `record()` replace
`  if(finished&&S.stickers<STICKERS.length){S.stickers++;reward=STICKERS[S.stickers-1];sStk++}`
with
`  if(finished){reward=earnSticker();if(reward)sStk++}`

(e) In the `pre=mod.createSounds({...})` call replace `stickers:STICKERS,` with `earnSticker,`.

`STICKERS` stays only for the migration. `WORLDS` is loaded at the top (top-level await) and `worldNow` is a function declaration/const defined before any call to `earnSticker`, so ordering is safe.

**In `src/sounds.js`** replace
`    if(finished&&S.stickers<ctx.stickers.length){S.stickers++;reward=ctx.stickers[S.stickers-1];ctx.sess.addSticker()}`
with
`    if(finished){reward=ctx.earnSticker();if(reward)ctx.sess.addSticker()}`

- [ ] **Step 4: Run to see it pass**

Run: `node tests/smoke.mjs 2>&1 | grep -E "FAIL|world stickers"`
Expected: every `world stickers` line PASS, no FAIL. If a click is swallowed (a second click needs `await sleep(5)`), fix the test pacing, not the code.

- [ ] **Step 5: Run the whole suite**

Run: `npm test 2>&1 | grep -E "FAIL|passed|FAILED"`
Expected: every suite passes. Check in particular the `sounds:` tests (Leo's end screen and sticker, `albumCount` still `1`) and the `pull: stickers earned on another device` test (the old counter 3 still shows `3`).

- [ ] **Step 6: Commit**

```bash
git add src/app.js src/sounds.js tests/smoke.mjs
git commit -m "feat(stickers): earn into the set of the world being played, one function for reader and Leo"
```

---

### Task 4: What she sees — picker badges, grouped album, reward origin — and the docs

**Files:**
- Modify: `src/app.js` (`renderWorlds`, `renderAlbum`, `showReward`)
- Modify: `index.html` (a line under `#rewardEmoji`)
- Modify: `src/styles.css`
- Modify: `src/data/i18n.es.json`, `src/data/i18n.ca.json`
- Modify: `tests/smoke.mjs` (new section)
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: Task 3's `S.stk`, `stkTotal()`, `rewardFrom`, `wn(w)`.
- Produces: i18n keys `worldProg`, `rewardFrom`; changed `albumInfo`.

- [ ] **Step 1: Write the failing tests** — append to `tests/smoke.mjs` above the final `console.log(failures ? ...`:

```js
// ---------- 34. sticker sets per world: what she sees ----------
{
  const own = (stk, n) => ({ 'leemos-v1': { name: 'Elsa', world: 0, sessionLen: 5, stk, stickers: n } });
  let x = await boot({ storage: own({ bosque: 2 }, 2) });
  x.$('worldBtn').click();
  const btns = [...x.d.querySelectorAll('#worldGrid .wbtn')];
  check('world sets: each world tile shows its progress and Sorpresa the total', btns.length === 17 && /2\/6/.test(btns[1].textContent) && /0\/6/.test(btns[2].textContent) && /2\/96/.test(btns[0].textContent), btns.slice(0, 3).map((b) => b.textContent).join(' | '));
  check('world sets: every tile stays selectable (nothing is locked)', btns.every((b) => !b.disabled));
  x = await boot({ storage: own({ bosque: 6 }, 6) });
  x.$('worldBtn').click();
  check('world sets: a complete set is marked with a tick', /6\/6 ✓/.test(x.d.querySelectorAll('#worldGrid .wbtn')[1].textContent));
  x = await boot({ storage: own({ bosque: 2, mar: 1 }, 3) });
  x.$('albumBtn').click();
  const sets = x.d.querySelectorAll('#stickerGrid .sset');
  check('album: grouped by world, 6 slots each, owned ones are not dimmed', sets.length === 16 && x.d.querySelectorAll('#stickerGrid .sticker').length === 96 && x.d.querySelectorAll('#stickerGrid .sticker:not(.locked)').length === 3);
  check('album: each group has a heading with its world and count', /Bosque.*2\/6/.test(x.d.querySelectorAll('#stickerGrid .sset-h')[0].textContent) && /3 de 96/.test(x.$('albumInfo').textContent), x.$('albumInfo').textContent);
  x = await boot({ storage: own({ bosque: 6 }, 6) });
  await playSession(x, 5);
  check('reward: when the sticker comes from another world, the screen says which', !x.$('rewardFrom').hidden && /Playa/.test(x.$('rewardFrom').textContent), x.$('rewardFrom').textContent);
  x = await boot({ storage: own({}, 0) });
  await playSession(x, 5);
  check('reward: a sticker from the world being played shows no origin line', x.$('rewardFrom').hidden);
  x = await boot({ lang: 'ca-ES', storage: own({ bosque: 6 }, 6) });
  await playSession(x, 5);
  check('reward: the origin line is in Catalan too', /Platja/.test(x.$('rewardFrom').textContent), x.$('rewardFrom').textContent);
}
```

- [ ] **Step 2: Run to see it fail**

Run: `node tests/smoke.mjs 2>&1 | grep -E "FAIL" | head`
Expected: the new `world sets:`, `album:` and `reward:` checks FAIL.

- [ ] **Step 3: Implement**

`index.html`: right after `<div class="big" id="rewardEmoji"></div>` add
`    <p class="small" id="rewardFrom" hidden></p>`

`src/data/i18n.es.json` — replace the `albumInfo` value and add two keys (keep valid JSON, commas between entries):
```
  "albumInfo": "{s} de {t} pegatinas y {x} estrellas. Ganas una pegatina al completar una sesión; va al mundo en el que juegas.",
  "worldProg": "{n} de {t} pegatinas",
  "rewardFrom": "Del mundo {w}",
```
`src/data/i18n.ca.json`:
```
  "albumInfo": "{s} de {t} enganxines i {x} estrelles. Guanyes una enganxina en completar una sessió; va al món on jugues.",
  "worldProg": "{n} de {t} enganxines",
  "rewardFrom": "Del món {w}",
```

`src/app.js`:

(a) Replace `renderWorlds` entirely with:

```js
function renderWorlds(){
  const g=$('worldGrid');g.innerHTML='';
  const have=w=>Math.min(Math.max(0,Math.floor(Number(S.stk[w.id]))||0),w.stk.length);
  const mk=(val,icon,label,w)=>{
    const b=document.createElement('button');b.className='wbtn';b.setAttribute('aria-pressed',S.world===val);
    if(w)b.style.background='linear-gradient(165deg,color-mix(in srgb,'+w.a+' 55%,var(--panel)),color-mix(in srgb,'+w.b+' 40%,var(--panel)))';
    const n=w?have(w):stkTotal(),of=w?w.stk.length:WORLDS.reduce((s,x)=>s+x.stk.length,0);
    b.innerHTML='<span>'+icon+'</span>'+label+'<small class="wk">'+n+'/'+of+(n===of?' ✓':'')+'</small>';
    b.setAttribute('aria-label',label+', '+t('worldProg',{n:n,t:of}));
    b.onclick=()=>{S.world=val;save();renderWorlds();applyWorld();$('worlds').hidden=true};
    g.appendChild(b);
  };
  mk('auto','🎲',t('worldAuto'),null);
  WORLDS.forEach((w,i)=>mk(i,w.icon,wn(w),w));
}
```

(b) Replace `renderAlbum` entirely with:

```js
function renderAlbum(){
  $('albumCount').textContent=S.stickers;
  const g=$('stickerGrid');g.innerHTML='';
  let all=0;
  WORLDS.forEach(w=>{
    const own=Math.min(Math.max(0,Math.floor(Number(S.stk[w.id]))||0),w.stk.length);all+=w.stk.length;
    const h=document.createElement('h3');h.className='sset-h';h.textContent=w.icon+' '+wn(w)+' '+own+'/'+w.stk.length;g.appendChild(h);
    const row=document.createElement('div');row.className='sset';
    w.stk.forEach((e,i)=>{
      const d=document.createElement('div');
      d.className='sticker'+(i<own?'':' locked');
      d.textContent=e;
      d.setAttribute('aria-label',i<own?t('albumGot',{e:e}):t('albumLocked'));
      row.appendChild(d);
    });
    g.appendChild(row);
  });
  $('albumInfo').textContent=t('albumInfo',{s:S.stickers,t:all,x:S.total});
}
```

(c) In `showReward(e)`, after `$('rewardEmoji').textContent=e;` add:
```js
  const rf=$('rewardFrom');rf.hidden=!rewardFrom;rf.textContent=rewardFrom?t('rewardFrom',{w:rewardFrom}):'';
```

`src/styles.css`: replace the rule `.stickers{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0}` with
```css
.stickers{margin:14px 0}
.sset{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin:4px 0 14px}
.sset .sticker{font-size:26px;border-radius:12px}
.sset-h{margin:10px 0 0;font-size:1rem}
#album .sheet{max-height:90vh;overflow:auto}
.wbtn .wk{display:block;font-size:.75rem;font-weight:700;opacity:.8}
```

- [ ] **Step 4: Run to see it pass**

Run: `node tests/smoke.mjs 2>&1 | grep -E "FAIL|world sets|album:|reward:"`
Expected: every new check PASS; no FAIL anywhere. If an older test reads the old `albumInfo` text, update that expectation (ledger a `Ruling:`).

- [ ] **Step 5: Docs** — in `CLAUDE.md` (Spanish):
- Architecture list: replace the `src/data/stickers.json  24 pegatinas (emoji), se ganan cada 8 aciertos` line with `src/data/stickers.json  las 24 pegatinas originales (solo su orden, para migrar guardados antiguos); las pegatinas actuales están en worlds.json (campo stk: 6 por mundo, 96 en total)`; and on the `worlds.json` line add `, stk (6 pegatinas)`.
- Pedagogy: replace "Pegatina cada 8 aciertos." by "Pegatina al terminar cada sesión, del mundo en el que juega (si ese conjunto está completo, del primer mundo incompleto); nada se bloquea."
- Persistence: add that `S.stk {mundo:n}` guarda cuántas pegatinas tiene de cada mundo (las primeras n del conjunto), `S.stickers` es el total, y que se sincroniza como máximo por mundo; un guardado antiguo (solo contador) se migra con `LEGACY_WORLD` (merge.js, y una copia en app.js que deriva el mundo de worlds.json; un test comprueba que coinciden). Add the spec link `docs/superpowers/specs/2026-10-17-world-stickers-design.md`.
- Pending item 6 ("Pegatinas por mundo"): mark as done.

- [ ] **Step 6: Run the whole suite**

Run: `npm test 2>&1 | grep -E "FAIL|passed|FAILED"`
Expected: all suites pass (the i18n parity check in section 7 included).

- [ ] **Step 7: Commit**

```bash
git add index.html src/app.js src/styles.css src/data/i18n.es.json src/data/i18n.ca.json tests/smoke.mjs CLAUDE.md
git commit -m "feat(stickers): world tiles show their set, the album is grouped by world, the reward names its world"
```
