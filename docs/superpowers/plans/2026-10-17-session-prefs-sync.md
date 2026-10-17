# Sync the Session in Progress and the Preferences — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The session in progress (done, correct, stickers earned) and the preferences (mode, world, session length, capitals, language, reading speed, sound, theme) follow the child across devices, with latest-change-wins and no interruption of a device that is being used.

**Architecture:** Two new fields in the already-synced `data`: `session` (one object, one timestamp) and `prefs` (one `{v, at}` per key). The pure merge in `src/merge.js` gains their rules; `src/app.js` gains change detection with separate fingerprints (so none of them touches `modAt`), local persistence of the session, and applying a pull through the UI's own functions with a 30-second idle rule. Nothing changes in `src/sync.js`, the table or the migration: `data` is a JSON document.

**Tech Stack:** Vanilla ES modules, jsdom smoke tests, plain Node test scripts (`PASS`/`FAIL`).

**Spec:** `docs/superpowers/specs/2026-10-17-session-prefs-sync-design.md` (read it first). Builds on `docs/superpowers/specs/2026-10-17-accounts-sync-design.md`.

## Global Constraints

- No bundler, no SDK. `app.js` has **no `import` statements**; `merge.js` stays pure (no globals, **no clock**).
- Not synced, ever: `voiceURI`, `voiceURIs`, recorded clips (IndexedDB). They must never appear in the uploaded `data`.
- The session and each preference have their **own timestamp**; none of them may change `modAt` (it decides `level` and `name`).
- Applying data that came from the server stamps nothing and schedules no sync (set the baselines before saving).
- Whitelist every remote value; anything invalid is dropped, never applied.
- New UI text: none (no new strings). If any is added, both `i18n.es.json` and `i18n.ca.json`.
- If the `SHELL` list in `sw.js` changes, bump `VERSION` (it does not change here).
- Commit trailers: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS`.

## Review Focus

1. **A session or preference change must not revert the level or the name** (separate timestamps): pinned in Tasks 2 and 3.
2. **Hostile or broken remote values** (wrong types, out-of-range, a theme of `'purple'`, negative counters, `at` in the future): dropped by the whitelist, no crash, nothing applied. Pinned in Tasks 1 and 3.
3. **Two devices at once:** a value changed locally in the last 30 s is kept and pushed back; a value idle for longer is replaced. Pinned in Task 3.
4. **A stale (older than 12 h) or finished remote session must not resume** as "4 de 10": it applies as zero. Pinned in Task 3.
5. **Reload mid-session** keeps "4 de 10" locally, a finished or stale one starts from zero. Pinned in Task 2.

## Rulings made while planning (the plan deviates from the spec here)

- **The 12-hour expiry is applied by the app, not by `mergeData`.** The spec said the merge treats an old session as none; that would make the pure merge depend on the clock and break its commutativity guarantee. The merge keeps the session with the larger `at`; `app.js` ignores one older than 12 h when restoring or adopting it. Cost if wrong: none visible.
- **Only explicit changes propagate.** A preference enters `prefs` only after the user changed it on some device (its `at` is stamped then), so a device's defaults (for example the language derived from the browser) never overwrite another device's choice.

## File structure

| File | Responsibility |
|---|---|
| `src/merge.js` (modify) | `session` and `prefs` merge rules, whitelist, `PREF_KEYS`, and `applySynced` writing them (pure). |
| `src/app.js` (modify) | session counters declared early; `S.session`/`S.prefs`; separate change detection in `save()`; restore on load; `renderSession` saves; `storeState` applies a pull with the idle rule. |
| `tests/merge.mjs`, `tests/sync.mjs`, `tests/smoke.mjs` (modify) | New sections. |
| `docs/superpowers/specs/2026-10-17-session-prefs-sync-design.md`, `CLAUDE.md` (modify) | The expiry ruling; persistence and sync notes. |

---

### Task 1: Merge rules for `session` and `prefs`

**Files:**
- Modify: `src/merge.js`
- Modify: `tests/merge.mjs`
- Modify: `docs/superpowers/specs/2026-10-17-session-prefs-sync-design.md` (the expiry ruling)

**Interfaces:**
- Produces: `mergeData(a, b)` now also returns `session: {done, ok, stk, at}` (zeros and `at: 0` when neither side has one) and `prefs: {[key]: {v, at}}` (only valid entries). `PREF_KEYS` exported: `['mode','world','sessionLen','upper','lang','rate','sound','theme']`. `applySynced(state, data)` also sets `state.session`, `state.prefs` and, for each key in `data.prefs`, `state[key] = data.prefs[key].v`.

- [ ] **Step 1: Write the failing tests** — in `tests/merge.mjs`, change the import line to `import { mergeData, sameData, pickSynced, applySynced, PREF_KEYS } from '../src/merge.js';` and add before the final `console.log(...)`:

```js
// ---------- session in progress and preferences (spec: 2026-10-17-session-prefs-sync-design.md) ----------
const sess = (done, ok, stk, at) => ({ done, ok, stk, at });
const pf = (v, at) => ({ v, at });
check('session: the side changed last wins as a whole', same(mergeData({ session: sess(2, 1, 0, 100) }, { session: sess(5, 4, 1, 200) }).session, sess(5, 4, 1, 200)) && same(mergeData({ session: sess(5, 4, 1, 200) }, { session: sess(2, 1, 0, 100) }).session, sess(5, 4, 1, 200)));
check('session: a tie is broken by done, then ok, then stk, whatever the argument order', same(mergeData({ session: sess(3, 1, 0, 100) }, { session: sess(4, 0, 0, 100) }).session, sess(4, 0, 0, 100)) && same(mergeData({ session: sess(4, 0, 0, 100) }, { session: sess(3, 1, 0, 100) }).session, sess(4, 0, 0, 100)) && same(mergeData({ session: sess(4, 2, 0, 100) }, { session: sess(4, 3, 0, 100) }).session, sess(4, 3, 0, 100)));
check('session: with none on either side the result is an empty session with at 0', same(mergeData({}, {}).session, sess(0, 0, 0, 0)));
check('session: a session without a valid timestamp is ignored', same(mergeData({ session: sess(9, 9, 9, 0) }, { session: sess(1, 0, 0, 5) }).session, sess(1, 0, 0, 5)) && same(mergeData({ session: { done: 9, ok: 9, stk: 9 } }, {}).session, sess(0, 0, 0, 0)));
check('session: counters are whole numbers and capped like the others', same(mergeData({ session: sess(1e300, -4, 2.9, 7) }, {}).session, sess(1e6, 0, 2, 7)));
check('prefs: each key is decided on its own, so a change on one device never overwrites another key', (() => { const r = mergeData({ prefs: { theme: pf('dark', 300), sound: pf(true, 100) } }, { prefs: { theme: pf('light', 200), sound: pf(false, 250) } }).prefs; return r.theme.v === 'dark' && r.sound.v === false; })());
check('prefs: a tie is broken by the value as text, whatever the argument order', mergeData({ prefs: { mode: pf('word', 50) } }, { prefs: { mode: pf('syl', 50) } }).prefs.mode.v === mergeData({ prefs: { mode: pf('syl', 50) } }, { prefs: { mode: pf('word', 50) } }).prefs.mode.v);
check('prefs: invalid values are dropped (wrong type, out of range, unknown)', (() => {
  const bad = mergeData({ prefs: { theme: pf('purple', 9), mode: pf('x', 9), sessionLen: pf(7, 9), rate: pf(5, 9), world: pf(1000, 9), lang: pf('fr', 9), sound: pf('yes', 9), upper: pf(1, 9) } }, {}).prefs;
  return Object.keys(bad).length === 0;
})(), '');
check('prefs: the valid values are accepted', (() => {
  const ok = mergeData({ prefs: { theme: pf('', 1), mode: pf('word', 1), sessionLen: pf(15, 1), rate: pf(0.6, 1), world: pf('auto', 1), lang: pf('ca', 1), sound: pf(false, 1), upper: pf(true, 1) } }, {}).prefs;
  return PREF_KEYS.every((k) => ok[k]);
})());
check('prefs: an entry without a valid timestamp is dropped and a non-object prefs is ignored', !('theme' in mergeData({ prefs: { theme: { v: 'dark' } } }, {}).prefs) && Object.keys(mergeData({ prefs: [1, 2] }, { prefs: 'x' }).prefs).length === 0);
check('prefs: voice settings can never come through', !('voiceURI' in mergeData({ prefs: { voiceURI: pf('x', 9) } }, {}).prefs) && !('voiceURIs' in mergeData({ prefs: { voiceURIs: pf({}, 9) } }, {}).prefs));
check('prefs: __proto__ and unknown keys are ignored', (() => { const r = mergeData(JSON.parse('{"prefs":{"__proto__":{"v":"dark","at":9},"constructor":{"v":1,"at":9}}}'), {}).prefs; return Object.keys(r).length === 0 && !({}).v; })());
check('session and prefs never touch modAt, level or name', (() => { const r = mergeData({ level: 3, name: 'A', modAt: 100, session: sess(1, 0, 0, 999) }, { prefs: { theme: pf('dark', 999) } }); return r.modAt === 100 && r.level === 3 && r.name === 'A'; })());

