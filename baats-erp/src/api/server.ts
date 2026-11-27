import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { AppError, UnauthenticatedError } from '../core/errors.ts';
import type { Ctx, Db, Tx } from '../core/db.ts';
import { authorize, decide } from '../iam/authz.ts';
import * as auth from '../iam/auth.ts';
import * as iam from '../iam/service.ts';
import * as org from '../org/service.ts';
import * as mdm from '../mdm/service.ts';
import * as wf from '../workflow/engine.ts';
import * as audit from '../audit/service.ts';
import { onboardTenant } from '../platform/onboarding.ts';
import { registerFinance } from './finance.ts';
import { registerOperations } from './operations.ts';
import { registerPhase3 } from './phase3.ts';
import { registerPhase4 } from './phase4.ts';
import { registerPhase5 } from './phase5.ts';
import { registerAssistant } from './assistant.ts';
import { parseSecretKey } from '../ai/secrets.ts';
import type { AiOptions } from '../ai/assistant.ts';

declare module 'fastify' {
  interface FastifyRequest { ctx: Ctx; token: string }
}

export interface ServerOptions {
  db: Db; platformAdminKey?: string; logger?: boolean;
  /** AI assistant: secretKey encrypts provider API keys (32 bytes, base64 or hex); allowPrivateUrls permits local model servers. */
  ai?: { secretKey?: string; allowPrivateUrls?: boolean; providerFactory?: AiOptions['providerFactory'] };
}

const str = { type: 'string', minLength: 1 } as const;
const uuid = { type: 'string', format: 'uuid' } as const;
const obj = (required: string[], properties: Record<string, object>) =>
  ({ body: { type: 'object', required, properties, additionalProperties: false } });

