// Optional ffmpeg post-processing: trims leading/trailing silence, peak-normalises to about -3 dBFS,
// and re-encodes as mono 64 kbps mp3. Short clips need consistent loudness, so we use a peak pass, not loudnorm.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const hasFfmpeg = () => spawnSync('ffmpeg', ['-version']).status === 0;

const TRIM =
  'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.03,areverse,' +
  'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.06,areverse';

export function postprocess(buf) {
  const dir = mkdtempSync(join(tmpdir(), 'leemos-'));
  const inp = join(dir, 'in.mp3');
  const out = join(dir, 'out.mp3');
  try {
    writeFileSync(inp, buf);
    const probe = spawnSync('ffmpeg', ['-hide_banner', '-i', inp, '-af', TRIM + ',volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
    const mv = /max_volume:\s*(-?[\d.]+) dB/.exec(probe.stderr || '');
    const gain = mv ? Math.max(-6, Math.min(24, -3 - parseFloat(mv[1]))) : 0;
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', inp, '-af', `${TRIM},volume=${gain.toFixed(2)}dB`, '-ar', '44100', '-ac', '1', '-b:a', '64k', out]);
    if (r.status !== 0) throw new Error('ffmpeg failed: ' + (r.stderr || '').toString().slice(0, 200));
    const res = readFileSync(out);
    return res.length > 400 ? res : buf; // if trimming ate everything, keep the original
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
