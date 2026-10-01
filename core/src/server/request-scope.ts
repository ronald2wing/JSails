/**
 * The ambient request id.
 *
 * `createApp` assigns every request an `X-Request-Id` (the inbound header when
 * it is well formed, otherwise a fresh id) and runs the rest of the pipeline
 * inside {@link withRequestId}. Any code on that async path — a logger, a job
 * dispatch, a diagnostics watcher — reads it with {@link currentRequestId}
 * instead of threading it through every call, so a user-reported id can be
 * matched to the log lines and jobs the request produced. Outside a request
 * the id is `undefined`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const requestIdStore = new AsyncLocalStorage<string>();

/** Run `fn` with `requestId` as the ambient request id for its whole async path. */
export function withRequestId<T>(requestId: string, fn: () => T): T {
  return requestIdStore.run(requestId, fn);
}

/** The id of the request whose async path this code runs on, or `undefined`. */
export function currentRequestId(): string | undefined {
  return requestIdStore.getStore();
}
