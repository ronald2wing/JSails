/**
 * Scenario tests for the tenant-row operations of the lifecycle: create,
 * rename, plan, settings, ownership transfer, suspension, scheduled deletion
 * and the three-phase purge, with every refusal code they raise, the audit
 * each change leaves and the events emitted after commit.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TenancyError } from '../src/tenancy-error.js';
import {
  auditActions,
  auditTrail,
  DAY,
  emailOf,
  join,
  lifecycleFixture,
  operator,
  system,
  tenantWith,
  user,
} from './lifecycle-fixture.js';
import { rejectedCode } from './thrown-code.js';

const noPurge = async (): Promise<void> => undefined;

describe('create', () => {
  it('creates an active tenant owned by the acting user', async () => {
    const { lifecycle, store, events } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: '  Acme  ', slug: 'Acme' }, user('alice'));
    assert.ok(Object.isFrozen(tenant));
    assert.equal(tenant.slug, 'acme');
    assert.equal(tenant.name, 'Acme');
    assert.equal(tenant.status, 'active');
    assert.equal(tenant.ownerUserId, 'alice');
    assert.equal((await store.membership(tenant.id, 'alice'))?.role, 'owner');
    const [record] = await auditTrail(store, tenant.id);
    assert.equal(record?.action, 'tenant.created');
    assert.equal(record?.target, 'alice');
    assert.deepEqual(record?.actor, { kind: 'user', id: 'alice' });
    assert.deepEqual(events, [
      { type: 'tenant', tenantId: tenant.id, change: 'created' },
      { type: 'membership', tenantId: tenant.id, userId: 'alice', change: 'added' },
    ]);
  });

  it('lets a system actor create a tenant for a named owner', async () => {
    const { lifecycle, store } = lifecycleFixture();
    const tenant = await lifecycle.create(
      { name: 'Acme', slug: 'acme', plan: 'pro' },
      system('provisioning'),
      'bob',
    );
    assert.equal(tenant.ownerUserId, 'bob');
    assert.equal(tenant.plan, 'pro');
    const [record] = await auditTrail(store, tenant.id);
    assert.deepEqual(record?.actor, { kind: 'system' });
    assert.equal(record?.reason, 'provisioning');
  });

  it('refuses owners and actors it cannot accept', async () => {
    const { lifecycle } = lifecycleFixture();
    const input = { name: 'Acme', slug: 'acme' };
    assert.equal(await rejectedCode(lifecycle.create(input, system())), 'invalid_actor');
    assert.equal(await rejectedCode(lifecycle.create(input, system(), ' bob')), 'invalid_actor');
    assert.equal(
      await rejectedCode(lifecycle.create(input, user('alice'), 'bob')),
      'not_permitted',
    );
    assert.equal(await rejectedCode(lifecycle.create(input, operator('op'))), 'not_permitted');
    assert.equal(
      await rejectedCode(lifecycle.create(input, { kind: 'system', reason: ' ' })),
      'reason_required',
    );
    assert.equal(
      await rejectedCode(lifecycle.create(input, { kind: 'user', userId: '' })),
      'invalid_actor',
    );
  });

  it('refuses invalid slugs, names, plans and settings without writing anything', async () => {
    const { lifecycle, events } = lifecycleFixture();
    const owner = user('alice');
    const cases: [Parameters<typeof lifecycle.create>[0], string][] = [
      [{ name: 'Acme', slug: 'ab' }, 'invalid_slug'],
      [{ name: 'Acme', slug: 'a--b' }, 'invalid_slug'],
      [{ name: 'Acme', slug: '12345' }, 'invalid_slug'],
      [{ name: 'Acme', slug: 'www' }, 'reserved_slug'],
      [{ name: '   ', slug: 'acme' }, 'invalid_name'],
      [{ name: 'Ac\nme', slug: 'acme' }, 'invalid_name'],
      [{ name: `Acme${String.fromCodePoint(0x202e)}`, slug: 'acme' }, 'invalid_name'],
      [{ name: 'x'.repeat(201), slug: 'acme' }, 'invalid_name'],
      [{ name: 'Acme', slug: 'acme', plan: 'pro plan' }, 'invalid_plan'],
      [{ name: 'Acme', slug: 'acme', plan: '' }, 'invalid_plan'],
      [{ name: 'Acme', slug: 'acme', settings: [] }, 'invalid_settings'],
      [{ name: 'Acme', slug: 'acme', settings: { blob: 'x'.repeat(70_000) } }, 'invalid_settings'],
    ];
    for (const [input, code] of cases) {
      assert.equal(await rejectedCode(lifecycle.create(input, owner)), code, JSON.stringify(code));
    }
    assert.deepEqual(events, []);
  });

  it('accepts a 200 code point name and refuses a taken slug', async () => {
    const { lifecycle } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'é'.repeat(200), slug: 'acme' }, user('alice'));
    assert.equal([...tenant.name].length, 200);
    assert.equal(
      await rejectedCode(lifecycle.create({ name: 'Other', slug: 'acme' }, user('bob'))),
      'slug_taken',
    );
  });

  it('stores what the settings parser returns', async () => {
    const { lifecycle } = lifecycleFixture({
      parseSettings: (raw) => ({ theme: 'light', ...(raw as Record<string, unknown>) }),
    });
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    assert.deepEqual(await lifecycle.settings(tenant.id, user('alice')), { theme: 'light' });
  });
});

describe('rename and plan', () => {
  it('lets a member with tenant.update rename, and refuses everyone else', async () => {
    const fixture = lifecycleFixture();
    const { lifecycle, store, events } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'admin', carol: 'member' });
    events.length = 0;
    const renamed = await lifecycle.rename(tenant.id, 'Acme Inc', user('bob'));
    assert.equal(renamed.name, 'Acme Inc');
    assert.equal(renamed.version, tenant.version + 1);
    assert.deepEqual(events, [{ type: 'tenant', tenantId: tenant.id, change: 'renamed' }]);
    assert.equal((await auditActions(store, tenant.id)).at(-1), 'tenant.renamed');
    assert.equal(
      await rejectedCode(lifecycle.rename(tenant.id, 'X', user('carol'))),
      'not_permitted',
    );
    assert.equal(
      await rejectedCode(lifecycle.rename(tenant.id, 'X', user('dave'))),
      'not_permitted',
    );
    assert.equal(await rejectedCode(lifecycle.rename(tenant.id, '', user('bob'))), 'invalid_name');
  });

  it('does nothing for an unchanged name', async () => {
    const { lifecycle, store, events } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    events.length = 0;
    const same = await lifecycle.rename(tenant.id, 'Acme', user('alice'));
    assert.equal(same.version, tenant.version);
    assert.deepEqual(events, []);
    assert.deepEqual(await auditActions(store, tenant.id), ['tenant.created']);
  });

  it('refuses an outsider with not_permitted whatever name or plan they send', async () => {
    const fixture = lifecycleFixture();
    const tenant = await tenantWith(fixture, 'acme', 'alice', { carol: 'member' });
    const { lifecycle } = fixture;
    for (const by of [user('mallory'), user('carol')]) {
      for (const id of [tenant.id, 99]) {
        assert.equal(await rejectedCode(lifecycle.rename(id, ' ', by)), 'not_permitted');
        assert.equal(
          await rejectedCode(lifecycle.setPlan(id, 'x'.repeat(10_000), by)),
          'not_permitted',
        );
      }
    }
    assert.equal(
      await rejectedCode(lifecycle.rename(tenant.id, ' ', user('alice'))),
      'invalid_name',
    );
    assert.equal(
      await rejectedCode(lifecycle.setPlan(tenant.id, 'x'.repeat(10_000), user('alice'))),
      'invalid_plan',
    );
  });

  it('does not tell a user whether a tenant id exists', async () => {
    const { lifecycle } = lifecycleFixture();
    await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    assert.equal(await rejectedCode(lifecycle.rename(99, 'X', user('alice'))), 'not_permitted');
    assert.equal(await rejectedCode(lifecycle.rename(99, 'X', system())), 'not_found');
    assert.equal(await rejectedCode(lifecycle.rename(0, 'X', system())), 'invalid_tenant_id');
  });

  it('refuses members of an inactive tenant with tenant_inactive', async () => {
    const { lifecycle } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    await lifecycle.suspend(tenant.id, operator('op'));
    assert.equal(
      await rejectedCode(lifecycle.rename(tenant.id, 'X', user('alice'))),
      'tenant_inactive',
    );
    assert.equal(
      await rejectedCode(lifecycle.rename(tenant.id, 'X', user('mallory'))),
      'not_permitted',
    );
  });

  it('needs a write grant for an operator to rename', async () => {
    const { lifecycle, store } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    assert.equal(
      await rejectedCode(lifecycle.rename(tenant.id, 'X', operator('op'))),
      'not_permitted',
    );
    await lifecycle.openOperatorGrant(tenant.id, { durationMs: DAY / 48 }, operator('op'));
    assert.equal(
      await rejectedCode(lifecycle.rename(tenant.id, 'X', operator('op'))),
      'not_permitted',
    );
    await lifecycle.openOperatorGrant(
      tenant.id,
      { durationMs: DAY / 48, write: true },
      operator('op'),
    );
    await lifecycle.rename(tenant.id, 'Fixed', operator('op', 'name typo, ticket 7'));
    const last = (await auditTrail(store, tenant.id)).at(-1);
    assert.deepEqual(last?.actor, { kind: 'operator', id: 'op' });
    assert.equal(last?.reason, 'name typo, ticket 7');
  });

  it('keeps plan changes with the owner by default', async () => {
    const fixture = lifecycleFixture();
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'admin' });
    assert.equal(
      await rejectedCode(fixture.lifecycle.setPlan(tenant.id, 'pro', user('bob'))),
      'not_permitted',
    );
    assert.equal((await fixture.lifecycle.setPlan(tenant.id, 'pro', user('alice'))).plan, 'pro');
    assert.equal((await fixture.lifecycle.setPlan(tenant.id, null, system())).plan, null);
    assert.equal(
      await rejectedCode(fixture.lifecycle.setPlan(tenant.id, 'a b', user('alice'))),
      'invalid_plan',
    );
    const actions = await auditActions(fixture.store, tenant.id);
    assert.equal(actions.filter((action) => action === 'tenant.plan_changed').length, 2);
  });
});

describe('settings', () => {
  it('reads with the view permission and writes with settings.manage', async () => {
    const fixture = lifecycleFixture();
    const { lifecycle, store } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'admin', vic: 'viewer' });
    assert.deepEqual(await lifecycle.updateSettings(tenant.id, { color: 'red' }, user('bob')), {
      color: 'red',
    });
    assert.deepEqual(await lifecycle.settings(tenant.id, user('vic')), { color: 'red' });
    assert.equal(
      await rejectedCode(lifecycle.updateSettings(tenant.id, {}, user('vic'))),
      'not_permitted',
    );
    assert.equal(await rejectedCode(lifecycle.settings(tenant.id, user('eve'))), 'not_permitted');
    assert.equal(
      await rejectedCode(lifecycle.updateSettings(tenant.id, 'nope', user('bob'))),
      'invalid_settings',
    );
    assert.equal((await auditActions(store, tenant.id)).at(-1), 'tenant.settings_changed');
  });

  it('turns any parser failure into invalid_settings, keeping the cause', async () => {
    const cause = new Error('schema says no');
    const { lifecycle } = lifecycleFixture({
      parseSettings: (raw) => {
        if (raw !== null && typeof raw === 'object' && 'bad' in raw) {
          throw cause;
        }
        return {};
      },
    });
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const error = await lifecycle.updateSettings(tenant.id, { bad: true }, user('alice')).then(
      () => assert.fail('expected a refusal'),
      (thrown: unknown) => thrown,
    );
    assert.ok(error instanceof TenancyError);
    assert.equal(error.code, 'invalid_settings');
    assert.equal(error.cause, cause);
  });

  it('authorizes before parsing, so outsiders never see the settings schema', async () => {
    const parsed: unknown[] = [];
    const { lifecycle } = lifecycleFixture({
      parseSettings: (raw) => {
        parsed.push(raw);
        if (raw !== null && typeof raw === 'object' && 'apiKey' in raw) {
          throw new TenancyError('invalid_settings', {
            issues: [{ path: ['apiKey'], code: 'invalid_format' }],
          });
        }
        return {};
      },
    });
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    parsed.length = 0;
    for (const id of [tenant.id, 99]) {
      assert.equal(
        await rejectedCode(lifecycle.updateSettings(id, { apiKey: 'nope' }, user('mallory'))),
        'not_permitted',
      );
    }
    assert.deepEqual(parsed, []);
    assert.equal(
      await rejectedCode(lifecycle.updateSettings(tenant.id, { apiKey: 'nope' }, user('alice'))),
      'invalid_settings',
    );
    assert.deepEqual(await lifecycle.updateSettings(tenant.id, {}, user('alice')), {});
  });

  it('lets an operator read with any grant', async () => {
    const { lifecycle } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    assert.equal(
      await rejectedCode(lifecycle.settings(tenant.id, operator('op'))),
      'not_permitted',
    );
    await lifecycle.openOperatorGrant(tenant.id, { durationMs: 60_000 }, operator('op'));
    assert.deepEqual(await lifecycle.settings(tenant.id, operator('op')), {});
  });
});

describe('transferOwnership', () => {
  it('moves ownership to a member atomically, demoting the old owner to the top role', async () => {
    const fixture = lifecycleFixture();
    const { lifecycle, store, events } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'member' });
    events.length = 0;
    const moved = await lifecycle.transferOwnership(tenant.id, 'bob', user('alice'));
    assert.equal(moved.ownerUserId, 'bob');
    assert.equal((await store.membership(tenant.id, 'bob'))?.role, 'owner');
    assert.equal((await store.membership(tenant.id, 'alice'))?.role, 'admin');
    const last = (await auditTrail(store, tenant.id)).at(-1);
    assert.equal(last?.action, 'ownership.transferred');
    assert.equal(last?.target, 'bob');
    assert.deepEqual(events, [
      { type: 'tenant', tenantId: tenant.id, change: 'owner' },
      { type: 'membership', tenantId: tenant.id, userId: 'alice', change: 'role' },
      { type: 'membership', tenantId: tenant.id, userId: 'bob', change: 'role' },
    ]);
    assert.equal(
      await rejectedCode(lifecycle.transferOwnership(tenant.id, 'alice', user('alice'))),
      'not_permitted',
    );
  });

  it('revokes the open invitations the former owner’s new role could not have sent', async () => {
    const fixture = lifecycleFixture();
    const { lifecycle, store } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'member' });
    const admin = await lifecycle.invite(
      tenant.id,
      { email: emailOf('a'), role: 'admin' },
      user('alice'),
    );
    const member = await lifecycle.invite(
      tenant.id,
      { email: emailOf('m'), role: 'member' },
      user('alice'),
    );
    await lifecycle.transferOwnership(tenant.id, 'bob', user('alice'));
    assert.equal(await store.invitation(admin.invitation.id), null);
    assert.notEqual(await store.invitation(member.invitation.id), null);
    const trail = await auditTrail(store, tenant.id);
    assert.deepEqual(
      trail.slice(-2).map((record) => [record.action, record.target]),
      [
        ['member.invitation_revoked', String(admin.invitation.id)],
        ['ownership.transferred', 'bob'],
      ],
    );
  });

  it('refuses admins, non-members and malformed targets, and ignores a transfer to the owner', async () => {
    const fixture = lifecycleFixture();
    const { lifecycle } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'admin' });
    assert.equal(
      await rejectedCode(lifecycle.transferOwnership(tenant.id, 'bob', user('bob'))),
      'not_permitted',
    );
    assert.equal(
      await rejectedCode(lifecycle.transferOwnership(tenant.id, 'zed', user('alice'))),
      'not_member',
    );
    assert.equal(
      await rejectedCode(lifecycle.transferOwnership(tenant.id, '', user('alice'))),
      'not_member',
    );
    const same = await lifecycle.transferOwnership(tenant.id, 'alice', user('alice'));
    assert.equal(same.version, tenant.version);
  });

  it('lets a system actor or an operator with a write grant transfer', async () => {
    const fixture = lifecycleFixture();
    const { lifecycle } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'member', carol: 'viewer' });
    assert.equal(
      (await lifecycle.transferOwnership(tenant.id, 'bob', system())).ownerUserId,
      'bob',
    );
    await lifecycle.openOperatorGrant(
      tenant.id,
      { durationMs: 60_000, write: true },
      operator('op'),
    );
    const moved = await lifecycle.transferOwnership(tenant.id, 'carol', operator('op'));
    assert.equal(moved.ownerUserId, 'carol');
  });
});

describe('suspension', () => {
  it('suspends and resumes for operators and systems with a reason', async () => {
    const { lifecycle, store, events } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    events.length = 0;
    const suspended = await lifecycle.suspend(tenant.id, operator('op', 'chargeback'));
    assert.equal(suspended.status, 'suspended');
    assert.equal(suspended.suspensionReason, 'chargeback');
    assert.ok(suspended.suspendedAt instanceof Date);
    assert.equal(await rejectedCode(lifecycle.suspend(tenant.id, system())), 'invalid_transition');
    const resumed = await lifecycle.resume(tenant.id, system('paid'));
    assert.equal(resumed.status, 'active');
    assert.equal(resumed.suspendedAt, null);
    assert.equal(resumed.suspensionReason, null);
    assert.equal(await rejectedCode(lifecycle.resume(tenant.id, system())), 'invalid_transition');
    assert.deepEqual((await auditActions(store, tenant.id)).slice(-2), [
      'tenant.suspended',
      'tenant.resumed',
    ]);
    assert.equal(events.length, 2);
  });

  it('refuses users, even the owner, and operators without a reason', async () => {
    const { lifecycle } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    assert.equal(await rejectedCode(lifecycle.suspend(tenant.id, user('alice'))), 'not_permitted');
    assert.equal(
      await rejectedCode(
        lifecycle.suspend(tenant.id, { kind: 'operator', userId: 'op', reason: '' }),
      ),
      'reason_required',
    );
    assert.equal(
      await rejectedCode(
        lifecycle.suspend(tenant.id, { kind: 'operator', userId: 'op', reason: 'x'.repeat(501) }),
      ),
      'invalid_reason',
    );
    assert.equal(await rejectedCode(lifecycle.suspend(42, operator('op'))), 'not_found');
  });
});

describe('scheduled deletion', () => {
  it('lets the owner schedule and cancel, and nobody below them', async () => {
    const fixture = lifecycleFixture();
    const { lifecycle, clock } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'admin' });
    assert.equal(
      await rejectedCode(lifecycle.scheduleDeletion(tenant.id, user('bob'))),
      'not_permitted',
    );
    const scheduled = await lifecycle.scheduleDeletion(tenant.id, user('alice'));
    assert.equal(scheduled.status, 'pending_deletion');
    assert.equal(scheduled.deletionDueAt?.getTime(), clock.now().getTime() + 30 * DAY);
    assert.equal(
      await rejectedCode(lifecycle.scheduleDeletion(tenant.id, user('alice'))),
      'invalid_transition',
    );
    assert.equal(
      await rejectedCode(lifecycle.rename(tenant.id, 'X', user('alice'))),
      'tenant_inactive',
    );
    const cancelled = await lifecycle.cancelDeletion(tenant.id, user('alice'));
    assert.equal(cancelled.status, 'active');
    assert.equal(cancelled.deletionDueAt, null);
    assert.equal(
      await rejectedCode(lifecycle.cancelDeletion(tenant.id, user('alice'))),
      'invalid_transition',
    );
  });

  it('keeps a suspension through scheduling and cancelling', async () => {
    const { lifecycle } = lifecycleFixture({ deletionRetentionMs: DAY });
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    await lifecycle.suspend(tenant.id, operator('op', 'abuse'));
    await lifecycle.scheduleDeletion(tenant.id, user('alice'));
    const cancelled = await lifecycle.cancelDeletion(tenant.id, user('alice'));
    assert.equal(cancelled.status, 'suspended');
    assert.equal(cancelled.suspensionReason, 'abuse');
  });
});

describe('purge', () => {
  it('refuses until the deletion is due, then purges in three phases', async () => {
    const fixture = lifecycleFixture({ deletionRetentionMs: DAY });
    const { lifecycle, store, events, clock, dns } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'member' });
    const { claim } = await lifecycle.addDomain(tenant.id, 'shop.acme-corp.io', user('alice'));
    dns.publish(claim.hostname, claim.token);
    await lifecycle.checkDomain(tenant.id, claim.hostname, user('alice'));
    assert.equal(
      await rejectedCode(lifecycle.purge(tenant.id, system(), noPurge)),
      'invalid_transition',
    );
    await lifecycle.scheduleDeletion(tenant.id, user('alice'));
    assert.equal(
      await rejectedCode(lifecycle.purge(tenant.id, system(), noPurge)),
      'purge_not_due',
    );
    clock.advance(DAY);
    const seen: string[] = [];
    events.length = 0;
    await lifecycle.purge(tenant.id, system('retention'), async (id) => {
      seen.push(`${id}:${(await store.tenantById(id))?.status ?? 'gone'}`);
    });
    assert.deepEqual(seen, [`${tenant.id}:purging`]);
    assert.equal(await store.tenantById(tenant.id), null);
    assert.equal(await store.membership(tenant.id, 'bob'), null);
    assert.equal(await store.tenantByVerifiedHostname(claim.hostname), null);
    assert.deepEqual((await auditActions(store, tenant.id)).slice(-2), [
      'tenant.purge_started',
      'tenant.purged',
    ]);
    assert.deepEqual(events, [
      { type: 'tenant', tenantId: tenant.id, change: 'status' },
      { type: 'domain', tenantId: tenant.id, hostname: claim.hostname, change: 'removed' },
      { type: 'tenant', tenantId: tenant.id, change: 'purged' },
    ]);
    assert.equal(await rejectedCode(lifecycle.purge(tenant.id, system(), noPurge)), 'not_found');
  });

  it('leaves the tenant purging when the data purge fails, and resumes it', async () => {
    const { lifecycle, store } = lifecycleFixture({ deletionRetentionMs: 0 });
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    await lifecycle.scheduleDeletion(tenant.id, user('alice'));
    await assert.rejects(
      lifecycle.purge(tenant.id, system(), async () => {
        throw new Error('disk offline');
      }),
      /disk offline/,
    );
    assert.equal((await store.tenantById(tenant.id))?.status, 'purging');
    assert.equal(
      await rejectedCode(lifecycle.cancelDeletion(tenant.id, user('alice'))),
      'purge_in_progress',
    );
    assert.equal(
      await rejectedCode(lifecycle.rename(tenant.id, 'X', system())),
      'purge_in_progress',
    );
    let calls = 0;
    await lifecycle.purge(tenant.id, system(), async () => {
      calls += 1;
    });
    assert.equal(calls, 1);
    assert.equal(await store.tenantById(tenant.id), null);
    const actions = await auditActions(store, tenant.id);
    assert.equal(actions.filter((action) => action === 'tenant.purge_started').length, 1);
  });

  it('is a system action only and needs a purge function', async () => {
    const { lifecycle } = lifecycleFixture({ deletionRetentionMs: 0 });
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    assert.equal(
      await rejectedCode(lifecycle.purge(tenant.id, user('alice'), noPurge)),
      'not_permitted',
    );
    assert.equal(
      await rejectedCode(lifecycle.purge(tenant.id, operator('op'), noPurge)),
      'not_permitted',
    );
    assert.equal(
      await rejectedCode(
        lifecycle.purge(tenant.id, system(), 'nope' as unknown as () => Promise<void>),
      ),
      'invalid_lifecycle_options',
    );
  });
});

describe('event listener', () => {
  /** A fixture whose store fails the test if a listener error ever reaches it. */
  const isolated = (options: Parameters<typeof lifecycleFixture>[0]) =>
    lifecycleFixture(options, {
      onAfterCommitError(error) {
        assert.fail(`a listener error reached the store: ${String(error)}`);
      },
    });
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('routes a listener that throws to onEmitError and keeps the commit', async () => {
    const failures: [unknown, string][] = [];
    const boom = new Error('listener broke');
    const { lifecycle, store } = isolated({
      emit: () => {
        throw boom;
      },
      onEmitError: (error, type) => failures.push([error, type]),
    });
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    assert.notEqual(await store.tenantById(tenant.id), null);
    assert.deepEqual(failures, [
      [boom, 'tenant'],
      [boom, 'membership'],
    ]);
  });

  it('routes an async listener’s rejection to onEmitError', async () => {
    const failures: string[] = [];
    const { lifecycle } = isolated({
      emit: async (event) => {
        if (event.type === 'invitation') {
          throw new Error('smtp down');
        }
      },
      onEmitError: (error, type) =>
        failures.push(`${type}: ${error instanceof Error ? error.message : String(error)}`),
    });
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const issued = await lifecycle.invite(tenant.id, { email: emailOf('b') }, user('alice'));
    await settle();
    assert.deepEqual(failures, ['invitation: smtp down']);
    assert.ok(issued.token.length > 0);
  });

  it('reports through a process warning by default, without the error or the event', async () => {
    const warnings: Error[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning);
    };
    process.on('warning', onWarning);
    try {
      const { lifecycle } = isolated({
        emit: (event) =>
          event.type === 'invitation' ? Promise.reject(new Error('smtp secret')) : undefined,
      });
      const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
      const { token } = await lifecycle.invite(tenant.id, { email: emailOf('b') }, user('alice'));
      await settle();
      await settle();
      assert.equal(warnings.length, 1);
      const [warning] = warnings;
      assert.ok(warning !== undefined && 'code' in warning);
      assert.equal(warning.code, 'JSAILS_TENANCY_EMIT_FAILED');
      assert.match(warning?.message ?? '', /invitation event/);
      assert.equal(warning?.message.includes('smtp secret'), false);
      assert.equal(warning?.message.includes(token), false);
    } finally {
      process.off('warning', onWarning);
    }
  });

  it('falls back to a warning when onEmitError itself throws', async () => {
    const warnings: Error[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning);
    };
    process.on('warning', onWarning);
    try {
      const { lifecycle } = isolated({
        emit: () => {
          throw new Error('listener broke');
        },
        onEmitError: () => {
          throw new Error('reporter broke');
        },
      });
      await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
      await settle();
      assert.equal(warnings.length, 2);
    } finally {
      process.off('warning', onWarning);
    }
  });

  it('refuses an onEmitError that is not a function', () => {
    assert.throws(
      () => lifecycleFixture({ onEmitError: 'nope' as unknown as () => void }),
      (error: unknown) =>
        error instanceof TenancyError && error.code === 'invalid_lifecycle_options',
    );
  });
});

