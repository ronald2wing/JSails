/**
 * `runCommand`: run a `defineCommand` command in-process, as the dispatcher
 * would, and capture what it writes.
 *
 * The argv is parsed against the command's own options (`--help` and an
 * unknown flag come back as exit code 2 with the usage line on `stderr`, as
 * the CLI prints them). The environment is the test's to state: nothing is
 * resolved from files. The command runs without interaction unless the test
 * hands it a prompter. A command that needs more than the environment gets
 * the stages the test passes as `stages` (a loaded app, opened services), so
 * the harness itself opens nothing. What `run` returns is read as the
 * dispatcher reads it (`cli/exit-code.ts`): a value that is no exit code
 * throws `cli.invalid_exit_code`, the failure `jsails` reports for it.
 */

import { parseCommandArgs } from '../cli/command-args.js';
import type { DefinedCommand, DefinedCommandNeeds } from '../cli/define-command.js';
import type { CommandContext, CommandOptions, Prompter } from '../cli/descriptor.js';
import { CliErrors } from '../cli/errors.js';
import { commandExitCode } from '../cli/exit-code.js';
import { NON_INTERACTIVE_PROMPTER } from '../cli/prompter.js';

/**
 * What {@link runCommand} takes besides the command.
 *
 * @public
 */
export interface RunCommandOptions<N extends DefinedCommandNeeds = DefinedCommandNeeds> {
  /** The tokens after the command name. */
  readonly args?: readonly string[];
  /** The environment the command sees, `JSAILS_ENV` and `NODE_ENV` included. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The working directory; defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** The name the command runs as; defaults to `command`. */
  readonly name?: string;
  /** Answers to its questions; without one every question fails. */
  readonly prompter?: Prompter;
  /** The stages its `needs` asks for beyond the environment. */
  readonly stages?: Omit<
    CommandContext<CommandOptions, N>,
    keyof CommandContext<CommandOptions, 'environment'>
  >;
}

/**
 * What a {@link runCommand} run produced.
 *
 * @public
 */
export interface CommandRun {
  /** The exit code: what `run` returned, 0 for nothing, 2 for a usage error. */
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

/**
 * Run `command` in-process with `options.args`. A throw from the command
 * propagates, so a test can assert on it, and so does
 * `cli.invalid_exit_code` for a result that is no integer from 0 to 255,
 * which `jsails` would refuse with exit code 1.
 *
 * @public
 */
export async function runCommand<O extends CommandOptions, N extends DefinedCommandNeeds>(
  command: DefinedCommand<O, N>,
  options: RunCommandOptions<N>,
): Promise<CommandRun> {
  const name = options.name ?? 'command';
  const stdout: string[] = [];
  const stderr: string[] = [];
  const usage = (message: string): number => {
    stderr.push(`jsails: ${message}`);
    return 2;
  };
  const parsed = parseCommandArgs(
    { name, options: command.options, positionals: command.positionals },
    options.args ?? [],
    true,
  );
  if (parsed.kind === 'help') return { code: 2, stdout, stderr: ['jsails: help requested'] };
  if (parsed.kind === 'usage') return { code: usage(parsed.message), stdout, stderr };
  const interactive = parsed.interactive && options.prompter !== undefined;
  const context = {
    name,
    values: parsed.values,
    positionals: parsed.positionals,
    cwd: options.cwd ?? process.cwd(),
    env: options.env,
    environment: options.env['JSAILS_ENV'],
    interactive,
    prompter:
      interactive && options.prompter !== undefined ? options.prompter : NON_INTERACTIVE_PROMPTER,
    stdout: (text: string) => stdout.push(text),
    stderr: (text: string) => stderr.push(text),
    usage,
    ...options.stages,
  } as unknown as CommandContext<O, N>;
  const code = commandExitCode(await command.run(context));
  if (code === undefined) {
    throw new CliErrors.Error('invalid_exit_code', { command: name, source: 'runCommand' });
  }
  return { code, stdout, stderr };
}
