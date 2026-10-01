/**
 * Async polling and event-loop yield helpers (`jsails/testing`).
 *
 * {@link waitFor} polls a synchronous or asynchronous predicate until it reports
 * truthy, yielding the event loop between attempts so in-process async work
 * (sockets, watchers, jobs) can settle. {@link tick} is the bare yield: a single
 * `setTimeout(resolve, 0)` that lets one macrotask queue drain before the caller
 * continues.
 */

import { setTimeout } from 'node:timers/promises';

/** Options for {@link waitFor}. */
export interface WaitForOptions {
  /** Total budget before giving up. Defaults to `3000`. */
  readonly timeoutMs?: number;
  /** Delay between attempts. Defaults to `5`. */
  readonly intervalMs?: number;
  /** What was being waited on; shown in the timeout error. */
  readonly label?: string;
}

/** Thrown by {@link waitFor} when the predicate never reports truthy in budget. */
export class WaitForTimeoutError extends Error {
  /** The elapsed budget that was exhausted. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number, label: string | undefined) {
    super(
      label === undefined
        ? `timed out after ${timeoutMs}ms waiting for condition`
        : `timed out after ${timeoutMs}ms waiting for ${label}`,
    );
    this.name = 'WaitForTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Poll `predicate` until it reports truthy, yielding the event loop between
 * attempts. Rejects with {@link WaitForTimeoutError} when `timeoutMs` (default
 * `3000`) elapses first. The predicate may be synchronous or async; it is
 * awaited on every attempt so a promise-based condition is supported.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: WaitForOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const intervalMs = options.intervalMs ?? 5;
  const deadline = Date.now() + timeoutMs;

  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new WaitForTimeoutError(timeoutMs, options.label);
    }
    await setTimeout(intervalMs);
  }
}

/**
 * Let one macrotask queue drain: resolves on the next timer/immediate tick.
 * Use it to let fire-and-forget async work (setImmediate, setTimeout, socket
 * callbacks) settle before asserting on the observable result.
 */
export function tick(): Promise<void> {
  return setTimeout(0);
}
