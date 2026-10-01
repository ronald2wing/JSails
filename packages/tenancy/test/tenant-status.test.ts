/**
 * Tests for the tenant status machine: the exhaustive transition table,
 * totality, cancel restoring a suspension, the purge phases, and a seeded
 * walk proving pending_deletion is left only by cancel or purge.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isTenantAccessible,
  nextTenantStatus,
  parseTenantStatus,
  TENANT_STATUSES,
  TENANT_TRANSITIONS,
  type TenantStatus,
  type TenantTransition,
} from '../src/tenant-status.js';
import { seededPrng } from './seeded-prng.js';

const TABLE: Readonly<
  Record<TenantStatus, Partial<Record<TenantTransition, TenantStatus | 'purged'>>>
> = {
  active: { suspend: 'suspended', schedule_deletion: 'pending_deletion' },
  suspended: { resume: 'active', schedule_deletion: 'pending_deletion' },
  pending_deletion: { cancel_deletion: 'active', begin_purge: 'purging' },
  purging: { finish_purge: 'purged' },
};

describe('nextTenantStatus', () => {
  for (const from of TENANT_STATUSES) {
    for (const transition of TENANT_TRANSITIONS) {
      const expected = TABLE[from][transition] ?? null;
      it(`${from} --${transition}--> ${String(expected)}`, () => {
        assert.equal(nextTenantStatus(from, transition), expected);
      });
    }
  }

  it('restores a suspension when deletion is cancelled', () => {
    assert.equal(
      nextTenantStatus('pending_deletion', 'cancel_deletion', { suspended: true }),
      'suspended',
    );
    assert.equal(
      nextTenantStatus('pending_deletion', 'cancel_deletion', { suspended: false }),
      'active',
    );
  });

  it('refuses cancel from purging whatever the context', () => {
    assert.equal(nextTenantStatus('purging', 'cancel_deletion', { suspended: true }), null);
    assert.equal(nextTenantStatus('purging', 'begin_purge'), null);
  });

  it('is total and refuses unknown statuses', () => {
    assert.equal(nextTenantStatus('deleted' as TenantStatus, 'resume'), null);
    assert.equal(nextTenantStatus('active', 'explode' as TenantTransition), null);
  });

  it('leaves pending_deletion only through cancel or purge (seeded walk)', () => {
    const random = seededPrng(0x57a7);
    for (let walk = 0; walk < 500; walk += 1) {
      let status: TenantStatus = 'active';
      for (let step = 0; step < 30; step += 1) {
        const transition = random.pick(TENANT_TRANSITIONS);
        const next = nextTenantStatus(status, transition, { suspended: random.int(2) === 0 });
        if (next === null) {
          continue;
        }
        if (status === 'pending_deletion') {
          assert.ok(transition === 'cancel_deletion' || transition === 'begin_purge');
        }
        if (status === 'purging') {
          assert.equal(next, 'purged');
        }
        if (next === 'purged') {
          break;
        }
        status = next;
      }
    }
  });
});

describe('parseTenantStatus and isTenantAccessible', () => {
  it('parses stored values only', () => {
    for (const status of TENANT_STATUSES) {
      assert.equal(parseTenantStatus(status), status);
    }
    assert.equal(parseTenantStatus('purged'), null);
    assert.equal(parseTenantStatus('ACTIVE'), null);
    assert.equal(parseTenantStatus(1), null);
  });

  it('grants access to active tenants only', () => {
    assert.deepEqual(
      TENANT_STATUSES.filter((status) => isTenantAccessible(status)),
      ['active'],
    );
  });
});
