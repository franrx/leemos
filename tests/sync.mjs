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

// ---------- profile sync: Task 4 adds its tests here ----------

console.log(failures ? `\n${failures} sync test(s) FAILED` : '\nAll sync tests passed');
process.exit(failures ? 1 : 0);
