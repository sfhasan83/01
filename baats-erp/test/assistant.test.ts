import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { one, type Ctx } from '../src/core/db.ts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../src/core/errors.ts';
import * as setup from '../src/fin/setup.ts';
import * as docs from '../src/fin/documents.ts';
import * as ai from '../src/ai/assistant.ts';
import { createProvider, type ChatProvider, type ChatRequest, type ChatResult } from '../src/ai/providers.ts';
import { validate, TOOL_BY_NAME } from '../src/ai/tools.ts';
import { buildServer } from '../src/api/server.ts';
import { createTestDb, giveRole, PASSWORD, seedOrg, type Seed, type TestDb } from './helpers.ts';

let t: TestDb;
let s: Seed;
let co: string;
let admin: Ctx, mgr: Ctx, rep1: Ctx;
const SECRET = randomBytes(32);
const tx = <T>(ctx: Ctx, fn: (tx: any) => Promise<T>) => t.db.withTenant(ctx, fn);

/** A provider that plays a script and keeps every request it was sent. */
class Scripted implements ChatProvider {
  readonly id = 'anthropic' as const;
  readonly model = 'scripted';
  readonly seen: ChatRequest[] = [];
  steps: ((req: ChatRequest) => ChatResult)[] = [];
  async complete(req: ChatRequest): Promise<ChatResult> {
    this.seen.push(JSON.parse(JSON.stringify(req)));
    const f = this.steps.shift();
    if (!f) throw new Error('script ran out');
    return f(req);
  }
}
const say = (text: string): ChatResult => ({ blocks: [{ type: 'text', text }], stop: 'end', model: 'scripted', usage: { input: 100, output: 20 } });
const use = (id: string, name: string, input: unknown, text = ''): ChatResult => ({
  blocks: [...(text ? [{ type: 'text' as const, text }] : []), { type: 'tool_use', id, name, input }], stop: 'tool_use', model: 'scripted', usage: { input: 100, output: 20 } });
const lastResults = (req: ChatRequest) => req.messages.at(-1)!.blocks.filter((b) => b.type === 'tool_result') as { toolUseId: string; content: string; isError?: boolean }[];

const script = new Scripted();
const opts: ai.AiOptions = { secretKey: SECRET, allowPrivateUrls: false, providerFactory: () => script };

before(async () => {
  t = await createTestDb();
  s = await seedOrg(t.db);
  co = s.units.uae;
  admin = s.adminCtx;
  mgr = s.ctxOf(s.people.finMgr.userId);
  rep1 = s.ctxOf(s.people.salesRep.userId);
  await tx(admin, (q) => setup.setupCompany(q, admin, { unitId: co, legalName: 'Acme UAE LLC', openFrom: '2026-01-01' }));
  await giveRole(t.db, s, s.people.finMgr.userId, 'CONTROLLER', { 'fin.report.read': {}, 'ai.assistant.use': {}, 'bi.esg.manage': {} }, s.units.root);
  await giveRole(t.db, s, s.people.salesRep.userId, 'REP', { 'ai.assistant.use': {} }, co);
  const customer = await tx(admin, async (q) => (await one(q, `INSERT INTO mdm.parties (tenant_id, code, name, normalized_name, is_customer, is_supplier, country_code, currency_code, owner_unit_id, status)
    VALUES (app.tenant(), 'C1', 'Gulf Retail', 'gulf retail', true, false, 'AE', 'AED', $1, 'active') RETURNING id`, [co])).id as string);
  const d = await tx(admin, (q) => docs.createInvoice(q, admin, { companyId: co, kind: 'sales_invoice', partyId: customer, date: '2026-03-05', dueDate: '2026-04-04',
    lines: [{ description: 'Consulting', quantity: 10, unitPrice: 1000, taxCode: 'SR' }] }));
  await tx(admin, (q) => docs.postInvoice(q, admin, d.id));
});
after(async () => { await t.drop(); });

