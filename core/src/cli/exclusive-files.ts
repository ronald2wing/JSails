/**
 * Creating a set of new files all or none, for the CLI commands that
 * generate or move project files (`make:*`, `jsails convert`).
 *
 * Each file is created exclusively (`wx`), so an existing file is never
 * overwritten, and the directories it needs are made. When any step fails,
 * what this call created is removed again before the failure surfaces: the
 * files it wrote, and each directory it made that is empty once they are
 * gone. A file or directory that something else created in the meantime
 * (a concurrent run that won the race for a path) is never touched, so a
 * failure leaves the tree as it was. `writeFile`, `mkdir` and the removals
 * are injectable, so a test can fail any step.
 */

import { mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, parse, resolve } from 'node:path';

import { isErrno } from '../errors/inspect.js';
import { toPosixId } from '../support/project-paths.server.js';

/** A file to create: its absolute path and its text. */
export interface NewFile {
  readonly path: string;
  readonly text: string;
}

/** The file system steps {@link createFilesExclusive} takes. */
export interface ExclusiveFilesFs {
  mkdir(path: string, options: { readonly recursive: true }): Promise<string | undefined>;
  writeFile(path: string, text: string, options: { readonly flag: 'wx' }): Promise<void>;
  rm(path: string, options: { readonly force: true }): Promise<void>;
  rmdir(path: string): Promise<void>;
}

const NODE_FS: ExclusiveFilesFs = { mkdir, writeFile, rm, rmdir };

/** The outcome of {@link createFilesExclusive}. */
export type ExclusiveFiles =
  | { readonly ok: true }
  /** `existing` already existed, so nothing was created. */
  | { readonly ok: false; readonly existing: string };

/**
 * How many named components `path` has below its filesystem root, split on
 * the platform's separator: on POSIX a `\` is part of a name.
 */
function depth(path: string): number {
  const absolute = resolve(path);
  return toPosixId(absolute.slice(parse(absolute).root.length))
    .split('/')
    .filter((segment) => segment !== '').length;
}

/**
 * The directories `mkdir(directory, { recursive: true })` made, given the
 * first one it reports: that one and each below it down to `directory`.
 *
 * They are counted by depth, not found by comparing spellings: `mkdir` may
 * spell the first directory differently from `directory` (on Windows a temp
 * directory under an 8.3 short name, or another drive-letter case), and a
 * walk that waited for an exact match would climb to the filesystem root and
 * hand every ancestor to the rollback. A first directory that is not above or
 * at `directory`'s depth proves nothing, so nothing is claimed; the
 * filesystem root is never claimed.
 */
function madeDirectories(first: string | undefined, directory: string): readonly string[] {
  if (first === undefined) return [];
  const count = depth(directory) - depth(first) + 1;
  const made: string[] = [];
  let current = resolve(directory);
  for (let index = 0; index < count; index += 1) {
    if (parse(current).root === current) break;
    made.push(current);
    current = dirname(current);
  }
  return made;
}

/**
 * Remove what a failed call created: its files, then each directory it made,
 * deepest first, while it is empty.
 */
async function rollBack(
  fs: ExclusiveFilesFs,
  written: readonly string[],
  made: readonly string[],
): Promise<void> {
  for (const path of [...written].reverse()) await fs.rm(path, { force: true });
  for (const directory of [...made].sort((a, b) => b.length - a.length)) {
    try {
      await fs.rmdir(directory);
    } catch (error) {
      // Something else wrote into the directory, or removed it: what is left
      // there is not this call's to remove.
      if (!isErrno(error, 'ENOTEMPTY') && !isErrno(error, 'EEXIST') && !isErrno(error, 'ENOENT')) {
        throw error;
      }
    }
  }
}

/**
 * Create every file of `files`, in order, or none of them: a file that
 * already exists ends the call with `{ ok: false, existing }`, any other
 * failure is rethrown, and either way what the call created is removed first.
 */
export async function createFilesExclusive(
  files: readonly NewFile[],
  fs: ExclusiveFilesFs = NODE_FS,
): Promise<ExclusiveFiles> {
  const written: string[] = [];
  const made: string[] = [];
  let existing: string | undefined;
  try {
    for (const file of files) {
      const directory = dirname(file.path);
      made.push(...madeDirectories(await fs.mkdir(directory, { recursive: true }), directory));
      try {
        await fs.writeFile(file.path, file.text, { flag: 'wx' });
      } catch (error) {
        if (isErrno(error, 'EEXIST')) existing = file.path;
        throw error;
      }
      written.push(file.path);
    }
  } catch (error) {
    await rollBack(fs, written, made);
    if (existing !== undefined) return Object.freeze({ ok: false, existing });
    throw error;
  }
  return Object.freeze({ ok: true });
}
