/**
 * The OpenAI-compatible adapter's settings and per-request provider options.
 *
 * Settings name the provider, carry explicit credentials (an `apiKey` or an
 * injected `client`; never the environment), and describe what the server
 * behind the base URL supports. Compatible servers (vLLM, Ollama,
 * OpenRouter, Azure, LM Studio) differ: some lack strict tools, images,
 * PDFs, reasoning effort, or the usage chunk, and older ones want
 * `max_tokens` instead of `max_completion_tokens`. The flags turn each
 * feature off instead of letting the server reject or silently ignore it.
 *
 * Sampling options exist only here, under `providerOptions.openaiCompatible`:
 * they are not part of the neutral request because Claude models reject them.
 */

import { AiError } from '../errors/ai-error.js';
import { isPlainObject } from '../content/json-value.js';
import { AI_EFFORTS, type AiEffort } from '../content/types.js';
import type { AiProviderCapabilities, AiProviderOptions } from '../provider/contract.js';
import { invalidSettings } from '../provider/client-settings.js';
import type { OpenAIChatClient } from './openai-wire.js';

/** What the server supports; every flag defaults to what api.openai.com supports. */
export interface OpenAICompatibleSupport {
  /** Function tools (default true). */
  readonly tools?: boolean;
  /** Several tool calls in one response, and `parallel_tool_calls` (default true). */
  readonly parallelTools?: boolean;
  /** `native`: `response_format` json_schema (default); `tool`: a tool-call fallback; `none`. */
  readonly structuredOutput?: AiProviderCapabilities['structuredOutput'];
  /** `strict: true` on tools and response formats (default true). */
  readonly strictTools?: boolean;
  /** Image input (default true). */
  readonly images?: boolean;
  /** PDF input as a `file` part (default false). */
  readonly pdf?: boolean;
  /** `reasoning_effort`, and streamed reasoning text (default false). */
  readonly reasoning?: boolean;
  /**
   * The final usage chunk (`stream_options.include_usage`, default true).
   * Without it the server reports no usage, every response counts zero
   * tokens, and token and cost budgets cannot bind.
   */
  readonly streamUsage?: boolean;
}

/** Settings for {@link createOpenAICompatible}. */
export interface OpenAICompatibleSettings {
  /** The provider id (default `openai-compatible`); it tags usage and pricing. */
  readonly name?: string;
  /** The API key; required unless `client` is given. Never read from the environment. */
  readonly apiKey?: string;
  /** A configured client (`OpenAI`, `AzureOpenAI`, or one of the same shape). */
  readonly client?: OpenAIChatClient;
  /** The server base URL (default `https://api.openai.com/v1`). */
  readonly baseURL?: string;
  /** SDK retries for the client built from `apiKey` (default 2). */
  readonly maxRetries?: number;
  /** Per-request SDK timeout in milliseconds for the client built from `apiKey`. */
  readonly timeoutMs?: number;
  /** A `fetch` for the client built from `apiKey` (a proxy agent, tests). */
  readonly fetch?: typeof globalThis.fetch;
  /** The output-token field the server reads (default `max_completion_tokens`). */
  readonly maxTokensField?: 'max_completion_tokens' | 'max_tokens';
  /** The role instructions and operator messages are sent as (default `system`). */
  readonly instructionsRole?: 'system' | 'developer';
  /** The highest effort the server accepts; higher efforts are lowered to it (default `high`). */
  readonly maxReasoningEffort?: AiEffort;
  /** What the server supports. */
  readonly supports?: OpenAICompatibleSupport;
}

/** Request options under `providerOptions.openaiCompatible`. */
export interface OpenAICompatibleRequestOptions {
  readonly temperature?: number;
  readonly topP?: number;
  readonly seed?: number;
  readonly promptCacheKey?: string;
  /** An opaque end-user id; never a name or email. */
  readonly user?: string;
}

declare module '../provider/contract.js' {
  interface AiProviderOptions {
    readonly openaiCompatible?: OpenAICompatibleRequestOptions;
  }
}

/** The validated, filled-in settings the request builder and stream reader use. */
export interface OpenAICompatibleConfig {
  readonly id: string;
  readonly maxTokensField: 'max_completion_tokens' | 'max_tokens';
  readonly instructionsRole: 'system' | 'developer';
  readonly maxReasoningEffort: AiEffort;
  readonly streamUsage: boolean;
  readonly capabilities: AiProviderCapabilities;
}

