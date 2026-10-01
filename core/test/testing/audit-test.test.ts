/**
 * Tests for the audit test helpers (`jsails/testing`): `auditCase` titles and
 * options, id and name validation, the once-per-file id rule, and
 * `settlesWithin`'s three outcomes.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUDIT_ID_PATTERN,
  AuditTestError,
  DEFAULT_AUDIT_TIMEOUT_MS,
  auditCase,
  auditTitle,
  settlesWithin,
  SettleTimeoutError,
} from '../../src/testing/index.js';

describe('auditTitle', () => {
  it('joins the id and the behaviour', () => {
    assert.equal(
      auditTitle('live/resume-ahead', 'a resume past the head snapshots'),
      'live/resume-ahead: a resume past the head snapshots',
    );
  });

  it('accepts only <area>/<finding> kebab-case ids', () => {
    for (const id of ['live/a', 'rich-text/cta-href-scheme', 'cache2/x-1']) {
      assert.match(id, AUDIT_ID_PATTERN);
      assert.doesNotThrow(() => auditTitle(id, 'name'));
    }
    for (const id of ['live', 'Live/x', 'live/', '/x', 'live/x/y', 'live/x_y', 'CNT-01', '']) {
      assert.throws(
        () => auditTitle(id, 'name'),
        (error: unknown) => error instanceof AuditTestError && error.code === 'invalid_id',
        id,
      );
    }
  });

  it('refuses an empty or untrimmed name', () => {
    for (const name of ['', '   ', ' leading', 'trailing ']) {
      assert.throws(
        () => auditTitle('live/x', name),
        (error: unknown) => error instanceof AuditTestError && error.code === 'invalid_name',
      );
    }
  });
});

describe('auditCase', () => {
  it('returns the title and the default bounded timeout', () => {
    assert.deepEqual(auditCase('testing/default-timeout', 'behaves'), [
      'testing/default-timeout: behaves',
      { timeout: DEFAULT_AUDIT_TIMEOUT_MS },
    ]);
  });

  it('takes a timeout override and refuses a non-positive one', () => {
    assert.deepEqual(auditCase('testing/override', 'behaves', { timeout: 500 })[1], {
      timeout: 500,
    });
    for (const timeout of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      assert.throws(() => auditCase('testing/bad-timeout', 'behaves', { timeout }), RangeError);
    }
  });

  it('allows one use of an id per file', () => {
    auditCase('testing/once', 'first');
    assert.throws(
      () => auditCase('testing/once', 'second'),
      (error: unknown) => error instanceof AuditTestError && error.code === 'duplicate_id',
    );
  });

  it('validates before registering, so a rejected call leaves the id free', () => {
    assert.throws(() => auditCase('testing/free', ''), AuditTestError);
    assert.doesNotThrow(() => auditCase('testing/free', 'now valid'));
  });

  it('produces arguments node:test accepts as a test title and options', async (t) => {
    let ran = false;
    await t.test(...auditCase('testing/spread', 'runs as a subtest'), () => {
      ran = true;
    });
    assert.equal(ran, true);
  });
});

describe('settlesWithin', () => {
  it('resolves with the value of a promise that settles in time', async () => {
    assert.equal(await settlesWithin(Promise.resolve(7), 100, 'value'), 7);
  });

  it("passes a promise's own rejection through unchanged", async () => {
    const original = new Error('boom');
    await assert.rejects(settlesWithin(Promise.reject(original), 100, 'rejection'), (error) => {
      assert.equal(error, original);
      return true;
    });
  });

  it('fails with SettleTimeoutError naming the label when the promise stays pending', async () => {
    await assert.rejects(settlesWithin(new Promise(() => undefined), 20, 'the probe'), (error) => {
      assert.ok(error instanceof SettleTimeoutError);
      assert.equal(error.code, 'not_settled');
      assert.equal(error.timeoutMs, 20);
      assert.equal(error.message, 'the probe did not settle within 20ms');
      return true;
    });
  });

  it('refuses a negative or non-finite budget', async () => {
    await assert.rejects(settlesWithin(Promise.resolve(1), -1, 'x'), RangeError);
    await assert.rejects(settlesWithin(Promise.resolve(1), Number.NaN, 'x'), RangeError);
  });
});
