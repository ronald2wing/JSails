/**
 * Credential kinds: what a surface accepts as proof of who is asking, a
 * session `cookie` or a `token` sent in a request header.
 *
 * A surface accepting `cookie` is one a browser attaches the visitor's
 * session to on its own, cross-site requests included, so the access chain
 * gives each of its unsafe requests the cross-site check; a surface accepting
 * none (`[]`) reads no credential at all.
 *
 * The list is enforced, not only described: the claim resolves an identity
 * for a route only from a credential kind the route accepts
 * ({@link acceptedIdentity}), so a route that leaves out `cookie` never acts
 * on the visitor's cookie session, and the cross-site check it skips has
 * nothing left to protect. Which kind an identity came from is
 * {@link credentialOf}: `token` when the session resolver marked it as
 * header-authenticated (`session.data.authMethod` of `bearer` or
 * `api-token`), `cookie` for every other identity, since an unmarked one may
 * have come from a cookie and only the cross-site check protects that.
 *
 * Browser-safe: no runtime imports.
 */

import type { Session } from '../contracts/http.js';

/**
 * A kind of credential a surface accepts.
 *
 * @public
 */
export type CredentialKind = 'cookie' | 'token';

const CREDENTIAL_KINDS: ReadonlySet<string> = new Set<CredentialKind>(['cookie', 'token']);

/** Whether `value` is a list of distinct {@link CredentialKind}s (the empty list included). */
export function isCredentialList(value: unknown): value is readonly CredentialKind[] {
  return (
    Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every((kind) => typeof kind === 'string' && CREDENTIAL_KINDS.has(kind))
  );
}

/** The `session.data.authMethod` values that name a credential sent in a header. */
const HEADER_AUTH_METHODS: ReadonlySet<unknown> = new Set(['bearer', 'api-token']);

/**
 * The credential kind `session` was resolved from: `token` when the session
 * resolver recorded a header credential (`session.data.authMethod` of
 * `bearer` or `api-token`), `cookie` otherwise. The marker is trusted because
 * it comes from `resolveSession`, the application's trusted seam, which must
 * derive it from the credential it verified on this request and never from
 * stored or client-supplied data.
 */
export function credentialOf(session: Session): CredentialKind {
  const data: unknown = session.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return 'cookie';
  return Object.hasOwn(data, 'authMethod') &&
    HEADER_AUTH_METHODS.has((data as { readonly authMethod?: unknown }).authMethod)
    ? 'token'
    : 'cookie';
}

/**
 * `identity` as a surface accepting `credentials` sees it: itself when it was
 * resolved from a kind the surface accepts, otherwise `null` (the request is
 * anonymous there).
 */
export function acceptedIdentity(
  identity: Session | null,
  credentials: readonly CredentialKind[],
): Session | null {
  return identity !== null && credentials.includes(credentialOf(identity)) ? identity : null;
}
