/**
 * Tests for the trusted-proxy rule: the setting every topology jamal can
 * build requires, the refusals for one it cannot describe safely, how the
 * planner applies it to the web container, the deploy check, and every
 * `kamal-proxy deploy` of the app's service. How the app resolves a client
 * under the `{ hops, cidrs }` setting, a client that reaches kamal-proxy
 * around the CDN included, is core's `security/request-origin.test.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  JamalConfigError,
  normalizeJamalConfig,
  type JamalConfig,
  type JamalConfigInput,
} from '../../src/config/index.js';
import { appProxyRoute, formatProductionPlan } from '../../src/production/plan.js';
import {
  proxyTopologyOf,
  requiredProxyTrust,
  trustedProxiesVariable,
  type ProxyTopology,
  type ProxyTrust,
} from '../../src/production/proxy-trust.js';
import {
  HOME,
  deployPlan,
  imageOf,
  observation,
  release,
  rollbackPlan,
  stateOf,
} from './host-observation.js';

/** A CDN's published ranges, as `upstreamCidrs` lists them. */
const CDN = ['173.245.48.0/20', '2400:cb00::/32'] as const;

/** A deployable config with the given proxy settings. */
function configWith(extra: Partial<JamalConfigInput> = {}): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    production: { server: '1.2.3.4', domain: 'example.com' },
    ...extra,
  });
}

/** The `-e` value of the plan's step `kind`, or `undefined` when it has none. */
function trustedProxiesFlag(
  config: JamalConfig,
  kind: 'check' | 'run' | 'rollback',
): string | undefined {
  const observed = observation(config, {
    releases: [1, [2, 1]],
    state: stateOf(2, 1),
    containers: [2],
    serving: 2,
  });
  const plan =
    kind === 'rollback' ? rollbackPlan(config, observed) : deployPlan(config, 3, { observed });
  const step = kind === 'rollback' ? 'run' : kind;
  const argv = plan.steps.find((candidate) => candidate.kind === step)?.argv ?? [];
  return argv.find((token) => token.startsWith('JSAILS_TRUSTED_PROXIES='));
}

describe('requiredProxyTrust', () => {
  const table: readonly (readonly [string, ProxyTopology, ProxyTrust])[] = [
    // forwardHeaders off: kamal-proxy replaces the chain with the address it saw.
    [
      'kamal-proxy alone',
      { cacheProxy: false, forwardHeaders: false, upstreamCidrs: undefined },
      { kind: 'trusted', trust: { hops: 1 } },
    ],
    [
      'kamal-proxy and the cache proxy',
      { cacheProxy: true, forwardHeaders: false, upstreamCidrs: undefined },
      { kind: 'trusted', trust: { hops: 2 } },
    ],
    [
      'upstream proxies whose chain kamal-proxy would discard',
      { cacheProxy: false, forwardHeaders: false, upstreamCidrs: CDN },
      { kind: 'refused', reason: 'forward_headers_required' },
    ],
    // forwardHeaders on: kamal-proxy keeps the chain the upstream proxies wrote.
    [
      'a CDN in front of kamal-proxy',
      { cacheProxy: false, forwardHeaders: true, upstreamCidrs: CDN },
      { kind: 'trusted', trust: { hops: 1, cidrs: [...CDN] } },
    ],
    [
      'a CDN in front, the cache proxy behind',
      { cacheProxy: true, forwardHeaders: true, upstreamCidrs: CDN },
      { kind: 'trusted', trust: { hops: 2, cidrs: [...CDN] } },
    ],
    [
      'a kept chain from proxies jamal does not know',
      { cacheProxy: false, forwardHeaders: true, upstreamCidrs: undefined },
      { kind: 'refused', reason: 'upstream_cidrs_required' },
    ],
  ];
  for (const [label, topology, expected] of table) {
    const outcome = expected.kind === 'trusted' ? JSON.stringify(expected.trust) : expected.reason;
    it(`${label}: ${outcome}`, () => {
      assert.deepEqual(requiredProxyTrust(topology), expected);
    });
  }
});

