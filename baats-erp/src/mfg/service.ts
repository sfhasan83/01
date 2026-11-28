import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';
import { company, nextNumber, post, roundMoney } from '../fin/ledger.ts';
import { ensureRoleAccount } from '../fin/setup.ts';
import { applyMove, issueCost, stockItem, warehouse } from '../inv/service.ts';

/**
 * Manufacturing: work centers, bills of materials with routing, work orders,
 * actual costing and MRP. Posting rules:
 *   material issue     Dr 1350 Work in progress | Cr 1300 Inventory         (at moving average)
 *   labour & overhead  Dr 1350 Work in progress | Cr 5060 Production absorbed (minutes x work center rate)
 *   completion         Dr 1300 Inventory        | Cr 1350 Work in progress    (everything the order cost)
 * So the product goes into stock at its actual cost and WIP is empty once the
 * order is complete. Materials not issued by hand are backflushed at completion,
 * in proportion to the quantity made.
 */

const d = (v: Date | string) => (typeof v === 'string' ? v : v.toISOString().slice(0, 10));

export async function createWorkCenter(tx: Tx, ctx: Ctx, input: { companyId: string; code: string; name: string; hourlyRate: number; unitId?: string }) {
  await authorize(tx, ctx, 'mfg.manage', { unitId: input.companyId });
  await company(tx, input.companyId);
  return one(tx, `INSERT INTO mfg.work_centers (tenant_id, company_id, code, name, hourly_rate, unit_id) VALUES (app.tenant(), $1, $2, $3, $4, $5) RETURNING *`,
    [input.companyId, input.code, input.name, input.hourlyRate, input.unitId ?? null]);
}

export async function listWorkCenters(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'mfg.manage', { unitId: companyId });
  return many(tx, 'SELECT * FROM mfg.work_centers WHERE company_id = $1 ORDER BY code', [companyId]);
}

export interface BomInput {
  companyId: string; itemId: string; code: string; outputQty?: number; notes?: string;
  lines: { itemId: string; qty: number; scrapPct?: number }[];
  operations?: { seq: number; name: string; workCenterId: string; setupMinutes?: number; runMinutes?: number }[];
}

/** Components a product needs, all the way down (to refuse a BOM that uses its own product). */
async function explodes(tx: Tx, companyId: string, itemId: string, target: string, seen = new Set<string>()): Promise<boolean> {
  if (itemId === target) return true;
  if (seen.has(itemId)) return false;
  seen.add(itemId);
  const comps = await many(tx, `SELECT l.item_id FROM mfg.bom_lines l JOIN mfg.boms b ON b.id = l.bom_id
                                 WHERE b.company_id = $1 AND b.item_id = $2 AND b.status = 'active'`, [companyId, itemId]);
  for (const c of comps) if (await explodes(tx, companyId, c.item_id, target, seen)) return true;
  return false;
}