describe('assistant settings', () => {
  it('only an administrator manages settings, and the API key is stored encrypted and never shown', async () => {
    await assert.rejects(tx(mgr, (q) => ai.getSettings(q, mgr)), ForbiddenError);
    const d = await tx(admin, (q) => ai.getSettings(q, admin));
    assert.equal(d.enabled, false);
    assert.equal(d.provider, 'anthropic');
    assert.equal(d.model, 'claude-opus-5-5');
    assert.equal(d.effort, 'medium');
    await assert.rejects(tx(admin, (q) => ai.saveSettings(q, admin, opts, { enabled: true })), /API key before turning/);
    await assert.rejects(tx(admin, (q) => ai.saveSettings(q, admin, { ...opts, secretKey: null }, { apiKey: 'sk-ant-test-1234567890' })), /no secret key/);
    const saved = await tx(admin, (q) => ai.saveSettings(q, admin, opts, { enabled: true, apiKey: 'sk-ant-test-1234567890' }));
    assert.deepEqual([saved.enabled, saved.apiKey.set, saved.apiKey.hint], [true, true, '…7890']);
    assert.equal(JSON.stringify(saved).includes('sk-ant-test'), false);
    const row = await tx(admin, (q) => one(q, 'SELECT key_enc FROM ai.provider_keys'));
    assert.equal(row.key_enc.includes('sk-ant'), false);
    // Neither the settings audit nor the key event holds the key.
    const trail = await tx(admin, (q) => one(q, `SELECT string_agg(coalesce(after::text, ''), ' ') AS t FROM audit.entries WHERE entity_type LIKE 'ai.%'`));
    assert.equal(trail.t.includes('sk-ant-test'), false);
    assert.match(trail.t, /7890/);
  });

  it('refuses private addresses unless the server allows them, and needs a base URL for OpenAI-compatible services', async () => {
    await assert.rejects(tx(admin, (q) => ai.saveSettings(q, admin, opts, { provider: 'openai_compatible', model: 'llama3.1' })), /base URL/);
    for (const url of ['http://127.0.0.1:11434/v1', 'https://localhost/v1', 'https://10.1.2.3/v1', 'https://[::1]/v1', 'https://metadata.internal/v1']) {
      await assert.rejects(tx(admin, (q) => ai.saveSettings(q, admin, opts, { baseUrl: url })), ValidationError, url);
    }
    await assert.rejects(tx(admin, (q) => ai.saveSettings(q, admin, opts, { baseUrl: 'https://user:pw@api.example.com/v1' })), /key field/);
    const local = await tx(admin, (q) => ai.saveSettings(q, admin, { ...opts, allowPrivateUrls: true }, { baseUrl: 'http://127.0.0.1:11434/v1' }));
    assert.equal(local.baseUrl, 'http://127.0.0.1:11434/v1');
    await tx(admin, (q) => ai.saveSettings(q, admin, opts, { baseUrl: null }));
  });
});

