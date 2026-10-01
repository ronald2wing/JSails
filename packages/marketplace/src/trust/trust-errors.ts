/**
 * The verdicts of release, delegation and catalog verification,
 * `marketplace_trust.*`. The verifiers return a code instead of throwing, since
 * a refused release is an expected outcome a planner or a loader reports and
 * moves past; a caller that wants an error raises
 * `new MarketplaceTrustErrors.Error(result.code)`. Like every registry, the
 * codes are value-free: no plugin id, key id or digest reaches a message.
 */

import { defineErrors, type ErrorRegistry } from 'jsails/errors';

const TRUST_ERRORS = {
  invalid_envelope: {
    kind: 'invalid',
    message: 'the release envelope or its statement is malformed',
    suggestion: 'Use the envelope the publisher released, unmodified',
  },
  invalid_delegation: {
    kind: 'invalid',
    message: 'a key delegation is malformed or its root signature does not verify',
    suggestion: 'Ask the publisher for a correctly signed catalog',
  },
  invalid_catalog: {
    kind: 'invalid',
    message: 'the catalog is malformed',
    suggestion: 'Use the catalog the publisher serves, unmodified',
  },
  digest_mismatch: {
    kind: 'invalid',
    message: 'the bundle bytes do not match the size and digest the release statement signs',
    suggestion: 'Download the bundle again from one of the release URLs',
  },
  unknown_publisher: {
    kind: 'forbidden',
    message: 'the publisher is not trusted by this site',
    suggestion: 'Add the publisher to the trusted publishers in the app config, if you trust it',
  },
  release_revoked: {
    kind: 'forbidden',
    message: 'the release has been revoked',
    suggestion: 'Install another version of the plugin',
  },
  unknown_key: {
    kind: 'forbidden',
    message: 'no signature is by a key the publisher has listed or delegated',
    suggestion: 'Refresh the publisher catalog, which carries its delegated keys',
  },
  key_revoked: {
    kind: 'forbidden',
    message: 'the signing key has been revoked',
    suggestion: 'Ask the publisher for a release signed by a current key',
  },
  key_use: {
    kind: 'forbidden',
    message: 'the signing key is not allowed to sign this kind of record',
    suggestion: 'A release needs a release key and a catalog a catalog key',
  },
  key_expired: {
    kind: 'forbidden',
    message: 'the delegated signing key had expired when the record was issued',
    suggestion: 'Ask the publisher for a release signed by a current key',
  },
  bad_signature: {
    kind: 'forbidden',
    message: 'the signature does not verify',
    suggestion: 'The record was altered after signing; use the one the publisher released',
  },
  id_outside_namespace: {
    kind: 'forbidden',
    message: 'the plugin id is outside the ids the publisher may release',
    suggestion: "A publisher may only release ids matching its configured 'ids' patterns",
  },
  permission_above_publisher_ceiling: {
    kind: 'forbidden',
    message: 'the release asks for a permission above the publisher ceiling',
    suggestion:
      "Raise the publisher's ceiling in the app config only if you accept that permission from it",
  },
  permission_above_site_ceiling: {
    kind: 'forbidden',
    message: 'the release asks for a permission above the site ceiling',
    suggestion:
      'Raise the site ceiling in the app config only if you accept that permission on this site',
  },
  invalid_bundle: {
    kind: 'invalid',
    message: 'the signed bundle cannot be opened',
    suggestion: 'The publisher released a broken bundle; install another version',
  },
  statement_mismatch: {
    kind: 'invalid',
    message: "the release statement disagrees with the bundle's manifest",
    suggestion: 'The publisher signed a statement for other contents; install another version',
  },
  catalog_rollback: {
    kind: 'conflict',
    message: 'the catalog is older than one this site has already accepted',
    suggestion: 'Serve the newest catalog; an older one may hide revocations',
  },
} as const;

/**
 * The verification verdict codes, `marketplace_trust.*`.
 *
 * @public
 */
export const MarketplaceTrustErrors: ErrorRegistry<'marketplace_trust', typeof TRUST_ERRORS> =
  defineErrors('marketplace_trust', TRUST_ERRORS);

/**
 * A verification verdict code.
 *
 * @public
 */
export type TrustFailureCode = keyof typeof TRUST_ERRORS;

/**
 * A refused verification.
 *
 * @public
 */
export interface TrustFailure<C extends TrustFailureCode = TrustFailureCode> {
  readonly ok: false;
  readonly code: C;
}

/** A frozen failure verdict. */
export function refuse<C extends TrustFailureCode>(code: C): TrustFailure<C> {
  return Object.freeze({ ok: false, code });
}
