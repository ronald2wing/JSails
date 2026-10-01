/**
 * Tests for `normalizeError`: framework errors pass through, the built-in
 * translators recognize Zod, abort, timeout and unique-violation errors
 * structurally, registered translators run first, and nothing else escapes as
 * anything but `errors.internal`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { QueryFailedError } from 'typeorm';
import { z } from 'zod';

import { conflict, notFound } from '../../src/errors/kernel.js';
import { normalizeError, registerErrorTranslator } from '../../src/errors/normalize.js';

describe('normalizeError', () => {
  it('returns a framework error unchanged', () => {
    const error = notFound();
    assert.equal(normalizeError(error), error);
  });

  it('turns a Zod error into the client-audience request.invalid with its issues', () => {
    const schema = z.object({ email: z.email(), age: z.number().min(18, 'adults only') });
    const parsed = schema.safeParse({ email: 'nope', age: 3 });
    assert.equal(parsed.success, false);
    const error = normalizeError(parsed.error);
    assert.equal(error.code, 'request.invalid');
    assert.equal(error.audience, 'client');
    const issues = (error.clientFields as { issues: { path: unknown[]; code: string }[] }).issues;
    assert.deepEqual(
      issues.map((issue) => [issue.path, issue.code]),
      [
        [['email'], 'invalid_format'],
        [['age'], 'too_small'],
      ],
    );
    assert.ok(!error.message.includes('nope'));
  });

  it('turns an AbortError into errors.aborted and a TimeoutError into errors.timeout', () => {
    const aborted = normalizeError(new DOMException('gone', 'AbortError'));
    assert.equal(aborted.code, 'errors.aborted');
    assert.equal(aborted.kind, 'aborted');
    const timedOut = normalizeError(new DOMException('slow', 'TimeoutError'));
    assert.equal(timedOut.code, 'errors.timeout');
    assert.equal(timedOut.kind, 'timeout');
  });

  it('turns each driver unique violation into the operator-audience errors.unique_violation', () => {
    const drivers = [
      { message: 'UNIQUE constraint failed: users.email' },
      { code: 'ER_DUP_ENTRY', errno: 1062 },
      { code: 'ER_DUP_KEY' },
      { code: '23505' },
      { errno: 2067 },
    ];
    for (const driver of drivers) {
      const error = normalizeError(
        new QueryFailedError('INSERT …', [], Object.assign(new Error('driver'), driver)),
      );
      assert.equal(error.code, 'errors.unique_violation');
      assert.equal(error.kind, 'conflict');
      assert.equal(error.audience, 'operator');
    }
    assert.equal(
      normalizeError(
        new QueryFailedError('INSERT …', [], Object.assign(new Error('driver'), { code: '23503' })),
      ).code,
      'errors.internal',
    );
  });

  it('wraps anything else as errors.internal with the original as cause', () => {
    for (const thrown of [new Error('secret-token-123'), 'a string', 42, null, undefined]) {
      const error = normalizeError(thrown);
      assert.equal(error.code, 'errors.internal');
      assert.equal(error.audience, 'operator');
      assert.equal(error.cause, thrown);
      assert.ok(!error.message.includes('secret-token-123'));
    }
  });

  it('consults registered translators first, newest first, and skips one that throws', () => {
    class DriverConflict extends Error {}
    const removeOld = registerErrorTranslator(() => notFound());
    const removeNew = registerErrorTranslator((error) =>
      error instanceof DriverConflict ? conflict('email_taken') : undefined,
    );
    const removeBroken = registerErrorTranslator(() => {
      throw new Error('translator bug');
    });
    try {
      assert.equal(normalizeError(new DriverConflict()).code, 'request.conflict');
      assert.equal(normalizeError(new Error('other')).code, 'request.not_found');
    } finally {
      removeNew();
      removeOld();
      removeBroken();
    }
    assert.equal(normalizeError(new DriverConflict()).code, 'errors.internal');
  });
});
