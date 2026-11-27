import { NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize, decide } from '../iam/authz.ts';
import { round2 } from '../fin/ledger.ts';
import { esgTotals } from './esg.ts';
import { ACC, KPIS, addDays, addMonths, fiscalYearStart, kpiDef, meta, monthEnd, monthStart, type KpiDef } from './kpi.ts';

/**
 * The interactive dashboard. The same KPI definitions as the executive
 * dashboard, but for any period the user picks, against the comparison they
 * choose, with a drill-down from each KPI to its monthly trend, its breakdowns
 * (by account, customer, supplier, cost center, ...) and the records behind it.
 * Each user keeps their own tile layout per company.
 */

export const PRESETS = ['this_month', 'last_month', 'this_quarter', 'last_quarter', 'this_year', 'last_year', 'last_12_months', 'custom'] as const;
export const COMPARES = ['previous_period', 'previous_year', 'none'] as const;
export type Preset = (typeof PRESETS)[number];
export type Compare = (typeof COMPARES)[number];

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (d: string) => { if (!ISO.test(d)) return false; const t = new Date(`${d}T00:00:00Z`); return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d; };
const lastYear = (d: string) => { const y = `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`; return y.endsWith('02-29') ? y.replace('02-29', '02-28') : y; };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400e3);
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

/** A preset period as dates, using the company's financial year for quarters and years. */
export async function resolvePeriod(tx: Tx, companyId: string, preset: Preset, today: string): Promise<[string, string]> {
  const fy = await fiscalYearStart(tx, companyId, today);
  const qStart = addMonths(fy, Math.floor(((Number(today.slice(0, 4)) - Number(fy.slice(0, 4))) * 12 + Number(today.slice(5, 7)) - Number(fy.slice(5, 7))) / 3) * 3);
  switch (preset) {
    case 'this_month': return [monthStart(today), today];
    case 'last_month': { const s = addMonths(monthStart(today), -1); return [s, monthEnd(s)]; }
    case 'this_quarter': return [qStart, today];
    case 'last_quarter': { const s = addMonths(qStart, -3); return [s, addDays(qStart, -1)]; }
    case 'this_year': return [fy, today];
    case 'last_year': { const s = addMonths(fy, -12); return [s, addDays(fy, -1)]; }
    case 'last_12_months': return [addMonths(monthStart(today), -11), today];
    default: throw new ValidationError('a custom period needs from and to dates');
  }
}

export function checkRange(from: string, to: string) {
  if (!validDate(from) || !validDate(to)) throw new ValidationError('dates must be real dates as YYYY-MM-DD');
  if (from > to) throw new ValidationError('the period starts after it ends');
  if (daysBetween(from, to) > 366 * 3) throw new ValidationError('a period can be at most three years');
}

const wholeMonths = (from: string, to: string) => from === monthStart(from) && to === monthEnd(to);
const monthCount = (from: string, to: string) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;

/** The period to compare with: the same months (or days) just before, or the same dates a year earlier. */
export function comparisonRange(from: string, to: string, compare: Compare): [string, string] | null {
  if (compare === 'none') return null;
  if (compare === 'previous_year') return [lastYear(from), lastYear(to)];
  if (from === monthStart(from)) {
    // Whole months, or months to date: the same months just before, to the same day of the month.
    const n = monthCount(from, to); const s = addMonths(from, -n); const lastMonth = addMonths(s, n - 1);
    if (to === monthEnd(to)) return [s, monthEnd(lastMonth)];
    const day = Math.min(Number(to.slice(8)), Number(monthEnd(lastMonth).slice(8)));
    return [s, `${lastMonth.slice(0, 8)}${String(day).padStart(2, '0')}`];
  }
  const len = daysBetween(from, to) + 1;
  return [addDays(from, -len), addDays(from, -1)];
}

const change = (a: number | null, b: number | null) => (a === null || b === null || b === 0 ? null : Math.round(((a - b) / Math.abs(b)) * 1000) / 10);
/** Whether the move is good news, by the KPI's direction. */
const judge = (k: KpiDef, a: number | null, b: number | null) =>
  a === null || b === null || k.better === 'neutral' ? null : a === b ? 'same' : (a > b) === (k.better === 'up') ? 'better' : 'worse';

