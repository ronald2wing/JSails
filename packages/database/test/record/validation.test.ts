/**
 * Record validation: a schema's failure becomes `record.invalid` (kind
 * `invalid`, client audience) whose exposed issues hold the path, a
 * snake_case code and the author's message only, whatever else the schema's
 * issues carry; a pass, or no validator, throws nothing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import { RecordErrors } from '../../src/record/index.js';
import { validateRecord } from '../../src/record/validation.js';

function failure(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return assert.fail('expected a failure');
}

describe('validateRecord', () => {
  it('passes a valid record and a model without a validator', () => {
    const schema = z.object({ title: z.string().min(1) });
    validateRecord(schema, { title: 'ok', extra: 1 }, 'Post');
    validateRecord(undefined, {}, 'Post');
  });

  it('raises record.invalid with value-free issues', () => {
    const schema = z.object({ title: z.string().min(3, 'Too short.'), tags: z.array(z.string()) });
    const error = failure(() =>
      validateRecord(schema, { title: 'secret-ish', tags: ['ok', 42] }, 'Post'),
    );
    assert.ok(RecordErrors.is(error, 'invalid'));
    assert.equal(error.kind, 'invalid');
    assert.equal(error.audience, 'client');
    assert.deepEqual(error.context, { model: 'Post' });
    assert.deepEqual(error.payload.issues, [
      {
        path: ['tags', 1],
        code: 'invalid_type',
        message: 'Invalid input: expected string, received number',
      },
    ]);
    const short = failure(() => validateRecord(schema, { title: 'ab', tags: [] }, 'Post'));
    assert.ok(RecordErrors.is(short, 'invalid'));
    assert.deepEqual(short.payload.issues, [
      { path: ['title'], code: 'too_small', message: 'Too short.' },
    ]);
    assert.doesNotMatch(JSON.stringify(short.payload), /"ab"/);
  });

  it('keeps only keys, snake_case codes and messages of a foreign schema', () => {
    const schema = {
      safeParse: () => ({
        success: false,
        error: {
          issues: [
            { path: ['a', Symbol('hidden'), 0], code: 'tooBig', message: 'Big.', input: 'value' },
            { path: 'not a path', code: 'custom_rule' },
            'not an issue',
          ],
        },
      }),
    };
    const error = failure(() => validateRecord(schema, {}, 'Post'));
    assert.ok(RecordErrors.is(error, 'invalid'));
    assert.deepEqual(error.payload.issues, [
      { path: ['a', 0], code: 'invalid', message: 'Big.' },
      { path: [], code: 'custom_rule' },
    ]);
    const bare = failure(() =>
      validateRecord({ safeParse: () => ({ success: false }) }, {}, 'Post'),
    );
    assert.ok(RecordErrors.is(bare, 'invalid'));
    assert.deepEqual(bare.payload.issues, []);
  });
});
