/**
 * Tests for the `jamal domain` verbs: add, remove, list, and host/service
 * validation.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runJamalCommand, type JamalDeps } from '../src/command.js';
import { normalizeJamalConfig, type JamalConfig } from '../src/config/index.js';
import type { CommandResult } from '../src/production/process-runner.js';
import { proxyDeployArgv, proxyListArgv, proxyRemoveServiceArgv } from '../src/production/proxy.js';
import {
  deployPlan,
  release,
  stateOf,
  webContainer,
  type HostSpec,
} from './production/host-observation.js';
import { scriptedServer, type ScriptedCall } from './scripted-server.js';

/**
 * Tests for the `jamal domain` verbs. The config loader and the server are
 * injected: the server reports the host the test describes (by default
 * release 1 live), so the assertions target the exact remote argv each verb
 * assembles, the lock `add` holds, the `--dry-run` output, the
 * positional/flag validation, and the value-free failure paths.
 */

function domainConfig(
  overrides: { service?: string; server?: string; extra?: Record<string, unknown> } = {},
): JamalConfig {
  return normalizeJamalConfig({
    service: overrides.service ?? 'myapp',
    image: 'ghcr.io/acme/myapp',
    production: { server: overrides.server ?? '1.2.3.4' },
    ...overrides.extra,
  });
}

/** The live release's web container on the default host. */
const CONTAINER = webContainer(domainConfig(), 1);

interface DomainHarness {
  deps: JamalDeps;
  out: string[];
  err: string[];
  calls: ScriptedCall[];
  locks: string[];
}

