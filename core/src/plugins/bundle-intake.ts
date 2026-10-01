/**
 * Bundle intake for the plugin installer: download a `.tgz` through
 * `guardedFetch` (every hop credential-free `https:`, resolved once and refused
 * when any address is private, connected to the vetted address, checked
 * against the caller's host list, within a byte and time bound), verify its
 * integrity (a checksum or a verified detached signature is mandatory unless
 * the caller explicitly allows an unverified bundle), extract it, and read the
 * embedded manifest. Nothing here touches `pluginsDir`, evaluates plugin code,
 * or echoes a URL (which may embed credentials).
 */

import { hashSync } from '../support/cryptography.server.js';
import {
  GuardedFetchError,
  type GuardedFetch,
  type GuardedFetchErrorCode,
} from '../support/guarded-fetch.server.js';

import { ArchiveError, extractTarGz } from './archive.js';
import { PluginInstallerError, type PluginInstallerErrorCode } from './installer-error.js';
import {
  PLUGIN_MANIFEST_FILENAME,
  PluginManifestError,
  parseBundleManifest,
  type PluginManifestV1,
} from './manifest/index.js';
import type { Awaitable } from '../contracts/awaitable.js';

/** Verifies a detached signature over the downloaded bundle bytes. */
export type VerifySignature = (data: Uint8Array, signature: string) => Awaitable<boolean>;

/** How long a whole download, redirects included, may take before it is aborted. */
export const DOWNLOAD_TIMEOUT_MS = 30_000;

/** How many redirects one download follows before it gives up. */
export const MAX_DOWNLOAD_REDIRECTS = 5;

/**
 * Who may serve a bundle. The list is checked on the submitted URL and again
 * on every redirect target, so a permitted host cannot hand the download to
 * one the caller never approved.
 */
export interface DownloadUrlPolicy {
  /** Host names (`URL#hostname`, compared case-insensitively) a download may reach. */
  readonly allowedHosts?: readonly string[];
}

/** Options for {@link downloadBundle}. */
export interface DownloadBundleOptions extends DownloadUrlPolicy {
  /** The outbound primitive; `guardedFetch` outside tests. */
  readonly fetch: GuardedFetch;
  /** Bound on the compressed bundle size, in bytes. */
  readonly maxBytes: number;
  /**
   * Let the download reach loopback and private addresses (and plain `http:`
   * to loopback). Only for a caller that is not relaying someone else's URL (a
   * developer at a terminal); never for a URL that arrives over a request.
   */
  readonly allowPrivateHosts?: boolean;
}

/** How each refusal of the outbound guard reads as an installer failure. */
const DOWNLOAD_FAILURES: Readonly<
  Partial<Record<GuardedFetchErrorCode, readonly [PluginInstallerErrorCode, string]>>
> = {
  invalid_options: ['invalid_options', 'plugin download options are invalid'],
  invalid_url: ['invalid_url', 'plugin download url must be credential-free https'],
  host_not_allowed: ['invalid_url', 'plugin download host is not allowed'],
  resolve_failed: ['fetch_failed', 'plugin download host could not be resolved'],
  blocked_address: [
    'private_address',
    'plugin download host resolves to a private network address',
  ],
  too_many_redirects: ['fetch_failed', 'plugin download redirected too many times'],
  too_large: ['oversize_download', 'plugin download exceeds the size limit'],
  timeout: ['fetch_failed', 'plugin download timed out'],
};

/**
 * Download the bundle at `url` through `options.fetch` within the byte and
 * time bounds, following at most {@link MAX_DOWNLOAD_REDIRECTS} redirects, each
 * one checked by the guard and the caller's host list before it is requested.
 * Anything but a 2xx final response fails.
 */
export async function downloadBundle(
  url: string,
  options: DownloadBundleOptions,
): Promise<Uint8Array> {
  let response;
  try {
    response = await options.fetch(url, {
      maxBytes: options.maxBytes,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      maxRedirects: MAX_DOWNLOAD_REDIRECTS,
      allowPrivate: options.allowPrivateHosts === true,
      ...(options.allowedHosts === undefined ? {} : { allowHosts: options.allowedHosts }),
    });
  } catch (error) {
    const failure = error instanceof GuardedFetchError ? DOWNLOAD_FAILURES[error.code] : undefined;
    throw failure === undefined
      ? new PluginInstallerError('fetch_failed', 'plugin download failed')
      : new PluginInstallerError(failure[0], failure[1]);
  }
  if (response.status < 200 || response.status > 299) {
    throw new PluginInstallerError('fetch_failed', 'plugin download failed');
  }
  return response.bytes;
}

