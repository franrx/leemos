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

// The screen. ctx: { doc, $, S, t, fmt, rnd, nm, say, lumiPlay, sayLumi, sfx, poke, sparkle, later, earnSticker, showReward, refresh, pathPos, levels, save, rng }
export function createFind(ctx) {
  const { doc, $, S, t, fmt, rnd, nm, say, lumiPlay, sayLumi, sfx, poke, sparkle, later, earnSticker, showReward, refresh, pathPos, levels, save, rng = Math.random } = ctx;
  const room = $('findRoom'), html = doc.documentElement;
  let game = null, page = 0, found = 0, over = false, gen = 0; // gen: a pending "next page" from a game that was left must not act
  const letters = () => (pathPos() >= 12 ? BOOK : [STEPS[pathPos() - 1]]);
  const canPlay = () => { const w = wordsOf(levels()); return letters().every((l) => pool(w, l).length > OTHERS); };
  const getPool = (r) => pool(wordsOf(levels()), pathPos() >= 12 ? BOOK[Math.floor(r() * BOOK.length)] : STEPS[pathPos() - 1]);
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  function leave() { gen++; game = null; room.hidden = true; room.innerHTML = ''; html.classList.remove('find'); }

  function begin() {
    gen++;
    if (!canPlay()) { leave(); return false; }
    game = makeGame(getPool, rng); page = 0; over = false;
    if (!game.length) { leave(); return false; }
    html.classList.add('find'); room.hidden = false; room.classList.toggle('upper', !!S.upper);
    render(true);
    return true;
  }

  function render(first) {
    found = 0;
    const p = game[page];
    room.innerHTML = '';
    const dots = el('div', 'find-dots'); dots.setAttribute('role', 'img'); dots.setAttribute('aria-label', t('findGoal', { i: page + 1, n: game.length }));
    for (let i = 0; i < game.length; i++) dots.appendChild(el('i', i < page ? 'on' : ''));
    const target = el('button', 'find-target', p.target.text); target.setAttribute('aria-label', t('findHear') + ': ' + p.target.text); target.onclick = () => say(p.target.text);
    const grid = el('div', 'find-grid');
    p.tiles.forEach((tile) => { const b = el('button', 'find-tile', tile.text); b.setAttribute('aria-pressed', 'false'); b.onclick = () => tap(b, tile); grid.appendChild(b); });
    room.append(dots, target, grid);
    $('hint').textContent = t('findIntro');
    if (first) { if (S.sound) lumiPlay(t('findIntro'), false); } // only a clip: without one it is silent
    else target.focus(); // a new page must not drop the keyboard onto the page
  }

  function tap(b, tile) {
    if (!game || over || found >= 3 || b.classList.contains('found')) return;
    if (tile.copy) {
      b.classList.add('found'); b.setAttribute('aria-pressed', 'true');
      sfx.ok(); say(tile.text); found++;
      if (found === 3) {
        const g = gen;
        poke('cheer', 900); sparkle(b, 10);
        $('hint').textContent = fmt(rnd(t('oks')));
        later(() => { if (g !== gen) return; page++; page < game.length ? render(false) : finish(); }, 1100);
      }
    } else {
      b.classList.add('wobble'); later(() => b.classList.remove('wobble'), 500);
    }
  }

  function finish() {
    over = true;
    const reward = earnSticker(); save(); refresh();
    const msg = t('findDone', { n: nm() });
    room.innerHTML = '';
    const again = el('button', 'btn primary', t('findAgain')); again.id = 'findAgain'; again.onclick = () => begin();
    room.append(el('p', 'find-done', msg), again);
    $('hint').textContent = msg;
    if (reward) later(() => showReward(reward), 500);
    else { again.focus(); sfx.win(); if (S.sound) sayLumi(msg); }
  }

  return { canPlay, begin, leave, active: () => !!game };
}
