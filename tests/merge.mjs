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

// bounds: hostile or broken numbers and keys cannot grow or freeze the data (review minor m5)
const huge = mergeData({ resets: { es: 1e300, ca: 2 }, total: 1e300, stickers: Infinity, stats: { 's:ma': { ok: 1e300, fail: 3 }, evil: { ok: 5 }, ['s:' + 'x'.repeat(200)]: { ok: 5 }, 'w:ne-na': { ok: 1.9 }, 'snd:m': { ok: 1, [('f').repeat(50)]: 9 } }, modAt: 1e300 }, {});
check('bounds: counters and resets are capped, so 1e300 cannot absorb later increments', huge.total === 1e6 && huge.resets.es === 1e6 && huge.stats['s:ma'].ok === 1e6 && huge.stickers === 0, JSON.stringify([huge.total, huge.resets, huge.stickers]));
check('bounds: a reset counter at the cap is still just a counter', huge.resets.ca === 2);
check('bounds: stats keys that are not item keys, or are too long, are dropped', !('evil' in huge.stats) && !Object.keys(huge.stats).some((k) => k.length > 44), Object.keys(huge.stats).join('|'));
check('bounds: fractional counters become whole numbers', huge.stats['w:ne-na'].ok === 1);
check('bounds: field names inside a stat are limited too', Object.keys(huge.stats['snd:m']).every((f) => f.length <= 16));
check('bounds: an unsafe modAt counts as zero', huge.modAt === 0);

console.log(failures ? `\n${failures} merge test(s) FAILED` : '\nAll merge tests passed');
process.exit(failures ? 1 : 0);
