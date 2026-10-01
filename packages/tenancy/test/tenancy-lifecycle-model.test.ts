/**
 * A seeded model test of the tenancy lifecycle with injected store faults.
 *
 * Each run drives random sequences of every lifecycle operation (create,
 * invite, accept, role changes, removal, leaving, transfer, suspension,
 * deletion and purge, domains, operator grants, account deletion, the sweep
 * and the passage of time) by random actors against the memory store, which
 * fails a random few percent of statements. After every step it checks the
 * invariants the lifecycle promises:
 *
 * - every tenant has exactly one owner membership, equal to the row's owner;
 * - no tenant has more members than its seats;
 * - a purged tenant leaves no membership, invitation or claim behind;
 * - a hostname is verified for at most one tenant, and routing agrees;
 * - a user just removed, departed or deleted holds no membership and no open
 *   grant on that tenant;
 * - every open invitation was sent by the operator or by a member whose
 *   current role could send it (holds `members.invite` and outranks the
 *   invited role), so an inviter's authority never outlives their role;
 * - a token admits at most once, and never once it has expired;
 * - a failed single-transaction step commits nothing and emits nothing (an
 *   invitation consumed before its refusal writes one audit record and no
 *   event), and no step emits an event without an audit record.
 *
 * A failing run names its seed and step.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMemoryTenancyStore } from '../src/memory-tenancy-store.js';
import type { TenancyActor } from '../src/tenancy-actor.js';
import type { TenancyStore } from '../src/tenancy-store.js';
import type { TenantId } from '../src/tenant-id.js';
import { defaultTenantRoles, OWNER_ROLE } from '../src/tenant-roles.js';
import {
  auditTrail,
  DAY,
  emailOf,
  HOUR,
  lifecycleFixture,
  operator,
  system,
  user,
  type DefaultRole,
} from './lifecycle-fixture.js';
import { seededPrng, type SeededPrng } from './seeded-prng.js';

const SEEDS = [11, 23, 37, 41, 59, 67, 71, 89];
const STEPS = 300;
const SEATS = 4;
const USERS = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
const SLUGS = ['one', 'two', 'three'];
const HOSTS = ['shop.alpha-co.io', 'www.alpha-co.io', 'beta-co.io'];
const ROLES: readonly DefaultRole[] = ['admin', 'member', 'viewer'];
const FAULT_RATE = 0.03;

/** Refusals that consume an invitation in a committed transaction before reporting it. */
const CONSUMING = new Set(['invitation_expired', 'already_member', 'invalid_invitation']);

/** Operations that run more than one transaction and may commit part of their work. */
const MULTI_TRANSACTION = new Set(['purge', 'sweep', 'userDeleted', 'recheck']);

interface IssuedToken {
  readonly token: string;
  readonly tenantId: TenantId;
  readonly invitee: string;
  readonly expiresAt: number;
}

interface Step {
  readonly name: string;
  run(): Promise<unknown>;
  /** Checks that apply only when the step succeeded. */
  readonly after?: (result: unknown) => Promise<void>;
}

async function allMembers(store: TenancyStore, tenantId: TenantId) {
  const members = [];
  let after: string | undefined;
  do {
    const page = await store.members(
      tenantId,
      after === undefined ? { limit: 200 } : { limit: 200, after },
    );
    members.push(...page.items);
    after = page.next ?? undefined;
  } while (after !== undefined);
  return members;
}

/** Successful steps per operation, over every seed, so a model that only ever refuses fails. */
const successes = new Map<string, number>();

