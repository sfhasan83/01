import { one, type Ctx, type Tx } from '../core/db.ts';
import { ValidationError } from '../core/errors.ts';
import * as kpi from '../bi/kpi.ts';
import * as dash from '../bi/dashboard.ts';
import * as rep from '../bi/reports.ts';
import * as esg from '../bi/esg.ts';
import * as anom from '../bi/anomaly.ts';
import * as strat from '../bi/strategy.ts';
import * as finrep from '../fin/reports.ts';
import * as inv from '../inv/service.ts';
import * as mdm from '../mdm/service.ts';
import * as svc from '../corp/svc.ts';

/**
 * What the assistant can do. Every tool calls the same service the screens use,
 * with the user's own identity, so permission checks, unit scoping and the audit
 * trail apply unchanged: the assistant can never see or do more than the user.
 *
 * kind 'read' tools run as soon as the model asks. kind 'change' tools never run
 * on the model's say-so: they are shown to the user, who confirms or rejects.
 */

export type JsonSchema = Record<string, unknown>;
export interface ToolEnv { companyId: string; today: string }
export interface ToolDef {
  name: string;
  description: string;
  kind: 'read' | 'change';
  schema: JsonSchema;
  run(tx: Tx, ctx: Ctx, env: ToolEnv, input: any): Promise<unknown>;
  /** One line for the confirmation card of a change. */
  summary?(input: any): string;
}

const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD' };
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema =>
  ({ type: 'object', properties, required, additionalProperties: false });

