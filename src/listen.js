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

// The screen. ctx: { doc, $, S, t, fmt, rnd, nm, say, part, lumiPlay, sayLumi, sfx, poke, sparkle, later, earnSticker, showReward, refresh, pathPos, levels, save, rng }
export function createListen(ctx) {
  const { doc, $, S, t, fmt, rnd, nm, say, part, lumiPlay, sayLumi, sfx, poke, sparkle, later, earnSticker, showReward, refresh, pathPos, levels, save, rng = Math.random } = ctx;
  const room = $('listenRoom'), html = doc.documentElement;
  let plan = null, idx = 0, over = false, gen = 0, advancing = false, talking = 0, idleT = 0, repeated = false;
  const idleMs = () => doc.defaultView.__leemosRescueMs || 3000;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const open = () => openWords(listenWords(levels()), pathPos());
  const canPlay = () => { const o = open(); return o.length >= MIN_OPEN && robotTargets(o).length >= MIN_OPEN; };

  function leave() { gen++; talking++; clearTimeout(idleT); plan = null; room.hidden = true; room.innerHTML = ''; html.classList.remove('listen'); }

  function begin() {
    gen++;
    if (!canPlay()) { leave(); return false; }
    plan = makeSession(open(), rng);
    if (!plan.length) { leave(); return false; }
    idx = 0; over = false;
    html.classList.add('listen'); room.hidden = false; room.classList.toggle('upper', !!S.upper);
    screen(true);
    return true;
  }

  // The robot says the syllables one after the other with a pause. Each call starts a new sounding-out and cancels the one still running (`talking` is its token).
  async function sound(parts, robot) {
    const my = ++talking, g = gen;
    for (let i = 0; i < parts.length; i++) {
      if (my !== talking || g !== gen) return;
      robot.classList.add('say');
      await part(partKeys(parts[i]));
      robot.classList.remove('say');
      if (my !== talking || g !== gen) return;
      await new Promise((r) => later(r, GAP));
    }
  }

  function armIdle(robot, parts) { // 3 s with no tap: the robot says it once more (once per screen, nothing recorded)
    clearTimeout(idleT);
    if (repeated || advancing || over) return;
    const g = gen;
    idleT = later(() => { if (g !== gen || repeated || advancing || over) return; repeated = true; sound(parts, robot); }, idleMs());
  }

  function screen(first) {
    gen++; advancing = false; repeated = false; clearTimeout(idleT);
    const p = plan[idx];
    room.innerHTML = '';
    const dots = el('div', 'listen-dots'); dots.setAttribute('role', 'img'); dots.setAttribute('aria-label', t('listenGoal', { i: idx + 1, n: plan.length }));
    for (let i = 0; i < plan.length; i++) dots.appendChild(el('i', i < idx ? 'on' : ''));
    const robot = el('button', 'listen-robot', '🤖'); robot.setAttribute('aria-label', t('listenRobot'));
    const grid = el('div', 'listen-cards');
    p.cards.forEach((w) => {
      const b = el('button', 'listen-card', w.emoji);
      b.dataset.w = w.text; b.dataset.parts = w.parts.join('-'); b.dataset.answer = String(w === p.target);
      b.onclick = () => tap(b, w, p, robot);
      grid.appendChild(b);
    });
    room.append(dots, robot, grid);
    $('hint').textContent = t('listenIntro');
    robot.onclick = () => { sound(p.target.parts, robot); armIdle(robot, p.target.parts); };
    if (first && S.sound) lumiPlay(t('listenIntro'), false); // only a clip: without one it is silent
    sound(p.target.parts, robot);
    armIdle(robot, p.target.parts);
  }

  function tap(b, w, p, robot) {
    if (!plan || over || advancing || b.classList.contains('found')) return;
    armIdle(robot, p.target.parts);
    if (w === p.target) {
      advancing = true; clearTimeout(idleT); talking++;
      b.classList.add('found'); sfx.ok(); say(w.text); poke('cheer', 900); sparkle(b, 10);
      $('hint').textContent = fmt(rnd(t('oks')));
      const g = gen;
      later(() => { if (g !== gen) return; idx++; idx < plan.length ? screen(false) : finishSession(); }, 1600);
    } else {
      b.classList.add('wobble'); later(() => b.classList.remove('wobble'), 500);
    }
  }

  function finishSession() {
    over = true; clearTimeout(idleT);
    const reward = earnSticker(); save(); refresh();
    const msg = t('listenDone', { n: nm() });
    room.innerHTML = '';
    const again = el('button', 'btn primary', t('listenAgain')); again.id = 'listenAgain'; again.onclick = () => begin();
    room.append(el('p', 'listen-done', msg), again);
    $('hint').textContent = msg;
    if (reward) later(() => showReward(reward), 500);
    else { again.focus(); sfx.win(); if (S.sound) sayLumi(msg); }
  }

  $('rewardOk').addEventListener('click', () => { if (!over) return; const g = gen; later(() => { const a = $('listenAgain'); if (g === gen && a) a.focus(); }, 0); }); // the reward closes: focus goes to "again"

  return { canPlay, begin, leave, active: () => !!plan, intro: 'listenIntro' };
}
