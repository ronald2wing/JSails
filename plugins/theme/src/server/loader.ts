/**
 * Server-only theme-package filesystem loader.
 *
 * Reads a theme package's declared template, partial, and preview files from
 * disk without ever executing package code. Every declared path is validated
 * lexically ({@link isSafeRelativePath}) and then resolved through `realpath`
 * against `packageDir`, so a path can never traverse outside the package
 * directory, be absolute, or escape through a symlink (including a dangling
 * one). A malformed or unsafe template surfaces as the browser-safe
 * {@link ThemeTemplateError}; a path that escapes the package or a missing
 * file surfaces as a value-free {@link ThemeLoaderError}. Nothing here is
 * imported dynamically and no package module is ever imported.
 *
 * This module is server-only: it imports `node:fs`/`node:path`, so it must be
 * reached through the `@jsails/theme/server` subpath, never the browser-safe
 * package entry.
 */

import { lstat, readFile as fsReadFile, realpath as fsRealpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import { isSafeRelativePath, ThemePackageManifest } from '../packages/manifest.js';
import { parseThemeTemplate, ThemeTemplate, ThemeTemplateError } from '../packages/template.js';
import { errnoCode, isErrno } from 'jsails/plugin-sdk';

// ---------------------------------------------------------------------------
// Error surface
// ---------------------------------------------------------------------------

/** Hard-error codes for the theme package filesystem loader. */
export type ThemeLoaderErrorCode = 'invalid_input' | 'invalid_path' | 'not_found' | 'io_failed';

/** Raised for a path, containment, or I/O failure while loading a theme package. Value-free. */
export class ThemeLoaderError extends Error {
  readonly code: ThemeLoaderErrorCode;

  constructor(code: ThemeLoaderErrorCode, message: string) {
    super(message);
    this.name = 'ThemeLoaderError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Safe path resolution
// ---------------------------------------------------------------------------

/** True when `candidate` is `root` or lives strictly inside it (segment-aware). */
function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

/**
 * The filesystem primitives the loader uses, injectable for tests. All mirror
 * `node:fs/promises`: `readFile(path)` returns bytes, `realpath(path)` returns
 * the canonical path (following symlinks), and `lstat(path)` returns minimal
 * stat info used to confirm a preview target is a regular file.
 */
export interface ThemeLoaderIo {
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly realpath: (path: string) => Promise<string>;
  readonly lstat: (path: string) => Promise<{ isFile(): boolean; isDirectory(): boolean }>;
}

const defaultIo: ThemeLoaderIo = {
  readFile: async (path) => new Uint8Array(await fsReadFile(path)),
  realpath: (path) => fsRealpath(path),
  lstat: async (path) => lstat(path),
};

/** The real path of `packageDir`, or fail value-free when it cannot be resolved. */
async function resolveRootReal(packageDir: string, io: ThemeLoaderIo): Promise<string> {
  try {
    return await io.realpath(packageDir);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw new ThemeLoaderError('not_found', 'theme package directory does not exist');
    }
    throw wrapIo(error);
  }
}

/** Reduce an unknown filesystem error to a payload-free {@link ThemeLoaderError}. */
function wrapIo(error: unknown): ThemeLoaderError {
  const code = errnoCode(error);
  return new ThemeLoaderError(
    'io_failed',
    code === undefined ? 'theme file read failed' : `theme file read failed (${code})`,
  );
}

/**
 * Resolve a declared package-relative path to a real path and verify it stays
 * inside `packageDir`. Rejects a lexically unsafe path, an absolute path, and
 * a symlink (including a dangling one) that resolves outside the package.
 */
async function resolveContainedPath(
  packageDir: string,
  declaredPath: string,
  io: ThemeLoaderIo,
): Promise<string> {
  if (!isSafeRelativePath(declaredPath)) {
    throw new ThemeLoaderError('invalid_path', 'theme path is not a safe package-relative path');
  }
  const rootReal = await resolveRootReal(packageDir, io);
  const target = resolve(rootReal, declaredPath);
  if (!isInsideRoot(rootReal, target)) {
    throw new ThemeLoaderError('invalid_path', 'theme path escapes the package directory');
  }
  let resolved: string;
  try {
    resolved = await io.realpath(target);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw new ThemeLoaderError('not_found', 'theme file not found');
    }
    throw wrapIo(error);
  }
  if (!isInsideRoot(rootReal, resolved)) {
    throw new ThemeLoaderError(
      'invalid_path',
      'theme path escapes the package directory through a symlink',
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Options for {@link loadThemeTemplates} and {@link loadThemePreview}. */
export interface ThemeLoaderOptions {
  /** Inject filesystem primitives for testing; defaults to `node:fs/promises`. */
  readonly io?: ThemeLoaderIo;
}

/** A loaded preview image. */
export interface LoadedThemePreview {
  /** The raw preview bytes, unmodified. */
  readonly bytes: Uint8Array;
  /** The MIME type, derived only from the declared file extension. */
  readonly contentType: string;
}

/** The small set of MIME types a preview image may map to. SVG is excluded. */
const PREVIEW_MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
});

/** Load every declared template and partial path, keyed by name. */
export async function loadThemeTemplates(
  packageDir: string,
  manifest: ThemePackageManifest,
  options: ThemeLoaderOptions = {},
): Promise<ReadonlyMap<string, ThemeTemplate>> {
  if (typeof packageDir !== 'string' || packageDir.length === 0) {
    throw new ThemeLoaderError('invalid_input', 'packageDir must be a non-empty string');
  }
  const io = options.io ?? defaultIo;
  const loaded = new Map<string, ThemeTemplate>();

  for (const declaredPath of [...manifest.templates, ...manifest.partials]) {
    const resolved = await resolveContainedPath(packageDir, declaredPath, io);
    const template = await loadTemplateFile(resolved, io);
    const key = template.name;
    if (loaded.has(key)) {
      throw new ThemeLoaderError('invalid_path', `duplicate template name "${key}"`);
    }
    loaded.set(key, template);
  }

  return Object.freeze(loaded);
}

/** Read, parse, and validate one template file. */
async function loadTemplateFile(resolvedPath: string, io: ThemeLoaderIo): Promise<ThemeTemplate> {
  let bytes: Uint8Array;
  try {
    bytes = await io.readFile(resolvedPath);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw new ThemeLoaderError('not_found', 'theme file not found');
    }
    throw wrapIo(error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ThemeTemplateError('invalid_template', 'theme template file is not valid JSON');
  }

  // parseThemeTemplate throws ThemeTemplateError for a malformed or unsafe tree.
  return parseThemeTemplate(parsed);
}

/** Load a declared preview path, returning its bytes and a MIME type. */
export async function loadThemePreview(
  packageDir: string,
  manifest: ThemePackageManifest,
  options: ThemeLoaderOptions = {},
): Promise<LoadedThemePreview | undefined> {
  if (typeof packageDir !== 'string' || packageDir.length === 0) {
    throw new ThemeLoaderError('invalid_input', 'packageDir must be a non-empty string');
  }
  if (manifest.preview === undefined) {
    return undefined;
  }

  const io = options.io ?? defaultIo;
  const resolved = await resolveContainedPath(packageDir, manifest.preview, io);

  let stats: { isFile(): boolean };
  try {
    stats = await io.lstat(resolved);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw new ThemeLoaderError('not_found', 'theme preview file not found');
    }
    throw wrapIo(error);
  }
  if (!stats.isFile()) {
    throw new ThemeLoaderError('not_found', 'theme preview file not found');
  }

  let bytes: Uint8Array;
  try {
    bytes = await io.readFile(resolved);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw new ThemeLoaderError('not_found', 'theme preview file not found');
    }
    throw wrapIo(error);
  }

  const contentType = PREVIEW_MIME_BY_EXTENSION[extensionOf(manifest.preview)];
  if (contentType === undefined) {
    throw new ThemeLoaderError('invalid_path', 'theme preview extension is not supported');
  }

  return { bytes, contentType };
}

/** The lowercased extension of a path, or `''` when there is none. */
function extensionOf(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}
