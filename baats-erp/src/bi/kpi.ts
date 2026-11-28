import { useBaseCurrency } from '../core/money.ts';
import { NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize, decide } from '../iam/authz.ts';
import { roundMoney } from '../fin/ledger.ts';
import { esgTotals } from './esg.ts';

/**
 * KPI engine. Every KPI is computed live from posted journals and module data,
 * so the dashboard, scorecards and the assistant all read the same numbers as
 * the statements. Each KPI names the permission that guards its source; a user
 * only ever sees the KPIs whose source they may read for that company.
 *
 * kind "flow" KPIs measure a period (revenue for March); kind "level" KPIs are
 * a position at the end of the period (cash on 31 March).
 */

export type Unit = 'money' | 'pct' | 'days' | 'count' | 'ratio' | 'tco2e' | 'number';
export interface KpiDef {
  code: string; name: string; module: string; unit: Unit; better: 'up' | 'down' | 'neutral'; kind: 'flow' | 'level';
  permission: string; description: string;
  /** The source only knows the position now, so the KPI cannot be restated for a past date. */
  snapshot?: boolean;
  compute: (tx: Tx, ctx: Ctx, companyId: string, from: string, to: string) => Promise<number | null>;
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400e3) + 1;
const ratio = (a: number, b: number, scale = 1) => (b ? Math.round((a / b) * scale * 100) / 100 : null);

export const ACC = {
  revenue: `a.type = 'revenue'`,
  direct: `a.type = 'expense' AND p.code = '52'`,
  opex: `a.type = 'expense' AND (p.code IS DISTINCT FROM '52')`,
  cash: `a.type = 'asset' AND (a.system_role IN ('cash','bank') OR (a.code LIKE '10%' AND a.system_role IS NULL))`,
  currentAssets: `a.type = 'asset' AND p.code = '11'`,
  currentLiabilities: `a.type = 'liability' AND p.code = '21'`,
  receivable: `a.control = 'receivable'`,
  payable: `a.control = 'payable'`,
  inventory: `a.system_role IN ('inventory','wip')`,
  payroll: `a.system_role IN ('salaries','eosb_expense','project_labour')`,
};

/** Credit minus debit on posted journals in the period (closing entries left out). */
async function flow(tx: Tx, companyId: string, from: string, to: string, where: string) {
  const r = await one(tx, `SELECT coalesce(sum(l.credit - l.debit), 0) AS v FROM fin.journal_lines l
      JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' AND j.type <> 'closing'
      JOIN fin.accounts a ON a.id = l.account_id LEFT JOIN fin.accounts p ON p.id = a.parent_id
     WHERE j.company_id = $1 AND j.date BETWEEN $2 AND $3 AND ${where}`, [companyId, from, to]);
  return roundMoney(num(r.v));
}

/** Debit minus credit balance at a date. */
async function level(tx: Tx, companyId: string, asOf: string, where: string) {
  const r = await one(tx, `SELECT coalesce(sum(l.debit - l.credit), 0) AS v FROM fin.journal_lines l
      JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted'
      JOIN fin.accounts a ON a.id = l.account_id LEFT JOIN fin.accounts p ON p.id = a.parent_id
     WHERE j.company_id = $1 AND j.date <= $2 AND ${where}`, [companyId, asOf]);
  return roundMoney(num(r.v));
}

const revenue = (tx: Tx, c: string, f: string, t: string) => flow(tx, c, f, t, ACC.revenue);
const directCosts = async (tx: Tx, c: string, f: string, t: string) => -(await flow(tx, c, f, t, ACC.direct));
const opex = async (tx: Tx, c: string, f: string, t: string) => -(await flow(tx, c, f, t, ACC.opex));

async function purchases(tx: Tx, companyId: string, from: string, to: string) {
  const r = await one(tx, `SELECT coalesce(sum(CASE WHEN kind = 'purchase_credit' THEN -1 ELSE 1 END * net_total * fx_rate), 0) AS v FROM fin.invoices
                            WHERE company_id = $1 AND kind IN ('purchase_invoice','purchase_credit') AND status = 'posted' AND date BETWEEN $2 AND $3`, [companyId, from, to]);
  return roundMoney(num(r.v));
}