async function companyHeader(tx: Tx, companyId: string) {
  const co = await one(tx, `SELECT c.legal_name, c.base_currency, u.code FROM fin.companies c JOIN org.units u ON u.id = c.unit_id WHERE c.unit_id = $1`, [companyId]);
  if (!co) throw new NotFoundError('company books');
  return { id: companyId, code: co.code, name: co.legal_name, currency: co.base_currency };
}

async function visibleKpis(tx: Tx, ctx: Ctx, companyId: string) {
  const out: KpiDef[] = [];
  for (const k of KPIS) if ((await decide(tx, ctx.userId!, k.permission, { unitId: companyId })).allowed) out.push(k);
  return out;
}

export interface PeriodInput { period?: Preset; from?: string; to?: string; compare?: Compare; today?: string }

async function period(tx: Tx, companyId: string, p: PeriodInput) {
  const today = p.today ?? new Date().toISOString().slice(0, 10);
  const preset: Preset = p.period ?? (p.from || p.to ? 'custom' : 'this_month');
  if (!PRESETS.includes(preset)) throw new ValidationError(`unknown period ${preset}`);
  const compare: Compare = p.compare ?? 'previous_period';
  if (!COMPARES.includes(compare)) throw new ValidationError(`unknown comparison ${compare}`);
  let from: string, to: string;
  if (preset === 'custom') {
    if (!p.from || !p.to) throw new ValidationError('a custom period needs from and to dates');
    [from, to] = [p.from, p.to];
  } else [from, to] = await resolvePeriod(tx, companyId, preset, today);
  checkRange(from, to);
  return { preset, from, to, compare, prior: comparisonRange(from, to, compare) };
}

/** Months of a range, clipped to it: [[from, to], ...]. */
function months(from: string, to: string) {
  const out: [string, string][] = [];
  for (let m = monthStart(from); m <= to; m = addMonths(m, 1)) out.push([m < from ? from : m, monthEnd(m) > to ? to : monthEnd(m)]);
  return out;
}

/**
 * Every KPI the user may see for the period, with the comparison. With spark,
 * each also carries its monthly values over the period (the last 12 months of it).
 */
export async function analyze(tx: Tx, ctx: Ctx, companyId: string, p: PeriodInput & { codes?: string[]; spark?: boolean }) {
  await authorize(tx, ctx, 'bi.dashboard', { unitId: companyId });
  const company = await companyHeader(tx, companyId);
  const per = await period(tx, companyId, p);
  for (const c of p.codes ?? []) kpiDef(c);
  const visible = await visibleKpis(tx, ctx, companyId);
  const chosen = p.codes?.length ? visible.filter((k) => p.codes!.includes(k.code)) : visible;
  const sparkMonths = months(per.from, per.to).slice(-12);
  const kpis = [];
  for (const k of chosen) {
    const value = await k.compute(tx, ctx, companyId, per.from, per.to);
    const prior = per.prior && !k.snapshot ? await k.compute(tx, ctx, companyId, per.prior[0], per.prior[1]) : null;
    let spark: { month: string; value: number | null }[] | null = null;
    if (p.spark && !k.snapshot && sparkMonths.length > 1) {
      spark = [];
      for (const [f, t] of sparkMonths) spark.push({ month: f.slice(0, 7), value: await k.compute(tx, ctx, companyId, f, t) });
    }
    kpis.push({ ...meta(k), value, prior, changePct: change(value, prior), verdict: judge(k, value, prior), spark });
  }
  return { company, period: per.preset, from: per.from, to: per.to, compare: per.compare, prior: per.prior, kpis, hidden: KPIS.length - visible.length };
}

// --- drill-down --------------------------------------------------------------------

