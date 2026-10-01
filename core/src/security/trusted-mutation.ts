/**
 * Trusted-mutation guard: same-origin + CSRF checks shared by the admin panel,
 * filesystem API routes, server-component runtime, and the auth/plugin hooks.
 *
 * The same-origin check is a pure string comparison of the request's `Origin`
 * header against a trusted origin; forwarded headers (X-Forwarded-Host, etc.)
 * are never consulted. {@link requestSite} widens it for unsafe requests that
 * may carry no session (sign-in, sign-up): `Origin`, then `Sec-Fetch-Site`,
 * then `Referer`. The CSRF check is constant-time via `safeEqualStrings`.
 *
 * This module is **server-only** (it imports `node:crypto` through
 * `./constant-time.js`). It must never be re-exported from `jsails/extensions`.
 */

import type { Session } from '../contracts/http.js';
import { safeEqualStrings } from './constant-time.js';

// ---------------------------------------------------------------------------
// Discriminated result types (value-free — never echo the request or token)
// ---------------------------------------------------------------------------

/** Reason codes a trusted-mutation guard can return on denial. */
type DenyCode = 'origin_mismatch' | 'csrf_mismatch';

/** A denied guard result: the caller renders its own response from these fields. */
interface GuardDenied {
  readonly allowed: false;
  readonly code: DenyCode;
  readonly status: number;
  readonly message: string;
}

/** An allowed guard result. */
interface GuardAllowed {
  readonly allowed: true;
}

/** Discriminated union: exactly one branch is present. */
type GuardResult = GuardAllowed | GuardDenied;

// ---------------------------------------------------------------------------
// Same-origin check
// ---------------------------------------------------------------------------

/**
 * True when the request's `Origin` header exactly equals the expected origin.
 *
 * When `expectedOrigin` is provided it is compared verbatim; when absent the
 * comparison falls back to the request URL's own origin. Forwarded headers are
 * never consulted — the caller supplies the trusted origin, which inside the
 * HTTP pipeline is the origin the request was addressed to (`c.var.origin`,
 * see `request-origin.ts`).
 */
export function isSameOriginRequest(request: Request, expectedOrigin?: string): boolean {
  const origin = request.headers.get('origin');
  if (typeof origin !== 'string' || origin === '') {
    return false;
  }
  const trusted = expectedOrigin ?? new URL(request.url).origin;
  return origin === trusted;
}

/** Where an unsafe request came from, as far as the browser's headers say. */
export type RequestSite = 'same-origin' | 'cross-site' | 'unknown';

/**
 * Classify a request's initiator from the headers a browser sets and page
 * script cannot forge: `Origin` first, then `Sec-Fetch-Site`, then the
 * `Referer` origin. The first header present decides; a value that does not
 * name the trusted origin (including `Origin: null` and an unparseable
 * `Referer`) is `cross-site`. `unknown` means none of the three was sent,
 * which a browser never does for a cross-site unsafe request but a plain HTTP
 * client does.
 */
export function requestSite(request: Request, expectedOrigin?: string): RequestSite {
  const trusted = expectedOrigin ?? new URL(request.url).origin;
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== '') {
    return origin === trusted ? 'same-origin' : 'cross-site';
  }
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite !== '') {
    return fetchSite === 'same-origin' ? 'same-origin' : 'cross-site';
  }
  const referer = request.headers.get('referer');
  if (referer !== null && referer !== '') {
    return URL.parse(referer)?.origin === trusted ? 'same-origin' : 'cross-site';
  }
  return 'unknown';
}

/** Methods that never change state, so a cross-site request for one is harmless. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** True for every method other than GET, HEAD, and OPTIONS. */
export function isUnsafeMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

// ---------------------------------------------------------------------------
// CSRF token check
// ---------------------------------------------------------------------------

/**
 * Constant-time CSRF comparison. Returns `true` only when the supplied value
 * is a non-empty string that exactly matches the session token.
 *
 * Unlike `assertCsrfToken` (which throws), this returns a boolean so callers
 * can build discriminated results without a try/catch in the expected-deny path.
 */
