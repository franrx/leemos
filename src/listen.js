// "Escucha / Escolta": a robot sounds a word out syllable by syllable and she picks the picture (and, below, minimal pairs).
// Spec: docs/superpowers/specs/2026-10-21-listen-mode-design.md
import { stepOf } from './levelrule.js';
import { similarity, shuffle, closer } from './find.js';
import { splitClosed } from './close.js';

export const MIN_OPEN = 4, SCREENS = 6, GAP = 600; // GAP: milliseconds between two syllables

// Every word with a picture, once per text, with the Camino step it needs.
export function listenWords(levels) {
  const seen = new Set(), out = [];
  for (const L of levels) {
    for (const o of L.words) {
      const parts = o.w.toLowerCase().split('-'), text = parts.join('');
      if (!o.e || seen.has(text)) continue;
      seen.add(text);
      out.push({ text, parts, emoji: o.e, step: stepOf(parts.join('-')) });
    }
  }
  return out;
}
export const openWords = (words, pos) => words.filter((w) => w.step <= pos);
export const robotTargets = (words) => words.filter((w) => w.parts.length >= 2 && w.parts.length <= 3); // one syllable has nothing to blend

// The clip keys to try, in order, for one syllable: a closed syllable has a stretched clip ("~pas") for some words.
export const partKeys = (part) => (splitClosed(part) ? ['~' + part, part] : [part]);

// One robot screen: a target not in `exclude` and the 2 open words most like it, never the same text or picture. null when there is no free target or fewer than 3 pictures.
export function makeRobot(words, rng, exclude = new Set()) {
  const free = robotTargets(words).filter((w) => !exclude.has(w.text));
  if (!free.length) return null;
  const target = free[Math.floor(rng() * free.length)];
  const others = shuffle(words.filter((w) => w.text !== target.text && w.emoji !== target.emoji), rng) // the shuffle breaks ties
    .map((w) => ({ w, s: similarity(target, w) })).sort((a, b) => closer(a.s, b.s)).map((x) => x.w);
  const picked = [];
  for (const w of others) { if (!picked.some((p) => p.emoji === w.emoji)) picked.push(w); if (picked.length === 2) break; }
  if (picked.length < 2) return null;
  return { kind: 'robot', target, cards: shuffle([target, ...picked], rng) };
}

// Up to 6 robot screens with distinct targets (fewer when the open words run out).
export function makeSession(words, rng) {
  const used = new Set(), screens = [];
  while (screens.length < SCREENS) {
    const r = makeRobot(words, rng, used);
    if (!r) break;
    used.add(r.target.text); screens.push(r);
  }
  return screens;
}
