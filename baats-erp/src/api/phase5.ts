import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx, Tx } from '../core/db.ts';
import * as kpi from '../bi/kpi.ts';
import * as rep from '../bi/reports.ts';
import * as strat from '../bi/strategy.ts';
import * as esg from '../bi/esg.ts';
import * as anom from '../bi/anomaly.ts';

type Run = <T>(req: FastifyRequest, fn: (tx: Tx, ctx: Ctx) => Promise<T>) => Promise<T>;
type B = any; // bodies are validated by the route schemas
type P = { company: string; id: string; code: string };

const str = { type: 'string', minLength: 1 } as const;
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const uuid = { type: 'string', format: 'uuid' } as const;
const body = (required: string[], properties: Record<string, object>) =>
  ({ body: { type: 'object', required, properties, additionalProperties: false } });
const today = () => new Date().toISOString().slice(0, 10);
const spec = {
  type: 'object', additionalProperties: false, properties: {
    columns: { type: 'array', items: str, maxItems: 40 },
    groupBy: { type: 'array', items: str, maxItems: 10 },
    measures: { type: 'array', maxItems: 20, items: { type: 'object', required: ['field', 'agg'], additionalProperties: false, properties: { field: str, agg: { enum: ['sum', 'avg', 'min', 'max', 'count'] } } } },
    filters: { type: 'array', maxItems: 20, items: { type: 'object', required: ['field', 'op'], additionalProperties: false,
      properties: { field: str, op: { enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'is_empty', 'not_empty'] }, value: {} } } },
    sort: { type: 'array', maxItems: 5, items: { type: 'object', required: ['by'], additionalProperties: false, properties: { by: str, dir: { enum: ['asc', 'desc'] } } } },
    limit: { type: 'integer', minimum: 1, maximum: 5000 },
  },
};