interface Row { label: string; value: number }
interface Breakdown { key: string; title: string; unit: 'money' | 'count' | 'tco2e'; rows: (Row & { share: number | null })[] }
interface Records { title: string; columns: { key: string; label: string; type: 'text' | 'date' | 'money' | 'number' }[]; rows: Record<string, unknown>[]; total: number }

/** The largest rows, the rest folded into "Other", with each row's share of the total. */
function topRows(rows: Row[], n = 10): Breakdown['rows'] {
  const clean = rows.map((r) => ({ label: r.label, value: round2(num(r.value)) })).filter((r) => r.value !== 0).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const total = clean.reduce((s, r) => s + r.value, 0);
  const head = clean.slice(0, n);
  if (clean.length > n) head.push({ label: `Other (${clean.length - n})`, value: round2(clean.slice(n).reduce((s, r) => s + r.value, 0)) });
  return head.map((r) => ({ ...r, share: total ? Math.round((r.value / total) * 1000) / 10 : null }));
}
const bd = (key: string, title: string, rows: Row[], unit: Breakdown['unit'] = 'money'): Breakdown => ({ key, title, unit, rows: topRows(rows) });

const JL = `FROM fin.journal_lines l JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted'
  JOIN fin.accounts a ON a.id = l.account_id LEFT JOIN fin.accounts p ON p.id = a.parent_id`;

/** Sign +1 reads credit minus debit (income), -1 debit minus credit (costs, assets). */
async function flowBy(tx: Tx, co: string, from: string, to: string, where: string, sign: 1 | -1, by: 'account' | 'group' | 'center') {
  const label = by === 'account' ? `a.code || ' ' || a.name` : by === 'group' ? `coalesce(p.code || ' ' || p.name, 'No group')` : `coalesce(u.name, 'Not assigned')`;
  return (await many(tx, `SELECT ${label} AS label, ($4::int * sum(l.credit - l.debit))::float AS value ${JL}
      ${by === 'center' ? 'LEFT JOIN org.units u ON u.id = l.unit_id' : ''}
     WHERE j.type <> 'closing' AND j.company_id = $1 AND j.date BETWEEN $2 AND $3 AND (${where}) GROUP BY 1`, [co, from, to, sign])) as Row[];
}
async function levelBy(tx: Tx, co: string, asOf: string, where: string, sign: 1 | -1, by: 'account' | 'party') {
  const label = by === 'account' ? `a.code || ' ' || a.name` : `coalesce(pt.name, 'No party')`;
  return (await many(tx, `SELECT ${label} AS label, ($3::int * sum(l.debit - l.credit))::float AS value ${JL}
      ${by === 'party' ? 'LEFT JOIN mdm.parties pt ON pt.id = l.party_id' : ''}
     WHERE j.company_id = $1 AND j.date <= $2 AND (${where}) GROUP BY 1`, [co, asOf, sign])) as Row[];
}
async function lineRecords(tx: Tx, co: string, from: string, to: string, where: string, sign: 1 | -1, title: string, flowOnly = true): Promise<Records> {
  const rows = await many(tx, `SELECT j.date::text AS date, j.no, j.memo, a.code || ' ' || a.name AS account, pt.name AS party,
        ($4::int * (l.credit - l.debit))::float AS amount, count(*) OVER ()::int AS total ${JL}
      LEFT JOIN mdm.parties pt ON pt.id = l.party_id
     WHERE j.company_id = $1 AND j.date BETWEEN $2 AND $3 AND (${where}) ${flowOnly ? `AND j.type <> 'closing'` : ''}
     ORDER BY abs(l.credit - l.debit) DESC, j.date DESC LIMIT 50`, [co, from, to, sign]);
  return { title, total: rows[0]?.total ?? 0, columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'no', label: 'Journal', type: 'text' },
    { key: 'memo', label: 'Description', type: 'text' }, { key: 'account', label: 'Account', type: 'text' }, { key: 'party', label: 'Party', type: 'text' },
    { key: 'amount', label: 'Amount', type: 'money' }], rows: rows.map(({ total: _t, ...r }) => ({ ...r, amount: round2(r.amount) })) };
}

