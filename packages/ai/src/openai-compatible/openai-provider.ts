/**
 * {@link createOpenAICompatible}: an OpenAI Chat Completions endpoint (OpenAI
 * itself, Azure, or a compatible server such as vLLM, Ollama, or OpenRouter)
 * as an {@link AiProvider}.
 *
 * Every call streams, and `generate` drains the same stream. Retries belong
 * to the SDK client (`maxRetries`); the adapter never retries. What the SDK
 * throws is mapped to a value-free `AiError`, a context-length rejection
 * included. The `openai` SDK (an optional peer) is loaded on the first call,
 * and only when the provider was given an `apiKey`.
 *
 * Chat Completions is the compatibility standard this adapter targets; the
 * OpenAI Responses API, the only way to round-trip OpenAI reasoning items,
 * is out of its scope.
 */

import { AiError } from '../errors/ai-error.js';
import type {
  AiCallInit,
  AiModel,
  AiProvider,
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
import { readOpenAICompatibleConfig, type OpenAICompatibleSettings } from './openai-options.js';
import { buildOpenAIRequest } from './openai-request.js';
import { readOpenAIStream } from './openai-stream.js';
import type { OpenAIChatClient } from './openai-wire.js';

/** An OpenAI-compatible provider, with a model factory. */
export interface OpenAICompatibleProvider extends AiProvider {
  /** Bind the provider to one model. */
  model(id: string): AiModel;
}

/** The default API base URL. */
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function isChatClient(value: unknown): value is OpenAIChatClient {
  return hasMethod(value, ['chat', 'completions', 'create']);
}

/** OpenAI names the code; compatible servers usually only say so in the message. */
function isContextLength(facts: ApiErrorFacts): boolean {
  if (facts.code === 'context_length_exceeded') return true;
  return (
    facts.message !== undefined &&
    /context length|context window|maximum context|too many tokens|prompt is too long/i.test(
      facts.message,
    )
  );
}

async function buildClient(settings: OwnedClientSettings): Promise<OpenAIChatClient> {
  let sdk: typeof import('openai');
  try {
    sdk = await import('openai');
  } catch {
    throw new AiError('invalid_options', 'the openai package is not installed', {
      context: { provider: 'openai-compatible', field: 'apiKey' },
      suggestion: 'Install openai, or pass a configured client.',
    });
  }
  const client: OpenAIChatClient = new sdk.default({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    maxRetries: settings.maxRetries,
    ...(settings.timeoutMs === undefined ? {} : { timeout: settings.timeoutMs }),
    ...(settings.fetch === undefined ? {} : { fetch: settings.fetch }),
    organization: null,
    project: null,
    webhookSecret: null,
    logLevel: 'off',
  });
  return client;
}

function toolCallIds(request: AiProviderRequest): Set<string> {
  const ids = new Set<string>();
  for (const message of request.messages) {
    for (const part of message.parts) {
      if (part.type === 'tool-call') ids.add(part.id);
    }
  }
  return ids;
}

/**
 * Create an OpenAI-compatible provider. Exactly one of `apiKey` and `client`
 * is required; nothing is read from the environment. Throws
 * `AiError('invalid_options')` naming only the bad field.
 */
export function createOpenAICompatible(
  settings: OpenAICompatibleSettings,
): OpenAICompatibleProvider {
  const config = readOpenAICompatibleConfig(settings);
  const transport = readClientSettings(settings, config.id, DEFAULT_BASE_URL, isChatClient);
  let owned: Promise<OpenAIChatClient> | undefined;
  const client = (): Promise<OpenAIChatClient> => {
    if (transport.kind === 'injected') return Promise.resolve(transport.client);
    owned ??= buildClient(transport);
    return owned;
  };

  async function* stream(
    request: AiProviderRequest,
    init: AiCallInit,
  ): AsyncGenerator<AiProviderStreamPart, void> {
    const body = buildOpenAIRequest(request, config);
    const completions = (await client()).chat.completions;
    let chunks: AsyncIterable<unknown>;
    try {
      chunks = await completions.create(body, {
        signal: init.signal,
        headers: { ...init.headers },
      });
    } catch (error) {
      throw mapApiError(error, init.signal, isContextLength);
    }
    try {
      yield* readOpenAIStream(chunks, {
        providerId: config.id,
        requestModel: request.model,
        usedIds: toolCallIds(request),
        streamUsage: config.streamUsage,
        signal: init.signal,
      });
    } catch (error) {
      throw mapApiError(error, init.signal, isContextLength);
    }
  }

  const provider: OpenAICompatibleProvider = {
    id: config.id,
    capabilities: config.capabilities,
    stream,
    generate: (request, init) => collectResponse(stream(request, init)),
    model(id) {
      if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
        throw invalidSettings(config.id, 'model');
      }
      return Object.freeze({ provider, id });
    },
  };
  return Object.freeze(provider);
}
