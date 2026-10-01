/**
 * Tests for `resolveStringRefs`: inline handlers pass through, registered
 * names resolve, and an unknown or inherited name fails by position only.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AppMiddlewareHandler } from '../../src/server/env.js';
import { resolveStringRefs } from '../../src/server/middleware-refs.js';

const auth: AppMiddlewareHandler = async (_c, next) => {
  await next();
};
const inline: AppMiddlewareHandler = async (_c, next) => {
  await next();
};

const toError = (message: string): Error => new Error(message);

describe('resolveStringRefs', () => {
  it('keeps inline handlers and resolves registered names in order', () => {
    assert.deepEqual(resolveStringRefs([inline, 'auth'], { auth }, toError), [inline, auth]);
  });

  it('returns no handlers for a missing or empty list', () => {
    assert.deepEqual(resolveStringRefs(undefined, { auth }, toError), []);
    assert.deepEqual(resolveStringRefs([], undefined, toError), []);
  });

  it('rejects an unregistered name with a value-free message', () => {
    assert.throws(
      () => resolveStringRefs([inline, 'missing'], { auth }, toError),
      (error: Error) => {
        assert.equal(error.message, 'references an unregistered middleware at index 1');
        return true;
      },
    );
    assert.throws(() => resolveStringRefs(['auth'], undefined, toError), /at index 0/);
  });

  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    it(`does not resolve the inherited name ${name}`, () => {
      assert.throws(
        () => resolveStringRefs([name], { auth }, toError),
        /unregistered middleware at index 0/,
      );
    });
  }
});