/** Dashboards, KPIs, report builder, scorecards, ESG and anomaly checks (v1). */
export function registerPhase5(app: FastifyInstance, run: Run): void {
  const q = (req: FastifyRequest) => req.query as Record<string, string>;
  const company = (req: FastifyRequest) => (req.params as P).company;
  const yearStart = () => `${today().slice(0, 4)}-01-01`;

  // KPIs and the dashboard
  app.get<{ Params: P }>('/v1/bi/companies/:company/kpis', async (req) => run(req, (tx, ctx) => kpi.kpiCatalog(tx, ctx, company(req))));
  app.get<{ Params: P }>('/v1/bi/companies/:company/kpis/:code', async (req) => run(req, async (tx, ctx) => ({
    code: req.params.code, from: q(req).from ?? yearStart(), to: q(req).to ?? today(),
    value: await kpi.kpiValue(tx, ctx, company(req), req.params.code, q(req).from ?? yearStart(), q(req).to ?? today()) })));
  app.get<{ Params: P }>('/v1/bi/companies/:company/kpis/:code/trend', async (req) =>
    run(req, (tx, ctx) => kpi.kpiTrend(tx, ctx, company(req), req.params.code, q(req).asOf ?? today(), Number(q(req).months ?? 12))));
  app.get<{ Params: P }>('/v1/bi/companies/:company/dashboard', async (req) => run(req, (tx, ctx) => kpi.dashboard(tx, ctx, company(req), q(req).asOf ?? today())));

  // Report builder
  app.get('/v1/bi/datasets', async (req) => run(req, (tx, ctx) => rep.datasetCatalog(tx, ctx)));
  app.post('/v1/bi/query', { schema: body(['dataset', 'spec'], { dataset: str, spec }) }, async (req) => run(req, (tx, ctx) => rep.runReport(tx, ctx, (req.body as B).dataset, (req.body as B).spec)));
  app.post('/v1/bi/query.csv', { schema: body(['dataset', 'spec'], { dataset: str, spec }) }, async (req, reply) => {
    const r = await run(req, (tx, ctx) => rep.runReport(tx, ctx, (req.body as B).dataset, (req.body as B).spec));
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${(req.body as B).dataset}.csv"`);
    return '﻿' + rep.toCsv(r);
  });
  app.get('/v1/bi/reports', async (req) => run(req, (tx, ctx) => rep.listReports(tx, ctx)));
  app.post('/v1/bi/reports', { schema: body(['name', 'dataset', 'spec'], { name: str, description: { type: 'string' }, dataset: str, spec, shared: { type: 'boolean' } }) },
    async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => rep.saveReport(tx, ctx, req.body as B)); });
  app.patch<{ Params: P }>('/v1/bi/reports/:id', { schema: body([], { name: str, description: { type: 'string' }, spec, shared: { type: 'boolean' } }) },
    async (req) => run(req, (tx, ctx) => rep.updateReport(tx, ctx, req.params.id, req.body as B)));
  app.delete<{ Params: P }>('/v1/bi/reports/:id', async (req) => run(req, (tx, ctx) => rep.deleteReport(tx, ctx, req.params.id)));
  app.get<{ Params: P }>('/v1/bi/reports/:id/run', async (req) => run(req, (tx, ctx) => rep.runSaved(tx, ctx, req.params.id)));
  app.get<{ Params: P }>('/v1/bi/reports/:id/csv', async (req, reply) => {
    const r = await run(req, (tx, ctx) => rep.runSaved(tx, ctx, req.params.id));
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${r.report.name.replace(/[^\w.\- ]/g, '_')}.csv"`);
    return '﻿' + rep.toCsv(r);
  });

  // Strategy scorecards
  app.get<{ Params: P }>('/v1/bi/companies/:company/scorecard', async (req) =>
    run(req, (tx, ctx) => strat.scorecard(tx, ctx, company(req), Number(q(req).year ?? today().slice(0, 4)), q(req).asOf ?? today())));
  app.post<{ Params: P }>('/v1/bi/companies/:company/objectives', { schema: body(['code', 'title', 'perspective'], { code: str, title: str,
    perspective: { enum: ['financial', 'customer', 'process', 'people', 'sustainability'] }, ownerEmployeeId: uuid }) },
  async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => strat.createObjective(tx, ctx, { ...(req.body as B), companyId: company(req) })); });
  app.post<{ Params: P }>('/v1/bi/objectives/:id/retire', async (req) => run(req, (tx, ctx) => strat.retireObjective(tx, ctx, req.params.id)));
  app.put<{ Params: P }>('/v1/bi/objectives/:id/targets', { schema: body(['kpiCode', 'year', 'target'], { kpiCode: str, year: { type: 'integer', minimum: 2000, maximum: 2100 },
    target: { type: 'number' }, tolerancePct: { type: 'number', minimum: 0, maximum: 100 } }) },
  async (req) => run(req, (tx, ctx) => strat.setTarget(tx, ctx, req.params.id, req.body as B)));
  app.delete<{ Params: P }>('/v1/bi/targets/:id', async (req) => run(req, (tx, ctx) => strat.removeTarget(tx, ctx, req.params.id)));

  // ESG
  app.get<{ Params: P }>('/v1/bi/companies/:company/esg', async (req) => run(req, (tx, ctx) => esg.esgReport(tx, ctx, company(req), q(req).from ?? yearStart(), q(req).to ?? today())));
  app.get<{ Params: P }>('/v1/bi/companies/:company/esg/readings', async (req) => run(req, (tx, ctx) => esg.listReadings(tx, ctx, company(req), q(req).from ?? yearStart(), q(req).to ?? today())));
  app.put<{ Params: P }>('/v1/bi/companies/:company/esg/readings', { schema: body(['month', 'metric', 'value'], { month: { type: 'string', pattern: '^\\d{4}-\\d{2}' },
    metric: { enum: [...esg.METRICS] }, value: { type: 'number', minimum: 0 }, unitId: uuid, note: { type: 'string' } }) },
  async (req) => run(req, (tx, ctx) => esg.recordReading(tx, ctx, company(req), req.body as B)));
  app.put<{ Params: P }>('/v1/bi/companies/:company/esg/factors', { schema: body(['key', 'value'], { key: { enum: Object.keys(esg.DEFAULT_FACTORS) }, value: { type: 'number', minimum: 0 }, source: { type: 'string' } }) },
    async (req) => run(req, (tx, ctx) => esg.setFactor(tx, ctx, company(req), req.body as B)));

  // Anomaly checks
  app.get<{ Params: P }>('/v1/bi/companies/:company/anomalies', async (req) => run(req, (tx, ctx) => anom.anomalyScan(tx, ctx, company(req), q(req).from ?? yearStart(), q(req).to ?? today())));
  app.post<{ Params: P }>('/v1/bi/companies/:company/anomalies/review', { schema: body(['rule', 'key', 'outcome', 'note', 'from', 'to'], { rule: str, key: str,
    outcome: { enum: ['explained', 'confirmed'] }, note: str, from: date, to: date }) },
  async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => anom.reviewFinding(tx, ctx, company(req), req.body as B)); });
}
