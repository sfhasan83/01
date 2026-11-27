import { ForbiddenError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize, unitScope } from '../iam/authz.ts';

/**
 * Report builder. Users pick a dataset from a governed catalogue, then columns,
 * grouping, totals, filters and sort. Only catalogue fields reach SQL (as
 * fixed expressions); every value is a bound parameter. Each dataset names the
 * permission that guards it and the org-unit column its rows belong to, so a
 * report only ever returns rows from units the user's roles cover.
 */

type FieldType = 'text' | 'date' | 'number' | 'money' | 'boolean';
interface Field { label: string; expr: string; type: FieldType }
interface Dataset { name: string; description: string; permission: string; unitColumn: string; from: string; where?: string; fields: Record<string, Field> }

const f = (label: string, expr: string, type: FieldType = 'text'): Field => ({ label, expr, type });
const MONTH = (col: string) => f('Month', `to_char(${col}, 'YYYY-MM')`);

export const DATASETS: Record<string, Dataset> = {
  gl_lines: {
    name: 'General ledger lines', description: 'Every posted journal line with its account, dimensions and party', permission: 'fin.report.read', unitColumn: 'j.company_id',
    from: `fin.journal_lines l JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' JOIN fin.accounts a ON a.id = l.account_id
           LEFT JOIN fin.accounts pa ON pa.id = a.parent_id LEFT JOIN org.units cc ON cc.id = l.unit_id LEFT JOIN prj.projects pr ON pr.id = l.project_id
           LEFT JOIN mdm.parties pt ON pt.id = l.party_id JOIN org.units co ON co.id = j.company_id`,
    fields: {
      company: f('Company', 'co.code'), journal_no: f('Journal', 'j.no'), journal_type: f('Journal type', 'j.type'), date: f('Date', 'j.date', 'date'), month: MONTH('j.date'),
      account_code: f('Account', 'a.code'), account_name: f('Account name', 'a.name'), account_type: f('Account type', 'a.type'), account_group: f('Account group', 'pa.name'),
      cost_center: f('Cost center', 'cc.code'), project: f('Project', 'pr.code'), party: f('Party', 'pt.name'), memo: f('Memo', 'j.memo'), description: f('Line text', 'l.description'),
      debit: f('Debit', 'l.debit', 'money'), credit: f('Credit', 'l.credit', 'money'), net: f('Debit less credit', '(l.debit - l.credit)', 'money'),
    },
  },
  sales_invoices: {
    name: 'Sales invoices', description: 'Posted customer invoices and credit notes, amounts in base currency', permission: 'fin.report.read', unitColumn: 'i.company_id',
    from: `fin.invoices i JOIN mdm.parties p ON p.id = i.party_id JOIN org.units co ON co.id = i.company_id`,
    where: `i.kind IN ('sales_invoice','sales_credit') AND i.status = 'posted'`,
    fields: {
      company: f('Company', 'co.code'), no: f('Number', 'i.no'), kind: f('Kind', 'i.kind'), date: f('Date', 'i.date', 'date'), month: MONTH('i.date'), due_date: f('Due', 'i.due_date', 'date'),
      customer: f('Customer', 'p.name'), customer_country: f('Customer country', 'p.country_code'), currency: f('Currency', 'i.currency'),
      net: f('Net (base)', `(CASE WHEN i.kind = 'sales_credit' THEN -1 ELSE 1 END * i.net_total * i.fx_rate)`, 'money'),
      vat: f('VAT (base)', `(CASE WHEN i.kind = 'sales_credit' THEN -1 ELSE 1 END * i.tax_total * i.fx_rate)`, 'money'),
      gross: f('Gross (base)', `(CASE WHEN i.kind = 'sales_credit' THEN -1 ELSE 1 END * i.gross_total * i.fx_rate)`, 'money'),
      open: f('Unpaid (document currency)', `(i.gross_total - coalesce((SELECT sum(x.amount) FROM fin.allocations x WHERE x.invoice_id = i.id), 0))`, 'money'),
      days_overdue: f('Days overdue', 'greatest(0, current_date - i.due_date)', 'number'),
    },
  },
  purchase_invoices: {
    name: 'Supplier bills', description: 'Posted supplier bills and credit notes, amounts in base currency', permission: 'fin.report.read', unitColumn: 'i.company_id',
    from: `fin.invoices i JOIN mdm.parties p ON p.id = i.party_id JOIN org.units co ON co.id = i.company_id`,
    where: `i.kind IN ('purchase_invoice','purchase_credit') AND i.status = 'posted'`,
    fields: {
      company: f('Company', 'co.code'), no: f('Number', 'i.no'), supplier_ref: f('Supplier reference', 'i.supplier_ref'), kind: f('Kind', 'i.kind'),
      date: f('Date', 'i.date', 'date'), month: MONTH('i.date'), due_date: f('Due', 'i.due_date', 'date'), supplier: f('Supplier', 'p.name'), currency: f('Currency', 'i.currency'),
      net: f('Net (base)', `(CASE WHEN i.kind = 'purchase_credit' THEN -1 ELSE 1 END * i.net_total * i.fx_rate)`, 'money'),
      vat: f('VAT (base)', `(CASE WHEN i.kind = 'purchase_credit' THEN -1 ELSE 1 END * i.tax_total * i.fx_rate)`, 'money'),
      gross: f('Gross (base)', `(CASE WHEN i.kind = 'purchase_credit' THEN -1 ELSE 1 END * i.gross_total * i.fx_rate)`, 'money'),
    },
  },
  stock: {
    name: 'Stock on hand', description: 'Quantity and value per item and warehouse', permission: 'inv.read', unitColumn: 'w.company_id',
    from: `inv.stock s JOIN inv.warehouses w ON w.id = s.warehouse_id JOIN mdm.items it ON it.id = s.item_id`,
    fields: {
      warehouse: f('Warehouse', 'w.code'), item_code: f('Item', 'it.code'), item_name: f('Item name', 'it.name'), item_type: f('Item type', 'it.item_type'),
      qty: f('Quantity', 's.qty', 'number'), value: f('Value', 's.value', 'money'), unit_cost: f('Average cost', 'CASE WHEN s.qty <> 0 THEN round(s.value / s.qty, 4) END', 'money'),
    },
  },
  sales_orders: {
    name: 'Sales orders', description: 'Quotations and orders with their customer and status', permission: 'sal.order.manage', unitColumn: 'o.company_id',
    from: `sal.orders o JOIN mdm.parties p ON p.id = o.customer_id`,
    fields: {
      no: f('Order', 'o.no'), quote_no: f('Quotation', 'o.quote_no'), date: f('Date', 'o.date', 'date'), month: MONTH('o.date'), customer: f('Customer', 'p.name'),
      status: f('Status', 'o.status'), currency: f('Currency', 'o.currency'), net: f('Net (base)', '(o.net_total * o.fx_rate)', 'money'),
    },
  },
  payslips: {
    name: 'Payslips', description: 'Payroll results per employee and month', permission: 'hr.payroll.run', unitColumn: 'r.company_id',
    from: `hr.payslips s JOIN hr.payroll_runs r ON r.id = s.run_id JOIN org.employees e ON e.id = s.employee_id LEFT JOIN org.units u ON u.id = s.unit_id`,
    fields: {
      period: f('Period', 'r.period'), run_status: f('Run status', 'r.status'), employee_no: f('Employee no.', 'e.employee_no'), employee: f('Employee', `e.first_name || ' ' || e.last_name`),
      unit: f('Unit', 'u.code'), basic: f('Basic', 's.basic', 'money'), allowances: f('Allowances', 's.allowances', 'money'), additions: f('Additions', 's.additions', 'money'),
      deductions: f('Deductions', 's.deductions', 'money'), gross: f('Gross', 's.gross', 'money'), net: f('Net', 's.net', 'money'), unpaid_leave_days: f('Unpaid leave days', 's.unpaid_leave_days', 'number'),
    },
  },
  tickets: {
    name: 'Service tickets', description: 'Service desk tickets with their SLA outcome', permission: 'svc.agent', unitColumn: 't.unit_id',
    from: `svc.tickets t JOIN iam.users r ON r.id = t.requester_user_id LEFT JOIN iam.users g ON g.id = t.assignee_user_id`,
    fields: {
      no: f('Ticket', 't.no'), queue: f('Queue', 't.queue'), category: f('Category', 't.category'), priority: f('Priority', 't.priority', 'number'), status: f('Status', 't.status'),
      raised: f('Raised', 't.created_at::date', 'date'), month: MONTH('t.created_at'), requester: f('Requester', 'r.display_name'), assignee: f('Assignee', 'g.display_name'),
      hours_to_resolve: f('Hours to resolve', 'round((extract(epoch FROM t.resolved_at - t.created_at) / 3600)::numeric, 1)', 'number'),
      resolved_late: f('Resolved late', '(t.resolved_at > t.resolution_due)', 'boolean'), satisfaction: f('Satisfaction', 't.satisfaction', 'number'),
    },
  },
  incidents: {
    name: 'Safety incidents', description: 'Incidents and near misses', permission: 'hse.manage', unitColumn: 'i.unit_id',
    from: `hse.incidents i JOIN org.units u ON u.id = i.unit_id`,
    fields: {
      no: f('Incident', 'i.no'), date: f('Date', 'i.occurred_at::date', 'date'), month: MONTH('i.occurred_at'), unit: f('Unit', 'u.code'), kind: f('Kind', 'i.kind'),
      severity: f('Severity', 'i.severity'), location: f('Location', 'i.location'), status: f('Status', 'i.status'), lost_days: f('Days lost', 'i.lost_days', 'number'),
    },
  },
  timesheets: {
    name: 'Timesheets', description: 'Hours logged on projects', permission: 'prj.manage', unitColumn: 'p.company_id',
    from: `prj.timesheets t JOIN prj.projects p ON p.id = t.project_id JOIN org.employees e ON e.id = t.employee_id`,
    fields: {
      project: f('Project', 'p.code'), project_name: f('Project name', 'p.name'), employee: f('Employee', `e.first_name || ' ' || e.last_name`), date: f('Date', 't.date', 'date'),
      month: MONTH('t.date'), status: f('Status', 't.status'), hours: f('Hours', 't.hours', 'number'), cost: f('Cost', 't.cost', 'money'), billable: f('Billable', 't.billable', 'boolean'),
    },
  },
};

