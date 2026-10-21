// Lumi's idle life: a repertoire of small acts (CSS classes `act-<name>` on his svg, see styles.css) played at random while he is not talking,
// and a gaze that follows where she taps. No DOM work beyond classes and two custom properties, so it is easy to test.
// The art and the keyframes live in styles.css / index.html; this file only decides WHEN.

export const ACTS = { look: 2400, tilt: 2000, twitch: 600, wing: 1100, shake: 650, hop: 850, yawn: 2500, giggle: 950, wow: 1100, bounce: 1400, wiggle: 900, twinkle: 1200, peek: 1800 }; // name -> milliseconds the class stays on
const WEIGHTS = { look: 3, tilt: 2, twitch: 3, wing: 2, shake: 1, hop: 2, yawn: 1, wow: 1, bounce: 2, wiggle: 2, twinkle: 2, peek: 2 }; // giggle is only for a tap on him
const clamp = (v) => Math.max(-1, Math.min(1, v));

// A random act that is not `last` (he never does the same thing twice in a row).
export function pickAct(rng, last) {
  const bag = [];
  for (const [k, w] of Object.entries(WEIGHTS)) if (k !== last) for (let i = 0; i < w; i++) bag.push(k);
  return bag[Math.floor(rng() * bag.length)];
}

// svg: his element. Options: rng, later(fn, ms) -> id, clear(id), canAct() (false while he talks or a screen covers him), reduced() (prefers-reduced-motion), minMs/maxMs between acts.
export function lumiLife(svg, { rng = Math.random, later = (f, ms) => setTimeout(f, ms), clear = (id) => clearTimeout(id), canAct = () => true, reduced = () => false, minMs = 3000, maxMs = 6500 } = {}) {
  let timer = 0, gazeT = 0, running = false, last = '';
  const act = (name) => {
    if (!ACTS[name] || reduced()) return false;
    const cls = 'act-' + name;
    svg.classList.remove(cls); // asking again restarts it
    void (svg.getBoundingClientRect && svg.getBoundingClientRect());
    svg.classList.add(cls);
    later(() => svg.classList.remove(cls), ACTS[name]);
    return true;
  };
  const tick = () => {
    if (!running) return;
    if (canAct() && !reduced()) { last = pickAct(rng, last); act(last); }
    timer = later(tick, minMs + rng() * (maxMs - minMs));
  };
  // Looks at (x, y), each from -1 to 1 (left/up to right/down), and goes back to the mood's own gaze after `hold` ms.
  const look = (x, y, hold = 1800) => {
    svg.style.setProperty('--lx', String(clamp(x)));
    svg.style.setProperty('--ly', String(clamp(y)));
    clear(gazeT);
    gazeT = later(() => { svg.style.removeProperty('--lx'); svg.style.removeProperty('--ly'); }, hold);
  };
  const start = () => { if (running) return; running = true; timer = later(tick, minMs + rng() * (maxMs - minMs)); };
  const stop = () => { running = false; clear(timer); clear(gazeT); };
  return { start, stop, act, look };
}

// His eyes follow the mouse and glance at every tap (a finger on an iPad has no hover: the tap is what he looks at).
export function followPointer(doc, svg, life, { reach = 320 } = {}) {
  const aim = (e, hold) => {
    const r = svg.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    life.look((e.clientX - cx) / reach, (e.clientY - cy) / reach, hold);
  };
  doc.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') aim(e, 2500); }, { passive: true });
  doc.addEventListener('pointerdown', (e) => aim(e, 1800), { passive: true });
}
