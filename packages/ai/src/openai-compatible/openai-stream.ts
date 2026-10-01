/**
 * Reading a Chat Completions chunk stream into neutral stream parts.
 *
 * Text, refusal, and reasoning deltas of the first choice are concatenated
 * (reasoning arrives as `reasoning_content` or `reasoning` on servers that
 * stream it). Tool-call deltas are assembled by their `index`. Compatible
 * servers omit tool-call ids, repeat them, or reuse ids from earlier turns,
 * so an id is kept only when it is a usable label not yet seen in this
 * conversation or response; otherwise the adapter synthesizes a unique one.
 * Arguments are parsed strictly once the stream ends; text that is not a
 * JSON object becomes `{ INVALID_JSON: text }`, which the run turns into an
 * error result before any schema or tool sees it.
 *
 * `prompt_tokens` already includes `cached_tokens`, so usage is normalized
 * with the cache inside the input count. A server configured with
 * `streamUsage` must send the usage chunk; one without it reports zero.
 * A refusal, a chunk stream that ends with no chunk, and malformed chunks
 * are handled with value-free errors (`provider_failed`).
 *
 * The SDK ends iteration without an error when the body closes, with or
 * without the `[DONE]` sentinel, so a reply cut off mid-stream would look
 * finished. The first choice must therefore carry a `finish_reason` before the
 * stream ends; one that never does is `provider_failed('incomplete_stream')`,
 * and any tool calls it started are never run.
 */

import { AiError } from '../errors/ai-error.js';
import { isPlainObject } from '../content/json-value.js';
import type { AiAssistantPart, AiFinishReason } from '../content/types.js';
import type { AiProviderResponse, AiProviderStreamPart } from '../provider/contract.js';
import { providerFailed } from '../provider/provider-response.js';
import { parseStreamedInput } from '../provider/wire-format.js';
import { ZERO_USAGE, normalizeUsage, type AiUsage } from '../usage/usage.js';
import { MAX_OPENAI_TOOL_ID_LENGTH } from './openai-request.js';

/** What the reader needs to know about the request and the provider. */
export interface OpenAIStreamContext {
  readonly providerId: string;
  readonly requestModel: string;
  /** Tool-call ids already in the conversation; a response may not reuse one. */
  readonly usedIds: ReadonlySet<string>;
  readonly streamUsage: boolean;
  readonly signal: AbortSignal;
}

interface ToolCallState {
  readonly id: string;
  /** The id the server sent for this call, if any. */
  readonly offered: string | undefined;
  name: string;
  args: string;
  started: boolean;
}

function isLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isCompleteObject(text: string): boolean {
  try {
    return isPlainObject(JSON.parse(text));
  } catch {
    return false;
  }
}

function randomId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

function readUsage(value: Record<string, unknown>): AiUsage {
  const prompt = value.prompt_tokens;
  const completion = value.completion_tokens;
  if (!isCount(prompt) || !isCount(completion)) throw providerFailed('usage');
  const promptDetails = isPlainObject(value.prompt_tokens_details)
    ? value.prompt_tokens_details
    : {};
  const completionDetails = isPlainObject(value.completion_tokens_details)
    ? value.completion_tokens_details
    : {};
  const cacheRead = isCount(promptDetails.cached_tokens) ? promptDetails.cached_tokens : 0;
  const cacheWrite = isCount(promptDetails.cache_write_tokens)
    ? promptDetails.cache_write_tokens
    : 0;
  const reasoning = completionDetails.reasoning_tokens;
  try {
    return normalizeUsage({
      inputTokens: prompt,
      outputTokens: completion,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      ...(isCount(reasoning) ? { reasoningTokens: reasoning } : {}),
      inputIncludesCache: true,
    });
  } catch {
    throw providerFailed('usage');
  }
}

function finishReasonOf(raw: string, hasToolCalls: boolean, refused: boolean): AiFinishReason {
  if (refused) return 'refusal';
  switch (raw) {
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content-filter';
    case 'tool_calls':
    case 'function_call':
      return 'tool-calls';
    case 'stop':
      // Some compatible servers end a tool-calling turn with `stop`.
      return hasToolCalls ? 'tool-calls' : 'stop';
    default:
      return hasToolCalls ? 'tool-calls' : 'other';
  }
}

/**
 * Turn the chunk stream of one request into neutral stream parts, ending
 * with `response-end`.
 */
