/**
 * Redirect rules and the `409` control responses (v3 protocol: Asset
 * Versioning, Redirects).
 *
 * An Inertia visit is an XHR, which follows redirects on its own, so the
 * server decides how each redirect reaches the client:
 *
 * - a `302` after `PUT`, `PATCH`, `DELETE`, or `QUERY` becomes `303`, so the
 *   browser follows it with `GET`;
 * - an off-origin target becomes `409` with `X-Inertia-Location`, and the
 *   client makes a full page visit (an XHR cannot follow it across origins);
 * - a same-origin target with a fragment becomes `409` with
 *   `X-Inertia-Redirect`, and the client makes a new Inertia visit that keeps
 *   the fragment; prefetch requests receive the redirect unchanged.
 *
 * A non-Inertia request gets every redirect unchanged. Control responses
 * carry no `X-Inertia` and no body, are never stored, and vary on the
 * Inertia request headers like every other answer.
 *
 * {@link sameOriginPath} is the redirect-target check, and it is the
 * framework's own (`isSameOriginPath` and `safeRedirectPath` from
 * `jsails/api`, the rule `Respond.redirect` and a page's `reply.redirect`
 * apply): a root-relative path with no scheme, authority, backslash, control
 * character, or `..` segment, which resolves against any request URL to the
 * same origin, returned with every character outside visible ASCII
 * percent-encoded for the header (`/café` becomes `/caf%C3%A9`).
 */

import { isSameOriginPath, safeRedirectPath } from 'jsails/api';

import { InertiaError } from './inertia-error.js';
import type { InertiaControlOutcome } from './outcome.js';
import { appendVary, headerList, INERTIA_VARY } from './response-headers.js';
import type { InertiaRequestFacts, InertiaVisit } from './visit.js';

const controlHeaders = {
  location: 'X-Inertia-Location',
  redirect: 'X-Inertia-Redirect',
  version: 'X-Inertia-Version',
} as const;
/** The `409` response header names. */
export const CONTROL_HEADERS: typeof controlHeaders = Object.freeze(controlHeaders);

/** The redirect statuses the rules apply to. */
export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Methods after which a `302` becomes a `303`. */
const SEE_OTHER_METHODS: ReadonlySet<string> = new Set(['PUT', 'PATCH', 'DELETE', 'QUERY']);

/** How a redirect reaches the client. */
export type RedirectDecision =
  | { readonly kind: 'redirect'; readonly status: number; readonly location: string }
  | {
      readonly kind: 'control';
      readonly control: 'location' | 'fragment';
      readonly target: string;
    };

/** Apply the redirect rules to a redirect answering `facts`. */
export function decideRedirect(
  facts: InertiaRequestFacts,
  visit: InertiaVisit,
  status: number,
  location: string,
): RedirectDecision {
  const unchanged = { kind: 'redirect', status, location } as const;
  if (!visit.isInertia) return unchanged;
  if (!URL.canParse(location, facts.url)) return unchanged;
  const target = new URL(location, facts.url);
  if (target.origin !== facts.url.origin) {
    return { kind: 'control', control: 'location', target: target.href };
  }
  if (location.includes('#') && !visit.prefetch) {
    return { kind: 'control', control: 'fragment', target: location };
  }
  if (status === 302 && SEE_OTHER_METHODS.has(facts.method.toUpperCase())) {
    return { kind: 'redirect', status: 303, location };
  }
  return unchanged;
}

/**
 * A `409` control outcome. `extra` keeps headers from the response it
 * replaces (cookies set by the handler); framing headers are dropped.
 */
export function controlOutcome(
  control: InertiaControlOutcome['control'],
  target: string,
  options: { readonly version?: string; readonly extra?: Headers } = {},
): InertiaControlOutcome {
  const headers = new Headers(options.extra);
  for (const name of DROPPED_ON_CONTROL) headers.delete(name);
  headers.set(control === 'fragment' ? CONTROL_HEADERS.redirect : CONTROL_HEADERS.location, target);
  if (options.version !== undefined) headers.set(CONTROL_HEADERS.version, options.version);
  headers.set('cache-control', 'private, no-store');
  appendVary(headers, INERTIA_VARY);
  return Object.freeze({
    kind: 'control',
    control,
    target,
    status: 409,
    headers: headerList(headers),
    body: null,
  });
}

/** The request path and query, the target of a version or same-URL location visit. */
export function pathAndQuery(url: URL): string {
  return `${url.pathname}${url.search}`;
}

/**
 * A root-relative, same-origin redirect path, percent-encoded for a header;
 * anything else is an `invalid_redirect` error.
 */
export function sameOriginPath(value: unknown): string {
  if (!isSameOriginPath(value)) throw new InertiaError('invalid_redirect');
  return safeRedirectPath(value, '/');
}

/**
 * Validate an explicit location-visit target: an absolute http(s) URL, on
 * any origin, or a same-origin path. Returns the URL the client navigates to.
 */
export function locationTarget(url: string | URL): string {
  if (typeof url === 'string' && isSameOriginPath(url)) return sameOriginPath(url);
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new InertiaError('invalid_redirect');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new InertiaError('invalid_redirect');
  }
  return target.href;
}

const DROPPED_ON_CONTROL: readonly string[] = Object.freeze([
  'location',
  'content-type',
  'content-length',
  'content-encoding',
  'x-inertia',
  'x-inertia-location',
  'x-inertia-redirect',
  'x-inertia-version',
]);
