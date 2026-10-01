/**
 * `defineCommandJob`: run a CLI command as a job, the explicit seam between a
 * human-facing command (argv, prompts, an exit code) and background work (no
 * terminal, retries). The result is an ordinary {@link defineJob} definition
 * whose payload is `{ args?: string[] }`, so a schedule or a dispatch runs it
 * like any other job.
 *
 * The command runs with `interactive: false`, so a prompt fails the job
 * instead of blocking a worker, and with the attempt's abort signal. Output
 * lines go to the given sinks (by default the worker's own stdout and
 * stderr). A thrown error or a non-zero exit code fails the attempt with a
 * value-free {@link CommandJobError}, and the job's retry policy applies.
 *
 * The command is taken structurally (a name and a `run` function), so this
 * module does not depend on the CLI's command registry.
 */

import { JsailsError } from 'jsails/support';
import { z } from 'jsails/zod';

import { defineJob, isJobName, type JobDefinition } from './define-job.js';
import { JobDefinitionError } from './definition-error.js';

/** What a command run as a job receives besides its arguments. */
export interface CommandJobRunContext {
  readonly cwd: string;
  readonly interactive: false;
  readonly signal: AbortSignal;
  stdout(line: string): void;
  stderr(line: string): void;
}

/** A command, as far as running it as a job needs. */
export interface CommandJobTarget {
  readonly name: string;
  run(
    args: readonly string[],
    context: CommandJobRunContext,
  ): Promise<number | undefined | void> | number | undefined | void;
}

/** Options accepted by {@link defineCommandJob}. */
export interface CommandJobOptions<N extends string, Q extends string> {
  /** The job name. Defaults to the command name. */
  readonly name?: N;
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

export type CommandJobErrorCode = 'command_threw' | 'command_exit';

/** Raised when the command throws or exits non-zero. Value-free. */
export class CommandJobError extends JsailsError {
  constructor(
    readonly code: CommandJobErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
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

function invalid(message: string): JobDefinitionError {
  return new JobDefinitionError('invalid_definition', message);
}

/**
 * Wrap a command as a job.
 *
 * @throws {JobDefinitionError} for a command without a valid name or `run`,
 *   an unknown option, or non-string fixed arguments.
 */
export function defineCommandJob<
  const N extends string = string,
  const Q extends string = 'default',
>(
  command: CommandJobTarget,
  options: CommandJobOptions<N, Q> = {},
): JobDefinition<N, typeof commandJobPayload, Q> {
  if (
    typeof command !== 'object' ||
    command === null ||
    typeof command.name !== 'string' ||
    typeof command.run !== 'function'
  ) {
    throw invalid('defineCommandJob needs a command with a name and a run function');
  }
  if (!Object.keys(options).every((key) => COMMAND_OPTION_KEYS.has(key))) {
    throw new JobDefinitionError(
      'unknown_option',
      'defineCommandJob options have a field that is not an option',
    );
  }
  const name = options.name ?? command.name;
  if (!isJobName(name)) {
    throw invalid(
      'a command job needs a valid job name; pass `name` when the command name is not one',
    );
  }
  if (
    options.args !== undefined &&
    (!Array.isArray(options.args) || !options.args.every((arg) => typeof arg === 'string'))
  ) {
    throw invalid('command job args must be strings');
  }
  const fixedArgs = Object.freeze([...(options.args ?? [])]);
  const stdout = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const run = command.run.bind(command);
  return defineJob<N, typeof commandJobPayload, Q>({
    name: name as N,
    schema: commandJobPayload,
    ...(options.queue === undefined ? {} : { queue: options.queue }),
    ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    async handle(payload, context) {
      let exitCode: number | undefined | void;
      try {
        exitCode = await run(payload.args ?? fixedArgs, {
          cwd: options.cwd ?? process.cwd(),
          interactive: false,
          signal: context.signal,
          stdout,
          stderr,
        });
      } catch (error) {
        throw new CommandJobError('command_threw', 'the command run as a job threw', {
          cause: error,
        });
      }
      if (exitCode === undefined || exitCode === 0) return;
      if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
        throw new CommandJobError(
          'command_exit',
          'the command run as a job returned an invalid exit code',
        );
      }
      throw new CommandJobError(
        'command_exit',
        `the command run as a job exited with code ${exitCode}`,
      );
    },
  });
}
