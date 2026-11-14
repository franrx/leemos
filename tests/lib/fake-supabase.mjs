// In-memory stand-in for Supabase (auth + the child_profiles table) used by tests/sync.mjs and tests/smoke.mjs.
// It enforces what the real project enforces: link/class-based row visibility, the 8-profile and 60-per-class limits, optimistic version
// filters, JWT expiry, and the RPCs of supabase/migrations/20261113000000_teachers_classes.sql (same codes, same return shapes).
// Invitation expiry uses an injectable clock (`now` option, `srv.advance(ms)`); JWT expiry keeps using the real clock.
export function createFakeSupabase({ code = '123456', ttlSeconds = 3600, now: baseNow = Date.now } = {}) {
  const users = new Map();      // email -> {id, email}
  const asked = new Set();      // emails that requested a code
  const access = new Map();     // access token -> {uid, exp}
  const refresh = new Map();    // refresh token -> uid
  const rows = new Map();       // id -> row {id, owner, class_id, name, kind, data, version}
  const links = new Map();      // child id -> Set of user ids (parent links)
  const accounts = new Map();   // user id -> {role, ack}
  const classes = new Map();    // id -> {id, name}
  const teachers = new Set();   // `${classId}|${userId}`
  const roleInvites = new Map(); // email -> expires_at (ms)
  const invites = [];           // {code, kind, child, by, exp, used}
  const attempts = [];          // {uid, at}
  const tombstones = new Set();
  const hidden = new Set();     // row ids the account no longer sees (policy refuses them)
  const log = [];
  let offline = false, n = 0, skew = 0;
  const clock = () => baseNow() + skew;
  const iso = (ms) => new Date(ms).toISOString();
  const DAY = 24 * 3600 * 1000, ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  const session = (u) => {
    const at = 'at-' + ++n, rt = 'rt-' + n;
    access.set(at, { uid: u.id, exp: Date.now() + ttlSeconds * 1000 });
    refresh.set(rt, u.id);
    return { access_token: at, refresh_token: rt, expires_in: ttlSeconds, user: { id: u.id, email: u.email } };
  };
  const ensureUser = (email) => {
    let user = users.get(email);
    if (!user) { user = { id: 'user-' + (users.size + 1), email }; users.set(email, user); }
    if (!accounts.has(user.id)) accounts.set(user.id, { role: 'parent', ack: null });
    return user;
  };
  const emailOf = (uid) => { const u = [...users.values()].find((x) => x.id === uid); return u ? u.email : ''; };
  const linkSet = (id) => { if (!links.has(id)) links.set(id, new Set()); return links.get(id); };
  const hasLink = (uid, id) => linkSet(id).has(uid);
  const hasAnyLink = (id) => linkSet(id).size > 0;
  const isTeacher = (uid, cid) => !!cid && teachers.has(cid + '|' + uid) && (accounts.get(uid) || {}).role === 'teacher' && !!(accounts.get(uid) || {}).ack;
  const isAdmin = (uid) => (accounts.get(uid) || {}).role === 'admin';
  // the select policy of child_profiles, including the creator's one-shot clause
  const canSee = (uid, r) => !hidden.has(r.id) && (hasLink(uid, r.id) || isTeacher(uid, r.class_id) || (r.owner === uid && !r.class_id && !hasAnyLink(r.id)));
  const dropLink = (uid, id) => {
    linkSet(id).delete(uid);
    const r = rows.get(id);
    if (r && !hasAnyLink(id)) r.owner = null; // child_links_clear_owner
  };
  const removeChild = (id) => { tombstones.add(id); rows.delete(id); links.delete(id); for (let i = invites.length; i--;) if (invites[i].child === id) invites.splice(i, 1); };
  const filters = (u) => {
    const f = {};
    for (const [k, v] of u.searchParams) { const m = /^eq\.(.*)$/.exec(v); if (m) f[k] = m[1]; }
    return f;
  };
  // ---------- RPCs: the same semantics and return shapes as the SQL functions ----------
  function rpc(name, a, uid) {
    const err = (e, more) => ({ error: e, ...(more || {}) });
    const fail = (e) => { attempts.push({ uid, at: clock() }); return err(e); };
    const normCode = (c) => String(c || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const admin = () => (isAdmin(uid) ? null : err('forbidden'));
    switch (name) {
      case 'whoami': {
        const user = [...users.values()].find((x) => x.id === uid), acc = accounts.get(uid);
        const exp = user && roleInvites.get(user.email.toLowerCase());
        if (exp !== undefined) { // claim_role: a pending, unexpired invitation turns a parent into a teacher and is consumed
          roleInvites.delete(user.email.toLowerCase());
          if (exp > clock() && acc && acc.role === 'parent') acc.role = 'teacher';
        }
        return { role: acc ? acc.role : 'parent', teacher_ack_at: acc && acc.ack ? acc.ack : null };
      }
      case 'ack_teacher': {
        const acc = accounts.get(uid);
        if (!acc || acc.role !== 'teacher') return err('forbidden');
        acc.ack = acc.ack || iso(clock());
        return { ok: true, teacher_ack_at: acc.ack };
      }
      case 'create_invite': {
        const r = rows.get(a.p_child);
        if (!['to_class', 'to_parent'].includes(a.p_kind)) return err('forbidden');
        if (!r || !(hasLink(uid, r.id) || isTeacher(uid, r.class_id))) return err('not_found');
        if (a.p_kind === 'to_class') {
          if (!hasLink(uid, r.id)) return err('forbidden');
          if (r.class_id) return err('already_in_class');
        } else {
          if (!isTeacher(uid, r.class_id)) return err('forbidden');
          if (hasAnyLink(r.id)) return err('has_parent');
        }
        if (invites.filter((i) => i.child === r.id && !i.used && i.exp > clock()).length >= 5) return err('limit');
        let c;
        do { c = ''; for (let i = 0; i < 8; i++) c += ALPHA[Math.floor(Math.random() * 32)]; } while (invites.some((i) => i.code === c));
        const exp = clock() + 7 * DAY;
        invites.push({ code: c, kind: a.p_kind, child: r.id, by: uid, exp, used: false });
        return { ok: true, code: c, expires_at: iso(exp) };
      }
      case 'redeem_invite': {
        for (let i = attempts.length; i--;) if (attempts[i].uid === uid && attempts[i].at < clock() - 3600000) attempts.splice(i, 1);
        if (attempts.filter((t) => t.uid === uid).length >= 10) return err('rate');
        const inv = invites.find((i) => i.code === normCode(a.p_code) && !i.used && i.exp > clock());
        if (!inv || inv.by === uid) return fail('invalid');
        const child = rows.get(inv.child);
        if (!child) return fail('invalid');
        if (inv.kind === 'to_class' && !hasLink(inv.by, child.id)) return fail('invalid'); // void: the creator lost the right
        if (inv.kind === 'to_parent' && !isTeacher(inv.by, child.class_id)) return fail('invalid');
        const cls = a.p_class || null;
        if (inv.kind === 'to_parent' && cls) return fail('invalid'); // the class box takes only to_class codes
        if (inv.kind === 'to_class') {
          if (!isTeacher(uid, cls)) return fail('forbidden');
          if (child.class_id) return fail('already_in_class');
          if ([...rows.values()].filter((r) => r.class_id === cls).length >= 60) return fail('limit');
        } else {
          if (hasAnyLink(child.id)) return fail('has_parent');
          if ([...links.values()].filter((l) => l.has(uid)).length >= 8) return fail('limit');
        }
        inv.used = true;
        if (inv.kind === 'to_class') child.class_id = cls; else linkSet(child.id).add(uid);
        return { ok: true, child_id: child.id };
      }
      case 'leave_class': {
        const r = rows.get(a.p_child);
        if (!r || !(hasLink(uid, r.id) || isTeacher(uid, r.class_id))) return err('not_found');
        if (!r.class_id) return { ok: true };
        if (!hasAnyLink(r.id)) return err('orphan');
        r.class_id = null;
        for (let i = invites.length; i--;) if (invites[i].child === r.id && !invites[i].used) invites.splice(i, 1);
        return { ok: true };
      }
      case 'unlink_me': {
        const r = rows.get(a.p_child);
        if (!r || !hasLink(uid, r.id)) return err('not_found');
        dropLink(uid, r.id);
        for (let i = invites.length; i--;) if (invites[i].child === r.id && !invites[i].used) invites.splice(i, 1);
        if (!r.class_id && !hasAnyLink(r.id)) { removeChild(r.id); return { ok: true, deleted: true }; }
        return { ok: true, deleted: false };
      }
      case 'delete_child': {
        const r = rows.get(a.p_child);
        if (!r || !(hasLink(uid, r.id) || isTeacher(uid, r.class_id))) return err('not_found');
        if (hasAnyLink(r.id) ? !hasLink(uid, r.id) : !isTeacher(uid, r.class_id)) return err('forbidden');
        removeChild(r.id);
        return { ok: true };
      }
      case 'export_my_data': {
        const acc = accounts.get(uid) || {};
        const mine = [...rows.values()].filter((r) => hasLink(uid, r.id) || isTeacher(uid, r.class_id));
        const cls = [...classes.values()].filter((c) => isTeacher(uid, c.id) || [...rows.values()].some((r) => r.class_id === c.id && hasLink(uid, r.id)));
        return {
          account: { email: emailOf(uid), role: acc.role },
          classes: cls.sort((x, y) => x.name.localeCompare(y.name)).map((c) => ({ id: c.id, name: c.name })),
          children: mine.sort((x, y) => String(x.name).localeCompare(String(y.name))).map((r) => ({ id: r.id, name: r.name, kind: r.kind, class_id: r.class_id, linked: hasLink(uid, r.id), data: r.data })),
        };
      }
      case 'delete_my_account': {
        if (isAdmin(uid) && [...accounts.values()].filter((x) => x.role === 'admin').length <= 1) return err('last_admin');
        for (const r of [...rows.values()]) {
          if (!hasLink(uid, r.id)) continue;
          if (!r.class_id && linkSet(r.id).size === 1) removeChild(r.id); // linked, class-less and nobody else's: deleted with a tombstone
          else dropLink(uid, r.id);
        }
        for (const r of rows.values()) if (r.owner === uid) r.owner = null;
        for (const t of [...teachers]) if (t.endsWith('|' + uid)) teachers.delete(t);
        const user = [...users.values()].find((x) => x.id === uid);
        users.delete(user.email); accounts.delete(uid);
        for (const [k, v] of [...access]) if (v.uid === uid) access.delete(k);
        for (const [k, v] of [...refresh]) if (v === uid) refresh.delete(k);
        return { ok: true };
      }
      case 'admin_list_accounts': {
        const bad = admin(); if (bad) return bad;
        const list = [...accounts].filter(([, x]) => ['teacher', 'admin'].includes(x.role)).map(([id, x]) => ({ user_id: id, email: emailOf(id), role: x.role }));
        list.sort((x, y) => x.role.localeCompare(y.role) || x.email.localeCompare(y.email));
        return { accounts: list, invites: [...roleInvites].filter(([, e]) => e > clock()).map(([email, e]) => ({ email, expires_at: iso(e) })).sort((x, y) => x.email.localeCompare(y.email)) };
      }
      case 'admin_list_classes': {
        const bad = admin(); if (bad) return bad;
        return { classes: [...classes.values()].sort((x, y) => x.name.localeCompare(y.name)).map((c) => {
          const kids = [...rows.values()].filter((r) => r.class_id === c.id);
          return { id: c.id, name: c.name, teachers: [...teachers].filter((t) => t.startsWith(c.id + '|')).map((t) => { const id = t.split('|')[1]; return { user_id: id, email: emailOf(id) }; }).sort((x, y) => x.email.localeCompare(y.email)), children: kids.length, unclaimed: kids.filter((r) => !hasAnyLink(r.id)).length };
        }) };
      }
      case 'admin_invite_teacher': {
        const bad = admin(); if (bad) return bad;
        const email = String(a.p_email || '').trim().toLowerCase();
        if (email.indexOf('@') < 1 || email.length > 254) return err('bad_input');
        const exp = clock() + 30 * DAY;
        roleInvites.set(email, exp);
        return { ok: true, email, expires_at: iso(exp) };
      }
      case 'admin_revoke_invite': {
        const bad = admin(); if (bad) return bad;
        const email = String(a.p_email || '').trim().toLowerCase();
        return roleInvites.delete(email) ? { ok: true } : err('not_found');
      }
      case 'admin_demote_teacher': {
        const bad = admin(); if (bad) return bad;
        const acc = accounts.get(a.p_user);
        if (!acc || acc.role !== 'teacher') return err('not_found');
        acc.role = 'parent'; acc.ack = null;
        for (const t of [...teachers]) if (t.endsWith('|' + a.p_user)) teachers.delete(t);
        for (let i = invites.length; i--;) if (invites[i].by === a.p_user && invites[i].kind === 'to_parent' && !invites[i].used) invites.splice(i, 1);
        return { ok: true };
      }
      case 'admin_create_class': {
        const bad = admin(); if (bad) return bad;
        const nm = String(a.p_name || '').trim();
        if (nm.length < 1 || nm.length > 40) return err('bad_input');
        const id = crypto.randomUUID();
        classes.set(id, { id, name: nm });
        return { ok: true, id, name: nm };
      }
      case 'admin_rename_class': {
        const bad = admin(); if (bad) return bad;
        const nm = String(a.p_name || '').trim();
        if (nm.length < 1 || nm.length > 40) return err('bad_input');
        const c = classes.get(a.p_class);
        if (!c) return err('not_found');
        c.name = nm;
        return { ok: true };
      }
      case 'admin_delete_class': {
        const bad = admin(); if (bad) return bad;
        const c = classes.get(a.p_class);
        if (!c) return err('not_found');
        const kids = [...rows.values()].filter((r) => r.class_id === c.id);
        const orphans = kids.filter((r) => !hasAnyLink(r.id)).length;
        if (orphans) return err('orphans', { count: orphans });
        for (const r of kids) { r.class_id = null; for (let i = invites.length; i--;) if (invites[i].child === r.id && !invites[i].used) invites.splice(i, 1); }
        classes.delete(c.id);
        for (const t of [...teachers]) if (t.startsWith(c.id + '|')) teachers.delete(t);
        return { ok: true };
      }
      case 'admin_assign_teacher': {
        const bad = admin(); if (bad) return bad;
        const acc = accounts.get(a.p_user);
        if (!classes.has(a.p_class) || !acc || acc.role !== 'teacher') return err('not_found');
        teachers.add(a.p_class + '|' + a.p_user);
        return { ok: true };
      }
      case 'admin_unassign_teacher': {
        const bad = admin(); if (bad) return bad;
        if (!teachers.delete(a.p_class + '|' + a.p_user)) return err('not_found');
        for (let i = invites.length; i--;) {
          const r = rows.get(invites[i].child);
          if (invites[i].by === a.p_user && invites[i].kind === 'to_parent' && !invites[i].used && r && r.class_id === a.p_class) invites.splice(i, 1);
        }
        return { ok: true };
      }
      default: return { error: 'not_found' };
    }
  }
  async function fetch(url, opts = {}) {
    if (offline) throw new TypeError('fetch failed');
    const u = new URL(url), method = (opts.method || 'GET').toUpperCase();
    log.push(`${method} ${u.pathname}${u.search}`);
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (u.pathname === '/auth/v1/otp') { asked.add(body.email); return res(200, {}); }
    if (u.pathname === '/auth/v1/verify') {
      if (!asked.has(body.email) || body.token !== code) return res(403, { msg: 'Token has expired or is invalid' });
      return res(200, session(ensureUser(body.email)));
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
    if (u.pathname.startsWith('/rest/v1/')) {
      const h = opts.headers || {};
      const tok = access.get(String(h.Authorization || h.authorization || '').replace('Bearer ', ''));
      if (!tok || tok.exp < Date.now()) return res(401, { message: 'JWT expired' });
      const uid = tok.uid;
      if (u.pathname.startsWith('/rest/v1/rpc/')) return method === 'POST' ? res(200, rpc(u.pathname.slice('/rest/v1/rpc/'.length), body || {}, uid)) : res(405, {});
      const f = filters(u);
      if (u.pathname === '/rest/v1/classes' && method === 'GET') {
        const seen = (c) => isAdmin(uid) || isTeacher(uid, c.id) || [...rows.values()].some((r) => r.class_id === c.id && canSee(uid, r));
        const embed = String(u.searchParams.get('select') || '').includes('class_teachers('); // RLS on class_teachers: only the caller's own rows
        return res(200, [...classes.values()].filter((c) => seen(c) && (!f.id || c.id === f.id)).sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ ...c, ...(embed ? { class_teachers: teachers.has(c.id + '|' + uid) ? [{ teacher_id: uid }] : [] } : {}) })));
      }
      if (u.pathname !== '/rest/v1/child_profiles') return res(404, { message: 'not found: ' + u.pathname });
      // the embedded child_links(user_id): RLS returns only the caller's own link
      const out = (r) => ({ ...r, has_parent: hasAnyLink(r.id), child_links: hasLink(uid, r.id) ? [{ user_id: uid }] : [] }); // has_parent: the computed column
      if (method === 'GET') return res(200, [...rows.values()].filter((r) => canSee(uid, r) && (!f.id || r.id === f.id)).map(out));
      if (method === 'POST') {
        const cid = body.class_id || null;
        // insert policy first (it runs before the unique index): creator, own class or none, never a tombstoned id
        if (tombstones.has(body.id) || (cid && !isTeacher(uid, cid))) return res(403, { message: 'new row violates row-level security policy' });
        if (rows.has(body.id)) return res(409, { message: 'duplicate key' });
        if (!cid && [...rows.values()].filter((r) => r.owner === uid && !r.class_id).length >= 8) return res(400, { message: 'profile limit reached' });
        if (cid && [...rows.values()].filter((r) => r.class_id === cid).length >= 60) return res(400, { message: 'class limit reached' });
        const row = { id: body.id, owner: uid, class_id: cid, name: body.name, kind: body.kind, data: body.data || {}, version: 1 };
        rows.set(row.id, row);
        if (!cid) linkSet(row.id).add(uid); // child_profiles_link_creator
        return res(201, [out(row)]);
      }
      if (method === 'PATCH') {
        const r = rows.get(f.id);
        if (!r || !canSee(uid, r) || (f.version && String(r.version) !== f.version)) return res(200, []);
        Object.assign(r, { name: body.name ?? r.name, kind: body.kind ?? r.kind, data: body.data ?? r.data, version: body.version ?? r.version + 1 });
        return res(200, [out(r)]);
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
    // teachers/classes helpers
    links, accounts, classes, tombstones, roleInvites, invites,
    advance: (ms) => { skew += ms; },
    setRole: (email, role, { ack = false } = {}) => { const u = ensureUser(email); accounts.set(u.id, { role, ack: ack ? iso(clock()) : null }); },
    addClass: (name) => { const id = crypto.randomUUID(); classes.set(id, { id, name }); return id; },
    addTeacher: (classId, email) => { teachers.add(classId + '|' + ensureUser(email).id); },
    inviteTeacher: (email, days = 30) => { roleInvites.set(email.toLowerCase(), clock() + days * DAY); },
    hideRow: (id) => { hidden.add(id); },
    tombstone: (id) => { tombstones.add(id); },
  };
}

// A tiny localStorage stand-in for tests that run outside jsdom.
export function memoryStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, _map: m };
}
