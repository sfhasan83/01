// BAATS Enterprise ERP desktop launcher (Windows).
// Starts a private PostgreSQL, prepares the database on first run, starts the
// BAATS server on this computer only, and opens the trial console in the browser.
// Usage: node launcher.mjs          start (or just open the browser if already running)
//        node launcher.mjs --stop   stop everything
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, rmSync, statSync, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { join, dirname } from 'node:path';
import { networkInterfaces } from 'node:os';
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

// Companies created by an older version: give their administrator role the permissions added since.
async function grantNewPermissions(c) {
  const tenants = (await c.query(`SELECT DISTINCT tenant_id FROM iam.roles WHERE code = 'TENANT_ADMIN'`)).rows;
  for (const { tenant_id: tid } of tenants) {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', '', true)`, [tid]);
    await c.query(`INSERT INTO iam.role_permissions (tenant_id, role_id, permission_code)
      SELECT r.tenant_id, r.id, p.code FROM iam.roles r CROSS JOIN ref.permissions p
       WHERE r.code = 'TENANT_ADMIN' AND r.tenant_id = $1
         AND NOT EXISTS (SELECT 1 FROM iam.role_permissions x WHERE x.role_id = r.id AND x.permission_code = p.code)`, [tid]);
    await c.query('COMMIT');
  }
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
  // Encrypts AI provider keys at rest. Older installs get one on upgrade.
  cfg.secretKey ??= randomBytes(32).toString('base64');

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
      let appliedNow = false;
      const done = new Set((await c.query('SELECT name FROM public.schema_migrations')).rows.map((x) => x.name));
      const dir = join(APP_DIR, 'db', 'migrations');
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
        if (done.has(f)) continue;
        say(`Preparing database: ${f}`);
        appliedNow = true;
        await c.query('BEGIN');
        try {
          await c.query(readFileSync(join(dir, f), 'utf8'));
          await c.query('INSERT INTO public.schema_migrations (name) VALUES ($1)', [f]);
          await c.query('COMMIT');
        } catch (err) { await c.query('ROLLBACK'); throw new Error(`database update ${f} failed: ${err.message}`); }
      }
      if (appliedNow) await grantNewPermissions(c);
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
  const app = buildServer({ db, platformAdminKey: cfg.platformAdminKey, logger: false, ai: { secretKey: cfg.secretKey, allowPrivateUrls: true },
    limits: { apiPerMinute: Number(cfg.apiRequestsPerMinute) || undefined, loginsPer5Min: Number(cfg.loginsPer5Minutes) || undefined },
    // publicUrl: the address people reach this PC at, when it is published (sign-in return and card payment pages).
    connectors: { publicUrl: typeof cfg.publicUrl === 'string' && cfg.publicUrl ? cfg.publicUrl : undefined, ssoAllowHttp: cfg.ssoAllowHttp === true } });

  const consoleHtml = readFileSync(join(HERE, 'console.html'), 'utf8');
  const version = (() => { try { return readFileSync(join(ROOT, 'VERSION.txt'), 'utf8').trim(); } catch { return 'dev'; } })();
  let shuttingDown = false;
  const shutdown = async (why) => {
    if (shuttingDown) return; shuttingDown = true;
    say(`Stopping BAATS (${why})...`);
    clearInterval(timer); clearInterval(hookTimer); clearInterval(backupTimer); clearInterval(mailTimer); clearInterval(linkTimer);
    try { server.close(); closePhoneAccess(); } catch { /* ignore */ }
    try { await app.close(); } catch { /* ignore */ }
    try { await db.close(); } catch { /* ignore */ }
    stopPostgres();
    say('Stopped.');
    process.exit(0);
  };
  const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => resolve(b)); });
  const send = (res, status, type, body) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  await app.ready();
  // Phone access (off by default): BAATS also listens on this computer's local
  // network addresses, so BAATS Mobile works on phones on the same Wi-Fi.
  const lanAddresses = () => Object.values(networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')).map((a) => a.address);
  const phoneServers = [];
  const received = [];
  const phoneUrls = () => phoneServers.map((x) => `http://${x.ip}:${cfg.appPort}/m/`);
  const openPhoneAccess = async () => {
    for (const ip of lanAddresses()) {
      if (phoneServers.some((x) => x.ip === ip)) continue;
      const srv = createHttpServer((req, res) => handle(req, res, true));
      try {
        await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(cfg.appPort, ip, resolve); });
        phoneServers.push({ ip, srv });
      } catch (err) { say(`Phone access: could not listen on ${ip} (${err.message})`); }
    }
    if (phoneServers.length) say(`Phones on the same network can open BAATS Mobile at ${phoneUrls().join(' or ')}`);
    else say('Phone access is on, but this computer has no local network address right now.');
  };
  const closePhoneAccess = () => { for (const x of phoneServers.splice(0)) x.srv.close(); };
  // Only someone who manages integrations in a company may switch phone access.
  const mayManage = async (req, permission = 'int.manage') => {
    const r = await app.inject({ method: 'POST', url: '/v1/iam/check', payload: { permission },
      headers: { authorization: req.headers.authorization ?? '', 'content-type': 'application/json' } });
    return r.statusCode === 200 && JSON.parse(r.body).allowed === true;
  };

  // Backups: one a day while BAATS runs (the last 14 are kept), and any time from the console.
  const BACKUP_DIR = join(DATA_ROOT, 'backups');
  mkdirSync(BACKUP_DIR, { recursive: true });
  const KEEP_AUTO = 14;
  const backupMod = await import(pathToFileURL(join(APP_DIR, 'src', 'platform', 'backup.ts')).href);
  const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const listBackups = () => readdirSync(BACKUP_DIR).filter((n) => /^baats-\d{8}-\d{6}-[a-z-]+\.baatsbak$/.test(n)).sort().reverse()
    .map((name) => { const st = statSync(join(BACKUP_DIR, name)); return { name, bytes: st.size, at: st.mtime.toISOString(), kind: name.slice(22, -9) }; });
  let backupBusy = false;
  const makeBackup = async (kind) => {
    if (backupBusy) throw new Error('a backup or restore is already running');
    backupBusy = true;
    try {
      const file = join(BACKUP_DIR, `baats-${stamp()}-${kind}.baatsbak`);
      const r = await backupMod.backupDatabase(ownerUrl('baats'), file, version);
      // Keep the last 14 daily backups and the last 5 made before a restore; manual ones stay until removed by hand.
      const keep = { auto: KEEP_AUTO, 'before-restore': 5 };
      for (const [k, n] of Object.entries(keep)) for (const old of listBackups().filter((b) => b.kind === k).slice(n)) rmSync(join(BACKUP_DIR, old.name), { force: true });
      say(`Backup made: ${file} (${Math.round(r.bytes / 1024)} KB)`);
      return { name: file.split(/[\\/]/).pop(), bytes: r.bytes, rows: r.rows, at: r.createdAt };
    } finally { backupBusy = false; }
  };
  const restoreBackup = async (name) => {
    // Check the file before anything else, so a wrong file changes nothing.
    try { await backupMod.readBackupHeader(join(BACKUP_DIR, name)); } catch (err) { throw Object.assign(err, { status: 422 }); }
    await makeBackup('before-restore');
    backupBusy = true;
    try {
      say(`Restoring ${name}...`);
      const r = await backupMod.restoreDatabase({ adminUrl: ownerUrl('postgres'), urlFor: ownerUrl, database: 'baats', file: join(BACKUP_DIR, name),
        migrationsDir: join(APP_DIR, 'db', 'migrations'), log: say });
      const c = new pg.Client({ connectionString: ownerUrl('baats') });
      await c.connect();
      try { await grantNewPermissions(c); } finally { await c.end(); }
      // Keep only the database replaced by this restore; older ones go.
      const kept = await backupMod.keptDatabases(ownerUrl('postgres'), 'baats');
      if (kept.length > 1) {
        const c2 = new pg.Client({ connectionString: ownerUrl('postgres') });
        await c2.connect();
        try { for (const k of kept.slice(0, -1)) await c2.query(`DROP DATABASE IF EXISTS "${k}" WITH (FORCE)`); } finally { await c2.end(); }
      }
      say(`Restored the backup of ${r.header.createdAt} (${r.rows} rows). The data before it was saved as a backup too.`);
      return { restored: name, backupOf: r.header.createdAt, fromVersion: r.header.appVersion, rows: r.rows, updatedWith: r.newerMigrations };
    } finally { backupBusy = false; }
  };
  const autoBackup = async () => {
    const today = stamp().slice(0, 8);
    if (listBackups().some((b) => b.kind === 'auto' && b.name.slice(6, 14) === today)) return;
    try { await makeBackup('auto'); } catch (err) { say(`Automatic backup failed: ${err.message}`); }
  };
  const backupTimer = setInterval(autoBackup, 3_600_000);

  // Local-only routes for the trial console; everything else goes to the BAATS API unchanged.
  // Requests that come from the local network reach only BAATS Mobile and the API.
  const handle = async (req, res, fromLan) => {
    const path = (req.url ?? '/').split('?')[0];
    try {
      if (fromLan) {
        if (req.method === 'GET' && (path === '/' || path === '/index.html')) { res.writeHead(302, { location: '/m/' }); return res.end(); }
        if (!(path === '/m' || path.startsWith('/m/') || path.startsWith('/v1/') || path === '/health') || path === '/v1/platform/tenants') {
          return send(res, 404, 'application/json', '{"error":"not_found","message":"not available from the network"}');
        }
        return app.routing(req, res);
      }
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) return send(res, 200, 'text/html; charset=utf-8', consoleHtml);
      if (req.method === 'GET' && path === '/local/ping') return send(res, 200, 'application/json', JSON.stringify({ baats: true, version }));
      if (req.method === 'GET' && path === '/local/phone-access') {
        return send(res, 200, 'application/json', JSON.stringify({ on: !!cfg.allowPhones, urls: phoneUrls(), port: cfg.appPort, localUrl: `http://127.0.0.1:${cfg.appPort}/m/` }));
      }
      if (req.method === 'POST' && path === '/local/phone-access') {
        if (!(await mayManage(req))) return send(res, 403, 'application/json', '{"error":"forbidden","message":"only someone with the int.manage permission can switch phone access"}');
        const on = JSON.parse((await readBody(req)) || '{}').on === true;
        cfg.allowPhones = on;
        writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
        if (on) await openPhoneAccess(); else { closePhoneAccess(); say('Phone access is off.'); }
        return send(res, 200, 'application/json', JSON.stringify({ on, urls: phoneUrls(), port: cfg.appPort }));
      }
      if (path === '/local/backups' || path.startsWith('/local/backups/') || path === '/local/restore') {
        if (!(await mayManage(req, 'sys.backup'))) return send(res, 403, 'application/json', '{"error":"forbidden","message":"only someone with the sys.backup permission can work with backups"}');
        if (req.method === 'GET' && path === '/local/backups') return send(res, 200, 'application/json', JSON.stringify({ dir: BACKUP_DIR, backups: listBackups(), keepAuto: KEEP_AUTO, busy: backupBusy }));
        if (req.method === 'POST' && path === '/local/backups') { const b = await makeBackup('manual'); return send(res, 200, 'application/json', JSON.stringify(b)); }
        if (req.method === 'GET' && path.startsWith('/local/backups/')) {
          const name = decodeURIComponent(path.slice('/local/backups/'.length));
          if (!listBackups().some((x) => x.name === name)) return send(res, 404, 'application/json', '{"error":"not_found","message":"no such backup"}');
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' });
          return createReadStream(join(BACKUP_DIR, name)).pipe(res);
        }
        if (req.method === 'POST' && path === '/local/restore') {
          // Either a backup kept here (?name=...), or a backup file sent as the request body.
          const q = new URL(req.url, 'http://x').searchParams;
          let name = q.get('name');
          if (q.get('confirm') !== 'RESTORE') return send(res, 422, 'application/json', '{"error":"validation_failed","message":"type RESTORE to confirm"}');
          if (!name) {
            name = `baats-${stamp()}-uploaded.baatsbak`;
            await pipeline(req, createWriteStream(join(BACKUP_DIR, name), { mode: 0o600 }));
          } else if (!listBackups().some((x) => x.name === name)) return send(res, 404, 'application/json', '{"error":"not_found","message":"no such backup"}');
          try {
            const r = await restoreBackup(name);
            return send(res, 200, 'application/json', JSON.stringify(r));
          } catch (err) {
            if (!q.get('name')) rmSync(join(BACKUP_DIR, name), { force: true });
            if (err.status === 422) return send(res, 422, 'application/json', JSON.stringify({ error: 'validation_failed', message: err.message }));
            throw err;
          }
        }
      }
      // A webhook receiver for trying webhooks without another system; keeps the last 50 messages in memory.
      if (req.method === 'POST' && path === '/local/test-receiver') {
        const raw = await readBody(req);
        let body; try { body = JSON.parse(raw); } catch { body = raw.slice(0, 2000); }
        received.unshift({ at: new Date().toISOString(), event: String(req.headers['x-baats-event'] ?? ''), signature: String(req.headers['x-baats-signature'] ?? ''), body });
        received.length = Math.min(received.length, 50);
        return send(res, 200, 'application/json', '{"received":true}');
      }
      if (req.method === 'GET' && path === '/local/test-receiver') return send(res, 200, 'application/json', JSON.stringify(received));
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
  };
  const server = createHttpServer((req, res) => handle(req, res, false));

  // Webhook deliveries every half minute, as in src/main.ts. Receivers on this
  // computer or the local network are allowed in the trial.
  const { dispatchAll } = await import(pathToFileURL(join(APP_DIR, 'src', 'int', 'webhooks.ts')).href);
  const { parseSecretKey } = await import(pathToFileURL(join(APP_DIR, 'src', 'ai', 'secrets.ts')).href);
  const hookOpts = { secretKey: parseSecretKey(cfg.secretKey), allowPrivateUrls: true };
  let dispatching = false;
  const hookTimer = setInterval(async () => {
    if (dispatching) return;
    dispatching = true;
    try { await dispatchAll(db, hookOpts); } catch { /* next time */ } finally { dispatching = false; }
  }, 30_000);

  // Email every half minute, and card payment links every two minutes, as in src/main.ts.
  const { dispatchMailAll } = await import(pathToFileURL(join(APP_DIR, 'src', 'int', 'mail.ts')).href);
  const { checkOpenLinks } = await import(pathToFileURL(join(APP_DIR, 'src', 'fin', 'paylinks.ts')).href);
  let mailing = false, checkingLinks = false;
  const mailTimer = setInterval(async () => {
    if (mailing) return;
    mailing = true;
    try { await dispatchMailAll(db, hookOpts); } catch { /* next time */ } finally { mailing = false; }
  }, 30_000);
  const linkTimer = setInterval(async () => {
    if (checkingLinks) return;
    checkingLinks = true;
    try { const n = await checkOpenLinks(db, hookOpts); if (n) say(`Card payments received: ${n}`); } catch { /* next time */ } finally { checkingLinks = false; }
  }, 120_000);

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
  if (cfg.allowPhones) await openPhoneAccess();
  setTimeout(autoBackup, 60_000);
  openBrowser(url);
}

main().catch((err) => { stopPostgres(); fail(err.message, err); });
