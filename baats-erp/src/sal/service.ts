import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';
import { company, nextNumber, post, roundMoney } from '../fin/ledger.ts';
import { priceLines } from '../fin/pricing.ts';
import { roundIn } from '../core/money.ts';
import { createInvoice } from '../fin/documents.ts';
import { applyMove, issueCost, warehouse } from '../inv/service.ts';

/**
 * Order to cash:
 *   quotation   -> numbered QT, editable
 *   confirm     -> numbered SO; credit limit checked against open receivables plus this order;
 *                  a linked opportunity is marked won
 *   delivery    -> stock leaves the warehouse at moving average: Dr 5050 COGS | Cr 1300 Inventory
 *   invoice     -> a sales invoice drafted from what was delivered (stock) or ordered (services)
 *                  and not invoiced yet; then posted in finance (Dr 1100 | Cr revenue | Cr 2100)
 */

export interface SalesLineInput { itemId?: string; description: string; quantity: number; unitPrice: number; discount?: number; taxCode: string; account?: string }
export interface QuotationInput {
  companyId: string; customerId: string; date: string; validUntil?: string; currency?: string; fxRate?: number;
  warehouseId?: string; sellingUnitId?: string; opportunityId?: string; notes?: string; lines: SalesLineInput[];
}

async function customer(tx: Tx, id: string) {
  const p = await one(tx, 'SELECT * FROM mdm.parties WHERE id = $1', [id]);
  if (!p || !p.is_customer) throw new ValidationError('unknown customer');
  return p;
}

export async function createQuotation(tx: Tx, ctx: Ctx, input: QuotationInput) {
  await authorize(tx, ctx, 'sal.order.manage', { unitId: input.sellingUnitId ?? input.companyId });
  const c = await company(tx, input.companyId);
  const cust = await customer(tx, input.customerId);
  if (cust.status === 'blocked' || cust.status === 'rejected') throw new ValidationError(`${cust.name} is ${cust.status}`);
  if (!input.lines?.length) throw new ValidationError('a quotation needs at least one line');
  const currency = input.currency ?? cust.currency_code;
  const fx = currency === c.base_currency ? 1 : input.fxRate;
  if (!fx) throw new ValidationError(`an exchange rate to ${c.base_currency} is needed for ${currency}`);
  for (const l of input.lines) {
    if (!l.itemId) continue;
    const item = await one(tx, 'SELECT item_type, status, code FROM mdm.items WHERE id = $1', [l.itemId]);
    if (!item) throw new ValidationError('unknown item');
    if (item.status !== 'active') throw new ValidationError(`${item.code} is ${item.status}`);
    if (item.item_type === 'stock' && !input.warehouseId) throw new ValidationError('choose the warehouse the goods ship from');
  }
  if (input.warehouseId) await warehouse(tx, input.companyId, input.warehouseId);
  const priced = await priceLines(tx, c.country_code, currency, input.lines);
  const quoteNo = await nextNumber(tx, input.companyId, 'sal_quote', 'QT', input.date);
  const o = await one(tx, `INSERT INTO sal.orders (tenant_id, company_id, quote_no, customer_id, opportunity_id, date, valid_until, currency, fx_rate,
      warehouse_id, selling_unit_id, notes, net_total, tax_total, gross_total, created_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
    [input.companyId, quoteNo, input.customerId, input.opportunityId ?? null, input.date, input.validUntil ?? null, currency, fx,
      input.warehouseId ?? null, input.sellingUnitId ?? null, input.notes ?? null, priced.net, priced.tax, priced.gross, ctx.userId]);
  for (const [i, l] of input.lines.entries()) {
    await tx.query(`INSERT INTO sal.order_lines (tenant_id, order_id, line_no, item_id, description, quantity, unit_price, discount, tax_code, account, net_amount)
      VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [o.id, i + 1, l.itemId ?? null, l.description, l.quantity, l.unitPrice, l.discount ?? 0, l.taxCode, l.account ?? null, priced.lines[i].net]);
  }
  if (input.opportunityId) {
    await tx.query(`UPDATE crm.opportunities SET stage = 'proposal', probability = greatest(probability, 50)
                     WHERE id = $1 AND stage IN ('prospecting','qualification')`, [input.opportunityId]);
  }
  return getOrder(tx, ctx, o.id);
}

