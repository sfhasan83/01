import { closeSync, createReadStream, createWriteStream, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import type { Readable } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { once } from 'node:events';
import pg from 'pg';

/**
 * Backups of a whole BAATS database, made while it runs, without pg_dump.
 *
 * A backup is one gzip file of JSON lines: a heading with the format, the
 * database migrations it was made with and the sequences, then every table's
 * rows, all read in one consistent snapshot. Restoring builds a new database
 * from the same migrations, loads the rows with triggers off (so the audit
 * chain and every stored total come back exactly as they were), applies any
 * newer migrations, and only then swaps it in place of the old one, which is
 * kept under another name.
 *
 * Both run as the database owner (superuser), never as baats_app.
 *
 * With a passphrase the backup is encrypted (AES-256-GCM, the key derived from
 * the passphrase with scrypt): BAATSENC1, a newline, the salt (16 bytes) and
 * nonce (12 bytes), the encrypted gzip, and the 16-byte tag at the end, which
 * proves that nothing was changed. Without the passphrase it cannot be read.
 */

export const BACKUP_FORMAT = 'baats-backup/1';
const SKIP_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];

export interface BackupHeader {
  format: string; createdAt: string; appVersion: string; database: string;
  migrations: string[]; sequences: { name: string; value: string; called: boolean }[]; tables: string[];
}
export interface BackupResult { file: string; bytes: number; tables: number; rows: number; createdAt: string; encrypted: boolean }

const MAGIC = Buffer.from('BAATSENC1\n');
const HEAD = MAGIC.length + 16 + 12;
const keyFor = (passphrase: string, salt: Buffer) => scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1_048_576 });

/** Whether a backup file is encrypted. */
export function isEncrypted(file: string): boolean {
  const fd = openSync(file, 'r');
  try { const b = Buffer.alloc(MAGIC.length); readSync(fd, b, 0, b.length, 0); return b.equals(MAGIC); } finally { closeSync(fd); }
}

/** The gzip bytes of a backup, decrypted when it is encrypted. */
function rawStream(file: string, passphrase?: string): Readable {
  if (!isEncrypted(file)) return createReadStream(file);
  if (!passphrase) throw new Error('this backup is encrypted; give its passphrase');
  const size = statSync(file).size;
  if (size < HEAD + 16) throw new Error('this file is not a BAATS backup');
  const fd = openSync(file, 'r');
  const head = Buffer.alloc(HEAD), tag = Buffer.alloc(16);
  try { readSync(fd, head, 0, HEAD, 0); readSync(fd, tag, 0, 16, size - 16); } finally { closeSync(fd); }
  const d = createDecipheriv('aes-256-gcm', keyFor(passphrase, head.subarray(MAGIC.length, MAGIC.length + 16)), head.subarray(MAGIC.length + 16));
  d.setAuthTag(tag);
  const src = createReadStream(file, { start: HEAD, end: size - 17 });
  src.on('error', (e) => d.destroy(e));
  return src.pipe(d);
}

const ident = (q: string) => q.split('.').map((p) => `"${p.replace(/"/g, '""')}"`).join('.');

async function tablesOf(c: pg.Client): Promise<string[]> {
  return (await c.query(`SELECT n.nspname || '.' || c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname <> ALL($1) AND n.nspname NOT LIKE 'pg_temp%'
        AND NOT (n.nspname = 'public' AND c.relname = 'schema_migrations') ORDER BY 1`, [SKIP_SCHEMAS])).rows.map((r) => r.t);
}