const AGGS = ['sum', 'avg', 'min', 'max', 'count'] as const;
const OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'is_empty', 'not_empty'] as const;
export interface ReportSpec {
  columns?: string[];
  groupBy?: string[];
  measures?: { field: string; agg: typeof AGGS[number] }[];
  filters?: { field: string; op: typeof OPS[number]; value?: unknown }[];
  sort?: { by: string; dir?: 'asc' | 'desc' }[];
  limit?: number;
}

export async function datasetCatalog(tx: Tx, ctx: Ctx) {
  const out = [];
  for (const [code, d] of Object.entries(DATASETS)) {
    const s = await unitScope(tx, ctx.userId!, d.permission, 'x', 1);
    if (!s.param.length) continue;
    out.push({ code, name: d.name, description: d.description, fields: Object.entries(d.fields).map(([k, v]) => ({ key: k, label: v.label, type: v.type })) });
  }
  return out;
}

const castFor = (t: FieldType) => (t === 'date' ? '::date' : t === 'number' || t === 'money' ? '::numeric' : t === 'boolean' ? '::boolean' : '::text');

/** Turn a spec into SQL over the catalogue, refusing anything that is not in it. */
export function compile(dataset: string, spec: ReportSpec, scopeSql: string) {
  const d = DATASETS[dataset];
  if (!d) throw new ValidationError(`unknown dataset ${dataset}`);
  const field = (k: string) => { const x = d.fields[k]; if (!x) throw new ValidationError(`${d.name} has no field ${k}`); return x; };
  const params: unknown[] = [];
  const bind = (v: unknown, t: FieldType) => { params.push(v); return `$${params.length + 1}${castFor(t)}`; };   // $1 is the unit scope
  const groupBy = spec.groupBy ?? [];
  const measures = spec.measures ?? [];
  if (measures.length && !groupBy.length && spec.columns?.length) throw new ValidationError('with totals, choose the fields to group by instead of plain columns');
  const select: string[] = [];
  const names: { key: string; label: string; type: FieldType }[] = [];
  if (groupBy.length || measures.length) {
    for (const k of groupBy) { const x = field(k); select.push(`${x.expr} AS "${k}"`); names.push({ key: k, label: x.label, type: x.type }); }
    for (const m of measures) {
      if (!(AGGS as readonly string[]).includes(m.agg)) throw new ValidationError(`unknown total ${m.agg}`);
      const x = field(m.field);
      if (m.agg !== 'count' && !['number', 'money'].includes(x.type)) throw new ValidationError(`${x.label} is not a number: only count it`);
      const key = `${m.agg}_${m.field}`;
      select.push(`${m.agg === 'count' ? `count(${x.expr})` : `round(${m.agg}(${x.expr})::numeric, 2)`} AS "${key}"`);
      names.push({ key, label: `${m.agg === 'avg' ? 'Average' : m.agg[0].toUpperCase() + m.agg.slice(1)} of ${x.label.toLowerCase()}`, type: m.agg === 'count' ? 'number' : x.type });
    }
  } else {
    const cols = spec.columns?.length ? spec.columns : Object.keys(d.fields).slice(0, 8);
    for (const k of cols) { const x = field(k); select.push(`${x.expr} AS "${k}"`); names.push({ key: k, label: x.label, type: x.type }); }
  }
  if (!select.length) throw new ValidationError('choose at least one column or total');
  const where = [scopeSql, ...(d.where ? [d.where] : [])];
  for (const flt of spec.filters ?? []) {
    const x = field(flt.field);
    if (!(OPS as readonly string[]).includes(flt.op)) throw new ValidationError(`unknown filter ${flt.op}`);
    const v = flt.value;
    switch (flt.op) {
      case 'eq': where.push(`${x.expr} = ${bind(v, x.type)}`); break;
      case 'ne': where.push(`${x.expr} IS DISTINCT FROM ${bind(v, x.type)}`); break;
      case 'gt': where.push(`${x.expr} > ${bind(v, x.type)}`); break;
      case 'gte': where.push(`${x.expr} >= ${bind(v, x.type)}`); break;
      case 'lt': where.push(`${x.expr} < ${bind(v, x.type)}`); break;
      case 'lte': where.push(`${x.expr} <= ${bind(v, x.type)}`); break;
      case 'contains': where.push(`${x.expr}::text ILIKE '%' || ${bind(String(v ?? ''), 'text')} || '%'`); break;
      case 'in': {
        if (!Array.isArray(v) || !v.length) throw new ValidationError(`give a list of values for ${x.label}`);
        params.push(v.map(String)); where.push(`${x.expr}::text = ANY($${params.length + 1}::text[])`); break;
      }
      case 'is_empty': where.push(`${x.expr} IS NULL`); break;
      case 'not_empty': where.push(`${x.expr} IS NOT NULL`); break;
    }
  }
  const order: string[] = [];
  for (const s of spec.sort ?? []) {
    if (!names.find((n) => n.key === s.by)) throw new ValidationError(`sort by a chosen column: ${s.by} is not one`);
    order.push(`"${s.by}" ${s.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`);
  }
  const limit = Math.min(Math.max(1, Math.floor(spec.limit ?? 1000)), 5000);
  const sql = `SELECT ${select.join(', ')} FROM ${d.from} WHERE ${where.join(' AND ')}`
    + (groupBy.length ? ` GROUP BY ${groupBy.map((k) => field(k).expr).join(', ')}` : '')
    + (order.length ? ` ORDER BY ${order.join(', ')}` : groupBy.length ? ` ORDER BY ${groupBy.map((_, i) => i + 1).join(', ')}` : '')
    + ` LIMIT ${limit + 1}`;
  return { sql, params, columns: names, limit };
}

