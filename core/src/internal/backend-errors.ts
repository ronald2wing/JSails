/**
 * Backend-error reporting shared by the Redis broadcast adapter and the Valkey
 * cache/mutex stores.
 *
 * Both surfaces talk to the same Redis-compatible backend and must obey the
 * same rules: never echo the connection URL (it may embed credentials), never
 * let a throwing or rejecting observer become an unhandled rejection, and
 * always complete teardown even when the backend is already unreachable.
 *
 * The caller supplies the error factory so each surface keeps its own error
 * class and message prefix.
 */

import { errnoCode } from '../internal/errors.js';

/** The slice of a Redis-compatible client the teardown helper needs. */
export interface DisconnectableClient {
  disconnect(): Promise<unknown>;
}

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
    void Promise.resolve(onError(sanitized)).catch(() => {
      // A rejecting observer must never surface as an unhandled rejection.
    });
  } catch {
    // A throwing observer is ignored; it must not take down the server.
  }
}

/** Best-effort disconnect used on the failure path; the primary error wins. */
export function disconnectQuietly(client: DisconnectableClient | undefined): void {
  if (client === undefined) {
    return;
  }
  try {
    void client.disconnect().catch(() => {
      // Teardown on the error path is best-effort.
    });
  } catch {
    // A synchronous disconnect failure is irrelevant to the reported error.
  }
}