/** HTTP API (v1). Every route except login and onboarding needs a bearer session token. */
export function buildServer(opts: ServerOptions): FastifyInstance {
  const { db } = opts;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1_048_576 });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details });
    const e = err as { validation?: unknown; statusCode?: number; message: string };
    if (e.validation) return reply.status(400).send({ error: 'bad_request', message: e.message });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: 'bad_request', message: e.message });
    app.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'internal error' });
  });

  app.decorateRequest('ctx', null as unknown as Ctx);
  app.decorateRequest('token', '');
  const PUBLIC = new Set(['/v1/auth/login', '/v1/platform/tenants', '/health']);
  app.addHook('onRequest', async (req: FastifyRequest) => {
    if (PUBLIC.has(req.routeOptions.url ?? '')) return;
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new UnauthenticatedError();
    req.token = h.slice(7);
    req.ctx = await auth.authenticate(db, req.token);
  });
  const run = <T>(req: FastifyRequest, fn: (tx: Tx, ctx: Ctx) => Promise<T>) => db.withTenant(req.ctx, (tx) => fn(tx, req.ctx));
  type B = any; // request bodies are validated by the route schemas below
  type P = { id: string };

  app.get('/health', async () => ({ ok: true }));

  // --- Platform ---------------------------------------------------------------
  app.post('/v1/platform/tenants', {
    schema: obj(['code', 'name', 'baseCurrency', 'countryCode', 'admin'], {
      code: str, name: str, baseCurrency: str, countryCode: str,
      admin: { type: 'object', required: ['email', 'displayName', 'password'], properties: { email: str, displayName: str, password: str } },
    }),
  }, async (req, reply) => {
    const key = String(req.headers['x-platform-admin-key'] ?? '');
    const expected = opts.platformAdminKey ?? '';
    if (!expected || key.length !== expected.length || !timingSafeEqual(Buffer.from(key), Buffer.from(expected))) {
      throw new UnauthenticatedError('platform administrator key required');
    }
    reply.status(201);
    return onboardTenant(db, req.body as B);
  });

  // --- Auth and self-service ----------------------------------------------------
  app.post('/v1/auth/login', { schema: obj(['tenant', 'email', 'password'], { tenant: str, email: str, password: str, totp: str }) },
    async (req) => auth.login(db, req.body as B));
  app.post('/v1/auth/logout', async (req, reply) => { await auth.logout(db, req.token); reply.status(204); });
  app.post('/v1/auth/mfa/enrol', async (req) => run(req, (tx, ctx) => auth.beginMfaEnrolment(tx, ctx)));
  app.post('/v1/auth/mfa/confirm', { schema: obj(['code'], { code: str }) },
    async (req, reply) => { await run(req, (tx, ctx) => auth.confirmMfaEnrolment(tx, ctx, (req.body as B).code)); reply.status(204); });
  app.get('/v1/me', async (req) => run(req, async (tx, ctx) => ({
    user: (await tx.query('SELECT id, email, display_name, employee_id, mfa_enabled FROM iam.users WHERE id = $1', [ctx.userId])).rows[0],
    permissions: await iam.effectivePermissions(tx, ctx.userId!),
    inbox: await wf.inbox(tx, ctx),
  })));
  app.post('/v1/me/delegations', { schema: obj(['delegateUserId', 'validFrom', 'validTo'], { delegateUserId: uuid, validFrom: str, validTo: str, reason: str }) },
    async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => iam.createDelegation(tx, ctx, req.body as B)); });

  // --- Organization ----------------------------------------------------------------
  app.get('/v1/org/unit-types', async (req) => run(req, (tx) => org.listUnitTypes(tx)));
  app.post('/v1/org/unit-types', { schema: obj(['code', 'name', 'rank'], { code: str, name: str, rank: { type: 'integer' }, isLegalEntity: { type: 'boolean' } }) },
    async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => org.createUnitType(tx, ctx, req.body as B)); });
  app.get('/v1/org/units', async (req) => run(req, (tx, ctx) => org.listUnits(tx, ctx, (req.query as B).root)));
  app.post('/v1/org/units', {
    schema: obj(['typeCode', 'parentId', 'code', 'name'], {
      typeCode: str, parentId: uuid, code: str, name: str, countryCode: str, currencyCode: str,
      isCostCenter: { type: 'boolean' }, isProfitCenter: { type: 'boolean' }, attributes: { type: 'object' },
    }),
  }, async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => org.createUnit(tx, ctx, req.body as B)); });
  app.patch<{ Params: P }>('/v1/org/units/:id', {
    schema: obj([], { name: str, parentId: uuid, headEmployeeId: { type: ['string', 'null'] }, status: str, isCostCenter: { type: 'boolean' }, isProfitCenter: { type: 'boolean' } }),
  }, async (req) => run(req, async (tx, ctx) => {
    const { parentId, ...rest } = req.body as B;
    if (parentId) await org.moveUnit(tx, ctx, req.params.id, parentId);
    return org.updateUnit(tx, ctx, req.params.id, rest);
  }));
  app.post('/v1/org/designations', { schema: obj(['code', 'title'], { code: str, title: str, grade: str }) },
    async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => org.createDesignation(tx, ctx, req.body as B)); });
  app.get('/v1/org/employees', async (req) => run(req, (tx, ctx) => {
    const q = req.query as B;
    return org.listEmployees(tx, ctx, { unitId: q.unitId, limit: q.limit ? Number(q.limit) : undefined, offset: q.offset ? Number(q.offset) : undefined });
  }));
  app.post('/v1/org/employees', {
    schema: obj(['employeeNo', 'firstName', 'lastName', 'unitId'], {
      employeeNo: str, firstName: str, lastName: str, email: str, unitId: uuid, designationId: uuid, managerId: uuid, hireDate: str, attributes: { type: 'object' },
    }),
  }, async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => org.createEmployee(tx, ctx, req.body as B)); });
  app.patch<{ Params: P }>('/v1/org/employees/:id', { schema: obj([], { unitId: uuid, managerId: { type: ['string', 'null'] }, designationId: uuid, status: str }) },
    async (req) => run(req, (tx, ctx) => org.updateEmployee(tx, ctx, req.params.id, req.body as B)));
  app.get<{ Params: P }>('/v1/org/employees/:id/reports', async (req) => run(req, (tx, ctx) => org.directReports(tx, ctx, req.params.id)));

  // --- Identity and access ------------------------------------------------------------
  app.get('/v1/iam/users', async (req) => run(req, (tx, ctx) => iam.listUsers(tx, ctx)));
  app.post('/v1/iam/users', { schema: obj(['email', 'displayName'], { email: str, displayName: str, password: str, employeeId: uuid }) },
    async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => iam.createUser(tx, ctx, req.body as B)); });
  app.post<{ Params: P }>('/v1/iam/users/:id/status', { schema: obj(['status'], { status: { enum: ['active', 'disabled'] } }) },
    async (req) => run(req, (tx, ctx) => iam.setUserStatus(tx, ctx, req.params.id, (req.body as B).status)));
  app.get('/v1/iam/roles', async (req) => run(req, (tx, ctx) => iam.listRoles(tx, ctx)));
  app.post('/v1/iam/roles', { schema: obj(['code', 'name'], { code: str, name: str }) },
    async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => iam.createRole(tx, ctx, req.body as B)); });
  app.put<{ Params: P & { perm: string } }>('/v1/iam/roles/:id/permissions/:perm', { schema: obj([], { conditions: { type: 'object' } }) },
    async (req) => run(req, (tx, ctx) => iam.grantPermission(tx, ctx, req.params.id, req.params.perm, (req.body as B)?.conditions ?? {})));
  app.delete<{ Params: P & { perm: string } }>('/v1/iam/roles/:id/permissions/:perm',
    async (req, reply) => { await run(req, (tx, ctx) => iam.revokePermission(tx, ctx, req.params.id, req.params.perm)); reply.status(204); });
  app.post('/v1/iam/assignments', {
    schema: obj(['userId', 'roleId', 'scopeUnitId'], { userId: uuid, roleId: uuid, scopeUnitId: uuid, includeDescendants: { type: 'boolean' }, validFrom: str, validTo: str }),
  }, async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => iam.assignRole(tx, ctx, req.body as B)); });
  app.delete<{ Params: P }>('/v1/iam/assignments/:id', async (req, reply) => { await run(req, (tx, ctx) => iam.removeAssignment(tx, ctx, req.params.id)); reply.status(204); });
  app.post('/v1/iam/sod-rules', { schema: obj(['name', 'permissionA', 'permissionB'], { name: str, permissionA: str, permissionB: str }) },
    async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => iam.createSodRule(tx, ctx, req.body as B)); });
  app.post('/v1/iam/delegations', {
    schema: obj(['delegatorUserId', 'delegateUserId', 'validFrom', 'validTo'], { delegatorUserId: uuid, delegateUserId: uuid, validFrom: str, validTo: str, reason: str }),
  }, async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => iam.createDelegation(tx, ctx, req.body as B)); });
  // Explain an access decision for the caller ("why can't I...?").
  app.post('/v1/iam/check', { schema: obj(['permission'], { permission: str, unitId: uuid, attrs: { type: 'object' } }) },
    async (req) => run(req, (tx, ctx) => { const b = req.body as B; return decide(tx, ctx.userId!, b.permission, { unitId: b.unitId, attrs: b.attrs }); }));

  // --- Master data -----------------------------------------------------------------------
  app.get('/v1/mdm/uoms', async (req) => run(req, (tx) => mdm.listUoms(tx)));
  app.post('/v1/mdm/uoms', { schema: obj(['code', 'name'], { code: str, name: str }) },
    async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => mdm.createUom(tx, ctx, req.body as B)); });
  app.get('/v1/mdm/items', async (req) => run(req, (tx, ctx) => mdm.listItems(tx, ctx, (req.query as B).q)));
  app.post('/v1/mdm/items', {
    schema: obj(['code', 'name', 'itemType', 'baseUom'], { code: str, name: str, itemType: { enum: ['stock', 'service', 'non_stock', 'asset'] }, baseUom: str, barcode: str, attributes: { type: 'object' } }),
  }, async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => mdm.createItem(tx, ctx, req.body as B)); });
  app.get('/v1/mdm/parties', async (req) => run(req, (tx, ctx) => mdm.listParties(tx, ctx, req.query as B)));
  app.post('/v1/mdm/parties', {
    schema: obj(['code', 'name', 'countryCode', 'ownerUnitId'], {
      code: str, name: str, isCustomer: { type: 'boolean' }, isSupplier: { type: 'boolean' }, countryCode: str, currencyCode: str,
      taxRegistrationNo: str, creditLimit: { type: 'number', minimum: 0 }, ownerUnitId: uuid, attributes: { type: 'object' },
    }),
  }, async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => mdm.createParty(tx, ctx, req.body as B)); });
  app.patch<{ Params: P }>('/v1/mdm/parties/:id', { schema: obj([], { name: str, creditLimit: { type: 'number', minimum: 0 }, taxRegistrationNo: str, attributes: { type: 'object' } }) },
    async (req) => run(req, (tx, ctx) => mdm.updateParty(tx, ctx, req.params.id, req.body as B)));
  app.post<{ Params: P }>('/v1/mdm/parties/:id/submit', async (req) => run(req, (tx, ctx) => mdm.submitParty(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/mdm/parties/:id/block', { schema: obj(['blocked'], { blocked: { type: 'boolean' } }) },
    async (req) => run(req, (tx, ctx) => mdm.setPartyBlocked(tx, ctx, req.params.id, (req.body as B).blocked)));

  // --- Workflow ------------------------------------------------------------------------
  app.get('/v1/wf/definitions', async (req) => run(req, (tx) => wf.listDefinitions(tx)));
  app.post('/v1/wf/definitions', { schema: obj(['code', 'name', 'entityType', 'definition'], { code: str, name: str, entityType: str, definition: { type: 'object' } }) },
    async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => wf.publishDefinition(tx, ctx, req.body as B)); });
  app.get('/v1/wf/inbox', async (req) => run(req, (tx, ctx) => wf.inbox(tx, ctx)));
  app.get<{ Params: P }>('/v1/wf/instances/:id', async (req) => run(req, (tx, ctx) => wf.getInstance(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/wf/instances/:id/withdraw', { schema: obj(['reason'], { reason: str }) },
    async (req, reply) => { await run(req, (tx, ctx) => wf.cancel(tx, ctx, req.params.id, (req.body as B).reason)); reply.status(204); });
  app.post<{ Params: P }>('/v1/wf/tasks/:id/approve', { schema: obj([], { comment: str }) },
    async (req) => run(req, (tx, ctx) => wf.act(tx, ctx, req.params.id, 'approve', (req.body as B)?.comment)));
  app.post<{ Params: P }>('/v1/wf/tasks/:id/reject', { schema: obj(['comment'], { comment: str }) },
    async (req) => run(req, (tx, ctx) => wf.act(tx, ctx, req.params.id, 'reject', (req.body as B).comment)));

  app.post('/v1/wf/escalations/run', async (req) => run(req, async (tx, ctx) => {
    await authorize(tx, ctx, 'wf.escalation.run');
    return { escalated: await wf.runEscalations(tx) };
  }));

  // --- Audit -------------------------------------------------------------------------
  app.get('/v1/audit/entries', async (req) => run(req, (tx, ctx) => {
    const q = req.query as B;
    return audit.queryAudit(tx, ctx, { ...q, limit: q.limit ? Number(q.limit) : undefined, beforeSeq: q.beforeSeq ? Number(q.beforeSeq) : undefined });
  }));
  app.get('/v1/audit/verify', async (req) => run(req, (tx, ctx) => audit.verifyChain(tx, ctx)));

  registerFinance(app, run);
  registerOperations(app, run);
  registerPhase3(app, run);
  registerPhase4(app, run);
  registerPhase5(app, run);
  registerAssistant(app, run, db, { secretKey: parseSecretKey(opts.ai?.secretKey), allowPrivateUrls: opts.ai?.allowPrivateUrls ?? false, providerFactory: opts.ai?.providerFactory });

  return app;
}
