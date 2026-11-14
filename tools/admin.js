// Admin page: teachers, classes and assignments. The admin sees counts, never a child's name. Every server string goes in with textContent.
// mountAdmin(root, sync, t) is pure DOM work (testable in jsdom); the page bootstrap at the end signs in and loads src/sync.js.
export const TEXT = {
  notAdmin: 'Esta cuenta no es de administrador',
  teachers: 'Profesores y administradores',
  pending: 'Invitaciones pendientes',
  none: 'Ninguno',
  inviteLabel: 'Email del profesor a invitar',
  invite: 'Invitar',
  revoke: 'Revocar invitación',
  demote: 'Quitar rol de profesor',
  expires: 'caduca',
  classes: 'Clases',
  newClass: 'Nombre de la nueva clase',
  create: 'Crear clase',
  rename: 'Renombrar',
  renameLabel: 'Nuevo nombre de la clase',
  del: 'Borrar clase',
  children: 'niños',
  unclaimed: 'sin familia',
  classTeachers: 'Profesores de la clase',
  assign: 'Asignar profesor',
  assignLabel: 'Profesor a asignar',
  unassign: 'Quitar de la clase',
  warnDemote: 'Estas clases se quedarían sin profesor y con niños sin familia:',
  confirmDemote: 'Quitar el rol igualmente',
  cancel: 'Cancelar',
  orphans: 'No se puede borrar: hay niños sin familia en la clase. Cantidad:',
  badInput: 'Dato no válido. Revísalo e inténtalo de nuevo.',
  failed: 'No se pudo completar la acción. Inténtalo de nuevo.',
  lastAdmin: 'No se puede: es el último administrador.',
  empty: 'Sin configuración de sincronización: no se hace ninguna petición.',
  email: 'Email',
  sendCode: 'Enviar código',
  code: 'Código',
  verify: 'Entrar',
  codeBad: 'Código incorrecto o caducado.',
  signOut: 'Salir',
};
export const t = (k) => TEXT[k] || k;

export async function mountAdmin(root, sync, tr = t) {
  const doc = root.ownerDocument;
  const el = (tag, props = {}, ...kids) => {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); }
    for (const c of kids) if (c) n.append(c);
    return n;
  };
  const btn = (label, onclick, extra = {}) => el('button', { type: 'button', text: label, 'aria-label': extra.aria || label, onclick, ...(extra.cls ? { class: extra.cls } : {}) });
  const field = (label, ph) => { const i = el('input', { type: 'text', 'aria-label': label, placeholder: ph || label }); return i; };
  const status = el('p', { role: 'status', 'aria-live': 'polite', id: 'adminStatus' });
  let panel = null; // the open demote warning, if any

  const msgFor = (j) => {
    const e = j && j.error;
    if (e === 'orphans') return `${tr('orphans')} ${j.count}`;
    if (e === 'bad_input') return tr('badInput');
    if (e === 'last_admin') return tr('lastAdmin');
    return tr('failed');
  };
  // Runs one admin RPC. Returns true when it succeeded; otherwise shows the message and returns false.
  async function act(name, args) {
    let j;
    try { j = await sync.rpc(name, args); } catch (e) { status.textContent = tr('failed'); return false; }
    if (j && j.error) { status.textContent = msgFor(j); return false; }
    status.textContent = '';
    return true;
  }
  const actAndRefresh = async (name, args) => { if (await act(name, args)) await load(); };

  let who;
  try { who = await sync.me(); } catch (e) { who = null; }
  if (!who || who.role !== 'admin') { root.replaceChildren(el('p', { text: tr('notAdmin') })); return; }

  async function load() {
    let a, c;
    try { a = await sync.rpc('admin_list_accounts'); c = await sync.rpc('admin_list_classes'); } catch (e) { status.textContent = tr('failed'); return; }
    if ((a && a.error) || (c && c.error)) { status.textContent = tr('failed'); return; }
    render(a, c);
  }

  function demote(acc, classes) {
    const left = classes.filter((k) => k.unclaimed > 0 && k.teachers.length === 1 && k.teachers[0].user_id === acc.user_id);
    if (!left.length) return actAndRefresh('admin_demote_teacher', { p_user: acc.user_id });
    const list = el('ul');
    for (const k of left) list.append(el('li', { text: `${k.name}: ${k.unclaimed} ${tr('unclaimed')}` }));
    panel = el('div', { role: 'alertdialog', 'aria-label': tr('warnDemote'), class: 'warn', id: 'demoteWarn' },
      el('p', { text: `${acc.email}. ${tr('warnDemote')}` }), list,
      el('div', { class: 'row' },
        btn(tr('confirmDemote'), () => { panel = null; actAndRefresh('admin_demote_teacher', { p_user: acc.user_id }); }, { cls: 'primary' }),
        btn(tr('cancel'), () => { panel.remove(); panel = null; })));
    root.append(panel);
    panel.querySelector('button').focus();
  }

  function render(a, c) {
    const teachers = a.accounts.filter((x) => x.role === 'teacher');
    const tl = el('ul');
    for (const acc of a.accounts) {
      const li = el('li', {}, el('span', { text: `${acc.email} (${acc.role}) ` }));
      if (acc.role === 'teacher') li.append(btn(tr('demote'), () => demote(acc, c.classes), { aria: `${tr('demote')}: ${acc.email}` }));
      tl.append(li);
    }
    if (!a.accounts.length) tl.append(el('li', { text: tr('none') }));
    const pl = el('ul');
    for (const iv of a.invites) {
      pl.append(el('li', {}, el('span', { text: `${iv.email} (${tr('expires')} ${String(iv.expires_at).slice(0, 10)}) ` }),
        btn(tr('revoke'), () => actAndRefresh('admin_revoke_invite', { p_email: iv.email }), { aria: `${tr('revoke')}: ${iv.email}` })));
    }
    if (!a.invites.length) pl.append(el('li', { text: tr('none') }));
    const inv = field(tr('inviteLabel'), 'profe@ejemplo.com');
    inv.type = 'email';
    const secT = el('section', {}, el('h2', { text: tr('teachers') }), tl, el('h3', { text: tr('pending') }), pl,
      el('div', { class: 'row' }, inv, btn(tr('invite'), () => { const v = inv.value.trim(); if (v) actAndRefresh('admin_invite_teacher', { p_email: v }); })));

    const nc = field(tr('newClass'));
    const secC = el('section', {}, el('h2', { text: tr('classes') }));
    for (const k of c.classes) {
      const rn = field(tr('renameLabel'));
      const tUl = el('ul');
      for (const tt of k.teachers) tUl.append(el('li', {}, el('span', { text: tt.email + ' ' }), btn(tr('unassign'), () => actAndRefresh('admin_unassign_teacher', { p_class: k.id, p_user: tt.user_id }), { aria: `${tr('unassign')}: ${tt.email}` })));
      if (!k.teachers.length) tUl.append(el('li', { text: tr('none') }));
      const free = teachers.filter((x) => !k.teachers.some((y) => y.user_id === x.user_id));
      const sel = el('select', { 'aria-label': tr('assignLabel') });
      for (const x of free) sel.append(el('option', { value: x.user_id, text: x.email }));
      const row = el('div', { class: 'row' }, rn, btn(tr('rename'), () => { const v = rn.value.trim(); if (v) actAndRefresh('admin_rename_class', { p_class: k.id, p_name: v }); }, { aria: `${tr('rename')}: ${k.name}` }), btn(tr('del'), () => actAndRefresh('admin_delete_class', { p_class: k.id }), { aria: `${tr('del')}: ${k.name}` }));
      const assignRow = free.length ? el('div', { class: 'row' }, sel, btn(tr('assign'), () => { if (sel.value) actAndRefresh('admin_assign_teacher', { p_class: k.id, p_user: sel.value }); }, { aria: `${tr('assign')}: ${k.name}` })) : null;
      secC.append(el('article', { class: 'class' }, el('h3', { text: k.name }), el('p', { class: 'muted', text: `${k.children} ${tr('children')}, ${k.unclaimed} ${tr('unclaimed')}` }), row, el('h4', { text: tr('classTeachers') }), tUl, assignRow));
    }
    secC.append(el('div', { class: 'row' }, nc, btn(tr('create'), () => { const v = nc.value.trim(); if (v) actAndRefresh('admin_create_class', { p_name: v }); })));
    root.replaceChildren(status, secT, secC);
  }
  await load();
}

