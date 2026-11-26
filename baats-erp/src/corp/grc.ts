import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize, unitScope } from '../iam/authz.ts';

/**
 * Governance, risk and compliance, internal audit, and the shared action list.
 *
 * Risks are scored likelihood x impact (1 to 25). Controls mitigate them; each
 * control whose latest test was effective lowers the residual likelihood by one
 * step, so the residual score responds to evidence rather than to opinion. A
 * failed test raises an action for the control owner (and a finding when it was
 * tested inside an audit engagement). The tester cannot be the control owner.
 *
 * Actions come from audit findings, quality non-conformances, safety incidents
 * and failed controls. The owner marks one done; someone else with
 * grc.action.verify confirms it. Verifying the last action of a finding closes it.
 */

const d = (v: Date | string | null) => (v === null ? null : typeof v === 'string' ? v : v.toISOString().slice(0, 10));
const addMonths = (date: string, n: number) => { const x = new Date(`${date}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + n); return d(x)!; };
const addDays = (date: string, n: number) => { const x = new Date(`${date}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return d(x)!; };
const employeeOf = async (tx: Tx, userId: string | null) => (await one(tx, 'SELECT employee_id FROM iam.users WHERE id = $1', [userId]))?.employee_id ?? null;

// ---------------------------------------------------------------------------
// Risks and controls
// ---------------------------------------------------------------------------

export async function createRisk(tx: Tx, ctx: Ctx, input: { unitId: string; code: string; title: string; category: string; likelihood: number; impact: number;
  ownerEmployeeId?: string; treatment?: string; appetite?: number }) {
  await authorize(tx, ctx, 'grc.manage', { unitId: input.unitId });
  return one(tx, `INSERT INTO grc.risks (tenant_id, unit_id, code, title, category, likelihood, impact, owner_employee_id, treatment, appetite)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [input.unitId, input.code, input.title, input.category, input.likelihood, input.impact, input.ownerEmployeeId ?? null, input.treatment ?? 'mitigate', input.appetite ?? 9]);
}

export async function updateRisk(tx: Tx, ctx: Ctx, id: string, patch: { likelihood?: number; impact?: number; treatment?: string; status?: string; appetite?: number }) {
  const r = await one(tx, 'SELECT unit_id FROM grc.risks WHERE id = $1', [id]);
  if (!r) throw new NotFoundError('risk');
  await authorize(tx, ctx, 'grc.manage', { unitId: r.unit_id });
  return one(tx, `UPDATE grc.risks SET likelihood = coalesce($2, likelihood), impact = coalesce($3, impact), treatment = coalesce($4, treatment),
      status = coalesce($5, status), appetite = coalesce($6, appetite) WHERE id = $1 RETURNING *`,
    [id, patch.likelihood ?? null, patch.impact ?? null, patch.treatment ?? null, patch.status ?? null, patch.appetite ?? null]);
}

export async function addControl(tx: Tx, ctx: Ctx, riskId: string, input: { code: string; title: string; kind?: string; frequency?: string; ownerEmployeeId?: string }) {
  const r = await one(tx, 'SELECT unit_id FROM grc.risks WHERE id = $1', [riskId]);
  if (!r) throw new NotFoundError('risk');
  await authorize(tx, ctx, 'grc.manage', { unitId: r.unit_id });
  return one(tx, `INSERT INTO grc.controls (tenant_id, risk_id, code, title, kind, frequency, owner_employee_id) VALUES (app.tenant(), $1, $2, $3, $4, $5, $6) RETURNING *`,
    [riskId, input.code, input.title, input.kind ?? 'preventive', input.frequency ?? 'monthly', input.ownerEmployeeId ?? null]);
}

/** Record a control test. A failed test raises an action, and a finding when it belongs to an engagement. */
export async function testControl(tx: Tx, ctx: Ctx, controlId: string, input: { testedOn: string; result: 'effective' | 'ineffective'; sampleSize?: number;
  exceptions?: number; notes?: string; engagementId?: string; actionDueDate?: string }) {
  const c = await one(tx, `SELECT c.*, r.unit_id, r.owner_employee_id AS risk_owner, r.code AS risk_code FROM grc.controls c JOIN grc.risks r ON r.id = c.risk_id WHERE c.id = $1`, [controlId]);
  if (!c) throw new NotFoundError('control');
  await authorize(tx, ctx, 'grc.audit', { unitId: c.unit_id });
  if (c.status !== 'active') throw new ValidationError('the control is retired');
  const me = await employeeOf(tx, ctx.userId);
  if (me && me === c.owner_employee_id) throw new ForbiddenError('grc.audit', { unitId: c.unit_id }, 'a control cannot be tested by its own owner');
  if (input.result === 'effective' && (input.exceptions ?? 0) > 0 && input.sampleSize && input.exceptions! / input.sampleSize > 0.05) {
    throw new ValidationError('more than 5% exceptions in the sample: the control is not effective');
  }
  if (input.engagementId) {
    const e = await one(tx, 'SELECT status FROM grc.engagements WHERE id = $1', [input.engagementId]);
    if (!e) throw new ValidationError('unknown engagement');
    if (e.status === 'closed') throw new ConflictError('the engagement is closed');
  }
  const t = await one(tx, `INSERT INTO grc.control_tests (tenant_id, control_id, engagement_id, tested_on, result, sample_size, exceptions, notes, tested_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [controlId, input.engagementId ?? null, input.testedOn, input.result, input.sampleSize ?? null, input.exceptions ?? 0, input.notes ?? null, ctx.userId]);
  let finding = null, action = null;
  if (input.result === 'ineffective') {
    const owner = c.owner_employee_id ?? c.risk_owner;
    if (!owner) throw new ValidationError(`give control ${c.code} or risk ${c.risk_code} an owner first, so the failure has someone to fix it`);
    if (input.engagementId) {
      finding = await one(tx, `INSERT INTO grc.findings (tenant_id, engagement_id, control_test_id, title, severity, condition, recommendation)
        VALUES (app.tenant(), $1, $2, $3, 'medium', $4, $5) RETURNING *`,
        [input.engagementId, t.id, `Control ${c.code} not effective`, input.notes ?? `${input.exceptions ?? 0} exceptions in a sample of ${input.sampleSize ?? 'n/a'}`,
          `Restore the operation of control ${c.code} (${c.title}) and evidence it.`]);
    }
    action = await createAction(tx, ctx, { sourceType: finding ? 'grc.finding' : 'grc.risk', sourceId: finding?.id ?? c.risk_id, unitId: c.unit_id,
      title: `Fix control ${c.code}: ${c.title}`, ownerEmployeeId: owner, dueDate: input.actionDueDate ?? addDays(input.testedOn, 30) });
  }
  return { test: t, finding, action };
}

/** The register with inherent and residual scores, and a 5 x 5 heat map of residual risk. */
export async function riskRegister(tx: Tx, ctx: Ctx) {
  const s = await unitScope(tx, ctx.userId!, 'grc.manage', 'r.unit_id', 1);
  const risks = await many(tx, `SELECT r.*, u.code AS unit_code, e.first_name || ' ' || e.last_name AS owner_name,
        (SELECT count(*)::int FROM grc.controls c WHERE c.risk_id = r.id AND c.status = 'active') AS controls,
        (SELECT count(*)::int FROM grc.controls c WHERE c.risk_id = r.id AND c.status = 'active'
            AND (SELECT t.result FROM grc.control_tests t WHERE t.control_id = c.id ORDER BY t.tested_on DESC, t.id DESC LIMIT 1) = 'effective') AS effective_controls,
        (SELECT count(*)::int FROM grc.actions a WHERE a.status <> 'verified' AND ((a.source_type = 'grc.risk' AND a.source_id = r.id))) AS open_actions
      FROM grc.risks r JOIN org.units u ON u.id = r.unit_id LEFT JOIN org.employees e ON e.id = r.owner_employee_id
     WHERE ${s.sql} ORDER BY r.code`, [s.param]);
  const heat = Array.from({ length: 5 }, () => Array(5).fill(0));
  const out = risks.map((r) => {
    const residualLikelihood = Math.max(1, r.likelihood - r.effective_controls);
    const residual = residualLikelihood * r.impact;
    if (r.status === 'open') heat[residualLikelihood - 1][r.impact - 1]++;
    return { ...r, inherent: r.likelihood * r.impact, residualLikelihood, residual, overAppetite: r.status === 'open' && residual > r.appetite };
  });
  return { risks: out, heatMap: heat };
}

export async function riskControls(tx: Tx, ctx: Ctx, riskId: string) {
  const r = await one(tx, 'SELECT unit_id FROM grc.risks WHERE id = $1', [riskId]);
  if (!r) throw new NotFoundError('risk');
  await authorize(tx, ctx, 'grc.manage', { unitId: r.unit_id });
  return many(tx, `SELECT c.*, e.first_name || ' ' || e.last_name AS owner_name,
      (SELECT row_to_json(t) FROM (SELECT tested_on, result, exceptions, sample_size FROM grc.control_tests WHERE control_id = c.id ORDER BY tested_on DESC, id DESC LIMIT 1) t) AS last_test
    FROM grc.controls c LEFT JOIN org.employees e ON e.id = c.owner_employee_id WHERE c.risk_id = $1 ORDER BY c.code`, [riskId]);
}

// ---------------------------------------------------------------------------
// Compliance calendar
// ---------------------------------------------------------------------------

export async function addObligation(tx: Tx, ctx: Ctx, input: { unitId: string; regulation: string; requirement: string; frequency?: string; nextDue: string; ownerEmployeeId?: string }) {
  await authorize(tx, ctx, 'grc.manage', { unitId: input.unitId });
  return one(tx, `INSERT INTO grc.obligations (tenant_id, unit_id, regulation, requirement, frequency, next_due, owner_employee_id)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.unitId, input.regulation, input.requirement, input.frequency ?? 'annual', input.nextDue, input.ownerEmployeeId ?? null]);
}

/** Mark an obligation met; recurring ones move to their next due date. */
export async function meetObligation(tx: Tx, ctx: Ctx, id: string, date: string) {
  const o = await one(tx, 'SELECT * FROM grc.obligations WHERE id = $1 FOR UPDATE', [id]);
  if (!o) throw new NotFoundError('obligation');
  await authorize(tx, ctx, 'grc.manage', { unitId: o.unit_id });
  if (o.status !== 'active') throw new ConflictError('the obligation is retired');
  const months = { once: 0, monthly: 1, quarterly: 3, annual: 12 }[o.frequency as 'once'];
  const next = months ? addMonths(d(o.next_due)!, months) : d(o.next_due);
  return one(tx, `UPDATE grc.obligations SET last_done = $2, next_due = $3, status = CASE WHEN $4 THEN 'retired' ELSE status END WHERE id = $1 RETURNING *`,
    [id, date, next, months === 0]);
}

export async function complianceCalendar(tx: Tx, ctx: Ctx, asOf: string, withinDays = 60) {
  const s = await unitScope(tx, ctx.userId!, 'grc.manage', 'o.unit_id', 1);
  const rows = await many(tx, `SELECT o.*, e.first_name || ' ' || e.last_name AS owner_name FROM grc.obligations o LEFT JOIN org.employees e ON e.id = o.owner_employee_id
                                WHERE ${s.sql} AND o.status = 'active' ORDER BY o.next_due`, [s.param]);
  const horizon = addDays(asOf, withinDays);
  return rows.map((o) => ({ ...o, overdue: d(o.next_due)! < asOf, dueSoon: d(o.next_due)! <= horizon }));
}

// ---------------------------------------------------------------------------
// Audit engagements and findings
// ---------------------------------------------------------------------------

export async function createEngagement(tx: Tx, ctx: Ctx, input: { unitId: string; title: string; kind?: string; periodFrom?: string; periodTo?: string }) {
  await authorize(tx, ctx, 'grc.audit', { unitId: input.unitId });
  return one(tx, `INSERT INTO grc.engagements (tenant_id, unit_id, title, kind, period_from, period_to, lead_user_id) VALUES (app.tenant(), $1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.unitId, input.title, input.kind ?? 'internal', input.periodFrom ?? null, input.periodTo ?? null, ctx.userId]);
}

const NEXT: Record<string, string> = { planned: 'fieldwork', fieldwork: 'reporting', reporting: 'closed' };

/** Move an engagement on. Closing needs an opinion and a management response with actions for every finding. */
export async function advanceEngagement(tx: Tx, ctx: Ctx, id: string, input: { opinion?: string } = {}) {
  const e = await one(tx, 'SELECT * FROM grc.engagements WHERE id = $1 FOR UPDATE', [id]);
  if (!e) throw new NotFoundError('engagement');
  await authorize(tx, ctx, 'grc.audit', { unitId: e.unit_id });
  const next = NEXT[e.status];
  if (!next) throw new ConflictError('the engagement is closed');
  if (next === 'closed') {
    if (!input.opinion && !e.opinion) throw new ValidationError('give the audit opinion before closing');
    const open = await one(tx, `SELECT count(*)::int AS n FROM grc.findings f WHERE f.engagement_id = $1
                                  AND (f.management_response IS NULL OR NOT EXISTS (SELECT 1 FROM grc.actions a WHERE a.source_type = 'grc.finding' AND a.source_id = f.id))`, [id]);
    if (open.n) throw new ConflictError(`${open.n} findings have no management response and action plan yet`);
  }
  return one(tx, 'UPDATE grc.engagements SET status = $2, opinion = coalesce($3, opinion) WHERE id = $1 RETURNING *', [id, next, input.opinion ?? null]);
}

export async function addFinding(tx: Tx, ctx: Ctx, engagementId: string, input: { title: string; severity: string; condition: string; recommendation: string }) {
  const e = await one(tx, 'SELECT * FROM grc.engagements WHERE id = $1', [engagementId]);
  if (!e) throw new NotFoundError('engagement');
  await authorize(tx, ctx, 'grc.audit', { unitId: e.unit_id });
  if (!['fieldwork', 'reporting'].includes(e.status)) throw new ConflictError(`findings are raised during fieldwork or reporting; the engagement is ${e.status}`);
  return one(tx, `INSERT INTO grc.findings (tenant_id, engagement_id, title, severity, condition, recommendation) VALUES (app.tenant(), $1, $2, $3, $4, $5) RETURNING *`,
    [engagementId, input.title, input.severity, input.condition, input.recommendation]);
}

/** Management's answer to a finding, with the actions it commits to. Anyone managing the audited unit may respond. */
export async function respondToFinding(tx: Tx, ctx: Ctx, findingId: string, input: { response: string; actions: { title: string; ownerEmployeeId: string; dueDate: string }[] }) {
  const f = await one(tx, 'SELECT f.*, e.unit_id FROM grc.findings f JOIN grc.engagements e ON e.id = f.engagement_id WHERE f.id = $1 FOR UPDATE OF f', [findingId]);
  if (!f) throw new NotFoundError('finding');
  await authorize(tx, ctx, 'grc.manage', { unitId: f.unit_id });
  if (f.status === 'closed') throw new ConflictError('the finding is closed');
  if (!input.actions?.length) throw new ValidationError('commit to at least one action');
  await tx.query('UPDATE grc.findings SET management_response = $2 WHERE id = $1', [findingId, input.response]);
  for (const a of input.actions) await createAction(tx, ctx, { sourceType: 'grc.finding', sourceId: findingId, unitId: f.unit_id, ...a });
  const out = await one(tx, 'SELECT * FROM grc.findings WHERE id = $1', [findingId]);
  out.actions = await many(tx, `SELECT * FROM grc.actions WHERE source_type = 'grc.finding' AND source_id = $1 ORDER BY due_date`, [findingId]);
  return out;
}

export async function getEngagement(tx: Tx, ctx: Ctx, id: string) {
  const e = await one(tx, 'SELECT e.*, u.code AS unit_code, u.name AS unit_name FROM grc.engagements e JOIN org.units u ON u.id = e.unit_id WHERE e.id = $1', [id]);
  if (!e) throw new NotFoundError('engagement');
  await authorize(tx, ctx, 'grc.audit', { unitId: e.unit_id });
  e.findings = await many(tx, `SELECT f.*, (SELECT json_agg(a ORDER BY a.due_date) FROM grc.actions a WHERE a.source_type = 'grc.finding' AND a.source_id = f.id) AS actions
                                 FROM grc.findings f WHERE f.engagement_id = $1 ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`, [id]);
  e.tests = await many(tx, `SELECT t.*, c.code AS control_code FROM grc.control_tests t JOIN grc.controls c ON c.id = t.control_id WHERE t.engagement_id = $1 ORDER BY t.tested_on`, [id]);
  return e;
}

export async function listEngagements(tx: Tx, ctx: Ctx) {
  const s = await unitScope(tx, ctx.userId!, 'grc.audit', 'e.unit_id', 1);
  return many(tx, `SELECT e.*, u.code AS unit_code,
      (SELECT count(*)::int FROM grc.findings f WHERE f.engagement_id = e.id) AS findings,
      (SELECT count(*)::int FROM grc.findings f WHERE f.engagement_id = e.id AND f.status = 'open') AS open_findings
    FROM grc.engagements e JOIN org.units u ON u.id = e.unit_id WHERE ${s.sql} ORDER BY e.status = 'closed', e.period_to DESC NULLS LAST`, [s.param]);
}

// ---------------------------------------------------------------------------
// Actions (CAPA)
// ---------------------------------------------------------------------------

export async function createAction(tx: Tx, ctx: Ctx, input: { sourceType: string; sourceId: string; unitId?: string | null; title: string; ownerEmployeeId: string; dueDate: string }) {
  const e = await one(tx, 'SELECT status FROM org.employees WHERE id = $1', [input.ownerEmployeeId]);
  if (!e) throw new ValidationError('unknown action owner');
  return one(tx, `INSERT INTO grc.actions (tenant_id, source_type, source_id, unit_id, title, owner_employee_id, due_date, created_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [input.sourceType, input.sourceId, input.unitId ?? null, input.title, input.ownerEmployeeId, input.dueDate, ctx.userId]);
}

/** The owner (or someone who verifies actions) marks the action done. */
export async function completeAction(tx: Tx, ctx: Ctx, id: string, input: { note: string; date: string }) {
  const a = await one(tx, 'SELECT * FROM grc.actions WHERE id = $1 FOR UPDATE', [id]);
  if (!a) throw new NotFoundError('action');
  const me = await employeeOf(tx, ctx.userId);
  if (me !== a.owner_employee_id) await authorize(tx, ctx, 'grc.action.verify', { unitId: a.unit_id ?? undefined });
  if (a.status !== 'open') throw new ConflictError(`the action is already ${a.status}`);
  if (!input.note?.trim()) throw new ValidationError('say what was done');
  return one(tx, `UPDATE grc.actions SET status = 'done', completion_note = $2, done_by = $3, done_on = $4 WHERE id = $1 RETURNING *`, [id, input.note, ctx.userId, input.date]);
}

/** Someone other than whoever did it confirms the action worked. The last verified action closes its finding. */
export async function verifyAction(tx: Tx, ctx: Ctx, id: string, input: { date: string; accepted: boolean; comment?: string }) {
  const a = await one(tx, 'SELECT * FROM grc.actions WHERE id = $1 FOR UPDATE', [id]);
  if (!a) throw new NotFoundError('action');
  await authorize(tx, ctx, 'grc.action.verify', { unitId: a.unit_id ?? undefined });
  if (a.status !== 'done') throw new ConflictError('only a completed action can be verified');
  const me = await employeeOf(tx, ctx.userId);
  if (a.done_by === ctx.userId || (me && me === a.owner_employee_id)) throw new ForbiddenError('grc.action.verify', {}, 'someone other than the person who did the action must verify it');
  if (!input.accepted) {
    return one(tx, `UPDATE grc.actions SET status = 'open', completion_note = completion_note || ' | not accepted: ' || $2, done_by = NULL, done_on = NULL WHERE id = $1 RETURNING *`,
      [id, input.comment ?? 'no reason given']);
  }
  const row = await one(tx, `UPDATE grc.actions SET status = 'verified', verified_by = $2, verified_on = $3 WHERE id = $1 RETURNING *`, [id, ctx.userId, input.date]);
  if (a.source_type === 'grc.finding') {
    await tx.query(`UPDATE grc.findings SET status = 'closed' WHERE id = $1 AND NOT EXISTS
      (SELECT 1 FROM grc.actions WHERE source_type = 'grc.finding' AND source_id = $1 AND status <> 'verified')`, [a.source_id]);
  }
  return row;
}

export async function listActions(tx: Tx, ctx: Ctx, f: { status?: string; mine?: boolean; asOf?: string } = {}) {
  const me = await employeeOf(tx, ctx.userId);
  const s = await unitScope(tx, ctx.userId!, 'grc.action.verify', 'a.unit_id', 1);
  const rows = await many(tx, `SELECT a.*, e.first_name || ' ' || e.last_name AS owner_name FROM grc.actions a JOIN org.employees e ON e.id = a.owner_employee_id
                                WHERE (a.owner_employee_id = $2 OR ${s.sql}) AND ($3::boolean IS NOT TRUE OR a.owner_employee_id = $2)
                                  AND ($4::text IS NULL OR a.status = $4) ORDER BY a.status = 'verified', a.due_date LIMIT 500`,
    [s.param, me, f.mine ?? false, f.status ?? null]);
  const today = f.asOf ?? new Date().toISOString().slice(0, 10);
  return rows.map((a) => ({ ...a, overdue: a.status === 'open' && d(a.due_date)! < today }));
}
