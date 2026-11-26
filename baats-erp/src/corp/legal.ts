import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize, unitScope } from '../iam/authz.ts';
import { insertDefinition, onWorkflowComplete, submit } from '../workflow/engine.ts';
import { company, nextNumber } from '../fin/ledger.ts';

/**
 * Legal and contracts. Contracts with customers, suppliers, landlords and
 * employees are drafted, approved through the workflow engine (value limits on
 * lgl.contract.approve, maker-checker), then tracked for obligations, notice
 * periods and renewals. Auto-renewing contracts roll forward on their end date
 * unless notice was given; others expire.
 */

export const CONTRACT_WORKFLOW = 'lgl.contract.approval';
const d = (v: Date | string | null) => (v === null ? null : typeof v === 'string' ? v : v.toISOString().slice(0, 10));
const addMonths = (date: string, n: number) => { const x = new Date(`${date}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + n); return d(x)!; };
const addDays = (date: string, n: number) => { const x = new Date(`${date}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return d(x)!; };

async function ensureWorkflow(tx: Tx) {
  if (!(await one(tx, 'SELECT 1 FROM iam.roles WHERE code = $1', ['LEGAL_COUNSEL']))) {
    await tx.query(`INSERT INTO iam.roles (tenant_id, code, name, is_system) VALUES (app.tenant(), 'LEGAL_COUNSEL', 'Legal counsel', true)`);
  }
  if (!(await one(tx, 'SELECT 1 FROM wf.definitions WHERE code = $1', [CONTRACT_WORKFLOW]))) {
    await insertDefinition(tx, { code: CONTRACT_WORKFLOW, name: 'Contract approval', entityType: 'lgl.contract',
      definition: { approvalPermission: 'lgl.contract.approve', steps: [{ key: 'legal', name: 'Legal review',
        approvers: [{ type: 'role', role: 'LEGAL_COUNSEL' }, { type: 'role', role: 'TENANT_ADMIN' }] }] } });
  }
}

export interface ContractInput {
  companyId: string; title: string; kind: string; partyId?: string; ownerEmployeeId?: string; value?: number; currency?: string;
  startDate: string; endDate?: string; autoRenew?: boolean; renewalMonths?: number; noticeDays?: number; governingLaw?: string;
}

export async function createContract(tx: Tx, ctx: Ctx, input: ContractInput) {
  await authorize(tx, ctx, 'lgl.contract.manage', { unitId: input.companyId });
  const c = await company(tx, input.companyId);
  if (['sales', 'purchase', 'lease', 'service', 'nda'].includes(input.kind) && !input.partyId) throw new ValidationError('this kind of contract needs a counterparty');
  if (input.partyId) {
    const p = await one(tx, 'SELECT status, name FROM mdm.parties WHERE id = $1', [input.partyId]);
    if (!p) throw new ValidationError('unknown counterparty');
    if (p.status === 'blocked' || p.status === 'inactive') throw new ValidationError(`${p.name} is ${p.status}`);
  }
  return one(tx, `INSERT INTO lgl.contracts (tenant_id, company_id, title, kind, party_id, owner_employee_id, value, currency, start_date, end_date,
                    auto_renew, renewal_months, notice_days, governing_law, created_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [input.companyId, input.title, input.kind, input.partyId ?? null, input.ownerEmployeeId ?? null, input.value ?? 0, input.currency ?? c.base_currency,
      input.startDate, input.endDate ?? null, input.autoRenew ?? false, input.renewalMonths ?? null, input.noticeDays ?? 30, input.governingLaw ?? 'UAE', ctx.userId]);
}

export async function submitContract(tx: Tx, ctx: Ctx, id: string) {
  const k = await one(tx, 'SELECT * FROM lgl.contracts WHERE id = $1 FOR UPDATE', [id]);
  if (!k) throw new NotFoundError('contract');
  await authorize(tx, ctx, 'lgl.contract.manage', { unitId: k.company_id });
  if (!['draft', 'rejected'].includes(k.status)) throw new ConflictError(`the contract is ${k.status}`);
  const signed = await one(tx, `SELECT 1 FROM dms.documents WHERE entity_type = 'lgl.contract' AND entity_id = $1 AND status = 'active'`, [id]);
  if (!signed) throw new ValidationError('attach the contract document before sending it for approval');
  await ensureWorkflow(tx);
  const no = k.no ?? await nextNumber(tx, k.company_id, 'lgl.contract', 'CT', d(k.start_date)!);
  await tx.query(`UPDATE lgl.contracts SET status = 'pending_approval', no = $2 WHERE id = $1`, [id, no]);
  await submit(tx, ctx, { code: CONTRACT_WORKFLOW, entityType: 'lgl.contract', entityId: id, subjectUnitId: k.company_id,
    payload: { amount: Number(k.value), currency: k.currency, kind: k.kind, no } });
  return getContract(tx, ctx, id);
}

onWorkflowComplete('lgl.contract', async (tx, inst) => {
  await tx.query(`UPDATE lgl.contracts SET status = $2 WHERE id = $1 AND status = 'pending_approval'`,
    [inst.entity_id, inst.status === 'approved' ? 'active' : 'rejected']);
});

export async function addObligation(tx: Tx, ctx: Ctx, contractId: string, input: { description: string; dueDate: string; responsibleEmployeeId?: string }) {
  const k = await one(tx, 'SELECT company_id, status FROM lgl.contracts WHERE id = $1', [contractId]);
  if (!k) throw new NotFoundError('contract');
  await authorize(tx, ctx, 'lgl.contract.manage', { unitId: k.company_id });
  if (['expired', 'terminated'].includes(k.status)) throw new ConflictError(`the contract is ${k.status}`);
  return one(tx, `INSERT INTO lgl.obligations (tenant_id, contract_id, description, due_date, responsible_employee_id) VALUES (app.tenant(), $1, $2, $3, $4) RETURNING *`,
    [contractId, input.description, input.dueDate, input.responsibleEmployeeId ?? null]);
}

export async function completeObligation(tx: Tx, ctx: Ctx, id: string, input: { date: string; waived?: boolean }) {
  const o = await one(tx, 'SELECT o.*, k.company_id FROM lgl.obligations o JOIN lgl.contracts k ON k.id = o.contract_id WHERE o.id = $1 FOR UPDATE OF o', [id]);
  if (!o) throw new NotFoundError('obligation');
  await authorize(tx, ctx, 'lgl.contract.manage', { unitId: o.company_id });
  if (o.status !== 'open') throw new ConflictError(`the obligation is already ${o.status}`);
  return one(tx, `UPDATE lgl.obligations SET status = $2, done_on = $3 WHERE id = $1 RETURNING *`, [id, input.waived ? 'waived' : 'done', input.date]);
}

export async function terminateContract(tx: Tx, ctx: Ctx, id: string, input: { date: string; reason: string }) {
  const k = await one(tx, 'SELECT * FROM lgl.contracts WHERE id = $1 FOR UPDATE', [id]);
  if (!k) throw new NotFoundError('contract');
  await authorize(tx, ctx, 'lgl.contract.manage', { unitId: k.company_id });
  if (k.status !== 'active') throw new ConflictError(`only an active contract can be terminated; this one is ${k.status}`);
  return one(tx, `UPDATE lgl.contracts SET status = 'terminated', terminated_on = $2, termination_reason = $3 WHERE id = $1 RETURNING *`, [id, input.date, input.reason]);
}

/**
 * The daily contract run: active contracts past their end date renew (auto-renew)
 * or expire. Returns what changed.
 */
export async function runRenewals(tx: Tx, ctx: Ctx, companyId: string, asOf: string) {
  await authorize(tx, ctx, 'lgl.contract.manage', { unitId: companyId });
  const due = await many(tx, `SELECT * FROM lgl.contracts WHERE company_id = $1 AND status = 'active' AND end_date < $2 FOR UPDATE`, [companyId, asOf]);
  const out = { renewed: [] as string[], expired: [] as string[] };
  for (const k of due) {
    if (k.auto_renew) {
      let end = d(k.end_date)!;
      while (end < asOf) end = addMonths(end, k.renewal_months);
      await tx.query('UPDATE lgl.contracts SET end_date = $2 WHERE id = $1', [k.id, end]);
      out.renewed.push(k.no);
    } else {
      await tx.query(`UPDATE lgl.contracts SET status = 'expired' WHERE id = $1`, [k.id]);
      out.expired.push(k.no);
    }
  }
  return out;
}

/** What needs attention: notice deadlines coming up and obligations due within the window. */
export async function contractAlerts(tx: Tx, ctx: Ctx, companyId: string, asOf: string, withinDays = 30) {
  await authorize(tx, ctx, 'lgl.contract.manage', { unitId: companyId });
  const horizon = addDays(asOf, withinDays);
  const contracts = (await many(tx, `SELECT k.*, p.name AS party_name FROM lgl.contracts k LEFT JOIN mdm.parties p ON p.id = k.party_id
                                       WHERE k.company_id = $1 AND k.status = 'active' AND k.end_date IS NOT NULL`, [companyId]))
    .map((k) => ({ id: k.id, no: k.no, title: k.title, party: k.party_name, endDate: d(k.end_date), autoRenew: k.auto_renew,
      noticeBy: addDays(d(k.end_date)!, -k.notice_days) }))
    .filter((k) => k.noticeBy <= horizon)
    .sort((a, b) => a.noticeBy.localeCompare(b.noticeBy));
  const obligations = await many(tx, `SELECT o.*, k.no AS contract_no, k.title AS contract_title FROM lgl.obligations o JOIN lgl.contracts k ON k.id = o.contract_id
                                       WHERE k.company_id = $1 AND o.status = 'open' AND o.due_date <= $2 ORDER BY o.due_date`, [companyId, horizon]);
  return { notice: contracts.map((k) => ({ ...k, overdue: k.noticeBy < asOf })), obligations: obligations.map((o) => ({ ...o, overdue: d(o.due_date)! < asOf })) };
}

export async function getContract(tx: Tx, ctx: Ctx, id: string) {
  const k = await one(tx, `SELECT k.*, p.name AS party_name FROM lgl.contracts k LEFT JOIN mdm.parties p ON p.id = k.party_id WHERE k.id = $1`, [id]);
  if (!k) throw new NotFoundError('contract');
  await authorize(tx, ctx, 'lgl.contract.manage', { unitId: k.company_id });
  k.obligations = await many(tx, 'SELECT * FROM lgl.obligations WHERE contract_id = $1 ORDER BY due_date', [id]);
  k.documents = await many(tx, `SELECT id, title, current_version, status FROM dms.documents WHERE entity_type = 'lgl.contract' AND entity_id = $1`, [id]);
  return k;
}

export async function listContracts(tx: Tx, ctx: Ctx, companyId: string) {
  const s = await unitScope(tx, ctx.userId!, 'lgl.contract.manage', 'k.company_id', 2);
  return many(tx, `SELECT k.*, p.name AS party_name,
                          (SELECT count(*)::int FROM lgl.obligations o WHERE o.contract_id = k.id AND o.status = 'open') AS open_obligations
                     FROM lgl.contracts k LEFT JOIN mdm.parties p ON p.id = k.party_id
                    WHERE k.company_id = $1 AND ${s.sql} ORDER BY k.status, k.end_date NULLS LAST`, [companyId, s.param]);
}
