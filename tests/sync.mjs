// Tests for the Supabase client (src/sync.js) against the in-memory fake: authentication, then the profile sync protocol (Task 4).
import { createSync, SyncError } from '../src/sync.js';
import { createFakeSupabase, memoryStorage } from './lib/fake-supabase.mjs';

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const URL_ = 'https://x.supabase.co';
const mk = (opts = {}) => {
  const srv = opts.srv || createFakeSupabase();
  const storage = opts.storage || memoryStorage();
  const sync = createSync({ url: URL_, anonKey: 'anon-key', fetch: srv.fetch, storage, now: opts.now || Date.now });
  return { srv, storage, sync };
};

// ---------- authentication ----------
{
  const { srv, storage, sync } = mk();
  await sync.requestCode('mama@example.com');
  check('auth: asking for a code posts the email and creates the user if needed', srv.log.includes('POST /auth/v1/otp'));
  const s = await sync.verifyCode('mama@example.com', '123456');
  check('auth: a correct code returns and stores a session', !!s.access_token && s.user.email === 'mama@example.com' && !!JSON.parse(storage.getItem('leemos-auth')).refresh_token);
  check('auth: userId reflects the stored session', sync.userId() === srv.userByEmail('mama@example.com').id);
  check('auth: session() returns the stored session while it is fresh', (await sync.session()).access_token === s.access_token);
  sync.signOut();
  check('auth: sign out removes the session', (await sync.session()) === null && sync.userId() === null);
}
{
  const { sync } = mk();
  await sync.requestCode('a@b.c');
  const e = await rejects(sync.verifyCode('a@b.c', '000000'));
  check('auth: a wrong code is a "code" error, not a crash', e instanceof SyncError && e.kind === 'code', e && e.kind);
  const e2 = await rejects(sync.verifyCode('never-asked@b.c', '123456'));
  check('auth: a code for an email that never asked is refused', e2 instanceof SyncError && e2.kind === 'code');
}
{
  const { srv, sync } = mk();
  srv.setOffline(true);
  const e = await rejects(sync.requestCode('a@b.c'));
  check('auth: no connection is an "offline" error', e instanceof SyncError && e.kind === 'offline', e && e.kind);
}
{
  // refresh: the access token is renewed before it expires, and a revoked refresh token signs the user out without touching anything else
  let t = Date.now();
  const { srv, storage, sync } = mk({ now: () => t });
  await sync.requestCode('m@e.c');
  const s1 = await sync.verifyCode('m@e.c', '123456');
  t += 3600 * 1000 - 30 * 1000; // 30 s before expiry
  const s2 = await sync.session();
  check('auth: a token near expiry is refreshed transparently', s2.access_token !== s1.access_token && s2.user.id === s1.user.id, s2.access_token);
  srv.revokeRefreshTokens();
  t += 3600 * 1000;
  const e = await rejects(sync.session());
  check('auth: a revoked refresh token is an "auth" error and the session is cleared', e instanceof SyncError && e.kind === 'auth' && storage.getItem('leemos-auth') === null, e && e.kind);
}
{
  const { sync } = mk({ storage: memoryStorage({ 'leemos-auth': '{not json' }) });
  check('auth: a corrupted stored session counts as signed out', (await sync.session()) === null && sync.userId() === null);
}

