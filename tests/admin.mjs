// Tests for tools/admin.js (mountAdmin) in jsdom against the fake Supabase (Task 7).
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSupabase, memoryStorage } from './lib/fake-supabase.mjs';
import { createSync } from '../src/sync.js';
import { mountAdmin, bootAdmin, t } from '../tools/admin.js';

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
  await click([...root.querySelectorAll('[role=alertdialog] button')].find((b) => b.textContent === t('confirmDel')));
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
  // the demote warning: the safe answer has the focus, one dialog at a time, focus back on cancel, gone after a failed confirm
  let cid;
  const { root, srv, doc } = await open('admin@e.c', (s) => { s.setRole('admin@e.c', 'admin'); s.setRole('prof@e.c', 'teacher', { ack: true }); cid = s.addClass('3A'); s.addTeacher(cid, 'prof@e.c'); kid(s, 'k1', cid, false, 'Ana'); });
  const opener = () => byLabel(root, /^Quitar rol de profesor: prof@e.c$/)[0];
  await click(opener());
  const focusCancel = doc.activeElement && doc.activeElement.textContent === t('cancel') && root.querySelector('[role=alertdialog]').contains(doc.activeElement);
  await click(opener());
  const one = root.querySelectorAll('[role=alertdialog]').length === 1;
  await click([...root.querySelectorAll('[role=alertdialog] button')].find((b) => b.textContent === t('cancel')));
  const back = doc.activeElement === opener();
  await click(opener());
  srv.setOffline(true);
  await click([...root.querySelectorAll('[role=alertdialog] button')].find((b) => b.textContent === t('confirmDemote')));
  srv.setOffline(false);
  check('admin: the demote warning focuses Cancel, opens once, returns the focus on cancel and closes after a failed confirm',
    focusCancel && one && back && !root.querySelector('[role=alertdialog]') && root.querySelector('#adminStatus').textContent === t('failed') && srv.accounts.get(srv.userByEmail('prof@e.c').id).role === 'teacher', JSON.stringify({ focusCancel, one, back }));
}
{
  // no warning when the class keeps another teacher, or when every child has a family
  let c1, c2;
  const { root, srv } = await open('admin@e.c', (s) => {
    s.setRole('admin@e.c', 'admin'); s.setRole('p1@e.c', 'teacher', { ack: true }); s.setRole('p2@e.c', 'teacher', { ack: true }); s.setRole('p3@e.c', 'teacher', { ack: true });
    c1 = s.addClass('3A'); s.addTeacher(c1, 'p1@e.c'); s.addTeacher(c1, 'p2@e.c'); kid(s, 'k1', c1, false, 'Ana'); // two teachers, an unclaimed child
    c2 = s.addClass('4B'); s.addTeacher(c2, 'p3@e.c'); kid(s, 'k2', c2, true, 'Beto'); // one teacher, only claimed children
  });
  await click(byLabel(root, /^Quitar rol de profesor: p1@e.c$/)[0]);
  const noAsk1 = !root.querySelector('[role=alertdialog]') && srv.accounts.get(srv.userByEmail('p1@e.c').id).role === 'parent';
  await click(byLabel(root, /^Quitar rol de profesor: p3@e.c$/)[0]);
  const noAsk2 = !root.querySelector('[role=alertdialog]') && srv.accounts.get(srv.userByEmail('p3@e.c').id).role === 'parent';
  check('admin: demoting a teacher whose classes keep another teacher or have no unclaimed child asks nothing', noAsk1 && noAsk2, JSON.stringify({ noAsk1, noAsk2 }));
}
{
  // deleting a class asks first (its linked children leave it and the families must share again)
  let cid;
  const { root, srv, doc } = await open('admin@e.c', (s) => { s.setRole('admin@e.c', 'admin'); cid = s.addClass('3A'); kid(s, 'k1', cid, true, 'Ana'); });
  const del = () => byLabel(root, /^Borrar clase: 3A$/)[0];
  await click(del());
  const asked = !!root.querySelector('[role=alertdialog]') && srv.classes.has(cid) && root.querySelector('[role=alertdialog]').textContent.includes('3A') && doc.activeElement && doc.activeElement.textContent === t('cancel');
  await click([...root.querySelectorAll('[role=alertdialog] button')].find((b) => b.textContent === t('cancel')));
  const kept = srv.classes.has(cid) && !root.querySelector('[role=alertdialog]') && doc.activeElement === del();
  await click(del());
  await click([...root.querySelectorAll('[role=alertdialog] button')].find((b) => b.textContent === t('confirmDel')));
  check('admin: "Borrar clase" asks first; cancel keeps the class, confirm deletes it and the child keeps no class', asked && kept && !srv.classes.has(cid) && srv.rows.get('k1').class_id === null && !root.querySelector('[role=alertdialog]'), JSON.stringify({ asked, kept }));
}
{
  const { root } = await open('admin@e.c', (s) => { s.setRole('admin@e.c', 'admin'); s.addClass('3A'); s.addClass('4B'); });
  const labels = [...root.querySelectorAll('input')].map((i) => i.getAttribute('aria-label')).filter((l) => /^Nuevo nombre de la clase/.test(l));
  check('admin: each rename field names its class', labels.length === 2 && labels.includes('Nuevo nombre de la clase: 3A') && labels.includes('Nuevo nombre de la clase: 4B'), labels.join('|'));
}
{
  // the sign-in path: email, code, admin UI; "Salir" stays after a refresh (outside the re-rendered root) and brings the form back
  const srv = createFakeSupabase();
  srv.setRole('admin@e.c', 'admin'); srv.addClass('3A');
  const storage = memoryStorage();
  const sync = createSync({ url: 'https://x.supabase.co', anonKey: 'anon', fetch: srv.fetch, storage });
  const dom = new JSDOM('<h1>Administración</h1><main id="app"></main>');
  const doc = dom.window.document, root = doc.getElementById('app');
  await bootAdmin(doc, sync); await settle();
  const mail = root.querySelector('input[type=email]'), code = () => root.querySelector('input[autocomplete=one-time-code]'), go = () => root.querySelector('button');
  const formFirst = !!mail && code().hidden;
  mail.value = 'admin@e.c'; await click(go());
  const codeShown = !code().hidden;
  code().value = '123456'; await click(go()); await settle();
  const out = () => [...doc.querySelectorAll('button')].find((b) => b.textContent === t('signOut'));
  const mounted = root.textContent.includes(t('classes')) && !!out() && !out().hidden;
  const nc = [...root.querySelectorAll('input')].find((i) => i.getAttribute('aria-label') === t('newClass'));
  nc.value = '4B'; await click([...root.querySelectorAll('button')].find((b) => b.textContent === t('create'))); // an action re-renders the root
  const stays = root.textContent.includes('4B') && !!out() && !out().hidden && !root.contains(out());
  await click(out());
  check('admin: sign-in shows the code field, then the admin page; "Salir" survives a re-render and brings the form back',
    formFirst && codeShown && mounted && stays && storage.getItem('leemos-auth') === null && !!root.querySelector('input[type=email]') && out().hidden, JSON.stringify({ formFirst, codeShown, mounted, stays }));
}
{
  // a failure after the code (the admin page cannot load) is shown, not thrown
  const srv = createFakeSupabase();
  const storage = memoryStorage();
  const sync = createSync({ url: 'https://x.supabase.co', anonKey: 'anon', fetch: srv.fetch, storage });
  const dom = new JSDOM('<main id="app"></main>');
  const doc = dom.window.document, root = doc.getElementById('app');
  const errs = []; process.on('unhandledRejection', (e) => errs.push(String(e)));
  await bootAdmin(doc, { ...sync, me: async () => ({ get role() { throw new Error('boom'); } }) }); await settle(); // mounting the page throws after the code
  root.querySelector('input[type=email]').value = 'x@e.c'; await click(root.querySelector('button'));
  root.querySelector('input[autocomplete=one-time-code]').value = '123456'; await click(root.querySelector('button')); await settle();
  check('admin: a failure after signing in is shown on the page and never left unhandled', errs.length === 0 && root.textContent.includes(t('failed')), JSON.stringify({ errs, txt: root.textContent }));
}
{
  const html = readFileSync(join(ROOT, 'tools/admin.html'), 'utf8');
  check('admin: the page asks search engines not to index it', /<meta name="robots" content="noindex">/.test(html));
}
// A parent link a teacher's code gave: k1 (in the class) and k2 (taken out of every class) were claimed with prof's to_parent codes.
const granted = (s, cid, profEmail) => {
  const prof = s.userByEmail(profEmail).id;
  kid(s, 'k1', cid, true, 'Ana'); kid(s, 'k2', null, true, 'Beto');
  for (const k of ['k1', 'k2']) s.invites.push({ code: 'C' + k, kind: 'to_parent', child: k, by: prof, exp: Date.now() + 864e5, used: true, usedBy: 'user-x' });
};
{
  // demote: the links from that teacher's codes are reported, and the admin may drop the ones still in a class
  let cid;
  const { root, srv, doc } = await open('admin@e.c', (s) => { s.setRole('admin@e.c', 'admin'); s.setRole('prof@e.c', 'teacher', { ack: true }); s.setRole('otra@e.c', 'teacher', { ack: true }); cid = s.addClass('3A'); s.addTeacher(cid, 'prof@e.c'); s.addTeacher(cid, 'otra@e.c'); granted(s, cid, 'prof@e.c'); });
  await click(byLabel(root, /^Quitar rol de profesor: prof@e.c$/)[0]);
  const dlg = root.querySelector('[role=alertdialog]');
  const told = !!dlg && dlg.textContent.includes(`${t('grantIn')} 1`) && dlg.textContent.includes(t('grantOutside').slice(0, 20)) && doc.activeElement && doc.activeElement.textContent === t('keepLinks') && !/Ana|Beto/.test(root.textContent);
  await click([...dlg.querySelectorAll('button')].find((b) => b.textContent === t('dropLinks')));
  check("admin: demoting reports the parent links from the teacher's codes and «Quitar esos vínculos» drops the one still in a class",
    told && srv.links.get('k1').size === 0 && srv.rows.get('k1').class_id === cid && srv.links.get('k2').size === 1 && root.querySelector('#adminStatus').textContent === `${t('dropped')} 1` && !root.querySelector('[role=alertdialog]'), JSON.stringify({ told, txt: dlg && dlg.textContent }));
}
{
  // unassign: the same report for that class; keeping them changes nothing and the focus lands on the section heading
  let cid;
  const { root, srv, doc } = await open('admin@e.c', (s) => { s.setRole('admin@e.c', 'admin'); s.setRole('prof@e.c', 'teacher', { ack: true }); cid = s.addClass('3A'); s.addTeacher(cid, 'prof@e.c'); granted(s, cid, 'prof@e.c'); });
  const b = byLabel(root, /^Quitar de la clase: prof@e.c$/)[0]; b.focus();
  await click(b);
  const dlg = root.querySelector('[role=alertdialog]'), told = !!dlg && dlg.textContent.includes('1') && !dlg.textContent.includes(t('grantOutside').slice(0, 20));
  await click([...dlg.querySelectorAll('button')].find((x) => x.textContent === t('keepLinks')));
  check('admin: unassigning reports the class links; «Mantenerlos» keeps them and the focus goes to the section heading',
    told && srv.links.get('k1').size === 1 && !root.querySelector('[role=alertdialog]') && doc.activeElement && doc.activeElement.tagName === 'H2' && doc.activeElement.textContent === t('classes'), JSON.stringify({ told, a: doc.activeElement && doc.activeElement.outerHTML }));
}
{
  // fix iteration 4 (F002): the only grant is a child its family already took out of every class (parent_links 0, outside_class 1):
  // nothing can be dropped from here, so no dialog, but the admin is told how many there are
  const { root, srv } = await open('admin@e.c', (s) => {
    s.setRole('admin@e.c', 'admin'); s.setRole('prof@e.c', 'teacher', { ack: true }); const cid = s.addClass('3A'); s.addTeacher(cid, 'prof@e.c');
    const prof = s.userByEmail('prof@e.c').id;
    kid(s, 'k2', null, true, 'Beto'); s.invites.push({ code: 'Ck2', kind: 'to_parent', child: 'k2', by: prof, exp: Date.now() + 864e5, used: true, usedBy: 'user-x' });
  });
  await click(byLabel(root, /^Quitar rol de profesor: prof@e.c$/)[0]);
  const st = root.querySelector('#adminStatus').textContent;
  check('admin: a demotion whose only grants are outside every class tells the admin their number (no drop dialog)',
    !root.querySelector('[role=alertdialog]') && st.includes(`${t('grantOutside')} 1`) && srv.links.get('k2').size === 1 && !/Beto/.test(root.textContent), st);
}
{
  // fix iteration 4 (F003): a teacher deleted their own account; the links their codes made are still listed (by id, with counts) and
  // «Quitar esos vínculos» drops the ones still in a class
  const GONE = '0b0b0b0b-0000-4000-8000-000000000001';
  let cid;
  const { root, srv } = await open('admin@e.c', (s) => {
    s.setRole('admin@e.c', 'admin'); cid = s.addClass('3A');
    kid(s, 'k1', cid, true, 'Ana'); kid(s, 'k2', null, true, 'Beto');
    for (const k of ['k1', 'k2']) s.invites.push({ code: 'C' + k, kind: 'to_parent', child: k, by: GONE, exp: Date.now() + 864e5, used: true, usedBy: 'user-x' });
  });
  const sec = [...root.querySelectorAll('section')].find((x) => x.querySelector('h3') && [...x.querySelectorAll('h3')].some((h) => h.textContent === t('former')));
  const item = sec && [...sec.querySelectorAll('li')].find((li) => li.textContent.includes(GONE.slice(0, 8)));
  const listed = !!item && item.textContent.includes(`${t('grantIn')} 1`) && item.textContent.includes(`${t('grantOutside')} 1`) && !/Ana|Beto/.test(root.textContent);
  const b = byLabel(root, new RegExp(`^${t('dropLinks')}: ${GONE.slice(0, 8)}`))[0];
  if (b) await click(b);
  const dlg = root.querySelector('[role=alertdialog]');
  if (dlg) await click([...dlg.querySelectorAll('button')].find((x) => x.textContent === t('dropLinks')));
  check('admin: a deleted teacher\'s parent grants are listed and «Quitar esos vínculos» drops the one still in a class',
    listed && !!b && srv.links.get('k1').size === 0 && srv.rows.get('k1').class_id === cid && srv.links.get('k2').size === 1 && root.querySelector('#adminStatus').textContent === `${t('dropped')} 1`,
    JSON.stringify({ listed, b: !!b, txt: sec && sec.textContent, st: root.querySelector('#adminStatus').textContent }));
}
{
  // a demotion with no such link asks nothing more
  let cid;
  const { root } = await open('admin@e.c', (s) => { s.setRole('admin@e.c', 'admin'); s.setRole('prof@e.c', 'teacher', { ack: true }); cid = s.addClass('3A'); s.addTeacher(cid, 'prof@e.c'); });
  await click(byLabel(root, /^Quitar rol de profesor: prof@e.c$/)[0]);
  check('admin: a demotion without parent links from the teacher opens no dialog', !root.querySelector('[role=alertdialog]') && root.querySelector('#adminStatus').textContent === t('done'));
}
{
  // focus after an action: the same control when it still exists, else the heading of its section; success is announced
  const { root, doc } = await open('admin@e.c', (s) => { s.setRole('admin@e.c', 'admin'); s.addClass('3A'); });
  const inv = root.querySelector('input[type=email]'); type(inv, 'nueva@e.c');
  const go = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Invitar'); go.focus();
  await click(go);
  const same = doc.activeElement && doc.activeElement.isConnected && doc.activeElement.textContent === 'Invitar' && root.querySelector('#adminStatus').textContent === t('done');
  const rv = byLabel(root, /^Revocar invitación: nueva@e.c$/)[0]; rv.focus();
  await click(rv);
  const heading = doc.activeElement && doc.activeElement.tagName === 'H2' && doc.activeElement.textContent === t('teachers');
  check('admin: after an action the focus stays on the same control, or on its section heading when the control is gone, and "Hecho" is announced', same && heading, JSON.stringify({ same, heading, a: doc.activeElement && doc.activeElement.outerHTML }));
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
