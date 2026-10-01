/**
 * Tests for the live layer's wire record and its structural guard.
 *
 * `isLiveChange` must accept a well-formed record and reject every malformed
 * shape — the transport trusts it to gate deserialization, so a missed field or
 * wrong type must fail closed (LIVE-PLAN.md §4.1).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isLiveChange,
  type LiveChange,
  type LiveChangeOperation,
} from '../../src/live/change-record.js';

function wellFormed(overrides: Partial<LiveChange> = {}): LiveChange {
  return {
    sequence: 7,
    collection: 'posts',
    id: '42',
    operation: 'update',
    row: { id: 42, title: 'Hello' },
    at: 1_700_000_000_000,
    ...overrides,
  };
}

function every(change: LiveChange): readonly [keyof LiveChange, unknown][] {
  return Object.entries(change) as [keyof LiveChange, unknown][];
}

describe('isLiveChange', () => {
  it('accepts a well-formed insert / update / delete record', () => {
    for (const operation of ['insert', 'update', 'delete'] as LiveChangeOperation[]) {
      assert.ok(
        isLiveChange(wellFormed({ operation, row: operation === 'delete' ? null : { id: 1 } })),
      );
    }
  });

  it('rejects null and undefined', () => {
    assert.equal(isLiveChange(null), false);
    assert.equal(isLiveChange(undefined), false);
  });

  it('rejects a primitive and an array', () => {
    assert.equal(isLiveChange(42), false);
    assert.equal(isLiveChange('change'), false);
    assert.equal(isLiveChange([]), false);
  });

  it('rejects when any field is missing or the wrong type', () => {
    const base = wellFormed();
    for (const [key, value] of every(base)) {
      const missing = { ...base };
      delete missing[key];
      assert.equal(isLiveChange(missing), false, `missing ${key}`);
      assert.equal(
        isLiveChange({ ...base, [key]: malformedTypeFor(value) }),
        false,
        `wrong type for ${key}`,
      );
    }
  });

  it('rejects an unknown operation but accepts all three real ones', () => {
    assert.equal(isLiveChange(wellFormed({ operation: 'upsert' as LiveChangeOperation })), false);
    assert.equal(isLiveChange(wellFormed({ operation: 'insert' })), true);
    assert.equal(isLiveChange(wellFormed({ operation: 'update' })), true);
    assert.equal(isLiveChange(wellFormed({ operation: 'delete', row: null })), true);
  });

  it('accepts row null only for delete and never a non-plain row', () => {
    assert.equal(isLiveChange(wellFormed({ operation: 'insert', row: null })), true);
    assert.equal(isLiveChange(wellFormed({ operation: 'delete' })), true);
    assert.equal(
      isLiveChange(wellFormed({ row: [1, 2] as unknown as Record<string, unknown> })),
      false,
    );
    assert.equal(
      isLiveChange(wellFormed({ row: new Date() as unknown as Record<string, unknown> })),
      false,
    );
    assert.equal(
      isLiveChange(wellFormed({ row: new (class Foo {})() as unknown as Record<string, unknown> })),
      false,
    );
  });

  it('accepts a null-prototype row', () => {
    const row = Object.create(null) as Record<string, unknown>;
    row.id = 1;
    assert.equal(isLiveChange(wellFormed({ row })), true);
  });

  it('rejects a non-finite sequence or at', () => {
    assert.equal(isLiveChange(wellFormed({ sequence: Number.NaN })), false);
    assert.equal(isLiveChange(wellFormed({ sequence: Number.POSITIVE_INFINITY })), false);
    assert.equal(isLiveChange(wellFormed({ at: Number.NaN })), false);
    assert.equal(isLiveChange(wellFormed({ at: Number.POSITIVE_INFINITY })), false);
  });

  it('does not mutate the record', () => {
    const change = wellFormed();
    isLiveChange(change);
    assert.deepEqual(change, wellFormed());
  });
});

function malformedTypeFor(value: unknown): unknown {
  switch (typeof value) {
    case 'string':
      return 42;
    case 'number':
      return 'not-a-number';
    case 'object':
      return 7;
    default:
      return 7;
  }
}
