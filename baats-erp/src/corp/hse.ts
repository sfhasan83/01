import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize, unitScope } from '../iam/authz.ts';
import { createAction } from './grc.ts';
import { tenantNumber } from './svc.ts';

/**
 * Health, safety and environment. Anyone can report an incident or near miss
 * (reporting must never be blocked by permissions); HSE staff investigate it,
 * record the root cause, raise corrective actions on the shared action list,
 * and close it once those actions are verified.
 *
 * Statistics follow the usual definitions: a lost-time injury (LTI) is an injury
 * with at least one day lost; LTIFR = LTIs x 1,000,000 / hours worked, and the
 * total recordable rate counts every injury the same way. Hours worked default
 * to 8 hours a day, 22 days a month, for every employee with a running contract.
 */

const d = (v: Date | string) => (typeof v === 'string' ? v : v.toISOString().slice(0, 10));

export async function reportIncident(tx: Tx, ctx: Ctx, input: { unitId: string; occurredAt: string; kind: string; severity: string; location: string;
  description: string; employeeId?: string; vehicleId?: string; lostDays?: number }) {
  const u = await one(tx, 'SELECT id FROM org.units WHERE id = $1', [input.unitId]);
  if (!u) throw new ValidationError('unknown unit');
  const at = new Date(input.occurredAt);
  if (Number.isNaN(at.getTime())) throw new ValidationError('give the date and time it happened');
  if (at.getTime() > Date.now() + 60e3) throw new ValidationError('the incident is in the future');
  if (input.kind === 'injury' && !input.employeeId) throw new ValidationError('say who was injured');
  const no = await tenantNumber(tx, 'hse.incidents', 'INC', at);
  return one(tx, `INSERT INTO hse.incidents (tenant_id, no, unit_id, occurred_at, kind, severity, location, description, employee_id, vehicle_id, lost_days, reported_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [no, input.unitId, at, input.kind, input.severity, input.location, input.description, input.employeeId ?? null, input.vehicleId ?? null, input.lostDays ?? 0, ctx.userId]);
}

export async function investigate(tx: Tx, ctx: Ctx, id: string, input: { rootCause: string; lostDays?: number; severity?: string;
  actions?: { title: string; ownerEmployeeId: string; dueDate: string }[] }) {
  const i = await one(tx, 'SELECT * FROM hse.incidents WHERE id = $1 FOR UPDATE', [id]);
  if (!i) throw new NotFoundError('incident');
  await authorize(tx, ctx, 'hse.manage', { unitId: i.unit_id });
  if (i.status === 'closed') throw new ConflictError('the incident is closed');
  await tx.query(`UPDATE hse.incidents SET status = 'investigating', root_cause = $2, lost_days = coalesce($3, lost_days), severity = coalesce($4, severity) WHERE id = $1`,
    [id, input.rootCause, input.lostDays ?? null, input.severity ?? null]);
  for (const a of input.actions ?? []) await createAction(tx, ctx, { sourceType: 'hse.incident', sourceId: id, unitId: i.unit_id, ...a });
  return getIncident(tx, ctx, id);
}

export async function closeIncident(tx: Tx, ctx: Ctx, id: string, date: string) {
  const i = await one(tx, 'SELECT * FROM hse.incidents WHERE id = $1 FOR UPDATE', [id]);
  if (!i) throw new NotFoundError('incident');
  await authorize(tx, ctx, 'hse.manage', { unitId: i.unit_id });
  if (i.status !== 'investigating' || !i.root_cause) throw new ConflictError('investigate the incident and record its root cause first');
  const open = await one(tx, `SELECT count(*)::int AS n FROM grc.actions WHERE source_type = 'hse.incident' AND source_id = $1 AND status <> 'verified'`, [id]);
  if (open.n) throw new ConflictError(`${open.n} corrective actions are not verified yet`);
  if (['serious', 'major', 'fatal'].includes(i.severity)) {
    const acts = await one(tx, `SELECT count(*)::int AS n FROM grc.actions WHERE source_type = 'hse.incident' AND source_id = $1`, [id]);
    if (!acts.n) throw new ValidationError('a serious incident needs at least one corrective action');
  }
  await tx.query(`UPDATE hse.incidents SET status = 'closed', closed_on = $2 WHERE id = $1`, [id, date]);
  return getIncident(tx, ctx, id);
}

export async function getIncident(tx: Tx, ctx: Ctx, id: string) {
  const i = await one(tx, `SELECT i.*, u.code AS unit_code, e.first_name || ' ' || e.last_name AS employee_name, v.plate_no
                             FROM hse.incidents i JOIN org.units u ON u.id = i.unit_id LEFT JOIN org.employees e ON e.id = i.employee_id
                             LEFT JOIN flt.vehicles v ON v.id = i.vehicle_id WHERE i.id = $1`, [id]);
  if (!i) throw new NotFoundError('incident');
  if (i.reported_by !== ctx.userId) await authorize(tx, ctx, 'hse.manage', { unitId: i.unit_id });
  i.actions = await many(tx, `SELECT * FROM grc.actions WHERE source_type = 'hse.incident' AND source_id = $1 ORDER BY due_date`, [id]);
  return i;
}

export async function listIncidents(tx: Tx, ctx: Ctx, status?: string) {
  const s = await unitScope(tx, ctx.userId!, 'hse.manage', 'i.unit_id', 1);
  return many(tx, `SELECT i.*, u.code AS unit_code, e.first_name || ' ' || e.last_name AS employee_name
                     FROM hse.incidents i JOIN org.units u ON u.id = i.unit_id LEFT JOIN org.employees e ON e.id = i.employee_id
                    WHERE (${s.sql} OR i.reported_by = $2) AND ($3::text IS NULL OR i.status = $3) ORDER BY i.occurred_at DESC LIMIT 300`,
    [s.param, ctx.userId, status ?? null]);
}

/** Safety statistics for a unit and its subtree over a period. */
export async function safetyStats(tx: Tx, ctx: Ctx, unitId: string, from: string, to: string, hoursWorked?: number) {
  await authorize(tx, ctx, 'hse.manage', { unitId });
  const u = await one(tx, 'SELECT path FROM org.units WHERE id = $1', [unitId]);
  const rows = await one(tx, `SELECT count(*)::int AS incidents,
        count(*) FILTER (WHERE i.kind = 'near_miss')::int AS near_misses,
        count(*) FILTER (WHERE i.kind = 'injury')::int AS injuries,
        count(*) FILTER (WHERE i.kind = 'injury' AND i.lost_days > 0)::int AS lost_time_injuries,
        coalesce(sum(i.lost_days), 0)::int AS lost_days,
        count(*) FILTER (WHERE i.kind = 'environmental')::int AS environmental,
        count(*) FILTER (WHERE i.status <> 'closed')::int AS open
      FROM hse.incidents i JOIN org.units x ON x.id = i.unit_id
     WHERE x.path LIKE $1 AND i.occurred_at >= $2::date AND i.occurred_at < $3::date + 1`, [`${u.path}%`, from, to]);
  let hours = hoursWorked;
  if (hours === undefined) {
    const k = await one(tx, `SELECT coalesce(sum(greatest(0, least(coalesce(k.end_date, $3::date), $3::date) - greatest(k.start_date, $2::date) + 1)), 0)::float AS days
                               FROM hr.contracts k JOIN org.employees e ON e.id = k.employee_id JOIN org.units x ON x.id = e.unit_id
                              WHERE x.path LIKE $1 AND k.start_date <= $3 AND (k.end_date IS NULL OR k.end_date >= $2)`, [`${u.path}%`, from, to]);
    hours = Math.round(k.days * 22 / 30.44 * 8);
  }
  const last = await one(tx, `SELECT max(i.occurred_at) AS at FROM hse.incidents i JOIN org.units x ON x.id = i.unit_id
                               WHERE x.path LIKE $1 AND i.kind = 'injury' AND i.lost_days > 0 AND i.occurred_at < $2::date + 1`, [`${u.path}%`, to]);
  const rate = (n: number) => (hours ? Math.round(n * 1e6 / hours * 100) / 100 : null);
  return { from, to, ...rows, hoursWorked: hours, ltifr: rate(rows.lost_time_injuries), trir: rate(rows.injuries),
    daysSinceLastLti: last.at ? Math.floor((new Date(`${to}T23:59:59Z`).getTime() - new Date(last.at).getTime()) / 86400e3) : null,
    lastLti: last.at ? d(last.at) : null };
}