async function runModel(seed: number): Promise<void> {
  const prng: SeededPrng = seededPrng(seed);
  const faults: SeededPrng = seededPrng(seed ^ 0x5eed);
  let faulting = false;
  const store = createMemoryTenancyStore({
    onStatement() {
      if (faulting && faults.next() < FAULT_RATE) {
        throw new Error('injected fault');
      }
    },
  });
  const fixture = lifecycleFixture({
    store,
    limits: () => ({ seats: SEATS }),
    deletionRetentionMs: 2 * DAY,
  });
  const { lifecycle, events, dns, clock } = fixture;

  const tenants = new Set<TenantId>();
  const tokens: IssuedToken[] = [];
  const accepted = new Set<string>();

  const anyUser = (): string => prng.pick(USERS);
  /** A known tenant, usually one that still exists and is active. */
  const anyTenant = async (): Promise<TenantId> => {
    const live: TenantId[] = [];
    for (const id of tenants) {
      if ((await store.tenantById(id))?.status === 'active') live.push(id);
    }
    if (live.length > 0 && prng.int(5) !== 0) return prng.pick(live);
    return tenants.size === 0 ? 1 : prng.pick([...tenants]);
  };
  /** A known tenant in one of `statuses` when there is one, otherwise any. */
  const anyTenantIn = async (statuses: readonly string[]): Promise<TenantId> => {
    const matching: TenantId[] = [];
    for (const id of tenants) {
      const status = (await store.tenantById(id))?.status;
      if (status !== undefined && statuses.includes(status)) matching.push(id);
    }
    return matching.length > 0 ? prng.pick(matching) : anyTenant();
  };
  /** A member of the tenant, or now and then anyone. */
  const anyMember = async (tenantId: TenantId): Promise<string> => {
    const members = await allMembers(store, tenantId);
    return members.length === 0 || prng.int(5) === 0
      ? anyUser()
      : prng.pick(members.map((member) => member.userId));
  };
  /** Mostly the owner, sometimes another member, a system or an operator, rarely anyone. */
  const anyActor = async (tenantId: TenantId): Promise<TenancyActor> => {
    const roll = prng.int(20);
    if (roll < 2) return system('model');
    if (roll < 4) return operator('op', 'model support');
    if (roll < 12) {
      const owner = (await store.tenantById(tenantId))?.ownerUserId;
      if (owner !== undefined) return user(owner);
    }
    return user(roll < 19 ? await anyMember(tenantId) : anyUser());
  };

  const totalAudit = async (): Promise<number> => {
    let total = 0;
    for (const id of tenants) {
      total += (await auditTrail(store, id)).length;
    }
    return total;
  };

  const expectGone = async (tenantId: TenantId, userId: string): Promise<void> => {
    assert.equal(await store.membership(tenantId, userId), null, 'removed user keeps a membership');
    assert.equal(
      await store.activeOperatorGrant(tenantId, userId, clock.now()),
      null,
      'removed user keeps an operator grant',
    );
  };

  const steps: (() => Promise<Step>)[] = [
    async () => {
      const slug = prng.pick(SLUGS);
      return {
        name: 'create',
        run: () => lifecycle.create({ name: `Tenant ${slug}`, slug }, user(anyUser())),
        async after(result) {
          tenants.add((result as { id: TenantId }).id);
        },
      };
    },
    async () => {
      const tenantId = await anyTenant();
      const invitee = anyUser();
      const by = await anyActor(tenantId);
      return {
        name: 'invite',
        run: () =>
          lifecycle.invite(tenantId, { email: emailOf(invitee), role: prng.pick(ROLES) }, by),
        async after(result) {
          const { token, invitation } = result as {
            token: string;
            invitation: { expiresAt: Date };
          };
          tokens.push({ token, tenantId, invitee, expiresAt: invitation.expiresAt.getTime() });
        },
      };
    },
    async () => {
      const open = tokens.filter((candidate) => !accepted.has(candidate.token));
      const pool = open.length > 0 && prng.int(6) !== 0 ? open : tokens;
      const issued = pool.length === 0 ? null : prng.pick(pool);
      const who = issued === null ? anyUser() : prng.int(4) === 0 ? anyUser() : issued.invitee;
      return {
        name: 'accept',
        run: () =>
          lifecycle.acceptInvitation(issued?.token ?? 'jsinv_nothing', {
            userId: who,
            email: emailOf(who),
            emailVerified: prng.int(10) !== 0,
          }),
        async after() {
          assert.ok(issued !== null);
          assert.ok(!accepted.has(issued.token), 'a token admitted twice');
          assert.ok(clock.now().getTime() < issued.expiresAt, 'an expired token admitted');
          accepted.add(issued.token);
          assert.notEqual(await store.membership(issued.tenantId, who), null);
        },
      };
    },
    async () => {
      const tenantId = await anyTenant();
      const by = await anyActor(tenantId);
      const target = await anyMember(tenantId);
      return {
        name: 'changeRole',
        run: async () => lifecycle.changeRole(tenantId, target, prng.pick(ROLES), by),
      };
    },
    async () => {
      const tenantId = await anyTenant();
      const target = await anyMember(tenantId);
      const by = await anyActor(tenantId);
      return {
        name: 'removeMember',
        run: () => lifecycle.removeMember(tenantId, target, by),
        after: () => expectGone(tenantId, target),
      };
    },
    async () => {
      const tenantId = await anyTenant();
      const who = await anyMember(tenantId);
      return {
        name: 'leave',
        run: () => lifecycle.leave(tenantId, user(who)),
        after: () => expectGone(tenantId, who),
      };
    },
    async () => {
      const tenantId = await anyTenant();
      const by = await anyActor(tenantId);
      const target = await anyMember(tenantId);
      return {
        name: 'transfer',
        run: () => lifecycle.transferOwnership(tenantId, target, by),
      };
    },
    async () => {
      const tenantId = await anyTenant();
      return prng.int(2) === 0
        ? { name: 'suspend', run: () => lifecycle.suspend(tenantId, operator('op', 'model')) }
        : { name: 'resume', run: () => lifecycle.resume(tenantId, operator('op', 'model')) };
    },
    async () => {
      const tenantId = await anyTenant();
      const by = await anyActor(tenantId);
      return prng.int(2) === 0
        ? { name: 'scheduleDeletion', run: () => lifecycle.scheduleDeletion(tenantId, by) }
        : { name: 'cancelDeletion', run: () => lifecycle.cancelDeletion(tenantId, by) };
    },
    async () => {
      const tenantId = await anyTenantIn(['pending_deletion', 'purging']);
      const fails = prng.int(4) === 0;
      return {
        name: 'purge',
        run: () =>
          lifecycle.purge(tenantId, system('model'), async () => {
            if (fails) throw new Error('purge data failed');
          }),
      };
    },
    async () => {
      const tenantId = await anyTenant();
      const host = prng.pick(HOSTS);
      const by = await anyActor(tenantId);
      return {
        name: 'addDomain',
        run: () => lifecycle.addDomain(tenantId, host, by),
        async after(result) {
          if (prng.int(2) === 0) {
            dns.publish(host, (result as { claim: { token: string } }).claim.token);
          }
        },
      };
    },
    async () => {
      const tenantId = await anyTenant();
      const host = prng.pick(HOSTS);
      if (prng.int(3) === 0) dns.withdraw(host);
      return {
        name: 'checkDomain',
        run: () => lifecycle.checkDomain(tenantId, host, system('model')),
      };
    },
    async () => {
      const tenantId = await anyTenant();
      const by = await anyActor(tenantId);
      return {
        name: 'removeDomain',
        run: () => lifecycle.removeDomain(tenantId, prng.pick(HOSTS), by),
      };
    },
    async () => {
      const tenantId = await anyTenant();
      return {
        name: 'openGrant',
        run: () =>
          lifecycle.openOperatorGrant(
            tenantId,
            { durationMs: HOUR, write: prng.int(2) === 0 },
            operator(prng.int(2) === 0 ? 'op' : anyUser(), 'model support'),
          ),
      };
    },
    async () => {
      const target = anyUser();
      return {
        name: 'userDeleted',
        run: () => lifecycle.userDeleted(target, system('model')),
        async after(result) {
          for (const tenantId of (result as { removedFrom: TenantId[] }).removedFrom) {
            await expectGone(tenantId, target);
          }
        },
      };
    },
    async () => ({
      name: 'sweep',
      run: () => lifecycle.sweep({ purgeData: async () => undefined }),
    }),
    async () => ({ name: 'recheck', run: () => lifecycle.recheckDomains() }),
    async () => {
      const ms = prng.int(8) === 0 ? prng.int(10 * DAY) : prng.int(6 * HOUR);
      return {
        name: 'advance',
        run: async () => {
          clock.advance(ms);
        },
      };
    },
  ];

  /** How often each step factory is chosen, in the order of `steps`. */
  const weights = [3, 6, 6, 4, 2, 2, 2, 1, 1, 1, 2, 3, 1, 1, 1, 1, 1, 2];
  assert.equal(weights.length, steps.length);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const pickWeighted = (): number => {
    let roll = prng.int(totalWeight);
    for (const [index, weight] of weights.entries()) {
      if (roll < weight) return index;
      roll -= weight;
    }
    return 0;
  };

  const checkInvariants = async (): Promise<void> => {
    for (const tenantId of tenants) {
      const tenant = await store.tenantById(tenantId);
      if (tenant === null) {
        assert.deepEqual(await store.domainClaims(tenantId), [], 'purged tenant keeps claims');
        assert.equal(await store.countMembers(tenantId), 0, 'purged tenant keeps members');
        assert.deepEqual(
          (await store.invitations(tenantId, { limit: 10 })).items,
          [],
          'purged tenant keeps invitations',
        );
        continue;
      }
      const members = await allMembers(store, tenantId);
      const owners = members.filter((member) => member.role === 'owner');
      assert.equal(owners.length, 1, 'exactly one owner');
      assert.equal(owners[0]?.userId, tenant.ownerUserId, 'owner mirrors the membership');
      assert.ok(members.length <= SEATS, 'seats exceeded');
      const roleOf = new Map(members.map((member) => [member.userId, member.role]));
      let after: string | undefined;
      do {
        const page = await store.invitations(
          tenantId,
          after === undefined ? { limit: 200 } : { limit: 200, after },
        );
        for (const invitation of page.items) {
          if (invitation.invitedBy === 'op') continue;
          const inviter = defaultTenantRoles.parse(roleOf.get(invitation.invitedBy) ?? '');
          const invited = defaultTenantRoles.parse(invitation.role);
          assert.ok(
            inviter !== null &&
              invited !== null &&
              invited !== OWNER_ROLE &&
              defaultTenantRoles.allows(inviter, 'members.invite') &&
              defaultTenantRoles.canAssign(inviter, null, invited),
            `an invitation outlived its inviter's authority (${invitation.invitedBy})`,
          );
        }
        after = page.next ?? undefined;
      } while (after !== undefined);
      assert.equal(
        tenant.deletionDueAt !== null,
        tenant.status === 'pending_deletion' || tenant.status === 'purging',
        'deletion due date matches the status',
      );
    }
    for (const host of HOSTS) {
      const verified = (await store.domainClaimsOfHostname(host)).filter(
        (claim) => claim.verifiedHostname !== null,
      );
      assert.ok(verified.length <= 1, 'a hostname verified twice');
      assert.equal((await store.tenantByVerifiedHostname(host))?.id, verified[0]?.tenantId);
    }
  };

  for (let index = 0; index < STEPS; index += 1) {
    const step = await (steps[pickWeighted()] ?? steps[0] ?? assert.fail('no steps'))();
    const label = `seed ${seed}, step ${index} (${step.name})`;
    const auditBefore = await totalAudit();
    const eventsBefore = events.length;
    faulting = true;
    let outcome: { ok: true; value: unknown } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await step.run() };
      successes.set(step.name, (successes.get(step.name) ?? 0) + 1);
    } catch (error) {
      outcome = { ok: false, error };
    } finally {
      faulting = false;
    }
    try {
      // A tenant created by this step counts towards the audit it wrote.
      for (const event of events.slice(eventsBefore)) {
        if (event.type === 'tenant' && event.change === 'created') {
          tenants.add(event.tenantId);
        }
      }
      const auditDelta = (await totalAudit()) - auditBefore;
      const eventsDelta = events.length - eventsBefore;
      if (eventsDelta > 0) {
        assert.ok(auditDelta > 0, 'an event without an audit record');
      }
      if (!outcome.ok && !MULTI_TRANSACTION.has(step.name)) {
        const code =
          typeof outcome.error === 'object' && outcome.error !== null && 'code' in outcome.error
            ? String(outcome.error.code)
            : '';
        assert.equal(eventsDelta, 0, 'a failed step emitted events');
        assert.ok(
          auditDelta === 0 || (auditDelta === 1 && CONSUMING.has(code)),
          'a failed step committed audit records',
        );
      }
      if (outcome.ok && step.after !== undefined) {
        await step.after(outcome.value);
      }
      await checkInvariants();
    } catch (error) {
      assert.fail(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  assert.ok(tenants.size > 0, `seed ${seed} created no tenant`);
}

describe('tenancy lifecycle model', () => {
  for (const seed of SEEDS) {
    it(`keeps every invariant under random operations and faults (seed ${seed})`, () =>
      runModel(seed));
  }

  it('drove every operation to success at least once', () => {
    const names = [
      'create',
      'invite',
      'accept',
      'changeRole',
      'removeMember',
      'leave',
      'transfer',
      'suspend',
      'resume',
      'scheduleDeletion',
      'cancelDeletion',
      'purge',
      'addDomain',
      'checkDomain',
      'removeDomain',
      'openGrant',
      'userDeleted',
      'sweep',
      'recheck',
      'advance',
    ];
    for (const name of names) {
      assert.ok((successes.get(name) ?? 0) > 0, `${name} ${JSON.stringify([...successes])}`);
    }
  });
});