export async function runReport(tx: Tx, ctx: Ctx, dataset: string, spec: ReportSpec) {
  const d = DATASETS[dataset];
  if (!d) throw new ValidationError(`unknown dataset ${dataset}`);
  const scope = await unitScope(tx, ctx.userId!, d.permission, d.unitColumn, 1);
  if (!scope.param.length) throw new ForbiddenError(d.permission, {}, `you cannot report on ${d.name.toLowerCase()}`);
  const q = compile(dataset, spec, scope.sql);
  const rows = await many(tx, q.sql, [scope.param, ...q.params]);
  const truncated = rows.length > q.limit;
  const data = rows.slice(0, q.limit).map((r) => Object.fromEntries(q.columns.map((c) => {
    const v = r[c.key];
    return [c.key, v instanceof Date ? v.toISOString().slice(0, 10) : (c.type === 'money' || c.type === 'number') && v !== null ? Number(v) : v];
  })));
  const totals = Object.fromEntries(q.columns.filter((c) => c.type === 'money' || (c.type === 'number' && c.key.startsWith('count_'))).map((c) => [c.key, Math.round(data.reduce((s, r) => s + (Number(r[c.key]) || 0), 0) * 100) / 100]));
  return { dataset, columns: q.columns, rows: data, totals, truncated };
}

