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

console.log(failures ? `\n${failures} sync test(s) FAILED` : '\nAll sync tests passed');
process.exit(failures ? 1 : 0);
