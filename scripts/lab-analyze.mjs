// Analysis for the voice-progress experiment (plan: docs/superpowers/plans/2026-10-17-voice-progress-experiment.md).
//   node scripts/lab-analyze.mjs [session ...] [--lab-dir lab] [--audio-dir audio] [--asr small|base|none] [--out lab]
// Reads lab/<session>/<n>.webm + labels.jsonl (written by tools/lab.html), computes timing, similarity to the app's reference clip and
// (optionally) what Whisper heard, and writes <out>/report.md and <out>/readings.csv with the decision rule applied line by line.
// Needs ffmpeg, and the `whisper` CLI only for --asr small|base. The recogniser's copies of her voice always stay under <lab-dir>/asr.
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/clips.mjs';
import { vad, mfcc, dtw, auc, clusterBootstrapCI, centerBy, pearson, spearman, normText, editDistance } from './lib/labdsp.mjs';

const RATE = 16000;
const LATE_START_MS = 400; // a recorder that took longer than this to start may have missed the beginning of the answer
const PAD_MS = 0; // silence around the sound would shift the clip's feature mean: compare the sounds only

function decode(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ar', String(RATE), '-ac', '1', '-f', 'f32le', '-'], { maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout || r.stdout.length < 4) return null;
  const b = r.stdout;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength - (b.byteLength % 4)));
}

function loadReadings(labDir, sessions, warnings) {
  const out = [];
  for (const session of sessions) {
    const f = join(labDir, session, 'labels.jsonl');
    if (!existsSync(f)) { warnings.push(`session ${session}: no labels.jsonl, skipped`); continue; }
    const byN = new Map();
    for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
      try { const o = JSON.parse(line); byN.set(o.n, o); } catch { warnings.push(`session ${session}: a label line is not JSON, skipped`); }
    } // a repeated reading number overwrites the earlier one: the last label belongs to the audio that is on disk
    for (const [n, label] of byN) {
      const file = join(labDir, session, `${n}.webm`);
      if (!existsSync(file)) { warnings.push(`session ${session} #${n}: label without audio, skipped`); continue; }
      out.push({ ...label, session, n, file });
    }
  }
  return out;
}

function referenceOf(audioDir, manifest, r) {
  const rel = manifest && manifest.clips && manifest.clips[r.lang] && manifest.clips[r.lang][r.text];
  if (!rel) return null;
  const f = join(audioDir, r.lang, rel);
  return existsSync(f) ? decode(f) : null;
}

const trim = (pcm, v) => (v.onsetMs === null ? pcm : pcm.slice(Math.max(0, Math.round((v.onsetMs - PAD_MS) * RATE / 1000)), Math.round((v.offsetMs + PAD_MS) * RATE / 1000)));

function measure(r, audioDir, manifest, refCache) {
  const pcm = decode(r.file);
  if (!pcm) return null;
  const v = vad(pcm, RATE);
  const m = { latencyMs: v.onsetMs, durMs: v.onsetMs === null ? null : v.offsetMs - v.onsetMs, snrDb: v.onsetMs === null ? null : v.speechDb - v.noiseDb, peakDb: v.peakDb, dtwDist: null, noSpeech: v.onsetMs === null, clipMs: pcm.length * 1000 / RATE };
  const refKey = `${r.lang}/${r.text}`;
  if (!refCache.has(refKey)) { const ref = referenceOf(audioDir, manifest, r); refCache.set(refKey, ref ? mfcc(trim(ref, vad(ref, RATE)), RATE) : null); }
  const refM = refCache.get(refKey);
  if (refM && v.onsetMs !== null) m.dtwDist = dtw(mfcc(trim(pcm, v), RATE), refM);
  return m;
}

