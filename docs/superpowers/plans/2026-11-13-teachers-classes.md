# Teachers, classes and shared children Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add teachers, named classes and children shared between teacher and parents, where an account sees only the children it is linked to, enforced by the database.

**Architecture:** One new migration adds link tables and `security definer` helper functions (in a non-exposed `private` schema) and rewrites the `child_profiles` RLS from them; every write outside `child_profiles` goes through RPCs that return `jsonb` (`{error:'…'}` for expected failures, never a `RAISE` where an attempt must be recorded). `sync.js` keeps talking to PostgREST directly and gains `rpc()` plus thin wrappers; the new UI is `src/teach.js`, loaded with `import()`; the admin page is `tools/admin.html` + `tools/admin.js`.

**Tech Stack:** Postgres/Supabase RLS and PL/pgSQL, vanilla JS ES modules (no build), jsdom + Node test scripts.

**Spec:** `docs/superpowers/specs/2026-11-13-teachers-classes-design.md` (approved by Fran). Executors read it with this plan; section numbers below (§n) refer to it. Request: `docs/inbox/teachers-classes-request.md`.

## Global Constraints
- No frameworks or bundler. `src/app.js` has **no static `import`** (the smoke test evaluates it as text); new code is loaded with `import()`.
- No `service_role` anywhere in git (`tests/migration.mjs` checks). Only the project URL and the anon key may be committed.
- With `src/data/sync.config.json` empty there is **no request to third parties** and none of the new UI is visible.
- The existing migration `20261017000000_child_profiles.sql` is **not edited**. New file: `supabase/migrations/20261113000000_teachers_classes.sql`.
- Every new table: `enable row level security`, then `revoke all … from anon, authenticated`, then only the `select` grants of §3. Every `security definer` function: `set search_path = ''`, fully-qualified names, `revoke execute … from public, anon`, explicit grant to `authenticated` only for the RPCs in `public`. Helpers live in schema `private`.
- Limits (§2): 8 children without class per owner, 60 per class, 1 parent link per child, 5 pending codes per child, `data` < 200000 bytes. Codes: 8 chars from an alphabet without `0O1Il`, single use, 7 days, stored as SHA-256 hash, shown once; 10 failed redeems per user per hour; `role_invites` expire after 30 days.
- Texts in `src/data/i18n.es.json` **and** `i18n.ca.json` with the same keys (`npm test` checks), `data-i` / `t()`.
- Touch targets ≥ 44 px, tokens in `:root` with a dark variant, `prefers-reduced-motion` respected (CLAUDE.md).
- If the `SHELL` list in `sw.js` changes, raise `VERSION` (now `leemos-v25`).
- `npm test` stays green after every task. Commit after each task. Work in Spanish with Fran, surgical edits.

## Review Focus
1. A parent or teacher creating a child with `Prefer: return=representation` (what `sync.js` always sends) must not get a 403; an old cached client's POST/PATCH must keep working (Task 1, Task 2, Task 3).
2. A wrong, used, expired or foreign code must give the **same** `{error:'invalid'}`; the 11th wrong attempt in an hour gives `rate`, which only works if the attempt is recorded, not rolled back (Task 1, Task 3).
3. Signing out on a tablet must remove only the `via:'class'` profiles and their local state, never a parent's own children, and must not lose unsent progress silently (Task 5).
4. A teacher signing in with a local profile must never be offered a class child as a link candidate, and class children must not be auto-added (Task 4).
5. A child removed from a class or deleted by someone else must keep the local data and drop the `rid` (`revoked`), never delete progress on the device (Task 3).

---

