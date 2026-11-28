import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';
import { company, nextNumber, post, roundMoney } from '../fin/ledger.ts';
import { ensureRoleAccount } from '../fin/setup.ts';
import { applyMove, issueCost, stockItem, warehouse } from '../inv/service.ts';

/**
 * Maintenance of fixed assets and vehicles. Preventive plans fall due by date
 * or, for vehicles, by distance; corrective and breakdown work is raised by
 * hand. Spare parts come out of stock at moving average cost:
 *   Dr 5250 Repairs & maintenance (the asset's cost center) | Cr 1300 Inventory
 * Outside repair work is billed by the supplier on a purchase invoice as usual.
 * Completing a preventive order rolls its plan forward.
 */

const d = (v: Date | string) => (typeof v === 'string' ? v : v.toISOString().slice(0, 10));

async function target(tx: Tx, companyId: string, t: { assetId?: string; vehicleId?: string }) {
  if (!!t.assetId === !!t.vehicleId) throw new ValidationError('choose either a fixed asset or a vehicle');
  if (t.assetId) {
    const a = await one(tx, 'SELECT company_id, status, unit_id, code, name FROM fin.assets WHERE id = $1', [t.assetId]);
    if (!a || a.company_id !== companyId) throw new ValidationError('the asset does not belong to this company');
    if (a.status !== 'active') throw new ValidationError(`asset ${a.code} is disposed`);
    return { unitId: a.unit_id, label: `${a.code} ${a.name}`, odometer: null };
  }
  const v = await one(tx, 'SELECT company_id, status, unit_id, plate_no, odometer FROM flt.vehicles WHERE id = $1', [t.vehicleId]);
  if (!v || v.company_id !== companyId) throw new ValidationError('the vehicle does not belong to this company');
  if (v.status !== 'active') throw new ValidationError(`vehicle ${v.plate_no} is ${v.status}`);
  return { unitId: v.unit_id, label: v.plate_no, odometer: Number(v.odometer) };
}

