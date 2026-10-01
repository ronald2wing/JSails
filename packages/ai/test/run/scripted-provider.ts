/**
 * A scripted provider for run-loop tests: each turn streams text, reasoning,
 * and tool calls through the real stream contract, records every request and
 * call init, counts pulled parts, and honours the abort signal.
 */

import type { AiFinishReason, AiMessage } from '../../src/content/types.js';
import type {
  AiCallInit,
  AiModel,
  AiProvider,
  AiProviderCapabilities,
  AiProviderRequest,
  AiProviderStreamPart,
} from '../../src/provider/contract.js';
import type { AiUsage } from '../../src/usage/usage.js';

/** One scripted response. */
export interface Turn {
  readonly text?: string;
  readonly reasoning?: string;
  readonly toolCalls?: readonly {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }[];
  readonly finishReason?: AiFinishReason;
  readonly usage?: Partial<AiUsage>;
  /** The model the response reports (default: the requested model). */
  readonly model?: string;
  /** Characters per text delta (default 4). */
  readonly chunk?: number;
  /** Wait for the abort signal before the first part. */
  readonly hang?: boolean;
  /** Wait this long before each part. */
  readonly delayMs?: number;
  /** Throw this instead of responding. */
  readonly error?: unknown;
  /** Stream exactly these parts instead. */
  readonly parts?: readonly unknown[];
  /** A raw message override for the final response. */
  readonly message?: AiMessage;
}

/** A scripted provider and what it saw. */
export interface ScriptedProvider extends AiProvider {
  readonly requests: AiProviderRequest[];
  readonly inits: AiCallInit[];
  /** Parts handed out so far, across turns. */
  pulls: number;
  model(id?: string): AiModel;
}

export const BASE_USAGE: AiUsage = Object.freeze({
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export const CAPABILITIES: AiProviderCapabilities = Object.freeze({
  tools: true,
  parallelTools: true,
  structuredOutput: 'native',
  strictTools: true,
  schemaProfile: 'anthropic-strict',
  images: true,
  pdf: true,
  reasoning: true,
  promptCache: 'explicit',
  countTokens: true,
});

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = (): void => reject(new Error('aborted by signal'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted by signal'));
      },
      { once: true },
    );
  });
}

/** Build the parts of one scripted turn. */
export function turnParts(turn: Turn, request: AiProviderRequest, index: number): unknown[] {
  if (turn.parts !== undefined) return [...turn.parts];
  const model = turn.model ?? request.model;
  const usage: AiUsage = { ...BASE_USAGE, ...turn.usage };
  const parts: unknown[] = [{ type: 'response-start', id: `resp_${index}`, model }];
  const chunk = turn.chunk ?? 4;
  if (turn.reasoning !== undefined) parts.push({ type: 'reasoning-delta', delta: turn.reasoning });
  const text = turn.text ?? '';
  for (let at = 0; at < text.length; at += chunk) {
    parts.push({ type: 'text-delta', delta: text.slice(at, at + chunk) });
  }
  for (const call of turn.toolCalls ?? []) {
    parts.push({ type: 'tool-input-start', id: call.id, name: call.name });
    parts.push({ type: 'tool-input-delta', id: call.id, delta: JSON.stringify(call.input) });
  }
  const messageParts = [
    ...(turn.reasoning === undefined ? [] : [{ type: 'reasoning', text: turn.reasoning }]),
    ...(text.length === 0 ? [] : [{ type: 'text', text }]),
    ...(turn.toolCalls ?? []).map((call) => ({ type: 'tool-call', ...call })),
  ];
  parts.push({
    type: 'response-end',
    response: {
      id: `resp_${index}`,
      model,
      message: turn.message ?? {
        role: 'assistant',
        parts: messageParts,
        native: { provider: 'scripted', model, content: [{ type: 'raw', index }] },
      },
      finishReason:
        turn.finishReason ?? ((turn.toolCalls ?? []).length > 0 ? 'tool-calls' : 'stop'),
      usage,
      iterations: [{ provider: 'scripted', model, usage }],
    },
  });
  return parts;
}

/** A provider that plays `script` turn by turn (the last turn repeats). */
export function scriptedProvider(
  script: readonly Turn[] | ((request: AiProviderRequest, index: number) => Turn),
  capabilities: Partial<AiProviderCapabilities> = {},
  countTokens?: (request: AiProviderRequest, init: AiCallInit) => Promise<unknown>,
): ScriptedProvider {
  const requests: AiProviderRequest[] = [];
  const inits: AiCallInit[] = [];
  const provider: ScriptedProvider = {
    id: 'scripted',
    capabilities: { ...CAPABILITIES, ...capabilities },
    requests,
    inits,
    pulls: 0,
    model(id = 'model-1'): AiModel {
      return { provider, id };
    },
    async *stream(request, init): AsyncGenerator<AiProviderStreamPart> {
      const index = requests.length;
      requests.push(request);
      inits.push(init);
      const turn =
        typeof script === 'function'
          ? script(request, index)
          : (script[Math.min(index, script.length - 1)] ?? {});
      if (turn.error !== undefined) throw turn.error;
      if (turn.hang === true) await waitForAbort(init.signal);
      for (const part of turnParts(turn, request, index)) {
        if (turn.delayMs !== undefined) await sleep(turn.delayMs, init.signal);
        provider.pulls += 1;
        yield part as AiProviderStreamPart;
      }
    },
    generate() {
      return Promise.reject(new Error('the run loop must not call generate'));
    },
    ...(countTokens === undefined
      ? {}
      : {
          countTokens(request: AiProviderRequest, init: AiCallInit): Promise<number> {
            requests.push(request);
            inits.push(init);
            return countTokens(request, init) as Promise<number>;
          },
        }),
  };
  return provider;
}
