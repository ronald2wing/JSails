/**
 * The `jsails` CLI as a module. The executable is `bin.cjs`, which checks the
 * Node version and then calls {@link main}; this module has no main-module
 * guard of its own, so importing it (the dev serve child, a test) runs
 * nothing. Every invocation goes through the dispatcher (`dispatch.ts`).
 */

import { dispatch, processIo } from './dispatch.js';

/** Run `jsails` with `argv` (the tokens after the bin) and resolve with its exit code. */
export function runCli(argv: readonly string[]): Promise<number> {
  return dispatch(argv, processIo());
}

/** The bin's entry: run `argv` and set the process exit code. */
export async function main(argv: readonly string[]): Promise<void> {
  try {
    process.exitCode = await runCli(argv);
  } catch {
    // The dispatcher reports every command failure itself; reaching this is a
    // defect in the CLI, whose error may carry anything, so only the fact is
    // printed.
    process.stderr.write('jsails: the CLI failed unexpectedly\n');
    process.exitCode = 1;
  }
}
