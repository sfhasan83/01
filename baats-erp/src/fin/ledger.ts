import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';
import { onWorkflowComplete, submit } from '../workflow/engine.ts';

/**
 * Accounting engine: the single posting API every module uses. The database
 * enforces balance, open periods, postable accounts, parties on control accounts
 * and immutability; this module adds currency conversion, numbering, approvals
 * for manual journals, and reversal.
 */

export const JOURNAL_WORKFLOW = 'fin.journal.approval';

export { roundMoney } from '../core/money.ts';
import { roundMoney, roundIn, useBaseCurrency, moneyDp } from '../core/money.ts';

export interface PostingLine {
  account: string;          // account id, or a code, or "role:<system role>"
  debit?: number;           // journal currency
  credit?: number;
  partyId?: string | null;
  unitId?: string | null;
  projectId?: string | null;
  taxCodeId?: string | null;
  taxBase?: number | null;  // base currency
  description?: string;
  /** Use this base-currency amount instead of converting (realised FX, allocations at the invoice rate). */
  baseAmount?: number;
}

export interface PostingInput {
  companyId: string;
  type: string;
  date: string;
  memo: string;
  currency?: string;
  fxRate?: number;
  source?: { type: string; id: string };
  reversalOf?: string;
  lines: PostingLine[];
}

export async function company(tx: Tx, companyId: string) {
  const c = await one(tx, 'SELECT * FROM fin.companies WHERE unit_id = $1', [companyId]);
  if (!c) throw new NotFoundError('company books');
  // Ledger amounts from here on round to this company's base currency (fils for BHD, KWD, OMR).
  useBaseCurrency(c.base_currency);
  return c;
}

export async function resolveAccount(tx: Tx, companyId: string, ref: string): Promise<{ id: string; code: string; type: string }> {
  let a;
  if (ref.startsWith('role:')) a = await one(tx, 'SELECT id, code, type FROM fin.accounts WHERE company_id = $1 AND system_role = $2', [companyId, ref.slice(5)]);
  else if (/^[0-9a-f-]{36}$/.test(ref)) a = await one(tx, 'SELECT id, code, type FROM fin.accounts WHERE company_id = $1 AND id = $2', [companyId, ref]);
  else a = await one(tx, 'SELECT id, code, type FROM fin.accounts WHERE company_id = $1 AND code = $2', [companyId, ref]);
  if (!a) throw new ValidationError(`unknown account ${ref}`);
  return a;
}

/** Next number in a gap-free series, for example SI-2026-00001. */
export async function nextNumber(tx: Tx, companyId: string, docType: string, prefix: string, date: string): Promise<string> {
  const year = Number(date.slice(0, 4));
  const r = await one(tx, `INSERT INTO fin.sequences (tenant_id, company_id, doc_type, year, next_no)
      VALUES (app.tenant(), $1, $2, $3, 2)
    ON CONFLICT (tenant_id, company_id, doc_type, year) DO UPDATE SET next_no = fin.sequences.next_no + 1
    RETURNING next_no - 1 AS n`, [companyId, docType, year]);
  return `${prefix}-${year}-${String(r.n).padStart(5, '0')}`;
}

const PREFIX: Record<string, string> = {
  manual: 'JV', opening: 'OB', sales_invoice: 'SJ', sales_credit: 'SCJ', purchase_invoice: 'PJ', purchase_credit: 'PCJ',
  receipt: 'RJ', payment: 'PYJ', write_off: 'WO', vat_return: 'VAT', tax_provision: 'CT', closing: 'CL', reversal: 'REV',
  inventory: 'IJ', goods_receipt: 'GRJ', delivery: 'DJ', payroll: 'PRJ', payroll_payment: 'PRP', gratuity: 'EOS',
  bank: 'BK', depreciation: 'DEP', asset_disposal: 'AD', timesheet: 'TS', production: 'MFJ', maintenance: 'MNJ', fuel: 'FJ',
  expense_claim: 'ECJ', expense_payment: 'ECP',
};

