// Analysis for the voice-progress experiment (plan: docs/superpowers/plans/2026-10-17-voice-progress-experiment.md).
//   node scripts/lab-analyze.mjs [session ...] [--lab-dir lab] [--audio-dir audio] [--asr small|base|none] [--out lab]
// Reads lab/<session>/<n>.webm + labels.jsonl (written by tools/lab.html), computes timing, similarity to the app's reference clip and
// (optionally) what Whisper heard, and writes <out>/report.md and <out>/readings.csv with the decision rule applied line by line.
// Needs ffmpeg, and the `whisper` CLI only for --asr small|base.
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/clips.mjs';
import { vad, mfcc, dtw, auc, bootstrapCI, pearson, normText, editDistance } from './lib/labdsp.mjs';

const RATE = 16000;
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
  const m = { latencyMs: v.onsetMs, durMs: v.onsetMs === null ? null : v.offsetMs - v.onsetMs, snrDb: v.onsetMs === null ? null : v.speechDb - v.noiseDb, peakDb: v.peakDb, dtwDist: null };
  const refKey = `${r.lang}/${r.text}`;
  if (!refCache.has(refKey)) { const ref = referenceOf(audioDir, manifest, r); refCache.set(refKey, ref ? mfcc(trim(ref, vad(ref, RATE)), RATE) : null); }
  const refM = refCache.get(refKey);
  if (refM && v.onsetMs !== null) m.dtwDist = dtw(mfcc(trim(pcm, v), RATE), refM);
  return m;
}

