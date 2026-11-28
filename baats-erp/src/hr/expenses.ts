import { createHash } from 'node:crypto';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { roundIn } from '../core/money.ts';
import { authorize, decide } from '../iam/authz.ts';
import { insertDefinition, onWorkflowComplete, submit } from '../workflow/engine.ts';
import { company, nextNumber, post, resolveAccount, type PostingLine } from '../fin/ledger.ts';
import { ensureRoleAccount } from '../fin/setup.ts';
import { emit } from '../int/webhooks.ts';

/**
 * Expense claims: what an employee paid out of pocket for the company, with a
 * photo of each receipt. The employee (usually from the phone) submits a claim;
 * the line manager, or HR, approves it; approval posts it (expense accounts and
 * recoverable VAT against 2230 Employee claims payable); finance then pays it
 * from the bank. Amounts are what the employee paid, VAT included, in the
 * company's currency.
 */

export const EXPENSE_WORKFLOW = 'hr.expense.approval';

/** Claim categories and the account each one is charged to (the same codes in every country chart). */
export const CATEGORIES: Record<string, { name: string; account: string }> = {
  travel: { name: 'Travel and transport', account: '5600' },
  accommodation: { name: 'Hotels and accommodation', account: '5600' },
  fuel: { name: 'Fuel and parking', account: '5610' },
  meals: { name: 'Meals and client entertainment', account: '5900' },
  office: { name: 'Office supplies', account: '5500' },
  software: { name: 'Software and subscriptions', account: '5300' },
  fees: { name: 'Government fees', account: '5400' },
  other: { name: 'Other', account: '5900' },
};

const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_RECEIPT = 750_000;

export interface ClaimLineInput {
  date: string; category: string; description: string; amount: number; taxCode?: string;
  receipt?: { fileName: string; contentType: string; dataBase64: string };
}
export interface ClaimInput { companyId: string; employeeId?: string; title: string; lines: ClaimLineInput[]; submit?: boolean }

async function myEmployee(tx: Tx, ctx: Ctx): Promise<string | null> {
  return (await one(tx, 'SELECT employee_id FROM iam.users WHERE id = $1', [ctx.userId]))?.employee_id ?? null;
}

async function ensureWorkflow(tx: Tx) {
  if (await one(tx, 'SELECT 1 FROM wf.definitions WHERE code = $1', [EXPENSE_WORKFLOW])) return;
  if (!(await one(tx, 'SELECT 1 FROM iam.roles WHERE code = $1', ['HR_MANAGER']))) {
    await tx.query(`INSERT INTO iam.roles (tenant_id, code, name, is_system) VALUES (app.tenant(), 'HR_MANAGER', 'HR manager', true)`);
  }
  await insertDefinition(tx, {
    code: EXPENSE_WORKFLOW, name: 'Expense claim approval', entityType: 'hr.expense',
    definition: { steps: [{ key: 'manager', name: 'Line manager or HR', dueHours: 48,
      approvers: [{ type: 'reporting_manager' }, { type: 'role', role: 'HR_MANAGER' }, { type: 'role', role: 'TENANT_ADMIN' }],
      escalateTo: [{ type: 'role', role: 'HR_MANAGER' }] }] },
  });
}

