/**
 * Adapt a `defineCommand` command to a job definition.
 *
 * A command is a human-facing delivery adapter: it parses argv, may prompt, and
 * returns an exit code. A scheduled task is background execution: no terminal,
 * no prompts, logs, retries. This bridge is the explicit seam between them.
 *
 * The scheduler stays job-first. A command that should run on a schedule is
 * registered with `defineCommandJob` and scheduled by its job name:
 *
 * ```ts
 * import reportsCommand from './commands/reports.js';
 *
 * const reports = defineCommandJob(reportsCommand, { name: 'reports', args: ['--force'] });
 * export default {
 *   registry: createJobRegistry({ reports }),
 *   schedules: [{ id: 'reports', job: 'reports', cron: '0 3 * * *' }],
 * };
 * ```
 *
 * Only a command that needs the environment alone can run as a job: the
 * worker has already assembled its app, so there is no stage to open. Its
 * argv is parsed against its own options, as the CLI does; it sees the
 * environment the worker resolved, runs without interaction (a prompt fails
 * the job instead of blocking a worker), and its `stdout`/`stderr` become job
 * log lines by default. A usage error, a throw or a non-zero exit code throws
 * a value-free {@link CommandJobError}; the transport applies its normal retry
 * policy.
 */

import { z } from 'zod';

import type { DefinedCommand } from '../cli/define-command.js';
import { isDefinedCommand } from '../cli/define-command.js';
import type { CommandOptions } from '../cli/descriptor.js';
import type { UnattendedOutcome } from '../cli/run-unattended.js';
import { defineJob, type JobObjectDefinition } from './registry.js';
import { JsailsError } from '../errors/jsails-error.js';

/** Stable failure code carried by {@link CommandJobError}. */
export type CommandJobErrorCode =
  'invalid_command' | 'command_usage' | 'command_threw' | 'command_exit';

/** Raised when a command job is malformed or the command fails. Value-free. */
export class CommandJobError extends JsailsError {
  constructor(
    readonly code: CommandJobErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Options accepted by {@link defineCommandJob}. */
export interface CommandJobOptions {
  /** The job name, which also names the command in its context and errors. */
  readonly name: string;
  /** Fixed arguments when the job payload does not provide `args`. */
  readonly args?: readonly string[];
  /** Working directory exposed to the command. Defaults to `process.cwd()` at run time. */
  readonly cwd?: string;
  /** Capture standard output. Defaults to a job log line. */
  readonly stdout?: (line: string) => void;
  /** Capture standard error. Defaults to a `[stderr]` job log line. */
  readonly stderr?: (line: string) => void;
}

/**
 * Wrap a command as a job. The job payload is `{ args?: string[] }`; the
 * scheduled `data.args` overrides the fixed args when present.
 */
export function defineCommandJob(
  command: DefinedCommand<CommandOptions, 'environment'>,
  options: CommandJobOptions,
): JobObjectDefinition {
  if (!isDefinedCommand(command) || command.needs !== 'environment') {
    throw new CommandJobError(
      'invalid_command',
      'defineCommandJob requires a defineCommand command that needs only the environment',
    );
  }
  if (typeof options.name !== 'string' || options.name.trim() === '') {
    throw new CommandJobError('invalid_command', 'command job name must not be empty');
  }
  const fixedArgs = Object.freeze([...(options.args ?? [])]);
  for (const arg of fixedArgs) {
    if (typeof arg !== 'string') {
      throw new CommandJobError('invalid_command', 'command job args must be strings');
    }
  }
  const { name } = options;

  return defineJob({
    name,
    schema: z.object({ args: z.array(z.string()).optional() }).strict(),
    handler: async (data, context) => {
      // The runner is loaded when a job runs, so declaring a command job
      // (importing `jsails/jobs`) loads no argument parser, prompter or
      // environment resolver.
      const { runUnattended } = await import('../cli/run-unattended.js');
      const writes: Promise<void>[] = [];
      const logLine = (line: string): void => {
        writes.push(context.log(line));
      };
      let outcome: UnattendedOutcome;
      try {
        outcome = await runUnattended(command, {
          name,
          args: data.args ?? fixedArgs,
          cwd: options.cwd ?? process.cwd(),
          stdout: options.stdout ?? logLine,
          stderr: options.stderr ?? ((line: string) => logLine(`[stderr] ${line}`)),
        });
      } catch (error) {
        throw new CommandJobError('command_threw', `command job "${name}" threw`, {
          cause: error,
        });
      } finally {
        await Promise.all(writes).catch(() => {
          // Job logging is best-effort; a log failure never changes the command outcome.
        });
      }
      if (outcome.kind === 'usage') {
        throw new CommandJobError('command_usage', `command job "${name}" was given invalid args`);
      }
      if (outcome.kind === 'invalid_exit') {
        throw new CommandJobError(
          'command_exit',
          `command job "${name}" returned an invalid exit code`,
        );
      }
      if (outcome.code !== 0) {
        throw new CommandJobError(
          'command_exit',
          `command job "${name}" exited with code ${outcome.code}`,
        );
      }
    },
  });
}