// One whisper run per language over wav copies of the readings. Failures are reported, never thrown.
function recognise(readings, model, asrDir, warnings) {
  mkdirSync(asrDir, { recursive: true });
  for (const lang of ['es', 'ca']) {
    const group = readings.filter((r) => r.lang === lang);
    if (!group.length) continue;
    const wavs = group.map((r) => {
      const wav = join(asrDir, `${r.session}-${r.n}.wav`);
      spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', r.file, '-ar', String(RATE), '-ac', '1', wav]);
      return wav;
    }).filter(existsSync);
    const run = spawnSync('whisper', [...wavs, '--model', model, '--language', lang, '--output_format', 'json', '--output_dir', asrDir, '--fp16', 'False', '--verbose', 'False'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (run.error || run.status !== 0) { warnings.push(`whisper (${lang}) failed: ${(run.error && run.error.message) || String(run.stderr || '').slice(-200)}`); continue; }
    for (const r of group) {
      const j = join(asrDir, `${r.session}-${r.n}.json`);
      if (!existsSync(j)) continue;
      try { r.asrText = JSON.parse(readFileSync(j, 'utf8')).text.trim(); } catch { warnings.push(`whisper output for ${r.session} #${r.n} is not readable`); }
    }
  }
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a');

// Signals are oriented so that a higher value means "more likely correct". Nobody speaking is the worst answer (latency and duration
// as long as the whole clip, distance infinite), and a retried reading or one whose recorder started late has no timing.
const SIGNALS = [
  ['latency (faster = better)', (r) => (r.tries > 1 || r.lateStart ? null : r.noSpeech ? -r.clipMs : -r.latencyMs), false],
  ['duration (shorter = better)', (r) => (r.tries > 1 || r.lateStart ? null : r.noSpeech ? -r.clipMs : -r.durMs), false],
  ['MFCC-DTW distance to the reference (closer = better)', (r) => (r.noSpeech ? -Infinity : r.dtwDist === null ? null : -r.dtwDist), true],
  ['Whisper heard exactly the target', (r) => (r.asrText === undefined ? null : r.asrExact ? 1 : 0), true],
  ['Whisper heard the target within 1 edit (words only; for syllables it is the exact one)', (r) => (r.asrText === undefined ? null : r.asrTol ? 1 : 0), true],
];

// raw AUC, and the AUC once each item is compared with itself (item difficulty and the reference clip's scale cannot pass for a signal).
// The interval resamples whole items: readings of one item are not independent.
function rocRow(group, score) {
  const items = group.map((r) => ({ r, s: score(r) })).filter((x) => x.s !== null);
  const adj = centerBy(items.map((x) => x.s), items.map((x) => x.r.key));
  const rows = items.map((x, i) => ({ s: x.s, a: adj[i], l: x.r.ok ? 1 : 0, key: x.r.key }));
  const pos = rows.filter((x) => x.l).length, neg = rows.length - pos;
  const fnAdj = (d) => auc(d.map((x) => x.a), d.map((x) => x.l));
  const raw = auc(rows.map((x) => x.s), rows.map((x) => x.l)), adjusted = fnAdj(rows);
  const [lo, hi] = Number.isFinite(adjusted) ? clusterBootstrapCI(fnAdj, rows, (x) => x.key, 2000) : [NaN, NaN];
  return { pos, neg, auc: raw, adj: adjusted, lo, hi };
}

export function analyze({ labDir, audioDir, sessions, asr = 'none', outDir, recogniser = null }) {
  const warnings = [];
  const manifest = existsSync(join(audioDir, 'manifest.json')) ? JSON.parse(readFileSync(join(audioDir, 'manifest.json'), 'utf8')) : null;
  if (!manifest) warnings.push('no audio/manifest.json: the similarity signal is not available');
  if (!sessions.length) sessions = existsSync(labDir) ? readdirSync(labDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'asr').map((d) => d.name) : [];
  const loaded = loadReadings(labDir, sessions, warnings);
  const refCache = new Map(), readings = [];
  for (const r of loaded) {
    const m = measure(r, audioDir, manifest, refCache);
    if (!m) { warnings.push(`session ${r.session} #${r.n}: the audio could not be decoded, skipped`); continue; }
    // the item was shown when the recorder was asked to start, so its own start lag is part of the reaction time
    const lag = r.startLagMs === null || r.startLagMs === undefined ? NaN : Number(r.startLagMs), hasLag = Number.isFinite(lag) && lag >= 0;
    readings.push({ ...r, ...m, latencyMs: m.latencyMs === null ? null : m.latencyMs + (hasLag ? lag : 0), lateStart: hasLag && lag > LATE_START_MS, ok: r.verdict === 'ok', tries: Number(r.tries) || 1 });
  }
  if (asr !== 'none') {
    if (!recogniser && spawnSync('whisper', ['--help']).error) warnings.push('the whisper CLI is not installed: the recogniser was not run');
    else (recogniser || recognise)(readings, asr, join(labDir, 'asr'), warnings);
  }
  for (const r of readings) if (r.asrText !== undefined) {
    const heard = normText(r.asrText), want = normText(r.text);
    r.asrExact = heard === want;
    r.asrTol = want.length <= 3 ? heard === want : editDistance(heard, want) <= 1; // one edit turns "ma" into "me": only meaningful for words
  }
  mkdirSync(outDir, { recursive: true });

  // ---- CSV
  const cols = ['session', 'n', 'who', 'kind', 'key', 'verdict', 'rep', 'tries', 'startLagMs', 'lateStart', 'noSpeech', 'latencyMs', 'durMs', 'snrDb', 'peakDb', 'dtwDist', 'asrText', 'asrExact', 'asrTol'];
  const cell = (v) => (v === undefined || v === null ? '' : typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : `"${String(v).replace(/"/g, '""')}"`);
  writeFileSync(join(outDir, 'readings.csv'), [cols.join(','), ...readings.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n');

  // ---- statistics by who and group
  const whos = [...new Set(readings.map((r) => r.who))];
  const groups = (who) => {
    const mine = readings.filter((r) => r.who === who);
    return [
      ['natural (read: ✅ vs 🔁)', mine.filter((r) => r.kind === 'read')],
      ['staged (✅ readings vs on-purpose wrong; overstates real performance)', mine.filter((r) => (r.kind === 'read' && r.ok) || r.kind === 'wrong')],
    ];
  };
  const lines = [];
  const L = (s = '') => lines.push(s);
  L('# Voice-progress experiment: report');
  L();
  L(`Sessions: ${sessions.join(', ') || '(none)'}. Readings analysed: ${readings.length}. Recogniser: ${asr === 'none' ? 'not run' : asr}.`);
  L();
  L('| who | kind | readings | ✅ | 🔁 |');
  L('|---|---|---|---|---|');
  for (const who of whos) for (const kind of ['read', 'wrong']) {
    const g = readings.filter((r) => r.who === who && r.kind === kind);
    if (g.length) L(`| ${who} | ${kind} | ${g.length} | ${g.filter((r) => r.ok).length} | ${g.filter((r) => !r.ok).length} |`);
  }
  L();
  L('### No speech detected');
  L();
  for (const who of whos) for (const kind of ['read', 'wrong']) {
    const g = readings.filter((r) => r.who === who && r.kind === kind);
    if (g.length) L(`- ${who} / ${kind}: nobody spoke in ✅ ${g.filter((r) => r.noSpeech && r.ok).length} and 🔁 ${g.filter((r) => r.noSpeech && !r.ok).length} of ${g.length} readings (they count as the worst answer for timing and distance).`);
  }
  const late = readings.filter((r) => r.lateStart).length;
  L();
  L(`Recorder started late (more than ${LATE_START_MS / 1000} s after the item appeared) in ${late} of ${readings.length} readings: their timing is excluded. The first reading of a page used to be the usual one (the recorder warms up); the page now does that before the first item.`);
  const lowSnr = readings.filter((r) => r.snrDb !== null && r.snrDb < 15).length;
  L();
  L(`Setup check: ${lowSnr} of ${readings.filter((r) => r.snrDb !== null).length} readings have speech less than 15 dB above the noise floor. The plan says to fix the microphone or the room before collecting more if this is common.`);
  L();
  L('## Signals: AUC (1 = ranks every correct reading above every wrong one, 0.5 = no information)');
  L();
  L('"Item-adjusted" compares each reading only with the other readings of the same item, so that difficulty of the item (long words, a different reference clip) cannot pass for a signal. The interval resamples whole items. The decision lines use the adjusted value.');
  const table = new Map();
  for (const who of whos) for (const [gname, g] of groups(who)) {
    L();
    L(`### ${who} / ${gname}`);
    L();
    L('| signal | ✅ n | 🔁 n | AUC (raw) | AUC (item-adjusted) | 95% interval (adjusted, by item) |');
    L('|---|---|---|---|---|---|');
    for (const [name, score] of SIGNALS) {
      const row = rocRow(g, score);
      table.set(`${who}|${gname.split(' ')[0]}|${name}`, row);
      L(`| ${name} | ${row.pos} | ${row.neg} | ${f2(row.auc)} | ${f2(row.adj)} | ${f2(row.lo)} to ${f2(row.hi)} |`);
    }
  }

  // ---- decision rule, line by line
  L();
  L('## Decision rule (fixed before any data; see the plan)');
  L();
  const similarity = SIGNALS.filter((s) => s[2]).map((s) => s[0]);
  const ctlAll = similarity.map((n) => table.get(`adult|staged|${n}`)).filter(Boolean);
  const ctlOk = ctlAll.filter((x) => x.pos >= 20 && x.neg >= 20 && Number.isFinite(x.adj)).sort((a, b) => b.adj - a.adj);
  if (!ctlOk.length) {
    const some = ctlAll.sort((a, b) => b.pos + b.neg - (a.pos + a.neg))[0];
    L(`- **Positive control (adult, staged, similarity signals, needs AUC ≥ 0.90):** NOT ENOUGH DATA (${some ? `${some.pos} correct / ${some.neg} wrong in the signal with most readings` : 'no usable similarity data'}; a signal needs 20 of each).`);
  } else {
    const best = ctlOk[0];
    L(`- **Positive control (adult, staged, similarity signals, needs AUC ≥ 0.90):** ${best.adj >= 0.9 ? 'PASS' : 'FAIL'} (best AUC ${f2(best.adj)}, interval ${f2(best.lo)} to ${f2(best.hi)}). ${best.adj >= 0.9 ? '' : 'The method is not sound: do not spend Elsa\'s sessions on it.'}`);
  }
  L('- **Per-item correctness (Elsa, natural readings; needs AUC ≥ 0.85, lower end ≥ 0.75, at least 15 🔁 and 40 ✅):**');
  for (const [name] of SIGNALS) {
    const row = table.get(`elsa|natural|${name}`);
    if (!row) { L(`  - ${name}: NOT ENOUGH DATA (no Elsa readings)`); continue; }
    if (row.pos < 40 || row.neg < 15 || !Number.isFinite(row.adj)) { L(`  - ${name}: NOT ENOUGH DATA (${row.pos} ✅ / ${row.neg} 🔁)`); continue; }
    L(`  - ${name}: ${row.adj >= 0.85 && row.lo >= 0.75 ? 'PASS' : 'FAIL'} (item-adjusted AUC ${f2(row.adj)}, ${f2(row.lo)} to ${f2(row.hi)}; raw ${f2(row.auc)})`);
  }
  // progress trend: test-retest of the latency for items read in different sessions, and latency of ✅ against 🔁
  const elsa = readings.filter((r) => r.who === 'elsa' && r.kind === 'read' && !r.noSpeech && r.tries <= 1 && !r.lateStart && r.latencyMs !== null);
  const firstSeen = new Map();
  for (const r of elsa) { const t = String(r.shownAtIso || ''); if (!firstSeen.has(r.session) || t < firstSeen.get(r.session)) firstSeen.set(r.session, t); }
  const order = [...firstSeen.entries()].sort((a, b) => a[1].localeCompare(b[1])).map((x) => x[0]);
  const pairs = [];
  for (const key of new Set(elsa.map((r) => r.key))) {
    const per = order.map((s) => elsa.filter((r) => r.key === key && r.session === s).sort((a, b) => String(a.shownAtIso).localeCompare(String(b.shownAtIso)))[0]).filter(Boolean);
    if (per.length >= 2) pairs.push([per[0].latencyMs, per[1].latencyMs]);
  }
  const retest = pairs.length >= 8 ? spearman(pairs.map((p) => p[0]), pairs.map((p) => p[1])) : NaN;
  const diffFn = (d) => mean(d.filter((r) => !r.ok).map((r) => r.latencyMs)) - mean(d.filter((r) => r.ok).map((r) => r.latencyMs));
  const hasBoth = elsa.some((r) => r.ok) && elsa.some((r) => !r.ok);
  const diff = hasBoth ? diffFn(elsa) : NaN;
  const [dLo, dHi] = hasBoth ? clusterBootstrapCI(diffFn, elsa, (r) => r.key, 2000) : [NaN, NaN];
  L('- **Progress trend (Elsa, timing; first readings only, no retries, nobody-spoke excluded; test-retest r ≥ 0.6 over at least 8 items read in different sessions, and 🔁 slower than ✅ with an interval above zero):**');
  L(`  - latency test-retest (Spearman, first two sessions that have the item): ${pairs.length < 8 ? `NOT ENOUGH DATA (${pairs.length} items read in two sessions)` : `${retest >= 0.6 ? 'PASS' : 'FAIL'} (r = ${f2(retest)} over ${pairs.length} items)`}`);
  L(`  - latency of 🔁 minus ✅ (this compares readings, not items; interval resamples items): ${!hasBoth ? 'NOT ENOUGH DATA (needs both kinds)' : `${dLo > 0 ? 'PASS' : 'FAIL'} (${Math.round(diff)} ms, interval ${Math.round(dLo)} to ${Math.round(dHi)} ms)`}`);
  L();
  L('## Limits (restate in the conclusion)');
  L();
  L('- Labels are a parent\'s quick judgment (noisy). One child, one microphone, one room: nothing here transfers to other children, dialects or devices.');
  L('- Staged wrong readings are easier to detect than real confusions: their scores overstate real performance.');
  L('- Her audio is a child\'s voice. It stays in this folder, is never uploaded, and is deleted when the experiment ends.');
  L('- readings.csv holds Whisper\'s transcript of her speech when the recogniser is run: keep it in lab/ (gitignored) and never commit it.');
  if (warnings.length) { L(); L('## Warnings'); L(); for (const w of warnings) L(`- ${w}`); }
  writeFileSync(join(outDir, 'report.md'), lines.join('\n') + '\n');
  return { readings, warnings, report: lines.join('\n'), table };
}

// ---- command line
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2), opt = { 'lab-dir': join(ROOT, 'lab'), 'audio-dir': join(ROOT, 'audio'), asr: 'small', out: null }, sessions = [];
  for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[++i]; else sessions.push(argv[i]); }
  if (!['small', 'base', 'none'].includes(opt.asr)) { console.error('--asr must be small, base or none'); process.exit(2); }
  const res = analyze({ labDir: opt['lab-dir'], audioDir: opt['audio-dir'], sessions, asr: opt.asr, outDir: opt.out || opt['lab-dir'] });
  console.log(res.report);
}