// property tests including the new fields
const genExtra = () => {
  const o = gen();
  o.session = rnd() < 0.7 ? sess(ri(6), ri(6), ri(3), (1 + ri(4)) * 100) : undefined;
  const prefs = {};
  if (rnd() < 0.6) prefs.theme = pf(['', 'light', 'dark'][ri(3)], (1 + ri(4)) * 100);
  if (rnd() < 0.6) prefs.sound = pf(rnd() < 0.5, (1 + ri(4)) * 100);
  if (rnd() < 0.6) prefs.sessionLen = pf([5, 10, 15, 20][ri(4)], (1 + ri(4)) * 100);
  if (rnd() < 0.6) prefs.mode = pf(['syl', 'word'][ri(2)], (1 + ri(4)) * 100);
  o.prefs = prefs;
  return o;
};
let c2 = true, a2 = true, i2 = true;
for (let i = 0; i < 300; i++) {
  const x = genExtra(), y = genExtra(), z = genExtra();
  if (!same(mergeData(x, y), mergeData(y, x))) c2 = false;
  if (!same(mergeData(mergeData(x, y), z), mergeData(x, mergeData(y, z)))) a2 = false;
  if (!same(mergeData(x, x), mergeData(x, {}))) i2 = false;
}
check('property: with session and prefs the merge is still commutative', c2);
check('property: with session and prefs the merge is still associative', a2);
check('property: with session and prefs merging a state with itself changes nothing', i2);