/** A new BOM for a product replaces its active one, which becomes obsolete. */
export async function createBom(tx: Tx, ctx: Ctx, input: BomInput) {
  await authorize(tx, ctx, 'mfg.manage', { unitId: input.companyId });
  await company(tx, input.companyId);
  const product = await stockItem(tx, input.itemId);
  if (!input.lines?.length) throw new ValidationError('a bill of materials needs at least one component');
  const seen = new Set<string>();
  for (const l of input.lines) {
    await stockItem(tx, l.itemId);
    if (seen.has(l.itemId)) throw new ValidationError('a component is listed twice');
    seen.add(l.itemId);
    if (!(l.qty > 0)) throw new ValidationError('component quantities must be positive');
    if (await explodes(tx, input.companyId, l.itemId, input.itemId)) throw new ValidationError(`${product.code} cannot be made from itself`);
  }
  for (const o of input.operations ?? []) {
    const wc = await one(tx, 'SELECT company_id, status FROM mfg.work_centers WHERE id = $1', [o.workCenterId]);
    if (!wc || wc.company_id !== input.companyId) throw new ValidationError('the work center does not belong to this company');
  }
  await tx.query(`UPDATE mfg.boms SET status = 'obsolete' WHERE company_id = $1 AND item_id = $2 AND status = 'active'`, [input.companyId, input.itemId]);
  const bom = await one(tx, `INSERT INTO mfg.boms (tenant_id, company_id, item_id, code, output_qty, notes) VALUES (app.tenant(), $1, $2, $3, $4, $5) RETURNING *`,
    [input.companyId, input.itemId, input.code, input.outputQty ?? 1, input.notes ?? null]);
  for (const [i, l] of input.lines.entries()) {
    await tx.query(`INSERT INTO mfg.bom_lines (tenant_id, bom_id, line_no, item_id, qty, scrap_pct) VALUES (app.tenant(), $1, $2, $3, $4, $5)`,
      [bom.id, i + 1, l.itemId, l.qty, l.scrapPct ?? 0]);
  }
  for (const o of input.operations ?? []) {
    await tx.query(`INSERT INTO mfg.bom_operations (tenant_id, bom_id, seq, name, work_center_id, setup_minutes, run_minutes)
      VALUES (app.tenant(), $1, $2, $3, $4, $5, $6)`, [bom.id, o.seq, o.name, o.workCenterId, o.setupMinutes ?? 0, o.runMinutes ?? 0]);
  }
  return getBom(tx, ctx, bom.id);
}

export async function getBom(tx: Tx, ctx: Ctx, bomId: string) {
  const bom = await one(tx, `SELECT b.*, i.code AS item_code, i.name AS item_name FROM mfg.boms b JOIN mdm.items i ON i.id = b.item_id WHERE b.id = $1`, [bomId]);
  if (!bom) throw new NotFoundError('bill of materials');
  await authorize(tx, ctx, 'mfg.manage', { unitId: bom.company_id });
  bom.lines = await many(tx, `SELECT l.*, i.code AS item_code, i.name AS item_name FROM mfg.bom_lines l JOIN mdm.items i ON i.id = l.item_id
                               WHERE l.bom_id = $1 ORDER BY l.line_no`, [bomId]);
  bom.operations = await many(tx, `SELECT o.*, w.code AS work_center_code, w.hourly_rate FROM mfg.bom_operations o JOIN mfg.work_centers w ON w.id = o.work_center_id
                                    WHERE o.bom_id = $1 ORDER BY o.seq`, [bomId]);
  return bom;
}

export async function listBoms(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'mfg.manage', { unitId: companyId });
  return many(tx, `SELECT b.*, i.code AS item_code, i.name AS item_name,
                          (SELECT count(*)::int FROM mfg.bom_lines l WHERE l.bom_id = b.id) AS components
                     FROM mfg.boms b JOIN mdm.items i ON i.id = b.item_id WHERE b.company_id = $1 ORDER BY b.status, i.code`, [companyId]);
}

/** Standard cost of one unit at today's average costs and work center rates, rolled up through sub-assemblies. */
export async function costRollup(tx: Tx, ctx: Ctx, companyId: string, itemId: string, depth = 0): Promise<{ material: number; conversion: number; total: number }> {
  if (depth === 0) await authorize(tx, ctx, 'mfg.manage', { unitId: companyId });
  if (depth > 20) throw new ValidationError('the bill of materials is nested too deep');
  const bom = await one(tx, `SELECT * FROM mfg.boms WHERE company_id = $1 AND item_id = $2 AND status = 'active'`, [companyId, itemId]);
  if (!bom) {
    const avg = await one(tx, `SELECT CASE WHEN sum(s.qty) > 0 THEN sum(s.value) / sum(s.qty) ELSE 0 END::float AS c
                                 FROM inv.stock s JOIN inv.warehouses w ON w.id = s.warehouse_id WHERE w.company_id = $1 AND s.item_id = $2`, [companyId, itemId]);
    return { material: avg.c, conversion: 0, total: avg.c };
  }
  const out = Number(bom.output_qty);
  let material = 0, conversion = 0;
  for (const l of await many(tx, 'SELECT * FROM mfg.bom_lines WHERE bom_id = $1', [bom.id])) {
    const c = await costRollup(tx, ctx, companyId, l.item_id, depth + 1);
    material += c.total * Number(l.qty) / (1 - Number(l.scrap_pct) / 100) / out;
  }
  for (const o of await many(tx, `SELECT o.*, w.hourly_rate FROM mfg.bom_operations o JOIN mfg.work_centers w ON w.id = o.work_center_id WHERE o.bom_id = $1`, [bom.id])) {
    conversion += (Number(o.setup_minutes) / out + Number(o.run_minutes)) / 60 * Number(o.hourly_rate);
  }
  return { material: roundMoney(material), conversion: roundMoney(conversion), total: roundMoney(material + conversion) };
}

