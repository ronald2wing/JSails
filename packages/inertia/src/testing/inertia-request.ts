/**
 * Build the request an official Inertia v3 client would send.
 *
 * {@link inertiaRequest} returns a web-standard `Request` carrying
 * `X-Inertia: true` and the v3 request headers a test names: the asset
 * version, a partial reload (component, `only`, `except`, `reset`), the error
 * bag, the once props the client holds, the infinite-scroll merge intent,
 * `Purpose: prefetch`, and Precognition with its validate-only fields. A
 * relative URL resolves against {@link INERTIA_TEST_ORIGIN}.
 *
 * Header names and values are the ones the client sends (@inertiajs/core
 * 3.11.0, `RequestParams.headers`): a partial reload sends
 * `X-Inertia-Partial-Component` only when one of `only`, `except`, or `reset`
 * is non-empty, and `X-Inertia-Partial-Data` lists `only` followed by
 * `reset`, because a reset prop must also be selected to be resolved again.
 * Values are validated so a test cannot build a request the client never
 * would (a comma inside a prop name, an empty component).
 */

import { InertiaError } from '../inertia-error.js';
import { isPlainObject } from '../plain-data.js';
import { PRECOGNITION_HEADERS } from '../precognition.js';
import { INERTIA_HEADERS } from '../visit.js';

/** The origin a relative test URL resolves against. */
export const INERTIA_TEST_ORIGIN = 'http://localhost';

/** A partial reload, as `router.reload({ only, except, reset })` sends it. */
export interface InertiaPartialInit {
  /** The component the client is showing (`X-Inertia-Partial-Component`). */
  readonly component: string;
  readonly only?: readonly string[];
  readonly except?: readonly string[];
  readonly reset?: readonly string[];
}

/** `RequestInit` plus the Inertia request headers. */
export interface InertiaRequestInit extends RequestInit {
  /** `X-Inertia-Version`; omitted when not given, which the server reads as `''`. */
  readonly version?: string;
  readonly partial?: InertiaPartialInit;
  /** `X-Inertia-Error-Bag`. */
  readonly errorBag?: string;
  /** `X-Inertia-Except-Once-Props`: the once keys the client already holds. */
  readonly exceptOnce?: readonly string[];
  /**
   * `X-Inertia-Infinite-Scroll-Merge-Intent`, which `<InfiniteScroll>` sends
   * when it loads the next (`append`) or previous (`prepend`) page.
   */
  readonly mergeIntent?: 'append' | 'prepend';
  /** Send `Purpose: prefetch`. */
  readonly prefetch?: boolean;
  /** Send `Precognition: true`, with `Precognition-Validate-Only` when fields are named. */
  readonly precognition?: { readonly validateOnly?: readonly string[] };
}

/** A `Request` as an Inertia v3 client sends it for `url`. */
export function inertiaRequest(url: string | URL, init: InertiaRequestInit = {}): Request {
  assertPlain(init);
  const {
    version,
    partial,
    errorBag,
    exceptOnce,
    mergeIntent,
    prefetch,
    precognition,
    ...requestInit
  } = init;
  const headers = new Headers(requestInit.headers);
  headers.set(INERTIA_HEADERS.inertia, 'true');
  headers.set('X-Requested-With', 'XMLHttpRequest');
  headers.set('Accept', 'text/html, application/xhtml+xml');
  if (version !== undefined) headers.set(INERTIA_HEADERS.version, headerValue(version));
  if (partial !== undefined) {
    assertPlain(partial);
    const component = headerValue(partial.component);
    if (component.trim() === '') throw new InertiaError('invalid_options');
    const only = listEntries(partial.only);
    const except = listEntries(partial.except);
    const reset = listEntries(partial.reset);
    if (only.length + except.length + reset.length > 0) {
      headers.set(INERTIA_HEADERS.partialComponent, component);
    }
    setList(headers, INERTIA_HEADERS.partialData, [...only, ...reset]);
    setList(headers, INERTIA_HEADERS.partialExcept, except);
    setList(headers, INERTIA_HEADERS.reset, reset);
  }
  if (errorBag !== undefined) headers.set(INERTIA_HEADERS.errorBag, headerValue(errorBag));
  setList(headers, INERTIA_HEADERS.exceptOnceProps, exceptOnce);
  if (mergeIntent !== undefined) {
    if (mergeIntent !== 'append' && mergeIntent !== 'prepend') {
      throw new InertiaError('invalid_options');
    }
    headers.set(INERTIA_HEADERS.mergeIntent, mergeIntent);
  }
  if (prefetch !== undefined && typeof prefetch !== 'boolean') {
    throw new InertiaError('invalid_options');
  }
  if (prefetch === true) headers.set(INERTIA_HEADERS.purpose, 'prefetch');
  if (precognition !== undefined) {
    assertPlain(precognition);
    headers.set(PRECOGNITION_HEADERS.precognition, 'true');
    setList(headers, PRECOGNITION_HEADERS.validateOnly, precognition.validateOnly);
  }
  return new Request(new URL(url, INERTIA_TEST_ORIGIN), { ...requestInit, headers });
}

/** Reject options that are not a plain object, without narrowing their declared type. */
function assertPlain(value: unknown): void {
  if (!isPlainObject(value)) throw new InertiaError('invalid_options');
}

function headerValue(value: unknown): string {
  if (typeof value !== 'string' || /[\r\n\0]/u.test(value)) {
    throw new InertiaError('invalid_options');
  }
  return value;
}

/** Set a comma-separated list header; an absent or empty list sends nothing. */
function setList(headers: Headers, name: string, list: readonly string[] | undefined): void {
  const entries = listEntries(list);
  if (entries.length > 0) headers.set(name, entries.join(','));
}

/** The validated entries of a list option; absent is empty. */
function listEntries(list: readonly string[] | undefined): readonly string[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new InertiaError('invalid_options');
  return list.map((entry: unknown) => {
    const value = headerValue(entry);
    if (value.includes(',') || value.trim() === '') throw new InertiaError('invalid_options');
    return value;
  });
}
