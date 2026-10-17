// Tests for sw.js audio caching, run in a Node vm with a fake service-worker environment.
// A clip URL with a different ?v= revision must be fetched again; the same URL must come from the cache.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };

const handlers = {};
const store = new Map();
const network = [];
const keyOf = (k) => (typeof k === 'string' ? k : k.url);
class Request { constructor(url) { this.url = url.startsWith('http') ? url : 'https://localhost' + url; this.method = 'GET'; this.headers = { has: () => false }; } }
const ctx = {
  self: { addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting() {}, clients: { claim() {} } },
  location: { origin: 'https://localhost' },
  URL, Request, Response: class {},
  caches: { open: async () => ({ match: async (k) => store.get(keyOf(k)), put: async (k, r) => { store.set(keyOf(k), r); } }), keys: async () => [], delete: async () => true },
  fetch: async (req) => { network.push(req.url); return { ok: true, tag: req.url, clone() { return this; } }; },
};
vm.createContext(ctx);
vm.runInContext(readFileSync(join(ROOT, 'sw.js'), 'utf8'), ctx);

async function get(url) {
  const req = new Request(url);
  let answer;
  handlers.fetch({ request: req, respondWith: (p) => { answer = p; } });
  return answer ? answer : null;
}

await get('/audio/es/m.mp3?v=1');
await get('/audio/es/m.mp3?v=1');
check('sw: the same clip revision is fetched once and then served from the cache', network.length === 1, network.join(','));
await get('/audio/es/m.mp3?v=2');
check('sw: a new revision of the same clip is fetched again (a re-recorded clip reaches installed devices)', network.length === 2 && network[1].endsWith('?v=2'), network.join(','));
await get('/audio/es/ma.mp3');
await get('/audio/es/ma.mp3');
check('sw: a clip without a revision is still cached by its plain path', network.length === 3);

// accounts: requests to Supabase (another origin) must never be intercepted or cached by the service worker
const before = network.length;
const supaAnswer = await get('https://x.supabase.co/rest/v1/child_profiles?select=id');
const authAnswer = await get('https://x.supabase.co/auth/v1/token?grant_type=refresh_token');
check('sw: requests to the Supabase origin are left alone (never intercepted or cached)', supaAnswer === null && authAnswer === null && network.length === before && ![...store.keys()].some((k) => k.includes('supabase')));

console.log(failures ? `\n${failures} sw test(s) FAILED` : '\nAll sw tests passed');
process.exit(failures ? 1 : 0);
