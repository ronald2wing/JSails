/**
 * `defineCommandJob`: a `defineCommand` command becomes an ordinary job
 * definition named by its options, whose handler parses the payload args
 * against the command's own options and runs it non-interactively, and whose
 * failures are value-free.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { defineCommand, type CommandContext } from 'jsails/kernel';

import { defineCommandJob } from '../../src/definition/command-job.js';
import { jobSpec, type JobContext } from '../../src/definition/define-job.js';
import { JobsErrors, type JobsErrorCode } from '../../src/errors/jobs-errors.js';

function refused(code: JobsErrorCode, rule?: string) {
  return (error: unknown) =>
    JobsErrors.is(error, code) &&
    (rule === undefined || (error.context as Record<string, unknown>).rule === rule);
}

function context(): JobContext {
  return { signal: new AbortController().signal } as JobContext;
}

const REPORT_OPTIONS = {
  force: { type: 'boolean', summary: 'Run them again' },
  only: { type: 'string', summary: 'One report' },
} as const;

describe('defineCommandJob', () => {
  test('runs a defineCommand command with the payload args parsed, non-interactively', async () => {
    const seen: CommandContext<typeof REPORT_OPTIONS, 'environment'>[] = [];
    const lines: string[] = [];
    const reports = defineCommand({
      summary: 'Run the reports',
      options: REPORT_OPTIONS,
      positionals: [{ name: 'period', summary: 'The period', required: false }],
      run(ctx) {
        seen.push(ctx);
        ctx.stdout('out');
        ctx.stderr('err');
      },
    });
    const Reports = defineCommandJob(reports, {
      name: 'reports',
      args: ['--only', 'sales'],
      cwd: '/srv/app',
      queue: 'maintenance',
      attempts: 1,
      stdout: (line) => lines.push(`o:${line}`),
      stderr: (line) => lines.push(`e:${line}`),
    });
    assert.equal(Reports.name, 'reports');
    assert.equal(Reports.queue, 'maintenance');
    const spec = jobSpec(Reports);
    assert.equal(spec.options.attempts, 1);

    await spec.handle({ args: ['--force', 'q3'] }, context());
    await spec.handle({}, context());

    assert.deepEqual(
      seen.map((ctx) => ({ values: { ...ctx.values }, positionals: ctx.positionals })),
      [
        { values: { force: true }, positionals: ['q3'] },
        { values: { only: 'sales' }, positionals: [] },
      ],
    );
    assert.equal(seen[0]!.name, 'reports');
    assert.equal(seen[0]!.interactive, false);
    assert.equal(seen[0]!.cwd, '/srv/app');
    await assert.rejects(seen[0]!.prompter.text('Name?'), /without interaction/);
    assert.deepEqual(lines, ['o:out', 'e:err', 'o:out', 'e:err']);
  });

  test('the payload schema refuses anything but string args', () => {
    const spec = jobSpec(
      defineCommandJob(defineCommand({ summary: 'Run', run: () => undefined }), {
        name: 'reports',
      }),
    );
    assert.equal(spec.schema.safeParse({ args: ['a'] }).success, true);
    assert.equal(spec.schema.safeParse({}).success, true);
    assert.equal(spec.schema.safeParse({ args: [1] }).success, false);
    assert.equal(spec.schema.safeParse({ args: [], extra: true }).success, false);
  });

  test('a throw, a usage error, or a non-zero or invalid exit fails value-free', async () => {
    const job = (name: string, run: () => unknown) =>
      jobSpec(
        defineCommandJob(defineCommand({ summary: 'Run', run: run as () => number }), { name }),
      );
    await assert.rejects(
      async () =>
        job('throwing', () => {
          throw new Error('SECRET-TOKEN');
        }).handle({}, context()),
      (error: unknown) =>
        JobsErrors.is(error, 'command_threw') &&
        !error.message.includes('SECRET-TOKEN') &&
        error.cause instanceof Error,
    );
    await assert.rejects(
      async () => job('exiting', () => Promise.resolve(3)).handle({}, context()),
      refused('command_exit'),
    );
    for (const code of [256, 1.5, -1]) {
      await assert.rejects(
        async () => job('invalid', () => code).handle({}, context()),
        refused('command_exit'),
        String(code),
      );
    }
    await assert.rejects(
      async () => job('unknown-flag', () => 0).handle({ args: ['--nope'] }, context()),
      refused('command_usage'),
    );
    const selfReported = jobSpec(
      defineCommandJob(
        defineCommand({ summary: 'Run', run: (ctx) => ctx.usage('which report?') }),
        { name: 'self-reported' },
      ),
    );
    await assert.rejects(async () => selfReported.handle({}, context()), refused('command_usage'));
  });

  test('refuses what is no command that needs only the environment, and malformed options', () => {
    const command = defineCommand({ summary: 'Run', run: () => 0 });
    for (const value of [
      { name: 'reports', run: () => 0 },
      defineCommand({ summary: 'Serve', needs: 'app', run: () => 0 }),
      null,
    ]) {
      assert.throws(
        () => defineCommandJob(value as never, { name: 'x' }),
        refused('invalid_definition', 'command'),
      );
    }
    assert.throws(
      () => defineCommandJob(command, {} as never),
      refused('invalid_definition', 'command_name'),
    );
    assert.throws(
      () => defineCommandJob(command, undefined as never),
      refused('invalid_definition', 'command_name'),
    );
    assert.throws(
      () => defineCommandJob(command, { name: 'bad name' }),
      refused('invalid_definition', 'command_name'),
    );
    assert.throws(
      () => defineCommandJob(command, { name: 'x', interactive: true } as never),
      refused('unknown_option'),
    );
    assert.throws(
      () => defineCommandJob(command, { name: 'x', args: [1] as never }),
      refused('invalid_definition', 'command_args'),
    );
    assert.throws(
      () => defineCommandJob(command, { name: 'x', args: '--force' as never }),
      refused('invalid_definition', 'command_args'),
    );
    assert.equal(defineCommandJob(command, { name: 'db.seed' }).name, 'db.seed');
  });
});