/** Write a backup of the database at ownerUrl to file. */
export async function backupDatabase(ownerUrl: string, file: string, appVersion: string, opts: { passphrase?: string } = {}): Promise<BackupResult> {
  if (opts.passphrase !== undefined && opts.passphrase.length < 12) throw new Error('a backup passphrase has at least 12 characters');
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  const gz = createGzip({ level: 6 });
  const out = createWriteStream(file, { mode: 0o600 });
  let cipher: import('node:crypto').CipherGCM | null = null;
  if (opts.passphrase) {
    const salt = randomBytes(16), iv = randomBytes(12);
    cipher = createCipheriv('aes-256-gcm', keyFor(opts.passphrase, salt), iv) as import('node:crypto').CipherGCM;
    out.write(Buffer.concat([MAGIC, salt, iv]));
    gz.pipe(cipher);
    cipher.on('data', (b) => { if (!out.write(b)) { cipher!.pause(); out.once('drain', () => cipher!.resume()); } });
    cipher.on('end', () => { out.end(cipher!.getAuthTag()); });
  } else gz.pipe(out);
  const put = async (line: string) => { if (!gz.write(line + '\n')) await once(gz, 'drain'); };
  const write = (obj: unknown) => put(JSON.stringify(obj));
  let rows = 0;
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = await tablesOf(c);
    const migrations = (await c.query('SELECT name FROM public.schema_migrations ORDER BY name')).rows.map((r) => r.name);
    const sequences = (await c.query(`SELECT schemaname || '.' || sequencename AS name, last_value FROM pg_sequences
        WHERE schemaname <> ALL($1) ORDER BY 1`, [SKIP_SCHEMAS])).rows
      .map((r) => ({ name: r.name as string, value: String(r.last_value ?? 1), called: r.last_value !== null }));
    const header: BackupHeader = { format: BACKUP_FORMAT, createdAt: new Date().toISOString(), appVersion,
      database: (await c.query('SELECT current_database() AS d')).rows[0].d, migrations, sequences, tables };
    await write(header);
    for (const t of tables) {
      await write({ t });
      await c.query(`DECLARE bk NO SCROLL CURSOR FOR SELECT to_jsonb(x)::text AS r FROM ${ident(t)} x`);
      for (;;) {
        const batch = (await c.query('FETCH 2000 FROM bk')).rows;
        if (!batch.length) break;
        // Rows stay as PostgreSQL wrote them: parsing them in JavaScript would turn 9.000 into 9 and round big numbers.
        for (const b of batch) await put(`{"r":${b.r}}`);
        rows += batch.length;
      }
      await c.query('CLOSE bk');
    }
    await write({ end: true, rows });
    await c.query('COMMIT');
    gz.end();
    await once(out, 'close');
    return { file, bytes: statSync(file).size, tables: tables.length, rows, createdAt: header.createdAt, encrypted: !!cipher };
  } catch (err) {
    gz.destroy(); out.destroy();
    throw err;
  } finally {
    await c.end().catch(() => {});
  }
}

const ROW = '{"r":';
/** The lines of a backup; a row comes back as its JSON text ({ raw }), untouched. */
async function* lines(file: string, passphrase?: string): AsyncGenerator<any> {
  const src = rawStream(file, passphrase);
  const gunzip = createGunzip();
  src.on('error', (e) => gunzip.destroy(e));
  const rl = createInterface({ input: src.pipe(gunzip), crlfDelay: Infinity });
  for await (const l of rl) {
    if (!l) continue;
    if (l.startsWith(ROW)) yield { raw: l.slice(ROW.length, -1) };
    else yield JSON.parse(l);
  }
}

/** The heading of a backup file, after checking it is one. */
export async function readBackupHeader(file: string, passphrase?: string): Promise<BackupHeader> {
  if (isEncrypted(file) && !passphrase) throw new Error('this backup is encrypted; give its passphrase');
  try {
    for await (const h of lines(file, passphrase)) {
      if (h?.format !== BACKUP_FORMAT) break;
      return h as BackupHeader;
    }
  } catch { /* not gzip or not JSON, or the wrong passphrase */ }
  throw new Error(isEncrypted(file) ? 'the passphrase is wrong, or the backup was changed' : 'this file is not a BAATS backup');
}

async function applyMigrations(c: pg.Client, dir: string, only?: Set<string>): Promise<string[]> {
  await c.query('CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await c.query('SELECT name FROM public.schema_migrations')).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f) || (only && !only.has(f))) continue;
    await c.query('BEGIN');
    try {
      await c.query(readFileSync(join(dir, f), 'utf8'));
      await c.query('INSERT INTO public.schema_migrations (name) VALUES ($1)', [f]);
      await c.query('COMMIT');
      applied.push(f);
    } catch (err) {
      await c.query('ROLLBACK');
      throw new Error(`database update ${f} failed: ${(err as Error).message}`);
    }
  }
  return applied;
}

