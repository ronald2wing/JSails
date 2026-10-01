/**
 * Tests for `jsails check`: the deploy rules over a resolved config, the
 * command's output and exit codes through injected dependencies, and the
 * compiled CLI, which checks the deployed (`production`) environment by
 * default under `--deploy`.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { runCli as spawnCli } from '../spawn-cli.js';

import type { ResolvedAppConfig } from '../../../src/app/config/index.js';
import { AppConfigError } from '../../../src/app/config/errors.js';
import {
  deployFindings,
  runCheck,
  type CheckDeps,
  type CheckResult,
} from '../../../src/cli/commands/check.js';
import type { TrustedProxies } from '../../../src/security/request-origin.js';

const ORIGIN = 'https://example.com';

/** A resolved config holding only the `server` the rules read. */
function configWith(origin: string | undefined, trustedProxies: TrustedProxies): ResolvedAppConfig {
  return {
    server: { origin, hosts: [], trustedProxies, timeouts: {}, handlerTimeoutMs: 30_000 },
  } as unknown as ResolvedAppConfig;
}

/** Injected deps around `config` (or a load failure), capturing the output. */
function depsFor(
  load: () => Promise<ResolvedAppConfig>,
  env: Record<string, string | undefined> = {},
): { deps: CheckDeps; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    deps: {
      loadConfig: load,
      env,
      cwd: process.cwd(),
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    stdout,
    stderr,
  };
}

/** Each finding as `[code, severity]`. */
function codes(findings: readonly { code: string; severity: string }[]): string[][] {
  return findings.map((finding) => [finding.code, finding.severity]);
}

describe('deployFindings', () => {
  it('finds nothing for an origin and a trust the deploy agrees with', () => {
    assert.deepEqual(
      deployFindings(configWith(ORIGIN, { hops: 1 }), { JSAILS_TRUSTED_PROXIES: 'hops=1' }),
      [],
    );
    assert.deepEqual(
      deployFindings(configWith(ORIGIN, { hops: 2, cidrs: ['173.245.48.0/20'] }), {
        JSAILS_TRUSTED_PROXIES: 'hops=2,173.245.48.0/20',
      }),
      [],
    );
  });

  it('says when the environment states no topology, without failing', () => {
    const findings = deployFindings(configWith(ORIGIN, 'none'), {});
    assert.deepEqual(codes(findings), [['proxy_trust_unstated', 'info']]);
    assert.match(findings[0]?.message ?? '', /JSAILS_TRUSTED_PROXIES is not set here/);
  });

  it('fails a config without server.origin, pointing at the deploy variables', () => {
    const findings = deployFindings(configWith(undefined, 'none'), {
      JSAILS_TRUSTED_PROXIES: 'none',
    });
    assert.deepEqual(codes(findings), [['origin_missing', 'error']]);
    assert.match(findings[0]?.message ?? '', /config\.server\.origin is not set/);
    assert.match(findings[0]?.message ?? '', /variables the deployed app receives/);
  });

  it("fails a config whose 'none' overrides the proxies the deploy states", () => {
    const findings = deployFindings(configWith(ORIGIN, 'none'), {
      JSAILS_TRUSTED_PROXIES: 'hops=2',
    });
    assert.deepEqual(
      findings.map((finding) => [finding.code, finding.severity]),
      [['proxy_untrusted', 'error']],
    );
  });

  it('fails a config that states another trust than the deploy', () => {
    for (const trust of [
      { cidrs: ['10.0.0.0/8'] },
      { hops: 1 },
      { hops: 2, cidrs: ['10.0.0.0/8'] },
    ] satisfies TrustedProxies[]) {
      const findings = deployFindings(configWith(ORIGIN, trust), {
        JSAILS_TRUSTED_PROXIES: 'hops=2',
      });
      assert.deepEqual(codes(findings), [['proxy_trust_overridden', 'error']]);
    }
  });

  it('reads a blank statement as none stated', () => {
    assert.deepEqual(
      codes(deployFindings(configWith(ORIGIN, 'none'), { JSAILS_TRUSTED_PROXIES: '  ' })),
      [['proxy_trust_unstated', 'info']],
    );
  });
});

