/**
 * Tests for host matching: the vector table, root-domain validation and
 * normalisation, the policy hook, `*.localhost` development hosts, and the
 * seeded properties (a subdomain match always passes checkSlug; a host outside
 * the root is never a subdomain).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkSlug, slugPolicy } from '../src/slug-policy.js';
import { matchTenantHost, normalizeRootDomain } from '../src/tenant-host.js';
import { HOST_MATCH_VECTORS } from './naming-vectors.js';
import { seededPrng } from './seeded-prng.js';
import { thrownCode } from './thrown-code.js';

describe('matchTenantHost', () => {
  for (const [host, expected, why] of HOST_MATCH_VECTORS) {
    it(why, () => {
      assert.deepEqual(matchTenantHost(host, { rootDomain: 'example.com' }), expected);
    });
  }

  it('normalises the configured root domain', () => {
    assert.deepEqual(matchTenantHost('acme.example.com', { rootDomain: 'Example.COM.' }), {
      kind: 'subdomain',
      slug: 'acme',
    });
    assert.equal(normalizeRootDomain('Bücher.de'), 'xn--bcher-kva.de');
  });

  it('refuses a malformed root domain with invalid_root_domain', () => {
    for (const rootDomain of ['', '127.0.0.1', '*.example.com', 'a..b']) {
      assert.equal(
        thrownCode(() => matchTenantHost('acme.example.com', { rootDomain })),
        'invalid_root_domain',
      );
    }
  });

  it('serves development tenants under localhost (RFC 6761)', () => {
    assert.deepEqual(matchTenantHost('acme.localhost:3000', { rootDomain: 'localhost' }), {
      kind: 'subdomain',
      slug: 'acme',
    });
    assert.deepEqual(matchTenantHost('localhost:3000', { rootDomain: 'localhost' }), {
      kind: 'apex',
    });
  });

  it('applies the slug policy', () => {
    const policy = slugPolicy({ reserved: ['pricing'] });
    assert.deepEqual(
      matchTenantHost('pricing.example.com', { rootDomain: 'example.com', policy }),
      {
        kind: 'reserved',
        hostname: 'pricing.example.com',
      },
    );
  });

  it('upholds the subdomain and suffix properties over random hosts (seeded)', () => {
    const random = seededPrng(0x40f7);
    const labels = ['acme', 'www', 'a', 'x-y', 'A1', '12', 'xn--bcher-kva', 'ac--me', 'bücher'];
    const tails = ['example.com', 'EXAMPLE.com.', 'example.co', 'xexample.com', 'example.com.evil'];
    for (let i = 0; i < 4000; i += 1) {
      const depth = 1 + random.int(3);
      const parts = Array.from({ length: depth }, () => random.pick(labels));
      const tail = random.pick(tails);
      const port = random.int(3) === 0 ? `:${random.int(65536)}` : '';
      const host = `${parts.join('.')}.${tail}${port}`;
      const match = matchTenantHost(host, { rootDomain: 'example.com' });
      if (match.kind === 'subdomain') {
        assert.deepEqual(checkSlug(match.slug), { ok: true, slug: match.slug }, host);
        assert.equal(depth, 1, host);
        assert.ok(tail.toLowerCase().startsWith('example.com'), host);
      }
      const insideRoot = /^example\.com\.?$/i.test(tail);
      if (!insideRoot) {
        assert.notEqual(match.kind, 'subdomain', host);
        assert.notEqual(match.kind, 'reserved', host);
      }
    }
  });
});