const OPEN = `LATERAL (SELECT i.gross_total - coalesce((SELECT sum(x.amount) FROM fin.allocations x WHERE x.invoice_id = i.id AND x.date <= $2), 0) AS open) o`;
async function openInvoices(tx: Tx, co: string, asOf: string, kind: 'sales_invoice' | 'purchase_invoice', overdueOnly: boolean, title: string): Promise<Records> {
  const rows = await many(tx, `SELECT i.no, i.supplier_ref, i.date::text AS date, i.due_date::text AS due_date, p.name AS party,
        CASE WHEN i.due_date < $2 THEN ($2::date - i.due_date) ELSE 0 END::int AS days_overdue, (o.open * i.fx_rate)::float AS open, count(*) OVER ()::int AS total
      FROM fin.invoices i JOIN mdm.parties p ON p.id = i.party_id, ${OPEN}
     WHERE i.company_id = $1 AND i.kind = $3 AND i.status = 'posted' AND i.date <= $2 AND o.open > 0 ${overdueOnly ? 'AND i.due_date < $2' : ''}
     ORDER BY o.open * i.fx_rate DESC LIMIT 50`, [co, asOf, kind]);
  return { title, total: rows[0]?.total ?? 0, columns: [{ key: 'no', label: kind === 'sales_invoice' ? 'Invoice' : 'Bill', type: 'text' },
    ...(kind === 'purchase_invoice' ? [{ key: 'supplier_ref', label: 'Supplier ref', type: 'text' as const }] : []),
    { key: 'party', label: kind === 'sales_invoice' ? 'Customer' : 'Supplier', type: 'text' }, { key: 'date', label: 'Date', type: 'date' },
    { key: 'due_date', label: 'Due', type: 'date' }, { key: 'days_overdue', label: 'Days overdue', type: 'number' }, { key: 'open', label: 'Open', type: 'money' }],
    rows: rows.map(({ total: _t, ...r }) => ({ ...r, open: round2(r.open) })) };
}
async function invoicesBy(tx: Tx, co: string, from: string, to: string, kinds: [string, string]) {
  return (await many(tx, `SELECT p.name AS label, sum(CASE WHEN i.kind = $5 THEN -1 ELSE 1 END * i.net_total * i.fx_rate)::float AS value
      FROM fin.invoices i JOIN mdm.parties p ON p.id = i.party_id
     WHERE i.company_id = $1 AND i.kind IN ($4, $5) AND i.status = 'posted' AND i.date BETWEEN $2 AND $3 GROUP BY 1`, [co, from, to, kinds[0], kinds[1]])) as Row[];
}
async function openBy(tx: Tx, co: string, asOf: string, kind: string, overdueOnly: boolean) {
  return (await many(tx, `SELECT p.name AS label, sum(o.open * i.fx_rate)::float AS value FROM fin.invoices i JOIN mdm.parties p ON p.id = i.party_id, ${OPEN}
     WHERE i.company_id = $1 AND i.kind = $3 AND i.status = 'posted' AND i.date <= $2 AND o.open > 0 ${overdueOnly ? 'AND i.due_date < $2' : ''} GROUP BY 1`, [co, asOf, kind])) as Row[];
}

type Drill = (tx: Tx, ctx: Ctx, co: string, from: string, to: string) => Promise<{ breakdowns: Breakdown[]; records: Records | null }>;

const profitWhere = `${ACC.revenue} OR ${ACC.direct} OR ${ACC.opex}`;
const grossWhere = `${ACC.revenue} OR ${ACC.direct}`;
const receivablesDrill: Drill = async (tx, _c, co, _f, to) => ({
  breakdowns: [bd('customer', 'By customer', await openBy(tx, co, to, 'sales_invoice', false))],
  records: await openInvoices(tx, co, to, 'sales_invoice', false, 'Open customer invoices') });
const payablesDrill: Drill = async (tx, _c, co, _f, to) => ({
  breakdowns: [bd('supplier', 'By supplier', await openBy(tx, co, to, 'purchase_invoice', false))],
  records: await openInvoices(tx, co, to, 'purchase_invoice', false, 'Open supplier bills') });

