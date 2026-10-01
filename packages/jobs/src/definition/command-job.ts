/**
 * `defineCommandJob`: run a `defineCommand` command as a job, the explicit
 * seam between a human-facing command (argv, prompts, an exit code) and
 * background work (no terminal, retries). The result is an ordinary
 * {@link defineJob} definition whose payload is `{ args?: string[] }`, so a
 * schedule or a dispatch runs it like any other job.
 *
 * Only a command that needs the environment alone runs as a job: the worker
 * has already resolved its environment and built what it serves, so there is
 * no stage to open. The command runs through the kernel's unattended runner
 * (`runCommandUnattended` of `jsails/internal`), as `jsails/jobs` runs one:
 * its argv is parsed against its own options, it sees the environment the
 * worker applied, runs without interaction (a prompt fails the job instead of
 * blocking a worker), and its output lines go to the given sinks (by default
 * the worker's own stdout and stderr). A thrown error fails the attempt with
 * `jobs.command_threw` (the command's error as its cause), invalid args or a
 * usage error with `jobs.command_usage`, a non-zero or invalid exit code with
 * `jobs.command_exit`, and the job's retry policy applies.
 *
 * A command carries no name of its own (an app command's is its path, a
 * package's is in its manifest), so the job is named here. The runner is
 * imported when the job first runs, so declaring command jobs loads no
 * argument parser.
 */

import type { UnattendedOutcome } from 'jsails/internal';
import type { CommandOptions, DefinedCommand } from 'jsails/kernel';
import { z } from 'jsails/zod';

import { isJobName } from '../envelope/job-options.js';
import { JobsErrors } from '../errors/jobs-errors.js';
import { defineJob, type JobDefinition } from './define-job.js';

/** A command that can run as a job: a `defineCommand` value that needs only the environment. */
export type CommandJobTarget = DefinedCommand<CommandOptions, 'environment'>;

/** Options accepted by {@link defineCommandJob}. */
export interface CommandJobOptions<N extends string, Q extends string> {
  /** The job name, which also names the command in its context. */
  readonly name: N;
  readonly queue?: Q;
  /** Arguments used when the payload has no `args`. */
  readonly args?: readonly string[];
  /** The working directory the command sees. Defaults to `process.cwd()` at run time. */
  readonly cwd?: string;
  readonly attempts?: number;
  readonly timeoutMs?: number;
  /** Receives each stdout line. Defaults to the worker's stdout. */
  readonly stdout?: (line: string) => void;
  /** Receives each stderr line. Defaults to the worker's stderr. */
  readonly stderr?: (line: string) => void;
}

/** The payload of a command job. */
export const commandJobPayload: z.ZodObject<
  { args: z.ZodOptional<z.ZodArray<z.ZodString>> },
  z.core.$strict
> = z.strictObject({ args: z.array(z.string()).optional() });

const COMMAND_OPTION_KEYS: ReadonlySet<string> = new Set([
  'name',
  'queue',
  'args',
  'cwd',
  'attempts',
  'timeoutMs',
  'stdout',
  'stderr',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether `command` has the shape of a `defineCommand` value that needs only
 * the environment. The shape is checked rather than the brand, which would
 * take importing the command surface when a job is declared; `defineCommand`
 * already checked each part of what it made.
 */
function isCommandJobTarget(command: unknown): command is CommandJobTarget {
  return (
    isRecord(command) &&
    typeof command['run'] === 'function' &&
    command['needs'] === 'environment' &&
    isRecord(command['options']) &&
    Array.isArray(command['positionals'])
  );
}

/**
 * Wrap a command as a job named `options.name`.
 *
 * @throws `jobs.invalid_definition` for a value that is no `defineCommand`
 *   command needing only the environment (rule `command`), an invalid job
 *   name, or non-string fixed arguments; `jobs.unknown_option` for a field
 *   that is not an option.
 */
export function defineCommandJob<
  const N extends string = string,
  const Q extends string = 'default',
>(
  command: CommandJobTarget,
  options: CommandJobOptions<N, Q>,
): JobDefinition<N, typeof commandJobPayload, Q> {
  if (!isCommandJobTarget(command)) {
    throw new JobsErrors.Error('invalid_definition', { rule: 'command' });
  }
  if (isRecord(options) && !Object.keys(options).every((key) => COMMAND_OPTION_KEYS.has(key))) {
    throw new JobsErrors.Error('unknown_option');
  }
  const name: unknown = isRecord(options) ? options.name : undefined;
  if (!isJobName(name)) {
    throw new JobsErrors.Error('invalid_definition', { rule: 'command_name' });
  }
  if (
    options.args !== undefined &&
    (!Array.isArray(options.args) || !options.args.every((arg) => typeof arg === 'string'))
  ) {
    throw new JobsErrors.Error('invalid_definition', { rule: 'command_args' });
  }
  const fixedArgs = Object.freeze([...(options.args ?? [])]);
  const stdout = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  return defineJob<N, typeof commandJobPayload, Q>({
    name: name as N,
    schema: commandJobPayload,
    ...(options.queue === undefined ? {} : { queue: options.queue }),
    ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    async handle(payload) {
      const { runCommandUnattended } = await import('jsails/internal');
      let outcome: UnattendedOutcome;
      try {
        outcome = await runCommandUnattended(command, {
          name,
          args: payload.args ?? fixedArgs,
          cwd: options.cwd ?? process.cwd(),
          stdout,
          stderr,
        });
      } catch (error) {
        throw new JobsErrors.Error('command_threw', {}, { cause: error });
      }
      if (outcome.kind === 'usage') throw new JobsErrors.Error('command_usage');
      if (outcome.kind === 'exit' && outcome.code === 0) return;
      throw new JobsErrors.Error('command_exit');
    },
  });
}
