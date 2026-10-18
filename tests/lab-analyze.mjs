// End-to-end test of scripts/lab-analyze.mjs on synthetic recordings (WAV bytes stored as .webm: ffmpeg sniffs the format).
// A "correct" reading is the same vowel as the reference clip, a "wrong" one the other vowel; latency is set by hand, so the onset it reports can be checked.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze } from '../scripts/lab-analyze.mjs';

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const RATE = 16000;
let seed = 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const noise = (ms, amp = 0.001) => Float32Array.from({ length: Math.round(RATE * ms / 1000) }, () => (rnd() * 2 - 1) * amp);
const cat = (...parts) => { const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const vowel = (f1, f2, f0, ms) => {
  const n = Math.round(RATE * ms / 1000), out = new Float32Array(n);
  for (let k = 1; k * f0 < 4000; k++) { const a = Math.exp(-(((k * f0 - f1) / 150) ** 2)) + 0.7 * Math.exp(-(((k * f0 - f2) / 250) ** 2)) + 0.03; for (let i = 0; i < n; i++) out[i] += a * Math.sin(2 * Math.PI * k * f0 * i / RATE); }
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i]));
  for (let i = 0; i < n; i++) out[i] *= 0.4 * Math.sin(Math.PI * i / n) ** 0.5 / pk;
  return out;
};
const TYPE = { ma: 'a', pa: 'a', mo: 'a', po: 'a', pe: 'i', pi: 'i', me: 'i', mu: 'i' };
const sound = (type, ms = 450) => (type === 'a' ? vowel(700, 1200, 200, ms) : vowel(300, 2300, 200, ms));
const other = (type) => (type === 'a' ? 'i' : 'a');
const wav = (pcm) => {
  const b = Buffer.alloc(44 + pcm.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + pcm.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
  return b;
};

const root = mkdtempSync(join(tmpdir(), 'leemos-lab-an-'));
const audioDir = join(root, 'audio');
mkdirSync(join(audioDir, 'es'), { recursive: true });
const clips = {};
for (const [text, type] of Object.entries(TYPE)) { writeFileSync(join(audioDir, 'es', `${text}.mp3`), wav(cat(noise(200), sound(type, 500), noise(200)))); clips[text] = `${text}.mp3`; }
writeFileSync(join(audioDir, 'manifest.json'), JSON.stringify({ clips: { es: clips, ca: {} } }));

const expected = new Map(); // `${session}#${n}` -> latency we built in
function writeSession(labDir, session, readings, { extra = false } = {}) {
  const dir = join(labDir, session);
  mkdirSync(dir, { recursive: true });
  const lines = [];
  readings.forEach((r, n) => {
    const heard = r.wrongSound ? other(TYPE[r.text]) : TYPE[r.text];
    writeFileSync(join(dir, `${n}.webm`), wav(cat(noise(r.latency), sound(heard), noise(400))));
    expected.set(`${session}#${n}`, r.latency);
    lines.push(JSON.stringify({ session, n, key: 's:' + r.text, text: r.text, lang: 'es', who: r.who, kind: r.kind, verdict: r.ok ? 'ok' : 'fail', rep: !!r.rep, shownAtIso: new Date(Date.UTC(2026, 9, 18, 10, 0, n)).toISOString() }));
  });
  if (extra) {
    const n0 = readings.length;
    writeFileSync(join(dir, `${n0}.webm`), wav(cat(noise(300), sound('a'), noise(300)))); // a text with no reference clip
    lines.push(JSON.stringify({ session, n: n0, key: 's:zz', text: 'zz', lang: 'es', who: readings[0].who, kind: 'read', verdict: 'ok', shownAtIso: '2026-10-18T10:30:00.000Z' }));
    writeFileSync(join(dir, `${n0 + 1}.webm`), wav(noise(1500))); // nobody spoke
    lines.push(JSON.stringify({ session, n: n0 + 1, key: 's:ma', text: 'ma', lang: 'es', who: readings[0].who, kind: 'read', verdict: 'fail', shownAtIso: '2026-10-18T10:31:00.000Z' }));
    writeFileSync(join(dir, `${n0 + 2}.webm`), Buffer.from('this is not audio at all'));
    lines.push(JSON.stringify({ session, n: n0 + 2, key: 's:ma', text: 'ma', lang: 'es', who: readings[0].who, kind: 'read', verdict: 'ok', shownAtIso: '2026-10-18T10:32:00.000Z' }));
    lines.push(JSON.stringify({ session, n: n0 + 3, key: 's:ma', text: 'ma', lang: 'es', who: readings[0].who, kind: 'read', verdict: 'ok' })); // label without audio
    lines.push('{this line is not json');
  }
  writeFileSync(join(dir, 'labels.jsonl'), lines.join('\n') + '\n');
}

const labDir = join(root, 'lab');
const texts = Object.keys(TYPE);
// the adult control: 24 correct and 24 wrong on purpose
writeSession(labDir, 'adult-read-1', Array.from({ length: 24 }, (_, i) => ({ who: 'adult', kind: 'read', text: texts[i % 8], latency: 300 + (i % 5) * 10, ok: true })));
writeSession(labDir, 'adult-wrong-1', Array.from({ length: 24 }, (_, i) => ({ who: 'adult', kind: 'wrong', text: texts[i % 8], latency: 320 + (i % 4) * 10, ok: false, wrongSound: true })));
// Elsa: 8 items read many times; the last three items go wrong (and slowly) from their third reading on
const base = [250, 350, 450, 550, 650, 300, 500, 400];
const occ = new Array(8).fill(0);
const elsaReadings = Array.from({ length: 60 }, (_, i) => {
  const k = i % 8, o = occ[k]++, fail = k >= 5 && o >= 2;
  return { who: 'elsa', kind: 'read', text: texts[k], latency: base[k] + (fail ? 500 : 0) + (i % 3) * 10, ok: !fail, wrongSound: fail, rep: o > 0 };
});
writeSession(labDir, 'elsa-read-1', elsaReadings, { extra: true });
const nFail = elsaReadings.filter((r) => !r.ok).length;

const outDir = join(root, 'out');
const res = analyze({ labDir, audioDir, sessions: [], asr: 'none', outDir });
const csv = readFileSync(join(outDir, 'readings.csv'), 'utf8').trim().split('\n');
const head = csv[0].split(',');
const rows = csv.slice(1).map((l) => { const c = l.split(',').map((x) => x.replace(/^"|"$/g, '')); return Object.fromEntries(head.map((h, i) => [h, c[i]])); });

check('analyze: the report and the CSV are written', existsSync(join(outDir, 'report.md')) && csv.length > 100, String(csv.length));
check('analyze: every readable reading is in the CSV and the broken ones are not', rows.length === 48 + 60 + 2 && res.readings.length === rows.length, String(rows.length));
check('analyze: the onset it reports matches the latency built into each recording (within 20 ms)', rows.filter((r) => expected.has(`${r.session}#${r.n}`)).length === 108 && rows.filter((r) => expected.has(`${r.session}#${r.n}`)).every((r) => Math.abs(Number(r.latencyMs) - expected.get(`${r.session}#${r.n}`)) <= 20), rows.filter((r) => expected.has(`${r.session}#${r.n}`) && Math.abs(Number(r.latencyMs) - expected.get(`${r.session}#${r.n}`)) > 20).slice(0, 3).map((r) => `${r.session}#${r.n}: ${r.latencyMs}`).join(' '));
check('analyze: a recording with nobody speaking has no latency and no distance, and does not break anything', rows.some((r) => r.session === 'elsa-read-1' && r.n === '61' && r.latencyMs === '' && r.dtwDist === ''));
check('analyze: a text with no reference clip has timing but no distance', rows.some((r) => r.key === 's:zz' && r.latencyMs !== '' && r.dtwDist === ''));
check('analyze: warnings name the undecodable audio, the label without audio and the broken line', res.warnings.some((w) => /could not be decoded/.test(w)) && res.warnings.some((w) => /label without audio/.test(w)) && res.warnings.some((w) => /not JSON/.test(w)), res.warnings.join(' | '));
check('analyze: the report says the recogniser was not run', /Recogniser: not run/.test(res.report));
const line = (re) => res.report.split('\n').find((l) => re.test(l)) || '';
check('analyze: the adult positive control passes on clean synthetic data', /Positive control.*PASS/.test(line(/Positive control/)), line(/Positive control/));
check('analyze: the AUC of timing and similarity for Elsa is high, and her counts are right', res.table.get('elsa|natural|latency (faster = better)').auc > 0.95 && res.table.get('elsa|natural|MFCC-DTW distance to the reference (closer = better)').auc > 0.9 && res.table.get('elsa|natural|latency (faster = better)').neg === nFail, `${res.table.get('elsa|natural|latency (faster = better)').auc} ${nFail}`);
check('analyze: the per-item rule passes for timing and similarity and says not enough data for the recogniser', /latency \(faster = better\): PASS/.test(res.report) && /MFCC-DTW distance to the reference \(closer = better\): PASS/.test(res.report) && /Whisper heard exactly the target: NOT ENOUGH DATA/.test(res.report));
check('analyze: the trend rule passes (repeated items are stable and failures are slower)', /latency test-retest: PASS/.test(res.report) && /latency of 🔁 minus ✅: PASS/.test(res.report), line(/test-retest/) + ' ' + line(/minus/));
check('analyze: the staged table exists for the adult and the limits are restated', /### adult \/ staged/.test(res.report) && /overstate real performance/.test(res.report) && /Her audio is a child/.test(res.report));

// a control that must come out as "no": the same recordings with verdicts that have nothing to do with what was said
const shuffledDir = join(root, 'lab-shuffled');
writeSession(shuffledDir, 'elsa-read-2', Array.from({ length: 60 }, (_, i) => ({ who: 'elsa', kind: 'read', text: texts[i % 8], latency: 400, ok: rnd() < 0.7, wrongSound: false, rep: i >= 8 })));
const res2 = analyze({ labDir: shuffledDir, audioDir, sessions: [], asr: 'none', outDir: join(root, 'out2') });
const dtwRow = res2.table.get('elsa|natural|MFCC-DTW distance to the reference (closer = better)'), latRow = res2.table.get('elsa|natural|latency (faster = better)');
check('analyze: with verdicts unrelated to the audio no signal passes (AUC near 0.5)', dtwRow.auc > 0.25 && dtwRow.auc < 0.75 && latRow.auc > 0.25 && latRow.auc < 0.75 && !/MFCC-DTW distance to the reference \(closer = better\): PASS/.test(res2.report) && !/latency \(faster = better\): PASS/.test(res2.report), `${dtwRow.auc.toFixed(2)} ${latRow.auc.toFixed(2)}`);
check('analyze: and the trend rule does not pass either', !/latency of 🔁 minus ✅: PASS/.test(res2.report), res2.report.split('\n').find((l) => /minus/.test(l)));
// the positive control must be able to fail: "wrong" adult readings that sound exactly like the correct ones
const ctlDir = join(root, 'lab-control-fail');
writeSession(ctlDir, 'adult-read-3', Array.from({ length: 24 }, (_, i) => ({ who: 'adult', kind: 'read', text: texts[i % 8], latency: 300, ok: true })));
writeSession(ctlDir, 'adult-wrong-3', Array.from({ length: 24 }, (_, i) => ({ who: 'adult', kind: 'wrong', text: texts[i % 8], latency: 300, ok: false, wrongSound: false })));
const res4 = analyze({ labDir: ctlDir, audioDir, sessions: [], asr: 'none', outDir: join(root, 'out4') });
const ctlLine = res4.report.split('\n').find((l) => /Positive control/.test(l)) || '';
check('analyze: a positive control that cannot tell the readings apart is reported as FAIL with the instruction to stop', /\*\* FAIL/.test(ctlLine) && /not sound/.test(ctlLine) && !/PASS/.test(ctlLine), ctlLine);
writeSession(join(root, 'lab-small'), 'adult-read-4', Array.from({ length: 6 }, (_, i) => ({ who: 'adult', kind: 'read', text: texts[i], latency: 300, ok: true })));
writeSession(join(root, 'lab-small'), 'adult-wrong-4', Array.from({ length: 6 }, (_, i) => ({ who: 'adult', kind: 'wrong', text: texts[i], latency: 300, ok: false, wrongSound: true })));
const res6 = analyze({ labDir: join(root, 'lab-small'), audioDir, sessions: [], asr: 'none', outDir: join(root, 'out6') });
check('analyze: with too few adult readings the control says NOT ENOUGH DATA, never PASS', /Positive control.*NOT ENOUGH DATA/.test(res6.report) && !/Positive control.*PASS/.test(res6.report));
const res3 = analyze({ labDir: join(root, 'nothing-here'), audioDir, sessions: [], asr: 'none', outDir: join(root, 'out3') });
check('analyze: an empty lab folder gives an empty report, not a crash', res3.readings.length === 0 && /NOT ENOUGH DATA/.test(res3.report));

rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} lab-analyze test(s) FAILED` : '\nAll lab-analyze tests passed');
process.exit(failures ? 1 : 0);
