/** Tests for `defineCommandJob`: the explicit bridge from a `defineCommand` command to a job, its argument handling, and its failure codes. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defineCommand } from '../../src/cli/define-command.js';
import type { CommandContext } from '../../src/cli/descriptor.js';
import { CliErrors } from '../../src/cli/errors.js';
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

const FORCE = { force: { type: 'boolean', summary: 'Do it anyway' } } as const;

describe('defineCommandJob', () => {
  it('parses the fixed args, runs the command without interaction and logs its output', async () => {
    let seen:
      | Omit<CommandContext<typeof FORCE>, 'prompter' | 'stdout' | 'stderr' | 'usage' | 'env'>
      | undefined;
    const logs: string[] = [];
    const job = defineCommandJob(
      defineCommand({
        summary: 'Say hello',
        options: FORCE,
        positionals: [{ name: 'who', summary: 'Who', required: false }],
        run(ctx) {
          seen = {
            name: ctx.name,
            values: ctx.values,
            positionals: ctx.positionals,
            cwd: ctx.cwd,
            environment: ctx.environment,
            interactive: ctx.interactive,
          };
          ctx.stdout('out');
          ctx.stderr('err');
        },
      }),
      { name: 'hello', args: ['--force', 'ada'], cwd: '/srv/project' },
    );

    await job.handler({}, context(logs));

    assert.equal(seen?.name, 'hello');
    assert.deepEqual({ ...seen?.values }, { force: true });
    assert.deepEqual(seen?.positionals, ['ada']);
    assert.equal(seen?.cwd, '/srv/project');
    assert.equal(seen?.interactive, false);
    assert.deepEqual(logs, ['out', '[stderr] err']);
  });

  it('lets the job payload override the fixed args', async () => {
    let received: readonly string[] = [];
    const job = defineCommandJob(
      defineCommand({
        summary: 'Echo',
        positionals: [{ name: 'word', summary: 'A word', required: false }],
        run(ctx) {
          received = ctx.positionals;
        },
      }),
      { name: 'echo', args: ['fixed'] },
    );

    await job.handler({ args: ['payload'] }, context([]));
    assert.deepEqual(received, ['payload']);
  });

  it('refuses an unknown flag as command_usage, without running the command', async () => {
    let ran = false;
    const job = defineCommandJob(
      defineCommand({
        summary: 'Strict',
        run() {
          ran = true;
        },
      }),
      { name: 'strict' },
    );
    await assert.rejects(
      Promise.resolve(job.handler({ args: ['--bogus=secret-value'] }, context([]))),
      (error: unknown) =>
        error instanceof CommandJobError &&
        error.code === 'command_usage' &&
        !error.message.includes('secret-value'),
    );
    assert.equal(ran, false);
  });

  it('fails a question the command asks, since a job never prompts', async () => {
    const job = defineCommandJob(
      defineCommand({
        summary: 'Asks',
        async run(ctx) {
          await ctx.prompter.text('Name?');
        },
      }),
      { name: 'asks' },
    );
    await assert.rejects(
      Promise.resolve(job.handler({}, context([]))),
      (error: unknown) =>
        error instanceof CommandJobError &&
        error.code === 'command_threw' &&
        CliErrors.is(error.cause, 'interactive_unavailable'),
    );
  });

  it('turns a non-zero exit code into a value-free CommandJobError', async () => {
    const job = defineCommandJob(defineCommand({ summary: 'Fails', run: () => 2 }), {
      name: 'fails',
    });
    await assert.rejects(
      Promise.resolve(job.handler({}, context([]))),
      (error: unknown) =>
        error instanceof CommandJobError &&
        error.code === 'command_exit' &&
        /exited with code 2/.test(error.message),
    );
  });

  it('turns a thrown command error into a value-free CommandJobError', async () => {
    const job = defineCommandJob(
      defineCommand({
        summary: 'Throws',
        run: () => {
          throw new Error('secret-value');
        },
      }),
      { name: 'throws' },
    );
    await assert.rejects(
      Promise.resolve(job.handler({}, context([]))),
      (error: unknown) =>
        error instanceof CommandJobError &&
        error.code === 'command_threw' &&
        !error.message.includes('secret-value'),
    );
  });

  it('accepts a custom stdout/stderr sink', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const job = defineCommandJob(
      defineCommand({
        summary: 'Writes',
        run(ctx) {
          ctx.stdout('a');
          ctx.stderr('b');
        },
      }),
      { name: 'writes', stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
    );
    await job.handler({}, context([]));
    assert.deepEqual(out, ['a']);
    assert.deepEqual(err, ['b']);
  });

  it('refuses what defineCommand did not make, a command that needs stages, and an empty name', () => {
    const plain = { summary: 'x', needs: 'environment', options: {}, run: () => 0 };
    assert.throws(
      () =>
        defineCommandJob(plain as unknown as Parameters<typeof defineCommandJob>[0], { name: 'x' }),
      (error) => error instanceof CommandJobError && error.code === 'invalid_command',
    );
    const staged = defineCommand({ summary: 'Staged', needs: 'app', run: () => 0 });
    assert.throws(
      () =>
        defineCommandJob(staged as unknown as Parameters<typeof defineCommandJob>[0], {
          name: 'x',
        }),
      (error) => error instanceof CommandJobError && error.code === 'invalid_command',
    );
    assert.throws(
      () => defineCommandJob(defineCommand({ summary: 'Ok', run: () => 0 }), { name: ' ' }),
      (error) => error instanceof CommandJobError && error.code === 'invalid_command',
    );
  });
});
