/**
 * Tests for `security/request-origin.ts`: the host allowlist (421), the client
 * address under each trusted-proxy setting, buckets, header canonicalization,
 * config validation, the `JSAILS_TRUSTED_PROXIES` parser and writer, and the
 * observer a policy can carry.
 *
 * The property cases draw from a seeded generator, so a failure reproduces
 * from its seed and iteration number.
 */

import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, type TestContext } from 'node:test';

import type { Hono } from 'hono';

import { publicAccess } from '../../src/api/access-ref.js';
import { createApp, type AppOptions } from '../../src/server/app.js';
import { currentRequestFrame } from '../../src/server/current-frame.js';
import type { AppEnv } from '../../src/server/env.js';
import { createHttpRoutes } from '../../src/server/http-routes.js';
import { createHttpServer } from '../../src/server/http-server.js';

import {
  canonicalizeForwardingHeaders,
  clientAddressOf,
  createOriginPolicy,
  formatTrustedProxies,
  observeRequestOrigins,
  parseTrustedProxies,
  RequestOriginConfigError,
  resolveRequestOrigin,
  sameTrustedProxies,
  type ClientAddress,
  type OriginPolicy,
  type RequestOriginResult,
  type ResolvedRequestOrigin,
  type RequestOriginInput,
  type ServerOriginConfig,
  type TrustedProxies,
} from '../../src/security/request-origin.js';

/** The peer every case uses unless it passes one; `null` means an in-process request. */
const PEER = '203.0.113.10';

function resolve(
  policy: OriginPolicy,
  url: string,
  headers: Record<string, string> = {},
  peer: string | null = PEER,
): RequestOriginResult {
  return resolveRequestOrigin(
    { peer: peer ?? undefined, url: new URL(url), headers: new Headers(headers) },
    policy,
  );
}

function ipOf(client: ClientAddress): string {
  assert.notEqual(client.via, 'unknown');
  return client.via === 'unknown' ? '' : client.ip;
}

function served(result: RequestOriginResult): ResolvedRequestOrigin {
  assert.ok(!('refused' in result), 'the request was refused');
  return result;
}

function clientOf(
  config: ServerOriginConfig,
  headers: Record<string, string>,
  peer: string | null = PEER,
): ClientAddress {
  return served(resolve(createOriginPolicy(config), 'http://localhost/', headers, peer)).client;
}