// ---------- page bootstrap (browser only) ----------
async function boot(doc) {
  const root = doc.getElementById('app');
  const say = (text) => root.replaceChildren(Object.assign(doc.createElement('p'), { textContent: text }));
  let cfg = {};
  try { cfg = await (await fetch('../src/data/sync.config.json')).json(); } catch (e) { cfg = {}; }
  if (!cfg.url || !cfg.anonKey) { say(t('empty')); return; }
  const { createSync } = await import('../src/sync.js');
  const sync = createSync({ url: cfg.url, anonKey: cfg.anonKey });
  const form = () => {
    const mail = Object.assign(doc.createElement('input'), { type: 'email', autocomplete: 'email' });
    mail.setAttribute('aria-label', t('email'));
    const code = Object.assign(doc.createElement('input'), { type: 'text', inputMode: 'numeric', autocomplete: 'one-time-code', hidden: true });
    code.setAttribute('aria-label', t('code'));
    const go = Object.assign(doc.createElement('button'), { type: 'button', textContent: t('sendCode') });
    const msg = Object.assign(doc.createElement('p'), {}); msg.setAttribute('role', 'status');
    go.addEventListener('click', async () => {
      try {
        if (code.hidden) { await sync.requestCode(mail.value.trim()); code.hidden = false; go.textContent = t('verify'); code.focus(); }
        else { await sync.verifyCode(mail.value.trim(), code.value); start(); }
      } catch (e) { msg.textContent = e && e.kind === 'code' ? t('codeBad') : t('failed'); }
    });
    root.replaceChildren(mail, code, go, msg);
  };
  const start = async () => {
    if (!(await sync.session().catch(() => null))) return form();
    await mountAdmin(root, sync, t);
    const out = Object.assign(doc.createElement('button'), { type: 'button', textContent: t('signOut') });
    out.addEventListener('click', async () => { await sync.signOut(); form(); });
    root.append(out);
  };
  start();
}
if (typeof document !== 'undefined' && document.getElementById('app')) boot(document);
