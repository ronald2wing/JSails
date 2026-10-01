/**
 * {@link replayProvider}: plays a recorded fixture back, one response per
 * request, in order.
 *
 * A fixture is plain JSON at the neutral provider boundary: for each
 * provider call, the stream parts it produced. It holds no headers, keys, or
 * SDK objects, so it can be committed. {@link parseFixture} is the only way a
 * fixture file enters (value-free errors naming the response and part
 * index). Matching is by sequence only: request N gets response N, and a
 * request past the end is `AiError('provider_failed')` with reason
 * `replay_exhausted`. The parts are not trusted; the run loop checks them
 * against the stream contract as it would a live provider's.
 */

import { AiError } from '../errors/ai-error.js';
import { copyJson, isPlainObject } from '../content/json-value.js';
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

/** One recorded provider call. */
export interface AiFixtureResponse {
  readonly parts: readonly AiProviderStreamPart[];
}

/** A recorded sequence of provider calls, wire version 1. */
export interface AiFixture {
  readonly v: 1;
  /** The recorded provider's id (default `replay`). */
  readonly provider?: string;
  readonly responses: readonly AiFixtureResponse[];
}

/** Options for {@link replayProvider}. */
export interface ReplayProviderOptions {
  readonly capabilities?: Partial<AiProviderCapabilities>;
}

/** A replaying provider and what it saw. */
export interface ReplayProvider extends AiProvider {
  readonly requests: readonly AiProviderRequest[];
  /** Responses not yet played; assert `0` at the end of a test. */
  readonly remaining: number;
  /** The provider bound to a model id (default `replay-model`). */
  model(id?: string): AiModel;
}

const PART_TYPES = new Set<string>([
  'response-start',
  'text-delta',
  'reasoning-delta',
  'tool-input-start',
  'tool-input-delta',
  'response-end',
]);

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

function invalidFixture(reason: string, response?: number, part?: number): AiError {
  return new AiError('invalid_options', 'the replay fixture is invalid', {
    context: {
      reason,
      ...(response === undefined ? {} : { response }),
      ...(part === undefined ? {} : { part }),
    },
  });
}

/** Parse fixture JSON. The result is deep-frozen. */
export function parseFixture(value: unknown): AiFixture {
  if (!isPlainObject(value)) throw invalidFixture('root');
  if (value.v !== 1) throw invalidFixture('v');
  const provider = value.provider;
  if (
    provider !== undefined &&
    (typeof provider !== 'string' || provider.length === 0 || provider.length > 256)
  ) {
    throw invalidFixture('provider');
  }
  if (!Array.isArray(value.responses)) throw invalidFixture('responses');
  const responses = (value.responses as readonly unknown[]).map((response, index) => {
    if (!isPlainObject(response) || !Array.isArray(response.parts)) {
      throw invalidFixture('response', index);
    }
    const parts = (response.parts as readonly unknown[]).map((part, at) => {
      const copied = copyJson(part);
      if (
        !isPlainObject(copied) ||
        typeof copied.type !== 'string' ||
        !PART_TYPES.has(copied.type)
      ) {
        throw invalidFixture('part', index, at);
      }
      return copied as unknown as AiProviderStreamPart;
    });
    return Object.freeze({ parts: Object.freeze(parts) });
  });
  return Object.freeze({
    v: 1,
    ...(provider === undefined ? {} : { provider }),
    responses: Object.freeze(responses),
  });
}

function exhausted(index: number): AiError {
  return new AiError('provider_failed', 'the replay fixture has no response for this request', {
    context: { reason: 'replay_exhausted', index },
  });
}

/** A provider that replays `fixture` (parsed with {@link parseFixture} first). */
export function replayProvider(
  fixture: unknown,
  options: ReplayProviderOptions = {},
): ReplayProvider {
  const parsed = parseFixture(fixture);
  const requests: AiProviderRequest[] = [];

  async function* stream(
    request: AiProviderRequest,
    init: AiCallInit,
  ): AsyncGenerator<AiProviderStreamPart> {
    const index = requests.length;
    requests.push(request);
    const response = parsed.responses[index];
    if (response === undefined) throw exhausted(index);
    for (const part of response.parts) {
      if (init.signal.aborted) throw new AiError('aborted', 'the replayed call was aborted');
      yield part;
    }
  }

  const provider: ReplayProvider = {
    id: parsed.provider ?? 'replay',
    capabilities: Object.freeze({ ...DEFAULT_CAPABILITIES, ...options.capabilities }),
    get requests(): readonly AiProviderRequest[] {
      return requests;
    },
    get remaining(): number {
      return Math.max(0, parsed.responses.length - requests.length);
    },
    model(id = 'replay-model'): AiModel {
      return Object.freeze({ provider, id });
    },
    stream,
    generate(request, init): Promise<AiProviderResponse> {
      return collectResponse(stream(request, init));
    },
  };
  return provider;
}