/** CSV with a header row; formulas are neutralised so a spreadsheet cannot execute cell text. */
export function toCsv(result: { columns: { key: string; label: string }[]; rows: Record<string, unknown>[] }) {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [result.columns.map((c) => cell(c.label)).join(','), ...result.rows.map((r) => result.columns.map((c) => cell(r[c.key])).join(','))].join('\r\n') + '\r\n';
}

function checkSpec(dataset: string, spec: ReportSpec) { compile(dataset, spec, 'true'); }

export async function saveReport(tx: Tx, ctx: Ctx, input: { name: string; description?: string; dataset: string; spec: ReportSpec; shared?: boolean }) {
  await authorize(tx, ctx, 'bi.report.manage', {});
  checkSpec(input.dataset, input.spec);
  if (!input.name?.trim()) throw new ValidationError('name the report');
  return one(tx, `INSERT INTO bi.reports (tenant_id, name, description, dataset, spec, shared, owner_user_id) VALUES (app.tenant(), $1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.name.trim(), input.description ?? null, input.dataset, JSON.stringify(input.spec), input.shared ?? false, ctx.userId]);
}

async function ownReport(tx: Tx, ctx: Ctx, id: string) {
  const r = await one(tx, 'SELECT * FROM bi.reports WHERE id = $1 FOR UPDATE', [id]);
  if (!r) throw new NotFoundError('report');
  if (r.owner_user_id !== ctx.userId) throw new ForbiddenError('bi.report.manage', {}, 'only the owner can change or delete a report');
  return r;
}

export async function updateReport(tx: Tx, ctx: Ctx, id: string, input: { name?: string; description?: string; spec?: ReportSpec; shared?: boolean }) {
  const r = await ownReport(tx, ctx, id);
  if (input.spec) checkSpec(r.dataset, input.spec);
  return one(tx, `UPDATE bi.reports SET name = coalesce($2, name), description = coalesce($3, description), spec = coalesce($4, spec), shared = coalesce($5, shared), updated_at = now()
                  WHERE id = $1 RETURNING *`, [id, input.name ?? null, input.description ?? null, input.spec ? JSON.stringify(input.spec) : null, input.shared ?? null]);
}

export async function deleteReport(tx: Tx, ctx: Ctx, id: string) {
  await ownReport(tx, ctx, id);
  await tx.query('DELETE FROM bi.reports WHERE id = $1', [id]);
  return { deleted: true };
}

/** Your reports and shared ones whose dataset you may read. */
export async function listReports(tx: Tx, ctx: Ctx) {
  const rows = await many(tx, `SELECT r.*, u.display_name AS owner FROM bi.reports r JOIN iam.users u ON u.id = r.owner_user_id
                                WHERE r.owner_user_id = $1 OR r.shared ORDER BY r.name`, [ctx.userId]);
  const out = [];
  for (const r of rows) {
    const d = DATASETS[r.dataset];
    if (d && (await unitScope(tx, ctx.userId!, d.permission, 'x', 1)).param.length) out.push({ ...r, datasetName: d.name, mine: r.owner_user_id === ctx.userId });
  }
  return out;
}

export async function runSaved(tx: Tx, ctx: Ctx, id: string) {
  const r = await one(tx, 'SELECT * FROM bi.reports WHERE id = $1', [id]);
  if (!r || (r.owner_user_id !== ctx.userId && !r.shared)) throw new NotFoundError('report');
  return { report: { id: r.id, name: r.name, dataset: r.dataset, spec: r.spec }, ...(await runReport(tx, ctx, r.dataset, r.spec)) };
}
