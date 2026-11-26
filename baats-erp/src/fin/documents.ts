import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';
import { company, nextNumber, post, resolveAccount, round2, type PostingLine } from './ledger.ts';

/**
 * Receivables and payables. Posting rules follow BAATS Accounting:
 *   sales invoice      Dr 1100 AR (party) gross | Cr revenue net | Cr 2100 output VAT
 *   purchase invoice   Dr expense net | Dr 1200 input VAT | Cr 2000 AP (party) gross
 *   reverse charge     Dr expense net | Dr 1200 input VAT | Cr 2100 output VAT | Cr 2000 AP net
 *   credit notes       the mirror image of the above
 *   receipt / payment  bank against AR / AP, with realised exchange differences to 4450
 * Customers and suppliers stay in subledgers under the 1100 / 2000 control accounts.
 */

export type InvoiceKind = 'sales_invoice' | 'sales_credit' | 'purchase_invoice' | 'purchase_credit';
const SALES = new Set(['sales_invoice', 'sales_credit']);
const CREDIT = new Set(['sales_credit', 'purchase_credit']);
const DOC_PREFIX: Record<InvoiceKind, string> = { sales_invoice: 'SI', sales_credit: 'SCN', purchase_invoice: 'PI', purchase_credit: 'PCN' };

export interface InvoiceLineInput {
  itemId?: string; description: string; quantity: number; unitPrice: number; discount?: number;
  account?: string; taxCode: string; unitId?: string;
  /** Project the line is revenue or cost of. */
  projectId?: string;
  /** The order line this document line bills (procurement and sales). */
  sourceLineId?: string;
}

export interface InvoiceInput {
  companyId: string; kind: InvoiceKind; partyId: string; date: string; dueDate?: string; taxDate?: string;
  currency?: string; fxRate?: number; supplierRef?: string; creditOf?: string; notes?: string;
  lines: InvoiceLineInput[];
  source?: { type: string; id: string };
}