/** Write a draft journal with its lines, converted to base currency and balanced to the cent. */
async function writeDraft(tx: Tx, ctx: Ctx, input: PostingInput, status: 'draft' | 'pending_approval' = 'draft') {
  const c = await company(tx, input.companyId);
  const currency = input.currency ?? c.base_currency;
  const fx = currency === c.base_currency ? 1 : input.fxRate;
  if (!fx || fx <= 0) throw new ValidationError(`an exchange rate to ${c.base_currency} is needed for ${currency}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new ValidationError('date must be YYYY-MM-DD');
  if (input.lines.length < 2) throw new ValidationError('a journal needs at least two lines');

  const lines = [];
  for (const [i, l] of input.lines.entries()) {
    const dr = roundIn(currency, l.debit ?? 0), cr = roundIn(currency, l.credit ?? 0);
    // A line with an explicit base amount (realised FX) may have no journal-currency amount.
    const baseOnly = l.baseAmount !== undefined && dr === 0 && cr === 0;
    if (dr < 0 || cr < 0 || (!baseOnly && (dr > 0) === (cr > 0))) throw new ValidationError(`line ${i + 1}: enter either a debit or a credit`);
    const acc = await resolveAccount(tx, input.companyId, l.account);
    if (l.projectId) {
      const p = await one(tx, 'SELECT company_id FROM prj.projects WHERE id = $1', [l.projectId]);
      if (!p || p.company_id !== input.companyId) throw new ValidationError(`line ${i + 1}: the project does not belong to this company`);
    }
    const txn = dr - cr;
    const base = l.baseAmount !== undefined ? roundMoney(l.baseAmount) : roundMoney(txn * fx);
    lines.push({ ...l, accountId: acc.id, txn, base });
  }
  // Conversion rounding: put any difference of a cent (or fils) a line on the largest line.
  const diff = roundMoney(lines.reduce((s, l) => s + l.base, 0));
  const unit = 10 ** -moneyDp();
  if (diff !== 0) {
    if (Math.abs(diff) > unit * lines.length && input.lines.every((l) => l.baseAmount === undefined)) {
      throw new ValidationError('journal is not balanced');
    }
    if (Math.abs(diff) <= unit * lines.length) {
      const big = lines.reduce((a, b) => (Math.abs(b.base) > Math.abs(a.base) ? b : a));
      big.base = roundMoney(big.base - diff);
    }
  }
  const j = await one(tx, `INSERT INTO fin.journals (tenant_id, company_id, type, date, memo, currency, fx_rate, source_type, source_id, status, created_by, reversal_of)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [input.companyId, input.type, input.date, input.memo, currency, fx, input.source?.type ?? null, input.source?.id ?? null, status, ctx.userId,
      input.reversalOf ?? null]);
  for (const [i, l] of lines.entries()) {
    if (l.base === 0) continue;
    await tx.query(`INSERT INTO fin.journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit, txn_amount,
                      party_id, unit_id, tax_code_id, tax_base, description, project_id)
      VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [j.id, i + 1, l.accountId, l.base > 0 ? l.base : 0, l.base < 0 ? -l.base : 0, roundIn(currency, l.txn),
        l.partyId ?? null, l.unitId ?? null, l.taxCodeId ?? null, l.taxBase ?? null, l.description ?? null, l.projectId ?? null]);
  }
  return j;
}

async function markPosted(tx: Tx, journalId: string, companyId: string, type: string, date: string) {
  const no = await nextNumber(tx, companyId, `journal:${type}`, PREFIX[type] ?? 'J', date);
  return one(tx, `UPDATE fin.journals SET status = 'posted', no = $2 WHERE id = $1 RETURNING *`, [journalId, no]);
}

/**
 * System posting, used by documents (invoices, payments, VAT returns...). The
 * calling module has already authorized the business action.
 */
export async function post(tx: Tx, ctx: Ctx, input: PostingInput) {
  const draft = await writeDraft(tx, ctx, input);
  return markPosted(tx, draft.id, input.companyId, input.type, input.date);
}

// --- Manual journals: maker-checker through the workflow engine ------------------------

export async function createManualJournal(tx: Tx, ctx: Ctx, input: Omit<PostingInput, 'type'> & { type?: 'manual' | 'opening' }) {
  await authorize(tx, ctx, 'fin.journal.create', { unitId: input.companyId });
  const type = input.type ?? 'manual';
  const draft = await writeDraft(tx, ctx, { ...input, type }, 'pending_approval');
  const totals = await one(tx, 'SELECT sum(debit)::float AS amount FROM fin.journal_lines WHERE journal_id = $1', [draft.id]);
  // Validate now, so the approver never sees a journal that cannot post.
  await tx.query('SELECT fin.validate_posting(j) FROM fin.journals j WHERE id = $1', [draft.id]);
  const instance = await submit(tx, ctx, {
    code: JOURNAL_WORKFLOW, entityType: 'fin.journal', entityId: draft.id, subjectUnitId: input.companyId,
    payload: { amount: totals.amount, type, date: input.date, memo: input.memo },
  });
  return { journal: (await one(tx, 'SELECT * FROM fin.journals WHERE id = $1', [draft.id]))!, approval: instance };
}

onWorkflowComplete('fin.journal', async (tx, inst) => {
  const j = await one(tx, 'SELECT * FROM fin.journals WHERE id = $1', [inst.entity_id]);
  if (!j || j.status !== 'pending_approval') return;
  if (inst.status === 'approved') await markPosted(tx, j.id, j.company_id, j.type, j.date.toISOString().slice(0, 10));
  else await tx.query(`UPDATE fin.journals SET status = 'rejected' WHERE id = $1`, [j.id]);
});

/** Reverse a posted journal with an equal and opposite one; the original stays as it was. */
export async function reverseJournal(tx: Tx, ctx: Ctx, journalId: string, date: string, reason: string) {
  const j = await one(tx, 'SELECT * FROM fin.journals WHERE id = $1 FOR UPDATE', [journalId]);
  if (!j) throw new NotFoundError('journal');
  await authorize(tx, ctx, 'fin.journal.reverse', { unitId: j.company_id });
  if (j.status !== 'posted') throw new ConflictError('only posted journals can be reversed');
  if (j.reversed_by) throw new ConflictError('journal is already reversed');
  if (j.type === 'reversal') throw new ConflictError('a reversal cannot itself be reversed; post a new journal');
  if (j.source_type && j.source_type !== 'journal') throw new ConflictError(`this journal belongs to a ${j.source_type}; correct the document instead (for example with a credit note)`);
  const lines = await many(tx, 'SELECT * FROM fin.journal_lines WHERE journal_id = $1 ORDER BY line_no', [journalId]);
  const rev = await post(tx, ctx, {
    companyId: j.company_id, type: 'reversal', date, memo: `Reversal of ${j.no}: ${reason}`,
    currency: j.currency, fxRate: Number(j.fx_rate), source: { type: 'journal', id: j.id }, reversalOf: j.id,
    lines: lines.map((l) => ({
      account: l.account_id, debit: Number(l.credit) > 0 ? Math.abs(Number(l.txn_amount)) : 0,
      credit: Number(l.debit) > 0 ? Math.abs(Number(l.txn_amount)) : 0, baseAmount: Number(l.credit) - Number(l.debit),
      partyId: l.party_id, unitId: l.unit_id, taxCodeId: l.tax_code_id, taxBase: l.tax_base === null ? null : -Number(l.tax_base),
      description: l.description,
    })),
  });
  await tx.query('UPDATE fin.journals SET reversed_by = $2 WHERE id = $1', [journalId, rev.id]);
  return rev;
}

export async function getJournal(tx: Tx, ctx: Ctx, id: string) {
  const j = await one(tx, 'SELECT * FROM fin.journals WHERE id = $1', [id]);
  if (!j) throw new NotFoundError('journal');
  await authorize(tx, ctx, 'fin.report.read', { unitId: j.company_id });
  const lines = await many(tx, `SELECT l.*, a.code AS account_code, a.name AS account_name FROM fin.journal_lines l
                                  JOIN fin.accounts a ON a.id = l.account_id WHERE journal_id = $1 ORDER BY line_no`, [id]);
  return { ...j, lines };
}

// --- Periods -------------------------------------------------------------------

export async function setPeriodStatus(tx: Tx, ctx: Ctx, companyId: string, period: string, status: 'open' | 'closed') {
  await authorize(tx, ctx, 'fin.period.manage', { unitId: companyId });
  const p = await one(tx, `INSERT INTO fin.periods (tenant_id, company_id, period, status, closed_at, closed_by)
      VALUES (app.tenant(), $1, date_trunc('month', $2::date)::date, $3, CASE WHEN $3 = 'closed' THEN now() END, CASE WHEN $3 = 'closed' THEN $4::uuid END)
    ON CONFLICT (tenant_id, company_id, period) DO UPDATE SET status = EXCLUDED.status,
      closed_at = EXCLUDED.closed_at, closed_by = EXCLUDED.closed_by
    RETURNING *`, [companyId, period, status, ctx.userId]);
  return p;
}

export async function openPeriods(tx: Tx, companyId: string, from: string, months: number) {
  for (let i = 0; i < months; i++) {
    await tx.query(`INSERT INTO fin.periods (tenant_id, company_id, period)
      VALUES (app.tenant(), $1, (date_trunc('month', $2::date) + make_interval(months => $3::int))::date)
      ON CONFLICT DO NOTHING`, [companyId, from, i]);
  }
}
