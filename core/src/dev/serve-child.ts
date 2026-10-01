/**
 * Serve-child entry point for the dev runtime.
 *
 * `jsails dev` spawns this module with the framework's Node binary. The module
 * chdirs back to the project and reads the app config path from dedicated
 * environment variables, then delegates to the normal `serve` command with
 * `--with worker`: the development server runs the whole app, the web and the
 * worker roles in one process, so a job dispatched in development runs (over
 * the in-memory jobs adapter, whose reach is the process, as over Valkey). The
 * project path and config path arrive as environment variables, never as
 * shell-interpolated argv.
 *
 * The child's environment is the one `jsails dev` resolved: `runCli` finds the
 * parent's `JSAILS_ENV_RESOLVED` marker and inherits it, `NODE_ENV` included.
 */

import { runCli } from '../cli/index.js';
import { DEV_CONFIG_ENV, DEV_CWD_ENV } from './runtime.js';

/** The `serve` arguments of the development server: the app config, both roles. */
function serveChildArgs(configPath: string): readonly string[] {
  return Object.freeze(['serve', '--config', configPath, '--with', 'worker']);
}

/** Run the serve child: restore the project context, then delegate to `serve`. */
async function main(): Promise<void> {
  const cwd = process.env[DEV_CWD_ENV];
  const configPath = process.env[DEV_CONFIG_ENV];

  if (cwd === undefined || configPath === undefined) {
    console.error('jsails dev: the serve child is missing its runtime environment');
    process.exitCode = 1;
    return;
  }

  // chdir sits inside the guard so a deleted project directory surfaces as a
  // controlled failure instead of an unhandled stack.
  let entered = false;
  try {
    process.chdir(cwd);
    entered = true;
  } catch {
    console.error('jsails dev: could not enter the project directory (was it deleted?)');
    process.exitCode = 1;
  }
  if (entered) {
    try {
      process.exitCode = await runCli([...serveChildArgs(configPath)]);
    } catch {
      console.error('jsails dev: the serve command failed');
      process.exitCode = 1;
    }
  }
}

// Run only when invoked as the entry point; importing this module must not
// chdir or start a server.
if (import.meta.main) {
  await main();
}
