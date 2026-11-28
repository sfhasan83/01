import { createHash } from 'node:crypto';
import { ConflictError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { roundIn } from '../core/money.ts';
import { authorize } from '../iam/authz.ts';
import { company, nextNumber, post } from '../fin/ledger.ts';
import * as docs from '../fin/documents.ts';
import * as mdm from '../mdm/service.ts';
import * as org from '../org/service.ts';
import * as inv from '../inv/service.ts';
import * as hr from '../hr/service.ts';
import * as assets from '../fin/assets.ts';
import * as pur from '../pur/service.ts';
import * as sal from '../sal/service.ts';

/**
 * Bringing a company's data into BAATS when it starts using it: customers,
 * suppliers, items with their opening stock, employees with their contracts,
 * the opening trial balance, and the invoices and bills still open on the
 * cut-over date. Every import is checked first (nothing is saved, every row
 * problem is listed) and then saved all at once, or not at all.
 *
 * The files are CSV, as Excel saves them ("CSV UTF-8"). Partners imported here
 * become active without the usual approval: importing needs mig.import, and each
 * import is recorded with the file's fingerprint and who ran it.
 */

export const IMPORT_KINDS = {
  customers: { title: 'Customers', columns: ['code*', 'name*', 'country', 'currency', 'tax_no', 'credit_limit', 'email', 'phone', 'address', 'city'] },
  suppliers: { title: 'Suppliers', columns: ['code*', 'name*', 'country', 'currency', 'tax_no', 'email', 'phone', 'address', 'city', 'iban'] },
  items: { title: 'Items and opening stock', columns: ['code*', 'name*', 'type', 'uom', 'barcode', 'sale_price', 'warehouse', 'opening_qty', 'unit_cost'] },
  employees: { title: 'Employees and contracts', columns: ['employee_no*', 'first_name*', 'last_name*', 'email', 'unit', 'manager_no', 'designation', 'hire_date',
    'nationality', 'contract_start', 'basic', 'housing', 'transport', 'other_allowances', 'annual_leave_days', 'iban', 'wps_person_id', 'bank_routing_code'] },
  open_invoices: { title: 'Open customer invoices', columns: ['customer_code*', 'number*', 'date*', 'due_date', 'currency', 'fx_rate', 'amount_due*'] },
  open_bills: { title: 'Open supplier bills', columns: ['supplier_code*', 'number*', 'date*', 'due_date', 'currency', 'fx_rate', 'amount_due*'] },
  opening_balances: { title: 'Opening trial balance', columns: ['account*', 'debit', 'credit'] },
  fixed_assets: { title: 'Fixed assets', columns: ['code*', 'name*', 'category*', 'acquired_on*', 'useful_life_months*', 'cost*', 'depreciation_to_date', 'residual_value', 'cost_center'] },
  open_purchase_orders: { title: 'Open purchase orders', columns: ['supplier_code*', 'number*', 'date*', 'expected_date', 'currency', 'fx_rate', 'warehouse', 'item_code', 'description*', 'quantity_open*', 'unit_price*', 'tax_code'] },
  open_sales_orders: { title: 'Open sales orders', columns: ['customer_code*', 'number*', 'date*', 'currency', 'fx_rate', 'warehouse', 'item_code', 'description*', 'quantity_open*', 'unit_price*', 'discount', 'tax_code'] },
} as const;
export type ImportKind = keyof typeof IMPORT_KINDS;

/** An empty file with the right headings, to fill in Excel. */
export function template(kind: ImportKind): string {
  const k = IMPORT_KINDS[kind];
  if (!k) throw new ValidationError(`unknown import ${kind}`);
  return '﻿' + k.columns.map((c) => c.replace('*', '')).join(',') + '\r\n';
}

// --- CSV -------------------------------------------------------------------------------------

/** Read CSV text: quoted fields, doubled quotes, line breaks inside quotes, a byte order mark, and comma, semicolon or tab between fields. */
export function parseCsv(text: string): string[][] {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const count = (ch: string) => first.split(ch).length - 1;
  const sep = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

const header = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Rows as objects keyed by the column headings. */
export function readRows(kind: ImportKind, text: string): Record<string, string>[] {
  const all = parseCsv(text);
  if (all.length < 2) throw new ValidationError('the file has no rows under its headings');
  const heads = all[0].map(header);
  const known = IMPORT_KINDS[kind].columns.map((c) => c.replace('*', ''));
  const missing = IMPORT_KINDS[kind].columns.filter((c) => c.endsWith('*')).map((c) => c.slice(0, -1)).filter((c) => !heads.includes(c));
  if (missing.length) throw new ValidationError(`the file needs the column${missing.length > 1 ? 's' : ''} ${missing.join(', ')}; download the template to see them`);
  const unknown = heads.filter((h) => h && !known.includes(h));
  if (unknown.length) throw new ValidationError(`unknown column${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}; the columns are ${known.join(', ')}`);
  if (all.length - 1 > 5000) throw new ValidationError('a file has at most 5,000 rows; split it');
  return all.slice(1).map((r) => Object.fromEntries(heads.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** 1,234.50 and 1234.5 are numbers; empty is null. */
function num(v: string | undefined, what: string): number | null {
  if (v === undefined || v === '') return null;
  const s = v.replace(/[\s,]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new ValidationError(`${what} "${v}" is not a number`);
  return Number(s);
}
/** 2026-03-31, or 31/03/2026 (day first, as in the GCC). */
function dateOf(v: string | undefined, what: string): string | null {
  if (!v) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v))) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else throw new ValidationError(`${what} "${v}" is not a date; write 2026-03-31 or 31/03/2026`);
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(t.getTime()) || t.getUTCDate() !== d) throw new ValidationError(`${what} "${v}" is not a real date`);
  return iso;
}
const need = (v: string | undefined, what: string) => { if (!v) throw new ValidationError(`${what} is missing`); return v; };
const upper = (v: string | undefined) => (v ? v.toUpperCase() : undefined);

// --- Import ----------------------------------------------------------------------------------

export interface ImportInput {
  kind: ImportKind;
  companyId: string;
  /** The cut-over date: opening balances, opening stock and contracts without a start date use it. */
  asOf?: string;
  fileName?: string;
  csv: string;
  /** Check only: nothing is saved. */
  dryRun?: boolean;
}

export interface ImportResult {
  kind: ImportKind; dryRun: boolean; saved: boolean;
  rows: number; created: number; skipped: number;
  errors: { row: number; message: string }[];
  warnings: { row: number; message: string }[];
  journalNo?: string | null;
  runId?: string;
}

/**
 * Check, and unless dryRun save, one file. Row numbers in messages are the
 * spreadsheet's (the heading is row 1). If any row fails, nothing is saved.
 */
export async function runImport(tx: Tx, ctx: Ctx, input: ImportInput): Promise<ImportResult> {
  if (!(input.kind in IMPORT_KINDS)) throw new ValidationError(`unknown import ${input.kind}; the imports are ${Object.keys(IMPORT_KINDS).join(', ')}`);
  await authorize(tx, ctx, 'mig.import', { unitId: input.companyId });
  const co = await company(tx, input.companyId);
  const asOf = dateOf(input.asOf, 'the cut-over date') ?? new Date().toISOString().slice(0, 10);
  const rows = readRows(input.kind, input.csv);
  const res: ImportResult = { kind: input.kind, dryRun: !!input.dryRun, saved: false, rows: rows.length, created: 0, skipped: 0, errors: [], warnings: [] };
  const fp = createHash('sha256').update(input.csv).digest('hex');

  await tx.query('SAVEPOINT mig_import');
  const ctxRun: Run = { tx, ctx, co, asOf, res };
  const handler = HANDLERS[input.kind];
  for (const [i, r] of rows.entries()) {
    const rowNo = i + 2;
    await tx.query('SAVEPOINT mig_row');
    try {
      await handler.row(ctxRun, r, rowNo);
      await tx.query('RELEASE SAVEPOINT mig_row');
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT mig_row');
      res.errors.push({ row: rowNo, message: (err as Error).message });
      if (res.errors.length >= 200) { res.errors.push({ row: 0, message: 'more than 200 problems; fix these and check again' }); break; }
    }
  }
  if (!res.errors.length && handler.finish) {
    try { await handler.finish(ctxRun); } catch (err) { res.errors.push({ row: 0, message: (err as Error).message }); }
  }
  if (res.errors.length || input.dryRun) {
    await tx.query('ROLLBACK TO SAVEPOINT mig_import');
    if (!res.errors.length) res.journalNo = res.journalNo ?? null;
    return res;
  }
  await tx.query('RELEASE SAVEPOINT mig_import');
  res.saved = true;
  res.runId = (await one(tx, `INSERT INTO mig.import_runs (tenant_id, company_id, kind, file_name, sha256, as_of, rows, created, skipped, warnings, journal_no, created_by)
      VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
  [input.companyId, input.kind, input.fileName?.slice(0, 200) ?? null, fp, asOf, res.rows, res.created, res.skipped, JSON.stringify(res.warnings), res.journalNo ?? null, ctx.userId])).id;
  return res;
}

export async function listImportRuns(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'mig.import', { unitId: companyId });
  return many(tx, `SELECT r.id, r.kind, r.file_name, r.as_of, r.rows, r.created, r.skipped, r.journal_no, r.created_at, u.email AS by
                     FROM mig.import_runs r LEFT JOIN iam.users u ON u.id = r.created_by WHERE r.company_id = $1 ORDER BY r.created_at DESC LIMIT 100`, [companyId]);
}

interface Run {
  tx: Tx; ctx: Ctx; co: { unit_id: string; base_currency: string; country_code: string; legal_name: string }; asOf: string; res: ImportResult;
  stock?: Map<string, { itemId: string; qty: number; unitCost: number }[]>;
  orders?: Map<string, { row: number; head: Record<string, string>; lines: { row: number; x: Record<string, string> }[] }>;
  tb?: { account: string; id: string; role: string | null; control: string | null; amount: number; row: number }[];
}
type Handler = { row: (r: Run, row: Record<string, string>, n: number) => Promise<void>; finish?: (r: Run) => Promise<void> };

async function partyRow(r: Run, x: Record<string, string>, customer: boolean) {
  const code = need(x.code, 'code'), name = need(x.name, 'name');
  const existing = await one(r.tx, 'SELECT id, is_customer, is_supplier FROM mdm.parties WHERE code = $1', [code]);
  if (existing) {
    // Someone already in BAATS: make them a customer or supplier too if they were not.
    const flag = customer ? 'is_customer' : 'is_supplier';
    if (!existing[flag]) { await r.tx.query(`UPDATE mdm.parties SET ${flag} = true WHERE id = $1`, [existing.id]); r.res.created++; }
    else r.res.skipped++;
    return;
  }
  const country = upper(x.country) ?? r.co.country_code;
  const attributes: Record<string, string> = {};
  for (const k of ['email', 'phone', 'address', 'city', 'iban'] as const) if (x[k]) attributes[k === 'address' ? 'street' : k] = x[k];
  const creditLimit = customer ? num(x.credit_limit, 'credit_limit') : null;
  if (creditLimit !== null && creditLimit < 0) throw new ValidationError('credit_limit cannot be negative');
  const { party, possibleDuplicates } = await mdm.createParty(r.tx, r.ctx, { code, name, isCustomer: customer, isSupplier: !customer, countryCode: country,
    currencyCode: upper(x.currency), taxRegistrationNo: x.tax_no || undefined, creditLimit: creditLimit ?? undefined, ownerUnitId: r.co.unit_id, attributes });
  await r.tx.query(`UPDATE mdm.parties SET status = 'active' WHERE id = $1`, [party.id]);
  if (possibleDuplicates.length) r.res.warnings.push({ row: 0, message: `${name} looks like ${possibleDuplicates.map((d: any) => d.code).join(', ')} already in BAATS` });
  r.res.created++;
}

async function openItem(r: Run, x: Record<string, string>, sales: boolean) {
  const code = need(sales ? x.customer_code : x.supplier_code, sales ? 'customer_code' : 'supplier_code');
  const p = await one(r.tx, 'SELECT id, status FROM mdm.parties WHERE code = $1', [code]);
  if (!p) throw new ValidationError(`no ${sales ? 'customer' : 'supplier'} with code ${code}; import ${sales ? 'customers' : 'suppliers'} first`);
  const number = need(x.number, 'number');
  const date = dateOf(need(x.date, 'date'), 'date')!;
  if (date > r.asOf) throw new ValidationError(`the date ${date} is after the cut-over date ${r.asOf}`);
  const due = dateOf(x.due_date, 'due_date') ?? undefined;
  const currency = upper(x.currency) ?? r.co.base_currency;
  const amount = num(need(x.amount_due, 'amount_due'), 'amount_due')!;
  if (!(amount > 0)) throw new ValidationError('amount_due must be more than zero; a credit is entered as a credit note after the import');
  const fx = currency === r.co.base_currency ? undefined : num(x.fx_rate, 'fx_rate') ?? undefined;
  if (currency !== r.co.base_currency && !fx) throw new ValidationError(`fx_rate is needed for an amount in ${currency}`);
  const dup = await one(r.tx, `SELECT 1 FROM fin.invoices WHERE company_id = $1 AND party_id = $2 AND notes = $3`, [r.co.unit_id, p.id, `Opening balance: ${number}`]);
  if (dup) { r.res.skipped++; return; }
  // One out-of-scope line against opening balance equity: no VAT again, no revenue or cost again.
  const d = await docs.createInvoice(r.tx, r.ctx, { companyId: r.co.unit_id, kind: sales ? 'sales_invoice' : 'purchase_invoice', partyId: p.id, date: r.asOf,
    dueDate: due && due >= r.asOf ? due : r.asOf, currency, fxRate: fx, supplierRef: sales ? undefined : number, notes: `Opening balance: ${number}`,
    lines: [{ description: `Opening balance, ${sales ? 'invoice' : 'bill'} ${number} of ${date}`, quantity: 1, unitPrice: roundIn(currency, amount), taxCode: 'OS', account: 'role:opening_balance_equity' }],
    source: { type: 'mig.open_item', id: p.id } });
  await docs.postInvoice(r.tx, r.ctx, d.id);
  r.res.created++;
}

/** Order lines are grouped by their number; each order is checked as a whole when the file has been read. */
function collectOrderLine(r: Run, x: Record<string, string>, n: number, partyCol: string) {
  const number = need(x.number, 'number'); need(x[partyCol], partyCol); need(x.date, 'date'); need(x.description, 'description');
  const qty = num(need(x.quantity_open, 'quantity_open'), 'quantity_open')!;
  if (!(qty > 0)) throw new ValidationError('quantity_open is what is still to be delivered; it must be more than zero');
  const price = num(need(x.unit_price, 'unit_price'), 'unit_price')!;
  if (price < 0) throw new ValidationError('unit_price cannot be negative');
  r.orders ??= new Map();
  const o = r.orders.get(number);
  if (!o) r.orders.set(number, { row: n, head: x, lines: [{ row: n, x }] });
  else {
    for (const k of [partyCol, 'date', 'currency']) if ((x[k] || '') !== (o.head[k] || '')) throw new ValidationError(`order ${number}: ${k} differs from row ${o.row}`);
    o.lines.push({ row: n, x });
  }
}

/** The tax code lines get when the file leaves it empty: the country's standard rate, or no VAT where there is none. */
async function defaultTaxCode(r: Run): Promise<string> {
  const t = await one(r.tx, `SELECT code FROM fin.tax_codes WHERE country_code = $1 AND active ORDER BY (category = 'standard') DESC, (category = 'out_of_scope') DESC, code LIMIT 1`, [r.co.country_code]);
  if (!t) throw new ValidationError('this company has no tax codes');
  return t.code;
}

async function orderLines(r: Run, lines: { row: number; x: Record<string, string> }[], purchase: boolean) {
  const tax = await defaultTaxCode(r);
  let stock = false;
  const out = [];
  for (const { row, x } of lines) {
    let itemId: string | undefined;
    if (x.item_code) {
      const it = await one(r.tx, 'SELECT id, item_type FROM mdm.items WHERE code = $1', [x.item_code]);
      if (!it) throw new ValidationError(`row ${row}: no item ${x.item_code}; import items first`);
      itemId = it.id; stock ||= it.item_type === 'stock';
    }
    const disc = purchase ? null : num(x.discount, 'discount');
    out.push({ itemId, description: x.description, quantity: num(x.quantity_open, 'quantity_open')!, unitPrice: num(x.unit_price, 'unit_price')!,
      ...(disc ? { discount: disc } : {}), taxCode: upper(x.tax_code) ?? tax });
  }
  return { lines: out, stock };
}

async function orderWarehouse(r: Run, code: string | undefined, needed: boolean, number: string) {
  if (code) {
    const w = await one(r.tx, 'SELECT id FROM inv.warehouses WHERE company_id = $1 AND code = $2', [r.co.unit_id, code]);
    if (!w) throw new ValidationError(`order ${number}: no warehouse ${code}`);
    return w.id as string;
  }
  if (!needed) return undefined;
  const ws = await many(r.tx, 'SELECT id FROM inv.warehouses WHERE company_id = $1', [r.co.unit_id]);
  if (ws.length !== 1) throw new ValidationError(`order ${number} has stock items; give the warehouse`);
  return ws[0].id as string;
}

async function importOrders(r: Run, purchase: boolean) {
  for (const [number, o] of r.orders ?? []) {
    const tag = `Imported open order ${number}`;
    const table = purchase ? 'pur.orders' : 'sal.orders';
    if (await one(r.tx, `SELECT 1 FROM ${table} WHERE company_id = $1 AND notes = $2`, [r.co.unit_id, tag])) { r.res.skipped++; continue; }
    const h = o.head;
    const code = purchase ? h.supplier_code : h.customer_code;
    const p = await one(r.tx, `SELECT id FROM mdm.parties WHERE code = $1 AND ${purchase ? 'is_supplier' : 'is_customer'}`, [code]);
    if (!p) throw new ValidationError(`row ${o.row}: no ${purchase ? 'supplier' : 'customer'} with code ${code}; import ${purchase ? 'suppliers' : 'customers'} first`);
    const date = dateOf(h.date, 'date')!;
    if (date > r.asOf) throw new ValidationError(`row ${o.row}: the date ${date} is after the cut-over date ${r.asOf}`);
    const currency = upper(h.currency) ?? undefined;
    const fx = currency && currency !== r.co.base_currency ? num(h.fx_rate, 'fx_rate') ?? undefined : undefined;
    if (currency && currency !== r.co.base_currency && !fx) throw new ValidationError(`row ${o.row}: fx_rate is needed for an order in ${currency}`);
    const { lines, stock } = await orderLines(r, o.lines, purchase);
    const warehouseId = await orderWarehouse(r, h.warehouse || undefined, stock, number);
    try {
      if (purchase) {
        const po = await pur.createOrder(r.tx, r.ctx, { companyId: r.co.unit_id, supplierId: p.id, date, expectedDate: dateOf(h.expected_date, 'expected_date') ?? undefined,
          currency, fxRate: fx, warehouseId, notes: tag, lines: lines as any });
        // Approved in the old system already: it comes in approved, with its own number in BAATS.
        const no = await nextNumber(r.tx, r.co.unit_id, 'pur_order', 'PO', date);
        await r.tx.query(`UPDATE pur.orders SET status = 'approved', no = $2 WHERE id = $1`, [po.id, no]);
      } else {
        const so = await sal.createQuotation(r.tx, r.ctx, { companyId: r.co.unit_id, customerId: p.id, date, currency, fxRate: fx, warehouseId, notes: tag, lines: lines as any });
        await sal.confirmOrder(r.tx, r.ctx, so.id);
      }
    } catch (err) {
      throw new ValidationError(`order ${number} (row ${o.row}): ${(err as Error).message}`);
    }
    r.res.created++;
  }
}

const HANDLERS: Record<ImportKind, Handler> = {
  fixed_assets: {
    async row(r, x) {
      const code = need(x.code, 'code');
      if (await one(r.tx, 'SELECT 1 FROM fin.assets WHERE company_id = $1 AND code = $2', [r.co.unit_id, code])) { r.res.skipped++; return; }
      const acquired = dateOf(need(x.acquired_on, 'acquired_on'), 'acquired_on')!;
      if (acquired > r.asOf) throw new ValidationError(`acquired_on ${acquired} is after the cut-over date ${r.asOf}`);
      const life = num(need(x.useful_life_months, 'useful_life_months'), 'useful_life_months')!;
      if (!Number.isInteger(life) || life < 1) throw new ValidationError('useful_life_months is a whole number of months, at least 1');
      const cost = num(need(x.cost, 'cost'), 'cost')!;
      if (!(cost > 0)) throw new ValidationError('cost must be more than zero');
      const acc = num(x.depreciation_to_date, 'depreciation_to_date') ?? 0;
      if (acc < 0 || acc > cost) throw new ValidationError('depreciation_to_date is between zero and the cost');
      let unitId: string | undefined;
      if (x.cost_center) {
        const u = await one(r.tx, 'SELECT id FROM org.units WHERE code = $1', [x.cost_center]);
        if (!u) throw new ValidationError(`no unit with code ${x.cost_center}`);
        unitId = u.id;
      }
      await assets.registerAsset(r.tx, r.ctx, { companyId: r.co.unit_id, code, name: need(x.name, 'name'), category: need(x.category, 'category'), unitId,
        acquisitionDate: acquired, usefulLifeMonths: life, residualValue: num(x.residual_value, 'residual_value') ?? undefined, cost, openingAccumulated: acc, openingDate: r.asOf });
      r.res.created++;
    },
  },
  open_purchase_orders: { row: (r, x, n) => { collectOrderLine(r, x, n, 'supplier_code'); return Promise.resolve(); }, finish: (r) => importOrders(r, true) },
  open_sales_orders: { row: (r, x, n) => { collectOrderLine(r, x, n, 'customer_code'); return Promise.resolve(); }, finish: (r) => importOrders(r, false) },
  customers: { row: (r, x) => partyRow(r, x, true) },
  suppliers: { row: (r, x) => partyRow(r, x, false) },

  items: {
    async row(r, x) {
      const code = need(x.code, 'code'), name = need(x.name, 'name');
      const type = (x.type || 'stock').toLowerCase();
      if (!['stock', 'service', 'non_stock'].includes(type)) throw new ValidationError('type is stock, service or non_stock');
      const uomCode = upper(x.uom) ?? 'EA';
      if (!(await one(r.tx, 'SELECT 1 FROM mdm.uoms WHERE code = $1', [uomCode]))) await mdm.createUom(r.tx, r.ctx, { code: uomCode, name: uomCode });
      let item = await one(r.tx, 'SELECT id, item_type FROM mdm.items WHERE code = $1', [code]);
      if (item) r.res.skipped++;
      else {
        const price = num(x.sale_price, 'sale_price');
        item = await mdm.createItem(r.tx, r.ctx, { code, name, itemType: type, baseUom: uomCode, barcode: x.barcode || undefined,
          attributes: price !== null ? { sale_price: price } : {} });
        r.res.created++;
      }
      const qty = num(x.opening_qty, 'opening_qty');
      if (qty === null || qty === 0) return;
      if (item.item_type !== 'stock') throw new ValidationError('only stock items have opening stock');
      if (qty < 0) throw new ValidationError('opening_qty cannot be negative');
      const cost = num(need(x.unit_cost, 'unit_cost (needed with opening_qty)'), 'unit_cost')!;
      if (cost < 0) throw new ValidationError('unit_cost cannot be negative');
      const whCode = need(x.warehouse, 'warehouse (needed with opening_qty)');
      let wh = await one(r.tx, 'SELECT id FROM inv.warehouses WHERE company_id = $1 AND code = $2', [r.co.unit_id, whCode]);
      if (!wh) wh = await inv.createWarehouse(r.tx, r.ctx, { companyId: r.co.unit_id, code: whCode, name: whCode });
      r.stock ??= new Map();
      const list = r.stock.get(wh.id) ?? [];
      list.push({ itemId: item.id, qty, unitCost: cost });
      r.stock.set(wh.id, list);
    },
    async finish(r) {
      for (const [warehouseId, lines] of r.stock ?? []) {
        const moved = await one(r.tx, `SELECT 1 FROM inv.moves WHERE warehouse_id = $1 AND item_id = ANY($2) LIMIT 1`, [warehouseId, lines.map((l) => l.itemId)]);
        if (moved) throw new ConflictError('some of these items already have stock movements in that warehouse; enter differences as stock adjustments instead');
        await inv.openingStock(r.tx, r.ctx, { companyId: r.co.unit_id, warehouseId, date: r.asOf, lines });
      }
    },
  },

  employees: {
    async row(r, x) {
      const no = need(x.employee_no, 'employee_no');
      let e = await one(r.tx, 'SELECT id FROM org.employees WHERE employee_no = $1', [no]);
      if (e) r.res.skipped++;
      else {
        const unit = x.unit ? await one(r.tx, 'SELECT id FROM org.units WHERE code = $1', [x.unit]) : { id: r.co.unit_id };
        if (!unit) throw new ValidationError(`no unit with code ${x.unit}`);
        const manager = x.manager_no ? await one(r.tx, 'SELECT id FROM org.employees WHERE employee_no = $1', [x.manager_no]) : null;
        if (x.manager_no && !manager) throw new ValidationError(`no employee ${x.manager_no} for the manager; list managers above the people who report to them`);
        const desig = x.designation ? await one(r.tx, 'SELECT id FROM org.designations WHERE code = $1 OR title = $1', [x.designation]) : null;
        if (x.designation && !desig) throw new ValidationError(`no designation ${x.designation}; add it under Organization first`);
        const nat = upper(x.nationality);
        if (nat && !/^[A-Z]{2}$/.test(nat)) throw new ValidationError('nationality is a two-letter country code, such as AE or IN');
        e = await org.createEmployee(r.tx, r.ctx, { employeeNo: no, firstName: need(x.first_name, 'first_name'), lastName: need(x.last_name, 'last_name'),
          email: x.email || undefined, unitId: unit.id, managerId: manager?.id, designationId: desig?.id, hireDate: dateOf(x.hire_date, 'hire_date') ?? undefined, nationality: nat });
        r.res.created++;
      }
      const basic = num(x.basic, 'basic');
      if (basic === null) return;
      if (await one(r.tx, `SELECT 1 FROM hr.contracts WHERE employee_id = $1 AND status = 'active'`, [e.id])) { r.res.warnings.push({ row: 0, message: `${no} already has a contract; it was left as it is` }); return; }
      await hr.createContract(r.tx, r.ctx, { employeeId: e.id, companyId: r.co.unit_id, startDate: dateOf(x.contract_start, 'contract_start') ?? dateOf(x.hire_date, 'hire_date') ?? r.asOf,
        basic, housing: num(x.housing, 'housing') ?? undefined, transport: num(x.transport, 'transport') ?? undefined, otherAllowances: num(x.other_allowances, 'other_allowances') ?? undefined,
        annualLeaveDays: num(x.annual_leave_days, 'annual_leave_days') ?? undefined, iban: x.iban || undefined, wpsPersonId: x.wps_person_id || undefined, bankRoutingCode: x.bank_routing_code || undefined });
    },
  },

  open_invoices: { row: (r, x) => openItem(r, x, true) },
  open_bills: { row: (r, x) => openItem(r, x, false) },

  opening_balances: {
    async row(r, x, n) {
      const code = need(x.account, 'account');
      const a = await one(r.tx, 'SELECT id, code, name, system_role, control, is_group, status FROM fin.accounts WHERE company_id = $1 AND code = $2', [r.co.unit_id, code]);
      if (!a) throw new ValidationError(`no account ${code} in the chart; add it under Finance: setup first`);
      if (a.is_group) throw new ValidationError(`${code} ${a.name} is a heading; use the accounts under it`);
      const dr = num(x.debit, 'debit') ?? 0, cr = num(x.credit, 'credit') ?? 0;
      if (dr < 0 || cr < 0) throw new ValidationError('debit and credit are not negative; put the amount in the other column');
      const amount = roundIn(r.co.base_currency, dr - cr);
      if (amount === 0) { r.res.skipped++; return; }
      if (a.system_role === 'opening_balance_equity') throw new ValidationError(`${code} is where BAATS balances the opening entry; leave it out`);
      r.tb ??= [];
      r.tb.push({ account: a.code, id: a.id, role: a.system_role, control: a.control, amount, row: n });
    },
    async finish(r) {
      const tb = r.tb ?? [];
      if (!tb.length) throw new ValidationError('the file has no balances');
      if (await one(r.tx, `SELECT 1 FROM mig.import_runs WHERE company_id = $1 AND kind = 'opening_balances'`, [r.co.unit_id])) {
        throw new ConflictError('the opening balances of this company were imported already; reverse that journal first if they need to change');
      }
      const total = roundIn(r.co.base_currency, tb.reduce((s, l) => s + l.amount, 0));
      if (Math.abs(total) > 0.0005) throw new ValidationError(`the trial balance does not balance: debits are ${total > 0 ? 'more' : 'less'} than credits by ${Math.abs(total)}`);
      // Customers, suppliers and stock come from their own imports; here they are only checked.
      // Fixed assets imported from the register are checked against it, like customers and stock.
      const faImported = !!(await one(r.tx, 'SELECT 1 FROM fin.assets WHERE company_id = $1 LIMIT 1', [r.co.unit_id]));
      const isSub = (l: { control: string | null; role: string | null }) => !!l.control || l.role === 'inventory' || (faImported && (l.role === 'fixed_assets' || l.role === 'accumulated_depreciation'));
      const sub = tb.filter(isSub);
      for (const l of sub) {
        const bal = Number((await one(r.tx, `SELECT coalesce(sum(jl.debit - jl.credit), 0) AS b FROM fin.journal_lines jl
            JOIN fin.journals j ON j.id = jl.journal_id AND j.status = 'posted' WHERE jl.account_id = $1 AND j.date <= $2`, [l.id, r.asOf])).b);
        if (l.role === 'inventory' && bal === 0 && !(await one(r.tx, 'SELECT 1 FROM inv.moves m JOIN inv.warehouses w ON w.id = m.warehouse_id WHERE w.company_id = $1 LIMIT 1', [r.co.unit_id]))) {
          l.control = null; l.role = 'inventory_direct';
          r.res.warnings.push({ row: l.row, message: `${l.account}: no opening stock was imported, so the stock value is posted without quantities; import items with opening stock instead to keep quantities` });
          continue;
        }
        if (Math.abs(roundIn(r.co.base_currency, bal - l.amount)) > 0.0005) {
          const what = l.control === 'receivable' ? 'open customer invoices' : l.control === 'payable' ? 'open supplier bills' : l.role === 'inventory' ? 'opening stock' : 'fixed assets';
          throw new ValidationError(`row ${l.row}: account ${l.account} is ${l.amount} here but the imported ${what} come to ${bal}; import the ${what} first, or correct the amount`);
        }
      }
      const lines = tb.filter((l) => !isSub(l))
        .map((l) => ({ account: l.id, ...(l.amount > 0 ? { debit: l.amount } : { credit: -l.amount }), description: 'Opening balance' }));
      const rest = roundIn(r.co.base_currency, sub.filter(isSub).reduce((s, l) => s + l.amount, 0));
      // What the sub-ledger imports put on opening balance equity is taken back out here.
      if (rest) lines.push({ account: 'role:opening_balance_equity', ...(rest > 0 ? { debit: rest } : { credit: -rest }), description: 'Customers, suppliers and stock imported separately' } as any);
      if (lines.length < 2) { r.res.created = tb.length; return; }
      const j = await post(r.tx, r.ctx, { companyId: r.co.unit_id, type: 'opening', date: r.asOf, memo: `Opening balances at ${r.asOf}`, lines });
      r.res.journalNo = j.no;
      r.res.created = tb.length;
    },
  },
};

// --- BAATS Accounting --------------------------------------------------------------------

/**
 * A BAATS Accounting book, as saved with Import / Export, All (JSON): its
 * customers, suppliers and items, turned into the CSV files above so they go
 * through the same checks. Balances come from its trial balance and open
 * invoices, which are imported with the opening balance files.
 */
export function fromBaatsAccounting(json: string): { customers: string; suppliers: string; items: string; counts: Record<string, number> } {
  let S: any;
  try { S = JSON.parse(json.replace(/^﻿/, '')); } catch { throw new ValidationError('this is not a BAATS Accounting book (JSON); in BAATS Accounting use Import / Export, All'); }
  if (!S || typeof S !== 'object' || !Array.isArray(S.cust) || !Array.isArray(S.sup) || !Array.isArray(S.acc)) {
    throw new ValidationError('this file is not a BAATS Accounting book: it has no customers, suppliers or accounts');
  }
  const q = (v: unknown) => { const s = String(v ?? '').replace(/\r?\n/g, ' ').trim(); return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = (cols: string[], rows: unknown[][]) => [cols.join(','), ...rows.map((r) => r.map(q).join(','))].join('\r\n') + '\r\n';
  const codeFor = (prefix: string, i: number, x: any) => (x.code ? String(x.code) : `${prefix}${String(i + 1).padStart(4, '0')}`);
  const party = (list: any[], prefix: string, customer: boolean) => csv(
    customer ? ['code', 'name', 'country', 'tax_no', 'credit_limit', 'email', 'phone', 'address', 'city'] : ['code', 'name', 'country', 'tax_no', 'email', 'phone', 'address', 'city'],
    list.filter((x) => x && x.name).map((x, i) => customer
      ? [codeFor(prefix, i, x), x.name, x.ctry || '', x.trn || '', x.limit || x.cl || '', x.email || '', x.phone || '', x.addr || x.street || '', x.city || '']
      : [codeFor(prefix, i, x), x.name, x.ctry || '', x.trn || '', x.email || '', x.phone || '', x.addr || x.street || '', x.city || '']));
  const items = (S.it ?? []).filter((x: any) => x && x.name);
  return {
    customers: party(S.cust, 'C', true),
    suppliers: party(S.sup, 'S', false),
    items: csv(['code', 'name', 'type', 'uom', 'sale_price'], items.map((x: any, i: number) => [codeFor('I', i, x), x.name, x.type === 'S' ? 'service' : 'stock', x.unit || 'EA', x.price ?? ''])),
    counts: { customers: S.cust.filter((x: any) => x?.name).length, suppliers: S.sup.filter((x: any) => x?.name).length, items: items.length },
  };
}
