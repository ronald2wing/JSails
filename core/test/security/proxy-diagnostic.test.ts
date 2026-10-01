/**
 * Tests for `security/proxy-diagnostic.ts`: which resolved requests report a
 * proxy-trust condition, that each condition is reported once, that reports
 * are value-free, that a health probe reports nothing, the private-address
 * classification, the static deploy comparison, and the wiring of a served
 * app (the diagnostic rides on its origin policy).
 */

import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, type TestContext } from 'node:test';

import { createApp } from '../../src/server/app.js';
import { createHttpServer } from '../../src/server/http-server.js';
import {
  createProxyDiagnostic,
  isPrivateOrLoopback,
  proxyDiagnostic,
  proxyTrustFindings,
  type ProxyDiagnostic,
  type ProxyDiagnosticCode,
} from '../../src/security/proxy-diagnostic.js';
import {
  createOriginPolicy,
  resolveRequestOrigin,
  type RequestOriginInput,
  type RequestOriginObserver,
  type ResolvedRequestOrigin,
  type TrustedProxies,
} from '../../src/security/request-origin.js';

/** Resolve one request the way the first stage does: what an observer is handed. */
function resolved(
  trustedProxies: TrustedProxies,
  peer: string | undefined,
  headers: Record<string, string> = {},
  probe = false,
): [ResolvedRequestOrigin, RequestOriginInput] {
  const input: RequestOriginInput = {
    peer,
    url: new URL(probe ? 'http://example.com/up' : 'http://example.com/'),
    headers: new Headers(headers),
    probe,
  };
  const result = resolveRequestOrigin(input, createOriginPolicy({ trustedProxies }));
  assert.ok(!('refused' in result));
  return [result, input];
}

/** An observer with its own reported set, and the codes it reported. */
function observer(
  trustedProxies: TrustedProxies,
  production = true,
): { observe: RequestOriginObserver; codes: ProxyDiagnosticCode[] } {
  const codes: ProxyDiagnosticCode[] = [];
  const observe = createProxyDiagnostic({
    trustedProxies,
    production,
    reported: new Set(),
    report: (diagnostic) => codes.push(diagnostic.code),
  });
  return { observe, codes };
}

const XFF = { 'x-forwarded-for': '198.51.100.7' };

/** kamal-proxy by position, a CDN in front of it by its published range. */
const UPSTREAM: TrustedProxies = { hops: 1, cidrs: ['173.245.48.0/20'] };