// ---------- profile sync ----------
const RID = '11111111-1111-4111-8111-111111111111';
const data = (over = {}) => ({ stats: { 's:ma': { ok: 2, fail: 0 } }, total: 5, stickers: 1, pre: { es: 0, ca: 0 }, resets: { es: 0, ca: 0 }, level: 0, name: 'Elsa', modAt: 100, ...over });
const signedIn = async () => { const x = mk(); await x.sync.requestCode('m@e.c'); await x.sync.verifyCode('m@e.c', '123456'); return x; };
{
  const { srv, sync } = await signedIn();
  const r = await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() });
  check('profiles: a profile that does not exist yet is created', srv.rows.has(RID) && r.version === 1 && r.data.total === 5, JSON.stringify(srv.log.slice(-2)));
  const before = srv.log.length;
  const again = await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() });
  check('profiles: syncing unchanged data writes nothing', !srv.log.slice(before).some((l) => l.startsWith('PATCH') || l.startsWith('POST')) && again.version === 1);
  const up = await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data({ total: 9, modAt: 200 }) });
  check('profiles: newer local data is pushed and the version goes up', srv.rows.get(RID).data.total === 9 && up.version === 2 && srv.rows.get(RID).version === 2);
  const down = await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data({ total: 1, stats: {}, modAt: 50 }) });
  check('profiles: an older device receives the merged remote counters', down.data.total === 9 && down.data.stats['s:ma'].ok === 2);
  const list = await sync.listProfiles();
  check("profiles: listProfiles returns the account's rows", list.length === 1 && list[0].id === RID && list[0].name === 'Elsa');
}
{
  // another device writes between our read and our write: version conflict, then a retry that keeps both sides' progress
  const srv = createFakeSupabase(), storage = memoryStorage();
  const sync = createSync({ url: URL_, anonKey: 'k', fetch: srv.fetch, storage });
  await sync.requestCode('m@e.c'); await sync.verifyCode('m@e.c', '123456');
  await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() });
  let injected = false;
  const racing = createSync({
    url: URL_, anonKey: 'k', storage,
    fetch: async (u, o = {}) => {
      if (!injected && (o.method || 'GET') === 'PATCH') { injected = true; const row = srv.rows.get(RID); row.version += 1; row.data = { ...row.data, total: 50, stats: { ...row.data.stats, 's:pa': { ok: 7, fail: 0 } } }; }
      return srv.fetch(u, o);
    },
  });
  const r = await racing.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data({ total: 6, modAt: 300, stats: { 's:ma': { ok: 4, fail: 1 } } }) });
  const row = srv.rows.get(RID);
  check("conflict: a write that lost the race is retried and keeps both devices' progress", injected && row.data.total === 50 && row.data.stats['s:pa'].ok === 7 && row.data.stats['s:ma'].ok === 4 && row.data.stats['s:ma'].fail === 1, JSON.stringify(row.data));
  check('conflict: the final version moved past the one that won the race', row.version === 3 && r.version === 3, String(row.version));
  let n = 0;
  const hostile = createSync({ url: URL_, anonKey: 'k', storage, fetch: async (u, o = {}) => { if ((o.method || 'GET') === 'PATCH') { n++; srv.rows.get(RID).version += 1; } return srv.fetch(u, o); } });
  const e = await rejects(hostile.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data({ total: 999, modAt: 999 }) }));
  check('conflict: after 5 lost races it gives up with a "conflict" error instead of looping', e instanceof SyncError && e.kind === 'conflict' && n === 5, `${e && e.kind} ${n}`);
}
{
  const { srv, sync } = await signedIn();
  srv.setOffline(true);
  const e = await rejects(sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() }));
  check('offline: syncing without a connection is an "offline" error and creates nothing', e instanceof SyncError && e.kind === 'offline' && srv.rows.size === 0);
  srv.setOffline(false);
  await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() });
  check('offline: the next attempt works', srv.rows.has(RID));
}
{
  const { srv, sync } = await signedIn();
  srv.expireAccessTokens();
  const r = await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() });
  check('auth: an access token the server rejected is refreshed once and the request succeeds', srv.rows.has(RID) && r.version === 1 && srv.log.some((l) => l.includes('grant_type=refresh_token')), srv.log.join(' | '));
}
{
  const { srv, sync } = await signedIn();
  srv.expireAccessTokens(); srv.revokeRefreshTokens();
  const e = await rejects(sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() }));
  check('auth: when the session cannot be renewed the error is "auth"', e instanceof SyncError && e.kind === 'auth', e && e.kind);
  const none = mk();
  const e2 = await rejects(none.sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() }));
  check('auth: syncing while signed out is an "auth" error and sends nothing to the data API', e2 instanceof SyncError && e2.kind === 'auth' && !none.srv.log.length);
}
{
  const { srv, sync } = await signedIn();
  for (let i = 0; i < 8; i++) await sync.syncProfile({ rid: crypto.randomUUID(), name: 'P' + i, kind: 'pre', data: data() });
  const e = await rejects(sync.syncProfile({ rid: crypto.randomUUID(), name: 'Nine', kind: 'pre', data: data() }));
  check('limits: the ninth profile is refused with an "http" error', e instanceof SyncError && e.kind === 'http' && srv.rows.size === 8, e && e.kind);
}
{
  const { srv, sync } = await signedIn();
  srv.rows.set(RID, { id: RID, owner: srv.userByEmail('m@e.c').id, name: 'Elsa', kind: 'reader', data: { stats: [1, 2], total: 'lots' }, version: 4 });
  const r = await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() });
  check('remote data: a malformed remote row is merged as if empty and never crashes', r.data.total === 5 && r.version === 5);
}
{
  // version is server-controlled (trigger child_profiles_version): a jump is flattened to one step, an insert always starts at 1
  const { srv, sync } = await signedIn();
  await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() });
  const tok = (await sync.session()).access_token;
  const p = await srv.fetch(`${URL_}/rest/v1/child_profiles?id=eq.${RID}`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + tok }, body: JSON.stringify({ version: 2147483647 }) });
  check('version: a write that jumps the version is flattened to old + 1 (fake follows the trigger)', p.status === 200 && srv.rows.get(RID).version === 2, String(srv.rows.get(RID).version));
  // a row poisoned before the trigger existed: version+1 overflows the integer (22003). The client resets it to 1 under the same filter.
  srv.rows.get(RID).version = 2147483647;
  const r = await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data({ total: 12 }) });
  check('version: a row at the integer maximum (22003 on version+1) still syncs: the client writes version 1 under the same filter', r.version === 1 && srv.rows.get(RID).version === 1 && srv.rows.get(RID).data.total === 12, JSON.stringify({ r: r.version, row: srv.rows.get(RID).version }));
}
{
  // the merge tokens inside data are server-owned (trigger child_profiles_data): a planted end-of-time stamp, a level past the last
  // and a resets jump are clamped, so the family's next edit (one past what it pulled, as stampAfter does) wins again
  const { srv, sync } = await signedIn();
  await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data({ level: 2, modAt: Date.now(), resets: { es: 3, ca: 0 }, prefs: { lang: { v: 'ca', at: Date.now() } } }) });
  const tok = (await sync.session()).access_token, END = 8.64e15;
  await srv.fetch(`${URL_}/rest/v1/child_profiles?id=eq.${RID}`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + tok }, body: JSON.stringify({ data: { level: 1e6, name: 'X', modAt: END, resets: { es: 1e6, ca: 'x' }, stats: { 's:pa': { ok: 99 } }, prefs: { lang: { v: 'es', at: END } }, session: { done: 1, ok: 1, stk: 0, at: END } } }) });
  const d = srv.rows.get(RID).data, cap = Date.now() + 600000;
  check('data: far-future stamps, a level past the last and a resets jump are clamped (fake follows the trigger)', d.modAt <= cap && d.prefs.lang.at <= cap && d.session.at <= cap && d.level === 4 && d.resets.es === 4 && d.resets.ca === 'x', JSON.stringify(d));
  const at = d.modAt + 1;
  const r = await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data({ level: 1, modAt: at, resets: { es: 5, ca: 0 }, stats: {}, prefs: { lang: { v: 'ca', at } } }) });
  const row = srv.rows.get(RID).data;
  check('data: after the clamp the family wins again (level, language, "Borrar progreso" drops the planted stats)', r.data.level === 1 && row.level === 1 && row.prefs.lang.v === 'ca' && row.resets.es === 5 && !row.stats['s:pa'], JSON.stringify(row));
}
{
  // two "Borrar progreso" before a push: the trigger stores old + 1. The data returned is what the server holds, so the device settles
  // on it (a higher local counter would later wipe what another device played at the stored one)
  const { srv, sync } = await signedIn();
  await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() });
  const r = await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data({ resets: { es: 2, ca: 0 }, stats: {}, total: 6 }) });
  const row = srv.rows.get(RID).data;
  check('resets: a jump of 2 is stored as old + 1 and the result says what the server holds', row.resets.es === 1 && r.data.resets.es === 1 && !row.stats['s:ma'] && !r.data.stats['s:ma'], JSON.stringify({ row: row.resets, r: r.data.resets }));
  const fresh = '22222222-2222-4222-8222-222222222222';
  const c = await sync.syncProfile({ rid: fresh, name: 'Ana', kind: 'reader', data: data({ resets: { es: 1500, ca: 0 } }) });
  check('resets: a new row is born with at most 1000 (insert clamp) and the result says so', srv.rows.get(fresh).data.resets.es === 1000 && c.data.resets.es === 1000, JSON.stringify(c.data.resets));
}