export interface RestoreOptions {
  /** Owner connection to any other database of the cluster, used to create, rename and drop databases. */
  adminUrl: string;
  /** Builds an owner connection string to a database of the cluster by name. */
  urlFor: (database: string) => string;
  /** The database to replace, for example baats. */
  database: string;
  file: string;
  migrationsDir: string;
  /** For an encrypted backup. */
  passphrase?: string;
  /** Called with progress messages. */
  log?: (msg: string) => void;
}

/** Build the database the backup describes into an empty database (connection c); returns the rows loaded and the newer migrations applied. */
async function buildFrom(c: pg.Client, header: BackupHeader, o: Pick<RestoreOptions, 'file' | 'migrationsDir' | 'passphrase' | 'log'>) {
  const log = o.log ?? (() => {});
  let rows = 0;
  log('Building the database structure of the backup...');
  await applyMigrations(c, o.migrationsDir, new Set(header.migrations));
  // Triggers (audit capture, immutability, numbering) stay off while rows go back as they were.
  await c.query("SET session_replication_role = 'replica'");
  const tables = await tablesOf(c);
  const missing = header.tables.filter((t) => !tables.includes(t));
  if (missing.length) throw new Error(`the backup has tables this database does not: ${missing.slice(0, 5).join(', ')}`);
  await c.query('BEGIN');
  await c.query(`TRUNCATE ${tables.map(ident).join(', ')}`);
  let table = '', batch: string[] = [], ended = false;
  const flush = async () => {
    if (!batch.length) return;
    await c.query(`INSERT INTO ${ident(table)} SELECT * FROM jsonb_populate_recordset(NULL::${ident(table)}, $1::jsonb)`, [`[${batch.join(',')}]`]);
    rows += batch.length; batch = [];
  };
  log('Loading the data...');
  let first = true;
  for await (const l of lines(o.file, o.passphrase)) {
    if (first) { first = false; continue; }
    if (l.t) { await flush(); table = l.t; continue; }
    if (l.end) { await flush(); ended = true; if (l.rows !== rows) throw new Error(`the backup holds ${l.rows} rows but ${rows} were read`); break; }
    batch.push(l.raw);
    if (batch.length >= 1000) await flush();
  }
  if (!ended) throw new Error('the backup file is incomplete');
  for (const s of header.sequences) await c.query('SELECT setval($1::regclass, $2::bigint, $3)', [s.name, s.value, s.called]);
  await c.query('COMMIT');
  await c.query("SET session_replication_role = 'origin'");
  const newer = await applyMigrations(c, o.migrationsDir);
  if (newer.length) log(`Updated the restored data to this version: ${newer.join(', ')}`);
  return { rows, newer };
}

function checkVersion(header: BackupHeader, migrationsDir: string) {
  const known = new Set(readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')));
  if (header.migrations.some((m) => !known.has(m))) throw new Error(`this backup was made by a newer BAATS (${header.appVersion}); install that version or later to restore it`);
}

/**
 * Restore a backup in place of options.database. Returns the name the
 * replaced database is kept under. Nothing is changed if any step before the
 * swap fails: the half-built database is dropped.
 */
export async function restoreDatabase(o: RestoreOptions): Promise<{ keptAs: string; header: BackupHeader; rows: number; newerMigrations: string[] }> {
  const log = o.log ?? (() => {});
  const header = await readBackupHeader(o.file, o.passphrase);
  checkVersion(header, o.migrationsDir);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const temp = `${o.database}_restoring_${stamp}`, keptAs = `${o.database}_before_restore_${stamp}`;
  const admin = new pg.Client({ connectionString: o.adminUrl });
  await admin.connect();
  let built = false;
  try {
    await admin.query(`CREATE DATABASE ${ident(temp)}`);
    built = true;
    const c = new pg.Client({ connectionString: o.urlFor(temp) });
    await c.connect();
    let rows = 0, newer: string[] = [];
    try {
      ({ rows, newer } = await buildFrom(c, header, o));
    } finally {
      await c.end().catch(() => {});
    }
    log('Putting the restored database in place...');
    // No new connections while the old database is renamed; the server reconnects to the new one by name.
    await admin.query(`ALTER DATABASE ${ident(o.database)} WITH ALLOW_CONNECTIONS false`);
    try {
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [o.database]);
      await admin.query(`ALTER DATABASE ${ident(o.database)} RENAME TO ${ident(keptAs)}`);
    } catch (err) {
      await admin.query(`ALTER DATABASE ${ident(o.database)} WITH ALLOW_CONNECTIONS true`).catch(() => {});
      throw err;
    }
    built = false;
    await admin.query(`ALTER DATABASE ${ident(temp)} RENAME TO ${ident(o.database)}`);
    return { keptAs, header, rows, newerMigrations: newer };
  } catch (err) {
    if (built) await admin.query(`DROP DATABASE IF EXISTS ${ident(temp)} WITH (FORCE)`).catch(() => {});
    throw err;
  } finally {
    await admin.end().catch(() => {});
  }
}

