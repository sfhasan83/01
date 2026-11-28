import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx, Db, Tx } from '../core/db.ts';
import { ValidationError } from '../core/errors.ts';
import * as bankfiles from '../fin/bankfiles.ts';
import * as paylinks from '../fin/paylinks.ts';
import { invoicePdf } from '../fin/invoicepdf.ts';
import { emailInvoice } from '../fin/send.ts';
import * as mail from '../int/mail.ts';
import * as sso from '../iam/sso.ts';
import { openXlsx, rowsToCsv } from '../mig/xlsx.ts';

type Run = <T>(req: FastifyRequest, fn: (tx: Tx, ctx: Ctx) => Promise<T>) => Promise<T>;
type B = any; // bodies are validated by the route schemas
type P = { company: string; id: string };

export interface ConnectorOptions {
  secretKey: Buffer | null;
  /** The address people reach this server at (https://erp.example.com), for sign-in and payment return addresses; by default taken from the request. */
  publicUrl?: string;
  /** Lets an identity provider be http:// (on-premises, tests). */
  ssoAllowHttp?: boolean;
  fetchImpl?: typeof fetch;
  stripeBase?: string; msLoginBase?: string; graphBase?: string;
}

/** Routes reached without a session. */
export const CONNECTOR_PUBLIC_PATHS = ['/v1/auth/sso/providers', '/v1/auth/sso/start', '/v1/auth/sso/callback', '/v1/pay/stripe/notice'];

const str = { type: 'string', minLength: 1 } as const;
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const uuid = { type: 'string', format: 'uuid' } as const;
const strs = { type: 'array', items: str, maxItems: 20 } as const;
const body = (required: string[], properties: Record<string, object>) =>
  ({ body: { type: 'object', required, properties, additionalProperties: false } });

/** Where this server is, as the browser sees it. */
function baseUrl(req: FastifyRequest, opts: ConnectorOptions): string {
  if (opts.publicUrl) return opts.publicUrl.replace(/\/$/, '');
  const host = String(req.headers.host ?? '');
  if (!/^[A-Za-z0-9.-]+(:\d+)?$|^\[[0-9a-f:]+\](:\d+)?$/i.test(host)) throw new ValidationError('this request has no usable Host header');
  return `${req.protocol}://${host}`;
}

/** The text of an uploaded statement or import file (base64 in JSON). */
const decode = (b64: string, max: number) => {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > max) throw new ValidationError(`the file is larger than ${Math.round(max / 1_048_576)} MB`);
  return buf;
};

