/**
 * The final-failure rule every transport applies: a failure is final when it
 * is not retryable or when it spent the last attempt.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isFinalFailure } from '../../src/contract/final-failure.js';

describe('isFinalFailure', () => {
  test('follows the rule table', () => {
    const cases: readonly [number, number | undefined, boolean, boolean][] = [
      [0, undefined, true, true],
      [0, 1, true, true],
      [0, 2, true, false],
      [1, 2, true, true],
      [3, 2, true, true],
      [0, 25, false, true],
      [24, 25, true, true],
      [23, 25, true, false],
    ];
    for (const [attemptsMade, attempts, retryable, final] of cases) {
      assert.equal(
        isFinalFailure(attemptsMade, attempts, retryable),
        final,
        `attemptsMade ${attemptsMade}, attempts ${attempts}, retryable ${retryable}`,
      );
    }
  });
});
