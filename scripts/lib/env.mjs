// Reads .env (never committed) merged under the real environment variables. Shared by the audio scripts.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './clips.mjs';

export function loadEnv() {
  const env = { ...process.env };
  const p = join(ROOT, '.env');
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#') && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}