/** Databases kept by earlier restores, oldest first. */
export async function keptDatabases(adminUrl: string, database: string): Promise<string[]> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    return (await c.query(`SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY datname`, [`${database}_before_restore_%`])).rows.map((r) => r.datname);
  } finally { await c.end(); }
}

export interface DrillReport {
  file: string; createdAt: string; appVersion: string; ok: boolean; rows: number; tables: number; seconds: number;
  tenants: { code: string; auditEntries: number; auditChainOk: boolean; unbalancedJournals: number }[];
  problems: string[];
}

/**
 * A restore drill: the backup is restored into a scratch database beside the
 * live one, which is never touched, and checked there. Every organization's
 * audit hash chain is recomputed and every posted journal must balance. The
 * scratch database is dropped afterwards, whatever happens.
 */
export async function verifyBackup(o: Omit<RestoreOptions, 'database'> & { database: string }): Promise<DrillReport> {
  const t0 = Date.now();
  const header = await readBackupHeader(o.file, o.passphrase);
  checkVersion(header, o.migrationsDir);
  const scratch = `${o.database}_drill_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  const admin = new pg.Client({ connectionString: o.adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${ident(scratch)}`);
    const c = new pg.Client({ connectionString: o.urlFor(scratch) });
    await c.connect();
    try {
      const { rows } = await buildFrom(c, header, { ...o, log: o.log });
      (o.log ?? (() => {}))('Checking the restored data...');
      const report: DrillReport = { file: o.file, createdAt: header.createdAt, appVersion: header.appVersion, ok: true, rows, tables: header.tables.length,
        seconds: 0, tenants: [], problems: [] };
      for (const t of (await c.query('SELECT id, code FROM platform.tenants ORDER BY code')).rows) {
        let prev = '0'.repeat(64), last = 0, n = 0, chainOk = true;
        for (;;) {
          const batch = (await c.query(`SELECT seq, prev_hash, hash, audit.payload(e) AS payload FROM audit.entries e WHERE tenant_id = $1 AND seq > $2 ORDER BY seq LIMIT 5000`, [t.id, last])).rows;
          if (!batch.length) break;
          for (const r of batch) {
            if (Number(r.seq) !== last + 1 || r.prev_hash !== prev || r.hash !== createHash('sha256').update(r.payload, 'utf8').digest('hex')) { chainOk = false; break; }
            prev = r.hash; last = Number(r.seq); n++;
          }
          if (!chainOk) break;
        }
        const unbalanced = Number((await c.query(`SELECT count(*) AS n FROM (SELECT j.id FROM fin.journals j JOIN fin.journal_lines l ON l.journal_id = j.id
            WHERE j.tenant_id = $1 AND j.status = 'posted' GROUP BY j.id HAVING sum(l.debit) <> sum(l.credit)) x`, [t.id])).rows[0].n);
        report.tenants.push({ code: t.code, auditEntries: n, auditChainOk: chainOk, unbalancedJournals: unbalanced });
        if (!chainOk) report.problems.push(`${t.code}: the audit trail's hash chain breaks after entry ${last}`);
        if (unbalanced) report.problems.push(`${t.code}: ${unbalanced} posted journals do not balance`);
      }
      report.ok = !report.problems.length;
      report.seconds = Math.round((Date.now() - t0) / 100) / 10;
      return report;
    } finally {
      await c.end().catch(() => {});
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${ident(scratch)} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
}
