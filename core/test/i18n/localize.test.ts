/** Tests for `createLocalizer`: formatter reuse across calls and per-option keying. */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { createLocalizer, I18nError } from '../../src/i18n/index.js';

const RealDateTimeFormat = Intl.DateTimeFormat;
const RealNumberFormat = Intl.NumberFormat;

afterEach(() => {
  Intl.DateTimeFormat = RealDateTimeFormat;
  Intl.NumberFormat = RealNumberFormat;
});

/** Count constructions of both Intl formatters until the test ends. */
function countConstructions(): { dates: number; numbers: number } {
  const counts = { dates: 0, numbers: 0 };
  Intl.DateTimeFormat = new Proxy(RealDateTimeFormat, {
    construct(target, args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      counts.dates += 1;
      return new target(...args);
    },
  });
  Intl.NumberFormat = new Proxy(RealNumberFormat, {
    construct(target, args: ConstructorParameters<typeof Intl.NumberFormat>) {
      counts.numbers += 1;
      return new target(...args);
    },
  });
  return counts;
}

describe('createLocalizer formatter cache', () => {
  it('reuses one formatter per locale and option set', () => {
    const l = createLocalizer('de');
    const counts = countConstructions();
    const day = new Date(Date.UTC(2026, 0, 2));
    const first = l(day, { timeZone: 'UTC', dateStyle: 'short' });
    for (let i = 0; i < 5; i += 1) {
      assert.equal(l(day, { timeZone: 'UTC', dateStyle: 'short' }), first);
      l(12.5, { kind: 'currency', currency: 'EUR' });
    }
    assert.equal(counts.dates, 1);
    assert.equal(counts.numbers, 1);
  });

  it('keys formatters by their options', () => {
    const l = createLocalizer('en-US');
    assert.equal(l(1234.5, { maximumFractionDigits: 0 }), '1,235');
    assert.equal(l(1234.5, { minimumFractionDigits: 2 }), '1,234.50');
    assert.equal(l(0.25, { kind: 'percent' }), '25%');
    assert.equal(l(3, { kind: 'currency', currency: 'USD' }), '$3.00');
    assert.equal(l(3, { kind: 'currency', currency: 'EUR' }), '€3.00');
  });

  it('still rejects an invalid time zone', () => {
    const l = createLocalizer('en');
    assert.throws(
      () => l(new Date(), { timeZone: 'Not/AZone' }),
      (error: unknown) => {
        assert.ok(error instanceof I18nError);
        assert.equal(error.code, 'invalid_localize_options');
        return true;
      },
    );
  });
});
