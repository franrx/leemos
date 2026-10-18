// Recording export: the clip list for tools/record.html, and saving a recording into audio/ + manifest.json
// exactly as the generator would (same file names), so it works on every device after a commit.
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, buildClipList, slug } from './clips.mjs';
import { postprocess } from './post.mjs';

export const LANGS = ['es', 'ca'];
export const MAX_BYTES = 5 * 1024 * 1024;
const MIN_BYTES = 400;
const fail = (status, message) => Object.assign(new Error(message), { status });
const readJSON = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

// Clips a parent records, in teaching order: every letter sound first, then the picture words.
// `shared` marks keys Elsa's syllable screens also use (recording them replaces her clip too).
export function recordList({ lang, audioDir = join(ROOT, 'audio') }) {
  if (!LANGS.includes(lang)) throw fail(400, 'bad language');
  const readerKeys = new Set();
  for (const L of readJSON(`src/data/levels.${lang}.json`)) {
    L.syl.forEach((s) => readerKeys.add(s));
    for (const o of L.words) {
      o.w.split('-').forEach((p) => readerKeys.add(p));
      readerKeys.add(o.w.replace(/-/g, ''));
    }
  }
  const letters = readJSON(`src/data/sounds.${lang}.json`).groups.flatMap((g) => g.letters);
  const entry = (text, kind, extra) => {
    const key = text.toLowerCase();
    const file = slug(key) + '.mp3';
    return { key, text, kind, file, has: existsSync(join(audioDir, lang, file)), shared: readerKeys.has(key), ...extra };
  };
  return [
    ...letters.map((x) => entry(x.l, 'sound', { word: x.w, emoji: x.e })),
    ...letters.map((x) => entry(x.w, 'word', { emoji: x.e })),
    ...buildClipList({ langs: [lang] }).filter((c) => c.kind === 'stretch').map((c) => entry(c.key, 'stretch', { shown: c.text })),
  ];
}

// Any recording format the browser produces (webm/opus, mp4/aac, ogg, wav) -> trimmed, normalised mono mp3.
export function convertToMp3(buf, type = '') {
  const ext = /mp4|aac|m4a/.test(type) ? 'mp4' : /ogg/.test(type) ? 'ogg' : /wav/.test(type) ? 'wav' : 'webm';
  const dir = mkdtempSync(join(tmpdir(), 'leemos-rec-'));
  try {
    const inp = join(dir, 'in.' + ext);
    const out = join(dir, 'out.mp3');
    writeFileSync(inp, buf);
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', inp, '-ac', '1', '-ar', '44100', '-b:a', '64k', out]);
    if (r.status !== 0) throw fail(500, 'ffmpeg could not read the recording (is ffmpeg installed?): ' + (r.stderr || r.error || '').toString().slice(0, 160));
    return postprocess(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Per-clip revision. The app asks for audio/<lang>/<file>?v=<rev>, so a regenerated or re-recorded clip is fetched again
// by devices that already cached the old file (the service worker caches audio by URL). Strictly increasing per clip.
export function bumpRev(manifest, lang, key) {
  manifest.rev ||= {};
  manifest.rev[lang] ||= {};
  manifest.rev[lang][key] = Math.max(Date.now(), (manifest.rev[lang][key] || 0) + 1);
}

export function saveClip({ audioDir = join(ROOT, 'audio'), lang, key, input, type = '', convert = convertToMp3 }) {
  if (!LANGS.includes(lang)) throw fail(400, 'bad language');
  const k = String(key || '').toLowerCase();
  const clip = buildClipList({ langs: [lang] }).find((c) => c.key === k);
  if (!clip) throw fail(404, 'unknown clip');
  if (!Buffer.isBuffer(input) || input.length < MIN_BYTES) throw fail(400, 'the recording is empty');
  if (input.length > MAX_BYTES) throw fail(413, 'the recording is too large');
  const mp3 = convert(input, type);
  mkdirSync(join(audioDir, lang), { recursive: true });
  writeFileSync(join(audioDir, lang, clip.file), mp3);
  const mp = join(audioDir, 'manifest.json');
  const manifest = existsSync(mp) ? JSON.parse(readFileSync(mp, 'utf8')) : { clips: {} };
  manifest.clips ||= {};
  for (const l of LANGS) manifest.clips[l] ||= {};
  manifest.clips[lang][clip.key] = clip.file;
  bumpRev(manifest, lang, clip.key);
  manifest.generated = new Date().toISOString(); // the app re-downloads clips when this stamp changes
  writeFileSync(mp, JSON.stringify(manifest, null, 1) + '\n');
  return { file: clip.file, key: clip.key, lang };
}
