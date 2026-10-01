/**
 * Read the `code` of whatever a call throws or a promise rejects with, so
 * tenancy tests assert on the stable error code rather than on the error class.
 */

import assert from 'node:assert/strict';

/** The `code` of the error `fn` throws; fails the test when it throws nothing. */
export function thrownCode(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    assert.ok(typeof error === 'object' && error !== null, 'expected an error object');
    return 'code' in error ? error.code : undefined;
  }
  assert.fail('expected the call to throw');
}

/** The `code` of the error `promise` rejects with; fails the test when it resolves. */
export async function rejectedCode(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    assert.ok(typeof error === 'object' && error !== null, 'expected an error object');
    return 'code' in error ? error.code : undefined;
  }
  assert.fail('expected the promise to reject');
}