/** A small deterministic PRNG (mulberry32), so property failures reproduce. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}

function randomIpv4(random: () => number): string {
  return Array.from({ length: 4 }, () => Math.floor(random() * 256)).join('.');
}

function randomIpv6(random: () => number): string {
  return Array.from({ length: 8 }, () => Math.floor(random() * 65536).toString(16)).join(':');
}

const GARBAGE = [
  '',
  'unknown',
  '_hidden',
  '999.1.1.1',
  '1.2.3',
  'not an ip',
  '::g',
  '[::1',
  'x'.repeat(300),
  '1.2.3.4, , ,',
  ',,,',
];

function randomHeaderValue(random: () => number): string {
  const parts = Array.from({ length: 1 + Math.floor(random() * 4) }, () =>
    pick(random, [randomIpv4(random), randomIpv6(random), pick(random, GARBAGE)]),
  );
  return parts.join(pick(random, [',', ', ', ' ,']));
}

describe('resolveRequestOrigin: hosts', () => {
  const policy = createOriginPolicy({
    origin: 'https://example.com',
    hosts: ['*.example.com', 'example.org:8443', 'alias.example.net'],
  });

  it('serves the canonical host as the configured origin, whatever the request scheme', () => {
    for (const url of ['http://example.com/', 'https://example.com/x', 'http://example.com:443/']) {
      assert.deepEqual(served(resolve(policy, url)).origin, {
        origin: 'https://example.com',
        host: 'example.com',
        canonical: true,
      });
    }
  });

  it('serves an allowed host as its own origin with the canonical scheme', () => {
    assert.deepEqual(served(resolve(policy, 'http://acme.example.com/')).origin, {
      origin: 'https://acme.example.com',
      host: 'acme.example.com',
      canonical: false,
    });
    assert.deepEqual(served(resolve(policy, 'http://example.org:8443/')).origin, {
      origin: 'https://example.org:8443',
      host: 'example.org:8443',
      canonical: false,
    });
    assert.equal(
      served(resolve(policy, 'http://alias.example.net/')).origin.origin,
      'https://alias.example.net',
    );
  });

  it('answers 421 for every other host', () => {
    for (const url of [
      'http://evil.example/',
      'http://a.b.example.com/',
      'http://example.com.evil.example/',
      'http://evilexample.com/',
      'http://example.org/',
      'http://example.org:9443/',
      'http://example.com:8080/',
      'http://127.0.0.1/',
      'http://[::1]/',
      'http://localhost:3000/',
    ]) {
      assert.deepEqual(resolve(policy, url), { refused: 421 }, url);
    }
  });

  it('resolves a probe for any host to the canonical origin, and only a probe', () => {
    for (const url of [
      'http://127.0.0.1:3000/up',
      'http://web-1:3000/up',
      'http://evil.example/',
    ]) {
      const probe = resolveRequestOrigin(
        { peer: PEER, url: new URL(url), headers: new Headers(), probe: true },
        policy,
      );
      assert.deepEqual(served(probe).origin, {
        origin: 'https://example.com',
        host: 'example.com',
        canonical: true,
      });
      assert.deepEqual(
        resolveRequestOrigin(
          { peer: PEER, url: new URL(url), headers: new Headers(), probe: false },
          policy,
        ),
        { refused: 421 },
      );
    }
    // An allowed alias keeps its own origin when probed.
    const alias = resolveRequestOrigin(
      {
        peer: PEER,
        url: new URL('http://acme.example.com/up'),
        headers: new Headers(),
        probe: true,
      },
      policy,
    );
    assert.equal(served(alias).origin.origin, 'https://acme.example.com');
  });

  it("serves a pattern without a port on the origin's port", () => {
    const dev = createOriginPolicy({ origin: 'http://localhost:3000', hosts: ['*.localhost'] });
    assert.deepEqual(served(resolve(dev, 'http://acme.localhost:3000/')).origin, {
      origin: 'http://acme.localhost:3000',
      host: 'acme.localhost:3000',
      canonical: false,
    });
    assert.deepEqual(resolve(dev, 'http://acme.localhost/'), { refused: 421 });
    assert.deepEqual(resolve(dev, 'http://acme.localhost:4000/'), { refused: 421 });
    assert.deepEqual(resolve(dev, 'http://a.b.localhost:3000/'), { refused: 421 });
    // A default port written out is the same as none.
    const explicit = createOriginPolicy({
      origin: 'https://example.com',
      hosts: ['example.org:443'],
    });
    assert.equal(
      served(resolve(explicit, 'http://example.org/')).origin.origin,
      'https://example.org',
    );
    assert.equal(
      served(resolve(explicit, 'http://example.org:443/')).origin.origin,
      'https://example.org',
    );
    assert.deepEqual(resolve(explicit, 'http://example.org:8443/'), { refused: 421 });
  });

  it('never reads X-Forwarded-Host or Forwarded for the host', () => {
    const headers = {
      'x-forwarded-host': 'example.com',
      forwarded: 'host=example.com;proto=https',
    };
    assert.deepEqual(resolve(policy, 'http://evil.example/', headers), { refused: 421 });
  });

  it('accepts every host as its own origin when no origin is configured', () => {
    const open = createOriginPolicy();
    assert.deepEqual(served(resolve(open, 'http://anything.test:3000/')).origin, {
      origin: 'http://anything.test:3000',
      host: 'anything.test:3000',
      canonical: false,
    });
    assert.equal(
      served(resolve(open, 'https://secure.test/')).origin.origin,
      'https://secure.test',
    );
  });

  it('takes an allowed host scheme from a trusted proxy only', () => {
    const trusted = createOriginPolicy({
      origin: 'https://example.com',
      hosts: ['*.example.com'],
      trustedProxies: { hops: 1 },
    });
    const via = (proto: string, chain = '198.51.100.7'): string =>
      served(
        resolve(trusted, 'http://acme.example.com/', {
          'x-forwarded-proto': proto,
          'x-forwarded-for': chain,
        }),
      ).origin.origin;
    assert.equal(via('http'), 'http://acme.example.com');
    assert.equal(via('HTTPS'), 'https://acme.example.com');
    assert.equal(via('gopher'), 'https://acme.example.com');
    // A chain too short for the hop count is not a trusted hop.
    assert.equal(via('http', ''), 'https://acme.example.com');
    // The canonical host is always the configured origin.
    assert.equal(
      served(
        resolve(trusted, 'http://example.com/', {
          'x-forwarded-proto': 'http',
          'x-forwarded-for': '198.51.100.7',
        }),
      ).origin.origin,
      'https://example.com',
    );
    // Without trust the header is ignored.
    const untrusted = createOriginPolicy({
      origin: 'https://example.com',
      hosts: ['*.example.com'],
    });
    assert.equal(
      served(resolve(untrusted, 'http://acme.example.com/', { 'x-forwarded-proto': 'http' })).origin
        .origin,
      'https://acme.example.com',
    );
  });
});

describe('resolveRequestOrigin: client address', () => {
  it("uses the socket peer and reads no header with trustedProxies 'none'", () => {
    assert.deepEqual(clientOf({}, { 'x-forwarded-for': '198.51.100.7' }), {
      via: 'socket',
      ip: '203.0.113.10',
      bucket: '203.0.113.10',
    });
    assert.deepEqual(clientOf({}, {}, null), { via: 'unknown', bucket: 'unknown' });
    assert.deepEqual(clientOf({}, {}, 'garbage'), { via: 'unknown', bucket: 'unknown' });
  });

  it('takes the n-th entry from the right with { hops: n }', () => {
    // forwardHeaders off: the proxy replaces the chain with the address it saw.
    assert.deepEqual(
      clientOf({ trustedProxies: { hops: 1 } }, { 'x-forwarded-for': '198.51.100.7' }),
      {
        via: 'forwarded',
        ip: '198.51.100.7',
        bucket: '198.51.100.7',
      },
    );
    // forwardHeaders on: the proxy appends to whatever the client sent.
    assert.equal(
      clientOf({ trustedProxies: { hops: 1 } }, { 'x-forwarded-for': '6.6.6.6, 198.51.100.7' })
        .bucket,
      '198.51.100.7',
    );
    assert.equal(
      clientOf(
        { trustedProxies: { hops: 2 } },
        { 'x-forwarded-for': 'spoof, 6.6.6.6, 198.51.100.7, 10.0.0.2' },
      ).bucket,
      '198.51.100.7',
    );
    // Repeated headers are one chain.
    const headers = new Headers();
    headers.append('x-forwarded-for', '6.6.6.6');
    headers.append('x-forwarded-for', '198.51.100.8');
    const result = resolveRequestOrigin(
      { peer: '10.0.0.1', url: new URL('http://localhost/'), headers },
      createOriginPolicy({ trustedProxies: { hops: 1 } }),
    );
    assert.equal(served(result).client.bucket, '198.51.100.8');
  });

  it('falls back to the peer and reports a short chain or a malformed entry', () => {
    const policy = createOriginPolicy({ trustedProxies: { hops: 2 } });
    const short = served(
      resolve(policy, 'http://localhost/', { 'x-forwarded-for': '198.51.100.7' }),
    );
    assert.equal(short.client.via, 'socket');
    assert.equal(short.anomaly, 'short_chain');
    const none = served(resolve(policy, 'http://localhost/'));
    assert.equal(none.anomaly, 'short_chain');
    const malformed = served(
      resolve(policy, 'http://localhost/', {
        'x-forwarded-for': '198.51.100.7, unknown, 10.0.0.2',
      }),
    );
    assert.equal(malformed.client.via, 'socket');
    assert.equal(malformed.anomaly, 'malformed_forwarded');
    // Garbage left of the client's entry is the client's own and changes nothing.
    const leftGarbage = served(
      resolve(policy, 'http://localhost/', {
        'x-forwarded-for': 'unknown, 198.51.100.7, 10.0.0.2',
      }),
    );
    assert.equal(leftGarbage.client.bucket, '198.51.100.7');
    assert.equal(leftGarbage.anomaly, undefined);
  });

  it('walks past trusted ranges with { cidrs }, only behind a trusted peer', () => {
    const config: ServerOriginConfig = { trustedProxies: { cidrs: ['10.0.0.0/8', 'fd00::/8'] } };
    const chain = { 'x-forwarded-for': '6.6.6.6, 198.51.100.7, 10.1.2.3, fd00::5' };
    assert.deepEqual(clientOf(config, chain, '10.0.0.1'), {
      via: 'forwarded',
      ip: '198.51.100.7',
      bucket: '198.51.100.7',
    });
    // A peer outside the ranges is the client; its headers are not read.
    assert.equal(clientOf(config, chain, '203.0.113.10').bucket, '203.0.113.10');
    // An IPv4-mapped peer is matched in its IPv4 form.
    assert.equal(clientOf(config, chain, '::ffff:10.0.0.1').bucket, '198.51.100.7');
    // Every hop trusted: the left-most address; no chain at all: the peer.
    assert.equal(
      clientOf(config, { 'x-forwarded-for': '10.9.9.9, 10.1.1.1' }, '10.0.0.1').bucket,
      '10.9.9.9',
    );
    assert.equal(clientOf(config, {}, '10.0.0.1').bucket, '10.0.0.1');
    // A malformed entry before an untrusted one falls back to the peer.
    const malformed = served(
      resolve(
        createOriginPolicy(config),
        'http://localhost/',
        { 'x-forwarded-for': '198.51.100.7, nope' },
        '10.0.0.1',
      ),
    );
    assert.equal(malformed.client.bucket, '10.0.0.1');
    assert.equal(malformed.anomaly, 'malformed_forwarded');
  });

  it('trusts the nearest proxies by position, then upstream ranges, with { hops, cidrs }', () => {
    // kamal-proxy (one hop, by position) keeps the chain a CDN in front of it
    // wrote; the CDN connects from 173.245.48.0/20. The peer is kamal-proxy's
    // container address, which no range lists.
    const config: ServerOriginConfig = {
      trustedProxies: { hops: 1, cidrs: ['173.245.48.0/20', '2400:cb00::/32'] },
    };
    const kamal = '172.18.0.3';
    const through = (chain: string): ClientAddress =>
      clientOf(config, { 'x-forwarded-for': chain }, kamal);
    // Through the CDN: the entry the CDN appended.
    assert.deepEqual(through('198.51.100.7, 173.245.48.9'), {
      via: 'forwarded',
      ip: '198.51.100.7',
      bucket: '198.51.100.7',
    });
    assert.equal(through('6.6.6.6, 198.51.100.7, 2400:cb00::1').bucket, '198.51.100.7');
    // Around the CDN, straight to kamal-proxy: the address kamal-proxy saw,
    // whatever chain the client wrote in front of it.
    assert.equal(through('198.51.100.7, 203.0.113.9').bucket, '203.0.113.9');
    assert.equal(through('173.245.48.9, 203.0.113.9').bucket, '203.0.113.9');
    // Every entry inside the ranges: the left-most.
    assert.equal(through('173.245.48.1, 173.245.48.9').bucket, '173.245.48.1');
    // With the cache proxy, two hops by position before the ranges.
    assert.equal(
      clientOf(
        { trustedProxies: { hops: 2, cidrs: ['173.245.48.0/20'] } },
        { 'x-forwarded-for': '198.51.100.7, 173.245.48.9, 172.18.0.3' },
        '172.18.0.5',
      ).bucket,
      '198.51.100.7',
    );
    // A chain shorter than the hops, or a malformed entry on the walk, falls
    // back to the peer and says so.
    const at = (chain: string): ResolvedRequestOrigin =>
      served(
        resolve(
          createOriginPolicy({ trustedProxies: { hops: 2, cidrs: ['173.245.48.0/20'] } }),
          'http://localhost/',
          { 'x-forwarded-for': chain },
          kamal,
        ),
      );
    assert.equal(at('198.51.100.7').anomaly, 'short_chain');
    assert.equal(at('198.51.100.7').trustedPeer, false);
    assert.equal(at('nope, 173.245.48.9, 172.18.0.3').anomaly, 'malformed_forwarded');
    assert.equal(at('nope, 173.245.48.9, 172.18.0.3').client.bucket, kamal);
    assert.equal(at('198.51.100.7, 173.245.48.9, 172.18.0.3').trustedPeer, true);
  });

  it('keys a login sent around the CDN on its sender, under the setting a deploy states', () => {
    // jamal states kamal-proxy by position and the CDN by its ranges.
    const policy = createOriginPolicy({
      trustedProxies: parseTrustedProxies('hops=1,173.245.48.0/20,2400:cb00::/32'),
    });
    const loginFrom = (chain: string): string =>
      ipOf(
        served(
          resolve(policy, 'http://localhost/api/login', { 'x-forwarded-for': chain }, '172.18.0.3'),
        ).client,
      );
    // Straight to kamal-proxy with a fresh forged address each time: one bucket.
    for (const forged of ['198.51.100.1', '198.51.100.2', '173.245.48.9', '10.0.0.1']) {
      assert.equal(loginFrom(`${forged}, 203.0.113.66`), '203.0.113.66');
    }
    // Through the CDN: the address the CDN appended.
    assert.equal(loginFrom('198.51.100.1, 203.0.113.66, 173.245.48.9'), '203.0.113.66');
  });

  it('property: with { hops, cidrs } a client outside the ranges cannot name another address', () => {
    const random = generator(0x5ec3);
    const cidrs = ['173.245.48.0/20'];
    for (let i = 0; i < 1000; i += 1) {
      const hops = 1 + Math.floor(random() * 2);
      const policy = createOriginPolicy({ trustedProxies: { hops, cidrs } });
      // The client's real address, as the outermost positional proxy appended it.
      const client = `203.0.113.${1 + Math.floor(random() * 254)}`;
      const proxies = Array.from({ length: hops - 1 }, () => randomIpv4(random));
      const forged = Array.from({ length: Math.floor(random() * 4) }, () =>
        pick(random, [randomIpv4(random), `173.245.48.${Math.floor(random() * 256)}`]),
      );
      const chain = [...forged, client, ...proxies].join(', ');
      const result = served(resolve(policy, 'http://localhost/', { 'x-forwarded-for': chain }));
      assert.equal(ipOf(result.client), client, `iteration ${i}`);
    }
  });

  it('reports whether the immediate peer is a trusted proxy, apart from the client address', () => {
    const at = (
      config: ServerOriginConfig,
      headers: Record<string, string>,
      peer: string | null = PEER,
    ): ResolvedRequestOrigin =>
      served(resolve(createOriginPolicy(config), 'http://localhost/', headers, peer));
    const cidrs: ServerOriginConfig = { trustedProxies: { cidrs: ['10.0.0.0/8'] } };
    const chain = { 'x-forwarded-for': '198.51.100.7' };

    // A trusted peer that sent no chain is its own client and still trusted.
    const bare = at(cidrs, {}, '10.0.0.1');
    assert.equal(bare.client.via, 'socket');
    assert.equal(bare.trustedPeer, true);
    assert.equal(at(cidrs, chain, '10.0.0.1').trustedPeer, true);
    assert.equal(at(cidrs, { 'x-forwarded-for': 'nope' }, '10.0.0.1').trustedPeer, true);
    // A peer outside the ranges is never trusted, whatever chain it claims.
    assert.equal(at(cidrs, {}, '203.0.113.10').trustedPeer, false);
    assert.equal(at(cidrs, { 'x-forwarded-for': '10.1.1.1' }, '203.0.113.10').trustedPeer, false);
    assert.equal(at(cidrs, {}, null).trustedPeer, false);

    // { hops }: trusted exactly when the chain is long enough to name the client.
    assert.equal(at({ trustedProxies: { hops: 1 } }, chain).trustedPeer, true);
    assert.equal(at({ trustedProxies: { hops: 2 } }, chain).trustedPeer, false);
    assert.equal(
      at({ trustedProxies: { hops: 1 } }, { 'x-forwarded-for': 'x' }).trustedPeer,
      false,
    );

    // 'none': no peer is trusted.
    assert.equal(at({}, chain, '10.0.0.1').trustedPeer, false);
  });

  it('normalizes ports, brackets, zone ids, and mapped addresses', () => {
    const hop = (entry: string): ClientAddress =>
      clientOf({ trustedProxies: { hops: 1 } }, { 'x-forwarded-for': entry });
    assert.deepEqual(hop('198.51.100.7:51234'), {
      via: 'forwarded',
      ip: '198.51.100.7',
      bucket: '198.51.100.7',
    });
    assert.deepEqual(hop('[2001:DB8:1:2::7]:443'), {
      via: 'forwarded',
      ip: '2001:db8:1:2::7',
      bucket: '2001:db8:1:2::/64',
    });
    assert.equal(ipOf(hop('fe80::1%eth0')), 'fe80::1');
    assert.deepEqual(hop('::ffff:192.0.2.1'), {
      via: 'forwarded',
      ip: '192.0.2.1',
      bucket: '192.0.2.1',
    });
    assert.equal(ipOf(hop('2001:0db8:0000:0000:0000:0000:0000:0001')), '2001:db8::1');
    assert.equal(hop('::').bucket, '::/64');
    for (const garbage of ['999.1.1.1', '1.2.3', '[::1', '::g', 'unknown', '1.2.3.4:99999']) {
      assert.equal(hop(garbage).via, 'socket', garbage);
    }
    assert.equal(clientAddressOf('  198.51.100.7 ', 'socket')?.bucket, '198.51.100.7');
    assert.equal(clientAddressOf('nope', 'socket'), undefined);
  });

  it('puts every address of one /64 in one bucket', () => {
    const random = generator(0x5ec02);
    const buckets = new Set<string>();
    const ips = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const host = Array.from({ length: 4 }, () => Math.floor(random() * 65536).toString(16));
      const client = clientOf({}, {}, `2001:db8:abcd:12:${host.join(':')}`);
      buckets.add(client.bucket);
      ips.add(ipOf(client));
    }
    assert.deepEqual([...buckets], ['2001:db8:abcd:12::/64']);
    assert.ok(ips.size > 490, 'the addresses themselves stay distinct');
    // A neighbouring /64 is a different bucket.
    assert.equal(clientOf({}, {}, '2001:db8:abcd:13::1').bucket, '2001:db8:abcd:13::/64');
  });

  it("property: with trustedProxies 'none' the result never depends on headers", () => {
    const random = generator(0x0091);
    const policy = createOriginPolicy({ origin: 'https://example.com', hosts: ['*.example.com'] });
    for (let i = 0; i < 2000; i += 1) {
      const peer = pick(random, [randomIpv4(random), randomIpv6(random), null, 'garbage']);
      const url = pick(random, [
        'http://example.com/',
        'http://acme.example.com/a',
        'http://evil.example/',
      ]);
      const baseline = resolve(policy, url, {}, peer);
      const headers: Record<string, string> = {};
      for (const name of [
        'x-forwarded-for',
        'forwarded',
        'x-real-ip',
        'x-forwarded-proto',
        'x-forwarded-host',
      ]) {
        if (random() < 0.7) headers[name] = randomHeaderValue(random);
      }
      const withHeaders = resolve(policy, url, headers, peer);
      if ('refused' in baseline || 'refused' in withHeaders) {
        assert.deepEqual(withHeaders, baseline, `iteration ${i}`);
        continue;
      }
      assert.deepEqual(withHeaders.client, baseline.client, `iteration ${i}`);
      assert.deepEqual(withHeaders.origin, baseline.origin, `iteration ${i}`);
      assert.equal(withHeaders.anomaly, undefined);
    }
  });

  it('property: with { hops: n } nothing left of the client entry matters', () => {
    const random = generator(0x40b5);
    for (let i = 0; i < 1000; i += 1) {
      const hops = 1 + Math.floor(random() * 3);
      const policy = createOriginPolicy({ trustedProxies: { hops } });
      const client = pick(random, [randomIpv4(random), randomIpv6(random)]);
      const proxies = Array.from({ length: hops - 1 }, () => randomIpv4(random));
      const tail = [client, ...proxies].join(', ');
      const prefix = randomHeaderValue(random);
      const plain = served(resolve(policy, 'http://localhost/', { 'x-forwarded-for': tail }));
      const spoofed = served(
        resolve(policy, 'http://localhost/', { 'x-forwarded-for': `${prefix}, ${tail}` }),
      );
      assert.equal(plain.client.via, 'forwarded', `iteration ${i}`);
      assert.deepEqual(spoofed.client, plain.client, `iteration ${i}`);
    }
  });
});

describe('canonicalizeForwardingHeaders', () => {
  const ORIGIN = { origin: 'https://example.com', host: 'example.com', canonical: true };

  function resolvedFor(client: ClientAddress, origin = ORIGIN): ResolvedRequestOrigin {
    return { client, origin, relayed: true, trustedPeer: true };
  }

  it('leaves one X-Forwarded-For with the client and drops Forwarded, X-Real-IP, and X-Forwarded-Host', () => {
    const headers = new Headers({
      'x-forwarded-for': '6.6.6.6, 198.51.100.7',
      forwarded: 'for=6.6.6.6;host=evil.example',
      'x-real-ip': '6.6.6.6',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
    });
    canonicalizeForwardingHeaders(
      headers,
      resolvedFor({ via: 'forwarded', ip: '198.51.100.7', bucket: '198.51.100.7' }),
    );
    assert.equal(headers.get('x-forwarded-for'), '198.51.100.7');
    assert.equal(headers.has('forwarded'), false);
    assert.equal(headers.has('x-real-ip'), false);
    assert.equal(headers.has('x-forwarded-host'), false);
    assert.equal(headers.get('x-forwarded-proto'), 'https');
  });

  it('makes a sent X-Forwarded-Proto agree with the resolved origin, and adds none', () => {
    const spoofed = new Headers({ 'x-forwarded-proto': 'http, https' });
    canonicalizeForwardingHeaders(
      spoofed,
      resolvedFor({ via: 'socket', ip: '127.0.0.1', bucket: '127.0.0.1' }),
    );
    assert.equal(spoofed.get('x-forwarded-proto'), 'https');
    const plain = new Headers({ 'x-forwarded-proto': 'https' });
    canonicalizeForwardingHeaders(
      plain,
      resolvedFor(
        { via: 'socket', ip: '127.0.0.1', bucket: '127.0.0.1' },
        { origin: 'http://localhost:3000', host: 'localhost:3000', canonical: false },
      ),
    );
    assert.equal(plain.get('x-forwarded-proto'), 'http');
    const none = new Headers();
    canonicalizeForwardingHeaders(
      none,
      resolvedFor({ via: 'socket', ip: '127.0.0.1', bucket: '127.0.0.1' }),
    );
    assert.equal(none.has('x-forwarded-proto'), false);
  });

  it('removes X-Forwarded-For for an unknown client and sets it for a socket peer', () => {
    const unknown = new Headers({ 'x-forwarded-for': '6.6.6.6' });
    canonicalizeForwardingHeaders(unknown, resolvedFor({ via: 'unknown', bucket: 'unknown' }));
    assert.equal(unknown.has('x-forwarded-for'), false);
    const socket = new Headers();
    canonicalizeForwardingHeaders(
      socket,
      resolvedFor({ via: 'socket', ip: '::1', bucket: '::/64' }),
    );
    assert.equal(socket.get('x-forwarded-for'), '::1');
  });
});

describe('createOriginPolicy: validation', () => {
  it('rejects bad values with a value-free error naming the field', () => {
    for (const [config, code, field] of [
      [{ origin: 'https://user:secret@example.com' }, 'invalid_origin', 'origin'],
      [{ origin: 'https://example.com/secret' }, 'invalid_origin', 'origin'],
      [{ origin: 42 }, 'invalid_origin', 'origin'],
      [{ hosts: ['example.org'] }, 'hosts_without_origin', 'hosts'],
      [{ origin: 'https://example.com', hosts: ['*.com'] }, 'invalid_host_pattern', 'hosts'],
      [{ origin: 'https://example.com', hosts: ['*.10.0.0.1'] }, 'invalid_host_pattern', 'hosts'],
      [{ origin: 'https://example.com', hosts: ['*.secret'] }, 'invalid_host_pattern', 'hosts'],
      [
        { origin: 'https://example.com', hosts: ['secret.example/x'] },
        'invalid_host_pattern',
        'hosts',
      ],
      [
        { origin: 'https://example.com', hosts: ['user@secret.example'] },
        'invalid_host_pattern',
        'hosts',
      ],
      [
        { origin: 'https://example.com', hosts: ['**.example.com'] },
        'invalid_host_pattern',
        'hosts',
      ],
      [{ origin: 'https://example.com', hosts: [''] }, 'invalid_host_pattern', 'hosts'],
      [{ origin: 'https://example.com', hosts: 'example.org' }, 'invalid_host_pattern', 'hosts'],
      [{ trustedProxies: { hops: 0 } }, 'invalid_trusted_proxies', 'trustedProxies'],
      [{ trustedProxies: { hops: 17 } }, 'invalid_trusted_proxies', 'trustedProxies'],
      [{ trustedProxies: { cidrs: ['10.0.0.0/33'] } }, 'invalid_trusted_proxies', 'trustedProxies'],
      [{ trustedProxies: { cidrs: ['secret/8'] } }, 'invalid_trusted_proxies', 'trustedProxies'],
      [{ trustedProxies: { cidrs: ['fd00::/129'] } }, 'invalid_trusted_proxies', 'trustedProxies'],
      [{ trustedProxies: 'all' }, 'invalid_trusted_proxies', 'trustedProxies'],
      [{ trustedProxies: 1 }, 'invalid_trusted_proxies', 'trustedProxies'],
      [{ trustedProxies: { hops: 1, cidrs: [] } }, 'invalid_trusted_proxies', 'trustedProxies'],
      [
        { trustedProxies: { hops: 0, cidrs: ['10.0.0.0/8'] } },
        'invalid_trusted_proxies',
        'trustedProxies',
      ],
      [
        { trustedProxies: { hops: 1, cidrs: ['secret'] } },
        'invalid_trusted_proxies',
        'trustedProxies',
      ],
      [
        { trustedProxies: { hops: 1, cidrs: ['10.0.0.0/8'], secret: 1 } },
        'invalid_trusted_proxies',
        'trustedProxies',
      ],
      [{ trustedProxies: {} }, 'invalid_trusted_proxies', 'trustedProxies'],
    ] as const) {
      assert.throws(
        () => createOriginPolicy(config as unknown as ServerOriginConfig),
        (error: unknown) =>
          error instanceof RequestOriginConfigError &&
          error.code === code &&
          error.field === field &&
          !error.message.includes('secret'),
        JSON.stringify(config),
      );
    }
  });

  it('freezes the policy and refuses one it did not build', () => {
    const policy = createOriginPolicy({ origin: 'https://Example.com', hosts: ['*.example.com'] });
    assert.ok(Object.isFrozen(policy));
    assert.equal(policy.origin, 'https://example.com');
    assert.deepEqual(policy.hosts, ['*.example.com']);
    assert.equal(policy.trustedProxies, 'none');
    assert.throws(
      () =>
        resolveRequestOrigin(
          { peer: undefined, url: new URL('http://example.com/'), headers: new Headers() },
          { ...policy },
        ),
      TypeError,
    );
  });
});

describe('parseTrustedProxies', () => {
  it('parses none, hops, CIDR lists, and hops followed by a CIDR list', () => {
    assert.equal(parseTrustedProxies('none'), 'none');
    assert.deepEqual(parseTrustedProxies(' hops=2 '), { hops: 2 });
    assert.deepEqual(parseTrustedProxies('10.0.0.0/8, 192.0.2.1'), {
      cidrs: ['10.0.0.0/8', '192.0.2.1'],
    });
    assert.deepEqual(parseTrustedProxies('hops=1,173.245.48.0/20, 2400:cb00::/32'), {
      hops: 1,
      cidrs: ['173.245.48.0/20', '2400:cb00::/32'],
    });
  });

  it('rejects anything else without echoing it', () => {
    for (const value of [
      '',
      '1',
      'hops=0',
      'hops=99',
      'hops=x',
      'cidrs=10.0.0.0/8',
      'secret, value',
      'hops=1,',
      'hops=1,hops=2',
      '10.0.0.0/8,hops=1',
      'hops=1,secret',
    ]) {
      assert.throws(
        () => parseTrustedProxies(value),
        (error: unknown) =>
          error instanceof RequestOriginConfigError &&
          error.message.startsWith('JSAILS_TRUSTED_PROXIES must be') &&
          !error.message.includes('secret'),
        value,
      );
    }
  });

  it('compares settings by meaning', () => {
    assert.ok(sameTrustedProxies({ hops: 1 }, { hops: 1 }));
    assert.ok(!sameTrustedProxies({ hops: 1 }, 'none'));
    assert.ok(sameTrustedProxies({ cidrs: ['10.0.0.0/8'] }, { cidrs: ['10.0.0.0/8'] }));
    assert.ok(!sameTrustedProxies({ cidrs: ['10.0.0.0/8'] }, { hops: 1 }));
    const combined = { hops: 1, cidrs: ['10.0.0.0/8'] };
    assert.ok(sameTrustedProxies(combined, { hops: 1, cidrs: ['10.0.0.0/8'] }));
    assert.ok(!sameTrustedProxies(combined, { hops: 1 }));
    assert.ok(!sameTrustedProxies(combined, { cidrs: ['10.0.0.0/8'] }));
    assert.ok(!sameTrustedProxies(combined, { hops: 2, cidrs: ['10.0.0.0/8'] }));
  });
});

describe('formatTrustedProxies', () => {
  it('writes every setting as the value parseTrustedProxies reads back', () => {
    for (const [trust, text] of [
      ['none', 'none'],
      [{ hops: 2 }, 'hops=2'],
      [{ cidrs: ['10.0.0.0/8', 'fd00::/8'] }, '10.0.0.0/8,fd00::/8'],
      [{ hops: 1, cidrs: ['173.245.48.0/20'] }, 'hops=1,173.245.48.0/20'],
    ] as const satisfies readonly (readonly [TrustedProxies, string])[]) {
      assert.equal(formatTrustedProxies(trust), text);
      assert.deepEqual(parseTrustedProxies(text), trust);
    }
  });

  it('refuses a setting the app would refuse, without echoing it', () => {
    for (const trust of [{ hops: 0 }, { cidrs: ['secret'] }, { hops: 1, cidrs: ['secret/99'] }]) {
      assert.throws(
        () => formatTrustedProxies(trust),
        (error: unknown) =>
          error instanceof RequestOriginConfigError && !error.message.includes('secret'),
      );
    }
  });
});

describe('observeRequestOrigins', () => {
  it('hands every resolved request, and no refused one, to the observer', () => {
    const seen: [ResolvedRequestOrigin, RequestOriginInput][] = [];
    const base = createOriginPolicy({ origin: 'https://example.com', trustedProxies: { hops: 1 } });
    const policy = observeRequestOrigins(base, (resolved, input) => seen.push([resolved, input]));
    assert.ok(Object.isFrozen(policy));
    assert.equal(policy.trustedProxies, base.trustedProxies);

    const input: RequestOriginInput = {
      peer: '172.18.0.3',
      url: new URL('https://example.com/'),
      headers: new Headers({ 'x-forwarded-for': '198.51.100.7' }),
      probe: false,
    };
    const result = resolveRequestOrigin(input, policy);
    assert.deepEqual(result, resolveRequestOrigin(input, base));
    assert.deepEqual(seen, [[result, input]]);

    const refused = resolveRequestOrigin(
      { ...input, url: new URL('https://other.example/') },
      policy,
    );
    assert.deepEqual(refused, { refused: 421 });
    assert.equal(seen.length, 1);
  });

  it('refuses a policy createOriginPolicy did not build', () => {
    const policy = createOriginPolicy({});
    assert.throws(() => observeRequestOrigins({ ...policy }, () => undefined), TypeError);
  });
});

// ---------------------------------------------------------------------------
// Through the HTTP pipeline, over a real socket
// ---------------------------------------------------------------------------

interface Echo {
  readonly client: ClientAddress;
  readonly origin: { readonly origin: string; readonly canonical: boolean };
  readonly relayed: boolean;
  readonly trustedPeer: boolean;
  readonly forwardedFor: string | null;
  readonly forwarded: string | null;
  readonly realIp: string | null;
}

/** An app whose one route echoes what the first stage resolved and left in the headers. */
async function echoApp(server: AppOptions['server']): Promise<Hono<AppEnv>> {
  const { routes, contributions } = createHttpRoutes({
    owner: 'app',
    origin: 'app',
    allow: { mount: false, guard: false, transform: false },
  });
  routes.add({
    methods: ['GET'],
    path: '/echo',
    access: publicAccess('request-origin probe'),
    credentials: [],
    handler: ({ request }) => {
      const frame = currentRequestFrame();
      assert.ok(frame !== undefined);
      return Response.json({
        client: frame.client,
        origin: frame.origin,
        relayed: frame.relayed,
        trustedPeer: frame.trustedPeer,
        forwardedFor: request.headers.get('x-forwarded-for'),
        forwarded: request.headers.get('forwarded'),
        realIp: request.headers.get('x-real-ip'),
      });
    },
  });
  return createApp({
    manifest: { entries: [], byRoute: new Map() },
    ...(server === undefined ? {} : { server }),
    contributions: contributions(),
  });
}

