import Anthropic from '@anthropic-ai/sdk';
import { AppError } from '../core/errors.ts';

/**
 * Model providers behind one small interface, so the assistant does not depend
 * on any vendor. Claude (Anthropic) is the default; any service that speaks the
 * OpenAI chat-completions protocol (OpenAI itself, Azure OpenAI, or a local model
 * served by Ollama, LM Studio or vLLM) is the second.
 *
 * The transcript is kept in a neutral form (Block). A provider may also return
 * its own content (native); the assistant stores it and hands it back to the same
 * provider and model unchanged, which Claude needs for its thinking blocks.
 */

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export interface ChatMessage {
  role: 'user' | 'assistant';
  blocks: Block[];
  native?: { provider: string; model: string; content: unknown } | null;
}
export interface ToolSpec { name: string; description: string; schema: Record<string, unknown> }
export interface ChatRequest {
  system: string;        // stable instructions (cached where the provider supports it)
  context: string;       // per-conversation facts: user, company, today's date
  messages: ChatMessage[];
  tools: ToolSpec[];
}
export type Stop = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';
export interface ChatResult {
  blocks: Block[];
  native?: unknown;
  stop: Stop;
  model: string;
  usage: { input: number; output: number };
}
export interface ChatProvider {
  readonly id: 'anthropic' | 'openai_compatible';
  readonly model: string;
  complete(req: ChatRequest): Promise<ChatResult>;
}

export interface ProviderConfig {
  provider: 'anthropic' | 'openai_compatible';
  model: string;
  effort?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
}

/** A provider failure, told in words a user can act on. */
export class AiProviderError extends AppError {
  constructor(message: string) { super(502, 'ai_provider_error', message); }
}

const MAX_TOKENS = 16000;
const TIMEOUT_MS = 180_000;

export function createProvider(cfg: ProviderConfig): ChatProvider {
  if (cfg.provider === 'anthropic') return new ClaudeProvider(cfg);
  if (cfg.provider === 'openai_compatible') return new OpenAiCompatibleProvider(cfg);
  throw new AiProviderError(`unknown AI provider ${String(cfg.provider)}`);
}

// --- Claude ---------------------------------------------------------------------

// Models that accept server-side refusal fallbacks: if a safety classifier
// declines, the API reruns the request on a suitable model inside the same call.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-fable-5-1']);

class ClaudeProvider implements ChatProvider {
  readonly id = 'anthropic' as const;
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: string | null;

  constructor(cfg: ProviderConfig) {
    if (!cfg.apiKey) throw new AiProviderError('no Anthropic API key is set; an administrator can add one under Assistant settings');
    this.model = cfg.model;
    this.effort = cfg.effort ?? null;
    this.client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl || undefined, timeout: TIMEOUT_MS, maxRetries: 2 });
  }

  async complete(req: ChatRequest): Promise<ChatResult> {
    const fallback = FALLBACK_MODELS.has(this.model);
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        ...(this.effort ? { output_config: { effort: this.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } } : {}),
        // Stable instructions first and cached; the per-conversation context after them.
        system: [
          { type: 'text', text: req.system, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: req.context },
        ],
        cache_control: { type: 'ephemeral' },
        tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema as Anthropic.Beta.BetaTool.InputSchema })),
        messages: req.messages.map((m) => this.toParam(m)),
      });
    } catch (err) {
      throw claudeError(err);
    }
    const blocks: Block[] = [];
    for (const b of res.content) {
      if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
      else if (b.type === 'tool_use') blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
    }
    const u = res.usage;
    return {
      blocks,
      native: res.content,
      stop: res.stop_reason === 'end_turn' ? 'end' : res.stop_reason === 'tool_use' ? 'tool_use' : res.stop_reason === 'max_tokens' ? 'max_tokens'
        : res.stop_reason === 'refusal' ? 'refusal' : 'other',
      model: res.model,
      usage: { input: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output: u.output_tokens },
    };
  }

  private toParam(m: ChatMessage): Anthropic.Beta.BetaMessageParam {
    // Replay Claude's own turns exactly as returned (thinking blocks included).
    if (m.role === 'assistant' && m.native?.provider === 'anthropic' && Array.isArray(m.native.content)) {
      return { role: 'assistant', content: m.native.content as Anthropic.Beta.BetaContentBlockParam[] };
    }
    const content: Anthropic.Beta.BetaContentBlockParam[] = m.blocks.map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input as Record<string, unknown> };
      return { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, is_error: b.isError ?? false };
    });
    return { role: m.role, content };
  }
}