describe('proxyTopologyOf', () => {
  it('reads the cache proxy only when it is enabled', () => {
    assert.equal(proxyTopologyOf(configWith()).cacheProxy, false);
    assert.equal(proxyTopologyOf(configWith({ cacheProxy: {} })).cacheProxy, false);
    assert.equal(proxyTopologyOf(configWith({ cacheProxy: { enabled: true } })).cacheProxy, true);
  });

  it('reads forwardHeaders and upstreamCidrs from config.proxy', () => {
    assert.deepEqual(
      proxyTopologyOf(configWith({ proxy: { forwardHeaders: true, upstreamCidrs: [...CDN] } })),
      { cacheProxy: false, forwardHeaders: true, upstreamCidrs: [...CDN] },
    );
  });
});

describe('trustedProxiesVariable', () => {
  it('states the setting as the variable the app reads', () => {
    assert.equal(trustedProxiesVariable(configWith()), 'JSAILS_TRUSTED_PROXIES=hops=1');
    assert.equal(
      trustedProxiesVariable(configWith({ cacheProxy: { enabled: true } })),
      'JSAILS_TRUSTED_PROXIES=hops=2',
    );
    assert.equal(
      trustedProxiesVariable(
        configWith({ proxy: { forwardHeaders: true, upstreamCidrs: [...CDN] } }),
      ),
      'JSAILS_TRUSTED_PROXIES=hops=1,173.245.48.0/20,2400:cb00::/32',
    );
  });

  it('refuses a topology it cannot describe safely, value-free and with a fix', () => {
    const cases: readonly (readonly [Partial<JamalConfigInput>, RegExp, RegExp])[] = [
      [
        { proxy: { forwardHeaders: true } },
        /^config\.proxy\.forwardHeaders requires config\.proxy\.upstreamCidrs/,
        /set config\.proxy\.upstreamCidrs/,
      ],
      [
        { proxy: { upstreamCidrs: [...CDN] } },
        /^config\.proxy\.upstreamCidrs requires config\.proxy\.forwardHeaders/,
        /forwardHeaders: true/,
      ],
    ];
    for (const [extra, message, suggestion] of cases) {
      assert.throws(
        () => trustedProxiesVariable(configWith(extra)),
        (error: unknown) =>
          error instanceof JamalConfigError &&
          error.code === 'invalid_config' &&
          message.test(error.message) &&
          suggestion.test(error.suggestion ?? ''),
      );
    }
  });
});

describe('planRelease: trusted proxies', () => {
  it('passes the derived setting to the check, the new, and the rolled-back container alike', () => {
    const cases: readonly (readonly [Partial<JamalConfigInput>, string])[] = [
      [{}, 'hops=1'],
      [{ cacheProxy: { enabled: true } }, 'hops=2'],
      [{ proxy: { forwardHeaders: true, upstreamCidrs: [...CDN] } }, `hops=1,${CDN.join(',')}`],
      [
        { cacheProxy: { enabled: true }, proxy: { forwardHeaders: true, upstreamCidrs: [...CDN] } },
        `hops=2,${CDN.join(',')}`,
      ],
    ];
    for (const [extra, value] of cases) {
      const config = configWith(extra);
      for (const kind of ['check', 'run', 'rollback'] as const) {
        assert.equal(trustedProxiesFlag(config, kind), `JSAILS_TRUSTED_PROXIES=${value}`, kind);
      }
    }
  });

  it('shows the setting in the dry-run plan, on the clear channel', () => {
    const text = formatProductionPlan(deployPlan(configWith(), 2));
    assert.match(text, /-e JSAILS_TRUSTED_PROXIES=hops=1 /);
  });

  it('has kamal-proxy keep the chain only when config.proxy says so', () => {
    const switchArgv = (config: JamalConfig): readonly string[] =>
      deployPlan(config, 2).steps.find((step) => step.kind === 'switch')?.argv ?? [];
    assert.ok(!switchArgv(configWith()).includes('--forward-headers'));
    const proxy = { forwardHeaders: true, upstreamCidrs: [...CDN] };
    assert.ok(switchArgv(configWith({ proxy })).includes('--forward-headers'));
    const onDemand = configWith({
      production: { server: '1.2.3.4', onDemandTlsUrl: '/tls/allow' },
      proxy,
    });
    assert.ok(switchArgv(onDemand).includes('--forward-headers'));
  });

  it('refuses an unsafe topology before planning any step', () => {
    for (const proxy of [{ forwardHeaders: true }, { upstreamCidrs: [...CDN] }]) {
      assert.throws(() => deployPlan(configWith({ proxy }), 2), JamalConfigError);
    }
  });
});