/** Serve `app` on loopback for the test and return a GET that sends `host` and `headers`. */
async function listen(
  t: TestContext,
  app: Hono<AppEnv>,
): Promise<
  (host: string, headers?: Record<string, string>) => Promise<{ status: number; body: string }>
> {
  const server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return (host, headers = {}) =>
    new Promise((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/echo',
          headers: { host, connection: 'close', ...headers },
        },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (body += chunk));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      outgoing.on('error', reject);
      outgoing.end();
    });
}

describe('the first pipeline stage, served', () => {
  const SPOOF = {
    'x-forwarded-for': '203.0.113.66',
    forwarded: 'for=203.0.113.66',
    'x-real-ip': '203.0.113.66',
  };

  it("keys on the socket peer and rewrites spoofed headers with trustedProxies 'none'", async (t) => {
    const get = await listen(t, await echoApp({ origin: 'https://example.com' }));
    const response = await get('example.com', SPOOF);
    assert.equal(response.status, 200);
    const echo = JSON.parse(response.body) as Echo;
    assert.deepEqual(echo.client, { via: 'socket', ip: '127.0.0.1', bucket: '127.0.0.1' });
    assert.equal(echo.relayed, true);
    assert.equal(echo.trustedPeer, false);
    assert.equal(echo.forwardedFor, '127.0.0.1');
    assert.equal(echo.forwarded, null);
    assert.equal(echo.realIp, null);
    assert.deepEqual(echo.origin, {
      origin: 'https://example.com',
      host: 'example.com',
      canonical: true,
    });
  });

  it('keys on the entry a single trusted proxy wrote, in both forwardHeaders shapes', async (t) => {
    const get = await listen(
      t,
      await echoApp({ origin: 'https://example.com', trustedProxies: { hops: 1 } }),
    );
    for (const chain of ['198.51.100.7', '6.6.6.6, 198.51.100.7']) {
      const echo = JSON.parse(
        (await get('example.com', { 'x-forwarded-for': chain })).body,
      ) as Echo;
      assert.deepEqual(echo.client, {
        via: 'forwarded',
        ip: '198.51.100.7',
        bucket: '198.51.100.7',
      });
      assert.equal(echo.forwardedFor, '198.51.100.7', 'downstream readers see one canonical value');
    }
  });

  it('sets c.var.trustedPeer for a loopback peer inside { cidrs } that sent no chain', async (t) => {
    const get = await listen(
      t,
      await echoApp({ origin: 'https://example.com', trustedProxies: { cidrs: ['127.0.0.0/8'] } }),
    );
    const echo = JSON.parse((await get('example.com')).body) as Echo;
    assert.deepEqual(echo.client, { via: 'socket', ip: '127.0.0.1', bucket: '127.0.0.1' });
    assert.equal(echo.relayed, false);
    assert.equal(echo.trustedPeer, true);
  });

  it('answers 421 for an unknown Host before any route runs', async (t) => {
    const get = await listen(
      t,
      await echoApp({ origin: 'https://example.com', hosts: ['*.example.com'] }),
    );
    assert.equal((await get('evil.example')).status, 421);
    assert.equal((await get('a.b.example.com')).status, 421);
    assert.equal((await get('127.0.0.1')).status, 421);
    const tenant = JSON.parse((await get('acme.example.com')).body) as Echo;
    assert.deepEqual(tenant.origin, {
      origin: 'https://acme.example.com',
      host: 'acme.example.com',
      canonical: false,
    });
  });

  it('answers the health and readiness probes on any Host, and nothing else there', async (t) => {
    const app = await createApp({
      manifest: { entries: [], byRoute: new Map() },
      server: { origin: 'https://example.com' },
      healthPath: '/up',
      readiness: { path: '/ready' },
    });
    const server = createHttpServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as AddressInfo;
    const call = (method: string, path: string, host: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const outgoing = httpRequest(
          { host: '127.0.0.1', port, method, path, headers: { host, connection: 'close' } },
          (response) => {
            response.resume();
            response.on('end', () => resolve(response.statusCode ?? 0));
          },
        );
        outgoing.on('error', reject);
        outgoing.end();
      });
    // How a deploy tool probes the container: by its own address.
    assert.equal(await call('GET', '/up', `127.0.0.1:${port}`), 200);
    assert.equal(await call('HEAD', '/up', 'web-1:3000'), 200);
    assert.equal(await call('GET', '/ready', `127.0.0.1:${port}`), 200);
    // Every other path, and every other method on the probe path, still gets 421.
    assert.equal(await call('GET', '/up/x', `127.0.0.1:${port}`), 421);
    assert.equal(await call('GET', '/', `127.0.0.1:${port}`), 421);
    assert.equal(await call('POST', '/up', `127.0.0.1:${port}`), 421);
  });

  it('accepts any Host as its own origin when no origin is configured', async (t) => {
    const get = await listen(t, await echoApp(undefined));
    const echo = JSON.parse((await get('dev.test:3000')).body) as Echo;
    assert.deepEqual(echo.origin, {
      origin: 'http://dev.test:3000',
      host: 'dev.test:3000',
      canonical: false,
    });
    assert.equal(echo.relayed, false);
  });
});
