/**
 * The catalog document a publisher signs:
 *
 * ```
 * { catalog: { v: 1, publisher, sequence, issuedAt, expiresAt,
 *              delegations: [SignedDelegation],
 *              revoked: { keys: [keyId], releases: [digest] },
 *              plugins: [{ id, name, summary, category,
 *                          releases: [{ version, urls, changelog, yanked?, envelope }] }] },
 *   signatures: [{ keyId, sig }] }
 * ```
 *
 * Every object is closed. `sequence` is a non-negative safe integer that grows
 * with every catalog the publisher issues; `issuedAt` is before `expiresAt`.
 * Plugin ids and the versions of one plugin are unique, each release's
 * envelope names that plugin, version and the catalog's publisher, its URLs
 * are 1 to 8 distinct credential-free https URLs, and a `yanked` release stays
 * verifiable (a lock may pin it) but is not offered. Bounds: 500 plugins, 100
 * releases each, 64 delegations, 1,000 revoked keys, 10,000 revoked releases,
 * name 100 and summary 280 characters on one line, changelog 10,000
 * characters, category a lowercase slug.
 */

import { PLUGIN_ID_PATTERN } from 'jsails/internal/plugin-manifest';

import { isWellFormedText } from '../archive/well-formed.js';
import { DIGEST_PATTERN } from '../intake/digest.js';
import { parseSignedDelegation, type SignedDelegation } from '../trust/delegation.js';
import {
  hasExactKeys,
  isHttpsUrl,
  isLine,
  isRecord,
  isTimestamp,
  KEY_ID_PATTERN,
  matches,
  parseSignatures,
  PUBLISHER_ID_PATTERN,
  type RecordSignature,
} from '../trust/field-checks.js';
import { parseReleaseEnvelope, type ReleaseEnvelope } from '../trust/statement.js';
import type { CatalogRevocations } from '../trust/trust-set.js';

/**
 * One release a catalog offers.
 *
 * @public
 */
export interface CatalogRelease {
  readonly version: string;
  /** Where the bundle can be downloaded; any one serves the same bytes. */
  readonly urls: readonly string[];
  readonly changelog: string;
  /** Withdrawn from offer; still verifiable for a site that pinned it. */
  readonly yanked?: boolean;
  readonly envelope: ReleaseEnvelope;
}

/**
 * One plugin a catalog lists.
 *
 * @public
 */
export interface CatalogPlugin {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly category: string;
  readonly releases: readonly CatalogRelease[];
}

/**
 * A catalog, version 1.
 *
 * @public
 */
export interface Catalog {
  readonly v: 1;
  readonly publisher: string;
  readonly sequence: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly delegations: readonly SignedDelegation[];
  readonly revoked: CatalogRevocations;
  readonly plugins: readonly CatalogPlugin[];
}

/**
 * A catalog with its signatures.
 *
 * @public
 */
export interface SignedCatalog {
  readonly catalog: Catalog;
  readonly signatures: readonly RecordSignature[];
}

const CATALOG_KEYS = [
  'v',
  'publisher',
  'sequence',
  'issuedAt',
  'expiresAt',
  'delegations',
  'revoked',
  'plugins',
];
const CATEGORY = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_PLUGINS = 500;
const MAX_RELEASES = 100;
const MAX_URLS = 8;
const MAX_DELEGATIONS = 64;
const MAX_REVOKED_KEYS = 1_000;
const MAX_REVOKED_RELEASES = 10_000;
const MAX_CHANGELOG = 10_000;

function list(value: unknown, max: number, min = 0): readonly unknown[] | undefined {
  return Array.isArray(value) && value.length >= min && value.length <= max
    ? (value as readonly unknown[])
    : undefined;
}

/** Every item parsed, or `undefined` when one fails or two share a key. */
function parseAll<T>(
  items: readonly unknown[],
  parse: (item: unknown) => T | undefined,
  key: (item: T) => string,
): readonly T[] | undefined {
  const parsed: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const value = parse(item);
    if (value === undefined || seen.has(key(value))) return undefined;
    seen.add(key(value));
    parsed.push(value);
  }
  return Object.freeze(parsed);
}

function parseUrls(value: unknown): readonly string[] | undefined {
  const urls = list(value, MAX_URLS, 1);
  if (urls === undefined) return undefined;
  return parseAll(
    urls,
    (url) => (isHttpsUrl(url) ? url : undefined),
    (url) => url,
  );
}

