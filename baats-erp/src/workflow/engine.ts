import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { matches, validateCondition, type Condition } from '../core/rules.ts';
import { authorize, decide } from '../iam/authz.ts';
import { activeDelegate } from '../iam/service.ts';
import { managerChain } from '../org/service.ts';

/**
 * Workflow and approval engine. A definition is JSON data, versioned per tenant:
 *
 * {
 *   "approvalPermission": "mdm.party.approve",   // approvers must hold this for the subject + payload (limits)
 *   "steps": [
 *     { "key": "manager", "name": "Line manager", "approvers": [{ "type": "reporting_manager" }], "endorseOnly": true, "dueHours": 24,
 *       "escalateTo": [{ "type": "reporting_manager", "level": 2 }] },
 *     { "key": "finance", "when": { "credit_limit": { "gt": 100000 } },
 *       "approvers": [{ "type": "role", "role": "FIN_MANAGER" }], "mode": "all" }
 *   ]
 * }
 *
 * Steps run in order (sequential); approvers inside a step act in parallel and the
 * step completes on "any" (default), "all", or { "quorum": n } approvals. A step whose
 * "when" condition does not match the payload is skipped (conditional routing).
 * The requester can never approve their own request (maker-checker), and by default
 * one person cannot approve two steps of the same request.
 */

export type ApproverSpec =
  | { type: 'user'; userId: string }
  | { type: 'role'; role: string }
  | { type: 'reporting_manager'; level?: number }
  | { type: 'unit_head'; unitType?: string };

export interface StepDef {
  key: string;
  name?: string;
  when?: Condition;
  approvers: ApproverSpec[];
  mode?: 'any' | 'all' | { quorum: number };
  dueHours?: number;
  escalateTo?: ApproverSpec[];
  /** An endorsement step (for example the line manager) is not checked against approvalPermission. */
  endorseOnly?: boolean;
}

export interface WorkflowDef {
  approvalPermission?: string;
  allowSelfApproval?: boolean;
  distinctApprovers?: boolean;
  steps: StepDef[];
}

export type CompletionHandler = (tx: Tx, instance: Instance) => Promise<void>;
const handlers = new Map<string, CompletionHandler>();

/** Modules register what happens to their record when its approval completes. */
export function onWorkflowComplete(entityType: string, fn: CompletionHandler): void {
  handlers.set(entityType, fn);
}

export interface Instance {
  id: string; definition_id: string; entity_type: string; entity_id: string; requester_user_id: string;
  subject_unit_id: string; payload: Record<string, unknown>; status: string; current_step: number;
}

// --- Definitions ---------------------------------------------------------------

export function validateDefinition(def: unknown): string[] {
  const d = def as WorkflowDef;
  const errors: string[] = [];
  if (!d || !Array.isArray(d.steps) || d.steps.length === 0) return ['steps must be a non-empty array'];
  const keys = new Set<string>();
  d.steps.forEach((s, i) => {
    const at = `steps[${i}]`;
    if (!s.key || typeof s.key !== 'string') errors.push(`${at}.key is required`);
    else if (keys.has(s.key)) errors.push(`${at}.key "${s.key}" is repeated`);
    keys.add(s.key);
    if (s.when !== undefined) errors.push(...validateCondition(s.when, `${at}.when`));
    for (const [field, list] of [['approvers', s.approvers], ['escalateTo', s.escalateTo]] as const) {
      if (list === undefined && field === 'escalateTo') continue;
      if (!Array.isArray(list) || list.length === 0) { errors.push(`${at}.${field} must be a non-empty array`); continue; }
      list.forEach((a, j) => {
        const p = `${at}.${field}[${j}]`;
        if (a.type === 'user' && !a.userId) errors.push(`${p}.userId is required`);
        else if (a.type === 'role' && !a.role) errors.push(`${p}.role is required`);
        else if (a.type === 'reporting_manager' && a.level !== undefined && !(Number.isInteger(a.level) && a.level >= 1)) errors.push(`${p}.level must be >= 1`);
        else if (!['user', 'role', 'reporting_manager', 'unit_head'].includes(a.type)) errors.push(`${p}.type is unknown`);
      });
    }
    const m = s.mode;
    if (m !== undefined && m !== 'any' && m !== 'all' && !(typeof m === 'object' && Number.isInteger(m.quorum) && m.quorum >= 1)) {
      errors.push(`${at}.mode must be "any", "all" or { "quorum": n }`);
    }
    if (s.dueHours !== undefined && !(typeof s.dueHours === 'number' && s.dueHours > 0)) errors.push(`${at}.dueHours must be positive`);
  });
  return errors;
}

