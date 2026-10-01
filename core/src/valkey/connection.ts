/**
 * Valkey URL and key-prefix validation shared by the connection provider and
 * its consumers.
 *
 * A leaf module in the plugin-sdk seam: it imports only `firstConfigured`, so
 * it is safe to import from any plugin without pulling in the jobs runtime or
 * the BullMQ adapters. The connection URL is never echoed in an error message
 * because a URL may embed credentials.
 */

import { firstConfigured } from '../support/first-configured.js';

/** Turns a validation message into a module-specific error. */
export type ConnectionUrlErrorFactory = (message: string) => Error;

/**
 * Validate a connection URL is an explicit `redis://` or `rediss://` URL and
 * return it unchanged. Throws via `makeError` on failure; the value is never
 * included in the error message because it may embed a password.
 */
export function assertConnectionUrl(value: unknown, makeError: ConnectionUrlErrorFactory): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw makeError('the Valkey connection URL must be a non-empty redis:// or rediss:// URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw makeError('the Valkey connection URL must be a valid redis:// or rediss:// URL');
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw makeError('the Valkey connection URL must use the redis:// or rediss:// scheme');
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
  env: Readonly<Record<string, string | undefined>>,
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