function parseRelease(
  value: unknown,
  pluginId: string,
  publisher: string,
): CatalogRelease | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'urls', 'changelog', 'envelope'], ['yanked'])
  ) {
    return undefined;
  }
  const { version, changelog, yanked } = value;
  const urls = parseUrls(value.urls);
  const envelope = parseReleaseEnvelope(value.envelope);
  if (urls === undefined || envelope === undefined || typeof version !== 'string') return undefined;
  if (
    typeof changelog !== 'string' ||
    changelog.length > MAX_CHANGELOG ||
    !isWellFormedText(changelog)
  ) {
    return undefined;
  }
  if (yanked !== undefined && typeof yanked !== 'boolean') return undefined;
  const { statement } = envelope;
  if (
    statement.id !== pluginId ||
    statement.version !== version ||
    statement.publisher !== publisher
  ) {
    return undefined;
  }
  return Object.freeze({
    version,
    urls,
    changelog,
    ...(yanked === undefined ? {} : { yanked }),
    envelope,
  });
}

function parsePlugin(value: unknown, publisher: string): CatalogPlugin | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'name', 'summary', 'category', 'releases'])) {
    return undefined;
  }
  const { id, name, summary, category } = value;
  if (!matches(id, PLUGIN_ID_PATTERN) || !isLine(name, 100) || !isLine(summary, 280))
    return undefined;
  if (!matches(category, CATEGORY)) return undefined;
  const items = list(value.releases, MAX_RELEASES);
  const releases =
    items === undefined
      ? undefined
      : parseAll(
          items,
          (item) => parseRelease(item, id, publisher),
          (release) => release.version,
        );
  if (releases === undefined) return undefined;
  return Object.freeze({ id, name, summary, category, releases });
}

function parseRevoked(value: unknown): CatalogRevocations | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['keys', 'releases'])) return undefined;
  const keyItems = list(value.keys, MAX_REVOKED_KEYS);
  const releaseItems = list(value.releases, MAX_REVOKED_RELEASES);
  if (keyItems === undefined || releaseItems === undefined) return undefined;
  const keys = parseAll(
    keyItems,
    (key) => (matches(key, KEY_ID_PATTERN) ? key : undefined),
    (key) => key,
  );
  const releases = parseAll(
    releaseItems,
    (digest) => (matches(digest, DIGEST_PATTERN) ? digest : undefined),
    (digest) => digest,
  );
  if (keys === undefined || releases === undefined) return undefined;
  return Object.freeze({ keys, releases });
}

function parseCatalog(value: unknown): Catalog | undefined {
  if (!isRecord(value) || !hasExactKeys(value, CATALOG_KEYS)) return undefined;
  const { v, publisher, sequence, issuedAt, expiresAt } = value;
  if (v !== 1 || !matches(publisher, PUBLISHER_ID_PATTERN)) return undefined;
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) return undefined;
  if (!isTimestamp(issuedAt) || !isTimestamp(expiresAt) || !(issuedAt < expiresAt))
    return undefined;
  const delegationItems = list(value.delegations, MAX_DELEGATIONS);
  const delegations =
    delegationItems === undefined
      ? undefined
      : parseAll(
          delegationItems,
          parseSignedDelegation,
          (signed) => `${signed.delegation.keyId} ${signed.delegation.publicKey}`,
        );
  const revoked = parseRevoked(value.revoked);
  const pluginItems = list(value.plugins, MAX_PLUGINS);
  const plugins =
    pluginItems === undefined
      ? undefined
      : parseAll(
          pluginItems,
          (item) => parsePlugin(item, publisher),
          (plugin) => plugin.id,
        );
  if (delegations === undefined || revoked === undefined || plugins === undefined) return undefined;
  return Object.freeze({
    v: 1,
    publisher,
    sequence: sequence as number,
    issuedAt,
    expiresAt,
    delegations,
    revoked,
    plugins,
  });
}

/** A checked signed catalog, or `undefined`. */
export function parseSignedCatalog(value: unknown): SignedCatalog | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['catalog', 'signatures'])) return undefined;
  const catalog = parseCatalog(value.catalog);
  const signatures = parseSignatures(value.signatures);
  if (catalog === undefined || signatures === undefined) return undefined;
  return Object.freeze({ catalog, signatures });
}
