import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Db, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';
import { open, seal } from '../ai/secrets.ts';

/**
 * Webhooks: other systems subscribe to business events and BAATS posts each one
 * to them, signed, and retries until it is accepted.
 *
 * Events are written by emit() inside the transaction that made the change (an
 * outbox), together with one delivery per subscribed webhook. So an event is sent
 * exactly when its change was committed, and never for a change rolled back. The
 * dispatcher claims due deliveries in a short transaction, sends them outside any
 * transaction, and records the outcome; a failure is retried with growing gaps
 * (1, 2, 4 ... minutes, at most 6 hours apart) and given up after 8 attempts.
 *
 * Each request carries X-BAATS-Event, X-BAATS-Delivery and
 * X-BAATS-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>"> with the
 * webhook's secret, so the receiver can check it came from BAATS and is fresh.
 */

export const EVENT_TYPES = {
  'invoice.posted': 'A sales or purchase invoice or credit note was posted',
  'payment.recorded': 'A customer receipt or supplier payment was recorded',
  'payroll.posted': 'A month\'s payroll was posted to the ledger',
  'expense.approved': 'An expense claim was approved and posted',
  'expense.paid': 'An approved expense claim was paid to the employee',
  'leave.approved': 'A leave request was approved',
  'ticket.created': 'A service desk ticket was raised',
} as const;
export type EventType = keyof typeof EVENT_TYPES;

export const MAX_ATTEMPTS = 8;
const TIMEOUT_MS = 10_000;

export interface WebhookOptions { secretKey: Buffer | null; allowPrivateUrls: boolean }

/** Record a business event and queue it for every active webhook that subscribes to it. */
export async function emit(tx: Tx, type: EventType, companyId: string | null, data: Record<string, unknown>): Promise<void> {
  const hooks = await many(tx, 'SELECT id FROM int.webhooks WHERE active AND $1 = ANY(events)', [type]);
  if (!hooks.length) return;   // nobody listens: nothing to keep
  const e = await one(tx, `INSERT INTO int.events (tenant_id, type, company_id, payload) VALUES (app.tenant(), $1, $2, $3) RETURNING id, created_at`,
    [type, companyId, JSON.stringify(data)]);
  for (const h of hooks) {
    await tx.query('INSERT INTO int.deliveries (tenant_id, webhook_id, event_id) VALUES (app.tenant(), $1, $2)', [h.id, e.id]);
  }
}

/** Refuse addresses that would let a tenant make the server call into its own network. */
export function checkWebhookUrl(raw: string, allowPrivate: boolean): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new ValidationError('the webhook address is not a valid URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ValidationError('the webhook address must start with https://');
  if (u.username || u.password) throw new ValidationError('do not put a user name or password in the webhook address');
  if (allowPrivate) return u.toString();
  if (u.protocol !== 'https:') throw new ValidationError('the webhook address must use https');
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const privateV4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')
    || (isIP(h) === 4 && privateV4.test(h)) || (isIP(h) === 6 && (h === '::1' || /^(fc|fd|fe80)/.test(h) || h.startsWith('::ffff:')))) {
    throw new ValidationError('this server does not send webhooks to a private or local address');
  }
  return u.toString();
}

/** At send time, also refuse a public name that resolves to a private address. */
async function checkResolved(url: string, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return;
  const addrs = await lookup(host, { all: true });
  for (const a of addrs) checkWebhookUrl(`https://${a.family === 6 ? `[${a.address}]` : a.address}/`, false);
}

const checkEvents = (events: string[]) => {
  if (!events.length) throw new ValidationError('choose at least one event');
  const bad = events.filter((e) => !(e in EVENT_TYPES));
  if (bad.length) throw new ValidationError(`unknown event ${bad.join(', ')}; the events are ${Object.keys(EVENT_TYPES).join(', ')}`);
  return [...new Set(events)];
};

