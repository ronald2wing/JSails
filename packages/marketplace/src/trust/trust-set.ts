/**
 * The trust set: who a site trusts, with which keys, up to which permissions,
 * and what has been revoked. `createTrust` builds it once from config data and
 * verified records; every verifier reads it and none changes it.
 *
 * Keys are the publishers' configured keys plus the keys delegated to them. A
 * delegation counts only while one of the root keys that signed it is still a
 * configured, unrevoked root key of its publisher, so revoking a root removes
 * every key it delegated. Revocations only restrict: the effective set is the
 * config's list (keys by publisher and key id, releases by digest) plus the
 * list of every verified catalog, each applying to its own publisher's keys and
 * releases only, so one publisher's catalog key cannot revoke another's.
 *
 * When no signature of a record verifies, the verdict is the furthest stage any
 * signature reached: `unknown_key`, then `key_revoked`, `key_use`,
 * `key_expired`, `bad_signature`. A delegated key signs a record only when the
 * record's `issuedAt` is not after the delegation's `notAfter`: releases signed
 * while the key was current stay valid after it retires. A thief holding a
 * delegated key can backdate `issuedAt`, so expiry limits only keys that were
 * not stolen; revocation is the control for a stolen one.
 */

import type { KeyObject } from 'node:crypto';

import { compileCeiling, type CompiledCeiling } from './ceiling.js';
import { MarketplaceConfigErrors } from './config-errors.js';
import type { VerifiedDelegation } from './delegation.js';
import {
  hasExactKeys,
  isRecord,
  KEY_ID_PATTERN,
  matches,
  type RecordSignature,
} from './field-checks.js';
import { DIGEST_PATTERN } from '../intake/digest.js';
import {
  compiledPublisher,
  type CompiledPublisher,
  type KeyUse,
  type Publisher,
} from './publisher.js';
import { verifySignature } from './signature.js';
import { delegatedKey, isVerifiedCatalog } from './verified.js';

/**
 * A revoked key, named by its publisher and key id.
 *
 * @public
 */
export interface RevokedKey {
  readonly publisher: string;
  readonly keyId: string;
}

/**
 * Revocations declared in config.
 *
 * @public
 */
export interface Revocations {
  readonly keys?: readonly RevokedKey[];
  /** Bundle digests, revoked whoever signed them. */
  readonly releases?: readonly string[];
}

/**
 * Revocations a verified catalog carries for its own publisher.
 *
 * @public
 */
export interface CatalogRevocations {
  /** Key ids of the catalog's publisher. */
  readonly keys: readonly string[];
  /** Digests of releases the catalog's publisher signed. */
  readonly releases: readonly string[];
}

/**
 * What a verified catalog contributes to a trust set.
 *
 * @public
 */
export interface VerifiedCatalogTrust {
  readonly publisher: string;
  readonly revoked: CatalogRevocations;
  readonly delegations: readonly VerifiedDelegation[];
}

/**
 * What `createTrust` takes.
 *
 * @public
 */
export interface TrustInput {
  /** Publishers made with `publisher()`. */
  readonly publishers: readonly Publisher[];
  /** The site ceiling: registered permissions, or `id:*`. */
  readonly ceiling: readonly string[];
  readonly revoked?: Revocations;
  /** Catalogs returned by `verifyCatalog`: their delegations and revocations apply. */
  readonly catalogs?: readonly VerifiedCatalogTrust[];
  /** Delegations returned by `verifyDelegation`. */
  readonly delegations?: readonly VerifiedDelegation[];
}

/**
 * A trust set, as `createTrust` returns it.
 *
 * @public
 */
export interface Trust {
  readonly publishers: readonly Publisher[];
  readonly ceiling: readonly string[];
}

/** A key a publisher may sign with. */
export interface TrustedKey {
  readonly keyId: string;
  readonly publicKey: string;
  readonly object: KeyObject;
  readonly use: readonly KeyUse[];
  /** Set for a delegated key: the last `issuedAt` it may sign. */
  readonly notAfter?: string;
}

/** What the verifiers read from a trust set. */
export interface TrustState {
  readonly publishers: ReadonlyMap<string, CompiledPublisher>;
  readonly ceiling: CompiledCeiling;
  readonly keys: ReadonlyMap<string, ReadonlyMap<string, readonly TrustedKey[]>>;
  readonly revokedKeys: ReadonlyMap<string, ReadonlySet<string>>;
  readonly revokedReleases: ReadonlySet<string>;
  readonly revokedReleasesBy: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Why no signature verified, in the order of how far a signature got.
 */
export type SignatureFailure =
  'unknown_key' | 'key_revoked' | 'key_use' | 'key_expired' | 'bad_signature';

const STAGES: readonly SignatureFailure[] = [
  'unknown_key',
  'key_revoked',
  'key_use',
  'key_expired',
  'bad_signature',
];

const MAX_REVOKED_KEYS = 1_000;
const MAX_REVOKED_RELEASES = 10_000;

const states = new WeakMap<Trust, TrustState>();

type Field = 'shape' | 'publishers' | 'ceiling' | 'revoked' | 'catalogs' | 'delegations';

function invalid(field: Field): Error {
  return new MarketplaceConfigErrors.Error('invalid_trust', { field });
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key) ?? new Set<V>();
  set.add(value);
  map.set(key, set);
}

