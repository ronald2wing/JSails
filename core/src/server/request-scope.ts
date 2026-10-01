/**
 * The ambient request id.
 *
 * `createApp` assigns every request an `X-Request-Id` (the inbound header when
 * it is well formed, otherwise a fresh id) and runs the rest of the pipeline
 * inside {@link withRequestId}. Any code on that async path — a logger, a job
 * dispatch, a diagnostics watcher — reads it with {@link currentRequestId}
 * instead of threading it through every call, so a user-reported id can be
 * matched to the log lines and jobs the request produced. A job dispatched
 * from a request carries the id, and the worker runs its handler under it, so
 * the id also reaches the job's own logs and nested dispatches. Outside both
 * the id is `undefined`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const requestIdStore = new AsyncLocalStorage<string>();

/**
 * The shape `createApp` accepts for an inbound `X-Request-Id` (Hono's
 * `requestId()` rule): word characters, `-` and `=`, at most 255 long. A value
 * read back from somewhere less trusted than the pipeline — a job's stored
 * options — is checked against it before it becomes ambient again.
 */
const REQUEST_ID_PATTERN = /^[\w\-=]{1,255}$/;

/** Whether `value` is a well-formed request id. */
export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

/** Run `fn` with `requestId` as the ambient request id for its whole async path. */
export function withRequestId<T>(requestId: string, fn: () => T): T {
  return requestIdStore.run(requestId, fn);
}

/**
 * Run `fn` with no ambient request id, whatever context the caller is in. A
 * queue that starts work from inside whichever call happened to drain it (the
 * in-memory adapter pumps from a dispatch or a finished job) would otherwise
 * hand that caller's id to unrelated work.
 */
export function withoutRequestId<T>(fn: () => T): T {
  return requestIdStore.exit(fn);
}

/** The id of the request whose async path this code runs on, or `undefined`. */
export function currentRequestId(): string | undefined {
  return requestIdStore.getStore();
}
