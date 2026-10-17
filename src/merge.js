// Pure merge of the synced part of a child's saved state. Spec: docs/superpowers/specs/2026-10-17-accounts-sync-design.md.
// No globals: tests, the sync module and the app (through import()) all use it.
const LANGS = ['es', 'ca'];
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const CAP = 1e6; // counters stay below this, so a hostile 1e300 can never absorb later +1 increments
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(CAP, Math.floor(v)) : 0);
const stamp = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0); // modAt is a millisecond timestamp, not a counter
const ITEM_KEY = /^(ca:)?(s|w|snd):.{1,40}$/; // the stat keys the app really writes
const unsafe = (k) => k === '__proto__' || k === 'constructor' || k === 'prototype';
const langOf = (k) => (k.indexOf('ca:') === 0 ? 'ca' : 'es');
const pair = (o) => ({ es: num(isObj(o) ? o.es : 0), ca: num(isObj(o) ? o.ca : 0) });
const lvl = (x) => Math.floor(num(x && x.level));
const nm = (x) => (x && typeof x.name === 'string' ? x.name.trim().slice(0, 40) : '');

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
