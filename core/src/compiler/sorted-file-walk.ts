/**
 * Recursive file walk in deterministic order.
 *
 * Every discovery pass (commands, jobs, models, components, autoload symbols,
 * compiled output) needs the same walk: depth-first, entries sorted by code
 * unit within each directory, symlinks skipped so a link cannot pull a file
 * from outside the tree, and a missing root treated as empty. Sorting makes
 * discovery order — and therefore duplicate-name errors and generated files —
 * identical across filesystems.
 *
 * The walk only lists paths; it never imports or reads a file.
 */

import { readdirSync, type Dirent } from 'node:fs';
import { extname, join } from 'node:path';

import { isErrno } from '../errors/inspect.js';
import { compareStrings } from '../support/index.js';

/** Which entries {@link walkSortedFiles} returns or descends into. */
export interface SortedFileWalkOptions {
  /** Keep only files with one of these extensions (`'.js'`, `'.mjs'`, ...). */
  readonly extensions?: ReadonlySet<string>;
  /** Keep only files whose basename passes; checked after `extensions`. */
  readonly include?: (fileName: string) => boolean;
  /** Skip files and directories whose name starts with `.`. */
  readonly skipDotEntries?: boolean;
  /** Directory names never descended into (e.g. `node_modules`). */
  readonly skipDirectories?: ReadonlySet<string>;
}

/**
 * Walk `rootDir` and return the posix-separated, root-relative path of every
 * matching file. A missing root returns `[]`; any other filesystem error is
 * rethrown.
 */
export function walkSortedFiles(rootDir: string, options: SortedFileWalkOptions = {}): string[] {
  const results: string[] = [];
  walk(rootDir, '');
  return results;

  function walk(current: string, prefix: string): void {
    let dirents: Dirent[];
    try {
      dirents = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        return;
      }
      throw error;
    }
    dirents.sort((a, b) => compareStrings(a.name, b.name));
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) {
        continue;
      }
      if (options.skipDotEntries === true && dirent.name.startsWith('.')) {
        continue;
      }
      const relative = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
      if (dirent.isDirectory()) {
        if (options.skipDirectories?.has(dirent.name) !== true) {
          walk(join(current, dirent.name), relative);
        }
        continue;
      }
      if (!dirent.isFile()) {
        continue;
      }
      if (options.extensions !== undefined && !options.extensions.has(extname(dirent.name))) {
        continue;
      }
      if (options.include !== undefined && !options.include(dirent.name)) {
        continue;
      }
      results.push(relative);
    }
  }
}