const DRILLS: Record<string, Drill> = {
  revenue: async (tx, _c, co, f, t) => ({
    breakdowns: [bd('customer', 'By customer (invoiced, net of VAT)', await invoicesBy(tx, co, f, t, ['sales_invoice', 'sales_credit'])),
      bd('account', 'By account', await flowBy(tx, co, f, t, ACC.revenue, 1, 'account')),
      bd('center', 'By profit center', await flowBy(tx, co, f, t, ACC.revenue, 1, 'center'))],
    records: await lineRecords(tx, co, f, t, ACC.revenue, 1, 'Revenue postings') }),
  gross_profit: async (tx, _c, co, f, t) => ({ breakdowns: [bd('account', 'Revenue and direct costs by account', await flowBy(tx, co, f, t, grossWhere, 1, 'account'))],
    records: await lineRecords(tx, co, f, t, grossWhere, 1, 'Revenue and direct cost postings') }),
  operating_expenses: async (tx, _c, co, f, t) => ({
    breakdowns: [bd('account', 'By account', await flowBy(tx, co, f, t, ACC.opex, -1, 'account')), bd('center', 'By cost center', await flowBy(tx, co, f, t, ACC.opex, -1, 'center'))],
    records: await lineRecords(tx, co, f, t, ACC.opex, -1, 'Expense postings') }),
  net_profit: async (tx, _c, co, f, t) => ({
    breakdowns: [bd('group', 'By account group (income less costs)', await flowBy(tx, co, f, t, profitWhere, 1, 'group')),
      bd('center', 'By profit or cost center', await flowBy(tx, co, f, t, profitWhere, 1, 'center'))],
    records: await lineRecords(tx, co, f, t, profitWhere, 1, 'Income and expense postings') }),
  cash: async (tx, _c, co, f, t) => ({ breakdowns: [bd('account', 'By bank and cash account', await levelBy(tx, co, t, ACC.cash, 1, 'account'))],
    records: await lineRecords(tx, co, f, t, ACC.cash, -1, 'Cash movements in the period (money in is positive)', false) }),
  receivables: receivablesDrill,
  dso: receivablesDrill,
  overdue_receivables: async (tx, _c, co, _f, t) => {
    const ages = await many(tx, `SELECT CASE WHEN $2::date - i.due_date <= 30 THEN '1 to 30 days' WHEN $2::date - i.due_date <= 60 THEN '31 to 60 days'
          WHEN $2::date - i.due_date <= 90 THEN '61 to 90 days' ELSE 'Over 90 days' END AS label, sum(o.open * i.fx_rate)::float AS value
        FROM fin.invoices i, ${OPEN} WHERE i.company_id = $1 AND i.kind = 'sales_invoice' AND i.status = 'posted' AND i.date <= $2 AND i.due_date < $2 AND o.open > 0 GROUP BY 1`, [co, t]);
    const order = ['1 to 30 days', '31 to 60 days', '61 to 90 days', 'Over 90 days'];
    const age = bd('age', 'By how late', ages as Row[]); age.rows.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
    return { breakdowns: [bd('customer', 'By customer', await openBy(tx, co, t, 'sales_invoice', true)), age],
      records: await openInvoices(tx, co, t, 'sales_invoice', true, 'Overdue customer invoices') };
  },
  payables: payablesDrill,
  dpo: payablesDrill,
  purchases: async (tx, _c, co, f, t) => {
    const rows = await many(tx, `SELECT i.no, i.supplier_ref, i.date::text AS date, p.name AS party,
          (CASE WHEN i.kind = 'purchase_credit' THEN -1 ELSE 1 END * i.net_total * i.fx_rate)::float AS net, count(*) OVER ()::int AS total
        FROM fin.invoices i JOIN mdm.parties p ON p.id = i.party_id
       WHERE i.company_id = $1 AND i.kind IN ('purchase_invoice','purchase_credit') AND i.status = 'posted' AND i.date BETWEEN $2 AND $3
       ORDER BY i.net_total * i.fx_rate DESC LIMIT 50`, [co, f, t]);
    return { breakdowns: [bd('supplier', 'By supplier', await invoicesBy(tx, co, f, t, ['purchase_invoice', 'purchase_credit']))],
      records: { title: 'Supplier bills and credit notes', total: rows[0]?.total ?? 0, columns: [{ key: 'no', label: 'Bill', type: 'text' }, { key: 'supplier_ref', label: 'Supplier ref', type: 'text' },
        { key: 'party', label: 'Supplier', type: 'text' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'net', label: 'Net', type: 'money' }],
      rows: rows.map(({ total: _t, ...r }) => ({ ...r, net: round2(r.net) })) } };
  },
  sales_orders: async (tx, _c, co, f, t) => {
    const where = `o.company_id = $1 AND o.date BETWEEN $2 AND $3 AND o.status IN ('confirmed','closed')`;
    const byCustomer = await many(tx, `SELECT p.name AS label, sum(o.net_total * o.fx_rate)::float AS value FROM sal.orders o JOIN mdm.parties p ON p.id = o.customer_id WHERE ${where} GROUP BY 1`, [co, f, t]);
    const byCenter = await many(tx, `SELECT coalesce(u.name, 'Not assigned') AS label, sum(o.net_total * o.fx_rate)::float AS value FROM sal.orders o LEFT JOIN org.units u ON u.id = o.selling_unit_id WHERE ${where} GROUP BY 1`, [co, f, t]);
    const rows = await many(tx, `SELECT o.no, o.date::text AS date, p.name AS party, o.status, (o.net_total * o.fx_rate)::float AS net, count(*) OVER ()::int AS total
        FROM sal.orders o JOIN mdm.parties p ON p.id = o.customer_id WHERE ${where} ORDER BY o.net_total * o.fx_rate DESC LIMIT 50`, [co, f, t]);
    return { breakdowns: [bd('customer', 'By customer', byCustomer as Row[]), bd('center', 'By profit center', byCenter as Row[])],
      records: { title: 'Sales orders', total: rows[0]?.total ?? 0, columns: [{ key: 'no', label: 'Order', type: 'text' }, { key: 'party', label: 'Customer', type: 'text' },
        { key: 'date', label: 'Date', type: 'date' }, { key: 'status', label: 'Status', type: 'text' }, { key: 'net', label: 'Net', type: 'money' }],
      rows: rows.map(({ total: _t, ...r }) => ({ ...r, net: round2(r.net) })) } };
  },
  inventory_value: async (tx, _c, co, f, t) => ({ breakdowns: [bd('account', 'By account', await levelBy(tx, co, t, ACC.inventory, 1, 'account'))],
    records: await lineRecords(tx, co, f, t, ACC.inventory, -1, 'Stock movements in the period (additions are positive)', false) }),
  payroll_cost: async (tx, _c, co, f, t) => ({
    breakdowns: [bd('account', 'By account', await flowBy(tx, co, f, t, ACC.payroll, -1, 'account')), bd('center', 'By cost center', await flowBy(tx, co, f, t, ACC.payroll, -1, 'center'))],
    records: await lineRecords(tx, co, f, t, ACC.payroll, -1, 'Payroll postings') }),
  headcount: async (tx, _c, co, _f, t) => {
    const rows = await many(tx, `SELECT e.employee_no, e.first_name || ' ' || e.last_name AS name, u.name AS department, k.start_date::text AS start_date, count(*) OVER ()::int AS total
        FROM hr.contracts k JOIN org.employees e ON e.id = k.employee_id JOIN org.units u ON u.id = e.unit_id
       WHERE k.company_id = $1 AND k.start_date <= $2 AND (k.end_date IS NULL OR k.end_date >= $2) ORDER BY u.name, e.last_name LIMIT 200`, [co, t]);
    const byDept = new Map<string, number>(); for (const r of rows) byDept.set(r.department, (byDept.get(r.department) ?? 0) + 1);
    return { breakdowns: [bd('department', 'By department', [...byDept].map(([label, value]) => ({ label, value })), 'count')],
      records: { title: 'Employees with a running contract', total: rows[0]?.total ?? 0, columns: [{ key: 'employee_no', label: 'No.', type: 'text' },
        { key: 'name', label: 'Name', type: 'text' }, { key: 'department', label: 'Department', type: 'text' }, { key: 'start_date', label: 'Contract from', type: 'date' }],
      rows: rows.slice(0, 50).map(({ total: _t, ...r }) => r) } };
  },
  fuel_cost: async (tx, _c, co, f, t) => {
    const where = `v.company_id = $1 AND l.date BETWEEN $2 AND $3`;
    const by = await many(tx, `SELECT v.code || ' ' || v.plate_no AS label, sum(l.amount - l.vat_amount)::float AS value FROM flt.fuel_logs l JOIN flt.vehicles v ON v.id = l.vehicle_id WHERE ${where} GROUP BY 1`, [co, f, t]);
    const rows = await many(tx, `SELECT l.date::text AS date, v.code || ' ' || v.plate_no AS vehicle, l.litres::float AS litres, l.station, (l.amount - l.vat_amount)::float AS net, count(*) OVER ()::int AS total
        FROM flt.fuel_logs l JOIN flt.vehicles v ON v.id = l.vehicle_id WHERE ${where} ORDER BY l.date DESC LIMIT 50`, [co, f, t]);
    return { breakdowns: [bd('vehicle', 'By vehicle', by as Row[])], records: { title: 'Fuel bought', total: rows[0]?.total ?? 0,
      columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'vehicle', label: 'Vehicle', type: 'text' }, { key: 'station', label: 'Station', type: 'text' },
        { key: 'litres', label: 'Litres', type: 'number' }, { key: 'net', label: 'Net cost', type: 'money' }], rows: rows.map(({ total: _t, ...r }) => ({ ...r, net: round2(r.net) })) } };
  },
  emissions: async (tx, _c, co, f, t) => {
    const e = await esgTotals(tx, co, f, t);
    return { breakdowns: [bd('scope', 'By scope', [{ label: 'Scope 1 (fuel, LPG, refrigerants)', value: e.scope1 }, { label: 'Scope 2 (purchased electricity)', value: e.scope2 }], 'tco2e')], records: null };
  },
};
DRILLS.gross_margin_pct = DRILLS.gross_profit;
DRILLS.net_margin_pct = DRILLS.net_profit;
DRILLS.inventory_turns = DRILLS.inventory_value;
DRILLS.revenue_per_employee = DRILLS.headcount;