export async function* readOpenAIStream(
  chunks: AsyncIterable<unknown>,
  context: OpenAIStreamContext,
): AsyncGenerator<AiProviderStreamPart, void> {
  let started: { readonly id: string; readonly model: string } | undefined;
  let text = '';
  let refusal = '';
  let reasoning = '';
  let finish: string | undefined;
  let usage: AiUsage | undefined;
  const calls = new Map<number, ToolCallState>();
  /** Wire index to call key, for servers that send each new call at a reused index. */
  const aliases = new Map<number, number>();
  const taken = new Set(context.usedIds);

  const claimId = (offered: unknown): string => {
    if (
      isLabel(offered) &&
      offered.length <= MAX_OPENAI_TOOL_ID_LENGTH &&
      /^[A-Za-z0-9_-]+$/.test(offered) &&
      !taken.has(offered)
    ) {
      taken.add(offered);
      return offered;
    }
    let id = randomId('call_');
    while (taken.has(id)) id = randomId('call_');
    taken.add(id);
    return id;
  };

  for await (const chunk of chunks) {
    if (!isPlainObject(chunk)) throw providerFailed('chunk');
    if (started === undefined) {
      const id = isLabel(chunk.id) ? chunk.id : randomId('chatcmpl-');
      const model = isLabel(chunk.model) ? chunk.model : context.requestModel;
      started = { id, model };
      yield { type: 'response-start', id, model };
    }
    if (isPlainObject(chunk.usage)) usage = readUsage(chunk.usage);
    if (chunk.choices === undefined || chunk.choices === null) continue;
    if (!Array.isArray(chunk.choices)) throw providerFailed('choices');
    for (const choice of chunk.choices as readonly unknown[]) {
      if (!isPlainObject(choice)) throw providerFailed('choice');
      if (choice.index !== undefined && choice.index !== 0) continue;
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (typeof choice.finish_reason !== 'string') throw providerFailed('finish_reason');
        finish = choice.finish_reason;
      }
      const delta = choice.delta;
      if (delta === undefined || delta === null) continue;
      if (!isPlainObject(delta)) throw providerFailed('delta');
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        text += delta.content;
        yield { type: 'text-delta', delta: delta.content };
      }
      if (typeof delta.refusal === 'string') refusal += delta.refusal;
      const thought =
        typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : typeof delta.reasoning === 'string'
            ? delta.reasoning
            : '';
      if (thought.length > 0) {
        reasoning += thought;
        yield { type: 'reasoning-delta', delta: thought };
      }
      if (delta.tool_calls === undefined || delta.tool_calls === null) continue;
      if (!Array.isArray(delta.tool_calls)) throw providerFailed('tool_calls');
      for (const [position, raw] of (delta.tool_calls as readonly unknown[]).entries()) {
        if (!isPlainObject(raw)) throw providerFailed('tool_call');
        const wireIndex = isCount(raw.index) ? raw.index : position;
        const fn = isPlainObject(raw.function) ? raw.function : {};
        let key = aliases.get(wireIndex) ?? wireIndex;
        let state = calls.get(key);
        const offered = isLabel(raw.id) ? raw.id : undefined;
        // A name arriving for a call that already has one starts a new call
        // when the server says so by a new id, or the earlier call is complete.
        const restarts =
          state !== undefined &&
          state.started &&
          typeof fn.name === 'string' &&
          fn.name.length > 0 &&
          ((offered !== undefined && state.offered !== undefined && offered !== state.offered) ||
            isCompleteObject(state.args));
        if (restarts) {
          key = Math.max(...calls.keys()) + 1;
          aliases.set(wireIndex, key);
          state = undefined;
        }
        if (state === undefined) {
          state = { id: claimId(raw.id), offered, name: '', args: '', started: false };
          calls.set(key, state);
        }
        if (typeof fn.name === 'string' && fn.name.length > 0 && !state.started) {
          state.name += fn.name;
        }
        if (!state.started && isLabel(state.name)) {
          state.started = true;
          yield { type: 'tool-input-start', id: state.id, name: state.name };
        }
        if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
          state.args += fn.arguments;
          if (state.started) yield { type: 'tool-input-delta', id: state.id, delta: fn.arguments };
        }
      }
    }
  }

  if (started === undefined) {
    if (context.signal.aborted) throw new AiError('aborted', 'the provider call was stopped');
    throw providerFailed('empty_stream');
  }
  if (context.signal.aborted) throw new AiError('aborted', 'the provider call was stopped');
  if (finish === undefined) throw providerFailed('incomplete_stream');
  if (usage === undefined && context.streamUsage) throw providerFailed('usage');

  const parts: AiAssistantPart[] = [];
  if (reasoning.length > 0) parts.push({ type: 'reasoning', text: reasoning });
  if (text.length > 0) parts.push({ type: 'text', text });
  const ordered = [...calls.entries()].sort(([a], [b]) => a - b);
  for (const [, call] of ordered) {
    if (!isLabel(call.name)) throw providerFailed('tool_call');
    parts.push({
      type: 'tool-call',
      id: call.id,
      name: call.name,
      input: parseStreamedInput(call.args),
    });
  }
  if (parts.length === 0) parts.push({ type: 'text', text: '' });
  const refused = refusal.length > 0;
  const total = usage ?? ZERO_USAGE;
  const finishReason = finishReasonOf(finish, ordered.length > 0, refused);
  const response: AiProviderResponse = {
    id: started.id,
    model: started.model,
    message: { role: 'assistant', parts },
    finishReason,
    usage: total,
    iterations: [{ provider: context.providerId, model: started.model, usage: total }],
    ...(refused ? { refusal: { category: null } } : {}),
  };
  yield { type: 'response-end', response };
}
