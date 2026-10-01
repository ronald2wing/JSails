/**
 * `data-jsails-intersect` observation, shared by component roots and client
 * islands.
 *
 * Each marked element fires its action once when it enters the viewport and is
 * then unobserved, so a scroll-off/scroll-back never re-dispatches: a retry
 * would duplicate side effects of idempotent handlers and do unbounded work for
 * the rest. Owners re-observe after each render to pick up new markup.
 */

import { INTERSECT_ATTRIBUTE } from '../../server-components/protocol.js';

/** The `IntersectionObserverEntry` members the observer callback reads. */
interface IntersectionObserverEntryLike<E> {
  readonly target: E;
  readonly isIntersecting: boolean;
}

/** The `IntersectionObserver` members the intersect directive uses. */
export interface IntersectionObserverLike<E> {
  observe(target: E): void;
  unobserve(target: E): void;
  disconnect(): void;
}

/** Builds an observer; injectable so Node tests need no browser global. */
export type IntersectionObserverFactory<E> = (
  callback: (entries: readonly IntersectionObserverEntryLike<E>[]) => void,
) => IntersectionObserverLike<E>;

interface IntersectTarget {
  getAttribute(name: string): string | null;
}

/** The injected factory, else the browser global, else `undefined`. */
function resolveFactory<E>(
  factory: IntersectionObserverFactory<E> | undefined,
): IntersectionObserverFactory<E> | undefined {
  if (factory !== undefined) {
    return factory;
  }
  const ctor = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  if (typeof ctor !== 'function') {
    return undefined;
  }
  const Observer = ctor as new (
    callback: (entries: readonly IntersectionObserverEntryLike<E>[]) => void,
  ) => IntersectionObserverLike<E>;
  return (callback) => new Observer(callback);
}

/**
 * Observe `elements` and call `onIntersect` once per element with its action.
 * Returns the observer to disconnect later, or `null` when there is nothing to
 * observe or no observer implementation (Node without injection): the
 * directive is then a no-op rather than an error.
 */
export function observeIntersections<E extends IntersectTarget>(
  elements: readonly E[],
  onIntersect: (element: E, action: string) => void,
  factory?: IntersectionObserverFactory<E>,
): IntersectionObserverLike<E> | null {
  if (elements.length === 0) {
    return null;
  }
  const create = resolveFactory(factory);
  if (create === undefined) {
    return null;
  }
  const observer = create((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        continue;
      }
      const element = entry.target;
      const action = element.getAttribute(INTERSECT_ATTRIBUTE);
      if (action === null || action === '') {
        continue;
      }
      try {
        onIntersect(element, action);
      } finally {
        observer.unobserve(element);
      }
    }
  });
  for (const element of elements) {
    observer.observe(element);
  }
  return observer;
}