function readRevocations(
  value: unknown,
  revokedKeys: Map<string, Set<string>>,
  revokedReleases: Set<string>,
): void {
  if (value === undefined) return;
  if (!isRecord(value) || !hasExactKeys(value, [], ['keys', 'releases'])) throw invalid('revoked');
  const keys = value.keys ?? [];
  const releases = value.releases ?? [];
  if (!Array.isArray(keys) || keys.length > MAX_REVOKED_KEYS) throw invalid('revoked');
  if (!Array.isArray(releases) || releases.length > MAX_REVOKED_RELEASES) throw invalid('revoked');
  for (const entry of keys as readonly unknown[]) {
    if (!isRecord(entry) || !hasExactKeys(entry, ['publisher', 'keyId'])) throw invalid('revoked');
    if (typeof entry.publisher !== 'string' || !matches(entry.keyId, KEY_ID_PATTERN)) {
      throw invalid('revoked');
    }
    addTo(revokedKeys, entry.publisher, entry.keyId);
  }
  for (const digest of releases as readonly unknown[]) {
    if (!matches(digest, DIGEST_PATTERN)) throw invalid('revoked');
    revokedReleases.add(digest);
  }
}

function readPublishers(value: unknown): Map<string, CompiledPublisher> {
  if (!Array.isArray(value)) throw invalid('publishers');
  const publishers = new Map<string, CompiledPublisher>();
  for (const entry of value as readonly unknown[]) {
    const checked = compiledPublisher(entry);
    if (checked === undefined) throw invalid('publishers');
    if (publishers.has(checked.id)) throw new MarketplaceConfigErrors.Error('duplicate_publisher');
    publishers.set(checked.id, checked);
  }
  return publishers;
}

function readCatalogs(value: unknown): readonly VerifiedCatalogTrust[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry: unknown) => isVerifiedCatalog(entry))) {
    throw invalid('catalogs');
  }
  return value as readonly VerifiedCatalogTrust[];
}

/** A verified delegation and the key it delegates. */
interface Delegated {
  readonly delegation: VerifiedDelegation;
  readonly key: TrustedKey;
}

function withKeys(value: unknown, field: Field): Delegated[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(field);
  return (value as readonly unknown[]).map((delegation) => {
    const key = delegatedKey(delegation);
    if (key === undefined) throw invalid(field);
    return { delegation: delegation as VerifiedDelegation, key };
  });
}

/** Whether one of the roots that signed `delegation` is a configured, unrevoked root key. */
function delegationHolds(
  delegation: VerifiedDelegation,
  publisher: CompiledPublisher,
  revoked: ReadonlySet<string> | undefined,
): boolean {
  return delegation.roots.some((root) => {
    const configured = publisher.keys.get(root.keyId);
    return (
      configured !== undefined &&
      configured.key.publicKey === root.publicKey &&
      configured.key.use.includes('root') &&
      revoked?.has(root.keyId) !== true
    );
  });
}

/** Whether two keys grant the same thing: one public key, the same uses and expiry. */
function sameGrant(left: TrustedKey, right: TrustedKey): boolean {
  return (
    left.publicKey === right.publicKey &&
    left.notAfter === right.notAfter &&
    left.use.length === right.use.length &&
    left.use.every((use) => right.use.includes(use))
  );
}

/**
 * Every key each publisher may sign with, by key id. A key delegated more than
 * once (a renewal with a later `notAfter`, a grant of another use) keeps each
 * grant as its own candidate, since `checkSignatures` tries them all: the
 * verdict then never depends on the order delegations and catalogs were
 * passed in. Only an identical grant is dropped.
 */