export async function createPlan(tx: Tx, ctx: Ctx, input: { companyId: string; assetId?: string; vehicleId?: string; name: string;
  intervalDays?: number; intervalKm?: number; firstDueDate?: string }) {
  await authorize(tx, ctx, 'mnt.manage', { unitId: input.companyId });
  await company(tx, input.companyId);
  const t = await target(tx, input.companyId, input);
  if (!input.intervalDays && !input.intervalKm) throw new ValidationError('give an interval in days, in kilometres, or both');
  if (input.intervalKm && !input.vehicleId) throw new ValidationError('distance intervals are for vehicles');
  if (input.intervalDays && !input.firstDueDate) throw new ValidationError('give the date the first service is due');
  return one(tx, `INSERT INTO mnt.plans (tenant_id, company_id, asset_id, vehicle_id, name, interval_days, interval_km, last_done_km, next_due_date)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [input.companyId, input.assetId ?? null, input.vehicleId ?? null, input.name, input.intervalDays ?? null, input.intervalKm ?? null,
      input.intervalKm ? t.odometer : null, input.firstDueDate ?? null]);
}

export async function listPlans(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'mnt.manage', { unitId: companyId });
  return many(tx, `SELECT p.*, coalesce(a.code || ' ' || a.name, v.plate_no) AS target, v.odometer,
                          CASE WHEN p.interval_km IS NOT NULL THEN p.last_done_km + p.interval_km END AS next_due_km
                     FROM mnt.plans p LEFT JOIN fin.assets a ON a.id = p.asset_id LEFT JOIN flt.vehicles v ON v.id = p.vehicle_id
                    WHERE p.company_id = $1 ORDER BY p.status, p.next_due_date NULLS LAST`, [companyId]);
}

/** Plans due by the date (plus a look-ahead) or within kmAhead of their distance. */
export async function duePlans(tx: Tx, ctx: Ctx, companyId: string, asOf: string, daysAhead = 7, kmAhead = 500) {
  await authorize(tx, ctx, 'mnt.manage', { unitId: companyId });
  return many(tx, `SELECT p.*, coalesce(a.code || ' ' || a.name, v.plate_no) AS target, v.odometer,
                          (SELECT w.no FROM mnt.work_orders w WHERE w.plan_id = p.id AND w.status IN ('open','in_progress')) AS open_order
                     FROM mnt.plans p LEFT JOIN fin.assets a ON a.id = p.asset_id LEFT JOIN flt.vehicles v ON v.id = p.vehicle_id
                    WHERE p.company_id = $1 AND p.status = 'active'
                      AND coalesce(a.status, 'active') = 'active' AND coalesce(v.status, 'active') = 'active'
                      AND (p.next_due_date <= $2::date + $3::int
                           OR (p.interval_km IS NOT NULL AND v.odometer >= p.last_done_km + p.interval_km - $4))
                    ORDER BY p.next_due_date NULLS LAST`, [companyId, asOf, daysAhead, kmAhead]);
}

/** Raise preventive work orders for every due plan that has none open. */
export async function generateDue(tx: Tx, ctx: Ctx, companyId: string, asOf: string) {
  const due = await duePlans(tx, ctx, companyId, asOf);
  const created = [];
  for (const p of due) {
    if (p.open_order) continue;
    const scheduled = p.next_due_date && d(p.next_due_date) > asOf ? d(p.next_due_date) : asOf;
    created.push(await createWorkOrder(tx, ctx, { companyId, assetId: p.asset_id ?? undefined, vehicleId: p.vehicle_id ?? undefined,
      planId: p.id, kind: 'preventive', description: p.name, scheduledDate: scheduled }));
  }
  return created;
}

export async function createWorkOrder(tx: Tx, ctx: Ctx, input: { companyId: string; assetId?: string; vehicleId?: string; planId?: string;
  kind: 'preventive' | 'corrective' | 'breakdown'; priority?: string; description: string; scheduledDate: string; unitId?: string }) {
  await authorize(tx, ctx, 'mnt.manage', { unitId: input.companyId });
  const t = await target(tx, input.companyId, input);
  if (input.planId) {
    const p = await one(tx, 'SELECT asset_id, vehicle_id FROM mnt.plans WHERE id = $1', [input.planId]);
    if (!p || (p.asset_id ?? null) !== (input.assetId ?? null) || (p.vehicle_id ?? null) !== (input.vehicleId ?? null)) {
      throw new ValidationError('the plan is for another asset');
    }
  }
  const no = await nextNumber(tx, input.companyId, 'mnt.work_order', 'MWO', input.scheduledDate);
  return one(tx, `INSERT INTO mnt.work_orders (tenant_id, company_id, no, asset_id, vehicle_id, plan_id, kind, priority, description, unit_id, scheduled_date, created_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [input.companyId, no, input.assetId ?? null, input.vehicleId ?? null, input.planId ?? null, input.kind, input.priority ?? 'normal',
      input.description, input.unitId ?? t.unitId ?? null, input.scheduledDate, ctx.userId]);
}

async function order(tx: Tx, id: string) {
  const w = await one(tx, 'SELECT * FROM mnt.work_orders WHERE id = $1 FOR UPDATE', [id]);
  if (!w) throw new NotFoundError('maintenance work order');
  return w;
}

export async function startWorkOrder(tx: Tx, ctx: Ctx, id: string) {
  const w = await order(tx, id);
  await authorize(tx, ctx, 'mnt.manage', { unitId: w.unit_id ?? w.company_id });
  if (w.status !== 'open') throw new ConflictError(`the work order is ${w.status}`);
  return one(tx, `UPDATE mnt.work_orders SET status = 'in_progress' WHERE id = $1 RETURNING *`, [id]);
}

export async function issueParts(tx: Tx, ctx: Ctx, id: string, input: { warehouseId: string; date: string; lines: { itemId: string; qty: number }[] }) {
  const w = await order(tx, id);
  await authorize(tx, ctx, 'mnt.manage', { unitId: w.unit_id ?? w.company_id });
  if (!['open', 'in_progress'].includes(w.status)) throw new ConflictError(`the work order is ${w.status}`);
  await warehouse(tx, w.company_id, input.warehouseId);
  if (!input.lines?.length) throw new ValidationError('no parts to issue');
  const costed = [];
  for (const l of input.lines) {
    await stockItem(tx, l.itemId);
    if (!(l.qty > 0)) throw new ValidationError('part quantities must be positive');
    costed.push({ ...l, cost: await issueCost(tx, input.warehouseId, l.itemId, l.qty) });
  }
  const total = roundMoney(costed.reduce((s, l) => s + l.cost, 0));
  await ensureRoleAccount(tx, w.company_id, 'maintenance');
  const j = total > 0 ? await post(tx, ctx, { companyId: w.company_id, type: 'maintenance', date: input.date, memo: `Parts for ${w.no}: ${w.description}`,
    lines: [{ account: 'role:maintenance', debit: total, unitId: w.unit_id }, { account: 'role:inventory', credit: total }] }) : null;
  for (const l of costed) {
    await applyMove(tx, ctx, { companyId: w.company_id, warehouseId: input.warehouseId, itemId: l.itemId, date: input.date, kind: 'maintenance_issue',
      qty: -l.qty, value: -l.cost, source: { type: 'mnt.work_order', id }, journalId: j?.id });
    await tx.query(`INSERT INTO mnt.wo_parts (tenant_id, work_order_id, warehouse_id, item_id, qty, cost, date, journal_id)
      VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7)`, [id, input.warehouseId, l.itemId, l.qty, l.cost, input.date, j?.id ?? null]);
  }
  await tx.query(`UPDATE mnt.work_orders SET parts_cost = parts_cost + $2, status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END WHERE id = $1`, [id, total]);
  return getWorkOrder(tx, ctx, id);
}

export async function completeWorkOrder(tx: Tx, ctx: Ctx, id: string, input: { date: string; resolution: string; downtimeHours?: number; odometer?: number }) {
  const w = await order(tx, id);
  await authorize(tx, ctx, 'mnt.manage', { unitId: w.unit_id ?? w.company_id });
  if (!['open', 'in_progress'].includes(w.status)) throw new ConflictError(`the work order is ${w.status}`);
  if (!input.resolution?.trim()) throw new ValidationError('say what was done');
  let km: number | null = null;
  if (w.vehicle_id) {
    const v = await one(tx, 'SELECT odometer FROM flt.vehicles WHERE id = $1 FOR UPDATE', [w.vehicle_id]);
    km = input.odometer ?? Number(v.odometer);
    await tx.query('UPDATE flt.vehicles SET odometer = greatest(odometer, $2) WHERE id = $1', [w.vehicle_id, km]);
  }
  await tx.query(`UPDATE mnt.work_orders SET status = 'done', completed_date = $2, resolution = $3, downtime_hours = $4, odometer = $5, completed_by = $6 WHERE id = $1`,
    [id, input.date, input.resolution, input.downtimeHours ?? null, km, ctx.userId]);
  if (w.plan_id) {
    const p = await one(tx, 'SELECT * FROM mnt.plans WHERE id = $1 FOR UPDATE', [w.plan_id]);
    await tx.query(`UPDATE mnt.plans SET last_done_date = $2, last_done_km = coalesce($3, last_done_km),
        next_due_date = CASE WHEN interval_days IS NULL THEN NULL ELSE $2::date + interval_days END WHERE id = $1`,
      [p.id, input.date, km]);
  }
  return getWorkOrder(tx, ctx, id);
}

export async function cancelWorkOrder(tx: Tx, ctx: Ctx, id: string, reason: string) {
  const w = await order(tx, id);
  await authorize(tx, ctx, 'mnt.manage', { unitId: w.unit_id ?? w.company_id });
  if (!['open', 'in_progress'].includes(w.status)) throw new ConflictError(`the work order is ${w.status}`);
  if (Number(w.parts_cost) > 0) throw new ConflictError('parts were used on this order: complete it instead');
  return one(tx, `UPDATE mnt.work_orders SET status = 'cancelled', resolution = $2 WHERE id = $1 RETURNING *`, [id, reason]);
}

export async function getWorkOrder(tx: Tx, ctx: Ctx, id: string) {
  const w = await one(tx, `SELECT w.*, coalesce(a.code || ' ' || a.name, v.plate_no) AS target, p.name AS plan_name
                             FROM mnt.work_orders w LEFT JOIN fin.assets a ON a.id = w.asset_id LEFT JOIN flt.vehicles v ON v.id = w.vehicle_id
                             LEFT JOIN mnt.plans p ON p.id = w.plan_id WHERE w.id = $1`, [id]);
  if (!w) throw new NotFoundError('maintenance work order');
  await authorize(tx, ctx, 'mnt.manage', { unitId: w.unit_id ?? w.company_id });
  w.parts = await many(tx, `SELECT x.*, i.code AS item_code, i.name AS item_name FROM mnt.wo_parts x JOIN mdm.items i ON i.id = x.item_id
                             WHERE x.work_order_id = $1 ORDER BY x.date`, [id]);
  return w;
}

export async function listWorkOrders(tx: Tx, ctx: Ctx, companyId: string, f: { status?: string; assetId?: string; vehicleId?: string } = {}) {
  await authorize(tx, ctx, 'mnt.manage', { unitId: companyId });
  return many(tx, `SELECT w.*, coalesce(a.code || ' ' || a.name, v.plate_no) AS target
                     FROM mnt.work_orders w LEFT JOIN fin.assets a ON a.id = w.asset_id LEFT JOIN flt.vehicles v ON v.id = w.vehicle_id
                    WHERE w.company_id = $1 AND ($2::text IS NULL OR w.status = $2) AND ($3::uuid IS NULL OR w.asset_id = $3)
                      AND ($4::uuid IS NULL OR w.vehicle_id = $4)
                    ORDER BY CASE w.status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, w.scheduled_date DESC LIMIT 300`,
    [companyId, f.status ?? null, f.assetId ?? null, f.vehicleId ?? null]);
}

