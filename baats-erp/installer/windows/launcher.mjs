// BAATS Enterprise ERP desktop launcher (Windows).
// Starts a private PostgreSQL, prepares the database on first run, starts the
// BAATS server on this computer only, and opens the trial console in the browser.
// Usage: node launcher.mjs          start (or just open the browser if already running)
//        node launcher.mjs --stop   stop everything
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const IS_WIN = process.platform === 'win32';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const APP_DIR = join(ROOT, 'app');
const PG_BIN = process.env.BAATS_PG_BIN ?? join(ROOT, 'pgsql', 'bin');
const exe = (name) => join(PG_BIN, IS_WIN ? `${name}.exe` : name);
const DATA_ROOT = process.env.BAATS_DATA_DIR
  ?? join(process.env.LOCALAPPDATA ?? join(process.env.HOME ?? '.', '.local', 'share'), 'BAATS-ERP');
const PGDATA = join(DATA_ROOT, 'pgdata');
const LOG_DIR = join(DATA_ROOT, 'logs');
const CONFIG = join(DATA_ROOT, 'config.json');
const LOG = join(LOG_DIR, 'launcher.log');

mkdirSync(LOG_DIR, { recursive: true });
const say = (msg) => { console.log(msg); try { appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ } };

function fail(msg, err) {
  say(`\nERROR: ${msg}${err ? `\n${err.stack ?? err}` : ''}`);
  say(`\nLogs are in ${LOG_DIR}`);
  say('Press Enter to close this window.');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(1));
}

const freePort = (port) => new Promise((resolve) => {
  const s = createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});
async function pickPort(from) {
  for (let p = from; p < from + 50; p++) if (await freePort(p)) return p;
  throw new Error(`no free port near ${from}`);
}

function loadConfig() {
  if (existsSync(CONFIG)) return JSON.parse(readFileSync(CONFIG, 'utf8'));
  return null;
}

function openBrowser(url) {
  if (IS_WIN) spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
  else if (!process.env.BAATS_NO_BROWSER) spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

async function isBaatsRunning(cfg) {
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.appPort}/local/ping`, { signal: AbortSignal.timeout(1500) });
    return r.ok && (await r.json()).baats === true;
  } catch { return false; }
}

const pgCtl = (args, opts = {}) => spawnSync(exe('pg_ctl'), args, { encoding: 'utf8', windowsHide: true, ...opts });
const pgRunning = () => pgCtl(['status', '-D', PGDATA]).status === 0;

function stopPostgres() {
  if (existsSync(join(PGDATA, 'postmaster.pid'))) {
    pgCtl(['stop', '-D', PGDATA, '-m', 'fast', '-w', '-t', '20']);
  }
}

async function stopAll() {
  const cfg = loadConfig();
  if (cfg && await isBaatsRunning(cfg)) {
    try { await fetch(`http://127.0.0.1:${cfg.appPort}/local/shutdown`, { method: 'POST', headers: { 'x-local-key': cfg.localKey } }); } catch { /* closing */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  stopPostgres();
  say('BAATS ERP is stopped.');
}

