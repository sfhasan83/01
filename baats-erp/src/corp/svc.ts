import { emit } from '../int/webhooks.ts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize, decide, unitScope } from '../iam/authz.ts';
import { createWorkOrder } from '../mnt/service.ts';

/**
 * Service desk for IT, facilities, HR and finance requests. Anyone signed in can
 * raise a ticket; agents (svc.agent on the requester's unit) work it. Priority
 * sets two SLA clocks, first response and resolution. A facilities or IT ticket
 * about a fixed asset can be turned into a maintenance work order, so the repair
 * and its spare parts are costed in maintenance.
 */

export const SLA_HOURS: Record<number, { response: number; resolution: number }> = {
  1: { response: 1, resolution: 4 }, 2: { response: 4, resolution: 8 }, 3: { response: 8, resolution: 24 }, 4: { response: 24, resolution: 72 },
};

/** Gap-free yearly numbers for tenant-wide records (tickets, incidents). */
export async function tenantNumber(tx: Tx, table: string, prefix: string, at: Date): Promise<string> {
  const year = at.getUTCFullYear();
  await tx.query('SELECT pg_advisory_xact_lock(hashtext(app.tenant()::text || $1))', [table]);
  const r = await one(tx, `SELECT coalesce(max(substr(no, ${prefix.length + 7})::int), 0) + 1 AS n FROM ${table} WHERE no LIKE $1`, [`${prefix}-${year}-%`]);
  return `${prefix}-${year}-${String(r.n).padStart(5, '0')}`;
}

async function isAgent(tx: Tx, ctx: Ctx, unitId: string | null) {
  return (await decide(tx, ctx.userId!, 'svc.agent', unitId ? { unitId } : {})).allowed;
}

