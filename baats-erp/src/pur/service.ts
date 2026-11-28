import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';
import { insertDefinition, onWorkflowComplete, submit } from '../workflow/engine.ts';
import { company, nextNumber, post, roundMoney } from '../fin/ledger.ts';
import { priceLines } from '../fin/pricing.ts';
import { ensureRoleAccount } from '../fin/setup.ts';
import { createInvoice } from '../fin/documents.ts';
import { applyMove, warehouse } from '../inv/service.ts';

/**
 * Procure to pay:
 *   purchase order  -> approved through the workflow engine (amount limits on pur.order.approve)
 *   goods receipt   -> stock lines: Dr 1300 Inventory | Cr 2010 GRNI, and the stock moves in
 *   supplier bill   -> a purchase invoice drafted from the order; stock lines debit 2010 GRNI,
 *                      service lines their expense account; then posted in finance as usual
 * Three-way match: a bill can only take quantities that were ordered and received and not
 * billed yet, at the order price. Service lines are received too (confirmation of service).
 */

export const PO_WORKFLOW = 'pur.order.approval';

export interface OrderLineInput {
  itemId?: string; description: string; quantity: number; unitPrice: number; taxCode: string; account?: string; unitId?: string;
}
export interface OrderInput {
  companyId: string; supplierId: string; date: string; expectedDate?: string; currency?: string; fxRate?: number;
  warehouseId?: string; requestingUnitId?: string; notes?: string; lines: OrderLineInput[];
}

async function ensureWorkflow(tx: Tx) {
  if (!(await one(tx, 'SELECT 1 FROM iam.roles WHERE code = $1', ['PROCUREMENT_MANAGER']))) {
    await tx.query(`INSERT INTO iam.roles (tenant_id, code, name, is_system) VALUES (app.tenant(), 'PROCUREMENT_MANAGER', 'Procurement manager', true)`);
  }
  if (!(await one(tx, 'SELECT 1 FROM wf.definitions WHERE code = $1', [PO_WORKFLOW]))) {
    await insertDefinition(tx, {
      code: PO_WORKFLOW, name: 'Purchase order approval', entityType: 'pur.order',
      definition: { approvalPermission: 'pur.order.approve', steps: [{ key: 'procurement', name: 'Procurement approval',
        approvers: [{ type: 'role', role: 'PROCUREMENT_MANAGER' }, { type: 'role', role: 'TENANT_ADMIN' }] }] },
    });
  }
}

async function activeSupplier(tx: Tx, id: string) {
  const p = await one(tx, 'SELECT * FROM mdm.parties WHERE id = $1', [id]);
  if (!p || !p.is_supplier) throw new ValidationError('unknown supplier');
  if (p.status !== 'active') throw new ValidationError(`${p.name} is ${p.status}; only approved, active suppliers can be ordered from`);
  return p;
}

export async function createOrder(tx: Tx, ctx: Ctx, input: OrderInput) {
  await authorize(tx, ctx, 'pur.order.manage', { unitId: input.companyId });
  const c = await company(tx, input.companyId);
  const supplier = await activeSupplier(tx, input.supplierId);
  if (!input.lines?.length) throw new ValidationError('an order needs at least one line');
  const currency = input.currency ?? supplier.currency_code;
  const fx = currency === c.base_currency ? 1 : input.fxRate;
  if (!fx) throw new ValidationError(`an exchange rate to ${c.base_currency} is needed for ${currency}`);
  const items = await Promise.all(input.lines.map((l) => (l.itemId ? one(tx, 'SELECT * FROM mdm.items WHERE id = $1', [l.itemId]) : null)));
  if (items.some((i, n) => input.lines[n].itemId && !i)) throw new ValidationError('unknown item');
  if (items.some((i) => i?.item_type === 'stock')) {
    if (!input.warehouseId) throw new ValidationError('choose the warehouse that will receive the stock items');
    await warehouse(tx, input.companyId, input.warehouseId);
  }
  const priced = await priceLines(tx, c.country_code, currency, input.lines);
  const order = await one(tx, `INSERT INTO pur.orders (tenant_id, company_id, supplier_id, date, expected_date, currency, fx_rate, warehouse_id,
      requesting_unit_id, notes, net_total, tax_total, gross_total, created_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
    [input.companyId, input.supplierId, input.date, input.expectedDate ?? null, currency, fx, input.warehouseId ?? null,
      input.requestingUnitId ?? null, input.notes ?? null, priced.net, priced.tax, priced.gross, ctx.userId]);
  for (const [i, l] of input.lines.entries()) {
    await tx.query(`INSERT INTO pur.order_lines (tenant_id, order_id, line_no, item_id, description, quantity, unit_price, tax_code, account, unit_id, net_amount)
      VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [order.id, i + 1, l.itemId ?? null, l.description, l.quantity, l.unitPrice, l.taxCode, l.account ?? null, l.unitId ?? input.requestingUnitId ?? null, priced.lines[i].net]);
  }
  return getOrder(tx, ctx, order.id);
}

