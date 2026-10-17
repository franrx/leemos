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

  // ---------- data API (PostgREST) ----------
  async function api(path, opts = {}) {
    let s = await session();
    if (!s) throw new SyncError('auth', 'not signed in');
    const go = (tok) => raw('/rest/v1/' + path, { ...opts, headers: { ...headers(tok), Prefer: 'return=representation', ...(opts.headers || {}) } });
    let r = await go(s.access_token);
    if (r.status === 401) { s = await refresh(s); r = await go(s.access_token); } // the server rejected the token: renew once
    if (r.status === 401) { signOut(); throw new SyncError('auth', 'not authorised', 401); }
    return r;
  }
  const rows = async (r) => { try { const j = await r.json(); return Array.isArray(j) ? j : []; } catch (e) { return []; } };
  const SELECT = 'select=id,name,kind,data,version';

  async function listProfiles() {
    const r = await api(`child_profiles?${SELECT}&order=id`);
    if (!r.ok) throw new SyncError('http', 'could not list profiles', r.status);
    return rows(r);
  }
  async function getProfile(rid) {
    const r = await api(`child_profiles?${SELECT}&id=eq.${encodeURIComponent(rid)}`);
    if (!r.ok) throw new SyncError('http', 'could not read the profile', r.status);
    return (await rows(r))[0] || null;
  }

  // Pull, merge, push one profile. `data` is the local synced snapshot. Returns the merged data and the server version.
  async function syncProfile({ rid, name, kind, data }) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await getProfile(rid);
      if (!row) {
        const c = await api('child_profiles', { method: 'POST', body: JSON.stringify({ id: rid, name, kind, data: mergeData(data, {}) }) });
        if (c.status === 409) continue; // another device created it first: read it and merge
        if (!c.ok) throw new SyncError('http', 'could not create the profile', c.status);
        return { data: mergeData(data, {}), version: 1 };
      }
      const merged = mergeData(data, row.data);
      if (sameData(merged, mergeData(row.data, {})) && row.name === name) return { data: merged, version: row.version };
      const p = await api(`child_profiles?id=eq.${encodeURIComponent(rid)}&version=eq.${row.version}`, { method: 'PATCH', body: JSON.stringify({ name, data: merged, version: row.version + 1 }) });
      if (!p.ok) throw new SyncError('http', 'could not save the profile', p.status);
      if ((await rows(p)).length) return { data: merged, version: row.version + 1 };
      // empty result: someone else wrote first, go again from the read
    }
    throw new SyncError('conflict', 'too many concurrent writes');
  }

  return { requestCode, verifyCode, session, signOut, userId, listProfiles, syncProfile };
}
