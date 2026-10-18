// Pure signal and statistics helpers for the voice-progress experiment (plan: docs/superpowers/plans/2026-10-17-voice-progress-experiment.md).
// No dependencies and no I/O: tests/labdsp.mjs drives them with synthetic signals, scripts/lab-analyze.mjs with real recordings.

const dbOf = (x) => 20 * Math.log10(Math.max(x, 1e-9));

// RMS of each non-overlapping frame of `ms` milliseconds (a trailing partial frame is dropped).
export function frames(pcm, rate, ms = 10) {
  const n = Math.round(rate * ms / 1000), out = [];
  for (let i = 0; i + n <= pcm.length; i += n) {
    let s = 0;
    for (let j = i; j < i + n; j++) s += pcm[j] * pcm[j];
    out.push(Math.sqrt(s / n));
  }
  return out;
}

// Voice activity by loudness. The noise floor is the 5th-percentile frame level, so it needs some silence before or after the voice
// (the recording page starts the microphone before the child answers, so there is). Speech = at least `minMs` of frames more than
// `marginDb` above the floor; bursts separated by no more than `maxGapMs` belong together, and anything later is not the reading
// (an adult's "muy bien" after it). Returns nulls when nothing qualifies.
export function vad(pcm, rate, { frameMs = 10, marginDb = 8, minMs = 60, maxGapMs = 700 } = {}) {
  const e = frames(pcm, rate, frameMs).map(dbOf);
  if (!e.length) return { onsetMs: null, offsetMs: null, peakDb: null, noiseDb: null, speechDb: null };
  const sorted = [...e].sort((a, b) => a - b);
  // never below -75 dB: generated clips contain exact digital silence (-180 dB), which would make every faint tail count as speech
  const noiseDb = Math.max(sorted[Math.floor(sorted.length * 0.05)], -75);
  const thr = noiseDb + marginDb, minFrames = Math.ceil(minMs / frameMs);
  const runs = [];
  for (let i = 0; i < e.length;) {
    if (e[i] <= thr) { i++; continue; }
    let j = i;
    while (j < e.length && e[j] > thr) j++;
    if (j - i >= minFrames) runs.push([i, j]);
    i = j;
  }
  const peakDb = Math.max(...e);
  if (!runs.length) return { onsetMs: null, offsetMs: null, peakDb, noiseDb, speechDb: null };
  const first = runs[0][0];
  let last = runs[0][1];
  for (const [a, b] of runs.slice(1)) { if ((a - last) * frameMs > maxGapMs) break; last = b; }
  const loud = e.slice(first, last).filter((x) => x > thr);
  return { onsetMs: first * frameMs, offsetMs: last * frameMs, peakDb, noiseDb, speechDb: loud.reduce((s, x) => s + x, 0) / loud.length };
}

// In-place radix-2 FFT.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
const hz2mel = (f) => 2595 * Math.log10(1 + f / 700), mel2hz = (m) => 700 * (10 ** (m / 2595) - 1);

// MFCC (25 ms windows every 10 ms, 26 mel filters, coefficients 1..13), with the clip's mean removed per coefficient, so that overall
// loudness and the microphone's colour do not count. The variance is left alone on purpose: scaling it up turned the tiny wobble of a
// steady sound into the whole signal. Returns one Float64Array per frame.
export function mfcc(pcm, rate, { winMs = 25, hopMs = 10, nMel = 26, nCoef = 13 } = {}) {
  const win = Math.round(rate * winMs / 1000), hop = Math.round(rate * hopMs / 1000);
  let nfft = 1; while (nfft < win) nfft <<= 1;
  const hamming = Float64Array.from({ length: win }, (_, i) => 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (win - 1)));
  const lo = hz2mel(60), hi = hz2mel(rate / 2);
  const pts = Array.from({ length: nMel + 2 }, (_, i) => mel2hz(lo + (hi - lo) * i / (nMel + 1)));
  const bins = pts.map((f) => Math.floor((nfft + 1) * f / rate));
  const fb = Array.from({ length: nMel }, (_, m) => {
    const w = new Float64Array(nfft / 2 + 1);
    for (let k = bins[m]; k < bins[m + 1]; k++) w[k] = (k - bins[m]) / Math.max(1, bins[m + 1] - bins[m]);
    for (let k = bins[m + 1]; k < bins[m + 2]; k++) w[k] = (bins[m + 2] - k) / Math.max(1, bins[m + 2] - bins[m + 1]);
    return w;
  });
  const out = [], energies = [];
  const re = new Float64Array(nfft), im = new Float64Array(nfft);
  let maxE = 0;
  for (let s = 0; s + win <= pcm.length; s += hop) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < win; i++) re[i] = (pcm[s + i] - (i ? 0.97 * pcm[s + i - 1] : 0)) * hamming[i];
    fft(re, im);
    const e = new Float64Array(nMel);
    for (let m = 0; m < nMel; m++) {
      for (let k = 0; k <= nfft / 2; k++) e[m] += fb[m][k] * (re[k] * re[k] + im[k] * im[k]);
      if (e[m] > maxE) maxE = e[m];
    }
    energies.push(e);
  }
  // Energies are floored 90 dB below the clip's loudest filter, so digital silence and faint tails do not become extreme features
  // that would dominate the distance.
  const floor = Math.max(maxE * 1e-9, 1e-20);
  for (const e of energies) {
    const c = new Float64Array(nCoef);
    for (let k = 1; k <= nCoef; k++) { let sum = 0; for (let m = 0; m < nMel; m++) sum += Math.log(Math.max(e[m], floor)) * Math.cos(Math.PI * k * (m + 0.5) / nMel); c[k - 1] = sum; }
    out.push(c);
  }
  for (let d = 0; d < nCoef && out.length; d++) {
    const mean = out.reduce((a, f) => a + f[d], 0) / out.length;
    for (const f of out) f[d] -= mean;
  }
  return out;
}

