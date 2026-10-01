/**
 * Tests for the tenancy error table and its carrier: every code is snake_case
 * with a known kind and audience, messages are fixed and value-free, and an
 * error exposes its code, kind, audience, cause and context.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TENANCY_ERROR_CODES, TenancyError, type TenancyErrorCode } from '../src/tenancy-error.js';
import { isTenantId } from '../src/tenant-id.js';

const KINDS = [
  'invalid_input',
  'conflict',
  'not_found',
  'forbidden',
  'expired',
  'limit',
  'misconfigured',
];

describe('TENANCY_ERROR_CODES', () => {
  it('is frozen, snake_case, and fully classified', () => {
    assert.ok(Object.isFrozen(TENANCY_ERROR_CODES));
    for (const [code, entry] of Object.entries(TENANCY_ERROR_CODES)) {
      assert.match(code, /^[a-z]+(?:_[a-z]+)*$/, code);
      assert.ok(KINDS.includes(entry.kind), code);
      assert.ok(entry.audience === 'client' || entry.audience === 'developer', code);
      assert.ok(entry.message.length > 0, code);
      assert.ok(Object.isFrozen(entry), code);
      assert.equal(entry.kind === 'misconfigured', entry.audience === 'developer', code);
    }
  });

  it('covers the refusals the lifecycle needs', () => {
    for (const code of [
      'not_permitted',
      'already_member',
      'purge_in_progress',
      'slug_taken',
      'domain_taken',
      'owner_required',
      'domain_claimed',
      'invalid_page_request',
      'transaction_conflict',
      'transaction_aborted',
      'transaction_closed',
      'invalid_store_input',
      'invalid_store_options',
    ]) {
      assert.ok(code in TENANCY_ERROR_CODES, code);
    }
  });
});

describe('TenancyError', () => {
  it('carries the code, kind, audience and fixed message', () => {
    const cause = new Error('inner');
    const error = new TenancyError('slug_taken', { cause, context: { attempt: 2 } });
    assert.equal(error.code, 'slug_taken');
    assert.equal(error.kind, 'conflict');
    assert.equal(error.audience, 'client');
    assert.equal(error.message, TENANCY_ERROR_CODES.slug_taken.message);
    assert.equal(error.name, 'TenancyError');
    assert.equal(error.cause, cause);
    assert.deepEqual(error.context, { attempt: 2 });
  });

  it('carries frozen issues, empty unless given, copied from the caller', () => {
    assert.deepEqual(new TenancyError('slug_taken').issues, []);
    assert.ok(Object.isFrozen(new TenancyError('slug_taken').issues));
    const issues = [{ path: ['theme'], code: 'invalid_value' }];
    const error = new TenancyError('invalid_settings', { issues });
    issues.push({ path: [], code: 'too_big' });
    assert.deepEqual(error.issues, [{ path: ['theme'], code: 'invalid_value' }]);
    assert.ok(Object.isFrozen(error.issues));
  });

  it('builds for every code', () => {
    for (const code of Object.keys(TENANCY_ERROR_CODES) as TenancyErrorCode[]) {
      assert.equal(new TenancyError(code).code, code);
    }
  });
});

describe('isTenantId', () => {
  it('accepts positive safe integers only', () => {
    assert.equal(isTenantId(1), true);
    assert.equal(isTenantId(Number.MAX_SAFE_INTEGER), true);
    for (const value of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '1', null, 1n]) {
      assert.equal(isTenantId(value), false, String(value));
    }
  });
});