/** Validate a caller's {@link DownloadUrlPolicy} before any request is made. */
export function assertDownloadUrlPolicy(policy: DownloadUrlPolicy): DownloadUrlPolicy {
  const { allowedHosts } = policy;
  if (
    allowedHosts !== undefined &&
    (!Array.isArray(allowedHosts) ||
      !allowedHosts.every((host) => typeof host === 'string' && host !== ''))
  ) {
    throw new PluginInstallerError(
      'invalid_options',
      'allowedHosts must be an array of non-empty host names',
    );
  }
  return allowedHosts === undefined ? {} : { allowedHosts };
}

/**
 * Verify the SHA-256 checksum the caller supplied for this artifact. Returns
 * `true` when a checksum was checked and matched, `false` when no checksum map
 * was supplied. A map that does not cover this artifact is an error: the
 * caller asked for verification, so silently skipping it would fail open.
 */
export function verifyChecksum(
  bytes: Uint8Array,
  checksums: Readonly<Record<string, string>> | undefined,
  url: string,
): boolean {
  if (checksums === undefined) return false;
  const expected = checksums[artifactName(url)];
  if (expected === undefined) {
    throw new PluginInstallerError(
      'checksum_missing',
      'plugin checksums do not cover the downloaded artifact',
    );
  }
  const digest = hashSync('SHA-256', bytes);
  if (!checksumMatches(digest, expected)) {
    throw new PluginInstallerError('checksum_mismatch', 'plugin checksum does not match');
  }
  return true;
}

/**
 * Verify a detached signature through `verifier`. Returns `true` when a
 * signature was verified, `false` when none was supplied. A signature that
 * cannot be verified (no verifier configured) is an error, never skipped: an
 * operator who passed one expects it to be checked.
 */
export async function verifySignature(
  bytes: Uint8Array,
  signature: string | undefined,
  verifier: VerifySignature | undefined,
): Promise<boolean> {
  if (signature === undefined) return false;
  if (verifier === undefined) {
    throw new PluginInstallerError(
      'signature_unverifiable',
      'a plugin signature was supplied but no signature verifier is configured',
    );
  }
  let valid: boolean;
  try {
    valid = await verifier(bytes, signature);
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new PluginInstallerError('signature_invalid', 'plugin signature verification failed');
  }
  return true;
}

/** The warning recorded when an install proceeds without any integrity check. */
export const UNVERIFIED_BUNDLE_WARNING =
  'plugin bundle integrity was not verified (installed with allowUnverified)';

/**
 * Require that the bundle was verified by a checksum or a signature. Without
 * either, the install is refused unless the caller explicitly opted out, in
 * which case a value-free warning is recorded for the caller to log. A bundle
 * that reached this point came over `https:`, or over plain `http:` from a
 * loopback address with `allowPrivateHosts`: {@link downloadBundle} refuses
 * any other transport before a byte is read.
 */
export function assertIntegrity(
  verified: boolean,
  allowUnverified: boolean | undefined,
  warnings: string[],
): void {
  if (verified) return;
  if (allowUnverified !== true) {
    throw new PluginInstallerError(
      'unverified_bundle',
      'plugin bundle has no checksum or signature; pass allowUnverified to install it anyway',
    );
  }
  warnings.push(UNVERIFIED_BUNDLE_WARNING);
}

/**
 * Validate a download URL: only `https:` and `http:` are fetched, and a URL that
 * does not parse is refused. Values are never echoed (a URL may embed
 * credentials).
 */
export function assertDownloadUrl(url: unknown): string {
  if (typeof url !== 'string' || url.length === 0) {
    throw new PluginInstallerError('invalid_url', 'plugin download url is invalid');
  }
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new PluginInstallerError('invalid_url', 'plugin download url is invalid');
  }
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new PluginInstallerError('invalid_url', 'plugin download url must use https or http');
  }
  return url;
}