function buildKeys(
  publishers: ReadonlyMap<string, CompiledPublisher>,
  delegated: readonly Delegated[],
  revokedKeys: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, Map<string, TrustedKey[]>> {
  const keys = new Map<string, Map<string, TrustedKey[]>>();
  const add = (publisherId: string, key: TrustedKey): void => {
    const byId = keys.get(publisherId) ?? new Map<string, TrustedKey[]>();
    const candidates = byId.get(key.keyId) ?? [];
    if (candidates.some((existing) => sameGrant(existing, key))) return;
    candidates.push(key);
    byId.set(key.keyId, candidates);
    keys.set(publisherId, byId);
  };
  for (const publisher of publishers.values()) {
    for (const { key, object } of publisher.keys.values()) {
      add(
        publisher.id,
        Object.freeze({ keyId: key.id, publicKey: key.publicKey, object, use: key.use }),
      );
    }
  }
  for (const { delegation, key } of delegated) {
    const publisher = publishers.get(delegation.delegation.publisher);
    if (publisher === undefined) continue;
    if (delegationHolds(delegation, publisher, revokedKeys.get(publisher.id)))
      add(publisher.id, key);
  }
  return keys;
}

/**
 * Build a trust set. Throws `marketplace_config.invalid_trust` naming the
 * first input that is wrong (including a catalog or delegation that no
 * verifier returned) and `marketplace_config.duplicate_publisher`.
 *
 * @public
 */
export function createTrust(input: TrustInput): Trust {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ['publishers', 'ceiling'], ['revoked', 'catalogs', 'delegations'])
  ) {
    throw invalid('shape');
  }
  const publishers = readPublishers(input.publishers);
  const ceiling = compileCeiling(input.ceiling);
  if (ceiling === undefined) throw invalid('ceiling');
  const revokedKeys = new Map<string, Set<string>>();
  const revokedReleases = new Set<string>();
  const revokedReleasesBy = new Map<string, Set<string>>();
  readRevocations(input.revoked, revokedKeys, revokedReleases);
  const delegated = withKeys(input.delegations, 'delegations');
  for (const catalog of readCatalogs(input.catalogs)) {
    if (!publishers.has(catalog.publisher)) continue;
    for (const keyId of catalog.revoked.keys) addTo(revokedKeys, catalog.publisher, keyId);
    for (const digest of catalog.revoked.releases)
      addTo(revokedReleasesBy, catalog.publisher, digest);
    delegated.push(...withKeys(catalog.delegations, 'catalogs'));
  }
  const trust: Trust = Object.freeze({
    publishers: Object.freeze([...input.publishers]),
    ceiling: ceiling.entries,
  });
  states.set(
    trust,
    Object.freeze({
      publishers,
      ceiling,
      keys: buildKeys(publishers, delegated, revokedKeys),
      revokedKeys,
      revokedReleases,
      revokedReleasesBy,
    }),
  );
  return trust;
}

/** The state of a trust set `createTrust` built; throws `invalid_trust` for anything else. */
export function trustState(trust: unknown): TrustState {
  const state =
    typeof trust === 'object' && trust !== null ? states.get(trust as Trust) : undefined;
  if (state === undefined) throw invalid('shape');
  return state;
}

/** Whether `digest`, released by `publisher`, is revoked. */
export function isReleaseRevoked(state: TrustState, publisher: string, digest: string): boolean {
  return (
    state.revokedReleases.has(digest) ||
    state.revokedReleasesBy.get(publisher)?.has(digest) === true
  );
}

/** The outcome of checking a record's signatures. */
export type SignatureVerdict =
  | { readonly ok: true; readonly key: TrustedKey }
  | { readonly ok: false; readonly code: SignatureFailure };

/** What one signature check needs beyond the trust set. */
export interface SignatureCheck {
  readonly publisher: string;
  readonly signatures: readonly RecordSignature[];
  readonly message: Uint8Array;
  readonly use: KeyUse;
  readonly issuedAt: string;
  /** Keys this record's own context adds (a catalog's delegations). */
  readonly extraKeys?: readonly TrustedKey[];
  /** Key ids this record's own context revokes. */
  readonly extraRevoked?: ReadonlySet<string>;
}

function candidateStage(
  key: TrustedKey,
  check: SignatureCheck,
  signature: RecordSignature,
  revoked: ReadonlySet<string> | undefined,
): SignatureFailure | 'valid' {
  if (revoked?.has(key.keyId) === true || check.extraRevoked?.has(key.keyId) === true) {
    return 'key_revoked';
  }
  if (!key.use.includes(check.use)) return 'key_use';
  if (key.notAfter !== undefined && Date.parse(check.issuedAt) > Date.parse(key.notAfter)) {
    return 'key_expired';
  }
  return verifySignature(check.message, signature.sig, key.object) ? 'valid' : 'bad_signature';
}

/**
 * Check a record's signatures against the publisher's keys: the first one by a
 * key that may sign it wins; otherwise the furthest stage any signature
 * reached.
 */
export function checkSignatures(state: TrustState, check: SignatureCheck): SignatureVerdict {
  const configured = state.keys.get(check.publisher);
  const revoked = state.revokedKeys.get(check.publisher);
  let furthest = 0;
  for (const signature of check.signatures) {
    const candidates = [
      ...(configured?.get(signature.keyId) ?? []),
      ...(check.extraKeys ?? []).filter((key) => key.keyId === signature.keyId),
    ];
    for (const key of candidates) {
      const stage = candidateStage(key, check, signature, revoked);
      if (stage === 'valid') return { ok: true, key };
      furthest = Math.max(furthest, STAGES.indexOf(stage));
    }
  }
  return { ok: false, code: STAGES[furthest] ?? 'unknown_key' };
}