export async function createTicket(tx: Tx, ctx: Ctx, input: { queue: string; category: string; priority: number; title: string; description: string;
  assetId?: string; spaceId?: string; now?: Date }) {
  const me = await one(tx, 'SELECT u.employee_id, e.unit_id FROM iam.users u LEFT JOIN org.employees e ON e.id = u.employee_id WHERE u.id = $1', [ctx.userId]);
  if (!me) throw new ForbiddenError('svc.ticket', {}, 'sign in to raise a ticket');
  const now = input.now ?? new Date();
  const sla = SLA_HOURS[input.priority];
  if (!sla) throw new ValidationError('priority is 1 (critical) to 4 (low)');
  const no = await tenantNumber(tx, 'svc.tickets', 'TKT', now);
  const t = await one(tx, `INSERT INTO svc.tickets (tenant_id, no, queue, category, priority, title, description, requester_user_id, unit_id, asset_id, space_id,
                    response_due, resolution_due, created_at)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
    [no, input.queue, input.category, input.priority, input.title, input.description, ctx.userId, me.unit_id ?? null, input.assetId ?? null, input.spaceId ?? null,
      new Date(now.getTime() + sla.response * 3600e3), new Date(now.getTime() + sla.resolution * 3600e3), now]);
  await emit(tx, 'ticket.created', null, { ticket_id: t.id, no: t.no, queue: t.queue, category: t.category, priority: t.priority, title: t.title,
    resolution_due: t.resolution_due });
  return t;
}

async function ticket(tx: Tx, id: string) {
  const t = await one(tx, 'SELECT * FROM svc.tickets WHERE id = $1 FOR UPDATE', [id]);
  if (!t) throw new NotFoundError('ticket');
  return t;
}

export async function assignTicket(tx: Tx, ctx: Ctx, id: string, input: { assigneeUserId?: string; now?: Date }) {
  const t = await ticket(tx, id);
  await authorize(tx, ctx, 'svc.agent', t.unit_id ? { unitId: t.unit_id } : {});
  if (['resolved', 'closed'].includes(t.status)) throw new ConflictError(`the ticket is ${t.status}`);
  const who = input.assigneeUserId ?? ctx.userId!;
  if (!(await decide(tx, who, 'svc.agent', t.unit_id ? { unitId: t.unit_id } : {})).allowed) throw new ValidationError('that person is not a service desk agent for this requester');
  return one(tx, `UPDATE svc.tickets SET assignee_user_id = $2, status = CASE WHEN status = 'new' THEN 'assigned' ELSE status END WHERE id = $1 RETURNING *`, [id, who]);
}

/** The requester and agents can comment. An agent's first public reply stops the response clock. */
export async function addComment(tx: Tx, ctx: Ctx, id: string, input: { body: string; internal?: boolean; now?: Date }) {
  const t = await ticket(tx, id);
  const agent = await isAgent(tx, ctx, t.unit_id);
  if (!agent && t.requester_user_id !== ctx.userId) throw new ForbiddenError('svc.agent', { unitId: t.unit_id }, 'not your ticket');
  if (input.internal && !agent) throw new ValidationError('only agents can add internal notes');
  if (t.status === 'closed') throw new ConflictError('the ticket is closed');
  const now = input.now ?? new Date();
  const c = await one(tx, `INSERT INTO svc.comments (tenant_id, ticket_id, author_user_id, body, internal, created_at) VALUES (app.tenant(), $1, $2, $3, $4, $5) RETURNING *`,
    [id, ctx.userId, input.body, input.internal ?? false, now]);
  if (agent && !input.internal && t.requester_user_id !== ctx.userId && !t.first_response_at) {
    await tx.query('UPDATE svc.tickets SET first_response_at = $2 WHERE id = $1', [id, now]);
  }
  if (!agent && t.status === 'waiting') await tx.query(`UPDATE svc.tickets SET status = 'in_progress' WHERE id = $1`, [id]);
  return c;
}

export async function setTicketStatus(tx: Tx, ctx: Ctx, id: string, input: { status: 'in_progress' | 'waiting' | 'resolved'; resolution?: string; now?: Date }) {
  const t = await ticket(tx, id);
  await authorize(tx, ctx, 'svc.agent', t.unit_id ? { unitId: t.unit_id } : {});
  if (t.status === 'closed') throw new ConflictError('the ticket is closed');
  const now = input.now ?? new Date();
  if (input.status === 'resolved') {
    if (!input.resolution?.trim()) throw new ValidationError('describe the resolution');
    if (t.maintenance_order_id) {
      const w = await one(tx, 'SELECT status, no FROM mnt.work_orders WHERE id = $1', [t.maintenance_order_id]);
      if (!['done', 'cancelled'].includes(w.status)) throw new ConflictError(`maintenance work order ${w.no} is still ${w.status}`);
    }
  }
  return one(tx, `UPDATE svc.tickets SET status = $2, resolution = coalesce($3, resolution),
      resolved_at = CASE WHEN $2 = 'resolved' THEN $4::timestamptz ELSE NULL END,
      first_response_at = coalesce(first_response_at, $4::timestamptz),
      assignee_user_id = coalesce(assignee_user_id, $5) WHERE id = $1 RETURNING *`,
    [id, input.status, input.resolution ?? null, now, ctx.userId]);
}

/** The requester confirms (with a rating) and the ticket closes, or reopens it. */
export async function confirmTicket(tx: Tx, ctx: Ctx, id: string, input: { accepted: boolean; satisfaction?: number; comment?: string }) {
  const t = await ticket(tx, id);
  if (t.requester_user_id !== ctx.userId) throw new ForbiddenError('svc.ticket', {}, 'only the requester can confirm the resolution');
  if (t.status !== 'resolved') throw new ConflictError('the ticket is not resolved');
  if (input.accepted) return one(tx, `UPDATE svc.tickets SET status = 'closed', satisfaction = $2 WHERE id = $1 RETURNING *`, [id, input.satisfaction ?? null]);
  if (input.comment) await addComment(tx, ctx, id, { body: `Reopened: ${input.comment}` });
  return one(tx, `UPDATE svc.tickets SET status = 'in_progress', resolved_at = NULL WHERE id = $1 RETURNING *`, [id]);
}

/** Send the repair to maintenance: a corrective work order on the ticket's asset. */
export async function raiseMaintenance(tx: Tx, ctx: Ctx, id: string, input: { scheduledDate: string; priority?: string }) {
  const t = await ticket(tx, id);
  await authorize(tx, ctx, 'svc.agent', t.unit_id ? { unitId: t.unit_id } : {});
  if (!t.asset_id) throw new ValidationError('the ticket is not about a fixed asset');
  if (t.maintenance_order_id) throw new ConflictError('a maintenance work order was already raised');
  const a = await one(tx, 'SELECT company_id FROM fin.assets WHERE id = $1', [t.asset_id]);
  const pri = input.priority ?? ({ 1: 'urgent', 2: 'high', 3: 'normal', 4: 'low' } as Record<number, string>)[t.priority];
  const w = await createWorkOrder(tx, ctx, { companyId: a.company_id, assetId: t.asset_id, kind: t.priority <= 2 ? 'breakdown' : 'corrective', priority: pri,
    description: `${t.no}: ${t.title}`, scheduledDate: input.scheduledDate });
  await tx.query(`UPDATE svc.tickets SET maintenance_order_id = $2, status = 'in_progress', first_response_at = coalesce(first_response_at, now()) WHERE id = $1`, [id, w.id]);
  return w;
}

const breach = (now: Date) => `
  (t.first_response_at IS NULL AND t.response_due < '${now.toISOString()}') OR t.first_response_at > t.response_due AS response_breached,
  (t.resolved_at IS NULL AND t.resolution_due < '${now.toISOString()}') OR t.resolved_at > t.resolution_due AS resolution_breached`;

export async function getTicket(tx: Tx, ctx: Ctx, id: string, now = new Date()) {
  const t = await one(tx, `SELECT t.*, ${breach(now)}, r.display_name AS requester, g.display_name AS assignee, a.code AS asset_code, w.no AS maintenance_no
                             FROM svc.tickets t JOIN iam.users r ON r.id = t.requester_user_id LEFT JOIN iam.users g ON g.id = t.assignee_user_id
                             LEFT JOIN fin.assets a ON a.id = t.asset_id LEFT JOIN mnt.work_orders w ON w.id = t.maintenance_order_id WHERE t.id = $1`, [id]);
  if (!t) throw new NotFoundError('ticket');
  const agent = await isAgent(tx, ctx, t.unit_id);
  if (!agent && t.requester_user_id !== ctx.userId) throw new ForbiddenError('svc.agent', { unitId: t.unit_id }, 'not your ticket');
  t.comments = await many(tx, `SELECT c.*, u.display_name AS author FROM svc.comments c JOIN iam.users u ON u.id = c.author_user_id
                                WHERE c.ticket_id = $1 AND ($2 OR NOT c.internal) ORDER BY c.created_at`, [id, agent]);
  return t;
}

/** Agents see the queues of the units they serve; everyone sees their own tickets. */
export async function listTickets(tx: Tx, ctx: Ctx, f: { queue?: string; status?: string; mine?: boolean } = {}, now = new Date()) {
  const s = await unitScope(tx, ctx.userId!, 'svc.agent', 't.unit_id', 1);
  const tenantWide = (await decide(tx, ctx.userId!, 'svc.agent', {})).allowed;
  return many(tx, `SELECT t.*, ${breach(now)}, r.display_name AS requester, g.display_name AS assignee
                     FROM svc.tickets t JOIN iam.users r ON r.id = t.requester_user_id LEFT JOIN iam.users g ON g.id = t.assignee_user_id
                    WHERE (t.requester_user_id = $2 OR (NOT $3 AND (${s.sql} OR ($4 AND t.unit_id IS NULL))))
                      AND ($5::text IS NULL OR t.queue = $5) AND ($6::text IS NULL OR t.status = $6)
                    ORDER BY t.status IN ('resolved','closed'), t.priority, t.created_at LIMIT 500`,
    [s.param, ctx.userId, f.mine ?? false, tenantWide, f.queue ?? null, f.status ?? null]);
}

/** SLA performance for a period. */
export async function slaReport(tx: Tx, ctx: Ctx, from: string, to: string, now = new Date()) {
  await authorize(tx, ctx, 'svc.agent', {});
  const rows = await many(tx, `SELECT t.queue, count(*)::int AS tickets,
        count(*) FILTER (WHERE t.status IN ('resolved','closed'))::int AS resolved,
        count(*) FILTER (WHERE (t.first_response_at IS NULL AND t.response_due < $3) OR t.first_response_at > t.response_due)::int AS response_breaches,
        count(*) FILTER (WHERE (t.resolved_at IS NULL AND t.resolution_due < $3) OR t.resolved_at > t.resolution_due)::int AS resolution_breaches,
        round(avg(extract(epoch FROM t.resolved_at - t.created_at) / 3600)::numeric, 1)::float AS avg_resolution_hours,
        round(avg(t.satisfaction)::numeric, 2)::float AS satisfaction
      FROM svc.tickets t WHERE t.created_at >= $1::date AND t.created_at < $2::date + 1 GROUP BY t.queue ORDER BY t.queue`, [from, to, now]);
  return rows.map((r) => ({ ...r, slaMetPct: r.tickets ? Math.round((1 - r.resolution_breaches / r.tickets) * 1000) / 10 : null }));
}
