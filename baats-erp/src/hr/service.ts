import { fixed } from '../core/money.ts';
import { emit } from '../int/webhooks.ts';
import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';
import { insertDefinition, onWorkflowComplete, submit } from '../workflow/engine.ts';
import { company, post, resolveAccount, roundMoney, type PostingLine } from '../fin/ledger.ts';
import { companyPack, uaeGratuity, type EndReason } from '../fin/country.ts';
import { ensureRoleAccount } from '../fin/setup.ts';

/**
 * HR and payroll. The country pack of the company decides the end-of-service rule,
 * social insurance (Saudi GOSI) and whether the UAE WPS file is produced.
 * UAE rules (BAATS Accounting):
 *   contracts      basic + housing + transport + other allowances, WPS details
 *   leave          requests approved by the line manager (or HR) through the workflow engine;
 *                  annual leave accrues monthly; unpaid leave reduces pay
 *   payroll        monthly run, pro-rated for joiners, leavers and unpaid leave;
 *                  Dr 5000 Salaries (per cost center) | Cr 2210 Salaries payable | Cr 1260 advance recovery
 *   gratuity       end-of-service benefit per UAE labour law, as BAATS eosb(): 21 days' basic per
 *                  year for the first 5 years, 30 days after, none before 1 year, capped at 24 months'
 *                  basic; daily wage = basic / 30. The provision is trued up with each payroll:
 *                  Dr 5920 | Cr 2500 for the change
 *   payment        Dr 2210 | Cr bank, with the WPS salary information file (SIF)
 * Saudi Arabia: end-of-service per Labor Law articles 84 and 85 on basic plus housing;
 *   GOSI from the company's contribution rules, by nationality, on basic plus housing up
 *   to the cap: the employee share is deducted from net pay, the employer share is
 *   Dr 5930 GOSI expense, and both are Cr 2220 GOSI payable.
 */

export const LEAVE_WORKFLOW = 'hr.leave.approval';
const DAY = 86_400_000;
const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const days = (from: string, to: string) => Math.round((toDate(to).getTime() - toDate(from).getTime()) / DAY);
const dstr = (v: Date | string | null) => (v === null ? null : typeof v === 'string' ? v : iso(v));

/** BAATS eosb(): UAE gratuity accrued at a date, from the join date and basic salary. */
export const gratuity = uaeGratuity;

/** The end-of-service benefit of a contract under its company's country rules. */
async function endOfService(tx: Tx, k: { company_id: string; employee_id: string; basic: unknown; housing: unknown; start_date: Date | string; nationality?: string | null },
  at: string, reason?: EndReason | null) {
  const pack = await companyPack(tx, k.company_id);
  const nationality = k.nationality !== undefined ? k.nationality
    : (await one(tx, 'SELECT nationality FROM org.employees WHERE id = $1', [k.employee_id]))?.nationality ?? null;
  return pack.endOfService({ basic: Number(k.basic), housing: Number(k.housing) }, dstr(k.start_date)!, at, reason, nationality === pack.country);
}

export interface ContractInput {
  employeeId: string; companyId: string; startDate: string; endDate?: string; contractType?: 'limited' | 'unlimited';
  basic: number; housing?: number; transport?: number; otherAllowances?: number; currency?: string; annualLeaveDays?: number;
  wpsPersonId?: string; bankRoutingCode?: string; iban?: string;
}

