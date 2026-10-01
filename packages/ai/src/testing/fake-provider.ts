/**
 * {@link createFakeProvider}: a scripted provider for app tests.
 *
 * Each request plays the next turn of the script (or the turn a function
 * returns) through the real stream contract: `response-start`, reasoning and
 * text deltas in chunks, tool-input parts, and one `response-end` whose
 * assistant message carries raw `native` blocks, a finish reason (refusals
 * with their category, `length`, and the rest), usage, and per-model usage
 * iterations. Turns can wait between parts, hang until aborted, or fail with
 * a value-free `AiError`. The provider records every request and call init
 * and counts the parts consumers pulled, so a test can assert backpressure;
 * it honours the abort signal between parts and while waiting.
 */

import { AiError, type AiErrorCode } from '../errors/ai-error.js';
import type { AiFinishReason, AiMessage, AiPart } from '../content/types.js';
import type {
  AiCallInit,
  AiModel,
  AiProvider,
  AiProviderCapabilities,
  AiProviderRequest,
  AiProviderResponse,
  AiProviderStreamPart,
} from '../provider/contract.js';
import { collectResponse } from '../provider/client-settings.js';
import type { AiUsageIteration } from '../usage/pricing.js';
import { ZERO_USAGE, addUsage, type AiUsage } from '../usage/usage.js';

/** A tool call a fake turn makes. */
export interface FakeToolCall {
  readonly name: string;
  readonly input: unknown;
  /**
   * Defaults to `fake_call_<n>_<index>`, where `n` is the number of messages
   * in the request: deterministic and unique within a conversation, even
   * across runs with different fake providers.
   */
  readonly id?: string;
}

/** One model and speed that served part of a fake response. */
export interface FakeIteration {
  /** Defaults to the turn's model. */
  readonly model?: string;
  readonly speed?: string;
  readonly usage?: Partial<AiUsage>;
}

/** One scripted response. */
export interface FakeTurn {
  readonly text?: string;
  readonly reasoning?: string;
  readonly toolCalls?: readonly FakeToolCall[];
  /** Defaults to `tool-calls` when the turn calls tools, `refusal` with `refusal`, else `stop`. */
  readonly finishReason?: AiFinishReason;
  /** A refusal and its category; implies the `refusal` finish reason. */
  readonly refusal?: { readonly category: string | null };
  /** The model the response reports (default: the requested model). */
  readonly model?: string;
  /** Usage of the response; defaults to the sum of `iterations`, else 10 in and 5 out. */
  readonly usage?: Partial<AiUsage>;
  /** Per-model usage, as when a server-side fallback served part of the turn. */
  readonly iterations?: readonly FakeIteration[];
  /** The raw content array kept in the message's `native` (default: one block per part). */
  readonly native?: readonly unknown[];
  /** Characters per text and reasoning delta (default: the whole text in one delta). */
  readonly chunkSize?: number;
  /** Milliseconds to wait before each part. */
  readonly delayMs?: number;
  /** Wait for the abort signal before the first part. */
  readonly hang?: boolean;
  /** Fail with `AiError(error)` instead of (or, with `errorAfterParts`, part way through) responding. */
  readonly error?: AiErrorCode;
  /** How many parts to stream before failing with `error`. */
  readonly errorAfterParts?: number;
}

/** A fixed script, or a function that picks the turn for each request. */
export type FakeScript =
  readonly FakeTurn[] | ((request: AiProviderRequest, index: number) => FakeTurn);

/** Options for {@link createFakeProvider}. */
export interface FakeProviderOptions {
  /** The provider id (default `fake`). */
  readonly id?: string;
  readonly capabilities?: Partial<AiProviderCapabilities>;
  /** Enables `countTokens`: a fixed count or a function of the request. */
  readonly countTokens?: number | ((request: AiProviderRequest) => number);
}

/** A fake provider and what it saw. */
export interface FakeProvider extends AiProvider {
  /** Every request, in order (stream, generate, and countTokens calls). */
  readonly requests: readonly AiProviderRequest[];
  /** The call init of every request, in order. */
  readonly inits: readonly AiCallInit[];
  /** Stream parts consumers have pulled so far, across requests. */
  readonly pulls: number;
  /** The provider bound to a model id (default `fake-model`). */
  model(id?: string): AiModel;
}

