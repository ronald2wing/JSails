/**
 * Scenario tests for custom domains in the lifecycle: claiming (admission,
 * duplicates, the per-tenant limit), checking against a fake resolver
 * (verify, evict other tenants' pending claims, taken, pending, failing,
 * withdrawal and recovery, expiry without a lookup, stale results, DNS
 * timeouts), removal, the primary domain and the re-check sweep.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  auditActions,
  auditTrail,
  DAY,
  HOUR,
  lifecycleFixture,
  operator,
  system,
  tenantWith,
  user,
} from './lifecycle-fixture.js';
import { rejectedCode } from './thrown-code.js';

const HOST = 'shop.acme-corp.io';

describe('addDomain', () => {
  it('opens a pending claim and returns the record to publish', async () => {
    const { lifecycle, store, events, clock } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    events.length = 0;
    const { claim, challenge } = await lifecycle.addDomain(
      tenant.id,
      'Shop.Acme-Corp.io.',
      user('alice'),
    );
    assert.equal(claim.hostname, HOST);
    assert.equal(claim.verifiedHostname, null);
    assert.equal(claim.expiresAt?.getTime(), clock.now().getTime() + 7 * DAY);
    assert.equal(challenge.recordName, `_jsails-challenge.${HOST}`);
    assert.equal(challenge.recordValue, `token=${claim.token}`);
    assert.deepEqual(events, [
      { type: 'domain', tenantId: tenant.id, hostname: HOST, change: 'claimed' },
    ]);
    const last = (await auditTrail(store, tenant.id)).at(-1);
    assert.equal(last?.action, 'domain.claimed');
    assert.equal(last?.target, HOST);
  });

  it('refuses hostnames that cannot be claimed, duplicates and claims over the limit', async () => {
    const fixture = lifecycleFixture({ limits: () => ({ domains: 1 }) });
    const { lifecycle } = fixture;
    const tenant = await tenantWith(fixture, 'acme', 'alice', { carol: 'member' });
    const add = (hostname: string, by = user('alice')) =>
      lifecycle.addDomain(tenant.id, hostname, by);
    assert.equal(await rejectedCode(add('not a host')), 'invalid_hostname');
    assert.equal(await rejectedCode(add('localhost')), 'invalid_hostname');
    assert.equal(await rejectedCode(add('acme.tenancy-app.io')), 'reserved_hostname');
    assert.equal(await rejectedCode(add('shop.example.com')), 'reserved_hostname');
    assert.equal(await rejectedCode(add(HOST, user('carol'))), 'not_permitted');
    await add(HOST);
    assert.equal(await rejectedCode(add(HOST)), 'limit_exceeded');
    const roomy = lifecycleFixture();
    const other = await roomy.lifecycle.create({ name: 'B', slug: 'beta' }, user('bob'));
    await roomy.lifecycle.addDomain(other.id, HOST, user('bob'));
    assert.equal(
      await rejectedCode(roomy.lifecycle.addDomain(other.id, HOST, user('bob'))),
      'domain_claimed',
    );
  });
});

describe('domain limits and authorization', () => {
  it('caps a tenant at ten claims, pending ones included, by default', async () => {
    const { lifecycle } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    for (let index = 0; index < 10; index += 1) {
      await lifecycle.addDomain(tenant.id, `shop${index}.acme-corp.io`, user('alice'));
    }
    assert.equal(
      await rejectedCode(lifecycle.addDomain(tenant.id, 'shop10.acme-corp.io', user('alice'))),
      'limit_exceeded',
    );
    const lifted = lifecycleFixture({ limits: () => ({ domains: Number.POSITIVE_INFINITY }) });
    const other = await lifted.lifecycle.create({ name: 'B', slug: 'beta' }, user('bob'));
    for (let index = 0; index < 11; index += 1) {
      await lifted.lifecycle.addDomain(other.id, `shop${index}.beta-corp.io`, user('bob'));
    }
  });

  it('refuses an outsider with not_permitted whatever hostname they send', async () => {
    const fixture = lifecycleFixture();
    const tenant = await tenantWith(fixture, 'acme', 'alice', { carol: 'member' });
    const { lifecycle } = fixture;
    for (const by of [user('mallory'), user('carol')]) {
      for (const id of [tenant.id, 99]) {
        for (const hostname of ['-', 'acme.tenancy-app.io', 'localhost']) {
          assert.equal(await rejectedCode(lifecycle.addDomain(id, hostname, by)), 'not_permitted');
          assert.equal(
            await rejectedCode(lifecycle.removeDomain(id, hostname, by)),
            'not_permitted',
          );
          assert.equal(
            await rejectedCode(lifecycle.setPrimaryDomain(id, hostname, by)),
            'not_permitted',
          );
          assert.equal(
            await rejectedCode(lifecycle.checkDomain(id, hostname, by)),
            'not_permitted',
          );
        }
      }
    }
    const owner = user('alice');
    assert.equal(
      await rejectedCode(lifecycle.removeDomain(tenant.id, '-', owner)),
      'invalid_hostname',
    );
    assert.equal(
      await rejectedCode(lifecycle.setPrimaryDomain(tenant.id, '-', owner)),
      'invalid_hostname',
    );
  });
});

describe('checkDomain', () => {
  it('verifies a published record and evicts other tenants’ pending claims', async () => {
    const { lifecycle, store, dns, events } = lifecycleFixture();
    const acme = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const squat = await lifecycle.create({ name: 'Squat', slug: 'squat' }, user('mallory'));
    await lifecycle.addDomain(squat.id, HOST, user('mallory'));
    const { claim } = await lifecycle.addDomain(acme.id, HOST, user('alice'));
    dns.publish(HOST, claim.token);
    events.length = 0;
    const result = await lifecycle.checkDomain(acme.id, HOST, user('alice'));
    assert.equal(result.status, 'verified');
    assert.equal(result.action, 'verified');
    assert.equal(result.claim?.verifiedHostname, HOST);
    assert.equal((await store.tenantByVerifiedHostname(HOST))?.id, acme.id);
    assert.equal(await store.domainClaim(squat.id, HOST), null);
    const evicted = (await auditTrail(store, squat.id)).at(-1);
    assert.equal(evicted?.action, 'domain.removed');
    assert.deepEqual(evicted?.actor, { kind: 'system' });
    assert.equal((await auditActions(store, acme.id)).at(-1), 'domain.verified');
    assert.deepEqual(events, [
      { type: 'domain', tenantId: acme.id, hostname: HOST, change: 'verified' },
      { type: 'domain', tenantId: squat.id, hostname: HOST, change: 'removed' },
    ]);
  });

  it('does not accept another tenant’s token', async () => {
    const { lifecycle, dns } = lifecycleFixture();
    const acme = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const squat = await lifecycle.create({ name: 'Squat', slug: 'squat' }, user('mallory'));
    const theirs = await lifecycle.addDomain(squat.id, HOST, user('mallory'));
    await lifecycle.addDomain(acme.id, HOST, user('alice'));
    dns.publish(HOST, theirs.claim.token);
    const result = await lifecycle.checkDomain(acme.id, HOST, user('alice'));
    assert.equal(result.status, 'mismatch');
    assert.equal(result.action, 'pending');
    assert.equal(result.claim?.failures, 1);
  });

  it('keeps a claim pending when another tenant verified the hostname first', async () => {
    const { lifecycle, store, dns } = lifecycleFixture();
    const acme = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const beta = await lifecycle.create({ name: 'Beta', slug: 'beta' }, user('bob'));
    const first = await lifecycle.addDomain(beta.id, HOST, user('bob'));
    dns.publish(HOST, first.claim.token);
    await lifecycle.checkDomain(beta.id, HOST, user('bob'));
    const second = await lifecycle.addDomain(acme.id, HOST, user('alice'));
    dns.answer(`_jsails-challenge.${HOST}`, [[`token=${second.claim.token}`]]);
    const result = await lifecycle.checkDomain(acme.id, HOST, user('alice'));
    assert.equal(result.status, 'verified');
    assert.equal(result.action, 'taken');
    assert.equal(result.claim?.verifiedHostname, null);
    assert.equal((await store.tenantByVerifiedHostname(HOST))?.id, beta.id);
  });

  it('withdraws a verified claim only after enough failures over enough time, and recovers', async () => {
    const { lifecycle, store, dns, clock, events } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const { claim } = await lifecycle.addDomain(tenant.id, HOST, user('alice'));
    dns.publish(HOST, claim.token);
    await lifecycle.checkDomain(tenant.id, HOST, system());
    await lifecycle.setPrimaryDomain(tenant.id, HOST, user('alice'));
    assert.equal((await lifecycle.checkDomain(tenant.id, HOST, system())).action, 'still_verified');
    dns.withdraw(HOST);
    events.length = 0;
    assert.equal((await lifecycle.checkDomain(tenant.id, HOST, system())).action, 'failing');
    assert.equal((await lifecycle.checkDomain(tenant.id, HOST, system())).action, 'failing');
    assert.equal((await lifecycle.checkDomain(tenant.id, HOST, system())).action, 'failing');
    assert.equal((await store.tenantByVerifiedHostname(HOST))?.id, tenant.id);
    clock.advance(DAY);
    const withdrawn = await lifecycle.checkDomain(tenant.id, HOST, system());
    assert.equal(withdrawn.action, 'unverified');
    assert.equal(withdrawn.claim?.verifiedHostname, null);
    assert.equal(withdrawn.claim?.primary, false);
    assert.equal(await store.tenantByVerifiedHostname(HOST), null);
    assert.equal((await store.domainClaims(tenant.id)).filter((c) => c.primary).length, 0);
    const actions = await auditActions(store, tenant.id);
    assert.equal(actions.filter((action) => action === 'domain.failing').length, 1);
    assert.deepEqual(actions.slice(-2), ['domain.unverified', 'domain.primary_changed']);
    const trail = await auditTrail(store, tenant.id);
    assert.equal(trail.at(-1)?.target, null);
    assert.deepEqual(
      events.map((event) => (event.type === 'domain' ? event.change : event.type)),
      ['failing', 'unverified', 'primary'],
    );
    dns.publish(HOST, claim.token);
    assert.equal((await lifecycle.checkDomain(tenant.id, HOST, system())).action, 'verified');
  });

  it('deletes a lapsed pending claim without asking DNS', async () => {
    const { lifecycle, store, dns, clock } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    await lifecycle.addDomain(tenant.id, HOST, user('alice'));
    clock.advance(7 * DAY);
    const result = await lifecycle.checkDomain(tenant.id, HOST, system());
    assert.deepEqual(result, { status: 'absent', action: 'expired', claim: null });
    assert.deepEqual(dns.lookups, []);
    assert.equal(await store.domainClaim(tenant.id, HOST), null);
    assert.equal((await auditActions(store, tenant.id)).at(-1), 'domain.expired');
  });

  it('discards a result when the claim was re-issued during the lookup', async () => {
    const { lifecycle, dns } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const { claim } = await lifecycle.addDomain(tenant.id, HOST, user('alice'));
    dns.publish(HOST, claim.token);
    dns.onLookup = async () => {
      dns.onLookup = null;
      await lifecycle.removeDomain(tenant.id, HOST, user('alice'));
      await lifecycle.addDomain(tenant.id, HOST, user('alice'));
    };
    const result = await lifecycle.checkDomain(tenant.id, HOST, user('alice'));
    assert.equal(result.action, 'stale');
    assert.equal(result.claim?.verifiedHostname, null);
    assert.notEqual(result.claim?.token, claim.token);
  });

  it('reports a DNS timeout as a failed check', async () => {
    const { lifecycle, dns } = lifecycleFixture({ dnsTimeoutMs: 100 });
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    await lifecycle.addDomain(tenant.id, HOST, user('alice'));
    dns.onLookup = () => new Promise(() => undefined);
    const result = await lifecycle.checkDomain(tenant.id, HOST, system());
    assert.equal(result.status, 'timeout');
    assert.equal(result.action, 'pending');
    const aborted = new AbortController();
    aborted.abort();
    assert.equal(
      (await lifecycle.checkDomain(tenant.id, HOST, system(), aborted.signal)).status,
      'timeout',
    );
  });

  it('refuses unknown claims, bad hostnames and members without domains.manage', async () => {
    const fixture = lifecycleFixture();
    const tenant = await tenantWith(fixture, 'acme', 'alice', { carol: 'member' });
    const { lifecycle } = fixture;
    assert.equal(
      await rejectedCode(lifecycle.checkDomain(tenant.id, HOST, user('alice'))),
      'not_found',
    );
    assert.equal(
      await rejectedCode(lifecycle.checkDomain(tenant.id, '-', user('alice'))),
      'invalid_hostname',
    );
    await lifecycle.addDomain(tenant.id, HOST, user('alice'));
    assert.equal(
      await rejectedCode(lifecycle.checkDomain(tenant.id, HOST, user('carol'))),
      'not_permitted',
    );
    await lifecycle.checkDomain(tenant.id, HOST, operator('op'));
  });
});

describe('removeDomain and setPrimaryDomain', () => {
  it('removes a claim and refuses an unknown one', async () => {
    const { lifecycle, store, events } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    await lifecycle.addDomain(tenant.id, HOST, user('alice'));
    events.length = 0;
    await lifecycle.removeDomain(tenant.id, HOST, user('alice'));
    assert.equal(await store.domainClaim(tenant.id, HOST), null);
    assert.deepEqual(events, [
      { type: 'domain', tenantId: tenant.id, hostname: HOST, change: 'removed' },
    ]);
    assert.equal((await auditActions(store, tenant.id)).at(-1), 'domain.removed');
    assert.equal(
      await rejectedCode(lifecycle.removeDomain(tenant.id, HOST, user('alice'))),
      'not_found',
    );
  });

  it('makes only a verified claim primary, one at a time', async () => {
    const { lifecycle, store, dns, events } = lifecycleFixture();
    const tenant = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const owner = user('alice');
    const first = await lifecycle.addDomain(tenant.id, HOST, owner);
    const second = await lifecycle.addDomain(tenant.id, 'www.acme-corp.io', owner);
    assert.equal(
      await rejectedCode(lifecycle.setPrimaryDomain(tenant.id, HOST, owner)),
      'domain_unverified',
    );
    assert.equal(
      await rejectedCode(lifecycle.setPrimaryDomain(tenant.id, 'x.acme-corp.io', owner)),
      'not_found',
    );
    dns.publish(HOST, first.claim.token);
    dns.publish('www.acme-corp.io', second.claim.token);
    await lifecycle.checkDomain(tenant.id, HOST, owner);
    await lifecycle.checkDomain(tenant.id, 'www.acme-corp.io', owner);
    await lifecycle.setPrimaryDomain(tenant.id, HOST, owner);
    events.length = 0;
    await lifecycle.setPrimaryDomain(tenant.id, 'www.acme-corp.io', owner);
    assert.deepEqual(
      (await store.domainClaims(tenant.id)).map((claim) => [claim.hostname, claim.primary]),
      [
        [HOST, false],
        ['www.acme-corp.io', true],
      ],
    );
    assert.deepEqual(events, [
      { type: 'domain', tenantId: tenant.id, hostname: HOST, change: 'primary' },
      { type: 'domain', tenantId: tenant.id, hostname: 'www.acme-corp.io', change: 'primary' },
    ]);
    const before = (await auditActions(store, tenant.id)).length;
    await lifecycle.setPrimaryDomain(tenant.id, 'www.acme-corp.io', owner);
    assert.equal((await auditActions(store, tenant.id)).length, before);
    await lifecycle.setPrimaryDomain(tenant.id, null, owner);
    assert.ok((await store.domainClaims(tenant.id)).every((claim) => !claim.primary));
    assert.equal((await auditActions(store, tenant.id)).at(-1), 'domain.primary_changed');
  });
});

describe('recheckDomains', () => {
  it('checks the claims due, least recently checked first, and reports failures', async () => {
    const { lifecycle, dns, clock } = lifecycleFixture({ deletionRetentionMs: 0 });
    const acme = await lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    const gone = await lifecycle.create({ name: 'Gone', slug: 'gone' }, user('bob'));
    const { claim } = await lifecycle.addDomain(acme.id, HOST, user('alice'));
    await lifecycle.addDomain(gone.id, 'shop.gone-corp.io', user('bob'));
    dns.publish(HOST, claim.token);
    await lifecycle.scheduleDeletion(gone.id, user('bob'));
    await rejectedCode(
      lifecycle.purge(gone.id, system(), async () => {
        throw new Error('stuck');
      }),
    );
    const report = await lifecycle.recheckDomains();
    assert.equal(report.checked.length, 1);
    assert.equal(report.checked[0]?.action, 'verified');
    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0]?.tenantId, gone.id);
    assert.equal((await lifecycle.recheckDomains()).checked.length, 0);
    await lifecycle.purge(gone.id, system(), async () => undefined);
    clock.advance(DAY + HOUR);
    assert.equal(
      (await lifecycle.recheckDomains({ limit: 1 })).checked[0]?.action,
      'still_verified',
    );
    assert.equal(
      await rejectedCode(lifecycle.recheckDomains({ limit: 0 })),
      'invalid_lifecycle_options',
    );
    const stopped = new AbortController();
    stopped.abort();
    clock.advance(2 * DAY);
    assert.equal((await lifecycle.recheckDomains({ signal: stopped.signal })).checked.length, 0);
  });
});
