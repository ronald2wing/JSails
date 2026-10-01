/**
 * The Anthropic adapter's settings and its per-request provider options.
 *
 * Settings configure the provider once: credentials (an explicit `apiKey` or
 * an injected `client`; never the environment), the transport of the client
 * the adapter builds, the prompt-cache TTL, and whether client tools stream
 * their input eagerly. Request options travel in
 * `providerOptions.anthropic`, typed here by augmenting
 * {@link AiProviderOptions}; the server-side refusal fallbacks and raw beta
 * flags among them are experimental, because they ride on beta API.
 */

import { AiError } from '../errors/ai-error.js';
import { isPlainObject } from '../content/json-value.js';
import type { AiProviderOptions } from '../provider/contract.js';
import type { AnthropicMessagesClient } from './anthropic-wire.js';

/** Settings for {@link createAnthropic}. */
export interface AnthropicProviderSettings {
  /** The API key. Required unless `client` is given; never read from the environment. */
  readonly apiKey?: string;
  /** A configured Messages API client (official, Bedrock, Vertex, Foundry, ...). */
  readonly client?: AnthropicMessagesClient;
  /** The API base URL for the client built from `apiKey` (default `https://api.anthropic.com`). */
  readonly baseURL?: string;
  /** SDK retries for the client built from `apiKey` (default 2). */
  readonly maxRetries?: number;
  /** Per-request SDK timeout in milliseconds for the client built from `apiKey`. */
  readonly timeoutMs?: number;
  /** A `fetch` for the client built from `apiKey` (a proxy agent, tests). */
  readonly fetch?: typeof globalThis.fetch;
  /** The prompt-cache TTL of every breakpoint (default: the API default, 5 minutes). */
  readonly cacheTtl?: '5m' | '1h';
  /**
   * `auto` (default): client tools stream their input as it is generated
   * (`eager_input_streaming`). The API then no longer validates the input, so
   * the run's own schema validation is the guarantee either way. `off`: for a
   * proxy or an older Bedrock deployment that rejects the field.
   */
  readonly eagerInputStreaming?: 'auto' | 'off';
}

/** Request options under `providerOptions.anthropic`. */
export interface AnthropicRequestOptions {
  /** Where inference runs (`inference_geo`), for example `'us'`. */
  readonly inferenceGeo?: string;
  /** `fast` runs the request in fast mode, on models that offer it, at its own price. */
  readonly speed?: 'fast';
  /** An opaque end-user id for abuse detection (`metadata.user_id`); never a name or email. */
  readonly userId?: string;
  /**
   * @experimental Server-side refusal fallbacks (beta
   * `server-side-fallback-2026-07-01`): `'default'` or an ordered model list.
   * Off unless set.
   */
  readonly fallbacks?: 'default' | readonly { readonly model: string }[];
  /** @experimental Extra `anthropic-beta` flags. */
  readonly betas?: readonly string[];
}

declare module '../provider/contract.js' {
  interface AiProviderOptions {
    readonly anthropic?: AnthropicRequestOptions;
  }
}

/** The beta flag the server-side fallbacks need. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** The validated request options. */
export interface AnthropicRequestExtras {
  readonly inferenceGeo?: string;
  readonly speed?: 'fast';
  readonly userId?: string;
  readonly fallbacks?: 'default' | readonly { readonly model: string }[];
  readonly betas: readonly string[];
}

const OPTION_KEYS: ReadonlySet<string> = new Set([
  'inferenceGeo',
  'speed',
  'userId',
  'fallbacks',
  'betas',
]);

function invalidOption(field: string): AiError {
  return new AiError('invalid_options', 'the anthropic provider options are invalid', {
    context: { field },
  });
}

function readFallbacks(value: unknown): AnthropicRequestExtras['fallbacks'] {
  if (value === undefined) return undefined;
  if (value === 'default') return 'default';
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw invalidOption('fallbacks');
  }
  return Object.freeze(
    (value as readonly unknown[]).map((entry) => {
      if (
        !isPlainObject(entry) ||
        Object.keys(entry).some((key) => key !== 'model') ||
        typeof entry.model !== 'string' ||
        !/^[A-Za-z0-9._:@-]{1,128}$/.test(entry.model)
      ) {
        throw invalidOption('fallbacks');
      }
      return Object.freeze({ model: entry.model });
    }),
  );
}

/**
 * Read `providerOptions.anthropic`. Unknown keys are refused, so a typo can
 * never silently drop an option. Throws `AiError('invalid_options')`.
 */
export function readAnthropicOptions(
  options: AiProviderOptions | undefined,
): AnthropicRequestExtras {
  const value: unknown = options?.anthropic;
  if (value === undefined) return { betas: [] };
  if (!isPlainObject(value)) throw invalidOption('anthropic');
  for (const key of Object.keys(value)) {
    if (!OPTION_KEYS.has(key)) throw invalidOption(key);
  }
  const { inferenceGeo, speed, userId, betas } = value;
  if (inferenceGeo !== undefined) {
    if (typeof inferenceGeo !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(inferenceGeo)) {
      throw invalidOption('inferenceGeo');
    }
  }
  if (speed !== undefined && speed !== 'fast') throw invalidOption('speed');
  if (userId !== undefined) {
    if (typeof userId !== 'string' || userId.length === 0 || userId.length > 256) {
      throw invalidOption('userId');
    }
  }
  const flags: string[] = [];
  if (betas !== undefined) {
    if (!Array.isArray(betas) || betas.length > 16) throw invalidOption('betas');
    for (const flag of betas as readonly unknown[]) {
      if (typeof flag !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,127}$/.test(flag)) {
        throw invalidOption('betas');
      }
      flags.push(flag);
    }
  }
  const fallbacks = readFallbacks(value.fallbacks);
  return {
    ...(inferenceGeo === undefined ? {} : { inferenceGeo }),
    ...(speed === undefined ? {} : { speed }),
    ...(userId === undefined ? {} : { userId }),
    ...(fallbacks === undefined ? {} : { fallbacks }),
    betas: Object.freeze(flags),
  };
}
