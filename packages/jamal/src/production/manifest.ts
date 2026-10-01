/**
 * The release manifest v1: what one release is, written once into
 * `releases/<id>/manifest.json` and never changed.
 *
 * ```ts
 * { v: 1, releaseId, image: 'repo@sha256:…', git: { sha, dirty },
 *   roles: { web: { container, command, replicas } },
 *   secretNames, secretsSha256, configSha256, jsailsVersion,
 *   infra: { proxyImage, cacheProxyImage? }, release: { ran, exit, deferred? },
 *   previous?, createdAt, by }
 * ```
 *
 * `image` and the infra images are pinned by digest, so a rollback runs the
 * bytes the release ran, whatever its tag points at since. `secretsSha256`
 * is the SHA-256 of the release's secrets file (the manifest sits in the
 * release's 0700 directory, beside that file); `secretNames` lists the
 * variables it holds. `configSha256` digests the jamal config the release
 * was planned from ({@link configDigest}). `previous` is the release a
 * rollback from this one returns to, as the deploy recorded it in `state.json`. There is no status: whether a release is
 * live, previous, or dead is derived from `state.json`, the proxy, and the
 * containers.
 *
 * The manifest is written with `expect: absent` (create only) before the
 * release's container starts, so every container a host runs for the app is
 * named by a manifest. {@link parseManifest} is strict: an observed manifest
 * that is not exactly v1 is reported as unreadable, never trusted.
 */

import { createHash } from 'node:crypto';

import { defineErrors, type ErrorRegistry } from 'jsails/errors';

import { SecretRef, type JamalConfig } from '../config/index.js';
import { isPlainObject } from '../object-shape.js';
import { isRecordedText } from './host-state.js';
import { isPinnedImage } from './image-ref.js';
import { isReleaseId } from './release-id.js';

const MANIFEST_ERRORS = {
  invalid: {
    kind: 'invalid',
    message: 'the release manifest is not a v1 manifest',
  },
} as const;

/** `jamal_manifest.*`: a release manifest that is not v1. */
export const ManifestErrors: ErrorRegistry<'jamal_manifest', typeof MANIFEST_ERRORS> = defineErrors(
  'jamal_manifest',
  MANIFEST_ERRORS,
);

/** The one manifest format version. */
export const MANIFEST_VERSION = 1;

/** One role a release runs. */
export interface ManifestRole {
  /** The container the role runs in (one replica). */
  readonly container: string;
  /** The command after the image; empty runs the image's own `CMD`. */
  readonly command: readonly string[];
  readonly replicas: number;
}

/** What the release step did. */
export interface ManifestReleaseStep {
  readonly ran: boolean;
  /** Its exit status, or `null` when it did not run. */
  readonly exit: number | null;
  readonly deferred?: boolean;
}

/** The infrastructure images the release was served through, pinned by digest. */
export interface ManifestInfra {
  /** The kamal-proxy image running on the host, or `null` when none ran. */
  readonly proxyImage: string | null;
  /** The cache proxy's image, when the release is served through it. */
  readonly cacheProxyImage?: string;
}

/** A release manifest v1. */
export interface ReleaseManifest {
  readonly v: typeof MANIFEST_VERSION;
  readonly releaseId: string;
  readonly image: string;
  readonly git: { readonly sha: string; readonly dirty: boolean };
  readonly roles: Readonly<Record<string, ManifestRole>>;
  readonly secretNames: readonly string[];
  readonly secretsSha256: string;
  readonly configSha256: string;
  readonly jsailsVersion: string;
  readonly infra: ManifestInfra;
  readonly release: ManifestReleaseStep;
  readonly previous?: string;
  readonly createdAt: string;
  readonly by: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const ROLE_NAME = /^[a-z][a-z0-9-]{0,30}$/;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether `keys` are exactly the own keys of `value`, optional ones allowed. */
function hasKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function invalid(): Error {
  return new ManifestErrors.Error('invalid');
}

function role(value: unknown): ManifestRole {
  if (!isPlainObject(value) || !hasKeys(value, ['container', 'command', 'replicas'])) {
    throw invalid();
  }
  const { container, command, replicas } = value;
  if (
    typeof container !== 'string' ||
    !CONTAINER_NAME.test(container) ||
    !Array.isArray(command) ||
    !command.every((token) => typeof token === 'string' && !token.includes('\0')) ||
    typeof replicas !== 'number' ||
    !Number.isSafeInteger(replicas) ||
    replicas < 1
  ) {
    throw invalid();
  }
  return { container, command: [...(command as string[])], replicas };
}

function roles(value: unknown): Readonly<Record<string, ManifestRole>> {
  if (!isPlainObject(value) || Object.keys(value).length === 0) throw invalid();
  const result: Record<string, ManifestRole> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!ROLE_NAME.test(name)) throw invalid();
    result[name] = role(entry);
  }
  return result;
}