export function csrfTokenValid(session: Session, supplied: unknown): boolean {
  if (typeof supplied !== 'string' || supplied === '') {
    return false;
  }
  return safeEqualStrings(session.csrfToken, supplied);
}

// ---------------------------------------------------------------------------
// Header-authenticated sessions
// ---------------------------------------------------------------------------

/** The `session.data.authMethod` values that name a credential sent in a header. */
const HEADER_AUTH_METHODS: ReadonlySet<unknown> = new Set(['bearer', 'api-token']);

/**
 * True when the session resolver recorded that this request authenticated
 * with a header credential (`session.data.authMethod` of `bearer` or
 * `api-token`) rather than a cookie. A browser attaches cookies to cross-site
 * requests but never a header credential, so the same-origin and CSRF checks
 * protect nothing for such a session.
 *
 * The marker is trusted because it comes from `resolveSession`, the
 * application's trusted seam, which must derive it from the credential it
 * verified on this request and never from stored or client-supplied data.
 * Every other value, including an absent marker and `cookie`, returns false,
 * so an unmarked session keeps both checks.
 */
export function isHeaderAuthenticatedSession(session: Session): boolean {
  const data: unknown = session.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return false;
  return (
    Object.hasOwn(data, 'authMethod') &&
    HEADER_AUTH_METHODS.has((data as { readonly authMethod?: unknown }).authMethod)
  );
}

// ---------------------------------------------------------------------------
// Combined trusted-mutation guard
// ---------------------------------------------------------------------------

/** Options for {@link checkTrustedMutation}. */
interface TrustedMutationOptions {
  /** The trusted origin to compare the `Origin` header against. */
  readonly expectedOrigin?: string;
  /** The CSRF token value (typically from the `X-CSRF-Token` header or form body). */
  readonly csrfValue?: unknown;
}

/** Stable, value-free rejection messages. */
const DENY_MESSAGES: Record<DenyCode, string> = {
  origin_mismatch: 'Cross-origin request rejected',
  csrf_mismatch: 'CSRF token missing or mismatch',
};

/** The value-free origin denial. */
const ORIGIN_DENIED: GuardDenied = Object.freeze({
  allowed: false,
  code: 'origin_mismatch',
  status: 403,
  message: DENY_MESSAGES.origin_mismatch,
});

/**
 * The origin half of {@link checkTrustedMutation}, which holds with or without
 * a session: an anonymous unsafe request is still refused when it is
 * cross-site, so a hostile page cannot sign a visitor in to an attacker's
 * account (login CSRF) or register one on their behalf.
 *
 * A request that names no site at all (see {@link requestSite}) passes only
 * when it has no session and sends no `Cookie` header: that is a non-browser
 * client, which no third-party page can drive. A cookie-authenticated
 * request must positively name the trusted origin.
 */
export function checkRequestOrigin(
  request: Request,
  session: Session | null,
  expectedOrigin?: string,
): GuardResult {
  const site = requestSite(request, expectedOrigin);
  if (site === 'same-origin') return { allowed: true };
  if (site === 'unknown' && session === null && !request.headers.has('cookie')) {
    return { allowed: true };
  }
  return ORIGIN_DENIED;
}

/**
 * Guard a mutation request: check the origin first, then CSRF. Returns a
 * discriminated result — `{ allowed: true }` or a value-free
 * `{ allowed: false, code, status, message }`. Never throws for the expected
 * deny path (a mismatched origin or CSRF token).
 *
 * The origin check ({@link checkRequestOrigin}) runs whether or not there is a
 * session. The CSRF token is checked only for a session, since an anonymous
 * request has no token to bind to; the caller still decides whether an
 * anonymous mutation is allowed at all.
 */
export function checkTrustedMutation(
  request: Request,
  session: Session | null,
  options: TrustedMutationOptions = {},
): GuardResult {
  const origin = checkRequestOrigin(request, session, options.expectedOrigin);
  if (!origin.allowed || session === null) {
    return origin;
  }

  if (!csrfTokenValid(session, options.csrfValue)) {
    return {
      allowed: false,
      code: 'csrf_mismatch',
      status: 403,
      message: DENY_MESSAGES.csrf_mismatch,
    };
  }

  return { allowed: true };
}