// ---------- a project URL pasted with an API path still works ----------
for (const pasted of ['https://x.supabase.co/rest/v1/', 'https://x.supabase.co/auth/v1', 'https://x.supabase.co/', 'https://x.supabase.co']) {
  const srv = createFakeSupabase();
  const s = createSync({ url: pasted, anonKey: 'k', fetch: srv.fetch, storage: memoryStorage() });
  await s.requestCode('a@b.c').catch(() => {});
  check(`url: "${pasted}" still reaches the auth endpoint at the project root`, srv.log[0] === 'POST /auth/v1/otp', String(srv.log[0]));
}

// ---------- review minors: sign-out revokes the session on the server, writes can finish while the page closes ----------
{
  const { srv, storage, sync } = await signedIn();
  const rt = JSON.parse(storage.getItem('leemos-auth')).refresh_token;
  await sync.signOut();
  check('sign out: the session is removed locally', storage.getItem('leemos-auth') === null && sync.userId() === null);
  check('sign out: the server is asked to revoke it', srv.log.includes('POST /auth/v1/logout'));
  const reuse = await srv.fetch(URL_ + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: rt }) });
  check('sign out: the old refresh token no longer works', reuse.status === 400, String(reuse.status));
}
{
  const { srv, storage, sync } = await signedIn();
  srv.setOffline(true);
  const e = await rejects(sync.signOut());
  check('sign out: with no connection it still signs out locally and never throws', e === null && storage.getItem('leemos-auth') === null);
}
{
  const srv = createFakeSupabase(), storage = memoryStorage(), seen = [];
  const sync = createSync({ url: URL_, anonKey: 'k', storage, fetch: async (u, o = {}) => { if (/child_profiles/.test(u) && o.method) seen.push({ m: o.method, keepalive: o.keepalive, len: (o.body || '').length }); return srv.fetch(u, o); } });
  await sync.requestCode('m@e.c'); await sync.verifyCode('m@e.c', '123456');
  await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() });
  await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data({ total: 9, modAt: 200 }) });
  check('keepalive: small writes survive the page closing (POST and PATCH)', seen.length === 2 && seen.every((s) => s.keepalive === true), JSON.stringify(seen));
  const many = {}; for (let i = 0; i < 3000; i++) many['s:item' + i] = { ok: 1, fail: 0 };
  seen.length = 0;
  await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data({ stats: many, modAt: 300 }) });
  check('keepalive: a write over the 64 KB browser limit does not ask for it (it would be rejected)', seen.length === 1 && seen[0].len > 60000 && !seen[0].keepalive, JSON.stringify(seen.map((s) => ({ k: s.keepalive, l: s.len }))));
}
// ---------- session and preferences travel through pull-merge-push ----------
{
  const { srv, sync } = await signedIn();
  const withSp = (over = {}) => data({ session: { done: 3, ok: 2, stk: 0, at: 500 }, prefs: { theme: { v: 'dark', at: 500 }, sound: { v: false, at: 500 } }, ...over });
  await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: withSp() });
  check('session/prefs: they are uploaded with the profile', srv.rows.get(RID).data.session.done === 3 && srv.rows.get(RID).data.prefs.theme.v === 'dark');
  const r = await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data({ prefs: { sound: { v: true, at: 900 } } }) });
  check('session/prefs: a later device keeps the newer sound and receives the other key and the session', r.data.prefs.sound.v === true && r.data.prefs.theme.v === 'dark' && r.data.session.done === 3, JSON.stringify(r.data.prefs));
  check('session/prefs: nothing about the voice is ever sent', !JSON.stringify([...srv.rows.values()]).includes('voice'));
}