/** Connectors (v1): bank files, payment files, single sign-on, email, card payment links, Excel import. */
export function registerPhase8(app: FastifyInstance, run: Run, db: Db, opts: ConnectorOptions): void {
  const ssoOpts = { secretKey: opts.secretKey, allowHttp: opts.ssoAllowHttp, fetchImpl: opts.fetchImpl };
  const mailOpts = { secretKey: opts.secretKey, fetchImpl: opts.fetchImpl, msLoginBase: opts.msLoginBase, graphBase: opts.graphBase };
  const payOpts = { secretKey: opts.secretKey, fetchImpl: opts.fetchImpl, stripeBase: opts.stripeBase };

  // --- Bank details, statement files and payment files ---
  app.get<{ Params: P }>('/v1/fin/companies/:company/bank-details', async (req) => run(req, (tx, ctx) => bankfiles.listBankDetails(tx, ctx, req.params.company)));
  app.put<{ Params: P }>('/v1/fin/companies/:company/bank-details', {
    schema: body(['bankAccount', 'bankName'], { bankAccount: str, bankName: str, iban: { type: 'string' }, bic: { type: 'string' }, accountNo: { type: 'string' }, currency: { type: 'string', pattern: '^[A-Za-z]{3}$' } }),
  }, async (req) => run(req, (tx, ctx) => bankfiles.setBankDetails(tx, ctx, req.params.company, req.body as B)));
  app.post<{ Params: P }>('/v1/fin/companies/:company/bank-statement-files', {
    bodyLimit: 20 * 1_048_576,
    schema: body(['fileBase64'], { fileBase64: str, fileName: { type: 'string' }, bankAccount: str }),
  }, async (req, reply) => {
    const b = req.body as B;
    reply.status(201);
    return run(req, (tx, ctx) => bankfiles.importStatementFile(tx, ctx, { companyId: req.params.company, bankAccount: b.bankAccount, fileName: b.fileName,
      text: decode(b.fileBase64, 15 * 1_048_576).toString('utf8') }));
  });
  app.get<{ Params: P }>('/v1/fin/companies/:company/payment-files/payable', async (req) =>
    run(req, (tx, ctx) => bankfiles.payableForFile(tx, ctx, req.params.company, String((req.query as B).bankAccount ?? 'role:bank'))));
  app.get<{ Params: P }>('/v1/fin/companies/:company/payment-files', async (req) => run(req, (tx, ctx) => bankfiles.listPaymentFiles(tx, ctx, req.params.company)));
  app.post<{ Params: P }>('/v1/fin/companies/:company/payment-files', {
    schema: body(['paymentIds', 'executionDate'], { paymentIds: { type: 'array', items: uuid, minItems: 1, maxItems: 1000 }, executionDate: date, bankAccount: str }),
  }, async (req, reply) => { reply.status(201); const b = req.body as B; return run(req, (tx, ctx) => bankfiles.createPaymentFile(tx, ctx, { companyId: req.params.company, bankAccount: b.bankAccount ?? 'role:bank', paymentIds: b.paymentIds, executionDate: b.executionDate })); });
  app.get<{ Params: P }>('/v1/fin/payment-files/:id/xml', async (req, reply) => {
    const f = await run(req, (tx, ctx) => bankfiles.paymentFileXml(tx, ctx, req.params.id));
    return reply.header('content-type', 'application/xml; charset=utf-8').header('content-disposition', `attachment; filename="${f.name}"`).send(f.xml);
  });
  app.post<{ Params: P }>('/v1/fin/payment-files/:id/status', { schema: body(['status'], { status: { enum: ['sent', 'cancelled'] } }) },
    async (req) => run(req, (tx, ctx) => bankfiles.setPaymentFileStatus(tx, ctx, req.params.id, (req.body as B).status)));

  // --- Invoice PDF and email ---
  app.get<{ Params: P }>('/v1/fin/invoices/:id/pdf', async (req, reply) => {
    const f = await run(req, (tx, ctx) => invoicePdf(tx, ctx, req.params.id));
    return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${f.name}"`).send(f.pdf);
  });
  app.post<{ Params: P }>('/v1/fin/invoices/:id/email', { schema: body([], { to: strs, cc: strs, message: { type: 'string', maxLength: 4000 } }) },
    async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => emailInvoice(tx, ctx, req.params.id, req.body as B)); });
  app.get<{ Params: P }>('/v1/fin/invoices/:id/emails', async (req) => run(req, (tx, ctx) => mail.listMails(tx, ctx, { entityType: 'fin.invoice', entityId: req.params.id })));

  // --- Email settings and outbox ---
  app.get('/v1/int/mail/settings', async (req) => run(req, (tx, ctx) => mail.getSettings(tx, ctx)));
  app.put('/v1/int/mail/settings', {
    schema: body(['transport', 'fromAddress', 'fromName'], {
      transport: { enum: ['smtp', 'microsoft365'] }, host: { type: 'string' }, port: { type: 'integer' }, security: { enum: ['starttls', 'tls', 'none'] },
      username: { type: 'string' }, password: { type: 'string' }, msTenant: { type: 'string' }, msClientId: { type: 'string' }, msClientSecret: { type: 'string' },
      fromAddress: str, fromName: str, replyTo: { type: 'string' }, notifyApprovals: { type: 'boolean' }, active: { type: 'boolean' },
    }),
  }, async (req) => run(req, (tx, ctx) => mail.saveSettings(tx, ctx, mailOpts, req.body as B)));
  app.post('/v1/int/mail/test', { schema: body(['to'], { to: str }) }, async (req) => mail.sendTest(db, req.ctx, mailOpts, (req.body as B).to));
  app.get('/v1/int/mail/outbox', async (req) => run(req, (tx, ctx) => mail.listMails(tx, ctx)));
  app.post<{ Params: P }>('/v1/int/mail/:id/resend', async (req) => run(req, (tx, ctx) => mail.resend(tx, ctx, req.params.id)));

  // --- Card payments ---
  app.get<{ Params: P }>('/v1/fin/companies/:company/payment-gateway', async (req) => run(req, (tx, ctx) => paylinks.getGateway(tx, ctx, req.params.company)));
  app.put<{ Params: P }>('/v1/fin/companies/:company/payment-gateway', {
    schema: body([], { secretKey: { type: 'string' }, webhookSecret: { type: 'string' }, active: { type: 'boolean' }, clearingAccount: str }),
  }, async (req) => run(req, (tx, ctx) => paylinks.setGateway(tx, ctx, payOpts, req.params.company, req.body as B)));
  app.post<{ Params: P }>('/v1/fin/invoices/:id/payment-link', { schema: body([], { returnPath: { type: 'string', pattern: '^/[^/\\\\]' } }) }, async (req, reply) => {
    reply.status(201);
    const returnUrl = `${baseUrl(req, opts)}${(req.body as B)?.returnPath ?? '/'}`;
    return run(req, (tx, ctx) => paylinks.createLink(tx, ctx, payOpts, req.params.id, { returnUrl }));
  });
  app.get<{ Params: P }>('/v1/fin/companies/:company/payment-links', async (req) =>
    run(req, (tx, ctx) => paylinks.listLinks(tx, ctx, req.params.company, (req.query as B).invoiceId)));
  app.post<{ Params: P }>('/v1/fin/payment-links/:id/check', async (req) => run(req, (tx, ctx) => paylinks.checkLink(tx, ctx, payOpts, req.params.id)));
  app.post<{ Params: P }>('/v1/fin/payment-links/:id/cancel', async (req) => run(req, (tx, ctx) => paylinks.cancelLink(tx, ctx, payOpts, req.params.id)));
  // Stripe's signed notices need the body exactly as sent.
  app.register(async (raw) => {
    raw.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 1_048_576 }, (_req, b, done) => done(null, b));
    raw.post('/v1/pay/stripe/notice', async (req: FastifyRequest, reply: FastifyReply) => {
      const r = await paylinks.stripeNotice(db, payOpts, String(req.headers['stripe-signature'] ?? ''), String(req.body ?? ''));
      return reply.status(200).send({ received: true, ...r });
    });
  });

  // --- Single sign-on ---
  app.get('/v1/iam/sso-providers', async (req) => run(req, (tx, ctx) => sso.listProviders(tx, ctx)));
  app.post('/v1/iam/sso-providers', {
    schema: body(['kind', 'clientId', 'clientSecret'], { kind: { enum: ['microsoft', 'google', 'oidc'] }, name: { type: 'string' }, issuer: { type: 'string' },
      msTenant: { type: 'string' }, clientId: str, clientSecret: str, allowedDomains: strs }),
  }, async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => sso.createProvider(tx, ctx, ssoOpts, req.body as B)); });
  app.patch<{ Params: P }>('/v1/iam/sso-providers/:id', { schema: body([], { active: { type: 'boolean' }, allowedDomains: strs, clientSecret: str, name: str }) },
    async (req) => run(req, (tx, ctx) => sso.updateProvider(tx, ctx, ssoOpts, req.params.id, req.body as B)));
  app.delete<{ Params: P }>('/v1/iam/sso-providers/:id', async (req) => run(req, (tx, ctx) => sso.deleteProvider(tx, ctx, req.params.id)));
  app.get('/v1/iam/sso-redirect-uri', async (req) => ({ redirectUri: `${baseUrl(req, opts)}/v1/auth/sso/callback` }));
  app.get('/v1/auth/sso/providers', async (req) => sso.publicProviders(db, String((req.query as B).tenant ?? '')));
  app.get('/v1/auth/sso/start', async (req, reply) => {
    const q = req.query as B;
    const r = await sso.startSignIn(db, ssoOpts, { tenant: String(q.tenant ?? ''), providerId: String(q.provider ?? ''),
      redirectUri: `${baseUrl(req, opts)}/v1/auth/sso/callback`, returnTo: q.returnTo ? String(q.returnTo) : '/' });
    return reply.redirect(r.url);
  });
  // The session goes back in the address's fragment, which browsers never send to a server.
  app.get('/v1/auth/sso/callback', async (req, reply) => {
    const q = req.query as B;
    const back = (returnTo: string, frag: Record<string, string>) => reply.redirect(`${returnTo}#${new URLSearchParams(frag).toString()}`);
    if (q.error) return back('/', { sso_error: String(q.error_description ?? q.error).slice(0, 300) });
    try {
      const s = await sso.finishSignIn(db, ssoOpts, { state: String(q.state ?? ''), code: String(q.code ?? ''), ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });
      return back(s.returnTo, { sso_token: s.token, tenant: s.tenantCode });
    } catch (err) {
      return back('/', { sso_error: (err as Error).message.slice(0, 300) });
    }
  });

  // --- Excel workbooks for the data import ---
  app.post('/v1/mig/xlsx', { bodyLimit: 30 * 1_048_576, schema: body(['fileBase64'], { fileBase64: str, sheet: { type: 'string' } }) }, async (req) => {
    const b = req.body as B;
    const wb = openXlsx(decode(b.fileBase64, 20 * 1_048_576));
    const rows = wb.read(b.sheet || undefined);
    return { sheets: wb.sheets, sheet: b.sheet || wb.sheets[0], rows: Math.max(0, rows.length - 1), csv: rowsToCsv(rows) };
  });
}
