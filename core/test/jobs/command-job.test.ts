import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CliCommand } from '../../src/cli/command-registry.js';
import { CommandJobError, defineCommandJob } from '../../src/jobs/command-job.js';
import type { JobContext } from '../../src/jobs/registry.js';

function context(logs: string[]): JobContext {
  return {
    jobId: '1',
    name: 'hello',
    attemptsMade: 0,
    attemptsStarted: 0,
    log: async (message) => {
      logs.push(message);
    },
    updateProgress: async () => {},
  };
}

function command(overrides: Partial<CliCommand> = {}): CliCommand {
  return {
    name: 'hello',
    summary: 'Say hello',
    run: () => 0,
    ...overrides,
  };
}

describe('defineCommandJob', () => {
  it('runs the command non-interactively with fixed args and captures output', async () => {
    let seen:
      | {
          args: readonly string[];
          interactive: boolean | undefined;
          cwd: string;
          configPath: string;
        }
      | undefined;
    const logs: string[] = [];
    const job = defineCommandJob(
      command({
        run: async (args, ctx) => {
          seen = {
            args,
            interactive: ctx.interactive,
            cwd: ctx.cwd,
            configPath: ctx.configPath,
          };
          ctx.stdout('out');
          ctx.stderr('err');
          return 0;
        },
      }),
      { args: ['--force'], cwd: '/tmp/project', configPath: '/tmp/project/jsails.runtime.js' },
    );

    await job.handler({}, context(logs));

    assert.deepEqual(seen, {
      args: ['--force'],
      interactive: false,
      cwd: '/tmp/project',
      configPath: '/tmp/project/jsails.runtime.js',
    });
    assert.deepEqual(logs, ['out', '[stderr] err']);
  });

  it('lets the job payload override fixed args', async () => {
    let received: readonly string[] = [];
    const job = defineCommandJob(
      command({
        run: (args) => {
          received = args;
          return 0;
        },
      }),
      { args: ['fixed'] },
    );

    await job.handler({ args: ['payload'] }, context([]));
    assert.deepEqual(received, ['payload']);
  });

  it('turns a non-zero exit code into a value-free CommandJobError', async () => {
    const job = defineCommandJob(command({ run: () => 2 }));
    await assert.rejects(
      async () => {
        await job.handler({}, context([]));
      },
      (error: unknown) =>
        error instanceof CommandJobError &&
        error.code === 'command_exit' &&
        /exited with code 2/.test(error.message),
    );
  });

  it('turns a thrown command error into a value-free CommandJobError', async () => {
    const job = defineCommandJob(
      command({
        run: () => {
          throw new Error('secret-value');
        },
      }),
    );
    await assert.rejects(
      async () => {
        await job.handler({}, context([]));
      },
      (error: unknown) =>
        error instanceof CommandJobError &&
        error.code === 'command_threw' &&
        !String(error.message).includes('secret-value'),
    );
  });

  it('accepts a custom stdout/stderr sink', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const job = defineCommandJob(
      command({
        run: (_args, ctx) => {
          ctx.stdout('a');
          ctx.stderr('b');
          return 0;
        },
      }),
      { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
    );
    await job.handler({}, context([]));
    assert.deepEqual(out, ['a']);
    assert.deepEqual(err, ['b']);
  });

  it('rejects a malformed command', () => {
    assert.throws(
      () => defineCommandJob({ name: '', summary: 'x', run: () => 0 }),
      (error) => error instanceof CommandJobError && error.code === 'invalid_command',
    );
  });
});
