// Tests for the pure signal helpers of the voice-progress experiment (scripts/lib/labdsp.mjs), on synthetic signals only.
import { frames, vad, mfcc, dtw, auc, bootstrapCI, spearman, pearson, editDistance, normText } from '../scripts/lib/labdsp.mjs';

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const RATE = 16000;
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const noise = (ms, amp) => Float32Array.from({ length: Math.round(RATE * ms / 1000) }, () => (rnd() * 2 - 1) * amp);
const cat = (...parts) => { const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const tone = (hz, ms, amp) => Float32Array.from({ length: Math.round(RATE * ms / 1000) }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / RATE));
// A vowel-like sound: harmonics of f0 shaped by two formants, with a soft fade in and out. Different (f1, f2) = a different vowel.
const vowel = (f1, f2, f0, ms) => {
  const n = Math.round(RATE * ms / 1000), out = new Float32Array(n);
  for (let k = 1; k * f0 < 4000; k++) {
    const a = Math.exp(-(((k * f0 - f1) / 150) ** 2)) + 0.7 * Math.exp(-(((k * f0 - f2) / 250) ** 2)) + 0.03;
    for (let i = 0; i < n; i++) out[i] += a * Math.sin(2 * Math.PI * k * f0 * i / RATE);
  }
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i]));
  for (let i = 0; i < n; i++) out[i] *= 0.4 * Math.sin(Math.PI * i / n) ** 0.5 / pk;
  return out;
};
const A = (f0, ms) => vowel(700, 1200, f0, ms), I = (f0, ms) => vowel(300, 2300, f0, ms);

// ---------- frames ----------
check('frames: one RMS value per 10 ms and the right level', frames(tone(440, 1000, 0.5), RATE, 10).length === 100 && Math.abs(frames(tone(440, 1000, 0.5), RATE, 10)[50] - 0.5 / Math.SQRT2) < 0.01);

// ---------- vad ----------
let sig = cat(noise(500, 0.001), tone(300, 400, 0.3), noise(300, 0.001));
let v = vad(sig, RATE);
check('vad: a tone burst starting at 500 ms is found within 20 ms', v.onsetMs !== null && Math.abs(v.onsetMs - 500) <= 20, JSON.stringify(v));
check('vad: and ends near 900 ms', Math.abs(v.offsetMs - 900) <= 30, String(v.offsetMs));
check('vad: it reports the noise floor and a speech level well above it', v.noiseDb < -50 && v.speechDb - v.noiseDb > 30, `${v.noiseDb} ${v.speechDb}`);
v = vad(new Float32Array(RATE), RATE);
check('vad: pure silence has no onset', v.onsetMs === null && v.offsetMs === null);
v = vad(noise(1000, 0.05), RATE);
check('vad: constant background noise has no onset', v.onsetMs === null);
v = vad(cat(noise(300, 0.001), tone(300, 30, 0.3), noise(500, 0.001)), RATE);
check('vad: a 30 ms click is not speech', v.onsetMs === null);
v = vad(cat(noise(300, 0.001), tone(300, 200, 0.3), noise(300, 0.001), tone(500, 200, 0.3), noise(300, 0.001)), RATE);
check('vad: with two bursts the onset is the first and the offset the end of the last', Math.abs(v.onsetMs - 300) <= 20 && Math.abs(v.offsetMs - 1000) <= 30, JSON.stringify(v));
v = vad(cat(noise(1000, 0.001), tone(300, 100, 0.01)), RATE);
check('vad: a quiet voice 20 dB above the floor is still found', v.onsetMs !== null && Math.abs(v.onsetMs - 1000) <= 20);

