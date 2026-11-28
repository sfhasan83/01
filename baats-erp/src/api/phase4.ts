import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx, Tx } from '../core/db.ts';
import * as dms from '../corp/dms.ts';
import * as lgl from '../corp/legal.ts';
import * as grc from '../corp/grc.ts';
import * as svc from '../corp/svc.ts';
import * as qms from '../corp/qms.ts';
import * as hse from '../corp/hse.ts';
import * as fac from '../corp/fac.ts';

type Run = <T>(req: FastifyRequest, fn: (tx: Tx, ctx: Ctx) => Promise<T>) => Promise<T>;
type B = any; // bodies are validated by the route schemas
type P = { company: string; id: string };

const str = { type: 'string', minLength: 1 } as const;
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const datetime = { type: 'string', minLength: 10 } as const;
const uuid = { type: 'string', format: 'uuid' } as const;
const pos = { type: 'number', exclusiveMinimum: 0 } as const;
const nonneg = { type: 'number', minimum: 0 } as const;
const score = { type: 'integer', minimum: 1, maximum: 5 } as const;
const body = (required: string[], properties: Record<string, object>) =>
  ({ body: { type: 'object', required, properties, additionalProperties: false } });
const actions = { type: 'array', items: { type: 'object', required: ['title', 'ownerEmployeeId', 'dueDate'], additionalProperties: false,
  properties: { title: str, ownerEmployeeId: uuid, dueDate: date } } };
const file = { fileName: str, contentType: str, contentBase64: { type: 'string' }, note: str };
const today = () => new Date().toISOString().slice(0, 10);