/**
 * One KPI in depth: its value and comparison, the month-by-month line for the
 * period (with the comparison line), its breakdowns and the records behind it.
 * A period shorter than three months shows the six months up to its end, so
 * the line has context; the months inside the period are marked.
 */
export async function kpiDrill(tx: Tx, ctx: Ctx, companyId: string, code: string, p: PeriodInput) {
  await authorize(tx, ctx, 'bi.dashboard', { unitId: companyId });
  const k = kpiDef(code);
  await authorize(tx, ctx, k.permission, { unitId: companyId });
  const company = await companyHeader(tx, companyId);
  const per = await period(tx, companyId, p);
  const value = await k.compute(tx, ctx, companyId, per.from, per.to);
  const prior = per.prior && !k.snapshot ? await k.compute(tx, ctx, companyId, per.prior[0], per.prior[1]) : null;
  let trend = null;
  if (!k.snapshot) {
    const n = monthCount(per.from, per.to);
    const start = n < 3 ? addMonths(monthStart(per.to), -5) : per.from;
    const shift = per.compare === 'previous_year' ? 12 : n;
    const back = (d: string) => { const m = addMonths(monthStart(d), -shift); const last = Number(monthEnd(m).slice(8)); return `${m.slice(0, 8)}${String(Math.min(Number(d.slice(8)), last)).padStart(2, '0')}`; };
    trend = [];
    for (const [f, t] of months(start < per.from ? start : per.from, per.to)) {
      const inRange = t >= per.from;
      const from = inRange && f < per.from ? per.from : f, to = t;
      let cmp: number | null = null;
      if (per.compare !== 'none') cmp = await k.compute(tx, ctx, companyId, back(from), to === monthEnd(to) ? monthEnd(back(to)) : back(to));
      trend.push({ month: f.slice(0, 7), from, to, inRange, value: await k.compute(tx, ctx, companyId, from, to), compare: cmp });
    }
  }
  const drill = DRILLS[k.code];
  const detail = drill ? await drill(tx, ctx, companyId, per.from, per.to) : { breakdowns: [], records: null };
  return { company, kpi: meta(k), period: per.preset, from: per.from, to: per.to, compare: per.compare, prior: per.prior,
    value, priorValue: prior, changePct: change(value, prior), verdict: judge(k, value, prior), trend, ...detail };
}

