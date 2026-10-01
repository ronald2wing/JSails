/**
 * Scenario tests for operator grants: who may open one, the duration bound,
 * read and write grants and what each allows, replacement of an earlier
 * grant, expiry, and early closing by the operator, a system actor or a
 * tenant user who can remove members.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  auditActions,
  auditTrail,
  HOUR,
  lifecycleFixture,
  MINUTE,
  operator,
  system,
  tenantWith,
  user,
} from './lifecycle-fixture.js';
import { rejectedCode } from './thrown-code.js';

describe('openOperatorGrant', () => {
  it('opens a time-boxed read grant with the operator’s reason', async () => {
    const { lifecycle, store, events, clock } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    events.length = 0;
    const grant = await lifecycle.openOperatorGrant(
      tenant.id,
      { durationMs: 30 * MINUTE },
      operator('op', 'ticket 9'),
    );
    assert.equal(grant.operatorId, 'op');
    assert.equal(grant.reason, 'ticket 9');
    assert.equal(grant.write, false);
    assert.equal(grant.expiresAt.getTime(), clock.now().getTime() + 30 * MINUTE);
    const last = (await auditTrail(store, tenant.id)).at(-1);
    assert.equal(last?.action, 'operator.access_opened');
    assert.equal(last?.target, String(grant.id));
    assert.equal(last?.reason, 'ticket 9');
    assert.deepEqual(events, [
      {
        type: 'operator_grant',
        tenantId: tenant.id,
        grantId: grant.id,
        operatorId: 'op',
        change: 'opened',
      },
    ]);
  });

  it('audits a write grant as its own action and replaces the earlier grant', async () => {
    const { lifecycle, store, clock } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const read = await lifecycle.openOperatorGrant(tenant.id, { durationMs: HOUR }, operator('op'));
    const write = await lifecycle.openOperatorGrant(
      tenant.id,
      { durationMs: MINUTE, write: true },
      operator('op'),
    );
    assert.equal((await store.operatorGrant(read.id))?.closedAt?.getTime(), clock.now().getTime());
    assert.equal((await store.activeOperatorGrant(tenant.id, 'op', clock.now()))?.id, write.id);
    assert.deepEqual((await auditActions(store, tenant.id)).slice(-2), [
      'operator.access_closed',
      'operator.write_access_opened',
    ]);
  });

  it('refuses non-operators, bad durations and missing or purging tenants', async () => {
    const { lifecycle } = lifecycleFixture({ deletionRetentionMs: 0 });
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const open = (request: { durationMs: number; write?: boolean }, by = operator('op')) =>
      lifecycle.openOperatorGrant(tenant.id, request, by);
    assert.equal(await rejectedCode(open({ durationMs: HOUR }, user('alice'))), 'not_permitted');
    assert.equal(await rejectedCode(open({ durationMs: HOUR }, system())), 'not_permitted');
    assert.equal(await rejectedCode(open({ durationMs: MINUTE - 1 })), 'invalid_grant');
    assert.equal(await rejectedCode(open({ durationMs: HOUR + 1 })), 'invalid_grant');
    assert.equal(await rejectedCode(open({ durationMs: MINUTE + 0.5 })), 'invalid_grant');
    assert.equal(
      await rejectedCode(open({ durationMs: HOUR, write: 'yes' as unknown as boolean })),
      'invalid_grant',
    );
    assert.equal(
      await rejectedCode(lifecycle.openOperatorGrant(77, { durationMs: HOUR }, operator('op'))),
      'not_found',
    );
    await lifecycle.scheduleDeletion(tenant.id, user('alice'));
    await rejectedCode(
      lifecycle.purge(tenant.id, system(), async () => {
        throw new Error('stuck');
      }),
    );
    assert.equal(await rejectedCode(open({ durationMs: HOUR })), 'purge_in_progress');
  });

  it('stops allowing anything once the grant expires', async () => {
    const { lifecycle, clock } = lifecycleFixture({ operatorGrantMaxMs: 2 * HOUR });
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    await lifecycle.openOperatorGrant(
      tenant.id,
      { durationMs: 2 * HOUR, write: true },
      operator('op'),
    );
    await lifecycle.rename(tenant.id, 'Renamed', operator('op'));
    clock.advance(2 * HOUR);
    assert.equal(
      await rejectedCode(lifecycle.rename(tenant.id, 'Again', operator('op'))),
      'not_permitted',
    );
    assert.equal(
      await rejectedCode(lifecycle.settings(tenant.id, operator('op'))),
      'not_permitted',
    );
  });
});

describe('closeOperatorGrant', () => {
  it('closes early once, and reports an ended grant as not closed', async () => {
    const { lifecycle, store, events, clock } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const grant = await lifecycle.openOperatorGrant(
      tenant.id,
      { durationMs: HOUR },
      operator('op'),
    );
    events.length = 0;
    assert.equal(await lifecycle.closeOperatorGrant(tenant.id, grant.id, operator('op')), true);
    assert.equal(await lifecycle.closeOperatorGrant(tenant.id, grant.id, operator('op')), false);
    assert.equal(await store.activeOperatorGrant(tenant.id, 'op', clock.now()), null);
    assert.deepEqual(events, [
      {
        type: 'operator_grant',
        tenantId: tenant.id,
        grantId: grant.id,
        operatorId: 'op',
        change: 'closed',
      },
    ]);
    const expiring = await lifecycle.openOperatorGrant(
      tenant.id,
      { durationMs: MINUTE },
      operator('op'),
    );
    clock.advance(MINUTE);
    assert.equal(await lifecycle.closeOperatorGrant(tenant.id, expiring.id, system()), false);
    assert.equal((await auditActions(store, tenant.id)).at(-1), 'operator.access_opened');
  });

  it('lets a tenant user who can remove members revoke staff access', async () => {
    const fixture = lifecycleFixture();
    const { lifecycle } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'admin', carol: 'member' });
    const grant = await lifecycle.openOperatorGrant(
      tenant.id,
      { durationMs: HOUR },
      operator('op'),
    );
    assert.equal(
      await rejectedCode(lifecycle.closeOperatorGrant(tenant.id, grant.id, user('carol'))),
      'not_permitted',
    );
    assert.equal(await lifecycle.closeOperatorGrant(tenant.id, grant.id, user('bob')), true);
  });

  it('does not reach another tenant’s grant', async () => {
    const { lifecycle } = lifecycleFixture();
    const acme = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const beta = await lifecycle.create({ name: 'Beta', slug: 'beta' }, user('alice'));
    const grant = await lifecycle.openOperatorGrant(beta.id, { durationMs: HOUR }, operator('op'));
    assert.equal(
      await rejectedCode(lifecycle.closeOperatorGrant(acme.id, grant.id, user('alice'))),
      'not_found',
    );
    assert.equal(
      await rejectedCode(lifecycle.closeOperatorGrant(acme.id, 0, user('alice'))),
      'not_found',
    );
  });
});
