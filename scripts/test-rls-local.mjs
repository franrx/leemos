// Runs scripts/check-rls.mjs against a LOCAL Supabase in Docker (never a real project):
//   npm run test:rls            start, apply supabase/migrations, run the checks, stop
//   npm run test:rls -- --keep  leave the stack running afterwards
// The local keys are read from `supabase status` at runtime and passed only through the child's environment (never written to disk).
import { spawnSync } from 'node:child_process';

const SUPABASE_CLI = '3.1.0'; // the version `supabase init` was run with; bump it here only
const keep = process.argv.includes('--keep');
const cli = (args, opts = {}) => spawnSync('npx', ['--yes', `supabase@${SUPABASE_CLI}`, ...args], { encoding: 'utf8', ...opts });

if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) { console.error('Docker no está en marcha: ábrelo y vuelve a ejecutar npm run test:rls'); process.exit(2); }

const run = () => {
  for (const args of [['start'], ['db', 'reset']]) {
    if (cli(args, { stdio: 'inherit' }).status !== 0) { console.error(`supabase ${args.join(' ')} falló`); return 2; }
  }
  const st = cli(['status', '-o', 'env']);
  const vars = {};
  for (const l of String(st.stdout).split('\n')) { const m = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(l.trim()); if (m) vars[m[1]] = m[2]; }
  const [SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY] = [vars.API_URL, vars.ANON_KEY, vars.SERVICE_ROLE_KEY];
  if (st.status !== 0 || !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) { console.error('No se pudieron leer las claves locales de supabase status'); return 2; }
  // The process environment wins over .env in check-rls, so production keys in .env are never used here. The db container name
  // (supabase_db_<project_id>, supabase/config.toml) lets check-rls seed rows past the triggers with docker exec psql.
  return spawnSync('node', ['scripts/check-rls.mjs'], { stdio: 'inherit', env: { ...process.env, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, LEEMOS_RLS_DB_CONTAINER: 'supabase_db_leemos' } }).status ?? 2;
};
let code = 2;
try { code = run(); } finally { if (!keep) cli(['stop'], { stdio: 'inherit' }); }
process.exit(code);
