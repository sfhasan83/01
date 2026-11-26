import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';
import { nextNumber } from '../fin/ledger.ts';
import { adjustStock, warehouse, stockItem } from '../inv/service.ts';
import { createInvoice } from '../fin/documents.ts';
import { createAction } from './grc.ts';

/**
 * Quality. Goods are inspected on receipt from suppliers, after production, or
 * in stock; rejected quantities raise a non-conformance report (NCR) straight
 * away. The NCR's disposition is carried out in the books:
 *   scrap               stock written off at average cost (Dr 5070 | Cr 1300)
 *   return to supplier  the goods leave stock the same way, and a purchase credit
 *                       note is drafted against the supplier's bill at the billed
 *                       price, crediting 5070, so the claim offsets the write-off
 *   rework, use as is   no stock movement
 * Corrective actions go to the shared action list; an NCR closes once it has a
 * disposition and its actions are verified.
 */


export async function inspect(tx: Tx, ctx: Ctx, input: { companyId: string; sourceType: 'pur.receipt' | 'mfg.work_order' | 'inv.stock'; sourceId?: string;
  itemId: string; warehouseId: string; inspectedOn: string; qtyInspected: number; qtyRejected?: number; notes?: string }) {
  await authorize(tx, ctx, 'qms.manage', { unitId: input.companyId });
  await warehouse(tx, input.companyId, input.warehouseId);
  await stockItem(tx, input.itemId);
  let supplierId: string | null = null;
  if (input.sourceType === 'pur.receipt') {
    const r = await one(tx, `SELECT o.supplier_id, r.company_id FROM pur.receipts r JOIN pur.orders o ON o.id = r.order_id
                              JOIN pur.receipt_lines rl ON rl.receipt_id = r.id JOIN pur.order_lines ol ON ol.id = rl.order_line_id
                             WHERE r.id = $1 AND ol.item_id = $2 LIMIT 1`, [input.sourceId, input.itemId]);
    if (!r || r.company_id !== input.companyId) throw new ValidationError('the receipt does not hold this item');
    supplierId = r.supplier_id;
  } else if (input.sourceType === 'mfg.work_order') {
    const w = await one(tx, 'SELECT item_id, company_id, status FROM mfg.work_orders WHERE id = $1', [input.sourceId]);
    if (!w || w.company_id !== input.companyId || w.item_id !== input.itemId) throw new ValidationError('the work order did not make this item');
  }
  const rejected = input.qtyRejected ?? 0;
  if (rejected > input.qtyInspected) throw new ValidationError('more rejected than inspected');
  const insp = await one(tx, `INSERT INTO qms.inspections (tenant_id, company_id, source_type, source_id, item_id, warehouse_id, supplier_id, inspected_on,
                                qty_inspected, qty_rejected, result, notes, inspector_user_id)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [input.companyId, input.sourceType, input.sourceId ?? null, input.itemId, input.warehouseId, supplierId, input.inspectedOn, input.qtyInspected, rejected,
      rejected > 0 ? 'fail' : 'pass', input.notes ?? null, ctx.userId]);
  let ncr = null;
  if (rejected > 0) {
    ncr = await raiseNcr(tx, ctx, { companyId: input.companyId, inspectionId: insp.id, itemId: input.itemId, warehouseId: input.warehouseId, supplierId: supplierId ?? undefined,
      qty: rejected, severity: rejected / input.qtyInspected > 0.1 ? 'major' : 'minor', description: input.notes ?? `${rejected} of ${input.qtyInspected} rejected at inspection`, date: input.inspectedOn });
  }
  return { inspection: insp, ncr };
}

export async function raiseNcr(tx: Tx, ctx: Ctx, input: { companyId: string; inspectionId?: string; itemId?: string; warehouseId?: string; supplierId?: string;
  qty?: number; severity: string; description: string; date: string }) {
  await authorize(tx, ctx, 'qms.manage', { unitId: input.companyId });
  const no = await nextNumber(tx, input.companyId, 'qms.ncr', 'NCR', input.date);
  return one(tx, `INSERT INTO qms.ncrs (tenant_id, company_id, no, inspection_id, item_id, warehouse_id, supplier_id, qty, severity, description, raised_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [input.companyId, no, input.inspectionId ?? null, input.itemId ?? null, input.warehouseId ?? null, input.supplierId ?? null, input.qty ?? 0,
      input.severity, input.description, ctx.userId]);
}

export async function dispositionNcr(tx: Tx, ctx: Ctx, id: string, input: { disposition: 'use_as_is' | 'rework' | 'return_to_supplier' | 'scrap'; rootCause: string; date: string;
  actions?: { title: string; ownerEmployeeId: string; dueDate: string }[] }) {
  const n = await one(tx, 'SELECT * FROM qms.ncrs WHERE id = $1 FOR UPDATE', [id]);
  if (!n) throw new NotFoundError('non-conformance');
  await authorize(tx, ctx, 'qms.manage', { unitId: n.company_id });
  if (n.status !== 'open') throw new ConflictError(`the NCR is already ${n.status}`);
  if (!input.rootCause?.trim()) throw new ValidationError('record the root cause');
  let journalId: string | null = null, creditNote = null;
  if (['scrap', 'return_to_supplier'].includes(input.disposition)) {
    if (!n.item_id || !n.warehouse_id || !(Number(n.qty) > 0)) throw new ValidationError('the NCR has no stock quantity to take out');
    let bill = null;
    if (input.disposition === 'return_to_supplier') {
      if (!n.supplier_id) throw new ValidationError('the NCR has no supplier to return to');
      bill = await one(tx, `SELECT i.id, i.currency, i.fx_rate, l.unit_price, t.code AS tax_code FROM fin.invoices i
                               JOIN fin.invoice_lines l ON l.invoice_id = i.id JOIN fin.tax_codes t ON t.id = l.tax_code_id
                              WHERE i.company_id = $1 AND i.party_id = $2 AND i.kind = 'purchase_invoice' AND i.status = 'posted' AND l.item_id = $3
                              ORDER BY i.date DESC LIMIT 1`, [n.company_id, n.supplier_id, n.item_id]);
      if (!bill) throw new ValidationError('there is no posted bill from this supplier for the item to claim against: bill the order first');
    }
    const adj = await adjustStock(tx, ctx, { companyId: n.company_id, warehouseId: n.warehouse_id, itemId: n.item_id, date: input.date, qty: -Number(n.qty),
      reason: `${n.no} ${input.disposition === 'scrap' ? 'scrapped' : 'returned to supplier'}` });
    journalId = adj.journalId;
    if (bill) {
      creditNote = await createInvoice(tx, ctx, { companyId: n.company_id, kind: 'purchase_credit', partyId: n.supplier_id, date: input.date, creditOf: bill.id,
        currency: bill.currency, fxRate: Number(bill.fx_rate), supplierRef: n.no, notes: `Return under ${n.no}`,
        lines: [{ itemId: n.item_id, description: `Returned: ${n.description}`, quantity: Number(n.qty), unitPrice: Number(bill.unit_price), taxCode: bill.tax_code, account: 'role:inventory_adjustments' }],
        source: { type: 'qms.ncr', id } });
    }
  }
  await tx.query(`UPDATE qms.ncrs SET disposition = $2, root_cause = $3, disposition_journal_id = $4, status = 'dispositioned' WHERE id = $1`,
    [id, input.disposition, input.rootCause, journalId]);
  for (const a of input.actions ?? []) await createAction(tx, ctx, { sourceType: 'qms.ncr', sourceId: id, unitId: n.company_id, ...a });
  return { ...(await getNcr(tx, ctx, id)), creditNote };
}

export async function closeNcr(tx: Tx, ctx: Ctx, id: string) {
  const n = await one(tx, 'SELECT * FROM qms.ncrs WHERE id = $1 FOR UPDATE', [id]);
  if (!n) throw new NotFoundError('non-conformance');
  await authorize(tx, ctx, 'qms.manage', { unitId: n.company_id });
  if (n.status !== 'dispositioned') throw new ConflictError('decide the disposition first');
  const open = await one(tx, `SELECT count(*)::int AS n FROM grc.actions WHERE source_type = 'qms.ncr' AND source_id = $1 AND status <> 'verified'`, [id]);
  if (open.n) throw new ConflictError(`${open.n} corrective actions are not verified yet`);
  await tx.query(`UPDATE qms.ncrs SET status = 'closed' WHERE id = $1`, [id]);
  return getNcr(tx, ctx, id);
}

export async function getNcr(tx: Tx, ctx: Ctx, id: string) {
  const n = await one(tx, `SELECT n.*, i.code AS item_code, p.name AS supplier_name, j.no AS journal_no FROM qms.ncrs n LEFT JOIN mdm.items i ON i.id = n.item_id
                             LEFT JOIN mdm.parties p ON p.id = n.supplier_id LEFT JOIN fin.journals j ON j.id = n.disposition_journal_id WHERE n.id = $1`, [id]);
  if (!n) throw new NotFoundError('non-conformance');
  await authorize(tx, ctx, 'qms.manage', { unitId: n.company_id });
  n.actions = await many(tx, `SELECT * FROM grc.actions WHERE source_type = 'qms.ncr' AND source_id = $1 ORDER BY due_date`, [id]);
  return n;
}

export async function listNcrs(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'qms.manage', { unitId: companyId });
  return many(tx, `SELECT n.*, i.code AS item_code, p.name AS supplier_name,
      (SELECT count(*)::int FROM grc.actions a WHERE a.source_type = 'qms.ncr' AND a.source_id = n.id AND a.status <> 'verified') AS open_actions
    FROM qms.ncrs n LEFT JOIN mdm.items i ON i.id = n.item_id LEFT JOIN mdm.parties p ON p.id = n.supplier_id
   WHERE n.company_id = $1 ORDER BY n.status = 'closed', n.no DESC`, [companyId]);
}