// applySynced writes them and the plain fields
const T = { theme: 'light', sound: true, voiceURI: 'keep-me' };
applySynced(T, { session: sess(4, 3, 1, 500), prefs: { theme: pf('dark', 9), sound: pf(false, 9) } });
check('applySynced: the session, the prefs and the plain preference fields are set; the voice is untouched', T.session.done === 4 && T.prefs.theme.v === 'dark' && T.theme === 'dark' && T.sound === false && T.voiceURI === 'keep-me', JSON.stringify(T));
```

Also add `sess`-less compatibility: the existing tests keep passing because `mergeData` of states without these fields yields an empty session and empty prefs.

- [ ] **Step 2: Run to verify they fail**

Run: `node tests/merge.mjs 2>&1 | grep -E "FAIL|rror" | head`
Expected: FAIL on the new checks (`session`/`prefs` are `undefined` in the result) and an error for `PREF_KEYS` not exported.

- [ ] **Step 3: Implement** — in `src/merge.js`, after the `nm` helper add:

```js
// ---------- session in progress and preferences (spec: 2026-10-17-session-prefs-sync-design.md) ----------
const PREF_OK = {
  mode: (v) => v === 'syl' || v === 'word',
  world: (v) => v === 'auto' || (Number.isInteger(v) && v >= 0 && v <= 99),
  sessionLen: (v) => v === 5 || v === 10 || v === 15 || v === 20,
  upper: (v) => typeof v === 'boolean',
  lang: (v) => v === 'es' || v === 'ca',
  rate: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0.5 && v <= 1.1,
  sound: (v) => typeof v === 'boolean',
  theme: (v) => v === '' || v === 'light' || v === 'dark',
};
export const PREF_KEYS = Object.keys(PREF_OK); // never the voice: it differs per device
const cleanPref = (k, prefs) => {
  const e = isObj(prefs) && Object.prototype.hasOwnProperty.call(prefs, k) ? prefs[k] : null;
  return isObj(e) && PREF_OK[k](e.v) && stamp(e.at) ? { v: e.v, at: stamp(e.at) } : null;
};
// the entry changed last; on a tie the larger value as text, so the order of the arguments never matters
const pickPref = (a, b) => (!a || !b ? a || b || null : a.at !== b.at ? (a.at > b.at ? a : b) : String(a.v) >= String(b.v) ? a : b);
const cleanSession = (s) => (isObj(s) && stamp(s.at) ? { done: num(s.done), ok: num(s.ok), stk: num(s.stk), at: stamp(s.at) } : null);
const pickSession = (a, b) => {
  if (!a || !b) return a || b || { done: 0, ok: 0, stk: 0, at: 0 };
  if (a.at !== b.at) return a.at > b.at ? a : b;
  return a.done !== b.done ? (a.done > b.done ? a : b) : a.ok !== b.ok ? (a.ok > b.ok ? a : b) : a.stk >= b.stk ? a : b;
};
```

In the object returned by `mergeData`, after `modAt: Math.max(ta, tb),` add:

```js
    session: pickSession(cleanSession(a.session), cleanSession(b.session)),
    prefs: Object.fromEntries(PREF_KEYS.map((k) => [k, pickPref(cleanPref(k, a.prefs), cleanPref(k, b.prefs))]).filter(([, e]) => e)),
```

In `applySynced`, after `state.modAt = d.modAt;` add:

```js
  state.session = d.session;
  state.prefs = d.prefs;
  for (const k of PREF_KEYS) if (d.prefs[k]) state[k] = d.prefs[k].v; // the plain fields the app reads; never the voice
