import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = new URL('../../db/migrations/', import.meta.url).pathname;

/**
 * Apply pending SQL migrations in file-name order, each in its own transaction.
 * Runs as the schema owner. If appPassword is given, the runtime role baats_app
 * is allowed to log in with it.
 */
export async function migrate(connectionString: string, appPassword?: string): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM public.schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    if (appPassword) {
      await client.query(`ALTER ROLE baats_app LOGIN PASSWORD ${client.escapeLiteral(appPassword)}`);
    }
  } finally {
    await client.end();
  }
  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) { console.error('MIGRATION_DATABASE_URL is required'); process.exit(1); }
  const applied = await migrate(url, process.env.APP_DB_PASSWORD);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
}
