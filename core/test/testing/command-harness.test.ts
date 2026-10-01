/**
 * `runCommand` (`jsails/testing`) runs a `defineCommand` command as the
 * dispatcher would: its argv parsed against its own options, the exit code
 * read as `jsails` reads it, so a result the CLI refuses fails the test too.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defineCommand } from '../../src/cli/define-command.js';
import { CliErrors } from '../../src/cli/errors.js';
import { runCommand } from '../../src/testing/command-harness.js';

const ENV = Object.freeze({ JSAILS_ENV: 'test', NODE_ENV: 'test' });

describe('runCommand', () => {
  it('runs the command with its parsed argv and returns its exit code and output', async () => {
    const greet = defineCommand({
      summary: 'Greet',
      options: { loud: { type: 'boolean', summary: 'Shout' } },
      positionals: [{ name: 'who', summary: 'Whom to greet' }],
      run(ctx) {
        ctx.stdout(ctx.values.loud === true ? `HI ${ctx.positionals[0]}` : 'hi');
        return 3;
      },
    });
    assert.deepEqual(await runCommand(greet, { args: ['--loud', 'ada'], env: ENV }), {
      code: 3,
      stdout: ['HI ada'],
      stderr: [],
    });
    const quiet = defineCommand({ summary: 'Quiet', run() {} });
    assert.equal((await runCommand(quiet, { env: ENV })).code, 0);
    const usage = await runCommand(greet, { args: ['--bogus'], env: ENV });
    assert.equal(usage.code, 2);
  });

  it('refuses an exit code that is no integer from 0 to 255, as the dispatcher does', async () => {
    for (const value of [256, 1.5, -1, Number.NaN]) {
      const odd = defineCommand({ summary: 'Odd', run: () => value });
      await assert.rejects(
        runCommand(odd, { env: ENV, name: 'odd' }),
        (error: unknown) =>
          CliErrors.is(error, 'invalid_exit_code') && error.context['command'] === 'odd',
        String(value),
      );
    }
    for (const value of [0, 1, 255]) {
      const fine = defineCommand({ summary: 'Fine', run: () => value });
      assert.equal((await runCommand(fine, { env: ENV })).code, value);
    }
  });
});
