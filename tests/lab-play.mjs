// Tests for scripts/lab-play.mjs (list, export to wav, play) on synthetic recordings (WAV bytes stored as .webm: ffmpeg sniffs the format).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { listSessions, describeSession, exportWav } from '../scripts/lab-play.mjs';

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const RATE = 16000;
const tone = (hz, ms) => Float32Array.from({ length: Math.round(RATE * ms / 1000) }, (_, i) => 0.3 * Math.sin(2 * Math.PI * hz * i / RATE));
const wav = (pcm) => {
  const b = Buffer.alloc(44 + pcm.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + pcm.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) b.writeInt16LE(Math.round(pcm[i] * 32767), 44 + i * 2);
  return b;
};
const duration = (f) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout);

const labDir = mkdtempSync(join(tmpdir(), 'leemos-lab-play-'));
const s1 = join(labDir, 'elsa-read-20261018100000');
mkdirSync(s1, { recursive: true });
writeFileSync(join(s1, '0.webm'), wav(tone(300, 500)));
writeFileSync(join(s1, '1.webm'), wav(tone(400, 800)));
writeFileSync(join(s1, '2.webm'), wav(tone(500, 600))); // no label for this one
writeFileSync(join(s1, 'labels.jsonl'), [
  JSON.stringify({ n: 0, text: 'ma', key: 's:ma', verdict: 'ok', kind: 'read', who: 'elsa', recMs: 700 }),
  JSON.stringify({ n: 1, text: 'casa', key: 'w:ca-sa', verdict: 'fail', kind: 'read', who: 'elsa', recMs: 1000 }),
].join('\n') + '\n');
const s2 = join(labDir, 'adult-wrong-20261018110000');
mkdirSync(s2, { recursive: true });
writeFileSync(join(s2, '0.webm'), wav(tone(600, 400)));
writeFileSync(join(s2, 'labels.jsonl'), JSON.stringify({ n: 0, text: 'pe', verdict: 'fail', kind: 'wrong', who: 'adult' }) + '\n');
mkdirSync(join(labDir, 'asr'), { recursive: true }); // the recogniser's folder is not a session

const sessions = listSessions(labDir);
check('list: every session with its number of readings, and the asr folder is not a session', sessions.length === 2 && sessions[0].name === 'adult-wrong-20261018110000' && sessions[1].name === 'elsa-read-20261018100000' && sessions[1].readings === 3 && sessions[0].readings === 1, JSON.stringify(sessions));
const d = describeSession(labDir, 'elsa-read-20261018100000');
check('describe: each reading with what was shown, the verdict and its length in seconds', d.length === 3 && d[0].text === 'ma' && d[0].verdict === 'ok' && Math.abs(d[0].seconds - 0.5) < 0.05 && d[1].text === 'casa' && d[1].verdict === 'fail' && Math.abs(d[1].seconds - 0.8) < 0.05, JSON.stringify(d));
check('describe: a recording with no label is still listed, as unlabelled', d[2].text === null && d[2].verdict === null && d[2].n === 2);
const files = exportWav(labDir, 'elsa-read-20261018100000');
const out = join(s1, 'wav');
check('export: one wav per reading, named with the reading number, the text and the verdict', files.length === 3 && existsSync(join(out, '0-ma-ok.wav')) && existsSync(join(out, '1-casa-fail.wav')) && existsSync(join(out, '2-unlabelled.wav')), readdirSync(out).join(','));
check('export: the wav files are real audio of the same length', Math.abs(duration(join(out, '0-ma-ok.wav')) - 0.5) < 0.05 && Math.abs(duration(join(out, '1-casa-fail.wav')) - 0.8) < 0.05);
check('export: the original recordings are untouched', readFileSync(join(s1, '0.webm')).equals(wav(tone(300, 500))) === true);
const again = exportWav(labDir, 'elsa-read-20261018100000');
check('export: running it again overwrites the same files and adds nothing', again.length === 3 && readdirSync(out).length === 3);
check('export: the exported folder is not read as a recording the next time', describeSession(labDir, 'elsa-read-20261018100000').length === 3 && listSessions(labDir).find((s) => s.name === 'elsa-read-20261018100000').readings === 3);
const bad = (name) => { try { describeSession(labDir, name); return null; } catch (e) { return e.message; } };
check('safety: a session name that is not a plain folder name is refused', /session/i.test(bad('../x') || '') && /session/i.test(bad('a/b') || '') && /session/i.test(bad('') || '') && /session/i.test(bad('nope-nope') || ''), String(bad('../x')));
check('empty: a folder with no sessions lists nothing', listSessions(join(labDir, 'nowhere')).length === 0);

rmSync(labDir, { recursive: true, force: true });
console.log(failures ? `\n${failures} lab-play test(s) FAILED` : '\nAll lab-play tests passed');
process.exit(failures ? 1 : 0);
