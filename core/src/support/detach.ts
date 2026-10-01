/**
 * The one sanctioned way to start a promise without awaiting it. A dependency-free
 * leaf: lint rejects `void promise` and floating promises in every `src/`, so
 * fire-and-forget work goes through `detach`, which always names where a
 * rejection goes.
 */

/**
 * Lets `promise` run without awaiting it and hands a rejection to `report`.
 *
 * There is deliberately no variant without a reporter: a rejection nobody
 * observes is how background work fails silently. `report` runs at most once;
 * if it throws, that error surfaces as an unhandled rejection rather than being
 * swallowed. A non-promise value (a callback typed `void | Promise<void>` that
 * returned synchronously) is accepted and ignored.
 */
export function detach(
  promise: PromiseLike<unknown> | void,
  report: (error: unknown) => void,
): void {
  Promise.resolve(promise).then(undefined, report);
}

/**
 * The reporter for a promise that handles its own failures and so must never
 * reject: it re-raises the rejection as an unhandled rejection, which is exactly
 * what an un-awaited promise did, so a broken invariant stays loud. A caller
 * with a real error channel passes that instead.
 */
export function escalate(error: unknown): never {
  throw error;
}
