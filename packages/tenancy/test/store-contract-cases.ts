/**
 * The tenancy store contract, as plain case objects.
 *
 * Each case receives a fresh, empty store and checks one rule of the port
 * (see `src/tenancy-store.ts`): the owner invariant, unique-violation codes,
 * the poisoned-transaction rule, rollback and after-commit behaviour, read
 * committed visibility, the version check, `lockTenant` serialisation, keyset
 * paging under concurrent inserts, cascades, domain-claim uniqueness,
 * operator grants and input refusal. Every implementation of the port runs
 * the same list; the memory store runs it now through a local loop.
 */

import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { issueDomainToken } from '../src/domain-verification.js';
import { issueInvitationToken } from '../src/invitation-token.js';
import type { Page } from '../src/tenancy-page.js';
import type { NewTenant, TenantSummary } from '../src/tenancy-records.js';
import type { TenancyStore, TenancyTx } from '../src/tenancy-store.js';
import type { TenantId } from '../src/tenant-id.js';
import { rejectedCode, thrownCode } from './thrown-code.js';

/** One contract case. */
export interface StoreContractCase {
  readonly name: string;
  run(store: TenancyStore): Promise<void>;
}

const T0 = Date.parse('2026-03-01T00:00:00.000Z');

/** A fixed instant `minutes` after the contract's epoch. */
export function at(minutes: number): Date {
  return new Date(T0 + minutes * 60_000);
}

function newTenant(slug: string, owner: string): NewTenant {
  return {
    slug,
    name: `Tenant ${slug}`,
    plan: null,
    ownerUserId: owner,
    settings: '{}',
    createdAt: at(0),
  };
}

async function insertOwned(tx: TenancyTx, slug: string, owner: string): Promise<TenantSummary> {
  const tenant = await tx.insertTenant(newTenant(slug, owner));
  await tx.insertMembership({
    tenantId: tenant.id,
    userId: owner,
    role: 'owner',
    invitedBy: null,
    createdAt: at(0),
  });
  return tenant;
}

/** Create a tenant with its owner membership. */
export function createTenant(
  store: TenancyStore,
  slug: string,
  owner = 'owner-1',
): Promise<TenantSummary> {
  return store.transaction((tx) => insertOwned(tx, slug, owner));
}

async function addMember(
  store: TenancyStore,
  tenantId: TenantId,
  userId: string,
  role = 'member',
): Promise<void> {
  await store.transaction(async (tx) => {
    await tx.insertMembership({ tenantId, userId, role, invitedBy: null, createdAt: at(1) });
  });
}