// --- personal layout ------------------------------------------------------------------

export const DEFAULT_TILES = ['revenue', 'gross_margin_pct', 'net_profit', 'cash', 'receivables', 'overdue_receivables', 'payables', 'sales_orders',
  'inventory_value', 'headcount', 'payroll_cost', 'tickets_open'];
export interface Layout { tiles: string[]; period: Preset; compare: Compare; from?: string | null; to?: string | null }

export async function getLayout(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'bi.dashboard', { unitId: companyId });
  const visible = new Set((await visibleKpis(tx, ctx, companyId)).map((k) => k.code));
  const row = await one(tx, 'SELECT layout, updated_at FROM bi.dashboard_layouts WHERE user_id = $1 AND company_id = $2', [ctx.userId, companyId]);
  const saved = row?.layout as Layout | undefined;
  let tiles = (saved?.tiles ?? DEFAULT_TILES).filter((c) => visible.has(c));
  // Someone who sees few of the default KPIs starts with the ones they can see.
  if (!saved && tiles.length < 4) tiles = [...tiles, ...[...visible].filter((c) => !tiles.includes(c))].slice(0, 12);
  return { tiles, period: saved?.period ?? 'this_month', compare: saved?.compare ?? 'previous_period', from: saved?.from ?? null, to: saved?.to ?? null,
    saved: !!row, available: KPIS.filter((k) => visible.has(k.code)).map(meta) };
}

