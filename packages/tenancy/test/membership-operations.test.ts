/**
 * Scenario tests for memberships and invitations: invite (role, seat and
 * daily limits, token rotation), revoke, accept (every check in its order,
 * single use, consumption of dead invitations), role changes under the rank
 * rule, removal and leaving (with the grants and invitations that go with a
 * membership), and the account-deletion hook. Audit records never carry an
 * invitee's email address.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defineTenantRoles } from '../src/tenant-roles.js';
import { createTenancyLifecycle } from '../src/tenancy-lifecycle.js';
import { plainTenantSettings } from '../src/tenancy-lifecycle-options.js';
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

const accept = (userId: string, email = emailOf(userId), emailVerified = true) => ({
  userId,
  email,
  emailVerified,
});

describe('invite', () => {
  it('issues a single token, stores its hash, audits by id and hands the token to the event', async () => {
    const { lifecycle, store, events, clock } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    events.length = 0;
    const { invitation, token } = await lifecycle.invite(
      tenant.id,
      { email: ' Bob@Mail.Tenancy-Test.io ', role: 'admin' },
      user('alice'),
    );
    assert.match(token, /^jsinv_[A-Za-z0-9_-]{43}$/);
    assert.equal(invitation.email, 'bob@mail.tenancy-test.io');
    assert.equal(invitation.role, 'admin');
    assert.equal(invitation.invitedBy, 'alice');
    assert.equal(invitation.expiresAt.getTime(), clock.now().getTime() + 7 * DAY);
    assert.ok(!JSON.stringify(invitation).includes(token));
    assert.deepEqual(events, [
      {
        type: 'invitation',
        tenantId: tenant.id,
        invitationId: invitation.id,
        email: 'bob@mail.tenancy-test.io',
        role: 'admin',
        invitedBy: 'alice',
        expiresAt: invitation.expiresAt,
        token,
      },
    ]);
    const last = (await auditTrail(store, tenant.id)).at(-1);
    assert.equal(last?.action, 'member.invited');
    assert.equal(last?.target, String(invitation.id));
  });

  it('uses the default role and refuses roles the inviter cannot assign', async () => {
    const fixture = lifecycleFixture();
    const { lifecycle } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'admin', carol: 'member' });
    const { invitation } = await lifecycle.invite(tenant.id, { email: emailOf('d') }, user('bob'));
    assert.equal(invitation.role, 'member');
    const invite = (role: string, by = user('bob')) =>
      lifecycle.invite(tenant.id, { email: emailOf('e'), role: role as 'member' }, by);
    assert.equal(await rejectedCode(invite('admin')), 'role_not_assignable');
    assert.equal(await rejectedCode(invite('owner')), 'role_not_assignable');
    assert.equal(await rejectedCode(invite('janitor')), 'invalid_role');
    assert.equal(await rejectedCode(invite('viewer', user('carol'))), 'not_permitted');
    assert.equal(await rejectedCode(invite('viewer', system())), 'not_permitted');
    assert.equal(
      await rejectedCode(lifecycle.invite(tenant.id, { email: 'not-an-email' }, user('bob'))),
      'invalid_email',
    );
    assert.equal(
      await rejectedCode(lifecycle.invite(tenant.id, { email: 'x@localhost' }, user('bob'))),
      'invalid_email',
    );
  });

  it('lets an operator with a write grant invite any defined role', async () => {
    const { lifecycle } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    await lifecycle.openOperatorGrant(
      tenant.id,
      { durationMs: 60_000, write: true },
      operator('op'),
    );
    const { invitation } = await lifecycle.invite(
      tenant.id,
      { email: emailOf('b'), role: 'admin' },
      operator('op'),
    );
    assert.equal(invitation.invitedBy, 'op');
  });

  it('counts members and open invitations against the seats', async () => {
    const { lifecycle, clock } = lifecycleFixture({ limits: () => ({ seats: 3 }) });
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const owner = user('alice');
    await lifecycle.invite(tenant.id, { email: emailOf('b') }, owner);
    const { token } = await lifecycle.invite(tenant.id, { email: emailOf('c') }, owner);
    assert.equal(
      await rejectedCode(lifecycle.invite(tenant.id, { email: emailOf('d') }, owner)),
      'limit_exceeded',
    );
    await lifecycle.invite(tenant.id, { email: emailOf('b') }, owner);
    await lifecycle.acceptInvitation(token, accept('c'));
    assert.equal(
      await rejectedCode(lifecycle.invite(tenant.id, { email: emailOf('d') }, owner)),
      'limit_exceeded',
    );
    clock.advance(8 * DAY);
    await lifecycle.invite(tenant.id, { email: emailOf('d') }, owner);
  });

  it('caps the invitations a tenant sends in 24 hours', async () => {
    const { lifecycle, clock } = lifecycleFixture({ limits: () => ({ invitationsPerDay: 2 }) });
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const send = (who: string) =>
      lifecycle.invite(tenant.id, { email: emailOf(who) }, user('alice'));
    await send('b');
    await send('b');
    assert.equal(await rejectedCode(send('c')), 'limit_exceeded');
    clock.advance(DAY);
    await send('c');
  });

  it('refuses limits the hook gets wrong', async () => {
    const { lifecycle } = lifecycleFixture({ limits: () => ({ seats: -1 }) });
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    assert.equal(
      await rejectedCode(lifecycle.invite(tenant.id, { email: emailOf('b') }, user('alice'))),
      'invalid_limits',
    );
  });

  it('rotates the token when an address is invited again', async () => {
    const { lifecycle } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const first = await lifecycle.invite(tenant.id, { email: emailOf('b') }, user('alice'));
    const second = await lifecycle.invite(tenant.id, { email: emailOf('b') }, user('alice'));
    assert.notEqual(first.token, second.token);
    assert.equal(
      await rejectedCode(lifecycle.acceptInvitation(first.token, accept('b'))),
      'invalid_invitation',
    );
    await lifecycle.acceptInvitation(second.token, accept('b'));
  });
});

describe('invite authorization', () => {
  it('refuses an outsider with not_permitted whatever email or role they send', async () => {
    const fixture = lifecycleFixture();
    const tenant = await tenantWith(fixture, 'acme', 'alice', { carol: 'member' });
    const inputs: readonly unknown[] = [
      { email: 'not an email' },
      { email: emailOf('x'), role: 'nope' },
      { email: emailOf('x'), role: 'owner' },
      null,
    ];
    for (const by of [user('mallory'), user('carol')]) {
      for (const input of inputs) {
        assert.equal(
          await rejectedCode(fixture.lifecycle.invite(tenant.id, input as { email: string }, by)),
          'not_permitted',
        );
      }
    }
    assert.equal(
      await rejectedCode(fixture.lifecycle.invite(999_999, { email: 'nope' }, user('mallory'))),
      'not_permitted',
    );
    const owner = user('alice');
    assert.equal(
      await rejectedCode(fixture.lifecycle.invite(tenant.id, { email: 'nope' }, owner)),
      'invalid_email',
    );
  });
});

describe('revokeInvitation', () => {
  it('lets the inviter or anyone who could assign the role revoke', async () => {
    const fixture = lifecycleFixture();
    const { lifecycle, store } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'admin', vic: 'viewer' });
    const byOwner = await lifecycle.invite(
      tenant.id,
      { email: emailOf('x'), role: 'admin' },
      user('alice'),
    );
    const byAdmin = await lifecycle.invite(tenant.id, { email: emailOf('y') }, user('bob'));
    assert.equal(
      await rejectedCode(lifecycle.revokeInvitation(tenant.id, byOwner.invitation.id, user('bob'))),
      'not_permitted',
    );
    assert.equal(
      await rejectedCode(lifecycle.revokeInvitation(tenant.id, byAdmin.invitation.id, user('vic'))),
      'not_permitted',
    );
    await lifecycle.revokeInvitation(tenant.id, byAdmin.invitation.id, user('bob'));
    await lifecycle.revokeInvitation(tenant.id, byOwner.invitation.id, user('alice'));
    assert.equal(
      await rejectedCode(lifecycle.acceptInvitation(byOwner.token, accept('x'))),
      'invalid_invitation',
    );
    assert.equal(
      await rejectedCode(
        lifecycle.revokeInvitation(tenant.id, byOwner.invitation.id, user('alice')),
      ),
      'not_found',
    );
    assert.equal(
      await rejectedCode(lifecycle.revokeInvitation(tenant.id, -1, user('alice'))),
      'not_found',
    );
    const actions = await auditActions(store, tenant.id);
    assert.equal(actions.filter((action) => action === 'member.invitation_revoked').length, 2);
  });

  it('does not reach another tenant’s invitation', async () => {
    const { lifecycle } = lifecycleFixture();
    const acme = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const beta = await lifecycle.create({ name: 'Beta', slug: 'beta' }, user('alice'));
    const { invitation } = await lifecycle.invite(beta.id, { email: emailOf('b') }, user('alice'));
    assert.equal(
      await rejectedCode(lifecycle.revokeInvitation(acme.id, invitation.id, user('alice'))),
      'not_found',
    );
  });
});

describe('acceptInvitation', () => {
  it('admits a verified matching user once, with the invited role', async () => {
    const { lifecycle, store, events } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const { token } = await lifecycle.invite(
      tenant.id,
      { email: emailOf('bob'), role: 'viewer' },
      user('alice'),
    );
    events.length = 0;
    const membership = await lifecycle.acceptInvitation(
      token,
      accept('bob', emailOf('bob').toUpperCase()),
    );
    assert.equal(membership.role, 'viewer');
    assert.equal(membership.invitedBy, 'alice');
    assert.deepEqual(events, [
      { type: 'membership', tenantId: tenant.id, userId: 'bob', change: 'added' },
    ]);
    const last = (await auditTrail(store, tenant.id)).at(-1);
    assert.equal(last?.action, 'member.joined');
    assert.deepEqual(last?.actor, { kind: 'user', id: 'bob' });
    assert.equal(
      await rejectedCode(lifecycle.acceptInvitation(token, accept('bob'))),
      'invalid_invitation',
    );
  });

  it('refuses malformed and unknown tokens and malformed users', async () => {
    const { lifecycle } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const { token } = await lifecycle.invite(tenant.id, { email: emailOf('b') }, user('alice'));
    assert.equal(
      await rejectedCode(lifecycle.acceptInvitation('jsinv_short', accept('b'))),
      'invalid_invitation',
    );
    const unknown = `jsinv_${'A'.repeat(43)}`;
    assert.equal(
      await rejectedCode(lifecycle.acceptInvitation(unknown, accept('b'))),
      'invalid_invitation',
    );
    assert.equal(
      await rejectedCode(lifecycle.acceptInvitation(token, accept(''))),
      'invalid_actor',
    );
  });

  it('checks the email before anything is consumed', async () => {
    const { lifecycle } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const { token } = await lifecycle.invite(tenant.id, { email: emailOf('b') }, user('alice'));
    assert.equal(
      await rejectedCode(lifecycle.acceptInvitation(token, accept('b', emailOf('b'), false))),
      'email_unverified',
    );
    assert.equal(
      await rejectedCode(lifecycle.acceptInvitation(token, accept('m', emailOf('m')))),
      'email_mismatch',
    );
    assert.equal(
      await rejectedCode(lifecycle.acceptInvitation(token, accept('m', 'garbage'))),
      'email_mismatch',
    );
    await lifecycle.acceptInvitation(token, accept('b'));
  });

  it('consumes an expired invitation and reports it', async () => {
    const { lifecycle, store, clock } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const { token } = await lifecycle.invite(tenant.id, { email: emailOf('b') }, user('alice'));
    clock.advance(7 * DAY);
    assert.equal(
      await rejectedCode(lifecycle.acceptInvitation(token, accept('b'))),
      'invitation_expired',
    );
    assert.equal(
      await rejectedCode(lifecycle.acceptInvitation(token, accept('b'))),
      'invalid_invitation',
    );
    assert.equal((await auditActions(store, tenant.id)).at(-1), 'member.invitation_expired');
    assert.equal(await store.membership(tenant.id, 'b'), null);
  });

  it('consumes the invitation of an existing member and reports already_member', async () => {
    const fixture = lifecycleFixture();
    const { lifecycle, store } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'viewer' });
    const { token } = await lifecycle.invite(
      tenant.id,
      { email: emailOf('bob'), role: 'admin' },
      user('alice'),
    );
    assert.equal(
      await rejectedCode(lifecycle.acceptInvitation(token, accept('bob'))),
      'already_member',
    );
    assert.equal((await store.membership(tenant.id, 'bob'))?.role, 'viewer');
    assert.equal((await auditActions(store, tenant.id)).at(-1), 'member.invitation_discarded');
    assert.equal(
      await rejectedCode(lifecycle.acceptInvitation(token, accept('bob'))),
      'invalid_invitation',
    );
  });

  it('keeps the invitation while the tenant is inactive or full', async () => {
    let seats = 1;
    const { lifecycle } = lifecycleFixture({ limits: () => ({ seats }) });
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    seats = 2;
    const { token } = await lifecycle.invite(tenant.id, { email: emailOf('b') }, user('alice'));
    seats = 1;
    assert.equal(
      await rejectedCode(lifecycle.acceptInvitation(token, accept('b'))),
      'limit_exceeded',
    );
    seats = 2;
    await lifecycle.suspend(tenant.id, operator('op'));
    assert.equal(
      await rejectedCode(lifecycle.acceptInvitation(token, accept('b'))),
      'tenant_inactive',
    );
    await lifecycle.resume(tenant.id, operator('op'));
    await lifecycle.acceptInvitation(token, accept('b'));
  });

  it('consumes an invitation whose role the app no longer defines', async () => {
    const fixture = lifecycleFixture();
    const tenant = await fixture.lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const { token } = await fixture.lifecycle.invite(
      tenant.id,
      { email: emailOf('b'), role: 'viewer' },
      user('alice'),
    );
    const narrowed = createTenancyLifecycle({
      store: fixture.store,
      roles: defineTenantRoles({
        roles: { admin: { rank: 2, permissions: [] }, member: { rank: 1, permissions: [] } },
        defaultRole: 'member',
      }),
      parseSettings: plainTenantSettings,
      now: fixture.clock.now,
    });
    assert.equal(
      await rejectedCode(narrowed.acceptInvitation(token, accept('b'))),
      'invalid_invitation',
    );
    assert.equal(
      (await auditActions(fixture.store, tenant.id)).at(-1),
      'member.invitation_discarded',
    );
  });
});

describe('changeRole', () => {
  it('moves roles by the rank rule', async () => {
    const fixture = lifecycleFixture();
    const { lifecycle, store, events } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', {
      bob: 'admin',
      ann: 'admin',
      carol: 'member',
    });
    events.length = 0;
    assert.equal(
      (await lifecycle.changeRole(tenant.id, 'carol', 'viewer', user('bob'))).role,
      'viewer',
    );
    assert.deepEqual(events, [
      { type: 'membership', tenantId: tenant.id, userId: 'carol', change: 'role' },
    ]);
    assert.equal(
      await rejectedCode(lifecycle.changeRole(tenant.id, 'carol', 'admin', user('bob'))),
      'role_not_assignable',
    );
    assert.equal(
      await rejectedCode(lifecycle.changeRole(tenant.id, 'ann', 'member', user('bob'))),
      'role_not_assignable',
    );
    assert.equal(
      await rejectedCode(lifecycle.changeRole(tenant.id, 'bob', 'member', user('bob'))),
      'role_not_assignable',
    );
    assert.equal(
      await rejectedCode(lifecycle.changeRole(tenant.id, 'alice', 'member', user('bob'))),
      'owner_required',
    );
    assert.equal(
      await rejectedCode(
        lifecycle.changeRole(tenant.id, 'carol', 'owner' as 'admin', user('alice')),
      ),
      'role_not_assignable',
    );
    assert.equal(
      await rejectedCode(
        lifecycle.changeRole(tenant.id, 'carol', 'boss' as 'admin', user('alice')),
      ),
      'invalid_role',
    );
    assert.equal(
      await rejectedCode(lifecycle.changeRole(tenant.id, 'zed', 'viewer', user('alice'))),
      'not_member',
    );
    assert.equal(
      await rejectedCode(lifecycle.changeRole(tenant.id, 'carol', 'member', user('carol'))),
      'not_permitted',
    );
    assert.equal(
      (await lifecycle.changeRole(tenant.id, 'ann', 'member', user('alice'))).role,
      'member',
    );
    assert.equal((await auditActions(store, tenant.id)).at(-1), 'member.role_changed');
  });

  it('does nothing for an unchanged role', async () => {
    const fixture = lifecycleFixture();
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'member' });
    const before = await auditActions(fixture.store, tenant.id);
    await fixture.lifecycle.changeRole(tenant.id, 'bob', 'member', user('alice'));
    assert.deepEqual(await auditActions(fixture.store, tenant.id), before);
  });

  it('revokes the invitations a demoted member could no longer send', async () => {
    const fixture = lifecycleFixture();
    const { lifecycle, store } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'admin' });
    const member = await lifecycle.invite(
      tenant.id,
      { email: emailOf('m'), role: 'member' },
      user('bob'),
    );
    await lifecycle.changeRole(tenant.id, 'bob', 'member', user('alice'));
    assert.equal(await store.invitation(member.invitation.id), null);
    const actions = await auditActions(store, tenant.id);
    assert.deepEqual(actions.slice(-2), ['member.invitation_revoked', 'member.role_changed']);
  });

  it('revokes every invitation of a member whose new role cannot invite at all', async () => {
    const fixture = lifecycleFixture();
    const { lifecycle, store } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'admin' });
    // A viewer ranks below `member`, so only the missing permission can revoke it.
    const viewer = await lifecycle.invite(
      tenant.id,
      { email: emailOf('v'), role: 'viewer' },
      user('bob'),
    );
    await lifecycle.changeRole(tenant.id, 'bob', 'member', user('alice'));
    assert.equal(await store.invitation(viewer.invitation.id), null);
    assert.equal(
      await rejectedCode(lifecycle.acceptInvitation(viewer.token, accept('v'))),
      'invalid_invitation',
    );
    const trail = await auditTrail(store, tenant.id);
    assert.deepEqual(
      trail.slice(-2).map((record) => [record.action, record.target]),
      [
        ['member.invitation_revoked', String(viewer.invitation.id)],
        ['member.role_changed', 'bob'],
      ],
    );
  });

  it('revokes the invitations of a high-ranked role without members.invite', async () => {
    const fixture = lifecycleFixture({
      roles: defineTenantRoles({
        roles: {
          admin: { rank: 60, permissions: ['members.invite', 'members.role'] },
          member: { rank: 50, permissions: ['tenant.view'] },
          viewer: { rank: 20, permissions: [] },
        },
        defaultRole: 'viewer',
      }),
    });
    const { lifecycle, store } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'admin' });
    const sent = await lifecycle.invite(
      tenant.id,
      { email: emailOf('v'), role: 'viewer' },
      user('bob'),
    );
    await lifecycle.changeRole(tenant.id, 'bob', 'member', user('alice'));
    assert.equal(await store.invitation(sent.invitation.id), null);
  });

  it('keeps the invitations a demoted member could still send', async () => {
    const fixture = lifecycleFixture({
      roles: defineTenantRoles({
        roles: {
          admin: { rank: 60, permissions: ['members.invite', 'members.role'] },
          member: { rank: 50, permissions: ['members.invite'] },
          viewer: { rank: 20, permissions: [] },
        },
        defaultRole: 'viewer',
      }),
    });
    const { lifecycle, store } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'admin' });
    const sent = await lifecycle.invite(
      tenant.id,
      { email: emailOf('v'), role: 'viewer' },
      user('bob'),
    );
    await lifecycle.changeRole(tenant.id, 'bob', 'member', user('alice'));
    assert.notEqual(await store.invitation(sent.invitation.id), null);
  });

  it('refuses an outsider with not_permitted whatever role they send', async () => {
    const fixture = lifecycleFixture();
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'member' });
    for (const role of ['nope', 'owner', 'viewer']) {
      assert.equal(
        await rejectedCode(
          fixture.lifecycle.changeRole(tenant.id, 'bob', role as 'viewer', user('mallory')),
        ),
        'not_permitted',
      );
    }
    assert.equal(
      await rejectedCode(
        fixture.lifecycle.changeRole(tenant.id, 'bob', 'nope' as 'viewer', user('alice')),
      ),
      'invalid_role',
    );
  });
});

describe('removeMember and leave', () => {
  it('removes a lower-ranked member with their grants and invitations', async () => {
    const fixture = lifecycleFixture();
    const { lifecycle, store, events, clock } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'admin', carol: 'admin' });
    const sent = await lifecycle.invite(tenant.id, { email: emailOf('z') }, user('carol'));
    await lifecycle.openOperatorGrant(tenant.id, { durationMs: 60_000 }, operator('carol'));
    assert.equal(
      await rejectedCode(lifecycle.removeMember(tenant.id, 'carol', user('bob'))),
      'not_permitted',
    );
    events.length = 0;
    await lifecycle.removeMember(tenant.id, 'carol', user('alice'));
    assert.equal(await store.membership(tenant.id, 'carol'), null);
    assert.equal(await store.activeOperatorGrant(tenant.id, 'carol', clock.now()), null);
    assert.equal(await store.invitation(sent.invitation.id), null);
    assert.deepEqual((await store.membershipsOfUser('carol', { limit: 10 })).items, []);
    assert.deepEqual((await auditActions(store, tenant.id)).slice(-3), [
      'operator.access_closed',
      'member.invitation_revoked',
      'member.removed',
    ]);
    assert.deepEqual(events, [
      { type: 'membership', tenantId: tenant.id, userId: 'carol', change: 'removed' },
    ]);
  });

  it('never removes the owner and reports non-members', async () => {
    const fixture = lifecycleFixture();
    const { lifecycle } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'admin' });
    assert.equal(
      await rejectedCode(lifecycle.removeMember(tenant.id, 'alice', user('bob'))),
      'owner_required',
    );
    assert.equal(
      await rejectedCode(lifecycle.removeMember(tenant.id, 'alice', system())),
      'owner_required',
    );
    assert.equal(
      await rejectedCode(lifecycle.removeMember(tenant.id, 'nobody', user('alice'))),
      'not_member',
    );
    await lifecycle.removeMember(tenant.id, 'bob', system('offboarding'));
  });

  it('lets a member leave, even a suspended tenant, but not the owner', async () => {
    const fixture = lifecycleFixture();
    const { lifecycle, store } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'member' });
    await lifecycle.suspend(tenant.id, operator('op'));
    await lifecycle.leave(tenant.id, user('bob'));
    assert.equal(await store.membership(tenant.id, 'bob'), null);
    assert.equal((await auditActions(store, tenant.id)).at(-1), 'member.left');
    assert.equal(await rejectedCode(lifecycle.leave(tenant.id, user('alice'))), 'owner_required');
    assert.equal(await rejectedCode(lifecycle.leave(tenant.id, user('bob'))), 'not_permitted');
    assert.equal(await rejectedCode(lifecycle.leave(tenant.id, system())), 'not_permitted');
  });
});

describe('userDeleted', () => {
  it('reports owned tenants and changes nothing while there are any', async () => {
    const fixture = lifecycleFixture();
    const { lifecycle, store } = fixture;
    const owned = await tenantWith(fixture, 'acme', 'alice');
    const other = await tenantWith(fixture, 'beta', 'bob', { alice: 'member' });
    const result = await lifecycle.userDeleted('alice', system('account deleted'));
    assert.deepEqual(result, { removedFrom: [], ownerOf: [owned.id] });
    assert.notEqual(await store.membership(other.id, 'alice'), null);
  });

  it('removes every membership of a user who owns nothing', async () => {
    const fixture = lifecycleFixture();
    const { lifecycle, store } = fixture;
    const acme = await tenantWith(fixture, 'acme', 'alice', { carl: 'admin' });
    const beta = await tenantWith(fixture, 'beta', 'bob', { carl: 'viewer' });
    const result = await lifecycle.userDeleted('carl', system('account deleted'));
    assert.deepEqual(result, { removedFrom: [acme.id, beta.id], ownerOf: [] });
    assert.deepEqual((await store.membershipsOfUser('carl', { limit: 10 })).items, []);
    const [record] = (await auditTrail(store, beta.id)).slice(-1);
    assert.equal(record?.action, 'member.deleted');
    assert.deepEqual(record?.actor, { kind: 'system' });
    assert.equal(record?.reason, 'account deleted');
    assert.deepEqual(await lifecycle.userDeleted('carl', system('again')), {
      removedFrom: [],
      ownerOf: [],
    });
    assert.deepEqual(await lifecycle.userDeleted('', system('blank')), {
      removedFrom: [],
      ownerOf: [],
    });
    assert.equal(await rejectedCode(lifecycle.userDeleted('carl', user('alice'))), 'not_permitted');
  });
});

describe('audit privacy', () => {
  it('never writes an email address into the audit trail', async () => {
    const fixture = lifecycleFixture({ deletionRetentionMs: 0 });
    const { lifecycle, store, clock } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'admin' });
    const sent = await lifecycle.invite(tenant.id, { email: emailOf('c') }, user('bob'));
    await lifecycle.revokeInvitation(tenant.id, sent.invitation.id, user('bob'));
    const expiring = await lifecycle.invite(tenant.id, { email: emailOf('d') }, user('bob'));
    clock.advance(8 * DAY);
    await rejectedCode(lifecycle.acceptInvitation(expiring.token, accept('d')));
    await join(fixture, tenant, 'e', 'member');
    await lifecycle.scheduleDeletion(tenant.id, user('alice'));
    await lifecycle.purge(tenant.id, system(), async () => undefined);
    const trail = await auditTrail(store, tenant.id);
    assert.ok(trail.length > 8);
    for (const record of trail) {
      assert.ok(!JSON.stringify(record).includes('@'), record.action);
    }
  });
});