async function headcount(tx: Tx, companyId: string, asOf: string) {
  const r = await one(tx, `SELECT count(DISTINCT k.employee_id)::int AS n FROM hr.contracts k
                            WHERE k.company_id = $1 AND k.start_date <= $2 AND (k.end_date IS NULL OR k.end_date >= $2)`, [companyId, asOf]);
  return r.n as number;
}

export const KPIS: KpiDef[] = [
  // Finance
  { code: 'revenue', name: 'Revenue', module: 'finance', unit: 'money', better: 'up', kind: 'flow', permission: 'fin.report.read',
    description: 'Income on revenue accounts from posted journals', compute: (tx, _c, co, f, t) => revenue(tx, co, f, t) },
  { code: 'gross_profit', name: 'Gross profit', module: 'finance', unit: 'money', better: 'up', kind: 'flow', permission: 'fin.report.read',
    description: 'Revenue less direct costs (account group 52)', compute: async (tx, _c, co, f, t) => roundMoney(await revenue(tx, co, f, t) - await directCosts(tx, co, f, t)) },
  { code: 'gross_margin_pct', name: 'Gross margin', module: 'finance', unit: 'pct', better: 'up', kind: 'flow', permission: 'fin.report.read',
    description: 'Gross profit as a share of revenue', compute: async (tx, _c, co, f, t) => { const r = await revenue(tx, co, f, t); return ratio(r - await directCosts(tx, co, f, t), r, 100); } },
  { code: 'operating_expenses', name: 'Operating expenses', module: 'finance', unit: 'money', better: 'down', kind: 'flow', permission: 'fin.report.read',
    description: 'Expenses outside direct costs, including depreciation and tax', compute: (tx, _c, co, f, t) => opex(tx, co, f, t) },
  { code: 'net_profit', name: 'Net profit', module: 'finance', unit: 'money', better: 'up', kind: 'flow', permission: 'fin.report.read',
    description: 'Revenue less all expenses', compute: async (tx, _c, co, f, t) => roundMoney(await revenue(tx, co, f, t) - await directCosts(tx, co, f, t) - await opex(tx, co, f, t)) },
  { code: 'net_margin_pct', name: 'Net margin', module: 'finance', unit: 'pct', better: 'up', kind: 'flow', permission: 'fin.report.read',
    description: 'Net profit as a share of revenue',
    compute: async (tx, _c, co, f, t) => { const r = await revenue(tx, co, f, t); return ratio(r - await directCosts(tx, co, f, t) - await opex(tx, co, f, t), r, 100); } },
  { code: 'cash', name: 'Cash and bank', module: 'finance', unit: 'money', better: 'up', kind: 'level', permission: 'fin.report.read',
    description: 'Balance of cash and bank accounts at the end of the period', compute: (tx, _c, co, _f, t) => level(tx, co, t, ACC.cash) },
  { code: 'receivables', name: 'Receivables', module: 'finance', unit: 'money', better: 'neutral', kind: 'level', permission: 'fin.report.read',
    description: 'Customer balances (receivable control account)', compute: (tx, _c, co, _f, t) => level(tx, co, t, ACC.receivable) },
  { code: 'payables', name: 'Payables', module: 'finance', unit: 'money', better: 'neutral', kind: 'level', permission: 'fin.report.read',
    description: 'Supplier balances (payable control account)', compute: async (tx, _c, co, _f, t) => -(await level(tx, co, t, ACC.payable)) },
  { code: 'dso', name: 'Days sales outstanding', module: 'finance', unit: 'days', better: 'down', kind: 'flow', permission: 'fin.report.read',
    description: 'Receivables at the end of the period / revenue x days in the period',
    compute: async (tx, _c, co, f, t) => { const r = await revenue(tx, co, f, t); return r > 0 ? Math.round(await level(tx, co, t, ACC.receivable) / r * days(f, t)) : null; } },
  { code: 'dpo', name: 'Days payables outstanding', module: 'finance', unit: 'days', better: 'neutral', kind: 'flow', permission: 'fin.report.read',
    description: 'Payables at the end of the period / bills received x days in the period',
    compute: async (tx, _c, co, f, t) => { const b = await purchases(tx, co, f, t); return b > 0 ? Math.round(-(await level(tx, co, t, ACC.payable)) / b * days(f, t)) : null; } },
  { code: 'current_ratio', name: 'Current ratio', module: 'finance', unit: 'ratio', better: 'up', kind: 'level', permission: 'fin.report.read',
    description: 'Current assets / current liabilities',
    compute: async (tx, _c, co, _f, t) => ratio(await level(tx, co, t, ACC.currentAssets), -(await level(tx, co, t, ACC.currentLiabilities))) },
  { code: 'overdue_receivables', name: 'Overdue receivables', module: 'finance', unit: 'money', better: 'down', kind: 'level', permission: 'fin.report.read',
    description: 'Open customer invoices past their due date, in base currency',
    compute: async (tx, _c, co, _f, t) => roundMoney(num((await one(tx, `SELECT sum(o.open * i.fx_rate) AS v FROM fin.invoices i,
        LATERAL (SELECT i.gross_total - coalesce((SELECT sum(a.amount) FROM fin.allocations a WHERE a.invoice_id = i.id AND a.date <= $2), 0) AS open) o
       WHERE i.company_id = $1 AND i.kind = 'sales_invoice' AND i.status = 'posted' AND i.date <= $2 AND i.due_date < $2 AND o.open > 0`, [co, t])).v)) },
  { code: 'purchases', name: 'Bills received', module: 'purchasing', unit: 'money', better: 'neutral', kind: 'flow', permission: 'fin.report.read',
    description: 'Posted supplier bills less credit notes, net of VAT', compute: (tx, _c, co, f, t) => purchases(tx, co, f, t) },
  // Sales and CRM
  { code: 'sales_orders', name: 'Sales orders taken', module: 'sales', unit: 'money', better: 'up', kind: 'flow', permission: 'sal.order.manage',
    description: 'Confirmed sales orders dated in the period, net of VAT, base currency',
    compute: async (tx, _c, co, f, t) => roundMoney(num((await one(tx, `SELECT sum(net_total * fx_rate) AS v FROM sal.orders WHERE company_id = $1 AND date BETWEEN $2 AND $3
        AND status IN ('confirmed','closed')`, [co, f, t])).v)) },
  { code: 'pipeline', snapshot: true, name: 'Weighted pipeline', module: 'sales', unit: 'money', better: 'up', kind: 'level', permission: 'crm.manage',
    description: 'Open opportunities x their probability, for units under the company',
    compute: async (tx, _c, co) => roundMoney(num((await one(tx, `SELECT sum(o.amount * o.probability / 100.0) AS v FROM crm.opportunities o JOIN org.units u ON u.id = o.owner_unit_id
        WHERE o.stage NOT IN ('won','lost') AND u.path LIKE (SELECT path FROM org.units WHERE id = $1) || '%'`, [co])).v)) },
  { code: 'win_rate', name: 'Opportunity win rate', module: 'sales', unit: 'pct', better: 'up', kind: 'flow', permission: 'crm.manage',
    description: 'Won / (won + lost) among opportunities created in the period',
    compute: async (tx, _c, co, f, t) => { const r = await one(tx, `SELECT count(*) FILTER (WHERE o.stage = 'won')::int AS w, count(*) FILTER (WHERE o.stage IN ('won','lost'))::int AS c
        FROM crm.opportunities o JOIN org.units u ON u.id = o.owner_unit_id WHERE o.created_at >= $2::date AND o.created_at < $3::date + 1
         AND u.path LIKE (SELECT path FROM org.units WHERE id = $1) || '%'`, [co, f, t]); return ratio(r.w, r.c, 100); } },
  // Inventory
  { code: 'inventory_value', name: 'Inventory value', module: 'inventory', unit: 'money', better: 'neutral', kind: 'level', permission: 'inv.read',
    description: 'Stock and work in progress on the balance sheet', compute: (tx, _c, co, _f, t) => level(tx, co, t, ACC.inventory) },
  { code: 'inventory_turns', name: 'Inventory turns (a year)', module: 'inventory', unit: 'ratio', better: 'up', kind: 'flow', permission: 'inv.read',
    description: 'Direct costs in the period, annualised, / inventory value at the end',
    compute: async (tx, _c, co, f, t) => ratio(await directCosts(tx, co, f, t) * 365 / days(f, t), await level(tx, co, t, ACC.inventory)) },
  { code: 'below_reorder', snapshot: true, name: 'Items below minimum', module: 'inventory', unit: 'count', better: 'down', kind: 'level', permission: 'inv.read',
    description: 'Reorder rules whose warehouse stock is under the minimum now',
    compute: async (tx, _c, co) => (await one(tx, `SELECT count(*)::int AS n FROM inv.reorder_rules r JOIN inv.warehouses w ON w.id = r.warehouse_id
        LEFT JOIN inv.stock s ON s.warehouse_id = r.warehouse_id AND s.item_id = r.item_id WHERE w.company_id = $1 AND coalesce(s.qty, 0) < r.min_qty`, [co])).n },
  // People
  { code: 'headcount', name: 'Headcount', module: 'hr', unit: 'count', better: 'neutral', kind: 'level', permission: 'hr.manage',
    description: 'Employees with a running contract at the end of the period', compute: (tx, _c, co, _f, t) => headcount(tx, co, t) },
  { code: 'payroll_cost', name: 'Payroll cost', module: 'hr', unit: 'money', better: 'neutral', kind: 'flow', permission: 'hr.manage',
    description: 'Salaries, end-of-service benefit and project labour expense', compute: async (tx, _c, co, f, t) => -(await flow(tx, co, f, t, ACC.payroll)) },
  { code: 'revenue_per_employee', name: 'Revenue per employee', module: 'hr', unit: 'money', better: 'up', kind: 'flow', permission: 'hr.manage',
    description: 'Revenue / headcount at the end of the period',
    compute: async (tx, ctx, co, f, t) => { const h = await headcount(tx, co, t); return h && (await decide(tx, ctx.userId!, 'fin.report.read', { unitId: co })).allowed ? roundMoney(await revenue(tx, co, f, t) / h) : null; } },
  // Operations
  { code: 'projects_active', snapshot: true, name: 'Active projects', module: 'projects', unit: 'count', better: 'neutral', kind: 'level', permission: 'prj.manage',
    description: 'Projects open at the end of the period',
    compute: async (tx, _c, co) => (await one(tx, `SELECT count(*)::int AS n FROM prj.projects WHERE company_id = $1 AND status = 'active'`, [co])).n },
  { code: 'work_orders_completed', name: 'Work orders completed', module: 'manufacturing', unit: 'count', better: 'up', kind: 'flow', permission: 'mfg.produce',
    description: 'Production work orders completed in the period',
    compute: async (tx, _c, co, f, t) => (await one(tx, `SELECT count(*)::int AS n FROM mfg.work_orders WHERE company_id = $1 AND status = 'completed' AND completed_date BETWEEN $2 AND $3`, [co, f, t])).n },
  { code: 'maintenance_backlog', snapshot: true, name: 'Maintenance backlog', module: 'maintenance', unit: 'count', better: 'down', kind: 'level', permission: 'mnt.manage',
    description: 'Maintenance work orders open or in progress',
    compute: async (tx, _c, co) => (await one(tx, `SELECT count(*)::int AS n FROM mnt.work_orders WHERE company_id = $1 AND status IN ('open','in_progress')`, [co])).n },
  { code: 'fuel_cost', name: 'Fuel cost', module: 'fleet', unit: 'money', better: 'down', kind: 'flow', permission: 'flt.manage',
    description: 'Fuel bought for the fleet, net of reclaimable VAT',
    compute: async (tx, _c, co, f, t) => roundMoney(num((await one(tx, `SELECT sum(l.amount - l.vat_amount) AS v FROM flt.fuel_logs l JOIN flt.vehicles v ON v.id = l.vehicle_id
        WHERE v.company_id = $1 AND l.date BETWEEN $2 AND $3`, [co, f, t])).v)) },
  // Corporate
  { code: 'tickets_open', snapshot: true, name: 'Open service tickets', module: 'service desk', unit: 'count', better: 'down', kind: 'level', permission: 'svc.agent',
    description: 'Tickets not yet resolved or closed',
    compute: async (tx) => (await one(tx, `SELECT count(*)::int AS n FROM svc.tickets WHERE status NOT IN ('resolved','closed')`)).n },
  { code: 'sla_met_pct', name: 'Tickets resolved in time', module: 'service desk', unit: 'pct', better: 'up', kind: 'flow', permission: 'svc.agent',
    description: 'Share of tickets raised in the period resolved within their resolution target (open ones count once late)',
    compute: async (tx, _c, _co, f, t) => { const r = await one(tx, `SELECT count(*)::int AS n, count(*) FILTER (WHERE (t.resolved_at IS NULL AND t.resolution_due < now()) OR t.resolved_at > t.resolution_due)::int AS late
        FROM svc.tickets t WHERE t.created_at >= $1::date AND t.created_at < $2::date + 1`, [f, t]); return r.n ? Math.round((1 - r.late / r.n) * 1000) / 10 : null; } },
  { code: 'overdue_actions', name: 'Overdue corrective actions', module: 'governance', unit: 'count', better: 'down', kind: 'level', permission: 'grc.action.verify',
    description: 'Actions still open after their due date',
    compute: async (tx, _c, co, _f, t) => (await one(tx, `SELECT count(*)::int AS n FROM grc.actions a JOIN org.units u ON u.id = a.unit_id
        WHERE a.status = 'open' AND a.due_date < $2 AND u.path LIKE (SELECT path FROM org.units WHERE id = $1) || '%'`, [co, t])).n },
  { code: 'high_risks', snapshot: true, name: 'Risks over appetite', module: 'governance', unit: 'count', better: 'down', kind: 'level', permission: 'grc.manage',
    description: 'Open risks whose residual score exceeds their appetite',
    compute: async (tx, _c, co) => (await one(tx, `SELECT count(*)::int AS n FROM grc.risks r JOIN org.units u ON u.id = r.unit_id
        WHERE r.status = 'open' AND u.path LIKE (SELECT path FROM org.units WHERE id = $1) || '%'
          AND greatest(1, r.likelihood - (SELECT count(*) FROM grc.controls c WHERE c.risk_id = r.id AND c.status = 'active'
              AND (SELECT x.result FROM grc.control_tests x WHERE x.control_id = c.id ORDER BY x.tested_on DESC, x.recorded_at DESC LIMIT 1) = 'effective')) * r.impact > r.appetite`, [co])).n },
  { code: 'ncr_open', snapshot: true, name: 'Open non-conformances', module: 'quality', unit: 'count', better: 'down', kind: 'level', permission: 'qms.manage',
    description: 'NCRs not yet closed', compute: async (tx, _c, co) => (await one(tx, `SELECT count(*)::int AS n FROM qms.ncrs WHERE company_id = $1 AND status <> 'closed'`, [co])).n },
  { code: 'rejection_pct', name: 'Inspection rejection rate', module: 'quality', unit: 'pct', better: 'down', kind: 'flow', permission: 'qms.manage',
    description: 'Quantity rejected / quantity inspected',
    compute: async (tx, _c, co, f, t) => { const r = await one(tx, `SELECT sum(qty_inspected)::float AS i, sum(qty_rejected)::float AS r FROM qms.inspections WHERE company_id = $1 AND inspected_on BETWEEN $2 AND $3`, [co, f, t]); return ratio(num(r.r), num(r.i), 100); } },
  { code: 'incidents', name: 'Safety incidents', module: 'safety', unit: 'count', better: 'down', kind: 'flow', permission: 'hse.manage',
    description: 'Incidents and near misses reported in the period',
    compute: async (tx, _c, co, f, t) => (await one(tx, `SELECT count(*)::int AS n FROM hse.incidents i JOIN org.units u ON u.id = i.unit_id
        WHERE i.occurred_at >= $2::date AND i.occurred_at < $3::date + 1 AND u.path LIKE (SELECT path FROM org.units WHERE id = $1) || '%'`, [co, f, t])).n },
  { code: 'lost_time_injuries', name: 'Lost-time injuries', module: 'safety', unit: 'count', better: 'down', kind: 'flow', permission: 'hse.manage',
    description: 'Injuries with at least one day lost',
    compute: async (tx, _c, co, f, t) => (await one(tx, `SELECT count(*)::int AS n FROM hse.incidents i JOIN org.units u ON u.id = i.unit_id
        WHERE i.kind = 'injury' AND i.lost_days > 0 AND i.occurred_at >= $2::date AND i.occurred_at < $3::date + 1 AND u.path LIKE (SELECT path FROM org.units WHERE id = $1) || '%'`, [co, f, t])).n },
  // Sustainability
  { code: 'emissions', name: 'Emissions (scope 1 and 2)', module: 'sustainability', unit: 'tco2e', better: 'down', kind: 'flow', permission: 'bi.esg.manage',
    description: 'Tonnes of CO2 equivalent from fuel, LPG, refrigerant losses and purchased electricity',
    compute: async (tx, _c, co, f, t) => { const e = await esgTotals(tx, co, f, t); return e.scope1 + e.scope2; } },
];

