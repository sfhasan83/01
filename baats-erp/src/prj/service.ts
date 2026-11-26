import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';
import { company, post, round2, type PostingLine } from '../fin/ledger.ts';
import { ensureRoleAccount } from '../fin/setup.ts';
import { createInvoice } from '../fin/documents.ts';

/**
 * Projects. A project is a ledger dimension: any invoice line or journal line
 * can carry it, so purchases, expenses and revenue land on the project as they
 * are posted. Time is costed when a timesheet is approved:
 *   Dr 5015 Project labour (project)  | Cr 5000 Salaries & wages (employee's unit)
 * which moves the cost already booked by payroll onto the project, so profit
 * and loss in total does not change. The hourly cost follows the UAE labour law
 * convention: monthly gross (basic and allowances) / 30 days / 8 hours.
 * Billing: time and material projects bill approved billable hours at the
 * member's rate (or the project default); fixed price projects bill milestones.
 */

export interface ProjectInput {
  companyId: string; code: string; name: string; customerId?: string; unitId?: string; managerEmployeeId?: string;
  billing?: 'time_material' | 'fixed_price' | 'non_billable'; currency?: string; contractValue?: number;
  budgetCost?: number; budgetHours?: number; defaultBillRate?: number; startDate: string; endDate?: string;
}