/** Publish a new version. Running instances keep the version they started on. */
export async function publishDefinition(tx: Tx, ctx: Ctx, input: { code: string; name: string; entityType: string; definition: WorkflowDef }) {
  await authorize(tx, ctx, 'wf.definition.manage');
  return insertDefinition(tx, input);
}

export async function insertDefinition(tx: Tx, input: { code: string; name: string; entityType: string; definition: WorkflowDef }) {
  const errors = validateDefinition(input.definition);
  if (errors.length) throw new ValidationError('invalid workflow definition', errors);
  await tx.query('UPDATE wf.definitions SET is_active = false WHERE code = $1 AND is_active', [input.code]);
  return one(tx, `INSERT INTO wf.definitions (tenant_id, code, version, name, entity_type, definition)
    VALUES (app.tenant(), $1, coalesce((SELECT max(version) FROM wf.definitions WHERE code = $1), 0) + 1, $2, $3, $4)
    RETURNING *`, [input.code, input.name, input.entityType, JSON.stringify(input.definition)]);
}

export async function listDefinitions(tx: Tx) {
  return many(tx, 'SELECT * FROM wf.definitions ORDER BY code, version DESC');
}

// --- Approver resolution -------------------------------------------------------------

async function resolve(tx: Tx, spec: ApproverSpec, inst: Instance): Promise<string[]> {
  switch (spec.type) {
    case 'user':
      return [spec.userId];
    case 'role':
      // Holders of the role whose assignment scope covers the subject unit.
      return (await many(tx, `
        SELECT DISTINCT ra.user_id FROM iam.role_assignments ra
          JOIN iam.roles r ON r.id = ra.role_id AND r.code = $1
          JOIN org.units scope ON scope.id = ra.scope_unit_id
          JOIN org.units subj ON subj.id = $2
         WHERE ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now())
           AND (subj.id = scope.id OR (ra.include_descendants AND subj.path LIKE scope.path || '%'))`,
        [spec.role, inst.subject_unit_id])).map((r) => r.user_id);
    case 'reporting_manager': {
      const req = await one(tx, 'SELECT employee_id FROM iam.users WHERE id = $1', [inst.requester_user_id]);
      if (!req?.employee_id) return [];
      const chain = await managerChain(tx, req.employee_id);
      const m = chain.find((c) => c.level === (spec.level ?? 1));
      return m?.user_id ? [m.user_id] : [];
    }
    case 'unit_head': {
      // Nearest unit at or above the subject (optionally of a given type) that has a head.
      const h = await one(tx, `
        SELECT us.id AS user_id FROM org.units subj
          JOIN org.units anc ON subj.path LIKE anc.path || '%'
          JOIN org.unit_types t ON t.id = anc.type_id
          JOIN iam.users us ON us.employee_id = anc.head_employee_id
         WHERE subj.id = $1 AND anc.head_employee_id IS NOT NULL AND ($2::text IS NULL OR t.code = $2)
         ORDER BY anc.depth DESC LIMIT 1`, [inst.subject_unit_id, spec.unitType ?? null]);
      return h ? [h.user_id] : [];
    }
  }
}

interface Assignee { assignee: string; onBehalfOf: string | null }

async function eligibleAssignees(tx: Tx, inst: Instance, def: WorkflowDef, specs: ApproverSpec[], now: Date): Promise<Assignee[]> {
  const raw = new Set<string>();
  for (const s of specs) for (const u of await resolve(tx, s, inst)) raw.add(u);
  const excluded = new Set<string>();
  if (!def.allowSelfApproval) excluded.add(inst.requester_user_id);
  if (def.distinctApprovers !== false) {
    for (const r of await many(tx, `SELECT DISTINCT coalesce(on_behalf_of_user_id, assignee_user_id) AS u, assignee_user_id AS a
                                      FROM wf.tasks WHERE instance_id = $1 AND status = 'approved'`, [inst.id])) {
      excluded.add(r.u); excluded.add(r.a);
    }
  }
  const active = new Set((await many(tx, `SELECT id FROM iam.users WHERE id = ANY($1) AND status = 'active'`, [[...raw]])).map((r) => r.id));
  const out = new Map<string, Assignee>();
  for (const u of raw) {
    if (excluded.has(u) || !active.has(u)) continue;
    const delegate = await activeDelegate(tx, u, now);
    // A delegation never routes a request to its own requester or to an excluded approver.
    const usable = delegate && !excluded.has(delegate);
    const a = usable ? { assignee: delegate, onBehalfOf: u } : { assignee: u, onBehalfOf: null };
    if (!out.has(a.assignee)) out.set(a.assignee, a);
  }
  return [...out.values()];
}

