/**
 * Tests for custom-domain verification: tokens, claims bound to a tenant,
 * admissibility (single labels, special-use names, root and app hosts with
 * their subdomains and parents, the challenge-name length limit), the
 * challenge record, and fake-resolver vectors for the check (multi-string and
 * several records, key case, bare tokens, whitespace, NXDOMAIN, ENODATA,
 * SERVFAIL, timeout, abort, a resolver that ignores the signal, and malformed
 * answers), and the refusal of a forged or malformed challenge.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DnsTxtResolver } from '../src/dns-resolver.js';
import { domainVerificationPolicy } from '../src/domain-verification-policy.js';
import {
  admissibleDomain,
  challengeTokenOf,
  checkDomainChallenge,
  domainChallenge,
  isDomainToken,
  issueDomainClaim,
  issueDomainToken,
} from '../src/domain-verification.js';
import { rejectedCode, thrownCode } from './thrown-code.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz234567';
const challenge = domainChallenge({ hostname: 'Shop.Acme.com', token: TOKEN });

function resolverOf(
  answer: (name: string, signal: AbortSignal) => Promise<readonly (readonly string[])[]>,
): DnsTxtResolver {
  return { resolveTxt: answer };
}

function records(...txt: (readonly string[])[]): DnsTxtResolver {
  return resolverOf((name) => {
    assert.equal(name, '_jsails-challenge.shop.acme.com');
    return Promise.resolve(txt);
  });
}

function failing(code: string): DnsTxtResolver {
  return resolverOf(() => Promise.reject(Object.assign(new Error('dns'), { code })));
}

describe('domain tokens', () => {
  it('are 160-bit lower-case base32 and do not repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      const token = issueDomainToken();
      assert.match(token, /^[a-z2-7]{32}$/);
      seen.add(token);
    }
    assert.equal(seen.size, 2000);
    assert.equal(isDomainToken(TOKEN), true);
    for (const bad of [TOKEN.toUpperCase(), `${TOKEN}a`, TOKEN.slice(1), `${TOKEN.slice(1)}1`, 7]) {
      assert.equal(isDomainToken(bad), false, String(bad));
    }
  });
});

describe('domainChallenge', () => {
  it('names an underscore TXT record carrying token=', () => {
    assert.deepEqual(challenge, {
      hostname: 'shop.acme.com',
      recordType: 'TXT',
      recordName: '_jsails-challenge.shop.acme.com',
      recordValue: `token=${TOKEN}`,
    });
    assert.ok(Object.isFrozen(challenge));
  });

  it('refuses a malformed hostname or token', () => {
    assert.equal(
      thrownCode(() => domainChallenge({ hostname: '1.2.3.4', token: TOKEN })),
      'invalid_hostname',
    );
    assert.equal(
      thrownCode(() =>
        domainChallenge({
          hostname: `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(50)}`,
          token: TOKEN,
        }),
      ),
      'invalid_hostname',
    );
    assert.equal(
      thrownCode(() => domainChallenge({ hostname: 'acme.com', token: 'x' })),
      'invalid_domain_token',
    );
  });
});

describe('admissibleDomain', () => {
  const options = { rootDomain: 'saas.example.net', appHosts: ['app.saas.io', 'saas.io'] };
  const table: readonly (readonly [string, 'ok' | 'invalid_hostname' | 'reserved_hostname'])[] = [
    ['acme.com', 'ok'],
    ['Shop.Acme.COM.', 'ok'],
    ['bücher.de', 'ok'],
    ['com', 'invalid_hostname'],
    ['localhost', 'invalid_hostname'],
    ['*.acme.com', 'invalid_hostname'],
    ['127.0.0.1', 'invalid_hostname'],
    ['acme.com/x', 'invalid_hostname'],
    [`${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(50)}`, 'invalid_hostname'],
    ['acme.localhost', 'reserved_hostname'],
    ['acme.test', 'reserved_hostname'],
    ['acme.example', 'reserved_hostname'],
    ['example.com', 'reserved_hostname'],
    ['shop.example.org', 'reserved_hostname'],
    ['acme.local', 'reserved_hostname'],
    ['x.onion', 'reserved_hostname'],
    ['router.home.arpa', 'reserved_hostname'],
    ['db.internal', 'reserved_hostname'],
    ['acme.invalid', 'reserved_hostname'],
    ['acme.alt', 'reserved_hostname'],
    ['saas.example.net', 'reserved_hostname'],
    ['acme.saas.example.net', 'reserved_hostname'],
    ['a.b.saas.example.net', 'reserved_hostname'],
    ['example.net', 'reserved_hostname'],
    ['saas.io', 'reserved_hostname'],
    ['app.saas.io', 'reserved_hostname'],
    ['evil.app.saas.io', 'reserved_hostname'],
    ['notsaas.io', 'ok'],
  ];
  for (const [hostname, expected] of table) {
    it(`${hostname} is ${expected}`, () => {
      const admission = admissibleDomain(hostname, options);
      assert.equal(admission.ok ? 'ok' : admission.code, expected);
    });
  }

  it('returns the normalised hostname', () => {
    assert.deepEqual(admissibleDomain('Bücher.DE.', { appHosts: [] }), {
      ok: true,
      hostname: 'xn--bcher-kva.de',
    });
  });

  it('refuses a malformed configuration with invalid_domain_policy', () => {
    assert.equal(
      thrownCode(() => admissibleDomain('acme.com', { appHosts: ['a..b'] })),
      'invalid_domain_policy',
    );
    assert.equal(
      thrownCode(() => admissibleDomain('acme.com', { rootDomain: '*', appHosts: [] })),
      'invalid_domain_policy',
    );
  });
});

describe('issueDomainClaim', () => {
  const now = new Date('2026-11-19T00:00:00Z');

  it('binds a fresh token to the tenant and hostname with a pending expiry', () => {
    const a = issueDomainClaim({ tenantId: 1, hostname: 'Acme.com', now }, { appHosts: [] });
    const b = issueDomainClaim({ tenantId: 2, hostname: 'acme.com', now }, { appHosts: [] });
    assert.equal(a.tenantId, 1);
    assert.equal(a.hostname, 'acme.com');
    assert.equal(isDomainToken(a.token), true);
    assert.notEqual(a.token, b.token);
    assert.equal(a.expiresAt.toISOString(), '2026-11-26T00:00:00.000Z');
    assert.ok(Object.isFrozen(a));
  });

  it('uses the policy pending TTL', () => {
    const claim = issueDomainClaim(
      { tenantId: 1, hostname: 'acme.com', now },
      { appHosts: [], policy: domainVerificationPolicy({ pendingTtlMs: 3_600_000 }) },
    );
    assert.equal(claim.expiresAt.toISOString(), '2026-11-19T01:00:00.000Z');
  });

  it('refuses bad input with value-free codes', () => {
    const cases: readonly (readonly [Record<string, unknown>, string])[] = [
      [{ tenantId: 0, hostname: 'acme.com', now }, 'invalid_tenant_id'],
      [{ tenantId: '1', hostname: 'acme.com', now }, 'invalid_tenant_id'],
      [{ tenantId: 1.5, hostname: 'acme.com', now }, 'invalid_tenant_id'],
      [{ tenantId: 1, hostname: 'acme', now }, 'invalid_hostname'],
      [{ tenantId: 1, hostname: 'acme.example.net', now }, 'reserved_hostname'],
      [{ tenantId: 1, hostname: 'acme.com', now: new Date(Number.NaN) }, 'invalid_domain_policy'],
    ];
    for (const [input, code] of cases) {
      assert.equal(
        thrownCode(() =>
          issueDomainClaim(input as { tenantId: number; hostname: string; now: Date }, {
            rootDomain: 'example.net',
            appHosts: [],
          }),
        ),
        code,
      );
    }
  });
});

describe('challengeTokenOf', () => {
  const table: readonly (readonly [readonly string[], string])[] = [
    [['token=abc'], 'abc'],
    [['TOKEN=abc'], 'abc'],
    [['token=ab', 'c'], 'abc'],
    [['token=abc expiry=never'], 'abc'],
    [['  token=abc  '], 'abc'],
    [['token=abc\texpiry=2026-12-01'], 'abc'],
    [['abc'], 'abc'],
    [['other=1 token=abc'], 'other=1 token=abc'],
    [[], ''],
  ];
  for (const [record, expected] of table) {
    it(`reads ${JSON.stringify(record)}`, () => {
      assert.equal(challengeTokenOf(record), expected);
    });
  }
});

describe('checkDomainChallenge', () => {
  const vectors: readonly (readonly [string, DnsTxtResolver, string])[] = [
    ['one matching record', records([`token=${TOKEN}`]), 'verified'],
    [
      'a record split into character-strings',
      records(['token=abcdefghijklmnop', 'qrstuvwxyz234567']),
      'verified',
    ],
    [
      'a match among several records',
      records(['v=spf1 -all'], [`token=${TOKEN}`], ['token=zz']),
      'verified',
    ],
    ['an upper-cased token', records([`token=${TOKEN.toUpperCase()}`]), 'verified'],
    ['an upper-cased key', records([`Token=${TOKEN}`]), 'verified'],
    ['a bare token', records([TOKEN]), 'verified'],
    ['surrounding whitespace', records([` token=${TOKEN} `]), 'verified'],
    ['trailing metadata', records([`token=${TOKEN} expiry=never`]), 'verified'],
    ['no records', records(), 'absent'],
    ['another token', records(['token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']), 'mismatch'],
    ['the token as a later element', records([`other=1 token=${TOKEN}`]), 'mismatch'],
    [
      'a token split by whitespace',
      records([`token=${TOKEN.slice(0, 10)} ${TOKEN.slice(10)}`]),
      'mismatch',
    ],
    ['a token prefix', records([`token=${TOKEN.slice(0, 31)}`]), 'mismatch'],
    ['NXDOMAIN thrown', failing('ENOTFOUND'), 'absent'],
    ['ENODATA thrown', failing('ENODATA'), 'absent'],
    ['SERVFAIL', failing('ESERVFAIL'), 'dns_error'],
    ['connection refused', failing('ECONNREFUSED'), 'dns_error'],
    ['a resolver timeout', failing('ETIMEOUT'), 'timeout'],
    ['a codeless failure', resolverOf(() => Promise.reject(new Error('x'))), 'dns_error'],
    [
      'a synchronous throw',
      resolverOf(() => {
        throw new Error('x');
      }),
      'dns_error',
    ],
    [
      'a malformed answer',
      resolverOf(() => Promise.resolve([[1]] as unknown as string[][])),
      'dns_error',
    ],
    [
      'a non-array answer',
      resolverOf(() => Promise.resolve('x' as unknown as string[][])),
      'dns_error',
    ],
  ];
  for (const [why, resolver, expected] of vectors) {
    it(`${why} is ${expected}`, async () => {
      assert.equal(await checkDomainChallenge(challenge, resolver), expected);
    });
  }

  const forged: readonly (readonly [string, Record<string, unknown>, string])[] = [
    ['an empty token', { recordValue: 'token=' }, 'invalid_domain_token'],
    ['a short token', { recordValue: 'token=abc' }, 'invalid_domain_token'],
    ['a value without the key', { recordValue: TOKEN }, 'invalid_domain_token'],
    [
      'a record name for another host',
      { recordName: '_jsails-challenge.evil.com' },
      'invalid_domain_token',
    ],
    ['a record name without the label', { recordName: 'shop.acme.com' }, 'invalid_domain_token'],
    ['another record type', { recordType: 'CNAME' }, 'invalid_domain_token'],
    ['a hostname that is not one', { hostname: 'not a host' }, 'invalid_hostname'],
  ];
  for (const [why, patch, code] of forged) {
    it(`rejects a challenge with ${why} before any lookup`, async () => {
      let called = false;
      const resolver = resolverOf(() => {
        called = true;
        return Promise.resolve([['']]);
      });
      // The spread keeps the challenge's static type; the patch changes the values.
      const malformed: typeof challenge = { ...challenge, ...patch };
      assert.equal(await rejectedCode(checkDomainChallenge(malformed, resolver)), code);
      assert.equal(called, false);
    });
  }

  it('never verifies an empty token against an empty record', async () => {
    const empty = { ...challenge, recordValue: 'token=' };
    assert.equal(
      await rejectedCode(checkDomainChallenge(empty, records(['']))),
      'invalid_domain_token',
    );
  });

  it('passes the signal to the resolver', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | null = null;
    const resolver = resolverOf((_name, signal) => {
      seen = signal;
      return Promise.resolve([]);
    });
    await checkDomainChallenge(challenge, resolver, controller.signal);
    assert.equal(seen, controller.signal);
  });

  it('reports timeout for an already aborted signal without a lookup', async () => {
    let called = false;
    const resolver = resolverOf(() => {
      called = true;
      return Promise.resolve([]);
    });
    assert.equal(await checkDomainChallenge(challenge, resolver, AbortSignal.abort()), 'timeout');
    assert.equal(called, false);
  });

  it('reports timeout when the signal aborts, even if the resolver ignores it', async () => {
    const controller = new AbortController();
    const resolver = resolverOf(() => new Promise(() => undefined));
    const pending = checkDomainChallenge(challenge, resolver, controller.signal);
    controller.abort();
    assert.equal(await pending, 'timeout');
  });

  it('reports timeout when a cooperative resolver rejects on abort', async () => {
    const controller = new AbortController();
    const resolver = resolverOf(
      (_name, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const pending = checkDomainChallenge(challenge, resolver, controller.signal);
    controller.abort();
    assert.equal(await pending, 'timeout');
  });
});
