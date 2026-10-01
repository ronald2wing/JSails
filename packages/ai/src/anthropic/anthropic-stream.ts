/**
 * Reading a raw Messages API event stream into neutral stream parts.
 *
 * The adapter iterates the SDK's raw `create({ stream: true })` stream, which
 * pulls from the response body only when the next event is asked for, and
 * accumulates the message here (the SDK's `MessageStream` helper reads the
 * body eagerly, so it would defeat backpressure). Each block is rebuilt
 * exactly as the API sends it: text and thinking deltas are concatenated,
 * signatures and citations are applied, and the streamed JSON of a tool
 * input is parsed strictly once the block stops. An unparseable input (eager
 * input streaming does not validate) becomes `{ INVALID_JSON: text }`, which
 * the run turns into an error result before any schema or tool sees it.
 *
 * The finished message keeps its raw content array as native content for
 * verbatim replay. After a mid-output server-side fallback, the content is
 * stored in the form the API documents for echoing such a turn back: before
 * the last `fallback` block only text, the fallback blocks themselves, and
 * paired server-tool blocks are kept, so no call the model abandoned is ever
 * replayed or executed.
 *
 * Any event out of order, a delta for the wrong block, or a stream that ends
 * without `message_stop` is `AiError('provider_failed')` with a static
 * reason. Unknown event types are skipped; unknown block types are kept.
 */

import { AiError } from '../errors/ai-error.js';
import { isPlainObject } from '../content/json-value.js';
import type { AiAssistantPart, AiFinishReason } from '../content/types.js';
import type { AiProviderResponse, AiProviderStreamPart } from '../provider/contract.js';
import { providerFailed } from '../provider/provider-response.js';
import { parseStreamedInput } from '../provider/wire-format.js';
import type { AiUsageIteration } from '../usage/pricing.js';
import { normalizeUsage, type AiUsage } from '../usage/usage.js';
import { ANTHROPIC_PROVIDER_ID } from './anthropic-request.js';

interface BlockState {
  readonly block: Record<string, unknown>;
  /** The streamed JSON of a tool input; `undefined` until the first delta. */
  json: string | undefined;
  stopped: boolean;
}

interface RawUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number | undefined;
  speed: string | undefined;
  iterations: unknown;
}

const STOP_REASONS: Readonly<Record<string, AiFinishReason>> = {
  end_turn: 'stop',
  stop_sequence: 'stop-sequence',
  max_tokens: 'length',
  model_context_window_exceeded: 'length',
  tool_use: 'tool-calls',
  pause_turn: 'pause',
  refusal: 'refusal',
};

/** Block types echoed from before the last fallback block. */
const KEPT_BEFORE_FALLBACK: ReadonlySet<string> = new Set(['text', 'fallback']);

function isLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readUsageInto(target: RawUsage, value: unknown, initial: boolean): void {
  if (!isPlainObject(value)) {
    if (initial) throw providerFailed('usage');
    return;
  }
  if (isCount(value.input_tokens)) target.input = value.input_tokens;
  else if (initial) throw providerFailed('usage');
  if (isCount(value.output_tokens)) target.output = value.output_tokens;
  if (isCount(value.cache_read_input_tokens)) target.cacheRead = value.cache_read_input_tokens;
  if (isCount(value.cache_creation_input_tokens)) {
    target.cacheWrite = value.cache_creation_input_tokens;
  }
  const details = value.output_tokens_details;
  if (isPlainObject(details) && isCount(details.thinking_tokens)) {
    target.thinking = details.thinking_tokens;
  }
  if (typeof value.speed === 'string') target.speed = value.speed;
  if (Array.isArray(value.iterations)) target.iterations = value.iterations;
}

function normalized(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  thinking: number | undefined,
): AiUsage {
  try {
    return normalizeUsage({
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      ...(thinking === undefined ? {} : { reasoningTokens: thinking }),
      inputIncludesCache: false,
    });
  } catch {
    throw providerFailed('usage');
  }
}

/**
 * The billed slices of the response: one per `usage.iterations` entry when
 * the API reports them (a server-side tool loop, a fallback, an advisor, a
 * compaction), each at the model that ran it; otherwise the whole usage at
 * the response model.
 */
