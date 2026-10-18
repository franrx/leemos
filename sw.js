// Service worker: makes the app installable and usable offline.
//  - app shell + data: network-first (always fresh while developing/online), cache fallback offline
//  - audio clips: cache-first, with Range support (Safari asks for media in byte ranges)
// Bump VERSION when you change the SHELL list.
const VERSION = 'leemos-v18';
const SHELL = [
  './', 'index.html', 'src/styles.css', 'src/app.js', 'src/sounds.js', 'src/find.js', 'src/close.js', 'src/merge.js', 'src/levelrule.js', 'src/sync.js', 'manifest.webmanifest',
  'src/data/levels.es.json', 'src/data/levels.ca.json', 'src/data/worlds.json',
  'src/data/sounds.es.json', 'src/data/sounds.ca.json', 'src/data/closed.es.json', 'src/data/closed.ca.json', 'src/data/sync.config.json',
  'src/data/stickers.json', 'src/data/i18n.es.json', 'src/data/i18n.ca.json',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function rangeResponse(req, res) {
  const buf = await res.arrayBuffer();
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.get('range') || '');
  if (!m) return new Response(buf, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), buf.byteLength - 1) : buf.byteLength - 1;
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`,
      'Content-Length': String(end - start + 1),
    },
  });
}

async function audio(req) {
  const cache = await caches.open(VERSION);
  const u = new URL(req.url);
  const key = new Request(u.pathname + u.search); // the ?v=<revision> is part of the key: a re-recorded clip is a new entry
  let res = await cache.match(key);
  if (!res) {
    const net = await fetch(new Request(req.url)); // full file, no Range header
    if (!net.ok) return net;
    await cache.put(key, net.clone());
    res = net;
  }
  return req.headers.has('range') ? rangeResponse(req, res) : res;
}

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const net = await fetch(req);
    if (net.ok && (net.type === 'basic' || net.type === 'cors')) cache.put(req, net.clone());
    return net;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.includes('/audio/') && url.pathname.endsWith('.mp3')) {
    e.respondWith(audio(req));
  } else if (url.origin === location.origin || /(^|\.)(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(networkFirst(req));
  }
});