async function activeParty(tx: Tx, partyId: string, kind: string) {
  const p = await one(tx, 'SELECT * FROM mdm.parties WHERE id = $1', [partyId]);
  if (!p) throw new ValidationError('unknown customer or supplier');
  if (p.status !== 'active') throw new ValidationError(`${p.name} is ${p.status}; only approved, active partners can be invoiced`);
  if (SALES.has(kind) && !p.is_customer) throw new ValidationError(`${p.name} is not a customer`);
  if (!SALES.has(kind) && !p.is_supplier) throw new ValidationError(`${p.name} is not a supplier`);
  return p;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Create a draft document. Totals are computed here, line by line, to the cent. */
export async function createInvoice(tx: Tx, ctx: Ctx, input: InvoiceInput) {
  await authorize(tx, ctx, 'fin.invoice.manage', { unitId: input.companyId });
  const c = await company(tx, input.companyId);
  const party = await activeParty(tx, input.partyId, input.kind);
  if (!input.lines?.length) throw new ValidationError('a document needs at least one line');
  const currency = input.currency ?? party.currency_code;
  const fx = currency === c.base_currency ? 1 : input.fxRate;
  if (!fx) throw new ValidationError(`an exchange rate to ${c.base_currency} is needed for ${currency}`);

  if (CREDIT.has(input.kind)) {
    if (!input.creditOf) throw new ValidationError('a credit note must refer to the original invoice');
    const orig = await one(tx, 'SELECT * FROM fin.invoices WHERE id = $1', [input.creditOf]);
    const origKind = input.kind === 'sales_credit' ? 'sales_invoice' : 'purchase_invoice';
    if (!orig || orig.kind !== origKind || orig.status !== 'posted' || orig.party_id !== input.partyId) {
      throw new ValidationError('the original must be a posted invoice of the same partner');
    }
    if (orig.currency !== currency) throw new ValidationError('a credit note must be in the original invoice currency');
  } else if (input.creditOf) {
    throw new ValidationError('only credit notes refer to an original invoice');
  }

  const terms = Number(party.attributes?.payment_terms_days ?? 30);
  const inv = await one(tx, `INSERT INTO fin.invoices (tenant_id, company_id, kind, supplier_ref, party_id, date, due_date, tax_date,
      currency, fx_rate, credit_of, notes, created_by, source_type, source_id)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [input.companyId, input.kind, input.supplierRef ?? null, input.partyId, input.date, input.dueDate ?? addDays(input.date, terms),
      input.taxDate ?? input.date, currency, fx, input.creditOf ?? null, input.notes ?? null, ctx.userId,
      input.source?.type ?? null, input.source?.id ?? null]);

  let net = 0, tax = 0;
  for (const [i, l] of input.lines.entries()) {
    if (!(l.quantity > 0) || !(l.unitPrice >= 0)) throw new ValidationError(`line ${i + 1}: quantity must be positive and price not negative`);
    const tc = await one(tx, 'SELECT * FROM fin.tax_codes WHERE country_code = $1 AND code = $2 AND active', [c.country_code, l.taxCode]);
    if (!tc) throw new ValidationError(`line ${i + 1}: unknown tax code ${l.taxCode}`);
    if (tc.category === 'reverse_charge' && SALES.has(input.kind)) throw new ValidationError('reverse charge applies to purchases only');
    let accountRef = l.account;
    if (!accountRef && l.itemId) {
      const item = await one(tx, 'SELECT attributes FROM mdm.items WHERE id = $1', [l.itemId]);
      accountRef = SALES.has(input.kind) ? item?.attributes?.revenue_account : item?.attributes?.expense_account;
    }
    const acc = await resolveAccount(tx, input.companyId, accountRef ?? (SALES.has(input.kind) ? 'role:default_revenue' : 'role:default_expense'));
    if (l.projectId) {
      const p = await one(tx, 'SELECT company_id, code, status FROM prj.projects WHERE id = $1', [l.projectId]);
      if (!p || p.company_id !== input.companyId) throw new ValidationError(`line ${i + 1}: the project does not belong to this company`);
      if (p.status === 'closed') throw new ValidationError(`line ${i + 1}: project ${p.code} is closed`);
    }
    const lineNet = round2(l.quantity * l.unitPrice - (l.discount ?? 0));
    if (lineNet < 0) throw new ValidationError(`line ${i + 1}: discount is larger than the line amount`);
    const lineTax = round2(lineNet * Number(tc.rate) / 100);
    await tx.query(`INSERT INTO fin.invoice_lines (tenant_id, invoice_id, line_no, item_id, description, quantity, unit_price, discount,
                      account_id, tax_code_id, unit_id, net_amount, tax_amount, source_line_id, project_id)
      VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [inv.id, i + 1, l.itemId ?? null, l.description, l.quantity, l.unitPrice, l.discount ?? 0, acc.id, tc.id, l.unitId ?? null, lineNet, lineTax,
        l.sourceLineId ?? null, l.projectId ?? null]);
    net += lineNet; tax += lineTax;
  }
  // Reverse-charge VAT is self-assessed: it is not part of what the supplier is owed.
  const rcTax = (await one(tx, `SELECT coalesce(sum(l.tax_amount), 0)::float AS t FROM fin.invoice_lines l
                                   JOIN fin.tax_codes t ON t.id = l.tax_code_id WHERE l.invoice_id = $1 AND t.category = 'reverse_charge'`, [inv.id])).t;
  return one(tx, `UPDATE fin.invoices SET net_total = $2, tax_total = $3, gross_total = $4 WHERE id = $1 RETURNING *`,
    [inv.id, round2(net), round2(tax), round2(net + tax - rcTax)]);
}

/** Amount still open on a posted document, in its own currency. */
export async function outstanding(tx: Tx, invoiceId: string): Promise<number> {
  const r = await one(tx, `SELECT i.gross_total
      - coalesce((SELECT sum(amount) FROM fin.allocations WHERE invoice_id = i.id), 0)
      - coalesce((SELECT sum(amount) FROM fin.allocations WHERE credit_id = i.id), 0) AS open
    FROM fin.invoices i WHERE i.id = $1`, [invoiceId]);
  return round2(Number(r.open));
}

