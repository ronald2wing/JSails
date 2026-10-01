/**
 * {@link createAnthropic}: the Claude Messages API as an {@link AiProvider}.
 *
 * Every call streams (`messages.create({ stream: true })`), and `generate`
 * drains the same stream, so there is one path and long generations never
 * meet a non-streaming timeout. Retries belong to the SDK client (its
 * `maxRetries`, honoring `retry-after` and `x-should-retry`); the adapter
 * never retries, so a stream is never replayed after its first token. What
 * the SDK finally throws is mapped to a value-free `AiError`, a prompt that
 * is too long included (`context_length_exceeded`).
 *
 * The SDK (`@anthropic-ai/sdk`, an optional peer) is loaded on the first
 * call, and only when the provider was given an `apiKey`; a provider built
 * on an injected client never loads it.
 */

import { AiError } from '../errors/ai-error.js';
import type {
  AiCallInit,
  AiModel,
  AiProvider,
  AiProviderCapabilities,
  AiProviderRequest,
  AiProviderStreamPart,
} from '../provider/contract.js';
import { mapApiError, type ApiErrorFacts } from '../provider/api-error.js';
import {
  collectResponse,
  hasMethod,
  invalidSettings,
  readClientSettings,
  type OwnedClientSettings,
} from '../provider/client-settings.js';
import { providerFailed } from '../provider/provider-response.js';
import type { AnthropicProviderSettings } from './anthropic-options.js';
import {
  ANTHROPIC_PROVIDER_ID,
  buildAnthropicCountRequest,
  buildAnthropicRequest,
  type AnthropicRequestConfig,
} from './anthropic-request.js';
import { readAnthropicStream } from './anthropic-stream.js';
import type { AnthropicMessagesClient } from './anthropic-wire.js';

/** A Claude model id; any other string is passed through. */
export type AnthropicModelId =
  'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-5-5' | 'claude-fable-5-2' | (string & {});

/** The Anthropic provider, with a model factory. */
export interface AnthropicProvider extends AiProvider {
  /** Bind the provider to one model. */
  model(id: AnthropicModelId): AiModel;
}

/** The default API base URL. */
const DEFAULT_BASE_URL = 'https://api.anthropic.com';

function isAnthropicClient(value: unknown): value is AnthropicMessagesClient {
  return hasMethod(value, ['messages', 'create']);
}

/** Anthropic reports an over-long prompt as a plain `invalid_request_error`. */
function isContextLength(facts: ApiErrorFacts): boolean {
  return (
    facts.message !== undefined &&
    /prompt is too long|context window|context length/i.test(facts.message)
  );
}

async function buildClient(settings: OwnedClientSettings): Promise<AnthropicMessagesClient> {
  let sdk: typeof import('@anthropic-ai/sdk');
  try {
    sdk = await import('@anthropic-ai/sdk');
  } catch {
    throw new AiError('invalid_options', 'the @anthropic-ai/sdk package is not installed', {
      context: { provider: ANTHROPIC_PROVIDER_ID, field: 'apiKey' },
      suggestion: 'Install @anthropic-ai/sdk, or pass a configured client.',
    });
  }
  const client: AnthropicMessagesClient = new sdk.default({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    maxRetries: settings.maxRetries,
    ...(settings.timeoutMs === undefined ? {} : { timeout: settings.timeoutMs }),
    ...(settings.fetch === undefined ? {} : { fetch: settings.fetch }),
    webhookKey: null,
    logLevel: 'off',
    openTelemetry: false,
  });
  return client;
}

function mergeHeaders(
  init: Readonly<Record<string, string>>,
  extra: Readonly<Record<string, string>>,
): Record<string, string> {
  const headers: Record<string, string> = { ...init };
  for (const [name, value] of Object.entries(extra)) {
    const existing = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
    if (existing === undefined) headers[name] = value;
    else headers[existing[0]] = `${existing[1]},${value}`;
  }
  return headers;
}

/**
 * Create the Anthropic provider. Exactly one of `apiKey` and `client` is
 * required; nothing is read from the environment. Throws
 * `AiError('invalid_options')` naming only the bad field.
 */
export function createAnthropic(settings: AnthropicProviderSettings): AnthropicProvider {
  const transport = readClientSettings(
    settings,
    ANTHROPIC_PROVIDER_ID,
    DEFAULT_BASE_URL,
    isAnthropicClient,
  );
  const { cacheTtl, eagerInputStreaming } = settings;
  if (cacheTtl !== undefined && cacheTtl !== '5m' && cacheTtl !== '1h') {
    throw invalidSettings(ANTHROPIC_PROVIDER_ID, 'cacheTtl');
  }
  if (
    eagerInputStreaming !== undefined &&
    eagerInputStreaming !== 'auto' &&
    eagerInputStreaming !== 'off'
  ) {
    throw invalidSettings(ANTHROPIC_PROVIDER_ID, 'eagerInputStreaming');
  }
  const config: AnthropicRequestConfig = {
    cacheTtl,
    eagerInputStreaming: eagerInputStreaming !== 'off',
  };
  let owned: Promise<AnthropicMessagesClient> | undefined;
  const client = (): Promise<AnthropicMessagesClient> => {
    if (transport.kind === 'injected') return Promise.resolve(transport.client);
    owned ??= buildClient(transport);
    return owned;
  };
  const canCount =
    transport.kind === 'owned' || hasMethod(transport.client, ['messages', 'countTokens']);
  const capabilities: AiProviderCapabilities = Object.freeze({
    tools: true,
    parallelTools: true,
    structuredOutput: 'native',
    strictTools: true,
    schemaProfile: 'anthropic-strict',
    images: true,
    pdf: true,
    reasoning: true,
    promptCache: 'explicit',
    countTokens: canCount,
  });

  async function* stream(
    request: AiProviderRequest,
    init: AiCallInit,
  ): AsyncGenerator<AiProviderStreamPart, void> {
    const built = buildAnthropicRequest(request, config);
    const messages = (await client()).messages;
    let events: AsyncIterable<unknown>;
    try {
      events = await messages.create(built.body, {
        signal: init.signal,
        headers: mergeHeaders(init.headers, built.headers),
      });
    } catch (error) {
      throw mapApiError(error, init.signal, isContextLength);
    }
    try {
      yield* readAnthropicStream(events, init.signal);
    } catch (error) {
      throw mapApiError(error, init.signal, isContextLength);
    }
  }

  const provider: AnthropicProvider = {
    id: ANTHROPIC_PROVIDER_ID,
    capabilities,
    stream,
    generate: (request, init) => collectResponse(stream(request, init)),
    async countTokens(request, init) {
      const built = buildAnthropicCountRequest(request, config);
      const messages = (await client()).messages;
      if (messages.countTokens === undefined) {
        throw new AiError('unsupported_capability', 'the provider cannot count tokens', {
          context: { provider: ANTHROPIC_PROVIDER_ID, capability: 'count_tokens' },
        });
      }
      let result: unknown;
      try {
        result = await messages.countTokens(built.body, {
          signal: init.signal,
          headers: mergeHeaders(init.headers, built.headers),
        });
      } catch (error) {
        throw mapApiError(error, init.signal, isContextLength);
      }
      const count =
        typeof result === 'object' && result !== null
          ? (result as { readonly input_tokens?: unknown }).input_tokens
          : undefined;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
        throw providerFailed('token_count');
      }
      return count;
    },
    model(id) {
      if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
        throw invalidSettings(ANTHROPIC_PROVIDER_ID, 'model');
      }
      return Object.freeze({ provider, id });
    },
  };
  return Object.freeze(provider);
}