describe('runCheck', () => {
  it('reports a loaded config and runs no deploy rule without --deploy', async () => {
    const { deps, stdout } = depsFor(async () => configWith(undefined, 'none'));
    const code = await runCheck({ configPath: 'jsails.app.js', deploy: false, json: false }, deps);
    assert.equal(code, 0);
    assert.deepEqual(stdout, ['config jsails.app.js loads (environment development)']);
  });

  it('exits 1 on a deploy error and lists every finding', async () => {
    const { deps, stdout } = depsFor(async () => configWith(undefined, 'none'), {
      JSAILS_ENV: 'production',
      JSAILS_TRUSTED_PROXIES: 'hops=1',
    });
    const code = await runCheck({ configPath: undefined, deploy: true, json: false }, deps);
    assert.equal(code, 1);
    assert.equal(stdout[0], 'config jsails.app.js loads (environment production)');
    assert.match(stdout[1] ?? '', /^error origin_missing: /);
    assert.match(stdout[2] ?? '', /^error proxy_untrusted: /);
    assert.equal(stdout[3], 'deploy: 2 errors');
  });

  it('exits 1 on a trust that overrides the deploy with another count', async () => {
    const { deps, stdout } = depsFor(async () => configWith(ORIGIN, { hops: 1 }), {
      JSAILS_TRUSTED_PROXIES: 'hops=2',
    });
    const code = await runCheck({ configPath: undefined, deploy: true, json: false }, deps);
    assert.equal(code, 1);
    assert.match(stdout[1] ?? '', /^error proxy_trust_overridden: /);
    assert.equal(stdout.at(-1), 'deploy: 1 error');
  });

  it('exits 0 on an info line alone and prints it', async () => {
    const { deps, stdout } = depsFor(async () => configWith(ORIGIN, 'none'));
    const code = await runCheck({ configPath: undefined, deploy: true, json: false }, deps);
    assert.equal(code, 0);
    assert.match(stdout[1] ?? '', /^info proxy_trust_unstated: /);
    assert.equal(stdout.at(-1), 'deploy: no problems found');
  });

  it('prints one JSON document with --json', async () => {
    const { deps, stdout } = depsFor(async () => configWith(ORIGIN, 'none'), {
      JSAILS_ENV: 'staging',
      JSAILS_TRUSTED_PROXIES: 'none',
    });
    const code = await runCheck({ configPath: 'app.js', deploy: true, json: true }, deps);
    assert.equal(code, 0);
    assert.equal(stdout.length, 1);
    const result = JSON.parse(stdout[0] ?? '') as CheckResult;
    assert.deepEqual(result, {
      config: 'app.js',
      environment: 'staging',
      deploy: true,
      findings: [],
    });
  });

  it('reports a config failure value-free and exits 1', async () => {
    const { deps, stdout, stderr } = depsFor(async () => {
      throw new AppConfigError('config.server.origin must be an http or https origin');
    });
    const code = await runCheck({ configPath: undefined, deploy: true, json: false }, deps);
    assert.equal(code, 1);
    assert.deepEqual(stdout, []);
    assert.equal(stderr[0], 'jsails: config.server.origin must be an http or https origin');
  });
});

describe('jsails check (compiled CLI)', () => {
  const root = mkdtempSync(join(tmpdir(), 'jsails-check-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  /** A project whose config reads its origin from PUBLIC_ORIGIN and states no trust. */
  function project(name: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'jsails.app.js'),
      'export default { server: { origin: process.env.PUBLIC_ORIGIN || undefined } };\n',
    );
    return dir;
  }

  /** The test process's environment without anything that picks or resolved an environment. */
  function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
    for (const key of [
      'NODE_ENV',
      'JSAILS_ENV',
      'JSAILS_ENV_RESOLVED',
      'JSAILS_CREDENTIALS_KEY',
      'PUBLIC_ORIGIN',
      'JSAILS_TRUSTED_PROXIES',
    ]) {
      if (!(key in extra)) delete env[key];
    }
    return env;
  }

  it('checks the production environment under --deploy unless one is named', async () => {
    const dir = project('default-production');
    const deploy = await spawnCli(['check', '--deploy', '--json'], {
      cwd: dir,
      env: childEnv({ PUBLIC_ORIGIN: ORIGIN, JSAILS_TRUSTED_PROXIES: 'hops=1' }),
    });
    assert.equal(deploy.status, 0, deploy.stderr);
    const result = JSON.parse(deploy.stdout) as CheckResult;
    assert.equal(result.environment, 'production');
    assert.deepEqual(result.findings, []);

    const plain = await spawnCli(['check', '--json'], { cwd: dir, env: childEnv({}) });
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal((JSON.parse(plain.stdout) as CheckResult).environment, 'development');
  });

  it('fails a deploy without an origin, in the environment named by --env', async () => {
    const dir = project('named-staging');
    const result = await spawnCli(['--env', 'staging', 'check', '--deploy'], {
      cwd: dir,
      env: childEnv({}),
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^config jsails\.app\.js loads \(environment staging\)$/m);
    assert.match(result.stdout, /^error origin_missing: /m);
    assert.match(result.stdout, /^info proxy_trust_unstated: /m);
  });

  it("fails a config whose 'none' beats the topology a deploy states", async () => {
    const dir = join(root, 'none-beats-deploy');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'jsails.app.js'),
      `export default { server: { origin: '${ORIGIN}', trustedProxies: 'none' } };\n`,
    );
    const result = await spawnCli(['check', '--deploy'], {
      cwd: dir,
      env: childEnv({ JSAILS_TRUSTED_PROXIES: 'hops=1' }),
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^error proxy_untrusted: /m);
  });

  it('refuses an unknown flag as a usage error', async () => {
    const result = await spawnCli(['check', '--deplyo'], {
      cwd: project('usage'),
      env: childEnv({}),
    });
    assert.equal(result.status, 2);
  });
});
