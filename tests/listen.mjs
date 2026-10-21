// Unit tests for the pure part of the listen mode (src/listen.js). Plain Node, no DOM.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_OPEN, SCREENS, GAP, listenWords, openWords, robotTargets, makeRobot, partKeys, makeSession } from '../src/listen.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const mulberry = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

check('constants: 4 open words to unlock, 6 screens, 600 ms between syllables', MIN_OPEN === 4 && SCREENS === 6 && GAP === 600);
check('partKeys: a closed syllable tries its stretched clip first, anything else only itself', JSON.stringify(partKeys('pas')) === '["~pas","pas"]' && JSON.stringify(partKeys('pa')) === '["pa"]' && JSON.stringify(partKeys('tras')) === '["~tras","tras"]');
check('listenWords: a word without a picture, and a repeat of the same text, are left out', listenWords([{ words: [{ w: 'pa-ta', e: '🐾' }, { w: 'pa-ta', e: '🐾' }, { w: 'ma-no' }] }]).length === 1);

for (const lang of ['es', 'ca']) {
  const words = listenWords(readJSON(`src/data/levels.${lang}.json`));
  const all = openWords(words, 12);
  const targets = robotTargets(all);
  check(`[${lang}] listenWords: every word has a picture, parts joined are its text, and a Camino step`, words.length > 50 && words.every((w) => w.emoji && w.parts.join('') === w.text && w.step >= 0));
  check(`[${lang}] robotTargets: only words of 2 or 3 syllables`, targets.length >= MIN_OPEN && targets.every((w) => w.parts.length >= 2 && w.parts.length <= 3));
  let ok = true, why = '';
  for (let seed = 1; seed <= 200 && ok; seed++) {
    const r = makeRobot(all, mulberry(seed), new Set());
    if (!r) { ok = false; why = 'null'; break; }
    const t = r.cards.map((c) => c.text), e = r.cards.map((c) => c.emoji);
    if (r.cards.length !== 3 || new Set(t).size !== 3 || new Set(e).size !== 3 || !t.includes(r.target.text)) { ok = false; why = `seed ${seed}: ${t}`; }
  }
  check(`[${lang}] makeRobot: 3 cards, the target once, no repeated word or picture`, ok, why);
  const again = (s) => makeRobot(all, mulberry(s), new Set()).cards.map((c) => c.text).join();
  check(`[${lang}] makeRobot: deterministic for a seed`, again(7) === again(7));
  check(`[${lang}] makeRobot: a target in exclude is never chosen`, (() => { const ex = new Set(targets.slice(1).map((w) => w.text)); return makeRobot(all, mulberry(3), ex).target.text === targets[0].text; })());
  check(`[${lang}] makeRobot: null when no free target or fewer than 3 distinct pictures`, makeRobot(all, mulberry(1), new Set(targets.map((w) => w.text))) === null && makeRobot(all.slice(0, 2), mulberry(1)) === null);
  const open3 = openWords(words, 3);
  const ses = makeSession(open3, mulberry(5));
  check(`[${lang}] makeSession: up to 6 robot screens with distinct targets`, ses.length >= 1 && ses.length <= SCREENS && ses.every((s) => s.kind === 'robot') && new Set(ses.map((s) => s.target.text)).size === ses.length);
}
console.log(failures ? `\n${failures} FAILED` : '\nall listen tests passed');
process.exit(failures ? 1 : 0);