export async function listInspections(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'qms.manage', { unitId: companyId });
  return many(tx, `SELECT x.*, i.code AS item_code, p.name AS supplier_name FROM qms.inspections x JOIN mdm.items i ON i.id = x.item_id
                    LEFT JOIN mdm.parties p ON p.id = x.supplier_id WHERE x.company_id = $1 ORDER BY x.inspected_on DESC LIMIT 300`, [companyId]);
}

/** Supplier quality: inspected and rejected quantities, the rejection rate and NCRs per supplier. */
export async function supplierQuality(tx: Tx, ctx: Ctx, companyId: string, from: string, to: string) {
  await authorize(tx, ctx, 'qms.manage', { unitId: companyId });
  return (await many(tx, `SELECT p.id AS supplier_id, p.code, p.name, sum(x.qty_inspected)::float AS inspected, sum(x.qty_rejected)::float AS rejected,
        count(*) FILTER (WHERE x.result = 'fail')::int AS failed_lots, count(*)::int AS lots,
        (SELECT count(*)::int FROM qms.ncrs n WHERE n.supplier_id = p.id AND n.company_id = $1) AS ncrs
      FROM qms.inspections x JOIN mdm.parties p ON p.id = x.supplier_id
     WHERE x.company_id = $1 AND x.inspected_on BETWEEN $2 AND $3 GROUP BY p.id, p.code, p.name ORDER BY p.name`, [companyId, from, to]))
    .map((r) => ({ ...r, rejectionPct: r.inspected ? Math.round(r.rejected / r.inspected * 10000) / 100 : 0 }));
}

