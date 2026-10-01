/**
 * Tests for the tenancy plugin: static entity declaration, the membership and
 * status enforcement around the app's resolver, the per-request memo, the
 * default membership lookup against a real sql.js database, and the subdomain
 * resolver.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import type { Session } from 'jsails';
import { runExtensions } from 'jsails/extensions';
import { createEmptyDataSource, createTestSession, tempDir } from 'jsails/testing';
import {
  Tenant,
  TenantMembership,
  defaultSessionUserId,
  subdomainTenantResolver,
  tenancyEntities,
  tenancyPlugin,
  tenancyToken,
  type TenancyPluginOptions,
  type TenancyService,
} from '../src/index.js';

function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return Object.assign(new Tenant(), {
    id: 1,
    slug: 'acme',
    name: 'Acme',
    status: 'active',
    metadata: null,
    ...overrides,
  });
}

function makeMembership(tenant: Tenant, userId: string): TenantMembership {
  return Object.assign(new TenantMembership(), { id: 1, tenant, userId, role: 'member' });
}

function sessionFor(userId: string): Session {
  return createTestSession({ data: { user: { id: userId, name: 'U', email: 'u@x.test' } } });
}

async function serviceFor(options: TenancyPluginOptions): Promise<TenancyService> {
  const runtime = await runExtensions([tenancyPlugin(options)]);
  return runtime.services.get(tenancyToken);
}

/** A resolver that trusts a client header, as a naive app might write it. */
function headerResolver(tenant: Tenant): TenancyPluginOptions['resolveTenant'] {
  return (request) => (request.headers.get('x-tenant') === tenant.slug ? tenant : null);
}

function requestFor(slug: string): Request {
  return new Request('http://localhost/', { headers: { 'x-tenant': slug } });
}