{
  const { srv, sync } = await signedIn();
  const wp = (over = {}) => data({ prefs: { pathEs: { v: 4, at: 500 }, pathAuto: { v: false, at: 500 } }, ...over });
  await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: wp() });
  check('path: the letter path and its switch are uploaded with the profile', srv.rows.get(RID).data.prefs.pathEs.v === 4 && srv.rows.get(RID).data.prefs.pathAuto.v === false);
  const r = await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data({ prefs: { pathEs: { v: 7, at: 900 } } }) });
  check('path: a later change on another device wins and keeps the other key', r.data.prefs.pathEs.v === 7 && r.data.prefs.pathAuto.v === false);
}

// ---------- teachers and classes (Task 4): rpc, class and link fields, revoked outcome ----------
const as = async (srv, email) => { const storage = memoryStorage(); const sync = createSync({ url: URL_, anonKey: 'anon-key', fetch: srv.fetch, storage }); await sync.requestCode(email); await sync.verifyCode(email, '123456'); return { sync, storage, id: srv.userByEmail(email).id }; };
{
  const { srv, sync } = await signedIn();
  srv.expireAccessTokens();
  const w = await sync.rpc('whoami');
  const refreshes = srv.log.filter((l) => l.includes('grant_type=refresh_token')).length;
  check('sync: rpc refreshes an expired token once', w.role === 'parent' && refreshes === 1 && srv.log.includes('POST /rest/v1/rpc/whoami'), JSON.stringify({ w, refreshes }));
}
{
  const srv = createFakeSupabase();
  const cls = srv.addClass('3A');
  const t = await as(srv, 't@e.c'); srv.setRole('t@e.c', 'teacher', { ack: true }); srv.addTeacher(cls, 't@e.c');
  const p = await as(srv, 'p@e.c');
  await p.sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() });
  const { code } = await p.sync.createInvite(RID, 'to_class');
  const bad = await rejects(t.sync.redeemInvite('ZZZZZZZZ', cls));
  check('sync: redeemInvite maps invalid to kind code', bad instanceof SyncError && bad.kind === 'code', bad && bad.kind);
  const other = await rejects(t.sync.redeemInvite(code, crypto.randomUUID()));
  check('sync: redeemInvite maps another error to http with its code as message and the code survives', other instanceof SyncError && other.kind === 'http' && other.message === 'forbidden', other && other.message);
  for (let i = 0; i < 8; i++) await rejects(t.sync.redeemInvite('ZZZZZZZZ', cls)); // 10 failures so far (invalid x9, forbidden x1)
  const limited = await rejects(t.sync.redeemInvite(code, cls));
  check('sync: redeemInvite maps rate (10 failures in an hour) to kind rate', limited instanceof SyncError && limited.kind === 'rate', limited && limited.kind);
  srv.advance(61 * 60 * 1000);
  const ok = await t.sync.redeemInvite(code, cls);
  check('sync: after the hour the unused code still redeems and moves the child into the class', ok.ok === true && ok.child_id === RID && srv.rows.get(RID).class_id === cls);
  const again = await rejects(t.sync.redeemInvite(code, cls));
  check('sync: a code is single use (uniform invalid)', again instanceof SyncError && again.kind === 'code');
}
{
  const srv = createFakeSupabase();
  const cls = srv.addClass('3A');
  const t = await as(srv, 't@e.c'); srv.setRole('t@e.c', 'teacher', { ack: true }); srv.addTeacher(cls, 't@e.c');
  const row = await t.sync.createInClass({ id: RID, name: 'Nuria', kind: 'reader', classId: cls, data: data() });
  const list = await t.sync.listProfiles();
  check('sync: listProfiles marks a class child as not linked', row.id === RID && list.length === 1 && list[0].class_id === cls && list[0].linked === false && !('child_links' in list[0]), JSON.stringify(list));
  const p = await as(srv, 'p@e.c');
  const R2 = '22222222-2222-4222-8222-222222222222';
  await p.sync.syncProfile({ rid: R2, name: 'Elsa', kind: 'reader', data: data() });
  const mine = await p.sync.listProfiles();
  check('sync: a parent own child is linked and has no class', mine.length === 1 && mine[0].linked === true && mine[0].class_id === null);
  check('sync: createInClass sends class_id and the insert gives the teacher no parent link', srv.rows.get(RID).class_id === cls && !(srv.links.get(RID) || new Set()).size && srv.log.some((l) => l === 'POST /rest/v1/child_profiles'));
  const notTeacher = await rejects(p.sync.createInClass({ id: crypto.randomUUID(), name: 'X', kind: 'reader', classId: cls, data: data() }));
  check('sync: createInClass by a non-teacher is an http 403 and creates nothing', notTeacher instanceof SyncError && notTeacher.kind === 'http' && notTeacher.status === 403 && srv.rows.size === 2, notTeacher && String(notTeacher.status));
}
{
  const { srv, sync } = await signedIn();
  await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() });
  srv.hideRow(RID);
  const before = JSON.stringify(srv.rows.get(RID));
  const r = await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data({ total: 77, modAt: 900 }) });
  check('sync: syncProfile on a hidden row resolves revoked and does not create', r.revoked === true && srv.rows.size === 1 && JSON.stringify(srv.rows.get(RID)) === before, JSON.stringify(r));
  const T = '33333333-3333-4333-8333-333333333333';
  srv.tombstone(T);
  const r2 = await sync.syncProfile({ rid: T, name: 'Gone', kind: 'reader', data: data() });
  check('sync: a tombstoned id (403 on insert) also resolves revoked', r2.revoked === true && !srv.rows.has(T));
}
{
  const { srv, sync } = await signedIn();
  await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data() });
  const up = await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'pre', data: data(), kindChanged: true });
  check('sync: a locally changed kind is pushed; an unchanged kind is adopted from the server', srv.rows.get(RID).kind === 'pre' && up.kind === 'pre');
  srv.rows.get(RID).kind = 'reader'; srv.rows.get(RID).version++; // another device changed it
  const before = srv.log.length;
  const adopt = await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'pre', data: data() });
  check('sync: a stale local kind without the changed flag is not pushed (adopted, nothing written)', adopt.kind === 'reader' && srv.rows.get(RID).kind === 'reader' && !srv.log.slice(before).some((l) => l.startsWith('PATCH')), JSON.stringify(adopt));
  const same = await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data(), kindChanged: true });
  check('sync: a kind flagged as changed but equal to the server writes nothing', same.kind === 'reader' && !srv.log.slice(before).some((l) => l.startsWith('PATCH')));
}
{
  const srv = createFakeSupabase();
  srv.inviteTeacher('t@e.c');
  const t = await as(srv, 't@e.c');
  const w1 = await t.sync.me();
  const w2 = await t.sync.me();
  check('sync: whoami claims a pending invitation', w1.role === 'teacher' && w1.teacher_ack_at === null && w2.role === 'teacher' && !srv.roleInvites.has('t@e.c'), JSON.stringify(w1));
  const ack = await t.sync.ackTeacher();
  check('sync: ackTeacher sets the acknowledgement', ack.ok === true && !!(await t.sync.me()).teacher_ack_at);
  const p = await as(srv, 'p@e.c');
  const e = await rejects(p.sync.ackTeacher());
  check('sync: a parent cannot acknowledge as teacher (http forbidden)', e instanceof SyncError && e.kind === 'http' && e.message === 'forbidden');
  srv.inviteTeacher('late@e.c'); srv.advance(31 * 24 * 3600 * 1000);
  const l = await as(srv, 'late@e.c');
  check('sync: an expired invitation is not claimed', (await l.sync.me()).role === 'parent');
}
{
  const { srv, sync } = await signedIn();
  srv.setOffline(true);
  const e = await rejects(sync.rpc('whoami'));
  check('sync: offline rpc throws kind offline', e instanceof SyncError && e.kind === 'offline', e && e.kind);
}
{
  const { srv, sync, storage } = await signedIn();
  srv.expireAccessTokens(); srv.revokeRefreshTokens();
  const e = await rejects(sync.rpc('whoami'));
  check('sync: a revoked refresh token on an rpc gives kind auth', e instanceof SyncError && e.kind === 'auth' && storage.getItem('leemos-auth') === null, e && e.kind);
}
{
  const srv = createFakeSupabase();
  const cls = srv.addClass('3A');
  const t = await as(srv, 't@e.c'); srv.setRole('t@e.c', 'teacher', { ack: true }); srv.addTeacher(cls, 't@e.c');
  const p = await as(srv, 'p@e.c');
  const C = '44444444-4444-4444-8444-444444444444';
  await t.sync.createInClass({ id: C, name: 'Nuria', kind: 'reader', classId: cls, data: data() });
  const inv = await t.sync.createInvite(C, 'to_parent');
  check('sync: createInvite returns code and expiry (8 chars, 7 days)', /^[A-Z2-9]{8}$/.test(inv.code) && Date.parse(inv.expires_at) > Date.now() + 6 * 24 * 3600 * 1000);
  const red = await p.sync.redeemInvite(inv.code.toLowerCase().replace(/^(....)/, '$1-'));
  check('sync: redeeming a to_parent code links the parent (case and dashes are ignored)', red.child_id === C && (await p.sync.listProfiles())[0].linked === true);
  const orphanLeave = await t.sync.leaveClass(C);
  check('sync: leaveClass takes a linked child out of the class', orphanLeave.ok === true && srv.rows.get(C).class_id === null);
  const un = await p.sync.unlinkMe(C);
  check('sync: unlinkMe of the last link deletes the child with a tombstone', un.deleted === true && !srv.rows.has(C) && srv.tombstones.has(C));
  const ex = await t.sync.exportMyData();
  check('sync: exportMyData has account, classes and children', ex.account.role === 'teacher' && ex.classes.length === 1 && Array.isArray(ex.children));
  const adm = await rejects(t.sync.rpc('admin_list_classes'));
  const raw = await t.sync.rpc('admin_list_classes');
  check('sync: admin rpcs answer forbidden to a non-admin as a value', adm === null && raw.error === 'forbidden');
  const lc = await t.sync.listClasses();
  check('sync: listClasses returns id, name and teaches (the caller teaches it)', lc.length === 1 && lc[0].id === cls && lc[0].name === '3A' && lc[0].teaches === true && !('class_teachers' in lc[0]));
  { // a parent sees the class only through its child: listed, but not taught
    const K = '55555555-5555-4555-8555-555555555555';
    srv.rows.set(K, { id: K, owner: null, class_id: cls, name: 'Kim', kind: 'reader', data: data(), version: 1 }); srv.links.set(K, new Set([srv.userByEmail('p@e.c').id]));
    const pc = await p.sync.listClasses();
    check('sync: a class seen only through the caller\'s own child has teaches:false', pc.length === 1 && pc[0].id === cls && pc[0].teaches === false, JSON.stringify(pc));
    srv.rows.delete(K); srv.links.delete(K);
  }
  await p.sync.deleteMyAccount();
  const gone = await rejects(p.sync.rpc('whoami'));
  check('sync: deleteMyAccount ends the account (its token stops working)', gone instanceof SyncError && gone.kind === 'auth', gone && gone.kind);
}
{
  // has_parent (a computed column) and the class box that refuses to_parent codes
  const srv = createFakeSupabase();
  const cls = srv.addClass('3A'), cls2 = srv.addClass('3B');
  const t = await as(srv, 't@e.c'); srv.setRole('t@e.c', 'teacher', { ack: true }); srv.addTeacher(cls, 't@e.c');
  const t2 = await as(srv, 't2@e.c'); srv.setRole('t2@e.c', 'teacher', { ack: true }); srv.addTeacher(cls2, 't2@e.c');
  const p = await as(srv, 'p@e.c');
  const U = '55555555-5555-4555-8555-555555555555', V = '66666666-6666-4666-8666-666666666666';
  await t.sync.createInClass({ id: U, name: 'Uno', kind: 'reader', classId: cls, data: data() });
  await t.sync.createInClass({ id: V, name: 'Vera', kind: 'reader', classId: cls, data: data() });
  const flags = async () => Object.fromEntries((await t.sync.listProfiles()).map((r) => [r.id, r.has_parent]));
  const before = await flags();
  const cV = await t.sync.createInvite(V, 'to_parent');
  const viaBox = await rejects(t2.sync.redeemInvite(cV.code, cls2));
  const stillNone = (await flags())[V] === false && (srv.links.get(V) || new Set()).size === 0;
  await p.sync.redeemInvite(cV.code);
  const after = await flags();
  check('sync: listProfiles carries has_parent (false while unclaimed, true once a parent redeemed)', before[U] === false && before[V] === false && after[U] === false && after[V] === true && srv.log.some((l) => /has_parent/.test(l)), JSON.stringify({ before, after }));
  check('sync: a to_parent code redeemed with a class is a code error, links nobody and still works for the parent', viaBox instanceof SyncError && viaBox.kind === 'code' && stillNone && srv.links.get(V).has(srv.userByEmail('p@e.c').id));
}

console.log(failures ? `\n${failures} sync test(s) FAILED` : '\nAll sync tests passed');
process.exit(failures ? 1 : 0);