async function main() {
  if (process.argv.includes('--stop')) return stopAll();

  say('BAATS Enterprise ERP is starting. Please keep this window open while you use it.');
  let cfg = loadConfig();
  if (cfg && await isBaatsRunning(cfg)) {
    say('BAATS is already running. Opening it in your browser.');
    openBrowser(`http://127.0.0.1:${cfg.appPort}/`);
    setTimeout(() => process.exit(0), 1500);
    return;
  }

  const firstRun = !existsSync(join(PGDATA, 'PG_VERSION'));
  if (!cfg || firstRun) {
    cfg = {
      pgPort: await pickPort(54329),
      appPort: cfg?.appPort ?? 3000,
      pgPassword: randomBytes(18).toString('base64url'),
      appDbPassword: randomBytes(18).toString('base64url'),
      platformAdminKey: randomBytes(24).toString('base64url'),
      localKey: randomBytes(24).toString('base64url'),
    };
  }

  // 1. Database cluster (first run only)
  if (firstRun) {
    say('First start: creating the BAATS database. This takes about a minute.');
    if (existsSync(PGDATA)) rmSync(PGDATA, { recursive: true, force: true });
    const pw = join(DATA_ROOT, 'pw.tmp');
    writeFileSync(pw, cfg.pgPassword);
    const r = spawnSync(exe('initdb'), ['-D', PGDATA, '-U', 'postgres', '-A', 'scram-sha-256', `--pwfile=${pw}`, '-E', 'UTF8', '--no-locale'],
      { encoding: 'utf8', windowsHide: true });
    rmSync(pw, { force: true });
    writeFileSync(join(LOG_DIR, 'initdb.log'), `${r.stdout ?? ''}\n${r.stderr ?? ''}\n${r.error ?? ''}`);
    if (r.status !== 0) throw new Error(`could not create the database (initdb exit ${r.status}). ${r.error ? r.error.message : r.stderr}`);
    writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
  }

  // 2. Start PostgreSQL
  if (!pgRunning()) {
    if (!(await freePort(cfg.pgPort))) throw new Error(`port ${cfg.pgPort} is used by another program`);
    say('Starting the database...');
    const r = pgCtl(['start', '-D', PGDATA, '-w', '-t', '60', '-l', join(LOG_DIR, 'postgres.log'),
      '-o', `-p ${cfg.pgPort} -c listen_addresses=127.0.0.1${IS_WIN ? '' : " -c unix_socket_directories=''"}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status !== 0) throw new Error(`the database did not start. See ${join(LOG_DIR, 'postgres.log')}. ${r.stderr ?? ''}`);
  }

  // 3. Create the database and apply migrations
  const pg = (await import(pathToFileURL(join(APP_DIR, 'node_modules', 'pg', 'lib', 'index.js')).href)).default;
  const ownerUrl = (db) => `postgres://postgres:${encodeURIComponent(cfg.pgPassword)}@127.0.0.1:${cfg.pgPort}/${db}`;
  {
    const c = new pg.Client({ connectionString: ownerUrl('postgres') });
    await c.connect();
    const has = await c.query(`SELECT 1 FROM pg_database WHERE datname = 'baats'`);
    if (!has.rowCount) await c.query('CREATE DATABASE baats');
    await c.end();
  }
  {
    const c = new pg.Client({ connectionString: ownerUrl('baats') });
    await c.connect();
    try {
      await c.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const done = new Set((await c.query('SELECT name FROM public.schema_migrations')).rows.map((x) => x.name));
      const dir = join(APP_DIR, 'db', 'migrations');
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
        if (done.has(f)) continue;
        say(`Preparing database: ${f}`);
        await c.query('BEGIN');
        try {
          await c.query(readFileSync(join(dir, f), 'utf8'));
          await c.query('INSERT INTO public.schema_migrations (name) VALUES ($1)', [f]);
          await c.query('COMMIT');
        } catch (err) { await c.query('ROLLBACK'); throw new Error(`database update ${f} failed: ${err.message}`); }
      }
      await c.query(`ALTER ROLE baats_app LOGIN PASSWORD ${c.escapeLiteral(cfg.appDbPassword)}`);
    } finally { await c.end(); }
  }

  // 4. Start the BAATS server (bound to this computer only)
  if (!(await freePort(cfg.appPort))) {
    cfg.appPort = await pickPort(3001);
    say(`Port 3000 is busy, using ${cfg.appPort} instead.`);
  }
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));

  const { Db } = await import(pathToFileURL(join(APP_DIR, 'src', 'core', 'db.ts')).href);
  const { buildServer } = await import(pathToFileURL(join(APP_DIR, 'src', 'api', 'server.ts')).href);
  const db = new Db({ connectionString: `postgres://baats_app:${encodeURIComponent(cfg.appDbPassword)}@127.0.0.1:${cfg.pgPort}/baats` });
  const app = buildServer({ db, platformAdminKey: cfg.platformAdminKey, logger: false });

  const consoleHtml = readFileSync(join(HERE, 'console.html'), 'utf8');
  const version = (() => { try { return readFileSync(join(ROOT, 'VERSION.txt'), 'utf8').trim(); } catch { return 'dev'; } })();
  let shuttingDown = false;
  const shutdown = async (why) => {
    if (shuttingDown) return; shuttingDown = true;
    say(`Stopping BAATS (${why})...`);
    clearInterval(timer);
    try { server.close(); } catch { /* ignore */ }
    try { await app.close(); } catch { /* ignore */ }
    try { await db.close(); } catch { /* ignore */ }
    stopPostgres();
    say('Stopped.');
    process.exit(0);
  };
  const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => resolve(b)); });
  const send = (res, status, type, body) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  await app.ready();
  // Local-only routes for the trial console; everything else goes to the BAATS API unchanged.
  const server = createHttpServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    try {
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) return send(res, 200, 'text/html; charset=utf-8', consoleHtml);
      if (req.method === 'GET' && path === '/local/ping') return send(res, 200, 'application/json', JSON.stringify({ baats: true, version }));
      if (req.method === 'POST' && path === '/local/create-company') {
        const r = await app.inject({ method: 'POST', url: '/v1/platform/tenants', payload: await readBody(req),
          headers: { 'content-type': 'application/json', 'x-platform-admin-key': cfg.platformAdminKey } });
        return send(res, r.statusCode, 'application/json', r.body);
      }
      if (req.method === 'POST' && path === '/local/shutdown') {
        if (req.headers['x-local-key'] !== cfg.localKey) return send(res, 403, 'application/json', '{"ok":false}');
        send(res, 200, 'application/json', '{"ok":true}');
        return setTimeout(() => shutdown('stop requested'), 100);
      }
      app.routing(req, res);
    } catch (err) { send(res, 500, 'application/json', JSON.stringify({ error: 'internal', message: err.message })); }
  });

  // Escalation sweep, as in src/main.ts
  const { runEscalations } = await import(pathToFileURL(join(APP_DIR, 'src', 'workflow', 'engine.ts')).href);
  const timer = setInterval(async () => {
    try {
      const ids = await db.withTenant({ tenantId: '00000000-0000-0000-0000-000000000000', userId: null },
        async (tx) => (await tx.query('SELECT platform.active_tenant_ids() AS id')).rows.map((x) => x.id));
      for (const tenantId of ids) await db.withTenant({ tenantId, userId: null }, (tx) => runEscalations(tx)).catch(() => {});
    } catch { /* next time */ }
  }, 300_000);

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try { process.on(sig, () => shutdown('window closed')); } catch { /* signal not supported */ }
  }

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(cfg.appPort, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${cfg.appPort}/`;
  say('');
  say('==========================================================');
  say(`  BAATS Enterprise ERP is running at ${url}`);
  say('  Your browser should open by itself.');
  say('  To stop BAATS, close this window (or press Ctrl+C).');
  say('==========================================================');
  openBrowser(url);
}

main().catch((err) => { stopPostgres(); fail(err.message, err); });
