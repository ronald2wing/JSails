/**
 * `jsails mcp` — run the developer MCP server over stdio.
 *
 * ```sh
 * jsails mcp [--config <path>] [--db-config <path>]
 * ```
 *
 * Only protocol frames reach stdout; the startup line, app console output, and
 * failure reports go to stderr.
 */

import { DEFAULT_APP_CONFIG_PATH } from '../../app/config/defaults.js';
import type { CommandModule } from '../descriptor.js';
import type { MCP_OPTIONS } from '../manifest.js';
import { writeFailure } from '../report.js';

/**
 * How long a closed server waits for the event loop to drain before the
 * process exits anyway: an app module's open handle (a timer, a pool) must not
 * keep a server whose client has gone alive.
 */
const EXIT_GRACE_MS = 1000;

/** Run the MCP server over stdio until its client goes; resolves with the exit code. */
export async function runMcpCommand(
  options: { readonly configPath: string; readonly dbConfigPath?: string },
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  process.stderr.write(`jsails MCP server starting (config: ${options.configPath})\n`);

  try {
    const { runJsailsDevMcp } = await import('../../mcp/server.js');
    await runJsailsDevMcp(options);
  } catch (error) {
    await writeFailure(error, (line) => process.stderr.write(`${line}\n`), {
      fallback: 'failed to start MCP server',
      env,
    });
    return 1;
  }

  setTimeout(() => {
    process.exit(process.exitCode ?? 0);
  }, EXIT_GRACE_MS).unref();
  return 0;
}

/** `jsails mcp`. */
export const mcpCommand: CommandModule<typeof MCP_OPTIONS, 'environment'> = {
  run: (context) =>
    runMcpCommand(
      {
        configPath: context.values.config ?? DEFAULT_APP_CONFIG_PATH,
        ...(context.values['db-config'] === undefined
          ? {}
          : { dbConfigPath: context.values['db-config'] }),
      },
      context.env,
    ),
};