/** Documents, contracts, risk and audit, service desk, quality, safety and facilities API (v1). */
export function registerPhase4(app: FastifyInstance, run: Run): void {
  const q = (req: FastifyRequest) => req.query as Record<string, string>;
  const created = <T>(reply: { status: (n: number) => unknown }, p: Promise<T>) => { reply.status(201); return p; };
  const company = (req: FastifyRequest) => (req.params as P).company;
  const big = { bodyLimit: 15 * 1024 * 1024 };

  // Documents
  app.post('/v1/dms/documents', { ...big, schema: body(['unitId', 'title', 'fileName', 'contentBase64'], { unitId: uuid, title: str, category: str, entityType: str,
    entityId: uuid, confidential: { type: 'boolean' }, retainUntil: date, ...file }) },
  async (req, reply) => created(reply, run(req, (tx, ctx) => dms.uploadDocument(tx, ctx, req.body as B))));
  app.get('/v1/dms/documents', async (req) => run(req, (tx, ctx) => dms.listDocuments(tx, ctx, { entityType: q(req).entityType, entityId: q(req).entityId, category: q(req).category })));
  app.get<{ Params: P }>('/v1/dms/documents/:id', async (req) => run(req, (tx, ctx) => dms.getDocument(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/dms/documents/:id/versions', { ...big, schema: body(['fileName', 'contentBase64'], file) },
    async (req, reply) => created(reply, run(req, (tx, ctx) => dms.addVersion(tx, ctx, req.params.id, req.body as B))));
  app.post<{ Params: P }>('/v1/dms/documents/:id/archive', async (req) => run(req, (tx, ctx) => dms.archiveDocument(tx, ctx, req.params.id)));
  app.get<{ Params: P }>('/v1/dms/documents/:id/content', async (req, reply) => {
    const v = await run(req, (tx, ctx) => dms.download(tx, ctx, req.params.id, q(req).version ? Number(q(req).version) : undefined));
    reply.header('content-type', v.content_type);
    reply.header('content-disposition', `attachment; filename="${v.file_name.replace(/[^\w.\- ]/g, '_')}"`);
    reply.header('x-content-sha256', v.sha256);
    return v.content;
  });

  // Legal
  app.post<{ Params: P }>('/v1/lgl/companies/:company/contracts', {
    schema: body(['title', 'kind', 'startDate'], { title: str, kind: { enum: ['sales', 'purchase', 'nda', 'lease', 'employment', 'service', 'other'] }, partyId: uuid,
      ownerEmployeeId: uuid, value: nonneg, currency: str, startDate: date, endDate: date, autoRenew: { type: 'boolean' }, renewalMonths: { type: 'integer', minimum: 1 },
      noticeDays: { type: 'integer', minimum: 0 }, governingLaw: str }),
  }, async (req, reply) => created(reply, run(req, (tx, ctx) => lgl.createContract(tx, ctx, { ...(req.body as B), companyId: company(req) }))));
  app.get<{ Params: P }>('/v1/lgl/companies/:company/contracts', async (req) => run(req, (tx, ctx) => lgl.listContracts(tx, ctx, company(req))));
  app.get<{ Params: P }>('/v1/lgl/companies/:company/alerts', async (req) => run(req, (tx, ctx) => lgl.contractAlerts(tx, ctx, company(req), q(req).asOf ?? today(), Number(q(req).days ?? 30))));
  app.post<{ Params: P }>('/v1/lgl/companies/:company/renewals', { schema: body(['asOf'], { asOf: date }) },
    async (req) => run(req, (tx, ctx) => lgl.runRenewals(tx, ctx, company(req), (req.body as B).asOf)));
  app.get<{ Params: P }>('/v1/lgl/contracts/:id', async (req) => run(req, (tx, ctx) => lgl.getContract(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/lgl/contracts/:id/submit', async (req) => run(req, (tx, ctx) => lgl.submitContract(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/lgl/contracts/:id/terminate', { schema: body(['date', 'reason'], { date, reason: str }) },
    async (req) => run(req, (tx, ctx) => lgl.terminateContract(tx, ctx, req.params.id, req.body as B)));
  app.post<{ Params: P }>('/v1/lgl/contracts/:id/obligations', { schema: body(['description', 'dueDate'], { description: str, dueDate: date, responsibleEmployeeId: uuid }) },
    async (req, reply) => created(reply, run(req, (tx, ctx) => lgl.addObligation(tx, ctx, req.params.id, req.body as B))));
  app.post<{ Params: P }>('/v1/lgl/obligations/:id/done', { schema: body(['date'], { date, waived: { type: 'boolean' } }) },
    async (req) => run(req, (tx, ctx) => lgl.completeObligation(tx, ctx, req.params.id, req.body as B)));

  // Risk, compliance, audit, actions
  app.post('/v1/grc/risks', { schema: body(['unitId', 'code', 'title', 'category', 'likelihood', 'impact'], { unitId: uuid, code: str, title: str,
    category: { enum: ['strategic', 'operational', 'financial', 'compliance', 'technology', 'hse', 'reputational'] }, likelihood: score, impact: score, ownerEmployeeId: uuid,
    treatment: { enum: ['mitigate', 'accept', 'transfer', 'avoid'] }, appetite: { type: 'integer', minimum: 1, maximum: 25 } }) },
  async (req, reply) => created(reply, run(req, (tx, ctx) => grc.createRisk(tx, ctx, req.body as B))));
  app.get('/v1/grc/risks', async (req) => run(req, (tx, ctx) => grc.riskRegister(tx, ctx)));
  app.patch<{ Params: P }>('/v1/grc/risks/:id', { schema: body([], { likelihood: score, impact: score, treatment: { enum: ['mitigate', 'accept', 'transfer', 'avoid'] },
    status: { enum: ['open', 'closed'] }, appetite: { type: 'integer', minimum: 1, maximum: 25 } }) },
  async (req) => run(req, (tx, ctx) => grc.updateRisk(tx, ctx, req.params.id, req.body as B)));
  app.get<{ Params: P }>('/v1/grc/risks/:id/controls', async (req) => run(req, (tx, ctx) => grc.riskControls(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/grc/risks/:id/controls', { schema: body(['code', 'title'], { code: str, title: str, kind: { enum: ['preventive', 'detective', 'corrective'] },
    frequency: { enum: ['continuous', 'daily', 'weekly', 'monthly', 'quarterly', 'annual'] }, ownerEmployeeId: uuid }) },
  async (req, reply) => created(reply, run(req, (tx, ctx) => grc.addControl(tx, ctx, req.params.id, req.body as B))));
  app.post<{ Params: P }>('/v1/grc/controls/:id/tests', { schema: body(['testedOn', 'result'], { testedOn: date, result: { enum: ['effective', 'ineffective'] },
    sampleSize: { type: 'integer', minimum: 1 }, exceptions: { type: 'integer', minimum: 0 }, notes: str, engagementId: uuid, actionDueDate: date }) },
  async (req, reply) => created(reply, run(req, (tx, ctx) => grc.testControl(tx, ctx, req.params.id, req.body as B))));
  app.post('/v1/grc/obligations', { schema: body(['unitId', 'regulation', 'requirement', 'nextDue'], { unitId: uuid, regulation: str, requirement: str,
    frequency: { enum: ['once', 'monthly', 'quarterly', 'annual'] }, nextDue: date, ownerEmployeeId: uuid }) },
  async (req, reply) => created(reply, run(req, (tx, ctx) => grc.addObligation(tx, ctx, req.body as B))));
  app.get('/v1/grc/obligations', async (req) => run(req, (tx, ctx) => grc.complianceCalendar(tx, ctx, q(req).asOf ?? today())));
  app.post<{ Params: P }>('/v1/grc/obligations/:id/met', { schema: body(['date'], { date }) },
    async (req) => run(req, (tx, ctx) => grc.meetObligation(tx, ctx, req.params.id, (req.body as B).date)));
  app.post('/v1/grc/engagements', { schema: body(['unitId', 'title'], { unitId: uuid, title: str, kind: { enum: ['internal', 'external', 'regulatory'] }, periodFrom: date, periodTo: date }) },
    async (req, reply) => created(reply, run(req, (tx, ctx) => grc.createEngagement(tx, ctx, req.body as B))));
  app.get('/v1/grc/engagements', async (req) => run(req, (tx, ctx) => grc.listEngagements(tx, ctx)));
  app.get<{ Params: P }>('/v1/grc/engagements/:id', async (req) => run(req, (tx, ctx) => grc.getEngagement(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/grc/engagements/:id/advance', { schema: body([], { opinion: { enum: ['satisfactory', 'needs_improvement', 'unsatisfactory'] } }) },
    async (req) => run(req, (tx, ctx) => grc.advanceEngagement(tx, ctx, req.params.id, (req.body as B) ?? {})));
  app.post<{ Params: P }>('/v1/grc/engagements/:id/findings', { schema: body(['title', 'severity', 'condition', 'recommendation'], { title: str,
    severity: { enum: ['low', 'medium', 'high', 'critical'] }, condition: str, recommendation: str }) },
  async (req, reply) => created(reply, run(req, (tx, ctx) => grc.addFinding(tx, ctx, req.params.id, req.body as B))));
  app.post<{ Params: P }>('/v1/grc/findings/:id/response', { schema: body(['response', 'actions'], { response: str, actions }) },
    async (req) => run(req, (tx, ctx) => grc.respondToFinding(tx, ctx, req.params.id, req.body as B)));
  app.get('/v1/grc/actions', async (req) => run(req, (tx, ctx) => grc.listActions(tx, ctx, { status: q(req).status, mine: q(req).mine === 'true' })));
  app.post<{ Params: P }>('/v1/grc/actions/:id/done', { schema: body(['note', 'date'], { note: str, date }) },
    async (req) => run(req, (tx, ctx) => grc.completeAction(tx, ctx, req.params.id, req.body as B)));
  app.post<{ Params: P }>('/v1/grc/actions/:id/verify', { schema: body(['date', 'accepted'], { date, accepted: { type: 'boolean' }, comment: str }) },
    async (req) => run(req, (tx, ctx) => grc.verifyAction(tx, ctx, req.params.id, req.body as B)));

  // Service desk
  app.post('/v1/svc/tickets', { schema: body(['queue', 'category', 'priority', 'title', 'description'], { queue: { enum: ['it', 'facilities', 'hr', 'finance'] },
    category: str, priority: { type: 'integer', minimum: 1, maximum: 4 }, title: str, description: str, assetId: uuid, spaceId: uuid }) },
  async (req, reply) => created(reply, run(req, (tx, ctx) => svc.createTicket(tx, ctx, req.body as B))));
  app.get('/v1/svc/tickets', async (req) => run(req, (tx, ctx) => svc.listTickets(tx, ctx, { queue: q(req).queue, status: q(req).status, mine: q(req).mine === 'true' })));
  app.get('/v1/svc/sla', async (req) => run(req, (tx, ctx) => svc.slaReport(tx, ctx, q(req).from ?? `${today().slice(0, 7)}-01`, q(req).to ?? today())));
  app.get<{ Params: P }>('/v1/svc/tickets/:id', async (req) => run(req, (tx, ctx) => svc.getTicket(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/svc/tickets/:id/assign', { schema: body([], { assigneeUserId: uuid }) },
    async (req) => run(req, (tx, ctx) => svc.assignTicket(tx, ctx, req.params.id, (req.body as B) ?? {})));
  app.post<{ Params: P }>('/v1/svc/tickets/:id/comments', { schema: body(['body'], { body: str, internal: { type: 'boolean' } }) },
    async (req, reply) => created(reply, run(req, (tx, ctx) => svc.addComment(tx, ctx, req.params.id, req.body as B))));
  app.post<{ Params: P }>('/v1/svc/tickets/:id/status', { schema: body(['status'], { status: { enum: ['in_progress', 'waiting', 'resolved'] }, resolution: str }) },
    async (req) => run(req, (tx, ctx) => svc.setTicketStatus(tx, ctx, req.params.id, req.body as B)));
  app.post<{ Params: P }>('/v1/svc/tickets/:id/confirm', { schema: body(['accepted'], { accepted: { type: 'boolean' }, satisfaction: score, comment: str }) },
    async (req) => run(req, (tx, ctx) => svc.confirmTicket(tx, ctx, req.params.id, req.body as B)));
  app.post<{ Params: P }>('/v1/svc/tickets/:id/maintenance', { schema: body(['scheduledDate'], { scheduledDate: date, priority: { enum: ['low', 'normal', 'high', 'urgent'] } }) },
    async (req, reply) => created(reply, run(req, (tx, ctx) => svc.raiseMaintenance(tx, ctx, req.params.id, req.body as B))));

  // Quality
  app.post<{ Params: P }>('/v1/qms/companies/:company/inspections', { schema: body(['sourceType', 'itemId', 'warehouseId', 'inspectedOn', 'qtyInspected'], {
    sourceType: { enum: ['pur.receipt', 'mfg.work_order', 'inv.stock'] }, sourceId: uuid, itemId: uuid, warehouseId: uuid, inspectedOn: date, qtyInspected: pos, qtyRejected: nonneg, notes: str }) },
  async (req, reply) => created(reply, run(req, (tx, ctx) => qms.inspect(tx, ctx, { ...(req.body as B), companyId: company(req) }))));
  app.get<{ Params: P }>('/v1/qms/companies/:company/receipts', async (req) => run(req, (tx, ctx) => qms.receiptsToInspect(tx, ctx, company(req))));
  app.get<{ Params: P }>('/v1/qms/companies/:company/inspections', async (req) => run(req, (tx, ctx) => qms.listInspections(tx, ctx, company(req))));
  app.post<{ Params: P }>('/v1/qms/companies/:company/ncrs', { schema: body(['severity', 'description', 'date'], { itemId: uuid, warehouseId: uuid, supplierId: uuid,
    qty: nonneg, severity: { enum: ['minor', 'major', 'critical'] }, description: str, date }) },
  async (req, reply) => created(reply, run(req, (tx, ctx) => qms.raiseNcr(tx, ctx, { ...(req.body as B), companyId: company(req) }))));
  app.get<{ Params: P }>('/v1/qms/companies/:company/ncrs', async (req) => run(req, (tx, ctx) => qms.listNcrs(tx, ctx, company(req))));
  app.get<{ Params: P }>('/v1/qms/companies/:company/supplier-quality', async (req) =>
    run(req, (tx, ctx) => qms.supplierQuality(tx, ctx, company(req), q(req).from ?? `${today().slice(0, 4)}-01-01`, q(req).to ?? today())));
  app.get<{ Params: P }>('/v1/qms/ncrs/:id', async (req) => run(req, (tx, ctx) => qms.getNcr(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/qms/ncrs/:id/disposition', { schema: body(['disposition', 'rootCause', 'date'], { disposition: { enum: ['use_as_is', 'rework', 'return_to_supplier', 'scrap'] },
    rootCause: str, date, actions }) },
  async (req) => run(req, (tx, ctx) => qms.dispositionNcr(tx, ctx, req.params.id, req.body as B)));
  app.post<{ Params: P }>('/v1/qms/ncrs/:id/close', async (req) => run(req, (tx, ctx) => qms.closeNcr(tx, ctx, req.params.id)));

  // Health and safety
  app.post('/v1/hse/incidents', { schema: body(['unitId', 'occurredAt', 'kind', 'severity', 'location', 'description'], { unitId: uuid, occurredAt: datetime,
    kind: { enum: ['injury', 'near_miss', 'property_damage', 'environmental', 'fire', 'vehicle'] }, severity: { enum: ['minor', 'moderate', 'serious', 'major', 'fatal'] },
    location: str, description: str, employeeId: uuid, vehicleId: uuid, lostDays: { type: 'integer', minimum: 0 } }) },
  async (req, reply) => created(reply, run(req, (tx, ctx) => hse.reportIncident(tx, ctx, req.body as B))));
  app.get('/v1/hse/incidents', async (req) => run(req, (tx, ctx) => hse.listIncidents(tx, ctx, q(req).status)));
  app.get<{ Params: P }>('/v1/hse/incidents/:id', async (req) => run(req, (tx, ctx) => hse.getIncident(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/hse/incidents/:id/investigate', { schema: body(['rootCause'], { rootCause: str, lostDays: { type: 'integer', minimum: 0 },
    severity: { enum: ['minor', 'moderate', 'serious', 'major', 'fatal'] }, actions }) },
  async (req) => run(req, (tx, ctx) => hse.investigate(tx, ctx, req.params.id, req.body as B)));
  app.post<{ Params: P }>('/v1/hse/incidents/:id/close', { schema: body(['date'], { date }) },
    async (req) => run(req, (tx, ctx) => hse.closeIncident(tx, ctx, req.params.id, (req.body as B).date)));
  app.get<{ Params: { unit: string } }>('/v1/hse/units/:unit/stats', async (req) =>
    run(req, (tx, ctx) => hse.safetyStats(tx, ctx, req.params.unit, q(req).from ?? `${today().slice(0, 4)}-01-01`, q(req).to ?? today(), q(req).hours ? Number(q(req).hours) : undefined)));

  // Facilities
  app.post('/v1/fac/spaces', { schema: body(['unitId', 'code', 'name', 'kind'], { unitId: uuid, code: str, name: str,
    kind: { enum: ['meeting_room', 'desk', 'office', 'parking', 'warehouse', 'other'] }, capacity: { type: 'integer', minimum: 1 }, bookable: { type: 'boolean' } }) },
  async (req, reply) => created(reply, run(req, (tx, ctx) => fac.createSpace(tx, ctx, req.body as B))));
  app.get('/v1/fac/spaces', async (req) => run(req, (tx) => fac.listSpaces(tx)));
  app.get('/v1/fac/bookings', async (req) => run(req, (tx) => fac.bookings(tx, q(req).date ?? today(), q(req).spaceId)));
  app.post('/v1/fac/bookings', { schema: body(['spaceId', 'startsAt', 'endsAt', 'purpose'], { spaceId: uuid, startsAt: datetime, endsAt: datetime, purpose: str, attendees: { type: 'integer', minimum: 1 } }) },
    async (req, reply) => created(reply, run(req, (tx, ctx) => fac.book(tx, ctx, req.body as B))));
  app.post<{ Params: P }>('/v1/fac/bookings/:id/cancel', async (req) => run(req, (tx, ctx) => fac.cancelBooking(tx, ctx, req.params.id)));
  app.get<{ Params: { unit: string } }>('/v1/fac/units/:unit/utilisation', async (req) =>
    run(req, (tx, ctx) => fac.utilisation(tx, ctx, req.params.unit, q(req).from ?? `${today().slice(0, 7)}-01`, q(req).to ?? today())));
}
