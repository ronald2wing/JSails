/**
 * Shared Valkey/Redis connection primitives for plugins that talk to the same
 * Redis-compatible backend: the cache/mutex stores, the live change log and
 * bus, and the jobs runtime.
 *
 * A leaf module in the plugin-sdk seam: it imports only `firstConfigured`, so
 * it is safe to import from any plugin without pulling in the jobs runtime or
 * the BullMQ adapters. The connection URL is never echoed in an error message
 * because a URL may embed credentials.
 */

import { firstConfigured } from './value-selection.js';

/**
 * Command-retry budget for Valkey/Redis connections. Commands that exhaust this
 * budget reject immediately, so a web-facing consumer fails fast instead of
 * retrying a command indefinitely.
 *
 * Note: workers that blocking-pop keep `null` (retry forever) — that is shaped
 * by the jobs runtime's own `buildConnectionOptions`, not this constant.
 */
export const VALKEY_MAX_RETRIES = 3;

/** Turns a validation message into a module-specific error. */
export type ConnectionUrlErrorFactory = (message: string) => Error;

/**
 * Validate a connection URL is an explicit `redis://` or `rediss://` URL and
 * return it unchanged. Throws via `makeError` on failure; the value is never
 * included in the error message because it may embed a password.
 */
export function assertConnectionUrl(value: unknown, makeError: ConnectionUrlErrorFactory): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw makeError(
      'the Valkey/Redis connection URL must be a non-empty redis:// or rediss:// URL',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw makeError('the Valkey/Redis connection URL must be a valid redis:// or rediss:// URL');
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw makeError('the Valkey/Redis connection URL must use the redis:// or rediss:// scheme');
  }
  return value;
}

/**
 * Resolve the connection URL from `options.valkeyUrl` then `VALKEY_URL`,
 * skipping empty values. Returns `undefined` when nothing is configured.
 *
 * This performs NO URL validation — call {@link assertConnectionUrl} separately.
 * It never echoes the resolved value.
 */
export function resolveValkeyUrl(
  options: { valkeyUrl?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return firstConfigured(
    typeof options.valkeyUrl === 'string' ? options.valkeyUrl : undefined,
    env.VALKEY_URL,
  );
}

/**
 * Resolve a Valkey key prefix. When `value` is `undefined` the `fallback` is
 * returned; a non-empty string is returned verbatim; anything else throws
 * `TypeError`.
 */
export function resolveValkeyPrefix(value: unknown, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('prefix must be a non-empty string');
  }
  return value;
}

/**
 * Load the real ioredis `Redis` class lazily, so importing modules that only
 * type against a narrow client slice never pays for ioredis at load time. The
 * returned constructor takes a URL and options; the caller supplies its own
 * client-slice type because the plugin seams are deliberately narrower than
 * ioredis.
 */
export async function loadIoredis<TClient>(): Promise<
  new (url: string, options: object) => TClient
> {
  const { Redis } = await import('ioredis');
  return Redis as unknown as new (url: string, options: object) => TClient;
}
