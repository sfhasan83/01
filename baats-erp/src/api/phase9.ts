import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx, Db, Tx } from '../core/db.ts';
import { UnauthenticatedError } from '../core/errors.ts';
import * as billing from '../platform/billing.ts';
import type { Metrics } from '../platform/metrics.ts';

type Run = <T>(req: FastifyRequest, fn: (tx: Tx, ctx: Ctx) => Promise<T>) => Promise<T>;
type B = any; // bodies are validated by the route schemas
type P = { id: string; code: string; tenant: string };

const str = { type: 'string', minLength: 1 } as const;
const period = { type: 'string', pattern: '^\\d{4}-\\d{2}$' } as const;
const body = (required: string[], properties: Record<string, object>) =>
  ({ body: { type: 'object', required, properties, additionalProperties: false } });

/** Routes that check their own key instead of a session. */
export const OPERATOR_PUBLIC_PATHS = ['/metrics', '/v1/platform/plans', '/v1/platform/plans/:code', '/v1/platform/tenants', '/v1/platform/tenants/:id/subscription',
  '/v1/platform/billing/run', '/v1/platform/billing/invoices', '/v1/platform/tenants/:tenant/invoices/:id/settle', '/v1/platform/billing/sweep'];

/** Constant-time comparison of a presented key with the expected one; no key configured means no access. */
export function keyMatches(presented: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = Buffer.from(presented), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Running BAATS as a service (v1): subscriptions, the operator's billing, monitoring. */
export function registerPhase9(app: FastifyInstance, run: Run, db: Db, opts: { platformAdminKey?: string; metricsToken?: string; metrics: Metrics; gate: billing.WriteGate }): void {
  const operator = async (req: FastifyRequest) => {
    if (!keyMatches(String(req.headers['x-platform-admin-key'] ?? ''), opts.platformAdminKey)) throw new UnauthenticatedError('platform administrator key required');
  };

  // The organization's own subscription.
  app.get('/v1/subscription', async (req) => run(req, (tx, ctx) => billing.mySubscription(tx, ctx)));

  // The platform operator.
  app.get('/v1/platform/plans', { preHandler: operator }, async () => billing.listPlans(db));
  app.put<{ Params: P }>('/v1/platform/plans/:code', {
    preHandler: operator,
    schema: body([], { name: str, monthlyPrice: { type: 'number', minimum: 0 }, currency: { type: 'string', pattern: '^[A-Za-z]{3}$' }, includedUsers: { type: 'integer', minimum: 0 },
      extraUserPrice: { type: 'number', minimum: 0 }, maxUsers: { type: ['integer', 'null'], minimum: 1 }, maxCompanies: { type: ['integer', 'null'], minimum: 1 },
      trialDays: { type: 'integer', minimum: 0 }, billable: { type: 'boolean' }, active: { type: 'boolean' } }),
  }, async (req) => billing.savePlan(db, req.params.code, req.body as B));
  app.get('/v1/platform/tenants', { preHandler: operator }, async () => billing.listTenants(db));
  app.patch<{ Params: P }>('/v1/platform/tenants/:id/subscription', {
    preHandler: operator,
    schema: body([], { plan: str, status: { enum: ['trial', 'active', 'suspended', 'cancelled'] }, trialEndsAt: str, billingEmail: { type: ['string', 'null'] } }),
  }, async (req) => { const r = await billing.setSubscription(db, req.params.id, req.body as B); opts.gate.forget(req.params.id); return r; });
  app.post('/v1/platform/billing/run', { preHandler: operator, schema: body(['period'], { period }) }, async (req) => billing.runBilling(db, (req.body as B).period));
  app.get('/v1/platform/billing/invoices', { preHandler: operator }, async (req) => billing.listBillingInvoices(db, (req.query as B).period || undefined));
  app.post<{ Params: P }>('/v1/platform/tenants/:tenant/invoices/:id/settle', { preHandler: operator, schema: body(['action'], { action: { enum: ['paid', 'void'] }, reference: { type: 'string', maxLength: 100 } }) },
    async (req) => { const r = await billing.settleInvoice(db, req.params.tenant, req.params.id, req.body as B); opts.gate.forget(req.params.tenant); return r; });
  app.post('/v1/platform/billing/sweep', { preHandler: operator }, async () => { const r = await billing.sweepSubscriptions(db); opts.gate.forget(); return { changed: r }; });

  // Monitoring, for Prometheus or any scraper: needs the metrics token (or the platform key) as a bearer token.
  app.get('/metrics', async (req, reply) => {
    const h = String(req.headers.authorization ?? '');
    const presented = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!keyMatches(presented, opts.metricsToken) && !keyMatches(presented, opts.platformAdminKey)) throw new UnauthenticatedError('the metrics token is needed');
    return reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8').send(await opts.metrics.render(db));
  });
}
