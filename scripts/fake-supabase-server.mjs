// Development-only stand-in for the Supabase project, so that QA of accounts, classes and sharing never touches the real one
// (whose URL is committed in src/data/sync.config.json). It is the in-memory fake the tests use (tests/lib/fake-supabase.mjs)
// behind plain HTTP on 127.0.0.1:5174, with CORS, and a few seeded accounts. Everything is lost when it stops.
//
//   node scripts/fake-supabase-server.mjs
//   LEEMOS_SYNC_CONFIG_JSON='{"url":"http://127.0.0.1:5174","anonKey":"dev"}' npm run dev
//
// Sign in with any of the emails below; the emailed code is always 123456.
import { createServer } from 'node:http';
import { createFakeSupabase } from '../tests/lib/fake-supabase.mjs';

export const SEED = { parent: 'padre@example.com', teacher: 'profe@example.com', newTeacher: 'profe-nuevo@example.com', admin: 'admin@example.com', code: '123456' };

export function seed(fake) {
  fake.setRole(SEED.parent, 'parent');
  fake.setRole(SEED.teacher, 'teacher', { ack: true });
  fake.setRole(SEED.newTeacher, 'teacher', { ack: false }); // has to accept the acknowledgement first
  fake.setRole(SEED.admin, 'admin');
  const cls = fake.addClass('3A');
  fake.addTeacher(cls, SEED.teacher);
  fake.addTeacher(cls, SEED.newTeacher);
  const id = crypto.randomUUID();
  const data = { stats: { 's:ma': { ok: 3, fail: 0 }, 's:me': { ok: 2, fail: 0 } }, total: 5, stk: {}, stickers: 0, pre: { es: 0, ca: 0 }, resets: { es: 0, ca: 0 }, level: 0, name: 'Nuria', modAt: 2 };
  fake.rows.set(id, { id, owner: null, class_id: cls, name: 'Nuria', kind: 'reader', data, version: 1 }); // an unclaimed child of the class
  return { cls, child: id };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type, prefer, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Max-Age': '600',
};

export function startFakeServer({ port = Number(process.env.PORT || 5174), host = '127.0.0.1' } = {}) {
  const fake = createFakeSupabase({ code: SEED.code });
  const seeded = seed(fake);
  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        const r = await fake.fetch(`http://${host}:${port}${req.url}`, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks).toString() : undefined });
        if (r.status === 204) { res.writeHead(204, CORS); return res.end(); }
        res.writeHead(r.status, { ...CORS, 'Content-Type': 'application/json' });
        res.end(await r.text());
      } catch (e) {
        res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'fake server error' }));
      }
    });
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({ server, fake, seeded, port: server.address().port })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startFakeServer();
  console.log(`Supabase de pruebas en http://127.0.0.1:${port} (solo memoria). Código de acceso: ${SEED.code}`);
  console.log(`Cuentas: ${SEED.parent} (familia), ${SEED.teacher} (profesor), ${SEED.newTeacher} (profesor sin aceptar), ${SEED.admin} (admin)`);
  console.log(`App: LEEMOS_SYNC_CONFIG_JSON='{"url":"http://127.0.0.1:${port}","anonKey":"dev"}' npm run dev`);
}
