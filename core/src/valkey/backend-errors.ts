/**
 * Backend-error reporting shared by the Valkey connection provider and every
 * consumer of its clients (the broadcast adapter, the cache and lease stores,
 * the live change log and bus).
 *
 * All of them talk to the same Redis-compatible backend and must obey the
 * same rules: never echo the connection URL (it may embed credentials), and
 * never let a throwing or rejecting observer become an unhandled rejection.
 *
 * The caller supplies the error factory so each surface keeps its own error
 * class and message prefix.
 */

import { errnoCode } from '../errors/inspect.js';

/** Turns a sanitized message and errno code into a module-specific error. */
export type BackendErrorFactory = (message: string, code: string | undefined) => Error;

/**
 * Reduce a backend error to a payload-free error. The `label` prefixes the
 * message (e.g. `"cache"`, `"Redis broadcast adapter"`); an extractable errno
 * code is appended and forwarded to the factory.
 */
export function sanitizeBackendError(
  error: unknown,
  label: string,
  makeError: BackendErrorFactory,
): Error {
  const code = errnoCode(error);
  const message = code === undefined ? `${label} error` : `${label} error (${code})`;
  return makeError(message, code);
}

/**
 * Surface a post-connect backend error to `onError`, falling back to a generic
 * warning. The observer is guarded so a throwing or rejecting handler never
 * becomes an unhandled rejection that could crash the process.
 */
export function reportBackendError(
  error: unknown,
  onError: ((error: Error) => void) | undefined,
  label: string,
  makeError: BackendErrorFactory,
): void {
  const sanitized = sanitizeBackendError(error, label, makeError);
  if (onError === undefined) {
    process.emitWarning(sanitized);
    return;
  }
  try {
    Promise.resolve(onError(sanitized)).catch(() => {
      // A rejecting observer must never surface as an unhandled rejection.
    });
  } catch {
    // A throwing observer is ignored; it must not take down the server.
  }
}