function iterationsOf(raw: RawUsage, usage: AiUsage, model: string): AiUsageIteration[] {
  const speed = raw.speed === 'fast' ? { speed: 'fast' } : {};
  const entries = Array.isArray(raw.iterations) ? (raw.iterations as readonly unknown[]) : [];
  const slices: AiUsageIteration[] = [];
  for (const entry of entries) {
    if (!isPlainObject(entry)) throw providerFailed('iterations');
    const input = entry.input_tokens;
    const output = entry.output_tokens;
    if (!isCount(input) || !isCount(output)) throw providerFailed('iterations');
    const cacheRead = isCount(entry.cache_read_input_tokens) ? entry.cache_read_input_tokens : 0;
    const cacheWrite = isCount(entry.cache_creation_input_tokens)
      ? entry.cache_creation_input_tokens
      : 0;
    slices.push({
      provider: ANTHROPIC_PROVIDER_ID,
      model: isLabel(entry.model) ? entry.model : model,
      ...speed,
      usage: normalized(input, output, cacheRead, cacheWrite, undefined),
    });
  }
  if (slices.length > 0) return slices;
  return [{ provider: ANTHROPIC_PROVIDER_ID, model, ...speed, usage }];
}

function toolResultId(block: Record<string, unknown>): string | undefined {
  return typeof block.type === 'string' &&
    block.type.endsWith('_tool_result') &&
    typeof block.tool_use_id === 'string'
    ? block.tool_use_id
    : undefined;
}

/** The content in its echo form: see the module header on fallbacks. */
function echoForm(content: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  let last = -1;
  content.forEach((block, index) => {
    if (block.type === 'fallback') last = index;
  });
  if (last === -1) return [...content];
  const resultIds = new Set(
    content.map(toolResultId).filter((id): id is string => id !== undefined),
  );
  const keptServerCalls = new Set<string>();
  const kept: Record<string, unknown>[] = [];
  content.forEach((block, index) => {
    if (index >= last) {
      kept.push(block);
      return;
    }
    if (KEPT_BEFORE_FALLBACK.has(String(block.type))) {
      kept.push(block);
    } else if (
      block.type === 'server_tool_use' &&
      typeof block.id === 'string' &&
      resultIds.has(block.id)
    ) {
      keptServerCalls.add(block.id);
      kept.push(block);
    } else {
      const resultFor = toolResultId(block);
      if (resultFor !== undefined && keptServerCalls.has(resultFor)) kept.push(block);
    }
  });
  return kept;
}

function neutralParts(content: readonly Record<string, unknown>[]): AiAssistantPart[] {
  const parts: AiAssistantPart[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push({ type: 'text', text: block.text });
        break;
      case 'thinking':
        parts.push({
          type: 'reasoning',
          text: typeof block.thinking === 'string' ? block.thinking : '',
        });
        break;
      case 'redacted_thinking':
        parts.push({ type: 'reasoning', text: '' });
        break;
      case 'tool_use':
        if (!isLabel(block.id) || !isLabel(block.name)) throw providerFailed('tool_use');
        parts.push({ type: 'tool-call', id: block.id, name: block.name, input: block.input });
        break;
      default:
        break;
    }
  }
  return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
}

function tracksInput(block: Record<string, unknown>): boolean {
  return block.type === 'tool_use' || block.type === 'server_tool_use';
}

/**
 * Turn the raw event stream of one request into neutral stream parts, ending
 * with `response-end`. `signal` tells a stopped call (the SDK ends an aborted
 * stream quietly) from a truncated one.
 */