export async function createContract(tx: Tx, ctx: Ctx, input: ContractInput) {
  const emp = await one(tx, 'SELECT * FROM org.employees WHERE id = $1', [input.employeeId]);
  if (!emp) throw new ValidationError('unknown employee');
  await authorize(tx, ctx, 'hr.manage', { unitId: emp.unit_id });
  const c = await company(tx, input.companyId);
  if (input.wpsPersonId && !/^\d{14}$/.test(input.wpsPersonId)) throw new ValidationError('the WPS personal number has 14 digits');
  if (input.bankRoutingCode && !/^\d{9}$/.test(input.bankRoutingCode)) throw new ValidationError('the bank routing code has 9 digits');
  const pack = await companyPack(tx, input.companyId);
  if (input.iban && !pack.iban.re.test(input.iban.replace(/\s/g, ''))) throw new ValidationError(pack.iban.message);
  if (await one(tx, `SELECT 1 FROM hr.contracts WHERE employee_id = $1 AND status = 'active'`, [input.employeeId])) {
    throw new ConflictError('the employee already has an active contract; end it first');
  }
  const row = await one(tx, `INSERT INTO hr.contracts (tenant_id, employee_id, company_id, start_date, end_date, contract_type, basic, housing, transport,
      other_allowances, currency, annual_leave_days, wps_person_id, bank_routing_code, iban)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [input.employeeId, input.companyId, input.startDate, input.endDate ?? null, input.contractType ?? 'unlimited', input.basic,
      input.housing ?? 0, input.transport ?? 0, input.otherAllowances ?? 0, input.currency ?? c.base_currency, input.annualLeaveDays ?? 30,
      input.wpsPersonId ?? null, input.bankRoutingCode ?? null, input.iban?.replace(/\s/g, '') ?? null]);
  if (!emp.hire_date) await tx.query('UPDATE org.employees SET hire_date = $2 WHERE id = $1', [emp.id, input.startDate]);
  return row;
}

export const END_REASONS: EndReason[] = ['contract_end', 'termination', 'resignation', 'retirement', 'death', 'mutual'];

/** End employment: the last payroll pro-rates to this date and the final end-of-service benefit is shown. */
export async function endContract(tx: Tx, ctx: Ctx, contractId: string, endDate: string, reason: EndReason = 'termination') {
  const k = await one(tx, 'SELECT k.*, e.unit_id FROM hr.contracts k JOIN org.employees e ON e.id = k.employee_id WHERE k.id = $1', [contractId]);
  if (!k) throw new NotFoundError('contract');
  await authorize(tx, ctx, 'hr.manage', { unitId: k.unit_id });
  if (k.status !== 'active') throw new ConflictError('the contract has already ended');
  if (endDate < dstr(k.start_date)!) throw new ValidationError('the end date is before the start date');
  if (!END_REASONS.includes(reason)) throw new ValidationError(`the reason is one of ${END_REASONS.join(', ')}`);
  await tx.query(`UPDATE hr.contracts SET status = 'ended', end_date = $2, end_reason = $3 WHERE id = $1`, [contractId, endDate, reason]);
  await tx.query(`UPDATE org.employees SET status = 'terminated' WHERE id = $1`, [k.employee_id]);
  return { contractId, endDate, reason, finalGratuity: await endOfService(tx, k, endDate, reason) };
}

export async function listContracts(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'hr.manage', { unitId: companyId });
  return many(tx, `SELECT k.*, e.employee_no, e.first_name || ' ' || e.last_name AS employee_name, u.name AS unit_name,
                          (k.basic + k.housing + k.transport + k.other_allowances)::float AS monthly_total
                     FROM hr.contracts k JOIN org.employees e ON e.id = k.employee_id JOIN org.units u ON u.id = e.unit_id
                    WHERE k.company_id = $1 ORDER BY k.status, e.employee_no`, [companyId]);
}

// --- Leave ---------------------------------------------------------------------------

async function ensureLeaveWorkflow(tx: Tx) {
  if (!(await one(tx, 'SELECT 1 FROM iam.roles WHERE code = $1', ['HR_MANAGER']))) {
    await tx.query(`INSERT INTO iam.roles (tenant_id, code, name, is_system) VALUES (app.tenant(), 'HR_MANAGER', 'HR manager', true)`);
  }
  if (!(await one(tx, 'SELECT 1 FROM wf.definitions WHERE code = $1', [LEAVE_WORKFLOW]))) {
    await insertDefinition(tx, {
      code: LEAVE_WORKFLOW, name: 'Leave approval', entityType: 'hr.leave',
      definition: { steps: [{ key: 'manager', name: 'Line manager or HR', dueHours: 48,
        approvers: [{ type: 'reporting_manager' }, { type: 'role', role: 'HR_MANAGER' }, { type: 'role', role: 'TENANT_ADMIN' }],
        escalateTo: [{ type: 'role', role: 'HR_MANAGER' }] }] },
    });
  }
}

/** Annual leave earned to a date (monthly accrual from the contract start) less leave approved or pending. */
export async function leaveBalance(tx: Tx, ctx: Ctx, employeeId: string, asOf: string) {
  const emp = await one(tx, 'SELECT * FROM org.employees WHERE id = $1', [employeeId]);
  if (!emp) throw new NotFoundError('employee');
  const self = await one(tx, 'SELECT 1 FROM iam.users WHERE id = $1 AND employee_id = $2', [ctx.userId, employeeId]);
  if (!self) await authorize(tx, ctx, 'hr.manage', { unitId: emp.unit_id });
  const k = await one(tx, `SELECT * FROM hr.contracts WHERE employee_id = $1 AND status = 'active'`, [employeeId]);
  if (!k) return { employeeId, entitled: 0, taken: 0, balance: 0, note: 'no active contract' };
  const start = dstr(k.start_date)!;
  const months = asOf < start ? 0 : (toDate(asOf).getUTCFullYear() - toDate(start).getUTCFullYear()) * 12
    + toDate(asOf).getUTCMonth() - toDate(start).getUTCMonth() - (toDate(asOf).getUTCDate() < toDate(start).getUTCDate() ? 1 : 0);
  const entitled = Math.round(months * k.annual_leave_days / 12 * 10) / 10;
  const t = await one(tx, `SELECT coalesce(sum(days), 0)::float AS d FROM hr.leave_requests
                            WHERE employee_id = $1 AND leave_type = 'annual' AND status IN ('approved','pending_approval') AND date_from >= $2`, [employeeId, start]);
  return { employeeId, entitled, taken: t.d, balance: Math.round((entitled - t.d) * 10) / 10 };
}

export async function requestLeave(tx: Tx, ctx: Ctx, input: { employeeId: string; leaveType: string; dateFrom: string; dateTo: string; reason?: string }) {
  const emp = await one(tx, 'SELECT * FROM org.employees WHERE id = $1', [input.employeeId]);
  if (!emp) throw new ValidationError('unknown employee');
  const self = await one(tx, 'SELECT 1 FROM iam.users WHERE id = $1 AND employee_id = $2', [ctx.userId, input.employeeId]);
  if (!self) await authorize(tx, ctx, 'hr.manage', { unitId: emp.unit_id });
  if (input.dateTo < input.dateFrom) throw new ValidationError('the leave ends before it starts');
  const n = days(input.dateFrom, input.dateTo) + 1;
  const overlap = await one(tx, `SELECT 1 FROM hr.leave_requests WHERE employee_id = $1 AND status IN ('approved','pending_approval')
                                   AND date_from <= $3 AND date_to >= $2`, [input.employeeId, input.dateFrom, input.dateTo]);
  if (overlap) throw new ConflictError('the employee already has leave in these dates');
  if (input.leaveType === 'annual') {
    const b = await leaveBalance(tx, ctx, input.employeeId, input.dateTo);
    if (n > b.balance + 1e-9) throw new ValidationError(`not enough annual leave: ${n} days asked, ${b.balance} available`);
  }
  await ensureLeaveWorkflow(tx);
  const r = await one(tx, `INSERT INTO hr.leave_requests (tenant_id, employee_id, leave_type, date_from, date_to, days, reason, requested_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [input.employeeId, input.leaveType, input.dateFrom, input.dateTo, n, input.reason ?? null, ctx.userId]);
  const inst = await submit(tx, ctx, { code: LEAVE_WORKFLOW, entityType: 'hr.leave', entityId: r.id, subjectUnitId: emp.unit_id,
    payload: { leave_type: input.leaveType, days: n, date_from: input.dateFrom, date_to: input.dateTo, employee: `${emp.first_name} ${emp.last_name}` } });
  return { ...r, workflowInstanceId: inst.id };
}

onWorkflowComplete('hr.leave', async (tx, inst) => {
  const approved = inst.status === 'approved';
  await tx.query(`UPDATE hr.leave_requests SET status = $2 WHERE id = $1 AND status = 'pending_approval'`, [inst.entity_id, approved ? 'approved' : 'rejected']);
  if (approved) {
    const r = await one(tx, `SELECT r.*, e.employee_no, k.company_id FROM hr.leave_requests r JOIN org.employees e ON e.id = r.employee_id
                              LEFT JOIN hr.contracts k ON k.employee_id = r.employee_id AND k.status = 'active' WHERE r.id = $1`, [inst.entity_id]);
    if (r) await emit(tx, 'leave.approved', r.company_id ?? null, { leave_id: r.id, employee_no: r.employee_no, leave_type: r.leave_type,
      from: dstr(r.date_from), to: dstr(r.date_to), days: Number(r.days) });
  }
});

export async function listLeave(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'hr.manage', { unitId: companyId });
  return many(tx, `SELECT r.*, e.employee_no, e.first_name || ' ' || e.last_name AS employee_name FROM hr.leave_requests r
                     JOIN org.employees e ON e.id = r.employee_id
                    WHERE EXISTS (SELECT 1 FROM hr.contracts k WHERE k.employee_id = e.id AND k.company_id = $1)
                    ORDER BY r.date_from DESC`, [companyId]);
}