function infra(value: unknown): ManifestInfra {
  if (!isPlainObject(value) || !hasKeys(value, ['proxyImage'], ['cacheProxyImage'])) {
    throw invalid();
  }
  const { proxyImage, cacheProxyImage } = value;
  if (proxyImage !== null && (typeof proxyImage !== 'string' || !isPinnedImage(proxyImage))) {
    throw invalid();
  }
  if (cacheProxyImage === undefined) return { proxyImage };
  if (typeof cacheProxyImage !== 'string' || !isPinnedImage(cacheProxyImage)) throw invalid();
  return { proxyImage, cacheProxyImage };
}

function releaseStep(value: unknown): ManifestReleaseStep {
  if (!isPlainObject(value) || !hasKeys(value, ['ran', 'exit'], ['deferred'])) throw invalid();
  const { ran, exit, deferred } = value;
  if (
    typeof ran !== 'boolean' ||
    (exit !== null && (typeof exit !== 'number' || !Number.isSafeInteger(exit))) ||
    (deferred !== undefined && typeof deferred !== 'boolean')
  ) {
    throw invalid();
  }
  return deferred === undefined ? { ran, exit } : { ran, exit, deferred };
}

/** Check a candidate manifest, throwing `jamal_manifest.invalid` when it is not v1. */
export function assertManifest(value: unknown): ReleaseManifest {
  const required = [
    'v',
    'releaseId',
    'image',
    'git',
    'roles',
    'secretNames',
    'secretsSha256',
    'configSha256',
    'jsailsVersion',
    'infra',
    'release',
    'createdAt',
    'by',
  ];
  if (!isPlainObject(value) || !hasKeys(value, required, ['previous'])) throw invalid();
  const { v, releaseId, image, git, secretNames, secretsSha256, configSha256 } = value;
  const { jsailsVersion, previous, createdAt, by } = value;
  if (
    v !== MANIFEST_VERSION ||
    typeof releaseId !== 'string' ||
    !isReleaseId(releaseId) ||
    typeof image !== 'string' ||
    !isPinnedImage(image) ||
    !isPlainObject(git) ||
    !hasKeys(git, ['sha', 'dirty']) ||
    typeof git.sha !== 'string' ||
    !GIT_SHA.test(git.sha) ||
    typeof git.dirty !== 'boolean' ||
    !Array.isArray(secretNames) ||
    !secretNames.every((name) => typeof name === 'string' && ENV_NAME.test(name)) ||
    typeof secretsSha256 !== 'string' ||
    !SHA256_HEX.test(secretsSha256) ||
    typeof configSha256 !== 'string' ||
    !SHA256_HEX.test(configSha256) ||
    !isRecordedText(jsailsVersion) ||
    (previous !== undefined &&
      (typeof previous !== 'string' || !isReleaseId(previous) || previous === releaseId)) ||
    !isRecordedText(createdAt) ||
    !isRecordedText(by)
  ) {
    throw invalid();
  }
  const names = secretNames as string[];
  if (names.some((name, index) => index > 0 && names[index - 1]! >= name)) throw invalid();
  return {
    v: MANIFEST_VERSION,
    releaseId,
    image,
    git: { sha: git.sha, dirty: git.dirty },
    roles: roles(value.roles),
    secretNames: [...names],
    secretsSha256,
    configSha256,
    jsailsVersion,
    infra: infra(value.infra),
    release: releaseStep(value.release),
    ...(previous === undefined ? {} : { previous }),
    createdAt,
    by,
  };
}

/** The bytes of `manifest`: checked, keys in their declared order, two-space indent. */
export function encodeManifest(manifest: ReleaseManifest): Uint8Array {
  const checked = assertManifest(manifest);
  return Buffer.from(`${JSON.stringify(checked, null, 2)}\n`, 'utf8');
}

/** Parse a manifest's bytes; throws `jamal_manifest.invalid` for anything but v1. */
export function parseManifest(bytes: Uint8Array): ReleaseManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw invalid();
  }
  return assertManifest(parsed);
}

/** `value` as JSON with every object's keys sorted, secrets as their names. */
function canonical(value: unknown): unknown {
  if (value instanceof SecretRef) return { secret: value.name };
  if (Array.isArray(value)) return value.map((entry) => canonical(entry));
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) sorted[key] = canonical(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * The SHA-256 hex of the normalized config as canonical JSON (sorted keys, a
 * secret reference as its name), so two releases planned from one config
 * share it and any change to the config changes it.
 */
export function configDigest(config: JamalConfig): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(config)), 'utf8')
    .digest('hex');
}