export async function submitOrder(tx: Tx, ctx: Ctx, orderId: string) {
  const o = await one(tx, 'SELECT * FROM pur.orders WHERE id = $1 FOR UPDATE', [orderId]);
  if (!o) throw new NotFoundError('purchase order');
  await authorize(tx, ctx, 'pur.order.manage', { unitId: o.company_id });
  if (o.status !== 'draft' && o.status !== 'rejected') throw new ConflictError(`the order is already ${o.status}`);
  await activeSupplier(tx, o.supplier_id);
  await ensureWorkflow(tx);
  const no = o.no ?? await nextNumber(tx, o.company_id, 'pur_order', 'PO', o.date.toISOString().slice(0, 10));
  await tx.query(`UPDATE pur.orders SET status = 'pending_approval', no = $2 WHERE id = $1`, [orderId, no]);
  const inst = await submit(tx, ctx, { code: PO_WORKFLOW, entityType: 'pur.order', entityId: orderId, subjectUnitId: o.company_id,
    payload: { amount: roundMoney(Number(o.gross_total) * Number(o.fx_rate)), currency: o.currency, no } });
  return { ...(await getOrder(tx, ctx, orderId)), workflowInstanceId: inst.id };
}

onWorkflowComplete('pur.order', async (tx, inst) => {
  await tx.query(`UPDATE pur.orders SET status = $2 WHERE id = $1 AND status = 'pending_approval'`,
    [inst.entity_id, inst.status === 'approved' ? 'approved' : 'rejected']);
});

const LINE_PROGRESS = `
  SELECT l.*, i.code AS item_code, i.item_type,
         coalesce((SELECT sum(r.quantity) FROM pur.receipt_lines r WHERE r.order_line_id = l.id), 0)::float AS received_qty,
         coalesce((SELECT sum(b.quantity) FROM fin.invoice_lines b JOIN fin.invoices v ON v.id = b.invoice_id
                    WHERE b.source_line_id = l.id AND v.status <> 'void'), 0)::float AS billed_qty
    FROM pur.order_lines l LEFT JOIN mdm.items i ON i.id = l.item_id`;

export async function getOrder(tx: Tx, ctx: Ctx, id: string) {
  const o = await one(tx, `SELECT o.*, p.name AS supplier_name, w.code AS warehouse_code FROM pur.orders o
                             JOIN mdm.parties p ON p.id = o.supplier_id LEFT JOIN inv.warehouses w ON w.id = o.warehouse_id WHERE o.id = $1`, [id]);
  if (!o) throw new NotFoundError('purchase order');
  await authorize(tx, ctx, 'pur.order.manage', { unitId: o.company_id });
  const lines = await many(tx, `${LINE_PROGRESS} WHERE l.order_id = $1 ORDER BY l.line_no`, [id]);
  const receipts = await many(tx, 'SELECT id, no, date, delivery_note FROM pur.receipts WHERE order_id = $1 ORDER BY date, no', [id]);
  const bills = await many(tx, `SELECT id, no, supplier_ref, status, gross_total FROM fin.invoices WHERE source_type = 'pur.order' AND source_id = $1 ORDER BY date`, [id]);
  return { ...o, lines, receipts, bills };
}

export async function listOrders(tx: Tx, ctx: Ctx, companyId: string, status?: string) {
  await authorize(tx, ctx, 'pur.order.manage', { unitId: companyId });
  return many(tx, `SELECT o.id, o.no, o.date, o.status, o.currency, o.gross_total, p.name AS supplier_name FROM pur.orders o
                     JOIN mdm.parties p ON p.id = o.supplier_id WHERE o.company_id = $1 AND ($2::text IS NULL OR o.status = $2)
                    ORDER BY o.date DESC, o.no DESC NULLS FIRST`, [companyId, status ?? null]);
}

