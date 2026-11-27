import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';
import { company, post, roundMoney, type PostingLine } from '../fin/ledger.ts';

/**
 * Inventory: perpetual stock at moving average cost, per warehouse.
 * Posting rules (BAATS Accounting 1300 / 5050 / 5070):
 *   opening stock    Dr 1300 Inventory          | Cr 3200 Opening balance equity
 *   goods receipt    Dr 1300 Inventory          | Cr 2010 Goods received not invoiced  (procurement)
 *   delivery         Dr 5050 Cost of goods sold | Cr 1300 Inventory                   (sales)
 *   adjustment       1300 against 5070 Inventory adjustments, either way
 *   transfer         no ledger effect (same company), cost moves with the goods
 * The stock value in inv.stock always equals the 1300 balance; valuation() checks it.
 */

export interface MoveInput {
  companyId: string; warehouseId: string; itemId: string; date: string;
  kind: 'opening' | 'receipt' | 'delivery' | 'adjustment' | 'transfer_in' | 'transfer_out' | 'production_issue' | 'production_receipt' | 'maintenance_issue';
  qty: number; value: number; source?: { type: string; id: string }; journalId?: string | null; reason?: string;
}

export async function stockItem(tx: Tx, itemId: string) {
  const item = await one(tx, 'SELECT * FROM mdm.items WHERE id = $1', [itemId]);
  if (!item) throw new ValidationError('unknown item');
  if (item.item_type !== 'stock') throw new ValidationError(`${item.code} is not a stock item`);
  if (item.status !== 'active') throw new ValidationError(`${item.code} is ${item.status}`);
  return item;
}

export async function warehouse(tx: Tx, companyId: string, warehouseId: string) {
  const w = await one(tx, 'SELECT * FROM inv.warehouses WHERE id = $1', [warehouseId]);
  if (!w || w.company_id !== companyId) throw new ValidationError('the warehouse does not belong to this company');
  if (w.status !== 'active') throw new ValidationError(`warehouse ${w.code} is blocked`);
  return w;
}

/** Cost of taking qty out at the current moving average; locks the balance row. */
export async function issueCost(tx: Tx, warehouseId: string, itemId: string, qty: number): Promise<number> {
  const s = await one(tx, 'SELECT qty, value FROM inv.stock WHERE warehouse_id = $1 AND item_id = $2 FOR UPDATE', [warehouseId, itemId]);
  const onHand = Number(s?.qty ?? 0);
  if (onHand + 1e-9 < qty) {
    const item = await one(tx, 'SELECT code FROM mdm.items WHERE id = $1', [itemId]);
    throw new ValidationError(`not enough ${item?.code ?? 'stock'} in the warehouse: ${onHand} on hand, ${qty} needed`);
  }
  // Taking the last unit takes the remaining value, so no rounding residue stays behind.
  return Math.abs(onHand - qty) < 1e-9 ? Number(s.value) : roundMoney(Number(s.value) * qty / onHand);
}