export async function postInvoice(tx: Tx, ctx: Ctx, invoiceId: string) {
  const inv = await one(tx, 'SELECT * FROM fin.invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
  if (!inv) throw new NotFoundError('document');
  if (inv.status !== 'draft') throw new ConflictError(`document is already ${inv.status}`);
  const fx = Number(inv.fx_rate);
  await authorize(tx, ctx, 'fin.invoice.post', { unitId: inv.company_id, attrs: { amount: round2(Number(inv.gross_total) * fx), kind: inv.kind } });
  await activeParty(tx, inv.party_id, inv.kind);
  const lines = await many(tx, `SELECT l.*, t.category, t.code AS tax_code FROM fin.invoice_lines l
                                  JOIN fin.tax_codes t ON t.id = l.tax_code_id WHERE invoice_id = $1 ORDER BY line_no`, [invoiceId]);
  const sales = SALES.has(inv.kind);
  const credit = CREDIT.has(inv.kind);
  // Sign convention: +1 = debit. A sales invoice credits revenue; credit notes flip everything.
  const flip = credit ? -1 : 1;
  const sideOf = (amount: number, sign: number): Pick<PostingLine, 'debit' | 'credit'> =>
    (amount * sign * flip >= 0 ? { debit: Math.abs(amount) } : { credit: Math.abs(amount) });

  if (credit) {
    const open = await outstanding(tx, inv.credit_of);
    if (Number(inv.gross_total) > open + 0.001) throw new ValidationError(`credit note exceeds what is still open on the original (${open})`);
  }

  const postLines: PostingLine[] = [];
  const taxByCode = new Map<string, { codeId: string; category: string; tax: number; base: number }>();
  for (const l of lines) {
    const net = Number(l.net_amount);
    if (net > 0) {
      postLines.push({ account: l.account_id, ...sideOf(net, sales ? -1 : 1), unitId: l.unit_id, projectId: l.project_id, taxCodeId: l.tax_code_id, description: l.description });
    }
    const t = taxByCode.get(l.tax_code_id) ?? { codeId: l.tax_code_id, category: l.category, tax: 0, base: 0 };
    t.tax += Number(l.tax_amount); t.base += net;
    taxByCode.set(l.tax_code_id, t);
  }
  for (const t of taxByCode.values()) {
    const tax = round2(t.tax);
    const base = round2(t.base * fx) * (credit ? -1 : 1);
    if (tax === 0) continue;
    if (sales) {
      postLines.push({ account: 'role:vat_output', ...sideOf(tax, -1), taxCodeId: t.codeId, taxBase: base, description: 'Output VAT' });
    } else {
      postLines.push({ account: 'role:vat_input', ...sideOf(tax, 1), taxCodeId: t.codeId, taxBase: base, description: 'Input VAT' });
      if (t.category === 'reverse_charge') {
        postLines.push({ account: 'role:vat_output', ...sideOf(tax, -1), taxCodeId: t.codeId, taxBase: base, description: 'Output VAT (reverse charge)' });
      }
    }
  }
  postLines.push({ account: sales ? 'role:receivable' : 'role:payable', ...sideOf(Number(inv.gross_total), sales ? 1 : -1), partyId: inv.party_id,
    description: inv.supplier_ref ?? undefined });

  const date = inv.date.toISOString().slice(0, 10);
  const no = await nextNumber(tx, inv.company_id, inv.kind, DOC_PREFIX[inv.kind as InvoiceKind], date);
  const party = await one(tx, 'SELECT name FROM mdm.parties WHERE id = $1', [inv.party_id]);
  const journal = await post(tx, ctx, {
    companyId: inv.company_id, type: inv.kind, date, memo: `${no} – ${party.name}`, currency: inv.currency, fxRate: fx,
    source: { type: 'invoice', id: inv.id }, lines: postLines,
  });
  await tx.query(`UPDATE fin.invoices SET status = 'posted', no = $2, journal_id = $3 WHERE id = $1`, [inv.id, no, journal.id]);
  // A credit note settles its original invoice straight away (same rate, so no exchange difference).
  if (credit) {
    await tx.query(`INSERT INTO fin.allocations (tenant_id, credit_id, invoice_id, amount, date) VALUES (app.tenant(), $1, $2, $3, $4)`,
      [inv.id, inv.credit_of, inv.gross_total, date]);
  }
  return getInvoice(tx, ctx, inv.id);
}

export async function deleteDraft(tx: Tx, ctx: Ctx, invoiceId: string) {
  const inv = await one(tx, 'SELECT company_id, status FROM fin.invoices WHERE id = $1', [invoiceId]);
  if (!inv) throw new NotFoundError('document');
  await authorize(tx, ctx, 'fin.invoice.manage', { unitId: inv.company_id });
  if (inv.status !== 'draft') throw new ConflictError('only drafts can be deleted; issue a credit note for a posted document');
  await tx.query('DELETE FROM fin.invoices WHERE id = $1', [invoiceId]);
}

export async function getInvoice(tx: Tx, ctx: Ctx, id: string) {
  const inv = await one(tx, `SELECT i.*, p.name AS party_name FROM fin.invoices i JOIN mdm.parties p ON p.id = i.party_id WHERE i.id = $1`, [id]);
  if (!inv) throw new NotFoundError('document');
  await authorize(tx, ctx, 'fin.report.read', { unitId: inv.company_id });
  const lines = await many(tx, `SELECT l.*, a.code AS account_code, t.code AS tax_code FROM fin.invoice_lines l
                                  JOIN fin.accounts a ON a.id = l.account_id JOIN fin.tax_codes t ON t.id = l.tax_code_id
                                 WHERE invoice_id = $1 ORDER BY line_no`, [id]);
  return { ...inv, lines, outstanding: inv.status === 'posted' ? await outstanding(tx, id) : null };
}

export async function listInvoices(tx: Tx, ctx: Ctx, companyId: string, f: { kind?: string; status?: string; partyId?: string } = {}) {
  await authorize(tx, ctx, 'fin.report.read', { unitId: companyId });
  return many(tx, `SELECT i.id, i.kind, i.no, i.supplier_ref, i.date, i.due_date, i.currency, i.gross_total, i.status, p.name AS party_name,
                          i.gross_total - coalesce((SELECT sum(amount) FROM fin.allocations a WHERE a.invoice_id = i.id OR a.credit_id = i.id), 0) AS outstanding
                     FROM fin.invoices i JOIN mdm.parties p ON p.id = i.party_id
                    WHERE i.company_id = $1 AND ($2::text IS NULL OR i.kind = $2) AND ($3::text IS NULL OR i.status = $3)
                      AND ($4::uuid IS NULL OR i.party_id = $4)
                    ORDER BY i.date DESC, i.no DESC LIMIT 500`, [companyId, f.kind ?? null, f.status ?? null, f.partyId ?? null]);
}

// --- Receipts and payments ---------------------------------------------------------------

export interface PaymentInput {
  companyId: string; kind: 'receipt' | 'payment'; partyId: string; date: string; bankAccount: string;
  currency?: string; fxRate?: number; amount: number; reference?: string;
  allocations?: Array<{ invoiceId: string; amount: number }>;
}

/**
 * Record money received from a customer or paid to a supplier, optionally settling
 * documents. Settled amounts leave AR / AP at the documents' own exchange rates;
 * the difference to the payment rate is the realised exchange gain or loss (4450).
 * Any unallocated remainder stays on the partner's account as an advance.
 */
export async function recordPayment(tx: Tx, ctx: Ctx, input: PaymentInput) {
  const c = await company(tx, input.companyId);
  const currency = input.currency ?? c.base_currency;
  const fx = currency === c.base_currency ? 1 : input.fxRate;
  if (!fx) throw new ValidationError(`an exchange rate to ${c.base_currency} is needed for ${currency}`);
  const amount = round2(input.amount);
  await authorize(tx, ctx, 'fin.payment.post', { unitId: input.companyId, attrs: { amount: round2(amount * fx), kind: input.kind } });
  const party = await one(tx, 'SELECT * FROM mdm.parties WHERE id = $1', [input.partyId]);
  if (!party || !['active', 'blocked'].includes(party.status)) throw new ValidationError('unknown or unapproved partner');
  if (input.kind === 'payment' && party.status === 'blocked') throw new ValidationError(`${party.name} is blocked; payments to it are stopped`);
  const bank = await resolveAccount(tx, input.companyId, input.bankAccount);
  const bankRow = await one(tx, 'SELECT system_role, control, type FROM fin.accounts WHERE id = $1', [bank.id]);
  if (bankRow.type !== 'asset' || bankRow.control || !['cash', 'bank', 'pdc_received'].includes(bankRow.system_role ?? '') && !bank.code.startsWith('10')) {
    throw new ValidationError('receipts and payments go through a cash or bank account');
  }

  const receipt = input.kind === 'receipt';
  const docKind = receipt ? 'sales_invoice' : 'purchase_invoice';
  const allocs = input.allocations ?? [];
  let allocated = 0, controlBase = 0;
  const checked: Array<{ invoiceId: string; amount: number }> = [];
  for (const a of allocs) {
    const inv = await one(tx, 'SELECT * FROM fin.invoices WHERE id = $1 FOR UPDATE', [a.invoiceId]);
    if (!inv || inv.status !== 'posted' || inv.kind !== docKind || inv.party_id !== input.partyId || inv.company_id !== input.companyId) {
      throw new ValidationError(`allocation must be to a posted ${docKind.replace('_', ' ')} of this partner`);
    }
    if (inv.currency !== currency) throw new ValidationError(`invoice ${inv.no} is in ${inv.currency}; allocate payments in the same currency`);
    const amt = round2(a.amount);
    if (!(amt > 0) || amt > await outstanding(tx, inv.id) + 0.001) throw new ValidationError(`allocation to ${inv.no} is more than is open on it`);
    allocated += amt;
    controlBase += round2(amt * Number(inv.fx_rate));
    checked.push({ invoiceId: inv.id, amount: amt });
  }
  allocated = round2(allocated);
  if (allocated > amount + 0.001) throw new ValidationError('allocations exceed the amount');
  const unallocated = round2(amount - allocated);
  controlBase = round2(controlBase + unallocated * fx);
  const bankBase = round2(amount * fx);

  // receipt: Dr bank, Cr AR; payment: Dr AP, Cr bank. FX line balances the base currency.
  const s = receipt ? 1 : -1;
  const lines: PostingLine[] = [
    { account: bank.id, ...(receipt ? { debit: amount } : { credit: amount }), baseAmount: s * bankBase },
    { account: receipt ? 'role:receivable' : 'role:payable', ...(receipt ? { credit: amount } : { debit: amount }),
      baseAmount: -s * controlBase, partyId: input.partyId },
  ];
  const fxDiff = round2(-(s * bankBase - s * controlBase));
  if (fxDiff !== 0) lines.push({ account: 'role:fx_gain_loss', baseAmount: fxDiff, description: 'Realised exchange difference' });

  const no = await nextNumber(tx, input.companyId, input.kind, receipt ? 'RV' : 'PV', input.date);
  const pay = await one(tx, `INSERT INTO fin.payments (tenant_id, company_id, kind, no, party_id, date, bank_account_id, currency, fx_rate, amount, reference, created_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [input.companyId, input.kind, no, input.partyId, input.date, bank.id, currency, fx, amount, input.reference ?? null, ctx.userId]);
  const journal = await post(tx, ctx, {
    companyId: input.companyId, type: input.kind, date: input.date, memo: `${no} – ${party.name}${input.reference ? ' · ' + input.reference : ''}`,
    currency, fxRate: fx, source: { type: 'payment', id: pay.id }, lines,
  });
  await tx.query('UPDATE fin.payments SET journal_id = $2 WHERE id = $1', [pay.id, journal.id]);
  for (const a of checked) {
    await tx.query(`INSERT INTO fin.allocations (tenant_id, payment_id, invoice_id, amount, date) VALUES (app.tenant(), $1, $2, $3, $4)`,
      [pay.id, a.invoiceId, a.amount, input.date]);
  }
  return { ...pay, journal_id: journal.id, unallocated };
}

/** Apply an earlier advance (unallocated payment) to a document, posting any exchange difference. */
export async function allocateAdvance(tx: Tx, ctx: Ctx, input: { paymentId: string; invoiceId: string; amount: number; date: string }) {
  const pay = await one(tx, 'SELECT * FROM fin.payments WHERE id = $1 FOR UPDATE', [input.paymentId]);
  if (!pay) throw new NotFoundError('payment');
  await authorize(tx, ctx, 'fin.payment.post', { unitId: pay.company_id, attrs: { amount: 0, kind: pay.kind } });
  const used = Number((await one(tx, 'SELECT coalesce(sum(amount),0) AS s FROM fin.allocations WHERE payment_id = $1', [pay.id])).s);
  const amt = round2(input.amount);
  if (amt > round2(Number(pay.amount) - used) + 0.001) throw new ValidationError('more than the unallocated part of the payment');
  const inv = await one(tx, 'SELECT * FROM fin.invoices WHERE id = $1 FOR UPDATE', [input.invoiceId]);
  const receipt = pay.kind === 'receipt';
  if (!inv || inv.status !== 'posted' || inv.party_id !== pay.party_id || inv.kind !== (receipt ? 'sales_invoice' : 'purchase_invoice')) {
    throw new ValidationError('allocate to a posted invoice of the same partner');
  }
  if (inv.currency !== pay.currency) throw new ValidationError('currencies differ');
  if (amt > await outstanding(tx, inv.id) + 0.001) throw new ValidationError('more than is open on the invoice');
  // The advance sits on AR/AP at the payment rate; the invoice at its own rate. Clear the difference.
  const residual = round2(amt * Number(inv.fx_rate) - amt * Number(pay.fx_rate));
  if (residual !== 0) {
    const s = receipt ? -1 : 1;
    await post(tx, ctx, {
      companyId: pay.company_id, type: pay.kind, date: input.date, memo: `Exchange difference on ${pay.no} against ${inv.no}`,
      source: { type: 'allocation', id: crypto.randomUUID() },
      lines: [
        { account: receipt ? 'role:receivable' : 'role:payable', baseAmount: s * residual, partyId: pay.party_id },
        { account: 'role:fx_gain_loss', baseAmount: -s * residual, description: 'Realised exchange difference' },
      ],
    });
  }
  return one(tx, `INSERT INTO fin.allocations (tenant_id, payment_id, invoice_id, amount, date) VALUES (app.tenant(), $1, $2, $3, $4) RETURNING *`,
    [pay.id, inv.id, amt, input.date]);
}
