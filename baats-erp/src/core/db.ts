import pg from 'pg';
import { ForbiddenError, fromPg } from './errors.ts';

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
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`,
        [ctx.tenantId, ctx.userId ?? '']);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (err instanceof ForbiddenError) await this.recordDenial(ctx, err);
      throw fromPg(err);
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
