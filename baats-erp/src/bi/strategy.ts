import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize, decide } from '../iam/authz.ts';
import { KPIS, addMonths, kpiDef } from './kpi.ts';

/**
 * Strategy and performance: a balanced scorecard of objectives, each measured
 * by KPI targets for a financial year. Actuals come from the KPI engine.
 * Additive KPIs (amounts and counts over a period) are judged against the
 * target pro-rated to the days elapsed, and projected to the full year;
 * rates, ratios and positions are judged against the target as it stands.
 * Within the tolerance band a KPI is amber; beyond it, red.
 */

const ADDITIVE = new Set(['money', 'count', 'tco2e', 'number']);

export async function createObjective(tx: Tx, ctx: Ctx, input: { companyId: string; code: string; title: string; perspective: string; ownerEmployeeId?: string }) {
  await authorize(tx, ctx, 'bi.scorecard.manage', { unitId: input.companyId });
  return one(tx, `INSERT INTO bi.objectives (tenant_id, company_id, code, title, perspective, owner_employee_id) VALUES (app.tenant(), $1, $2, $3, $4, $5) RETURNING *`,
    [input.companyId, input.code, input.title, input.perspective, input.ownerEmployeeId ?? null]);
}

export async function retireObjective(tx: Tx, ctx: Ctx, id: string) {
  const o = await one(tx, 'SELECT * FROM bi.objectives WHERE id = $1 FOR UPDATE', [id]);
  if (!o) throw new NotFoundError('objective');
  await authorize(tx, ctx, 'bi.scorecard.manage', { unitId: o.company_id });
  if (o.status === 'retired') throw new ConflictError('already retired');
  return one(tx, `UPDATE bi.objectives SET status = 'retired' WHERE id = $1 RETURNING *`, [id]);
}

/** Set (or change) the target for a KPI in a year. */
export async function setTarget(tx: Tx, ctx: Ctx, objectiveId: string, input: { kpiCode: string; year: number; target: number; tolerancePct?: number }) {
  const o = await one(tx, 'SELECT * FROM bi.objectives WHERE id = $1', [objectiveId]);
  if (!o) throw new NotFoundError('objective');
  await authorize(tx, ctx, 'bi.scorecard.manage', { unitId: o.company_id });
  const k = kpiDef(input.kpiCode);
  if (k.better === 'neutral') throw new ValidationError(`${k.name} has no better direction, so it cannot carry a target`);
  if (!Number.isFinite(input.target)) throw new ValidationError('give a target');
  return one(tx, `INSERT INTO bi.targets (tenant_id, objective_id, kpi_code, year, target, tolerance_pct) VALUES (app.tenant(), $1, $2, $3, $4, $5)
                  ON CONFLICT (objective_id, kpi_code, year) DO UPDATE SET target = EXCLUDED.target, tolerance_pct = EXCLUDED.tolerance_pct RETURNING *`,
    [objectiveId, k.code, input.year, input.target, input.tolerancePct ?? 10]);
}

export async function removeTarget(tx: Tx, ctx: Ctx, targetId: string) {
  const t = await one(tx, 'SELECT t.id, o.company_id FROM bi.targets t JOIN bi.objectives o ON o.id = t.objective_id WHERE t.id = $1', [targetId]);
  if (!t) throw new NotFoundError('target');
  await authorize(tx, ctx, 'bi.scorecard.manage', { unitId: t.company_id });
  await tx.query('DELETE FROM bi.targets WHERE id = $1', [targetId]);
  return { deleted: true };
}

export function rag(better: 'up' | 'down', actual: number, target: number, tolerancePct: number): 'green' | 'amber' | 'red' {
  const band = Math.abs(target) * tolerancePct / 100;
  if (better === 'up') return actual >= target ? 'green' : actual >= target - band ? 'amber' : 'red';
  return actual <= target ? 'green' : actual <= target + band ? 'amber' : 'red';
}

/** The scorecard for a financial year, as at a date inside it. */
export async function scorecard(tx: Tx, ctx: Ctx, companyId: string, year: number, asOf: string) {
  await authorize(tx, ctx, 'bi.dashboard', { unitId: companyId });
  const c = await one(tx, 'SELECT fiscal_year_start_month AS m FROM fin.companies WHERE unit_id = $1', [companyId]);
  const start = `${year}-${String(Number(c?.m ?? 1)).padStart(2, '0')}-01`;
  const end = new Date(Date.parse(`${addMonths(start, 12)}T00:00:00Z`) - 86400e3).toISOString().slice(0, 10);
  if (asOf < start) throw new ValidationError(`the year starts on ${start}`);
  const to = asOf > end ? end : asOf;
  const elapsed = (Date.parse(to) - Date.parse(start)) / 86400e3 + 1, total = (Date.parse(end) - Date.parse(start)) / 86400e3 + 1;
  const share = elapsed / total;
  const objectives = await many(tx, `SELECT o.*, e.first_name || ' ' || e.last_name AS owner_name FROM bi.objectives o LEFT JOIN org.employees e ON e.id = o.owner_employee_id
                                      WHERE o.company_id = $1 AND o.status = 'active' ORDER BY o.perspective, o.code`, [companyId]);
  const targets = await many(tx, `SELECT t.* FROM bi.targets t JOIN bi.objectives o ON o.id = t.objective_id WHERE o.company_id = $1 AND t.year = $2`, [companyId, year]);
  const out = [];
  const count = { green: 0, amber: 0, red: 0, hidden: 0 };
  for (const o of objectives) {
    const measures = [];
    for (const t of targets.filter((x) => x.objective_id === o.id)) {
      const k = KPIS.find((x) => x.code === t.kpi_code);
      if (!k) continue;
      if (!(await decide(tx, ctx.userId!, k.permission, { unitId: companyId })).allowed) { count.hidden++; continue; }
      const actual = await k.compute(tx, ctx, companyId, start, to);
      const target = Number(t.target), tol = Number(t.tolerance_pct);
      const additive = k.kind === 'flow' && ADDITIVE.has(k.unit);
      const due = additive ? Math.round(target * share * 100) / 100 : target;
      const status = actual === null ? null : rag(k.better as 'up' | 'down', actual, due, tol);
      if (status) count[status]++;
      measures.push({ targetId: t.id, kpi: k.code, name: k.name, unit: k.unit, better: k.better, target, tolerancePct: tol, dueToDate: due, actual,
        projected: additive && actual !== null && share > 0 ? Math.round(actual / share * 100) / 100 : null, status });
    }
    const worst = measures.some((m) => m.status === 'red') ? 'red' : measures.some((m) => m.status === 'amber') ? 'amber' : measures.some((m) => m.status === 'green') ? 'green' : null;
    out.push({ id: o.id, code: o.code, title: o.title, perspective: o.perspective, owner: o.owner_name, status: worst, measures });
  }
  return { year, from: start, to, yearEnds: end, elapsedPct: Math.round(share * 1000) / 10, objectives: out, summary: count };
}