/** Create a claim (as a draft, or submitted for approval straight away). */
export async function createClaim(tx: Tx, ctx: Ctx, input: ClaimInput) {
  const own = await myEmployee(tx, ctx);
  const employeeId = input.employeeId ?? own;
  if (!employeeId) throw new ValidationError('your user is not linked to an employee, so it cannot claim expenses');
  const emp = await one(tx, 'SELECT * FROM org.employees WHERE id = $1', [employeeId]);
  if (!emp) throw new ValidationError('unknown employee');
  if (employeeId !== own) await authorize(tx, ctx, 'hr.expense.manage', { unitId: input.companyId });
  const c = await company(tx, input.companyId);
  if (!(await one(tx, `SELECT 1 FROM hr.contracts WHERE employee_id = $1 AND company_id = $2 AND status = 'active'`, [employeeId, input.companyId]))) {
    throw new ValidationError(`${emp.first_name} ${emp.last_name} has no active contract with ${c.legal_name}`);
  }
  if (!input.lines?.length) throw new ValidationError('a claim needs at least one expense');
  if (input.lines.length > 30) throw new ValidationError('a claim has at most 30 expenses');
  const cur = c.base_currency as string;
  const claim = await one(tx, `INSERT INTO hr.expense_claims (tenant_id, company_id, employee_id, title, currency, created_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5) RETURNING *`, [input.companyId, employeeId, input.title, cur, ctx.userId]);
  let net = 0, tax = 0, gross = 0;
  for (const [i, l] of input.lines.entries()) {
    const n = i + 1;
    const cat = CATEGORIES[l.category];
    if (!cat) throw new ValidationError(`expense ${n}: the category is one of ${Object.keys(CATEGORIES).join(', ')}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(l.date) || Number.isNaN(Date.parse(l.date))) throw new ValidationError(`expense ${n}: the date is YYYY-MM-DD`);
    if (l.date > new Date().toISOString().slice(0, 10)) throw new ValidationError(`expense ${n}: the date is in the future`);
    const amount = roundIn(cur, l.amount);
    if (!(amount > 0)) throw new ValidationError(`expense ${n}: the amount must be more than zero`);
    const tc = await one(tx, 'SELECT * FROM fin.tax_codes WHERE country_code = $1 AND code = $2 AND active', [c.country_code, l.taxCode ?? defaultTaxCode(c.country_code)]);
    if (!tc) throw new ValidationError(`expense ${n}: unknown tax code ${l.taxCode}`);
    if (tc.category === 'reverse_charge') throw new ValidationError(`expense ${n}: a reverse-charge purchase is entered as a supplier bill, not an expense claim`);
    const lineTax = roundIn(cur, amount * Number(tc.rate) / (100 + Number(tc.rate)));
    const account = await resolveAccount(tx, input.companyId, cat.account);
    let receiptId: string | null = null;
    if (l.receipt) {
      const r = l.receipt;
      if (!RECEIPT_TYPES.includes(r.contentType)) throw new ValidationError(`expense ${n}: the receipt is a JPEG, PNG or WebP photo or a PDF`);
      const bytes = Buffer.from(r.dataBase64, 'base64');
      if (!bytes.length) throw new ValidationError(`expense ${n}: the receipt is empty`);
      if (bytes.length > MAX_RECEIPT) throw new ValidationError(`expense ${n}: the receipt is larger than 750 KB; take the photo at a lower resolution`);
      receiptId = (await one(tx, `INSERT INTO hr.expense_receipts (tenant_id, claim_id, file_name, content_type, size_bytes, sha256, content)
        VALUES (app.tenant(), $1, $2, $3, $4, $5, $6) RETURNING id`,
      [claim.id, r.fileName.slice(0, 200), r.contentType, bytes.length, createHash('sha256').update(bytes).digest('hex'), bytes])).id;
    }
    await tx.query(`INSERT INTO hr.expense_lines (tenant_id, claim_id, line_no, date, category, account_id, description, gross_amount, tax_code_id, tax_amount, net_amount, receipt_id)
      VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [claim.id, n, l.date, l.category, account.id, l.description, amount, tc.id, lineTax, roundIn(cur, amount - lineTax), receiptId]);
    gross += amount; tax += lineTax; net += amount - lineTax;
  }
  await tx.query('UPDATE hr.expense_claims SET net_total = $2, tax_total = $3, gross_total = $4 WHERE id = $1',
    [claim.id, roundIn(cur, net), roundIn(cur, tax), roundIn(cur, gross)]);
  if (input.submit) return submitClaim(tx, ctx, claim.id);
  return getClaim(tx, ctx, claim.id);
}

const defaultTaxCode = (country: string) => (['QA', 'KW'].includes(country) ? 'NV' : 'SR');

export async function submitClaim(tx: Tx, ctx: Ctx, claimId: string) {
  const c = await one(tx, 'SELECT * FROM hr.expense_claims WHERE id = $1 FOR UPDATE', [claimId]);
  if (!c) throw new NotFoundError('expense claim');
  await mayManageOrOwn(tx, ctx, c);
  if (c.status !== 'draft') throw new ConflictError(`the claim is ${c.status.replace('_', ' ')}`);
  const emp = await one(tx, 'SELECT unit_id, first_name, last_name FROM org.employees WHERE id = $1', [c.employee_id]);
  await ensureWorkflow(tx);
  const no = await nextNumber(tx, c.company_id, 'expense_claim', 'EC', new Date().toISOString().slice(0, 10));
  await tx.query(`UPDATE hr.expense_claims SET status = 'pending_approval', no = $2, submitted_at = now() WHERE id = $1`, [claimId, no]);
  await submit(tx, ctx, { code: EXPENSE_WORKFLOW, entityType: 'hr.expense', entityId: claimId, subjectUnitId: emp.unit_id,
    payload: { no, employee: `${emp.first_name} ${emp.last_name}`, title: c.title, amount: Number(c.gross_total), currency: c.currency } });
  return getClaim(tx, ctx, claimId);
}

