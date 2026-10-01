/**
 * Level vocabulary tests: ordering, the threshold check, and value-free
 * validation of an option that must be a level.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertLogLevel, LEVEL_ORDER, meetsThreshold } from '../src/levels.js';

describe('levels', () => {
  it('orders debug < info < warn < error', () => {
    assert.ok(LEVEL_ORDER.debug < LEVEL_ORDER.info);
    assert.ok(LEVEL_ORDER.info < LEVEL_ORDER.warn);
    assert.ok(LEVEL_ORDER.warn < LEVEL_ORDER.error);
    assert.ok(Object.isFrozen(LEVEL_ORDER));
  });

  it('meetsThreshold passes a level at or above the minimum', () => {
    assert.equal(meetsThreshold('warn', 'warn'), true);
    assert.equal(meetsThreshold('error', 'debug'), true);
    assert.equal(meetsThreshold('info', 'warn'), false);
  });

  it('assertLogLevel accepts the four levels and rejects anything else without echoing it', () => {
    for (const level of ['debug', 'info', 'warn', 'error']) {
      assertLogLevel(level, 'test');
    }
    for (const value of ['critical', 'toString', '', 3, undefined, null]) {
      assert.throws(
        () => assertLogLevel(value, 'consoleChannel.minLevel'),
        (error: unknown) =>
          error instanceof TypeError &&
          error.message.startsWith('consoleChannel.minLevel') &&
          !error.message.includes('critical'),
      );
    }
  });
});