async function history(tx: Tx, instanceId: string, actor: string | null, step: number | null, action: string, comment: string | null = null, detail: object = {}) {
  await tx.query(`INSERT INTO wf.history (tenant_id, instance_id, actor_user_id, step_index, action, comment, detail)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6)`, [instanceId, actor, step, action, comment, JSON.stringify(detail)]);
}

async function loadDef(tx: Tx, definitionId: string): Promise<WorkflowDef> {
  return (await one(tx, 'SELECT definition FROM wf.definitions WHERE id = $1', [definitionId]))!.definition;
}

/** Move to the first applicable step at or after `from`; finish the instance if none is left. */
async function activateFrom(tx: Tx, inst: Instance, def: WorkflowDef, from: number, now: Date): Promise<void> {
  for (let i = from; i < def.steps.length; i++) {
    const step = def.steps[i];
    if (step.when && !matches(step.when, inst.payload)) {
      await history(tx, inst.id, null, i, 'step_skipped', null, { step: step.key });
      continue;
    }
    let assignees = await eligibleAssignees(tx, inst, def, step.approvers, now);
    if (assignees.length === 0 && step.escalateTo) {
      assignees = await eligibleAssignees(tx, inst, def, step.escalateTo, now);
      if (assignees.length) await history(tx, inst.id, null, i, 'routed_to_escalation', 'no eligible primary approver', { step: step.key });
    }
    if (assignees.length === 0) throw new ValidationError(`no eligible approver for step "${step.key}"`);
    const quorum = typeof step.mode === 'object' ? step.mode.quorum : 1;
    if (assignees.length < quorum) throw new ValidationError(`step "${step.key}" needs ${quorum} approvers but only ${assignees.length} are eligible`);
    const due = step.dueHours ? new Date(now.getTime() + step.dueHours * 3_600_000) : null;
    for (const a of assignees) {
      await tx.query(`INSERT INTO wf.tasks (tenant_id, instance_id, step_index, step_key, assignee_user_id, on_behalf_of_user_id, due_at)
        VALUES (app.tenant(), $1, $2, $3, $4, $5, $6)`, [inst.id, i, step.key, a.assignee, a.onBehalfOf, due]);
    }
    await tx.query('UPDATE wf.instances SET current_step = $2 WHERE id = $1', [inst.id, i]);
    inst.current_step = i;
    await history(tx, inst.id, null, i, 'step_started', null, { step: step.key, assignees });
    return;
  }
  await finish(tx, inst, 'approved');
}

async function finish(tx: Tx, inst: Instance, status: 'approved' | 'rejected' | 'cancelled'): Promise<void> {
  await tx.query(`UPDATE wf.tasks SET status = 'closed' WHERE instance_id = $1 AND status = 'open'`, [inst.id]);
  await tx.query(`UPDATE wf.instances SET status = $2, completed_at = now() WHERE id = $1`, [inst.id, status]);
  inst.status = status;
  await history(tx, inst.id, null, null, status);
  const h = handlers.get(inst.entity_type);
  if (h) await h(tx, inst);
}

// --- Runtime API -------------------------------------------------------------------