/** Approval posts the claim; rejection closes it. */
onWorkflowComplete('hr.expense', async (tx, inst) => {
  const c = await one(tx, 'SELECT * FROM hr.expense_claims WHERE id = $1 FOR UPDATE', [inst.entity_id]);
  if (!c || c.status !== 'pending_approval') return;
  if (inst.status !== 'approved') {
    await tx.query(`UPDATE hr.expense_claims SET status = 'rejected', decided_at = now() WHERE id = $1`, [c.id]);
    return;
  }
  const emp = await one(tx, 'SELECT employee_no, first_name, last_name, unit_id FROM org.employees WHERE id = $1', [c.employee_id]);
  const lines = await many(tx, 'SELECT l.*, t.category AS tax_category FROM hr.expense_lines l JOIN fin.tax_codes t ON t.id = l.tax_code_id WHERE claim_id = $1 ORDER BY line_no', [c.id]);
  const payable = await ensureRoleAccount(tx, c.company_id, 'employee_claims_payable');
  const posting: PostingLine[] = [];
  for (const l of lines) {
    posting.push({ account: l.account_id, debit: Number(l.net_amount), unitId: emp.unit_id, taxCodeId: l.tax_code_id, description: l.description });
    if (Number(l.tax_amount) > 0) {
      posting.push({ account: 'role:vat_input', debit: Number(l.tax_amount), taxCodeId: l.tax_code_id, taxBase: Number(l.net_amount), description: `Input VAT: ${l.description}` });
    }
  }
  posting.push({ account: payable, credit: Number(c.gross_total), description: `Owed to ${emp.employee_no} ${emp.first_name} ${emp.last_name}` });
  const tenantId = (await one(tx, 'SELECT app.tenant() AS t')).t;
  const date = new Date().toISOString().slice(0, 10);
  const j = await post(tx, { tenantId, userId: inst.requester_user_id }, { companyId: c.company_id, type: 'expense_claim', date,
    memo: `${c.no} ${c.title} (${emp.first_name} ${emp.last_name})`, source: { type: 'hr.expense', id: c.id }, lines: posting });
  await tx.query(`UPDATE hr.expense_claims SET status = 'approved', journal_id = $2, decided_at = now() WHERE id = $1`, [c.id, j.id]);
  await emit(tx, 'expense.approved', c.company_id, { claim_id: c.id, no: c.no, employee_no: emp.employee_no, amount: Number(c.gross_total), currency: c.currency, journal_no: j.no });
});

/** Pay an approved claim to the employee from a bank account. */
export async function payClaim(tx: Tx, ctx: Ctx, claimId: string, input: { date: string; bankAccount?: string }) {
  const c = await one(tx, 'SELECT * FROM hr.expense_claims WHERE id = $1 FOR UPDATE', [claimId]);
  if (!c) throw new NotFoundError('expense claim');
  await authorize(tx, ctx, 'hr.expense.manage', { unitId: c.company_id });
  await authorize(tx, ctx, 'fin.payment.post', { unitId: c.company_id, attrs: { amount: Number(c.gross_total), kind: 'payment' } });
  if (c.status !== 'approved') throw new ConflictError(c.status === 'paid' ? 'the claim is already paid' : `only an approved claim can be paid; it is ${c.status.replace('_', ' ')}`);
  const bank = await resolveAccount(tx, c.company_id, input.bankAccount ?? 'role:bank');
  const payable = await ensureRoleAccount(tx, c.company_id, 'employee_claims_payable');
  const j = await post(tx, ctx, { companyId: c.company_id, type: 'expense_payment', date: input.date, memo: `${c.no} paid`,
    source: { type: 'hr.expense', id: c.id },
    lines: [{ account: payable, debit: Number(c.gross_total) }, { account: bank.id, credit: Number(c.gross_total) }] });
  await tx.query(`UPDATE hr.expense_claims SET status = 'paid', payment_journal_id = $2 WHERE id = $1`, [claimId, j.id]);
  await emit(tx, 'expense.paid', c.company_id, { claim_id: c.id, no: c.no, amount: Number(c.gross_total), currency: c.currency, journal_no: j.no, date: input.date });
  return getClaim(tx, ctx, claimId);
}

/** Delete a draft that was never submitted. */
export async function deleteDraftClaim(tx: Tx, ctx: Ctx, claimId: string) {
  const c = await one(tx, 'SELECT * FROM hr.expense_claims WHERE id = $1 FOR UPDATE', [claimId]);
  if (!c) throw new NotFoundError('expense claim');
  await mayManageOrOwn(tx, ctx, c);
  if (c.status !== 'draft') throw new ConflictError('only a draft can be deleted');
  await tx.query('DELETE FROM hr.expense_claims WHERE id = $1', [claimId]);
  return { deleted: true };
}

