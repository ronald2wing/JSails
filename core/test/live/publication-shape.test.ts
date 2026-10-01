/**
 * Tests for {@link assertPublicationShape}: the guard that rejects a
 * publication whose membership is not a pure function of its own projected row
 * (docs/design/live.md §4.2a). Unit-level; no database.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertPublicationShape, PublicationShapeError } from '../../src/live/publication.js';

/** A minimal ModelQuery shape sufficient for the guard; the private fields are irrelevant. */
function fakeQuery(
  expressionMap: {
    limit?: number;
    offset?: number;
    wheres?: ReadonlyArray<{ condition: unknown }>;
  },
  applied = false,
): Parameters<typeof assertPublicationShape>[0] {
  return {
    builder: {
      expressionMap: { limit: undefined, offset: undefined, wheres: [], ...expressionMap },
    },
    applied,
  } as unknown as Parameters<typeof assertPublicationShape>[0];
}

describe('assertPublicationShape', () => {
  it('accepts a scalar-where query with no limit/offset/relation/apply', () => {
    assert.doesNotThrow(() =>
      assertPublicationShape(fakeQuery({ wheres: [{ condition: 'entity_.status = ?' }] })),
    );
  });

  it('rejects a limit with unsupported_limit (expressionMap.limit, not take)', () => {
    assert.throws(
      () => assertPublicationShape(fakeQuery({ limit: 20 })),
      (error: unknown) =>
        error instanceof PublicationShapeError && error.code === 'unsupported_limit',
    );
  });

  it('rejects an offset with unsupported_offset (expressionMap.offset, not skip)', () => {
    assert.throws(
      () => assertPublicationShape(fakeQuery({ offset: 10 })),
      (error: unknown) =>
        error instanceof PublicationShapeError && error.code === 'unsupported_offset',
    );
  });

  it('rejects a relation predicate by scanning wheres for EXISTS', () => {
    const relationWhere = { condition: 'EXISTS (SELECT 1 FROM other WHERE other.id = entity_.id)' };
    assert.throws(
      () => assertPublicationShape(fakeQuery({ wheres: [relationWhere] })),
      (error: unknown) =>
        error instanceof PublicationShapeError && error.code === 'unsupported_relation_predicate',
    );
  });

  it('rejects a raw apply via the #applied flag', () => {
    assert.throws(
      () => assertPublicationShape(fakeQuery({}, true)),
      (error: unknown) =>
        error instanceof PublicationShapeError && error.code === 'unsupported_raw_apply',
    );
  });
});
