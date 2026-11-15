// Supabase client for accounts and progress sync: plain fetch, no SDK. Loaded with import() only when sync is configured.
// Spec: docs/superpowers/specs/2026-10-17-accounts-sync-design.md. Endpoint names: re-check against the current Supabase docs when changing them.
import { mergeData, sameData } from './merge.js';

export class SyncError extends Error {
  constructor(kind, message, status) { super(message || kind); this.kind = kind; this.status = status; }
}

const SESSION_KEY = 'leemos-auth';
// The server keeps at most old + 1 resets per language and write, and 1000 on insert (trigger child_profiles_data). Push exactly what it
// will store, so the data returned is the server's and the device settles on it in the same round: a higher local counter would later
// wipe what another device played at the stored one. `old`: the row's cleaned data, or null for an insert.
const capResets = (d, old) => { for (const L of ['es', 'ca']) d.resets[L] = Math.min(d.resets[L], old ? old.resets[L] + 1 : 1000); return d; };

export function createSync({ url, anonKey, fetch: doFetch = globalThis.fetch, storage = globalThis.localStorage, now = Date.now }) {
  // the project root: a URL copied with an API path (…/rest/v1/, …/auth/v1) or a trailing slash still works
  const base = String(url).trim().replace(/\/+$/, '').replace(/\/(rest|auth)\/v1$/, '').replace(/\/+$/, '');
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

  const clearSession = () => { try { storage.removeItem(SESSION_KEY); } catch (e) { /* nothing to clear */ } };
  // Signs out locally at once, then asks the server to revoke the session. Best effort: offline just skips the revocation.
  async function signOut() {
    const s = read(SESSION_KEY);
    clearSession();
    if (!s || typeof s.access_token !== 'string') return;
    try { await raw('/auth/v1/logout', { method: 'POST', headers: headers(s.access_token) }); } catch (e) { /* the local sign-out already happened */ }
  }

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
      if ([400, 401, 403].includes(r.status)) { clearSession(); throw new SyncError('auth', 'session expired', r.status); }
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
    // keepalive lets a write finish while the page is closing; browsers reject it above 64 KB, so only small bodies ask for it
    const ka = opts.method && opts.method !== 'GET' && typeof opts.body === 'string' && opts.body.length < 60000;
    const go = (tok) => raw('/rest/v1/' + path, { ...opts, ...(ka ? { keepalive: true } : {}), headers: { ...headers(tok), Prefer: 'return=representation', ...(opts.headers || {}) } });
    let r = await go(s.access_token);
    if (r.status === 401) { s = await refresh(s); r = await go(s.access_token); } // the server rejected the token: renew once
    if (r.status === 401) { clearSession(); throw new SyncError('auth', 'not authorised', 401); }
    return r;
  }
  const errCode = async (r) => { try { const j = await r.json(); return j && j.code; } catch (e) { return null; } };
  const rows = async (r) => { try { const j = await r.json(); return Array.isArray(j) ? j : []; } catch (e) { return []; } };
  const SELECT = 'select=id,name,kind,data,version,class_id,has_parent,child_links(user_id)'; // has_parent: a computed column (a boolean for rows the caller can read)

  // ---------- RPCs (security definer functions): expected failures come back as a value, {error:'<code>'} ----------
  async function rpc(name, args = {}) {
    const r = await api('rpc/' + name, { method: 'POST', body: JSON.stringify(args) });
    if (!r.ok) throw new SyncError('http', 'rpc ' + name + ' failed', r.status);
    try { return await r.json(); } catch (e) { return {}; }
  }
  // An rpc whose {error} becomes a SyncError: invalid -> 'code', rate -> 'rate', anything else -> 'http' with the code as the message.
  async function call(name, args) {
    const j = await rpc(name, args);
    if (j && j.error) throw new SyncError(j.error === 'invalid' ? 'code' : j.error === 'rate' ? 'rate' : 'http', j.error);
    return j;
  }
  const me = () => call('whoami');
  const ackTeacher = () => call('ack_teacher');
  // `teaches`: the caller teaches the class (RLS on class_teachers returns only the caller's own rows). A class seen only through the
  // caller's own child in a colleague's class is listed (its name names the chip) but is not one of theirs.
  async function listClasses() {
    const r = await api('classes?select=id,name,class_teachers(teacher_id)&order=name');
    if (!r.ok) throw new SyncError('http', 'could not list classes', r.status);
    return (await rows(r)).map(({ class_teachers, ...c }) => ({ ...c, teaches: Array.isArray(class_teachers) && class_teachers.length > 0 }));
  }
  const createInvite = (childId, kind) => call('create_invite', { p_child: childId, p_kind: kind });
  const redeemInvite = (code, classId) => call('redeem_invite', { p_code: code, p_class: classId || null });
  const leaveClass = (id) => call('leave_class', { p_child: id });
  const unlinkMe = (id) => call('unlink_me', { p_child: id });
  const deleteChild = (id) => call('delete_child', { p_child: id });
  const exportMyData = () => call('export_my_data');
  const deleteMyAccount = () => call('delete_my_account');

  // `linked`: the caller has a parent link (RLS returns only the caller's own child_links row). A class child seen by its teacher is not.
  async function listProfiles() {
    const r = await api(`child_profiles?${SELECT}&order=id`);
    if (!r.ok) throw new SyncError('http', 'could not list profiles', r.status);
    const me_ = userId();
    return (await rows(r)).map(({ child_links, ...p }) => ({ ...p, class_id: p.class_id || null, has_parent: p.has_parent === true, linked: !!me_ && Array.isArray(child_links) && child_links.some((l) => l && l.user_id === me_) }));
  }
  async function getProfile(rid) {
    const r = await api(`child_profiles?${SELECT}&id=eq.${encodeURIComponent(rid)}`);
    if (!r.ok) throw new SyncError('http', 'could not read the profile', r.status);
    return (await rows(r))[0] || null;
  }
  // "New child in this class": an explicit insert with class_id, before the ordinary sync (whose create-on-missing would land it class-less).
  async function createInClass({ id, name, kind, classId, data }) {
    const c = await api('child_profiles', { method: 'POST', body: JSON.stringify({ id, name, kind, class_id: classId, data: mergeData(data, {}) }) });
    if (!c.ok) throw new SyncError('http', 'could not create the child', c.status);
    return (await rows(c))[0] || null;
  }

  // Pull, merge, push one profile. `data` is the local synced snapshot. Returns {data, version, kind}, or {revoked:true} when the server
  // no longer lets this account have the row. `kind` is pushed only with kindChanged (the adult changed it here); otherwise the server's wins.
  async function syncProfile({ rid, name, kind, data, kindChanged = false }) {
    for (let attempt = 0; attempt < 5; attempt++) {
      let row = await getProfile(rid);
      if (!row) {
        const born = capResets(mergeData(data, {}), null);
        const c = await api('child_profiles', { method: 'POST', body: JSON.stringify({ id: rid, name, kind, data: born }) });
        if (c.status === 403) return { revoked: true }; // the insert policy refuses (e.g. a deleted child's id)
        if (c.status === 409) { // exists but not visible to us (revoked), or another device created it first
          row = await getProfile(rid);
          if (!row) return { revoked: true };
        } else {
          if (!c.ok) throw new SyncError('http', 'could not create the profile', c.status);
          return { data: born, version: 1, kind };
        }
      }
      const merged = capResets(mergeData(data, row.data), mergeData(row.data, {}));
      const push = kindChanged && kind !== row.kind;
      const nextKind = push ? kind : row.kind;
      if (sameData(merged, mergeData(row.data, {})) && row.name === name && !push) return { data: merged, version: row.version, kind: nextKind };
      const write = (version) => api(`child_profiles?id=eq.${encodeURIComponent(rid)}&version=eq.${row.version}`, { method: 'PATCH', body: JSON.stringify({ name, data: merged, version, ...(push ? { kind } : {}) }) });
      let next = row.version + 1, p = await write(next);
      // a version at the integer maximum (planted before the server controlled it): version+1 overflows (22003). Start again at 1 under the same filter.
      if (p.status === 400 && (await errCode(p)) === '22003') { next = 1; p = await write(next); }
      if (!p.ok) throw new SyncError('http', 'could not save the profile', p.status);
      if ((await rows(p)).length) return { data: merged, version: next, kind: nextKind };
      // empty result: someone else wrote first, go again from the read
    }
    throw new SyncError('conflict', 'too many concurrent writes');
  }

  return { requestCode, verifyCode, session, signOut, userId, listProfiles, syncProfile, createInClass, rpc, me, ackTeacher, listClasses, createInvite, redeemInvite, leaveClass, unlinkMe, deleteChild, exportMyData, deleteMyAccount };
}
