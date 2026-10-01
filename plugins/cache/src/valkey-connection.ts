/**
 * Cache-local Valkey backend-error surfacing, layered on the shared
 * plugin-sdk connection primitives.
 *
 * The connection-resolution, prefix, and URL-assertion helpers now live in
 * `jsails/plugin-sdk` (`valkey-connection.js` there); this module keeps only
 * the error sanitization/reporting wrappers that name the cache/mutex backend,
 * plus the `disconnectQuietly` re-export the stores use during teardown.
 */

import { reportBackendError, sanitizeBackendError } from 'jsails/plugin-sdk';

/**
 * Reduce a backend error to a payload-free error via the injected factory.
 * The `label` is used as the error-message prefix (e.g. `"cache"` or
 * `"mutex"`). When an errno code is extractable it is appended to the
 * message and forwarded to the factory.
 */
export function sanitizeValkeyError(
  error: unknown,
  label: string,
  makeError: (message: string, code: string | undefined) => Error,
): Error {
  return sanitizeBackendError(error, `${label} backend`, makeError);
}

/**
 * Surface a post-connect backend error to `onError`, falling back to a
 * generic warning. The observer is guarded so a throwing or rejecting
 * handler never becomes an unhandled rejection that could crash the process.
 */
export function reportValkeyError(
  error: unknown,
  onError: ((error: Error) => void) | undefined,
  label: string,
  makeError: (message: string, code: string | undefined) => Error,
): void {
  reportBackendError(error, onError, `${label} backend`, makeError);
}