function claudeError(err: unknown): AiProviderError {
  if (err instanceof Anthropic.AuthenticationError) return new AiProviderError('the Anthropic API key was rejected; check it under Assistant settings');
  if (err instanceof Anthropic.PermissionDeniedError) return new AiProviderError('this Anthropic API key may not use the chosen model');
  if (err instanceof Anthropic.NotFoundError) return new AiProviderError('the chosen Claude model was not found; check the model name under Assistant settings');
  if (err instanceof Anthropic.RateLimitError) return new AiProviderError('the AI service is busy or the account limit was reached; try again in a minute');
  if (err instanceof Anthropic.BadRequestError) return new AiProviderError(`the AI service refused the request: ${err.message}`);
  if (err instanceof Anthropic.APIConnectionError) return new AiProviderError('could not reach the AI service; check the internet connection');
  if (err instanceof Anthropic.APIError) return new AiProviderError(`the AI service failed (${err.status ?? 'no status'}); try again`);
  return new AiProviderError(`the AI service failed: ${(err as Error)?.message ?? String(err)}`);
}

// --- OpenAI-compatible chat completions (OpenAI, Azure, Ollama, LM Studio, vLLM) --

class OpenAiCompatibleProvider implements ChatProvider {
  readonly id = 'openai_compatible' as const;
  readonly model: string;
  private readonly url: string;
  private readonly key: string | null;

  constructor(cfg: ProviderConfig) {
    if (!cfg.baseUrl) throw new AiProviderError('set the service address (base URL) under Assistant settings, for example http://127.0.0.1:11434/v1 for Ollama');
    this.model = cfg.model;
    this.url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    this.key = cfg.apiKey ?? null;
  }

  async complete(req: ChatRequest): Promise<ChatResult> {
    const messages: unknown[] = [{ role: 'system', content: `${req.system}\n\n${req.context}` }];
    for (const m of req.messages) {
      if (m.role === 'assistant') {
        const text = m.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
        const calls = m.blocks.filter((b) => b.type === 'tool_use') as Extract<Block, { type: 'tool_use' }>[];
        messages.push({ role: 'assistant', content: text || null,
          ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) } : {}) });
      } else {
        for (const b of m.blocks) {
          if (b.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.isError ? `ERROR: ${b.content}` : b.content });
          else if (b.type === 'text') messages.push({ role: 'user', content: b.text });
        }
      }
    }
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) },
        body: JSON.stringify({ model: this.model, messages,
          tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new AiProviderError(`could not reach the AI service at ${this.url}: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new AiProviderError('the AI service rejected the API key; check it under Assistant settings');
    if (res.status === 404) throw new AiProviderError('the AI service or model was not found; check the base URL and model name');
    if (res.status === 429) throw new AiProviderError('the AI service is busy or the account limit was reached; try again in a minute');
    if (!res.ok) throw new AiProviderError(`the AI service failed (${res.status}): ${text.slice(0, 300)}`);
    let body: any;
    try { body = JSON.parse(text); } catch { throw new AiProviderError('the AI service answered with something that is not JSON'); }
    const choice = body?.choices?.[0];
    if (!choice?.message) throw new AiProviderError('the AI service returned no answer');
    const blocks: Block[] = [];
    if (typeof choice.message.content === 'string' && choice.message.content.trim()) blocks.push({ type: 'text', text: choice.message.content });
    for (const c of choice.message.tool_calls ?? []) {
      let input: unknown;
      try { input = c.function?.arguments ? JSON.parse(c.function.arguments) : {}; } catch { input = { _unparseable: String(c.function?.arguments) }; }
      blocks.push({ type: 'tool_use', id: String(c.id), name: String(c.function?.name), input });
    }
    const fr = choice.finish_reason;
    return {
      blocks,
      stop: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : fr === 'length' ? 'max_tokens' : fr === 'content_filter' ? 'refusal' : fr === 'stop' ? 'end' : 'other',
      model: String(body.model ?? this.model),
      usage: { input: Number(body.usage?.prompt_tokens ?? 0), output: Number(body.usage?.completion_tokens ?? 0) },
    };
  }
}