describe('createProxyDiagnostic', () => {
  const table: readonly (readonly [
    string,
    TrustedProxies,
    string | undefined,
    Record<string, string>,
    readonly ProxyDiagnosticCode[],
  ])[] = [
    ["'none' behind a loopback proxy", 'none', '127.0.0.1', XFF, ['proxy_untrusted']],
    ["'none' behind a container-network proxy", 'none', '172.18.0.5', XFF, ['proxy_untrusted']],
    ["'none' behind an IPv6 ULA proxy", 'none', 'fd12::5', XFF, ['proxy_untrusted']],
    [
      "'none', a proxy sending X-Real-IP only",
      'none',
      '10.0.0.2',
      { 'x-real-ip': '1.2.3.4' },
      ['proxy_untrusted'],
    ],
    ["'none', a public client forging the header", 'none', '203.0.113.9', XFF, []],
    ["'none', a direct loopback request (a health probe)", 'none', '127.0.0.1', {}, []],
    [
      'cidrs, a proxy outside the ranges',
      { cidrs: ['10.0.0.0/8'] },
      '172.18.0.5',
      XFF,
      ['proxy_untrusted'],
    ],
    ['cidrs, a proxy inside the ranges', { cidrs: ['10.0.0.0/8'] }, '10.1.2.3', XFF, []],
    [
      'cidrs, a malformed entry where the client should be',
      { cidrs: ['10.0.0.0/8'] },
      '10.1.2.3',
      { 'x-forwarded-for': 'garbage' },
      ['proxy_chain_malformed'],
    ],
    ['hops 1, one proxy', { hops: 1 }, '127.0.0.1', XFF, []],
    ['hops 2 behind one proxy', { hops: 2 }, '127.0.0.1', XFF, ['proxy_chain_short']],
    ['hops 2, a direct request with no chain', { hops: 2 }, '127.0.0.1', {}, []],
    [
      'hops 1, a malformed entry',
      { hops: 1 },
      '127.0.0.1',
      { 'x-forwarded-for': 'unknown' },
      ['proxy_chain_malformed'],
    ],
    ['an in-process request in production', 'none', undefined, {}, ['client_unknown']],
    ['an in-process request with a chain in production', { hops: 1 }, undefined, XFF, []],
    [
      'hops 1 and ranges, a client around the upstream proxy',
      UPSTREAM,
      '172.18.0.3',
      { 'x-forwarded-for': '198.51.100.7, 203.0.113.9' },
      [],
    ],
    [
      'hops 1 and ranges, through the upstream proxy',
      UPSTREAM,
      '172.18.0.3',
      { 'x-forwarded-for': '198.51.100.7, 173.245.48.9' },
      [],
    ],
    [
      'hops 2 and ranges behind one proxy',
      { hops: 2, cidrs: ['173.245.48.0/20'] },
      '172.18.0.3',
      XFF,
      ['proxy_chain_short'],
    ],
    [
      'hops 1 and ranges, a peer outside the ranges is not an untrusted proxy',
      UPSTREAM,
      '172.18.0.3',
      {},
      [],
    ],
  ];
  for (const [label, trust, peer, headers, expected] of table) {
    it(`${label}: ${expected.length === 0 ? 'nothing' : expected.join(', ')}`, () => {
      const { observe, codes } = observer(trust);
      observe(...resolved(trust, peer, headers));
      assert.deepEqual(codes, expected);
    });
  }

  it('reports nothing for a health probe, whatever chain a proxy in between gave it', () => {
    // kamal-proxy health-checks the release through the cache proxy, which
    // gives the probe a chain of one entry, its own peer, while the app
    // trusts two hops: a probe says nothing about the proxies in front of
    // real clients, so it is never reported.
    for (const [trust, peer, headers] of [
      [{ hops: 2 }, '172.18.0.5', { 'x-forwarded-for': '172.18.0.3' }],
      [{ hops: 1 }, '172.18.0.5', { 'x-forwarded-for': 'garbage' }],
      ['none', '127.0.0.1', XFF],
    ] as const) {
      const { observe, codes } = observer(trust);
      observe(...resolved(trust, peer, headers, true));
      assert.deepEqual(codes, [], JSON.stringify(trust));
    }
  });

  it('reports an unknown client only in production', () => {
    const { observe, codes } = observer('none', false);
    observe(...resolved('none', undefined));
    assert.deepEqual(codes, []);
  });

  it('reports each condition once, however many requests show it', () => {
    const { observe, codes } = observer({ hops: 2 });
    for (let index = 0; index < 5; index += 1) {
      observe(...resolved({ hops: 2 }, '127.0.0.1', XFF));
      observe(...resolved({ hops: 2 }, '127.0.0.1', { 'x-forwarded-for': 'bad, 1.1.1.1' }));
      observe(...resolved({ hops: 2 }, undefined));
    }
    assert.deepEqual(codes, ['proxy_chain_short', 'proxy_chain_malformed', 'client_unknown']);
  });

  it('shares the reported set between observers given the same one', () => {
    const reported = new Set<ProxyDiagnosticCode>();
    const codes: ProxyDiagnosticCode[] = [];
    for (let index = 0; index < 2; index += 1) {
      createProxyDiagnostic({
        trustedProxies: 'none',
        production: false,
        reported,
        report: (diagnostic) => codes.push(diagnostic.code),
      })(...resolved('none', '127.0.0.1', XFF));
    }
    assert.deepEqual(codes, ['proxy_untrusted']);
  });

  it('emits a process warning under the report code by default, naming no address', () => {
    const warnings: { message: string; code: string | undefined }[] = [];
    const original = process.emitWarning;
    process.emitWarning = ((message: string, options?: { code?: string }) => {
      warnings.push({ message, code: options?.code });
    }) as typeof process.emitWarning;
    try {
      createProxyDiagnostic({ trustedProxies: 'none', production: false, reported: new Set() })(
        ...resolved('none', '10.9.8.7', { 'x-forwarded-for': '198.51.100.77' }),
      );
    } finally {
      process.emitWarning = original;
    }
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.code, 'JSAILS_PROXY_UNTRUSTED');
    assert.ok(!/10\.9\.8\.7|198\.51\.100\.77/.test(warnings[0]?.message ?? ''));
  });

  it('gives every code a JSAILS_ warning code and a message that names the fix', () => {
    const codes: readonly ProxyDiagnosticCode[] = [
      'proxy_untrusted',
      'proxy_chain_short',
      'proxy_chain_malformed',
      'client_unknown',
    ];
    for (const code of codes) {
      const diagnostic: ProxyDiagnostic = proxyDiagnostic(code);
      assert.equal(diagnostic.code, code);
      assert.equal(diagnostic.warning, `JSAILS_${code.toUpperCase()}`);
      assert.match(diagnostic.message, /^jsails: /);
      assert.ok(Object.isFrozen(diagnostic));
    }
  });
});

