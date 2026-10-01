/**
 * Tests for `detach` and `escalate`: the reporter receives a rejection exactly
 * once, a fulfilled promise or a synchronous (non-promise) result never reaches
 * it, and `detach(p, escalate)` ends a process the way `void p` does. The last
 * runs in a child process, because an unhandled rejection in this one would
 * fail the test file.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { setImmediate as nextMacrotask } from 'node:timers/promises';

import { detach, escalate } from '../../src/support/detach.js';

describe('detach', () => {
  it('hands a rejection to the reporter', async () => {
    const reported: unknown[] = [];
    const error = new Error('failed');
    detach(Promise.reject(error), (cause) => reported.push(cause));
    await nextMacrotask();
    assert.deepEqual(reported, [error]);
  });

  it('never calls the reporter for a fulfilled promise', async () => {
    const reported: unknown[] = [];
    detach(Promise.resolve(1), (cause) => reported.push(cause));
    await nextMacrotask();
    assert.deepEqual(reported, []);
  });

  it('accepts and ignores a synchronous void result', async () => {
    const reported: unknown[] = [];
    const callback = (): void | Promise<void> => undefined;
    detach(callback(), (cause) => reported.push(cause));
    await nextMacrotask();
    assert.deepEqual(reported, []);
  });

  it('reports at most once, even for a thenable that rejects twice', async () => {
    const reported: unknown[] = [];
    const thenable: PromiseLike<never> = {
      then(_onFulfilled, onRejected) {
        onRejected?.('first');
        onRejected?.('second');
        return Promise.resolve() as never;
      },
    };
    detach(thenable, (cause) => reported.push(cause));
    await nextMacrotask();
    assert.deepEqual(reported, ['first']);
  });

  it('does not run the reporter synchronously', () => {
    let reported = false;
    detach(Promise.reject(new Error('later')), () => {
      reported = true;
    });
    assert.equal(reported, false);
  });
});

describe('escalate', () => {
  it('rethrows the error it is given', () => {
    const error = new Error('broken invariant');
    assert.throws(
      () => escalate(error),
      (thrown) => thrown === error,
    );
  });
});

describe('detach(p, escalate) in a process', () => {
  const detachModule = new URL('../../src/support/detach.js', import.meta.url).href;

  /** Runs `body` as an ES module in a fresh node process, without the test preload. */
  function runModule(body: string): { status: number | null; stderr: string } {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', body], {
      env,
      encoding: 'utf8',
    });
    return { status: result.status, stderr: result.stderr };
  }

  it('ends the process with an unhandled rejection, exactly as `void p` does', () => {
    const viaVoid = runModule(`void Promise.reject(new Error('lost-rejection'));`);
    const viaDetach = runModule(
      `import { detach, escalate } from ${JSON.stringify(detachModule)};
detach(Promise.reject(new Error('lost-rejection')), escalate);`,
    );
    assert.notEqual(viaVoid.status, 0);
    assert.equal(viaDetach.status, viaVoid.status);
    assert.match(viaVoid.stderr, /lost-rejection/);
    assert.match(viaDetach.stderr, /lost-rejection/);
  });

  it('surfaces a throwing reporter as an unhandled rejection instead of swallowing it', () => {
    const outcome = runModule(
      `import { detach } from ${JSON.stringify(detachModule)};
detach(Promise.reject(new Error('original')), () => { throw new Error('reporter-failed'); });`,
    );
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /reporter-failed/);
  });

  it('leaves a fulfilled promise without effect', () => {
    const outcome = runModule(
      `import { detach, escalate } from ${JSON.stringify(detachModule)};
detach(Promise.resolve(1), escalate);`,
    );
    assert.equal(outcome.status, 0, outcome.stderr);
  });
});