describe('tenancyPlugin', () => {
  it('owns tenant and membership entities without wiring them into an app', () => {
    const plugin = tenancyPlugin({ resolveTenant: () => null });
    assert.equal(plugin.name, 'tenancy');
    assert.deepEqual(plugin.schema?.entities, [Tenant, TenantMembership]);
    assert.deepEqual(tenancyEntities, [Tenant, TenantMembership]);
  });

  it('grants a tenant to a member of it', async () => {
    const tenant = makeTenant();
    const service = await serviceFor({
      resolveTenant: headerResolver(tenant),
      findMembership: (found, userId) =>
        found.id === tenant.id && userId === 'u1' ? makeMembership(found, userId) : null,
    });

    const access = await service.resolveAccess(requestFor('acme'), { session: sessionFor('u1') });
    assert.equal(access.status, 'granted');
    assert.equal(access.status === 'granted' ? access.membership?.userId : null, 'u1');
    assert.equal(await service.resolve(requestFor('acme'), { session: sessionFor('u1') }), tenant);
  });

  it('refuses a tenant the signed-in user is not a member of, even when a header names it', async () => {
    const tenant = makeTenant();
    const service = await serviceFor({
      resolveTenant: headerResolver(tenant),
      findMembership: () => null,
    });

    const context = { session: sessionFor('intruder') };
    assert.deepEqual(await service.resolveAccess(requestFor('acme'), context), {
      status: 'refused',
      reason: 'not_member',
    });
    assert.equal(await service.resolve(requestFor('acme'), context), null);
  });

  it('refuses an anonymous request and a non-active tenant', async () => {
    const service = await serviceFor({
      resolveTenant: headerResolver(makeTenant()),
      findMembership: (tenant, userId) => makeMembership(tenant, userId),
    });
    assert.deepEqual(await service.resolveAccess(requestFor('acme'), { session: null }), {
      status: 'refused',
      reason: 'anonymous',
    });

    const suspended = await serviceFor({
      resolveTenant: headerResolver(makeTenant({ status: 'suspended' })),
      findMembership: (tenant, userId) => makeMembership(tenant, userId),
    });
    assert.deepEqual(
      await suspended.resolveAccess(requestFor('acme'), { session: sessionFor('u1') }),
      { status: 'refused', reason: 'inactive' },
    );
  });

  it('skips membership only when explicitly told the tenant is public', async () => {
    const tenant = makeTenant();
    const service = await serviceFor({
      resolveTenant: headerResolver(tenant),
      requireMembership: false,
      findMembership: () => assert.fail('membership must not be looked up'),
    });
    assert.deepEqual(await service.resolveAccess(requestFor('acme'), { session: null }), {
      status: 'granted',
      tenant,
      membership: null,
    });
  });

  it('reports a global request as none', async () => {
    const service = await serviceFor({ resolveTenant: () => null });
    assert.deepEqual(await service.resolveAccess(requestFor('x'), { session: null }), {
      status: 'none',
    });
  });

  it('memoizes the resolver and membership lookup per request', async () => {
    let resolverCalls = 0;
    let lookups = 0;
    const tenant = makeTenant();
    const service = await serviceFor({
      resolveTenant: () => {
        resolverCalls += 1;
        return tenant;
      },
      findMembership: (found, userId) => {
        lookups += 1;
        return makeMembership(found, userId);
      },
    });
    const request = requestFor('acme');
    const context = { session: sessionFor('u1') };

    await Promise.all([service.resolve(request, context), service.resolveAccess(request, context)]);
    await service.resolve(request, context);
    assert.equal(resolverCalls, 1);
    assert.equal(lookups, 1);

    await service.resolve(requestFor('acme'), context);
    assert.equal(resolverCalls, 2, 'a new request resolves again');
  });

  it('keys the memo on the session user, not the request alone', async () => {
    let lookups = 0;
    const service = await serviceFor({
      resolveTenant: headerResolver(makeTenant()),
      findMembership: (found, userId) => {
        lookups += 1;
        return userId === 'u1' ? makeMembership(found, userId) : null;
      },
    });
    const request = requestFor('acme');

    // A consumer that ran before the session was resolved must not pin the
    // anonymous refusal on the request.
    assert.deepEqual(await service.resolveAccess(request, { session: null }), {
      status: 'refused',
      reason: 'anonymous',
    });
    assert.equal(
      (await service.resolveAccess(request, { session: sessionFor('u1') })).status,
      'granted',
    );
    // Nor does one user's grant reach a call made with another session.
    assert.deepEqual(await service.resolveAccess(request, { session: sessionFor('u2') }), {
      status: 'refused',
      reason: 'not_member',
    });
    await service.resolve(request, { session: sessionFor('u1') });
    assert.equal(lookups, 2, 'each session user is decided once per request');
  });

  it('surfaces a synchronous resolver throw as a rejection', async () => {
    const service = await serviceFor({
      resolveTenant: () => {
        throw new Error('boom');
      },
    });
    await assert.rejects(service.resolve(requestFor('x'), { session: null }), /boom/);
  });

  it('checks membership against the database by default', async (t: TestContext) => {
    const dataSource = await createEmptyDataSource([Tenant, TenantMembership], {
      location: join(tempDir(t), 'tenancy.db'),
    });
    t.after(() => dataSource.destroy());
    const acme = await Tenant.save(Object.assign(new Tenant(), { slug: 'acme', name: 'Acme' }));
    const other = await Tenant.save(Object.assign(new Tenant(), { slug: 'other', name: 'Other' }));
    await TenantMembership.save(
      Object.assign(new TenantMembership(), { tenant: acme, userId: 'u1' }),
    );

    const service = await serviceFor({
      resolveTenant: subdomainTenantResolver({ rootDomain: 'example.test' }),
    });
    const member = { session: sessionFor('u1') };
    assert.equal(
      (await service.resolve(new Request('http://acme.example.test/'), member))?.id,
      acme.id,
    );
    assert.equal(await service.resolve(new Request('http://other.example.test/'), member), null);
    assert.ok(other.id !== acme.id);
  });

  it('rejects malformed options', () => {
    assert.throws(() => tenancyPlugin(null as never), TypeError);
    assert.throws(() => tenancyPlugin({ resolveTenant: 1 as never }), TypeError);
    assert.throws(
      () => tenancyPlugin({ resolveTenant: () => null, requireMembership: 'no' as never }),
      TypeError,
    );
    assert.throws(
      () => tenancyPlugin({ resolveTenant: () => null, activeStatuses: [1] as never }),
      TypeError,
    );
    assert.throws(
      () => tenancyPlugin({ resolveTenant: () => null, findMembership: {} as never }),
      TypeError,
    );
  });
});

describe('defaultSessionUserId', () => {
  it('reads data.userId, then data.user.id, else null', () => {
    assert.equal(defaultSessionUserId(createTestSession({ data: { userId: 'a' } })), 'a');
    assert.equal(defaultSessionUserId(sessionFor('b')), 'b');
    assert.equal(defaultSessionUserId(createTestSession({ data: { user: 'c' } })), null);
  });
});

describe('subdomainTenantResolver', () => {
  it('looks up exactly one label under the root domain', async () => {
    const seen: string[] = [];
    const resolver = subdomainTenantResolver({
      rootDomain: 'example.test',
      findTenant: (slug) => {
        seen.push(slug);
        return makeTenant({ slug });
      },
    });
    const context = { session: null };
    assert.equal((await resolver(new Request('http://Acme.Example.test/'), context))?.slug, 'acme');
    assert.equal(await resolver(new Request('http://example.test/'), context), null);
    assert.equal(await resolver(new Request('http://a.b.example.test/'), context), null);
    assert.equal(await resolver(new Request('http://acme.elsewhere.test/'), context), null);
    assert.deepEqual(seen, ['acme']);
  });
});
