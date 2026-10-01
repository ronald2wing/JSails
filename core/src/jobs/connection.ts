/**
 * Error routing and naming defaults for BullMQ producers and workers.
 *
 * Connections come from the app's Valkey provider (`core/src/valkey`), which
 * owns every connection policy; this module only names the defaults and routes
 * errors.
 *
 * Error surfacing is non-silent by design. BullMQ re-emits backend errors on
 * its `Queue`/`Worker` `'error'` event, but drops them when no listener is
 * attached. Every queue/worker created by this library therefore gets an
 * `'error'` listener that routes to the caller's `onError` callback, or to a
 * default logger that prints `name: message` — never a job payload.
 *
 * The default queue key prefix is the app key prefix, so a producer and a
 * worker of the same app and environment share it when neither names one.
 */

export { defaultAppPrefix as defaultQueuePrefix } from '../valkey/app-prefix.js';

/** Default queue name when none is supplied. */
export const DEFAULT_QUEUE_NAME = 'default';

/** Key prefix of a runtime constructed directly without one (BullMQ's own default). */
export const DEFAULT_PREFIX = 'bull';

/** Receives connection and processing errors surfaced by a queue or worker. */
export type JobErrorHandler = (error: Error) => void;

/**
 * Default payload-free error logger used when the caller omits `onError`.
 * Logs only the error class and message; it never logs a job's data, so
 * payloads (which may carry secrets) cannot leak into logs.
 */
export function defaultErrorLogger(component: string, name: string): JobErrorHandler {
  return (error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`[jsails:jobs] ${component} "${name}" error: ${err.name}: ${err.message}`);
  };
}

/**
 * Attach an `'error'` listener that routes to `onError` or, when absent, to
 * `fallback`. This guarantees a queue/worker never emits an unhandled Redis
 * error even when the caller forgets to pass `onError`.
 */
export function attachErrorHandler(
  target: { on(eventName: 'error', listener: (error: Error) => void): unknown },
  onError: JobErrorHandler | undefined,
  fallback: JobErrorHandler,
): void {
  target.on('error', (error) => {
    (onError ?? fallback)(error);
  });
}