// --- Payroll -------------------------------------------------------------------------

function periodBounds(period: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new ValidationError('the payroll period is YYYY-MM');
  const [y, m] = period.split('-').map(Number);
  const from = `${period}-01`;
  const to = iso(new Date(Date.UTC(y, m, 0)));
  return { from, to, daysInPeriod: Number(to.slice(8)) };
}

/** Prepare (or recalculate) the draft payroll for a month. inputs add variable pay or deductions. */
export async function runPayroll(tx: Tx, ctx: Ctx, input: { companyId: string; period: string; inputs?: { employeeId: string; additions?: number; deductions?: number }[] }) {
  await authorize(tx, ctx, 'hr.payroll.run', { unitId: input.companyId });
  await company(tx, input.companyId);
  const { from, to, daysInPeriod } = periodBounds(input.period);
  const existing = await one(tx, 'SELECT * FROM hr.payroll_runs WHERE company_id = $1 AND period = $2 FOR UPDATE', [input.companyId, input.period]);
  if (existing && existing.status !== 'draft') throw new ConflictError(`payroll for ${input.period} is already ${existing.status}`);
  if (existing) await tx.query('DELETE FROM hr.payroll_runs WHERE id = $1', [existing.id]);
  const run = await one(tx, `INSERT INTO hr.payroll_runs (tenant_id, company_id, period, created_by) VALUES (app.tenant(), $1, $2, $3) RETURNING *`,
    [input.companyId, input.period, ctx.userId]);

  const rules = await many(tx, `SELECT * FROM hr.contribution_rules WHERE company_id = $1 AND active ORDER BY code`, [input.companyId]);
  const country = (await company(tx, input.companyId)).country_code;
  const contracts = await many(tx, `SELECT k.*, e.unit_id, e.nationality, e.employee_no FROM hr.contracts k JOIN org.employees e ON e.id = k.employee_id
                                     WHERE k.company_id = $1 AND k.start_date <= $3 AND (k.end_date IS NULL OR k.end_date >= $2)
                                     ORDER BY e.employee_no`, [input.companyId, from, to]);
  if (!contracts.length) throw new ValidationError('no employment contracts in this company for the period');
  const extras = new Map((input.inputs ?? []).map((i) => [i.employeeId, i]));
  let gross = 0, ded = 0, net = 0, eeTotal = 0, erTotal = 0;
  const unknownNationality = rules.some((r) => r.applies_to !== 'all') ? contracts.filter((k) => !k.nationality).map((k) => k.employee_no) : [];
  if (unknownNationality.length) throw new ValidationError(`set the nationality of ${unknownNationality.join(', ')}; social insurance depends on it`);
  for (const k of contracts) {
    const start = dstr(k.start_date)! > from ? dstr(k.start_date)! : from;
    const end = k.end_date && dstr(k.end_date)! < to ? dstr(k.end_date)! : to;
    const employed = days(start, end) + 1;
    const unpaid = await one(tx, `SELECT coalesce(sum(greatest(0, least(date_to, $3::date) - greatest(date_from, $2::date) + 1)), 0)::float AS d
                                    FROM hr.leave_requests WHERE employee_id = $1 AND leave_type = 'unpaid' AND status = 'approved'
                                     AND date_from <= $3 AND date_to >= $2`, [k.employee_id, start, end]);
    const paidDays = Math.max(0, employed - unpaid.d);
    const share = paidDays / daysInPeriod;
    const basic = roundMoney(Number(k.basic) * share);
    const allowances = roundMoney((Number(k.housing) + Number(k.transport) + Number(k.other_allowances)) * share);
    const x = extras.get(k.employee_id);
    const additions = roundMoney(x?.additions ?? 0), deductions = roundMoney(x?.deductions ?? 0);
    const g = roundMoney(basic + allowances + additions);
    // Social insurance on the contractual base, pro-rated like pay, up to the monthly cap.
    const contributions = [];
    for (const r of rules) {
      const national = k.nationality === country;
      if (r.applies_to === 'nationals' && !national) continue;
      if (r.applies_to === 'non_nationals' && national) continue;
      const full = r.base === 'basic' ? Number(k.basic) : r.base === 'basic_housing' ? Number(k.basic) + Number(k.housing)
        : Number(k.basic) + Number(k.housing) + Number(k.transport) + Number(k.other_allowances);
      const base = roundMoney(Math.min(full, r.monthly_cap === null ? Infinity : Number(r.monthly_cap)) * share);
      // Some employer rates step up with service (Bahrain's leaving indemnity after three years).
      const served = days(dstr(k.start_date)!, to) / 365.25;
      const employerPct = r.after_years !== null && served >= Number(r.after_years) ? Number(r.employer_pct_after) : Number(r.employer_pct);
      const employee = roundMoney(base * Number(r.employee_pct) / 100), employer = roundMoney(base * employerPct / 100);
      if (employee || employer) contributions.push({ code: r.code, name: r.name, base, employee, employer });
    }
    const ee = roundMoney(contributions.reduce((x, c) => x + c.employee, 0)), er = roundMoney(contributions.reduce((x, c) => x + c.employer, 0));
    const n = roundMoney(g - deductions - ee);
    if (n < 0) throw new ValidationError(`deductions for employee ${k.employee_no} exceed the month's pay`);
    const grat = await endOfService(tx, k, end);
    await tx.query(`INSERT INTO hr.payslips (tenant_id, run_id, employee_id, contract_id, unit_id, days_in_period, paid_days, unpaid_leave_days,
        basic, allowances, additions, deductions, gross, net, gratuity_balance, employee_contributions, employer_contributions, contributions)
      VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [run.id, k.employee_id, k.id, k.unit_id, daysInPeriod, paidDays, unpaid.d, basic, allowances, additions, deductions, g, n, grat, ee, er, JSON.stringify(contributions)]);
    gross += g; ded += deductions; net += n; eeTotal += ee; erTotal += er;
  }
  for (const id of extras.keys()) {
    if (!contracts.some((k) => k.employee_id === id)) throw new ValidationError(`employee ${id} has no contract in this payroll`);
  }
  await tx.query(`UPDATE hr.payroll_runs SET gross_total = $2, deductions_total = $3, net_total = $4,
      employee_contributions_total = $5, employer_contributions_total = $6 WHERE id = $1`,
    [run.id, roundMoney(gross), roundMoney(ded), roundMoney(net), roundMoney(eeTotal), roundMoney(erTotal)]);
  return getPayroll(tx, ctx, run.id);
}

export async function getPayroll(tx: Tx, ctx: Ctx, runId: string) {
  const run = await one(tx, 'SELECT * FROM hr.payroll_runs WHERE id = $1', [runId]);
  if (!run) throw new NotFoundError('payroll run');
  await authorize(tx, ctx, 'hr.payroll.run', { unitId: run.company_id });
  const payslips = await many(tx, `SELECT s.*, e.employee_no, e.first_name || ' ' || e.last_name AS employee_name, u.name AS unit_name
                                     FROM hr.payslips s JOIN org.employees e ON e.id = s.employee_id JOIN org.units u ON u.id = s.unit_id
                                    WHERE s.run_id = $1 ORDER BY e.employee_no`, [runId]);
  return { ...run, payslips };
}

export async function listPayrolls(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'hr.payroll.run', { unitId: companyId });
  return many(tx, 'SELECT * FROM hr.payroll_runs WHERE company_id = $1 ORDER BY period DESC', [companyId]);
}

async function provisionBalance(tx: Tx, companyId: string): Promise<number> {
  const r = await one(tx, `SELECT coalesce(sum(l.credit - l.debit), 0)::float AS b FROM fin.journal_lines l
                             JOIN fin.journals j ON j.id = l.journal_id JOIN fin.accounts a ON a.id = l.account_id
                            WHERE j.company_id = $1 AND j.status = 'posted' AND a.system_role = 'eosb_provision'`, [companyId]);
  return roundMoney(r.b);
}

/** Post the payroll and true up the gratuity provision to what the payslips show. */
export async function postPayroll(tx: Tx, ctx: Ctx, runId: string, date?: string) {
  const run = await one(tx, 'SELECT * FROM hr.payroll_runs WHERE id = $1 FOR UPDATE', [runId]);
  if (!run) throw new NotFoundError('payroll run');
  await authorize(tx, ctx, 'hr.payroll.run', { unitId: run.company_id, attrs: { amount: Number(run.gross_total) } });
  if (run.status !== 'draft') throw new ConflictError(`the payroll is already ${run.status}`);
  const on = date ?? periodBounds(run.period).to;
  const byUnit = await many(tx, `SELECT unit_id, sum(gross)::float AS gross FROM hr.payslips WHERE run_id = $1 GROUP BY unit_id`, [runId]);
  const lines: PostingLine[] = byUnit.filter((u) => u.gross > 0).map((u) => ({ account: 'role:salaries', debit: roundMoney(u.gross), unitId: u.unit_id, description: `Payroll ${run.period}` }));
  lines.push({ account: 'role:salaries_payable', credit: Number(run.net_total), description: `Net pay ${run.period}` });
  if (Number(run.deductions_total) > 0) lines.push({ account: 'role:employee_advances', credit: Number(run.deductions_total), description: 'Recovered from salaries' });
  const ee = Number(run.employee_contributions_total), er = Number(run.employer_contributions_total);
  if (ee > 0 || er > 0) {
    const payable = await ensureRoleAccount(tx, run.company_id, 'social_insurance_payable');
    if (er > 0) {
      const expense = await ensureRoleAccount(tx, run.company_id, 'social_insurance_expense');
      const erByUnit = await many(tx, `SELECT unit_id, sum(employer_contributions)::float AS er FROM hr.payslips WHERE run_id = $1 GROUP BY unit_id`, [runId]);
      for (const u of erByUnit) if (u.er > 0) lines.push({ account: expense, debit: roundMoney(u.er), unitId: u.unit_id, description: `Employer social insurance ${run.period}` });
    }
    lines.push({ account: payable, credit: roundMoney(ee + er), description: `Social insurance ${run.period} (employees ${fixed(ee)}, employer ${fixed(er)})` });
  }
  const j = await post(tx, ctx, { companyId: run.company_id, type: 'payroll', date: on, memo: `Payroll ${run.period}`, source: { type: 'hr.payroll', id: runId }, lines });

  // Gratuity: the provision equals what everyone on this payroll has accrued (a leaver's to the last day).
  // Leavers are paid from the provision with paySettlement, before they drop off the next payroll.
  const target = await one(tx, `SELECT coalesce(sum(gratuity_balance), 0)::float AS t FROM hr.payslips WHERE run_id = $1`, [runId]);
  const change = roundMoney(target.t - await provisionBalance(tx, run.company_id));
  let gj = null;
  if (change !== 0) {
    gj = await post(tx, ctx, { companyId: run.company_id, type: 'gratuity', date: on, memo: `End-of-service provision ${run.period}`,
      source: { type: 'hr.gratuity', id: runId },
      lines: change > 0
        ? [{ account: 'role:eosb_expense', debit: change }, { account: 'role:eosb_provision', credit: change }]
        : [{ account: 'role:eosb_provision', debit: -change }, { account: 'role:eosb_expense', credit: -change }] });
  }
  await tx.query(`UPDATE hr.payroll_runs SET status = 'posted', journal_id = $2, gratuity_journal_id = $3, gratuity_change = $4 WHERE id = $1`,
    [runId, j.id, gj?.id ?? null, change]);
  await emit(tx, 'payroll.posted', run.company_id, { run_id: runId, period: run.period, gross: Number(run.gross_total), net: Number(run.net_total),
    employees: Number((await one(tx, 'SELECT count(*) AS n FROM hr.payslips WHERE run_id = $1', [runId])).n), journal_no: j.no });
  return getPayroll(tx, ctx, runId);
}

/**
 * Final settlement for a leaver: the end-of-service benefit, under the country's
 * rule and the reason the contract ended, is paid out of the 2500 provision. The
 * provision held the full entitlement; whatever a resignation does not pay is
 * released by the next payroll's true-up.
 */
export async function paySettlement(tx: Tx, ctx: Ctx, contractId: string, input: { date: string; bankAccount?: string }) {
  const k = await one(tx, `SELECT k.*, e.employee_no, e.first_name || ' ' || e.last_name AS name FROM hr.contracts k
                             JOIN org.employees e ON e.id = k.employee_id WHERE k.id = $1`, [contractId]);
  if (!k) throw new NotFoundError('contract');
  await authorize(tx, ctx, 'hr.payroll.run', { unitId: k.company_id });
  if (k.status !== 'ended') throw new ConflictError('end the contract first');
  if (await one(tx, `SELECT 1 FROM fin.journals WHERE source_type = 'hr.settlement' AND source_id = $1 AND status = 'posted'`, [contractId])) {
    throw new ConflictError('the settlement is already paid');
  }
  const amount = await endOfService(tx, k, dstr(k.end_date)!, k.end_reason);
  if (amount === 0) return { amount: 0, journalId: null, note: 'no end-of-service benefit is due for this length of service and reason' };
  const bank = await resolveAccount(tx, k.company_id, input.bankAccount ?? 'role:bank');
  const j = await post(tx, ctx, { companyId: k.company_id, type: 'payroll_payment', date: input.date,
    memo: `End-of-service gratuity ${k.employee_no} ${k.name}`, source: { type: 'hr.settlement', id: contractId },
    lines: [{ account: 'role:eosb_provision', debit: amount }, { account: bank.id, credit: amount }] });
  return { amount, journalId: j.id };
}

/** Pay net salaries from a bank account; in the UAE also produce the WPS salary information file. */
export async function payPayroll(tx: Tx, ctx: Ctx, runId: string, input: { date: string; bankAccount?: string; employerId?: string; employerBankCode?: string }) {
  const run = await one(tx, 'SELECT * FROM hr.payroll_runs WHERE id = $1 FOR UPDATE', [runId]);
  if (!run) throw new NotFoundError('payroll run');
  await authorize(tx, ctx, 'hr.payroll.run', { unitId: run.company_id, attrs: { amount: Number(run.net_total) } });
  if (run.status !== 'posted') throw new ConflictError(run.status === 'paid' ? 'the payroll is already paid' : 'post the payroll first');
  const bank = await resolveAccount(tx, run.company_id, input.bankAccount ?? 'role:bank');
  const pack = await companyPack(tx, run.company_id);
  const wps = pack.wps;
  if (wps && (!input.employerId || !input.employerBankCode)) throw new ValidationError('the MOHRE employer id and the employer bank routing code are needed for the WPS file');
  const sif = wps ? await wpsFile(tx, runId, input.employerId!, input.employerBankCode!, new Date()) : { fileName: null, content: null, records: 0, total: Number(run.net_total) };
  const j = await post(tx, ctx, { companyId: run.company_id, type: 'payroll_payment', date: input.date, memo: `Salaries paid ${run.period}${wps ? ' (WPS)' : ''}`,
    source: { type: 'hr.payroll', id: runId },
    lines: [{ account: 'role:salaries_payable', debit: Number(run.net_total) }, { account: bank.id, credit: Number(run.net_total) }] });
  await tx.query(`UPDATE hr.payroll_runs SET status = 'paid', payment_journal_id = $2 WHERE id = $1`, [runId, j.id]);
  return { journalId: j.id, ...sif, note: pack.payrollFileGap ?? null };
}

/**
 * UAE WPS salary information file: one EDR record per employee and an SCR control record.
 * EDR, person id (14), agent routing code (9), IBAN, pay start, pay end, days, fixed pay, variable pay, days on leave
 * SCR, employer id (13), bank code (9), file date, file time (HHMM), salary month (MMYYYY), records, total, AED, reference
 */
export async function wpsFile(tx: Tx, runId: string, employerId: string, employerBankCode: string, now: Date) {
  if (!/^\d{13}$/.test(employerId)) throw new ValidationError('the MOHRE employer (establishment) id has 13 digits');
  if (!/^\d{9}$/.test(employerBankCode)) throw new ValidationError('the employer bank routing code has 9 digits');
  const run = await one(tx, 'SELECT * FROM hr.payroll_runs WHERE id = $1', [runId]);
  const { from, to } = periodBounds(run.period);
  const slips = await many(tx, `SELECT s.*, k.wps_person_id, k.bank_routing_code, k.iban, e.employee_no FROM hr.payslips s
                                  JOIN hr.contracts k ON k.id = s.contract_id JOIN org.employees e ON e.id = s.employee_id
                                 WHERE s.run_id = $1 AND s.net > 0 ORDER BY e.employee_no`, [runId]);
  const missing = slips.filter((s) => !s.wps_person_id || !s.bank_routing_code || !s.iban).map((s) => s.employee_no);
  if (missing.length) throw new ValidationError(`WPS details (person id, routing code, IBAN) are missing for ${missing.join(', ')}`);
  const m2 = (n: number) => n.toFixed(2);
  let total = 0;
  const edr = slips.map((s) => {
    const net = Number(s.net), variable = Math.min(Number(s.additions), net), fixed = roundMoney(net - variable);
    total += net;
    return ['EDR', s.wps_person_id, s.bank_routing_code, s.iban, from, to, Math.round(Number(s.paid_days)), m2(fixed), m2(variable), Math.round(Number(s.unpaid_leave_days))].join(',');
  });
  const stamp = iso(now);
  const hhmm = now.toISOString().slice(11, 16).replace(':', '');
  const scr = ['SCR', employerId, employerBankCode, stamp, hhmm, run.period.slice(5) + run.period.slice(0, 4), edr.length, m2(roundMoney(total)), 'AED', `PAYROLL-${run.period}`].join(',');
  const fileName = `${employerId}${now.toISOString().replace(/[-:T]/g, '').slice(2, 14)}.SIF`;
  return { fileName, content: [...edr, scr].join('\r\n') + '\r\n', records: edr.length, total: roundMoney(total) };
}

// --- Social insurance rules ----------------------------------------------------------------

export async function listContributionRules(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'hr.manage', { unitId: companyId });
  const pack = await companyPack(tx, companyId);
  const rules = await many(tx, `SELECT id, code, name, applies_to, employee_pct::float, employer_pct::float, base, monthly_cap::float, active,
                                         after_years::float, employer_pct_after::float
                                  FROM hr.contribution_rules WHERE company_id = $1 ORDER BY code`, [companyId]);
  return { country: pack.country, endOfService: pack.endOfServiceRule, wps: pack.wps, payrollFileGap: pack.payrollFileGap ?? null, rules };
}

export interface ContributionRuleInput {
  code?: string; name?: string; appliesTo?: 'nationals' | 'non_nationals' | 'all'; employeePct?: number; employerPct?: number;
  base?: 'basic' | 'basic_housing' | 'gross'; monthlyCap?: number | null; active?: boolean;
  /** A higher employer rate from this many years of service; null removes the step. */
  afterYears?: number | null; employerPctAfter?: number | null;
}

/** Add a rule, or change one by its code (rates change by law; payrolls already posted keep the old figures). */
export async function saveContributionRule(tx: Tx, ctx: Ctx, companyId: string, input: ContributionRuleInput & { code: string }) {
  await authorize(tx, ctx, 'hr.manage', { unitId: companyId });
  await company(tx, companyId);
  if (!/^[A-Z0-9_]{2,30}$/.test(input.code)) throw new ValidationError('the code is 2 to 30 capital letters, digits or _');
  const old = await one(tx, 'SELECT * FROM hr.contribution_rules WHERE company_id = $1 AND code = $2', [companyId, input.code]);
  if (!old && !input.name) throw new ValidationError('a new rule needs a name');
  const v = {
    name: input.name ?? old.name, applies_to: input.appliesTo ?? old?.applies_to ?? 'all', employee_pct: input.employeePct ?? old?.employee_pct ?? 0,
    employer_pct: input.employerPct ?? old?.employer_pct ?? 0, base: input.base ?? old?.base ?? 'basic_housing',
    monthly_cap: input.monthlyCap !== undefined ? input.monthlyCap : old?.monthly_cap ?? null, active: input.active ?? old?.active ?? true,
    after_years: input.afterYears !== undefined ? input.afterYears : old?.after_years ?? null,
    employer_pct_after: input.employerPctAfter !== undefined ? input.employerPctAfter : old?.employer_pct_after ?? null,
  };
  if ((v.after_years === null) !== (v.employer_pct_after === null)) throw new ValidationError('a stepped rate needs both the years of service and the later employer rate');
  if (v.after_years !== null && !(Number(v.after_years) > 0 && Number(v.after_years) <= 50)) throw new ValidationError('the years of service are more than 0 and at most 50');
  if (v.employer_pct_after !== null && !(Number(v.employer_pct_after) >= 0 && Number(v.employer_pct_after) <= 100)) throw new ValidationError('rates are 0 to 100 percent');
  for (const k of ['employee_pct', 'employer_pct'] as const) if (!(Number(v[k]) >= 0 && Number(v[k]) <= 100)) throw new ValidationError('rates are 0 to 100 percent');
  return one(tx, `INSERT INTO hr.contribution_rules (tenant_id, company_id, code, name, applies_to, employee_pct, employer_pct, base, monthly_cap, active,
                     after_years, employer_pct_after)
      VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (tenant_id, company_id, code) DO UPDATE SET name = EXCLUDED.name, applies_to = EXCLUDED.applies_to, employee_pct = EXCLUDED.employee_pct,
        employer_pct = EXCLUDED.employer_pct, base = EXCLUDED.base, monthly_cap = EXCLUDED.monthly_cap, active = EXCLUDED.active,
        after_years = EXCLUDED.after_years, employer_pct_after = EXCLUDED.employer_pct_after
      RETURNING id, code, name, applies_to, employee_pct::float, employer_pct::float, base, monthly_cap::float, active, after_years::float, employer_pct_after::float`,
    [companyId, input.code, v.name, v.applies_to, v.employee_pct, v.employer_pct, v.base, v.monthly_cap, v.active, v.after_years, v.employer_pct_after]);
}
