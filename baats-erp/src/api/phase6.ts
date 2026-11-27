import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readFileSync } from 'node:fs';
import type { Ctx, Tx } from '../core/db.ts';
import * as ess from '../ess/service.ts';
import * as exp from '../hr/expenses.ts';
import * as keys from '../iam/apikeys.ts';
import * as hooks from '../int/webhooks.ts';

type Run = <T>(req: FastifyRequest, fn: (tx: Tx, ctx: Ctx) => Promise<T>) => Promise<T>;
type B = any; // bodies are validated by the route schemas
type P = { company: string; id: string };

const str = { type: 'string', minLength: 1 } as const;
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const uuid = { type: 'string', format: 'uuid' } as const;
const body = (required: string[], properties: Record<string, object>) =>
  ({ body: { type: 'object', required, properties, additionalProperties: false } });
const today = () => new Date().toISOString().slice(0, 10);

const claimLine = {
  type: 'object', required: ['date', 'category', 'description', 'amount'], additionalProperties: false,
  properties: {
    date, category: str, description: str, amount: { type: 'number', exclusiveMinimum: 0 }, taxCode: str,
    receipt: { type: 'object', required: ['fileName', 'contentType', 'dataBase64'], additionalProperties: false,
      properties: { fileName: str, contentType: str, dataBase64: str } },
  },
};

/** The paths of BAATS Mobile, served without sign-in (the app signs in through the API). */
export const MOBILE_PATHS = ['/m', '/m/', '/m/manifest.webmanifest', '/m/sw.js', '/m/icon.svg', '/m/icon-192.png', '/m/icon-512.png'];
const MOBILE_FILES: Record<string, [string, string]> = {
  '/m/': ['index.html', 'text/html; charset=utf-8'],
  '/m/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/m/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/m/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/m/icon-192.png': ['icon-192.png', 'image/png'],
  '/m/icon-512.png': ['icon-512.png', 'image/png'],
};

