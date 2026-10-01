/**
 * The release statement: what a publisher vouches for when it signs a release,
 * detached from the bundle so a digest beside the bytes is never mistaken for
 * authority. Its envelope is `{ statement, signatures: [{ keyId, sig }] }`,
 * each signature over the `release` signing message of the statement.
 *
 * Both objects are closed (an unknown member is refused; a new member is a new
 * `v`). `permissions` are registered permissions, unique and sorted by UTF-16
 * code units, so one release has one statement; `issuedAt` is a UTC timestamp
 * in `Date#toISOString` form; `provenance` optionally names the source
 * repository (an https URL), the commit (40 or 64 hex characters) and the
 * build run that produced the bundle.
 */

import {
  isValidSemverRange,
  isValidSemverVersion,
  parsePermission,
  PLUGIN_ID_PATTERN,
} from 'jsails/internal/plugin-manifest';

import { ARCHIVE_LIMITS } from '../archive/limits.js';
import { DIGEST_PATTERN } from '../intake/digest.js';
import {
  hasExactKeys,
  isHttpsUrl,
  isLine,
  isRecord,
  isTimestamp,
  matches,
  parseSignatures,
  PUBLISHER_ID_PATTERN,
  type RecordSignature,
} from './field-checks.js';

/**
 * Where a release was built.
 *
 * @public
 */
export interface ReleaseProvenance {
  /** The source repository, an https URL. */
  readonly repo: string;
  /** The commit, 40 or 64 lowercase hex characters. */
  readonly commit: string;
  /** The build run, as the CI system names it. */
  readonly run: string;
}

/**
 * A release statement, version 1.
 *
 * @public
 */
export interface ReleaseStatement {
  readonly v: 1;
  readonly id: string;
  readonly version: string;
  /** SHA-256 of the bundle archive, lowercase hex. */
  readonly digest: string;
  /** Byte length of the bundle archive. */
  readonly size: number;
  /** SHA-256 of the bundle's `manifest.json`, lowercase hex. */
  readonly manifestDigest: string;
  /** The manifest's permissions, unique and sorted. */
  readonly permissions: readonly string[];
  readonly jsailsCompat: string;
  readonly publisher: string;
  readonly issuedAt: string;
  readonly provenance?: ReleaseProvenance;
}

/**
 * A detached, signed release statement.
 *
 * @public
 */
export interface ReleaseEnvelope {
  readonly statement: ReleaseStatement;
  readonly signatures: readonly RecordSignature[];
}

const MAX_ID_LENGTH = 214;
const MAX_VERSION_LENGTH = 256;
const MAX_PERMISSIONS = 100;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const STATEMENT_KEYS = [
  'v',
  'id',
  'version',
  'digest',
  'size',
  'manifestDigest',
  'permissions',
  'jsailsCompat',
  'publisher',
  'issuedAt',
];

function parsePermissions(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_PERMISSIONS) return undefined;
  const permissions = value as readonly unknown[];
  for (let index = 0; index < permissions.length; index += 1) {
    const permission = permissions[index];
    if (typeof permission !== 'string' || !parsePermission(permission).ok) return undefined;
    const previous = permissions[index - 1];
    if (typeof previous === 'string' && !(previous < permission)) return undefined;
  }
  return Object.freeze([...(permissions as readonly string[])]);
}

function parseProvenance(value: unknown): ReleaseProvenance | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['repo', 'commit', 'run'])) return undefined;
  const { repo, commit, run } = value;
  if (!isHttpsUrl(repo) || !matches(commit, COMMIT) || !isLine(run, 256)) return undefined;
  return Object.freeze({ repo, commit, run });
}

/** A checked statement, or `undefined`. */
export function parseStatement(value: unknown): ReleaseStatement | undefined {
  if (!isRecord(value) || !hasExactKeys(value, STATEMENT_KEYS, ['provenance'])) return undefined;
  const { v, id, version, digest, size, manifestDigest, jsailsCompat, publisher, issuedAt } = value;
  if (v !== 1) return undefined;
  if (!matches(id, PLUGIN_ID_PATTERN) || id.length > MAX_ID_LENGTH) return undefined;
  if (typeof version !== 'string' || version.length > MAX_VERSION_LENGTH) return undefined;
  if (!isValidSemverVersion(version)) return undefined;
  if (!matches(digest, DIGEST_PATTERN) || !matches(manifestDigest, DIGEST_PATTERN))
    return undefined;
  if (!Number.isSafeInteger(size) || (size as number) < 1) return undefined;
  if ((size as number) > ARCHIVE_LIMITS.maxCompressedBytes) return undefined;
  if (typeof jsailsCompat !== 'string' || !isValidSemverRange(jsailsCompat)) return undefined;
  if (!matches(publisher, PUBLISHER_ID_PATTERN) || !isTimestamp(issuedAt)) return undefined;
  const permissions = parsePermissions(value.permissions);
  if (permissions === undefined) return undefined;
  let provenance: ReleaseProvenance | undefined;
  if (Object.hasOwn(value, 'provenance')) {
    provenance = parseProvenance(value.provenance);
    if (provenance === undefined) return undefined;
  }
  return Object.freeze({
    v: 1,
    id,
    version,
    digest,
    size: size as number,
    manifestDigest,
    permissions,
    jsailsCompat,
    publisher,
    issuedAt,
    ...(provenance === undefined ? {} : { provenance }),
  });
}

/** A checked release envelope, or `undefined`. */
export function parseReleaseEnvelope(value: unknown): ReleaseEnvelope | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['statement', 'signatures'])) return undefined;
  const statement = parseStatement(value.statement);
  const signatures = parseSignatures(value.signatures);
  if (statement === undefined || signatures === undefined) return undefined;
  return Object.freeze({ statement, signatures });
}
