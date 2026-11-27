import { ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize, decide } from '../iam/authz.ts';

/**
 * ESG: greenhouse gas emissions (scope 1 and 2, location based) and resource
 * use. Fleet fuel comes straight from the fuel logs; meters, waste and
 * refrigerant top-ups are recorded as monthly readings. Factors are kg CO2e
 * per unit. The defaults are common published values; each company should
 * replace them with its utility's and regulator's figures.
 */

export const DEFAULT_FACTORS: Record<string, { value: number; label: string; source: string }> = {
  diesel_kg_per_l: { value: 2.68, label: 'Diesel, kg CO2e per litre', source: 'IPCC 2006 default for gas/diesel oil' },
  petrol_kg_per_l: { value: 2.31, label: 'Petrol, kg CO2e per litre', source: 'IPCC 2006 default for motor gasoline' },
  lpg_kg_per_kg: { value: 2.94, label: 'LPG, kg CO2e per kg', source: 'IPCC 2006 default for LPG' },
  refrigerant_kg_per_kg: { value: 2088, label: 'Refrigerant leaked, kg CO2e per kg (R-410A)', source: 'IPCC AR4 GWP for R-410A' },
  grid_kg_per_kwh: { value: 0.4, label: 'Grid electricity, kg CO2e per kWh', source: 'Placeholder for the UAE grid: use your utility\'s published factor' },
};
export const METRICS = ['electricity_kwh', 'solar_kwh', 'water_m3', 'waste_kg', 'recycled_kg', 'lpg_kg', 'refrigerant_kg'] as const;

const r3 = (v: number) => Math.round(v * 1000) / 1000;

export async function factors(tx: Tx, companyId: string) {
  const rows = await many(tx, 'SELECT key, value, source FROM bi.esg_factors WHERE company_id = $1', [companyId]);
  return Object.fromEntries(Object.entries(DEFAULT_FACTORS).map(([k, d]) => {
    const o = rows.find((r) => r.key === k);
    return [k, { value: o ? Number(o.value) : d.value, label: d.label, source: o ? (o.source ?? 'company') : d.source, overridden: !!o }];
  })) as Record<string, { value: number; label: string; source: string; overridden: boolean }>;
}

export async function setFactor(tx: Tx, ctx: Ctx, companyId: string, input: { key: string; value: number; source?: string }) {
  await authorize(tx, ctx, 'bi.esg.manage', { unitId: companyId });
  if (!DEFAULT_FACTORS[input.key]) throw new ValidationError(`unknown factor ${input.key}`);
  if (!(input.value >= 0)) throw new ValidationError('the factor cannot be negative');
  await tx.query(`INSERT INTO bi.esg_factors (tenant_id, company_id, key, value, source) VALUES (app.tenant(), $1, $2, $3, $4)
                  ON CONFLICT (tenant_id, company_id, key) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source`,
    [companyId, input.key, input.value, input.source ?? null]);
  return factors(tx, companyId);
}

/** Record (or correct) one month's reading for a metric. */
export async function recordReading(tx: Tx, ctx: Ctx, companyId: string, input: { month: string; metric: string; value: number; unitId?: string; note?: string }) {
  await authorize(tx, ctx, 'bi.esg.manage', { unitId: companyId });
  if (!(METRICS as readonly string[]).includes(input.metric)) throw new ValidationError(`unknown metric ${input.metric}`);
  if (!/^\d{4}-\d{2}/.test(input.month)) throw new ValidationError('give the month as YYYY-MM');
  if (!(input.value >= 0)) throw new ValidationError('the reading cannot be negative');
  const month = `${input.month.slice(0, 7)}-01`;
  if (input.unitId) {
    const u = await one(tx, `SELECT 1 FROM org.units u, org.units c WHERE u.id = $1 AND c.id = $2 AND u.path LIKE c.path || '%'`, [input.unitId, companyId]);
    if (!u) throw new ValidationError('the site is not part of this company');
  }
  const existing = await one(tx, `SELECT id FROM bi.esg_readings WHERE company_id = $1 AND unit_id IS NOT DISTINCT FROM $2 AND month = $3 AND metric = $4`,
    [companyId, input.unitId ?? null, month, input.metric]);
  if (existing) {
    return one(tx, `UPDATE bi.esg_readings SET value = $2, note = $3, recorded_by = $4, recorded_at = now() WHERE id = $1 RETURNING *`,
      [existing.id, input.value, input.note ?? null, ctx.userId]);
  }
  return one(tx, `INSERT INTO bi.esg_readings (tenant_id, company_id, unit_id, month, metric, value, note, recorded_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`, [companyId, input.unitId ?? null, month, input.metric, input.value, input.note ?? null, ctx.userId]);
}

