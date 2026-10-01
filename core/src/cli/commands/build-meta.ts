/**
 * `build:meta` — the pre-`tsc` codegen step.
 *
 * Walks the authoring tree once (via {@link scanProjectMeta}) and writes the
 * generated artifacts under `.jsails/`: the ambient autoload declarations, the
 * autoload JSON the Vite transform consumes, and the model/component registries
 * `tsc` compiles. It runs **before** `tsc` so the declarations exist when the
 * type checker runs and the registries are part of the compiled output.
 *
 * The command takes no app config: it is a pure source-to-source transform over
 * the project tree. `--dir <path>` relocates the project root (defaults to the
 * current working directory).
 */

import { resolve } from 'node:path';

import { scanProjectMeta } from '../../build/meta-scan.js';
import { writeMetaArtifacts } from '../../build/generate-meta.js';
import type { CommandModule } from '../descriptor.js';
import type { BUILD_DIR_OPTIONS } from '../manifest.js';
import { writeFailure } from '../report.js';

/** Options for {@link runMetaCommand}. */
interface MetaCommandOptions {
  /** Project root to scan. Defaults to the current working directory. */
  readonly dir?: string;
  /** The environment a failure report reads `JSAILS_DEBUG` from. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Run the `build:meta` step. Returns 0 on success, 1 on a scan/write failure.
 * The failure message is value-free: a scan error carries no source text.
 */
export async function runMetaCommand(options: MetaCommandOptions = {}): Promise<number> {
  const rootDir = resolve(options.dir ?? process.cwd());
  try {
    const meta = await scanProjectMeta(rootDir);
    writeMetaArtifacts(meta, rootDir);
    console.log(
      `Generated .jsails/ (${meta.models.length} model(s), ${meta.components.length} component(s)).`,
    );
    return 0;
  } catch (error) {
    await writeFailure(error, (line) => console.error(line), {
      label: 'build:meta',
      env: options.env ?? {},
    });
    return 1;
  }
}

/** `jsails build:meta`. */
export const buildMetaCommand: CommandModule<typeof BUILD_DIR_OPTIONS, 'environment'> = {
  run: (context) =>
    runMetaCommand({ dir: resolve(context.cwd, context.values.dir ?? '.'), env: context.env }),
};
