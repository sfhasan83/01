import { createHash } from 'node:crypto';
import { many, type Ctx, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';

/**
 * Audit engine. Entries are written only by the database (row triggers and
 * audit.append), cannot be updated or deleted, and form a SHA-256 hash chain
 * per tenant, so any tampering with stored history is detectable.
 */

export async function queryAudit(tx: Tx, ctx: Ctx, f: {
  entityType?: string; entityId?: string; category?: string; actorUserId?: string; from?: string; to?: string; limit?: number; beforeSeq?: number;
} = {}) {
  await authorize(tx, ctx, 'audit.read');
  return many(tx, `SELECT seq, occurred_at, actor_user_id, category, action, entity_type, entity_id, before, after
                     FROM audit.entries
                    WHERE ($1::text IS NULL OR entity_type = $1) AND ($2::text IS NULL OR entity_id = $2)
                      AND ($3::text IS NULL OR category = $3) AND ($4::uuid IS NULL OR actor_user_id = $4)
                      AND ($5::timestamptz IS NULL OR occurred_at >= $5) AND ($6::timestamptz IS NULL OR occurred_at < $6)
                      AND ($8::bigint IS NULL OR seq < $8)
                    ORDER BY seq DESC LIMIT $7`,
    [f.entityType ?? null, f.entityId ?? null, f.category ?? null, f.actorUserId ?? null, f.from ?? null, f.to ?? null,
      Math.min(f.limit ?? 100, 1000), f.beforeSeq ?? null]);
}

export interface ChainReport { entries: number; valid: boolean; firstBrokenSeq: number | null }

/**
 * Recompute the hash chain. The database supplies each entry's canonical text
 * (audit.payload), and the hash is recomputed here independently of the database.
 */
export async function verifyChain(tx: Tx, ctx: Ctx): Promise<ChainReport> {
  await authorize(tx, ctx, 'audit.verify');
  let prev = '0'.repeat(64);
  let count = 0;
  let lastSeq = 0;
  for (;;) {
    const rows = await many(tx, `SELECT seq, prev_hash, hash, audit.payload(e) AS payload
                                   FROM audit.entries e WHERE seq > $1 ORDER BY seq LIMIT 5000`, [lastSeq]);
    if (rows.length === 0) break;
    for (const r of rows) {
      const expectedSeq = lastSeq + 1;
      const computed = createHash('sha256').update(r.payload, 'utf8').digest('hex');
      if (Number(r.seq) !== expectedSeq || r.prev_hash !== prev || r.hash !== computed) {
        return { entries: count, valid: false, firstBrokenSeq: expectedSeq };
      }
      prev = r.hash;
      lastSeq = Number(r.seq);
      count++;
    }
  }
  return { entries: count, valid: true, firstBrokenSeq: null };
}