```

- [ ] **Step 4: Run**

Run: `node tests/merge.mjs 2>&1 | grep -vE "^PASS"`
Expected: `All merge tests passed`. If `property: ... associative` fails, check `pickPref`/`pickSession` tie rules.

- [ ] **Step 5: Spec note and commit** — in the spec, section 1 ("Merge rules"), replace the sentence "A session whose `at` is older than **12 hours** is treated as no session (all zero): a session left over from yesterday must not resume." with "A session older than **12 hours** (by its `at`) is ignored by the app when it restores or adopts it (the merge itself stays free of the clock): a session left over from yesterday must not resume." Then:

```bash
npm test 2>&1 | grep -E "FAIL|FAILED"
git add src/merge.js tests/merge.mjs docs
git commit -m "feat(sync): merge rules for the session in progress and the preferences

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS"
```
Expected: no `FAIL` lines.

---

### Task 2: Local state, change detection and persistence of the session

**Files:**
- Modify: `src/app.js`
- Modify: `tests/smoke.mjs` (section 29)

**Interfaces:**
- Consumes: Task 1 (`PREF_KEYS` is duplicated in `app.js` as a plain array because `app.js` cannot import; keep the two lists identical).
- Produces in `app.js`: `S.session = {done, ok, stk, at}`, `S.prefs = {[key]: {v, at}}`; module bindings `PREF_KEYS`, `SESSION_TTL`, `stampAfter`, `lastSessFp`, `lastPref`, `sessFp()`, `prefSnap()`; `save()` stamps `S.session.at` only when the counters changed and `S.prefs[k].at` only for a changed preference; `restoreSession(s)`; `renderSession()` calls `save()`.

- [ ] **Step 1: Write the failing tests** — append as section 29 in `tests/smoke.mjs` (before the final `console.log`). `dump`, `playSession`, `boot` exist:

```js
// ---------- 29. the session and the preferences have their own timestamps; the session survives a reload ----------
a = await boot();
a.$('joinBtn').click(); a.$('okBtn').click(); a.$('joinBtn').click(); a.$('noBtn').click();
const s29 = JSON.parse(a.w.localStorage.getItem('leemos-v1'));
check('session: counters and their own timestamp are saved after each answer', s29.session.done === 2 && s29.session.ok === 1 && s29.session.at > 0, JSON.stringify(s29.session));
a = await boot({ storage: dump(a.w) });
check('session: reloading the page keeps "2 de 10"', /2 de 10/.test(a.$('slabel').textContent), a.$('slabel').textContent);
a = await boot({ storage: { 'leemos-v1': { name: 'Elsa', session: { done: 4, ok: 3, stk: 0, at: Date.now() - 13 * 3600 * 1000 } } } });
check('session: one older than 12 hours does not resume', /0 de 10/.test(a.$('slabel').textContent), a.$('slabel').textContent);
a = await boot({ storage: { 'leemos-v1': { name: 'Elsa', session: { done: 10, ok: 9, stk: 1, at: Date.now() - 1000 } } } });
check('session: a finished one does not resume either', /0 de 10/.test(a.$('slabel').textContent), a.$('slabel').textContent);
a = await boot();
a.$('joinBtn').click(); a.$('okBtn').click();
const afterAnswer = JSON.parse(a.w.localStorage.getItem('leemos-v1'));
a.$('soundBtn').click();
const afterSound = JSON.parse(a.w.localStorage.getItem('leemos-v1'));
check('prefs: a preference change is stamped on its own key and does not touch modAt or the session stamp', afterSound.prefs.sound.v === false && afterSound.prefs.sound.at > 0 && afterSound.modAt === afterAnswer.modAt && afterSound.session.at === afterAnswer.session.at, JSON.stringify(afterSound.prefs));
a.$('themeBtn').click();
const afterTheme = JSON.parse(a.w.localStorage.getItem('leemos-v1'));
check('prefs: only the changed keys are recorded (defaults never travel)', Object.keys(afterTheme.prefs).sort().join() === 'sound,theme', Object.keys(afterTheme.prefs).join());
a = await boot();
check('prefs: loading an untouched profile records no preference', Object.keys(JSON.parse(a.w.localStorage.getItem('leemos-v1') || '{}').prefs || {}).length === 0);
a = await boot();
a.$('joinBtn').click(); a.$('okBtn').click();
const modBefore = JSON.parse(a.w.localStorage.getItem('leemos-v1')).modAt;
await playSession(a, 3);
a.$('soundBtn').click(); a.$('soundBtn').click();
check('session and prefs: neither moves modAt except real progress (level and name keep their own stamp)', (() => { const x = JSON.parse(a.w.localStorage.getItem('leemos-v1')); return x.modAt >= modBefore; })());
a = await boot();
await playSession(a, 10);
await until(() => !a.$('end').hidden);
a.$('endMore').click();
await sleep(20);
check('session: starting another session saves it as zero', JSON.parse(a.w.localStorage.getItem('leemos-v1')).session.done === 0);
```

(The `modAt` check above is weak by design; the strong check for "unrelated change does not revert the level" is in Task 3, test g.)

- [ ] **Step 2: Run to verify they fail**

Run: `node tests/smoke.mjs 2>&1 | grep -E "^FAIL.*(session|prefs)" | cut -c1-160`
Expected: FAIL for the saved session, the reload, and the per-key prefs.

- [ ] **Step 3: Implement** — edits in `src/app.js`:

(a) Move the session counters' declaration above the first possible `save()`. Delete the line `let sDone=0,sOk=0,sStk=0,pendingEnd=false,resting=false;` where it is now, and add it immediately before the line `let onProgressChange=()=>{}; // replaced by the sync glue`.

