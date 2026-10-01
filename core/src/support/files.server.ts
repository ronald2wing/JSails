import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { glob as tinyGlob } from 'tinyglobby';

import { Encoding } from './encoding.js';
import { SupportError } from './errors.js';

// ---------------------------------------------------------------------------
// Domain error
// ---------------------------------------------------------------------------

export type FilesErrorCode = 'not_found' | 'io_failed' | 'invalid_argument';

export class FilesError extends SupportError {
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
  spaces?: number;
}

export interface CopyOptions {
  /** Overwrite an existing destination. */
  overwrite?: boolean;
  /** Preserve file timestamps. */
  preserveTimestamps?: boolean;
}

export interface GlobOptions {
  /** Working directory the patterns are resolved against. */
  cwd?: string;
  /** Include dot-files. Defaults to false. */
  dot?: boolean;
  /** Return absolute paths. Defaults to false. */
  absolute?: boolean;
  /** Follow symlinked directories. Defaults to false. */
  followSymbolicLinks?: boolean;
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
    await writeFile(path, `${JSON.stringify(value, null, options.spaces ?? 2)}\n`);
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

/** Move a file or directory tree. */
export async function move(src: string, dest: string): Promise<void> {
  try {
    await rm(dest, { recursive: true, force: true });
    try {
      await rename(src, dest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      await cp(src, dest, { recursive: true });
      await rm(src, { recursive: true, force: true });
    }
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
