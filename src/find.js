// "Busca la paraula": the pure choice of the tiles and (below) the game screen.
// Spec: docs/superpowers/specs/2026-10-18-busca-la-paraula-design.md
import { letterOf, STEPS } from './levelrule.js';

export const COPIES = 3, OTHERS = 9, PAGES = 5;
export const BOOK = STEPS.slice(0, 11); // the 11 letters of the school book (the last step, "el resto", has no letter)

export const wordsOf = (levels) => levels.flatMap((l) => l.words.map((o) => ({ text: o.w.replace(/-/g, '').toLowerCase(), parts: o.w.toLowerCase().split('-') })));

// Every word that starts with `letter`, from every level, once per text. The Camino's "open" filter is not applied: finding a copy is matching, not decoding.
export function pool(words, letter) {
  const seen = new Set(), out = [];
  for (const w of words) {
    if (letterOf(w.text) !== letter || seen.has(w.text)) continue;
    seen.add(w.text); out.push(w);
  }
  return out;
}

export function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// Higher = easier to confuse with `a`. Compared lexicographically: same first syllable, same length, then the fewest letter differences.
export const similarity = (a, b) => [a.parts[0] === b.parts[0] ? 1 : 0, a.text.length === b.text.length ? 1 : 0, -editDistance(a.text, b.text)];
const closer = (x, y) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; };

export function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// One page: a target not in `exclude` and the 9 closest other words, as 12 shuffled tiles (3 copies of the target). null when the pool is too small or has no free target.
export function makePage(words, rng, exclude = new Set()) {
  if (words.length < OTHERS + 1) return null;
  const free = words.filter((w) => !exclude.has(w.text));
  if (!free.length) return null;
  const target = free[Math.floor(rng() * free.length)];
  const others = shuffle(words.filter((w) => w.text !== target.text), rng) // the shuffle breaks ties between equally close words
    .map((w) => ({ w, s: similarity(target, w) })).sort((a, b) => closer(a.s, b.s)).slice(0, OTHERS).map((x) => x.w);
  const tiles = shuffle([...Array(COPIES).fill(target), ...others], rng).map((w, i) => ({ id: i, text: w.text, parts: w.parts, copy: w.text === target.text }));
  return { target, tiles };
}

// getPool(rng) is asked once per page (the last Camino step draws a different letter each time). Pages with a target already used are skipped by `exclude`.
export function makeGame(getPool, rng, n = PAGES) {
  const used = new Set(), pages = [];
  for (let i = 0; i < n; i++) {
    const p = makePage(getPool(rng), rng, used);
    if (!p) break;
    used.add(p.target.text); pages.push(p);
  }
  return pages;
}