const SUPPORT_KEYS: ReadonlySet<string> = new Set([
  'tools',
  'parallelTools',
  'structuredOutput',
  'strictTools',
  'images',
  'pdf',
  'reasoning',
  'streamUsage',
]);

function flag(
  supports: Record<string, unknown>,
  key: string,
  fallback: boolean,
  provider: string,
): boolean {
  const value = supports[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw invalidSettings(provider, `supports.${key}`);
  return value;
}

/** Validate the non-transport settings. Throws `AiError('invalid_options')`. */
export function readOpenAICompatibleConfig(
  settings: OpenAICompatibleSettings,
): OpenAICompatibleConfig {
  const id = settings.name ?? 'openai-compatible';
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
    throw invalidSettings('openai-compatible', 'name');
  }
  const maxTokensField = settings.maxTokensField ?? 'max_completion_tokens';
  if (maxTokensField !== 'max_completion_tokens' && maxTokensField !== 'max_tokens') {
    throw invalidSettings(id, 'maxTokensField');
  }
  const instructionsRole = settings.instructionsRole ?? 'system';
  if (instructionsRole !== 'system' && instructionsRole !== 'developer') {
    throw invalidSettings(id, 'instructionsRole');
  }
  const maxReasoningEffort = settings.maxReasoningEffort ?? 'high';
  if (!AI_EFFORTS.includes(maxReasoningEffort)) throw invalidSettings(id, 'maxReasoningEffort');
  const supports: unknown = settings.supports ?? {};
  if (!isPlainObject(supports)) throw invalidSettings(id, 'supports');
  for (const key of Object.keys(supports)) {
    if (!SUPPORT_KEYS.has(key)) throw invalidSettings(id, `supports.${key}`);
  }
  const structuredOutput = supports.structuredOutput ?? 'native';
  if (structuredOutput !== 'native' && structuredOutput !== 'tool' && structuredOutput !== 'none') {
    throw invalidSettings(id, 'supports.structuredOutput');
  }
  const strictTools = flag(supports, 'strictTools', true, id);
  const capabilities: AiProviderCapabilities = Object.freeze({
    tools: flag(supports, 'tools', true, id),
    parallelTools: flag(supports, 'parallelTools', true, id),
    structuredOutput,
    strictTools,
    schemaProfile: strictTools ? 'openai-strict' : 'loose',
    images: flag(supports, 'images', true, id),
    pdf: flag(supports, 'pdf', false, id),
    reasoning: flag(supports, 'reasoning', false, id),
    promptCache: 'automatic',
    countTokens: false,
  });
  return {
    id,
    maxTokensField,
    instructionsRole,
    maxReasoningEffort,
    streamUsage: flag(supports, 'streamUsage', true, id),
    capabilities,
  };
}

const OPTION_KEYS: ReadonlySet<string> = new Set([
  'temperature',
  'topP',
  'seed',
  'promptCacheKey',
  'user',
]);

function invalidOption(field: string): AiError {
  return new AiError('invalid_options', 'the openai-compatible provider options are invalid', {
    context: { field },
  });
}

function readNumber(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw invalidOption(field);
  }
  return value;
}

function readLabel(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw invalidOption(field);
  }
  return value;
}

/**
 * Read `providerOptions.openaiCompatible`; unknown keys are refused. Throws
 * `AiError('invalid_options')`.
 */
export function readOpenAICompatibleOptions(
  options: AiProviderOptions | undefined,
): OpenAICompatibleRequestOptions {
  const value: unknown = options?.openaiCompatible;
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw invalidOption('openaiCompatible');
  for (const key of Object.keys(value)) {
    if (!OPTION_KEYS.has(key)) throw invalidOption(key);
  }
  const temperature = readNumber(value.temperature, 'temperature', 0, 2);
  const topP = readNumber(value.topP, 'topP', 0, 1);
  const seed = value.seed;
  if (seed !== undefined && (typeof seed !== 'number' || !Number.isSafeInteger(seed))) {
    throw invalidOption('seed');
  }
  const promptCacheKey = readLabel(value.promptCacheKey, 'promptCacheKey');
  const user = readLabel(value.user, 'user');
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(seed === undefined ? {} : { seed }),
    ...(promptCacheKey === undefined ? {} : { promptCacheKey }),
    ...(user === undefined ? {} : { user }),
  };
}