// ---------- mfcc and dtw ----------
const m = mfcc(A(150, 400), RATE);
check('mfcc: 10 ms hop and 13 coefficients, normalised to zero mean', m.length > 35 && m.length < 45 && m[0].length === 13 && m[0].every((_, d) => Math.abs(m.reduce((s, f) => s + f[d], 0) / m.length) < 1e-6));
check('dtw: a clip against itself is about zero', dtw(m, m) < 1e-9);
const dAA = dtw(mfcc(A(120, 400), RATE), mfcc(A(120, 650), RATE));
const dAI = dtw(mfcc(A(120, 400), RATE), mfcc(I(120, 400), RATE));
check('dtw: the same sound stretched in time is clearly closer than another vowel (same pitch)', dAA < dAI * 0.8, `${dAA.toFixed(3)} vs ${dAI.toFixed(3)}`);
// OBSERVATION, not a requirement: with these clean synthetic harmonics a pitch change moves the MFCCs more than a vowel change does
// (same vowel at f0 260 vs 120 came out farther than another vowel). Real voices decide whether this matters; the adult control in the plan tests it
// across two different speakers (Fran against the generated reference voice) before any child is recorded.
const dHigh = dtw(mfcc(A(120, 400), RATE), mfcc(A(260, 450), RATE));
const dHighI = dtw(mfcc(A(120, 400), RATE), mfcc(I(260, 450), RATE));
console.log(`INFO  synthetic pitch sensitivity: same vowel at f0 260 = ${dHigh.toFixed(2)}, other vowel at f0 260 = ${dHighI.toFixed(2)} (${dHigh < dHighI ? 'vowel identity wins' : 'pitch dominates'})`);
check('dtw: an empty clip is infinitely far', dtw([], m) === Infinity);
// Real references are generated audio with exact digital silence around the sound. After trimming to the speech, the amount of silence must not matter.
const speechOnly = (pcm) => { const x = vad(pcm, RATE); return pcm.slice(Math.round(x.onsetMs * RATE / 1000), Math.round(x.offsetMs * RATE / 1000)); };
const zeros = (ms) => new Float32Array(Math.round(RATE * ms / 1000));
const core = A(180, 420);
const p1 = speechOnly(cat(zeros(200), core, zeros(300))), p2 = speechOnly(cat(zeros(900), core, zeros(50)));
check('dtw: the same sound inside different amounts of digital silence is the same after trimming', dtw(mfcc(p1, RATE), mfcc(p2, RATE)) < 1e-6, String(dtw(mfcc(p1, RATE), mfcc(p2, RATE))));
check('vad: digital silence around a sound does not make faint tails count as speech', Math.abs(vad(cat(zeros(400), core, zeros(400)), RATE).onsetMs - 400) <= 20 && vad(cat(zeros(400), core, zeros(400)), RATE).offsetMs <= 880);

// ---------- auc, bootstrap, correlation ----------
check('auc: perfectly separated is 1, inverted is 0, identical scores 0.5', auc([1, 2, 3, 4], [0, 0, 1, 1]) === 1 && auc([4, 3, 2, 1], [0, 0, 1, 1]) === 0 && auc([5, 5, 5, 5], [0, 1, 0, 1]) === 0.5);
check('auc: a mixed case is the share of correctly ordered pairs', auc([1, 3, 2, 4], [0, 0, 1, 1]) === 0.75 && Math.abs(auc([1, 2, 2, 3], [0, 0, 1, 1]) - 0.875) < 1e-12);
check('auc: one class missing is not a number', Number.isNaN(auc([1, 2], [1, 1])) && Number.isNaN(auc([], [])));
const data = Array.from({ length: 100 }, (_, i) => i);
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const ci = bootstrapCI(mean, data, 1000);
check('bootstrapCI: brackets the true mean with a sensible width and is repeatable', ci[0] < 49.5 && ci[1] > 49.5 && ci[1] - ci[0] > 3 && ci[1] - ci[0] < 14 && JSON.stringify(ci) === JSON.stringify(bootstrapCI(mean, data, 1000)), JSON.stringify(ci));
const perfect = Array.from({ length: 60 }, (_, i) => ({ s: i, l: i >= 30 ? 1 : 0 }));
const ciA = bootstrapCI((d) => auc(d.map((x) => x.s), d.map((x) => x.l)), perfect, 500);
check('bootstrapCI: a perfect AUC has an interval at 1', ciA[0] === 1 && ciA[1] === 1);
check('spearman: monotone is 1, reversed is -1, ties are handled', Math.abs(spearman([1, 2, 3, 4], [10, 20, 30, 41]) - 1) < 1e-12 && Math.abs(spearman([1, 2, 3, 4], [4, 3, 2, 1]) + 1) < 1e-12 && Math.abs(spearman([1, 1, 2, 2], [1, 1, 2, 2]) - 1) < 1e-12);
check('pearson: a line is 1 and no variation is not a number', Math.abs(pearson([1, 2, 3], [2, 4, 6]) - 1) < 1e-12 && Number.isNaN(pearson([1, 1, 1], [1, 2, 3])));

// ---------- text matching for the recogniser ----------
check('normText: lowercase, no accents, no punctuation or spaces', normText(' ¿Má? ') === 'ma' && normText('PA.') === 'pa' && normText('Ñu') === 'nyu' && normText('') === '');
check('editDistance: identical 0, one change 1, insertion 1, empty vs word its length', editDistance('ma', 'ma') === 0 && editDistance('ma', 'mu') === 1 && editDistance('ma', 'mas') === 1 && editDistance('', 'casa') === 4);

console.log(failures ? `\n${failures} labdsp test(s) FAILED` : '\nAll labdsp tests passed');
process.exit(failures ? 1 : 0);
