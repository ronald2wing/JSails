/**
 * Adapt a CLI command to a job definition.
 *
 * A command is a human-facing delivery adapter: it parses argv, may prompt, and
 * returns an exit code. A scheduled task is background execution: no terminal,
 * no prompts, logs, retries. This bridge is the explicit seam between them.
 *
 * The scheduler stays job-first. A command that should run on a schedule is
 * registered with `defineCommandJob` and scheduled by its job name:
 *
 * ```ts
 * const reports = defineCommandJob(reportsCommand, { args: ['--force'] });
 * export default {
 *   registry: createJobRegistry({ reports }),
 *   schedules: [{ id: 'reports', job: 'reports', cron: '0 3 * * *' }],
 * };
 * ```
 *
 * The command runs with `interactive: false`; a prompt fails the job instead of
 * blocking a worker. `stdout`/`stderr` become job log lines by default. A
 * non-zero exit code throws a value-free {@link CommandJobError}; the transport
 * applies its normal retry policy.
 */

import { z } from 'zod';

import { commandFromClass, isCommandClass, type CommandClass } from '../cli/command-class.js';
import type { CliCommand, CliCommandContext } from '../cli/command-registry.js';
import { defineJob, type JobObjectDefinition } from './registry.js';

/** Stable failure code carried by {@link CommandJobError}. */
export type CommandJobErrorCode = 'invalid_command' | 'command_threw' | 'command_exit';

/** Raised when a command job is malformed or the command fails. Value-free. */
export class CommandJobError extends Error {
  readonly code: CommandJobErrorCode;

  constructor(code: CommandJobErrorCode, message: string) {
    super(message);
    this.name = 'CommandJobError';
    this.code = code;
  }
}

/** Options accepted by {@link defineCommandJob}. */
export interface CommandJobOptions {
  /** Job name. Defaults to the command name. */
  readonly name?: string;
  /** Fixed arguments when the job payload does not provide `args`. */
  readonly args?: readonly string[];
  /** Working directory exposed to the command. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Config path exposed to the command. Defaults to `jsails.runtime.js`. */
  readonly configPath?: string;
  /** Capture standard output. Defaults to a job log line. */
  readonly stdout?: (line: string) => void;
  /** Capture standard error. Defaults to a `[stderr]` job log line. */
  readonly stderr?: (line: string) => void;
}

/**
 * Wrap a CLI command as a job. The job payload is `{ args?: string[] }`; the
 * scheduled `data.args` overrides the fixed args when present.
 */
export function defineCommandJob(
  command: CliCommand | CommandClass,
  options: CommandJobOptions = {},
): JobObjectDefinition {
  const normalized = isCommandClass(command) ? commandFromClass(command) : command;
  if (
    normalized === null ||
    typeof normalized !== 'object' ||
    typeof normalized.name !== 'string' ||
    normalized.name.trim() === '' ||
    typeof normalized.run !== 'function'
  ) {
    throw new CommandJobError(
      'invalid_command',
      'defineCommandJob requires a command with a non-empty name and a run function',
    );
  }
  if (options.name !== undefined && options.name.trim() === '') {
    throw new CommandJobError('invalid_command', 'command job name must not be empty');
  }
  const fixedArgs = Object.freeze([...(options.args ?? [])]);
  for (const arg of fixedArgs) {
    if (typeof arg !== 'string') {
      throw new CommandJobError('invalid_command', 'command job args must be strings');
    }
  }

  return defineJob({
    ...(options.name === undefined ? {} : { name: options.name }),
    schema: z.object({ args: z.array(z.string()).optional() }).strict(),
    handler: async (data, context) => {
      const writes: Promise<void>[] = [];
      const logLine = (line: string): void => {
        writes.push(context.log(line));
      };
      const stdout = options.stdout ?? logLine;
      const stderr = options.stderr ?? ((line: string) => logLine(`[stderr] ${line}`));
      const commandContext: CliCommandContext = {
        configPath: options.configPath ?? 'jsails.runtime.js',
        cwd: options.cwd ?? process.cwd(),
        interactive: false,
        stdout,
        stderr,
      };

      let exitCode: number | void = undefined;
      let failed = false;
      try {
        exitCode = await normalized.run(data.args ?? fixedArgs, commandContext);
      } catch {
        failed = true;
      } finally {
        await Promise.all(writes).catch(() => {
          // Job logging is best-effort; a log failure never changes the command outcome.
        });
      }

      if (failed) {
        throw new CommandJobError('command_threw', `command "${normalized.name}" threw`);
      }
      if (exitCode === undefined) {
        return;
      }
      if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
        throw new CommandJobError(
          'command_exit',
          `command "${normalized.name}" returned an invalid exit code`,
        );
      }
      if (exitCode !== 0) {
        throw new CommandJobError(
          'command_exit',
          `command "${normalized.name}" exited with code ${exitCode}`,
        );
      }
    },
  });
}
