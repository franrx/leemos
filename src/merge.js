// Pure merge of the synced part of a child's saved state. Spec: docs/superpowers/specs/2026-10-17-accounts-sync-design.md.
// No globals: tests, the sync module and the app (through import()) all use it.
const LANGS = ['es', 'ca'];
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const CAP = 1e6; // counters stay below this, so a hostile 1e300 can never absorb later +1 increments
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(CAP, Math.floor(v)) : 0);
const MAX_AT = 8.64e15; // the largest date JavaScript can represent: a stamp beyond it is invalid
const stamp = (v) => (Number.isSafeInteger(v) && v > 0 && v <= MAX_AT ? v : 0); // modAt and the other stamps are millisecond timestamps, not counters
const ITEM_KEY = /^(ca:)?(s|w|snd):.{1,40}$/; // the stat keys the app really writes
const unsafe = (k) => k === '__proto__' || k === 'constructor' || k === 'prototype';
const langOf = (k) => (k.indexOf('ca:') === 0 ? 'ca' : 'es');
const pair = (o) => ({ es: num(isObj(o) ? o.es : 0), ca: num(isObj(o) ? o.ca : 0) });
const lvl = (x) => Math.floor(num(x && x.level));
const nm = (x) => (x && typeof x.name === 'string' ? x.name.trim().slice(0, 40) : '');
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
  pathEs: (v) => Number.isInteger(v) && v >= 1 && v <= 12, // letters open in Spanish (Camino de Elsa)
  pathCa: (v) => Number.isInteger(v) && v >= 1 && v <= 12,
  pathAuto: (v) => typeof v === 'boolean',
};
export const PREF_KEYS = Object.keys(PREF_OK); // never the voice: it differs per device
const cleanPref = (k, prefs) => {
  const e = isObj(prefs) && Object.prototype.hasOwnProperty.call(prefs, k) ? prefs[k] : null;
  return isObj(e) && PREF_OK[k](e.v) && stamp(e.at) ? { v: e.v, at: stamp(e.at) } : null;
};
// the entry changed last; on a tie the larger value as text, so the order of the arguments never matters
const pickPref = (a, b) => (!a || !b ? a || b || null : a.at !== b.at ? (a.at > b.at ? a : b) : String(a.v) >= String(b.v) ? a : b);
// correct answers and stickers cannot exceed the answers done
const cleanSession = (s) => { if (!isObj(s) || !stamp(s.at)) return null; const done = num(s.done); return { done, ok: Math.min(num(s.ok), done), stk: Math.min(num(s.stk), done), at: stamp(s.at) }; };
const pickSession = (a, b) => {
  if (!a || !b) return a || b || { done: 0, ok: 0, stk: 0, at: 0 };
  if (a.at !== b.at) return a.at > b.at ? a : b;
  return a.done !== b.done ? (a.done > b.done ? a : b) : a.ok !== b.ok ? (a.ok > b.ok ? a : b) : a.stk >= b.stk ? a : b;
};


const cleanStat = (s) => {
  const o = {};
  if (isObj(s)) for (const f of Object.keys(s).slice(0, 8)) if (!unsafe(f) && f.length <= 16 && typeof s[f] === 'number' && Number.isFinite(s[f]) && s[f] >= 0) o[f] = Math.min(CAP, Math.floor(s[f]));
  return o;
};
const statsOf = (d, L) => {
  const out = {};
  if (isObj(d.stats)) for (const k of Object.keys(d.stats)) if (!unsafe(k) && ITEM_KEY.test(k) && langOf(k) === L) out[k] = cleanStat(d.stats[k]);
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
  const ta = stamp(a.modAt), tb = stamp(b.modAt);
  // current position (level, name): the side changed last; ties by (level, name) so the argument order never matters
  const aWins = ta !== tb ? ta > tb : lvl(a) !== lvl(b) ? lvl(a) > lvl(b) : nm(a) >= nm(b);
  const w = aWins ? a : b;
  let stk = {};
  if (isObj(a.stk) === isObj(b.stk)) { // both new, or both old: per world, the larger count
    const ka = stkOf(a), kb = stkOf(b);
    for (const id of new Set([...Object.keys(ka), ...Object.keys(kb)])) stk[id] = Math.max(ka[id] || 0, kb[id] || 0);
  } else {
    // One side is a device on the old version: it pushes only a counter, and that counter is the larger of its own and OUR total
    // (an echo), so reading it again from the start would invent stickers on every round. Only what is beyond our total is new:
    // the stickers it earned itself, which are the next ones in the old order.
    const [mine, old] = isObj(a.stk) ? [a, b] : [b, a];
    stk = stkOf(mine);
    const from = stkSum(stk), to = Math.min(LEGACY_WORLD.length, num(old.stickers));
    for (let i = from; i < to; i++) stk[LEGACY_WORLD[i]] = Math.min(CAP_STK, (stk[LEGACY_WORLD[i]] || 0) + 1);
  }
  return {
    stats,
    total: Math.max(num(a.total), num(b.total)),
    stk,
    stickers: stkSum(stk),
    pre: { es: Math.max(pa.es, pb.es), ca: Math.max(pa.ca, pb.ca) },
    resets: { es: Math.max(ra.es, rb.es), ca: Math.max(ra.ca, rb.ca) },
    level: lvl(w),
    name: nm(w),
    modAt: Math.max(ta, tb),
    session: pickSession(cleanSession(a.session), cleanSession(b.session)),
    prefs: Object.fromEntries(PREF_KEYS.map((k) => [k, pickPref(cleanPref(k, a.prefs), cleanPref(k, b.prefs))]).filter(([, e]) => e)),
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
  state.stk = d.stk;
  state.stickers = d.stickers;
  state.pre = d.pre;
  state.resets = d.resets;
  state.level = d.level;
  state.modAt = d.modAt;
  state.session = d.session;
  state.prefs = d.prefs;
  for (const k of PREF_KEYS) if (d.prefs[k]) state[k] = d.prefs[k].v; // the plain fields the app reads; never the voice
  if (d.name) state.name = d.name;
  return state;
}
