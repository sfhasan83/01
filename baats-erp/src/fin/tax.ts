import { ConflictError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';
import { company, post, round2, type PostingLine } from './ledger.ts';
import { fiscalYear } from './reports.ts';

/**
 * UAE VAT return (FTA form VAT 201) and corporate tax provision, following the
 * BAATS Accounting rules: VAT is computed from the ledger's tax-coded lines, a
 * filed return clears 2100 / 1200 into 2110 (settlement with the FTA), and
 * corporate tax is 9% of accounting profit above AED 375,000 (both configurable).
 */

const SALES_TYPES = ['sales_invoice', 'sales_credit'];
// Fuel receipts logged in fleet carry input VAT like a purchase invoice.
const PURCHASE_TYPES = ['purchase_invoice', 'purchase_credit', 'fuel'];

export interface VatBox { amount: number; vat: number }
export interface VatReturn {
  from: string; to: string;
  boxes: Record<string, VatBox>;
  outputTax: number; inputTax: number; netPayable: number;
}

export async function computeVatReturn(tx: Tx, ctx: Ctx, companyId: string, from: string, to: string): Promise<VatReturn> {
  await authorize(tx, ctx, 'fin.report.read', { unitId: companyId });
  const rows = await many(tx, `
    SELECT j.type, t.category, coalesce(a.system_role, '') AS role,
           sum(l.debit - l.credit)::float AS amount, sum(coalesce(l.tax_base, 0))::float AS tax_base
      FROM fin.journal_lines l
      JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted'
      JOIN fin.accounts a ON a.id = l.account_id
      JOIN fin.tax_codes t ON t.id = l.tax_code_id
     WHERE j.company_id = $1 AND j.date BETWEEN $2 AND $3 AND j.type = ANY($4)
     GROUP BY 1, 2, 3`, [companyId, from, to, [...SALES_TYPES, ...PURCHASE_TYPES]]);
  const box = (): VatBox => ({ amount: 0, vat: 0 });
  const b: Record<string, VatBox> = { '1': box(), '3': box(), '4': box(), '5': box(), '8': box(), '9': box(), '10': box(), '11': box() };
  for (const r of rows) {
    const sales = SALES_TYPES.includes(r.type);
    const isVat = r.role === 'vat_output' || r.role === 'vat_input';
    if (sales) {
      // Supplies are credits (negative debit-minus-credit).
      if (!isVat) {
        const net = -r.amount;
        if (r.category === 'standard') b['1'].amount += net;
        else if (r.category === 'zero') b['4'].amount += net;
        else if (r.category === 'exempt') b['5'].amount += net;
      } else if (r.role === 'vat_output') b['1'].vat += -r.amount;
    } else {
      if (!isVat) {
        if (r.category === 'standard') b['9'].amount += r.amount;
        else if (r.category === 'reverse_charge') { b['10'].amount += r.amount; b['3'].amount += r.amount; }
      } else if (r.role === 'vat_input') {
        if (r.category === 'reverse_charge') b['10'].vat += r.amount; else b['9'].vat += r.amount;
      } else if (r.role === 'vat_output') b['3'].vat += -r.amount;
    }
  }
  for (const k of ['1', '3', '4', '5']) { b['8'].amount += b[k].amount; b['8'].vat += b[k].vat; }
  for (const k of ['9', '10']) { b['11'].amount += b[k].amount; b['11'].vat += b[k].vat; }
  for (const v of Object.values(b)) { v.amount = round2(v.amount); v.vat = round2(v.vat); }
  const outputTax = b['8'].vat, inputTax = b['11'].vat;
  return { from, to, boxes: b, outputTax, inputTax, netPayable: round2(outputTax - inputTax) };
}

/** File a VAT return: clear the period's output and input VAT into the FTA settlement account. */
export async function fileVatReturn(tx: Tx, ctx: Ctx, companyId: string, from: string, to: string, filedRef?: string) {
  await authorize(tx, ctx, 'fin.tax.manage', { unitId: companyId });
  if (to < from) throw new ValidationError('period end is before its start');
  const overlap = await one(tx, `SELECT period_from, period_to FROM fin.vat_returns
                                  WHERE company_id = $1 AND period_from <= $3 AND period_to >= $2`, [companyId, from, to]);
  if (overlap) throw new ConflictError('a VAT return already covers part of this period');
  const r = await computeVatReturn(tx, ctx, companyId, from, to);
  const lines: PostingLine[] = [];
  if (r.outputTax) lines.push({ account: 'role:vat_output', ...(r.outputTax > 0 ? { debit: r.outputTax } : { credit: -r.outputTax }), description: 'Output VAT for the period' });
  if (r.inputTax) lines.push({ account: 'role:vat_input', ...(r.inputTax > 0 ? { credit: r.inputTax } : { debit: -r.inputTax }), description: 'Input VAT for the period' });
  if (r.netPayable) lines.push({ account: 'role:vat_settlement', ...(r.netPayable > 0 ? { credit: r.netPayable } : { debit: -r.netPayable }),
    description: r.netPayable > 0 ? 'VAT payable to the FTA' : 'VAT refundable by the FTA' });
  if (lines.length < 2) throw new ValidationError('there is no VAT to declare in this period');
  const j = await post(tx, ctx, { companyId, type: 'vat_return', date: to, memo: `VAT return ${from} to ${to}${filedRef ? ' · ' + filedRef : ''}`, lines });
  const row = await one(tx, `INSERT INTO fin.vat_returns (tenant_id, company_id, period_from, period_to, output_tax, input_tax, net_payable, boxes, journal_id, filed_ref)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [companyId, from, to, r.outputTax, r.inputTax, r.netPayable, JSON.stringify(r.boxes), j.id, filedRef ?? null]);
  return { ...row, journal_no: j.no };
}

/**
 * Corporate tax provision for a financial year: rate × (accounting profit − threshold),
 * never negative. Posts only the change since the last provision, dated the last
 * day of the year (or `postingDate`). Exempt income, non-deductible items and loss
 * carry-forward are not modelled yet, as in BAATS Accounting.
 */
export async function provideCorporateTax(tx: Tx, ctx: Ctx, companyId: string, fyStartYear: number, postingDate?: string) {
  await authorize(tx, ctx, 'fin.tax.manage', { unitId: companyId });
  const c = await company(tx, companyId);
  const fy = fiscalYear(c.fiscal_year_start_month, fyStartYear);
  const r = await one(tx, `
    SELECT coalesce(sum(CASE WHEN a.type = 'revenue' THEN l.credit - l.debit ELSE 0 END), 0)::float AS revenue,
           coalesce(sum(CASE WHEN a.type = 'expense' AND coalesce(a.system_role,'') <> 'corporate_tax_expense' THEN l.debit - l.credit ELSE 0 END), 0)::float AS expenses,
           coalesce(sum(CASE WHEN a.system_role = 'corporate_tax_expense' THEN l.debit - l.credit ELSE 0 END), 0)::float AS provided
      FROM fin.journal_lines l
      JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' AND j.type <> 'closing'
      JOIN fin.accounts a ON a.id = l.account_id
     WHERE j.company_id = $1 AND j.date BETWEEN $2 AND $3`, [companyId, fy.from, fy.to]);
  const profit = round2(r.revenue - r.expenses);
  const taxable = Math.max(0, round2(profit - Number(c.corporate_tax_threshold)));
  const tax = round2(taxable * Number(c.corporate_tax_rate) / 100);
  const change = round2(tax - r.provided);
  let journal = null;
  if (change !== 0) {
    journal = await post(tx, ctx, {
      companyId, type: 'tax_provision', date: postingDate ?? fy.to, memo: `Corporate tax provision FY ${fy.from} to ${fy.to}`,
      lines: [
        { account: 'role:corporate_tax_expense', ...(change > 0 ? { debit: change } : { credit: -change }) },
        { account: 'role:corporate_tax_payable', ...(change > 0 ? { credit: change } : { debit: -change }) },
      ],
    });
  }
  return { fiscalYear: fy, accountingProfit: profit, threshold: Number(c.corporate_tax_threshold), rate: Number(c.corporate_tax_rate),
    taxableAmount: taxable, tax, previouslyProvided: round2(r.provided), posted: change, journalNo: journal?.no ?? null };
}
