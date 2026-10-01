/** Tests for `isUniqueViolation`: each supported driver's report, and nothing else. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { QueryFailedError } from 'typeorm';

import { isUniqueViolation } from '../../src/database/index.js';

function failed(driverError: unknown): QueryFailedError {
  return new QueryFailedError('INSERT', [], driverError as Error);
}

describe('isUniqueViolation', () => {
  it('recognizes each driver report of a unique violation', () => {
    for (const driver of [
      { message: 'UNIQUE constraint failed: member.email' },
      { code: 'ER_DUP_ENTRY' },
      { code: 'ER_DUP_KEY' },
      { code: '23505' },
      { errno: 1062 },
      { errno: 2067 },
    ]) {
      assert.equal(isUniqueViolation(failed(driver)), true, JSON.stringify(driver));
    }
  });

  it('rejects other query failures and other errors', () => {
    assert.equal(
      isUniqueViolation(failed({ code: 'ER_NO_DEFAULT_FOR_FIELD', errno: 1364 })),
      false,
    );
    assert.equal(isUniqueViolation(failed({ code: '23502' })), false);
    assert.equal(isUniqueViolation(new Error('UNIQUE constraint failed: x')), false);
    assert.equal(isUniqueViolation(undefined), false);
  });
});
