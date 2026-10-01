/**
 * `jsails inject:auto-imports`: apply the scoped Preact auto-imports to compiled server
 * output. The Vite client build applies the same pass at transform time; this
 * command is the post-`tsc` half so SSR modules get real imports too.
 */

import { resolve } from 'node:path';

import { injectScopedAutoImportsInDirectory } from '../compiler/scoped-auto-imports.js';

/** Options accepted by {@link runAutoImportCommand}. */
export interface AutoImportCommandOptions {
  readonly dir?: string;
}

/** Run the scoped auto-import pass over `dir` (default: `dist`). */
export async function runAutoImportCommand(
  options: AutoImportCommandOptions = {},
): Promise<number> {
  const dir = resolve(options.dir ?? 'dist');
  try {
    const result = injectScopedAutoImportsInDirectory(dir);
    console.log(
      `jsails inject:auto-imports: ${result.injected} import${result.injected === 1 ? '' : 's'} ` +
        `in ${result.files} file${result.files === 1 ? '' : 's'}`,
    );
    return 0;
  } catch (error) {
    console.error(`jsails: ${error instanceof Error ? error.message : 'auto-import failed'}`);
    return 1;
  }
}
