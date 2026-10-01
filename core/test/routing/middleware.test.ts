/**
 * Unit tests for the per-route middleware contract: the structural validator
 * for a route module's `middleware` export, whose every entry is the
 * middleware function itself (the live chain is covered in `server.test.ts`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateMiddlewareList, type RouteMiddleware } from '../../src/routing/middleware.js';

describe('validateMiddlewareList', () => {
  const fail = (message: string): Error => new Error(message);

  it('returns undefined for an absent export', () => {
    assert.equal(validateMiddlewareList(undefined, fail), undefined);
  });

  it('accepts an array of functions by identity', () => {
    const handlers: RouteMiddleware[] = [async (_c, next) => next()];
    assert.equal(validateMiddlewareList(handlers, fail), handlers);
  });

  it('rejects a non-array export without echoing the value', () => {
    assert.throws(
      () => validateMiddlewareList('not-an-array', fail),
      /exports "middleware" as a non-array value/,
    );
    assert.throws(
      () => validateMiddlewareList(42, fail),
      (error: unknown) => !(error as Error).message.includes('42'),
    );
  });

  it('rejects a non-function entry without echoing the value', () => {
    const handler: RouteMiddleware = async (_c, next) => next();
    assert.throws(
      () => validateMiddlewareList([handler, 42], fail),
      /exports a non-function middleware entry at index 1/,
    );
  });

  it('rejects a name, which names no middleware, without echoing it', () => {
    for (const entry of ['secret-auth', '']) {
      assert.throws(
        () => validateMiddlewareList([entry], fail),
        (error: unknown) =>
          /exports a non-function middleware entry at index 0/.test((error as Error).message) &&
          !(error as Error).message.includes('secret-auth'),
      );
    }
  });

  it('rejects an object entry value-free', () => {
    const handler: RouteMiddleware = async (_c, next) => next();
    assert.throws(
      () => validateMiddlewareList([handler, {}], fail),
      /exports a non-function middleware entry at index 1/,
    );
  });
});
