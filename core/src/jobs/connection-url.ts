/**
 * Valkey/Redis connection-URL validation.
 *
 * A leaf module: it imports nothing from the jobs runtime, so both
 * `runtime-config.ts` (which owns the CLI config contract) and
 * `bullmq-adapter.ts` (which must stay importable without pulling in the
 * config loader) can share one implementation. The caller supplies the error
 * factory because each surface throws its own error class.
 *
 * The value is never included in the error message: a URL may embed a password.
 */

/** Turns a validation message into a module-specific error. */
export type ConnectionUrlErrorFactory = (message: string) => Error;

/**
 * Validate a connection URL is an explicit `redis://` or `rediss://` URL and
 * return it unchanged. Throws via `makeError` on failure.
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