(b) In the `S` defaults (`Object.assign({stats:{}, ...`) add `session:{done:0,ok:0,stk:0,at:0},prefs:{},` (for example right after `resets:{es:0,ca:0},modAt:0,`).

(c) Right after the line `let onProgressChange=()=>{};...` add:

```js
// Session in progress and preferences (spec: docs/superpowers/specs/2026-10-17-session-prefs-sync-design.md). Each has its own
// timestamp, so none of them can overwrite another value on a second device or move modAt (which decides level and name).
const PREF_KEYS=['mode','world','sessionLen','upper','lang','rate','sound','theme']; // keep identical to merge.js; never the voice
const SESSION_TTL=12*3600*1000; // a session left over from yesterday must not resume
const stampAfter=prev=>Math.max(Date.now(),(prev||0)+1);
if(!S.prefs||typeof S.prefs!=='object')S.prefs={};
const restoreSession=s=>{
  if(s&&s.at&&Date.now()-s.at<SESSION_TTL&&s.done<S.sessionLen){sDone=s.done|0;sOk=s.ok|0;sStk=s.stk|0}
};
restoreSession(S.session);
let lastSessFp=null,lastPref=null; // baselines, set once the state is loaded: a save() before that (a migration) stamps nothing
const sessFp=()=>sDone+'|'+sOk+'|'+sStk;
const prefSnap=()=>Object.fromEntries(PREF_KEYS.map(k=>[k,S[k]]));
```

(d) Immediately after the capitals-migration line (`if(PROFILE.kind==='reader'&&!S.upperMigrated){...}`) add: `lastSessFp=sessFp();lastPref=prefSnap();`

(e) Replace the body of `save` so it reads:

```js
const save=()=>{
  const fp=fpOf();
  if(fp!==lastFp){lastFp=fp;S.modAt=Math.max(Date.now(),(S.modAt||0)+1);onProgressChange()} // never older than a stamp that came from a device with a faster clock
  if(lastSessFp!==null){
    const sf=sessFp();
    if(sf!==lastSessFp){lastSessFp=sf;S.session={done:sDone,ok:sOk,stk:sStk,at:stampAfter(S.session&&S.session.at)};onProgressChange()}
  }
  if(lastPref!==null){
    for(const k of PREF_KEYS){
      if(S[k]!==lastPref[k]){lastPref[k]=S[k];S.prefs[k]={v:S[k],at:stampAfter(S.prefs[k]&&S.prefs[k].at)};onProgressChange()}
    }
  }
  try{localStorage.setItem(KEY,JSON.stringify(S))}catch(e){}
};
```
(keep whatever comment text the existing `modAt` line already has; the logic is the existing one plus the two new blocks).

(f) At the end of `renderSession()` add `save();` so every place that resets or advances the counters (language switch, "Otra sesión", the end of a session) persists them.

- [ ] **Step 4: Run**

```bash
node tests/smoke.mjs 2>&1 | grep -E "^(FAIL|PASS).*(session|prefs)" | cut -c1-150
npm test 2>&1 | grep -E "FAIL|FAILED"
```
Expected: all section-29 lines PASS, no failures elsewhere. If an old test fails because the session now persists across `boot({storage: dump(...)})`, read it: tests that reload a dumped state expected a fresh "0 de 10"; adapt only those tests (the new behavior is intended) and note it in the ledger as a ruling.

- [ ] **Step 5: Commit**

```bash
git add src/app.js tests/smoke.mjs
git commit -m "feat(sync): session counters and preferences with their own timestamps; the session survives a reload

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS"
```

---

### Task 3: Applying a pull — idle rule and the UI

**Files:**
- Modify: `src/app.js` (`storeState`, new `applyMerged`)
- Modify: `tests/smoke.mjs` (section 30)

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: `storeState(id, data)` keeps a value changed locally in the last `IDLE_MS` (30 000 ms) and returns the merged data (so `syncAll` pushes it back); `applyMerged(m)` applies the merged state to the active profile through the UI's own functions.

- [ ] **Step 1: Write the failing tests** — append as section 30:

```js
// ---------- 30. applying a pull: session and preferences from another device, idle rule, hostile values ----------
const NOW = () => Date.now();
const seed = async (extraData, localState = {}, bootExtra = {}) => {
  const s = createFakeSupabase(); const { auth, uid } = await signedAuth(s);
  s.rows.set(RID_A, { id: RID_A, owner: uid, name: 'Elsa', kind: 'reader', version: 1, data: dat({ total: 1, name: 'Elsa', modAt: 5, ...extraData }) });
  const app = await boot({ supa: s, syncConfig: CFG, ...bootExtra, storage: { 'leemos-auth': auth, 'leemos-auth-user': uid, ...PROF_A, 'leemos-v1': { name: 'Elsa', total: 1, modAt: 5, ...localState } } });
  return { s, app };
};
const localState = (app) => JSON.parse(app.w.localStorage.getItem('leemos-v1'));
const OLD = () => NOW() - 120000; // idle for two minutes

// a: the session in progress arrives and shows
{
  const { s, app } = await seed({ session: { done: 4, ok: 3, stk: 0, at: NOW() - 1000 } }, { session: { done: 1, ok: 1, stk: 0, at: OLD() } });
  await until(() => /4 de 10/.test(app.$('slabel').textContent), 3000);
  check('pull a: the session in progress from another device shows "4 de 10"', /4 de 10/.test(app.$('slabel').textContent), app.$('slabel').textContent);
  check('pull a: and it is saved locally as that session', localState(app).session.done === 4);
}
// b: a device being used keeps its own session and pushes it back
{
  const { s, app } = await seed({ session: { done: 6, ok: 6, stk: 0, at: NOW() + 5000 } }, { session: { done: 2, ok: 1, stk: 0, at: NOW() } });
  await sleep(150);
  check('pull b: a session changed on this device a moment ago is not overwritten', /2 de 10/.test(app.$('slabel').textContent), app.$('slabel').textContent);
  await until(() => s.rows.get(RID_A).data.session.done === 2, 3000);
  check('pull b: and it is pushed back, so the other device adopts it', s.rows.get(RID_A).data.session.done === 2, JSON.stringify(s.rows.get(RID_A).data.session));
}
// c: every preference arrives and is applied through the UI
{
  const t0 = NOW() - 1000;
  const { s, app } = await seed({ prefs: { theme: { v: 'dark', at: t0 }, sound: { v: false, at: t0 }, mode: { v: 'word', at: t0 }, sessionLen: { v: 5, at: t0 }, upper: { v: false, at: t0 }, rate: { v: 0.6, at: t0 }, world: { v: 3, at: t0 }, lang: { v: 'ca', at: t0 } } });
  await until(() => app.d.documentElement.lang === 'ca', 3000);
  await sleep(60);
  const st = localState(app);
  check('pull c: theme, sound, mode, session length, capitals, speed and world are applied', app.d.documentElement.getAttribute('data-theme') === 'dark' && app.$('soundBtn').getAttribute('aria-pressed') === 'false' && app.$('mWord').getAttribute('aria-pressed') === 'true' && app.$('sessionSel').value === '5' && !app.d.body.classList.contains('upper') && app.$('rate').value === '0.6' && st.world === 3, JSON.stringify({ t: st.theme, s: st.sound, m: st.mode, l: st.sessionLen, u: st.upper, r: st.rate, w: st.world }));
  check('pull c: the language switches the interface', app.d.documentElement.lang === 'ca' && app.$('langBtn').textContent === 'CA', app.$('langBtn').textContent);
  check('pull c: the page shows the session length of the pulled preference', /de 5/.test(app.$('slabel').textContent), app.$('slabel').textContent);
}
// d: preferences are independent per key
{
  const { s, app } = await seed({ prefs: { sound: { v: false, at: NOW() - 1000 }, theme: { v: 'light', at: NOW() - 200000 } } }, { theme: 'dark', prefs: { theme: { v: 'dark', at: NOW() - 60000 } } });
  await until(() => app.$('soundBtn').getAttribute('aria-pressed') === 'false', 3000);
  check('pull d: the newer remote sound is applied while the newer local theme is kept', app.$('soundBtn').getAttribute('aria-pressed') === 'false' && app.d.documentElement.getAttribute('data-theme') === 'dark');
}
// e: a finished or stale remote session starts a new one
{
  const { app } = await seed({ session: { done: 10, ok: 9, stk: 1, at: NOW() - 1000 } }, { session: { done: 3, ok: 3, stk: 0, at: OLD() } });
  await until(() => /0 de 10/.test(app.$('slabel').textContent), 3000);
  check('pull e: a finished remote session applies as zero, not as "10 de 10"', /0 de 10/.test(app.$('slabel').textContent), app.$('slabel').textContent);
  const { app: app2 } = await seed({ session: { done: 7, ok: 5, stk: 0, at: NOW() - 13 * 3600 * 1000 } }, { session: { done: 0, ok: 0, stk: 0, at: 0 } });
  await sleep(150);
  check('pull e: a remote session older than 12 hours is ignored', /0 de 10/.test(app2.$('slabel').textContent), app2.$('slabel').textContent);
}
// f: the voice never leaves the device
{
  const { s, app } = await seed({}, { voiceURIs: { es: 'my-private-voice', ca: '' }, voiceURI: 'my-private-voice', theme: 'dark', prefs: { theme: { v: 'dark', at: NOW() - 60000 } } });
  await until(() => s.rows.get(RID_A).data.prefs && s.rows.get(RID_A).data.prefs.theme, 3000);
  check('pull f: the voice is never uploaded', !JSON.stringify(s.rows.get(RID_A).data).includes('my-private-voice') && !('voiceURI' in s.rows.get(RID_A).data.prefs));
}
// g: a session or preference change never reverts the level
{
  const { s, app } = await seed({ level: 3, name: 'Elsa', modAt: NOW() - 1000 }, { level: 0, modAt: 10 });
  await until(() => localState(app).level === 3, 3000);
  app.$('themeBtn').click(); app.$('soundBtn').click();
  app.$('joinBtn').click(); // no progress change: only session-neutral actions
  await sleep(100);
  app.w.dispatchEvent(new app.w.Event('online'));
  await sleep(150);
  check('pull g: the level from the other device survives local preference changes and the next sync', localState(app).level === 3 && s.rows.get(RID_A).data.level === 3, `${localState(app).level} ${s.rows.get(RID_A).data.level}`);
}
// h: hostile remote values are dropped
{
  const t0 = NOW() - 1000;
  const { app } = await seed({ prefs: { theme: { v: 'purple', at: t0 }, mode: { v: 'x', at: t0 }, sessionLen: { v: 7, at: t0 }, rate: { v: 99, at: t0 }, lang: { v: 'fr', at: t0 } }, session: { done: -3, ok: 'a', stk: 1e300, at: t0 } });
  await sleep(250);
  const st = localState(app);
  check('pull h: invalid remote preferences are never applied and nothing crashes', app.errors.length === 0 && (st.theme || '') !== 'purple' && st.mode !== 'x' && st.sessionLen !== 7 && st.rate !== 99 && st.lang !== 'fr', app.errors.join(' | '));
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `node tests/smoke.mjs 2>&1 | grep -E "^FAIL.*pull [a-h]" | cut -c1-150`
Expected: FAIL on a, b, c, d, e (the session and preferences are not applied yet); f may pass or fail depending on earlier tasks; g and h pass trivially until the merge feeds them (record which in the ledger).

- [ ] **Step 3: Implement** — in `src/app.js` replace the whole `storeState` function with:

```js
const IDLE_MS=30000; // a value changed on THIS device within the last 30 s is kept: nobody is interrupted while playing
function applyMerged(m){
  const before={lang:S.lang,mode:S.mode};
  mergeMod.applySynced(S,m); // sets the progress fields, S.session, S.prefs and the plain preference fields (never the voice)
  if(S.lang!==before.lang){LEVELS=LV[S.lang]||LV_ES;pendingEnd=false;resting=false}
  if(S.level>=LEVELS.length)S.level=0;
  // preferences, through the same functions the UI uses
  applyTheme();applyCase();applySound();applyWorld();
  $('rate').value=S.rate;$('sessionSel').value=String(S.sessionLen);
  $('mSyl').setAttribute('aria-pressed',S.mode==='syl');$('mWord').setAttribute('aria-pressed',S.mode==='word');
  // the session in progress: a finished or stale one starts a new session
  const s=m.session;
  if(s.at){
    if(Date.now()-s.at<SESSION_TTL&&s.done<S.sessionLen){sDone=s.done;sOk=s.ok;sStk=s.stk}
    else{sDone=sOk=sStk=0}
  }
  lastFp=fpOf();lastSessFp=sessFp();lastPref=prefSnap(); // data that came from the server is not a local change: no stamps, no new sync
  save();renderLevels();renderHard();renderAlbum();updateHello();
  if(S.lang!==before.lang)applyLang();else renderSession();
  renderGoal();renderWorlds();
  if(S.lang!==before.lang||S.mode!==before.mode)pre?pre.refresh():next(); // a different context needs a new exercise; otherwise the card on screen stays
}
// Returns the merged data. The child may have answered while the request was in flight, so the server's data is merged
// into the CURRENT local state (never copied over it): a sync can only add progress, never take it away.
function storeState(id,data){
  const active=id===PROFILE.id,cur=active?S:stateOf(id);
  const mine=mergeMod.pickSynced(cur);
  const merged=mergeMod.mergeData(mine,data);
  if(active){
    const now=Date.now();
    for(const k of PREF_KEYS){ // keep what was changed here a moment ago; renewing its stamp makes it win on the next push
      const m=mine.prefs[k];
      if(m&&now-m.at<IDLE_MS&&(!merged.prefs[k]||merged.prefs[k].at!==m.at))merged.prefs[k]={v:m.v,at:now};
    }
    if(mine.session.at&&now-mine.session.at<IDLE_MS&&merged.session.at!==mine.session.at)merged.session={...mine.session,at:now};
    applyMerged(merged);
  }else{
    mergeMod.applySynced(cur,merged);
    try{localStorage.setItem(keyFor(id),JSON.stringify(cur))}catch(e){}
  }
  return merged;
}
```
`syncAll` already compares the returned `merged` with `r.data` and schedules another sync when they differ, so a kept value is pushed back.

- [ ] **Step 4: Run**

```bash
node tests/smoke.mjs 2>&1 | grep -E "^(FAIL|PASS).*pull [a-h]" | cut -c1-170
npm test 2>&1 | grep -E "FAIL|FAILED"
```
Expected: all section-30 lines PASS and no failure elsewhere. Likely snags: (1) `app.$('rate').value` returns `'0.6'` as a string in jsdom; (2) `applyWorld()` needs `WORLDS`; (3) when the language switches, `applyLang()` re-renders the session label, so check the order in `applyMerged`.

- [ ] **Step 5: Commit**

```bash
git add src/app.js tests/smoke.mjs
git commit -m "feat(sync): apply the session and preferences from another device, with a 30 s idle rule

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS"
```

---

### Task 4: Protocol test, docs and final verification

**Files:**
- Modify: `tests/sync.mjs`, `CLAUDE.md`

**Interfaces:** consumes everything above.

- [ ] **Step 1: Protocol test** — in `tests/sync.mjs`, before the final `console.log`, add:

```js
// ---------- session and preferences travel through pull-merge-push ----------
{
  const { srv, sync } = await signedIn();
  const withSp = (over = {}) => data({ session: { done: 3, ok: 2, stk: 0, at: 500 }, prefs: { theme: { v: 'dark', at: 500 }, sound: { v: false, at: 500 } }, ...over });
  await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: withSp() });
  check('session/prefs: they are uploaded with the profile', srv.rows.get(RID).data.session.done === 3 && srv.rows.get(RID).data.prefs.theme.v === 'dark');
  const r = await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data({ prefs: { sound: { v: true, at: 900 } } }) });
  check('session/prefs: a later device keeps the newer sound and receives the other key and the session', r.data.prefs.sound.v === true && r.data.prefs.theme.v === 'dark' && r.data.session.done === 3, JSON.stringify(r.data.prefs));
  check('session/prefs: nothing about the voice is ever sent', !srv.log.length || !JSON.stringify([...srv.rows.values()]).includes('voice'));
}
```

- [ ] **Step 2: Docs** — in `CLAUDE.md` (Persistence section) add a bullet: "Sesión en curso y preferencias sincronizadas (spec `docs/superpowers/specs/2026-10-17-session-prefs-sync-design.md`): `S.session {done,ok,stk,at}` refleja los contadores `sDone/sOk/sStk` y se guarda en local (sobrevive a recargar; si tiene más de 12 h o está terminada, empieza de cero); `S.prefs {clave:{v,at}}` guarda solo las preferencias que alguien cambió (mode, world, sessionLen, upper, lang, rate, sound, theme), cada una con su marca de tiempo. Ninguna toca `modAt` (huellas separadas en `save()`). Nunca se sincroniza la voz (`voiceURI(s)`) ni las grabaciones. Al aplicar un pull, un valor cambiado en este dispositivo hace menos de 30 s se conserva y se devuelve al servidor (regla de inactividad); lo que viene del servidor no marca ni dispara otra sincronización." Also replace the pending item that says "Persistir la sesión en curso" by noting it is done.

- [ ] **Step 3: Full verification**

```bash
npm test 2>&1 | grep -E "FAIL|FAILED"; echo "--- (none expected)"
npm test 2>&1 | grep -cE "passed"
git status --short
```
Expected: no failures; 11 `passed` lines; only the planned files modified before the commit below.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs+test(sync): session and preferences travel through the sync protocol; CLAUDE.md

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS"
```
Before `git add -A` check `git status --short`: Fran's local `src/data/sync.config.json` is marked skip-worktree and must not appear.

