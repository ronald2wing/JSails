/**
 * Concurrency tests for the lifecycle against the interleaving memory store.
 * Every in-transaction statement yields to the event loop, so concurrent
 * operations really interleave, and the tenant lock is what keeps each
 * invariant: one membership from parallel accepts of a token, one winner for
 * a slug, serialised transfers with one owner, seats never exceeded by
 * parallel invites or accepts, one verified tenant per hostname, and a
 * consistent outcome when a removal races a role change or a transfer races
 * a leave.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  emailOf,
  lifecycleFixture,
  system,
  tenantWith,
  user,
  type FixtureOptions,
  type LifecycleFixture,
} from './lifecycle-fixture.js';

function interleaved(options: FixtureOptions = {}): LifecycleFixture {
  return lifecycleFixture(options, {
    onStatement: (event) =>
      event.inTransaction ? new Promise((resolve) => setImmediate(resolve)) : undefined,
  });
}

function codesOf(results: readonly PromiseSettledResult<unknown>[]): string[] {
  return results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => {
      const reason: unknown = result.reason;
      return typeof reason === 'object' && reason !== null && 'code' in reason
        ? String(reason.code)
        : String(reason);
    })
    .sort();
}

const fulfilled = (results: readonly PromiseSettledResult<unknown>[]): number =>
  results.filter((result) => result.status === 'fulfilled').length;

describe('lifecycle concurrency', () => {
  it('admits exactly one user from parallel accepts of one token', async () => {
    const { lifecycle, store } = interleaved();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const shared = emailOf('shared');
    const { token } = await lifecycle.invite(tenant.id, { email: shared }, user('alice'));
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        lifecycle.acceptInvitation(token, {
          userId: `u${index}`,
          email: shared,
          emailVerified: true,
        }),
      ),
    );
    assert.equal(fulfilled(results), 1);
    assert.deepEqual(
      codesOf(results),
      Array.from({ length: 5 }, () => 'invalid_invitation'),
    );
    assert.equal(await store.countMembers(tenant.id), 2);
  });

  it('gives one slug to exactly one of parallel creates', async () => {
    const { lifecycle } = interleaved();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        lifecycle.create({ name: `Acme ${index}`, slug: 'acme' }, user(`u${index}`)),
      ),
    );
    assert.equal(fulfilled(results), 1);
    assert.deepEqual(
      codesOf(results),
      Array.from({ length: 5 }, () => 'slug_taken'),
    );
  });

  it('serialises parallel transfers and keeps exactly one owner', async () => {
    const fixture = interleaved();
    const { lifecycle, store } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', {
      b: 'member',
      c: 'member',
      d: 'viewer',
    });
    const bySystem = await Promise.allSettled(
      ['b', 'c', 'd'].map((to) => lifecycle.transferOwnership(tenant.id, to, system())),
    );
    assert.equal(fulfilled(bySystem), 3);
    const after = await store.tenantById(tenant.id);
    const members = (await store.members(tenant.id, { limit: 10 })).items;
    const owners = members.filter((member) => member.role === 'owner');
    assert.equal(owners.length, 1);
    assert.equal(owners[0]?.userId, after?.ownerUserId);

    const owner = after?.ownerUserId ?? '';
    const others = members.map((member) => member.userId).filter((id) => id !== owner);
    const byOwner = await Promise.allSettled(
      others.map((to) => lifecycle.transferOwnership(tenant.id, to, user(owner))),
    );
    assert.equal(fulfilled(byOwner), 1);
    assert.deepEqual(
      codesOf(byOwner),
      others.slice(1).map(() => 'not_permitted'),
    );
  });

  it('never lets parallel invites exceed the seats', async () => {
    const { lifecycle, store, clock } = interleaved({ limits: () => ({ seats: 4 }) });
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        lifecycle.invite(tenant.id, { email: emailOf(`u${index}`) }, user('alice')),
      ),
    );
    assert.equal(fulfilled(results), 3);
    assert.equal(
      (await store.countMembers(tenant.id)) +
        (await store.countOpenInvitations(tenant.id, clock.now())),
      4,
    );
  });

  it('never lets parallel accepts exceed the seats', async () => {
    let seats = 10;
    const { lifecycle, store } = interleaved({ limits: () => ({ seats }) });
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const tokens = [];
    for (let index = 0; index < 8; index += 1) {
      tokens.push(
        (await lifecycle.invite(tenant.id, { email: emailOf(`u${index}`) }, user('alice'))).token,
      );
    }
    seats = 4;
    const results = await Promise.allSettled(
      tokens.map((token, index) =>
        lifecycle.acceptInvitation(token, {
          userId: `u${index}`,
          email: emailOf(`u${index}`),
          emailVerified: true,
        }),
      ),
    );
    assert.equal(fulfilled(results), 3);
    assert.equal(await store.countMembers(tenant.id), 4);
  });

  it('verifies a hostname for exactly one of two tenants checking at once', async () => {
    const { lifecycle, store, dns } = interleaved();
    const host = 'shop.acme-corp.io';
    const acme = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const beta = await lifecycle.create({ name: 'Beta', slug: 'beta' }, user('bob'));
    const one = await lifecycle.addDomain(acme.id, host, user('alice'));
    const two = await lifecycle.addDomain(beta.id, host, user('bob'));
    dns.answer(`_jsails-challenge.${host}`, [
      [`token=${one.claim.token}`],
      [`token=${two.claim.token}`],
    ]);
    const results = await Promise.allSettled([
      lifecycle.checkDomain(acme.id, host, user('alice')),
      lifecycle.checkDomain(beta.id, host, user('bob')),
    ]);
    const verified = results.filter(
      (result) => result.status === 'fulfilled' && result.value.action === 'verified',
    );
    assert.equal(verified.length, 1);
    const claims = await store.domainClaimsOfHostname(host);
    assert.equal(claims.filter((claim) => claim.verifiedHostname !== null).length, 1);
  });

  it('settles a removal racing a role change consistently', async () => {
    const fixture = interleaved();
    const { lifecycle, store } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'member' });
    const results = await Promise.allSettled([
      lifecycle.changeRole(tenant.id, 'bob', 'viewer', user('alice')),
      lifecycle.removeMember(tenant.id, 'bob', user('alice')),
    ]);
    assert.equal(results[1]?.status, 'fulfilled');
    assert.equal(await store.membership(tenant.id, 'bob'), null);
    if (results[0]?.status === 'rejected') {
      assert.deepEqual(codesOf(results), ['not_member']);
    }
  });

  it('settles a transfer racing a leave with one owner either way', async () => {
    const fixture = interleaved();
    const { lifecycle, store } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', { bob: 'member' });
    const results = await Promise.allSettled([
      lifecycle.transferOwnership(tenant.id, 'bob', user('alice')),
      lifecycle.leave(tenant.id, user('bob')),
    ]);
    assert.equal(fulfilled(results), 1);
    const after = await store.tenantById(tenant.id);
    const owners = (await store.members(tenant.id, { limit: 10 })).items.filter(
      (member) => member.role === 'owner',
    );
    assert.equal(owners.length, 1);
    assert.equal(owners[0]?.userId, after?.ownerUserId);
    assert.ok(['not_member', 'owner_required'].includes(codesOf(results)[0] ?? ''));
  });
});