export const TOOLS: ToolDef[] = [
  {
    name: 'list_kpis', kind: 'read',
    description: 'List the KPIs this user may see for the company (code, name, unit, whether higher is better). Call this before get_kpi when unsure of a code.',
    schema: obj({}),
    run: (tx, ctx, env) => kpi.kpiCatalog(tx, ctx, env.companyId),
  },
  {
    name: 'get_kpi', kind: 'read',
    description: 'Value of one KPI for a period. Flow KPIs (revenue, expenses) cover from..to; level KPIs (cash, receivables) are the position at "to".',
    schema: obj({ code: { type: 'string' }, from: date, to: date }, ['code', 'from', 'to']),
    run: async (tx, ctx, env, i) => ({ code: i.code, ...pick(kpi.kpiDef(i.code)), from: i.from, to: i.to, value: await kpi.kpiValue(tx, ctx, env.companyId, i.code, i.from, i.to) }),
  },
  {
    name: 'kpi_trend', kind: 'read',
    description: 'Monthly values of one KPI for the last N months up to as_of (default today, 12 months).',
    schema: obj({ code: { type: 'string' }, as_of: date, months: { type: 'integer', minimum: 2, maximum: 36 } }, ['code']),
    run: (tx, ctx, env, i) => kpi.kpiTrend(tx, ctx, env.companyId, i.code, i.as_of ?? env.today, i.months ?? 12),
  },
  {
    name: 'kpi_breakdown', kind: 'read',
    description: 'One KPI in depth for a period: its value against a comparison period, the month-by-month line, breakdowns (by customer, supplier, account, cost center, vehicle, department or age) and the largest records behind it. Use it to explain why a KPI moved.',
    schema: obj({ code: { type: 'string' }, from: date, to: date, compare: { enum: ['previous_period', 'previous_year', 'none'] } }, ['code', 'from', 'to']),
    run: (tx, ctx, env, i) => dash.kpiDrill(tx, ctx, env.companyId, i.code, { from: i.from, to: i.to, compare: i.compare ?? 'previous_period', today: env.today }),
  },
  {
    name: 'executive_dashboard', kind: 'read',
    description: 'The executive dashboard: month-to-date and year-to-date KPIs against the prior period, top customers and overdue receivables.',
    schema: obj({ as_of: date }),
    run: (tx, ctx, env, i) => kpi.dashboard(tx, ctx, env.companyId, i.as_of ?? env.today),
  },
  {
    name: 'trial_balance', kind: 'read',
    description: 'Trial balance by account up to a date, optionally showing movements from a start date.',
    schema: obj({ to: date, from: date }, ['to']),
    run: (tx, ctx, env, i) => finrep.trialBalance(tx, ctx, env.companyId, i.to, i.from),
  },
  {
    name: 'profit_and_loss', kind: 'read',
    description: 'Profit and loss statement for a period.',
    schema: obj({ from: date, to: date }, ['from', 'to']),
    run: (tx, ctx, env, i) => finrep.profitAndLoss(tx, ctx, env.companyId, i.from, i.to),
  },
  {
    name: 'balance_sheet', kind: 'read',
    description: 'Balance sheet at a date.',
    schema: obj({ as_of: date }, ['as_of']),
    run: (tx, ctx, env, i) => finrep.balanceSheet(tx, ctx, env.companyId, i.as_of),
  },
  {
    name: 'ageing', kind: 'read',
    description: 'Receivables or payables ageing by partner at a date, with open documents and days overdue.',
    schema: obj({ side: { enum: ['receivable', 'payable'] }, as_of: date }, ['side']),
    run: (tx, ctx, env, i) => finrep.ageing(tx, ctx, env.companyId, i.side, i.as_of ?? env.today),
  },
  {
    name: 'find_partners', kind: 'read',
    description: 'Find customers or suppliers by part of their name or code.',
    schema: obj({ text: { type: 'string', minLength: 1 }, type: { enum: ['customer', 'supplier'] } }, ['text']),
    run: async (tx, ctx, _env, i) => {
      const q = String(i.text).toLowerCase();
      return (await mdm.listParties(tx, ctx, { type: i.type })).filter((p: any) => p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q))
        .slice(0, 25).map((p: any) => ({ id: p.id, code: p.code, name: p.name, customer: p.is_customer, supplier: p.is_supplier, status: p.status, creditLimit: p.credit_limit }));
    },
  },
  {
    name: 'stock_levels', kind: 'read',
    description: 'Stock on hand by item and warehouse with value and average cost. Optionally filter by text in the item code or name.',
    schema: obj({ text: { type: 'string' } }),
    run: async (tx, ctx, env, i) => {
      const q = (i.text ?? '').toLowerCase();
      const rows = await inv.stockLevels(tx, ctx, env.companyId);
      return rows.filter((r: any) => !q || r.item_code.toLowerCase().includes(q) || r.item_name.toLowerCase().includes(q)).slice(0, 200);
    },
  },
  {
    name: 'list_datasets', kind: 'read',
    description: 'The report-builder datasets this user may query, with their fields. Call before run_report.',
    schema: obj({}),
    run: (tx, ctx) => rep.datasetCatalog(tx, ctx),
  },
  {
    name: 'run_report', kind: 'read',
    description: 'Run an ad hoc report on a dataset: pick columns, or groupBy with measures (sum/avg/min/max/count), plus filters and sort. Use field keys from list_datasets.',
    schema: obj({ dataset: { type: 'string' }, spec: rep.REPORT_SPEC_SCHEMA as JsonSchema }, ['dataset', 'spec']),
    run: (tx, ctx, _env, i) => rep.runReport(tx, ctx, i.dataset, { limit: 200, ...i.spec }),
  },
  {
    name: 'anomaly_checks', kind: 'read',
    description: 'Run the anomaly checks on the books for a period (duplicate bills, weekend and late postings, round amounts, Benford test and others).',
    schema: obj({ from: date, to: date }, ['from', 'to']),
    run: (tx, ctx, env, i) => anom.anomalyScan(tx, ctx, env.companyId, i.from, i.to),
  },
  {
    name: 'esg_report', kind: 'read',
    description: 'Scope 1 and 2 emissions, energy, water and waste for a period, with intensity figures.',
    schema: obj({ from: date, to: date }, ['from', 'to']),
    run: async (tx, ctx, env, i) => { const r: any = await esg.esgReport(tx, ctx, env.companyId, i.from, i.to); delete r.factors; return r; },
  },
  {
    name: 'strategy_scorecard', kind: 'read',
    description: 'The strategy scorecard for a year: objectives, KPI targets, actuals, projections and red/amber/green status.',
    schema: obj({ year: { type: 'integer', minimum: 2000, maximum: 2100 } }, ['year']),
    run: (tx, ctx, env, i) => strat.scorecard(tx, ctx, env.companyId, i.year, env.today),
  },
  {
    name: 'my_tickets', kind: 'read',
    description: 'Service desk tickets the user raised or can see, optionally by status.',
    schema: obj({ status: { enum: ['new', 'assigned', 'in_progress', 'waiting', 'resolved', 'closed'] } }),
    run: async (tx, ctx, _env, i) => (await svc.listTickets(tx, ctx, { status: i.status })).slice(0, 50).map((t: any) => ({
      no: t.no, title: t.title, queue: t.queue, priority: t.priority, status: t.status, requester: t.requester, assignee: t.assignee,
      created: t.created_at, resolutionDue: t.resolution_due, responseBreached: t.response_breached, resolutionBreached: t.resolution_breached })),
  },
  // --- Changes: shown to the user, run only after they confirm ---------------------
  {
    name: 'create_ticket', kind: 'change',
    description: 'Raise a service desk ticket for the user. Priority 1 is critical, 4 is low.',
    schema: obj({ queue: { enum: ['it', 'facilities', 'hr', 'finance'] }, category: { type: 'string', minLength: 1 }, priority: { type: 'integer', minimum: 1, maximum: 4 },
      title: { type: 'string', minLength: 3, maxLength: 200 }, description: { type: 'string', minLength: 1, maxLength: 4000 } }, ['queue', 'category', 'priority', 'title', 'description']),
    summary: (i) => `Raise a P${i.priority} ${i.queue} ticket: "${i.title}"`,
    run: async (tx, ctx, _env, i) => { const t = await svc.createTicket(tx, ctx, i); return { id: t.id, no: t.no, status: t.status, resolutionDue: t.resolution_due }; },
  },
  {
    name: 'record_esg_reading', kind: 'change',
    description: 'Record or correct one month\'s ESG meter reading for the company (electricity, solar, water, waste, recycled waste, LPG, refrigerant).',
    schema: obj({ month: { type: 'string', pattern: '^\\d{4}-\\d{2}$', description: 'YYYY-MM' }, metric: { enum: [...esg.METRICS] }, value: { type: 'number', minimum: 0 }, note: { type: 'string' } },
      ['month', 'metric', 'value']),
    summary: (i) => `Record ${i.metric.replace(/_/g, ' ')} = ${i.value} for ${i.month}`,
    run: async (tx, ctx, env, i) => { const r = await esg.recordReading(tx, ctx, env.companyId, i); return { id: r.id, month: i.month, metric: r.metric, value: Number(r.value) }; },
  },
  {
    name: 'save_report', kind: 'change',
    description: 'Save a report definition (dataset and spec) to the user\'s saved reports, optionally shared with colleagues.',
    schema: obj({ name: { type: 'string', minLength: 1, maxLength: 120 }, description: { type: 'string' }, dataset: { type: 'string' }, spec: rep.REPORT_SPEC_SCHEMA as JsonSchema, shared: { type: 'boolean' } },
      ['name', 'dataset', 'spec']),
    summary: (i) => `Save the report "${i.name}" on ${i.dataset}${i.shared ? ', shared with colleagues' : ''}`,
    run: async (tx, ctx, _env, i) => { const r = await rep.saveReport(tx, ctx, i); return { id: r.id, name: r.name }; },
  },
];

