// In-memory stand-in for Supabase (auth + the child_profiles table) used by tests/sync.mjs and tests/smoke.mjs.
// It enforces what the real project enforces: link/class-based row visibility, the 8-profile and 60-per-class limits, optimistic version
// filters, JWT expiry, and the RPCs of supabase/migrations/20261113000000_teachers_classes.sql (same codes, same return shapes).
// Invitation expiry uses an injectable clock (`now` option, `srv.advance(ms)`); JWT expiry keeps using the real clock.
// trigger child_profiles_data: stamps at most now + 10 min, level at most 4 (the last level index), resets at most old + 1 (1000 on
// insert); only numbers are touched, an odd type is left alone
const clampData = (d, old, now) => {
  const cap = Math.floor(now) + 600000, isNum = (v) => typeof v === 'number', isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  // on update, the old counters that are safe integers (>= 0) never go down: a lowered, missing or odd value keeps the old one
  const keep = {};
  if (old && isObj(old) && isObj(old.resets)) for (const L of ['es', 'ca']) { const v = old.resets[L]; if (isNum(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER) keep[L] = Math.floor(v); }
  const kept = Object.keys(keep).length > 0;
  if (!isObj(d)) { if (!kept) return d; d = {}; }
  const out = { ...d };
  if (kept && !isObj(out.resets)) out.resets = {};
  if (isNum(out.modAt) && out.modAt > cap) out.modAt = cap;
  if (isObj(out.session) && isNum(out.session.at) && out.session.at > cap) out.session = { ...out.session, at: cap };
  if (isObj(out.prefs)) out.prefs = Object.fromEntries(Object.entries(out.prefs).map(([k, e]) => [k, isObj(e) && isNum(e.at) && e.at > cap ? { ...e, at: cap } : e]));
  if (isNum(out.level) && out.level > 4) out.level = 4;
  if (isObj(out.resets)) {
    out.resets = { ...out.resets };
    for (const L of ['es', 'ca']) {
      if (L in keep) { const o = keep[L]; out.resets[L] = isNum(out.resets[L]) ? Math.max(o, Math.min(out.resets[L], o + 1)) : o; continue; }
      if (!isNum(out.resets[L])) continue;
      const o = old && isObj(old.resets) && isNum(old.resets[L]) ? Math.max(0, Math.floor(old.resets[L])) + 1 : 1;
      const allowed = old ? o : 1000;
      if (out.resets[L] > allowed) out.resets[L] = allowed;
    }
  }
  return out;
};

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
  const adminLog = [];          // admin_log rows the RPCs write (only redeem_to_parent is modelled)
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
  // private.granted_links: the parent links that came from a teacher's redeemed to_parent codes (optionally only for one class)
  const granted = (teacher, cls) => {
    const out = [];
    for (const [id, set] of links) for (const user of set) {
      const r = rows.get(id);
      if (r && (!cls || r.class_id === cls) && invites.some((i) => i.child === id && i.kind === 'to_parent' && i.used && i.usedBy === user && i.by === teacher)) out.push({ r, user });
    }
    return out;
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
        inv.used = true; inv.usedBy = uid;
        if (inv.kind === 'to_class') child.class_id = cls;
        else { // the child has its parent: its other parent codes go, and the grant is logged
          linkSet(child.id).add(uid);
          for (let i = invites.length; i--;) if (invites[i].child === child.id && invites[i].kind === 'to_parent' && !invites[i].used) invites.splice(i, 1);
          adminLog.push({ actor: uid, action: 'redeem_to_parent', detail: { child_id: child.id, teacher: inv.by } });
        }
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
          else { dropLink(uid, r.id); for (let i = invites.length; i--;) if (invites[i].child === r.id && !invites[i].used) invites.splice(i, 1); } // its pending codes are voided
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
        // former: accounts that no longer exist whose to_parent codes made links still in place (the SQL reads child_links.granted_by)
        const gone = [...new Set(invites.filter((i) => i.kind === 'to_parent' && i.used && !emailOf(i.by)).map((i) => i.by))].sort();
        const former = gone.map((by) => { const g = granted(by, null); return { user_id: by, parent_links: g.filter((x) => x.r.class_id).length, outside_class: g.filter((x) => !x.r.class_id).length }; }).filter((f) => f.parent_links + f.outside_class > 0);
        return { accounts: list, invites: [...roleInvites].filter(([, e]) => e > clock()).map(([email, e]) => ({ email, expires_at: iso(e) })).sort((x, y) => x.email.localeCompare(y.email)), former };
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
        const g = granted(a.p_user, null);
        return { ok: true, parent_links: g.filter((x) => x.r.class_id).length, outside_class: g.filter((x) => !x.r.class_id).length };
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
        return { ok: true, parent_links: granted(a.p_user, a.p_class).length, outside_class: 0 };
      }
      case 'admin_drop_teacher_links': {
        const bad = admin(); if (bad) return bad;
        const g = granted(a.p_user, a.p_class || null).filter((x) => x.r.class_id);
        for (const x of g) { dropLink(x.user, x.r.id); for (let i = invites.length; i--;) if (invites[i].child === x.r.id && !invites[i].used) invites.splice(i, 1); }
        return { ok: true, dropped: g.length };
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
        const row = { id: body.id, owner: uid, class_id: cid, name: body.name, kind: body.kind, data: clampData(body.data || {}, null, clock()), version: 1 }; // trigger child_profiles_version: an insert always starts at 1
        rows.set(row.id, row);
        if (!cid) linkSet(row.id).add(uid); // child_profiles_link_creator
        return res(201, [out(row)]);
      }
      if (method === 'PATCH') {
        const r = rows.get(f.id);
        // PostgREST casts the body first: a version past the integer maximum is 22003 before any row is touched
        if (typeof body.version === 'number' && body.version > 2147483647) return res(400, { code: '22003', message: `value "${body.version}" is out of range for type integer` });
        if (!r || !canSee(uid, r) || (f.version && String(r.version) !== f.version)) return res(200, []);
        // trigger child_profiles_version: a changed version moves at most one step up (least(new, old + 1)); an omitted one stays
        const v = body.version === undefined || body.version === r.version ? r.version : Math.min(body.version, r.version + 1);
        Object.assign(r, { name: body.name ?? r.name, kind: body.kind ?? r.kind, data: clampData(body.data ?? r.data, r.data, clock()), version: v });
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
    links, accounts, classes, tombstones, roleInvites, invites, adminLog,
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
