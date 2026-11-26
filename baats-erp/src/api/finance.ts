import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx, Tx } from '../core/db.ts';
import * as ledger from '../fin/ledger.ts';
import * as setup from '../fin/setup.ts';
import * as docs from '../fin/documents.ts';
import * as tax from '../fin/tax.ts';
import * as reports from '../fin/reports.ts';

type Run = <T>(req: FastifyRequest, fn: (tx: Tx, ctx: Ctx) => Promise<T>) => Promise<T>;
type B = any; // bodies are validated by the route schemas
type P = { company: string; id: string };

const str = { type: 'string', minLength: 1 } as const;
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const uuid = { type: 'string', format: 'uuid' } as const;
const num = { type: 'number' } as const;
const body = (required: string[], properties: Record<string, object>) =>
  ({ body: { type: 'object', required, properties, additionalProperties: false } });

const journalLine = {
  type: 'object', required: ['account'], additionalProperties: false,
  properties: { account: str, debit: { type: 'number', minimum: 0 }, credit: { type: 'number', minimum: 0 }, partyId: uuid, unitId: uuid, description: str },
};
const invoiceLine = {
  type: 'object', required: ['description', 'quantity', 'unitPrice', 'taxCode'], additionalProperties: false,
  properties: { itemId: uuid, description: str, quantity: { type: 'number', exclusiveMinimum: 0 }, unitPrice: { type: 'number', minimum: 0 },
    discount: { type: 'number', minimum: 0 }, account: str, taxCode: str, unitId: uuid },
};

