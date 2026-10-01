/**
 * `jsails inject:auto-imports`: apply the scoped Preact auto-imports to compiled server
 * output. The Vite client build applies the same pass at transform time; this
 * command is the post-`tsc` half so SSR modules get real imports too.
 */

import { resolve } from 'node:path';

import { injectScopedAutoImportsInDirectory } from '../../compiler/scoped-auto-imports.js';
import type { CommandModule } from '../descriptor.js';
import type { INJECT_OPTIONS } from '../manifest.js';
import { writeFailure } from '../report.js';

/** Options accepted by {@link runAutoImportCommand}. */
export interface AutoImportCommandOptions {
  readonly dir?: string;
  /** The environment a failure report reads `JSAILS_DEBUG` from. */
  readonly env?: Readonly<Record<string, string | undefined>>;
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
    await writeFailure(error, (line) => console.error(line), {
      fallback: 'auto-import failed',
      env: options.env ?? {},
    });
    return 1;
  }
}

/** `jsails inject:auto-imports`. */
export const injectAutoImportsCommand: CommandModule<typeof INJECT_OPTIONS, 'environment'> = {
  run: (context) =>
    runAutoImportCommand({
      dir: resolve(context.cwd, context.values.dir ?? 'dist'),
      env: context.env,
    }),
};
