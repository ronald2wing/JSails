/**
 * Portable relative path validation, shared by the plugin archive extractor
 * and plugin entry resolution, plus the file-versus-directory collision check
 * the scaffold uses.
 *
 * A portable relative path is the single form of file path JSails lets
 * untrusted input place on disk: relative, forward slashes only, and free of
 * absolute POSIX/UNC paths, Windows drive paths, backslashes, Windows-reserved
 * characters, empty/`.`/`..`/`__proto__` segments, and control characters.
 * Dotfiles such as `.env.example` are ordinary segments. Pure: no filesystem
 * access, and every message is value-free.
 */

import { JsailsError } from '../errors/jsails-error.js';
import { CONTROL_CHARS } from './strings.js';

/** Raised for a path that is not a portable relative path. Value-free. */
export class PortablePathError extends JsailsError {
  readonly code = 'invalid_path';
}

/** A Windows drive prefix (`C:`, `C:` relative, `C:/x`). */
const WINDOWS_DRIVE = /^[A-Za-z]:/;

/** Characters Windows forbids in a file name (drive colon handled separately). */
const WINDOWS_RESERVED_CHARS = /[<>:"|?*]/;

/** Throws {@link PortablePathError} unless `path` is a portable relative file path. */
export function assertPortablePath(path: string): void {
  if (path.length === 0) {
    throw new PortablePathError('paths must not be empty');
  }
  if (CONTROL_CHARS.test(path)) {
    throw new PortablePathError('paths must not contain control characters');
  }
  if (path.includes('\\')) {
    throw new PortablePathError('paths must use forward slashes, not backslashes');
  }
  if (path.startsWith('/')) {
    throw new PortablePathError('paths must be relative, not absolute');
  }
  if (WINDOWS_DRIVE.test(path)) {
    throw new PortablePathError('paths must not include a Windows drive or UNC prefix');
  }
  if (WINDOWS_RESERVED_CHARS.test(path)) {
    throw new PortablePathError('paths must not contain Windows-reserved characters');
  }
  for (const segment of path.split('/')) {
    if (segment.length === 0) {
      throw new PortablePathError('paths must not contain empty segments');
    }
    if (segment === '.' || segment === '..') {
      throw new PortablePathError('paths must not contain "." or ".." segments');
    }
    if (segment === '__proto__') {
      throw new PortablePathError('paths must not contain a "__proto__" segment');
    }
  }
}

/**
 * The first path in `paths` that is also a directory prefix of another (`a`
 * alongside `a/b`), or `null`. Pure: each caller throws its own error.
 */
export function findPathCollision(paths: readonly string[]): string | null {
  const files = new Set(paths);
  for (const path of paths) {
    const segments = path.split('/');
    let prefix = '';
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]!;
      prefix = prefix.length === 0 ? segment : `${prefix}/${segment}`;
      if (files.has(prefix)) {
        return prefix;
      }
    }
  }
  return null;
}
