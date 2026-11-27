import { NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';
import { company, post, resolveAccount, roundMoney } from '../fin/ledger.ts';
import { ensureRoleAccount } from '../fin/setup.ts';

/**
 * Fleet: vehicles (optionally booked as fixed assets), fuel, trips and
 * compliance dates. Fuel is posted as it is logged:
 *   Dr 5610 Vehicle fuel & running (vehicle's cost center) net
 *   Dr 1200 Input VAT (SR)                                    VAT on the receipt
 *   Cr cash, bank or a fuel card account                      paid
 * Odometer readings from fuel, trips and maintenance keep the vehicle's
 * mileage current, which drives distance-based maintenance plans.
 */

export interface VehicleInput {
  companyId: string; code: string; plateNo: string; make?: string; model?: string; year?: number;
  fuelType?: 'petrol' | 'diesel' | 'electric' | 'hybrid'; assetId?: string; unitId?: string; driverEmployeeId?: string;
  odometer?: number; registrationExpiry?: string; insuranceExpiry?: string; insurancePolicy?: string;
}

export async function vehicle(tx: Tx, id: string, lock = false) {
  const v = await one(tx, `SELECT * FROM flt.vehicles WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!v) throw new NotFoundError('vehicle');
  return v;
}

export async function createVehicle(tx: Tx, ctx: Ctx, input: VehicleInput) {
  await authorize(tx, ctx, 'flt.manage', { unitId: input.unitId ?? input.companyId });
  await company(tx, input.companyId);
  if (input.assetId) {
    const a = await one(tx, 'SELECT company_id, status, unit_id FROM fin.assets WHERE id = $1', [input.assetId]);
    if (!a || a.company_id !== input.companyId) throw new ValidationError('the fixed asset does not belong to this company');
    if (a.status !== 'active') throw new ValidationError('the fixed asset is disposed');
    input.unitId ??= a.unit_id ?? undefined;
  }
  return one(tx, `INSERT INTO flt.vehicles (tenant_id, company_id, code, plate_no, make, model, year, fuel_type, asset_id, unit_id, driver_employee_id,
                    odometer, registration_expiry, insurance_expiry, insurance_policy)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [input.companyId, input.code, input.plateNo.toUpperCase(), input.make ?? null, input.model ?? null, input.year ?? null, input.fuelType ?? 'petrol',
      input.assetId ?? null, input.unitId ?? null, input.driverEmployeeId ?? null, input.odometer ?? 0, input.registrationExpiry ?? null,
      input.insuranceExpiry ?? null, input.insurancePolicy ?? null]);
}

export async function updateVehicle(tx: Tx, ctx: Ctx, id: string, patch: { driverEmployeeId?: string | null; unitId?: string | null;
  registrationExpiry?: string | null; insuranceExpiry?: string | null; insurancePolicy?: string | null; status?: string }) {
  const v = await vehicle(tx, id, true);
  await authorize(tx, ctx, 'flt.manage', { unitId: v.unit_id ?? v.company_id });
  const set: string[] = [];
  const vals: unknown[] = [id];
  const col = { driverEmployeeId: 'driver_employee_id', unitId: 'unit_id', registrationExpiry: 'registration_expiry',
    insuranceExpiry: 'insurance_expiry', insurancePolicy: 'insurance_policy', status: 'status' } as const;
  for (const [k, c] of Object.entries(col)) {
    if (k in patch) { vals.push((patch as any)[k] ?? null); set.push(`${c} = $${vals.length}`); }
  }
  if (!set.length) return v;
  return one(tx, `UPDATE flt.vehicles SET ${set.join(', ')} WHERE id = $1 RETURNING *`, vals);
}

async function bumpOdometer(tx: Tx, vehicleId: string, km: number) {
  await tx.query('UPDATE flt.vehicles SET odometer = greatest(odometer, $2) WHERE id = $1', [vehicleId, km]);
}

export async function logFuel(tx: Tx, ctx: Ctx, input: { vehicleId: string; date: string; odometer: number; litres: number; amount: number;
  vatAmount?: number; station?: string; paidFrom?: string }) {
  const v = await vehicle(tx, input.vehicleId, true);
  await authorize(tx, ctx, 'flt.manage', { unitId: v.unit_id ?? v.company_id });
  if (v.status !== 'active') throw new ValidationError(`vehicle ${v.plate_no} is ${v.status}`);
  if (!(input.litres > 0) || !(input.amount > 0)) throw new ValidationError('litres and amount must be positive');
  const last = await one(tx, 'SELECT max(odometer)::float AS km FROM flt.fuel_logs WHERE vehicle_id = $1 AND date <= $2', [v.id, input.date]);
  if (last.km !== null && input.odometer < last.km) throw new ValidationError(`the odometer (${input.odometer}) is below the last fill-up (${last.km})`);
  const vat = roundMoney(input.vatAmount ?? 0);
  if (vat < 0 || vat > roundMoney(input.amount * 5 / 105) + 0.01) throw new ValidationError('the VAT is more than 5% VAT included in the amount');
  const net = roundMoney(input.amount - vat);
  const paid = await resolveAccount(tx, v.company_id, input.paidFrom ?? 'role:cash');
  const pa = await one(tx, 'SELECT control, type, is_group FROM fin.accounts WHERE id = $1', [paid.id]);
  if (pa.control || pa.is_group || !['asset', 'liability'].includes(pa.type)) throw new ValidationError('pay fuel from a cash, bank or card account');
  await ensureRoleAccount(tx, v.company_id, 'vehicle_running');
  const c = await company(tx, v.company_id);
  const sr = vat > 0 ? await one(tx, `SELECT id FROM fin.tax_codes WHERE country_code = $1 AND category = 'standard' AND active ORDER BY code LIMIT 1`, [c.country_code]) : null;
  if (vat > 0 && !sr) throw new ValidationError('the company has no standard-rated tax code for the VAT');
  const lines = [{ account: 'role:vehicle_running', debit: net, unitId: v.unit_id, taxCodeId: vat > 0 ? sr?.id : null, description: `Fuel ${v.plate_no}` }];
  if (vat > 0) lines.push({ account: 'role:vat_input', debit: vat, unitId: null, taxCodeId: sr?.id ?? null, taxBase: net, description: 'Input VAT' } as any);
  lines.push({ account: paid.id, credit: input.amount, description: `Fuel ${v.plate_no}${input.station ? ` at ${input.station}` : ''}` } as any);
  const j = await post(tx, ctx, { companyId: v.company_id, type: 'fuel', date: input.date, memo: `Fuel ${v.plate_no}, ${input.litres} L`, lines });
  const row = await one(tx, `INSERT INTO flt.fuel_logs (tenant_id, vehicle_id, date, odometer, litres, amount, vat_amount, station, journal_id, created_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [v.id, input.date, input.odometer, input.litres, input.amount, vat, input.station ?? null, j.id, ctx.userId]);
  await bumpOdometer(tx, v.id, input.odometer);
  return row;
}

export async function logTrip(tx: Tx, ctx: Ctx, input: { vehicleId: string; date: string; startKm?: number; endKm: number; purpose: string;
  driverEmployeeId?: string; projectId?: string }) {
  const v = await vehicle(tx, input.vehicleId, true);
  await authorize(tx, ctx, 'flt.manage', { unitId: v.unit_id ?? v.company_id });
  if (v.status !== 'active') throw new ValidationError(`vehicle ${v.plate_no} is ${v.status}`);
  const start = input.startKm ?? Number(v.odometer);
  if (!(input.endKm > start)) throw new ValidationError('the trip must end at a higher odometer reading than it starts');
  if (input.projectId) {
    const p = await one(tx, 'SELECT company_id FROM prj.projects WHERE id = $1', [input.projectId]);
    if (!p || p.company_id !== v.company_id) throw new ValidationError('the project does not belong to this company');
  }
  const row = await one(tx, `INSERT INTO flt.trips (tenant_id, vehicle_id, driver_employee_id, date, start_km, end_km, purpose, project_id, created_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [v.id, input.driverEmployeeId ?? v.driver_employee_id, input.date, start, input.endKm, input.purpose, input.projectId ?? null, ctx.userId]);
  await bumpOdometer(tx, v.id, input.endKm);
  return row;
}

/** Fuel economy is measured between fill-ups: the litres of every fill after the first, over the distance covered. */
export async function vehicleSummary(tx: Tx, ctx: Ctx, id: string) {
  const v = await one(tx, `SELECT v.*, e.first_name || ' ' || e.last_name AS driver_name, a.code AS asset_code
                             FROM flt.vehicles v LEFT JOIN org.employees e ON e.id = v.driver_employee_id LEFT JOIN fin.assets a ON a.id = v.asset_id
                            WHERE v.id = $1`, [id]);
  if (!v) throw new NotFoundError('vehicle');
  await authorize(tx, ctx, 'flt.manage', { unitId: v.unit_id ?? v.company_id });
  const fuel = await many(tx, 'SELECT * FROM flt.fuel_logs WHERE vehicle_id = $1 ORDER BY date, odometer', [id]);
  const trips = await many(tx, `SELECT t.*, p.code AS project_code FROM flt.trips t LEFT JOIN prj.projects p ON p.id = t.project_id
                                 WHERE t.vehicle_id = $1 ORDER BY t.date DESC LIMIT 100`, [id]);
  const maintenance = await many(tx, 'SELECT * FROM mnt.work_orders WHERE vehicle_id = $1 ORDER BY scheduled_date DESC', [id]);
  let economy: number | null = null;
  if (fuel.length >= 2) {
    const km = Number(fuel[fuel.length - 1].odometer) - Number(fuel[0].odometer);
    const litres = fuel.slice(1).reduce((s, f) => s + Number(f.litres), 0);
    economy = km > 0 ? roundMoney(litres / km * 100) : null;
  }
  const fuelCost = roundMoney(fuel.reduce((s, f) => s + Number(f.amount) - Number(f.vat_amount), 0));
  const maintenanceCost = roundMoney(maintenance.reduce((s, m) => s + Number(m.parts_cost), 0));
  const firstKm = fuel.length ? Number(fuel[0].odometer) : null;
  const km = firstKm !== null ? Number(v.odometer) - firstKm : 0;
  return { vehicle: v, fuel: fuel.reverse(), trips, maintenance, litresPer100km: economy, fuelCost, maintenanceCost,
    costPerKm: km > 0 ? roundMoney((fuelCost + maintenanceCost) / km) : null };
}

export async function listVehicles(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'flt.manage', { unitId: companyId });
  return many(tx, `SELECT v.*, e.first_name || ' ' || e.last_name AS driver_name
                     FROM flt.vehicles v LEFT JOIN org.employees e ON e.id = v.driver_employee_id
                    WHERE v.company_id = $1 ORDER BY v.status, v.code`, [companyId]);
}

/** Registration and insurance that expire within the window (or have expired), and maintenance that is due. */
export async function complianceAlerts(tx: Tx, ctx: Ctx, companyId: string, asOf: string, withinDays = 30) {
  await authorize(tx, ctx, 'flt.manage', { unitId: companyId });
  const docs = await many(tx, `SELECT v.id AS vehicle_id, v.code, v.plate_no, x.kind, x.expiry, (x.expiry - $2::date) AS days_left
      FROM flt.vehicles v CROSS JOIN LATERAL (VALUES ('registration', v.registration_expiry), ('insurance', v.insurance_expiry)) AS x(kind, expiry)
     WHERE v.company_id = $1 AND v.status = 'active' AND x.expiry IS NOT NULL AND x.expiry <= $2::date + $3::int
     ORDER BY x.expiry`, [companyId, asOf, withinDays]);
  const service = await many(tx, `SELECT v.id AS vehicle_id, v.code, v.plate_no, p.name AS plan, p.next_due_date,
        CASE WHEN p.interval_km IS NOT NULL THEN p.last_done_km + p.interval_km - v.odometer END AS km_left
      FROM mnt.plans p JOIN flt.vehicles v ON v.id = p.vehicle_id
     WHERE v.company_id = $1 AND v.status = 'active' AND p.status = 'active'
       AND (p.next_due_date <= $2::date + $3::int OR (p.interval_km IS NOT NULL AND v.odometer >= p.last_done_km + p.interval_km - 500))
     ORDER BY p.next_due_date NULLS LAST`, [companyId, asOf, withinDays]);
  return { documents: docs.map((d) => ({ ...d, expired: d.days_left < 0 })), maintenance: service };
}
