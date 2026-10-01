/**
 * Tests for the `jamal cache-proxy` command: help, argument validation, status,
 * and plan output.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runJamalCommand, type JamalDeps } from '../src/command.js';
import { normalizeJamalConfig, type JamalConfig } from '../src/config/index.js';
import { CACHE_PROXY_IMAGE_DEFAULT } from '../src/production/cache-proxy.js';

/**
 * Tests for the `jamal cache-proxy` verbs. The config loader is injected, so no
 * file is read and no docker/ssh command is ever spawned. Assertions target the
 * status/plan output, the cookie-allowlist application, positional/flag
 * validation, and the value-free failure paths.
 */

interface Harness {
  deps: JamalDeps;
  out: string[];
  err: string[];
}

function makeDeps(config?: JamalConfig): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const deps: JamalDeps = {
    loadJamalConfig: async () => config ?? normalizeJamalConfig({ service: 'myapp', image: 'img' }),
    cwd: '/project',
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return { deps, out, err };
}

function enabledConfig(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    cacheProxy: { enabled: true, cookieAllowlist: ['session_id'] },
  });
}

describe('jamal cache-proxy --help', () => {
  it('prints usage without loading the config', async () => {
    const { deps, out, err } = makeDeps();
    const code = await runJamalCommand(['cache-proxy', '--help'], deps);

    assert.equal(code, 0);
    assert.match(out.join('\n'), /Usage:/);
    assert.match(out.join('\n'), /plan\|status/);
    assert.equal(err.length, 0);
  });
});

/**
 * `jamal cache-proxy` is a server-facing verb, so Windows refuses it with
 * `unsupported_platform` (`cli/platform-guard.ts`;
 * `core/test/cli/platform-guard.test.ts` proves the refusal): the tests of
 * what it does run on POSIX only. Its help still prints on every platform.
 */
const serverVerb = {
  skip:
    process.platform === 'win32' &&
    'jamal cache-proxy is a server-facing verb, which Windows refuses',
};

describe('jamal cache-proxy: argument validation', serverVerb, () => {
  it('rejects a missing verb', async () => {
    const { deps, err } = makeDeps();
    const code = await runJamalCommand(['cache-proxy'], deps);
    assert.equal(code, 2);
    assert.match(err.join('\n'), /a verb is required/);
  });

  it('rejects an unknown verb', async () => {
    const { deps, err } = makeDeps();
    const code = await runJamalCommand(['cache-proxy', 'bogus'], deps);
    assert.equal(code, 2);
    assert.match(err.join('\n'), /a verb is required/);
  });

  it('rejects a trailing positional', async () => {
    const { deps, err } = makeDeps();
    const code = await runJamalCommand(['cache-proxy', 'status', 'extra'], deps);
    assert.equal(code, 2);
    assert.match(err.join('\n'), /unexpected argument/);
  });

  it('rejects --release on status', async () => {
    const { deps, err } = makeDeps();
    const code = await runJamalCommand(
      ['cache-proxy', 'status', '--release', '20261123100000-0123456789ab'],
      deps,
    );
    assert.equal(code, 2);
    assert.match(err.join('\n'), /--release is only valid/);
  });

  it('rejects a --release that is no release id, value-free', async () => {
    const { deps, err } = makeDeps();
    const code = await runJamalCommand(['cache-proxy', 'plan', '--release', 'v1;rm'], deps);
    assert.equal(code, 2);
    assert.match(err.join('\n'), /--release must be a release id/);
    assert.ok(!err.join('\n').includes('v1;rm'));
  });
});

describe('jamal cache-proxy status', serverVerb, () => {
  it('reports "not configured" when cacheProxy is absent', async () => {
    const { deps, out } = makeDeps(normalizeJamalConfig({ service: 'myapp', image: 'img' }));
    const code = await runJamalCommand(['cache-proxy', 'status'], deps);
    assert.equal(code, 0);
    assert.match(out.join('\n'), /not configured/);
  });

  it('reports a disabled cache proxy with its image, size, and allowlist', async () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      cacheProxy: { enabled: false },
    });
    const { deps, out } = makeDeps(config);
    const code = await runJamalCommand(['cache-proxy', 'status'], deps);

    assert.equal(code, 0);
    const text = out.join('\n');
    assert.match(text, /cache proxy: disabled/);
    assert.ok(text.includes(`image: ${CACHE_PROXY_IMAGE_DEFAULT}`), 'the pinned default image');
    assert.match(text, /size: 256m/);
    assert.match(text, /cookie allowlist: none/);
  });

  it('reports an enabled cache proxy with its allowlist', async () => {
    const { deps, out } = makeDeps(enabledConfig());
    const code = await runJamalCommand(['cache-proxy', 'status'], deps);

    assert.equal(code, 0);
    const text = out.join('\n');
    assert.match(text, /cache proxy: enabled/);
    assert.match(text, /cookie allowlist: session_id/);
  });
});

describe('jamal cache-proxy plan', serverVerb, () => {
  it('refuses to plan when the cache proxy is disabled or absent', async () => {
    const { deps, err } = makeDeps(normalizeJamalConfig({ service: 'myapp', image: 'img' }));
    const code = await runJamalCommand(['cache-proxy', 'plan'], deps);
    assert.equal(code, 1);
    assert.match(err.join('\n'), /cacheProxy\.enabled must be true/);
  });

  it('prints the resolved VCL with the allowlist applied', async () => {
    const { deps, out } = makeDeps(enabledConfig());
    const code = await runJamalCommand(['cache-proxy', 'plan'], deps);

    assert.equal(code, 0);
    const text = out.join('\n');
    assert.match(text, /backend myapp-web-<release-id>/);
    assert.match(text, /regsuball\(req\.http\.Cookie, "\(\^\|; \*\)session_id=\[\^;\]\*", ""\)/);
    assert.ok(!text.includes('__BACKEND_HOST__'), 'placeholder must be replaced');
  });

  it('names the backend container of the release --release names', async () => {
    const { deps, out } = makeDeps(enabledConfig());
    const code = await runJamalCommand(
      ['cache-proxy', 'plan', '--release', '20261123100000-0123456789ab'],
      deps,
    );

    assert.equal(code, 0);
    assert.match(out.join('\n'), /backend myapp-web-20261123100000-0123456789ab/);
  });
});