## File structure
- `supabase/migrations/20261113000000_teachers_classes.sql` (new): schema, helpers, policies, triggers, RPCs.
- `tests/migration.mjs` (modify): text checks of the new SQL (the old file's checks stay).
- `scripts/check-rls.mjs` (extend): real-project checks, run by Fran.
- `tests/lib/fake-supabase.mjs` (extend): roles, classes, links, codes, RPC endpoint.
- `src/sync.js` (modify): `rpc`, wrappers, `linked`/`class_id`, `revoked`, `kind` push.
- `src/app.js` (modify): `whoami` after sign-in, linked-only linking, `via` marker, purge on sign-out; loads `src/teach.js`.
- `src/teach.js` (new): parent and teacher panels (`createTeach(ctx)`).
- `index.html`, `src/styles.css`, `src/data/i18n.{es,ca}.json` (modify).
- `tools/admin.html`, `tools/admin.js` (new).
- `privacy.html` (new), export/delete UI in `teach.js`.
- `sw.js` (modify), `CLAUDE.md` (modify, last task).

---

### Task 1: `check-rls.mjs` cases first, and a local Supabase to run them

**Files:**
- Modify: `scripts/check-rls.mjs`, `package.json`, `.gitignore` (only if `supabase/.temp` or `supabase/.branches` are not already ignored)
- Create: `supabase/config.toml` (from `npx supabase@<pinned> init`, committed: project id `leemos`, defaults otherwise), `scripts/test-rls-local.mjs`

**Interfaces:**
- Consumes: nothing yet. It is written **first** from §9 as the executable spec; it cannot run until Fran applies the migration of Tasks 2 and 3 to a Supabase project, and the failing-first run is the local one below (never production). This task is done when the file parses, covers every case below and `scripts/test-rls-local.mjs` is in place.
- Produces: `npm run test:rls` → `node scripts/test-rls-local.mjs`: checks Docker is running (clear message in Spanish if not), starts the stack with `npx --yes supabase@<pinned version> start` (pin the version that `supabase init` was run with, in one constant), applies every file of `supabase/migrations` with `db reset`, reads the local URL, anon key and service key from `supabase status -o env` **at runtime and only into the child process environment** (never written to disk or git: `tests/migration.mjs` forbids `service_role`), runs `node scripts/check-rls.mjs` with them, stops the stack unless `--keep` is passed, and exits with check-rls's code. It is **not** part of `npm test` (needs Docker and downloads images); it is how the factory's verify can run it (`factory verify` stays `npm test`; a human or the QA run adds `npm run test:rls`). The helper `mk(tag)` already creates a user and signs in; add `mkRole(tag, role, {ack})` that creates the user, then (with the service key, as the script already does) sets `accounts.role` / `teacher_ack_at` through the REST API, and `rpc(user, name, args)`.

- [ ] **Step 1: Add every case of §9 `check-rls`** (an expired code is produced with the service key by moving `invites.expires_at` into the past; the cleanup in `finally` deletes the users, classes and invitations it created) as one `check('<name>', …)` line each, keeping the existing ones except "an account is limited to 8 profiles" (still valid for class-less children) and adapting the cleanup to also delete the new users. The cases: parent does not see another family's child; teacher sees only own classes' children; teacher of another class sees nothing; teacher without acknowledgement sees nothing; a parent cannot update `accounts` nor call any `admin_*` nor `claim` with someone else's or an expired invitation; invited email becomes teacher on `whoami` and the invite is gone; `admin_list_accounts` returns no parent email; admin cannot read any child; used, expired, wrong and own codes give the same `{error:'invalid'}`; two concurrent `redeem_invite` calls (`Promise.all`) → exactly one `ok`; the 11th wrong code in an hour gives `rate`; code void after the creator lost the link or the class; demoted teacher loses access; demoting the last teacher of a class holding an unclaimed child succeeds and the child survives; `leave_class` works for the parent and is refused (`orphan`) for an unclaimed child; `admin_delete_class` refused with orphans; delete rules (teacher cannot delete a child with a parent link; parent can delete a claimed teacher-created child; teacher can delete an unclaimed one; stranger cannot delete); teacher cannot create a `to_parent` code for a child with a parent; a parent and a teacher each create a child with `Prefer: return=representation` (201); tombstoned id cannot be re-inserted; direct `DELETE` on `child_profiles` is refused; helper functions are not callable at `/rest/v1/rpc/is_class_teacher` (404/403); `anon` cannot call any RPC; `delete_my_account` for a classed child leaves it in the class and for a class-less one deletes it; **teacher creates a child, a parent claims it with a `to_parent` code and takes it out of the class: the teacher can no longer read or edit it**; a teacher removed from a class (`admin_unassign_teacher`) loses access at once; `whoami` with no invitation leaves the role `parent`; an old cached client's POST and PATCH (`name, data, version`, `Prefer: return=representation`) still work; a code cannot be redeemed by its creator in either direction; the limits hold (9th class-less child refused, 61st child in a class refused, 6th pending code refused, a second parent link refused).
- [ ] **Step 2: Run `node --check scripts/check-rls.mjs scripts/test-rls-local.mjs`.** Expected: no output. Then `npm run test:rls` once against the *current* migrations only: Expected: the new cases FAIL (the failing-first run) while the pre-existing ones PASS. If Docker is not running the script must say so and exit 2, which is also accepted for this step.
- [ ] **Step 3: Commit** `test(rls): check-rls cases and a local Supabase runner`.

### Task 2: Migration: schema, helpers, RLS, triggers

**Files:**
- Create: `supabase/migrations/20261113000000_teachers_classes.sql`
- Modify: `tests/migration.mjs`

**Interfaces:**
- Produces (SQL): tables `accounts, classes, class_teachers, child_links, invites, invite_attempts, deleted_children, role_invites, admin_log`; columns `child_profiles.class_id`, `child_profiles.owner` nullable `on delete set null`; helpers `private.is_admin() boolean`, `private.current_role() text`, `private.is_class_teacher(uuid) boolean`, `private.has_link(uuid) boolean`, `private.is_tombstoned(uuid) boolean`, `private.has_any_link(uuid) boolean` (any parent link at all, regardless of whose; needed because under RLS a plain subquery on `child_links` only sees the caller's own rows); trigger on `auth.users` inserting an `accounts` row (role `parent`); trigger giving a class-less child's creator a `child_links` row; limit triggers.

- [ ] **Step 1: Extend `tests/migration.mjs` (failing first)** to read `20261113000000_teachers_classes.sql` and assert, with the exact check names it will print: RLS enabled on each of the 9 new tables; `revoke all on public.<t> from anon, authenticated` for each; no `grant` at all on `invites, invite_attempts, deleted_children, role_invites, admin_log`; only `select` granted on `accounts, classes, class_teachers, child_links`; every `security definer` function has `set search_path = ''`; every `revoke execute … from public, anon` appears once per function; `revoke update, delete on public.child_profiles from authenticated` appears before `grant update (name, data, version, kind)`, no `grant … delete on public.child_profiles`, `private.has_any_link` is `security definer` and is the one the select policy uses, and the two triggers that write `child_links` / `accounts` are `security definer`; no `service_role`; dollar-quote count even; the old file's checks unchanged.
- [ ] **Step 2: Run `node tests/migration.mjs`.** Expected: FAIL (new file missing).
- [ ] **Step 3: Write the SQL migration**, in one transaction, in this order: tables (FKs exactly as §2); backfill `accounts` for every `auth.users` row and `child_links` from `child_profiles.owner`; `alter table child_profiles alter column owner drop not null`, replace its FK with `on delete set null`, add `class_id uuid references classes on delete set null`; schema `private` and the five helpers (`is_class_teacher` also requires role `teacher` **and** `teacher_ack_at is not null`); drop the old policies and the old `child_profiles_limit` trigger; new policies exactly as §3 (select/update on row columns `has_link(id) or is_class_teacher(class_id) or (owner = auth.uid() and class_id is null and not private.has_any_link(id))`; insert `owner = auth.uid()` and (`class_id is null` or `is_class_teacher(class_id)`) and `not is_tombstoned(id)`); grants of §3, **starting with an explicit `revoke update, delete on public.child_profiles from authenticated`** (the old migration's grants stay live otherwise) followed by `grant select, insert on …` and `grant update (name, data, version, kind)`; `after insert` trigger (**`security definer`**, as is the `auth.users` trigger, otherwise the link write is refused by the new grants) adding the creator's link when `class_id is null`; `security definer` limit triggers (8 class-less per owner with the advisory lock; 60 per class on `before insert or update of class_id` with an advisory lock per class; 1 parent link per child); `accounts` trigger on `auth.users`.
- [ ] **Step 4: Run `node tests/migration.mjs`, `npm test` and `npm run test:rls`.** Expected: all PASS except the check-rls cases that need the RPCs of Task 3 (list them in the commit body).
- [ ] **Step 5: Commit** `feat(db): teachers, classes and link-based RLS migration`.

### Task 3: Migration: RPCs

**Files:**
- Modify: `supabase/migrations/20261113000000_teachers_classes.sql`, `tests/migration.mjs`

**Interfaces:**
- Produces (all in `public`, `security definer`, return `jsonb`; expected failures are `{"error":"<code>"}`, success is `{"ok":true,…}`):
  - `whoami()` volatile: calls `private.claim_role()` (matches a pending, unexpired `role_invites` row to the lower-cased verified JWT email, sets `teacher`, deletes the invite, writes `admin_log`) and returns `{role, teacher_ack_at}`.
  - `ack_teacher()`; `create_invite(p_child uuid, p_kind text)` → `{code, expires_at}`; `redeem_invite(p_code text, p_class uuid)` → `{ok:true, child_id}` or `{error:'invalid'|'rate'|'already_in_class'|'forbidden'|'limit'}`.
  - `leave_class(p_child uuid)`, `unlink_me(p_child uuid)`, `delete_child(p_child uuid)`, `export_my_data()`, `delete_my_account()`.
  - `admin_list_accounts()`, `admin_list_classes()`, `admin_invite_teacher(p_email text)`, `admin_revoke_invite(p_email text)`, `admin_demote_teacher(p_user uuid)`, `admin_create_class(p_name text)`, `admin_rename_class(p_class uuid, p_name text)`, `admin_delete_class(p_class uuid)`, `admin_assign_teacher(p_class uuid, p_user uuid)`, `admin_unassign_teacher(p_class uuid, p_user uuid)`. Every one starts by checking `private.is_admin()` and returns `{error:'forbidden'}` otherwise.

- [ ] **Step 1: Extend `tests/migration.mjs`** (failing first): each function above exists as `create function public.<name>`; each has `revoke execute` from `public, anon` and `grant execute … to authenticated`; `redeem_invite` body contains an insert into `invite_attempts` and no `raise exception`; `redeem_invite` uses `extensions.gen_random_bytes` nowhere and `create_invite` uses it; the code alphabet literal has no `0O1Il`; `create_invite` stores `encode(extensions.digest(…,'sha256'),'hex')`; `delete_child` writes `deleted_children`; no function other than `whoami`, `admin_demote_teacher` assigns `accounts.role`.
- [ ] **Step 2: Run `node tests/migration.mjs`.** Expected: FAIL.
- [ ] **Step 3: Implement the functions** with the rules of §4 and §5. **Order inside `redeem_invite`:** rate limit, then role/class/ownership/limit checks (own code, `to_parent` on a child with a parent, `to_class` on a child already in a class, class limit, caller's 8-children limit), then the single-statement consume, so a refused redeem never uses up a code (§10). **Return shapes** (the clients of Tasks 4–8 read exactly these): `admin_list_accounts` → `{accounts:[{user_id,email,role}], invites:[{email,expires_at}]}`; `admin_list_classes` → `{classes:[{id,name,teachers:[{user_id,email}],children:int,unclaimed:int}]}`; `export_my_data` → `{account:{email,role}, classes:[{id,name}], children:[{id,name,kind,class_id,linked,data}]}`; `create_invite` → `{ok:true,code,expires_at}`; every failure is `{error:<code>}` with codes `forbidden | invalid | rate | already_in_class | has_parent | orphan | orphans | limit | not_found | last_admin`, and each wrapper of Task 4 maps `invalid`→`SyncError('code')`, `rate`→`SyncError('rate')`, anything else→`SyncError('http', <code>)`. Rules: single-statement consume `update invites … where used_at is null and expires_at > now() returning`; uniform `invalid` for wrong/used/expired/void/own code; void rules (creator lost link or class); `to_parent` only for a child without a parent link, re-checked at redeem; a code cannot be redeemed by its creator; failed redeem inserts into `invite_attempts` and returns the value; 10 per user per hour → `rate`; `leave_class` refused for a child with no parent link (`{error:'orphan'}`), allowed to a linked parent or a teacher of the class, deletes the pending codes of that child; `unlink_me` deletes the link and the child's pending codes, and deletes the child if it was the last link and the child has no class; `delete_child` allowed only to the linked parent, or to a teacher of the class when the child has no parent link; `admin_delete_class` refuses while the class holds children without a parent link (`{error:'orphans', count}`), `admin_demote_teacher` and `delete_my_account` are never refused for that reason (§5, Mi llamada); `delete_my_account` refuses the last admin, leaves classed children in their class unlinked, deletes class-less ones with tombstones, then deletes the `auth.users` row; every admin write inserts into `admin_log`.
- [ ] **Step 4: Run `node tests/migration.mjs`, `npm test` and `npm run test:rls`.** Expected: PASS, including every check-rls case (this is the first full green of the database rules).
- [ ] **Step 5: Commit** `feat(db): RPCs for codes, class membership, deletion and admin`.

### Task 4: Fake Supabase and `sync.js`

**Files:**
- Modify: `tests/lib/fake-supabase.mjs`, `src/sync.js`, `tests/sync.mjs`

**Interfaces:**
- Consumes: RPC names and return shapes of Task 3.
- Produces in `createSync(...)`: `rpc(name: string, args?: object) → Promise<object>` (same auth/refresh as `api`, throws `SyncError('auth'|'offline'|'http')`); `me() → {role, teacher_ack_at}`; `ackTeacher()`; `listClasses() → [{id, name}]`; `createInvite(childId, kind) → {code, expires_at}`; `redeemInvite(code, classId) → {ok, child_id}` (throws `SyncError('code')` for `invalid`, `SyncError('rate')` for `rate`, `SyncError('http', message)` for other `error` values); `leaveClass(id)`, `unlinkMe(id)`, `deleteChild(id)`, `exportMyData()`, `deleteMyAccount()`; `listProfiles()` rows gain `class_id` and `linked: boolean` (from embedded `child_links(user_id)`); `syncProfile` resolves `{data, version, kind}` or `{revoked: true}`; `createInClass({id, name, kind, classId, data}) → row` (explicit insert with `class_id`, used by "New child in this class" before the normal sync).
- Produces in the fake: `srv.setRole(email, role, {ack})`, `srv.addClass(name)`, `srv.addTeacher(classId, email)`, `srv.hideRow(id)` (makes an existing row answer 409/403 to the account), RPC endpoint `/rest/v1/rpc/<name>` implementing **every RPC of Task 3 that Tasks 5–8 call** with the code rules of Task 3 (single use, expiry via an injectable clock, uniform error, rate limit), and `rows` carrying `owner`, `class_id`, links.

- [ ] **Step 1: Write failing tests in `tests/sync.mjs`**, named: `sync: rpc refreshes an expired token once`; `sync: redeemInvite maps invalid to kind code and rate to kind rate`; `sync: listProfiles marks a class child as not linked`; `sync: syncProfile on a hidden row resolves revoked and does not create`; `sync: a locally changed kind is pushed; an unchanged kind is adopted from the server`; `sync: whoami claims a pending invitation`; `sync: offline rpc throws kind offline`; `sync: a revoked refresh token on an rpc gives kind auth`; `sync: createInClass sends class_id`.
- [ ] **Step 2: Run `node tests/sync.mjs`.** Expected: FAIL (new tests).
- [ ] **Step 3: Extend the fake**, then **implement in `src/sync.js`**: `rpc` built on the existing `api` helper with `/rest/v1/rpc/<name>` and POST; `SELECT` gains `class_id,child_links(user_id)`; `linked` = the embedded array contains the caller's id; `syncProfile` returns `{revoked:true}` when the create POST answers 403, or answers 409 and the re-read returns nothing; the early return compares `kind` too; `kind` is sent only when the caller passes `kindChanged: true` and otherwise taken from the row.
- [ ] **Step 4: Run `node tests/sync.mjs`, `node tests/merge.mjs` and `npm test`.** Expected: PASS (merge untouched).
- [ ] **Step 5: Commit** `feat(sync): rpc wrappers, class and link fields, revoked outcome`.

### Task 5: App integration: sign-in, linking and tablet cleanup

**Files:**
- Modify: `src/app.js`, `tests/smoke.mjs`

**Interfaces:**
- Consumes: Task 4's `me()`, `listProfiles()` (`linked`), `syncProfile` (`revoked`).
- Produces: `ROLE` (string, `'parent'` default, set from `sync.me()` after sign-in **and at app start** when a session exists); local profile entries may carry `via:'class'`, `kindDirty:true` (the adult changed the kind here and it is not yet pushed) and `hidden:true` (class profile hidden after an `auth` error), and `cleanProfiles` keeps all three (only the exact values `'class'` and `true`); `purgeClassProfiles(): Promise<void>` (removes the profiles with `via:'class'`, their `leemos-v1:<id>` state and stats keys, and the active-profile fallback); `signOutAndClean(): Promise<void>` used by `#acctOutBtn` (final `syncAll()`, then `sync.signOut()`, then purge; if the final sync fails offline and a marked profile has unsent progress it asks and aborts on "stay"); on `auth` failure from sync the marked profiles get `hidden:true` (not listed, not openable) and are purged at the next sign-in of a different account or unhidden after a successful sign-in of the same account; when the purge removes the active profile the app switches to the first remaining profile that is not marked (the default reader profile if none) and reloads as profile switching already does.

- [ ] **Step 1: Write failing tests in `tests/smoke.mjs`** (jsdom with the fake): `sign-in: a teacher with a local profile is not offered a class child in askLink`; `sign-in: class children are not auto-added`; `sign-out: removes only via:class profiles and their state, keeps linked and unmarked ones`; `sign-out: offline with unsent progress asks and keeps everything on "stay"`; `sync revoked: keeps local data and drops the rid`; `auth error: marked profiles are hidden, and unhidden after the same account signs in again`; `a different account signing in purges the hidden ones`; `purging the active profile switches to a remaining one`; `kind switched here is pushed once (kindDirty) and then adopted from the server`; `role is read at app start with a stored session`; `i18n parity still holds`.
- [ ] **Step 2: Run `node tests/smoke.mjs`.** Expected: FAIL (new tests).
- [ ] **Step 3: Implement.** In `afterSignIn`, call `sync.me()` and set `ROLE`; restrict `askLink` candidates and the auto-add loop to rows with `linked`; handle `{revoked:true}` in `syncAll` by deleting only `p.rid` and showing the existing `acct` status with a new i18n key `acctRevoked`; `kindChanged` is true when a local flag set by the profile-kind switch is present and is cleared after a successful sync; replace the `acctOutBtn` handler with `signOutAndClean`. Keep `app.js` free of `import` statements; the module for Task 6 is loaded with `window.__leemosImport || import()` the same way `sounds.js` is.
- [ ] **Step 4: Run `node tests/smoke.mjs` and `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(app): role at sign-in, linked-only linking and tablet cleanup`.

### Task 6: Parent and teacher UI (`src/teach.js`)

**Files:**
- Create: `src/teach.js`
- Modify: `index.html` (blocks inside `#acctIn`), `src/styles.css`, `src/data/i18n.es.json`, `src/data/i18n.ca.json`, `src/app.js` (load and mount), `tests/smoke.mjs`

**Interfaces:**
- Loaded with `import()` the first time the parents' panel is opened with a signed-in account (the parent's share button lives there too), not only for teachers.
- Produces: `export function createTeach(ctx)` returning `{render, refresh}`; `ctx` provides `sync`, `t`, `PROFILES`, `openChild(rid)` (creates the local profile with `rid` and `via:'class'` and switches to it), `confirm(textKey) → Promise<boolean>`. Parent block: per linked child "Compartir con el profesor" (shows the code large with its expiry and a copy button, after a confirmation text that names what the teacher will see), "Quitar de la clase" when the child has a class, a field "Tengo un código" (redeems a `to_parent` code). Teacher block (only if `ROLE==='teacher'` and `teacher_ack_at` set, otherwise the acknowledgement text with an accept button calling `ackTeacher`): per class the roster (name, the existing progress bar), buttons "Abrir aquí", "Código para los padres" (unclaimed children only), "Sacar de la clase", "Borrar" (two separate buttons, each with a confirmation), "Introducir un código" with a class picker, "Nuevo niño en esta clase" (inserts the row with `class_id` first, marks it `via:'class'`, then the normal sync).
- Sketch (text mockup, §6 and CLAUDE.md conventions):
```
┌ Guardar mi progreso ───────────────────┐
│ ana@cole.es · Sincronizado hace 2 min  │
│ ── Mis niños ──                        │
│ Elsa   [Compartir con el profesor]     │
│ Leo    En clase 3ºA  [Quitar de clase] │
│ [ Tengo un código ______ ] [Canjear]   │
│ ── Mis clases (profesor) ──            │
│ 3ºA  Elsa ▓▓▓░ [Abrir][Sacar][Borrar]  │
│      [Código para los padres] [Nuevo]  │
└────────────────────────────────────────┘
```

- [ ] **Step 1: Write failing smoke tests**: `teach: panels hidden with empty config`; `teach: a parent session sees the parent block and not the teacher block`; `teach: a teacher without acknowledgement sees only the acknowledgement`; `teach: sharing shows an 8-character code and its expiry after confirming`; `teach: redeeming a wrong code shows one generic message`; `teach: "New child in this class" creates the row with class_id and marks via:class`; `teach: delete and take-out are different buttons and each asks to confirm`; `teach: redeeming a valid to_class code as a teacher puts the child in the chosen class`; `teach: redeeming a valid to_parent code as a parent links the child`; `teach: Open here creates the local profile with rid and via:class`; `teach: a parent takes the child out of the class and the roster updates`; `teach: leaving a class with an unclaimed child shows the orphan message`; `teach: offline code actions show the network message and consume nothing`; `i18n: es and ca have the same keys`.
- [ ] **Step 2: Run `node tests/smoke.mjs`.** Expected: FAIL.
- [ ] **Step 3: Dev QA harness (so QA never touches production, whose URL is committed in `sync.config.json`).** Add `scripts/fake-supabase-server.mjs` (the fake of `tests/lib/fake-supabase.mjs` behind HTTP on port 5174, with CORS and seeded parent, teacher and admin accounts, code `123456`) and make `scripts/dev-server.mjs` serve the JSON in env `LEEMOS_SYNC_CONFIG_JSON` for `/src/data/sync.config.json` when it is set (dev only, off by default; covered by a test in `tests/staticserver.mjs`). The factory QA run starts both, never the committed config.
- [ ] **Step 4: Implement** `createTeach`, the markup, styles with existing tokens (44 px targets, visible focus), and all strings in both i18n files (ca texts reviewed by a native speaker later, flagged in the PR body). No `import` in `app.js`.
- [ ] **Step 5: Run `node tests/smoke.mjs`, `node tests/staticserver.mjs` and `npm test`.** Expected: PASS.
- [ ] **Step 6: Commit** `feat(ui): parent sharing, code redeem and teacher class panel`.

### Task 7: Admin page

**Files:**
- Create: `tools/admin.html`, `tools/admin.js`, `tests/admin.mjs`
- Modify: `package.json` (add `node tests/admin.mjs` to `test`)

**Interfaces:**
- Consumes: `createSync` (`rpc`, `me`, session in `localStorage['leemos-auth']`), the `admin_*` RPCs of Task 3.
- Produces: `export function mountAdmin(root, sync, t)` in `tools/admin.js`. First call `whoami`; anything other than `admin` renders only "Esta cuenta no es de administrador". Screens: teachers and admins with pending invitations (invite by email, revoke, demote), classes (create, rename, delete with children and unclaimed counts, never names), teachers per class (assign, unassign). No "change role" control and no child list. A warning dialog before demoting a teacher whose class would be left without teachers and with unclaimed children.

- [ ] **Step 1: Write `tests/admin.mjs` (failing)** with jsdom and the fake: `admin: a parent session shows only "not an admin"`; `admin: an admin lists teachers and pending invitations and no parent email`; `admin: inviting then revoking an email updates the list`; `admin: deleting a class with orphans shows the count and does not delete`; `admin: demoting the last teacher of a class with unclaimed children asks first`; `admin: the page has no control that sets an arbitrary role`.
- [ ] **Step 2: Run `node tests/admin.mjs`.** Expected: FAIL.
- [ ] **Step 3: Implement** the page (own sign-in form reusing the email-code flow, same markup conventions as `tools/record.html`). It loads `../src/sync.js` and reads `../src/data/sync.config.json`; with an empty config it says so and does nothing.
- [ ] **Step 4: Run `node tests/admin.mjs` and `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(admin): admin page for teachers, classes and assignments`.

### Task 8: Privacy: page, export and account deletion

**Files:**
- Create: `privacy.html`
- Modify: `src/teach.js`, `index.html` (consent line link), `src/data/i18n.{es,ca}.json`, `tests/smoke.mjs`

**Interfaces:**
- Consumes: `sync.exportMyData()`, `sync.deleteChild(id)`, `sync.deleteMyAccount()`.
- Produces: `privacy.html` (es + ca in one static page, visible `PENDIENTE` markers for controller, contact email and Supabase region, and a banner "borrador sin revisión legal"); in the account block "Descargar mis datos" (client-side JSON download, nothing leaves the browser), per child "Descargar" and "Borrar los datos de este niño", and "Borrar mi cuenta" (double confirmation; after success it clears `leemos-auth`, `leemos-auth-user`, `leemos-sync-at` and every `rid`, **purges the `via:'class'` profiles** and keeps the rest of the local progress); a link to `privacy.html` also inside the account block, not only on the consent line.

- [ ] **Step 1: Write failing smoke tests**: `privacy: the consent line and the account block link to privacy.html`; `delete account: via:class profiles are purged`; `export: "Download my data" produces JSON with the account's children and no other account's`; `delete: deleting a child calls deleteChild and removes only its rid`; `delete account: asks twice, clears the auth keys and keeps local progress`; `privacy.html contains the PENDIENTE markers`.
- [ ] **Step 2: Run `node tests/smoke.mjs`.** Expected: FAIL.
- [ ] **Step 3: Implement** the page (text per §8.1: what is stored, who sees it, retention, rights, the admin-trust statement) and the buttons.
- [ ] **Step 4: Run `node tests/smoke.mjs` and `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(privacy): privacy page, data export and deletion`.

### Task 9: Service worker, docs and final verification

**Files:**
- Modify: `sw.js`, `tests/sw.mjs`, `tests/close.mjs` (line 96 asserts `VERSION = 'leemos-v25'`; change it to `/VERSION = 'leemos-v\d+'/` like `tests/find.mjs` does), `CLAUDE.md`, `README.md` (only the accounts paragraph if it exists)

- [ ] **Step 1: Failing test in `tests/sw.mjs`:** `sw: SHELL lists src/teach.js and privacy.html and VERSION is leemos-v26`.
- [ ] **Step 2: Run `node tests/sw.mjs`.** Expected: FAIL.
- [ ] **Step 3: Add `src/teach.js` and `privacy.html` to `SHELL`, set `VERSION = 'leemos-v26'`.** `tools/admin.*` stay out of `SHELL`.
- [ ] **Step 4: Update `CLAUDE.md`:** in Arquitectura add `src/teach.js`, `tools/admin.html+js`, `privacy.html`, the new migration and tests; in Persistencia add the roles, links, `via:'class'` marker and the sign-out cleanup, the delete rules and the code rules; remove "subproyecto 2" from the pending list only for what this run delivers (export, delete, policy draft) and keep "revisión legal" pending. Keep it in Spanish and as short as the neighbouring entries.
- [ ] **Step 5: Write the rollout section** in `README.md` (Spanish, a numbered list Fran can follow; this is documentation, the plan does not run it): (1) with Docker running, `npm run test:rls` starts a local Supabase, applies every migration and runs `scripts/check-rls.mjs`; it must end with `All RLS checks passed` (the production keys never go in `.env` for this: the script injects the local ones); (2) repeat it after any change to the migration; (3) in production, export `child_profiles` (SQL editor: `select * from child_profiles`, download CSV) as a backup; (4) apply the migration to production (it is one transaction: a failure leaves nothing half applied); (5) set the first admin by SQL (`update public.accounts set role='admin' where user_id=(select id from auth.users where email='…')`); (6) check by hand with the real account that Elsa's and Leo's profiles still sync; **do not run `check-rls.mjs` against production** (it creates and deletes throwaway users; the local run of step 1 is the database test); (7) only then merge and publish. If step 6 fails, the rollback is restoring the backup of step 3 and `drop`ping the new tables, written out in the README.
- [ ] **Step 6: Run `npm test`.** Expected: every script passes, final line of each `All … passed`.
- [ ] **Step 7: Commit** `chore: service worker v26, docs and rollout for teachers and classes`.
