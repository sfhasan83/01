import { NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { decide } from '../iam/authz.ts';
import { leaveBalance, requestLeave } from '../hr/service.ts';
import { CATEGORIES, myClaims } from '../hr/expenses.ts';

/**
 * Employee self-service, used by BAATS Mobile: what the signed-in person can see
 * about themselves. Everything is limited to the user's own employee record, so
 * no extra permission is needed; managers approve through the workflow inbox.
 */

async function me(tx: Tx, ctx: Ctx) {
  const u = await one(tx, `SELECT u.id, u.email, u.display_name, u.employee_id FROM iam.users u WHERE u.id = $1`, [ctx.userId]);
  if (!u) throw new NotFoundError('user');
  return u;
}
async function ownEmployee(tx: Tx, ctx: Ctx): Promise<string> {
  const u = await me(tx, ctx);
  if (!u.employee_id) throw new ValidationError('your user is not linked to an employee record; ask HR to link it');
  return u.employee_id;
}

/** Who I am, where I work, my leave balance and how many approvals wait for me. */
export async function profile(tx: Tx, ctx: Ctx) {
  const u = await me(tx, ctx);
  const today = new Date().toISOString().slice(0, 10);
  const emp = u.employee_id ? await one(tx, `SELECT e.id, e.employee_no, e.first_name, e.last_name, e.nationality, ou.name AS unit_name,
        d.title AS designation, m.first_name || ' ' || m.last_name AS manager
      FROM org.employees e JOIN org.units ou ON ou.id = e.unit_id LEFT JOIN org.designations d ON d.id = e.designation_id
      LEFT JOIN org.employees m ON m.id = e.manager_id WHERE e.id = $1`, [u.employee_id]) : null;
  const contract = emp ? await one(tx, `SELECT k.company_id, c.legal_name AS company, k.start_date, k.currency, k.annual_leave_days
      FROM hr.contracts k JOIN fin.companies c ON c.unit_id = k.company_id WHERE k.employee_id = $1 AND k.status = 'active'`, [emp.id]) : null;
  const approvals = Number((await one(tx, `SELECT count(*) AS n FROM wf.tasks WHERE assignee_user_id = $1 AND status = 'open'`, [ctx.userId])).n);
  const dashboard = contract ? (await decide(tx, ctx.userId!, 'bi.dashboard', { unitId: contract.company_id })).allowed : false;
  return {
    user: { id: u.id, email: u.email, name: u.display_name },
    employee: emp, contract,
    leave: emp && contract ? await leaveBalance(tx, ctx, emp.id, today) : null,
    approvals, canSeeDashboard: dashboard,
  };
}

/** My payslips from payrolls that have been posted. */
export async function payslips(tx: Tx, ctx: Ctx) {
  const id = await ownEmployee(tx, ctx);
  return many(tx, `SELECT s.id, r.period, r.status AS payroll_status, k.currency, s.paid_days, s.basic, s.allowances, s.additions, s.deductions,
        s.employee_contributions, s.gross, s.net
      FROM hr.payslips s JOIN hr.payroll_runs r ON r.id = s.run_id JOIN hr.contracts k ON k.id = s.contract_id
     WHERE s.employee_id = $1 AND r.status IN ('posted','paid') ORDER BY r.period DESC LIMIT 36`, [id]);
}

export async function payslip(tx: Tx, ctx: Ctx, payslipId: string) {
  const id = await ownEmployee(tx, ctx);
  const s = await one(tx, `SELECT s.*, r.period, r.status AS payroll_status, k.currency, c.legal_name AS company, e.employee_no, e.first_name || ' ' || e.last_name AS name
      FROM hr.payslips s JOIN hr.payroll_runs r ON r.id = s.run_id JOIN hr.contracts k ON k.id = s.contract_id
      JOIN fin.companies c ON c.unit_id = r.company_id JOIN org.employees e ON e.id = s.employee_id
     WHERE s.id = $1 AND s.employee_id = $2 AND r.status IN ('posted','paid')`, [payslipId, id]);
  if (!s) throw new NotFoundError('payslip');
  return s;
}

/** My leave requests, newest first. */
export async function myLeave(tx: Tx, ctx: Ctx) {
  const id = await ownEmployee(tx, ctx);
  return many(tx, `SELECT id, leave_type, date_from, date_to, days, reason, status, created_at FROM hr.leave_requests
                    WHERE employee_id = $1 ORDER BY date_from DESC LIMIT 50`, [id]);
}

export async function applyForLeave(tx: Tx, ctx: Ctx, input: { leaveType: string; dateFrom: string; dateTo: string; reason?: string }) {
  return requestLeave(tx, ctx, { ...input, employeeId: await ownEmployee(tx, ctx) });
}

export const expenses = myClaims;

/** What the claim form on the phone needs: my company and currency, the categories and the tax codes I can pick. */
export async function expenseOptions(tx: Tx, ctx: Ctx) {
  const id = await ownEmployee(tx, ctx);
  const k = await one(tx, `SELECT k.company_id, c.legal_name AS company, c.base_currency AS currency, c.country_code
      FROM hr.contracts k JOIN fin.companies c ON c.unit_id = k.company_id WHERE k.employee_id = $1 AND k.status = 'active'
      ORDER BY k.start_date DESC LIMIT 1`, [id]);
  if (!k) throw new ValidationError('you have no active contract, so there is no company to claim from');
  const taxCodes = await many(tx, `SELECT code, name, rate, category FROM fin.tax_codes
      WHERE country_code = $1 AND active AND category <> 'reverse_charge' ORDER BY rate DESC, code`, [k.country_code]);
  return {
    companyId: k.company_id, company: k.company, currency: k.currency,
    defaultTaxCode: ['QA', 'KW'].includes(k.country_code) ? 'NV' : 'SR',
    categories: Object.entries(CATEGORIES).map(([code, c]) => ({ code, name: c.name })),
    taxCodes,
  };
}