// One whisper run per language over wav copies of the readings. Failures are reported, never thrown.
function recognise(readings, model, outDir, warnings) {
  const asrDir = join(outDir, 'asr');
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

// Signals are oriented so that a higher value means "more likely correct".
const SIGNALS = [
  ['latency (faster = better)', (r) => (r.latencyMs === null ? null : -r.latencyMs), false],
  ['duration (shorter = better)', (r) => (r.durMs === null ? null : -r.durMs), false],
  ['MFCC-DTW distance to the reference (closer = better)', (r) => (r.dtwDist === null ? null : -r.dtwDist), true],
  ['Whisper heard exactly the target', (r) => (r.asrText === undefined ? null : r.asrExact ? 1 : 0), true],
  ['Whisper heard the target within 1 edit', (r) => (r.asrText === undefined ? null : r.asrTol ? 1 : 0), true],
];

function rocRow(group, score) {
  const rows = group.map((r) => ({ s: score(r), l: r.ok ? 1 : 0 })).filter((x) => x.s !== null);
  const pos = rows.filter((x) => x.l).length, neg = rows.length - pos;
  const fn = (d) => auc(d.map((x) => x.s), d.map((x) => x.l));
  const a = fn(rows);
  const [lo, hi] = Number.isFinite(a) ? bootstrapCI(fn, rows, 2000) : [NaN, NaN];
  return { pos, neg, auc: a, lo, hi };
}

export function analyze({ labDir, audioDir, sessions, asr = 'none', outDir }) {
  const warnings = [];
  const manifest = existsSync(join(audioDir, 'manifest.json')) ? JSON.parse(readFileSync(join(audioDir, 'manifest.json'), 'utf8')) : null;
  if (!manifest) warnings.push('no audio/manifest.json: the similarity signal is not available');
  if (!sessions.length) sessions = existsSync(labDir) ? readdirSync(labDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'asr').map((d) => d.name) : [];
  const loaded = loadReadings(labDir, sessions, warnings);
  const refCache = new Map(), readings = [];
  for (const r of loaded) {
    const m = measure(r, audioDir, manifest, refCache);
    if (!m) { warnings.push(`session ${r.session} #${r.n}: the audio could not be decoded, skipped`); continue; }
    readings.push({ ...r, ...m, ok: r.verdict === 'ok' });
  }
  if (asr !== 'none') {
    if (spawnSync('whisper', ['--help']).error) warnings.push('the whisper CLI is not installed: the recogniser was not run');
    else recognise(readings, asr, outDir, warnings);
  }
  for (const r of readings) if (r.asrText !== undefined) { const heard = normText(r.asrText), want = normText(r.text); r.asrExact = heard === want; r.asrTol = editDistance(heard, want) <= 1; }
  mkdirSync(outDir, { recursive: true });

  // ---- CSV
  const cols = ['session', 'n', 'who', 'kind', 'key', 'verdict', 'rep', 'latencyMs', 'durMs', 'snrDb', 'peakDb', 'dtwDist', 'asrText', 'asrExact', 'asrTol'];
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
  L('## Signals: AUC (1 = ranks every correct reading above every wrong one, 0.5 = no information)');
  const table = new Map();
  for (const who of whos) for (const [gname, g] of groups(who)) {
    L();
    L(`### ${who} / ${gname}`);
    L();
    L('| signal | ✅ n | 🔁 n | AUC | 95% interval |');
    L('|---|---|---|---|---|');
    for (const [name, score] of SIGNALS) {
      const row = rocRow(g, score);
      table.set(`${who}|${gname.split(' ')[0]}|${name}`, row);
      L(`| ${name} | ${row.pos} | ${row.neg} | ${f2(row.auc)} | ${f2(row.lo)} to ${f2(row.hi)} |`);
    }
  }

  // ---- decision rule, line by line
  L();
  L('## Decision rule (fixed before any data; see the plan)');
  L();
  const similarity = SIGNALS.filter((s) => s[2]).map((s) => s[0]);
  const ctl = similarity.map((n) => table.get(`adult|staged|${n}`)).filter(Boolean);
  const ctlBest = ctl.filter((x) => Number.isFinite(x.auc)).sort((a, b) => b.auc - a.auc)[0];
  if (!ctlBest || ctlBest.pos < 20 || ctlBest.neg < 20) L(`- **Positive control (adult, staged, similarity signals, needs AUC ≥ 0.90):** NOT ENOUGH DATA (${ctlBest ? `${ctlBest.pos} correct / ${ctlBest.neg} wrong` : 'no usable similarity data'}; needs 20 of each).`);
  else L(`- **Positive control (adult, staged, similarity signals, needs AUC ≥ 0.90):** ${ctlBest.auc >= 0.9 ? 'PASS' : 'FAIL'} (best AUC ${f2(ctlBest.auc)}, interval ${f2(ctlBest.lo)} to ${f2(ctlBest.hi)}). ${ctlBest.auc >= 0.9 ? '' : 'The method is not sound: do not spend Elsa\'s sessions on it.'}`);
  L('- **Per-item correctness (Elsa, natural readings; needs AUC ≥ 0.85, lower end ≥ 0.75, at least 15 🔁 and 40 ✅):**');
  for (const [name] of SIGNALS) {
    const row = table.get(`elsa|natural|${name}`);
    if (!row) { L(`  - ${name}: NOT ENOUGH DATA (no Elsa readings)`); continue; }
    if (row.pos < 40 || row.neg < 15 || !Number.isFinite(row.auc)) { L(`  - ${name}: NOT ENOUGH DATA (${row.pos} ✅ / ${row.neg} 🔁)`); continue; }
    L(`  - ${name}: ${row.auc >= 0.85 && row.lo >= 0.75 ? 'PASS' : 'FAIL'} (AUC ${f2(row.auc)}, ${f2(row.lo)} to ${f2(row.hi)})`);
  }
  // progress trend: test-retest of the latency over repeated items, and latency of ✅ against 🔁
  const elsa = readings.filter((r) => r.who === 'elsa' && r.kind === 'read' && r.latencyMs !== null);
  const byKey = new Map();
  for (const r of [...elsa].sort((a, b) => String(a.shownAtIso).localeCompare(String(b.shownAtIso)))) { if (!byKey.has(r.key)) byKey.set(r.key, []); byKey.get(r.key).push(r.latencyMs); }
  const pairs = [...byKey.values()].filter((v) => v.length >= 2).map((v) => [v[0], v[1]]);
  const retest = pairs.length >= 8 ? pearson(pairs.map((p) => p[0]), pairs.map((p) => p[1])) : NaN;
  const diffFn = (d) => mean(d.filter((r) => !r.ok).map((r) => r.latencyMs)) - mean(d.filter((r) => r.ok).map((r) => r.latencyMs));
  const hasBoth = elsa.some((r) => r.ok) && elsa.some((r) => !r.ok);
  const diff = hasBoth ? diffFn(elsa) : NaN;
  const [dLo, dHi] = hasBoth ? bootstrapCI(diffFn, elsa, 2000) : [NaN, NaN];
  L('- **Progress trend (Elsa, timing; test-retest r ≥ 0.6 over at least 8 repeated items, and 🔁 slower than ✅ with an interval above zero):**');
  L(`  - latency test-retest: ${pairs.length < 8 ? `NOT ENOUGH DATA (${pairs.length} repeated items)` : `${retest >= 0.6 ? 'PASS' : 'FAIL'} (r = ${f2(retest)} over ${pairs.length} items)`}`);
  L(`  - latency of 🔁 minus ✅: ${!hasBoth ? 'NOT ENOUGH DATA (needs both kinds)' : `${dLo > 0 ? 'PASS' : 'FAIL'} (${Math.round(diff)} ms, interval ${Math.round(dLo)} to ${Math.round(dHi)} ms)`}`);
  L();
  L('## Limits (restate in the conclusion)');
  L();
  L('- Labels are a parent\'s quick judgment (noisy). One child, one microphone, one room: nothing here transfers to other children, dialects or devices.');
  L('- Staged wrong readings are easier to detect than real confusions: their scores overstate real performance.');
  L('- Her audio is a child\'s voice. It stays in this folder, is never uploaded, and is deleted when the experiment ends.');
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