export async function listReadings(tx: Tx, ctx: Ctx, companyId: string, from: string, to: string) {
  await authorize(tx, ctx, 'bi.esg.manage', { unitId: companyId });
  return many(tx, `SELECT r.*, u.code AS site_code FROM bi.esg_readings r LEFT JOIN org.units u ON u.id = r.unit_id
                    WHERE r.company_id = $1 AND r.month BETWEEN date_trunc('month', $2::date) AND $3 ORDER BY r.month DESC, r.metric`, [companyId, from, to]);
}

/** Monthly activity data (no permission check: callers authorize). */
async function activity(tx: Tx, companyId: string, from: string, to: string) {
  const fuel = await many(tx, `SELECT to_char(l.date, 'YYYY-MM') AS month,
        coalesce(sum(l.litres) FILTER (WHERE v.fuel_type = 'diesel'), 0)::float AS diesel_l,
        coalesce(sum(l.litres) FILTER (WHERE v.fuel_type IN ('petrol','hybrid')), 0)::float AS petrol_l
      FROM flt.fuel_logs l JOIN flt.vehicles v ON v.id = l.vehicle_id
     WHERE v.company_id = $1 AND l.date BETWEEN $2 AND $3 GROUP BY 1`, [companyId, from, to]);
  const readings = await many(tx, `SELECT to_char(month, 'YYYY-MM') AS month, metric, sum(value)::float AS value FROM bi.esg_readings
                                    WHERE company_id = $1 AND month BETWEEN date_trunc('month', $2::date) AND $3 GROUP BY 1, 2`, [companyId, from, to]);
  const months = new Map<string, Record<string, number>>();
  const row = (m: string) => { if (!months.has(m)) months.set(m, Object.fromEntries(['diesel_l', 'petrol_l', ...METRICS].map((k) => [k, 0]))); return months.get(m)!; };
  for (const f of fuel) { const r = row(f.month); r.diesel_l += f.diesel_l; r.petrol_l += f.petrol_l; }
  for (const x of readings) row(x.month)[x.metric] += x.value;
  return [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => ({ month, ...v })) as Array<Record<string, number> & { month: string }>;
}

function emissions(a: Record<string, any>, f: Record<string, { value: number }>) {
  const s1 = (a.diesel_l * f.diesel_kg_per_l.value + a.petrol_l * f.petrol_kg_per_l.value + a.lpg_kg * f.lpg_kg_per_kg.value + a.refrigerant_kg * f.refrigerant_kg_per_kg.value) / 1000;
  const s2 = (a.electricity_kwh * f.grid_kg_per_kwh.value) / 1000;
  return { scope1: r3(s1), scope2: r3(s2) };
}

/** Scope 1 and 2 tonnes for a period (used by the KPI engine; callers authorize). */
export async function esgTotals(tx: Tx, companyId: string, from: string, to: string) {
  const f = await factors(tx, companyId);
  let scope1 = 0, scope2 = 0;
  for (const m of await activity(tx, companyId, from, to)) { const e = emissions(m, f); scope1 += e.scope1; scope2 += e.scope2; }
  return { scope1: r3(scope1), scope2: r3(scope2) };
}

export async function esgReport(tx: Tx, ctx: Ctx, companyId: string, from: string, to: string) {
  await authorize(tx, ctx, 'bi.esg.manage', { unitId: companyId });
  const f = await factors(tx, companyId);
  const months = (await activity(tx, companyId, from, to)).map((m) => {
    const e = emissions(m, f);
    return { ...m, ...e, total: r3(e.scope1 + e.scope2) };
  });
  const sum = (k: string) => r3(months.reduce((s, m) => s + (m as any)[k], 0));
  const totals = Object.fromEntries(['diesel_l', 'petrol_l', ...METRICS, 'scope1', 'scope2', 'total'].map((k) => [k, sum(k)]));
  const waste = totals.waste_kg + totals.recycled_kg;
  const power = totals.electricity_kwh + totals.solar_kwh;
  let perMillionRevenue = null;
  if ((await decide(tx, ctx.userId!, 'fin.report.read', { unitId: companyId })).allowed) {
    const r = await one(tx, `SELECT coalesce(sum(l.credit - l.debit), 0)::float AS v FROM fin.journal_lines l
        JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' AND j.type <> 'closing' JOIN fin.accounts a ON a.id = l.account_id AND a.type = 'revenue'
       WHERE j.company_id = $1 AND j.date BETWEEN $2 AND $3`, [companyId, from, to]);
    perMillionRevenue = r.v > 0 ? r3(totals.total / (r.v / 1e6)) : null;
  }
  const hc = await one(tx, `SELECT count(DISTINCT employee_id)::int AS n FROM hr.contracts WHERE company_id = $1 AND start_date <= $2 AND (end_date IS NULL OR end_date >= $2)`, [companyId, to]);
  return { from, to, factors: f, months, totals,
    intensity: { perMillionRevenue, perEmployee: hc.n ? r3(totals.total / hc.n) : null },
    recycledPct: waste ? Math.round((totals.recycled_kg / waste) * 1000) / 10 : null,
    renewablePct: power ? Math.round((totals.solar_kwh / power) * 1000) / 10 : null };
}