export async function* readAnthropicStream(
  events: AsyncIterable<unknown>,
  signal: AbortSignal,
): AsyncGenerator<AiProviderStreamPart, void> {
  let message: { readonly id: string; readonly model: string } | undefined;
  const blocks = new Map<number, BlockState>();
  const usage: RawUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    thinking: undefined,
    speed: undefined,
    iterations: undefined,
  };
  let stopReason: unknown = null;
  let refusalCategory: string | null = null;

  for await (const event of events) {
    if (!isPlainObject(event) || typeof event.type !== 'string') throw providerFailed('event');
    if (message === undefined && event.type !== 'message_start') {
      if (event.type.startsWith('message') || event.type.startsWith('content_block')) {
        throw providerFailed('event_order');
      }
      continue;
    }
    switch (event.type) {
      case 'message_start': {
        if (message !== undefined) throw providerFailed('message_start');
        const start = event.message;
        if (!isPlainObject(start) || !isLabel(start.id) || !isLabel(start.model)) {
          throw providerFailed('message_start');
        }
        readUsageInto(usage, start.usage, true);
        message = { id: start.id, model: start.model };
        yield { type: 'response-start', id: start.id, model: start.model };
        break;
      }
      case 'content_block_start': {
        const index = event.index;
        const block = event.content_block;
        if (
          !isCount(index) ||
          blocks.has(index) ||
          !isPlainObject(block) ||
          typeof block.type !== 'string'
        ) {
          throw providerFailed('content_block_start');
        }
        const copy = structuredClone(block);
        blocks.set(index, { block: copy, json: undefined, stopped: false });
        if (copy.type === 'tool_use') {
          if (!isLabel(copy.id) || !isLabel(copy.name)) throw providerFailed('tool_use');
          yield { type: 'tool-input-start', id: copy.id, name: copy.name };
        } else if (copy.type === 'text' && typeof copy.text === 'string' && copy.text.length > 0) {
          yield { type: 'text-delta', delta: copy.text };
        }
        break;
      }
      case 'content_block_delta': {
        const state = isCount(event.index) ? blocks.get(event.index) : undefined;
        const delta = event.delta;
        if (state === undefined || state.stopped || !isPlainObject(delta)) {
          throw providerFailed('content_block_delta');
        }
        const block = state.block;
        if (
          delta.type === 'text_delta' &&
          block.type === 'text' &&
          typeof delta.text === 'string'
        ) {
          block.text = `${typeof block.text === 'string' ? block.text : ''}${delta.text}`;
          if (delta.text.length > 0) yield { type: 'text-delta', delta: delta.text };
        } else if (
          delta.type === 'thinking_delta' &&
          block.type === 'thinking' &&
          typeof delta.thinking === 'string'
        ) {
          block.thinking = `${typeof block.thinking === 'string' ? block.thinking : ''}${delta.thinking}`;
          if (delta.thinking.length > 0) yield { type: 'reasoning-delta', delta: delta.thinking };
        } else if (
          delta.type === 'signature_delta' &&
          block.type === 'thinking' &&
          typeof delta.signature === 'string'
        ) {
          block.signature = delta.signature;
        } else if (
          delta.type === 'input_json_delta' &&
          tracksInput(block) &&
          typeof delta.partial_json === 'string'
        ) {
          state.json = (state.json ?? '') + delta.partial_json;
          if (block.type === 'tool_use' && isLabel(block.id)) {
            yield { type: 'tool-input-delta', id: block.id, delta: delta.partial_json };
          }
        } else if (
          delta.type === 'citations_delta' &&
          block.type === 'text' &&
          isPlainObject(delta.citation)
        ) {
          const citations = Array.isArray(block.citations) ? (block.citations as unknown[]) : [];
          block.citations = [...citations, delta.citation];
        } else {
          throw providerFailed('content_block_delta');
        }
        break;
      }
      case 'content_block_stop': {
        const state = isCount(event.index) ? blocks.get(event.index) : undefined;
        if (state === undefined || state.stopped) throw providerFailed('content_block_stop');
        state.stopped = true;
        if (state.json !== undefined) state.block.input = parseStreamedInput(state.json);
        break;
      }
      case 'message_delta': {
        const delta = event.delta;
        if (!isPlainObject(delta)) throw providerFailed('message_delta');
        if (delta.stop_reason !== undefined && delta.stop_reason !== null) {
          stopReason = delta.stop_reason;
        }
        const details = delta.stop_details;
        if (isPlainObject(details) && details.type === 'refusal') {
          refusalCategory = isLabel(details.category) ? details.category : null;
        }
        readUsageInto(usage, event.usage, false);
        break;
      }
      case 'message_stop': {
        if (message === undefined) throw providerFailed('event_order');
        const ordered = [...blocks.entries()].sort(([a], [b]) => a - b);
        if (ordered.some(([, state]) => !state.stopped)) throw providerFailed('block_open');
        const content = echoForm(ordered.map(([, state]) => state.block));
        const fallback = [...content].reverse().find((block) => block.type === 'fallback');
        const to = fallback === undefined ? undefined : fallback.to;
        const model = isPlainObject(to) && isLabel(to.model) ? to.model : message.model;
        const finishReason: AiFinishReason =
          typeof stopReason === 'string' ? (STOP_REASONS[stopReason] ?? 'other') : 'other';
        const total = normalized(
          usage.input,
          usage.output,
          usage.cacheRead,
          usage.cacheWrite,
          usage.thinking,
        );
        const response: AiProviderResponse = {
          id: message.id,
          model,
          message: {
            role: 'assistant',
            parts: neutralParts(content),
            native: { provider: ANTHROPIC_PROVIDER_ID, model, content },
          },
          finishReason,
          usage: total,
          iterations: iterationsOf(usage, total, model),
          ...(finishReason === 'refusal' ? { refusal: { category: refusalCategory } } : {}),
        };
        yield { type: 'response-end', response };
        return;
      }
      default:
        break;
    }
  }
  if (signal.aborted) throw new AiError('aborted', 'the provider call was stopped');
  throw providerFailed('incomplete_stream');
}