/** Record goods (or services) received. Stock lines go into the warehouse at the order price. */
export async function receive(tx: Tx, ctx: Ctx, orderId: string, input: { date: string; deliveryNote?: string; lines: { orderLineId: string; quantity: number }[] }) {
  const o = await one(tx, 'SELECT * FROM pur.orders WHERE id = $1 FOR UPDATE', [orderId]);
  if (!o) throw new NotFoundError('purchase order');
  await authorize(tx, ctx, 'pur.receive', { unitId: o.company_id });
  if (o.status !== 'approved') throw new ConflictError(`only approved orders can be received (this one is ${o.status})`);
  if (!input.lines.length) throw new ValidationError('nothing to receive');
  const fx = Number(o.fx_rate);
  const lines = [];
  for (const r of input.lines) {
    const l = await one(tx, `${LINE_PROGRESS} WHERE l.id = $1 AND l.order_id = $2`, [r.orderLineId, orderId]);
    if (!l) throw new ValidationError('the line is not on this order');
    if (!(r.quantity > 0)) throw new ValidationError('received quantities must be positive');
    if (l.received_qty + r.quantity > Number(l.quantity) + 1e-9) {
      throw new ValidationError(`line ${l.line_no}: receiving ${r.quantity} would exceed the ${Number(l.quantity)} ordered (${l.received_qty} already received)`);
    }
    const stock = l.item_type === 'stock';
    lines.push({ ...r, line: l, stock, value: stock ? roundMoney(r.quantity * Number(l.unit_price) * fx) : 0 });
  }
  const no = await nextNumber(tx, o.company_id, 'pur_receipt', 'GRN', input.date);
  const rec = await one(tx, `INSERT INTO pur.receipts (tenant_id, company_id, order_id, no, date, warehouse_id, delivery_note, created_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [o.company_id, orderId, no, input.date, o.warehouse_id, input.deliveryNote ?? null, ctx.userId]);
  const stockValue = roundMoney(lines.reduce((s, l) => s + l.value, 0));
  let journalId: string | null = null;
  if (stockValue > 0) {
    await ensureRoleAccount(tx, o.company_id, 'grni');
    const j = await post(tx, ctx, { companyId: o.company_id, type: 'goods_receipt', date: input.date, memo: `${no} – ${o.no}`,
      source: { type: 'pur.receipt', id: rec.id },
      lines: [{ account: 'role:inventory', debit: stockValue }, { account: 'role:grni', credit: stockValue }] });
    journalId = j.id;
    await tx.query('UPDATE pur.receipts SET journal_id = $2 WHERE id = $1', [rec.id, journalId]);
  }
  for (const l of lines) {
    await tx.query(`INSERT INTO pur.receipt_lines (tenant_id, receipt_id, order_line_id, quantity, value) VALUES (app.tenant(), $1, $2, $3, $4)`,
      [rec.id, l.orderLineId, l.quantity, l.value]);
    if (l.stock) {
      await applyMove(tx, ctx, { companyId: o.company_id, warehouseId: o.warehouse_id, itemId: l.line.item_id, date: input.date,
        kind: 'receipt', qty: l.quantity, value: l.value, source: { type: 'pur.receipt', id: rec.id }, journalId });
    }
  }
  return { ...rec, journal_id: journalId, value: stockValue };
}

/**
 * Draft the supplier's bill from the order (three-way match). Without lines it bills
 * everything received and not billed yet. Post it with the usual invoice posting.
 */
export async function billOrder(tx: Tx, ctx: Ctx, orderId: string, input: { date: string; supplierRef: string; dueDate?: string; lines?: { orderLineId: string; quantity: number }[] }) {
  const o = await one(tx, 'SELECT * FROM pur.orders WHERE id = $1 FOR UPDATE', [orderId]);
  if (!o) throw new NotFoundError('purchase order');
  await authorize(tx, ctx, 'fin.invoice.manage', { unitId: o.company_id });
  if (o.status !== 'approved' && o.status !== 'closed') throw new ConflictError(`order ${o.no ?? ''} is ${o.status}`);
  const all = await many(tx, `${LINE_PROGRESS} WHERE l.order_id = $1 ORDER BY l.line_no`, [orderId]);
  const wanted = input.lines ?? all.map((l) => ({ orderLineId: l.id, quantity: round4(l.received_qty - l.billed_qty) })).filter((l) => l.quantity > 0);
  if (!wanted.length) throw new ValidationError('nothing has been received that is not billed yet');
  await ensureRoleAccount(tx, o.company_id, 'grni');
  const lines = wanted.map((w) => {
    const l = all.find((x) => x.id === w.orderLineId);
    if (!l) throw new ValidationError('the line is not on this order');
    const open = round4(l.received_qty - l.billed_qty);
    if (w.quantity > open + 1e-9) {
      throw new ValidationError(`line ${l.line_no}: three-way match fails, ${w.quantity} billed but only ${open} received and not yet billed`);
    }
    return {
      itemId: l.item_id ?? undefined, description: l.description, quantity: w.quantity, unitPrice: Number(l.unit_price), taxCode: l.tax_code,
      account: l.item_type === 'stock' ? 'role:grni' : (l.account ?? undefined), unitId: l.unit_id ?? undefined, sourceLineId: l.id,
    };
  });
  return createInvoice(tx, ctx, { companyId: o.company_id, kind: 'purchase_invoice', partyId: o.supplier_id, date: input.date,
    dueDate: input.dueDate, currency: o.currency, fxRate: Number(o.fx_rate), supplierRef: input.supplierRef, lines,
    source: { type: 'pur.order', id: orderId }, notes: `Bill for ${o.no}` });
}

/** Close an order that will not be received in full; cancel one that has nothing received. */
export async function closeOrder(tx: Tx, ctx: Ctx, orderId: string) {
  const o = await one(tx, 'SELECT * FROM pur.orders WHERE id = $1 FOR UPDATE', [orderId]);
  if (!o) throw new NotFoundError('purchase order');
  await authorize(tx, ctx, 'pur.order.manage', { unitId: o.company_id });
  const received = await one(tx, 'SELECT 1 FROM pur.receipts WHERE order_id = $1 LIMIT 1', [orderId]);
  const status = received ? 'closed' : 'cancelled';
  if (['closed', 'cancelled'].includes(o.status)) throw new ConflictError(`the order is already ${o.status}`);
  if (o.status === 'pending_approval') throw new ConflictError('withdraw the approval request first');
  await tx.query('UPDATE pur.orders SET status = $2 WHERE id = $1', [orderId, status]);
  return getOrder(tx, ctx, orderId);
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