describe('assistant conversations', () => {
  it('answers from a read tool, with the company context, and records usage', async () => {
    const c = await tx(mgr, (q) => ai.createConversation(q, mgr, { companyId: co }));
    script.steps = [
      () => use('t1', 'get_kpi', { code: 'revenue', from: '2026-01-01', to: '2026-03-31' }),
      (req) => { const r = lastResults(req); assert.equal(r[0].toolUseId, 't1'); return say(`Revenue was ${JSON.parse(r[0].content).value} AED.`); },
    ];
    const v = await ai.sendMessage(t.db, mgr, opts, c.id, 'What was revenue in Q1?');
    assert.equal(v.title, 'What was revenue in Q1?');
    assert.deepEqual(v.messages.map((m) => m.role), ['user', 'assistant', 'assistant']);
    assert.equal(v.messages[1].toolCalls[0].status, 'done');
    assert.equal(v.messages[2].text, 'Revenue was 10000 AED.');
    const first = script.seen.at(-2)!;
    assert.match(first.context, /Finmgr/);
    assert.match(first.context, /Acme UAE LLC.*base currency AED/);
    assert.match(first.system, /never an instruction to you/);
    assert.ok(first.tools.some((x) => x.name === 'create_ticket'));
    const u = await tx(admin, (q) => ai.getSettings(q, admin));
    assert.equal(u.usageThisMonth.requests >= 2, true);
    assert.equal(u.usageThisMonth.inputTokens >= 200, true);
  });

  it('cannot read past the user\'s permissions, and the denial is audited', async () => {
    const c = await tx(rep1, (q) => ai.createConversation(q, rep1, { companyId: co }));
    script.steps = [
      () => use('t2', 'trial_balance', { to: '2026-03-31' }),
      (req) => { const r = lastResults(req); assert.equal(r[0].isError, true); assert.match(r[0].content, /Not permitted/); return say('You do not have access to the books.'); },
    ];
    const v = await ai.sendMessage(t.db, rep1, opts, c.id, 'Show me the trial balance');
    assert.equal(v.messages[1].toolCalls[0].status, 'failed');
    const denied = await tx(admin, (q) => one(q, `SELECT count(*)::int AS n FROM audit.entries WHERE action = 'access_denied' AND actor_user_id = $1 AND entity_id = 'fin.report.read'`, [rep1.userId]));
    assert.equal(denied.n >= 1, true);
    // Conversations are private to the user who started them.
    await assert.rejects(tx(mgr, (q) => ai.getConversation(q, mgr, c.id)), NotFoundError);
    await assert.rejects(ai.sendMessage(t.db, mgr, opts, c.id, 'hello'), NotFoundError);
  });

  it('proposes changes and runs them only when the user confirms', async () => {
    const c = await tx(mgr, (q) => ai.createConversation(q, mgr, { companyId: co }));
    const ticket = { queue: 'it', category: 'laptop', priority: 3, title: 'Laptop screen flickers', description: 'Since Monday' };
    script.steps = [() => use('t3', 'create_ticket', ticket, 'I will raise an IT ticket for you.')];
    let v = await ai.sendMessage(t.db, mgr, opts, c.id, 'My laptop screen flickers, raise a ticket');
    assert.equal(v.pending.length, 1);
    assert.equal(v.pending[0].summary, 'Raise a P3 it ticket: "Laptop screen flickers"');
    assert.equal((await tx(admin, (q) => one(q, `SELECT count(*)::int AS n FROM svc.tickets`))).n, 0);
    await assert.rejects(ai.sendMessage(t.db, mgr, opts, c.id, 'and another thing'), ConflictError);
    // Someone else cannot decide it.
    await assert.rejects(ai.decide(t.db, rep1, opts, v.pending[0].id, true), NotFoundError);

    // Rejected: nothing happens, and the model is told.
    script.steps = [(req) => { assert.match(lastResults(req)[0].content, /rejected/); return say('Understood, no ticket raised.'); }];
    v = await ai.decide(t.db, mgr, opts, v.pending[0].id, false);
    assert.equal(v.messages.at(-1)!.text, 'Understood, no ticket raised.');
    assert.equal((await tx(admin, (q) => one(q, `SELECT count(*)::int AS n FROM svc.tickets`))).n, 0);

    // Confirmed: the ticket is raised as the user.
    script.steps = [() => use('t4', 'create_ticket', ticket), (req) => say(`Raised ${JSON.parse(lastResults(req)[0].content).no}.`)];
    v = await ai.sendMessage(t.db, mgr, opts, c.id, 'Actually, please raise it');
    const id = v.pending[0].id;
    v = await ai.decide(t.db, mgr, opts, id, true);
    const tk = await tx(admin, (q) => one(q, `SELECT * FROM svc.tickets`));
    assert.equal(tk.requester_user_id, mgr.userId);
    assert.equal(v.messages.at(-1)!.text, `Raised ${tk.no}.`);
    const done = v.messages.flatMap((m) => m.toolCalls).find((x) => x.id === id)!;
    assert.equal(done.status, 'done');
    await assert.rejects(ai.decide(t.db, mgr, opts, id, true), ConflictError);
    const audited = await tx(admin, (q) => one(q, `SELECT count(*)::int AS n FROM audit.entries WHERE entity_type = 'ai.tool_calls' AND entity_id = $1`, [id]));
    assert.equal(audited.n >= 2, true);
  });

  it('rejects malformed tool calls without running them', async () => {
    assert.match(validate(TOOL_BY_NAME.get('record_esg_reading')!.schema, { month: 'March', metric: 'electricity_kwh', value: 5 }) ?? '', /month must look like/);
    assert.match(validate(TOOL_BY_NAME.get('get_kpi')!.schema, { code: 'revenue', from: '2026-01-01', to: '2026-03-31', extra: 1 }) ?? '', /extra is not allowed/);
    const c = await tx(mgr, (q) => ai.createConversation(q, mgr, { companyId: co }));
    script.steps = [
      () => use('t5', 'record_esg_reading', { month: 'March', metric: 'electricity_kwh', value: -4 }),
      (req) => { assert.match(lastResults(req)[0].content, /Invalid call/); return use('t6', 'drop_tables', {}); },
      (req) => { assert.match(lastResults(req)[0].content, /no tool called drop_tables/); return say('I could not do that.'); },
    ];
    const v = await ai.sendMessage(t.db, mgr, opts, c.id, 'Record -4 kWh for March');
    assert.equal(v.pending.length, 0);
    assert.equal((await tx(admin, (q) => one(q, `SELECT count(*)::int AS n FROM bi.esg_readings`))).n, 0);
  });

  it('stops at the monthly allowance and when the assistant is off', async () => {
    const c = await tx(mgr, (q) => ai.createConversation(q, mgr, { companyId: co }));
    await tx(admin, (q) => ai.saveSettings(q, admin, opts, { monthlyTokenLimit: 10 }));
    await assert.rejects(ai.sendMessage(t.db, mgr, opts, c.id, 'hi'), /allowance is used up/);
    await tx(admin, (q) => ai.saveSettings(q, admin, opts, { monthlyTokenLimit: null, enabled: false }));
    await assert.rejects(ai.sendMessage(t.db, mgr, opts, c.id, 'hi'), /turned off/);
    await tx(admin, (q) => ai.saveSettings(q, admin, opts, { enabled: true }));
    // The failed attempts left the conversation usable.
    script.steps = [() => say('Hello.')];
    const v = await ai.sendMessage(t.db, mgr, opts, c.id, 'hello again');
    assert.equal(v.messages.at(-1)!.text, 'Hello.');
    assert.equal(v.busy, false);
  });
});