export async function submit(tx: Tx, ctx: Ctx, input: {
  code: string; entityType: string; entityId: string; subjectUnitId: string; payload?: Record<string, unknown>; now?: Date;
}): Promise<Instance> {
  const def = await one(tx, 'SELECT id, entity_type, definition FROM wf.definitions WHERE code = $1 AND is_active', [input.code]);
  if (!def) throw new NotFoundError(`workflow ${input.code}`);
  if (def.entity_type !== input.entityType) throw new ValidationError(`workflow ${input.code} is for ${def.entity_type}`);
  const inst = await one<Instance>(tx, `INSERT INTO wf.instances
      (tenant_id, definition_id, entity_type, entity_id, requester_user_id, subject_unit_id, payload)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6) RETURNING *`,
    [def.id, input.entityType, input.entityId, ctx.userId, input.subjectUnitId, JSON.stringify(input.payload ?? {})]);
  await history(tx, inst!.id, ctx.userId, null, 'submitted');
  await activateFrom(tx, inst!, def.definition, 0, input.now ?? new Date());
  return (await one<Instance>(tx, 'SELECT * FROM wf.instances WHERE id = $1', [inst!.id]))!;
}

export async function act(tx: Tx, ctx: Ctx, taskId: string, decision: 'approve' | 'reject', comment?: string, now = new Date()): Promise<Instance> {
  const task = await one(tx, 'SELECT * FROM wf.tasks WHERE id = $1 FOR UPDATE', [taskId]);
  if (!task) throw new NotFoundError('task');
  if (task.assignee_user_id !== ctx.userId) throw new ForbiddenError('wf.task.act', { taskId }, 'task is assigned to someone else');
  if (task.status !== 'open') throw new ConflictError(`task is already ${task.status}`);
  const inst = (await one<Instance>(tx, 'SELECT * FROM wf.instances WHERE id = $1 FOR UPDATE', [task.instance_id]))!;
  if (inst.status !== 'pending') throw new ConflictError(`request is already ${inst.status}`);
  if (inst.requester_user_id === ctx.userId) throw new ForbiddenError('wf.task.act', { taskId }, 'maker-checker: requester cannot approve');
  if (decision === 'reject' && !comment) throw new ValidationError('a comment is required to reject');

  const def = await loadDef(tx, inst.definition_id);
  const step = def.steps[task.step_index];
  // Approval limits: the authority used is the delegator's when acting on their behalf.
  if (decision === 'approve' && def.approvalPermission && !step.endorseOnly) {
    const authority = task.on_behalf_of_user_id ?? ctx.userId!;
    const d = await decide(tx, authority, def.approvalPermission, { unitId: inst.subject_unit_id, attrs: inst.payload });
    if (!d.allowed) throw new ForbiddenError(def.approvalPermission, { instanceId: inst.id }, d.reason);
  }

  await tx.query(`UPDATE wf.tasks SET status = $2, acted_at = $3, comment = $4 WHERE id = $1`,
    [taskId, decision === 'approve' ? 'approved' : 'rejected', now, comment ?? null]);
  await history(tx, inst.id, ctx.userId, task.step_index, decision === 'approve' ? 'approved_step' : 'rejected_step', comment ?? null,
    task.on_behalf_of_user_id ? { onBehalfOf: task.on_behalf_of_user_id } : {});

  if (decision === 'reject') { await finish(tx, inst, 'rejected'); return inst; }

  const c = await one(tx, `SELECT count(*) FILTER (WHERE status = 'approved')::int AS approved,
                                  count(*) FILTER (WHERE status = 'open')::int AS open
                             FROM wf.tasks WHERE instance_id = $1 AND step_index = $2`, [inst.id, task.step_index]);
  const mode = step.mode ?? 'any';
  const done = mode === 'any' ? c.approved >= 1
    : mode === 'all' ? c.open === 0
    : c.approved >= mode.quorum;
  if (done) {
    await tx.query(`UPDATE wf.tasks SET status = 'closed' WHERE instance_id = $1 AND step_index = $2 AND status = 'open'`, [inst.id, task.step_index]);
    await history(tx, inst.id, null, task.step_index, 'step_completed', null, { step: step.key });
    await activateFrom(tx, inst, def, task.step_index + 1, now);
  }
  return (await one<Instance>(tx, 'SELECT * FROM wf.instances WHERE id = $1', [inst.id]))!;
}

export async function cancel(tx: Tx, ctx: Ctx, instanceId: string, reason: string): Promise<void> {
  const inst = await one<Instance>(tx, 'SELECT * FROM wf.instances WHERE id = $1 FOR UPDATE', [instanceId]);
  if (!inst) throw new NotFoundError('request');
  if (inst.requester_user_id !== ctx.userId) throw new ForbiddenError('wf.instance.cancel', { instanceId }, 'only the requester can withdraw');
  if (inst.status !== 'pending') throw new ConflictError(`request is already ${inst.status}`);
  await history(tx, inst.id, ctx.userId, inst.current_step, 'withdrawn', reason);
  await finish(tx, inst, 'cancelled');
}

