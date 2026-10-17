// Tests for the sticker sets per world (data only). Spec: docs/superpowers/specs/2026-10-17-world-stickers-design.md.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };

const WORLDS = readJSON('src/data/worlds.json');
const OLD = readJSON('src/data/stickers.json');
const all = WORLDS.flatMap((w) => w.stk || []);

check('stickers: 16 worlds, each with exactly 6 stickers', WORLDS.length === 16 && WORLDS.every((w) => Array.isArray(w.stk) && w.stk.length === 6));
check('stickers: no emoji is repeated inside or across worlds (96 different)', all.length === 96 && new Set(all).size === 96 && all.every((e) => typeof e === 'string' && e.length > 0));
check('stickers: the 24 old animals all belong to some world', OLD.length === 24 && OLD.every((e) => all.includes(e)));
let prefix = true;
for (const w of WORLDS) { const old = OLD.filter((e) => (w.stk || []).includes(e)); if (!w.stk || w.stk.slice(0, old.length).join() !== old.join()) prefix = false; }
check('stickers: in each world the old animals come first, in their old order (owned ones are always a prefix)', prefix);
check('stickers: world ids are what the merge accepts (/^[a-z]{2,20}$/)', WORLDS.every((w) => /^[a-z]{2,20}$/.test(w.id)));

console.log(failures ? `\n${failures} sticker test(s) FAILED` : '\nAll sticker tests passed');
process.exit(failures ? 1 : 0);
