/**
 * A resource created on first use and released at most once.
 *
 * `createLazyResource` memoizes a single in-flight creation so concurrent
 * callers share one resource, retries after a failed creation, and refuses to
 * create anything once `close` has been called. Teardown goes through
 * {@link createCleanup}, so concurrent and repeated `close` calls share exactly
 * one release; a creation still in flight at close time is awaited and then
 * released rather than leaked.
 *
 * Dependency-free (no Node imports). The public surface is `jsails/plugin-sdk`.
 */

import { JsailsError } from '../errors/jsails-error.js';
import { createCleanup } from './cleanup.js';

/** The only failure a lazy resource raises itself: use after `close`. */
export type LazyResourceErrorCode = 'closed';

/** Raised by `get` once the resource has been closed. */
export class LazyResourceError extends JsailsError {
  constructor(
    readonly code: LazyResourceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** How to create and release the resource. */
export interface LazyResourceOptions<T> {
  /** Create the resource; runs on the first `get` and again after a failure. */
  readonly create: () => T | Promise<T>;
  /** Release a successfully created resource; runs at most once. */
  readonly close: (resource: T) => void | Promise<void>;
}

/** A lazily created, close-once resource handle. */
export interface LazyResource<T> {
  /** Whether `close` has been called; `get` rejects from then on. */
  readonly closed: boolean;
  /**
   * The resource, creating it on first call. Concurrent callers share the
   * pending creation; a rejected creation is not memoized, so the next call
   * retries. Rejects with {@link LazyResourceError} (`closed`) after `close`.
   */
  get(): Promise<T>;
  /** Release the resource. Idempotent, concurrent-safe, a no-op when never created. */
  close(): Promise<void>;
}

/** Outcome of an awaited creation, so teardown can skip a failed one. */
type Settled<T> = { readonly created: true; readonly resource: T } | { readonly created: false };

export function createLazyResource<T>(options: LazyResourceOptions<T>): LazyResource<T> {
  let pending: Promise<T> | undefined;
  let closed = false;

  const release = createCleanup(async () => {
    const creating = pending;
    pending = undefined;
    if (creating === undefined) {
      return;
    }
    const settled = await creating.then(
      (resource): Settled<T> => ({ created: true, resource }),
      (): Settled<T> => ({ created: false }),
    );
    if (settled.created) {
      await options.close(settled.resource);
    }
  });

  return {
    get closed() {
      return closed;
    },
    get() {
      if (closed) {
        return Promise.reject(new LazyResourceError('closed', 'the resource is closed'));
      }
      if (pending !== undefined) {
        return pending;
      }
      // Assign synchronously so two callers in the same tick share one
      // creation. A synchronous throw from `create` becomes a rejection, and a
      // rejection clears the slot so a later `get` retries instead of
      // replaying the same failure.
      let creating: Promise<T>;
      try {
        creating = Promise.resolve(options.create());
      } catch (error: unknown) {
        creating = Promise.reject(error);
      }
      pending = creating;
      void creating.catch(() => {
        if (pending === creating) {
          pending = undefined;
        }
      });
      return creating;
    },
    close() {
      closed = true;
      return release();
    },
  };
}