// ---------------------------------------------------------------------------
// Work orders
// ---------------------------------------------------------------------------

export async function createWorkOrder(tx: Tx, ctx: Ctx, input: { companyId: string; itemId: string; qty: number; warehouseId: string; dueDate?: string; salesOrderId?: string; date: string }) {
  await authorize(tx, ctx, 'mfg.produce', { unitId: input.companyId });
  await warehouse(tx, input.companyId, input.warehouseId);
  if (!(input.qty > 0)) throw new ValidationError('the quantity must be positive');
  const bom = await one(tx, `SELECT * FROM mfg.boms WHERE company_id = $1 AND item_id = $2 AND status = 'active'`, [input.companyId, input.itemId]);
  if (!bom) throw new ValidationError('the product has no active bill of materials');
  const no = await nextNumber(tx, input.companyId, 'mfg.work_order', 'WO', input.date);
  return one(tx, `INSERT INTO mfg.work_orders (tenant_id, company_id, no, bom_id, item_id, qty, warehouse_id, due_date, sales_order_id, created_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [input.companyId, no, bom.id, input.itemId, input.qty, input.warehouseId, input.dueDate ?? null, input.salesOrderId ?? null, ctx.userId]);
}

async function workOrder(tx: Tx, id: string) {
  const wo = await one(tx, 'SELECT * FROM mfg.work_orders WHERE id = $1 FOR UPDATE', [id]);
  if (!wo) throw new NotFoundError('work order');
  return wo;
}

/** Release: copy the BOM's materials and routing onto the order, scaled to its quantity. */
export async function releaseWorkOrder(tx: Tx, ctx: Ctx, id: string) {
  const wo = await workOrder(tx, id);
  await authorize(tx, ctx, 'mfg.produce', { unitId: wo.company_id });
  if (wo.status !== 'draft') throw new ConflictError(`the work order is ${wo.status}`);
  const bom = await getBom(tx, ctx, wo.bom_id);
  const factor = Number(wo.qty) / Number(bom.output_qty);
  for (const l of bom.lines) {
    const req = Math.round(Number(l.qty) * factor / (1 - Number(l.scrap_pct) / 100) * 10000) / 10000;
    await tx.query(`INSERT INTO mfg.wo_materials (tenant_id, work_order_id, item_id, required_qty) VALUES (app.tenant(), $1, $2, $3)`, [id, l.item_id, req]);
  }
  for (const o of bom.operations) {
    const minutes = roundMoney(Number(o.setup_minutes) + Number(o.run_minutes) * Number(wo.qty));
    await tx.query(`INSERT INTO mfg.wo_operations (tenant_id, work_order_id, seq, name, work_center_id, planned_minutes, hourly_rate)
      VALUES (app.tenant(), $1, $2, $3, $4, $5, $6)`, [id, o.seq, o.name, o.work_center_id, minutes, o.hourly_rate]);
  }
  await tx.query(`UPDATE mfg.work_orders SET status = 'released' WHERE id = $1`, [id]);
  return getWorkOrder(tx, ctx, id);
}

async function issue(tx: Tx, ctx: Ctx, wo: any, lines: { itemId: string; qty: number }[], date: string, memo: string) {
  await ensureRoleAccount(tx, wo.company_id, 'wip');
  const costed = [];
  for (const l of lines) {
    if (!(l.qty > 0)) continue;
    const m = await one(tx, 'SELECT * FROM mfg.wo_materials WHERE work_order_id = $1 AND item_id = $2', [wo.id, l.itemId]);
    if (!m) throw new ValidationError('the item is not a material of this work order');
    costed.push({ ...l, value: await issueCost(tx, wo.warehouse_id, l.itemId, l.qty) });
  }
  const total = roundMoney(costed.reduce((s, l) => s + l.value, 0));
  const j = total > 0 ? await post(tx, ctx, { companyId: wo.company_id, type: 'production', date, memo,
    lines: [{ account: 'role:wip', debit: total }, { account: 'role:inventory', credit: total }] }) : null;
  for (const l of costed) {
    await applyMove(tx, ctx, { companyId: wo.company_id, warehouseId: wo.warehouse_id, itemId: l.itemId, date, kind: 'production_issue',
      qty: -l.qty, value: -l.value, source: { type: 'mfg.work_order', id: wo.id }, journalId: j?.id });
    await tx.query('UPDATE mfg.wo_materials SET issued_qty = issued_qty + $3, issued_value = issued_value + $4 WHERE work_order_id = $1 AND item_id = $2',
      [wo.id, l.itemId, l.qty, l.value]);
  }
  await tx.query('UPDATE mfg.work_orders SET material_cost = material_cost + $2 WHERE id = $1', [wo.id, total]);
  return total;
}

/** Issue materials to the order by hand (more than planned is allowed: it is scrap or loss, and costs the order). */
export async function issueMaterials(tx: Tx, ctx: Ctx, id: string, input: { date: string; lines?: { itemId: string; qty: number }[] }) {
  const wo = await workOrder(tx, id);
  await authorize(tx, ctx, 'mfg.produce', { unitId: wo.company_id });
  if (wo.status !== 'released') throw new ConflictError(`materials are issued to released work orders; this one is ${wo.status}`);
  const lines = input.lines ?? (await many(tx, 'SELECT item_id, required_qty - issued_qty AS rest FROM mfg.wo_materials WHERE work_order_id = $1', [id]))
    .map((m) => ({ itemId: m.item_id, qty: Math.max(0, Number(m.rest)) }));
  const value = await issue(tx, ctx, wo, lines, input.date, `Materials to ${wo.no}`);
  return { value, workOrder: await getWorkOrder(tx, ctx, id) };
}

/**
 * Complete the order: backflush the materials not issued yet (for the quantity
 * made), absorb labour and overhead from the routing, and put the product into
 * stock at the order's full cost. A short quantity is a yield loss carried by
 * the good units.
 */
export async function completeWorkOrder(tx: Tx, ctx: Ctx, id: string, input: { date: string; qty?: number; operations?: { seq: number; minutes: number }[] }) {
  const wo = await workOrder(tx, id);
  await authorize(tx, ctx, 'mfg.produce', { unitId: wo.company_id });
  if (wo.status !== 'released') throw new ConflictError(`only a released work order can be completed; this one is ${wo.status}`);
  const qty = input.qty ?? Number(wo.qty);
  if (!(qty > 0)) throw new ValidationError('the quantity made must be positive');
  if (qty > Number(wo.qty) * 1.1 + 1e-9) throw new ValidationError('more than 10% over the ordered quantity: raise another work order');
  const share = Math.min(1, qty / Number(wo.qty));
  const backflush = (await many(tx, 'SELECT item_id, required_qty, issued_qty FROM mfg.wo_materials WHERE work_order_id = $1', [id]))
    .map((m) => ({ itemId: m.item_id, qty: Math.round(Math.max(0, Number(m.required_qty) * share - Number(m.issued_qty)) * 10000) / 10000 }));
  await issue(tx, ctx, wo, backflush, input.date, `Backflush ${wo.no}`);

  const actual = new Map((input.operations ?? []).map((o) => [o.seq, o.minutes]));
  let conversion = 0;
  for (const o of await many(tx, 'SELECT * FROM mfg.wo_operations WHERE work_order_id = $1 ORDER BY seq', [id])) {
    const minutes = actual.get(o.seq) ?? Number(o.planned_minutes) * share;
    if (minutes < 0) throw new ValidationError('minutes cannot be negative');
    const cost = roundMoney(minutes / 60 * Number(o.hourly_rate));
    conversion = roundMoney(conversion + cost);
    await tx.query('UPDATE mfg.wo_operations SET actual_minutes = $2, cost = $3 WHERE id = $1', [o.id, roundMoney(minutes), cost]);
  }
  await ensureRoleAccount(tx, wo.company_id, 'production_absorbed');
  const fresh = await one(tx, 'SELECT material_cost FROM mfg.work_orders WHERE id = $1', [id]);
  const total = roundMoney(Number(fresh.material_cost) + conversion);
  const wc = await one(tx, `SELECT w.unit_id FROM mfg.wo_operations o JOIN mfg.work_centers w ON w.id = o.work_center_id WHERE o.work_order_id = $1 ORDER BY o.seq LIMIT 1`, [id]);
  const lines = [];
  if (conversion > 0) lines.push({ account: 'role:wip', debit: conversion }, { account: 'role:production_absorbed', credit: conversion, unitId: wc?.unit_id ?? null });
  if (total > 0) lines.push({ account: 'role:inventory', debit: total }, { account: 'role:wip', credit: total });
  const j = lines.length ? await post(tx, ctx, { companyId: wo.company_id, type: 'production', date: input.date, memo: `Completed ${wo.no}`,
    source: { type: 'mfg.work_order', id }, lines }) : null;
  await applyMove(tx, ctx, { companyId: wo.company_id, warehouseId: wo.warehouse_id, itemId: wo.item_id, date: input.date, kind: 'production_receipt',
    qty, value: total, source: { type: 'mfg.work_order', id }, journalId: j?.id });
  await tx.query(`UPDATE mfg.work_orders SET status = 'completed', completed_qty = $2, completed_date = $3, conversion_cost = $4 WHERE id = $1`,
    [id, qty, input.date, conversion]);
  return getWorkOrder(tx, ctx, id);
}

export async function cancelWorkOrder(tx: Tx, ctx: Ctx, id: string) {
  const wo = await workOrder(tx, id);
  await authorize(tx, ctx, 'mfg.produce', { unitId: wo.company_id });
  if (!['draft', 'released'].includes(wo.status)) throw new ConflictError(`the work order is ${wo.status}`);
  if (Number(wo.material_cost) > 0) throw new ConflictError('materials were issued to this order: complete it (even for a smaller quantity) instead');
  await tx.query(`UPDATE mfg.work_orders SET status = 'cancelled' WHERE id = $1`, [id]);
  return getWorkOrder(tx, ctx, id);
}

export async function getWorkOrder(tx: Tx, ctx: Ctx, id: string) {
  const wo = await one(tx, `SELECT w.*, i.code AS item_code, i.name AS item_name, h.code AS warehouse_code, b.code AS bom_code
                              FROM mfg.work_orders w JOIN mdm.items i ON i.id = w.item_id JOIN inv.warehouses h ON h.id = w.warehouse_id
                              JOIN mfg.boms b ON b.id = w.bom_id WHERE w.id = $1`, [id]);
  if (!wo) throw new NotFoundError('work order');
  await authorize(tx, ctx, 'mfg.produce', { unitId: wo.company_id });
  wo.materials = await many(tx, `SELECT m.*, i.code AS item_code, i.name AS item_name FROM mfg.wo_materials m JOIN mdm.items i ON i.id = m.item_id
                                   WHERE m.work_order_id = $1 ORDER BY i.code`, [id]);
  wo.operations = await many(tx, `SELECT o.*, w.code AS work_center_code FROM mfg.wo_operations o JOIN mfg.work_centers w ON w.id = o.work_center_id
                                    WHERE o.work_order_id = $1 ORDER BY o.seq`, [id]);
  const made = Number(wo.completed_qty ?? 0);
  wo.unit_cost = made > 0 ? roundMoney((Number(wo.material_cost) + Number(wo.conversion_cost)) / made) : null;
  return wo;
}

export async function listWorkOrders(tx: Tx, ctx: Ctx, companyId: string, status?: string) {
  await authorize(tx, ctx, 'mfg.produce', { unitId: companyId });
  return many(tx, `SELECT w.*, i.code AS item_code, i.name AS item_name FROM mfg.work_orders w JOIN mdm.items i ON i.id = w.item_id
                    WHERE w.company_id = $1 AND ($2::text IS NULL OR w.status = $2) ORDER BY w.no DESC LIMIT 300`, [companyId, status ?? null]);
}

// ---------------------------------------------------------------------------
// Reorder rules and MRP
// ---------------------------------------------------------------------------

export async function setReorderRule(tx: Tx, ctx: Ctx, input: { companyId: string; warehouseId: string; itemId: string; minQty: number; reorderQty?: number }) {
  await authorize(tx, ctx, 'inv.manage', { unitId: input.companyId });
  await warehouse(tx, input.companyId, input.warehouseId);
  await stockItem(tx, input.itemId);
  return one(tx, `INSERT INTO inv.reorder_rules (tenant_id, warehouse_id, item_id, min_qty, reorder_qty) VALUES (app.tenant(), $1, $2, $3, $4)
    ON CONFLICT (tenant_id, warehouse_id, item_id) DO UPDATE SET min_qty = EXCLUDED.min_qty, reorder_qty = EXCLUDED.reorder_qty RETURNING *`,
    [input.warehouseId, input.itemId, input.minQty, input.reorderQty ?? 0]);
}

export interface MrpRow {
  itemId: string; code: string; name: string; level: number; onHand: number; minQty: number;
  salesDemand: number; productionDemand: number; plannedDemand: number; incomingPurchases: number; incomingProduction: number;
  shortage: number; action: 'make' | 'buy' | null; suggestedQty: number; bomId: string | null;
}

/**
 * Material requirements for the whole company: open sales orders, released work
 * orders and reorder points against stock, open purchase orders and work orders
 * in progress. Shortages of products with a BOM become "make" suggestions whose
 * components are planned in turn (by low-level code); the rest are "buy".
 */
export async function runMrp(tx: Tx, ctx: Ctx, companyId: string): Promise<MrpRow[]> {
  await authorize(tx, ctx, 'mfg.manage', { unitId: companyId });
  const items = new Map<string, MrpRow>();
  const row = (id: string, code = '', name = ''): MrpRow => {
    let r = items.get(id);
    if (!r) {
      r = { itemId: id, code, name, level: 0, onHand: 0, minQty: 0, salesDemand: 0, productionDemand: 0, plannedDemand: 0,
        incomingPurchases: 0, incomingProduction: 0, shortage: 0, action: null, suggestedQty: 0, bomId: null };
      items.set(id, r);
    }
    return r;
  };
  const q = async (sql: string, f: (r: MrpRow, x: any) => void) => {
    for (const x of await many(tx, sql, [companyId])) f(row(x.item_id), x);
  };
  await q(`SELECT s.item_id, sum(s.qty)::float AS n FROM inv.stock s JOIN inv.warehouses w ON w.id = s.warehouse_id WHERE w.company_id = $1 GROUP BY s.item_id`,
    (r, x) => { r.onHand = x.n; });
  await q(`SELECT r.item_id, sum(r.min_qty)::float AS n, sum(r.reorder_qty)::float AS rq FROM inv.reorder_rules r JOIN inv.warehouses w ON w.id = r.warehouse_id
            WHERE w.company_id = $1 GROUP BY r.item_id`, (r, x) => { r.minQty = x.n; (r as any).reorderQty = x.rq; });
  await q(`SELECT l.item_id, sum(l.quantity - coalesce((SELECT sum(dl.quantity) FROM sal.delivery_lines dl WHERE dl.order_line_id = l.id), 0))::float AS n
             FROM sal.order_lines l JOIN sal.orders o ON o.id = l.order_id JOIN mdm.items i ON i.id = l.item_id
            WHERE o.company_id = $1 AND o.status = 'confirmed' AND i.item_type = 'stock' GROUP BY l.item_id`, (r, x) => { r.salesDemand = Math.max(0, x.n); });
  await q(`SELECT m.item_id, sum(greatest(m.required_qty - m.issued_qty, 0))::float AS n FROM mfg.wo_materials m JOIN mfg.work_orders w ON w.id = m.work_order_id
            WHERE w.company_id = $1 AND w.status = 'released' GROUP BY m.item_id`, (r, x) => { r.productionDemand = x.n; });
  await q(`SELECT l.item_id, sum(l.quantity - coalesce((SELECT sum(rl.quantity) FROM pur.receipt_lines rl WHERE rl.order_line_id = l.id), 0))::float AS n
             FROM pur.order_lines l JOIN pur.orders o ON o.id = l.order_id
            WHERE o.company_id = $1 AND o.status = 'approved' AND l.item_id IS NOT NULL GROUP BY l.item_id`, (r, x) => { r.incomingPurchases = Math.max(0, x.n); });
  await q(`SELECT item_id, sum(qty)::float AS n FROM mfg.work_orders WHERE company_id = $1 AND status IN ('draft','released') GROUP BY item_id`,
    (r, x) => { r.incomingProduction = x.n; });

  // BOM graph and low-level codes: a component sits one level below the deepest product that uses it.
  const boms = await many(tx, `SELECT b.id, b.item_id, b.output_qty FROM mfg.boms b WHERE b.company_id = $1 AND b.status = 'active'`, [companyId]);
  const bomOf = new Map(boms.map((b) => [b.item_id, b]));
  const comps = new Map<string, any[]>();
  for (const l of await many(tx, `SELECT l.* FROM mfg.bom_lines l JOIN mfg.boms b ON b.id = l.bom_id WHERE b.company_id = $1 AND b.status = 'active'`, [companyId])) {
    comps.set(l.bom_id, [...(comps.get(l.bom_id) ?? []), l]);
  }
  const level = new Map<string, number>();
  const visit = (itemId: string, lv: number, path: Set<string>) => {
    if (path.has(itemId) || path.size > 50) return;
    if ((level.get(itemId) ?? -1) >= lv && lv > 0) return;
    level.set(itemId, Math.max(level.get(itemId) ?? 0, lv));
    const b = bomOf.get(itemId);
    if (!b) return;
    for (const c of comps.get(b.id) ?? []) visit(c.item_id, lv + 1, new Set([...path, itemId]));
  };
  for (const b of boms) visit(b.item_id, 0, new Set());
  for (const b of boms) for (const c of comps.get(b.id) ?? []) row(c.item_id);
  for (const [id, r] of items) r.level = level.get(id) ?? 0;

  const order = [...items.values()].sort((a, b) => a.level - b.level);
  for (const r of order) {
    const need = r.salesDemand + r.productionDemand + r.plannedDemand + r.minQty;
    const have = r.onHand + r.incomingPurchases + r.incomingProduction;
    r.shortage = Math.max(0, Math.round((need - have) * 10000) / 10000);
    if (r.shortage <= 0) continue;
    const b = bomOf.get(r.itemId);
    const lot = Math.max(r.shortage, (r as any).reorderQty ?? 0);
    if (b) {
      const out = Number(b.output_qty);
      r.action = 'make'; r.bomId = b.id; r.suggestedQty = Math.ceil(lot / out - 1e-9) * out;
      for (const c of comps.get(b.id) ?? []) {
        row(c.item_id).plannedDemand += Number(c.qty) * r.suggestedQty / out / (1 - Number(c.scrap_pct) / 100);
      }
    } else {
      r.action = 'buy'; r.suggestedQty = Math.ceil(lot * 10000) / 10000;
    }
  }
  const names = await many(tx, 'SELECT id, code, name FROM mdm.items WHERE id = ANY($1)', [[...items.keys()]]);
  for (const n of names) { const r = items.get(n.id)!; r.code = n.code; r.name = n.name; }
  for (const r of items.values()) delete (r as any).reorderQty;
  return [...items.values()].sort((a, b) => a.level - b.level || a.code.localeCompare(b.code));
}

