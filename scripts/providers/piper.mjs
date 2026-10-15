// Piper: free, local neural TTS. https://github.com/rhasspy/piper (needs the `piper` binary, a .onnx voice model, and ffmpeg)
// .env: PIPER_MODEL_ES, PIPER_MODEL_CA (paths to .onnx models), optional PIPER_BIN (default "piper").
// Quality is below the paid services, but it costs nothing and runs offline.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// A letter sound arrives as <phoneme alphabet='ipa' ph='mː'>m</phoneme> (see scripts/spoken.mjs).
// Returns the IPA, or null for plain text.
export function ipaFrom(text) {
  const m = /<phoneme[^>]*\bph=['"]([^'"]+)['"]/.exec(text);
  return m ? m[1] : null;
}

export async function synthesize({ text, lang, env }) {
  const model = env['PIPER_MODEL_' + lang.toUpperCase()];
  if (!model) throw new Error('Falta PIPER_MODEL_ES / PIPER_MODEL_CA en .env (ruta a un modelo .onnx)');
  const dir = mkdtempSync(join(tmpdir(), 'leemos-piper-'));
  const wav = join(dir, 'out.wav');
  try {
    const ipa = ipaFrom(text);
    if (ipa) {
      // IPA goes straight to the voice (no text-to-phoneme step): needs the Python package, see .env.example.
      if (!env.PIPER_PY) throw new Error('Falta PIPER_PY en .env (python con piper-tts) para los sonidos en IPA');
      const q = spawnSync(env.PIPER_PY, [join(HERE, 'piper_ipa.py'), model, ipa, wav, env.PIPER_SOUND_LENGTH || '2'], { encoding: 'utf8' });
      if (q.status !== 0) throw new Error('piper_ipa failed: ' + (q.stderr || q.error || '').toString().slice(-300));
    } else {
      const p = spawnSync(env.PIPER_BIN || 'piper', ['--model', model, '--output_file', wav], { input: text, encoding: 'utf8' });
      if (p.status !== 0) throw new Error('piper failed: ' + (p.stderr || p.error || '').toString().slice(0, 200));
    }
    const f = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-ac', '1', '-f', 'mp3', 'pipe:1'], { maxBuffer: 1 << 26 });
    if (f.status !== 0) throw new Error('ffmpeg failed converting piper output');
    return f.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
