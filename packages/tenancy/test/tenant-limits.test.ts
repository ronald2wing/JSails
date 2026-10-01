/**
 * Tests for plan limits: the `checkLimit` boundary table, unset, inherited
 * and infinite limits, a zero delta after a downgrade, the refusal of values
 * that are not counts, and `limitValue` reading one limit.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkLimit, limitValue, type TenantLimits } from '../src/tenant-limits.js';
import { thrownCode } from './thrown-code.js';

describe('checkLimit', () => {
  it('allows exactly up to the limit', () => {
    const limits: TenantLimits = { seats: 3, projects: 0 };
    const table: readonly [string, number, number | undefined, string][] = [
      ['seats', 0, undefined, 'ok'],
      ['seats', 2, undefined, 'ok'],
      ['seats', 3, undefined, 'limit_exceeded'],
      ['seats', 1, 2, 'ok'],
      ['seats', 1, 3, 'limit_exceeded'],
      ['seats', 3, 0, 'ok'],
      ['seats', 4, 0, 'limit_exceeded'],
      ['projects', 0, undefined, 'limit_exceeded'],
      ['projects', 0, 0, 'ok'],
    ];
    for (const [name, current, delta, expected] of table) {
      assert.equal(
        delta === undefined
          ? checkLimit(limits, name, current)
          : checkLimit(limits, name, current, delta),
        expected,
        `${name} ${current} + ${String(delta)}`,
      );
    }
  });

  it('treats unset, undefined, inherited and infinite limits as unlimited', () => {
    const limits: TenantLimits = { domains: undefined, seats: Number.POSITIVE_INFINITY };
    const large = Number.MAX_SAFE_INTEGER - 1;
    assert.equal(checkLimit(limits, 'domains', large), 'ok');
    assert.equal(checkLimit(limits, 'seats', large), 'ok');
    assert.equal(checkLimit(limits, 'projects', large), 'ok');
    assert.equal(checkLimit({}, 'constructor', 5), 'ok');
    assert.equal(checkLimit({}, 'toString', 5), 'ok');
  });

  it('refuses counts, deltas and limits that are not non-negative integers', () => {
    const calls: readonly (() => unknown)[] = [
      () => checkLimit({ seats: 1 }, 'seats', -1),
      () => checkLimit({ seats: 1 }, 'seats', 0.5),
      () => checkLimit({ seats: 1 }, 'seats', Number.NaN),
      () => checkLimit({ seats: 1 }, 'seats', 0, -1),
      () => checkLimit({ seats: 1 }, 'seats', 0, 1.5),
      () => checkLimit({ seats: -1 }, 'seats', 0),
      () => checkLimit({ seats: 2.5 }, 'seats', 0),
      () => checkLimit({ seats: Number.NEGATIVE_INFINITY }, 'seats', 0),
      () => checkLimit({ seats: Number.NaN }, 'seats', 0),
      () => checkLimit({ seats: '3' } as unknown as TenantLimits, 'seats', 0),
      () => checkLimit({ seats: 1 }, '', 0),
      () => checkLimit(null as unknown as TenantLimits, 'seats', 0),
    ];
    for (const [index, call] of calls.entries()) {
      assert.equal(thrownCode(call), 'invalid_limits', String(index));
    }
  });
});

describe('limitValue', () => {
  it('reads own limits only', () => {
    const inherited: unknown = Object.create({ seats: 4 });
    assert.equal(limitValue({ seats: 4 }, 'seats'), 4);
    assert.equal(limitValue(inherited, 'seats'), undefined);
    assert.equal(limitValue({ seats: undefined }, 'seats'), undefined);
    assert.equal(limitValue({}, 'seats'), undefined);
    assert.equal(
      thrownCode(() => limitValue(3, 'seats')),
      'invalid_limits',
    );
  });
});
