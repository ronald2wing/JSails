/**
 * The Origin check, Inertia's CSRF defence.
 *
 * Inertia needs no CSRF token: the v3 client sends every visit as a
 * same-origin XHR, and a browser attaches `Origin` to every XHR whose method
 * is not `GET` or `HEAD`. A forged cross-site form or fetch therefore names
 * another origin, and refusing it is the whole defence. The engine sets no
 * `XSRF-TOKEN` cookie (so the client sends no `X-XSRF-TOKEN`) and reads no
 * `_method` override.
 *
 * {@link originGuard} classifies an unsafe request by the headers page script
 * cannot forge: `Origin` first, then
 * `Sec-Fetch-Site`, then the `Referer` origin; the first one present decides.
 * A request with none of the three comes from a non-browser client and passes
 * only when it carries no `Cookie`, since without an ambient credential there
 * is nothing to forge. Forwarded headers are never read: behind a
 * TLS-terminating proxy the caller passes the public origin.
 */

import { InertiaError } from './inertia-error.js';
import type { InertiaForbiddenOutcome } from './outcome.js';
import { appendVary, headerList, INERTIA_VARY } from './response-headers.js';
import type { InertiaRequestFacts } from './visit.js';

/** Options for {@link originGuard}. */
export interface OriginGuardOptions {
  /**
   * The trusted origin (`https://app.example`). Defaults to the request URL's
   * origin; set it when a proxy rewrites the scheme or host.
   */
  readonly origin?: string;
}

/** Methods that never change state, so a cross-site request for one is harmless. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The refusal in core's problem envelope, so a client reads it like any other failure. */
const DENIED_BODY = JSON.stringify({
  type: 'about:blank',
  title: 'Forbidden',
  status: 403,
  detail: 'Cross-origin request rejected',
  code: 'origin_mismatch',
});

/**
 * A `403` for an unsafe request that did not come from the trusted origin, or
 * `null` when the request may proceed. Run it before reading the body of a
 * mutation or a Precognition request.
 */
export function originGuard(
  facts: InertiaRequestFacts,
  options: OriginGuardOptions = {},
): InertiaForbiddenOutcome | null {
  const trusted = trustedOrigin(facts, options.origin);
  if (SAFE_METHODS.has(facts.method.toUpperCase())) return null;
  const site = requestSite(facts.headers, trusted);
  if (site === 'same-origin') return null;
  if (site === 'unknown' && !facts.headers.has('cookie')) return null;
  const headers = new Headers({
    'content-type': 'application/problem+json',
    'cache-control': 'private, no-store',
  });
  appendVary(headers, INERTIA_VARY);
  return Object.freeze({
    kind: 'forbidden',
    status: 403,
    code: 'origin_mismatch',
    headers: headerList(headers),
    body: DENIED_BODY,
  });
}

function trustedOrigin(facts: InertiaRequestFacts, origin: string | undefined): string {
  if (origin === undefined) return facts.url.origin;
  const parsed = typeof origin === 'string' ? URL.parse(origin) : null;
  if (
    parsed === null ||
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.origin !== origin
  ) {
    throw new InertiaError('invalid_options');
  }
  return origin;
}

function requestSite(headers: Headers, trusted: string): 'same-origin' | 'cross-site' | 'unknown' {
  const origin = headers.get('origin');
  if (origin !== null && origin !== '') return origin === trusted ? 'same-origin' : 'cross-site';
  const fetchSite = headers.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite !== '') {
    return fetchSite === 'same-origin' ? 'same-origin' : 'cross-site';
  }
  const referer = headers.get('referer');
  if (referer !== null && referer !== '') {
    return URL.parse(referer)?.origin === trusted ? 'same-origin' : 'cross-site';
  }
  return 'unknown';
}