async function project(tx: Tx, id: string, lock = false) {
  const p = await one(tx, `SELECT * FROM prj.projects WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!p) throw new NotFoundError('project');
  return p;
}

export async function createProject(tx: Tx, ctx: Ctx, input: ProjectInput) {
  await authorize(tx, ctx, 'prj.manage', { unitId: input.unitId ?? input.companyId });
  const c = await company(tx, input.companyId);
  const billing = input.billing ?? 'time_material';
  if (billing !== 'non_billable') {
    if (!input.customerId) throw new ValidationError('a billable project needs a customer');
    const cust = await one(tx, 'SELECT name, status, is_customer FROM mdm.parties WHERE id = $1', [input.customerId]);
    if (!cust?.is_customer) throw new ValidationError('the customer is not a customer');
    if (cust.status !== 'active') throw new ValidationError(`${cust.name} is ${cust.status}`);
  }
  return one(tx, `INSERT INTO prj.projects (tenant_id, company_id, code, name, customer_id, unit_id, manager_employee_id, billing, currency,
                    contract_value, budget_cost, budget_hours, default_bill_rate, start_date, end_date, created_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
    [input.companyId, input.code, input.name, input.customerId ?? null, input.unitId ?? null, input.managerEmployeeId ?? null, billing,
      input.currency ?? c.base_currency, input.contractValue ?? 0, input.budgetCost ?? 0, input.budgetHours ?? 0, input.defaultBillRate ?? 0,
      input.startDate, input.endDate ?? null, ctx.userId]);
}

export async function updateProject(tx: Tx, ctx: Ctx, id: string, patch: { name?: string; status?: string; budgetCost?: number; budgetHours?: number;
  contractValue?: number; defaultBillRate?: number; endDate?: string | null; managerEmployeeId?: string | null }) {
  const p = await project(tx, id, true);
  await authorize(tx, ctx, 'prj.manage', { unitId: p.unit_id ?? p.company_id });
  if (patch.status === 'closed') {
    const open = await one(tx, `SELECT count(*)::int AS n FROM prj.timesheets WHERE project_id = $1 AND status = 'submitted'`, [id]);
    if (open.n) throw new ConflictError(`${open.n} timesheets are still waiting for approval`);
  }
  return one(tx, `UPDATE prj.projects SET name = coalesce($2, name), status = coalesce($3, status), budget_cost = coalesce($4, budget_cost),
      budget_hours = coalesce($5, budget_hours), contract_value = coalesce($6, contract_value), default_bill_rate = coalesce($7, default_bill_rate),
      end_date = CASE WHEN $8::boolean THEN $9::date ELSE end_date END,
      manager_employee_id = CASE WHEN $10::boolean THEN $11::uuid ELSE manager_employee_id END
    WHERE id = $1 RETURNING *`,
    [id, patch.name ?? null, patch.status ?? null, patch.budgetCost ?? null, patch.budgetHours ?? null, patch.contractValue ?? null,
      patch.defaultBillRate ?? null, 'endDate' in patch, patch.endDate ?? null, 'managerEmployeeId' in patch, patch.managerEmployeeId ?? null]);
}

export async function addMember(tx: Tx, ctx: Ctx, projectId: string, input: { employeeId: string; role?: string; billRate?: number }) {
  const p = await project(tx, projectId);
  await authorize(tx, ctx, 'prj.manage', { unitId: p.unit_id ?? p.company_id });
  const e = await one(tx, 'SELECT status FROM org.employees WHERE id = $1', [input.employeeId]);
  if (!e) throw new ValidationError('unknown employee');
  return one(tx, `INSERT INTO prj.members (tenant_id, project_id, employee_id, role, bill_rate) VALUES (app.tenant(), $1, $2, $3, $4)
    ON CONFLICT (tenant_id, project_id, employee_id) DO UPDATE SET role = EXCLUDED.role, bill_rate = EXCLUDED.bill_rate RETURNING *`,
    [projectId, input.employeeId, input.role ?? null, input.billRate ?? null]);
}

export async function addMilestone(tx: Tx, ctx: Ctx, projectId: string, input: { name: string; amount: number; dueDate?: string }) {
  const p = await project(tx, projectId);
  await authorize(tx, ctx, 'prj.manage', { unitId: p.unit_id ?? p.company_id });
  if (p.billing === 'non_billable') throw new ValidationError('a non-billable project has no billing milestones');
  const sum = await one(tx, 'SELECT coalesce(sum(amount), 0)::float AS s FROM prj.milestones WHERE project_id = $1', [projectId]);
  if (Number(p.contract_value) > 0 && sum.s + input.amount > Number(p.contract_value) + 0.001) {
    throw new ValidationError(`milestones would exceed the contract value of ${p.contract_value}`);
  }
  return one(tx, `INSERT INTO prj.milestones (tenant_id, project_id, name, amount, due_date) VALUES (app.tenant(), $1, $2, $3, $4) RETURNING *`,
    [projectId, input.name, input.amount, input.dueDate ?? null]);
}

export async function reachMilestone(tx: Tx, ctx: Ctx, milestoneId: string, date: string) {
  const m = await one(tx, 'SELECT * FROM prj.milestones WHERE id = $1 FOR UPDATE', [milestoneId]);
  if (!m) throw new NotFoundError('milestone');
  const p = await project(tx, m.project_id);
  await authorize(tx, ctx, 'prj.manage', { unitId: p.unit_id ?? p.company_id });
  if (m.status === 'reached') throw new ConflictError('the milestone is already reached');
  return one(tx, `UPDATE prj.milestones SET status = 'reached', reached_date = $2 WHERE id = $1 RETURNING *`, [milestoneId, date]);
}

/** Employees log their own time; project managers (prj.manage) can log it for anyone on the team. */
export async function logTime(tx: Tx, ctx: Ctx, input: { projectId: string; employeeId: string; date: string; hours: number; description: string; billable?: boolean }) {
  const p = await project(tx, input.projectId);
  const self = await one(tx, 'SELECT 1 FROM iam.users WHERE id = $1 AND employee_id = $2', [ctx.userId, input.employeeId]);
  if (!self) await authorize(tx, ctx, 'prj.manage', { unitId: p.unit_id ?? p.company_id });
  if (p.status !== 'active') throw new ValidationError(`project ${p.code} is ${p.status}`);
  if (input.date < p.start_date.toISOString().slice(0, 10) || (p.end_date && input.date > p.end_date.toISOString().slice(0, 10))) {
    throw new ValidationError('the date is outside the project dates');
  }
  if (!(input.hours > 0 && input.hours <= 24)) throw new ValidationError('hours must be more than 0 and at most 24');
  const member = await one(tx, 'SELECT 1 FROM prj.members WHERE project_id = $1 AND employee_id = $2', [input.projectId, input.employeeId]);
  if (!member) throw new ValidationError('the employee is not on the project team');
  const day = await one(tx, `SELECT coalesce(sum(hours), 0)::float AS h FROM prj.timesheets WHERE employee_id = $1 AND date = $2 AND status <> 'rejected'`,
    [input.employeeId, input.date]);
  if (day.h + input.hours > 24) throw new ValidationError(`that makes ${day.h + input.hours} hours on ${input.date}`);
  return one(tx, `INSERT INTO prj.timesheets (tenant_id, project_id, employee_id, date, hours, description, billable, entered_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [input.projectId, input.employeeId, input.date, input.hours, input.description, p.billing !== 'non_billable' && (input.billable ?? true), ctx.userId]);
}

/** Monthly gross / 30 / 8, from the contract running on the date. */
async function hourlyCost(tx: Tx, employeeId: string, date: string): Promise<number> {
  const c = await one(tx, `SELECT basic + housing + transport + other_allowances AS gross FROM hr.contracts
                            WHERE employee_id = $1 AND start_date <= $2 AND (end_date IS NULL OR end_date >= $2)
                            ORDER BY start_date DESC LIMIT 1`, [employeeId, date]);
  if (!c) {
    const e = await one(tx, 'SELECT first_name, last_name FROM org.employees WHERE id = $1', [employeeId]);
    throw new ValidationError(`${e?.first_name ?? ''} ${e?.last_name ?? ''} has no employment contract on ${date}, so the time has no cost`.trim());
  }
  return Number(c.gross) / 30 / 8;
}

/** Approve timesheets and post their cost to the projects: one journal per project. */
export async function approveTimesheets(tx: Tx, ctx: Ctx, ids: string[], input: { date?: string } = {}) {
  if (!ids.length) throw new ValidationError('choose timesheets to approve');
  const rows = await many(tx, `SELECT t.*, e.unit_id AS employee_unit, u.employee_id AS approver_employee
                                 FROM prj.timesheets t JOIN org.employees e ON e.id = t.employee_id
                                 LEFT JOIN iam.users u ON u.id = $2
                                WHERE t.id = ANY($1) ORDER BY t.date FOR UPDATE OF t`, [ids, ctx.userId]);
  if (rows.length !== new Set(ids).size) throw new NotFoundError('timesheet');
  const byProject = new Map<string, typeof rows>();
  for (const r of rows) {
    if (r.status !== 'submitted') throw new ConflictError(`a timesheet of ${r.date.toISOString().slice(0, 10)} is already ${r.status}`);
    if (r.approver_employee && r.approver_employee === r.employee_id) throw new ValidationError('you cannot approve your own time');
    byProject.set(r.project_id, [...(byProject.get(r.project_id) ?? []), r]);
  }
  const journals: string[] = [];
  for (const [projectId, list] of byProject) {
    const p = await project(tx, projectId);
    await authorize(tx, ctx, 'prj.time.approve', { unitId: p.unit_id ?? p.company_id });
    await ensureRoleAccount(tx, p.company_id, 'project_labour');
    const members = new Map((await many(tx, 'SELECT employee_id, bill_rate FROM prj.members WHERE project_id = $1', [projectId]))
      .map((m) => [m.employee_id, m.bill_rate]));
    const credits = new Map<string, number>();
    let total = 0;
    const costed = [];
    for (const r of list) {
      const rate = await hourlyCost(tx, r.employee_id, r.date.toISOString().slice(0, 10));
      const cost = round2(rate * Number(r.hours));
      const billRate = r.billable ? Number(members.get(r.employee_id) ?? p.default_bill_rate) : null;
      costed.push({ r, rate, cost, billRate });
      total = round2(total + cost);
      const unit = r.employee_unit ?? '';
      credits.set(unit, round2((credits.get(unit) ?? 0) + cost));
    }
    const date = input.date ?? list[list.length - 1].date.toISOString().slice(0, 10);
    const lines: PostingLine[] = [{ account: 'role:project_labour', debit: total, projectId, unitId: p.unit_id, description: `Time on ${p.code}` }];
    for (const [unit, amount] of credits) lines.push({ account: 'role:salaries', credit: amount, unitId: unit || null, description: `Time on ${p.code}` });
    const j = total > 0 ? await post(tx, ctx, { companyId: p.company_id, type: 'timesheet', date, memo: `Timesheets ${p.code}: ${list.length} entries`, lines }) : null;
    if (!j) throw new ValidationError('the time has no cost');
    journals.push(j.id);
    for (const c of costed) {
      await tx.query(`UPDATE prj.timesheets SET status = 'approved', cost_rate = $2, cost = $3, bill_rate = $4, journal_id = $5, approved_by = $6 WHERE id = $1`,
        [c.r.id, c.rate, c.cost, c.billRate, j.id, ctx.userId]);
    }
  }
  return { approved: rows.length, journalIds: journals };
}

export async function rejectTimesheets(tx: Tx, ctx: Ctx, ids: string[]) {
  const rows = await many(tx, 'SELECT t.*, p.unit_id, p.company_id FROM prj.timesheets t JOIN prj.projects p ON p.id = t.project_id WHERE t.id = ANY($1) FOR UPDATE OF t', [ids]);
  if (rows.length !== new Set(ids).size) throw new NotFoundError('timesheet');
  for (const r of rows) {
    await authorize(tx, ctx, 'prj.time.approve', { unitId: r.unit_id ?? r.company_id });
    if (r.status !== 'submitted') throw new ConflictError(`the timesheet is already ${r.status}`);
  }
  await tx.query(`UPDATE prj.timesheets SET status = 'rejected', approved_by = $2 WHERE id = ANY($1)`, [ids, ctx.userId]);
  return { rejected: rows.length };
}

export async function listTimesheets(tx: Tx, ctx: Ctx, companyId: string, f: { projectId?: string; status?: string } = {}) {
  await authorize(tx, ctx, 'prj.manage', { unitId: companyId });
  return many(tx, `SELECT t.*, p.code AS project_code, e.first_name || ' ' || e.last_name AS employee_name
                     FROM prj.timesheets t JOIN prj.projects p ON p.id = t.project_id JOIN org.employees e ON e.id = t.employee_id
                    WHERE p.company_id = $1 AND ($2::uuid IS NULL OR t.project_id = $2) AND ($3::text IS NULL OR t.status = $3)
                    ORDER BY t.date DESC, e.last_name LIMIT 500`, [companyId, f.projectId ?? null, f.status ?? null]);
}

/** Draft the next invoice: approved billable hours not billed yet, and reached milestones. */
export async function invoiceProject(tx: Tx, ctx: Ctx, projectId: string, input: { date: string; upTo?: string; taxCode?: string; fxRate?: number }) {
  const p = await project(tx, projectId, true);
  await authorize(tx, ctx, 'fin.invoice.manage', { unitId: p.company_id });
  if (p.billing === 'non_billable') throw new ValidationError('the project is not billable');
  const taxCode = input.taxCode ?? 'SR';
  const lines = [];
  const times = p.billing === 'time_material' ? await many(tx, `SELECT t.id, t.employee_id, t.hours, t.bill_rate, t.date, e.first_name || ' ' || e.last_name AS name
      FROM prj.timesheets t JOIN org.employees e ON e.id = t.employee_id
     WHERE t.project_id = $1 AND t.status = 'approved' AND t.billable AND t.invoice_id IS NULL AND t.date <= $2 ORDER BY e.last_name, t.date FOR UPDATE OF t`,
    [projectId, input.upTo ?? input.date]) : [];
  const groups = new Map<string, { name: string; rate: number; hours: number; from: string; to: string }>();
  for (const t of times) {
    const key = `${t.employee_id}|${t.bill_rate}`;
    const d = t.date.toISOString().slice(0, 10);
    const g = groups.get(key) ?? { name: t.name, rate: Number(t.bill_rate), hours: 0, from: d, to: d };
    g.hours += Number(t.hours); g.to = d;
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    if (g.rate <= 0) throw new ValidationError(`no bill rate for ${g.name}: set it on the team or the project`);
    lines.push({ description: `${p.name}: ${g.name}, ${g.from} to ${g.to}`, quantity: round2(g.hours), unitPrice: g.rate, taxCode, projectId, unitId: p.unit_id ?? undefined });
  }
  const miles = await many(tx, `SELECT * FROM prj.milestones WHERE project_id = $1 AND status = 'reached' AND invoice_id IS NULL ORDER BY reached_date FOR UPDATE`, [projectId]);
  for (const m of miles) lines.push({ description: `${p.name}: milestone ${m.name}`, quantity: 1, unitPrice: Number(m.amount), taxCode, projectId, unitId: p.unit_id ?? undefined });
  if (!lines.length) throw new ValidationError('nothing to invoice: no approved billable hours or reached milestones are waiting');
  const inv = await createInvoice(tx, ctx, { companyId: p.company_id, kind: 'sales_invoice', partyId: p.customer_id, date: input.date,
    currency: p.currency, fxRate: input.fxRate, lines, source: { type: 'prj.project', id: projectId }, notes: `Project ${p.code}` });
  if (times.length) await tx.query('UPDATE prj.timesheets SET invoice_id = $2 WHERE id = ANY($1)', [times.map((t) => t.id), inv.id]);
  if (miles.length) await tx.query('UPDATE prj.milestones SET invoice_id = $2 WHERE id = ANY($1)', [miles.map((m) => m.id), inv.id]);
  return inv;
}

const ACTUALS = `SELECT l.project_id,
    coalesce(sum(CASE WHEN a.type = 'revenue' THEN l.credit - l.debit END), 0)::float AS revenue,
    coalesce(sum(CASE WHEN a.type = 'expense' THEN l.debit - l.credit END), 0)::float AS cost
  FROM fin.journal_lines l JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' JOIN fin.accounts a ON a.id = l.account_id
 WHERE l.project_id IS NOT NULL GROUP BY l.project_id`;

export async function listProjects(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'prj.manage', { unitId: companyId });
  return many(tx, `SELECT p.*, c.name AS customer_name, coalesce(x.revenue, 0) AS revenue, coalesce(x.cost, 0) AS cost,
                          coalesce(x.revenue, 0) - coalesce(x.cost, 0) AS margin,
                          (SELECT coalesce(sum(hours), 0)::float FROM prj.timesheets t WHERE t.project_id = p.id AND t.status = 'approved') AS hours
                     FROM prj.projects p LEFT JOIN mdm.parties c ON c.id = p.customer_id LEFT JOIN (${ACTUALS}) x ON x.project_id = p.id
                    WHERE p.company_id = $1 ORDER BY p.status, p.code`, [companyId]);
}

/** Budget against actuals, unbilled work and the cost breakdown by account. */
export async function projectStatus(tx: Tx, ctx: Ctx, projectId: string) {
  const p = await project(tx, projectId);
  await authorize(tx, ctx, 'prj.manage', { unitId: p.unit_id ?? p.company_id });
  const x = await one(tx, `SELECT * FROM (${ACTUALS}) x WHERE project_id = $1`, [projectId]);
  const revenue = round2(x?.revenue ?? 0), cost = round2(x?.cost ?? 0);
  const time = await one(tx, `SELECT coalesce(sum(hours) FILTER (WHERE status = 'approved'), 0)::float AS approved,
      coalesce(sum(hours) FILTER (WHERE status = 'submitted'), 0)::float AS submitted,
      coalesce(sum(hours * bill_rate) FILTER (WHERE status = 'approved' AND billable AND invoice_id IS NULL), 0)::float AS unbilled
    FROM prj.timesheets WHERE project_id = $1`, [projectId]);
  const breakdown = await many(tx, `SELECT a.code, a.name, a.type, sum(l.debit - l.credit)::float AS amount
      FROM fin.journal_lines l JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' JOIN fin.accounts a ON a.id = l.account_id
     WHERE l.project_id = $1 AND a.type IN ('revenue','expense') GROUP BY a.code, a.name, a.type ORDER BY a.code`, [projectId]);
  const milestones = await many(tx, `SELECT m.*, i.no AS invoice_no FROM prj.milestones m LEFT JOIN fin.invoices i ON i.id = m.invoice_id
                                      WHERE m.project_id = $1 ORDER BY m.due_date NULLS LAST, m.name`, [projectId]);
  const team = await many(tx, `SELECT m.*, e.first_name || ' ' || e.last_name AS name FROM prj.members m JOIN org.employees e ON e.id = m.employee_id
                                WHERE m.project_id = $1 ORDER BY e.last_name`, [projectId]);
  const unbilledMilestones = milestones.filter((m) => m.status === 'reached' && !m.invoice_id).reduce((s, m) => s + Number(m.amount), 0);
  const budget = Number(p.budget_cost);
  return {
    project: p, team, milestones, breakdown,
    revenue, cost, margin: round2(revenue - cost), marginPct: revenue ? round2((revenue - cost) / revenue * 100) : null,
    budgetCost: budget, budgetUsedPct: budget ? round2(cost / budget * 100) : null, overBudget: budget > 0 && cost > budget,
    hours: { approved: time.approved, submitted: time.submitted, budget: Number(p.budget_hours) },
    unbilled: round2(time.unbilled + unbilledMilestones),
  };
}
