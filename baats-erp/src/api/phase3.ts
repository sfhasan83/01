import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx, Tx } from '../core/db.ts';
import * as prj from '../prj/service.ts';
import * as mfg from '../mfg/service.ts';
import * as mnt from '../mnt/service.ts';
import * as flt from '../flt/service.ts';

type Run = <T>(req: FastifyRequest, fn: (tx: Tx, ctx: Ctx) => Promise<T>) => Promise<T>;
type B = any; // bodies are validated by the route schemas
type P = { company: string; id: string };

const str = { type: 'string', minLength: 1 } as const;
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const uuid = { type: 'string', format: 'uuid' } as const;
const pos = { type: 'number', exclusiveMinimum: 0 } as const;
const nonneg = { type: 'number', minimum: 0 } as const;
const nullable = (s: object) => ({ anyOf: [s, { type: 'null' }] });
const body = (required: string[], properties: Record<string, object>) =>
  ({ body: { type: 'object', required, properties, additionalProperties: false } });
const ids = body(['ids'], { ids: { type: 'array', minItems: 1, items: uuid }, date });
const itemQty = { type: 'array', minItems: 1, items: { type: 'object', required: ['itemId', 'qty'], additionalProperties: false, properties: { itemId: uuid, qty: pos } } };

/** Projects, manufacturing, maintenance and fleet API (v1). */
export function registerPhase3(app: FastifyInstance, run: Run): void {
  const q = (req: FastifyRequest) => req.query as Record<string, string>;
  const created = <T>(reply: { status: (n: number) => unknown }, p: Promise<T>) => { reply.status(201); return p; };
  const company = (req: FastifyRequest) => (req.params as P).company;

  // Projects
  app.post<{ Params: P }>('/v1/prj/companies/:company/projects', {
    schema: body(['code', 'name', 'startDate'], { code: str, name: str, customerId: uuid, unitId: uuid, managerEmployeeId: uuid,
      billing: { enum: ['time_material', 'fixed_price', 'non_billable'] }, currency: str, contractValue: nonneg, budgetCost: nonneg,
      budgetHours: nonneg, defaultBillRate: nonneg, startDate: date, endDate: date }),
  }, async (req, reply) => created(reply, run(req, (tx, ctx) => prj.createProject(tx, ctx, { ...(req.body as B), companyId: company(req) }))));
  app.get<{ Params: P }>('/v1/prj/companies/:company/projects', async (req) => run(req, (tx, ctx) => prj.listProjects(tx, ctx, company(req))));
  app.get<{ Params: P }>('/v1/prj/projects/:id', async (req) => run(req, (tx, ctx) => prj.projectStatus(tx, ctx, req.params.id)));
  app.patch<{ Params: P }>('/v1/prj/projects/:id', {
    schema: body([], { name: str, status: { enum: ['active', 'on_hold', 'closed'] }, budgetCost: nonneg, budgetHours: nonneg, contractValue: nonneg,
      defaultBillRate: nonneg, endDate: nullable(date), managerEmployeeId: nullable(uuid) }),
  }, async (req) => run(req, (tx, ctx) => prj.updateProject(tx, ctx, req.params.id, req.body as B)));
  app.post<{ Params: P }>('/v1/prj/projects/:id/members', { schema: body(['employeeId'], { employeeId: uuid, role: str, billRate: nonneg }) },
    async (req, reply) => created(reply, run(req, (tx, ctx) => prj.addMember(tx, ctx, req.params.id, req.body as B))));
  app.post<{ Params: P }>('/v1/prj/projects/:id/milestones', { schema: body(['name', 'amount'], { name: str, amount: pos, dueDate: date }) },
    async (req, reply) => created(reply, run(req, (tx, ctx) => prj.addMilestone(tx, ctx, req.params.id, req.body as B))));
  app.post<{ Params: P }>('/v1/prj/milestones/:id/reached', { schema: body(['date'], { date }) },
    async (req) => run(req, (tx, ctx) => prj.reachMilestone(tx, ctx, req.params.id, (req.body as B).date)));
  app.post<{ Params: P }>('/v1/prj/projects/:id/invoice', { schema: body(['date'], { date, upTo: date, taxCode: str, fxRate: pos }) },
    async (req, reply) => created(reply, run(req, (tx, ctx) => prj.invoiceProject(tx, ctx, req.params.id, req.body as B))));
  app.post('/v1/prj/timesheets', {
    schema: body(['projectId', 'employeeId', 'date', 'hours', 'description'], { projectId: uuid, employeeId: uuid, date, hours: { type: 'number', exclusiveMinimum: 0, maximum: 24 },
      description: str, billable: { type: 'boolean' } }),
  }, async (req, reply) => created(reply, run(req, (tx, ctx) => prj.logTime(tx, ctx, req.body as B))));
  app.get<{ Params: P }>('/v1/prj/companies/:company/timesheets', async (req) =>
    run(req, (tx, ctx) => prj.listTimesheets(tx, ctx, company(req), { projectId: q(req).projectId, status: q(req).status })));
  app.post('/v1/prj/timesheets/approve', { schema: ids }, async (req) => run(req, (tx, ctx) => prj.approveTimesheets(tx, ctx, (req.body as B).ids, { date: (req.body as B).date })));
  app.post('/v1/prj/timesheets/reject', { schema: ids }, async (req) => run(req, (tx, ctx) => prj.rejectTimesheets(tx, ctx, (req.body as B).ids)));

  // Manufacturing
  app.post<{ Params: P }>('/v1/mfg/companies/:company/work-centers', { schema: body(['code', 'name', 'hourlyRate'], { code: str, name: str, hourlyRate: nonneg, unitId: uuid }) },
    async (req, reply) => created(reply, run(req, (tx, ctx) => mfg.createWorkCenter(tx, ctx, { ...(req.body as B), companyId: company(req) }))));
  app.get<{ Params: P }>('/v1/mfg/companies/:company/work-centers', async (req) => run(req, (tx, ctx) => mfg.listWorkCenters(tx, ctx, company(req))));
  app.post<{ Params: P }>('/v1/mfg/companies/:company/boms', {
    schema: body(['itemId', 'code', 'lines'], { itemId: uuid, code: str, outputQty: pos, notes: str,
      lines: { type: 'array', minItems: 1, items: { type: 'object', required: ['itemId', 'qty'], additionalProperties: false,
        properties: { itemId: uuid, qty: pos, scrapPct: { type: 'number', minimum: 0, exclusiveMaximum: 100 } } } },
      operations: { type: 'array', items: { type: 'object', required: ['seq', 'name', 'workCenterId'], additionalProperties: false,
        properties: { seq: { type: 'integer', minimum: 1 }, name: str, workCenterId: uuid, setupMinutes: nonneg, runMinutes: nonneg } } } }),
  }, async (req, reply) => created(reply, run(req, (tx, ctx) => mfg.createBom(tx, ctx, { ...(req.body as B), companyId: company(req) }))));
  app.get<{ Params: P }>('/v1/mfg/companies/:company/boms', async (req) => run(req, (tx, ctx) => mfg.listBoms(tx, ctx, company(req))));
  app.get<{ Params: P }>('/v1/mfg/boms/:id', async (req) => run(req, (tx, ctx) => mfg.getBom(tx, ctx, req.params.id)));
  app.get<{ Params: P & { item: string } }>('/v1/mfg/companies/:company/items/:item/cost', async (req) =>
    run(req, (tx, ctx) => mfg.costRollup(tx, ctx, company(req), req.params.item)));
  app.post<{ Params: P }>('/v1/mfg/companies/:company/work-orders', {
    schema: body(['itemId', 'qty', 'warehouseId', 'date'], { itemId: uuid, qty: pos, warehouseId: uuid, dueDate: date, salesOrderId: uuid, date }),
  }, async (req, reply) => created(reply, run(req, (tx, ctx) => mfg.createWorkOrder(tx, ctx, { ...(req.body as B), companyId: company(req) }))));
  app.get<{ Params: P }>('/v1/mfg/companies/:company/work-orders', async (req) => run(req, (tx, ctx) => mfg.listWorkOrders(tx, ctx, company(req), q(req).status)));
  app.get<{ Params: P }>('/v1/mfg/work-orders/:id', async (req) => run(req, (tx, ctx) => mfg.getWorkOrder(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/mfg/work-orders/:id/release', async (req) => run(req, (tx, ctx) => mfg.releaseWorkOrder(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/mfg/work-orders/:id/issue', { schema: body(['date'], { date, lines: itemQty }) },
    async (req) => run(req, (tx, ctx) => mfg.issueMaterials(tx, ctx, req.params.id, req.body as B)));
  app.post<{ Params: P }>('/v1/mfg/work-orders/:id/complete', {
    schema: body(['date'], { date, qty: pos, operations: { type: 'array', items: { type: 'object', required: ['seq', 'minutes'], additionalProperties: false,
      properties: { seq: { type: 'integer' }, minutes: nonneg } } } }),
  }, async (req) => run(req, (tx, ctx) => mfg.completeWorkOrder(tx, ctx, req.params.id, req.body as B)));
  app.post<{ Params: P }>('/v1/mfg/work-orders/:id/cancel', async (req) => run(req, (tx, ctx) => mfg.cancelWorkOrder(tx, ctx, req.params.id)));
  app.put<{ Params: P }>('/v1/inv/companies/:company/reorder-rules', {
    schema: body(['warehouseId', 'itemId', 'minQty'], { warehouseId: uuid, itemId: uuid, minQty: nonneg, reorderQty: nonneg }),
  }, async (req) => run(req, (tx, ctx) => mfg.setReorderRule(tx, ctx, { ...(req.body as B), companyId: company(req) })));
  app.get<{ Params: P }>('/v1/mfg/companies/:company/mrp', async (req) => run(req, (tx, ctx) => mfg.runMrp(tx, ctx, company(req))));

  // Fleet
  app.post<{ Params: P }>('/v1/flt/companies/:company/vehicles', {
    schema: body(['code', 'plateNo'], { code: str, plateNo: str, make: str, model: str, year: { type: 'integer', minimum: 1950, maximum: 2100 },
      fuelType: { enum: ['petrol', 'diesel', 'electric', 'hybrid'] }, assetId: uuid, unitId: uuid, driverEmployeeId: uuid, odometer: nonneg,
      registrationExpiry: date, insuranceExpiry: date, insurancePolicy: str }),
  }, async (req, reply) => created(reply, run(req, (tx, ctx) => flt.createVehicle(tx, ctx, { ...(req.body as B), companyId: company(req) }))));
  app.get<{ Params: P }>('/v1/flt/companies/:company/vehicles', async (req) => run(req, (tx, ctx) => flt.listVehicles(tx, ctx, company(req))));
  app.get<{ Params: P }>('/v1/flt/vehicles/:id', async (req) => run(req, (tx, ctx) => flt.vehicleSummary(tx, ctx, req.params.id)));
  app.patch<{ Params: P }>('/v1/flt/vehicles/:id', {
    schema: body([], { driverEmployeeId: nullable(uuid), unitId: nullable(uuid), registrationExpiry: nullable(date), insuranceExpiry: nullable(date),
      insurancePolicy: nullable(str), status: { enum: ['active', 'inactive', 'disposed'] } }),
  }, async (req) => run(req, (tx, ctx) => flt.updateVehicle(tx, ctx, req.params.id, req.body as B)));
  app.post<{ Params: P }>('/v1/flt/vehicles/:id/fuel', {
    schema: body(['date', 'odometer', 'litres', 'amount'], { date, odometer: nonneg, litres: pos, amount: pos, vatAmount: nonneg, station: str, paidFrom: str }),
  }, async (req, reply) => created(reply, run(req, (tx, ctx) => flt.logFuel(tx, ctx, { ...(req.body as B), vehicleId: req.params.id }))));
  app.post<{ Params: P }>('/v1/flt/vehicles/:id/trips', {
    schema: body(['date', 'endKm', 'purpose'], { date, startKm: nonneg, endKm: pos, purpose: str, driverEmployeeId: uuid, projectId: uuid }),
  }, async (req, reply) => created(reply, run(req, (tx, ctx) => flt.logTrip(tx, ctx, { ...(req.body as B), vehicleId: req.params.id }))));
  app.get<{ Params: P }>('/v1/flt/companies/:company/alerts', async (req) =>
    run(req, (tx, ctx) => flt.complianceAlerts(tx, ctx, company(req), q(req).asOf ?? new Date().toISOString().slice(0, 10), Number(q(req).days ?? 30))));

  // Maintenance
  app.post<{ Params: P }>('/v1/mnt/companies/:company/plans', {
    schema: body(['name'], { assetId: uuid, vehicleId: uuid, name: str, intervalDays: { type: 'integer', minimum: 1 }, intervalKm: pos, firstDueDate: date }),
  }, async (req, reply) => created(reply, run(req, (tx, ctx) => mnt.createPlan(tx, ctx, { ...(req.body as B), companyId: company(req) }))));
  app.get<{ Params: P }>('/v1/mnt/companies/:company/plans', async (req) => run(req, (tx, ctx) => mnt.listPlans(tx, ctx, company(req))));
  app.get<{ Params: P }>('/v1/mnt/companies/:company/due', async (req) =>
    run(req, (tx, ctx) => mnt.duePlans(tx, ctx, company(req), q(req).asOf ?? new Date().toISOString().slice(0, 10))));
  app.post<{ Params: P }>('/v1/mnt/companies/:company/generate', { schema: body(['asOf'], { asOf: date }) },
    async (req) => run(req, (tx, ctx) => mnt.generateDue(tx, ctx, company(req), (req.body as B).asOf)));
  app.post<{ Params: P }>('/v1/mnt/companies/:company/work-orders', {
    schema: body(['kind', 'description', 'scheduledDate'], { assetId: uuid, vehicleId: uuid, planId: uuid, kind: { enum: ['preventive', 'corrective', 'breakdown'] },
      priority: { enum: ['low', 'normal', 'high', 'urgent'] }, description: str, scheduledDate: date, unitId: uuid }),
  }, async (req, reply) => created(reply, run(req, (tx, ctx) => mnt.createWorkOrder(tx, ctx, { ...(req.body as B), companyId: company(req) }))));
  app.get<{ Params: P }>('/v1/mnt/companies/:company/work-orders', async (req) =>
    run(req, (tx, ctx) => mnt.listWorkOrders(tx, ctx, company(req), { status: q(req).status, assetId: q(req).assetId, vehicleId: q(req).vehicleId })));
  app.get<{ Params: P }>('/v1/mnt/work-orders/:id', async (req) => run(req, (tx, ctx) => mnt.getWorkOrder(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/mnt/work-orders/:id/start', async (req) => run(req, (tx, ctx) => mnt.startWorkOrder(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/mnt/work-orders/:id/parts', { schema: body(['warehouseId', 'date', 'lines'], { warehouseId: uuid, date, lines: itemQty }) },
    async (req) => run(req, (tx, ctx) => mnt.issueParts(tx, ctx, req.params.id, req.body as B)));
  app.post<{ Params: P }>('/v1/mnt/work-orders/:id/complete', {
    schema: body(['date', 'resolution'], { date, resolution: str, downtimeHours: nonneg, odometer: nonneg }),
  }, async (req) => run(req, (tx, ctx) => mnt.completeWorkOrder(tx, ctx, req.params.id, req.body as B)));
  app.post<{ Params: P }>('/v1/mnt/work-orders/:id/cancel', { schema: body(['reason'], { reason: str }) },
    async (req) => run(req, (tx, ctx) => mnt.cancelWorkOrder(tx, ctx, req.params.id, (req.body as B).reason)));
}