/** Extract the gzipped tarball into path -> bytes entries. */
export function extractBundle(bytes: Uint8Array): Map<string, Uint8Array> {
  try {
    return extractTarGz(bytes);
  } catch (error) {
    if (error instanceof ArchiveError) {
      throw new PluginInstallerError('extract_failed', 'plugin archive could not be extracted');
    }
    throw error;
  }
}

/**
 * The bundle's files relative to its root: when every entry sits under one
 * shared top-level directory (the `package/` an `npm pack` tarball uses), that
 * directory is stripped; nothing deeper is. The installer stores exactly this
 * layout, so the manifest lands at `<pluginsDir>/<id>/<version>/manifest.json`.
 */
export function flattenBundleEntries(entries: Map<string, Uint8Array>): Map<string, Uint8Array> {
  let shared: string | undefined;
  for (const path of entries.keys()) {
    const slash = path.indexOf('/');
    if (slash === -1) return entries;
    const top = path.slice(0, slash);
    if (shared === undefined) shared = top;
    else if (shared !== top) return entries;
  }
  if (shared === undefined) return entries;
  const prefixLength = shared.length + 1;
  const flattened = new Map<string, Uint8Array>();
  for (const [path, data] of entries) flattened.set(path.slice(prefixLength), data);
  return flattened;
}

/**
 * Parse the manifest of a flattened bundle (see {@link flattenBundleEntries}).
 * The bundle must hold exactly one file named `manifest.json` (compared
 * case-insensitively, as a case-insensitive filesystem would), at its root.
 * Any second one is refused rather than ignored: a nested manifest is a
 * second plugin identity nobody reviewed, which anything that walks the
 * installed tree could pick up.
 */
export function parseExtractedManifest(entries: Map<string, Uint8Array>): PluginManifestV1 {
  const manifestPaths = [...entries.keys()].filter(
    (path) => basename(path).toLowerCase() === PLUGIN_MANIFEST_FILENAME,
  );
  if (manifestPaths.length > 1) {
    throw new PluginInstallerError(
      'multiple_manifests',
      'plugin archive contains more than one manifest',
    );
  }
  const raw =
    manifestPaths[0] === PLUGIN_MANIFEST_FILENAME ? entries.get(manifestPaths[0]) : undefined;
  if (raw === undefined) {
    throw new PluginInstallerError(
      'manifest_missing',
      'plugin archive has no manifest at its root',
    );
  }

  let text: string;
  try {
    text = new TextDecoder().decode(raw);
  } catch {
    throw new PluginInstallerError('manifest_invalid', 'plugin manifest is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PluginInstallerError('manifest_invalid', 'plugin manifest is invalid');
  }
  try {
    return parseBundleManifest(parsed);
  } catch (error) {
    if (error instanceof PluginManifestError) {
      throw new PluginInstallerError('manifest_invalid', 'plugin manifest is invalid');
    }
    throw error;
  }
}

/** The embedded manifest must name exactly the requested id and version. */
export function assertManifestMatches(
  manifest: PluginManifestV1,
  id: string,
  version: string,
): void {
  if (manifest.id !== id) {
    throw new PluginInstallerError(
      'manifest_mismatch',
      'plugin manifest id does not match the requested id',
    );
  }
  if (manifest.version !== version) {
    throw new PluginInstallerError(
      'manifest_mismatch',
      'plugin manifest version does not match the requested version',
    );
  }
}

/** Derive the bundle artifact name from a URL's path basename (query/fragment stripped). */
function artifactName(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split(/[?#]/)[0] ?? '';
  }
  const segments = pathname.split('/').filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? '';
}

/** Whether an actual sha256 hex digest matches an expected (possibly `sha256-` prefixed) value. */
function checksumMatches(actualHex: string, expected: string): boolean {
  const normalized = expected.trim().toLowerCase();
  const unprefixed = normalized.startsWith('sha256-')
    ? normalized.slice('sha256-'.length)
    : normalized;
  return unprefixed === actualHex.toLowerCase();
}

/** The last segment of a portable relative entry path. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
