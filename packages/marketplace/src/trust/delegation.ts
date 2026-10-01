/**
 * Key delegations: a publisher's offline root key hands day-to-day signing to
 * a release or catalog key without a config change on every site.
 *
 * A delegation `{ v: 1, publisher, keyId, publicKey, use, notAfter }` is
 * signed by a root key of `publisher` (the `delegation` signing message) and
 * travels in that publisher's catalog, or beside a lock entry. `use` is
 * `release`, `catalog` or both, never `root`: only config makes a root key.
 * `notAfter` is the last `issuedAt` the key may sign (see `trust-set.ts` for
 * why that limits only a key that was not stolen).
 */

import { refuse, type TrustFailure } from './trust-errors.js';
import {
  hasExactKeys,
  isRecord,
  isTimestamp,
  KEY_ID_PATTERN,
  matches,
  parseSignatures,
  PUBLISHER_ID_PATTERN,
  type RecordSignature,
} from './field-checks.js';
import { decodePublicKey, signingMessage } from './signature.js';
import {
  checkSignatures,
  trustState,
  type SignatureFailure,
  type Trust,
  type TrustedKey,
  type TrustState,
} from './trust-set.js';
import { markVerifiedDelegation } from './verified.js';

/**
 * What a delegated key may sign.
 *
 * @public
 */
export type DelegatedKeyUse = 'release' | 'catalog';

/**
 * A key delegation, version 1.
 *
 * @public
 */
export interface KeyDelegation {
  readonly v: 1;
  readonly publisher: string;
  readonly keyId: string;
  /** Standard padded base64 of the raw 32-byte Ed25519 public key. */
  readonly publicKey: string;
  readonly use: readonly DelegatedKeyUse[];
  /** The last `issuedAt` the key may sign. */
  readonly notAfter: string;
}

/**
 * A key delegation with its root signatures.
 *
 * @public
 */
export interface SignedDelegation {
  readonly delegation: KeyDelegation;
  readonly signatures: readonly RecordSignature[];
}

/**
 * A delegation whose root signature verified, as only the verifiers return
 * one. `roots` are the root keys whose signatures verified; the delegation
 * holds while one of them is still a configured, unrevoked root.
 *
 * @public
 */
export interface VerifiedDelegation {
  readonly delegation: KeyDelegation;
  readonly roots: readonly { readonly keyId: string; readonly publicKey: string }[];
}

/**
 * The verdict of {@link verifyDelegation}.
 *
 * @public
 */
export type DelegationVerdict =
  | { readonly ok: true; readonly delegation: VerifiedDelegation }
  | TrustFailure<'invalid_delegation' | 'unknown_publisher' | SignatureFailure>;

const DELEGATION_KEYS = ['v', 'publisher', 'keyId', 'publicKey', 'use', 'notAfter'];
const DELEGATED_USES: readonly DelegatedKeyUse[] = ['release', 'catalog'];

function parseUse(value: unknown): readonly DelegatedKeyUse[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || new Set(value).size !== value.length) {
    return undefined;
  }
  const uses = value as readonly unknown[];
  if (!uses.every((use) => DELEGATED_USES.includes(use as DelegatedKeyUse))) return undefined;
  return Object.freeze([...(uses as readonly DelegatedKeyUse[])]);
}

/** A checked delegation record, or `undefined`. */
function parseDelegation(value: unknown): KeyDelegation | undefined {
  if (!isRecord(value) || !hasExactKeys(value, DELEGATION_KEYS)) return undefined;
  const { v, publisher, keyId, publicKey, notAfter } = value;
  const use = parseUse(value.use);
  if (v !== 1 || use === undefined || !isTimestamp(notAfter)) return undefined;
  if (!matches(publisher, PUBLISHER_ID_PATTERN) || !matches(keyId, KEY_ID_PATTERN))
    return undefined;
  if (typeof publicKey !== 'string' || decodePublicKey(publicKey) === undefined) return undefined;
  return Object.freeze({ v: 1, publisher, keyId, publicKey, use, notAfter });
}

/** A checked signed delegation, or `undefined`. */
export function parseSignedDelegation(value: unknown): SignedDelegation | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['delegation', 'signatures'])) return undefined;
  const delegation = parseDelegation(value.delegation);
  const signatures = parseSignatures(value.signatures);
  if (delegation === undefined || signatures === undefined) return undefined;
  return Object.freeze({ delegation, signatures });
}

/** A verified delegation together with the key it delegates. */
export type DelegationCheck =
  | { readonly ok: true; readonly delegation: VerifiedDelegation; readonly key: TrustedKey }
  | TrustFailure<'unknown_publisher' | SignatureFailure>;

/**
 * Check a parsed delegation's root signatures against `state`, with
 * `extraRevoked` key ids revoked on top (a catalog's own list).
 */
export function checkDelegation(
  state: TrustState,
  signed: SignedDelegation,
  extraRevoked?: ReadonlySet<string>,
): DelegationCheck {
  const { delegation } = signed;
  if (!state.publishers.has(delegation.publisher)) return refuse('unknown_publisher');
  const check = {
    publisher: delegation.publisher,
    message: signingMessage('delegation', delegation),
    use: 'root' as const,
    issuedAt: delegation.notAfter,
    ...(extraRevoked === undefined ? {} : { extraRevoked }),
  };
  const verdict = checkSignatures(state, { ...check, signatures: signed.signatures });
  if (!verdict.ok) return refuse(verdict.code);
  // Every root that signed is recorded, so the delegation survives the
  // revocation of one of two roots that both signed it.
  const roots = signed.signatures.flatMap((signature) => {
    const single = checkSignatures(state, { ...check, signatures: [signature] });
    return single.ok
      ? [Object.freeze({ keyId: single.key.keyId, publicKey: single.key.publicKey })]
      : [];
  });
  const key: TrustedKey = Object.freeze({
    keyId: delegation.keyId,
    publicKey: delegation.publicKey,
    // `parseSignedDelegation` accepted only a key that decodes.
    object: decodePublicKey(delegation.publicKey)!,
    use: delegation.use,
    notAfter: delegation.notAfter,
  });
  const verified: VerifiedDelegation = Object.freeze({ delegation, roots: Object.freeze(roots) });
  return Object.freeze({ ok: true, delegation: markVerifiedDelegation(verified, key), key });
}

/**
 * Verify a signed key delegation against the root keys of its publisher in
 * `trust`. The verified delegation can then be passed to `createTrust`.
 *
 * @public
 */
export function verifyDelegation(signed: unknown, trust: Trust): DelegationVerdict {
  const state = trustState(trust);
  const parsed = parseSignedDelegation(signed);
  if (parsed === undefined) return refuse('invalid_delegation');
  const verdict = checkDelegation(state, parsed);
  return verdict.ok ? Object.freeze({ ok: true, delegation: verdict.delegation }) : verdict;
}