export async function saveLayout(tx: Tx, ctx: Ctx, companyId: string, input: Layout) {
  await authorize(tx, ctx, 'bi.dashboard', { unitId: companyId });
  if (!Array.isArray(input.tiles) || input.tiles.length > 30) throw new ValidationError('choose at most 30 tiles');
  if (new Set(input.tiles).size !== input.tiles.length) throw new ValidationError('a KPI appears twice');
  for (const c of input.tiles) kpiDef(c);
  if (!PRESETS.includes(input.period)) throw new ValidationError(`unknown period ${input.period}`);
  if (!COMPARES.includes(input.compare)) throw new ValidationError(`unknown comparison ${input.compare}`);
  let from = null, to = null;
  if (input.period === 'custom') { if (!input.from || !input.to) throw new ValidationError('a custom period needs from and to dates'); checkRange(input.from, input.to); [from, to] = [input.from, input.to]; }
  const layout = { tiles: input.tiles, period: input.period, compare: input.compare, from, to };
  await one(tx, `INSERT INTO bi.dashboard_layouts (tenant_id, user_id, company_id, layout) VALUES (app.tenant(), $1, $2, $3)
      ON CONFLICT (tenant_id, user_id, company_id) DO UPDATE SET layout = EXCLUDED.layout, updated_at = now() RETURNING id`, [ctx.userId, companyId, JSON.stringify(layout)]);
  return getLayout(tx, ctx, companyId);
}

export async function resetLayout(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'bi.dashboard', { unitId: companyId });
  await many(tx, 'DELETE FROM bi.dashboard_layouts WHERE user_id = $1 AND company_id = $2', [ctx.userId, companyId]);
  return getLayout(tx, ctx, companyId);
}
