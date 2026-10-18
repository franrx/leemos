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
// readings: { who, kind, text, latency, ok, wrongSound, rep, tries, dur, noiseAmp }
function writeSession(labDir, session, readings, { extra = false, day = 18 } = {}) {
  const dir = join(labDir, session);
  mkdirSync(dir, { recursive: true });
  const lines = [];
  readings.forEach((r, n) => {
    const heard = r.wrongSound ? other(TYPE[r.text]) : TYPE[r.text];
    const na = r.noiseAmp || 0.001;
    writeFileSync(join(dir, `${n}.webm`), wav(cat(noise(r.latency, na), sound(heard, r.dur || 450), noise(400, na))));
    expected.set(`${session}#${n}`, r.latency);
    lines.push(JSON.stringify({ session, n, key: 's:' + r.text, text: r.text, lang: 'es', who: r.who, kind: r.kind, verdict: r.ok ? 'ok' : 'fail', rep: !!r.rep, tries: r.tries || 1, startLagMs: r.startLag, shownAtIso: new Date(Date.UTC(2026, 9, day, 10, 0, n)).toISOString() }));
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
const run = (labDir, extra = {}) => analyze({ labDir, audioDir, sessions: [], asr: 'none', outDir: join(root, 'out-' + Math.random().toString(36).slice(2)), ...extra });
const A_ROW = 'MFCC-DTW distance to the reference (closer = better)', LAT = 'latency (faster = better)', DUR = 'duration (shorter = better)';

const labDir = join(root, 'lab');
const texts = Object.keys(TYPE);
// the adult control: 24 correct and 24 wrong on purpose
writeSession(labDir, 'adult-read-1', Array.from({ length: 24 }, (_, i) => ({ who: 'adult', kind: 'read', text: texts[i % 8], latency: 300 + (i % 5) * 10, ok: true })));
writeSession(labDir, 'adult-wrong-1', Array.from({ length: 24 }, (_, i) => ({ who: 'adult', kind: 'wrong', text: texts[i % 8], latency: 320 + (i % 4) * 10, ok: false, wrongSound: true })));
// Elsa, on two days: 8 items read many times; the last three items go wrong (and slowly) from their second reading on, but never on their first reading of a session
const base = [250, 350, 450, 550, 650, 300, 500, 400];
const occ = new Array(8).fill(0);
const elsaReadings = Array.from({ length: 60 }, (_, i) => {
  const k = i % 8, o = occ[k]++, fail = k >= 5 && o >= 1 && i % 30 >= 8; // the first readings of each session are normal ones, so the retest measures stability
  return { who: 'elsa', kind: 'read', text: texts[k], latency: base[k] + (fail ? 500 : 0) + (i % 3) * 10, ok: !fail, wrongSound: fail, rep: o > 0 };
});
writeSession(labDir, 'elsa-read-1', elsaReadings.slice(0, 30), { extra: true });
writeSession(labDir, 'elsa-read-1b', elsaReadings.slice(30), { day: 19 });
const nFail = elsaReadings.filter((r) => !r.ok).length;

const outDir = join(root, 'out');
const res = analyze({ labDir, audioDir, sessions: [], asr: 'none', outDir });
const csv = readFileSync(join(outDir, 'readings.csv'), 'utf8').trim().split('\n');
const head = csv[0].split(',');
const rows = csv.slice(1).map((l) => { const c = l.split(',').map((x) => x.replace(/^"|"$/g, '')); return Object.fromEntries(head.map((h, i) => [h, c[i]])); });

check('analyze: the report and the CSV are written', existsSync(join(outDir, 'report.md')) && csv.length > 100, String(csv.length));
check('analyze: every readable reading is in the CSV and the broken ones are not', rows.length === 48 + 60 + 2 && res.readings.length === rows.length, String(rows.length));
check('analyze: the onset it reports matches the latency built into each recording (within 20 ms)', rows.filter((r) => expected.has(`${r.session}#${r.n}`)).length === 108 && rows.filter((r) => expected.has(`${r.session}#${r.n}`)).every((r) => Math.abs(Number(r.latencyMs) - expected.get(`${r.session}#${r.n}`)) <= 20), rows.filter((r) => expected.has(`${r.session}#${r.n}`) && Math.abs(Number(r.latencyMs) - expected.get(`${r.session}#${r.n}`)) > 20).slice(0, 3).map((r) => `${r.session}#${r.n}: ${r.latencyMs}`).join(' '));
check('analyze: a recording with nobody speaking has no onset and no distance, is flagged, and does not break anything', rows.some((r) => r.session === 'elsa-read-1' && r.n === '31' && r.latencyMs === '' && r.dtwDist === '' && r.noSpeech === 'true') && rows.filter((r) => r.noSpeech === 'true').length === 1);
check('analyze: a text with no reference clip has timing but no distance', rows.some((r) => r.key === 's:zz' && r.latencyMs !== '' && r.dtwDist === ''));
check('analyze: warnings name the undecodable audio, the label without audio and the broken line', res.warnings.some((w) => /could not be decoded/.test(w)) && res.warnings.some((w) => /label without audio/.test(w)) && res.warnings.some((w) => /not JSON/.test(w)), res.warnings.join(' | '));
check('analyze: the report says the recogniser was not run', /Recogniser: not run/.test(res.report));
const line = (rep, re) => rep.split('\n').find((l) => re.test(l)) || '';
check('analyze: the adult positive control passes on clean synthetic data', /Positive control.*PASS/.test(line(res.report, /Positive control/)), line(res.report, /Positive control/));
const latRow = res.table.get(`elsa|natural|${LAT}`), dtwRow = res.table.get(`elsa|natural|${A_ROW}`);
check('analyze: silence counts as the worst answer, so a reading nobody spoke is a wrong one for timing and distance', latRow.neg === nFail + 1 && dtwRow.neg === nFail + 1, `${latRow.neg} ${dtwRow.neg} ${nFail}`);
check('analyze: the item-adjusted AUC of timing and similarity for Elsa is high', latRow.adj > 0.95 && dtwRow.adj > 0.9, `${latRow.adj} ${dtwRow.adj}`);
check('analyze: the per-item rule passes for timing and similarity and says not enough data for the recogniser', new RegExp(`${LAT.replace(/[()]/g, '\\$&')}: PASS`).test(res.report) && /MFCC-DTW distance to the reference \(closer = better\): PASS/.test(res.report) && /Whisper heard exactly the target: NOT ENOUGH DATA/.test(res.report));
check('analyze: the trend rule passes (items repeated across sessions are stable and failures are slower)', /latency test-retest.*\): PASS \(r =/.test(res.report) && /latency of 🔁 minus ✅.*\): PASS \(/.test(res.report), line(res.report, /test-retest/) + ' ' + line(res.report, /minus/));
check('analyze: the trend is stated to compare readings, and the CSV is flagged as holding her speech when the recogniser runs', /readings, not items/.test(res.report) && /readings\.csv/.test(res.report) && /keep it in lab/i.test(res.report));
check('analyze: the staged table exists for the adult and the limits are restated', /### adult \/ staged/.test(res.report) && /overstate real performance/.test(res.report) && /Her audio is a child/.test(res.report));
check('analyze: the report shows how many readings had nobody speaking, per verdict', /No speech detected/.test(res.report) && /elsa \/ read: nobody spoke in ✅ 0 and 🔁 1 of/.test(res.report));

// a control that must come out as "no": the same recordings with verdicts that have nothing to do with what was said
const shuffledDir = join(root, 'lab-shuffled');
writeSession(shuffledDir, 'elsa-read-2', Array.from({ length: 60 }, (_, i) => ({ who: 'elsa', kind: 'read', text: texts[i % 8], latency: 400, ok: rnd() < 0.7, wrongSound: false, rep: i >= 8 })));
const res2 = run(shuffledDir);
const dtwRow2 = res2.table.get(`elsa|natural|${A_ROW}`), latRow2 = res2.table.get(`elsa|natural|${LAT}`);
check('analyze: with verdicts unrelated to the audio no signal passes (AUC near 0.5)', dtwRow2.adj > 0.25 && dtwRow2.adj < 0.75 && latRow2.adj > 0.25 && latRow2.adj < 0.75 && !/MFCC-DTW distance to the reference \(closer = better\): PASS/.test(res2.report) && !new RegExp(`${LAT.replace(/[()]/g, '\\$&')}: PASS`).test(res2.report), `${dtwRow2.adj.toFixed(2)} ${latRow2.adj.toFixed(2)}`);
check('analyze: and the trend rule does not pass either (and a single session cannot give a test-retest)', /latency of 🔁 minus ✅.*\): FAIL \(/.test(res2.report) && /latency test-retest.*: NOT ENOUGH DATA/.test(res2.report), line(res2.report, /minus/));

// item difficulty must not pass for a signal: long items fail more, but inside each item duration says nothing about the verdict
const confDir = join(root, 'lab-confound');
const conf = [];
for (let i = 0; i < 48; i++) conf.push({ who: 'elsa', kind: 'read', text: 'ma', latency: 300, dur: 300 + (i % 5) * 10, ok: i % 6 !== 5, rep: i >= 1 }); // verdict and duration vary independently inside each item
for (let i = 0; i < 32; i++) conf.push({ who: 'elsa', kind: 'read', text: 'pe', latency: 300, dur: 700 + (i % 5) * 10, ok: i % 4 === 0, rep: i >= 1 });
writeSession(confDir, 'elsa-read-5', conf);
const res3 = run(confDir);
const durRow = res3.table.get(`elsa|natural|${DUR}`);
check('analyze: a signal that only detects which item it was (long words fail more) has a high raw AUC but about 0.5 once each item is compared with itself', durRow.auc > 0.7 && durRow.adj < 0.7, `raw ${durRow.auc.toFixed(2)} adjusted ${durRow.adj.toFixed(2)}`);
check('analyze: and the decision line uses the adjusted value, so it does not pass', !new RegExp(`${DUR.replace(/[()]/g, '\\$&')}: PASS`).test(res3.report) && new RegExp(`${DUR.replace(/[()]/g, '\\$&')}: FAIL`).test(res3.report), line(res3.report, /duration/));

// a retried reading: its timing is not a first reaction, but its sound still counts
const triesDir = join(root, 'lab-tries');
const tr = Array.from({ length: 35 }, (_, i) => ({ who: 'elsa', kind: 'read', text: texts[i % 8], latency: 300, ok: i % 7 !== 6, wrongSound: i % 7 === 6 }));
tr.push({ who: 'elsa', kind: 'read', text: 'ma', latency: 3000, ok: true, tries: 2 });
writeSession(triesDir, 'elsa-read-6', tr);
const res4 = run(triesDir);
check('analyze: a retried reading is left out of the timing signals and kept in the similarity one', res4.table.get(`elsa|natural|${LAT}`).pos === 30 && res4.table.get(`elsa|natural|${A_ROW}`).pos === 31, `${res4.table.get(`elsa|natural|${LAT}`).pos} ${res4.table.get(`elsa|natural|${A_ROW}`).pos}`);

// the control cannot fail by "best signal" having too little data: a recogniser that only ran on a few readings must not hide the distance
const ctlDir = join(root, 'lab-asr');
writeSession(ctlDir, 'adult-read-7', Array.from({ length: 24 }, (_, i) => ({ who: 'adult', kind: 'read', text: texts[i % 8], latency: 300, ok: true })));
writeSession(ctlDir, 'adult-wrong-7', Array.from({ length: 24 }, (_, i) => ({ who: 'adult', kind: 'wrong', text: texts[i % 8], latency: 300, ok: false, wrongSound: true })));
let asrDirSeen = null;
const partial = (readings, model, asrDir) => { asrDirSeen = asrDir; for (const r of readings) { if (r.n < 6) r.asrText = r.kind === 'read' ? r.text : (r.text === 'ma' ? 'me' : 'zzzz'); } };
const outAsr = join(root, 'out-asr');
const res5 = analyze({ labDir: ctlDir, audioDir, sessions: [], asr: 'fake', recogniser: partial, outDir: outAsr });
check('analyze: a recogniser that only produced a few transcripts does not hide a distance signal that has enough readings', /Positive control.*PASS/.test(line(res5.report, /Positive control/)), line(res5.report, /Positive control/));
check('analyze: the tolerant recogniser signal is the exact one for syllables (one edit turns "ma" into "me")', rows.length > 0 && res5.readings.filter((r) => r.asrText === 'me').length > 0 && res5.readings.filter((r) => r.asrText === 'me').every((r) => r.asrTol === false));
check('analyze: the recogniser copies of her voice stay under the lab folder, not under --out', asrDirSeen && asrDirSeen.startsWith(ctlDir) && !asrDirSeen.startsWith(outAsr), String(asrDirSeen));

// a noisy room is reported, as the plan says
const snrDir = join(root, 'lab-snr');
writeSession(snrDir, 'elsa-read-8', Array.from({ length: 6 }, (_, i) => ({ who: 'elsa', kind: 'read', text: texts[i], latency: 400, ok: true, noiseAmp: 0.1 })));
const res6 = run(snrDir);
check('analyze: readings with speech less than 15 dB above the noise are counted in a setup warning', /less than 15 dB/.test(res6.report) && res6.readings.filter((r) => r.snrDb < 15).length >= 5, line(res6.report, /15 dB/));

// the recorder's own start lag is part of the reaction time, and a recorder that started late may have missed the beginning
const lagDir = join(root, 'lab-lag');
writeSession(lagDir, 'elsa-read-9', [
  { who: 'elsa', kind: 'read', text: 'ma', latency: 300, ok: true, startLag: 60 },
  { who: 'elsa', kind: 'read', text: 'pe', latency: 300, ok: true, startLag: 1259 },
  { who: 'elsa', kind: 'read', text: 'mo', latency: 300, ok: true },
  { who: 'elsa', kind: 'read', text: 'pi', latency: 350, ok: false, wrongSound: true, startLag: 80 },
]);
const res10 = run(lagDir);
const byN = new Map(res10.readings.map((r) => [r.n, r]));
check('analyze: the latency is the onset inside the clip plus the time the recorder took to start', Math.abs(byN.get(0).latencyMs - 360) <= 20 && Math.abs(byN.get(1).latencyMs - 1559) <= 20 && Math.abs(byN.get(2).latencyMs - 300) <= 20, [0, 1, 2].map((n) => byN.get(n).latencyMs).join(' '));
check('analyze: a recorder that started more than 0.4 s late is flagged and left out of the timing signals but not of the similarity one', byN.get(1).lateStart === true && byN.get(0).lateStart === false && res10.table.get(`elsa|natural|${LAT}`).pos === 2 && res10.table.get(`elsa|natural|${A_ROW}`).pos === 3, `${res10.table.get(`elsa|natural|${LAT}`).pos} ${res10.table.get(`elsa|natural|${A_ROW}`).pos}`);
check('analyze: the report counts the late starts and says the first reading of a page is the usual one', /Recorder started late.*1 of 4/.test(res10.report.replace(/\n/g, ' ')) , res10.report.split('\n').find((l) => /late/.test(l)));

// the positive control must be able to fail: "wrong" adult readings that sound exactly like the correct ones
const ctlFail = join(root, 'lab-control-fail');
writeSession(ctlFail, 'adult-read-3', Array.from({ length: 24 }, (_, i) => ({ who: 'adult', kind: 'read', text: texts[i % 8], latency: 300, ok: true })));
writeSession(ctlFail, 'adult-wrong-3', Array.from({ length: 24 }, (_, i) => ({ who: 'adult', kind: 'wrong', text: texts[i % 8], latency: 300, ok: false, wrongSound: false })));
const res7 = run(ctlFail);
const ctlLine = line(res7.report, /Positive control/);
check('analyze: a positive control that cannot tell the readings apart is reported as FAIL with the instruction to stop', /\*\* FAIL/.test(ctlLine) && /not sound/.test(ctlLine) && !/PASS/.test(ctlLine), ctlLine);
const smallDir = join(root, 'lab-small');
writeSession(smallDir, 'adult-read-4', Array.from({ length: 6 }, (_, i) => ({ who: 'adult', kind: 'read', text: texts[i], latency: 300, ok: true })));
writeSession(smallDir, 'adult-wrong-4', Array.from({ length: 6 }, (_, i) => ({ who: 'adult', kind: 'wrong', text: texts[i], latency: 300, ok: false, wrongSound: true })));
const res8 = run(smallDir);
check('analyze: with too few adult readings the control says NOT ENOUGH DATA, never PASS', /Positive control.*NOT ENOUGH DATA/.test(res8.report) && !/Positive control.*PASS/.test(res8.report));
const res9 = analyze({ labDir: join(root, 'nothing-here'), audioDir, sessions: [], asr: 'none', outDir: join(root, 'out9') });
check('analyze: an empty lab folder gives an empty report, not a crash', res9.readings.length === 0 && /NOT ENOUGH DATA/.test(res9.report));

rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} lab-analyze test(s) FAILED` : '\nAll lab-analyze tests passed');
process.exit(failures ? 1 : 0);
