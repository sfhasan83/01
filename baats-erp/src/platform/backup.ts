import { createReadStream, createWriteStream, readdirSync, readFileSync, statSync } from 'node:fs';
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
 */

export const BACKUP_FORMAT = 'baats-backup/1';
const SKIP_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];

export interface BackupHeader {
  format: string; createdAt: string; appVersion: string; database: string;
  migrations: string[]; sequences: { name: string; value: string; called: boolean }[]; tables: string[];
}
export interface BackupResult { file: string; bytes: number; tables: number; rows: number; createdAt: string }

const ident = (q: string) => q.split('.').map((p) => `"${p.replace(/"/g, '""')}"`).join('.');

async function tablesOf(c: pg.Client): Promise<string[]> {
  return (await c.query(`SELECT n.nspname || '.' || c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname <> ALL($1) AND n.nspname NOT LIKE 'pg_temp%'
        AND NOT (n.nspname = 'public' AND c.relname = 'schema_migrations') ORDER BY 1`, [SKIP_SCHEMAS])).rows.map((r) => r.t);
}

/** Write a backup of the database at ownerUrl to file. */
export async function backupDatabase(ownerUrl: string, file: string, appVersion: string): Promise<BackupResult> {
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  const gz = createGzip({ level: 6 });
  const out = createWriteStream(file, { mode: 0o600 });
  gz.pipe(out);
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
    return { file, bytes: statSync(file).size, tables: tables.length, rows, createdAt: header.createdAt };
  } catch (err) {
    gz.destroy(); out.destroy();
    throw err;
  } finally {
    await c.end().catch(() => {});
  }
}

const ROW = '{"r":';
/** The lines of a backup; a row comes back as its JSON text ({ raw }), untouched. */
async function* lines(file: string): AsyncGenerator<any> {
  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const l of rl) {
    if (!l) continue;
    if (l.startsWith(ROW)) yield { raw: l.slice(ROW.length, -1) };
    else yield JSON.parse(l);
  }
}

/** The heading of a backup file, after checking it is one. */
export async function readBackupHeader(file: string): Promise<BackupHeader> {
  try {
    for await (const h of lines(file)) {
      if (h?.format !== BACKUP_FORMAT) break;
      return h as BackupHeader;
    }
  } catch { /* not gzip or not JSON */ }
  throw new Error('this file is not a BAATS backup');
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
  /** Called with progress messages. */
  log?: (msg: string) => void;
}

/**
 * Restore a backup in place of options.database. Returns the name the
 * replaced database is kept under. Nothing is changed if any step before the
 * swap fails: the half-built database is dropped.
 */
export async function restoreDatabase(o: RestoreOptions): Promise<{ keptAs: string; header: BackupHeader; rows: number; newerMigrations: string[] }> {
  const log = o.log ?? (() => {});
  const header = await readBackupHeader(o.file);
  const known = new Set(readdirSync(o.migrationsDir).filter((x) => x.endsWith('.sql')));
  const unknown = header.migrations.filter((m) => !known.has(m));
  if (unknown.length) throw new Error(`this backup was made by a newer BAATS (${header.appVersion}); install that version or later to restore it`);
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
      for await (const l of lines(o.file)) {
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
      newer = await applyMigrations(c, o.migrationsDir);
      if (newer.length) log(`Updated the restored data to this version: ${newer.join(', ')}`);
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
