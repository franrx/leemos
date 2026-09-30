#!/usr/bin/env node
// Generates every clip once and writes audio/<lang>/<file>.mp3 + audio/manifest.json.
//
//   npm run audio -- --dry-run                       what would be generated, and how many characters
//   npm run audio -- --provider mock --limit 20      test the pipeline offline (needs ffmpeg)
//   npm run audio -- --provider elevenlabs --lang ca real run for Catalan only
//   npm run audio -- --provider azure --only "ma,me" regenerate specific clips (case-insensitive text)
//
// Flags: --provider <name>  --lang es|ca|all  --only a,b,c  --force  --limit N  --concurrency N
//        --no-post (skip ffmpeg trim/normalise)  --name Elsa  --dry-run
// Existing files are skipped unless --force or --only. Config comes from .env (see .env.example).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, buildClipList } from './lib/clips.mjs';
import { hasFfmpeg, postprocess } from './lib/post.mjs';
import { spokenFor } from './spoken.mjs';

function loadEnv() {
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

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) { a._.push(t); continue; }
    const k = t.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) a[k] = true;
    else { a[k] = next; i++; }
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      const retryable = !e.status || e.status === 429 || e.status >= 500;
      if (i >= tries || !retryable) throw e;
      await sleep(1000 * 2 ** i);
    }
  }
}

const env = loadEnv();
const args = parseArgs(process.argv.slice(2));
const provider = args.provider || env.PROVIDER || 'mock';
const name = args.name || env.NAME || 'Elsa';
const langs = !args.lang || args.lang === 'all' ? ['es', 'ca'] : String(args.lang).split(',');
const only = args.only ? new Set(String(args.only).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) : null;
const force = Boolean(args.force);
const limit = args.limit ? Number(args.limit) : Infinity;
const concurrency = Number(args.concurrency || 3);
const usePost = !args['no-post'] && hasFfmpeg();

let clips = buildClipList({ name, langs });
if (only) clips = clips.filter((c) => only.has(c.key));
const audioPath = (c) => join(ROOT, 'audio', c.lang, c.file);
let todo = clips.filter((c) => force || only || !existsSync(audioPath(c)));

if (args['dry-run']) {
  const chars = todo.reduce((n, c) => n + spokenFor(c).length, 0);
  const by = {};
  clips.forEach((c) => { const k = `${c.lang}/${c.kind}`; by[k] = (by[k] || 0) + 1; });
  console.log(`Clips en total: ${clips.length}  (${Object.entries(by).map(([k, v]) => `${k}=${v}`).join(', ')})`);
  console.log(`Por generar:    ${todo.length}   caracteres a enviar: ${chars}`);
  console.log(`Proveedor: ${provider}   nombre en las frases: ${name}   ffmpeg: ${hasFfmpeg() ? 'sí' : 'no'}`);
  process.exit(0);
}

todo = todo.slice(0, limit);
if (!todo.length) { console.log('Nada que generar.'); process.exit(0); }
if (!usePost && !args['no-post']) console.warn('Aviso: ffmpeg no está instalado; se guardan los clips sin recortar ni normalizar.');

const { synthesize } = await import(`./providers/${provider}.mjs`);
for (const l of langs) mkdirSync(join(ROOT, 'audio', l), { recursive: true });

const manifestPath = join(ROOT, 'audio', 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { clips: {} };
manifest.clips ||= {};
for (const l of ['es', 'ca']) manifest.clips[l] ||= {};
// make sure files that already exist on disk are listed (e.g. after a fresh checkout)
for (const c of clips) if (existsSync(audioPath(c))) manifest.clips[c.lang][c.key] = c.file;

let done = 0, failed = 0, idx = 0;
async function worker() {
  while (idx < todo.length) {
    const c = todo[idx++];
    try {
      let buf = await withRetry(() => synthesize({ text: spokenFor(c), lang: c.lang, kind: c.kind, env }));
      if (usePost) buf = postprocess(buf);
      writeFileSync(audioPath(c), buf);
      manifest.clips[c.lang][c.key] = c.file;
      done++;
      if (done % 25 === 0 || done === todo.length) console.log(`  ${done}/${todo.length}`);
    } catch (e) {
      failed++;
      console.error(`✗ [${c.lang}] "${c.text}": ${e.message}`);
      if (/Faltan|Falta|needs ffmpeg/.test(e.message)) { console.error('Configuración incompleta, abortando.'); process.exit(1); }
    }
  }
}
console.log(`Generando ${todo.length} clips con "${provider}" (${usePost ? 'con' : 'sin'} postprocesado)…`);
await Promise.all(Array.from({ length: concurrency }, worker));

manifest.generated = new Date().toISOString();
manifest.provider = provider;
manifest.name = name;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
console.log(`Hecho: ${done} generados, ${failed} con error. Manifest actualizado.`);
process.exit(failed ? 2 : 0);
