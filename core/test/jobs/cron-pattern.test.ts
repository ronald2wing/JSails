/** Tests for local cron-pattern validation against the provider's grammar. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isValidCronPattern } from '../../src/jobs/cron-pattern.js';

describe('isValidCronPattern', () => {
  it('accepts the patterns the provider parses', () => {
    for (const pattern of [
      '* * * * *',
      '0 3 * * *',
      '*/15 9-17 * * 1-5',
      '0 0 1,15 * *',
      '30 * * * * *',
      '0 0 * JAN,jul MON-FRI',
      '0 0 L * *',
      '0 0 * * 5L',
      '0 0 * * 1#2',
      '0 0 ? * 0',
      '0 0 * * 7',
      '5/10 * * * *',
      '@daily',
      '@weekdays',
    ]) {
      assert.equal(isValidCronPattern(pattern), true, pattern);
    }
  });

  it('rejects malformed patterns', () => {
    for (const pattern of [
      '61 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * * 13 *',
      '* * * * 8',
      '* * * * * * *',
      '*/0 * * * *',
      '5-1 * * * *',
      '* * * FOO *',
      'every minute',
      '@sometimes',
      '@DAILY',
      '1,,2 * * * *',
    ]) {
      assert.equal(isValidCronPattern(pattern), false, pattern);
    }
  });
});
