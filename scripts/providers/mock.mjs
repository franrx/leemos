// Offline test provider: short beeps (needs ffmpeg). Lets you test the whole pipeline without an API key.
import { spawnSync } from 'node:child_process';
export async function synthesize({ text }) {
  const dur = Math.min(1.2, 0.25 + text.length * 0.05);
  const freq = 300 + ((text.length * 40) % 400);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${dur}`, '-ac', '1', '-f', 'mp3', 'pipe:1'], { maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error('The mock provider needs ffmpeg installed');
  return r.stdout;
}
