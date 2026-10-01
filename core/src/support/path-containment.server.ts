/**
 * Lexical path containment: whether one filesystem path lies within another,
 * plus the `--dir` resolver CLI commands use to confine a user-supplied
 * directory to the working directory. Server-only (Node `path`).
 *
 * The checks are lexical: they compare normalized paths and never consult
 * the filesystem. A caller that must defend against symlinks resolves both
 * sides with `realpath` first and then asks the same question.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * The path of `child` relative to `parent` when `child` is `parent` or lives
 * inside it (`''` for `parent` itself), or `undefined` when it does not. A
 * directory merely named `..foo` is inside; only a real `..` segment escapes.
 */
export function relativePathInside(parent: string, child: string): string | undefined {
  const rel = relative(parent, child);
  if (rel === '') return rel;
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return undefined;
  return rel;
}

/** True when `child` is `parent` or lives inside it. */
export function isPathInside(parent: string, child: string): boolean {
  return relativePathInside(parent, child) !== undefined;
}

/** Throw `makeError()` unless `child` is `parent` or lives inside it. */
export function assertPathInside(parent: string, child: string, makeError: () => Error): void {
  if (!isPathInside(parent, child)) {
    throw makeError();
  }
}

/**
 * Resolve a CLI `--dir` value against `cwd`, defaulting to `cwd` itself when
 * omitted or empty. A value that resolves outside `cwd` (`..` traversal or an
 * absolute path landing elsewhere) is refused with `makeError()`, which must
 * not echo the value.
 */
export function resolveDirWithin(
  cwd: string,
  dir: string | undefined,
  makeError: () => Error,
): string {
  const base = resolve(cwd);
  if (dir === undefined || dir === '') {
    return base;
  }
  const target = resolve(base, dir);
  assertPathInside(base, target, makeError);
  return target;
}
