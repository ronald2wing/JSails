/**
 * Tests for the store input checks: each accepts its canonical form and
 * refuses wrong types, out-of-range values and non-canonical spellings with
 * `invalid_store_input`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  requireAuditAction,
  requireAuditActor,
  requireBatchLimit,
  requireBoolean,
  requireCount,
  requireDate,
  requireDomainToken,
  requireEmail,
  requireHostname,
  requireLookup,
  requireOptionalDate,
  requireOptionalText,
  requireRecord,
  requireRole,
  requireRowId,
  requireSettings,
  requireSlug,
  requireStatus,
  requireTenantId,
  requireText,
  requireTokenHash,
  requireUserId,
} from '../src/store-input.js';
import { issueDomainToken } from '../src/domain-verification.js';
import { thrownCode } from './thrown-code.js';

const accepted: readonly [string, () => unknown, unknown][] = [
  ['tenant id', () => requireTenantId(7), 7],
  ['row id', () => requireRowId(3), 3],
  ['text of four code points', () => requireText('😀😀😀😀', 4), '😀😀😀😀'],
  ['null text', () => requireOptionalText(null, 3), null],
  ['user id', () => requireUserId('user-1'), 'user-1'],
  ['date', () => requireDate(new Date(5)), 5],
  ['null date', () => requireOptionalDate(null), null],
  ['count', () => requireCount(0), 0],
  ['batch limit', () => requireBatchLimit(1000), 1000],
  ['slug', () => requireSlug('a-1'), 'a-1'],
  ['owner role', () => requireRole('owner'), 'owner'],
  ['status', () => requireStatus('purging'), 'purging'],
  ['email', () => requireEmail('guest+tag@bigcorp.io'), 'guest+tag@bigcorp.io'],
  ['hostname', () => requireHostname('xn--bcher-kva.example'), 'xn--bcher-kva.example'],
  ['token hash', () => requireTokenHash(new Uint8Array(32).fill(255)), 'ff'.repeat(32)],
  ['settings', () => requireSettings('{"a":[1]}'), '{"a":[1]}'],
  ['boolean', () => requireBoolean(false), false],
  ['audit action', () => requireAuditAction('tenant.purged'), 'tenant.purged'],
  ['system actor', () => requireAuditActor({ kind: 'system', id: 'ignored' }), { kind: 'system' }],
  ['user actor', () => requireAuditActor({ kind: 'user', id: 'u' }), { kind: 'user', id: 'u' }],
  ['lookup', () => requireLookup('Anything At All'), 'Anything At All'],
  ['record', () => requireRecord({}), undefined],
];

const refused: readonly [string, () => unknown][] = [
  ['zero tenant id', () => requireTenantId(0)],
  ['string row id', () => requireRowId('1')],
  ['empty text', () => requireText('', 4)],
  ['five code points', () => requireText('😀😀😀😀😀', 4)],
  ['empty user id', () => requireUserId('')],
  ['invalid date', () => requireDate(new Date(Number.NaN))],
  ['date number', () => requireDate(5)],
  ['negative count', () => requireCount(-1)],
  ['batch limit above maximum', () => requireBatchLimit(1001)],
  ['upper-case slug', () => requireSlug('Acme')],
  ['slug of 64 characters', () => requireSlug('a'.repeat(64))],
  ['role with a dash', () => requireRole('super-admin')],
  ['purged status', () => requireStatus('purged')],
  ['unnormalised email', () => requireEmail(' guest@bigcorp.io')],
  ['unicode hostname', () => requireHostname('bücher.example')],
  ['token', () => requireDomainToken('A'.repeat(32))],
  ['token hash of 33 bytes', () => requireTokenHash(new Uint8Array(33))],
  ['token hash array', () => requireTokenHash(Array.from({ length: 32 }, () => 0))],
  ['settings not JSON', () => requireSettings('{')],
  ['settings object', () => requireSettings({})],
  ['boolean string', () => requireBoolean('true')],
  ['audit action', () => requireAuditAction('tenant.exploded')],
  ['actor kind', () => requireAuditActor({ kind: 'robot', id: 'r' })],
  ['operator without id', () => requireAuditActor({ kind: 'operator' })],
  ['actor null', () => requireAuditActor(null)],
  ['lookup number', () => requireLookup(1)],
  ['record null', () => requireRecord(null)],
];

describe('store input checks', () => {
  for (const [label, call, expected] of accepted) {
    it(`accepts ${label}`, () => {
      assert.deepEqual(call(), expected);
    });
  }

  it('accepts a domain token', () => {
    const token = issueDomainToken();
    assert.equal(requireDomainToken(token), token);
  });

  for (const [label, call] of refused) {
    it(`refuses ${label}`, () => {
      assert.equal(thrownCode(call), 'invalid_store_input');
    });
  }
});
