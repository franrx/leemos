// Supabase client for accounts and progress sync: plain fetch, no SDK. Loaded with import() only when sync is configured.
// Spec: docs/superpowers/specs/2026-10-17-accounts-sync-design.md. Endpoint names: re-check against the current Supabase docs when changing them.
import { mergeData, sameData } from './merge.js';

export class SyncError extends Error {
  constructor(kind, message, status) { super(message || kind); this.kind = kind; this.status = status; }
}

const SESSION_KEY = 'leemos-auth';

export function createSync({ url, anonKey, fetch: doFetch = globalThis.fetch, storage = globalThis.localStorage, now = Date.now }) {
  const base = String(url).replace(/\/+$/, '');
  const read = (k) => { try { return JSON.parse(storage.getItem(k)); } catch (e) { return null; } };
  const write = (k, v) => { try { storage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked: the session just will not persist */ } };
  const headers = (token) => ({ apikey: anonKey, 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || anonKey) });

  async function raw(path, opts) {
    try { return await doFetch(base + path, opts); } catch (e) { throw new SyncError('offline', 'network error'); }
  }
  const toSession = (j, fallbackUser) => ({
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: now() + (Number(j.expires_in) || 3600) * 1000,
    user: { id: (j.user && j.user.id) || (fallbackUser && fallbackUser.id) || null, email: (j.user && j.user.email) || (fallbackUser && fallbackUser.email) || '' },
  });

  const signOut = () => { try { storage.removeItem(SESSION_KEY); } catch (e) { /* nothing to clear */ } };

  async function requestCode(email) {
    const r = await raw('/auth/v1/otp', { method: 'POST', headers: headers(), body: JSON.stringify({ email, create_user: true }) });
    if (!r.ok) throw new SyncError('http', 'could not send the code', r.status);
  }

  async function verifyCode(email, code) {
    const r = await raw('/auth/v1/verify', { method: 'POST', headers: headers(), body: JSON.stringify({ type: 'email', email, token: String(code).trim() }) });
    if (!r.ok) throw new SyncError([400, 401, 403, 422].includes(r.status) ? 'code' : 'http', 'could not verify the code', r.status);
    const s = toSession(await r.json());
    write(SESSION_KEY, s);
    return s;
  }

  async function refresh(old) {
    const r = await raw('/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: headers(), body: JSON.stringify({ refresh_token: old.refresh_token }) });
    if (!r.ok) {
      if ([400, 401, 403].includes(r.status)) { signOut(); throw new SyncError('auth', 'session expired', r.status); }
      throw new SyncError('http', 'could not refresh the session', r.status);
    }
    const s = toSession(await r.json(), old.user);
    write(SESSION_KEY, s);
    return s;
  }

  // The stored session, refreshed when it is about to expire. null when signed out.
  async function session() {
    const s = read(SESSION_KEY);
    if (!s || typeof s.access_token !== 'string' || typeof s.refresh_token !== 'string') return null;
    return s.expires_at - now() < 60000 ? refresh(s) : s;
  }
  const userId = () => { const s = read(SESSION_KEY); return s && s.user && s.user.id ? s.user.id : null; };

  // Task 4 adds the data API (listProfiles, syncProfile) here.

  return { requestCode, verifyCode, session, signOut, userId };
}