function makeDeps(
  overrides: {
    config?: JamalConfig;
    host?: HostSpec;
    answer?: (remoteArgv: readonly string[]) => Partial<CommandResult> | undefined;
  } = {},
): DomainHarness {
  const out: string[] = [];
  const err: string[] = [];
  const config = overrides.config ?? domainConfig();
  const { remote, calls, locks } = scriptedServer({
    config,
    ...(overrides.host === undefined ? {} : { host: overrides.host }),
    ...(overrides.answer === undefined ? {} : { answer: overrides.answer }),
  });
  const deps: JamalDeps = {
    loadJamalConfig: async () => config,
    remoteRunner: remote,
    cwd: '/project',
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return { deps, out, err, calls, locks };
}

/**
 * `jamal domain` is a server-facing verb, so Windows refuses it with
 * `unsupported_platform` (`cli/platform-guard.ts`;
 * `core/test/cli/platform-guard.test.ts` proves the refusal): the tests of
 * what it does run on POSIX only. Its help still prints on every platform.
 */
const serverVerb = {
  skip:
    process.platform === 'win32' && 'jamal domain is a server-facing verb, which Windows refuses',
};

describe('jamal domain --help', () => {
  it('prints the domain usage on --help without loading config', async () => {
    const { deps, out } = makeDeps();

    const code = await runJamalCommand(['domain', '--help'], deps);

    assert.equal(code, 0);
    assert.match(out.join('\n'), /jamal domain - manage the proxy/);
    assert.match(out.join('\n'), /add <host>/);
    assert.match(out.join('\n'), /remove <host>/);
    assert.match(out.join('\n'), /--no-tls/);
  });
});

describe('jamal domain add', serverVerb, () => {
  it('routes the host to the live release under the deploy lock, terminating TLS by default', async () => {
    const { deps, calls, locks, err } = makeDeps();

    const code = await runJamalCommand(['domain', 'add', 'example.com'], deps);

    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(calls, [
      {
        server: '1.2.3.4',
        remoteArgv: [
          ...proxyDeployArgv({
            service: 'myapp',
            target: `${CONTAINER}:3000`,
            host: 'example.com',
            tls: true,
            healthCheckPath: '/up',
          }),
        ],
        fenced: true,
        stdin: Buffer.alloc(0),
      },
    ]);
    assert.deepEqual(locks, ['lock.acquire', 'lock.release']);
  });

  it('deploys the same route as the release switch: forward headers, cache proxy, health path', async () => {
    // kamal-proxy's deploy replaces every option of the service, so a route
    // without them would change the proxies in front of the app.
    const config = domainConfig({
      extra: {
        cacheProxy: { enabled: true },
        health: { path: '/healthz', timeoutMs: 1000, intervalMs: 1000 },
        proxy: { forwardHeaders: true, upstreamCidrs: ['173.245.48.0/20'] },
      },
    });
    const { deps, calls, err } = makeDeps({ config });

    const code = await runJamalCommand(['domain', 'add', 'www.example.com'], deps);

    assert.equal(code, 0, err.join('\n'));
    const argv = calls[0]?.remoteArgv ?? [];
    assert.deepEqual(argv, [
      ...proxyDeployArgv({
        service: 'myapp',
        target: 'jamal-cache-proxy:6081',
        host: 'www.example.com',
        tls: true,
        healthCheckPath: '/healthz',
        forwardHeaders: true,
      }),
    ]);
    const production = config.production;
    assert.ok(production !== undefined);
    const withDomain = deployPlan(
      { ...config, production: { ...production, domain: 'www.example.com' } },
      1,
    );
    assert.deepEqual(
      withDomain.steps.find((step) => step.kind === 'switch')?.argv?.slice(2),
      argv,
      'domain add and the release switch deploy one route',
    );
  });

  it('omits --tls with --no-tls', async () => {
    const { deps, calls } = makeDeps();

    const code = await runJamalCommand(['domain', 'add', 'example.com', '--no-tls'], deps);

    assert.equal(code, 0);
    assert.deepEqual(calls[0]?.remoteArgv, [
      ...proxyDeployArgv({
        service: 'myapp',
        target: `${CONTAINER}:3000`,
        host: 'example.com',
        tls: false,
        healthCheckPath: '/up',
      }),
    ]);
    assert.ok(!calls[0]?.remoteArgv.includes('--tls'));
  });

  it('honors --service as the proxy service name, routed to the live release', async () => {
    const { deps, calls } = makeDeps();

    const code = await runJamalCommand(['domain', 'add', 'example.com', '--service', 'web'], deps);

    assert.equal(code, 0);
    assert.deepEqual(calls[0]?.remoteArgv, [
      ...proxyDeployArgv({
        service: 'web',
        target: `${CONTAINER}:3000`,
        host: 'example.com',
        tls: true,
        healthCheckPath: '/up',
      }),
    ]);
  });

  it('--dry-run reads the live release, prints the exact ssh argv, and never runs it', async () => {
    const { deps, out, calls, locks } = makeDeps();

    const code = await runJamalCommand(['domain', 'add', 'example.com', '--dry-run'], deps);

    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    assert.deepEqual(locks, [], 'a dry run takes no lock');
    assert.match(
      out.join('\n'),
      new RegExp(
        "\\[dry-run\\] ssh -o BatchMode=yes 1\\.2\\.3\\.4 'docker exec kamal-proxy " +
          `kamal-proxy deploy myapp --target myapp-web-${release(1)}:3000 --host example\\.com --tls ` +
          "--health-check-path /up'",
      ),
    );
  });

  it('fails value-free, releasing the lock, when the server serves no release', async () => {
    const { deps, err, calls, locks } = makeDeps({ host: {} });

    const code = await runJamalCommand(['domain', 'add', 'example.com'], deps);

    assert.equal(code, 1);
    assert.equal(calls.length, 0);
    assert.deepEqual(locks, ['lock.acquire', 'lock.release']);
    assert.match(err.join('\n'), /the server has no live release to route a domain to/);
  });

  for (const dryRun of [false, true]) {
    it(`refuses${dryRun ? ' a dry run' : ''} while kamal-proxy is stopped, sending nothing but the reads`, async () => {
      const config = domainConfig({
        extra: { production: { server: '1.2.3.4', domain: 'example.com' } },
      });
      const { deps, out, err, calls } = makeDeps({
        config,
        host: { releases: [1], state: stateOf(1), containers: [1], proxy: 'stopped' },
      });

      const code = await runJamalCommand(
        ['domain', 'add', 'www.example.com', ...(dryRun ? ['--dry-run'] : [])],
        deps,
      );

      assert.equal(code, 1);
      assert.deepEqual(calls, []);
      assert.deepEqual(out, []);
      assert.match(err.join('\n'), /kamal-proxy is not running on the server/);
    });
  }

  it('requires a host', async () => {
    const { deps, err, calls } = makeDeps();

    const code = await runJamalCommand(['domain', 'add'], deps);

    assert.equal(code, 2);
    assert.equal(calls.length, 0);
    assert.match(err.join('\n'), /requires a host/);
  });

  it('rejects invalid host values as usage errors, value-free', async () => {
    for (const bad of [
      'https://example.com',
      'Example.COM',
      '*.example.com',
      'has space',
      'example.com/check',
      'example.com:443',
      'user@example.com',
    ]) {
      const { deps, err, calls } = makeDeps();
      const code = await runJamalCommand(['domain', 'add', bad], deps);
      assert.equal(code, 2, `expected usage error for ${JSON.stringify(bad)}`);
      assert.equal(calls.length, 0);
      assert.ok(
        !err.join('\n').includes(bad),
        `${JSON.stringify(bad)} must not leak into the error message`,
      );
    }
  });

  it('rejects an unknown flag as a usage error', async () => {
    const { deps, err } = makeDeps();

    const code = await runJamalCommand(['domain', 'add', 'example.com', '--bogus'], deps);

    assert.equal(code, 2);
    assert.match(err.join('\n'), /Unknown option/);
  });
});

describe('jamal domain remove', serverVerb, () => {
  it('removes the service (and its host) via the proxy remove argv', async () => {
    const { deps, calls, err } = makeDeps();

    const code = await runJamalCommand(['domain', 'remove', 'example.com'], deps);

    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(calls, [
      {
        server: '1.2.3.4',
        remoteArgv: [...proxyRemoveServiceArgv({ service: 'myapp' })],
        fenced: false,
      },
    ]);
  });

  it('honors --service and validates the host', async () => {
    const { deps, calls } = makeDeps();

    const code = await runJamalCommand(
      ['domain', 'remove', 'example.com', '--service', 'web'],
      deps,
    );

    assert.equal(code, 0);
    assert.deepEqual(calls[0]?.remoteArgv, [...proxyRemoveServiceArgv({ service: 'web' })]);
  });

  it('requires a host', async () => {
    const { deps, err } = makeDeps();

    const code = await runJamalCommand(['domain', 'remove'], deps);

    assert.equal(code, 2);
    assert.match(err.join('\n'), /requires a host/);
  });
});

describe('jamal domain list', serverVerb, () => {
  it('runs the proxy list argv and forwards its output verbatim', async () => {
    const { deps, out, calls, err } = makeDeps({
      answer: () => ({ stdout: 'myapp example.com\n' }),
    });

    const code = await runJamalCommand(['domain', 'list'], deps);

    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(calls, [
      { server: '1.2.3.4', remoteArgv: [...proxyListArgv()], fenced: false },
    ]);
    assert.match(out.join('\n'), /myapp example\.com/);
  });

  it('rejects extra positionals', async () => {
    const { deps, err } = makeDeps();

    const code = await runJamalCommand(['domain', 'list', 'extra'], deps);

    assert.equal(code, 2);
    assert.match(err.join('\n'), /unexpected argument/);
  });
});

describe('jamal domain: config and subcommand handling', serverVerb, () => {
  it('requires config.production', async () => {
    const { deps, err } = makeDeps({
      config: normalizeJamalConfig({ service: 'myapp', image: 'ghcr.io/acme/myapp' }),
    });

    const code = await runJamalCommand(['domain', 'list'], deps);

    assert.equal(code, 1);
    assert.match(err.join('\n'), /config\.production is required/);
  });

  it('reports an unknown subcommand as a usage error', async () => {
    const { deps, err } = makeDeps();

    const code = await runJamalCommand(['domain', 'bogus'], deps);

    assert.equal(code, 2);
    assert.match(err.join('\n'), /subcommand is required \(add \| list \| remove\)/);
  });

  it('reports a non-zero remote exit code value-free', async () => {
    const { deps, out, err } = makeDeps({ answer: () => ({ exitCode: 7, stdout: 'routing\n' }) });

    const code = await runJamalCommand(['domain', 'list'], deps);

    assert.equal(code, 7);
    assert.match(out.join('\n'), /routing/);
    assert.match(err.join('\n'), /domain list exited with code 7/);
  });
});