async function mayManageOrOwn(tx: Tx, ctx: Ctx, c: { employee_id: string; company_id: string }) {
  if ((await myEmployee(tx, ctx)) === c.employee_id) return;
  await authorize(tx, ctx, 'hr.expense.manage', { unitId: c.company_id });
}

/** Who may see a claim: the employee, an approver it was sent to, or someone who manages claims. */
async function maySee(tx: Tx, ctx: Ctx, c: { id: string; employee_id: string; company_id: string }) {
  if ((await myEmployee(tx, ctx)) === c.employee_id) return;
  if (await one(tx, `SELECT 1 FROM wf.tasks t JOIN wf.instances i ON i.id = t.instance_id
                      WHERE i.entity_type = 'hr.expense' AND i.entity_id = $1 AND t.assignee_user_id = $2`, [c.id, ctx.userId])) return;
  if ((await decide(tx, ctx.userId!, 'hr.expense.manage', { unitId: c.company_id })).allowed) return;
  throw new ForbiddenError('hr.expense.manage', { unitId: c.company_id }, 'this is another employee\'s claim');
}

export async function getClaim(tx: Tx, ctx: Ctx, claimId: string) {
  const c = await one(tx, `SELECT c.*, e.employee_no, e.first_name || ' ' || e.last_name AS employee_name, j.no AS journal_no, pj.no AS payment_journal_no
      FROM hr.expense_claims c JOIN org.employees e ON e.id = c.employee_id
      LEFT JOIN fin.journals j ON j.id = c.journal_id LEFT JOIN fin.journals pj ON pj.id = c.payment_journal_id WHERE c.id = $1`, [claimId]);
  if (!c) throw new NotFoundError('expense claim');
  await maySee(tx, ctx, c);
  const lines = await many(tx, `SELECT l.line_no, l.date, l.category, a.code AS account_code, l.description, l.gross_amount, t.code AS tax_code, l.tax_amount, l.net_amount,
      l.receipt_id, r.file_name AS receipt_name, r.content_type AS receipt_type
      FROM hr.expense_lines l JOIN fin.accounts a ON a.id = l.account_id JOIN fin.tax_codes t ON t.id = l.tax_code_id
      LEFT JOIN hr.expense_receipts r ON r.id = l.receipt_id WHERE l.claim_id = $1 ORDER BY l.line_no`, [claimId]);
  return { ...c, lines };
}

export async function receipt(tx: Tx, ctx: Ctx, receiptId: string) {
  const r = await one(tx, `SELECT r.*, c.employee_id, c.company_id FROM hr.expense_receipts r JOIN hr.expense_claims c ON c.id = r.claim_id WHERE r.id = $1`, [receiptId]);
  if (!r) throw new NotFoundError('receipt');
  await maySee(tx, ctx, { id: r.claim_id, employee_id: r.employee_id, company_id: r.company_id });
  return { fileName: r.file_name as string, contentType: r.content_type as string, content: r.content as Buffer };
}

const LIST = `SELECT c.id, c.no, c.title, c.status, c.currency, c.gross_total, c.tax_total, c.created_at, c.submitted_at, c.decided_at,
    e.employee_no, e.first_name || ' ' || e.last_name AS employee_name,
    (SELECT count(*)::int FROM hr.expense_lines l WHERE l.claim_id = c.id) AS lines,
    (SELECT count(*)::int FROM hr.expense_lines l WHERE l.claim_id = c.id AND l.receipt_id IS NOT NULL) AS receipts
  FROM hr.expense_claims c JOIN org.employees e ON e.id = c.employee_id`;

/** The signed-in employee's own claims. */
export async function myClaims(tx: Tx, ctx: Ctx) {
  const own = await myEmployee(tx, ctx);
  if (!own) return [];
  return many(tx, `${LIST} WHERE c.employee_id = $1 ORDER BY c.created_at DESC LIMIT 100`, [own]);
}

/** Every claim in a company, for HR and finance. */
export async function listClaims(tx: Tx, ctx: Ctx, companyId: string, status?: string) {
  await authorize(tx, ctx, 'hr.expense.manage', { unitId: companyId });
  return many(tx, `${LIST} WHERE c.company_id = $1 AND ($2::text IS NULL OR c.status = $2) ORDER BY c.created_at DESC LIMIT 500`, [companyId, status ?? null]);
}