const pick = (k: kpi.KpiDef) => ({ name: k.name, unit: k.unit, better: k.better, kind: k.kind });

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Validate a tool input against its schema (the subset of JSON Schema used above). */
export function validate(schema: any, v: unknown, path = 'input'): string | null {
  if (schema.enum) return (schema.enum as unknown[]).includes(v) ? null : `${path} must be one of ${schema.enum.join(', ')}`;
  switch (schema.type) {
    case 'object': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return `${path} must be an object`;
      for (const r of schema.required ?? []) if ((v as any)[r] === undefined) return `${path}.${r} is required`;
      for (const [k, x] of Object.entries(v)) {
        const s = schema.properties?.[k];
        if (!s) { if (schema.additionalProperties === false) return `${path}.${k} is not allowed`; continue; }
        const e = validate(s, x, `${path}.${k}`);
        if (e) return e;
      }
      return null;
    }
    case 'array':
      if (!Array.isArray(v)) return `${path} must be a list`;
      if (schema.maxItems !== undefined && v.length > schema.maxItems) return `${path} has more than ${schema.maxItems} items`;
      for (let n = 0; n < v.length; n++) { const e = validate(schema.items ?? {}, v[n], `${path}[${n}]`); if (e) return e; }
      return null;
    case 'string':
      if (typeof v !== 'string') return `${path} must be text`;
      if (schema.minLength !== undefined && v.length < schema.minLength) return `${path} is too short`;
      if (schema.maxLength !== undefined && v.length > schema.maxLength) return `${path} is too long`;
      if (schema.pattern && !new RegExp(schema.pattern).test(v)) return `${path} must look like ${schema.description ?? schema.pattern}`;
      return null;
    case 'integer': case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v) || (schema.type === 'integer' && !Number.isInteger(v))) return `${path} must be a ${schema.type}`;
      if (schema.minimum !== undefined && v < schema.minimum) return `${path} must be at least ${schema.minimum}`;
      if (schema.maximum !== undefined && v > schema.maximum) return `${path} must be at most ${schema.maximum}`;
      return null;
    case 'boolean':
      return typeof v === 'boolean' ? null : `${path} must be true or false`;
    default:
      return null;
  }
}

/** Company facts for the assistant's context. */
export async function companyFacts(tx: Tx, companyId: string) {
  return one(tx, `SELECT u.name, u.code, c.legal_name, c.country_code, c.base_currency, c.fiscal_year_start_month
                    FROM org.units u LEFT JOIN fin.companies c ON c.unit_id = u.id WHERE u.id = $1`, [companyId]);
}