- [ ] **Step 5: Tell Fran** (short): reload both devices with Cmd+Shift+R; the session counters, the stickers earned and the preferences now follow the child; the voice stays per device; the exact syllable on screen is not synced.

---

## Self-Review

**Spec coverage:** data model and merge rules (Task 1); local state, separate fingerprints, persistence, 12 h expiry (Task 2); applying a pull, idle rule, order of application, finished and stale session, whitelist (Task 3); testing list items map to Tasks 1-4; failure modes: clock differences (accepted in the spec), two devices at once (Task 3 b/d), hostile values (Tasks 1 and 3 h), unknown language (Task 1 whitelist), session length arriving with the session (Task 3 c, order inside `applyMerged`: `applySynced` first sets `sessionLen`, then the session is clamped).

**Placeholder scan:** Task 2 step 3 (e) says to keep the existing comment on the `modAt` line; Task 2 step 4 tells the executor to adapt old tests that assumed a session never persists (to be decided on reading them, recorded as a ruling). No other placeholders.

**Type consistency:** `PREF_KEYS` is the same list in `merge.js` and `app.js`; `S.prefs[k] = {v, at}` is what `pickSynced`/`mergeData` read; `applySynced` writes both `state.prefs` and the plain fields; `IDLE_MS`, `SESSION_TTL`, `lastSessFp`, `lastPref`, `sessFp`, `prefSnap`, `stampAfter` are defined once (Task 2) and reused (Task 3).

**Known risks the plan cannot remove:** `world`, `lang` and `mode` adopted on an idle device call `next()` and can replace a card the child was looking at after 30 s of inactivity; real-browser behavior of the theme and language switches is only checked in jsdom.
