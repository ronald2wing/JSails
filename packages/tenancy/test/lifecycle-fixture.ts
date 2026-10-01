/**
 * A tenancy lifecycle on the memory store with a controllable clock, a fake
 * DNS resolver and a recorded event stream, plus the actor shorthands and
 * the setup steps the lifecycle tests share.
 */

import type { DnsTxtResolver } from '../src/dns-resolver.js';
import { DOMAIN_CHALLENGE_LABEL } from '../src/domain-verification.js';
import {
  createMemoryTenancyStore,
  type MemoryTenancyStoreOptions,
} from '../src/memory-tenancy-store.js';
import type { TenancyActor } from '../src/tenancy-actor.js';
import type { TenancyEvent } from '../src/tenancy-events.js';
import { createTenancyLifecycle, type TenancyLifecycle } from '../src/tenancy-lifecycle.js';
import {
  plainTenantSettings,
  type PlainTenantSettings,
  type TenancyLifecycleOptions,
} from '../src/tenancy-lifecycle-options.js';
import type { TenantAuditRecord, TenantSummary } from '../src/tenancy-records.js';
import type { TenancyStore } from '../src/tenancy-store.js';
import type { TenantId } from '../src/tenant-id.js';
import { defaultTenantRoles } from '../src/tenant-roles.js';

/** The fixture's epoch. */
export const T0 = Date.parse('2026-03-01T00:00:00.000Z');

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The default role names. */
export type DefaultRole = 'admin' | 'member' | 'viewer';

/** Lifecycle options the fixture accepts as overrides. */
export type FixtureOptions = Partial<
  TenancyLifecycleOptions<DefaultRole, never, PlainTenantSettings>
>;

/** A TXT resolver whose answers a test sets per record name. */
export interface FakeDns extends DnsTxtResolver {
  /** Names looked up, in order. */
  readonly lookups: string[];
  /** Answer `name` with these records, or fail with this error. */
  answer(name: string, answer: readonly (readonly string[])[] | Error): void;
  /** Publish `token=<token>` for a hostname's challenge. */
  publish(hostname: string, token: string): void;
  /** Remove a hostname's challenge record. */
  withdraw(hostname: string): void;
  /** Run before each lookup resolves. */
  onLookup: ((name: string) => Promise<void>) | null;
}

/** Create a {@link FakeDns}; unknown names have no records. */
export function fakeDns(): FakeDns {
  const answers = new Map<string, readonly (readonly string[])[] | Error>();
  const notFound = (): Error => Object.assign(new Error('no records'), { code: 'ENOTFOUND' });
  const dns: FakeDns = {
    lookups: [],
    onLookup: null,
    answer(name, answer) {
      answers.set(name, answer);
    },
    publish(hostname, token) {
      answers.set(`${DOMAIN_CHALLENGE_LABEL}.${hostname}`, [[`token=${token}`]]);
    },
    withdraw(hostname) {
      answers.delete(`${DOMAIN_CHALLENGE_LABEL}.${hostname}`);
    },
    async resolveTxt(name) {
      dns.lookups.push(name);
      if (dns.onLookup !== null) {
        await dns.onLookup(name);
      }
      const answer = answers.get(name);
      if (answer === undefined) {
        throw notFound();
      }
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    },
  };
  return dns;
}

/** A controllable clock. */
export interface FixtureClock {
  now(): Date;
  advance(ms: number): void;
}

/** A lifecycle wired for tests. */
export interface LifecycleFixture {
  readonly store: TenancyStore;
  readonly lifecycle: TenancyLifecycle<DefaultRole, PlainTenantSettings>;
  readonly events: TenancyEvent[];
  readonly dns: FakeDns;
  readonly clock: FixtureClock;
}

/** Build a lifecycle on a fresh memory store. */
export function lifecycleFixture(
  options: FixtureOptions = {},
  storeOptions: MemoryTenancyStoreOptions = {},
): LifecycleFixture {
  let time = T0;
  const clock: FixtureClock = {
    now: () => new Date(time),
    advance(ms) {
      time += ms;
    },
  };
  const events: TenancyEvent[] = [];
  const dns = fakeDns();
  const store = options.store ?? createMemoryTenancyStore(storeOptions);
  const lifecycle = createTenancyLifecycle({
    roles: defaultTenantRoles,
    parseSettings: plainTenantSettings,
    now: clock.now,
    emit: (event) => {
      events.push(event);
    },
    dns,
    rootDomain: 'tenancy-app.io',
    appHosts: ['tenancy-app.io'],
    ...options,
    store,
  });
  return { store, lifecycle, events, dns, clock };
}

/** A user actor. */
export function user(userId: string): TenancyActor {
  return { kind: 'user', userId };
}

/** An operator actor. */
export function operator(userId: string, reason = 'support ticket 42'): TenancyActor {
  return { kind: 'operator', userId, reason };
}

/** A system actor. */
export function system(reason = 'scheduled job'): TenancyActor {
  return { kind: 'system', reason };
}

/** The address a test user receives invitations at. */
export function emailOf(userId: string): string {
  return `${userId}@mail.tenancy-test.io`;
}

/** Invite `userId` as `role` (by the owner unless `by` is given) and accept. */
export async function join(
  fixture: LifecycleFixture,
  tenant: TenantSummary,
  userId: string,
  role: DefaultRole,
  by: TenancyActor = user(tenant.ownerUserId),
): Promise<void> {
  const { token } = await fixture.lifecycle.invite(tenant.id, { email: emailOf(userId), role }, by);
  await fixture.lifecycle.acceptInvitation(token, {
    userId,
    email: emailOf(userId),
    emailVerified: true,
  });
}

/**
 * Create a tenant owned by `owner` with the given members (user id to role).
 */
export async function tenantWith(
  fixture: LifecycleFixture,
  slug: string,
  owner: string,
  members: Readonly<Record<string, DefaultRole>> = {},
): Promise<TenantSummary> {
  const tenant = await fixture.lifecycle.create({ name: `Tenant ${slug}`, slug }, user(owner));
  for (const [userId, role] of Object.entries(members)) {
    await join(fixture, tenant, userId, role);
  }
  return tenant;
}

/** Every audit record of a tenant, oldest first. */
export async function auditTrail(
  store: TenancyStore,
  tenantId: TenantId,
): Promise<TenantAuditRecord[]> {
  const records: TenantAuditRecord[] = [];
  let after: string | undefined;
  do {
    const page = await store.audit(
      tenantId,
      after === undefined ? { limit: 200 } : { limit: 200, after },
    );
    records.push(...page.items);
    after = page.next ?? undefined;
  } while (after !== undefined);
  return records.reverse();
}

/** The audit actions of a tenant, oldest first. */
export async function auditActions(store: TenancyStore, tenantId: TenantId): Promise<string[]> {
  return (await auditTrail(store, tenantId)).map((record) => record.action);
}
