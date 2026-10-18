// Listen to the voice-progress experiment's recordings (plan: docs/superpowers/plans/2026-10-17-voice-progress-experiment.md).
// The recordings are .webm files under lab/ and lab/ is deliberately never served over HTTP (it holds a child's voice), so this works on the files directly:
//   node scripts/lab-play.mjs                          list the sessions
//   node scripts/lab-play.mjs <session>                list the readings: what was shown, the verdict, how long
//   node scripts/lab-play.mjs <session> --play [n]     play them one after another with afplay (macOS), or only reading n
//   node scripts/lab-play.mjs <session> --export       write lab/<session>/wav/<n>-<text>-<verdict>.wav (double-click them in Finder)
import { readdirSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/clips.mjs';

const SESSION = /^[a-z0-9-]{3,40}$/;
const READING = /^(\d+)\.webm$/;

function sessionDir(labDir, name) {
  if (!SESSION.test(name || '')) throw new Error('bad session name (use the folder name inside lab/)');
  const dir = join(labDir, name);
  if (!existsSync(dir)) throw new Error(`session not found: ${name}`);
  return dir;
}
const readingsOf = (dir) => readdirSync(dir).map((f) => READING.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);

export function listSessions(labDir) {
  if (!existsSync(labDir)) return [];
  return readdirSync(labDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && SESSION.test(d.name) && d.name !== 'asr')
    .map((d) => ({ name: d.name, readings: readingsOf(join(labDir, d.name)).length }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function labelsOf(dir) {
  const f = join(dir, 'labels.jsonl'), byN = new Map();
  if (!existsSync(f)) return byN;
  for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) { try { const o = JSON.parse(line); byN.set(o.n, o); } catch { /* a broken line is skipped */ } }
  return byN;
}
const seconds = (file) => { const x = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout); return Number.isFinite(x) ? x : null; };

// -> [{ n, text, key, verdict, kind, who, seconds, file }] for every recording of the session (labels may be missing)
export function describeSession(labDir, name) {
  const dir = sessionDir(labDir, name), labels = labelsOf(dir);
  return readingsOf(dir).map((n) => {
    const l = labels.get(n) || {}, file = join(dir, `${n}.webm`);
    return { n, text: l.text ?? null, key: l.key ?? null, verdict: l.verdict ?? null, kind: l.kind ?? null, who: l.who ?? null, seconds: seconds(file), file };
  });
}

const safe = (s) => String(s).toLowerCase().replace(/ñ/g, 'ny').normalize('NFD').replace(/[^a-z0-9]/g, '');
const toWav = (src, dst) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-ac', '1', dst]); if (r.status !== 0) throw new Error(`ffmpeg could not convert ${src}`); };

// Writes one wav per reading next to the originals, which are never touched. Returns the paths.
export function exportWav(labDir, name) {
  const dir = sessionDir(labDir, name), out = join(dir, 'wav');
  mkdirSync(out, { recursive: true });
  return describeSession(labDir, name).map((r) => {
    const dst = join(out, r.text === null ? `${r.n}-unlabelled.wav` : `${r.n}-${safe(r.text)}-${r.verdict || 'unlabelled'}.wav`);
    toWav(r.file, dst);
    return dst;
  });
}

const mark = (r) => `#${r.n}  ${r.text === null ? '(no label)' : `"${r.text}"`}  ${r.verdict === 'ok' ? '✅' : r.verdict === 'fail' ? '🔁' : ''}  ${r.seconds === null ? '' : r.seconds.toFixed(1) + ' s'}`;

function play(labDir, name, only) {
  if (spawnSync('afplay', ['-h']).error) throw new Error('afplay (macOS) is not available here: use --export and open the wav files instead');
  const tmp = mkdtempSync(join(tmpdir(), 'leemos-play-'));
  try {
    for (const r of describeSession(labDir, name)) {
      if (only !== null && r.n !== only) continue;
      const wav = join(tmp, `${r.n}.wav`);
      toWav(r.file, wav);
      console.log(mark(r));
      spawnSync('afplay', [wav], { stdio: 'inherit' });
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ---- command line
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const labDir = join(ROOT, 'lab'), args = process.argv.slice(2);
  try {
    const name = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
    if (!name) {
      const s = listSessions(labDir);
      if (!s.length) console.log('No sessions in lab/ yet.');
      for (const x of s) console.log(`${x.name}   ${x.readings} readings`);
      if (s.length) console.log('\nNext: node scripts/lab-play.mjs <session> [--play [n] | --export]');
    } else if (args.includes('--export')) {
      const files = exportWav(labDir, name);
      console.log(`${files.length} wav files in lab/${name}/wav/ (open them in Finder).`);
    } else if (args.includes('--play')) {
      const i = args.indexOf('--play'), n = /^\d+$/.test(args[i + 1] || '') ? Number(args[i + 1]) : null;
      play(labDir, name, n);
    } else {
      for (const r of describeSession(labDir, name)) console.log(`${mark(r)}  ${r.kind || ''}`);
    }
  } catch (e) { console.error(e.message); process.exit(1); }
}
