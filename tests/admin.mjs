// Tests for tools/admin.js (mountAdmin) in jsdom against the fake Supabase (Task 7).
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSupabase, memoryStorage } from './lib/fake-supabase.mjs';
import { createSync } from '../src/sync.js';
import { mountAdmin, t } from '../tools/admin.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 20; i++) await sleep(0); };

async function open(email, setup = () => {}) {
  const srv = createFakeSupabase();
  const storage = memoryStorage();
  const sync = createSync({ url: 'https://x.supabase.co', anonKey: 'anon', fetch: srv.fetch, storage });
  await sync.requestCode(email); await sync.verifyCode(email, '123456');
  setup(srv);
  const dom = new JSDOM('<main id="app"></main>');
  const root = dom.window.document.getElementById('app');
  await mountAdmin(root, sync, t);
  return { srv, root, doc: dom.window.document, sync };
}
const byLabel = (root, re) => [...root.querySelectorAll('button')].filter((b) => re.test(b.getAttribute('aria-label') || ''));
const click = async (b) => { b.click(); await settle(); };
const type = (inp, v) => { inp.value = v; };
const kid = (srv, id, classId, claimed, name) => { srv.rows.set(id, { id, owner: null, class_id: classId, name, kind: 'reader', data: {}, version: 1 }); if (claimed) srv.links.set(id, new Set(['user-x'])); };

{
  const { root } = await open('mama@e.c');
  check('admin: a parent session shows only "not an admin"', root.textContent.trim() === 'Esta cuenta no es de administrador' && !root.querySelector('button, input'), root.textContent);
}
{
  const { root } = await open('admin@e.c', (srv) => {
    srv.setRole('admin@e.c', 'admin'); srv.setRole('prof@e.c', 'teacher', { ack: true }); srv.setRole('mama@parent.c', 'parent');
    srv.inviteTeacher('nueva@e.c'); const c = srv.addClass('3A'); srv.addTeacher(c, 'prof@e.c'); kid(srv, 'k1', c, false, 'Nombre Secreto');
  });
  const txt = root.textContent;
  check('admin: an admin lists teachers and pending invitations and no parent email', txt.includes('prof@e.c') && txt.includes('admin@e.c') && txt.includes('nueva@e.c') && !txt.includes('mama@parent.c') && txt.includes('3A') && /1 niños, 1 sin familia/.test(txt) && !txt.includes('Nombre Secreto'), txt);
}
{
  const { root, srv } = await open('admin@e.c', (s) => s.setRole('admin@e.c', 'admin'));
  type(root.querySelector('input[type=email]'), 'Otra@E.c');
  await click([...root.querySelectorAll('button')].find((b) => b.textContent === 'Invitar'));
  const added = root.textContent.includes('otra@e.c') && srv.roleInvites.has('otra@e.c');
  await click(byLabel(root, /^Revocar invitación: otra@e.c$/)[0]);
  check('admin: inviting then revoking an email updates the list', added && !root.textContent.includes('otra@e.c') && !srv.roleInvites.has('otra@e.c'));
}
{
  let cid;
  const { root, srv } = await open('admin@e.c', (s) => { s.setRole('admin@e.c', 'admin'); cid = s.addClass('3A'); kid(s, 'k1', cid, false, 'Ana'); kid(s, 'k2', cid, false, 'Beto'); kid(s, 'k3', cid, true, 'Cleo'); });
  await click(byLabel(root, /^Borrar clase: 3A$/)[0]);
  check('admin: deleting a class with orphans shows the count and does not delete', srv.classes.has(cid) && root.textContent.includes('Cantidad: 2') && root.textContent.includes('3A') && !/Ana|Beto|Cleo/.test(root.textContent), root.textContent);
}
{
  let cid;
  const { root, srv } = await open('admin@e.c', (s) => { s.setRole('admin@e.c', 'admin'); s.setRole('prof@e.c', 'teacher', { ack: true }); cid = s.addClass('3A'); s.addTeacher(cid, 'prof@e.c'); kid(s, 'k1', cid, false, 'Ana'); });
  const uid = srv.userByEmail('prof@e.c').id;
  await click(byLabel(root, /^Quitar rol de profesor: prof@e.c$/)[0]);
  const asked = !!root.querySelector('[role=alertdialog]') && srv.accounts.get(uid).role === 'teacher' && root.textContent.includes('3A');
  await click([...root.querySelectorAll('[role=alertdialog] button')].find((b) => b.textContent === 'Cancelar'));
  const cancelled = !root.querySelector('[role=alertdialog]') && srv.accounts.get(uid).role === 'teacher';
  await click(byLabel(root, /^Quitar rol de profesor: prof@e.c$/)[0]);
  await click([...root.querySelectorAll('[role=alertdialog] button')].find((b) => b.textContent === 'Quitar el rol igualmente'));
  check('admin: demoting the last teacher of a class with unclaimed children asks first', asked && cancelled && srv.accounts.get(uid).role === 'parent', JSON.stringify({ asked, cancelled }));
}
{
  const { root } = await open('admin@e.c', (s) => { s.setRole('admin@e.c', 'admin'); s.setRole('prof@e.c', 'teacher', { ack: true }); const c = s.addClass('3A'); s.addTeacher(c, 'prof@e.c'); s.addClass('4B'); });
  const selects = root.querySelectorAll('select');
  const inputs = [...root.querySelectorAll('input')].map((i) => i.type);
  const labels = [...root.querySelectorAll('button, select, input')].map((e) => (e.getAttribute('aria-label') || e.textContent || '').toLowerCase());
  const allNamed = [...root.querySelectorAll('button, select, input')].every((e) => (e.getAttribute('aria-label') || e.textContent).trim());
  check('admin: the page has no control that sets an arbitrary role', !inputs.some((x) => ['radio', 'checkbox'].includes(x)) && !labels.some((l) => /\brol\b|role|administrador|hacer admin/.test(l.replace('quitar rol de profesor: prof@e.c', ''))) && [...selects].every((s) => s.getAttribute('aria-label') === 'Profesor a asignar') && allNamed, labels.join('|'));
  const demoteOnly = [...root.querySelectorAll('button')].filter((b) => /rol/i.test(b.getAttribute('aria-label'))).every((b) => /^Quitar rol de profesor: /.test(b.getAttribute('aria-label')));
  check('admin: the only role control is demote, and the page lists no child', demoteOnly);
}
{
  // empty config: the page makes no request
  const html = readFileSync(join(ROOT, 'tools/admin.html'), 'utf8');
  const src = readFileSync(join(ROOT, 'tools/admin.js'), 'utf8');
  const calls = [];
  const dom = new JSDOM(html.replace(/<script[^>]*><\/script>/, ''), { runScripts: 'outside-only' });
  dom.window.fetch = async (u) => { calls.push(String(u)); return { json: async () => ({ url: '', anonKey: '' }) }; };
  dom.window.eval(src.replace(/^export /gm, '')); // the page bootstrap runs on load, as a classic script here
  await settle();
  const shown = dom.window.document.getElementById('app').textContent;
  check('admin: with an empty config the page says so and makes no request to anything but the config file', shown === t('empty') && calls.length === 1 && calls[0].endsWith('sync.config.json'), JSON.stringify({ shown, calls }));
  check('admin: no innerHTML in the page script and no forbidden key name in the markup', !/innerHTML/.test(src) && !/service_role/.test(html + src));
}
if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('\nadmin: all passed');
