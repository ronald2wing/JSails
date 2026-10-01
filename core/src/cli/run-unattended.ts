/**
 * Run a `defineCommand` command with no terminal: the seam a command job
 * (`defineCommandJob` of `jsails/jobs` and of `@jsails/jobs`) runs a command
 * through, so both read argv, the environment and the exit code as the
 * dispatcher does.
 *
 * Only a command that needs the environment alone runs this way: the process
 * (a worker) has already resolved and applied its environment and built what
 * it serves, so there is no stage to open. Its argv is parsed against its own
 * options; it sees the applied environment's variables, runs without
 * interaction (a question fails it instead of blocking a worker), and its
 * output lines go to the caller's sinks. What it returns is read by
 * `exit-code.ts`. A throw from the command propagates, for the caller to wrap
 * in its own value-free failure.
 */

import { appliedEnvironment, environmentVariables } from '../environment/resolve.js';
import { parseCommandArgs } from './command-args.js';
import type { DefinedCommand } from './define-command.js';
import type { CommandOptions } from './descriptor.js';
import { commandExitCode } from './exit-code.js';
import { NON_INTERACTIVE_PROMPTER } from './prompter.js';

/**
 * What {@link runUnattended} takes besides the command.
 *
 * @internal
 */
export interface UnattendedRun {
  /** The name the command runs as, which its context carries. */
  readonly name: string;
  /** The tokens after the command name. */
  readonly args: readonly string[];
  /** The working directory the command sees. */
  readonly cwd: string;
  /** Receives each line the command writes to standard output. */
  stdout(line: string): void;
  /** Receives each line the command writes to standard error. */
  stderr(line: string): void;
}

/**
 * How an unattended run ended, short of a throw: its args did not parse or
 * it reported a usage error itself (`usage`), it returned an exit code
 * (`exit`, 0 for nothing), or it returned something that is no exit code
 * (`invalid_exit`).
 *
 * @internal
 */
export type UnattendedOutcome =
  | { readonly kind: 'usage' }
  | { readonly kind: 'exit'; readonly code: number }
  | { readonly kind: 'invalid_exit' };

/**
 * Run `command` once with `run.args`, non-interactively, against the
 * environment the process applied.
 *
 * @internal
 */
export async function runUnattended(
  command: DefinedCommand<CommandOptions, 'environment'>,
  run: UnattendedRun,
): Promise<UnattendedOutcome> {
  const parsed = parseCommandArgs(
    { name: run.name, options: command.options, positionals: command.positionals },
    run.args,
  );
  if (parsed.kind !== 'run') return { kind: 'usage' };
  const resolved = appliedEnvironment();
  let usage = false;
  const result = await command.run({
    name: run.name,
    values: parsed.values,
    positionals: parsed.positionals,
    cwd: run.cwd,
    env: resolved === undefined ? {} : environmentVariables(resolved),
    environment: resolved?.name,
    interactive: false,
    prompter: NON_INTERACTIVE_PROMPTER,
    stdout: (text) => run.stdout(text),
    stderr: (text) => run.stderr(text),
    usage: () => {
      usage = true;
      return 2;
    },
  });
  if (usage) return { kind: 'usage' };
  const code = commandExitCode(result);
  return code === undefined ? { kind: 'invalid_exit' } : { kind: 'exit', code };
}
