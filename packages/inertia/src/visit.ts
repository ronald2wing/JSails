/**
 * Request facts and the parsed Inertia v3 request headers.
 *
 * The protocol engine never reads a framework request object: it takes the
 * plain {@link InertiaRequestFacts} (method, URL, headers, abort signal) and
 * derives an {@link InertiaVisit} from the v3 request headers once. Header
 * lists are comma-separated; entries are trimmed and empty entries dropped.
 * A list header that is absent or empty reads as `null` (no filter), which is
 * how the reference adapter tells "no Data header" from "an empty one".
 * {@link requestFacts} derives the facts from a web-standard `Request`.
 */

/** The request data the Inertia engine depends on. */
export interface InertiaRequestFacts {
  /** The HTTP method, upper-case. */
  readonly method: string;
  /** The full request URL. */
  readonly url: URL;
  readonly headers: Headers;
  /** Aborted when the client goes away or the request deadline passes. */
  readonly signal: AbortSignal;
}

/** The partial-reload request, as sent by the client. */
export interface InertiaPartialRequest {
  /** `X-Inertia-Partial-Component`: the component the client is showing. */
  readonly component: string;
  /** `X-Inertia-Partial-Data`, or `null` when absent. */
  readonly only: readonly string[] | null;
  /** `X-Inertia-Partial-Except`, or `null` when absent. */
  readonly except: readonly string[] | null;
}

/** Every v3 request header the server half of the protocol reads. */
export interface InertiaVisit {
  /** `X-Inertia` is present: the client wants the JSON page object. */
  readonly isInertia: boolean;
  /** `X-Inertia-Version`, or `''` when absent (the reference comparison). */
  readonly version: string;
  /** The partial-reload headers, or `null` when no partial component was sent. */
  readonly partial: InertiaPartialRequest | null;
  /** `X-Inertia-Reset`: props whose merge state the client is resetting. */
  readonly reset: readonly string[];
  /** `X-Inertia-Except-Once-Props`: once-prop keys the client already holds. */
  readonly exceptOnce: readonly string[];
  /** `X-Inertia-Error-Bag`, or `null` when absent or empty. */
  readonly errorBag: string | null;
  /** `X-Inertia-Infinite-Scroll-Merge-Intent`: `prepend` or the default `append`. */
  readonly mergeIntent: 'append' | 'prepend';
  /** `Purpose: prefetch`: the response is cached and replayed by the client later. */
  readonly prefetch: boolean;
}

const inertiaHeaders = {
  inertia: 'X-Inertia',
  version: 'X-Inertia-Version',
  partialComponent: 'X-Inertia-Partial-Component',
  partialData: 'X-Inertia-Partial-Data',
  partialExcept: 'X-Inertia-Partial-Except',
  reset: 'X-Inertia-Reset',
  exceptOnceProps: 'X-Inertia-Except-Once-Props',
  errorBag: 'X-Inertia-Error-Bag',
  mergeIntent: 'X-Inertia-Infinite-Scroll-Merge-Intent',
  purpose: 'Purpose',
} as const;
/** The v3 request header names. */
export const INERTIA_HEADERS: typeof inertiaHeaders = Object.freeze(inertiaHeaders);

/**
 * The facts of a web-standard `Request`: its method upper-cased, its URL,
 * headers, and abort signal. The request body is not read.
 */
export function requestFacts(request: Request): InertiaRequestFacts {
  return Object.freeze({
    method: request.method.toUpperCase(),
    url: new URL(request.url),
    headers: request.headers,
    signal: request.signal,
  });
}

/** Parse the v3 request headers into an {@link InertiaVisit}. */
export function readInertiaVisit(headers: Headers): InertiaVisit {
  const component = headers.get(INERTIA_HEADERS.partialComponent);
  const errorBag = headers.get(INERTIA_HEADERS.errorBag)?.trim() ?? '';
  return Object.freeze({
    isInertia: headers.has(INERTIA_HEADERS.inertia),
    version: headers.get(INERTIA_HEADERS.version) ?? '',
    partial:
      component === null || component === ''
        ? null
        : Object.freeze({
            component,
            only: readList(headers, INERTIA_HEADERS.partialData),
            except: readList(headers, INERTIA_HEADERS.partialExcept),
          }),
    reset: readList(headers, INERTIA_HEADERS.reset) ?? [],
    exceptOnce: readList(headers, INERTIA_HEADERS.exceptOnceProps) ?? [],
    errorBag: errorBag === '' ? null : errorBag,
    mergeIntent: headers.get(INERTIA_HEADERS.mergeIntent) === 'prepend' ? 'prepend' : 'append',
    prefetch: headers.get(INERTIA_HEADERS.purpose)?.toLowerCase() === 'prefetch',
  });
}

/** A comma-separated header as a frozen list, or `null` when it names nothing. */
function readList(headers: Headers, name: string): readonly string[] | null {
  const value = headers.get(name);
  if (value === null) return null;
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return entries.length === 0 ? null : Object.freeze(entries);
}
