/**
 * Tests for the lifecycle options: defaults, every range check, the limits
 * hook's result, and the schema-less settings parser.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMemoryTenancyStore } from '../src/memory-tenancy-store.js';
import { createTenancyLifecycle } from '../src/tenancy-lifecycle.js';
import {
  DEFAULT_DOMAINS,
  DEFAULT_INVITATIONS_PER_DAY,
  enforcedLimits,
  plainTenantSettings,
  resolveLifecycleOptions,
  type TenancyLifecycleOptions,
} from '../src/tenancy-lifecycle-options.js';
import { defaultTenantRoles } from '../src/tenant-roles.js';
import { thrownCode } from './thrown-code.js';

type Options = TenancyLifecycleOptions<'admin' | 'member' | 'viewer', never, unknown>;

function base(): Options {
  return {
    store: createMemoryTenancyStore(),
    roles: defaultTenantRoles,
    parseSettings: plainTenantSettings,
  };
}

describe('resolveLifecycleOptions', () => {
  it('applies the documented defaults', () => {
    const resolved = resolveLifecycleOptions(base());
    assert.ok(Object.isFrozen(resolved));
    assert.equal(resolved.invitationTtlMs, 7 * 86_400_000);
    assert.equal(resolved.deletionRetentionMs, 30 * 86_400_000);
    assert.equal(resolved.operatorGrantMaxMs, 3_600_000);
    assert.equal(resolved.auditRetentionMs, 400 * 86_400_000);
    assert.equal(resolved.domainRecheckMs, 86_400_000);
    assert.equal(resolved.dnsTimeoutMs, 5000);
    assert.equal(resolved.conflictRetries, 2);
    assert.equal(resolved.rootDomain, undefined);
    assert.deepEqual(resolved.appHosts, []);
    assert.ok(resolved.now() instanceof Date);
    assert.equal(typeof resolved.dns.resolveTxt, 'function');
  });

  it('normalises configured hosts', () => {
    const resolved = resolveLifecycleOptions({
      ...base(),
      rootDomain: 'App.Example.IO.',
      appHosts: ['WWW.example.io:443'],
    });
    assert.equal(resolved.rootDomain, 'app.example.io');
    assert.deepEqual(resolved.appHosts, ['www.example.io']);
  });

  it('refuses every out-of-range or malformed option', () => {
    const cases: Partial<Record<keyof Options, unknown>>[] = [
      { store: {} },
      { roles: { parse: () => null } },
      { parseSettings: 'json' },
      { slugs: { minLength: 3 } },
      { domainPolicy: null },
      { appHosts: 'example.io' },
      { appHosts: ['not a host'] },
      { rootDomain: '' },
      { dns: {} },
      { limits: 5 },
      { emit: 'log' },
      { now: Date.now() },
      { invitationTtlMs: 60_000 },
      { invitationTtlMs: 31 * 86_400_000 },
      { deletionRetentionMs: -1 },
      { operatorGrantMaxMs: 1000 },
      { operatorGrantMaxMs: 2 * 86_400_000 },
      { auditRetentionMs: 1000 },
      { domainRecheckMs: 1000 },
      { dnsTimeoutMs: 10 },
      { conflictRetries: 6 },
      { conflictRetries: 1.5 },
    ];
    for (const override of cases) {
      assert.equal(
        thrownCode(() => resolveLifecycleOptions({ ...base(), ...override } as Options)),
        'invalid_lifecycle_options',
        JSON.stringify(Object.keys(override)),
      );
    }
    assert.equal(
      thrownCode(() => resolveLifecycleOptions(null as unknown as Options)),
      'invalid_lifecycle_options',
    );
    assert.equal(
      thrownCode(() => createTenancyLifecycle({ ...base(), invitationTtlMs: 0 })),
      'invalid_lifecycle_options',
    );
  });
});

describe('enforcedLimits', () => {
  it('applies defaults and passes app limits through', () => {
    assert.deepEqual(enforcedLimits({}), {
      seats: Number.POSITIVE_INFINITY,
      invitationsPerDay: DEFAULT_INVITATIONS_PER_DAY,
      domains: DEFAULT_DOMAINS,
    });
    assert.equal(DEFAULT_DOMAINS, 10);
    assert.equal(enforcedLimits({ domains: Number.POSITIVE_INFINITY }).domains, Infinity);
    assert.deepEqual(enforcedLimits({ seats: 0, domains: 3, projects: 9 }), {
      seats: 0,
      invitationsPerDay: 50,
      domains: 3,
    });
    assert.equal(
      enforcedLimits({ seats: Number.POSITIVE_INFINITY }).seats,
      Number.POSITIVE_INFINITY,
    );
  });

  it('refuses limits that are not non-negative integers', () => {
    for (const limits of [
      null,
      3,
      { seats: -1 },
      { seats: 1.5 },
      { invitationsPerDay: '5' },
      { domains: Number.NaN },
    ]) {
      assert.equal(
        thrownCode(() => enforcedLimits(limits)),
        'invalid_limits',
        JSON.stringify(limits),
      );
    }
  });
});

describe('plainTenantSettings', () => {
  it('copies plain JSON objects', () => {
    const raw = { theme: { color: 'red' } };
    const copy = plainTenantSettings(raw);
    assert.deepEqual(copy, raw);
    assert.notEqual(copy.theme, raw.theme);
    assert.deepEqual(plainTenantSettings(Object.create(null)), {});
  });

  it('refuses everything else', () => {
    for (const raw of [null, [], 'x', 1, new Date(0), new Map(), { n: 1n }]) {
      assert.equal(
        thrownCode(() => plainTenantSettings(raw)),
        'invalid_settings',
        String(raw),
      );
    }
  });
});
