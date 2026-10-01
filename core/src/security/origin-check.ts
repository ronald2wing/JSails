/**
 * The cross-site check: whether an unsafe request to a cookie-accepting
 * surface was sent by a page of the origin it was addressed to.
 *
 * A browser attaches cookies to a cross-site request, so a hostile page can
 * make a visitor's browser send a write carrying the visitor's session, or no
 * session at all (signing the visitor in to the attacker's account). The
 * check is the only protection, with `SameSite=Lax` session cookies as the
 * second layer; there is no token.
 *
 * {@link crossSiteVerdict} reads only the headers page script cannot set:
 * `Origin`, compared by exact string equality with the origin the request was
 * addressed to (never derived from forwarded headers: the caller supplies it,
 * inside the pipeline `frame.origin.origin`), and, only when `Origin` is
 * absent, `Sec-Fetch-Site`, which must be `same-origin`. Anything else, an
 * `Origin: null`, a request that names no site at all, or one that names it
 * only in `Referer`, is cross-site: a client outside a browser that sends a
 * cookie sends `Origin` too.
 *
 * {@link requiresOriginCheck} is when the check applies: an unsafe method (not
 * GET, HEAD or OPTIONS) to a surface whose credentials include `cookie`. The
 * access chain (`access-chain.ts`) also skips it for a request whose identity
 * came from a header credential ({@link isHeaderAuthenticatedSession}): a
 * cross-site page cannot attach an `Authorization` header without a CORS
 * preflight the app never grants.
 *
 * Browser-safe: its one runtime import, `credentials.ts`, imports nothing.
 */

import type { Session } from '../contracts/http.js';
import { credentialOf, type CredentialKind } from './credentials.js';

/** Methods that never change state, so a cross-site request for one is harmless. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * True for every method other than GET, HEAD and OPTIONS.
 *
 * @public
 */
export function isUnsafeMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Whether a request was sent from the origin it was addressed to.
 *
 * @public
 */
export type CrossSiteVerdict = 'same-origin' | 'cross-site';

/**
 * The verdict for `request` against `expectedOrigin`: `same-origin` when its
 * `Origin` header equals `expectedOrigin` exactly, or when it sends no
 * `Origin` and sends `Sec-Fetch-Site: same-origin`; `cross-site` otherwise.
 *
 * @public
 */
export function crossSiteVerdict(request: Request, expectedOrigin: string): CrossSiteVerdict {
  const origin = request.headers.get('origin');
  if (origin !== null) return origin === expectedOrigin ? 'same-origin' : 'cross-site';
  return request.headers.get('sec-fetch-site') === 'same-origin' ? 'same-origin' : 'cross-site';
}

/**
 * Whether the cross-site check applies to a `method` request to a surface
 * accepting `credentials`: an unsafe method to a cookie-accepting surface.
 *
 * @public
 */
export function requiresOriginCheck(
  method: string,
  credentials: readonly CredentialKind[],
): boolean {
  return isUnsafeMethod(method) && credentials.includes('cookie');
}

/**
 * True when the session resolver recorded that this request authenticated
 * with a header credential (`session.data.authMethod` of `bearer` or
 * `api-token`) rather than a cookie. The marker is trusted because it comes
 * from `resolveSession`, the application's trusted seam, which must derive it
 * from the credential it verified on this request and never from stored or
 * client-supplied data. Every other value, an absent marker and `cookie`
 * included, is false.
 *
 * @public
 */
export function isHeaderAuthenticatedSession(session: Session): boolean {
  return credentialOf(session) === 'token';
}
