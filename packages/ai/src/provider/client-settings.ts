/**
 * Credential and transport settings shared by the first-party adapters, and
 * the helper that drains a provider stream into its final response.
 *
 * An adapter is given exactly one of an explicit `apiKey` (it then builds the
 * official SDK client itself) or a ready `client` (an official platform
 * client such as Bedrock, Vertex, or Foundry, or any object of the same
 * shape). Nothing is read from the environment or a credential profile: the
 * adapter passes the SDK an explicit base URL and turns off the SDK's own
 * logging and tracing, so neither an ambient variable nor an SDK log line can
 * redirect a request or record a prompt. Transport settings (`baseURL`,
 * `maxRetries`, `timeoutMs`, `fetch`) configure the client the adapter
 * builds, so they are refused next to an injected client.
 */

import { AiError } from '../errors/ai-error.js';
import { isPlainObject } from '../content/json-value.js';
import { MAX_TIMER_MS } from './request-fields.js';
import type { AiProviderResponse, AiProviderStreamPart } from './contract.js';

/** The transport settings both adapters accept. */
export interface ClientSettingsInput {
  readonly apiKey?: unknown;
  readonly client?: unknown;
  readonly baseURL?: unknown;
  readonly maxRetries?: unknown;
  readonly timeoutMs?: unknown;
  readonly fetch?: unknown;
}

/** Validated settings for the client an adapter builds from an API key. */
export interface OwnedClientSettings {
  readonly kind: 'owned';
  readonly apiKey: string;
  readonly baseURL: string;
  readonly maxRetries: number;
  readonly timeoutMs: number | undefined;
  readonly fetch: typeof globalThis.fetch | undefined;
}

/** An injected client, checked only for the methods the adapter calls. */
export interface InjectedClientSettings<T> {
  readonly kind: 'injected';
  readonly client: T;
}

/** The largest retry count accepted. */
const MAX_RETRIES = 10;

/** Hosts a plain-HTTP base URL may name: a local server only. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The value-free settings error. */
export function invalidSettings(provider: string, field: string): AiError {
  return new AiError('invalid_options', 'the provider settings are invalid', {
    context: { provider, field },
  });
}

/** A base URL: `https:`, or `http:` to a loopback host; no credentials in it. */
export function readBaseUrl(value: unknown, fallback: string, provider: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw invalidSettings(provider, 'baseURL');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidSettings(provider, 'baseURL');
  }
  const secure = url.protocol === 'https:';
  const local = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if ((!secure && !local) || url.username !== '' || url.password !== '') {
    throw invalidSettings(provider, 'baseURL');
  }
  return value;
}

/**
 * Read the credential and transport settings. `isClient` checks an injected
 * client's shape. Throws `AiError('invalid_options')` naming only the field.
 */
export function readClientSettings<T>(
  settings: ClientSettingsInput,
  provider: string,
  defaultBaseUrl: string,
  isClient: (value: unknown) => value is T,
): OwnedClientSettings | InjectedClientSettings<T> {
  if (!isPlainObject(settings)) throw invalidSettings(provider, 'settings');
  if (settings.client !== undefined) {
    if (settings.apiKey !== undefined) throw invalidSettings(provider, 'apiKey');
    for (const field of ['baseURL', 'maxRetries', 'timeoutMs', 'fetch'] as const) {
      if (settings[field] !== undefined) throw invalidSettings(provider, field);
    }
    if (!isClient(settings.client)) throw invalidSettings(provider, 'client');
    return { kind: 'injected', client: settings.client };
  }
  const apiKey = settings.apiKey;
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0 || apiKey.length > 4096) {
    throw new AiError('invalid_options', 'the provider needs an explicit apiKey or client', {
      context: { provider, field: 'apiKey' },
      suggestion: 'Pass apiKey (read from your secret store) or a configured SDK client.',
    });
  }
  const maxRetries = settings.maxRetries ?? 2;
  if (
    typeof maxRetries !== 'number' ||
    !Number.isSafeInteger(maxRetries) ||
    maxRetries < 0 ||
    maxRetries > MAX_RETRIES
  ) {
    throw invalidSettings(provider, 'maxRetries');
  }
  const timeoutMs = settings.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > MAX_TIMER_MS)
  ) {
    throw invalidSettings(provider, 'timeoutMs');
  }
  const fetchImpl = settings.fetch;
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') {
    throw invalidSettings(provider, 'fetch');
  }
  return {
    kind: 'owned',
    apiKey,
    baseURL: readBaseUrl(settings.baseURL, defaultBaseUrl, provider),
    maxRetries,
    timeoutMs,
    fetch: fetchImpl as typeof globalThis.fetch | undefined,
  };
}

/** Whether `value` has a callable at `path` (for example `['messages', 'create']`). */
export function hasMethod(value: unknown, path: readonly string[]): boolean {
  let target: unknown = value;
  for (const key of path.slice(0, -1)) {
    if (typeof target !== 'object' || target === null) return false;
    target = (target as Record<string, unknown>)[key];
  }
  const last = path.at(-1);
  if (last === undefined || typeof target !== 'object' || target === null) return false;
  return typeof (target as Record<string, unknown>)[last] === 'function';
}

/**
 * Drain a provider stream and return its final response, for an adapter's
 * `generate`: one streaming path serves both, so long generations never hit a
 * non-streaming request timeout.
 */
export async function collectResponse(
  parts: AsyncIterable<AiProviderStreamPart>,
): Promise<AiProviderResponse> {
  let response: AiProviderResponse | undefined;
  for await (const part of parts) {
    if (part.type === 'response-end') response = part.response;
  }
  if (response === undefined) {
    throw new AiError('provider_failed', 'the provider returned a malformed response', {
      context: { reason: 'no_response_end' },
    });
  }
  return response;
}