/** Add a webhook. The signing secret is returned once, here, and kept sealed. */
export async function createWebhook(tx: Tx, ctx: Ctx, opts: WebhookOptions, input: { name: string; url: string; events: string[] }) {
  await authorize(tx, ctx, 'int.manage');
  const url = checkWebhookUrl(input.url, opts.allowPrivateUrls);
  const events = checkEvents(input.events);
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  const sealed = seal(opts.secretKey, secret);
  const w = await one(tx, `INSERT INTO int.webhooks (tenant_id, name, url, events, created_by) VALUES (app.tenant(), $1, $2, $3, $4)
    RETURNING id, name, url, events, active, created_at`, [input.name, url, events, ctx.userId]);
  await tx.query('INSERT INTO int.webhook_secrets (tenant_id, webhook_id, sealed) VALUES (app.tenant(), $1, $2)', [w.id, sealed]);
  return { ...w, secret };
}

export async function updateWebhook(tx: Tx, ctx: Ctx, opts: WebhookOptions, id: string, input: { name?: string; url?: string; events?: string[]; active?: boolean }) {
  await authorize(tx, ctx, 'int.manage');
  const w = await one(tx, 'SELECT * FROM int.webhooks WHERE id = $1', [id]);
  if (!w) throw new NotFoundError('webhook');
  return one(tx, `UPDATE int.webhooks SET name = $2, url = $3, events = $4, active = $5 WHERE id = $1 RETURNING id, name, url, events, active, created_at`,
    [id, input.name ?? w.name, input.url ? checkWebhookUrl(input.url, opts.allowPrivateUrls) : w.url, input.events ? checkEvents(input.events) : w.events,
      input.active ?? w.active]);
}

export async function deleteWebhook(tx: Tx, ctx: Ctx, id: string) {
  await authorize(tx, ctx, 'int.manage');
  const r = await tx.query('DELETE FROM int.webhooks WHERE id = $1', [id]);
  if (!r.rowCount) throw new NotFoundError('webhook');
  return { deleted: true };
}

export async function listWebhooks(tx: Tx, ctx: Ctx) {
  await authorize(tx, ctx, 'int.manage');
  const hooks = await many(tx, `SELECT w.id, w.name, w.url, w.events, w.active, w.created_at,
      (SELECT count(*)::int FROM int.deliveries d WHERE d.webhook_id = w.id AND d.status = 'pending') AS pending,
      (SELECT count(*)::int FROM int.deliveries d WHERE d.webhook_id = w.id AND d.status = 'failed') AS failed,
      (SELECT max(delivered_at) FROM int.deliveries d WHERE d.webhook_id = w.id) AS last_delivered_at
    FROM int.webhooks w ORDER BY w.created_at`);
  return { events: EVENT_TYPES, webhooks: hooks };
}

export async function listDeliveries(tx: Tx, ctx: Ctx, webhookId: string, limit = 50) {
  await authorize(tx, ctx, 'int.manage');
  return many(tx, `SELECT d.id, e.type, e.created_at AS event_at, d.status, d.attempts, d.next_attempt_at, d.last_status, d.last_error, d.delivered_at, e.payload
                     FROM int.deliveries d JOIN int.events e ON e.id = d.event_id WHERE d.webhook_id = $1
                    ORDER BY e.created_at DESC LIMIT $2`, [webhookId, Math.min(Math.max(limit, 1), 200)]);
}

/** Send a failed (or still pending) delivery again now. */
export async function redeliver(tx: Tx, ctx: Ctx, deliveryId: string) {
  await authorize(tx, ctx, 'int.manage');
  const d = await one(tx, 'SELECT * FROM int.deliveries WHERE id = $1', [deliveryId]);
  if (!d) throw new NotFoundError('delivery');
  if (d.status === 'delivered') throw new ConflictError('this delivery was accepted already');
  await tx.query(`UPDATE int.deliveries SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE id = $1`, [deliveryId]);
  return { queued: true };
}

/** Queue a test event for one webhook, whatever it subscribes to. */
export async function pingWebhook(tx: Tx, ctx: Ctx, id: string) {
  await authorize(tx, ctx, 'int.manage');
  const w = await one(tx, 'SELECT id FROM int.webhooks WHERE id = $1', [id]);
  if (!w) throw new NotFoundError('webhook');
  const e = await one(tx, `INSERT INTO int.events (tenant_id, type, payload) VALUES (app.tenant(), 'ping', $1) RETURNING id`,
    [JSON.stringify({ message: 'Test event from BAATS ERP' })]);
  const d = await one(tx, 'INSERT INTO int.deliveries (tenant_id, webhook_id, event_id) VALUES (app.tenant(), $1, $2) RETURNING id', [id, e.id]);
  return { deliveryId: d.id };
}