describe('planRelease: the deploy check', () => {
  it('runs jsails check --deploy in the new image, with the release environment, before the run', () => {
    const plan = deployPlan(configWith(), 2);
    const kinds = plan.steps.map((step) => step.kind);
    assert.ok(kinds.indexOf('check') > kinds.indexOf('pull'));
    assert.ok(kinds.indexOf('check') < kinds.indexOf('run'));
    const check = plan.steps.find((step) => step.kind === 'check');
    const run = plan.steps.find((step) => step.kind === 'run');
    assert.ok(check?.argv !== undefined && run?.argv !== undefined);
    assert.deepEqual(check.argv.slice(0, 7), [
      'ssh',
      '1.2.3.4',
      'docker',
      'run',
      '--rm',
      '--network',
      'none',
    ]);
    assert.deepEqual(check.argv.slice(-5), [
      imageOf(configWith(), 2),
      'node',
      'node_modules/.bin/jsails',
      'check',
      '--deploy',
    ]);
    // Every variable the web container gets, the check gets too.
    const envOf = (argv: readonly string[]): string[] =>
      argv.flatMap((token, index) => (argv[index - 1] === '-e' ? [token] : []));
    assert.deepEqual(envOf(check.argv), envOf(run.argv));
    assert.ok(envOf(check.argv).includes('JSAILS_ENV=production'));
    assert.equal(check.cleanupOnFailure, undefined);
  });

  it('mounts the secrets file the run mounts, written before it', () => {
    const plan = deployPlan(configWith(), 2, {
      env: {
        clear: [],
        secret: [{ name: 'PUBLIC_ORIGIN', value: 'https://example.com', secret: true }],
        secretsFile: Buffer.from('{"v":1,"values":{"PUBLIC_ORIGIN":"https://example.com"}}\n'),
      },
    });
    const kinds = plan.steps.map((step) => step.kind);
    assert.ok(kinds.indexOf('secrets-file') < kinds.indexOf('check'));
    const argvOf = (kind: 'check' | 'run'): readonly string[] =>
      plan.steps.find((step) => step.kind === kind)?.argv ?? [];
    const mount = (argv: readonly string[]) => argv[argv.indexOf('-v') + 1];
    assert.equal(
      mount(argvOf('check')),
      `${HOME}/.jamal/apps/myapp/releases/${release(2)}/secrets:/run/jsails/secrets:ro`,
    );
    assert.ok(argvOf('run').includes(mount(argvOf('check')) ?? ''));
  });
});

describe('appProxyRoute', () => {
  it('routes to the release container, or to the cache proxy when it is enabled', () => {
    assert.deepEqual(appProxyRoute(configWith(), 'myapp-web-2'), {
      target: 'myapp-web-2:3000',
      healthCheckPath: '/up',
      forwardHeaders: false,
    });
    assert.deepEqual(
      appProxyRoute(
        configWith({
          cacheProxy: { enabled: true },
          health: { path: '/healthz', timeoutMs: 1000, intervalMs: 1000 },
          proxy: { forwardHeaders: true, upstreamCidrs: [...CDN] },
        }),
        'myapp-web-2',
      ),
      { target: 'jamal-cache-proxy:6081', healthCheckPath: '/healthz', forwardHeaders: true },
    );
  });
});