/** Customer exposure in base currency: open posted invoices plus confirmed, not yet invoiced orders. */
export async function exposure(tx: Tx, customerId: string, companyId: string): Promise<number> {
  const r = await one(tx, `
    SELECT coalesce((SELECT sum((i.gross_total
              - coalesce((SELECT sum(amount) FROM fin.allocations a WHERE a.invoice_id = i.id OR a.credit_id = i.id), 0)) * i.fx_rate
              * CASE WHEN i.kind = 'sales_credit' THEN -1 ELSE 1 END)
          FROM fin.invoices i WHERE i.party_id = $1 AND i.company_id = $2 AND i.status = 'posted' AND i.kind IN ('sales_invoice','sales_credit')), 0)
         + coalesce((SELECT sum(o.gross_total * o.fx_rate) FROM sal.orders o
          WHERE o.customer_id = $1 AND o.company_id = $2 AND o.status = 'confirmed'
            AND NOT EXISTS (SELECT 1 FROM fin.invoices v WHERE v.source_type = 'sal.order' AND v.source_id = o.id AND v.status <> 'void')), 0) AS e`,
  [customerId, companyId]);
  return roundMoney(Number(r.e));
}

export async function confirmOrder(tx: Tx, ctx: Ctx, orderId: string) {
  const o = await one(tx, 'SELECT * FROM sal.orders WHERE id = $1 FOR UPDATE', [orderId]);
  if (!o) throw new NotFoundError('sales order');
  await authorize(tx, ctx, 'sal.order.manage', { unitId: o.selling_unit_id ?? o.company_id });
  if (o.status !== 'quotation') throw new ConflictError(`the order is already ${o.status}`);
  const cust = await customer(tx, o.customer_id);
  if (cust.status !== 'active') throw new ValidationError(`${cust.name} is ${cust.status}; the customer must be approved before an order is confirmed`);
  if (cust.credit_limit !== null) {
    const c = await company(tx, o.company_id);
    // The limit is held in the customer's currency; compare in base using this order's rate when they differ.
    const limitBase = cust.currency_code === c.base_currency ? Number(cust.credit_limit) : Number(cust.credit_limit) * Number(o.fx_rate);
    const after = roundMoney(await exposure(tx, o.customer_id, o.company_id) + Number(o.gross_total) * Number(o.fx_rate));
    if (after > limitBase + 0.0005) {
      throw new ValidationError(`credit limit exceeded for ${cust.name}: exposure would be ${after} ${c.base_currency} against a limit of ${roundMoney(limitBase)}`);
    }
  }
  const no = await nextNumber(tx, o.company_id, 'sal_order', 'SO', o.date.toISOString().slice(0, 10));
  await tx.query(`UPDATE sal.orders SET status = 'confirmed', no = $2 WHERE id = $1`, [orderId, no]);
  if (o.opportunity_id) await tx.query(`UPDATE crm.opportunities SET stage = 'won', probability = 100, party_id = coalesce(party_id, $2) WHERE id = $1`, [o.opportunity_id, o.customer_id]);
  return getOrder(tx, ctx, orderId);
}

const LINE_PROGRESS = `
  SELECT l.*, i.code AS item_code, i.item_type,
         coalesce((SELECT sum(d.quantity) FROM sal.delivery_lines d WHERE d.order_line_id = l.id), 0)::float AS delivered_qty,
         coalesce((SELECT sum(b.quantity) FROM fin.invoice_lines b JOIN fin.invoices v ON v.id = b.invoice_id
                    WHERE b.source_line_id = l.id AND v.status <> 'void'), 0)::float AS invoiced_qty
    FROM sal.order_lines l LEFT JOIN mdm.items i ON i.id = l.item_id`;

