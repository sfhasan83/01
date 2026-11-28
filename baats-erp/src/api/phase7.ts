import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx, Tx } from '../core/db.ts';
import { ValidationError } from '../core/errors.ts';
import * as mig from '../mig/import.ts';
import * as sess from '../iam/sessions.ts';

type Run = <T>(req: FastifyRequest, fn: (tx: Tx, ctx: Ctx) => Promise<T>) => Promise<T>;
type B = any; // bodies are validated by the route schemas
type P = { company: string; id: string; kind: string };

const str = { type: 'string', minLength: 1 } as const;
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const body = (required: string[], properties: Record<string, object>) =>
  ({ body: { type: 'object', required, properties, additionalProperties: false } });

/** Data import, sessions and passwords (v1). */
export function registerPhase7(app: FastifyInstance, run: Run): void {
  // Importing a company's data
  app.get('/v1/mig/kinds', async () => mig.IMPORT_KINDS);
  app.get<{ Params: P }>('/v1/mig/templates/:kind', async (req, reply) => {
    const kind = req.params.kind as mig.ImportKind;
    if (!(kind in mig.IMPORT_KINDS)) throw new ValidationError(`unknown import ${kind}`);
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="baats-${kind}.csv"`);
    return mig.template(kind);
  });
  app.post<{ Params: P }>('/v1/mig/companies/:company/import', {
    bodyLimit: 20 * 1_048_576,
    schema: body(['kind', 'csv'], { kind: { enum: Object.keys(mig.IMPORT_KINDS) }, csv: str, fileName: { type: 'string' }, asOf: date, dryRun: { type: 'boolean' } }),
  }, async (req) => run(req, (tx, ctx) => mig.runImport(tx, ctx, { ...(req.body as B), companyId: req.params.company })));
  app.get<{ Params: P }>('/v1/mig/companies/:company/imports', async (req) => run(req, (tx, ctx) => mig.listImportRuns(tx, ctx, req.params.company)));
  // A BAATS Accounting book becomes the customer, supplier and item files, to check and import like any other.
  app.post('/v1/mig/baats-accounting', { bodyLimit: 50 * 1_048_576, schema: body(['json'], { json: str }) },
    async (req) => mig.fromBaatsAccounting((req.body as B).json));

  // My sessions and password
  app.get('/v1/me/sessions', async (req) => run(req, (tx, ctx) => sess.mySessions(tx, ctx, req.token)));
  app.post('/v1/me/sessions/revoke-others', async (req) => run(req, (tx, ctx) => sess.revokeOtherSessions(tx, ctx, req.token)));
  app.delete<{ Params: P }>('/v1/me/sessions/:id', async (req) => run(req, (tx, ctx) => sess.revokeSession(tx, ctx, req.params.id)));
  app.post('/v1/me/password', { schema: body(['current', 'next'], { current: str, next: str }) },
    async (req) => run(req, (tx, ctx) => sess.changePassword(tx, ctx, req.token, req.body as B)));
  app.post<{ Params: P }>('/v1/iam/users/:id/password', { schema: body(['password'], { password: str }) },
    async (req) => run(req, (tx, ctx) => sess.setPassword(tx, ctx, req.params.id, (req.body as B).password)));
}
