/**
 * Handler deadlines: how long a route has to answer.
 *
 * A route's deadline is its `timeoutMs`, else the app's `handlerTimeoutMs`
 * (config `server.handlerTimeoutMs`, 30 seconds by default; `0` disables
 * it). It is armed when the request enters the route and covers everything
 * up to the returned response: the rate-limit hook, the claim, the access
 * gate, the middleware, the handler and the transforms. When it passes, the
 * frame's signal aborts (a handler passing it to its own I/O stops), the
 * expiry is reported with phase `timeout`, and the request is answered 504;
 * whatever the route produces afterwards is discarded (a response's body is
 * cancelled) and a later rejection is reported with phase `timeout`.
 *
 * A streamed answer is past its deadline once it is returned; a route that
 * declares `stream.timeoutMs` bounds the gap between two chunks instead
 * (`output.ts`). A live stream has no idle bound and ends on drain.
 */

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import { detach } from '../support/detach.js';

const DEADLINE_ERRORS = {
  handler_timeout: {
    kind: 'timeout',
    message: 'the route did not answer within its deadline of {timeoutMs} ms',
    context: { timeoutMs: 'count' },
    suggestion:
      'pass ctx.signal to the work the handler waits on, move long work to a job, or declare a larger timeoutMs on the route',
  },
  stream_idle: {
    kind: 'timeout',
    message: 'a streamed response produced no chunk within {timeoutMs} ms',
    context: { timeoutMs: 'count' },
    suggestion: "raise the route's stream.timeoutMs, or send a chunk more often",
  },
} as const;

/**
 * The deadline codes, `deadline.*`: a route that did not answer within its
 * deadline (504), and a streamed answer idle past its `stream.timeoutMs`.
 * Both are operator errors: the caller sees the status only.
 *
 * @public
 */
export const DeadlineErrors: ErrorRegistry<'deadline', typeof DEADLINE_ERRORS> = defineErrors(
  'deadline',
  DEADLINE_ERRORS,
);

/** What a deadline's `expired` promise resolves to. */
const EXPIRED: unique symbol = Symbol('expired');

/** One armed deadline. */
export interface Deadline {
  /** The error the expiry is answered and reported with; also the abort reason. */
  readonly error: Error;
  /** Whether the deadline has passed. */
  readonly fired: boolean;
  /** Resolves when the deadline passes; never rejects. */
  readonly expired: Promise<typeof EXPIRED>;
  /** Stop the timer: the route answered. */
  clear(): void;
}

/**
 * Arm a deadline of `timeoutMs` milliseconds that aborts `controller` when it
 * passes. The timer does not hold the process open.
 */
export function startDeadline(timeoutMs: number, controller: AbortController): Deadline {
  const error = new DeadlineErrors.Error('handler_timeout', { timeoutMs });
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    timer = setTimeout(() => {
      fired = true;
      controller.abort(error);
      resolve(EXPIRED);
    }, timeoutMs);
    timer.unref?.();
  });
  return {
    error,
    get fired() {
      return fired;
    },
    expired,
    clear() {
      clearTimeout(timer);
    },
  };
}

/** What happens to work that settles after its deadline passed. */
export interface LateOutcome {
  /** A late rejection (never the deadline's own error). */
  rejected(error: unknown): void;
}

/**
 * `work`, or the deadline's error once `deadline` passes first. Work that
 * settles after that is handed to `late`: a `Response` has its body
 * cancelled, a rejection other than the deadline's own error is passed on.
 */
export async function withinDeadline<T>(
  deadline: Deadline | undefined,
  work: Promise<T>,
  late: LateOutcome,
): Promise<T> {
  if (deadline === undefined) return work;
  if (!deadline.fired) {
    const outcome = await Promise.race([
      work.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      ),
      deadline.expired,
    ]);
    if (outcome !== EXPIRED) {
      if ('error' in outcome) throw outcome.error;
      return outcome.value;
    }
  }
  detach(
    work.then(discardResponse, (error: unknown) => {
      if (error !== deadline.error) late.rejected(error);
    }),
    late.rejected,
  );
  throw deadline.error;
}

/**
 * Release what an answer that is never sent holds: a response's unread body.
 * Anything else is left alone.
 */
export function discardResponse(value: unknown): void {
  // Either Response class a listening process holds (see route-boundary.ts).
  if (
    !(value instanceof Response) &&
    Object.prototype.toString.call(value) !== '[object Response]'
  ) {
    return;
  }
  const response = value as Response;
  if (response.body === null || response.bodyUsed) return;
  // Nothing reads the discarded body; a failing cancel has no one to tell.
  response.body.cancel().catch(() => undefined);
}

/** Whether `error` is a deadline's expiry. */
export function isDeadlineExpiry(error: unknown): boolean {
  return DeadlineErrors.is(error, 'handler_timeout');
}
