import pg from 'pg';
import { ForbiddenError, fromPg } from './errors.ts';
import { moneyScope } from './money.ts';

// Ledger dates are calendar dates. node-postgres turns a date column into a
// Date at local midnight, so on a computer east of UTC (Dubai is UTC+4) the
// ISO string of it would be the day before. The server works in UTC.
process.env.TZ = 'UTC';

export type Tx = pg.PoolClient;

/** Who is acting, and for which tenant. userId is null for system work such as login. */
export interface Ctx {
  tenantId: string;
  userId: string | null;
}

export class Db {
  readonly pool: pg.Pool;
  constructor(config: pg.PoolConfig) {
    this.pool = new pg.Pool({ max: 20, ...config });
  }

  /**
   * Run fn in one transaction bound to a tenant. Row-level security in PostgreSQL
   * limits every statement to that tenant, and the audit trail records ctx.userId.
   * An access denial is rolled back and then written to the audit trail on its own.
   */
  async withTenant<T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>): Promise<T> {
    // A deadlock or serialization failure rolls the whole transaction back, so
    // it is safe to run it again; PostgreSQL has already picked one side to lose.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once(ctx, fn);
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if ((code !== '40P01' && code !== '40001') || attempt >= 3) throw fromPg(err);
        await new Promise((r) => setTimeout(r, 20 * attempt + Math.random() * 30));
      }
    }
  }

  private async once<T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`,
        [ctx.tenantId, ctx.userId ?? '']);
      // Each transaction has its own money precision; loading a company's books sets it.
      const result = await moneyScope(() => fn(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (err instanceof ForbiddenError) await this.recordDenial(ctx, err);
      throw err;
    } finally {
      client.release();
    }
  }

  private async recordDenial(ctx: Ctx, err: ForbiddenError): Promise<void> {
    await this.withTenant(ctx, (tx) =>
      tx.query(`SELECT audit.append('security','access_denied','permission',$1,NULL,$2)`,
        [err.permission, JSON.stringify({ resource: err.resource ?? null, reason: err.message })]),
    ).catch(() => undefined);
  }

  close(): Promise<void> { return this.pool.end(); }
}

export async function one<T = any>(tx: Tx, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const r = await tx.query(sql, params);
  return r.rows[0] as T | undefined;
}

export async function many<T = any>(tx: Tx, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await tx.query(sql, params);
  return r.rows as T[];
}