const BY_CODE = new Map(KPIS.map((k) => [k.code, k]));
export const kpiDef = (code: string) => { const k = BY_CODE.get(code); if (!k) throw new ValidationError(`unknown KPI ${code}`); return k; };

/** The KPIs this user may see for the company, without values. */
export async function kpiCatalog(tx: Tx, ctx: Ctx, companyId: string) {
  const out = [];
  for (const k of KPIS) if ((await decide(tx, ctx.userId!, k.permission, { unitId: companyId })).allowed) out.push(meta(k));
  return out;
}
export const meta = (k: KpiDef) => ({ code: k.code, name: k.name, module: k.module, unit: k.unit, better: k.better, kind: k.kind, snapshot: !!k.snapshot, description: k.description });

export async function kpiValue(tx: Tx, ctx: Ctx, companyId: string, code: string, from: string, to: string) {
  const k = kpiDef(code);
  await authorize(tx, ctx, k.permission, { unitId: companyId });
  return k.compute(tx, ctx, companyId, from, to);
}

/** Calendar helpers on ISO dates. */
export const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
export const monthEnd = (d: string) => new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0)).toISOString().slice(0, 10);
export const addMonths = (d: string, n: number) => { const x = new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1 + n, 1)); return x.toISOString().slice(0, 10); };
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

