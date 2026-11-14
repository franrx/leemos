// Parent and teacher panel inside the account block (spec: docs/superpowers/specs/2026-11-13-teachers-classes-design.md, section 6).
// Loaded with import() the first time the parents' panel is opened with a signed-in account. Everything is built with DOM calls and
// textContent: class names and child names come from other accounts and are never put into innerHTML.
//
// ctx: { doc, root, sync, t, lang, role, setRole, profiles, uuid, pct, openChild, syncNow, confirm }
//   sync        the sync client (me, ackTeacher, listProfiles, listClasses, createInvite, redeemInvite, leaveClass, deleteChild, createInClass)
//   role()      'parent' | 'teacher' | 'admin' as the app knows it (gates the teacher block); setRole(r) updates it from whoami()
//   profiles    the local profile list ({active, list}); only read here
//   pct(data)   percentage of mastered items for a server row's data
//   openChild(row, {stay})  creates (or finds) the local profile with the row's id as rid (marked via:'class' when the account is not linked to it)
//   confirm(textKey, vars, yesKey) -> Promise<boolean>
//   download(filename, obj)  saves JSON in the browser (nothing is sent); forgetRid(id) drops the local profile's rid, keeping its progress
export function createTeach(ctx) {
  const { doc, root, sync, t, lang } = ctx;
  let rows = null, classes = [], me = null; // classes: every class the account can see (for names); taught() only the ones it teaches
  let msg = null, busy = false;
  const codes = {};               // child id -> {code, expires_at} shown in its row
  const hasParent = new Set();    // roster children the server said already have a parent (no parent code for them)
  const draft = { redeem: '', classCode: '', pick: '', names: {} };
  // render() rebuilds the panel: the focused control is found again by what it is (id, or action + child/class)
  let want = null, clicked = null; // clicked: Safari does not focus a button on tap, so the tapped one is remembered
  const body = doc.createElement('div');
  const msgEl = doc.createElement('p'); msgEl.className = 'small'; msgEl.id = 'teachMsg'; msgEl.setAttribute('role', 'status'); msgEl.setAttribute('aria-live', 'polite'); // created once: a live region that is rebuilt is not announced
  root.append(body, msgEl);
  root.tabIndex = -1;
  const keyOf = (e) => {
    if (!e || !root.contains(e) || e === root) return null;
    if (e.id) return '#' + e.id;
    const d = e.dataset || {};
    return d.act ? `[data-act="${d.act}"]` + (d.child ? `[data-child="${d.child}"]` : '') + (d.class ? `[data-class="${d.class}"]` : '') : null;
  };

  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const clean = (s, n = 40) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
  const nameOf = (r) => clean(r && r.name, 20) || '?';
  const taught = () => classes.filter((c) => c.teaches);
  const className = (id) => { const c = classes.find((x) => x.id === id); return clean(c && c.name, 40) || '…'; };
  const btn = (key, onClick, { act, child, cls = 'icon-btn', name, extra } = {}) => {
    const b = el('button', cls, t(key));
    b.type = 'button';
    if (name) b.setAttribute('aria-label', t(key) + ': ' + name);
    if (act) b.dataset.act = act;
    if (child) b.dataset.child = child;
    if (extra) Object.assign(b.dataset, extra);
    b.onclick = () => { clicked = b; onClick(); };
    return b;
  };
  const heading = (key) => { const h = el('h3', 'teach-h', t(key)); return h; };
  const fieldRow = (id, labelKey, hintKey, value, onInput, onEnter) => {
    const wrap = el('div', 'teach-field');
    const lab = el('label', null, t(labelKey)); lab.htmlFor = id;
    const inp = el('input'); inp.type = 'text'; inp.id = id; inp.value = value; inp.maxLength = 20;
    inp.autocomplete = 'off'; inp.spellcheck = false;
    if (hintKey) inp.placeholder = t(hintKey);
    inp.addEventListener('input', () => onInput(inp.value));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(); } });
    wrap.append(lab, inp);
    return wrap;
  };

  const setMsg = (key, vars) => { msg = key ? { key, vars } : null; };
  // What each failure says. A wrong, used, expired or own code is ONE message; the server does not say which and neither do we.
  function errKey(e, forbidden) {
    const k = e && e.kind, m = e && e.message;
    if (k === 'offline') return 'acctNetwork';
    if (k === 'code') return 'teachBadCode';
    if (k === 'rate') return 'teachRate';
    if (k === 'auth') return 'acctExpired';
    if (k === 'http') {
      if (m === 'forbidden') return forbidden || 'acctError';
      return { orphan: 'teachOrphan', already_in_class: 'teachAlreadyClass', has_parent: 'teachHasParent', limit: 'teachLimit', not_found: 'teachGone' }[m] || 'acctError';
    }
    return 'acctError';
  }

  // One action at a time (a double tap must not send two requests). Any failure becomes a message; the lists reload either way.
  async function act(fn, forbidden) {
    if (busy) return;
    busy = true; setMsg(null); want = keyOf(clicked) || keyOf(doc.activeElement); clicked = null; render();
    try { await fn(); }
    catch (e) {
      const key = errKey(e, forbidden);
      setMsg(key);
      if (key === 'teachGone') await load();
    } finally { busy = false; render(); want = null; }
  }

  async function load() {
    try {
      const m = await sync.me();
      me = m || null;
      if (ctx.setRole) ctx.setRole(m && m.role);
      const [r, c] = await Promise.all([sync.listProfiles(), sync.listClasses()]);
      rows = r; classes = c;
    } catch (e) {
      if (!rows) { rows = []; classes = []; }
      setMsg(errKey(e));
    }
  }
  async function refresh() { await load(); render(); }

  // ---------- parent block ----------
  function codeBox(r, kind) {
    const c = codes[r.id];
    if (!c) return null;
    const box = el('div', 'teach-code');
    box.append(el('p', 'small', t('teachCodeFor', { n: nameOf(r) })));
    const big = el('p', 'teach-code-big', c.code); big.dataset.code = '1'; big.setAttribute('aria-hidden', 'true'); // read letter by letter through the hidden copy
    const spoken = el('span', 'sr-only', c.code.split('').join(' '));
    const day = new Date(c.expires_at).toLocaleDateString(lang() === 'ca' ? 'ca' : 'es', { day: 'numeric', month: 'long' });
    const exp = el('p', 'small', t('teachCodeExp', { d: day })); exp.dataset.expiry = '1';
    box.append(big, spoken, exp, el('p', 'small', t(kind === 'to_parent' ? 'teachCodeParent' : 'teachCodeTeacher')));
    box.append(btn('teachCopy', () => copy(c.code), { act: 'copy', child: r.id, name: nameOf(r) }));
    return box;
  }
  async function copy(code) {
    let ok = false;
    try { const nav = ctx.nav || (typeof navigator !== 'undefined' ? navigator : null); if (nav && nav.clipboard) { await nav.clipboard.writeText(code); ok = true; } } catch (e) { /* falls to the manual message */ }
    setMsg(ok ? 'teachCopied' : 'teachCopyFail'); render();
  }

  const share = (r) => act(async () => {
    if (!await ctx.confirm('teachShareAsk', { n: nameOf(r) }, 'teachShareYes')) return;
    const inv = await sync.createInvite(r.id, 'to_class');
    codes[r.id] = { code: inv.code, expires_at: inv.expires_at };
  });
  const leaveAsParent = (r) => act(async () => {
    if (!await ctx.confirm('teachLeaveAskParent', { n: nameOf(r), c: className(r.class_id) }, 'teachTakeYes')) return;
    await sync.leaveClass(r.id);
    delete codes[r.id];
    await load();
  });

  const isLocal = (r) => ctx.profiles.list.some((p) => p.rid === r.id);

  function parentRow(r) {
    const li = el('div', 'teach-row'); li.dataset.child = r.id;
    const top = el('div', 'teach-top');
    top.append(el('strong', 'teach-name', nameOf(r)));
    if (r.class_id) top.append(el('span', 'chip', t('teachInClass', { c: className(r.class_id) })));
    li.append(top);
    const acts = el('div', 'teach-acts');
    if (r.class_id) acts.append(btn('teachLeave', () => leaveAsParent(r), { act: 'leave', child: r.id, name: nameOf(r) }));
    else acts.append(btn('teachShare', () => share(r), { act: 'share', child: r.id, name: nameOf(r) }));
    if (!isLocal(r)) acts.append(btn('teachOpen', () => open(r), { act: 'open', child: r.id, name: nameOf(r), extra: { own: '1' } }));
    acts.append(btn('teachDownload', () => download(r), { act: 'download', child: r.id, name: nameOf(r) }));
    acts.append(btn('teachWipe', () => wipe(r), { act: 'wipe', child: r.id, name: nameOf(r), cls: 'icon-btn danger' }));
    li.append(acts);
    const cb = codeBox(r, 'to_class'); if (cb) li.append(cb);
    return li;
  }

  const redeemParent = () => act(async () => {
    const code = draft.redeem.trim();
    if (!code) { setMsg('teachNeedCode'); return; }
    const res = await sync.redeemInvite(code, null);
    draft.redeem = '';
    await load();
    const row = rows.find((x) => x.id === res.child_id);
    if (row && row.linked && !isLocal(row)) ctx.openChild(row, { stay: true }); // the account's own child: on this device too
    setMsg('teachRedeemedParent');
  }, 'teachBadCode');

  function parentBlock() {
    const box = el('section', 'teach-block'); box.dataset.block = 'parent';
    box.append(heading('teachMine'));
    const mine = rows.filter((r) => r.linked);
    if (!mine.length) box.append(el('p', 'small', t('teachNoKids')));
    mine.forEach((r) => box.append(parentRow(r)));
    ctx.profiles.list.filter((p) => p.noSync && p.via !== 'class').forEach((p) => { // deleted from the account: kept here, off the account until the adult says so
      const li = el('div', 'teach-row'); li.dataset.local = p.id;
      const top = el('div', 'teach-top'); top.append(el('strong', 'teach-name', clean(p.name, 20) || '?'), el('span', 'chip', t('teachLocalOnly')));
      li.append(top);
      const acts = el('div', 'teach-acts');
      acts.append(btn('teachResync', () => act(async () => { ctx.resync(p.id); await load(); }), { act: 'resync', child: p.id, name: clean(p.name, 20) }));
      li.append(acts); box.append(li);
    });
    const form = el('div', 'teach-form');
    form.append(fieldRow('teachCode', 'teachHaveCode', 'teachCodeHint', draft.redeem, (v) => { draft.redeem = v; }, redeemParent));
    const b = btn('teachRedeem', redeemParent); b.id = 'teachRedeem'; b.disabled = busy;
    form.append(b);
    box.append(form);
    return box;
  }

  // ---------- teacher block ----------
  const open = (r) => act(async () => { ctx.openChild(r); });
  const ackAccept = () => act(async () => { await sync.ackTeacher(); await load(); });

  const takeOut = (r) => act(async () => {
    if (!await ctx.confirm('teachTakeAsk', { n: nameOf(r), c: className(r.class_id) }, 'teachTakeYes')) return;
    await sync.leaveClass(r.id);
    delete codes[r.id];
    await load();
  });
  const remove = (r) => act(async () => {
    if (!await ctx.confirm('teachDeleteAsk', { n: nameOf(r) }, 'teachDeleteYes')) return;
    await sync.deleteChild(r.id);
    if (ctx.forgetRid) ctx.forgetRid(r.id);
    delete codes[r.id];
    await load();
  }, 'teachDelForbidden');
  // A family deletes its child's data from the server (the local progress stays on this device).
  const wipe = (r) => act(async () => {
    if (!await ctx.confirm(r.class_id ? 'teachWipeAskClass' : 'teachWipeAsk', { n: nameOf(r), c: className(r.class_id) }, 'teachWipeYes')) return;
    await sync.deleteChild(r.id);
    if (ctx.forgetRid) ctx.forgetRid(r.id);
    delete codes[r.id];
    await load();
    setMsg('teachWiped');
  }, 'teachDelForbidden');
  // One child's data, taken from the account's export (never from another account's rows).
  const download = (r) => act(async () => {
    const d = await sync.exportMyData();
    const c = (d && Array.isArray(d.children) ? d.children : []).find((x) => x && x.id === r.id);
    if (!c) throw { kind: 'http', message: 'not_found' };
    ctx.download('leemos-nino-' + String(r.id).slice(0, 8) + '.json', { exported_at: new Date().toISOString(), child: c });
  });
  const parentCode = (r) => act(async () => {
    try { const inv = await sync.createInvite(r.id, 'to_parent'); codes[r.id] = { code: inv.code, expires_at: inv.expires_at }; }
    catch (e) { if (e && e.message === 'has_parent') hasParent.add(r.id); throw e; } // somebody already claimed it: no code, and no button next time
  });

  function rosterRow(r) {
    const li = el('div', 'teach-row'); li.dataset.child = r.id;
    const top = el('div', 'teach-top');
    top.append(el('strong', 'teach-name', nameOf(r)));
    const p = Math.max(0, Math.min(100, Number(ctx.pct(r.data)) || 0));
    const bar = el('div', 'teach-bar'); bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', t('teachProgress', { n: nameOf(r), p }));
    const fill = el('i'); fill.style.width = p + '%'; bar.append(fill);
    top.append(bar);
    li.append(top);
    const acts = el('div', 'teach-acts');
    const nm = nameOf(r);
    acts.append(btn('teachOpen', () => open(r), { act: 'open', child: r.id, name: nm }));
    if (!r.linked && !r.has_parent && !hasParent.has(r.id)) acts.append(btn('teachParentCode', () => parentCode(r), { act: 'parentcode', child: r.id, name: nm }));
    acts.append(btn('teachDownload', () => download(r), { act: 'download', child: r.id, name: nm }));
    acts.append(btn('teachTake', () => takeOut(r), { act: 'leave', child: r.id, name: nm }));
    acts.append(btn('teachDelete', () => remove(r), { act: 'delete', child: r.id, name: nm, cls: 'icon-btn danger' }));
    li.append(acts);
    const cb = codeBox(r, 'to_parent'); if (cb) li.append(cb);
    return li;
  }

  const redeemClass = () => act(async () => {
    const code = draft.classCode.trim();
    if (!code) { setMsg('teachNeedCode'); return; }
    const mine = taught();
    const cls = draft.pick && mine.some((c) => c.id === draft.pick) ? draft.pick : mine[0] && mine[0].id;
    const res = await sync.redeemInvite(code, cls);
    draft.classCode = '';
    await load();
    const row = rows.find((x) => x.id === res.child_id);
    setMsg(row && row.linked ? 'teachRedeemedParent' : 'teachRedeemedClass');
  }, 'teachBadCode');

  const newChild = (c) => act(async () => {
    const name = clean(draft.names[c.id], 20);
    if (!name) { setMsg('teachNeedName'); return; }
    const id = ctx.uuid();
    // the row is inserted with its class first: the ordinary sync would create it class-less (and as the teacher's own child)
    const row = await sync.createInClass({ id, name, kind: 'reader', classId: c.id, data: {} });
    draft.names[c.id] = '';
    ctx.openChild({ id, name, kind: 'reader', data: (row && row.data) || {}, linked: false, class_id: c.id }, { stay: true });
    await load();
    if (ctx.syncNow) ctx.syncNow(); // then the normal sync, like any other profile
  }, 'teachGone');

  function classBlock(c) {
    const sec = el('div', 'teach-class'); sec.dataset.class = c.id;
    sec.append(el('h4', 'teach-ch', clean(c.name, 40)));
    const roster = el('div', 'teach-roster'); roster.dataset.roster = c.id;
    const kids = rows.filter((r) => r.class_id === c.id);
    if (!kids.length) roster.append(el('p', 'small', t('teachEmpty')));
    kids.forEach((r) => roster.append(rosterRow(r)));
    sec.append(roster);
    const form = el('div', 'teach-form');
    form.append(fieldRow('teachNewName-' + c.id, 'teachNewName', null, draft.names[c.id] || '', (v) => { draft.names[c.id] = v; }, () => newChild(c)));
    const b = btn('teachNewChild', () => newChild(c), { act: 'newchild', extra: { class: c.id } }); b.disabled = busy;
    form.append(b);
    sec.append(form);
    return sec;
  }

  function teacherBlock() {
    const box = el('section', 'teach-block'); box.dataset.block = 'teacher';
    box.append(heading('teachClasses'));
    if (!me || !me.teacher_ack_at) { // until acknowledged the database gives no class access either: only the statement is shown
      const ack = el('div', 'teach-ack'); ack.id = 'teachAck';
      ack.append(el('strong', null, t('teachAckTitle')), el('p', null, t('teachAckText')));
      const b = btn('teachAckBtn', ackAccept, { cls: 'icon-btn' }); b.id = 'teachAckBtn'; b.disabled = busy;
      ack.append(b);
      box.append(ack);
      return box;
    }
    const mine = taught();
    if (!mine.length) { box.append(el('p', 'small', t('teachNoClasses'))); return box; }
    mine.forEach((c) => box.append(classBlock(c)));
    const form = el('div', 'teach-form');
    form.append(el('strong', null, t('teachEnterCode')));
    const pickWrap = el('div', 'teach-field');
    const lab = el('label', null, t('teachPickClass')); lab.htmlFor = 'teachPick';
    const sel = el('select'); sel.id = 'teachPick';
    mine.forEach((c) => { const o = el('option', null, clean(c.name, 40)); o.value = c.id; sel.append(o); });
    if (draft.pick && mine.some((c) => c.id === draft.pick)) sel.value = draft.pick;
    sel.addEventListener('change', () => { draft.pick = sel.value; });
    pickWrap.append(lab, sel);
    form.append(pickWrap);
    form.append(fieldRow('teachClassCode', 'teachHaveCode', 'teachCodeHint', draft.classCode, (v) => { draft.classCode = v; }, redeemClass));
    const b = btn('teachRedeem', redeemClass); b.id = 'teachClassRedeem'; b.disabled = busy;
    form.append(b);
    box.append(form);
    return box;
  }

  // ---------- render ----------
  function render() {
    if (!sync.userId()) { // signed out: nothing of an account stays on the screen (or in memory)
      rows = null; classes = []; me = null; msg = null; hasParent.clear();
      Object.keys(codes).forEach((k) => delete codes[k]);
      body.textContent = ''; msgEl.textContent = ''; root.hidden = true;
      return;
    }
    if (!rows) return;
    const key = want || keyOf(doc.activeElement);
    body.textContent = '';
    body.append(parentBlock());
    if (ctx.role() === 'teacher') body.append(teacherBlock());
    const text = msg ? t(msg.key, msg.vars) : '';
    if (msgEl.textContent !== text) msgEl.textContent = text;
    root.hidden = false;
    if (key) { let f = null; try { f = root.querySelector(key); } catch (e) { /* a key that is not a selector */ } if (f && !f.disabled) f.focus(); else if (want && !busy) root.focus(); } // the control is gone (left, deleted): the panel itself
  }

  return { render, refresh };
}