/** Finance API (v1). Every company-scoped route takes the company's org unit id. */
export function registerFinance(app: FastifyInstance, run: Run): void {
  const q = (req: FastifyRequest) => req.query as Record<string, string>;
  const today = () => new Date().toISOString().slice(0, 10);

  // Books, chart of accounts, tax codes, periods
  app.post('/v1/fin/companies', {
    schema: body(['unitId', 'legalName', 'openFrom'], {
      unitId: uuid, legalName: str, taxRegistrationNo: str, fiscalYearStartMonth: { type: 'integer', minimum: 1, maximum: 12 },
      vatPeriod: { enum: ['monthly', 'quarterly'] }, vatQuarterStartMonth: { type: 'integer', minimum: 1, maximum: 3 },
      corporateTaxRate: num, corporateTaxThreshold: num, openFrom: date,
    }),
  }, async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => setup.setupCompany(tx, ctx, req.body as B)); });
  app.get<{ Params: P }>('/v1/fin/companies/:company/accounts', async (req) => run(req, (tx, ctx) => setup.listAccounts(tx, ctx, req.params.company)));
  app.post<{ Params: P }>('/v1/fin/companies/:company/accounts', { schema: body(['code', 'name', 'parentCode'], { code: str, name: str, parentCode: str }) },
    async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => setup.createAccount(tx, ctx, req.params.company, req.body as B)); });
  app.get('/v1/fin/tax-codes', async (req) => run(req, (tx) => setup.listTaxCodes(tx, q(req).country ?? 'AE')));
  app.put<{ Params: P & { period: string } }>('/v1/fin/companies/:company/periods/:period', { schema: body(['status'], { status: { enum: ['open', 'closed'] } }) },
    async (req) => run(req, (tx, ctx) => ledger.setPeriodStatus(tx, ctx, req.params.company, req.params.period, (req.body as B).status)));
  app.post<{ Params: P }>('/v1/fin/companies/:company/year-end-close', { schema: body(['fiscalYear'], { fiscalYear: { type: 'integer' } }) },
    async (req) => run(req, (tx, ctx) => reports.closeYear(tx, ctx, req.params.company, (req.body as B).fiscalYear)));

  // Journals
  app.post<{ Params: P }>('/v1/fin/companies/:company/journals', {
    schema: body(['date', 'memo', 'lines'], { type: { enum: ['manual', 'opening'] }, date, memo: str, currency: str, fxRate: { type: 'number', exclusiveMinimum: 0 },
      lines: { type: 'array', minItems: 2, items: journalLine } }),
  }, async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => ledger.createManualJournal(tx, ctx, { ...(req.body as B), companyId: req.params.company })); });
  app.get<{ Params: P }>('/v1/fin/journals/:id', async (req) => run(req, (tx, ctx) => ledger.getJournal(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/fin/journals/:id/reverse', { schema: body(['date', 'reason'], { date, reason: str }) },
    async (req) => run(req, (tx, ctx) => ledger.reverseJournal(tx, ctx, req.params.id, (req.body as B).date, (req.body as B).reason)));

  // Invoices and credit notes
  app.post<{ Params: P }>('/v1/fin/companies/:company/invoices', {
    schema: body(['kind', 'partyId', 'date', 'lines'], {
      kind: { enum: ['sales_invoice', 'sales_credit', 'purchase_invoice', 'purchase_credit'] }, partyId: uuid, date, dueDate: date, taxDate: date,
      currency: str, fxRate: { type: 'number', exclusiveMinimum: 0 }, supplierRef: str, creditOf: uuid, notes: str,
      lines: { type: 'array', minItems: 1, items: invoiceLine },
    }),
  }, async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => docs.createInvoice(tx, ctx, { ...(req.body as B), companyId: req.params.company })); });
  app.get<{ Params: P }>('/v1/fin/companies/:company/invoices', async (req) =>
    run(req, (tx, ctx) => docs.listInvoices(tx, ctx, req.params.company, q(req))));
  app.get<{ Params: P }>('/v1/fin/invoices/:id', async (req) => run(req, (tx, ctx) => docs.getInvoice(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/fin/invoices/:id/post', async (req) => run(req, (tx, ctx) => docs.postInvoice(tx, ctx, req.params.id)));
  app.delete<{ Params: P }>('/v1/fin/invoices/:id', async (req, reply) => { await run(req, (tx, ctx) => docs.deleteDraft(tx, ctx, req.params.id)); reply.status(204); });

  // Receipts and payments
  app.post<{ Params: P }>('/v1/fin/companies/:company/payments', {
    schema: body(['kind', 'partyId', 'date', 'bankAccount', 'amount'], {
      kind: { enum: ['receipt', 'payment'] }, partyId: uuid, date, bankAccount: str, currency: str, fxRate: { type: 'number', exclusiveMinimum: 0 },
      amount: { type: 'number', exclusiveMinimum: 0 }, reference: str,
      allocations: { type: 'array', items: { type: 'object', required: ['invoiceId', 'amount'], properties: { invoiceId: uuid, amount: { type: 'number', exclusiveMinimum: 0 } } } },
    }),
  }, async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => docs.recordPayment(tx, ctx, { ...(req.body as B), companyId: req.params.company })); });
  app.post<{ Params: P }>('/v1/fin/payments/:id/allocate', { schema: body(['invoiceId', 'amount', 'date'], { invoiceId: uuid, amount: { type: 'number', exclusiveMinimum: 0 }, date }) },
    async (req) => run(req, (tx, ctx) => docs.allocateAdvance(tx, ctx, { ...(req.body as B), paymentId: req.params.id })));

  // Tax
  app.get<{ Params: P }>('/v1/fin/companies/:company/vat-return', async (req) =>
    run(req, (tx, ctx) => tax.computeVatReturn(tx, ctx, req.params.company, q(req).from, q(req).to)));
  app.post<{ Params: P }>('/v1/fin/companies/:company/vat-returns', { schema: body(['from', 'to'], { from: date, to: date, filedRef: str }) },
    async (req, reply) => { reply.status(201); const b = req.body as B; return run(req, (tx, ctx) => tax.fileVatReturn(tx, ctx, req.params.company, b.from, b.to, b.filedRef)); });
  app.post<{ Params: P }>('/v1/fin/companies/:company/corporate-tax', { schema: body(['fiscalYear'], { fiscalYear: { type: 'integer' }, postingDate: date }) },
    async (req) => { const b = req.body as B; return run(req, (tx, ctx) => tax.provideCorporateTax(tx, ctx, req.params.company, b.fiscalYear, b.postingDate)); });

  // Reports
  app.get<{ Params: P }>('/v1/fin/companies/:company/trial-balance', async (req) =>
    run(req, (tx, ctx) => reports.trialBalance(tx, ctx, req.params.company, q(req).to ?? today(), q(req).from)));
  app.get<{ Params: P }>('/v1/fin/companies/:company/profit-and-loss', async (req) =>
    run(req, (tx, ctx) => reports.profitAndLoss(tx, ctx, req.params.company, q(req).from, q(req).to ?? today())));
  app.get<{ Params: P }>('/v1/fin/companies/:company/balance-sheet', async (req) =>
    run(req, (tx, ctx) => reports.balanceSheet(tx, ctx, req.params.company, q(req).asOf ?? today())));
  app.get<{ Params: P & { account: string } }>('/v1/fin/companies/:company/ledger/:account', async (req) =>
    run(req, (tx, ctx) => reports.accountLedger(tx, ctx, req.params.company, req.params.account, q(req).from, q(req).to ?? today())));
  app.get<{ Params: P & { party: string } }>('/v1/fin/companies/:company/statements/:party', async (req) =>
    run(req, (tx, ctx) => reports.partyStatement(tx, ctx, req.params.company, req.params.party, q(req).from ?? '0001-01-01', q(req).to ?? today())));
  app.get<{ Params: P & { side: 'receivable' | 'payable' } }>('/v1/fin/companies/:company/ageing/:side', async (req) =>
    run(req, (tx, ctx) => reports.ageing(tx, ctx, req.params.company, req.params.side, q(req).asOf ?? today())));
}
