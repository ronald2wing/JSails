/**
 * Catalog verification.
 *
 * `verifyCatalog` reads at most 4 MiB of UTF-8 JSON (`invalid_catalog`
 * otherwise, and for any shape error), requires a trusted publisher
 * (`unknown_publisher`), and checks the catalog's delegations against that
 * publisher's root keys: one whose signature fails under a known root refuses
 * the catalog (`invalid_delegation`), while one signed by a root the site does
 * not know or has revoked is ignored, since the publisher may have rotated
 * roots ahead of this site's config. The catalog must then be signed by a
 * configured or delegated `catalog` key that neither the trust set nor the
 * catalog itself revokes (`unknown_key`, `key_revoked`, `key_use`,
 * `key_expired`, `bad_signature`), list only ids inside the publisher's
 * namespace (`id_outside_namespace`), and have a `sequence` no lower than that
 * of the newest catalog this site has accepted (`catalog_rollback`; an equal
 * sequence is a refetch).
 *
 * Revocations only restrict, so they are honoured from any catalog whose
 * signature verified. An expired catalog still verifies, marked `stale`, while
 * the caller stops offering installs from it. A rollback is refused but its
 * verdict carries the catalog's revocations (without its delegations, which
 * would add keys from an outdated list): otherwise one catalog signed with a
 * stolen key at a huge sequence would make every later catalog, the one
 * revoking that key included, a rollback whose revocations are dropped.
 *
 * The rollback floor is bound to the key that set it, as TUF recovers from a
 * fast-forward attack: once the key that signed the accepted catalog is
 * revoked, by this site's trust set or by the candidate catalog itself, the
 * floor no longer holds. A publisher recovers from a stolen catalog key by
 * revoking it in its next catalog, signed by another key, at its usual next
 * sequence.
 * Release envelopes inside are checked for shape and for naming their plugin,
 * version and publisher; their signatures, namespace and ceilings are decided
 * by `verifyStatement`, because ceilings are this site's decision.
 */

import { MarketplaceConfigErrors } from '../trust/config-errors.js';
import { checkDelegation, type VerifiedDelegation } from '../trust/delegation.js';
import { isRecord, KEY_ID_PATTERN, matches } from '../trust/field-checks.js';
import { inNamespace } from '../trust/publisher.js';
import { signingMessage } from '../trust/signature.js';
import { refuse, type TrustFailure } from '../trust/trust-errors.js';
import {
  checkSignatures,
  trustState,
  type SignatureFailure,
  type Trust,
  type TrustedKey,
  type TrustState,
  type VerifiedCatalogTrust,
} from '../trust/trust-set.js';
import { markVerifiedCatalog } from '../trust/verified.js';
import { parseSignedCatalog, type Catalog } from './catalog-document.js';

/**
 * A catalog this site trusts, as only `verifyCatalog` returns one; pass it to
 * `createTrust` to apply its delegations and revocations.
 *
 * @public
 */
export interface VerifiedCatalog extends VerifiedCatalogTrust {
  readonly catalog: Catalog;
  readonly sequence: number;
  /** Past `expiresAt` when it was verified: still honoured for revocations, not offered. */
  readonly stale: boolean;
  /** The id of the key whose signature verified. */
  readonly keyId: string;
  /** The catalog's delegations that verified and hold. */
  readonly delegations: readonly VerifiedDelegation[];
}

/**
 * The newest catalog a site has accepted from a publisher, as it stores it
 * from the {@link VerifiedCatalog}: its `sequence` and the `keyId` that signed
 * it.
 *
 * @public
 */
export interface AcceptedCatalog {
  readonly sequence: number;
  readonly keyId: string;
}

/**
 * Options for {@link verifyCatalog}.
 *
 * @public
 */
export interface VerifyCatalogOptions {
  /**
   * The newest catalog this site has accepted from the publisher. A lower
   * sequence is a rollback while the key that signed this one is unrevoked.
   * Without it, any sequence is accepted.
   */
  readonly accepted?: AcceptedCatalog;
  /** The time expiry is judged at. Defaults to now. */
  readonly now?: Date;
}

/**
 * A catalog refused as a rollback. Its signature verified, so its revocations
 * are returned: pass `revocations` in `createTrust`'s `catalogs` beside the
 * accepted catalog. It adds no keys.
 *
 * @public
 */
export interface CatalogRollback extends TrustFailure<'catalog_rollback'> {
  readonly revocations: VerifiedCatalogTrust;
}

/**
 * The verdict of {@link verifyCatalog}.
 *
 * @public
 */
