// Unit tests for the pure part of the listen mode (src/listen.js). Plain Node, no DOM.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClipList } from '../scripts/lib/clips.mjs';
import { MIN_OPEN, SCREENS, GAP, listenWords, openWords, robotTargets, makeRobot, partKeys, makeSession, validPair, openPairs, makePair } from '../src/listen.js';

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
check('validPair: pata/pasta is a pair; pala/palma and sala/salsa are not (no coda to drop)', validPair({ a: 'pa-ta', ea: '🐾', b: 'pas-ta', eb: '🍝' }).length === 0 && validPair({ a: 'pa-la', ea: '🪏', b: 'pal-ma', eb: '🌴' }).length > 0 && validPair({ a: 'sa-la', ea: '🏠', b: 'sal-sa', eb: '🥫' }).length > 0);
check('validPair: same picture twice, a missing picture, or a trill/geminate coda is rejected', validPair({ a: 'pa-ta', ea: '🐾', b: 'pas-ta', eb: '🐾' }).length > 0 && validPair({ a: 'pa-ta', ea: '', b: 'pas-ta', eb: '🍝' }).length > 0 && validPair({ a: 'go-ro', ea: '🧢', b: 'gor-ro', eb: '👒' }).length > 0);
for (const lang of ['es', 'ca']) {
  const pairs = readJSON(`src/data/pairs.${lang}.json`);
  check(`[${lang}] pairs file: every pair is valid`, Array.isArray(pairs) && pairs.length >= 1 && pairs.every((p) => validPair(p).length === 0), pairs.map((p) => validPair(p).join(';')).join('|'));
  check(`[${lang}] openPairs: none open at step 1, all of them at step 12`, openPairs(pairs, 1).length === 0 && openPairs(pairs, 12).length === pairs.length);
}
for (const lang of ['es', 'ca']) {
  const keys = new Set(buildClipList({ langs: [lang] }).map((c) => c.key));
  const need = readJSON(`src/data/pairs.${lang}.json`).flatMap((p) => [p.a, p.b]).flatMap((h) => [h.replace(/-/g, ''), ...h.split('-')]);
  check(`[${lang}] clip list: every pair word and syllable has a clip`, need.every((k) => keys.has(k.toLowerCase())), need.filter((k) => !keys.has(k.toLowerCase())).join(','));
  const i18n = readJSON(`src/data/i18n.${lang}.json`);
  check(`[${lang}] clip list: Lumi's listen sentences are clips`, ['listenIntro', 'listenPairHint'].every((k) => i18n[k] && keys.has(i18n[k].toLowerCase())));
}
{
  const pairs = openPairs(readJSON('src/data/pairs.es.json'), 12);
  const words = openWords(listenWords(readJSON('src/data/levels.es.json')), 12);
  let ok = true;
  for (let s = 1; s <= 100 && ok; s++) { const r = makePair(pairs, mulberry(s), new Set()); ok = !!r && r.cards.length === 2 && r.cards.every((c) => c.emoji) && r.cards[0].emoji !== r.cards[1].emoji && r.cards.some((c) => c.text === r.printed.text) && r.answer.text === r.printed.text; }
  check('makePair: two pictures, one of them is the printed word, never the same picture', ok);
  const sides = new Set(), printed = new Set(); for (let s = 1; s <= 60; s++) { const r = makePair(pairs, mulberry(s), new Set()); sides.add(r.cards[0].text); printed.add(r.printed.text); }
  check('makePair: which twin is printed and which side it is on both vary', sides.size > 1 && printed.size > 1);
  check('makePair: null when every pair is excluded', makePair(pairs, mulberry(1), new Set(pairs.map((p) => p.id))) === null);
  const full = makeSession(words, mulberry(2), pairs);
  check('makeSession: with 2+ open pairs, 4 robot then 2 pair screens (distinct pairs)', full.length === 6 && full.slice(0, 4).every((s) => s.kind === 'robot') && full.slice(4).every((s) => s.kind === 'pair') && new Set(full.slice(4).map((s) => s.pair.id)).size === 2);
  check('makeSession: with fewer than 2 open pairs, all robot', makeSession(words, mulberry(2), pairs.slice(0, 1)).every((s) => s.kind === 'robot') && makeSession(words, mulberry(2)).every((s) => s.kind === 'robot'));
}
check('partKeys: a closed syllable followed by its own coda letter (a trill or a geminate) is not stretched: bar-ret, tas-sa, tor-re', JSON.stringify(partKeys('bar', 'ret')) === '["bar"]' && JSON.stringify(partKeys('tas', 'sa')) === '["tas"]' && JSON.stringify(partKeys('tor', 're')) === '["tor"]' && JSON.stringify(partKeys('pas', 'ta')) === '["~pas","pas"]');
for (const lang of ['es', 'ca']) {
  const bad = listenWords(readJSON(`src/data/levels.${lang}.json`)).flatMap((w) => w.parts.map((p, i) => [p, w.parts[i + 1], w.text])).filter(([p, n]) => partKeys(p, n)[0].startsWith('~') && n && n[0] === p[p.length - 1]);
  check(`[${lang}] partKeys: no word of the real data stretches a coda that starts the next syllable`, bad.length === 0, bad.map((b) => b[2]).join(','));
}
{
  const pairs = openPairs(readJSON('src/data/pairs.es.json'), 12);
  const words = openWords(listenWords(readJSON('src/data/levels.es.json')), 12);
  let clash = 0; for (let sd = 1; sd <= 150; sd++) { const ses = makeSession(words, mulberry(sd), pairs), pw = new Set(ses.filter((x) => x.kind === 'pair').flatMap((x) => [x.pair.a.text, x.pair.b.text])); for (const sc of ses) if (sc.kind === 'robot' && pw.has(sc.target.text)) clash++; }
  check('makeSession: a word of the pair screens is never also a robot target in the same session', clash === 0, 'clashes=' + clash);
}
console.log(failures ? `\n${failures} FAILED` : '\nall listen tests passed');
process.exit(failures ? 1 : 0);