/** Start of the company's financial year containing a date. */
export async function fiscalYearStart(tx: Tx, companyId: string, asOf: string) {
  const c = await one(tx, 'SELECT fiscal_year_start_month AS m FROM fin.companies WHERE unit_id = $1', [companyId]);
  const m = Number(c?.m ?? 1);
  const y = Number(asOf.slice(0, 4)) - (Number(asOf.slice(5, 7)) < m ? 1 : 0);
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

/** A KPI month by month: the last n months ending with the month of asOf (the last one to date). */
export async function kpiTrend(tx: Tx, ctx: Ctx, companyId: string, code: string, asOf: string, months = 12) {
  const k = kpiDef(code);
  await authorize(tx, ctx, k.permission, { unitId: companyId });
  if (months < 1 || months > 36) throw new ValidationError('1 to 36 months');
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const from = addMonths(monthStart(asOf), -i);
    const to = i === 0 ? asOf : monthEnd(from);
    out.push({ month: from.slice(0, 7), value: await k.compute(tx, ctx, companyId, from, to) });
  }
  return { ...meta(k), points: out };
}

/**
 * The executive dashboard: every KPI the user may see, month to date and year
 * to date against the same span a period earlier, plus monthly trends for the
 * headline figures and the largest customers and overdue balances.
 */