export type CatalogVerdict =
  | { readonly ok: true; readonly catalog: VerifiedCatalog }
  | CatalogRollback
  | TrustFailure<
      | 'invalid_catalog'
      | 'unknown_publisher'
      | 'invalid_delegation'
      | SignatureFailure
      | 'id_outside_namespace'
    >;

const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

function readJson(raw: Uint8Array | string): unknown {
  const bytes = typeof raw === 'string' ? encoder.encode(raw) : raw;
  if (bytes.byteLength > MAX_CATALOG_BYTES) return undefined;
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    // Not UTF-8 JSON; reported as invalid_catalog without the parser's message.
    return undefined;
  }
}

function invalidOptions(field: 'shape' | 'accepted' | 'now'): Error {
  return new MarketplaceConfigErrors.Error('invalid_catalog_options', { field });
}

/** The options, checked: they are the caller's own state, so a wrong one throws. */
function checkOptions(options: unknown): { accepted?: AcceptedCatalog; now: number } {
  if (!isRecord(options)) throw invalidOptions('shape');
  const { accepted, now } = options;
  if (now !== undefined && !(now instanceof Date && !Number.isNaN(now.getTime()))) {
    throw invalidOptions('now');
  }
  const at = (now ?? new Date()).getTime();
  if (accepted === undefined) return { now: at };
  if (!isRecord(accepted)) throw invalidOptions('accepted');
  const { sequence, keyId } = accepted;
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) {
    throw invalidOptions('accepted');
  }
  if (!matches(keyId, KEY_ID_PATTERN)) throw invalidOptions('accepted');
  return { accepted: { sequence: sequence as number, keyId }, now: at };
}

/**
 * The lowest sequence the publisher's next catalog may carry: the accepted
 * catalog's, unless the key that signed it is now revoked.
 */
function rollbackFloor(
  state: TrustState,
  publisher: string,
  ownRevoked: ReadonlySet<string>,
  accepted: AcceptedCatalog | undefined,
): number {
  if (accepted === undefined) return 0;
  const revoked =
    state.revokedKeys.get(publisher)?.has(accepted.keyId) === true ||
    ownRevoked.has(accepted.keyId);
  return revoked ? 0 : accepted.sequence;
}

/**
 * Verify a signed catalog against `trust`. Throws
 * `marketplace_config.invalid_catalog_options` for options that are wrong.
 *
 * @public
 */
export function verifyCatalog(
  raw: Uint8Array | string,
  trust: Trust,
  options: VerifyCatalogOptions = {},
): CatalogVerdict {
  const state = trustState(trust);
  const { accepted, now } = checkOptions(options);
  const signed = parseSignedCatalog(readJson(raw));
  if (signed === undefined) return refuse('invalid_catalog');
  const { catalog } = signed;
  const publisher = state.publishers.get(catalog.publisher);
  if (publisher === undefined) return refuse('unknown_publisher');
  const ownRevoked = new Set(catalog.revoked.keys);

  const delegations: VerifiedDelegation[] = [];
  const extraKeys: TrustedKey[] = [];
  for (const delegation of catalog.delegations) {
    if (delegation.delegation.publisher !== catalog.publisher) return refuse('invalid_delegation');
    const verdict = checkDelegation(state, delegation, ownRevoked);
    if (!verdict.ok) {
      if (verdict.code === 'bad_signature') return refuse('invalid_delegation');
      continue;
    }
    delegations.push(verdict.delegation);
    extraKeys.push(verdict.key);
  }

  const verdict = checkSignatures(state, {
    publisher: catalog.publisher,
    signatures: signed.signatures,
    message: signingMessage('catalog', catalog),
    use: 'catalog',
    issuedAt: catalog.issuedAt,
    extraKeys,
    extraRevoked: ownRevoked,
  });
  if (!verdict.ok) return refuse(verdict.code);
  if (!catalog.plugins.every((plugin) => inNamespace(publisher, plugin.id))) {
    return refuse('id_outside_namespace');
  }
  if (catalog.sequence < rollbackFloor(state, catalog.publisher, ownRevoked, accepted)) {
    const revocations: VerifiedCatalogTrust = Object.freeze({
      publisher: catalog.publisher,
      revoked: catalog.revoked,
      delegations: Object.freeze([]),
    });
    return Object.freeze({
      ...refuse('catalog_rollback'),
      revocations: markVerifiedCatalog(revocations),
    });
  }
  const verified: VerifiedCatalog = Object.freeze({
    catalog,
    publisher: catalog.publisher,
    sequence: catalog.sequence,
    stale: now > Date.parse(catalog.expiresAt),
    keyId: verdict.key.keyId,
    revoked: catalog.revoked,
    delegations: Object.freeze(delegations),
  });
  return Object.freeze({ ok: true, catalog: markVerifiedCatalog(verified) });
}
