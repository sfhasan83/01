import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx, Db, Tx } from '../core/db.ts';
import * as ai from '../ai/assistant.ts';

type Run = <T>(req: FastifyRequest, fn: (tx: Tx, ctx: Ctx) => Promise<T>) => Promise<T>;
type B = any; // bodies are validated by the route schemas
type P = { id: string };

const uuid = { type: 'string', format: 'uuid' } as const;
const body = (required: string[], properties: Record<string, object>) =>
  ({ body: { type: 'object', required, properties, additionalProperties: false } });

/** The AI assistant (v1): settings, conversations, and confirming proposed changes. */
export function registerAssistant(app: FastifyInstance, run: Run, db: Db, opts: ai.AiOptions): void {
  app.get('/v1/ai/status', async (req) => run(req, (tx, ctx) => ai.assistantStatus(tx, ctx)));
  app.get('/v1/ai/settings', async (req) => run(req, (tx, ctx) => ai.getSettings(tx, ctx)));
  app.put('/v1/ai/settings', { schema: body([], {
    enabled: { type: 'boolean' }, provider: { enum: ['anthropic', 'openai_compatible'] }, model: { type: 'string', minLength: 1, maxLength: 120 },
    effort: { enum: ['low', 'medium', 'high', 'xhigh', 'max', null] }, baseUrl: { type: ['string', 'null'], maxLength: 500 },
    monthlyTokenLimit: { type: ['integer', 'null'], minimum: 1 }, apiKey: { type: ['string', 'null'], maxLength: 500 } }) },
  async (req) => run(req, (tx, ctx) => ai.saveSettings(tx, ctx, opts, req.body as B)));
  app.post('/v1/ai/settings/test', async (req) => ai.testConnection(db, req.ctx, opts));

  app.get('/v1/ai/conversations', async (req) => run(req, (tx, ctx) => ai.listConversations(tx, ctx, (req.query as Record<string, string>).companyId)));
  app.post('/v1/ai/conversations', { schema: body(['companyId'], { companyId: uuid, title: { type: 'string', maxLength: 120 } }) },
    async (req, reply) => { reply.status(201); return run(req, (tx, ctx) => ai.createConversation(tx, ctx, req.body as B)); });
  app.get<{ Params: P }>('/v1/ai/conversations/:id', async (req) => run(req, (tx, ctx) => ai.getConversation(tx, ctx, req.params.id)));
  app.delete<{ Params: P }>('/v1/ai/conversations/:id', async (req) => run(req, (tx, ctx) => ai.deleteConversation(tx, ctx, req.params.id)));
  app.post<{ Params: P }>('/v1/ai/conversations/:id/messages', { schema: body(['text'], { text: { type: 'string', minLength: 1, maxLength: 8000 } }) },
    async (req) => ai.sendMessage(db, req.ctx, opts, req.params.id, (req.body as B).text));
  app.post<{ Params: P }>('/v1/ai/tool-calls/:id/confirm', async (req) => ai.decide(db, req.ctx, opts, req.params.id, true));
  app.post<{ Params: P }>('/v1/ai/tool-calls/:id/reject', async (req) => ai.decide(db, req.ctx, opts, req.params.id, false));
}
