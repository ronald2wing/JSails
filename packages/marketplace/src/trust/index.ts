/**
 * Release trust: canonical JSON and Ed25519 signing messages, release
 * statements, `publisher()` config data with id namespaces, keys and
 * permission ceilings, key delegations, the immutable trust set with its
 * revocations, and `verifyStatement` / `verifyRelease`.
 */

export { canonicalJson } from './canonical-json.js';
export { MarketplaceConfigErrors } from './config-errors.js';
export {
  verifyDelegation,
  type DelegatedKeyUse,
  type DelegationVerdict,
  type KeyDelegation,
  type SignedDelegation,
  type VerifiedDelegation,
} from './delegation.js';
export { KEY_ID_PATTERN, PUBLISHER_ID_PATTERN, type RecordSignature } from './field-checks.js';
export {
  publisher,
  type KeyUse,
  type Publisher,
  type PublisherInput,
  type PublisherKey,
} from './publisher.js';
export { signingMessage, type SignedRecordKind } from './signature.js';
export type { ReleaseEnvelope, ReleaseProvenance, ReleaseStatement } from './statement.js';
export {
  MarketplaceTrustErrors,
  type TrustFailure,
  type TrustFailureCode,
} from './trust-errors.js';
export {
  createTrust,
  type CatalogRevocations,
  type RevokedKey,
  type Revocations,
  type SignatureFailure,
  type Trust,
  type TrustInput,
  type VerifiedCatalogTrust,
} from './trust-set.js';
export {
  verifyRelease,
  verifyStatement,
  type ReleaseVerdict,
  type StatementFailureCode,
  type StatementVerdict,
  type VerifiedRelease,
  type VerifiedStatement,
} from './verify-release.js';
