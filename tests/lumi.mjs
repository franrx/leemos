// Unit tests for Lumi's idle life (src/lumi.js). Plain Node: a fake svg and a manual clock.
import { ACTS, pickAct, lumiLife, followPointer } from '../src/lumi.js';

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const mulberry = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// a manual clock: later() queues, advance(ms) runs what is due
function clock() {
  let now = 0, id = 0; const q = [];
  return {
    later: (f, ms) => { const t = { id: ++id, at: now + ms, f }; q.push(t); return t.id; },
    clear: (i) => { const k = q.findIndex((t) => t.id === i); if (k >= 0) q.splice(k, 1); },
    advance: (ms) => { const end = now + ms; for (;;) { q.sort((a, b) => a.at - b.at); const t = q[0]; if (!t || t.at > end) break; q.shift(); now = t.at; t.f(); } now = end; },
    pending: () => q.length,
  };
}
const fakeSvg = () => { const cls = new Set(), st = {}, added = []; return { added, classList: { add: (c) => { added.push(c); cls.add(c); }, remove: (c) => cls.delete(c), contains: (c) => cls.has(c), list: () => [...cls] }, style: { setProperty: (k, v) => { st[k] = v; }, removeProperty: (k) => { delete st[k]; }, get: (k) => st[k] }, getBoundingClientRect: () => ({ left: 100, top: 100, width: 100, height: 100 }) }; };

check('ACTS: every act has a duration in ms', Object.values(ACTS).every((v) => v > 0) && ['look', 'tilt', 'twitch', 'wing', 'shake', 'hop', 'yawn', 'giggle', 'wow', 'bounce', 'wiggle', 'twinkle', 'peek'].every((k) => ACTS[k]));
{
  const rng = mulberry(3); let last = '', same = 0, seen = new Set();
  for (let i = 0; i < 500; i++) { const a = pickAct(rng, last); if (a === last) same++; seen.add(a); last = a; }
  check('pickAct: never the same act twice in a row, and every idle act turns up', same === 0 && ['look', 'tilt', 'twitch', 'wing', 'shake', 'hop', 'yawn', 'wow', 'bounce', 'wiggle', 'twinkle', 'peek'].every((k) => seen.has(k)));
  check('pickAct: giggle is only for a tap on him, never random', !seen.has('giggle'));
}
{
  const c = clock(), s = fakeSvg(), L = lumiLife(s, { rng: mulberry(1), later: c.later, clear: c.clear });
  {
  const c = clock(), s = fakeSvg(); lumiLife(s, { rng: () => 0, later: c.later, clear: c.clear }).start(); c.advance(2999); const early = s.added.length;
  const c2 = clock(), s2 = fakeSvg(); lumiLife(s2, { rng: () => 0.999, later: c2.later, clear: c2.clear }).start(); c2.advance(6500);
  check('life: by default the first act comes after 3 s at the soonest and 6.5 s at the latest (a lively pace)', early === 0 && s2.added.length === 1, `early=${early} late=${s2.added.length}`);
}
check('act: a known act puts its class on and takes it off after its duration', L.act('hop') === true && s.classList.contains('act-hop') && (c.advance(ACTS.hop - 1), s.classList.contains('act-hop')) && (c.advance(2), !s.classList.contains('act-hop')));
  check('act: an unknown act does nothing', L.act('fly') === false && s.classList.list().length === 0);
  const r = lumiLife(s, { later: c.later, clear: c.clear, reduced: () => true });
  check('act: with reduced motion nothing is played', r.act('hop') === false && s.classList.list().length === 0);
}
{
  const c = clock(), s = fakeSvg(); let can = true;
  const L = lumiLife(s, { rng: mulberry(5), later: c.later, clear: c.clear, canAct: () => can, minMs: 5000, maxMs: 9500 });
  L.start(); c.advance(4999);
  check('life: nothing happens before the first 5 s', s.added.length === 0);
  c.advance(4600);
  check('life: exactly one act has started once the first wait is over (by 9.5 s)', s.added.length === 1);
  const n1 = s.added.length; can = false; c.advance(40000);
  check('life: while he cannot act (talking, a screen over him) no new act starts', s.added.length === n1 && s.classList.list().length === 0);
  can = true; c.advance(20000);
  check('life: and acts come back when he can', s.added.length > n1 && c.pending() > 0);
  L.stop(); const p = c.pending(), n2 = s.added.length; c.advance(60000);
  check('life: stop() cancels the clock and nothing more happens', p === 0 && s.added.length === n2);
  L.start(); L.start();
  check('life: start() twice keeps ONE clock', c.pending() === 1);
  L.stop();
}
{
  const c = clock(), s = fakeSvg(), L = lumiLife(s, { later: c.later, clear: c.clear });
  L.look(0.5, -0.25, 1000);
  check('look: sets the gaze', s.style.get('--lx') === '0.5' && s.style.get('--ly') === '-0.25');
  L.look(9, -9, 1000);
  check('look: the gaze is clamped to -1..1', s.style.get('--lx') === '1' && s.style.get('--ly') === '-1');
  c.advance(999); const still = s.style.get('--lx') === '1'; c.advance(2);
  check('look: after the hold the gaze goes back to the mood (properties removed)', still && s.style.get('--lx') === undefined && s.style.get('--ly') === undefined);
  L.look(1, 1, 1000); c.advance(600); L.look(-1, 0, 1000); c.advance(600);
  check('look: a new look restarts the hold (the first timer does not cut the second)', s.style.get('--lx') === '-1');
}
{
  const c = clock(), s = fakeSvg(), L = lumiLife(s, { later: c.later, clear: c.clear }); const ev = {};
  followPointer({ addEventListener: (n, f) => { ev[n] = f; } }, s, L, { reach: 100 });
  ev.pointerdown({ clientX: 250, clientY: 150, pointerType: 'touch' }); // svg centre is (150,150): 100 px to the right
  check('followPointer: a tap makes him look towards it', s.style.get('--lx') === '1' && Number(s.style.get('--ly')) === 0);
  c.advance(1801);
  check('followPointer: and he stops looking after about 2 s', s.style.get('--lx') === undefined);
  ev.pointermove({ clientX: 100, clientY: 150, pointerType: 'mouse' });
  check('followPointer: a mouse move is followed too', s.style.get('--lx') === '-0.5');
  s.style.removeProperty('--lx'); ev.pointermove({ clientX: 100, clientY: 150, pointerType: 'touch' });
  check('followPointer: a touch drag is not followed (only the tap is)', s.style.get('--lx') === undefined);
}
console.log(failures ? `\n${failures} FAILED` : '\nall lumi tests passed');
process.exit(failures ? 1 : 0);