/** Record a movement and update the balance. qty and value carry their sign. */
export async function applyMove(tx: Tx, ctx: Ctx, m: MoveInput): Promise<void> {
  await tx.query(`INSERT INTO inv.moves (tenant_id, company_id, warehouse_id, item_id, date, kind, qty, value, source_type, source_id, journal_id, reason, created_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [m.companyId, m.warehouseId, m.itemId, m.date, m.kind, m.qty, m.value, m.source?.type ?? null, m.source?.id ?? null,
      m.journalId ?? null, m.reason ?? null, ctx.userId]);
  // Update first: an INSERT ... ON CONFLICT would check the constraints on a negative "new" row.
  const r = await tx.query('UPDATE inv.stock SET qty = qty + $3, value = value + $4 WHERE warehouse_id = $1 AND item_id = $2',
    [m.warehouseId, m.itemId, m.qty, m.value]);
  if (r.rowCount === 0) {
    await tx.query('INSERT INTO inv.stock (tenant_id, warehouse_id, item_id, qty, value) VALUES (app.tenant(), $1, $2, $3, $4)',
      [m.warehouseId, m.itemId, m.qty, m.value]);
  }
}

export async function createWarehouse(tx: Tx, ctx: Ctx, input: { companyId: string; code: string; name: string; unitId?: string }) {
  await authorize(tx, ctx, 'inv.manage', { unitId: input.companyId });
  await company(tx, input.companyId);
  return one(tx, `INSERT INTO inv.warehouses (tenant_id, company_id, code, name, unit_id) VALUES (app.tenant(), $1, $2, $3, $4) RETURNING *`,
    [input.companyId, input.code, input.name, input.unitId ?? null]);
}

export async function listWarehouses(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'inv.read', { unitId: companyId });
  return many(tx, 'SELECT * FROM inv.warehouses WHERE company_id = $1 ORDER BY code', [companyId]);
}

/** Opening stock when a company starts using the inventory module. */
export async function openingStock(tx: Tx, ctx: Ctx, input: { companyId: string; warehouseId: string; date: string; lines: { itemId: string; qty: number; unitCost: number }[] }) {
  await authorize(tx, ctx, 'inv.manage', { unitId: input.companyId });
  await warehouse(tx, input.companyId, input.warehouseId);
  if (!input.lines.length) throw new ValidationError('no stock lines');
  const valued = [];
  for (const l of input.lines) {
    await stockItem(tx, l.itemId);
    if (!(l.qty > 0) || !(l.unitCost >= 0)) throw new ValidationError('opening quantities must be positive and costs not negative');
    valued.push({ ...l, value: roundMoney(l.qty * l.unitCost) });
  }
  const total = roundMoney(valued.reduce((s, l) => s + l.value, 0));
  const j = total > 0 ? await post(tx, ctx, {
    companyId: input.companyId, type: 'inventory', date: input.date, memo: 'Opening stock',
    lines: [{ account: 'role:inventory', debit: total }, { account: 'role:opening_balance_equity', credit: total }],
  }) : null;
  for (const l of valued) {
    await applyMove(tx, ctx, { companyId: input.companyId, warehouseId: input.warehouseId, itemId: l.itemId, date: input.date,
      kind: 'opening', qty: l.qty, value: l.value, journalId: j?.id, reason: 'Opening stock' });
  }
  return { journalId: j?.id ?? null, value: total };
}

/** Stock count differences, damage and write-offs. A positive qty needs a unit cost. */
export async function adjustStock(tx: Tx, ctx: Ctx, input: { companyId: string; warehouseId: string; itemId: string; date: string; qty: number; unitCost?: number; reason: string }) {
  await authorize(tx, ctx, 'inv.manage', { unitId: input.companyId });
  await warehouse(tx, input.companyId, input.warehouseId);
  const item = await stockItem(tx, input.itemId);
  if (!input.qty) throw new ValidationError('the adjustment quantity cannot be zero');
  let value: number;
  if (input.qty > 0) {
    const cur = await one(tx, 'SELECT qty, value FROM inv.stock WHERE warehouse_id = $1 AND item_id = $2', [input.warehouseId, input.itemId]);
    const avg = cur && Number(cur.qty) > 0 ? Number(cur.value) / Number(cur.qty) : undefined;
    const unitCost = input.unitCost ?? avg;
    if (unitCost === undefined) throw new ValidationError('give a unit cost: the item has no stock to take an average cost from');
    value = roundMoney(input.qty * unitCost);
  } else {
    value = -(await issueCost(tx, input.warehouseId, input.itemId, -input.qty));
  }
  const lines: PostingLine[] = value >= 0
    ? [{ account: 'role:inventory', debit: value }, { account: 'role:inventory_adjustments', credit: value }]
    : [{ account: 'role:inventory_adjustments', debit: -value }, { account: 'role:inventory', credit: -value }];
  const j = value !== 0 ? await post(tx, ctx, { companyId: input.companyId, type: 'inventory', date: input.date,
    memo: `Stock adjustment ${item.code}: ${input.reason}`, lines }) : null;
  await applyMove(tx, ctx, { companyId: input.companyId, warehouseId: input.warehouseId, itemId: input.itemId, date: input.date,
    kind: 'adjustment', qty: input.qty, value, journalId: j?.id, reason: input.reason });
  return { value, journalId: j?.id ?? null };
}

export async function transferStock(tx: Tx, ctx: Ctx, input: { companyId: string; fromWarehouseId: string; toWarehouseId: string; itemId: string; qty: number; date: string }) {
  await authorize(tx, ctx, 'inv.manage', { unitId: input.companyId });
  if (input.fromWarehouseId === input.toWarehouseId) throw new ValidationError('choose two different warehouses');
  await warehouse(tx, input.companyId, input.fromWarehouseId);
  await warehouse(tx, input.companyId, input.toWarehouseId);
  await stockItem(tx, input.itemId);
  if (!(input.qty > 0)) throw new ValidationError('the quantity must be positive');
  const value = await issueCost(tx, input.fromWarehouseId, input.itemId, input.qty);
  const ref = { type: 'transfer', id: crypto.randomUUID() };
  await applyMove(tx, ctx, { ...input, warehouseId: input.fromWarehouseId, kind: 'transfer_out', qty: -input.qty, value: -value, source: ref });
  await applyMove(tx, ctx, { ...input, warehouseId: input.toWarehouseId, kind: 'transfer_in', qty: input.qty, value, source: ref });
  return { value };
}

export async function stockLevels(tx: Tx, ctx: Ctx, companyId: string, warehouseId?: string) {
  await authorize(tx, ctx, 'inv.read', { unitId: companyId });
  return many(tx, `SELECT w.code AS warehouse, w.id AS warehouse_id, i.id AS item_id, i.code AS item_code, i.name AS item_name,
                          s.qty::float AS qty, s.value::float AS value,
                          CASE WHEN s.qty > 0 THEN round(s.value / s.qty, 4)::float ELSE 0 END AS average_cost,
                          (i.attributes->>'reorder_level')::float AS reorder_level
                     FROM inv.stock s JOIN inv.warehouses w ON w.id = s.warehouse_id JOIN mdm.items i ON i.id = s.item_id
                    WHERE w.company_id = $1 AND ($2::uuid IS NULL OR w.id = $2) AND (s.qty <> 0 OR s.value <> 0)
                    ORDER BY i.code, w.code`, [companyId, warehouseId ?? null]);
}

export async function itemMoves(tx: Tx, ctx: Ctx, companyId: string, itemId: string) {
  await authorize(tx, ctx, 'inv.read', { unitId: companyId });
  return many(tx, `SELECT m.date, m.kind, w.code AS warehouse, m.qty::float AS qty, m.value::float AS value, m.source_type, m.reason,
                          sum(m.qty) OVER (PARTITION BY m.warehouse_id ORDER BY m.date, m.created_at, m.id)::float AS balance_qty
                     FROM inv.moves m JOIN inv.warehouses w ON w.id = m.warehouse_id
                    WHERE m.company_id = $1 AND m.item_id = $2 ORDER BY m.date, m.created_at, m.id`, [companyId, itemId]);
}

/** Stock subledger against the 1300 Inventory control account: they must agree. */
export async function valuation(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'inv.read', { unitId: companyId });
  const sub = await one(tx, `SELECT coalesce(sum(s.value), 0)::float AS v FROM inv.stock s JOIN inv.warehouses w ON w.id = s.warehouse_id WHERE w.company_id = $1`, [companyId]);
  const gl = await one(tx, `SELECT coalesce(sum(l.debit - l.credit), 0)::float AS v FROM fin.journal_lines l
                              JOIN fin.journals j ON j.id = l.journal_id JOIN fin.accounts a ON a.id = l.account_id
                             WHERE j.company_id = $1 AND j.status = 'posted' AND a.system_role = 'inventory'`, [companyId]);
  return { stockValue: roundMoney(sub.v), ledgerBalance: roundMoney(gl.v), difference: roundMoney(sub.v - gl.v) };
}

export async function blockWarehouse(tx: Tx, ctx: Ctx, warehouseId: string) {
  const w = await one(tx, 'SELECT * FROM inv.warehouses WHERE id = $1', [warehouseId]);
  if (!w) throw new NotFoundError('warehouse');
  await authorize(tx, ctx, 'inv.manage', { unitId: w.company_id });
  const s = await one(tx, 'SELECT 1 FROM inv.stock WHERE warehouse_id = $1 AND qty > 0 LIMIT 1', [warehouseId]);
  if (s) throw new ConflictError('move or write off the stock before blocking the warehouse');
  return one(tx, `UPDATE inv.warehouses SET status = 'blocked' WHERE id = $1 RETURNING *`, [warehouseId]);
}
