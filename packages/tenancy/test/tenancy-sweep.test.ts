/**
 * Tests for the tenancy sweep: due purges and resumed purges with failures
 * isolated per tenant, expired invitations deleted and audited, audit records
 * pruned past the retention period, and the run options validated.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { auditActions, DAY, emailOf, lifecycleFixture, system, user } from './lifecycle-fixture.js';
import { rejectedCode } from './thrown-code.js';

describe('sweep', () => {
  it('purges due tenants, resumes interrupted ones and isolates failures', async () => {
    const { lifecycle, store, clock } = lifecycleFixture({ deletionRetentionMs: DAY });
    const due = await lifecycle.create({ name: 'Due', slug: 'due' }, user('a'));
    const stuck = await lifecycle.create({ name: 'Stuck', slug: 'stuck' }, user('b'));
    const later = await lifecycle.create({ name: 'Later', slug: 'later' }, user('c'));
    const kept = await lifecycle.create({ name: 'Kept', slug: 'kept' }, user('d'));
    await lifecycle.scheduleDeletion(due.id, user('a'));
    await lifecycle.scheduleDeletion(stuck.id, user('b'));
    clock.advance(DAY);
    await lifecycle.scheduleDeletion(later.id, user('c'));
    const failure = new Error('bucket unavailable');
    const report = await lifecycle.sweep({
      purgeData: async (id) => {
        if (id === stuck.id) {
          throw failure;
        }
      },
    });
    assert.deepEqual(report.purged, [due.id]);
    assert.deepEqual(report.purgeFailures, [{ tenantId: stuck.id, error: failure }]);
    assert.equal((await store.tenantById(stuck.id))?.status, 'purging');
    assert.equal((await store.tenantById(later.id))?.status, 'pending_deletion');
    assert.equal((await store.tenantById(kept.id))?.status, 'active');
    const resumed = await lifecycle.sweep({ purgeData: async () => undefined });
    assert.deepEqual(resumed.purged, [stuck.id]);
    assert.equal(await store.tenantById(stuck.id), null);
  });

  it('deletes expired invitations and audits each as a system action', async () => {
    const { lifecycle, store, clock } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const old = await lifecycle.invite(tenant.id, { email: emailOf('b') }, user('alice'));
    clock.advance(6 * DAY);
    const fresh = await lifecycle.invite(tenant.id, { email: emailOf('c') }, user('alice'));
    clock.advance(DAY);
    const report = await lifecycle.sweep({ purgeData: async () => undefined });
    assert.equal(report.invitationsExpired, 1);
    assert.equal(await store.invitation(old.invitation.id), null);
    assert.notEqual(await store.invitation(fresh.invitation.id), null);
    assert.equal((await auditActions(store, tenant.id)).at(-1), 'member.invitation_expired');
  });

  it('prunes audit records past the retention period, a batch per run', async () => {
    const { lifecycle, store, clock } = lifecycleFixture({ auditRetentionMs: 10 * DAY });
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    await lifecycle.rename(tenant.id, 'Acme 2', user('alice'));
    await lifecycle.rename(tenant.id, 'Acme 3', user('alice'));
    clock.advance(5 * DAY);
    await lifecycle.rename(tenant.id, 'Acme 4', user('alice'));
    clock.advance(6 * DAY);
    const first = await lifecycle.sweep({ purgeData: async () => undefined, limit: 2 });
    assert.equal(first.auditPruned, 2);
    const second = await lifecycle.sweep({ purgeData: async () => undefined, limit: 2 });
    assert.equal(second.auditPruned, 1);
    assert.deepEqual(await auditActions(store, tenant.id), ['tenant.renamed']);
  });

  it('validates its options', async () => {
    const { lifecycle } = lifecycleFixture();
    const purgeData = async (): Promise<void> => undefined;
    assert.equal(
      await rejectedCode(lifecycle.sweep({ purgeData, limit: 1001 })),
      'invalid_lifecycle_options',
    );
    assert.equal(
      await rejectedCode(lifecycle.sweep({ purgeData: undefined as unknown as typeof purgeData })),
      'invalid_lifecycle_options',
    );
    assert.deepEqual(await lifecycle.sweep({ purgeData }), {
      purged: [],
      purgeFailures: [],
      invitationsExpired: 0,
      auditPruned: 0,
    });
    assert.equal(await rejectedCode(lifecycle.purge(1, system(), purgeData)), 'not_found');
  });
});