/** Employee self-service, expense claims, API keys and webhooks (v1), and the BAATS Mobile app. */
export function registerPhase6(app: FastifyInstance, run: Run, opts: hooks.WebhookOptions): void {
  // BAATS Mobile: a phone web app that can be added to the home screen.
  app.get('/m', async (_req, reply) => reply.redirect('/m/'));
  for (const [path, [file, type]] of Object.entries(MOBILE_FILES)) {
    const content = readFileSync(new URL(`../mobile/${file}`, import.meta.url));
    app.get(path, async (_req, reply) => {
      reply.header('content-type', type).header('cache-control', 'no-cache')
        .header('x-content-type-options', 'nosniff');
      if (file === 'sw.js') reply.header('service-worker-allowed', '/m/');
      if (file === 'index.html') reply.header('content-security-policy',
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
      return reply.send(content);
    });
  }

  // Self-service: my record, payslips, leave and claims
  app.get('/v1/ess/me', async (req) => run(req, (tx, ctx) => ess.profile(tx, ctx)));
  app.get('/v1/ess/payslips', async (req) => run(req, (tx, ctx) => ess.payslips(tx, ctx)));
  app.get<{ Params: P }>('/v1/ess/payslips/:id', async (req) => run(req, (tx, ctx) => ess.payslip(tx, ctx, req.params.id)));
  app.get('/v1/ess/leave', async (req) => run(req, (tx, ctx) => ess.myLeave(tx, ctx)));
  app.post('/v1/ess/leave', { schema: body(['leaveType', 'dateFrom', 'dateTo'], { leaveType: str, dateFrom: date, dateTo: date, reason: { type: 'string' } }) },
    async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => ess.applyForLeave(tx, ctx, req.body as B)); });
  app.get('/v1/ess/expenses', async (req) => run(req, (tx, ctx) => ess.expenses(tx, ctx)));
  app.get('/v1/ess/expense-options', async (req) => run(req, (tx, ctx) => ess.expenseOptions(tx, ctx)));

  // Expense claims. A claim with photos of receipts is larger than other requests.
  app.post('/v1/hr/expenses', {
    bodyLimit: 8 * 1_048_576,
    schema: body(['companyId', 'title', 'lines'], { companyId: uuid, employeeId: uuid, title: str, submit: { type: 'boolean' },
      lines: { type: 'array', minItems: 1, maxItems: 30, items: claimLine } }),
  }, async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => exp.createClaim(tx, ctx, req.body as B)); });
  app.get('/v1/hr/expense-categories', async () => Object.entries(exp.CATEGORIES).map(([code, c]) => ({ code, ...c })));
  app.get<{ Params: P }>('/v1/hr/expenses/:id', async (req) => run(req, (tx, ctx) => exp.getClaim(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/hr/expenses/:id/submit', async (req) => run(req, (tx, ctx) => exp.submitClaim(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/hr/expenses/:id/pay', { schema: body([], { date, bankAccount: str }) },
    async (req) => run(req, (tx, ctx) => exp.payClaim(tx, ctx, req.params.id, { date: (req.body as B)?.date ?? today(), bankAccount: (req.body as B)?.bankAccount })));
  app.delete<{ Params: P }>('/v1/hr/expenses/:id', async (req) => run(req, (tx, ctx) => exp.deleteDraftClaim(tx, ctx, req.params.id)));
  app.get<{ Params: P }>('/v1/hr/companies/:company/expenses', async (req) =>
    run(req, (tx, ctx) => exp.listClaims(tx, ctx, req.params.company, (req.query as Record<string, string>).status || undefined)));
  app.get<{ Params: P }>('/v1/hr/receipts/:id', async (req, reply) => {
    const r = await run(req, (tx, ctx) => exp.receipt(tx, ctx, req.params.id));
    const safe = r.fileName.replace(/[^\w.\- ]/g, '_');
    reply.header('content-type', r.contentType).header('content-disposition', `inline; filename="${safe}"`)
      .header('x-content-type-options', 'nosniff').header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
      .header('cache-control', 'private, no-store');
    return reply.send(r.content);
  });

  // API keys for other systems
  app.get('/v1/int/api-keys', async (req) => run(req, (tx, ctx) => keys.listApiKeys(tx, ctx)));
  app.post('/v1/int/api-keys', { schema: body(['name'], { name: str, userId: uuid, expiresAt: str }) },
    async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => keys.createApiKey(tx, ctx, req.body as B)); });
  app.post<{ Params: P }>('/v1/int/api-keys/:id/revoke', async (req) => run(req, (tx, ctx) => keys.revokeApiKey(tx, ctx, req.params.id)));

  // Webhooks
  const events = { type: 'array', minItems: 1, maxItems: 20, items: str };
  app.get('/v1/int/webhooks', async (req) => run(req, (tx, ctx) => hooks.listWebhooks(tx, ctx)));
  app.post('/v1/int/webhooks', { schema: body(['name', 'url', 'events'], { name: str, url: str, events }) },
    async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => hooks.createWebhook(tx, ctx, opts, req.body as B)); });
  app.patch<{ Params: P }>('/v1/int/webhooks/:id', { schema: body([], { name: str, url: str, events, active: { type: 'boolean' } }) },
    async (req) => run(req, (tx, ctx) => hooks.updateWebhook(tx, ctx, opts, req.params.id, req.body as B)));
  app.delete<{ Params: P }>('/v1/int/webhooks/:id', async (req) => run(req, (tx, ctx) => hooks.deleteWebhook(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/int/webhooks/:id/ping', async (req, reply) => { reply.status(202); return run(req, (tx, ctx) => hooks.pingWebhook(tx, ctx, req.params.id)); });
  app.get<{ Params: P }>('/v1/int/webhooks/:id/deliveries', async (req) =>
    run(req, (tx, ctx) => hooks.listDeliveries(tx, ctx, req.params.id, Number((req.query as Record<string, string>).limit ?? 50))));
  app.post<{ Params: P }>('/v1/int/deliveries/:id/redeliver', async (req) => run(req, (tx, ctx) => hooks.redeliver(tx, ctx, req.params.id)));
}