const DEFAULT_USAGE: AiUsage = Object.freeze({
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

const DEFAULT_CAPABILITIES: AiProviderCapabilities = Object.freeze({
  tools: true,
  parallelTools: true,
  structuredOutput: 'native',
  strictTools: true,
  schemaProfile: 'anthropic-strict',
  images: true,
  pdf: true,
  reasoning: true,
  promptCache: 'none',
  countTokens: false,
});

function fakeFailure(code: AiErrorCode): AiError {
  return new AiError(code, 'the fake provider failed as scripted', {
    context: { reason: 'scripted' },
  });
}

function abortedError(): AiError {
  return new AiError('aborted', 'the fake provider call was aborted');
}

function invalidScript(reason: string, index: number): AiError {
  return new AiError('invalid_options', 'the fake provider script is invalid', {
    context: { reason, index },
  });
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(abortedError());
    else signal.addEventListener('abort', () => reject(abortedError()), { once: true });
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortedError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortedError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function chunks(text: string, size: number | undefined): string[] {
  if (text.length === 0) return [];
  if (size === undefined) return [text];
  const code = Array.from(text);
  const out: string[] = [];
  for (let at = 0; at < code.length; at += size) out.push(code.slice(at, at + size).join(''));
  return out;
}

function usageOf(partial: Partial<AiUsage> | undefined): AiUsage {
  return Object.freeze({ ...DEFAULT_USAGE, ...partial });
}

function finishReasonOf(turn: FakeTurn): AiFinishReason {
  if (turn.finishReason !== undefined) return turn.finishReason;
  if (turn.refusal !== undefined) return 'refusal';
  return (turn.toolCalls ?? []).length > 0 ? 'tool-calls' : 'stop';
}

/** The parts and final response of one turn. */
function playTurn(
  providerId: string,
  turn: FakeTurn,
  request: AiProviderRequest,
  index: number,
): AiProviderStreamPart[] {
  if (
    turn.chunkSize !== undefined &&
    (!Number.isSafeInteger(turn.chunkSize) || turn.chunkSize < 1)
  ) {
    throw invalidScript('chunk_size', index);
  }
  const model = turn.model ?? request.model;
  const responseId = `fake_resp_${index}`;
  const calls = (turn.toolCalls ?? []).map((call, at) => ({
    id: call.id ?? `fake_call_${request.messages.length}_${at}`,
    name: call.name,
    input: call.input,
  }));
  const parts: AiProviderStreamPart[] = [{ type: 'response-start', id: responseId, model }];
  for (const delta of chunks(turn.reasoning ?? '', turn.chunkSize)) {
    parts.push({ type: 'reasoning-delta', delta });
  }
  for (const delta of chunks(turn.text ?? '', turn.chunkSize)) {
    parts.push({ type: 'text-delta', delta });
  }
  for (const call of calls) {
    parts.push({ type: 'tool-input-start', id: call.id, name: call.name });
    parts.push({ type: 'tool-input-delta', id: call.id, delta: JSON.stringify(call.input) });
  }

  const messageParts: AiPart[] = [];
  const native: unknown[] = [];
  if (turn.reasoning !== undefined) {
    messageParts.push({ type: 'reasoning', text: turn.reasoning });
    native.push({ type: 'reasoning', text: turn.reasoning });
  }
  if (turn.text !== undefined && turn.text.length > 0) {
    messageParts.push({ type: 'text', text: turn.text });
    native.push({ type: 'text', text: turn.text });
  }
  for (const call of calls) {
    messageParts.push({ type: 'tool-call', ...call });
    native.push({ type: 'tool_call', ...call });
  }
  const message: AiMessage = {
    role: 'assistant',
    parts: messageParts,
    native: { provider: providerId, model, content: turn.native ?? native },
  };

  const iterations: AiUsageIteration[] = (turn.iterations ?? [{}]).map((iteration) => ({
    provider: providerId,
    model: iteration.model ?? model,
    ...(iteration.speed === undefined ? {} : { speed: iteration.speed }),
    usage: usageOf(iteration.usage),
  }));
  const usage =
    turn.usage !== undefined || turn.iterations === undefined
      ? usageOf(turn.usage)
      : iterations.reduce((total, iteration) => addUsage(total, iteration.usage), ZERO_USAGE);
  const response: AiProviderResponse = {
    id: responseId,
    model,
    message,
    finishReason: finishReasonOf(turn),
    usage,
    iterations,
    ...(turn.refusal === undefined ? {} : { refusal: { category: turn.refusal.category } }),
  };
  parts.push({ type: 'response-end', response });
  return parts;
}

/** A provider that plays `script`, one turn per request. */
export function createFakeProvider(
  script: FakeScript,
  options: FakeProviderOptions = {},
): FakeProvider {
  const id = options.id ?? 'fake';
  const requests: AiProviderRequest[] = [];
  const inits: AiCallInit[] = [];
  let pulls = 0;
  const countTokens = options.countTokens;
  const capabilities: AiProviderCapabilities = Object.freeze({
    ...DEFAULT_CAPABILITIES,
    countTokens: countTokens !== undefined,
    ...options.capabilities,
  });

  const turnFor = (request: AiProviderRequest, index: number): FakeTurn => {
    if (typeof script === 'function') return script(request, index);
    const turn = script[index];
    if (turn === undefined) throw invalidScript('script_exhausted', index);
    return turn;
  };

  async function* stream(
    request: AiProviderRequest,
    init: AiCallInit,
  ): AsyncGenerator<AiProviderStreamPart> {
    const index = requests.length;
    requests.push(request);
    inits.push(init);
    const turn = turnFor(request, index);
    const parts = playTurn(id, turn, request, index);
    const failAt = turn.error === undefined ? -1 : (turn.errorAfterParts ?? 0);
    if (turn.hang === true) await waitForAbort(init.signal);
    for (let at = 0; at < parts.length; at += 1) {
      if (at === failAt && turn.error !== undefined) throw fakeFailure(turn.error);
      if (turn.delayMs !== undefined) await sleep(turn.delayMs, init.signal);
      if (init.signal.aborted) throw abortedError();
      pulls += 1;
      yield parts[at] as AiProviderStreamPart;
    }
    if (failAt >= parts.length && turn.error !== undefined) throw fakeFailure(turn.error);
  }

  const provider: FakeProvider = {
    id,
    capabilities,
    get requests(): readonly AiProviderRequest[] {
      return requests;
    },
    get inits(): readonly AiCallInit[] {
      return inits;
    },
    get pulls(): number {
      return pulls;
    },
    model(modelId = 'fake-model'): AiModel {
      return Object.freeze({ provider, id: modelId });
    },
    stream,
    generate(request, init): Promise<AiProviderResponse> {
      return collectResponse(stream(request, init));
    },
    ...(countTokens === undefined
      ? {}
      : {
          countTokens(request: AiProviderRequest, init: AiCallInit): Promise<number> {
            requests.push(request);
            inits.push(init);
            if (init.signal.aborted) return Promise.reject(abortedError());
            return Promise.resolve(
              typeof countTokens === 'number' ? countTokens : countTokens(request),
            );
          },
        }),
  };
  return provider;
}