export async function getOrder(tx: Tx, ctx: Ctx, id: string) {
  const o = await one(tx, `SELECT o.*, p.name AS customer_name FROM sal.orders o JOIN mdm.parties p ON p.id = o.customer_id WHERE o.id = $1`, [id]);
  if (!o) throw new NotFoundError('sales order');
  await authorize(tx, ctx, 'sal.order.manage', { unitId: o.selling_unit_id ?? o.company_id });
  const lines = await many(tx, `${LINE_PROGRESS} WHERE l.order_id = $1 ORDER BY l.line_no`, [id]);
  const deliveries = await many(tx, 'SELECT id, no, date FROM sal.deliveries WHERE order_id = $1 ORDER BY date, no', [id]);
  const invoices = await many(tx, `SELECT id, no, status, gross_total FROM fin.invoices WHERE source_type = 'sal.order' AND source_id = $1 ORDER BY date`, [id]);
  return { ...o, lines, deliveries, invoices };
}

export async function listOrders(tx: Tx, ctx: Ctx, companyId: string, status?: string) {
  await authorize(tx, ctx, 'sal.order.manage', { unitId: companyId });
  return many(tx, `SELECT o.id, o.quote_no, o.no, o.date, o.status, o.currency, o.gross_total, p.name AS customer_name FROM sal.orders o
                     JOIN mdm.parties p ON p.id = o.customer_id WHERE o.company_id = $1 AND ($2::text IS NULL OR o.status = $2)
                    ORDER BY o.date DESC, o.quote_no DESC`, [companyId, status ?? null]);
}

/** Ship goods. Without lines it delivers everything still open on stock lines. */
export async function deliver(tx: Tx, ctx: Ctx, orderId: string, input: { date: string; lines?: { orderLineId: string; quantity: number }[] }) {
  const o = await one(tx, 'SELECT * FROM sal.orders WHERE id = $1 FOR UPDATE', [orderId]);
  if (!o) throw new NotFoundError('sales order');
  await authorize(tx, ctx, 'sal.deliver', { unitId: o.selling_unit_id ?? o.company_id });
  if (o.status !== 'confirmed') throw new ConflictError(`only confirmed orders can be delivered (this one is ${o.status})`);
  const all = await many(tx, `${LINE_PROGRESS} WHERE l.order_id = $1 ORDER BY l.line_no`, [orderId]);
  const wanted = input.lines ?? all.filter((l) => l.item_type === 'stock')
    .map((l) => ({ orderLineId: l.id, quantity: Number(l.quantity) - l.delivered_qty })).filter((l) => l.quantity > 1e-9);
  if (!wanted.length) throw new ValidationError('nothing left to deliver');
  const lines = [];
  for (const w of wanted) {
    const l = all.find((x) => x.id === w.orderLineId);
    if (!l) throw new ValidationError('the line is not on this order');
    if (l.item_type !== 'stock') throw new ValidationError(`line ${l.line_no} is not a stock item; services are invoiced directly`);
    if (!(w.quantity > 0) || l.delivered_qty + w.quantity > Number(l.quantity) + 1e-9) {
      throw new ValidationError(`line ${l.line_no}: ${w.quantity} would exceed the ${Number(l.quantity)} ordered (${l.delivered_qty} already delivered)`);
    }
    lines.push({ ...w, line: l, cost: await issueCost(tx, o.warehouse_id, l.item_id, w.quantity) });
  }
  const no = await nextNumber(tx, o.company_id, 'sal_delivery', 'DN', input.date);
  const d = await one(tx, `INSERT INTO sal.deliveries (tenant_id, company_id, order_id, no, date, warehouse_id, created_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6) RETURNING *`, [o.company_id, orderId, no, input.date, o.warehouse_id, ctx.userId]);
  const cost = roundMoney(lines.reduce((s, l) => s + l.cost, 0));
  let journalId: string | null = null;
  if (cost > 0) {
    const j = await post(tx, ctx, { companyId: o.company_id, type: 'delivery', date: input.date, memo: `${no} – ${o.no}`,
      source: { type: 'sal.delivery', id: d.id },
      lines: [{ account: 'role:cogs', debit: cost, unitId: o.selling_unit_id }, { account: 'role:inventory', credit: cost }] });
    journalId = j.id;
    await tx.query('UPDATE sal.deliveries SET journal_id = $2 WHERE id = $1', [d.id, journalId]);
  }
  for (const l of lines) {
    await tx.query(`INSERT INTO sal.delivery_lines (tenant_id, delivery_id, order_line_id, quantity, cost) VALUES (app.tenant(), $1, $2, $3, $4)`,
      [d.id, l.orderLineId, l.quantity, l.cost]);
    await applyMove(tx, ctx, { companyId: o.company_id, warehouseId: o.warehouse_id, itemId: l.line.item_id, date: input.date,
      kind: 'delivery', qty: -l.quantity, value: -l.cost, source: { type: 'sal.delivery', id: d.id }, journalId });
  }
  return { ...d, journal_id: journalId, cost };
}