describe('isPrivateOrLoopback', () => {
  it('classifies the ranges a proxy in front of an app connects from', () => {
    for (const ip of [
      '127.0.0.1',
      '127.8.9.10',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1',
      '169.254.1.1',
      '::1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
    ]) {
      assert.equal(isPrivateOrLoopback(ip), true, ip);
    }
    for (const ip of ['203.0.113.9', '172.32.0.1', '8.8.8.8', '2001:db8::1', '::', 'nope', '']) {
      assert.equal(isPrivateOrLoopback(ip), false, ip);
    }
  });
});

describe('proxyTrustFindings', () => {
  it('finds nothing without a statement, or when the app resolved what the deploy states', () => {
    assert.deepEqual(proxyTrustFindings(undefined, 'none'), []);
    assert.deepEqual(proxyTrustFindings(undefined, { hops: 1 }), []);
    assert.deepEqual(proxyTrustFindings({ hops: 1 }, { hops: 1 }), []);
    assert.deepEqual(proxyTrustFindings('none', 'none'), []);
  });

  it("fails a config that overrides the deploy's proxies with 'none'", () => {
    for (const stated of [{ hops: 1 }, { cidrs: ['10.0.0.0/8'] }] as const) {
      const findings = proxyTrustFindings(stated, 'none');
      assert.deepEqual(
        findings.map((finding) => [finding.code, finding.severity]),
        [['proxy_untrusted', 'error']],
      );
      assert.match(findings[0]?.message ?? '', /JSAILS_TRUSTED_PROXIES/);
    }
  });

  it('fails a config that states another trust than the deploy', () => {
    for (const [stated, resolvedTrust] of [
      [{ hops: 1 }, { hops: 2 }],
      [{ hops: 2 }, { cidrs: ['10.0.0.0/8'] }],
      [{ hops: 1, cidrs: ['173.245.48.0/20'] }, { hops: 1 }],
      ['none', { hops: 1 }],
    ] as const) {
      assert.deepEqual(
        proxyTrustFindings(stated, resolvedTrust).map((finding) => [
          finding.code,
          finding.severity,
        ]),
        [['proxy_trust_overridden', 'error']],
      );
    }
  });
});

describe('a served app reports a proxy it does not trust', () => {
  /** A GET of `path` with `headers` against a served app with no routes. */
  async function served(
    t: TestContext,
    trustedProxies: TrustedProxies,
  ): Promise<(path: string, headers: Record<string, string>) => Promise<number>> {
    const app = await createApp({
      manifest: { entries: [], byRoute: new Map() },
      server: { trustedProxies },
      healthPath: '/up',
    });
    const server = createHttpServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as AddressInfo;
    return (path, headers) =>
      new Promise((resolve, reject) => {
        const outgoing = httpRequest(
          { host: '127.0.0.1', port, path, headers: { connection: 'close', ...headers } },
          (response) => {
            response.resume();
            response.on('end', () => resolve(response.statusCode ?? 0));
          },
        );
        outgoing.on('error', reject);
        outgoing.end();
      });
  }

  it('warns once per process, and not for a direct request or a probe', async (t) => {
    const warnings: string[] = [];
    const onWarning = (warning: Error & { code?: string }): void => {
      if (warning.code?.startsWith('JSAILS_PROXY') === true) warnings.push(warning.code);
    };
    process.on('warning', onWarning);
    t.after(() => process.off('warning', onWarning));

    const get = await served(t, 'none');
    assert.equal(await get('/missing', {}), 404);
    assert.equal(await get('/up', { 'x-forwarded-for': '198.51.100.7' }), 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings, []);
    for (let index = 0; index < 3; index += 1) {
      assert.equal(await get('/missing', { 'x-forwarded-for': '198.51.100.7' }), 404);
    }
    // A second app in the same process stays quiet: the condition was reported.
    const again = await served(t, 'none');
    assert.equal(await again('/missing', { 'x-forwarded-for': '198.51.100.8' }), 404);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings, ['JSAILS_PROXY_UNTRUSTED']);
  });
});