/** Recent goods receipt lines for stock items, newest first: what is waiting to be inspected, with what has been inspected so far. */
export async function receiptsToInspect(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'qms.manage', { unitId: companyId });
  return many(tx, `SELECT r.id AS receipt_id, r.no AS receipt_no, r.date, p.name AS supplier_name, i.id AS item_id, i.code AS item_code, i.name AS item_name,
        sum(rl.quantity)::float AS qty_received, coalesce(r.warehouse_id, o.warehouse_id) AS warehouse_id,
        coalesce((SELECT sum(x.qty_inspected) FROM qms.inspections x WHERE x.source_type = 'pur.receipt' AND x.source_id = r.id AND x.item_id = i.id), 0)::float AS qty_inspected
      FROM pur.receipts r JOIN pur.orders o ON o.id = r.order_id JOIN mdm.parties p ON p.id = o.supplier_id
      JOIN pur.receipt_lines rl ON rl.receipt_id = r.id JOIN pur.order_lines ol ON ol.id = rl.order_line_id JOIN mdm.items i ON i.id = ol.item_id
     WHERE r.company_id = $1 AND i.item_type = 'stock'
     GROUP BY r.id, r.no, r.date, p.name, i.id, i.code, i.name, r.warehouse_id, o.warehouse_id ORDER BY r.date DESC, r.no DESC LIMIT 100`, [companyId]);
}