/** Draft the invoice for what was delivered (goods) or ordered (services) and not invoiced yet. */
export async function invoiceOrder(tx: Tx, ctx: Ctx, orderId: string, input: { date: string }) {
  const o = await one(tx, 'SELECT * FROM sal.orders WHERE id = $1 FOR UPDATE', [orderId]);
  if (!o) throw new NotFoundError('sales order');
  await authorize(tx, ctx, 'fin.invoice.manage', { unitId: o.company_id });
  if (o.status !== 'confirmed' && o.status !== 'closed') throw new ConflictError(`order is ${o.status}`);
  const all = await many(tx, `${LINE_PROGRESS} WHERE l.order_id = $1 ORDER BY l.line_no`, [orderId]);
  const lines = all.map((l) => {
    const billable = (l.item_type === 'stock' ? l.delivered_qty : Number(l.quantity)) - l.invoiced_qty;
    if (billable <= 1e-9) return null;
    const discount = roundIn(o.currency, Number(l.discount) * billable / Number(l.quantity));
    return { itemId: l.item_id ?? undefined, description: l.description, quantity: billable, unitPrice: Number(l.unit_price), discount,
      taxCode: l.tax_code, account: l.account ?? undefined, unitId: o.selling_unit_id ?? undefined, sourceLineId: l.id };
  }).filter((l) => l !== null);
  if (!lines.length) throw new ValidationError('nothing to invoice: deliver the goods first, or everything is invoiced already');
  return createInvoice(tx, ctx, { companyId: o.company_id, kind: 'sales_invoice', partyId: o.customer_id, date: input.date,
    currency: o.currency, fxRate: Number(o.fx_rate), lines, source: { type: 'sal.order', id: orderId }, notes: `Order ${o.no}` });
}

export async function cancelOrder(tx: Tx, ctx: Ctx, orderId: string) {
  const o = await one(tx, 'SELECT * FROM sal.orders WHERE id = $1 FOR UPDATE', [orderId]);
  if (!o) throw new NotFoundError('sales order');
  await authorize(tx, ctx, 'sal.order.manage', { unitId: o.selling_unit_id ?? o.company_id });
  if (['cancelled', 'closed'].includes(o.status)) throw new ConflictError(`the order is already ${o.status}`);
  const done = await one(tx, `SELECT 1 FROM sal.deliveries WHERE order_id = $1 UNION ALL
                               SELECT 1 FROM fin.invoices WHERE source_type = 'sal.order' AND source_id = $1 AND status <> 'void' LIMIT 1`, [orderId]);
  const status = done ? 'closed' : 'cancelled';
  await tx.query('UPDATE sal.orders SET status = $2 WHERE id = $1', [orderId, status]);
  return getOrder(tx, ctx, orderId);
}
