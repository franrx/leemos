// Unit tests for the pure part of "Busca la paraula" (src/find.js). Plain Node, no DOM.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COPIES, OTHERS, PAGES, BOOK, wordsOf, pool, editDistance, similarity, shuffle, makePage, makeGame } from '../src/find.js';
import { STEPS } from '../src/levelrule.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const mulberry = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const W = (s) => ({ text: s.replace(/-/g, ''), parts: s.split('-') });

check('constants: 3 copies, 9 others, 5 pages, 11 book letters, 12 Camino steps', COPIES === 3 && OTHERS === 9 && PAGES === 5 && BOOK.join('') === 'mplntsfbdrc' && STEPS.length === 12);
check('editDistance: identical 0, one substitution 1, insertion 1, empty to word = its length', editDistance('mano', 'mano') === 0 && editDistance('mano', 'mono') === 1 && editDistance('mano', 'manos') === 1 && editDistance('', 'casa') === 4);

const SYN = ['ma-no', 'ma-pa', 'ma-ta', 'me-sa', 'mo-no', 'mi-ra', 'mu-la', 'ma-le-ta', 'mo-ne-da', 'ma-ri-po-sa', 'me-lo-co-tón', 'mu-ñe-ca'].map(W);
const onlyMano = new Set(SYN.map((w) => w.text).filter((x) => x !== 'mano')); // forces the target
const pg = makePage(SYN, mulberry(1), onlyMano);
const texts = pg.tiles.map((x) => x.text);
check('page: 12 tiles, exactly 3 copies of the target and 9 other distinct words', pg.tiles.length === 12 && pg.target.text === 'mano' && texts.filter((x) => x === 'mano').length === 3 && new Set(texts.filter((x) => x !== 'mano')).size === 9);
check('page: only the copies are flagged as copies, and every tile has a different id', pg.tiles.every((x) => x.copy === (x.text === 'mano')) && new Set(pg.tiles.map((x) => x.id)).size === 12);
check('page: the closest words are chosen (same first syllable and length first) and the farthest is left out', ['mapa', 'mata', 'mono'].every((x) => texts.includes(x)) && !texts.includes('melocotón'));
const a1 = JSON.stringify(makePage(SYN, mulberry(5)));
check('page: the same seed gives the same page', a1 === JSON.stringify(makePage(SYN, mulberry(5))));
check('page: a different seed shuffles the tiles differently', JSON.stringify(makePage(SYN, mulberry(5)).tiles.map((x) => x.text)) !== JSON.stringify(makePage(SYN, mulberry(6)).tiles.map((x) => x.text)));
check('page: a pool of exactly 10 still makes a page', makePage(SYN.slice(0, 10), mulberry(2)) !== null);
check('page: a pool of 9 is refused', makePage(SYN.slice(0, 9), mulberry(2)) === null);
check('page: a target already used is not drawn again, and with none left there is no page', makePage(SYN.slice(0, 10), mulberry(2), new Set(SYN.slice(0, 10).map((x) => x.text))) === null);
check('pool: the same word in two levels counts once, and other letters are left out', pool([W('ma-no'), W('ma-no'), W('me-sa'), W('so-pa')], 'm').map((x) => x.text).join() === 'mano,mesa');
check('similarity: a word sharing the first syllable ranks above one that does not', similarity(W('ma-no'), W('ma-pa'))[0] > similarity(W('ma-no'), W('mo-no'))[0]);

let calls = 0;
const game = makeGame(() => { calls++; return SYN.slice(0, 12); }, mulberry(3));
check('game: 5 pages with 5 different targets, the pool asked once per page', game.length === 5 && new Set(game.map((p) => p.target.text)).size === 5 && calls === 5);
check('game: a pool that cannot make a page gives an empty game', makeGame(() => SYN.slice(0, 9), mulberry(3)).length === 0);
check('shuffle: keeps the same items and does not touch the input', (() => { const a = [1, 2, 3, 4, 5]; const s = shuffle(a, mulberry(1)); return a.join() === '1,2,3,4,5' && s.slice().sort().join() === '1,2,3,4,5'; })());

// the real data, both languages, every letter of the book
for (const lang of ['es', 'ca']) {
  const words = wordsOf(readJSON(`src/data/levels.${lang}.json`));
  const bad = [];
  for (const L of BOOK) {
    const p = pool(words, L);
    if (p.length < 10) { bad.push(`${L}: pool ${p.length}`); continue; }
    if (new Set(p.map((x) => x.text)).size !== p.length) bad.push(`${L}: duplicates in the pool`);
    for (let seed = 1; seed <= 20; seed++) {
      const g = makePage(p, mulberry(seed));
      const xs = g.tiles.map((x) => x.text);
      if (g.tiles.length !== 12 || xs.filter((x) => x === g.target.text).length !== 3 || new Set(xs).size !== 10) bad.push(`${L}/${seed}: wrong shape`);
      if (!g.tiles.every((x) => p.some((q) => q.text === x.text))) bad.push(`${L}/${seed}: a tile is not from the pool`);
    }
  }
  check(`[${lang}] every book letter has a pool of at least 10 and makes valid pages`, bad.length === 0, bad.slice(0, 3).join(' | '));
  check(`[${lang}] a pool holds only words that start with its letter`, pool(words, 'm').every((x) => x.text[0] === 'm') && pool(words, 'p').every((x) => x.text[0] === 'p'));
}

const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
check('service worker: src/find.js is cached with the shell and the version was bumped', /'src\/find\.js'/.test(sw) && /VERSION = 'leemos-v6'/.test(sw));
const es = readJSON('src/data/i18n.es.json'), ca = readJSON('src/data/i18n.ca.json');
const KEYS = ['mFind', 'findLocked', 'findIntro', 'findGoal', 'findAgain', 'findDone', 'findHear'];
check('i18n: every Busca la paraula key exists in both languages and is not empty', KEYS.every((k) => typeof es[k] === 'string' && es[k] && typeof ca[k] === 'string' && ca[k]));

console.log(failures ? `\n${failures} find test(s) FAILED` : '\nAll find tests passed');
process.exit(failures ? 1 : 0);
