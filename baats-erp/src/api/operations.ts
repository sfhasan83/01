import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx, Tx } from '../core/db.ts';
import * as inv from '../inv/service.ts';
import * as pur from '../pur/service.ts';
import * as crm from '../crm/service.ts';
import * as sal from '../sal/service.ts';
import * as hr from '../hr/service.ts';

type Run = <T>(req: FastifyRequest, fn: (tx: Tx, ctx: Ctx) => Promise<T>) => Promise<T>;
type B = any; // bodies are validated by the route schemas
type P = { company: string; id: string };

const str = { type: 'string', minLength: 1 } as const;
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const uuid = { type: 'string', format: 'uuid' } as const;
const pos = { type: 'number', exclusiveMinimum: 0 } as const;
const nonneg = { type: 'number', minimum: 0 } as const;
const body = (required: string[], properties: Record<string, object>) =>
  ({ body: { type: 'object', required, properties, additionalProperties: false } });
const qtyLines = { type: 'array', minItems: 1, items: { type: 'object', required: ['orderLineId', 'quantity'], additionalProperties: false,
  properties: { orderLineId: uuid, quantity: pos } } };

/** Inventory, procurement, CRM, sales, HR and payroll API (v1). */
export function registerOperations(app: FastifyInstance, run: Run): void {
  const q = (req: FastifyRequest) => req.query as Record<string, string>;
  const created = <T>(reply: { status: (n: number) => unknown }, p: Promise<T>) => { reply.status(201); return p; };

  // Inventory
  app.post<{ Params: P }>('/v1/inv/companies/:company/warehouses', { schema: body(['code', 'name'], { code: str, name: str, unitId: uuid }) },
    async (req, reply) => created(reply, run(req, (tx, ctx) => inv.createWarehouse(tx, ctx, { ...(req.body as B), companyId: req.params.company }))));
  app.get<{ Params: P }>('/v1/inv/companies/:company/warehouses', async (req) => run(req, (tx, ctx) => inv.listWarehouses(tx, ctx, req.params.company)));
  app.post<{ Params: P }>('/v1/inv/companies/:company/opening-stock', {
    schema: body(['warehouseId', 'date', 'lines'], { warehouseId: uuid, date, lines: { type: 'array', minItems: 1, items: { type: 'object',
      required: ['itemId', 'qty', 'unitCost'], additionalProperties: false, properties: { itemId: uuid, qty: pos, unitCost: nonneg } } } }),
  }, async (req, reply) => created(reply, run(req, (tx, ctx) => inv.openingStock(tx, ctx, { ...(req.body as B), companyId: req.params.company }))));
  app.post<{ Params: P }>('/v1/inv/companies/:company/adjustments', {
    schema: body(['warehouseId', 'itemId', 'date', 'qty', 'reason'], { warehouseId: uuid, itemId: uuid, date, qty: { type: 'number' }, unitCost: nonneg, reason: str }),
  }, async (req, reply) => created(reply, run(req, (tx, ctx) => inv.adjustStock(tx, ctx, { ...(req.body as B), companyId: req.params.company }))));
  app.post<{ Params: P }>('/v1/inv/companies/:company/transfers', {
    schema: body(['fromWarehouseId', 'toWarehouseId', 'itemId', 'qty', 'date'], { fromWarehouseId: uuid, toWarehouseId: uuid, itemId: uuid, qty: pos, date }),
  }, async (req, reply) => created(reply, run(req, (tx, ctx) => inv.transferStock(tx, ctx, { ...(req.body as B), companyId: req.params.company }))));
  app.get<{ Params: P }>('/v1/inv/companies/:company/stock', async (req) => run(req, (tx, ctx) => inv.stockLevels(tx, ctx, req.params.company, q(req).warehouseId)));
  app.get<{ Params: P & { item: string } }>('/v1/inv/companies/:company/items/:item/moves', async (req) =>
    run(req, (tx, ctx) => inv.itemMoves(tx, ctx, req.params.company, req.params.item)));
  app.get<{ Params: P }>('/v1/inv/companies/:company/valuation', async (req) => run(req, (tx, ctx) => inv.valuation(tx, ctx, req.params.company)));

  // Procurement
  const poLine = { type: 'object', required: ['description', 'quantity', 'unitPrice', 'taxCode'], additionalProperties: false,
    properties: { itemId: uuid, description: str, quantity: pos, unitPrice: nonneg, taxCode: str, account: str, unitId: uuid } };
  app.post<{ Params: P }>('/v1/pur/companies/:company/orders', {
    schema: body(['supplierId', 'date', 'lines'], { supplierId: uuid, date, expectedDate: date, currency: str, fxRate: pos, warehouseId: uuid,
      requestingUnitId: uuid, notes: str, lines: { type: 'array', minItems: 1, items: poLine } }),
  }, async (req, reply) => created(reply, run(req, (tx, ctx) => pur.createOrder(tx, ctx, { ...(req.body as B), companyId: req.params.company }))));
  app.get<{ Params: P }>('/v1/pur/companies/:company/orders', async (req) => run(req, (tx, ctx) => pur.listOrders(tx, ctx, req.params.company, q(req).status)));
  app.get<{ Params: P }>('/v1/pur/orders/:id', async (req) => run(req, (tx, ctx) => pur.getOrder(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/pur/orders/:id/submit', async (req) => run(req, (tx, ctx) => pur.submitOrder(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/pur/orders/:id/receipts', { schema: body(['date', 'lines'], { date, deliveryNote: str, lines: qtyLines }) },
    async (req, reply) => created(reply, run(req, (tx, ctx) => pur.receive(tx, ctx, req.params.id, req.body as B))));
  app.post<{ Params: P }>('/v1/pur/orders/:id/bill', { schema: body(['date', 'supplierRef'], { date, supplierRef: str, dueDate: date, lines: qtyLines }) },
    async (req, reply) => created(reply, run(req, (tx, ctx) => pur.billOrder(tx, ctx, req.params.id, req.body as B))));
  app.post<{ Params: P }>('/v1/pur/orders/:id/close', async (req) => run(req, (tx, ctx) => pur.closeOrder(tx, ctx, req.params.id)));

  // CRM
  app.post('/v1/crm/leads', { schema: body(['ownerUnitId', 'name'], { ownerUnitId: uuid, name: str, companyName: str, email: str, phone: str,
    countryCode: { type: 'string', minLength: 2, maxLength: 2 }, source: str, notes: str }) },
  async (req, reply) => created(reply, run(req, (tx, ctx) => crm.createLead(tx, ctx, req.body as B))));
  app.get('/v1/crm/leads', async (req) => run(req, (tx, ctx) => crm.listLeads(tx, ctx, q(req).status)));
  app.post<{ Params: P }>('/v1/crm/leads/:id/status', { schema: body(['status'], { status: { enum: ['qualified', 'disqualified'] } }) },
    async (req) => run(req, (tx, ctx) => crm.setLeadStatus(tx, ctx, req.params.id, (req.body as B).status)));
  app.post<{ Params: P }>('/v1/crm/leads/:id/convert', {
    schema: body(['customerCode'], { customerCode: str, countryCode: { type: 'string', minLength: 2, maxLength: 2 },
      opportunity: { type: 'object', required: ['title', 'amount', 'currency'], additionalProperties: false,
        properties: { title: str, amount: nonneg, currency: str, expectedClose: date } } }),
  }, async (req) => run(req, (tx, ctx) => crm.convertLead(tx, ctx, req.params.id, req.body as B)));
  app.post('/v1/crm/opportunities', { schema: body(['ownerUnitId', 'title', 'amount', 'currency'], { ownerUnitId: uuid, title: str, amount: nonneg,
    currency: str, leadId: uuid, partyId: uuid, expectedClose: date, stage: str }) },
  async (req, reply) => created(reply, run(req, (tx, ctx) => crm.createOpportunity(tx, ctx, req.body as B))));
  app.patch<{ Params: P }>('/v1/crm/opportunities/:id', { schema: body([], { stage: { enum: ['prospecting', 'qualification', 'proposal', 'negotiation', 'won', 'lost'] },
    amount: nonneg, probability: { type: 'integer', minimum: 0, maximum: 100 }, expectedClose: date, lostReason: str }) },
  async (req) => run(req, (tx, ctx) => crm.updateOpportunity(tx, ctx, req.params.id, req.body as B)));
  app.get('/v1/crm/pipeline', async (req) => run(req, (tx, ctx) => crm.pipeline(tx, ctx)));
  app.post('/v1/crm/activities', { schema: body(['entityType', 'entityId', 'kind', 'subject'], { entityType: { enum: ['lead', 'opportunity', 'party'] },
    entityId: uuid, kind: { enum: ['call', 'meeting', 'email', 'task', 'note'] }, subject: str, dueAt: str, done: { type: 'boolean' } }) },
  async (req, reply) => created(reply, run(req, (tx, ctx) => crm.addActivity(tx, ctx, req.body as B))));
  app.post<{ Params: P }>('/v1/crm/activities/:id/done', async (req) => run(req, (tx, ctx) => crm.completeActivity(tx, ctx, req.params.id)));
  app.get('/v1/crm/activities', async (req) => run(req, (tx, ctx) => crm.activities(tx, ctx, q(req).entityType, q(req).entityId)));

  // Sales
  const soLine = { type: 'object', required: ['description', 'quantity', 'unitPrice', 'taxCode'], additionalProperties: false,
    properties: { itemId: uuid, description: str, quantity: pos, unitPrice: nonneg, discount: nonneg, taxCode: str, account: str } };
  app.post<{ Params: P }>('/v1/sal/companies/:company/quotations', {
    schema: body(['customerId', 'date', 'lines'], { customerId: uuid, date, validUntil: date, currency: str, fxRate: pos, warehouseId: uuid,
      sellingUnitId: uuid, opportunityId: uuid, notes: str, lines: { type: 'array', minItems: 1, items: soLine } }),
  }, async (req, reply) => created(reply, run(req, (tx, ctx) => sal.createQuotation(tx, ctx, { ...(req.body as B), companyId: req.params.company }))));
  app.get<{ Params: P }>('/v1/sal/companies/:company/orders', async (req) => run(req, (tx, ctx) => sal.listOrders(tx, ctx, req.params.company, q(req).status)));
  app.get<{ Params: P }>('/v1/sal/orders/:id', async (req) => run(req, (tx, ctx) => sal.getOrder(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/sal/orders/:id/confirm', async (req) => run(req, (tx, ctx) => sal.confirmOrder(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/sal/orders/:id/deliveries', { schema: body(['date'], { date, lines: qtyLines }) },
    async (req, reply) => created(reply, run(req, (tx, ctx) => sal.deliver(tx, ctx, req.params.id, req.body as B))));
  app.post<{ Params: P }>('/v1/sal/orders/:id/invoice', { schema: body(['date'], { date }) },
    async (req, reply) => created(reply, run(req, (tx, ctx) => sal.invoiceOrder(tx, ctx, req.params.id, req.body as B))));
  app.post<{ Params: P }>('/v1/sal/orders/:id/cancel', async (req) => run(req, (tx, ctx) => sal.cancelOrder(tx, ctx, req.params.id)));

  // HR and payroll
  const TAX_FIELDS = { taxCode: { type: ['string', 'null'], maxLength: 20 }, taxCredits: { type: ['number', 'null'], minimum: 0 },
    rateCutOff: { type: ['number', 'null'], minimum: 0 }, withholdingPct: { type: ['number', 'null'], minimum: 0, maximum: 100 },
    previousPay: { type: 'number', minimum: 0 }, previousTax: { type: 'number' }, previousUsc: { type: 'number', minimum: 0 } };
  app.post('/v1/hr/contracts', {
    schema: body(['employeeId', 'companyId', 'startDate', 'basic'], { employeeId: uuid, companyId: uuid, startDate: date, endDate: date,
      contractType: { enum: ['limited', 'unlimited'] }, basic: pos, housing: nonneg, transport: nonneg, otherAllowances: nonneg, currency: str,
      annualLeaveDays: { type: 'integer', minimum: 0 }, wpsPersonId: str, bankRoutingCode: str, iban: str, ...TAX_FIELDS }),
  }, async (req, reply) => created(reply, run(req, (tx, ctx) => hr.createContract(tx, ctx, req.body as B))));
  app.patch<{ Params: P }>('/v1/hr/contracts/:id/tax', { schema: body([], TAX_FIELDS) },
    async (req) => run(req, (tx, ctx) => hr.setContractTax(tx, ctx, req.params.id, req.body as B)));
  app.get<{ Params: P }>('/v1/hr/companies/:company/contracts', async (req) => run(req, (tx, ctx) => hr.listContracts(tx, ctx, req.params.company)));
  app.post<{ Params: P }>('/v1/hr/contracts/:id/end', { schema: body(['endDate'], { endDate: date, reason: { enum: hr.END_REASONS } }) },
    async (req) => run(req, (tx, ctx) => hr.endContract(tx, ctx, req.params.id, (req.body as B).endDate, (req.body as B).reason)));
  app.post<{ Params: P }>('/v1/hr/contracts/:id/settlement', { schema: body(['date'], { date, bankAccount: str }) },
    async (req) => run(req, (tx, ctx) => hr.paySettlement(tx, ctx, req.params.id, req.body as B)));
  app.post('/v1/hr/leave', { schema: body(['employeeId', 'leaveType', 'dateFrom', 'dateTo'], { employeeId: uuid,
    leaveType: { enum: ['annual', 'sick', 'unpaid', 'maternity', 'parental', 'compassionate', 'hajj'] }, dateFrom: date, dateTo: date, reason: str }) },
  async (req, reply) => created(reply, run(req, (tx, ctx) => hr.requestLeave(tx, ctx, req.body as B))));
  app.get<{ Params: P }>('/v1/hr/companies/:company/leave', async (req) => run(req, (tx, ctx) => hr.listLeave(tx, ctx, req.params.company)));
  app.get<{ Params: P }>('/v1/hr/employees/:id/leave-balance', async (req) =>
    run(req, (tx, ctx) => hr.leaveBalance(tx, ctx, req.params.id, q(req).asOf ?? new Date().toISOString().slice(0, 10))));
  app.post<{ Params: P }>('/v1/hr/companies/:company/payroll', {
    schema: body(['period'], { period: { type: 'string', pattern: '^\\d{4}-\\d{2}$' }, inputs: { type: 'array', items: { type: 'object',
      required: ['employeeId'], additionalProperties: false, properties: { employeeId: uuid, additions: nonneg, deductions: nonneg } } } }),
  }, async (req, reply) => created(reply, run(req, (tx, ctx) => hr.runPayroll(tx, ctx, { ...(req.body as B), companyId: req.params.company }))));
  app.get<{ Params: P }>('/v1/hr/companies/:company/payroll', async (req) => run(req, (tx, ctx) => hr.listPayrolls(tx, ctx, req.params.company)));
  app.get<{ Params: P }>('/v1/hr/payroll/:id', async (req) => run(req, (tx, ctx) => hr.getPayroll(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/hr/payroll/:id/post',
    async (req) => run(req, (tx, ctx) => hr.postPayroll(tx, ctx, req.params.id, (req.body as B | undefined)?.date)));
  app.post<{ Params: P }>('/v1/hr/payroll/:id/pay', { schema: body(['date'], { date, bankAccount: str, employerId: str, employerBankCode: str }) },
    async (req) => run(req, (tx, ctx) => hr.payPayroll(tx, ctx, req.params.id, req.body as B)));
  app.get<{ Params: P }>('/v1/hr/companies/:company/contribution-rules', async (req) => run(req, (tx, ctx) => hr.listContributionRules(tx, ctx, req.params.company)));
  app.put<{ Params: P }>('/v1/hr/companies/:company/contribution-rules', {
    schema: body(['code'], { code: str, name: str, appliesTo: { enum: ['nationals', 'non_nationals', 'all'] }, employeePct: nonneg, employerPct: nonneg,
      base: { enum: ['basic', 'basic_housing', 'gross'] }, monthlyCap: { type: ['number', 'null'], exclusiveMinimum: 0 }, active: { type: 'boolean' },
      afterYears: { type: ['number', 'null'], exclusiveMinimum: 0 }, employerPctAfter: { type: ['number', 'null'], minimum: 0 },
      monthlyThreshold: { type: ['number', 'null'], minimum: 0 }, preTax: { type: 'boolean' }, eligibleUpTo: { type: ['number', 'null'], exclusiveMinimum: 0 } }),
  }, async (req) => run(req, (tx, ctx) => hr.saveContributionRule(tx, ctx, req.params.company, req.body as B)));
}
