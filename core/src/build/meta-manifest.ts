/**
 * The `.jsails/manifest.json` staleness record.
 *
 * `jsails build:meta` derives every artifact from the authoring tree, but only
 * `autoload.json` is read back at runtime, and its staleness was detected by a
 * schema version constant alone — a stale-but-valid-version artifact was
 * trusted silently. This module records a **content hash of every source file
 * the scan read**, so a consumer can prove the artifacts still describe the
 * tree before trusting them.
 *
 * Content hashes, not mtimes: an mtime changes on checkout, on a clock skew,
 * and on a `touch`, so it reports staleness that is not real and misses a
 * change that preserved the timestamp. A content hash is deterministic and
 * portable, and re-reading the convention directories to hash them is cheaper
 * than the parse the scan would otherwise repeat.
 *
 * The manifest is the single staleness authority for the whole `.jsails/`
 * generation, so the code index (see `code-index.ts`) reuses it rather than
 * carrying a second fingerprint.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONVENTION_DIRS, SOURCE_EXTENSIONS } from '../compiler/conventions.js';
import { walkSortedFiles } from '../compiler/sorted-file-walk.js';
import { JsailsError } from '../errors/jsails-error.js';

/** The artifact file name, relative to `.jsails/`. */
export const META_MANIFEST_FILE = 'manifest.json';

/** Schema version of the manifest. Bumping it invalidates every existing one. */
export const META_MANIFEST_VERSION = 1;

/**
 * The directories the scan reads. A file outside these never reaches an
 * artifact, so it never invalidates one.
 */
const SCANNED_DIRS: readonly string[] = [
  CONVENTION_DIRS.pages,
  CONVENTION_DIRS.api,
  CONVENTION_DIRS.jobs,
  CONVENTION_DIRS.models,
  CONVENTION_DIRS.commands,
  CONVENTION_DIRS.serverComponents,
  CONVENTION_DIRS.clientComponents,
  CONVENTION_DIRS.serializers,
  CONVENTION_DIRS.middleware,
  CONVENTION_DIRS.content,
];

/** One source file the scan read, with its content hash. */
export interface MetaManifestInput {
  /** Posix-relative path from the project root. */
  readonly path: string;
  /** Hex SHA-256 of the file's bytes. */
  readonly sha256: string;
}

/** The parsed `.jsails/manifest.json`. */
export interface MetaManifest {
  readonly version: number;
  /** Hex SHA-256 over the sorted input list. */
  readonly fingerprint: string;
  /** Every scanned source file, sorted by path. */
  readonly inputs: readonly MetaManifestInput[];
}

/** A manifest failure. Value-free: paths are project-relative, never absolute. */
export class MetaManifestError extends JsailsError {
  constructor(
    readonly code: 'stale_meta' | 'invalid_manifest' | 'missing_manifest',
    message: string,
    options?: { readonly suggestion?: string },
  ) {
    super(message, options);
  }
}

/**
 * Hash every source file under the scanned convention directories, sorted by
 * path. A directory that does not exist contributes nothing.
 */
export function collectInputHashes(rootDir: string): readonly MetaManifestInput[] {
  const inputs: MetaManifestInput[] = [];
  for (const dir of SCANNED_DIRS) {
    for (const relative of walkSortedFiles(join(rootDir, dir), { extensions: SOURCE_EXTENSIONS })) {
      if (relative.endsWith('.d.ts')) continue;
      const absolute = join(rootDir, dir, relative);
      const sha256 = createHash('sha256').update(readFileSync(absolute)).digest('hex');
      inputs.push({ path: `${dir}/${relative}`, sha256 });
    }
  }
  return inputs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The fingerprint of an input list: SHA-256 over its sorted `path\0hash` lines. */
export function computeFingerprint(inputs: readonly MetaManifestInput[]): string {
  const lines = [...inputs]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((input) => `${input.path}\0${input.sha256}`);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** Build the manifest for the tree under `rootDir`. */
export function buildMetaManifest(rootDir: string): MetaManifest {
  const inputs = collectInputHashes(rootDir);
  return Object.freeze({
    version: META_MANIFEST_VERSION,
    fingerprint: computeFingerprint(inputs),
    inputs,
  });
}

/** Serialize a manifest as the artifact's JSON text. */
export function emitMetaManifest(manifest: MetaManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Parse the artifact text. A malformed document, a wrong version, or a
 * fingerprint that does not match its own inputs is `invalid_manifest` — the
 * file was written by something other than this build step.
 */
export function parseMetaManifest(raw: string): MetaManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MetaManifestError('invalid_manifest', 'the .jsails manifest is not valid JSON', {
      suggestion: 'run "jsails build:meta" to regenerate it',
    });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new MetaManifestError('invalid_manifest', 'the .jsails manifest is not an object');
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== META_MANIFEST_VERSION) {
    throw new MetaManifestError(
      'invalid_manifest',
      `the .jsails manifest has version ${String(record.version)}, expected ${META_MANIFEST_VERSION}`,
      { suggestion: 'run "jsails build:meta" to regenerate it' },
    );
  }
  if (typeof record.fingerprint !== 'string' || !Array.isArray(record.inputs)) {
    throw new MetaManifestError('invalid_manifest', 'the .jsails manifest is missing its inputs');
  }
  const inputs: MetaManifestInput[] = [];
  for (const entry of record.inputs) {
    if (typeof entry !== 'object' || entry === null) {
      throw new MetaManifestError('invalid_manifest', 'the .jsails manifest has a malformed input');
    }
    const { path, sha256 } = entry as Record<string, unknown>;
    if (typeof path !== 'string' || typeof sha256 !== 'string') {
      throw new MetaManifestError('invalid_manifest', 'the .jsails manifest has a malformed input');
    }
    inputs.push({ path, sha256 });
  }
  if (computeFingerprint(inputs) !== record.fingerprint) {
    throw new MetaManifestError(
      'invalid_manifest',
      'the .jsails manifest fingerprint does not match its own inputs',
      { suggestion: 'run "jsails build:meta" to regenerate it' },
    );
  }
  return Object.freeze({ version: META_MANIFEST_VERSION, fingerprint: record.fingerprint, inputs });
}

/**
 * Read and verify the manifest for the tree under `rootDir`. Throws
 * `missing_manifest` when the file is absent and `stale_meta` when the tree no
 * longer matches it.
 */
export function verifyMetaManifest(rootDir: string): MetaManifest {
  let raw: string;
  try {
    raw = readFileSync(join(rootDir, '.jsails', META_MANIFEST_FILE), 'utf8');
  } catch {
    throw new MetaManifestError('missing_manifest', 'the .jsails manifest is missing', {
      suggestion: 'run "jsails build:meta" to generate it',
    });
  }
  const manifest = parseMetaManifest(raw);
  const current = computeFingerprint(collectInputHashes(rootDir));
  if (current !== manifest.fingerprint) {
    throw new MetaManifestError(
      'stale_meta',
      'the .jsails artifacts no longer match the source tree',
      { suggestion: 'run "jsails build:meta" to regenerate them' },
    );
  }
  return manifest;
}