// --- Real providers against local stand-in services -------------------------------

async function stub(handler: (body: any, req: IncomingMessage) => unknown) {
  const seen: { body: any; headers: IncomingMessage['headers']; url: string }[] = [];
  const srv: Server = createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      seen.push({ body, headers: req.headers, url: req.url ?? '' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(handler(body, req)));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen, close: () => new Promise((r) => srv.close(r)) };
}

describe('providers', () => {
  it('Claude: sends cached instructions, tools, effort and refusal fallbacks, and replays thinking blocks unchanged', async () => {
    let n = 0;
    const svc = await stub(() => {
      n++;
      const base = { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_sequence: null,
        usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 7 } };
      return n === 1
        ? { ...base, stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 'sig-abc' }, { type: 'tool_use', id: 'toolu_1', name: 'list_kpis', input: {} }] }
        : { ...base, stop_reason: 'end_turn', content: [{ type: 'text', text: 'You can see 12 KPIs.' }] };
    });
    try {
      const real: ai.AiOptions = { secretKey: SECRET, allowPrivateUrls: true };
      await tx(admin, (q) => ai.saveSettings(q, admin, real, { provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: svc.url, apiKey: 'sk-ant-real-key-0001', enabled: true }));
      const c = await tx(mgr, (q) => ai.createConversation(q, mgr, { companyId: co }));
      const v = await ai.sendMessage(t.db, mgr, real, c.id, 'Which KPIs can I see?');
      assert.equal(v.messages.at(-1)!.text, 'You can see 12 KPIs.');
      const [a, b] = svc.seen;
      assert.match(a.url, /\/v1\/messages/);
      assert.match(String(a.headers['x-api-key'] ?? a.headers.authorization), /sk-ant-real-key-0001/);
      assert.match(String(a.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
      assert.equal(a.body.model, 'claude-opus-5-5');
      assert.equal(a.body.fallbacks, 'default');
      assert.deepEqual(a.body.output_config, { effort: 'medium' });
      assert.deepEqual(a.body.system[0].cache_control, { type: 'ephemeral' });
      assert.match(a.body.system[1].text, /Today is/);
      assert.ok(a.body.tools.find((x: any) => x.name === 'run_report').input_schema.properties.spec);
      // The second request replays Claude's turn exactly, thinking block first, then the tool result.
      assert.deepEqual(b.body.messages[1], { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig-abc' }, { type: 'tool_use', id: 'toolu_1', name: 'list_kpis', input: {} }] });
      assert.equal(b.body.messages[2].content[0].type, 'tool_result');
      assert.equal(b.body.messages[2].content[0].tool_use_id, 'toolu_1');
      const m = await tx(mgr, (q) => one(q, `SELECT input_tokens FROM ai.messages WHERE conversation_id = $1 AND role = 'assistant' ORDER BY seq LIMIT 1`, [c.id]));
      assert.equal(m.input_tokens, 62);
      const test = await ai.testConnection(t.db, admin, real);
      assert.equal(test.ok, true);
    } finally { await svc.close(); }
  });

  it('Claude: reports a rejected key in plain words', async () => {
    const srv = createServer((_req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const p = createProvider({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-bad-key-000', baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` });
      await assert.rejects(p.complete({ system: 's', context: 'c', tools: [], messages: [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }] }), /API key was rejected/);
    } finally { await new Promise((r) => srv.close(r)); }
  });

  it('OpenAI-compatible (for example a local model): maps tools and tool results both ways', async () => {
    let n = 0;
    const svc = await stub(() => {
      n++;
      return n === 1
        ? { model: 'llama3.1', choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ageing', arguments: '{"side":"receivable","as_of":"2026-04-30"}' } }] } }], usage: { prompt_tokens: 30, completion_tokens: 8 } }
        : { model: 'llama3.1', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Gulf Retail owes 10,500 AED.' } }], usage: { prompt_tokens: 40, completion_tokens: 9 } };
    });
    try {
      const real: ai.AiOptions = { secretKey: SECRET, allowPrivateUrls: true };
      await tx(admin, (q) => ai.saveSettings(q, admin, real, { provider: 'openai_compatible', model: 'llama3.1', baseUrl: `${svc.url}/v1`, apiKey: null, enabled: true }));
      const st = await tx(admin, (q) => ai.getSettings(q, admin));
      assert.equal(st.effort, null);
      const c = await tx(mgr, (q) => ai.createConversation(q, mgr, { companyId: co }));
      const v = await ai.sendMessage(t.db, mgr, real, c.id, 'Who owes us money?');
      assert.equal(v.messages.at(-1)!.text, 'Gulf Retail owes 10,500 AED.');
      const [a, b] = svc.seen;
      assert.equal(a.url, '/v1/chat/completions');
      assert.equal(a.headers.authorization, undefined);
      assert.equal(a.body.messages[0].role, 'system');
      assert.ok(a.body.tools.some((x: any) => x.function.name === 'ageing'));
      assert.deepEqual(b.body.messages[2].tool_calls[0].function, { name: 'ageing', arguments: '{"side":"receivable","as_of":"2026-04-30"}' });
      assert.equal(b.body.messages[3].role, 'tool');
      assert.equal(b.body.messages[3].tool_call_id, 'call_1');
      assert.match(b.body.messages[3].content, /Gulf Retail/);
    } finally { await svc.close(); }
  });
});

describe('assistant API', () => {
  it('serves status, conversations and messages over HTTP', async () => {
    await tx(admin, (q) => ai.saveSettings(q, admin, opts, { provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: null, effort: 'medium', apiKey: 'sk-ant-test-1234567890', enabled: true }));
    const app = buildServer({ db: t.db, ai: { secretKey: SECRET.toString('base64'), providerFactory: () => script } });
    try {
      const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: s.code, email: `finmgr@${s.code}.test`, password: PASSWORD } });
      const h = { authorization: `Bearer ${login.json().token}` };
      const st = await app.inject({ method: 'GET', url: '/v1/ai/status', headers: h });
      assert.deepEqual(st.json(), { enabled: true, provider: 'anthropic', model: 'claude-opus-5-5' });
      assert.equal((await app.inject({ method: 'GET', url: '/v1/ai/settings', headers: h })).statusCode, 403);
      const c = await app.inject({ method: 'POST', url: '/v1/ai/conversations', headers: h, payload: { companyId: co } });
      assert.equal(c.statusCode, 201);
      script.steps = [() => say('Hello Finmgr.')];
      const m = await app.inject({ method: 'POST', url: `/v1/ai/conversations/${c.json().id}/messages`, headers: h, payload: { text: 'Hello' } });
      assert.equal(m.statusCode, 200);
      assert.equal(m.json().messages.at(-1).text, 'Hello Finmgr.');
      const list = await app.inject({ method: 'GET', url: `/v1/ai/conversations?companyId=${co}`, headers: h });
      assert.equal(list.json()[0].title, 'Hello');
      assert.equal((await app.inject({ method: 'DELETE', url: `/v1/ai/conversations/${c.json().id}`, headers: h })).statusCode, 200);
      assert.equal((await app.inject({ method: 'GET', url: `/v1/ai/conversations/${c.json().id}`, headers: h })).statusCode, 404);
    } finally { await app.close(); }
  });
});
