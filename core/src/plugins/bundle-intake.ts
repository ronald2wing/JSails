/**
 * Bundle intake for the plugin installer: download a `.tgz` within a byte and
 * time bound, verify its integrity (a checksum or a verified detached signature
 * is mandatory unless the caller explicitly allows an unverified bundle),
 * extract it, and read the embedded manifest. Nothing here touches `pluginsDir`, evaluates
 * plugin code, or echoes a URL (which may embed credentials).
 */

import { isIPv4 } from 'node:net';

import { readStreamBounded } from '../support/bytes.js';
import { hashSync } from '../support/cryptography.server.js';
import { Async } from '../support/async.js';

import { ArchiveError, extractTarGz } from './archive.js';
import { PluginInstallerError } from './installer-error.js';
import {
  PLUGIN_MANIFEST_FILENAME,
  PluginManifestError,
  parsePluginManifest,
  type PluginManifest,
} from './manifest/index.js';
import type { Awaitable } from '../contracts/awaitable.js';

/** Injectable download seam: a fetch that resolves a `Response` for the bundle. */
export type PluginFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Verifies a detached signature over the downloaded bundle bytes. */
export type VerifySignature = (data: Uint8Array, signature: string) => Awaitable<boolean>;

/** How long a single download may take before it is aborted. */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;

/** Options for {@link downloadBundle}. */
export interface DownloadBundleOptions {
  readonly fetch: PluginFetch;
  /** Bound on the compressed bundle size, in bytes. */
  readonly maxBytes: number;
}

/** Download the bundle at `url` within the byte and time bounds. */
export async function downloadBundle(
  url: string,
  options: DownloadBundleOptions,
): Promise<Uint8Array> {
  const timeout = Async.timeout(DEFAULT_DOWNLOAD_TIMEOUT_MS);
  let response: Response;
  try {
    try {
      response = await options.fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: timeout.signal,
      });
    } catch {
      // Sanitized: the fetch error (and any URL it embeds, including
      // credentials) is never propagated.
      throw new PluginInstallerError('fetch_failed', 'plugin download failed');
    }

    if (!response.ok) {
      throw new PluginInstallerError('fetch_failed', 'plugin download failed');
    }

    return await readStreamBounded(response.body, options.maxBytes, oversizeDownload);
  } catch (error) {
    if (error instanceof PluginInstallerError) throw error;
    throw new PluginInstallerError('fetch_failed', 'plugin download failed');
  } finally {
    timeout.clear();
  }
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
 * which case a value-free warning is recorded for the caller to log.
 *
 * The opt-out does not extend to plain `http:` from a non-loopback host: with
 * no checksum or signature, transport security is the only thing standing
 * between an on-path attacker and code imported at the next boot. A verified
 * bundle may still come over `http:`, since its bytes are checked anyway.
 */
export function assertIntegrity(
  verified: boolean,
  allowUnverified: boolean | undefined,
  url: string,
  warnings: string[],
): void {
  if (verified) return;
  if (allowUnverified !== true) {
    throw new PluginInstallerError(
      'unverified_bundle',
      'plugin bundle has no checksum or signature; pass allowUnverified to install it anyway',
    );
  }
  const parsed = new URL(url);
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    throw new PluginInstallerError(
      'invalid_url',
      'an unverified plugin bundle must be downloaded over https (or http from loopback)',
    );
  }
  warnings.push(UNVERIFIED_BUNDLE_WARNING);
}

/** `localhost`, `127.0.0.0/8`, or `::1`, as `URL#hostname` spells them. */
function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  return isIPv4(hostname) && hostname.startsWith('127.');
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

/** Locate the shallowest unique manifest among the entries and parse it. */
export function parseExtractedManifest(entries: Map<string, Uint8Array>): PluginManifest {
  const manifestPaths = [...entries.keys()]
    .filter(
      (path) => path === PLUGIN_MANIFEST_FILENAME || path.endsWith(`/${PLUGIN_MANIFEST_FILENAME}`),
    )
    .sort((a, b) => pathDepth(a) - pathDepth(b));

  const shallowest = manifestPaths[0];
  if (shallowest === undefined) {
    throw new PluginInstallerError('manifest_missing', 'plugin archive has no manifest');
  }
  const next = manifestPaths[1];
  if (next !== undefined && pathDepth(next) === pathDepth(shallowest)) {
    throw new PluginInstallerError(
      'manifest_ambiguous',
      'plugin archive has an ambiguous manifest',
    );
  }

  const raw = entries.get(shallowest);
  if (raw === undefined) {
    throw new PluginInstallerError('manifest_missing', 'plugin archive has no manifest');
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
    return parsePluginManifest(parsed);
  } catch (error) {
    if (error instanceof PluginManifestError) {
      throw new PluginInstallerError('manifest_invalid', 'plugin manifest is invalid');
    }
    throw error;
  }
}

/** The embedded manifest must name exactly the requested id and version. */
export function assertManifestMatches(manifest: PluginManifest, id: string, version: string): void {
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

/** The overflow error raised when a download exceeds `maxBytes`. */
function oversizeDownload(): never {
  throw new PluginInstallerError('oversize_download', 'plugin download exceeds the size limit');
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

/** The number of path segments in a portable relative entry path. */
function pathDepth(path: string): number {
  return path.split('/').length;
}
