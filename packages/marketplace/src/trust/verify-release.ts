/**
 * Release verification: does this site trust this release, and are these the
 * bytes it names?
 *
 * `verifyStatement` decides everything that needs no bytes, in this order: the
 * envelope is well formed (`invalid_envelope`); the publisher is trusted
 * (`unknown_publisher`); the digest is not revoked (`release_revoked`); a
 * signature verifies under a current, unrevoked key of that publisher that may
 * sign releases (`unknown_key`, `key_revoked`, `key_use`, `key_expired`,
 * `bad_signature`); the plugin id is inside the publisher's namespace
 * (`id_outside_namespace`); and every permission is under the publisher's
 * ceiling and the site's (`permission_above_publisher_ceiling`,
 * `permission_above_site_ceiling`).
 *
 * `verifyRelease` first checks the bytes against the statement's size and
 * digest (`digest_mismatch`), then everything above, and only then opens the
 * bundle, so an archive no trusted key signed is never parsed. A signed bundle
 * that does not open is `invalid_bundle`, and one whose manifest disagrees
 * with the statement (id, version, publisher, `jsailsCompat`, permission set,
 * manifest digest) is `statement_mismatch`.
 *
 * Whether the release suits the running framework (`jsailsCompat`) is not a
 * trust question; the loader and the planner decide it.
 */

import { ArchiveErrors } from '../archive/archive-errors.js';
import { resolveArchiveLimits } from '../archive/limits.js';
import { sha256Hex } from '../intake/digest.js';
import { IntakeErrors } from '../intake/intake-errors.js';
import { openBundle, type OpenBundleOptions, type OpenedBundle } from '../intake/open-bundle.js';
import { ceilingCovers } from './ceiling.js';
import { inNamespace } from './publisher.js';
import { signingMessage } from './signature.js';
import { parseReleaseEnvelope, type ReleaseEnvelope, type ReleaseStatement } from './statement.js';
import { refuse, type TrustFailure } from './trust-errors.js';
import {
  checkSignatures,
  isReleaseRevoked,
  trustState,
  type SignatureFailure,
  type Trust,
  type TrustState,
} from './trust-set.js';

/**
 * A release statement this site trusts.
 *
 * @public
 */
export interface VerifiedStatement {
  readonly ok: true;
  readonly statement: ReleaseStatement;
  /** The id of the publisher whose key signed it. */
  readonly publisher: string;
  /** The id of the key whose signature verified. */
  readonly keyId: string;
  /** Whether that key was delegated rather than configured. */
  readonly delegated: boolean;
}

/**
 * A trusted release and its opened bundle.
 *
 * @public
 */
export interface VerifiedRelease extends VerifiedStatement {
  readonly bundle: OpenedBundle;
}

/**
 * Why a statement was refused.
 *
 * @public
 */
export type StatementFailureCode =
  | 'invalid_envelope'
  | 'unknown_publisher'
  | 'release_revoked'
  | SignatureFailure
  | 'id_outside_namespace'
  | 'permission_above_publisher_ceiling'
  | 'permission_above_site_ceiling';

/**
 * The verdict of {@link verifyStatement}.
 *
 * @public
 */
export type StatementVerdict = VerifiedStatement | TrustFailure<StatementFailureCode>;

/**
 * The verdict of {@link verifyRelease}.
 *
 * @public
 */
export type ReleaseVerdict =
  | VerifiedRelease
  | TrustFailure<
      StatementFailureCode | 'digest_mismatch' | 'invalid_bundle' | 'statement_mismatch'
    >;

function checkStatement(state: TrustState, envelope: ReleaseEnvelope): StatementVerdict {
  const { statement } = envelope;
  const publisher = state.publishers.get(statement.publisher);
  if (publisher === undefined) return refuse('unknown_publisher');
  if (isReleaseRevoked(state, statement.publisher, statement.digest))
    return refuse('release_revoked');
  const verdict = checkSignatures(state, {
    publisher: statement.publisher,
    signatures: envelope.signatures,
    message: signingMessage('release', statement),
    use: 'release',
    issuedAt: statement.issuedAt,
  });
  if (!verdict.ok) return refuse(verdict.code);
  if (!inNamespace(publisher, statement.id)) return refuse('id_outside_namespace');
  for (const permission of statement.permissions) {
    if (!ceilingCovers(publisher.ceiling, permission)) {
      return refuse('permission_above_publisher_ceiling');
    }
  }
  for (const permission of statement.permissions) {
    if (!ceilingCovers(state.ceiling, permission)) return refuse('permission_above_site_ceiling');
  }
  return Object.freeze({
    ok: true,
    statement,
    publisher: publisher.id,
    keyId: verdict.key.keyId,
    delegated: verdict.key.notAfter !== undefined,
  });
}

/**
 * Verify a release envelope against `trust` without the bundle bytes, to list
 * what a catalog offers or to plan an install before downloading.
 *
 * @public
 */
export function verifyStatement(envelope: unknown, trust: Trust): StatementVerdict {
  const state = trustState(trust);
  const parsed = parseReleaseEnvelope(envelope);
  return parsed === undefined ? refuse('invalid_envelope') : checkStatement(state, parsed);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const sorted = [...right].sort();
  return left.length === sorted.length && left.every((value, index) => value === sorted[index]);
}

function agrees(statement: ReleaseStatement, bundle: OpenedBundle): boolean {
  const { manifest } = bundle;
  return (
    manifest.id === statement.id &&
    manifest.version === statement.version &&
    manifest.publisher === statement.publisher &&
    manifest.jsailsCompat === statement.jsailsCompat &&
    bundle.manifestDigest === statement.manifestDigest &&
    sameSet(statement.permissions, manifest.permissions)
  );
}

/**
 * Verify a release envelope and the bundle bytes it signs against `trust`,
 * and open the bundle. Archive errors of a signed bundle become
 * `invalid_bundle`; anything else a bundle could not cause is rethrown. The
 * caller's archive limits are site config, so limits that are wrong throw
 * `bundle_archive.invalid_limits` before any input is read, whatever the
 * release.
 *
 * @public
 */
export function verifyRelease(
  envelope: unknown,
  bytes: Uint8Array,
  trust: Trust,
  options: OpenBundleOptions = {},
): ReleaseVerdict {
  const state = trustState(trust);
  const limits = resolveArchiveLimits(options.limits);
  const parsed = parseReleaseEnvelope(envelope);
  if (parsed === undefined) return refuse('invalid_envelope');
  const { statement } = parsed;
  if (bytes.byteLength !== statement.size || sha256Hex(bytes) !== statement.digest) {
    return refuse('digest_mismatch');
  }
  const verdict = checkStatement(state, parsed);
  if (!verdict.ok) return verdict;
  let bundle: OpenedBundle;
  try {
    bundle = openBundle(bytes, { limits });
  } catch (error) {
    if (ArchiveErrors.is(error) || IntakeErrors.is(error)) return refuse('invalid_bundle');
    throw error;
  }
  if (!agrees(statement, bundle)) return refuse('statement_mismatch');
  return Object.freeze({ ...verdict, bundle });
}
