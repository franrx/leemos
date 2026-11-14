// Verifies row level security on a REAL Supabase project with throwaway users. Run it after applying the migrations:
//   node scripts/check-rls.mjs        (or `npm run test:rls`, which runs it against a local Docker Supabase)
// Needs in .env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY (the service key stays in .env, never in git or the app).
// It creates users with the admin API, signs them in with a password, sets roles/classes with the service key (the only way, as in
// production), and deletes everything it created at the end. Spec: docs/superpowers/specs/2026-11-13-teachers-classes-design.md section 9.
import { readFileSync, existsSync } from 'node:fs';

const env = { ...process.env };
if (existsSync('.env')) for (const l of readFileSync('.env', 'utf8').split('\n')) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l); if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const { SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_KEY: service } = env;
const url = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/(rest|auth)\/v1$/, '').replace(/\/+$/, ''); // project root, even if pasted with an API path
if (!url || !anon || !service) { console.error('Faltan SUPABASE_URL, SUPABASE_ANON_KEY o SUPABASE_SERVICE_KEY en .env'); process.exit(2); }

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const j = (h) => ({ 'Content-Type': 'application/json', ...h });
const stamp = Date.now();
const pw = 'T3st-' + Math.random().toString(36).slice(2) + 'Zz9!';
const made = [], kids = [], classes = [], emails = []; // everything created, for the cleanup in `finally`
const mk = async (tag) => {
  const email = `rls-${tag}-${stamp}@example.com`;
  const c = await fetch(`${url}/auth/v1/admin/users`, { method: 'POST', headers: j({ apikey: service, Authorization: 'Bearer ' + service }), body: JSON.stringify({ email, password: pw, email_confirm: true }) });
  const u = await c.json();
  const s = await (await fetch(`${url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: j({ apikey: anon }), body: JSON.stringify({ email, password: pw }) })).json();
  const me = { id: u.id, token: s.access_token, email };
  made.push(me);
  return me;
};
const rest = (u, path, opts = {}) => fetch(`${url}/rest/v1/${path}`, { ...opts, headers: j({ apikey: anon, Authorization: 'Bearer ' + u.token, Prefer: 'return=representation', ...(opts.headers || {}) }) });
const uuid = () => crypto.randomUUID();
const svc = (path, opts = {}) => fetch(`${url}/rest/v1/${path}`, { ...opts, headers: j({ apikey: service, Authorization: 'Bearer ' + service, Prefer: 'return=representation', ...(opts.headers || {}) }) });
const json = async (r) => { try { return await r.json(); } catch { return null; } };
const one = async (r) => { const b = await json(r); return Array.isArray(b) ? b[0] : undefined; };
const rpc = async (u, name, args = {}) => { // u = null calls it with only the public key
  const r = await fetch(`${url}/rest/v1/rpc/${name}`, { method: 'POST', headers: j({ apikey: anon, Authorization: 'Bearer ' + (u ? u.token : anon) }), body: JSON.stringify(args) });
  return { status: r.status, body: await json(r) };
};
const okr = (r) => r.status < 300 && !(r.body && r.body.error); // an RPC refuses with an HTTP error or with {error:'…'}
const refused = (r) => r.status !== 404 && !okr(r); // 404 is a missing function or a wrong signature, never a refusal
const errOf = (r) => (r.body && r.body.error) || '';
// A user with a role; `ack` also sets the teacher acknowledgement (accounts has no client write: only the service key sets these).
const mkRole = async (tag, role, { ack = false } = {}) => {
  const u = await mk(tag);
  if (role !== 'parent' || ack) { const row = await one(await svc(`accounts?user_id=eq.${u.id}`, { method: 'PATCH', body: JSON.stringify({ role, teacher_ack_at: ack ? new Date().toISOString() : null }) })); check(`setup: ${tag} has role ${role}`, !!row && row.role === role); }
  return u;
};
const whoami = async (u) => { const r = await rpc(u, 'whoami'); return (Array.isArray(r.body) ? r.body[0] : r.body) || {}; };
const mkClass = async (name) => { const c = await one(await svc('classes', { method: 'POST', body: JSON.stringify({ name }) })); if (c) classes.push(c.id); return c && c.id; };
const teach = (cls, u) => svc('class_teachers', { method: 'POST', body: JSON.stringify({ class_id: cls, teacher_id: u.id }) });
const mkKid = async (u, extra = {}) => { const id = uuid(); kids.push(id); await rest(u, 'child_profiles', { method: 'POST', body: JSON.stringify({ id, name: 'Kid', kind: 'reader', ...extra }) }); return id; };
const kidRow = async (id) => one(await svc(`child_profiles?id=eq.${id}&select=id,class_id`));
const linksOf = async (id) => (await json(await svc(`child_links?child_id=eq.${id}`))) || [];
const seen = async (u, id) => { const b = await json(await rest(u, `child_profiles?id=eq.${id}&select=id`)); return Array.isArray(b) && b.length > 0; };
const code = async (u, child, kind) => { const r = await rpc(u, 'create_invite', { p_child: child, p_kind: kind }); return r.body && r.body.code; };
const redeem = (u, c, cls) => rpc(u, 'redeem_invite', { p_code: c, p_class: cls });
const share = async (parent, kid, teacher, cls) => redeem(teacher, await code(parent, kid, 'to_class'), cls); // parent puts their child in the teacher's class
const claim = async (teacher, cls, parent) => { const kid = await mkKid(teacher, { class_id: cls }); await redeem(parent, await code(teacher, kid, 'to_parent')); return kid; }; // teacher-created child, then a parent takes it
const t = async (name, fn) => { let ok = false, extra = ''; try { const r = await fn(); ok = Array.isArray(r) ? !!r[0] : r === true; if (Array.isArray(r)) extra = String(r[1] ?? ''); } catch (e) { extra = 'threw: ' + e.message; } check(name, ok, extra); };

const A = await mk('a'), B = await mk('b');
try {
  const id = uuid();
  const ins = await rest(A, 'child_profiles', { method: 'POST', body: JSON.stringify({ id, name: 'Elsa', kind: 'reader', data: { total: 1 } }) });
  const row = (await ins.json())[0];
  check('A can create a profile and the owner is A', ins.status === 201 && row && row.owner === A.id, String(ins.status));
  check("B cannot read A's profile", (await (await rest(B, `child_profiles?id=eq.${id}`)).json()).length === 0);
  const upd = await (await rest(B, `child_profiles?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Hacked' }) })).json();
  check("B cannot update A's profile", Array.isArray(upd) && upd.length === 0);
  const delR = await rest(B, `child_profiles?id=eq.${id}`, { method: 'DELETE' }), del = await json(delR); // direct delete is revoked (403) since the teachers migration
  check("B cannot delete A's profile", (delR.status >= 400 || (Array.isArray(del) && del.length === 0)) && !!(await one(await svc(`child_profiles?id=eq.${id}&select=id`))), String(delR.status));
  const steal = await rest(B, 'child_profiles', { method: 'POST', body: JSON.stringify({ id: uuid(), owner: A.id, name: 'X', kind: 'reader' }) });
  check('B cannot create a profile owned by A', steal.status >= 400, String(steal.status));
  const anonRead = await fetch(`${url}/rest/v1/child_profiles?select=id`, { headers: { apikey: anon, Authorization: 'Bearer ' + anon } });
  check('a request with only the public key sees nothing', anonRead.status >= 400 || (await anonRead.json()).length === 0, String(anonRead.status));
  const big = await rest(A, 'child_profiles', { method: 'POST', body: JSON.stringify({ id: uuid(), name: 'Big', kind: 'reader', data: { x: 'y'.repeat(250000) } }) });
  check('a profile over 200 KB is rejected', big.status >= 400, String(big.status));
  const bad = await rest(A, 'child_profiles', { method: 'POST', body: JSON.stringify({ id: uuid(), name: 'Bad', kind: 'admin' }) });
  check('an unknown kind is rejected', bad.status >= 400, String(bad.status));
  const own = await rest(A, `child_profiles?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ owner: B.id }) });
  check("A cannot hand a profile to B by changing 'owner'", own.status >= 400 || ((await own.json()).every((r) => r.owner === A.id)), String(own.status));
  const idc = await rest(A, `child_profiles?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ id: uuid() }) });
  check("A cannot change a profile's id", idc.status >= 400 || ((await idc.json()).every((r) => r.id === id)), String(idc.status));
  const v = await (await rest(A, `child_profiles?id=eq.${id}&version=eq.5`, { method: 'PATCH', body: JSON.stringify({ name: 'Stale', version: 6 }) })).json();
  check('a write with a wrong version changes nothing (optimistic concurrency)', Array.isArray(v) && v.length === 0);

  // ---- Teachers, classes and shared children. Fixtures: the roles are set with the service key, everything else goes through the real API.
  const AD = await mkRole('admin', 'admin'), T1 = await mkRole('t1', 'teacher', { ack: true }), T2 = await mkRole('t2', 'teacher', { ack: true });
  const T3 = await mkRole('t3', 'teacher'), PA = await mk('pa'), PB = await mk('pb');
  const C1 = await mkClass('rls 3A ' + stamp), C2 = await mkClass('rls 3B ' + stamp);
  await teach(C1, T1); await teach(C2, T2); await teach(C1, T3); // T3 teaches C1 but never accepted the acknowledgement
  const K1 = await mkKid(PA); // PA's child, put in C1 by PA with a code that T1 redeems
  const sh = await share(PA, K1, T1, C1);
  const K2 = await mkKid(T2, { class_id: C2 }); // created by T2 inside C2, no parent yet
  const classOfK1 = async () => (await kidRow(K1) || {}).class_id;

  await t('the sharing fixture works (PA puts K1 in C1, T1 redeems)', async () => [okr(sh) && (await classOfK1()) === C1, JSON.stringify(sh.body)]);
  await t("a parent does not see another family's child", async () => okr(sh) && (await seen(PA, K1)) && !(await seen(PB, K1)));
  await t("a teacher sees the children of their classes and only those", async () => (await seen(T1, K1)) && !(await seen(T1, K2)) && !(await seen(T1, id)));
  await t('a teacher of another class sees nothing', async () => okr(sh) && (await classOfK1()) === C1 && !(await seen(T2, K1)) && (await seen(T2, K2)));
  await t('a teacher without acknowledgement sees nothing', async () => (await whoami(T3)).role === 'teacher' && !(await seen(T3, K1)));
  await t('an admin cannot read any child', async () => (await whoami(AD)).role === 'admin' && !(await seen(AD, K1)) && !(await seen(AD, K2)));

  // A parent cannot give themselves a role. V and CV are a sacrificial teacher and class: they must still be there afterwards.
  const PM = await mk('pm'), V = await mkRole('v', 'teacher', { ack: true }), CV = await mkClass('rls victim ' + stamp);
  await teach(CV, V);
  await t('a parent cannot update accounts', async () => {
    const r = await rest(PM, `accounts?user_id=eq.${PM.id}`, { method: 'PATCH', body: JSON.stringify({ role: 'admin' }) });
    return [r.status !== 404 && (r.status >= 400 || !(await json(r)).length) && (await whoami(PM)).role === 'parent', String(r.status)];
  });
  await t('a parent cannot call any admin_* function', async () => {
    emails.push(`x-${stamp}@example.com`);
    const calls = [['admin_list_accounts', {}], ['admin_list_classes', {}], ['admin_invite_teacher', { p_email: `x-${stamp}@example.com` }], ['admin_revoke_invite', { p_email: 'x@example.com' }],
      ['admin_demote_teacher', { p_user: V.id }], ['admin_create_class', { p_name: 'Hack' }], ['admin_rename_class', { p_class: CV, p_name: 'Hack' }], ['admin_delete_class', { p_class: CV }],
      ['admin_assign_teacher', { p_class: CV, p_user: PM.id }], ['admin_unassign_teacher', { p_class: CV, p_user: V.id }]];
    const res = []; for (const [n, a] of calls) res.push(refused(await rpc(PM, n, a)));
    const ctl = okr(await rpc(AD, 'admin_list_accounts')) && okr(await rpc(AD, 'admin_rename_class', { p_class: CV, p_name: 'rls victim ' + stamp })); // the same functions work for an admin
    const still = ctl && (await whoami(V)).role === 'teacher' && !!(await one(await svc(`classes?id=eq.${CV}`))) && res.every(Boolean);
    return [still && (await json(await svc(`class_teachers?class_id=eq.${CV}`))).length === 1, res.join()];
  });
  await t("a parent cannot claim a role with someone else's invitation", async () => {
    const exp = new Date(Date.now() + 30 * 864e5).toISOString(); emails.push(`other-${stamp}@example.com`);
    await svc('role_invites', { method: 'POST', body: JSON.stringify({ email: `other-${stamp}@example.com`, created_by: AD.id, expires_at: exp }) });
    return (await whoami(PM)).role === 'parent';
  });
  await t('a parent cannot claim a role with an expired invitation', async () => {
    const P = await mk('pexp'); emails.push(P.email);
    await svc('role_invites', { method: 'POST', body: JSON.stringify({ email: P.email, created_by: AD.id, expires_at: new Date(Date.now() - 864e5).toISOString() }) });
    return (await whoami(P)).role === 'parent';
  });
  await t('whoami with no invitation leaves the role parent', async () => { const w = await whoami(await mk('plain')); return [w.role === 'parent' && !w.teacher_ack_at, JSON.stringify(w)]; });
  await t('an invited email becomes teacher on whoami and the invitation is gone', async () => {
    const I = await mk('inv'); emails.push(I.email);
    const inv = await rpc(AD, 'admin_invite_teacher', { p_email: I.email.toUpperCase() });
    const w = await whoami(I);
    return [okr(inv) && w.role === 'teacher' && !w.teacher_ack_at && !(await json(await svc(`role_invites?email=eq.${encodeURIComponent(I.email)}`))).length, JSON.stringify(w)];
  });
  await t('admin_list_accounts returns no parent email', async () => {
    const r = await rpc(AD, 'admin_list_accounts'); const txt = JSON.stringify(r.body);
    return okr(r) && !txt.includes(PA.email) && !txt.includes(PM.email) && !txt.includes(PB.email) && txt.includes(T1.email);
  });

  // Invitation codes: one uniform error whatever is wrong with the code.
  await t('used, expired, wrong and own codes give the same {error:invalid}', async () => {
    const PU = await mk('pu'), KU = await mkKid(PU), KE = await mkKid(PU), own = await mkKid(T1, { class_id: C1 });
    const used = await code(PU, KU, 'to_class'); const first = await redeem(T1, used, C1);
    const rUsed = await redeem(T2, used, C2);
    const exp = await code(PU, KE, 'to_class');
    await svc(`invites?child_id=eq.${KE}`, { method: 'PATCH', body: JSON.stringify({ expires_at: new Date(Date.now() - 6e4).toISOString() }) });
    const rExp = await redeem(T1, exp, C1), rWrong = await redeem(T1, 'ZZZZZZZZ', C1), rOwn = await redeem(T1, await code(T1, own, 'to_parent'));
    const want = JSON.stringify({ error: 'invalid' });
    return [okr(first) && [rUsed, rExp, rWrong, rOwn].every((r) => JSON.stringify(r.body) === want), [rUsed, rExp, rWrong, rOwn].map((r) => JSON.stringify(r.body)).join(' ')];
  });
  await t('two concurrent redeem_invite calls: exactly one wins', async () => {
    const PC = await mk('pc'), KC = await mkKid(PC), c = await code(PC, KC, 'to_class');
    const rs = await Promise.all([redeem(T1, c, C1), redeem(T2, c, C2)]);
    return [rs.filter(okr).length === 1 && [C1, C2].includes((await kidRow(KC)).class_id), rs.map((r) => JSON.stringify(r.body)).join(' ')];
  });
  await t('the 11th wrong code in an hour is rate limited', async () => {
    const TR = await mkRole('tr', 'teacher', { ack: true }), CR = await mkClass('rls rate ' + stamp); await teach(CR, TR);
    const rs = []; for (let i = 0; i < 11; i++) rs.push(await redeem(TR, 'ZZZZZZZZ', CR));
    return [rs.slice(0, 10).every((r) => errOf(r) === 'invalid') && errOf(rs[10]) === 'rate', rs.map(errOf).join()];
  });
  await t('a code is void after its creator lost the link or the class', async () => {
    const PL = await mk('pl'), KL = await mkKid(PL), c1 = await code(PL, KL, 'to_class');
    await svc(`child_links?child_id=eq.${KL}`, { method: 'DELETE' }); // PL lost the link
    const r1 = await redeem(T1, c1, C1);
    const TT = await mkRole('tt', 'teacher', { ack: true }), CT = await mkClass('rls void ' + stamp); await teach(CT, TT);
    const KT = await mkKid(TT, { class_id: CT }), c2 = await code(TT, KT, 'to_parent');
    await svc(`class_teachers?class_id=eq.${CT}&teacher_id=eq.${TT.id}`, { method: 'DELETE' }); // TT lost the class
    const r2 = await redeem(await mk('pv'), c2);
    return [refused(r1) && refused(r2) && !!errOf(r1) && !!errOf(r2) && !(await kidRow(KL) || {}).class_id, `${errOf(r1)} ${errOf(r2)}`];
  });
  await t('a code cannot be redeemed by its creator in either direction', async () => {
    const TC = await mkRole('tc', 'teacher', { ack: true }), CC = await mkClass('rls own ' + stamp); await teach(CC, TC);
    const mine = await mkKid(TC), ours = await mkKid(TC, { class_id: CC });
    const a = await redeem(TC, await code(TC, mine, 'to_class'), CC), b = await redeem(TC, await code(TC, ours, 'to_parent'));
    return [errOf(a) === 'invalid' && errOf(b) === 'invalid' && !(await kidRow(mine)).class_id, `${errOf(a)} ${errOf(b)}`];
  });
  await t('a teacher cannot create a to_parent code for a child that already has a parent', async () => refused(await rpc(T1, 'create_invite', { p_child: K1, p_kind: 'to_parent' })) && okr(await rpc(PA, 'create_invite', { p_child: K1, p_kind: 'to_class' })));

  // Leaving, removing, deleting.
  await t('leave_class works for the parent and the teacher loses access at once', async () => {
    const PL = await mk('pl2'), KL = await mkKid(PL); await share(PL, KL, T1, C1);
    const before = await seen(T1, KL), r = await rpc(PL, 'leave_class', { p_child: KL });
    return [before && okr(r) && !(await kidRow(KL)).class_id && !(await seen(T1, KL)) && await seen(PL, KL), JSON.stringify(r.body)];
  });
  await t('leave_class is refused (orphan) for an unclaimed child', async () => {
    const r = await rpc(T2, 'leave_class', { p_child: K2 });
    return [errOf(r) === 'orphan' && (await kidRow(K2)).class_id === C2, JSON.stringify(r.body)];
  });
  await t('admin_delete_class is refused while the class holds an unclaimed child', async () => {
    const CO = await mkClass('rls orphan ' + stamp), TO = await mkRole('to', 'teacher', { ack: true }); await teach(CO, TO); await mkKid(TO, { class_id: CO });
    const r = await rpc(AD, 'admin_delete_class', { p_class: CO });
    return [refused(r) && !!(await one(await svc(`classes?id=eq.${CO}`))), JSON.stringify(r.body)];
  });
  await t('a class holding only linked children can be deleted and the children keep their parent', async () => {
    const CD = await mkClass('rls del ' + stamp), TD = await mkRole('td', 'teacher', { ack: true }), PD = await mk('pd'); await teach(CD, TD);
    const KD = await mkKid(PD); await share(PD, KD, TD, CD);
    const r = await rpc(AD, 'admin_delete_class', { p_class: CD });
    const row = await kidRow(KD);
    return [okr(r) && !(await one(await svc(`classes?id=eq.${CD}`))) && !!row && !row.class_id && await seen(PD, KD), JSON.stringify(r.body)];
  });
  await t('demoting the last teacher of a class with an unclaimed child succeeds and the child survives', async () => {
    const TL = await mkRole('tl', 'teacher', { ack: true }), CL = await mkClass('rls last ' + stamp); await teach(CL, TL);
    const KL = await mkKid(TL, { class_id: CL }), r = await rpc(AD, 'admin_demote_teacher', { p_user: TL.id });
    return [okr(r) && (await whoami(TL)).role === 'parent' && !!(await kidRow(KL)), JSON.stringify(r.body)];
  });
  await t('a demoted teacher loses class access', async () => {
    const TD = await mkRole('td2', 'teacher', { ack: true }), CD = await mkClass('rls demote ' + stamp), PD = await mk('pd2'); await teach(CD, TD);
    const KD = await mkKid(PD); await share(PD, KD, TD, CD);
    const before = await seen(TD, KD), r = await rpc(AD, 'admin_demote_teacher', { p_user: TD.id });
    return [before && okr(r) && !(await seen(TD, KD)), JSON.stringify(r.body)];
  });
  await t('a teacher removed from a class (admin_unassign_teacher) loses access at once', async () => {
    const TU = await mkRole('tu', 'teacher', { ack: true }), CU = await mkClass('rls unassign ' + stamp), PU = await mk('pu2'); await teach(CU, TU);
    const KU = await mkKid(PU); await share(PU, KU, TU, CU);
    const before = await seen(TU, KU), r = await rpc(AD, 'admin_unassign_teacher', { p_class: CU, p_user: TU.id });
    return [before && okr(r) && !(await seen(TU, KU)), JSON.stringify(r.body)];
  });
  await t('a teacher cannot delete a child that has a parent link', async () => {
    const r = await rpc(T1, 'delete_child', { p_child: K1 });
    return [refused(r) && !!(await kidRow(K1)), JSON.stringify(r.body)];
  });
  await t('a parent can delete a teacher-created child once claimed', async () => {
    const PD = await mk('pd3'), kid = await claim(T1, C1, PD), before = await seen(PD, kid), r = await rpc(PD, 'delete_child', { p_child: kid });
    return [before && okr(r) && !(await kidRow(kid)), JSON.stringify(r.body)];
  });
  await t('a teacher can delete an unclaimed child', async () => {
    const kid = await mkKid(T1, { class_id: C1 }), r = await rpc(T1, 'delete_child', { p_child: kid });
    return [okr(r) && !(await kidRow(kid)), JSON.stringify(r.body)];
  });
  await t('an account without a link cannot delete anything and cannot tell a hidden child from a missing one', async () => {
    const r = await rpc(PB, 'delete_child', { p_child: K1 }), none = await rpc(PB, 'delete_child', { p_child: uuid() });
    return [refused(r) && refused(none) && JSON.stringify(r.body) === JSON.stringify(none.body) && !!(await kidRow(K1)), `${JSON.stringify(r.body)} ${JSON.stringify(none.body)}`];
  });
  await t('a tombstoned id cannot be re-inserted', async () => {
    const PT = await mk('pt'), kid = await mkKid(PT), d = await rpc(PT, 'delete_child', { p_child: kid });
    const r = await rest(PT, 'child_profiles', { method: 'POST', body: JSON.stringify({ id: kid, name: 'Back', kind: 'reader' }) });
    return [okr(d) && r.status >= 400 && !(await kidRow(kid)), String(r.status)];
  });
  await t('a direct DELETE on child_profiles is refused', async () => {
    const PD = await mk('pd4'), kid = await mkKid(PD), r = await rest(PD, `child_profiles?id=eq.${kid}`, { method: 'DELETE' });
    return [!!(await kidRow(kid)) && !((await json(r)) || []).length, String(r.status)];
  });
  await t('delete_my_account leaves a classed child in its class and deletes a class-less one', async () => {
    const DU = await mk('du'), classed = await mkKid(DU), alone = await mkKid(DU); await share(DU, classed, T1, C1);
    const r = await rpc(DU, 'delete_my_account');
    return [okr(r) && (await kidRow(classed) || {}).class_id === C1 && !(await linksOf(classed)).length && !(await kidRow(alone)), JSON.stringify(r.body)];
  });
  await t('a parent claims a teacher-created child and takes it out of the class: the teacher can no longer read or edit it', async () => {
    const PD = await mk('pd5'), kid = await claim(T1, C1, PD), saw = await seen(T1, kid), r = await rpc(PD, 'leave_class', { p_child: kid });
    const edit = await json(await rest(T1, `child_profiles?id=eq.${kid}`, { method: 'PATCH', body: JSON.stringify({ name: 'Teacher' }) }));
    return [saw && okr(r) && !(await seen(T1, kid)) && Array.isArray(edit) && !edit.length && (await one(await svc(`child_profiles?id=eq.${kid}&select=name`))).name === 'Kid', JSON.stringify(r.body)];
  });

  // Creating children, old clients and the exposed surface.
  await t('a parent and a teacher each create a child with return=representation (201)', async () => {
    const a = await rest(PB, 'child_profiles', { method: 'POST', body: JSON.stringify({ id: uuid(), name: 'P', kind: 'pre' }) });
    const tid = uuid(); kids.push(tid);
    const b = await rest(T1, 'child_profiles', { method: 'POST', body: JSON.stringify({ id: tid, name: 'T', kind: 'reader', class_id: C1 }) });
    const [ra, rb] = [(await json(a)) || [], (await json(b)) || []]; kids.push(...ra.map((x) => x.id));
    return [a.status === 201 && b.status === 201 && rb[0] && rb[0].class_id === C1, `${a.status} ${b.status}`];
  });
  await t("an old cached client's POST and PATCH (name, data, version) still work", async () => {
    const PO = await mk('po'), oid = uuid(); kids.push(oid);
    const p = await rest(PO, 'child_profiles', { method: 'POST', body: JSON.stringify({ id: oid, name: 'Old', kind: 'reader', data: { total: 1 } }) });
    const u = await rest(PO, `child_profiles?id=eq.${oid}&version=eq.1`, { method: 'PATCH', body: JSON.stringify({ name: 'Old2', data: { total: 2 }, version: 2 }) });
    const row = ((await json(u)) || [])[0];
    return [p.status === 201 && u.status === 200 && row && row.name === 'Old2' && row.version === 2, `${p.status} ${u.status}`];
  });
  await t("a creator does not get a child back after its last parent link is gone (the just-inserted read is one-shot)", async () => {
    const PX = await mk('px'), kid = await mkKid(PX);
    const patch = async () => (await json(await rest(PX, `child_profiles?id=eq.${kid}`, { method: 'PATCH', body: JSON.stringify({ name: 'Mine' }) }))) || [];
    const before = (await seen(PX, kid)) && (await patch()).length === 1; // positive control: the creator sees and edits it while linked
    await svc(`child_links?child_id=eq.${kid}`, { method: 'DELETE' });
    const after = !(await seen(PX, kid)) && (await patch()).length === 0;
    const row = await one(await svc(`child_profiles?id=eq.${kid}&select=name,owner`));
    return [before && after && !!row && row.owner === null && row.name === 'Mine', JSON.stringify(row)];
  });
  await t('the helper functions are not exposed at /rest/v1/rpc (OpenAPI lists none; calls with their real signatures answer 404/403)', async () => {
    const helpers = { is_admin: {}, current_role: {}, is_class_teacher: { p_class: C1 }, has_link: { p_child: K1 }, has_any_link: { p_child: K1 }, is_tombstoned: { p_child: K1 } };
    const doc = await json(await fetch(`${url}/rest/v1/`, { headers: { apikey: anon, Authorization: 'Bearer ' + T1.token } }));
    const paths = Object.keys((doc && doc.paths) || {});
    const listed = Object.keys(helpers).filter((n) => paths.includes('/rpc/' + n));
    const sts = []; for (const [n, a] of Object.entries(helpers)) sts.push((await rpc(T1, n, a)).status);
    const control = paths.includes('/rpc/whoami') && (await seen(T1, K1)); // the document does list exposed functions, and the policies work (they use the helpers)
    return [control && !listed.length && sts.every((x) => x === 404 || x === 403), `${listed.join()} ${sts.join()}`];
  });
  await t('anon cannot call any RPC (the same call works signed in)', async () => {
    const CT = await mk('ctl'), x = uuid();
    const calls = [['whoami', {}], ['ack_teacher', {}], ['create_invite', { p_child: x, p_kind: 'to_class' }], ['redeem_invite', { p_code: 'ZZZZZZZZ', p_class: x }], ['leave_class', { p_child: x }], ['unlink_me', { p_child: x }],
      ['delete_child', { p_child: x }], ['export_my_data', {}], ['admin_list_accounts', {}], ['admin_list_classes', {}], ['admin_invite_teacher', { p_email: 'anon@example.com' }], ['admin_revoke_invite', { p_email: 'anon@example.com' }],
      ['admin_demote_teacher', { p_user: x }], ['admin_create_class', { p_name: 'Anon' }], ['admin_rename_class', { p_class: x, p_name: 'Anon' }], ['admin_delete_class', { p_class: x }],
      ['admin_assign_teacher', { p_class: x, p_user: x }], ['admin_unassign_teacher', { p_class: x, p_user: x }], ['delete_my_account', {}]];
    const bad = []; // last, delete_my_account removes CT: its control runs after the others
    for (const [n, a] of calls) { const an = await rpc(null, n, a), au = await rpc(CT, n, a); if (!(an.status === 401 || an.status === 403) || au.status === 404) bad.push(`${n}:${an.status}/${au.status}`); }
    return [!bad.length, bad.join(' ')];
  });

  // Limits (fresh accounts, so the earlier fixtures do not count).
  await t('the 9th child without a class is refused', async () => {
    const PL = await mk('lim1'); let n = 0;
    for (let i = 0; i < 9; i++) { const r = await rest(PL, 'child_profiles', { method: 'POST', body: JSON.stringify({ id: uuid(), name: 'L' + i, kind: 'pre' }) }); if (r.status === 201) n++; }
    return [n === 8, String(n)];
  });
  await t('the 61st child in a class is refused', async () => {
    const TL = await mkRole('lim2', 'teacher', { ack: true }), CL = await mkClass('rls limit ' + stamp); await teach(CL, TL);
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: uuid(), name: 'C' + i, kind: 'pre', class_id: CL })); kids.push(...rows.map((x) => x.id));
    const a = await rest(TL, 'child_profiles', { method: 'POST', body: JSON.stringify(rows) });
    const b = await rest(TL, 'child_profiles', { method: 'POST', body: JSON.stringify({ id: uuid(), name: 'C61', kind: 'pre', class_id: CL }) });
    return [a.status === 201 && b.status >= 400, `${a.status} ${b.status}`];
  });
  await t('the 6th pending code for a child is refused', async () => {
    const PL = await mk('lim3'), kid = await mkKid(PL), rs = []; for (let i = 0; i < 6; i++) rs.push(okr(await rpc(PL, 'create_invite', { p_child: kid, p_kind: 'to_class' })));
    return [rs.slice(0, 5).every(Boolean) && !rs[5], rs.join()];
  });
  await t('a second parent link for a child is refused', async () => {
    const TL = await mkRole('lim4', 'teacher', { ack: true }), CL = await mkClass('rls link ' + stamp), P1 = await mk('lim4a'), P2 = await mk('lim4b'); await teach(CL, TL);
    const kid = await mkKid(TL, { class_id: CL }), c1 = await code(TL, kid, 'to_parent'), c2 = await code(TL, kid, 'to_parent');
    const a = await redeem(P1, c1), b = await redeem(P2, c2);
    return [okr(a) && refused(b) && (await linksOf(kid)).length === 1, `${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`];
  });
} finally {
  // Children first (owner is informational, so they outlive their creator), then classes and invitations, then the users.
  const inl = (a) => `in.(${a.join(',')})`, del = async (p) => { try { const r = await svc(p, { method: 'DELETE' }); if (!r.ok) console.log('cleanup: ' + p.split('?')[0] + ' -> ' + r.status); } catch (e) { console.log('cleanup: ' + p.split('?')[0] + ' threw'); } };
  if (made.length) await del(`child_profiles?owner=${inl(made.map((u) => u.id))}`);
  if (kids.length) { await del(`child_profiles?id=${inl(kids)}`); await del(`deleted_children?id=${inl(kids)}`); }
  if (classes.length) await del(`classes?id=${inl(classes)}`);
  if (emails.length) await del(`role_invites?email=${inl(emails.map((e) => '"' + e + '"'))}`);
  for (const u of made) await fetch(`${url}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: { apikey: service, Authorization: 'Bearer ' + service } });
}
console.log(failures ? `\n${failures} RLS check(s) FAILED` : '\nAll RLS checks passed');
process.exit(failures ? 1 : 0);
