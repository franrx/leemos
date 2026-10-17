// In-memory stand-in for Supabase (auth + the child_profiles table) used by tests/sync.mjs and tests/smoke.mjs.
// It enforces what the real project enforces: owner-only rows, the 8-profile limit, optimistic version filters, JWT expiry.
export function createFakeSupabase({ code = '123456', ttlSeconds = 3600 } = {}) {
  const users = new Map();      // email -> {id, email}
  const asked = new Set();      // emails that requested a code
  const access = new Map();     // access token -> {uid, exp}
  const refresh = new Map();    // refresh token -> uid
  const rows = new Map();       // id -> row
  const log = [];
  let offline = false, n = 0;
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  const session = (u) => {
    const at = 'at-' + ++n, rt = 'rt-' + n;
    access.set(at, { uid: u.id, exp: Date.now() + ttlSeconds * 1000 });
    refresh.set(rt, u.id);
    return { access_token: at, refresh_token: rt, expires_in: ttlSeconds, user: { id: u.id, email: u.email } };
  };
  const filters = (u) => {
    const f = {};
    for (const [k, v] of u.searchParams) { const m = /^eq\.(.*)$/.exec(v); if (m) f[k] = m[1]; }
    return f;
  };
  async function fetch(url, opts = {}) {
    if (offline) throw new TypeError('fetch failed');
    const u = new URL(url), method = (opts.method || 'GET').toUpperCase();
    log.push(`${method} ${u.pathname}${u.search}`);
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (u.pathname === '/auth/v1/otp') { asked.add(body.email); return res(200, {}); }
    if (u.pathname === '/auth/v1/verify') {
      if (!asked.has(body.email) || body.token !== code) return res(403, { msg: 'Token has expired or is invalid' });
      let user = users.get(body.email);
      if (!user) { user = { id: 'user-' + (users.size + 1), email: body.email }; users.set(body.email, user); }
      return res(200, session(user));
    }
    if (u.pathname === '/auth/v1/logout') { // revokes every refresh token of the caller
      const h = opts.headers || {};
      const tok = access.get(String(h.Authorization || h.authorization || '').replace('Bearer ', ''));
      if (tok) for (const [rt, uid] of [...refresh]) if (uid === tok.uid) refresh.delete(rt);
      return res(204, {});
    }
    if (u.pathname === '/auth/v1/token') {
      const uid = refresh.get(body.refresh_token);
      if (!uid) return res(400, { msg: 'Invalid Refresh Token' });
      refresh.delete(body.refresh_token);
      const user = [...users.values()].find((x) => x.id === uid);
      return res(200, session(user));
    }
    if (u.pathname === '/rest/v1/child_profiles') {
      const h = opts.headers || {};
      const tok = access.get(String(h.Authorization || h.authorization || '').replace('Bearer ', ''));
      if (!tok || tok.exp < Date.now()) return res(401, { message: 'JWT expired' });
      const f = filters(u);
      const mine = (r) => r.owner === tok.uid;
      if (method === 'GET') return res(200, [...rows.values()].filter((r) => mine(r) && (!f.id || r.id === f.id)).map((r) => ({ ...r })));
      if (method === 'POST') {
        if (rows.has(body.id)) return res(409, { message: 'duplicate key' });
        if ([...rows.values()].filter(mine).length >= 8) return res(400, { message: 'profile limit reached' });
        const row = { id: body.id, owner: tok.uid, name: body.name, kind: body.kind, data: body.data || {}, version: 1 };
        rows.set(row.id, row);
        return res(201, [{ ...row }]);
      }
      if (method === 'PATCH') {
        const r = rows.get(f.id);
        if (!r || !mine(r) || (f.version && String(r.version) !== f.version)) return res(200, []);
        Object.assign(r, { name: body.name ?? r.name, data: body.data ?? r.data, version: body.version ?? r.version + 1 });
        return res(200, [{ ...r }]);
      }
    }
    return res(404, { message: 'not found: ' + u.pathname });
  }
  return {
    fetch, rows, log,
    setOffline: (b) => { offline = b; },
    expireAccessTokens: () => access.forEach((t) => { t.exp = Date.now() - 1000; }),
    revokeRefreshTokens: () => refresh.clear(),
    userByEmail: (e) => users.get(e),
  };
}

// A tiny localStorage stand-in for tests that run outside jsdom.
export function memoryStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, _map: m };
}
