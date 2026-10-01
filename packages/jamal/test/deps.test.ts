/**
 * Tests for jamal's failure report, the one the `jsails` CLI prints: a
 * framework error's message and hint, a fixed line for any other error, then
 * the cause chain, value-free unless the injected environment sets
 * `JSAILS_DEBUG=1`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reportFailure, type JamalDeps } from '../src/deps.js';
import { JamalError } from '../src/error.js';

const SECRET = 'sk_live_FAKE0123456789';
const NOTE =
  '  (set JSAILS_DEBUG=1 to print the underlying error messages; they may contain values from your code or environment)';

function sink(env: Record<string, string>): { deps: JamalDeps; err: string[] } {
  const err: string[] = [];
  const deps: JamalDeps = {
    cwd: process.cwd(),
    env,
    stdout: () => undefined,
    stderr: (text) => err.push(text),
  };
  return { deps, err };
}

/** A Node-style errno failure whose message names a secret path. */
function errnoError(): Error {
  const error = new Error(`EACCES: permission denied, open '/srv/${SECRET}'`);
  (error as { code?: string }).code = 'EACCES';
  error.stack = undefined;
  return error;
}

describe('reportFailure', () => {
  it("prints a wrapped failure's errno code, never its message", async () => {
    const { deps, err } = sink({});
    const error = new JamalError('invalid_config', 'the backup file could not be created', {
      cause: errnoError(),
    });
    await reportFailure(deps, error, 'backup failed');
    assert.deepEqual(err, [
      'jamal: backup failed: the backup file could not be created',
      '  caused by: Error EACCES',
      NOTE,
    ]);
  });

  it('prints the underlying message under JSAILS_DEBUG=1', async () => {
    const { deps, err } = sink({ JSAILS_DEBUG: '1' });
    await reportFailure(
      deps,
      new JamalError('invalid_config', 'the backup file could not be created', {
        cause: errnoError(),
      }),
    );
    assert.equal(err[0], 'jamal: the backup file could not be created');
    assert.equal(err[1], '  caused by: Error EACCES');
    assert.ok(err.join('\n').includes(SECRET));
    assert.ok(!err.includes(NOTE));
  });

  it("withholds a failure's message when it is no framework error", async () => {
    const { deps, err } = sink({});
    await reportFailure(deps, errnoError(), 'backup failed');
    assert.deepEqual(err, [
      'jamal: backup failed: the command failed',
      '  error: Error EACCES',
      NOTE,
    ]);
  });

  it('prints only the message of a failure without a cause', async () => {
    const { deps, err } = sink({});
    await reportFailure(deps, new JamalError('confirmation_required', 'pass --yes'));
    assert.deepEqual(err, ['jamal: pass --yes']);
  });
});