export async function dashboard(tx: Tx, ctx: Ctx, companyId: string, asOf: string) {
  await authorize(tx, ctx, 'bi.dashboard', { unitId: companyId });
  const co = await one(tx, `SELECT c.legal_name, c.base_currency, u.code FROM fin.companies c JOIN org.units u ON u.id = c.unit_id WHERE c.unit_id = $1`, [companyId]);
  if (co) useBaseCurrency(co.base_currency);
  if (!co) throw new NotFoundError('company books');
  const mtdFrom = monthStart(asOf), ytdFrom = await fiscalYearStart(tx, companyId, asOf);
  const prevMonthTo = addDays(mtdFrom, -1);
  const prevMtdTo = (() => { const pm = monthStart(prevMonthTo); const d = Math.min(Number(asOf.slice(8, 10)), Number(monthEnd(pm).slice(8, 10))); return `${pm.slice(0, 8)}${String(d).padStart(2, '0')}`; })();
  const lastYear = (d: string) => { const y = `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`; return y.endsWith('02-29') ? y.replace('02-29', '02-28') : y; };
  const visible = [];
  for (const k of KPIS) if ((await decide(tx, ctx.userId!, k.permission, { unitId: companyId })).allowed) visible.push(k);
  const kpis = [];
  for (const k of visible) {
    const mtd = await k.compute(tx, ctx, companyId, mtdFrom, asOf);
    const mtdPrior = k.snapshot ? null : await k.compute(tx, ctx, companyId, monthStart(prevMonthTo), prevMtdTo);
    const ytd = k.kind === 'flow' ? await k.compute(tx, ctx, companyId, ytdFrom, asOf) : mtd;
    const ytdPrior = k.snapshot ? null : await k.compute(tx, ctx, companyId, lastYear(ytdFrom), lastYear(asOf));
    const change = (a: number | null, b: number | null) => (a === null || b === null || b === 0 ? null : Math.round(((a - b) / Math.abs(b)) * 1000) / 10);
    kpis.push({ ...meta(k), mtd, mtdPrior, mtdChangePct: change(mtd, mtdPrior), ytd, ytdPrior, ytdChangePct: change(ytd, ytdPrior) });
  }
  const finance = visible.some((k) => k.permission === 'fin.report.read');
  let trend = null, topCustomers = null, overdue = null;
  if (finance) {
    const from = addMonths(mtdFrom, -11);
    const rows = await many(tx, `SELECT to_char(j.date, 'YYYY-MM') AS month,
          coalesce(sum(l.credit - l.debit) FILTER (WHERE ${ACC.revenue}), 0)::float AS revenue,
          coalesce(sum(l.debit - l.credit) FILTER (WHERE ${ACC.direct}), 0)::float AS direct,
          coalesce(sum(l.debit - l.credit) FILTER (WHERE ${ACC.opex}), 0)::float AS opex
        FROM fin.journal_lines l JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' AND j.type <> 'closing'
        JOIN fin.accounts a ON a.id = l.account_id LEFT JOIN fin.accounts p ON p.id = a.parent_id
       WHERE j.company_id = $1 AND j.date BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 1`, [companyId, from, asOf]);
    const cashRows = await many(tx, `SELECT to_char(j.date, 'YYYY-MM') AS month, sum(l.debit - l.credit)::float AS movement
        FROM fin.journal_lines l JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted'
        JOIN fin.accounts a ON a.id = l.account_id LEFT JOIN fin.accounts p ON p.id = a.parent_id
       WHERE j.company_id = $1 AND j.date <= $2 AND ${ACC.cash} GROUP BY 1 ORDER BY 1`, [companyId, asOf]);
    let cash = 0; const cashAt = new Map<string, number>();
    for (const r of cashRows) { cash += r.movement; cashAt.set(r.month, roundMoney(cash)); }
    let running = cashRows.filter((r) => r.month < from.slice(0, 7)).reduce((s, r) => s + r.movement, 0);
    trend = [];
    for (let i = 0; i < 12; i++) {
      const m = addMonths(from, i).slice(0, 7);
      const r = rows.find((x) => x.month === m) ?? { revenue: 0, direct: 0, opex: 0 };
      if (cashAt.has(m)) running = cashAt.get(m)!;
      trend.push({ month: m, revenue: roundMoney(r.revenue), costs: roundMoney(r.direct + r.opex), netProfit: roundMoney(r.revenue - r.direct - r.opex), cash: roundMoney(running) });
    }
    topCustomers = (await many(tx, `SELECT p.name, sum(CASE WHEN i.kind = 'sales_credit' THEN -1 ELSE 1 END * i.net_total * i.fx_rate)::float AS revenue
        FROM fin.invoices i JOIN mdm.parties p ON p.id = i.party_id
       WHERE i.company_id = $1 AND i.kind IN ('sales_invoice','sales_credit') AND i.status = 'posted' AND i.date BETWEEN $2 AND $3
       GROUP BY p.name ORDER BY 2 DESC LIMIT 5`, [companyId, ytdFrom, asOf])).map((r) => ({ name: r.name, revenue: roundMoney(r.revenue) }));
    overdue = (await many(tx, `SELECT p.name, sum(o.open * i.fx_rate)::float AS amount, max($2::date - i.due_date)::int AS oldest_days
        FROM fin.invoices i JOIN mdm.parties p ON p.id = i.party_id,
        LATERAL (SELECT i.gross_total - coalesce((SELECT sum(a.amount) FROM fin.allocations a WHERE a.invoice_id = i.id AND a.date <= $2), 0) AS open) o
       WHERE i.company_id = $1 AND i.kind = 'sales_invoice' AND i.status = 'posted' AND i.due_date < $2 AND o.open > 0
       GROUP BY p.name ORDER BY 2 DESC LIMIT 5`, [companyId, asOf])).map((r) => ({ name: r.name, amount: roundMoney(r.amount), oldestDays: r.oldest_days }));
  }
  return { company: { id: companyId, code: co.code, name: co.legal_name, currency: co.base_currency }, asOf, periods: { mtd: [mtdFrom, asOf], ytd: [ytdFrom, asOf] },
    kpis, trend, topCustomers, overdue, hidden: KPIS.length - visible.length };
}
