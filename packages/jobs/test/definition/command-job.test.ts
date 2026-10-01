/**
 * `defineCommandJob`: a command becomes an ordinary job definition whose
 * handler runs it non-interactively with the attempt signal, and whose
 * failures are value-free.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CommandJobError,
  defineCommandJob,
  type CommandJobRunContext,
} from '../../src/definition/command-job.js';
import { jobSpec, type JobContext } from '../../src/definition/define-job.js';
import { JobDefinitionError } from '../../src/definition/definition-error.js';

function context(signal = new AbortController().signal): JobContext {
  return { signal } as JobContext;
}

describe('defineCommandJob', () => {
  test('runs the command with the payload args, non-interactively, with the attempt signal', async () => {
    const calls: { args: readonly string[]; context: CommandJobRunContext }[] = [];
    const lines: string[] = [];
    const Reports = defineCommandJob(
      {
        name: 'reports',
        run(args, runContext) {
          calls.push({ args, context: runContext });
          runContext.stdout('out');
          runContext.stderr('err');
          return 0;
        },
      },
      {
        args: ['--fixed'],
        cwd: '/srv/app',
        queue: 'maintenance',
        attempts: 1,
        stdout: (line) => lines.push(`o:${line}`),
        stderr: (line) => lines.push(`e:${line}`),
      },
    );
    assert.equal(Reports.name, 'reports');
    assert.equal(Reports.queue, 'maintenance');
    const spec = jobSpec(Reports);
    assert.equal(spec.options.attempts, 1);
    const controller = new AbortController();
    await spec.handle({ args: ['--force'] }, context(controller.signal));
    await spec.handle({}, context());
    assert.deepEqual(
      calls.map((call) => call.args),
      [['--force'], ['--fixed']],
    );
    assert.equal(calls[0]!.context.interactive, false);
    assert.equal(calls[0]!.context.cwd, '/srv/app');
    assert.equal(calls[0]!.context.signal, controller.signal);
    assert.deepEqual(lines, ['o:out', 'e:err', 'o:out', 'e:err']);
  });

  test('the payload schema refuses anything but string args', () => {
    const spec = jobSpec(defineCommandJob({ name: 'reports', run: () => undefined }));
    assert.equal(spec.schema.safeParse({ args: ['a'] }).success, true);
    assert.equal(spec.schema.safeParse({}).success, true);
    assert.equal(spec.schema.safeParse({ args: [1] }).success, false);
    assert.equal(spec.schema.safeParse({ args: [], extra: true }).success, false);
  });

  test('a throwing command or a non-zero exit fails value-free', async () => {
    const throwing = jobSpec(
      defineCommandJob({
        name: 'throwing',
        run: () => {
          throw new Error('SECRET-TOKEN');
        },
      }),
    );
    await assert.rejects(
      async () => throwing.handle({}, context()),
      (error: unknown) =>
        error instanceof CommandJobError &&
        error.code === 'command_threw' &&
        !error.message.includes('SECRET-TOKEN'),
    );
    const exiting = jobSpec(defineCommandJob({ name: 'exiting', run: () => Promise.resolve(3) }));
    await assert.rejects(
      async () => exiting.handle({}, context()),
      (error: unknown) => error instanceof CommandJobError && error.code === 'command_exit',
    );
    const invalid = jobSpec(defineCommandJob({ name: 'invalid', run: () => 999 }));
    await assert.rejects(
      async () => invalid.handle({}, context()),
      (error: unknown) => error instanceof CommandJobError && error.code === 'command_exit',
    );
  });

  test('a malformed command or option is refused', () => {
    assert.throws(() => defineCommandJob({ name: 'x' } as never), JobDefinitionError);
    assert.throws(() => defineCommandJob({ name: 'bad name', run: () => 0 }), JobDefinitionError);
    assert.throws(
      () => defineCommandJob({ name: 'x', run: () => 0 }, { interactive: true } as never),
      (error: unknown) => error instanceof JobDefinitionError && error.code === 'unknown_option',
    );
    assert.throws(
      () => defineCommandJob({ name: 'x', run: () => 0 }, { args: [1] as never }),
      JobDefinitionError,
    );
    assert.throws(
      () => defineCommandJob({ name: 'x', run: () => 0 }, { args: '--force' as never }),
      JobDefinitionError,
    );
    const renamed = defineCommandJob({ name: 'db:seed all', run: () => 0 }, { name: 'db.seed' });
    assert.equal(renamed.name, 'db.seed');
  });
});
