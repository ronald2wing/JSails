/**
 * Bundle intake: archive bytes to a bundle, without running or importing any
 * of it.
 *
 * The archive is read by the bundle reader (`archive/`). When every file sits
 * under one shared top-level directory (the `package/` of `npm pack`), that
 * directory is stripped; nothing deeper ever is. The result must hold exactly
 * one file named `manifest.json` (compared case-insensitively, as a
 * case-insensitive file system would), and it must be `manifest.json` at the
 * root: a nested one is a second plugin identity nobody reviewed, so it is
 * refused rather than ignored. The manifest is parsed as a bundle manifest, and
 * the entry module and the declared schema file must be in the bundle.
 *
 * A bundle's digest is the SHA-256 of the archive bytes exactly as received,
 * which is what a release statement signs; `manifestDigest` is the SHA-256 of
 * the `manifest.json` bytes.
 */

import {
  checkPluginManifest,
  PLUGIN_MANIFEST_FILENAME,
  type PluginManifestV1,
} from 'jsails/internal/plugin-manifest';

import type { ArchiveLimits } from '../archive/limits.js';
import { readTarGz, type ArchiveFiles } from '../archive/tar-reader.js';
import { sha256Hex } from './digest.js';
import { IntakeErrors } from './intake-errors.js';

/**
 * An opened bundle. `files` are relative to the bundle root.
 *
 * @public
 */
export interface OpenedBundle {
  /** SHA-256 of the archive bytes, lowercase hex. */
  readonly digest: string;
  /** Byte length of the archive. */
  readonly size: number;
  readonly manifest: PluginManifestV1;
  /** SHA-256 of the `manifest.json` bytes, lowercase hex. */
  readonly manifestDigest: string;
  readonly files: ArchiveFiles;
}

/**
 * Options for {@link openBundle}.
 *
 * @public
 */
export interface OpenBundleOptions {
  /** Tighter archive limits than the reader's ceilings. */
  readonly limits?: Partial<ArchiveLimits>;
}

const MAX_MANIFEST_BYTES = 256 * 1024;

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function stripSharedRoot(files: ArchiveFiles): ArchiveFiles {
  let root: string | undefined;
  for (const path of files.keys()) {
    const slash = path.indexOf('/');
    if (slash === -1) return files;
    const top = path.slice(0, slash);
    if (root === undefined) root = top;
    else if (root !== top) return files;
  }
  if (root === undefined) return files;
  const strip = root.length + 1;
  return new Map([...files].map(([path, data]) => [path.slice(strip), data]));
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function readManifest(files: ArchiveFiles): Uint8Array {
  const named = [...files.keys()].filter(
    (path) => basename(path).toLowerCase() === PLUGIN_MANIFEST_FILENAME,
  );
  if (named.length > 1) throw new IntakeErrors.Error('multiple_manifests');
  const raw = named[0] === PLUGIN_MANIFEST_FILENAME ? files.get(named[0]) : undefined;
  if (raw === undefined) throw new IntakeErrors.Error('manifest_missing');
  return raw;
}

function parseManifest(raw: Uint8Array): PluginManifestV1 {
  if (raw.byteLength > MAX_MANIFEST_BYTES) throw new IntakeErrors.Error('manifest_unreadable');
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(raw));
  } catch {
    // Not UTF-8 or not JSON: the decoder's and the parser's messages may quote the input.
    throw new IntakeErrors.Error('manifest_unreadable');
  }
  const result = checkPluginManifest(parsed, 'bundle');
  if (!result.ok) {
    throw new IntakeErrors.Error('manifest_invalid', {}, { payload: { issues: result.issues } });
  }
  return result.manifest;
}

function bundlePath(path: string): string {
  return path.startsWith('./') ? path.slice(2) : path;
}

/**
 * Read and check a bundle archive. Throws a `bundle_archive.*` error for an
 * archive the reader refuses and a `bundle_intake.*` error for a bundle whose
 * manifest is missing, duplicated, unreadable or invalid, or whose entry or
 * schema file is absent.
 *
 * @public
 */
export function openBundle(bytes: Uint8Array, options: OpenBundleOptions = {}): OpenedBundle {
  const files = stripSharedRoot(readTarGz(bytes, options.limits));
  const raw = readManifest(files);
  const manifest = parseManifest(raw);
  if (!files.has(bundlePath(manifest.entry))) {
    throw new IntakeErrors.Error('missing_file', { field: 'entry' });
  }
  const schemaFile = manifest.schema?.file;
  if (schemaFile !== undefined && !files.has(bundlePath(schemaFile))) {
    throw new IntakeErrors.Error('missing_file', { field: 'schema' });
  }
  return Object.freeze({
    digest: sha256Hex(bytes),
    size: bytes.byteLength,
    manifest,
    manifestDigest: sha256Hex(raw),
    files,
  });
}