export function sign(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Wait before attempt n+1 after n failures. */
export const backoffMs = (attempts: number) => Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 6 * 3_600_000);

/**
 * Send what is due for one tenant. Returns how many deliveries were attempted.
 * fetchImpl and now are for tests.
 */
export async function dispatchTenant(db: Db, tenantId: string, opts: WebhookOptions & { fetchImpl?: typeof fetch; now?: () => Date }): Promise<number> {
  const ctx = { tenantId, userId: null };
  const now = opts.now ?? (() => new Date());
  // Claim: push the due rows a few minutes ahead so a parallel run leaves them alone.
  const due = await db.withTenant(ctx, (tx) => many(tx, `
    UPDATE int.deliveries d SET next_attempt_at = $1::timestamptz + interval '5 minutes'
     WHERE d.id IN (SELECT id FROM int.deliveries WHERE status = 'pending' AND next_attempt_at <= $1 ORDER BY next_attempt_at LIMIT 25 FOR UPDATE SKIP LOCKED)
    RETURNING d.id, d.attempts, d.webhook_id, d.event_id`, [now()]));
  let sent = 0;
  for (const d of due) {
    const x = await db.withTenant(ctx, (tx) => one(tx, `SELECT w.url, w.active, s.sealed, e.type, e.company_id, e.payload, e.created_at
        FROM int.webhooks w JOIN int.webhook_secrets s ON s.webhook_id = w.id JOIN int.events e ON e.id = $2 WHERE w.id = $1`, [d.webhook_id, d.event_id]));
    if (!x) continue;
    let status: number | null = null, error: string | null = null;
    try {
      if (!x.active) throw new Error('the webhook is switched off');
      const url = checkWebhookUrl(x.url, opts.allowPrivateUrls);
      await checkResolved(url, opts.allowPrivateUrls);
      const body = JSON.stringify({ id: d.event_id, type: x.type, created_at: x.created_at, tenant_id: tenantId, company_id: x.company_id, data: x.payload });
      const ts = Math.floor(now().getTime() / 1000);
      const res = await (opts.fetchImpl ?? fetch)(url, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'content-type': 'application/json', 'user-agent': 'BAATS-ERP-Webhooks/1', 'x-baats-event': x.type, 'x-baats-delivery': d.id,
          'x-baats-signature': sign(open(opts.secretKey, x.sealed), ts, body) },
        body,
      });
      status = res.status;
      if (res.status < 200 || res.status >= 300) error = `the receiver answered ${res.status}`;
    } catch (err) {
      error = (err as Error).message.slice(0, 500);
    }
    sent++;
    const attempts = d.attempts + 1;
    await db.withTenant(ctx, (tx) => tx.query(error
      ? `UPDATE int.deliveries SET attempts = $2, last_status = $3, last_error = $4,
           status = CASE WHEN $2 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END, next_attempt_at = $5 WHERE id = $1`
      : `UPDATE int.deliveries SET attempts = $2, last_status = $3, last_error = $4, status = 'delivered', delivered_at = $5 WHERE id = $1`,
    [d.id, attempts, status, error, error ? new Date(now().getTime() + backoffMs(attempts)) : now()]));
  }
  return sent;
}

/** Send what is due for every active tenant (run every half minute by the server). */
export async function dispatchAll(db: Db, opts: WebhookOptions): Promise<number> {
  const ids = await db.withTenant({ tenantId: '00000000-0000-0000-0000-000000000000', userId: null },
    async (tx) => (await tx.query('SELECT platform.active_tenant_ids() AS id')).rows.map((r) => r.id as string));
  let n = 0;
  for (const id of ids) n += await dispatchTenant(db, id, opts).catch(() => 0);
  return n;
}