interface Gate {
  readonly wait: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/**
 * A lifecycle-shaped join: count the members, refuse when the seats are
 * full, insert. With `lock`, it takes the tenant lock first, as the lifecycle
 * must.
 */
export function seatLimitedJoin(
  store: TenancyStore,
  tenantId: TenantId,
  userId: string,
  seats: number,
  lock: boolean,
): Promise<void> {
  return store.transaction(async (tx) => {
    if (lock) {
      await tx.lockTenant(tenantId);
    }
    if ((await tx.countMembers(tenantId)) >= seats) {
      throw new Error('seats full');
    }
    await tx.insertMembership({
      tenantId,
      userId,
      role: 'member',
      invitedBy: null,
      createdAt: at(2),
    });
  });
}

async function collect<T>(
  fetch: (after: string | undefined) => Promise<Page<T>>,
  between: (pageIndex: number) => Promise<void> = async () => undefined,
): Promise<T[]> {
  const items: T[] = [];
  let after: string | undefined;
  for (let index = 0; index < 1000; index += 1) {
    const page = await fetch(after);
    assert.ok(Object.isFrozen(page) && Object.isFrozen(page.items));
    items.push(...page.items);
    if (page.next === null) {
      return items;
    }
    after = page.next;
    await between(index);
  }
  assert.fail('paging did not end');
}

function fulfilled(results: readonly PromiseSettledResult<unknown>[]): number {
  return results.filter((result) => result.status === 'fulfilled').length;
}

function rejectionCodes(results: readonly PromiseSettledResult<unknown>[]): unknown[] {
  return results.flatMap((result) => {
    if (result.status === 'fulfilled') {
      return [];
    }
    const reason: unknown = result.reason;
    return [
      typeof reason === 'object' && reason !== null && 'code' in reason ? reason.code : reason,
    ];
  });
}

/** Every contract case. */
export const STORE_CONTRACT_CASES: readonly StoreContractCase[] = Object.freeze([
  {
    name: 'insertTenant gives a frozen active summary at version 1 with copied dates',
    async run(store) {
      const tenant = await createTenant(store, 'acme', 'alice');
      assert.ok(Object.isFrozen(tenant));
      assert.equal(tenant.status, 'active');
      assert.equal(tenant.version, 1);
      assert.equal(tenant.ownerUserId, 'alice');
      assert.equal(tenant.plan, null);
      assert.equal(tenant.suspendedAt, null);
      assert.equal(tenant.suspensionReason, null);
      assert.equal(tenant.deletionDueAt, null);
      assert.equal(tenant.updatedAt.getTime(), at(0).getTime());
      tenant.createdAt.setTime(0);
      const again = await store.tenantById(tenant.id);
      assert.equal(again?.createdAt.getTime(), at(0).getTime());
      assert.equal((await store.tenantBySlug('acme'))?.id, tenant.id);
      assert.equal(await store.tenantBySlug('ACME'), null);
      assert.equal(await store.tenantById(tenant.id + 1000), null);
      assert.equal(await store.tenantSettings(tenant.id), '{}');
      assert.equal(await store.tenantSettings(tenant.id + 1000), null);
      const membership = await store.membership(tenant.id, 'alice');
      assert.ok(membership !== null && Object.isFrozen(membership));
      assert.equal(membership.role, 'owner');
    },
  },
  {
    name: 'a commit needs exactly one owner membership matching the tenant row',
    async run(store) {
      assert.equal(
        await rejectedCode(store.transaction((tx) => tx.insertTenant(newTenant('lonely', 'a')))),
        'owner_required',
      );
      assert.equal(await store.tenantBySlug('lonely'), null);
      assert.equal(
        await rejectedCode(
          store.transaction(async (tx) => {
            const tenant = await tx.insertTenant(newTenant('mismatch', 'a'));
            await tx.insertMembership({
              tenantId: tenant.id,
              userId: 'b',
              role: 'owner',
              invitedBy: null,
              createdAt: at(0),
            });
          }),
        ),
        'owner_required',
      );
      const tenant = await createTenant(store, 'acme', 'alice');
      assert.equal(
        await rejectedCode(
          store.transaction(async (tx) => {
            await tx.insertMembership({
              tenantId: tenant.id,
              userId: 'second',
              role: 'owner',
              invitedBy: null,
              createdAt: at(1),
            });
          }),
        ),
        'owner_required',
      );
      assert.equal(
        await rejectedCode(
          store.transaction(async (tx) => {
            await tx.deleteMembership(tenant.id, 'alice');
          }),
        ),
        'owner_required',
      );
      assert.equal(await store.countMembers(tenant.id), 1);
      assert.equal((await store.membership(tenant.id, 'alice'))?.role, 'owner');
    },
  },
  {
    name: 'ownership moves only when the memberships and the row change together',
    async run(store) {
      const tenant = await createTenant(store, 'acme', 'alice');
      await addMember(store, tenant.id, 'bob', 'admin');
      assert.equal(
        await rejectedCode(
          store.transaction(async (tx) => {
            await tx.updateMembershipRole(tenant.id, 'alice', 'admin');
            await tx.updateMembershipRole(tenant.id, 'bob', 'owner');
          }),
        ),
        'owner_required',
      );
      assert.equal((await store.membership(tenant.id, 'alice'))?.role, 'owner');
      const moved = await store.transaction(async (tx) => {
        const locked = await tx.lockTenant(tenant.id);
        assert.ok(locked !== null);
        await tx.updateMembershipRole(tenant.id, 'alice', 'admin');
        await tx.updateMembershipRole(tenant.id, 'bob', 'owner');
        return tx.updateTenant(tenant.id, locked.version, { ownerUserId: 'bob', updatedAt: at(5) });
      });
      assert.equal(moved.ownerUserId, 'bob');
      assert.equal(moved.version, 2);
      assert.equal((await store.membership(tenant.id, 'alice'))?.role, 'admin');
      assert.equal((await store.membership(tenant.id, 'bob'))?.role, 'owner');
      assert.equal(
        await store.transaction((tx) => tx.updateMembershipRole(tenant.id, 'nobody', 'admin')),
        null,
      );
    },
  },
  {
    name: 'unique violations and missing parents map to codes',
    async run(store) {
      const tenant = await createTenant(store, 'acme', 'alice');
      assert.equal(await rejectedCode(createTenant(store, 'acme', 'bob')), 'slug_taken');
      assert.equal(
        await rejectedCode(
          store.transaction(async (tx) => {
            await insertOwned(tx, 'twice', 'a');
            await insertOwned(tx, 'twice', 'b');
          }),
        ),
        'slug_taken',
      );
      assert.equal(await rejectedCode(addMember(store, tenant.id, 'alice')), 'already_member');
      assert.equal(await rejectedCode(addMember(store, tenant.id + 1000, 'x')), 'not_found');
      const claim = {
        hostname: 'shop.bigcorp.io',
        token: issueDomainToken(),
        expiresAt: at(60),
        createdAt: at(0),
      };
      await store.transaction((tx) => tx.insertDomainClaim({ tenantId: tenant.id, ...claim }));
      assert.equal(
        await rejectedCode(
          store.transaction((tx) => tx.insertDomainClaim({ tenantId: tenant.id, ...claim })),
        ),
        'domain_claimed',
      );
      assert.equal(
        await rejectedCode(
          store.transaction((tx) => tx.insertDomainClaim({ tenantId: tenant.id + 1000, ...claim })),
        ),
        'not_found',
      );
      const token = issueInvitationToken();
      assert.equal(
        await rejectedCode(
          store.transaction((tx) =>
            tx.putInvitation({
              tenantId: tenant.id + 1000,
              email: 'guest@bigcorp.io',
              role: 'member',
              invitedBy: 'alice',
              tokenHash: token.hash,
              expiresAt: at(60),
              createdAt: at(0),
            }),
          ),
        ),
        'not_found',
      );
      assert.equal(
        await rejectedCode(
          store.transaction((tx) =>
            tx.insertOperatorGrant({
              tenantId: tenant.id + 1000,
              operatorId: 'op',
              reason: 'support ticket',
              write: false,
              openedAt: at(0),
              expiresAt: at(30),
            }),
          ),
        ),
        'not_found',
      );
    },
  },
  {
    name: 'parallel creates of one slug have exactly one winner',
    async run(store) {
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, index) => createTenant(store, 'race', `user-${index}`)),
      );
      assert.equal(fulfilled(results), 1);
      assert.deepEqual(
        rejectionCodes(results),
        Array.from({ length: 7 }, () => 'slug_taken'),
      );
    },
  },
  {
    name: 'a failed call poisons the transaction even when the body catches it',
    async run(store) {
      await createTenant(store, 'taken', 'alice');
      let callbackRan = false;
      let later: unknown;
      let lateCallback: unknown;
      const code = await rejectedCode(
        store.transaction(async (tx) => {
          await insertOwned(tx, 'fresh', 'bob');
          tx.afterCommit(() => {
            callbackRan = true;
          });
          await tx.insertTenant(newTenant('taken', 'carol')).catch(() => undefined);
          later = await rejectedCode(tx.tenantBySlug('fresh'));
          lateCallback = thrownCode(() => tx.afterCommit(() => undefined));
          return 'swallowed';
        }),
      );
      assert.equal(code, 'slug_taken');
      assert.equal(later, 'transaction_aborted');
      assert.equal(lateCallback, 'transaction_aborted');
      assert.equal(callbackRan, false);
      assert.equal(await store.tenantBySlug('fresh'), null);
    },
  },
  {
    name: 'a rollback discards the writes and the after-commit callbacks',
    async run(store) {
      let ran = false;
      await assert.rejects(
        store.transaction(async (tx) => {
          await insertOwned(tx, 'doomed', 'alice');
          tx.afterCommit(() => {
            ran = true;
          });
          throw new Error('boom');
        }),
        /boom/,
      );
      assert.equal(ran, false);
      assert.equal(await store.tenantBySlug('doomed'), null);
      assert.equal((await store.membershipsOfUser('alice', { limit: 10 })).items.length, 0);
      const tenant = await createTenant(store, 'doomed', 'alice');
      assert.equal(tenant.slug, 'doomed');
    },
  },
  {
    name: 'after-commit callbacks run in order, only once the commit is visible',
    async run(store) {
      const seen: string[] = [];
      let visible: Promise<TenantSummary | null> | undefined;
      await store.transaction(async (tx) => {
        await insertOwned(tx, 'ordered', 'alice');
        tx.afterCommit(() => {
          seen.push('first');
          visible = store.tenantBySlug('ordered');
        });
        tx.afterCommit(() => {
          seen.push('second');
        });
        assert.deepEqual(seen, []);
      });
      assert.deepEqual(seen, ['first', 'second']);
      assert.ok(visible !== undefined);
      assert.equal((await visible)?.slug, 'ordered');
    },
  },
  {
    name: 'a transaction cannot be used after it ends',
    async run(store) {
      let leaked: TenancyTx | undefined;
      await store.transaction(async (tx) => {
        leaked = tx;
      });
      assert.ok(leaked !== undefined);
      const ended = leaked;
      assert.equal(await rejectedCode(ended.tenantById(1)), 'transaction_closed');
      assert.equal(await rejectedCode(ended.lockTenant(1)), 'transaction_closed');
      assert.equal(
        thrownCode(() => ended.afterCommit(() => undefined)),
        'transaction_closed',
      );
    },
  },
  {
    name: 'uncommitted writes are visible to their transaction only',
    async run(store) {
      const inside = gate();
      const release = gate();
      const pending = store.transaction(async (tx) => {
        const tenant = await insertOwned(tx, 'hidden', 'alice');
        assert.equal((await tx.tenantBySlug('hidden'))?.id, tenant.id);
        assert.equal(await tx.countMembers(tenant.id), 1);
        inside.open();
        await release.wait;
      });
      await inside.wait;
      assert.equal(await store.tenantBySlug('hidden'), null);
      assert.equal(await store.transaction((tx) => tx.tenantBySlug('hidden')), null);
      release.open();
      await pending;
      assert.equal((await store.tenantBySlug('hidden'))?.slug, 'hidden');
    },
  },
  {
    name: 'updateTenant applies a patch only at the expected version',
    async run(store) {
      const tenant = await createTenant(store, 'acme', 'alice');
      const renamed = await store.transaction((tx) =>
        tx.updateTenant(tenant.id, 1, {
          name: 'Acme Inc',
          plan: 'pro',
          status: 'suspended',
          suspendedAt: at(3),
          suspensionReason: 'billing',
          deletionDueAt: at(9),
          settings: '{"theme":"dark"}',
          updatedAt: at(3),
        }),
      );
      assert.equal(renamed.version, 2);
      assert.equal(renamed.name, 'Acme Inc');
      assert.equal(renamed.plan, 'pro');
      assert.equal(renamed.status, 'suspended');
      assert.equal(renamed.suspendedAt?.getTime(), at(3).getTime());
      assert.equal(renamed.suspensionReason, 'billing');
      assert.equal(renamed.deletionDueAt?.getTime(), at(9).getTime());
      assert.equal(renamed.updatedAt.getTime(), at(3).getTime());
      assert.equal(renamed.slug, 'acme');
      assert.equal(await store.tenantSettings(tenant.id), '{"theme":"dark"}');
      assert.equal(
        await rejectedCode(
          store.transaction((tx) =>
            tx.updateTenant(tenant.id, 1, { name: 'Late', updatedAt: at(4) }),
          ),
        ),
        'stale_tenant',
      );
      assert.equal(
        await rejectedCode(
          store.transaction((tx) => tx.updateTenant(tenant.id + 1000, 1, { updatedAt: at(4) })),
        ),
        'not_found',
      );
      const results = await Promise.allSettled(
        ['One', 'Two'].map((name) =>
          store.transaction((tx) => tx.updateTenant(tenant.id, 2, { name, updatedAt: at(5) })),
        ),
      );
      assert.equal(fulfilled(results), 1);
      assert.deepEqual(rejectionCodes(results), ['stale_tenant']);
      assert.equal((await store.tenantById(tenant.id))?.version, 3);
    },
  },
  {
    name: 'lockTenant holds the tenant until the transaction ends',
    async run(store) {
      const tenant = await createTenant(store, 'acme', 'alice');
      const locked = gate();
      const release = gate();
      const order: string[] = [];
      const first = store.transaction(async (tx) => {
        await tx.lockTenant(tenant.id);
        locked.open();
        await release.wait;
        await tx.updateTenant(tenant.id, 1, { name: 'First', updatedAt: at(1) });
        order.push('first');
      });
      await locked.wait;
      const second = store.transaction(async (tx) => {
        const seen = await tx.lockTenant(tenant.id);
        order.push('second');
        return seen;
      });
      await delay(20);
      assert.deepEqual(order, []);
      release.open();
      const seen = await second;
      await first;
      assert.deepEqual(order, ['first', 'second']);
      assert.equal(seen?.name, 'First');
      assert.equal(seen?.version, 2);
      assert.equal(await store.transaction((tx) => tx.lockTenant(tenant.id + 1000)), null);
    },
  },
  {
    name: 'a seat check under lockTenant never over-admits',
    async run(store) {
      const tenant = await createTenant(store, 'acme', 'alice');
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, index) =>
          seatLimitedJoin(store, tenant.id, `user-${index}`, 4, true),
        ),
      );
      assert.equal(fulfilled(results), 3);
      assert.equal(await store.countMembers(tenant.id), 4);
    },
  },
  {
    name: 'parallel accepts of one invitation give exactly one membership',
    async run(store) {
      const tenant = await createTenant(store, 'acme', 'alice');
      const token = issueInvitationToken();
      await store.transaction((tx) =>
        tx.putInvitation({
          tenantId: tenant.id,
          email: 'guest@bigcorp.io',
          role: 'member',
          invitedBy: 'alice',
          tokenHash: token.hash,
          expiresAt: at(60),
          createdAt: at(0),
        }),
      );
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, index) =>
          store.transaction(async (tx) => {
            const invitation = await tx.invitationByTokenHash(token.hash);
            if (invitation === null || !(await tx.deleteInvitation(invitation.id))) {
              throw new Error('invitation used');
            }
            await tx.insertMembership({
              tenantId: tenant.id,
              userId: `guest-${index}`,
              role: invitation.role,
              invitedBy: invitation.invitedBy,
              createdAt: at(1),
            });
          }),
        ),
      );
      assert.equal(fulfilled(results), 1);
      assert.equal(await store.countMembers(tenant.id), 2);
      assert.equal(await store.invitationByTokenHash(token.hash), null);
    },
  },
  {
    name: 'keyset pages stay stable under concurrent inserts',
    async run(store) {
      const tenant = await createTenant(store, 'acme', 'm-15');
      const original = ['m-15'];
      for (let index = 3; index <= 30; index += 3) {
        const userId = `m-${String(index).padStart(2, '0')}`;
        if (userId !== 'm-15') {
          await addMember(store, tenant.id, userId);
          original.push(userId);
        }
      }
      const inserted = ['m-00', 'm-99', 'm-10', 'm-31'];
      const seen = await collect(
        async (after) =>
          store.members(tenant.id, { limit: 3, ...(after === undefined ? {} : { after }) }),
        async (index) => {
          const userId = inserted[index];
          if (userId !== undefined) {
            await addMember(store, tenant.id, userId);
          }
        },
      );
      const ids = seen.map((member) => member.userId);
      assert.deepEqual(ids, [...new Set(ids)].sort());
      for (const userId of original) {
        assert.equal(ids.filter((id) => id === userId).length, 1, userId);
      }
      assert.ok(!ids.includes('m-00'));
      assert.ok(ids.includes('m-99'));
    },
  },
  {
    name: 'every listing pages to the end in its order',
    async run(store) {
      const tenants: TenantSummary[] = [];
      for (const slug of ['alpha', 'bravo', 'charlie']) {
        const tenant = await createTenant(store, slug, `owner-${slug}`);
        await addMember(store, tenant.id, 'shared');
        tenants.push(tenant);
      }
      const ofUser = await collect((after) =>
        store.membershipsOfUser('shared', { limit: 2, ...(after === undefined ? {} : { after }) }),
      );
      assert.deepEqual(
        ofUser.map((row) => row.tenant.slug),
        ['alpha', 'bravo', 'charlie'],
      );
      assert.ok(ofUser.every((row) => Object.isFrozen(row) && Object.isFrozen(row.tenant)));
      const first = tenants[0];
      assert.ok(first !== undefined);
      for (let index = 0; index < 5; index += 1) {
        await store.transaction((tx) =>
          tx.putInvitation({
            tenantId: first.id,
            email: `guest-${index}@bigcorp.io`,
            role: 'member',
            invitedBy: 'owner-alpha',
            tokenHash: issueInvitationToken().hash,
            expiresAt: at(60),
            createdAt: at(index),
          }),
        );
      }
      const invitations = await collect((after) =>
        store.invitations(first.id, { limit: 2, ...(after === undefined ? {} : { after }) }),
      );
      assert.deepEqual(
        invitations.map((row) => row.email),
        [0, 1, 2, 3, 4].map((index) => `guest-${index}@bigcorp.io`),
      );
      const exact = await store.invitations(first.id, { limit: 5 });
      assert.equal(exact.items.length, 5);
      assert.equal(exact.next, null);
    },
  },
  {
    name: 'page requests are validated',
    async run(store) {
      const tenant = await createTenant(store, 'acme', 'alice');
      await addMember(store, tenant.id, 'bob');
      const page = await store.members(tenant.id, { limit: 1 });
      assert.ok(page.next !== null);
      const cursor = page.next;
      for (const limit of [0, 201, 1.5, Number.NaN]) {
        assert.equal(
          await rejectedCode(store.members(tenant.id, { limit })),
          'invalid_page_request',
        );
      }
      for (const after of [
        '',
        'not a cursor',
        `${cursor}A`,
        Buffer.from('["members",""]').toString('base64url'),
      ]) {
        assert.equal(
          await rejectedCode(store.members(tenant.id, { limit: 1, after })),
          'invalid_page_request',
          after,
        );
      }
      assert.equal(
        await rejectedCode(store.invitations(tenant.id, { limit: 1, after: cursor })),
        'invalid_page_request',
      );
      const next = await store.members(tenant.id, { limit: 1, after: cursor });
      assert.deepEqual(
        next.items.map((member) => member.userId),
        ['bob'],
      );
    },
  },
  {
    name: 'the audit trail is newest first, countable, prunable and outlives its tenant',
    async run(store) {
      const tenant = await createTenant(store, 'acme', 'alice');
      const actions = [
        'tenant.created',
        'member.invited',
        'member.invited',
        'member.joined',
      ] as const;
      for (const [index, action] of actions.entries()) {
        const record = await store.transaction((tx) =>
          tx.appendAudit({
            tenantId: tenant.id,
            at: at(index),
            actor: index === 0 ? { kind: 'system' } : { kind: 'user', id: 'alice' },
            action,
            target: index === 0 ? null : `invitation:${index}`,
            reason: null,
            traceId: index === 3 ? 'trace-1' : null,
          }),
        );
        assert.ok(Object.isFrozen(record) && Object.isFrozen(record.actor));
      }
      const records = await collect((after) =>
        store.audit(tenant.id, { limit: 3, ...(after === undefined ? {} : { after }) }),
      );
      assert.deepEqual(
        records.map((record) => record.action),
        [...actions].reverse(),
      );
      assert.deepEqual(records.at(-1)?.actor, { kind: 'system' });
      assert.equal(records[0]?.traceId, 'trace-1');
      assert.equal(await store.countAudit(tenant.id, 'member.invited', at(0)), 2);
      assert.equal(await store.countAudit(tenant.id, 'member.invited', at(2)), 1);
      assert.equal(await store.transaction((tx) => tx.deleteAuditBefore(at(2), 1)), 1);
      assert.equal(await store.transaction((tx) => tx.deleteAuditBefore(at(2), 10)), 1);
      await store.transaction(async (tx) => {
        await tx.updateTenant(tenant.id, 1, { status: 'purging', updatedAt: at(5) });
        assert.equal(await tx.deleteTenant(tenant.id), true);
      });
      const kept = await store.audit(tenant.id, { limit: 10 });
      assert.deepEqual(
        kept.items.map((record) => record.action),
        ['member.joined', 'member.invited'],
      );
    },
  },
  {
    name: 'deleting a tenant removes its memberships, invitations, claims and grants',
    async run(store) {
      const tenant = await createTenant(store, 'acme', 'alice');
      const other = await createTenant(store, 'other', 'olga');
      await addMember(store, tenant.id, 'bob');
      await addMember(store, other.id, 'bob');
      const token = issueInvitationToken();
      const grant = await store.transaction(async (tx) => {
        await tx.putInvitation({
          tenantId: tenant.id,
          email: 'guest@bigcorp.io',
          role: 'member',
          invitedBy: 'alice',
          tokenHash: token.hash,
          expiresAt: at(60),
          createdAt: at(0),
        });
        await tx.insertDomainClaim({
          tenantId: tenant.id,
          hostname: 'shop.bigcorp.io',
          token: issueDomainToken(),
          expiresAt: at(60),
          createdAt: at(0),
        });
        await tx.updateDomainClaim(tenant.id, 'shop.bigcorp.io', {
          verifiedAt: at(1),
          expiresAt: null,
        });
        return tx.insertOperatorGrant({
          tenantId: tenant.id,
          operatorId: 'op',
          reason: 'support ticket',
          write: false,
          openedAt: at(0),
          expiresAt: at(30),
        });
      });
      assert.equal(await store.transaction((tx) => tx.deleteTenant(tenant.id)), true);
      assert.equal(await store.transaction((tx) => tx.deleteTenant(tenant.id)), false);
      assert.equal(await store.tenantById(tenant.id), null);
      assert.equal(await store.membership(tenant.id, 'bob'), null);
      assert.deepEqual(
        (await store.membershipsOfUser('bob', { limit: 10 })).items.map((row) => row.tenantId),
        [other.id],
      );
      assert.equal(await store.invitationByTokenHash(token.hash), null);
      assert.deepEqual(await store.domainClaims(tenant.id), []);
      assert.equal(await store.tenantByVerifiedHostname('shop.bigcorp.io'), null);
      assert.equal(await store.operatorGrant(grant.id), null);
      const reborn = await createTenant(store, 'acme', 'carol');
      await store.transaction((tx) =>
        tx.insertDomainClaim({
          tenantId: reborn.id,
          hostname: 'shop.bigcorp.io',
          token: issueDomainToken(),
          expiresAt: at(60),
          createdAt: at(0),
        }),
      );
      const verified = await store.transaction((tx) =>
        tx.updateDomainClaim(reborn.id, 'shop.bigcorp.io', { verifiedAt: at(2), expiresAt: null }),
      );
      assert.equal(verified?.verifiedHostname, 'shop.bigcorp.io');
    },
  },
  {
    name: 'a removed member keeps no membership and no open operator grant',
    async run(store) {
      const tenant = await createTenant(store, 'acme', 'alice');
      await addMember(store, tenant.id, 'bob', 'admin');
      await store.transaction((tx) =>
        tx.insertOperatorGrant({
          tenantId: tenant.id,
          operatorId: 'bob',
          reason: 'support ticket',
          write: true,
          openedAt: at(0),
          expiresAt: at(30),
        }),
      );
      await store.transaction(async (tx) => {
        assert.equal(await tx.deleteMembership(tenant.id, 'bob'), true);
        assert.equal(await tx.deleteMembership(tenant.id, 'bob'), false);
        assert.equal(await tx.closeOperatorGrants(tenant.id, 'bob', at(1)), 1);
      });
      assert.equal(await store.membership(tenant.id, 'bob'), null);
      assert.equal(await store.activeOperatorGrant(tenant.id, 'bob', at(2)), null);
      assert.deepEqual((await store.membershipsOfUser('bob', { limit: 10 })).items, []);
    },
  },
  {
    name: 'putting an invitation replaces the open one for the same address',
    async run(store) {
      const tenant = await createTenant(store, 'acme', 'alice');
      const firstToken = issueInvitationToken();
      const secondToken = issueInvitationToken();
      const hash = new Uint8Array(firstToken.hash);
      const invite = (tokenHash: Uint8Array, role: string, minutes: number) =>
        store.transaction((tx) =>
          tx.putInvitation({
            tenantId: tenant.id,
            email: 'guest@bigcorp.io',
            role,
            invitedBy: 'alice',
            tokenHash,
            expiresAt: at(minutes + 60),
            createdAt: at(minutes),
          }),
        );
      const first = await invite(hash, 'member', 0);
      hash.fill(0);
      assert.equal(first.replaced, null);
      assert.ok(Object.isFrozen(first) && Object.isFrozen(first.invitation));
      assert.equal((await store.invitationByTokenHash(firstToken.hash))?.id, first.invitation.id);
      const second = await invite(secondToken.hash, 'admin', 5);
      assert.equal(second.replaced?.id, first.invitation.id);
      assert.notEqual(second.invitation.id, first.invitation.id);
      assert.equal(await store.invitationByTokenHash(firstToken.hash), null);
      assert.equal(await store.invitation(first.invitation.id), null);
      assert.equal((await store.invitationByEmail(tenant.id, 'guest@bigcorp.io'))?.role, 'admin');
      assert.equal(await store.invitationByEmail(tenant.id, 'other@bigcorp.io'), null);
      assert.equal(await store.countOpenInvitations(tenant.id, at(10)), 1);
      assert.equal(await store.countOpenInvitations(tenant.id, at(65)), 0);
      assert.deepEqual(
        (await store.invitationsExpiredBefore(at(65), 10)).map((row) => row.id),
        [second.invitation.id],
      );
      assert.deepEqual(await store.invitationsExpiredBefore(at(64), 10), []);
      const other = await createTenant(store, 'other', 'olga');
      assert.equal(
        await rejectedCode(
          store.transaction((tx) =>
            tx.putInvitation({
              tenantId: other.id,
              email: 'someone@bigcorp.io',
              role: 'member',
              invitedBy: 'olga',
              tokenHash: secondToken.hash,
              expiresAt: at(60),
              createdAt: at(0),
            }),
          ),
        ),
        'transaction_conflict',
      );
      assert.equal(
        await store.transaction((tx) => tx.deleteInvitation(second.invitation.id)),
        true,
      );
      assert.equal(
        await store.transaction((tx) => tx.deleteInvitation(second.invitation.id)),
        false,
      );
    },
  },
  {
    name: 'pending claims coexist while a verified hostname is unique',
    async run(store) {
      const host = 'shop.bigcorp.io';
      const first = await createTenant(store, 'first', 'alice');
      const second = await createTenant(store, 'second', 'bob');
      for (const tenant of [first, second]) {
        const claim = await store.transaction((tx) =>
          tx.insertDomainClaim({
            tenantId: tenant.id,
            hostname: host,
            token: issueDomainToken(),
            expiresAt: at(60),
            createdAt: at(0),
          }),
        );
        assert.ok(Object.isFrozen(claim));
        assert.equal(claim.verifiedHostname, null);
        assert.equal(claim.primary, false);
        assert.equal(claim.failures, 0);
        assert.equal(claim.expiresAt?.getTime(), at(60).getTime());
      }
      const claims = await store.domainClaimsOfHostname(host);
      assert.deepEqual(
        claims.map((claim) => claim.tenantId),
        [first.id, second.id],
      );
      assert.notEqual(claims[0]?.token, claims[1]?.token);
      assert.equal(await store.tenantByVerifiedHostname(host), null);
      const verified = await store.transaction((tx) =>
        tx.updateDomainClaim(first.id, host, {
          verifiedAt: at(1),
          expiresAt: null,
          lastCheckedAt: at(1),
        }),
      );
      assert.equal(verified?.verifiedHostname, host);
      assert.equal(verified?.verifiedAt?.getTime(), at(1).getTime());
      assert.equal((await store.tenantByVerifiedHostname(host))?.id, first.id);
      assert.equal(
        await rejectedCode(
          store.transaction((tx) =>
            tx.updateDomainClaim(second.id, host, { verifiedAt: at(2), expiresAt: null }),
          ),
        ),
        'domain_taken',
      );
      const failing = await store.transaction((tx) =>
        tx.updateDomainClaim(first.id, host, {
          failures: 2,
          failingSince: at(3),
          lastCheckedAt: at(3),
        }),
      );
      assert.equal(failing?.verifiedHostname, host);
      assert.equal(failing?.failures, 2);
      assert.equal(
        await rejectedCode(
          store.transaction((tx) => tx.updateDomainClaim(first.id, host, { verifiedAt: null })),
        ),
        'invalid_store_input',
      );
      assert.equal(
        await store.transaction((tx) =>
          tx.updateDomainClaim(first.id, 'none.bigcorp.io', { failures: 1 }),
        ),
        null,
      );
      assert.equal(await store.transaction((tx) => tx.deleteDomainClaim(first.id, host)), true);
      assert.equal(await store.transaction((tx) => tx.deleteDomainClaim(first.id, host)), false);
      const taken = await store.transaction((tx) =>
        tx.updateDomainClaim(second.id, host, { verifiedAt: at(4), expiresAt: null }),
      );
      assert.equal(taken?.verifiedHostname, host);
      assert.equal((await store.tenantByVerifiedHostname(host))?.id, second.id);
    },
  },
  {
    name: 'concurrent verification of one hostname has exactly one winner',
    async run(store) {
      const host = 'shop.bigcorp.io';
      const tenants = [
        await createTenant(store, 'first', 'alice'),
        await createTenant(store, 'second', 'bob'),
        await createTenant(store, 'third', 'carol'),
      ];
      for (const tenant of tenants) {
        await store.transaction((tx) =>
          tx.insertDomainClaim({
            tenantId: tenant.id,
            hostname: host,
            token: issueDomainToken(),
            expiresAt: at(60),
            createdAt: at(0),
          }),
        );
      }
      const results = await Promise.allSettled(
        tenants.map((tenant) =>
          store.transaction((tx) =>
            tx.updateDomainClaim(tenant.id, host, { verifiedAt: at(1), expiresAt: null }),
          ),
        ),
      );
      assert.equal(fulfilled(results), 1);
      assert.deepEqual(rejectionCodes(results), ['domain_taken', 'domain_taken']);
      const verified = (await store.domainClaimsOfHostname(host)).filter(
        (claim) => claim.verifiedHostname !== null,
      );
      assert.equal(verified.length, 1);
    },
  },
  {
    name: 'a tenant has at most one primary domain, and only a verified one',
    async run(store) {
      const tenant = await createTenant(store, 'acme', 'alice');
      const hosts = ['shop.bigcorp.io', 'www.bigcorp.io', 'pending.bigcorp.io'];
      await store.transaction(async (tx) => {
        for (const hostname of hosts) {
          await tx.insertDomainClaim({
            tenantId: tenant.id,
            hostname,
            token: issueDomainToken(),
            expiresAt: at(60),
            createdAt: at(0),
          });
        }
        await tx.updateDomainClaim(tenant.id, 'shop.bigcorp.io', {
          verifiedAt: at(1),
          expiresAt: null,
        });
        await tx.updateDomainClaim(tenant.id, 'www.bigcorp.io', {
          verifiedAt: at(1),
          expiresAt: null,
        });
      });
      const primaries = async (): Promise<string[]> =>
        (await store.domainClaims(tenant.id))
          .filter((claim) => claim.primary)
          .map((claim) => claim.hostname);
      assert.equal(
        await rejectedCode(
          store.transaction((tx) => tx.setPrimaryDomain(tenant.id, 'pending.bigcorp.io')),
        ),
        'domain_unverified',
      );
      assert.equal(
        await store.transaction((tx) => tx.setPrimaryDomain(tenant.id, 'none.bigcorp.io')),
        false,
      );
      assert.equal(
        await store.transaction((tx) => tx.setPrimaryDomain(tenant.id + 1000, null)),
        false,
      );
      assert.equal(
        await store.transaction((tx) => tx.setPrimaryDomain(tenant.id, 'shop.bigcorp.io')),
        true,
      );
      assert.deepEqual(await primaries(), ['shop.bigcorp.io']);
      await store.transaction((tx) => tx.setPrimaryDomain(tenant.id, 'www.bigcorp.io'));
      assert.deepEqual(await primaries(), ['www.bigcorp.io']);
      const withdrawn = await store.transaction((tx) =>
        tx.updateDomainClaim(tenant.id, 'www.bigcorp.io', { verifiedAt: null, expiresAt: at(90) }),
      );
      assert.equal(withdrawn?.primary, false);
      assert.equal(withdrawn?.verifiedHostname, null);
      assert.deepEqual(await primaries(), []);
      await store.transaction((tx) => tx.setPrimaryDomain(tenant.id, 'shop.bigcorp.io'));
      await store.transaction((tx) => tx.setPrimaryDomain(tenant.id, null));
      assert.deepEqual(await primaries(), []);
      assert.deepEqual(
        (await store.domainClaims(tenant.id)).map((claim) => claim.hostname),
        ['pending.bigcorp.io', 'shop.bigcorp.io', 'www.bigcorp.io'],
      );
    },
  },
  {
    name: 'operator grants are time-boxed and closable',
    async run(store) {
      const tenant = await createTenant(store, 'acme', 'alice');
      const open = (operatorId: string, minutes: number) =>
        store.transaction((tx) =>
          tx.insertOperatorGrant({
            tenantId: tenant.id,
            operatorId,
            reason: 'support ticket',
            write: false,
            openedAt: at(0),
            expiresAt: at(minutes),
          }),
        );
      const grant = await open('op', 60);
      assert.ok(Object.isFrozen(grant));
      assert.equal(grant.closedAt, null);
      const longer = await open('op', 90);
      await open('other', 30);
      assert.equal((await store.activeOperatorGrant(tenant.id, 'op', at(30)))?.id, longer.id);
      assert.equal((await store.activeOperatorGrant(tenant.id, 'op', at(75)))?.id, longer.id);
      assert.equal(await store.activeOperatorGrant(tenant.id, 'op', at(90)), null);
      assert.deepEqual(
        (await store.activeOperatorGrants(tenant.id, at(10))).map((row) => row.operatorId),
        ['other', 'op', 'op'],
      );
      assert.equal(await store.transaction((tx) => tx.closeOperatorGrant(longer.id, at(31))), true);
      assert.equal(
        await store.transaction((tx) => tx.closeOperatorGrant(longer.id, at(32))),
        false,
      );
      assert.equal(
        await store.transaction((tx) => tx.closeOperatorGrant(longer.id + 1000, at(32))),
        false,
      );
      assert.equal((await store.operatorGrant(longer.id))?.closedAt?.getTime(), at(31).getTime());
      assert.equal((await store.activeOperatorGrant(tenant.id, 'op', at(40)))?.id, grant.id);
      assert.equal(
        await store.transaction((tx) => tx.closeOperatorGrants(tenant.id, 'op', at(41))),
        1,
      );
      assert.equal(await store.activeOperatorGrant(tenant.id, 'op', at(42)), null);
      assert.equal(await rejectedCode(open('op', 0)), 'invalid_store_input');
    },
  },
  {
    name: 'sweep reads are ordered and bounded',
    async run(store) {
      const due = await createTenant(store, 'due', 'a');
      const later = await createTenant(store, 'later', 'b');
      const purging = await createTenant(store, 'purging', 'c');
      await createTenant(store, 'active', 'd');
      await store.transaction(async (tx) => {
        await tx.updateTenant(due.id, 1, {
          status: 'pending_deletion',
          deletionDueAt: at(10),
          updatedAt: at(1),
        });
        await tx.updateTenant(later.id, 1, {
          status: 'pending_deletion',
          deletionDueAt: at(100),
          updatedAt: at(1),
        });
        await tx.updateTenant(purging.id, 1, {
          status: 'purging',
          deletionDueAt: at(5),
          updatedAt: at(1),
        });
      });
      assert.deepEqual(
        (await store.tenantsDueForPurge(at(50), 10)).map((tenant) => tenant.slug),
        ['purging', 'due'],
      );
      assert.deepEqual(
        (await store.tenantsDueForPurge(at(50), 1)).map((tenant) => tenant.slug),
        ['purging'],
      );
      assert.equal(await rejectedCode(store.tenantsDueForPurge(at(50), 0)), 'invalid_store_input');
      assert.equal(
        await rejectedCode(store.tenantsDueForPurge(at(50), 1001)),
        'invalid_store_input',
      );
      await store.transaction(async (tx) => {
        for (const hostname of ['a.bigcorp.io', 'b.bigcorp.io', 'c.bigcorp.io']) {
          await tx.insertDomainClaim({
            tenantId: due.id,
            hostname,
            token: issueDomainToken(),
            expiresAt: at(60),
            createdAt: at(0),
          });
        }
        await tx.updateDomainClaim(due.id, 'a.bigcorp.io', { lastCheckedAt: at(20) });
        await tx.updateDomainClaim(due.id, 'b.bigcorp.io', { lastCheckedAt: at(5) });
      });
      assert.deepEqual(
        (await store.domainClaimsDueForCheck(at(10), 10)).map((claim) => claim.hostname),
        ['c.bigcorp.io', 'b.bigcorp.io'],
      );
      assert.deepEqual(
        (await store.domainClaimsDueForCheck(at(30), 10)).map((claim) => claim.hostname),
        ['c.bigcorp.io', 'b.bigcorp.io', 'a.bigcorp.io'],
      );
    },
  },
  {
    name: 'a deadlock rejects one transaction with transaction_conflict',
    async run(store) {
      const one = await createTenant(store, 'one', 'alice');
      const two = await createTenant(store, 'two', 'bob');
      const oneLocked = gate();
      const twoLocked = gate();
      const results = await Promise.allSettled([
        store.transaction(async (tx) => {
          await tx.lockTenant(one.id);
          oneLocked.open();
          await twoLocked.wait;
          await tx.lockTenant(two.id);
        }),
        store.transaction(async (tx) => {
          await tx.lockTenant(two.id);
          twoLocked.open();
          await oneLocked.wait;
          await tx.lockTenant(one.id);
        }),
      ]);
      assert.equal(fulfilled(results), 1);
      assert.deepEqual(rejectionCodes(results), ['transaction_conflict']);
    },
  },
  {
    name: 'values outside the record shapes are refused and poison the transaction',
    async run(store) {
      const tenant = await createTenant(store, 'acme', 'alice');
      const token = issueInvitationToken();
      const invitation = {
        tenantId: tenant.id,
        email: 'guest@bigcorp.io',
        role: 'member',
        invitedBy: 'alice',
        tokenHash: token.hash,
        expiresAt: at(60),
        createdAt: at(0),
      };
      const claim = {
        tenantId: tenant.id,
        hostname: 'shop.bigcorp.io',
        token: issueDomainToken(),
        expiresAt: at(60),
        createdAt: at(0),
      };
      const audit = {
        tenantId: tenant.id,
        at: at(0),
        actor: { kind: 'system' as const },
        action: 'tenant.created' as const,
        target: null,
        reason: null,
        traceId: null,
      };
      const calls: Record<string, (tx: TenancyTx) => Promise<unknown>> = {
        'slug with a space': (tx) => tx.insertTenant(newTenant('bad slug', 'a')),
        'slug with a trailing dash': (tx) => tx.insertTenant(newTenant('bad-', 'a')),
        'empty name': (tx) => tx.insertTenant({ ...newTenant('fine', 'a'), name: '' }),
        'long name': (tx) => tx.insertTenant({ ...newTenant('fine', 'a'), name: 'x'.repeat(201) }),
        'settings not JSON': (tx) => tx.insertTenant({ ...newTenant('fine', 'a'), settings: '{' }),
        'settings too large': (tx) =>
          tx.insertTenant({
            ...newTenant('fine', 'a'),
            settings: JSON.stringify('x'.repeat(70_000)),
          }),
        'invalid date': (tx) =>
          tx.insertTenant({ ...newTenant('fine', 'a'), createdAt: new Date(Number.NaN) }),
        'long user id': (tx) => tx.insertTenant(newTenant('fine', 'u'.repeat(192))),
        'version zero': (tx) => tx.updateTenant(tenant.id, 0, { updatedAt: at(1) }),
        'tenant id zero': (tx) => tx.lockTenant(0),
        'upper-case role': (tx) =>
          tx.insertMembership({
            tenantId: tenant.id,
            userId: 'x',
            role: 'Owner',
            invitedBy: null,
            createdAt: at(0),
          }),
        'upper-case email': (tx) => tx.putInvitation({ ...invitation, email: 'Guest@bigcorp.io' }),
        'short token hash': (tx) =>
          tx.putInvitation({ ...invitation, tokenHash: new Uint8Array(31) }),
        'upper-case hostname': (tx) =>
          tx.insertDomainClaim({ ...claim, hostname: 'Shop.bigcorp.io' }),
        'malformed domain token': (tx) => tx.insertDomainClaim({ ...claim, token: 'short' }),
        'negative failures': (tx) =>
          tx.updateDomainClaim(tenant.id, 'shop.bigcorp.io', { failures: -1 }),
        'batch limit zero': (tx) => tx.deleteAuditBefore(at(0), 0),
        'long audit target': (tx) => tx.appendAudit({ ...audit, target: 't'.repeat(256) }),
        'empty grant reason': (tx) =>
          tx.insertOperatorGrant({
            tenantId: tenant.id,
            operatorId: 'op',
            reason: '',
            write: false,
            openedAt: at(0),
            expiresAt: at(1),
          }),
        'malformed token hash lookup': (tx) => tx.invitationByTokenHash(new Uint8Array(4)),
      };
      for (const [label, call] of Object.entries(calls)) {
        let after: unknown;
        const code = await rejectedCode(
          store.transaction(async (tx) => {
            assert.equal(await rejectedCode(call(tx)), 'invalid_store_input', label);
            after = await rejectedCode(tx.countMembers(tenant.id));
          }),
        );
        assert.equal(code, 'invalid_store_input', label);
        assert.equal(after, 'transaction_aborted', label);
      }
      assert.equal(await store.tenantBySlug('fine'), null);
      assert.equal(await store.countMembers(tenant.id), 1);
    },
  },
]);
