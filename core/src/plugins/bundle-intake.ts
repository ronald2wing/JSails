/**
 * Bundle intake for the plugin installer: download a `.tgz` within a byte and
 * time bound, verify its optional checksum and detached signature, extract it,
 * and read the embedded manifest. Nothing here touches `pluginsDir`, evaluates
 * plugin code, or echoes a URL (which may embed credentials).
 */

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

/** Verify the SHA-256 checksum the manifest lists for this artifact, when it lists one. */
export function verifyChecksum(
  bytes: Uint8Array,
  checksums: Readonly<Record<string, string>> | undefined,
  url: string,
): void {
  if (checksums === undefined) return;
  const expected = checksums[artifactName(url)];
  if (expected === undefined) return; // the map does not cover this artifact.
  const digest = hashSync('SHA-256', bytes);
  if (!checksumMatches(digest, expected)) {
    throw new PluginInstallerError('checksum_mismatch', 'plugin checksum does not match');
  }
}

/**
 * Verify a detached signature through `verifier`; without a verifier a provided
 * signature is skipped with a warning rather than silently trusted.
 */
export async function verifySignature(
  bytes: Uint8Array,
  signature: string | undefined,
  verifier: VerifySignature | undefined,
  warnings: string[],
): Promise<void> {
  if (signature === undefined) return; // nothing to verify.
  if (verifier === undefined) {
    warnings.push('plugin signature was not verified');
    return;
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
