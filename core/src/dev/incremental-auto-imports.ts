/**
 * Incremental scoped auto-import injection for the `jsails dev` loop.
 *
 * `jsails build` applies the auto-import pass to the whole `dist/` tree once.
 * The dev loop instead reacts to the paths one change burst touched: only those
 * compiled files are parsed, so a save costs one file's parse rather than the
 * whole tree's.
 *
 * The injector writes into `dist/`, which the project watcher also observes, so
 * each injection would otherwise come back as a second change burst and a
 * second server restart. The injector remembers the exact content it wrote and
 * reports a burst made only of its own writes as not relevant.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertNoOutOfScopeAutoImports,
  DEFAULT_SCOPED_AUTO_IMPORTS,
  injectScopedAutoImports,
  injectScopedAutoImportsInDirectory,
  type ScopedAutoImportRule,
} from '../compiler/scoped-auto-imports.js';

/** The outcome of handling one change burst. */
export interface AutoImportBurstResult {
  /** Whether the burst holds any change other than the injector's own writes. */
  readonly relevant: boolean;
  /** The first injection failure, or `undefined` when every file passed. */
  readonly error: unknown;
}

/** A stateful injector bound to one project. */
export interface IncrementalAutoImports {
  /** Apply the pass to the whole compiled tree (startup, or an unknown burst). */
  injectAll(): void;
  /**
   * Apply the pass to the compiled `.js` files among `paths` (`/`-separated
   * ids relative to the project root, as the watcher reports them). `undefined` means the watcher could not name the paths, so
   * the whole tree is processed and the burst counts as relevant.
   */
  injectChanged(paths: readonly string[] | undefined): AutoImportBurstResult;
}

const DIST_PREFIX = 'dist/';

/**
 * Whether a project-relative path is a compiled module the directory pass would
 * visit: a `.js` file under `dist/`, outside dot-directories and `node_modules`.
 */
function isCompiledModule(normalized: string): boolean {
  if (!normalized.startsWith(DIST_PREFIX) || !normalized.endsWith('.js')) {
    return false;
  }
  const segments = normalized.slice(DIST_PREFIX.length).split('/');
  return !segments.some((segment) => segment.startsWith('.') || segment === 'node_modules');
}

/** Create the injector for the project rooted at `cwd`. */
export function createIncrementalAutoImports(
  cwd: string,
  options: { readonly rules?: readonly ScopedAutoImportRule[] } = {},
): IncrementalAutoImports {
  const distDir = join(cwd, 'dist');
  const rules = options.rules ?? DEFAULT_SCOPED_AUTO_IMPORTS;
  // Content this injector last wrote per file. A watcher event for a file whose
  // content still equals this entry is the echo of that write.
  const written = new Map<string, string>();

  const processFile = (file: string, code: string): void => {
    const result = injectScopedAutoImports(code, {
      fileName: file,
      rootDir: distDir,
      rules,
      placement: 'append',
    });
    if (result !== null) {
      writeFileSync(file, result.code, 'utf8');
      written.set(file, result.code);
      return;
    }
    written.delete(file);
    assertNoOutOfScopeAutoImports(code, { fileName: file, rootDir: distDir, rules });
  };

  return {
    injectAll(): void {
      written.clear();
      if (existsSync(distDir)) {
        injectScopedAutoImportsInDirectory(distDir, { rules });
      }
    },

    injectChanged(paths): AutoImportBurstResult {
      if (paths === undefined) {
        try {
          this.injectAll();
          return { relevant: true, error: undefined };
        } catch (error) {
          return { relevant: true, error };
        }
      }
      let relevant = false;
      let firstError: unknown;
      for (const id of new Set(paths)) {
        if (!isCompiledModule(id)) {
          relevant = true;
          continue;
        }
        const file = join(cwd, id);
        let code: string;
        try {
          code = readFileSync(file, 'utf8');
        } catch {
          // A deleted or unreadable module still changes what the server loads.
          written.delete(file);
          relevant = true;
          continue;
        }
        if (written.get(file) === code) {
          continue;
        }
        relevant = true;
        try {
          processFile(file, code);
        } catch (error) {
          firstError ??= error;
        }
      }
      return { relevant, error: firstError };
    },
  };
}
