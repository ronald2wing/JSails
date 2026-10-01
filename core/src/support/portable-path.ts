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

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import { CONTROL_CHARS } from './strings.js';

const PORTABLE_PATH_ERRORS = {
  invalid_path: {
    kind: 'invalid',
    message: 'not a portable relative path: {problem}',
    context: {
      problem: [
        'empty',
        'control_character',
        'backslash',
        'absolute',
        'windows_drive',
        'windows_reserved_character',
        'empty_segment',
        'dot_segment',
        'proto_segment',
      ],
    },
    suggestion:
      'use a relative path with forward slashes and no empty, ".", ".." or "__proto__" segments',
  },
} as const;

/**
 * The portable-path codes, `portable_path.*`: the one rule a path broke, never
 * the path.
 */
export const PortablePathErrors: ErrorRegistry<'portable_path', typeof PORTABLE_PATH_ERRORS> =
  defineErrors('portable_path', PORTABLE_PATH_ERRORS);

type PathProblem = (typeof PORTABLE_PATH_ERRORS.invalid_path.context.problem)[number];

function invalidPath(problem: PathProblem): Error {
  return new PortablePathErrors.Error('invalid_path', { problem });
}

/** A Windows drive prefix (`C:`, `C:` relative, `C:/x`). */
const WINDOWS_DRIVE = /^[A-Za-z]:/;

/** Characters Windows forbids in a file name (drive colon handled separately). */
const WINDOWS_RESERVED_CHARS = /[<>:"|?*]/;

/** Throws `portable_path.invalid_path` unless `path` is a portable relative file path. */
export function assertPortablePath(path: string): void {
  if (path.length === 0) {
    throw invalidPath('empty');
  }
  if (CONTROL_CHARS.test(path)) {
    throw invalidPath('control_character');
  }
  if (path.includes('\\')) {
    throw invalidPath('backslash');
  }
  if (path.startsWith('/')) {
    throw invalidPath('absolute');
  }
  if (WINDOWS_DRIVE.test(path)) {
    throw invalidPath('windows_drive');
  }
  if (WINDOWS_RESERVED_CHARS.test(path)) {
    throw invalidPath('windows_reserved_character');
  }
  for (const segment of path.split('/')) {
    if (segment.length === 0) {
      throw invalidPath('empty_segment');
    }
    if (segment === '.' || segment === '..') {
      throw invalidPath('dot_segment');
    }
    if (segment === '__proto__') {
      throw invalidPath('proto_segment');
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