// Dynamic time warping distance between two MFCC sequences, divided by (n + m) so clips of different lengths compare.
export function dtw(a, b) {
  const n = a.length, m = b.length;
  if (!n || !m) return Infinity;
  const d = (x, y) => { let s = 0; for (let k = 0; k < x.length; k++) s += (x[k] - y[k]) ** 2; return Math.sqrt(s); };
  let prev = new Float64Array(m + 1).fill(Infinity), cur = new Float64Array(m + 1);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    cur[0] = Infinity;
    for (let j = 1; j <= m; j++) cur[j] = d(a[i - 1], b[j - 1]) + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    [prev, cur] = [cur, prev];
  }
  return prev[m] / (n + m);
}

// Area under the ROC curve: the chance that a random positive scores higher than a random negative (ties count half). labels: truthy = positive.
export function auc(scores, labels) {
  const n = scores.length;
  const pos = labels.filter(Boolean).length, neg = n - pos;
  if (!pos || !neg) return NaN;
  const order = scores.map((s, i) => i).sort((x, y) => (scores[x] < scores[y] ? -1 : scores[x] > scores[y] ? 1 : 0)); // not x - y: -Infinity - -Infinity is NaN
  const rank = new Float64Array(n);
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && scores[order[j + 1]] === scores[order[i]]) j++;
    for (let k = i; k <= j; k++) rank[order[k]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  let sum = 0;
  for (let i = 0; i < n; i++) if (labels[i]) sum += rank[i];
  return (sum - pos * (pos + 1) / 2) / (pos * neg);
}

const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// Percentile bootstrap interval of fn(data); the generator is seeded, so the same data gives the same interval.
export function bootstrapCI(fn, data, B = 2000, alpha = 0.05) {
  const rng = mulberry32(12345), vals = [];
  for (let b = 0; b < B; b++) {
    const sample = Array.from({ length: data.length }, () => data[Math.floor(rng() * data.length)]);
    const v = fn(sample);
    if (Number.isFinite(v)) vals.push(v);
  }
  if (!vals.length) return [NaN, NaN];
  vals.sort((x, y) => x - y);
  return [vals[Math.floor(alpha / 2 * vals.length)], vals[Math.min(vals.length - 1, Math.ceil((1 - alpha / 2) * vals.length) - 1)]];
}

// The same, but whole items are resampled (with all their readings): readings of one item are not independent, so resampling
// single readings gives intervals that are too narrow.
export function clusterBootstrapCI(fn, data, keyOf, B = 2000, alpha = 0.05) {
  const groups = new Map();
  for (const d of data) { const k = keyOf(d); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(d); }
  const clusters = [...groups.values()];
  const rng = mulberry32(12345), vals = [];
  for (let b = 0; b < B; b++) {
    const sample = [];
    for (let i = 0; i < clusters.length; i++) sample.push(...clusters[Math.floor(rng() * clusters.length)]);
    const v = fn(sample);
    if (Number.isFinite(v)) vals.push(v);
  }
  if (!vals.length) return [NaN, NaN];
  vals.sort((x, y) => x - y);
  return [vals[Math.floor(alpha / 2 * vals.length)], vals[Math.min(vals.length - 1, Math.ceil((1 - alpha / 2) * vals.length) - 1)]];
}

// Removes each item's own typical value (its mean over finite readings) so that "this item is long / hard / has a different reference
// clip" cannot pass for a signal. An item with a single finite reading becomes 0; infinities are left alone.
export function centerBy(values, keys) {
  const sum = new Map(), cnt = new Map();
  values.forEach((v, i) => { if (Number.isFinite(v)) { sum.set(keys[i], (sum.get(keys[i]) || 0) + v); cnt.set(keys[i], (cnt.get(keys[i]) || 0) + 1); } });
  return values.map((v, i) => (!Number.isFinite(v) ? v : cnt.get(keys[i]) < 2 ? 0 : v - sum.get(keys[i]) / cnt.get(keys[i])));
}

export function pearson(x, y) {
  const n = x.length;
  if (n < 2) return NaN;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}
const ranks = (v) => {
  const order = v.map((x, i) => i).sort((a, b) => (v[a] < v[b] ? -1 : v[a] > v[b] ? 1 : 0)), r = new Array(v.length);
  for (let i = 0; i < v.length;) { let j = i; while (j + 1 < v.length && v[order[j + 1]] === v[order[i]]) j++; for (let k = i; k <= j; k++) r[order[k]] = (i + j) / 2 + 1; i = j + 1; }
  return r;
};
export const spearman = (x, y) => pearson(ranks(x), ranks(y));

// Text matching for the recogniser: what Whisper wrote against what was shown.
export const normText = (s) => String(s || '').toLowerCase().replace(/ñ/g, 'ny').replace(/ç/g, 'ss').normalize('NFD').replace(/[^a-z0-9]/g, '');
export function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
