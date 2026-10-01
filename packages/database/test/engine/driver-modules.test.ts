/**
 * Optional-peer loading: a missing driver is a value-free missing_dependency
 * naming the package; any other failure of an installed driver propagates.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadMysql2, loadOptionalPeer, loadPg } from '../../src/engine/driver-modules.js';

function notFound(name: string, code = 'MODULE_NOT_FOUND'): Error {
  return Object.assign(new Error(`Cannot find module '${name}'`), { code });
}

describe('loadOptionalPeer', () => {
  it('turns an absent package into missing_dependency, naming it', () => {
    for (const code of ['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND']) {
      assert.throws(
        () =>
          loadOptionalPeer('pg', () => {
            throw notFound('pg', code);
          }),
        (error: unknown) => {
          const typed = error as {
            code?: string;
            context?: Record<string, unknown>;
            suggestion?: string;
          };
          assert.equal(typed.code, 'missing_dependency');
          assert.equal(typed.context?.dependency, 'pg');
          assert.equal(typed.suggestion, 'npm install pg');
          return true;
        },
      );
    }
  });

  it('passes through a missing module that is not the driver, and other failures', () => {
    const inner = notFound('pg-native');
    assert.throws(
      () =>
        loadOptionalPeer('pg', () => {
          throw inner;
        }),
      (error: unknown) => error === inner,
    );
    const broken = new Error('driver crashed');
    assert.throws(
      () =>
        loadOptionalPeer('mysql2', () => {
          throw broken;
        }),
      (error: unknown) => error === broken,
    );
  });

  it('loads the installed drivers', () => {
    assert.equal(typeof loadPg().types.getTypeParser, 'function');
    assert.equal(typeof loadMysql2().createPool, 'function');
  });
});