describe('transactions', () => {
  it('retries an operation that lost a lock conflict, and gives up after the retries', async () => {
    let failures = 0;
    const conflict = (): Error => new TenancyError('transaction_conflict');
    const fixture = lifecycleFixture(
      {},
      {
        onStatement(event) {
          if (event.statement === 'insertTenant' && failures > 0) {
            failures -= 1;
            throw conflict();
          }
        },
      },
    );
    failures = 2;
    await fixture.lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    failures = 3;
    assert.equal(
      await rejectedCode(fixture.lifecycle.create({ name: 'Beta', slug: 'beta' }, user('alice'))),
      'transaction_conflict',
    );
    const noRetry = lifecycleFixture(
      { conflictRetries: 0 },
      {
        onStatement(event) {
          if (event.statement === 'insertTenant') {
            throw conflict();
          }
        },
      },
    );
    assert.equal(
      await rejectedCode(noRetry.lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'))),
      'transaction_conflict',
    );
  });

  it('emits nothing and keeps nothing when a statement fails', async () => {
    const fixture = lifecycleFixture(
      {},
      {
        onStatement(event) {
          if (event.statement === 'appendAudit') {
            throw new Error('injected');
          }
        },
      },
    );
    await assert.rejects(
      fixture.lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice')),
      /injected/,
    );
    assert.deepEqual(fixture.events, []);
    assert.equal(await fixture.store.tenantBySlug('acme'), null);
  });

  it('refuses a clock that gives no valid date', async () => {
    const { lifecycle } = lifecycleFixture({ now: () => new Date(Number.NaN) });
    assert.equal(
      await rejectedCode(lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'))),
      'invalid_lifecycle_options',
    );
  });

  it('joins through the fixture helper', async () => {
    const fixture = lifecycleFixture();
    const tenant = await fixture.lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    await join(fixture, tenant, 'bob', 'viewer');
    assert.equal((await fixture.store.membership(tenant.id, 'bob'))?.role, 'viewer');
  });
});