/**
 * Escalation sweep, run by the scheduler. Overdue tasks move to the step's
 * escalateTo approvers; steps without escalation get a single overdue record.
 */
export async function runEscalations(tx: Tx, now = new Date()): Promise<number> {
  const overdue = await many(tx, `SELECT t.*, i.definition_id FROM wf.tasks t JOIN wf.instances i ON i.id = t.instance_id
                                   WHERE t.status = 'open' AND t.due_at < $1 AND i.status = 'pending'
                                   ORDER BY t.due_at FOR UPDATE OF t`, [now]);
  let escalated = 0;
  for (const t of overdue) {
    const inst = (await one<Instance>(tx, 'SELECT * FROM wf.instances WHERE id = $1', [t.instance_id]))!;
    const def = await loadDef(tx, t.definition_id);
    const step = def.steps[t.step_index];
    if (!step.escalateTo) {
      await tx.query('UPDATE wf.tasks SET due_at = NULL WHERE id = $1', [t.id]);
      await history(tx, inst.id, null, t.step_index, 'overdue', null, { taskId: t.id });
      continue;
    }
    const open = new Set((await many(tx, `SELECT assignee_user_id FROM wf.tasks WHERE instance_id = $1 AND status = 'open'`, [inst.id]))
      .map((r) => r.assignee_user_id));
    const targets = (await eligibleAssignees(tx, inst, def, step.escalateTo, now)).filter((a) => !open.has(a.assignee));
    if (targets.length === 0) {
      await tx.query('UPDATE wf.tasks SET due_at = NULL WHERE id = $1', [t.id]);
      await history(tx, inst.id, null, t.step_index, 'escalation_failed', 'no eligible escalation approver', { taskId: t.id });
      continue;
    }
    await tx.query(`UPDATE wf.tasks SET status = 'escalated', acted_at = $2 WHERE id = $1`, [t.id, now]);
    for (const a of targets) {
      await tx.query(`INSERT INTO wf.tasks (tenant_id, instance_id, step_index, step_key, assignee_user_id, on_behalf_of_user_id)
        VALUES (app.tenant(), $1, $2, $3, $4, $5)`, [inst.id, t.step_index, t.step_key, a.assignee, a.onBehalfOf]);
    }
    await history(tx, inst.id, null, t.step_index, 'escalated', null, { from: t.assignee_user_id, to: targets });
    escalated++;
  }
  return escalated;
}

export async function inbox(tx: Tx, ctx: Ctx) {
  return many(tx, `SELECT t.id AS task_id, t.step_key, t.due_at, t.on_behalf_of_user_id, t.created_at,
                          i.id AS instance_id, i.entity_type, i.entity_id, i.payload, d.name AS workflow,
                          ru.display_name AS requester
                     FROM wf.tasks t JOIN wf.instances i ON i.id = t.instance_id
                     JOIN wf.definitions d ON d.id = i.definition_id
                     JOIN iam.users ru ON ru.id = i.requester_user_id
                    WHERE t.assignee_user_id = $1 AND t.status = 'open' ORDER BY t.created_at`, [ctx.userId]);
}

/** Full approval history. Visible to the requester, any assignee, or holders of wf.instance.read over the subject. */
export async function getInstance(tx: Tx, ctx: Ctx, id: string) {
  const inst = await one<Instance>(tx, 'SELECT * FROM wf.instances WHERE id = $1', [id]);
  if (!inst) throw new NotFoundError('request');
  const involved = inst.requester_user_id === ctx.userId
    || (await one(tx, 'SELECT 1 FROM wf.tasks WHERE instance_id = $1 AND (assignee_user_id = $2 OR on_behalf_of_user_id = $2)', [id, ctx.userId]));
  if (!involved) await authorize(tx, ctx, 'wf.instance.read', { unitId: inst.subject_unit_id });
  const tasks = await many(tx, 'SELECT * FROM wf.tasks WHERE instance_id = $1 ORDER BY step_index, created_at', [id]);
  const hist = await many(tx, 'SELECT * FROM wf.history WHERE instance_id = $1 ORDER BY id', [id]);
  return { ...inst, tasks, history: hist };
}
