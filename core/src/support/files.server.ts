/**
 * The server-only `Files` namespace: bounded filesystem helpers (read, write, copy, glob, JSON) over `node:fs/promises`.
 */

import { access, cp, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { glob as tinyGlob } from 'tinyglobby';

import { Encoding } from './encoding.js';
import { JsailsError } from '../errors/jsails-error.js';

// ---------------------------------------------------------------------------
// Domain error
// ---------------------------------------------------------------------------

export type FilesErrorCode = 'not_found' | 'io_failed' | 'invalid_argument';

export class FilesError extends JsailsError {
  readonly code: FilesErrorCode;

  constructor(code: FilesErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

/**
 * Map a thrown filesystem error to a value-free `FilesError`. The path and the
 * raw system message are never carried through — only the errno class.
 */
function wrapError(error: unknown, operation: string): FilesError {
  if (error instanceof FilesError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new FilesError('not_found', `${operation}: file not found`, { cause: error });
  }
  return new FilesError('io_failed', `${operation}: filesystem error`, { cause: error });
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WriteJsonOptions {
  /** Pretty-print with the given number of spaces. */
  readonly spaces?: number;
}

export interface CopyOptions {
  /** Overwrite an existing destination. */
  readonly overwrite?: boolean;
  /** Preserve file timestamps. */
  readonly preserveTimestamps?: boolean;
}

export interface GlobOptions {
  /** Working directory the patterns are resolved against. */
  readonly cwd?: string;
  /** Include dot-files. Defaults to false. */
  readonly dot?: boolean;
  /** Return absolute paths. Defaults to false. */
  readonly absolute?: boolean;
  /** Follow symlinked directories. Defaults to false. */
  readonly followSymbolicLinks?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read and JSON-parse a file. Throws `FilesError` on missing/invalid input. */
export async function readJsonFile<T = unknown>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    // A malformed JSON document is an input problem, not an I/O failure.
    if (error instanceof SyntaxError) {
      throw new FilesError('invalid_argument', 'readJsonFile: invalid JSON', { cause: error });
    }
    throw wrapError(error, 'readJsonFile');
  }
}

/** Serialize `value` to JSON and write it, creating parent directories. */
export async function writeJson(
  path: string,
  value: unknown,
  options: WriteJsonOptions = {},
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    // Write a sibling and rename it into place so a crash mid-write never
    // leaves a truncated document behind for the next reader.
    const staged = siblingPath(path, 'tmp');
    try {
      await writeFile(staged, `${JSON.stringify(value, null, options.spaces ?? 2)}\n`);
      await rename(staged, path);
    } catch (error) {
      await rm(staged, { force: true });
      throw error;
    }
  } catch (error) {
    throw wrapError(error, 'writeJson');
  }
}

/** Create a directory and any missing parents. */
export async function ensureDir(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
  } catch (error) {
    throw wrapError(error, 'ensureDir');
  }
}

/** Copy a file or directory tree. */
export async function copy(src: string, dest: string, options: CopyOptions = {}): Promise<void> {
  try {
    await cp(src, dest, {
      recursive: true,
      force: options.overwrite ?? true,
      preserveTimestamps: options.preserveTimestamps ?? false,
    });
  } catch (error) {
    throw wrapError(error, 'copy');
  }
}

/** A unique path next to `path`, used to stage or set aside a tree. */
function siblingPath(path: string, suffix: string): string {
  return `${path}.${Encoding.uuid()}.${suffix}`;
}

/** Errno codes `rename` raises when the destination is a directory it cannot overwrite. */
const REPLACE_REQUIRED = new Set(['ENOTEMPTY', 'EEXIST', 'EISDIR', 'ENOTDIR', 'EPERM']);

/**
 * Replace `dest` by running `place`, which must create `dest`. The old tree is
 * set aside first and only removed once `place` succeeded; on failure it is
 * restored, so a failed move never destroys the destination.
 */
async function replacePath(dest: string, place: () => Promise<void>): Promise<void> {
  const aside = siblingPath(dest, 'old');
  await rename(dest, aside);
  try {
    await place();
  } catch (error) {
    try {
      await rename(aside, dest);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], 'move: destination restore failed');
    }
    throw error;
  }
  await rm(aside, { recursive: true, force: true });
}

/** Whether `path` exists, without following a final symlink. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Cross-device move: copy into a staged sibling, swap it in, then drop the source. */
async function moveAcrossDevices(src: string, dest: string): Promise<void> {
  const staged = siblingPath(dest, 'tmp');
  try {
    await cp(src, staged, { recursive: true });
    if (await pathExists(dest)) {
      await replacePath(dest, () => rename(staged, dest));
    } else {
      await rename(staged, dest);
    }
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
  await rm(src, { recursive: true, force: true });
}

/**
 * Move a file or directory tree, replacing `dest`. The source is checked
 * before the destination is touched, and an existing destination is only
 * removed after the new tree is in place.
 */
export async function move(src: string, dest: string): Promise<void> {
  try {
    await lstat(src);
    try {
      await rename(src, dest);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EXDEV') {
        await moveAcrossDevices(src, dest);
        return;
      }
      if (code === undefined || !REPLACE_REQUIRED.has(code) || !(await pathExists(dest))) {
        throw error;
      }
    }
    await replacePath(dest, () => rename(src, dest));
  } catch (error) {
    throw wrapError(error, 'move');
  }
}

/** Remove a file or directory; a missing target is not an error. */
export async function remove(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    throw wrapError(error, 'remove');
  }
}

/** Test whether a path exists. */
export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Match files against one or more glob patterns. */
export async function glob(
  patterns: string | readonly string[],
  options: GlobOptions = {},
): Promise<string[]> {
  try {
    const input = typeof patterns === 'string' ? patterns : [...patterns];
    const matches = await tinyGlob(input, {
      cwd: options.cwd,
      dot: options.dot ?? false,
      absolute: options.absolute ?? false,
      followSymbolicLinks: options.followSymbolicLinks ?? false,
      onlyFiles: true,
    });
    return matches.sort();
  } catch (error) {
    throw wrapError(error, 'glob');
  }
}

/** Read a file and base64-encode its bytes. */
export async function toBase64(path: string): Promise<string> {
  try {
    const buffer = await readFile(path);
    return Encoding.base64(buffer);
  } catch (error) {
    throw wrapError(error, 'toBase64');
  }
}

// ---------------------------------------------------------------------------
// Frozen namespace
// ---------------------------------------------------------------------------

export const Files = Object.freeze({
  readJsonFile,
  writeJson,
  ensureDir,
  copy,
  move,
  remove,
  exists,
  glob,
  toBase64,
});
