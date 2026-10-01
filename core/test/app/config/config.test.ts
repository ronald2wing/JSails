/** Tests for loading (`loadApp`) and `validateAppConfig`: shape, host and port, field semantics, callbacks, extensions, and i18n prefix routing. */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  AppConfigError,
  DEFAULT_APP_CONFIG_PATH,
  DEFAULT_APP_HOST,
  DEFAULT_APP_PORT,
  DEFAULT_HEALTH_PATH,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  MAX_SHUTDOWN_TIMEOUT_MS,
  validateAppConfig,
  type ResolvedAppConfig,
} from '../../../src/app/config/index.js';
import { createApplication } from '../../../src/app/application.js';
import { loadApp } from '../../../src/kernel/load-app.js';
import { definePlugin } from '../../../src/plugins/contract/define-plugin.js';
import { ConfigErrors } from '../../../src/plugins/contract/errors.js';
import type { PageOutcome, PageRenderer } from '../../../src/contracts/render.js';
import type { RouteManifestEntry } from '../../../src/routing/routes.js';
import { DEFAULT_MAX_BODY_BYTES } from '../../../src/server/route-limits.js';
import { identitySource } from '../../../src/server/request-frame.js';
import { createTestSession } from '../../../src/testing/index.js';
import { documentOutcome } from '../../../src/pages/page.js';

/**
 * Tests for the application config loader. Config modules are written under the
 * project tree (not `os.tmpdir()`) so they inherit `"type": "module"` and load
 * as ESM. No test connects to a service, creates a directory for the resolved
 * config, or invokes a callback.
 */

const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'app-config-fixture-'),
);

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function makeDir(name: string): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(dir: string, content: string, filename = DEFAULT_APP_CONFIG_PATH): string {
  const path = join(dir, filename);
  writeFileSync(path, content);
  return path;
}

/** The resolved config of the app module at `configPath`, loaded by the kernel loader. */
async function loadAppConfig(
  configPath?: string,
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<ResolvedAppConfig> {
  const app = await loadApp({
    ...(configPath === undefined ? {} : { configPath }),
    ...options,
  });
  return app.config;
}

// ---------------------------------------------------------------------------
// loadAppConfig: import + resolution
// ---------------------------------------------------------------------------

describe('loadAppConfig', () => {
  it('loads jsails.app.js by default and resolves dirs from the config directory', async () => {
    const dir = makeDir('defaults');
    writeConfig(dir, `export default { port: 0 };`);

    const resolved = await loadAppConfig(undefined, { cwd: dir });

    assert.equal(resolved.configPath, join(dir, DEFAULT_APP_CONFIG_PATH));
    assert.equal(resolved.rootDir, dir);
    assert.equal(resolved.pagesDir, join(dir, 'pages'));
    assert.equal(resolved.apiDir, join(dir, 'api'));
    assert.equal(resolved.publicDir, join(dir, 'public'));
    assert.equal(resolved.outDir, join(dir, 'out'));
    assert.equal(resolved.host, DEFAULT_APP_HOST);
    assert.deepEqual(resolved.extensions, []);
    assert.equal(resolved.renderer, undefined);
    assert.equal(resolved.port, 0);
    assert.equal(resolved.maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
    assert.deepEqual(resolved.server, {
      origin: undefined,
      hosts: [],
      trustedProxies: 'none',
      timeouts: {},
      handlerTimeoutMs: 30_000,
    });
    assert.equal(resolved.resolveSession, undefined);
    assert.equal(resolved.setup, undefined);
  });

  it('resolves rootDir against the config directory and other dirs against rootDir', async () => {
    const dir = makeDir('nested');
    const sub = makeDir('nested/sub');
    writeConfig(
      sub,
      `export default {
  rootDir: '..',
  pages: 'src/pages',
  api: 'src/api',
  public: 'assets',
  out: 'build',
};`,
    );

    const resolved = await loadAppConfig(join(sub, DEFAULT_APP_CONFIG_PATH));

    assert.equal(resolved.rootDir, dir);
    assert.equal(resolved.pagesDir, join(dir, 'src/pages'));
    assert.equal(resolved.apiDir, join(dir, 'src/api'));
    assert.equal(resolved.publicDir, join(dir, 'assets'));
    assert.equal(resolved.outDir, join(dir, 'build'));
  });

  it('resolves a relative config path against the explicit cwd, not process.cwd()', async () => {
    const a = makeDir('cwd-a');
    const b = makeDir('cwd-b');
    writeConfig(a, `export default { host: '10.0.0.1' };`);
    writeConfig(b, `export default { host: '10.0.0.2' };`);

    const resolved = await loadAppConfig('jsails.app.js', { cwd: b });

    assert.equal(resolved.configPath, join(b, DEFAULT_APP_CONFIG_PATH));
    assert.equal(resolved.rootDir, b);
    assert.equal(resolved.host, '10.0.0.2');
  });

  it('imports a config whose path contains spaces', async () => {
    const dir = makeDir('with space');
    writeConfig(dir, `export default { host: '0.0.0.0' };`);

    const resolved = await loadAppConfig(join(dir, DEFAULT_APP_CONFIG_PATH));

    assert.equal(resolved.configPath, join(dir, DEFAULT_APP_CONFIG_PATH));
    assert.equal(resolved.rootDir, dir);
    assert.equal(resolved.host, '0.0.0.0');
  });

  it('passes setup through without invoking it', async () => {
    const dir = makeDir('setup');
    writeConfig(
      dir,
      `globalThis.__jsailsSetupCalled = false;
export default {
  setup() { globalThis.__jsailsSetupCalled = true; },
};`,
    );

    const resolved = await loadAppConfig(undefined, { cwd: dir });

    assert.equal(typeof resolved.setup, 'function');
    assert.equal(
      (globalThis as Record<string, unknown>).__jsailsSetupCalled,
      false,
      'setup must not run during load',
    );
    delete (globalThis as Record<string, unknown>).__jsailsSetupCalled;
  });

  it('refuses a TypeScript root that does not default-export defineApp', async () => {
    const dir = makeDir('typescript');
    for (const name of ['jsails.config.ts', 'jsails.config.mts']) {
      writeFileSync(join(dir, name), 'export default { port: 3000 };\n');
      await assert.rejects(loadAppConfig(name, { cwd: dir }), (error: unknown) => {
        assert.ok(ConfigErrors.is(error, 'invalid_app_definition'));
        assert.equal(error.context.path, name);
        return true;
      });
    }
  });

  it('keeps a module exception as the cause, never in the message, when import fails', async () => {
    const dir = makeDir('throwing-module');
    writeConfig(dir, `throw new Error('supersecret-password');`);

    await assert.rejects(loadAppConfig(undefined, { cwd: dir }), (error: unknown) => {
      assert.ok(error instanceof AppConfigError);
      assert.equal(error.code, 'load_failed');
      assert.doesNotMatch(error.message, /supersecret-password/);
      assert.ok(error.cause instanceof Error);
      assert.equal(error.cause.message, 'supersecret-password');
      return true;
    });
  });

  it('rejects a missing config module without leaking filesystem details', async () => {
    const dir = makeDir('missing-module');
    await assert.rejects(loadAppConfig(undefined, { cwd: dir }), (error: unknown) => {
      assert.ok(error instanceof AppConfigError);
      assert.match(error.message, /failed to load app config/);
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// validateAppConfig: shape + resolution
// ---------------------------------------------------------------------------

describe('loadAppConfig: JSAILS_TRUSTED_PROXIES', () => {
  it('applies the variable when the config states no trustedProxies', async () => {
    const dir = makeDir('trusted-env');
    writeConfig(dir, `export default { server: { origin: 'https://example.com' } };`);
    for (const [value, expected] of [
      ['hops=1', { hops: 1 }],
      [' none ', 'none'],
      ['10.0.0.0/8, fd00::/8', { cidrs: ['10.0.0.0/8', 'fd00::/8'] }],
      ['hops=1,173.245.48.0/20', { hops: 1, cidrs: ['173.245.48.0/20'] }],
      ['', 'none'],
    ] as const) {
      const resolved = await loadAppConfig(undefined, {
        cwd: dir,
        env: { JSAILS_TRUSTED_PROXIES: value },
      });
      assert.deepEqual(resolved.server.trustedProxies, expected);
      assert.equal(resolved.server.origin, 'https://example.com');
    }
  });

  it('keeps the config value and reports a disagreeing variable', async (t) => {
    const dir = makeDir('trusted-config-wins');
    writeConfig(dir, `export default { server: { trustedProxies: { hops: 2 } } };`);
    const warnings: string[] = [];
    const onWarning = (warning: Error & { code?: string }): void => {
      warnings.push(warning.code ?? '');
    };
    process.on('warning', onWarning);
    t.after(() => process.off('warning', onWarning));
    const resolved = await loadAppConfig(undefined, {
      cwd: dir,
      env: { JSAILS_TRUSTED_PROXIES: 'hops=1' },
    });
    const agreeing = await loadAppConfig(undefined, {
      cwd: dir,
      env: { JSAILS_TRUSTED_PROXIES: 'hops=2' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(resolved.server.trustedProxies, { hops: 2 });
    assert.deepEqual(agreeing.server.trustedProxies, { hops: 2 });
    assert.deepEqual(warnings, ['JSAILS_TRUSTED_PROXIES_IGNORED']);
  });

  it('rejects a malformed variable without echoing it', async () => {
    const dir = makeDir('trusted-invalid');
    writeConfig(dir, `export default {};`);
    for (const value of ['1', 'hops=0', 'hops=secret', 'secret-range', 'all']) {
      await assert.rejects(
        loadAppConfig(undefined, { cwd: dir, env: { JSAILS_TRUSTED_PROXIES: value } }),
        (error: unknown) =>
          error instanceof AppConfigError &&
          error.message.startsWith('JSAILS_TRUSTED_PROXIES must be') &&
          !error.message.includes('secret'),
      );
    }
  });

  it('never applies to validateAppConfig', () => {
    const previous = process.env.JSAILS_TRUSTED_PROXIES;
    process.env.JSAILS_TRUSTED_PROXIES = 'hops=1';
    try {
      assert.equal(validateAppConfig({}).server.trustedProxies, 'none');
    } finally {
      if (previous === undefined) delete process.env.JSAILS_TRUSTED_PROXIES;
      else process.env.JSAILS_TRUSTED_PROXIES = previous;
    }
  });
});

describe('loadAppConfig: listen overrides', () => {
  it('takes JSAILS_HOST and JSAILS_PORT over the config', async () => {
    const dir = makeDir('listen-override');
    writeConfig(dir, `export default { host: '127.0.0.1', port: 4000 };`);
    const resolved = await loadAppConfig(undefined, {
      cwd: dir,
      env: { JSAILS_HOST: '0.0.0.0', JSAILS_PORT: '3000' },
    });
    assert.equal(resolved.host, '0.0.0.0');
    assert.equal(resolved.port, 3000);
    assert.equal(resolved.rootDir, dir);
  });

  it('keeps the config values when the variables are unset or empty', async () => {
    const dir = makeDir('listen-unset');
    writeConfig(dir, `export default { port: 4000 };`);
    const resolved = await loadAppConfig(undefined, {
      cwd: dir,
      env: { JSAILS_HOST: '', JSAILS_PORT: '' },
    });
    assert.equal(resolved.host, DEFAULT_APP_HOST);
    assert.equal(resolved.port, 4000);
  });

  it('rejects an invalid port or host without echoing it', async () => {
    const dir = makeDir('listen-invalid');
    writeConfig(dir, `export default {};`);
    for (const env of [
      { JSAILS_PORT: '70000' },
      { JSAILS_PORT: '3000abc' },
      { JSAILS_HOST: 'evil host' },
    ]) {
      await assert.rejects(
        loadAppConfig(undefined, { cwd: dir, env }),
        (error: unknown) =>
          error instanceof AppConfigError &&
          !error.message.includes('70000') &&
          !error.message.includes('abc') &&
          !error.message.includes('evil'),
      );
    }
  });

  it('never applies to validateAppConfig', () => {
    const previous = process.env.JSAILS_PORT;
    process.env.JSAILS_PORT = '3999';
    try {
      assert.equal(validateAppConfig({ port: 4000 }).port, 4000);
    } finally {
      if (previous === undefined) delete process.env.JSAILS_PORT;
      else process.env.JSAILS_PORT = previous;
    }
  });
});

describe('validateAppConfig: shape', () => {
  it('rejects exports that are not plain objects', () => {
    for (const value of [
      undefined,
      null,
      42,
      'nope',
      true,
      [],
      new Map(),
      new (class Config {})(),
    ]) {
      assert.throws(
        () => validateAppConfig(value),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /default-export a plain object/);
          return true;
        },
      );
    }
  });

  it('rejects unknown top-level fields without echoing their names', () => {
    assert.throws(
      () => validateAppConfig({ nope: 'supersecret-password' }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /unrecognized config field/);
        assert.doesNotMatch(error.message, /supersecret-password/);
        return true;
      },
    );
  });

  it('applies defaults anchored at cwd when no configPath is given', () => {
    const cwd = makeDir('defaults-anchor');
    const resolved = validateAppConfig({}, { cwd });

    assert.equal(resolved.configPath, join(cwd, DEFAULT_APP_CONFIG_PATH));
    assert.equal(resolved.rootDir, cwd);
    assert.equal(resolved.pagesDir, join(cwd, 'pages'));
    assert.equal(resolved.apiDir, join(cwd, 'api'));
    assert.equal(resolved.publicDir, join(cwd, 'public'));
    assert.equal(resolved.outDir, join(cwd, 'out'));
    assert.equal(resolved.host, DEFAULT_APP_HOST);
    assert.equal(resolved.port, DEFAULT_APP_PORT);
    assert.equal(resolved.maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
  });

  it('anchors rootDir at an explicit relative configPath directory', () => {
    const cwd = makeDir('explicit-anchor');
    const resolved = validateAppConfig(
      { rootDir: 'app', pages: 'views' },
      { configPath: 'configs/jsails.app.js', cwd },
    );

    assert.equal(resolved.configPath, join(cwd, 'configs/jsails.app.js'));
    assert.equal(resolved.rootDir, join(cwd, 'configs', 'app'));
    assert.equal(resolved.pagesDir, join(cwd, 'configs', 'app', 'views'));
  });

  it('keeps absolute directory overrides', () => {
    const cwd = makeDir('absolute-dirs');
    const absolute = makeDir('absolute-dirs/root');
    const resolved = validateAppConfig(
      { rootDir: absolute, out: join(absolute, 'build') },
      { cwd },
    );

    assert.equal(resolved.rootDir, absolute);
    assert.equal(resolved.outDir, join(absolute, 'build'));
  });
});

describe('validateAppConfig: host and port', () => {
  it('preserves port 0 as an explicit ephemeral-port request', () => {
    assert.equal(validateAppConfig({ port: 0 }).port, 0);
  });

  it('rejects invalid ports', () => {
    for (const port of [-1, 65536, 1.5, Number.NaN, '3000']) {
      assert.throws(
        () => validateAppConfig({ port: port as unknown as number }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.port/);
          return true;
        },
      );
    }
  });

  it('rejects invalid hosts and accepts real host forms', () => {
    for (const host of ['', 'has space', 'http://example.com', 'a/b']) {
      assert.throws(
        () => validateAppConfig({ host }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.host/);
          return true;
        },
      );
    }
    for (const host of ['0.0.0.0', 'localhost', '::']) {
      assert.equal(validateAppConfig({ host }).host, host);
    }
  });

  it('rejects invalid body limits', () => {
    // Above the largest route cap a declared length is refused before routing.
    for (const maxBodyBytes of [0, -1, 1.5, '1024', 100 * 1024 * 1024 + 1]) {
      assert.throws(
        () =>
          validateAppConfig({
            maxBodyBytes: maxBodyBytes as unknown as number,
          }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.maxBodyBytes/);
          return true;
        },
      );
    }
  });
});

describe('validateAppConfig: field semantics', () => {
  it('canonicalizes a valid server.origin', () => {
    assert.equal(
      validateAppConfig({ server: { origin: 'https://Example.com:443' } }).server.origin,
      'https://example.com',
    );
    assert.equal(
      validateAppConfig({ server: { origin: 'http://localhost:8080' } }).server.origin,
      'http://localhost:8080',
    );
  });

  it('rejects non-origin server.origin values without echoing credentials', () => {
    for (const origin of [
      'not a url',
      'ftp://example.com',
      'https://example.com/path',
      'https://example.com?x=1',
      'https://example.com#frag',
    ]) {
      assert.throws(
        () => validateAppConfig({ server: { origin } }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.server\.origin/);
          return true;
        },
      );
    }

    assert.throws(
      () =>
        validateAppConfig({
          server: { origin: 'https://user:supersecret-password@example.com' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /credentials/);
        assert.doesNotMatch(error.message, /supersecret-password/);
        return true;
      },
    );
  });

  it('rejects the removed top-level publicOrigin key', () => {
    assert.throws(
      () => validateAppConfig({ publicOrigin: 'https://example.com' }),
      (error: unknown) =>
        error instanceof AppConfigError && error.message === 'unrecognized config field',
    );
  });

  it('resolves server.hosts and server.trustedProxies', () => {
    const resolved = validateAppConfig({
      server: {
        origin: 'https://example.com',
        hosts: ['*.example.com', 'example.org:8443'],
        trustedProxies: { hops: 2 },
      },
    });
    assert.deepEqual(resolved.server.hosts, ['*.example.com', 'example.org:8443']);
    assert.deepEqual(resolved.server.trustedProxies, { hops: 2 });
    assert.ok(Object.isFrozen(resolved.server));
    assert.deepEqual(
      validateAppConfig({ server: { trustedProxies: { cidrs: ['10.0.0.0/8', 'fd00::/8'] } } })
        .server.trustedProxies,
      { cidrs: ['10.0.0.0/8', 'fd00::/8'] },
    );
    assert.deepEqual(
      validateAppConfig({ server: { trustedProxies: { hops: 1, cidrs: ['173.245.48.0/20'] } } })
        .server.trustedProxies,
      { hops: 1, cidrs: ['173.245.48.0/20'] },
    );
  });

  it('rejects invalid hosts and trusted proxies without echoing them', () => {
    for (const [server, field] of [
      [{ hosts: ['example.org'] }, /config\.server\.hosts requires server\.origin/],
      [{ origin: 'https://example.com', hosts: ['*.com'] }, /config\.server\.hosts/],
      [{ origin: 'https://example.com', hosts: ['secret-host/path'] }, /config\.server\.hosts/],
      [{ origin: 'https://example.com', hosts: ['Example.org'] }, /config\.server\.hosts/],
      [{ origin: 'https://example.com', hosts: ['a.*.example.com'] }, /config\.server\.hosts/],
      [{ trustedProxies: { hops: 0 } }, /config\.server\.trustedProxies/],
      [{ trustedProxies: { hops: 1.5 } }, /config\.server\.trustedProxies/],
      [{ trustedProxies: { cidrs: [] } }, /config\.server\.trustedProxies/],
      [{ trustedProxies: { cidrs: ['secret-range/99'] } }, /config\.server\.trustedProxies/],
      [{ trustedProxies: { hops: 0, cidrs: ['10.0.0.0/8'] } }, /config\.server\.trustedProxies/],
      [{ trustedProxies: { hops: 1, cidrs: [] } }, /config\.server\.trustedProxies/],
      [
        { trustedProxies: { hops: 1, cidrs: ['secret-range/99'] } },
        /config\.server\.trustedProxies/,
      ],
      [{ trustedProxies: { hops: 1, ranges: ['10.0.0.0/8'] } }, /config\.server\.trustedProxies/],
      [{ trustedProxies: 'all' }, /config\.server\.trustedProxies/],
    ] as const) {
      assert.throws(
        () => validateAppConfig({ server }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, field);
          assert.doesNotMatch(error.message, /secret/);
          return true;
        },
      );
    }
  });

  it('rejects non-function callbacks', () => {
    for (const [name, value] of [
      ['resolveSession', 'x'],
      ['setup', {}],
    ] as const) {
      assert.throws(
        () => validateAppConfig({ [name]: value }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, new RegExp(`config\\.${name} must be a function`));
          return true;
        },
      );
    }
  });
});

// ---------------------------------------------------------------------------
// callback pass-through + immutability
// ---------------------------------------------------------------------------

describe('the session seam in the app config', () => {
  /** An app whose one API route answers the session id the request resolved. */
  async function whoami(name: string, config: Record<string, unknown>) {
    const dir = makeDir(name);
    mkdirSync(join(dir, 'api'), { recursive: true });
    writeFileSync(
      join(dir, 'api', 'whoami.js'),
      'export const GET = (_request, context) => Response.json({ session: context.session?.id ?? null });\nexport const authorize = () => true;\n',
    );
    const app = await createApplication(
      validateAppConfig({ rootDir: dir, port: 0, ...config }, { cwd: dir }),
    );
    const sessionOf = async (headers: Record<string, string>): Promise<unknown> => {
      const response = await app.fetch(new Request('http://localhost/api/whoami', { headers }));
      assert.equal(response.status, 200);
      return ((await response.json()) as { session: unknown }).session;
    };
    return { app, sessionOf };
  }

  it('resolves a token a bare resolveSession reads from its own header', async () => {
    const { app, sessionOf } = await whoami('session-seam-bare', {
      resolveSession: (request: Request) =>
        request.headers.get('x-api-token') === 'Bearer t1'
          ? createTestSession({ id: 'tok' })
          : null,
    });
    try {
      assert.equal(await sessionOf({ 'x-api-token': 'Bearer t1' }), 'tok');
    } finally {
      await app.close();
    }
  });

  it('passes a declared identity source to the HTTP pipeline', async () => {
    let resolved = 0;
    const identity = identitySource({
      headers: ['x-api-token'],
      resolve: () => {
        resolved += 1;
        return createTestSession({ id: 'tok' });
      },
    });
    assert.equal(validateAppConfig({ identity }).identity, identity);
    const { app, sessionOf } = await whoami('session-seam-identity', { identity });
    try {
      assert.equal(await sessionOf({ cookie: 'theme=dark' }), null);
      assert.equal(resolved, 0);
      assert.equal(await sessionOf({ 'x-api-token': 'Bearer t1' }), 'tok');
      assert.equal(resolved, 1);
    } finally {
      await app.close();
    }
  });

  it('rejects an identity source of the wrong shape or beside resolveSession', () => {
    const identity = identitySource({ cookies: ['sid'], resolve: () => null });
    for (const [config, message] of [
      [{ identity: { resolve: () => null } }, /config\.identity must implement/],
      [{ identity: 'secret' }, /config\.identity must implement/],
      [{ identity, resolveSession: () => null }, /mutually exclusive/],
    ] as const) {
      assert.throws(
        () => validateAppConfig(config),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, message);
          assert.doesNotMatch(error.message, /secret/);
          return true;
        },
      );
    }
  });
});

describe('validateAppConfig: callbacks and immutability', () => {
  it('passes callbacks through by identity and never invokes them', () => {
    let sessionCalls = 0;
    let setupCalls = 0;
    const resolveSession = async () => {
      sessionCalls += 1;
      return null;
    };
    const setup = (): void => {
      setupCalls += 1;
    };

    const resolved = validateAppConfig({ resolveSession, setup });

    assert.equal(resolved.resolveSession, resolveSession);
    assert.equal(resolved.setup, setup);
    assert.equal(sessionCalls, 0);
    assert.equal(setupCalls, 0);
  });

  it('does not mutate or freeze the input config', () => {
    const plugins = { use: ['jsails/auth'] };
    const input = {
      rootDir: '.',
      port: 0,
      server: { origin: 'https://example.com' },
      plugins,
    };
    const inputKeys = Object.keys(input);
    const pluginsKeys = Object.keys(plugins);

    const resolved = validateAppConfig(input, { cwd: '/tmp/anchor' });

    assert.deepEqual(Object.keys(input), inputKeys, 'the input must not gain or lose fields');
    assert.deepEqual(Object.keys(plugins), pluginsKeys, 'plugins must not be mutated');
    assert.equal(input.rootDir, '.');
    assert.equal(input.port, 0);
    assert.deepEqual(input.server, { origin: 'https://example.com' });
    assert.equal(Object.isFrozen(input), false);
    assert.equal(Object.isFrozen(plugins), false);
    assert.deepEqual(plugins.use, ['jsails/auth']);
    assert.deepEqual(resolved.plugins.use, ['jsails/auth']);
  });
});

// ---------------------------------------------------------------------------
// extensions + renderer: structural validation, identity pass-through
// ---------------------------------------------------------------------------

describe('validateAppConfig: extensions', () => {
  const extension = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    setup: () => {},
    ...extra,
  });

  it('defaults to an empty list when unset', () => {
    assert.deepEqual(validateAppConfig({}).extensions, []);
  });

  it('passes the list and its entries through by identity without invoking setup', () => {
    let setupCalls = 0;
    const setup = (): void => {
      setupCalls += 1;
    };
    const first = { name: 'a', setup };
    const second = { name: 'b', setup };
    const extensions = [first, second];

    const resolved = validateAppConfig({ extensions });

    assert.equal(resolved.extensions, extensions);
    assert.equal(resolved.extensions[0], first);
    assert.equal(resolved.extensions[1], second);
    assert.equal(setupCalls, 0);
  });

  it('accepts requires tokens structurally without invoking them', () => {
    const token = { name: 'db' };
    const resolved = validateAppConfig({
      extensions: [{ name: 'a', setup: () => {}, requires: [token] }],
    });
    assert.equal(resolved.extensions.length, 1);
  });

  it('rejects non-array, non-object, and malformed extensions', () => {
    assert.throws(
      () => validateAppConfig({ extensions: 'nope' }),
      /config\.extensions must be an array/,
    );
    assert.throws(
      () => validateAppConfig({ extensions: [null] }),
      /entries must be extension objects/,
    );
    assert.throws(
      () => validateAppConfig({ extensions: [42] }),
      /entries must be extension objects/,
    );
    assert.throws(
      () => validateAppConfig({ extensions: [{ setup: () => {} }] }),
      /identifier name/,
    );
    assert.throws(
      () => validateAppConfig({ extensions: [{ name: '  ', setup: () => {} }] }),
      /identifier name/,
    );
    assert.throws(() => validateAppConfig({ extensions: [{ name: 'a' }] }), /setup function/);
    assert.throws(
      () =>
        validateAppConfig({
          extensions: [{ name: 'a', setup: () => {}, requires: 'db' }],
        }),
      /requires must be an array/,
    );
    assert.throws(
      () =>
        validateAppConfig({
          extensions: [{ name: 'a', setup: () => {}, requires: [{}] }],
        }),
      /invalid service token/,
    );
  });

  it('rejects duplicate names early without echoing the name', () => {
    assert.throws(
      () =>
        validateAppConfig({
          extensions: [extension('alpha-secret'), extension('alpha-secret')],
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /duplicate names/);
        assert.doesNotMatch(error.message, /alpha-secret/);
        return true;
      },
    );
  });

  it('never leaks an extension value in an error', () => {
    assert.throws(
      () => validateAppConfig({ extensions: [{ name: 'supersecret-password' }] }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.doesNotMatch(error.message, /supersecret-password/);
        return true;
      },
    );
  });

  it('does not source extensions from the environment', () => {
    process.env.JSAILS_EXTENSIONS = 'nope';
    try {
      assert.deepEqual(validateAppConfig({}).extensions, []);
    } finally {
      delete process.env.JSAILS_EXTENSIONS;
    }
  });

  it('rejects malformed priority and disabled flags', () => {
    assert.throws(
      () =>
        validateAppConfig({
          extensions: [{ name: 'a', setup: () => {}, priority: 'x' }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /priority/);
        return true;
      },
    );
    assert.throws(
      () =>
        validateAppConfig({
          extensions: [{ name: 'a', setup: () => {}, disabled: 1 }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /disabled/);
        return true;
      },
    );
  });
});

describe('validateAppConfig: renderer', () => {
  class TestRenderer {
    calls = 0;
    constructor(private readonly label: string) {}
    render(): string {
      this.calls += 1;
      return `${this.label}:${this.calls}`;
    }
  }

  it('defaults to undefined when unset', () => {
    assert.equal(validateAppConfig({}).renderer, undefined);
  });

  it('passes a class renderer through by identity and preserves this and state', () => {
    const renderer = new TestRenderer('page');
    const resolved = validateAppConfig({ renderer });

    assert.equal(resolved.renderer, renderer);
    const roundTripped = resolved.renderer;
    assert.equal(roundTripped.render(), 'page:1');
    assert.equal(roundTripped.render(), 'page:2');
  });

  it('accepts a plain object renderer with a render function', () => {
    const renderer = { render: () => 'html' };
    assert.equal(validateAppConfig({ renderer }).renderer, renderer);
  });

  it('rejects renderers without a render function without echoing the value', () => {
    for (const renderer of [null, 42, 'supersecret-password', {}, { render: 'nope' }]) {
      assert.throws(
        () => validateAppConfig({ renderer }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.renderer/);
          assert.doesNotMatch(error.message, /supersecret-password/);
          return true;
        },
      );
    }
  });

  it('does not source a renderer from the environment', () => {
    process.env.JSAILS_RENDERER = 'nope';
    try {
      assert.equal(validateAppConfig({}).renderer, undefined);
    } finally {
      delete process.env.JSAILS_RENDERER;
    }
  });
});

describe('validateAppConfig: deployments', () => {
  it('rejects the removed deployments key as an unrecognized field', () => {
    assert.throws(
      () => validateAppConfig({ deployments: [] }),
      (error: unknown) =>
        error instanceof AppConfigError && error.message === 'unrecognized config field',
    );
  });
});

describe('validateAppConfig: plugins', () => {
  it('defaults to no plugins when absent', () => {
    assert.deepEqual(validateAppConfig({}).plugins, { use: [] });
    assert.deepEqual(validateAppConfig({ plugins: {} }).plugins, { use: [] });
  });

  it('refuses the app-wide authorize callback, naming its replacement', () => {
    assert.throws(
      () => validateAppConfig({ authorize: () => true }),
      (error: unknown) => {
        assert.ok(ConfigErrors.is(error, 'removed_option'));
        assert.equal(error.context.option, 'authorize');
        assert.equal(error.context.replacement, 'the access each API module states');
        return true;
      },
    );
  });

  it('refuses the removed options, naming each replacement', () => {
    const cases = [
      [{ managed: true }, 'plugins.managed', 'plugins.activation'],
      [{ force: true }, 'plugins.force', 'the requires and provides of definePlugin instances'],
      [
        { use: [{ specifier: '@jsails/auth', enabled: false }] },
        'plugins.use descriptor',
        'a definePlugin instance in plugins.use',
      ],
      [{ enabled: ['alpha'] }, 'plugins.enabled', 'the marketplace plugin source'],
      [{ downloads: true }, 'plugins.downloads', 'the marketplace plugin source'],
      [{ stateSource: {} }, 'plugins.stateSource', 'the marketplace plugin source'],
      [{ pluginsDir: 'var/plugins' }, 'plugins.pluginsDir', 'the marketplace plugin source'],
      [{ allowLoadFailures: true }, 'plugins.allowLoadFailures', 'the marketplace plugin source'],
    ] as const;
    for (const [plugins, option, replacement] of cases) {
      assert.throws(
        () => validateAppConfig({ plugins }),
        (error: unknown) => {
          assert.ok(ConfigErrors.is(error, 'removed_option'));
          assert.equal(error.context.option, option);
          assert.equal(error.context.replacement, replacement);
          return true;
        },
      );
    }
  });

  it('validates the activation mode and keeps it off the resolved config', () => {
    const resolved = validateAppConfig({ plugins: { activation: { mode: 'managed' } } });
    assert.deepEqual(resolved.plugins, { use: [] });
    assert.equal('activation' in resolved.plugins, false);
    for (const activation of [{ mode: 'open' }, { mode: 'managed', extra: 1 }, 'managed']) {
      assert.throws(
        () => validateAppConfig({ plugins: { activation } }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.plugins\.activation|unrecognized config field/);
          return true;
        },
      );
    }
  });

  it('resolves the plugins block into a frozen copy, leaving the input unfrozen', () => {
    const use = ['jsails/auth'];
    const plugins = { use };
    const resolved = validateAppConfig({ plugins });

    assert.deepEqual(resolved.plugins, { use });
    assert.equal(Object.isFrozen(resolved.plugins), true);
    assert.equal(Object.isFrozen(resolved.plugins.use), true);
    assert.equal(Object.isFrozen(plugins), false);
    assert.equal(Object.isFrozen(use), false);
  });

  it('refuses a removed option without echoing its value', () => {
    assert.throws(
      () => validateAppConfig({ plugins: { pluginsDir: 'supersecret-password' } }),
      (error: unknown) => {
        assert.ok(ConfigErrors.is(error, 'removed_option'));
        assert.doesNotMatch(error.message, /supersecret-password/);
        return true;
      },
    );
  });

  it('rejects unknown plugin config keys without echoing them', () => {
    assert.throws(
      () => validateAppConfig({ plugins: { nope: 'supersecret-password' } }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /unrecognized config field/);
        assert.doesNotMatch(error.message, /supersecret-password/);
        return true;
      },
    );
  });

  it('rejects a non-object plugins value', () => {
    for (const plugins of ['nope', 42, [], true]) {
      assert.throws(
        () => validateAppConfig({ plugins }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.plugins: expected an object/);
          return true;
        },
      );
    }
  });

  it('carries the plugins field through loadAppConfig', async () => {
    const dir = makeDir('plugins-module');
    writeConfig(dir, `export default { plugins: { use: ['jsails/auth'] } };`);

    const resolved = await loadAppConfig(undefined, { cwd: dir });

    assert.deepEqual(resolved.plugins, { use: ['jsails/auth'] });
  });

  // -- plugins.use: declarative specifier/tuple entries -------------------------

  it('accepts a bare string specifier in use', () => {
    const plugins = { use: ['jsails/auth', 'jsails/cache'] };
    assert.deepEqual(validateAppConfig({ plugins }).plugins?.use, ['jsails/auth', 'jsails/cache']);
  });

  it('accepts a [specifier, options] tuple in use', () => {
    const plugins = { use: [['jsails/auth', { sessionDuration: 3600 }]] as const };
    assert.deepEqual(validateAppConfig({ plugins }).plugins?.use, [
      ['jsails/auth', { sessionDuration: 3600 }],
    ]);
  });

  it('keeps plugin instances and legacy entries in declaration order', () => {
    const instance = definePlugin({ name: 'inline', setup() {} })();
    const use = ['jsails/mail', instance, ['jsails/auth', { tokenExpiry: 7200 }]] as const;
    const resolved = validateAppConfig({ plugins: { use } });
    assert.equal(resolved.plugins.use.length, 3);
    assert.strictEqual(resolved.plugins.use[1], instance);
  });

  it('rejects a use entry that is neither a plugin instance nor a specifier', () => {
    for (const entry of [42, {}, null]) {
      assert.throws(
        () => validateAppConfig({ plugins: { use: [entry] } }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.plugins\.use/);
          return true;
        },
      );
    }
  });

  it('accepts a mix of bare strings and tuples in use', () => {
    const plugins = { use: ['jsails/mail', ['jsails/auth', { tokenExpiry: 7200 }]] as const };
    assert.deepEqual(validateAppConfig({ plugins }).plugins?.use, [
      'jsails/mail',
      ['jsails/auth', { tokenExpiry: 7200 }],
    ]);
  });

  it('resolves use to an empty list when absent', () => {
    assert.deepEqual(validateAppConfig({ plugins: {} }).plugins.use, []);
    assert.deepEqual(
      validateAppConfig({ plugins: { activation: { mode: 'locked' } } }).plugins.use,
      [],
    );
  });

  it('preserves use without mutating it', () => {
    const use = ['jsails/auth'];
    const plugins = { use };
    const resolved = validateAppConfig({ plugins });

    assert.deepEqual(resolved.plugins.use, use);
    assert.equal(Object.isFrozen(plugins), false);
    assert.equal(Object.isFrozen(use), false);
  });

  it('rejects an empty string entry in use without echoing it', () => {
    assert.throws(
      () => validateAppConfig({ plugins: { use: [''] } }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /config\.plugins\.use/);
        return true;
      },
    );
  });

  it('rejects a tuple whose second element is not a plain object', () => {
    for (const bad of [null, 42, 'nope', [1, 2], ['supersecret-password']]) {
      assert.throws(
        () => validateAppConfig({ plugins: { use: [['jsails/auth', bad]] } }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.plugins\.use/);
          return true;
        },
      );
    }
  });

  it('rejects a tuple with wrong arity without echoing values', () => {
    assert.throws(
      () => validateAppConfig({ plugins: { use: [['jsails/auth']] } }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /config\.plugins\.use/);
        return true;
      },
    );
    assert.throws(
      () => validateAppConfig({ plugins: { use: [['jsails/auth', {}, 'extra']] } }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /config\.plugins\.use/);
        return true;
      },
    );
  });

  it('rejects a use entry that is neither string nor tuple', () => {
    for (const bad of [42, true, {}, []]) {
      assert.throws(
        () => validateAppConfig({ plugins: { use: [bad] } }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.plugins\.use/);
          return true;
        },
      );
    }
  });

  it('never echoes a use entry value in an error', () => {
    // A tuple whose second element embeds a secret — rejected because null is not
    // a plain object, and the error must not echo the secret.
    assert.throws(
      () => validateAppConfig({ plugins: { use: [['supersecret-password', null]] } }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.doesNotMatch(error.message, /supersecret-password/);
        return true;
      },
    );
  });

  it('carries use through loadAppConfig', async () => {
    const dir = makeDir('plugins-use-module');
    writeConfig(
      dir,
      `export default {
  plugins: {
    use: ['jsails/auth', ['jsails/cache', { ttl: 3600 }]],
  },
};`,
    );

    const resolved = await loadAppConfig(undefined, { cwd: dir });

    assert.deepEqual(resolved.plugins, {
      use: ['jsails/auth', ['jsails/cache', { ttl: 3600 }]],
    });
  });
});

// ---------------------------------------------------------------------------
// throwing property getters: value-free sanitization
// ---------------------------------------------------------------------------

describe('validateAppConfig: throwing getters', () => {
  const secret = 'supersecret-password';

  /** Assert the error is a value-free AppConfigError with no chained cause. */
  function assertRedacted(error: unknown): boolean {
    assert.ok(error instanceof AppConfigError);
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.equal(error.cause, undefined);
    return true;
  }

  it('sanitizes a throwing top-level config getter', () => {
    const config = {
      get port(): number {
        throw new Error(secret);
      },
    };
    assert.throws(() => validateAppConfig(config), assertRedacted);
  });

  it('sanitizes throwing extension field getters', () => {
    for (const field of ['name', 'setup', 'requires'] as const) {
      const extension: Record<string, unknown> = { name: 'x', setup: () => {} };
      Object.defineProperty(extension, field, {
        enumerable: true,
        get() {
          throw new Error(secret);
        },
      });
      assert.throws(() => validateAppConfig({ extensions: [extension] }), assertRedacted);
    }
  });

  it('sanitizes a throwing renderer method getter', () => {
    const renderer = {
      get render() {
        throw new Error(secret);
      },
    };
    assert.throws(() => validateAppConfig({ renderer }), assertRedacted);
  });

  it('sanitizes throwing plugin config getters', () => {
    for (const field of ['activation', 'use'] as const) {
      const plugins: Record<string, unknown> = {
        activation: { mode: 'locked' },
        use: ['jsails/auth'],
      };
      Object.defineProperty(plugins, field, {
        enumerable: true,
        get() {
          throw new Error(secret);
        },
      });
      assert.throws(() => validateAppConfig({ plugins }), assertRedacted);
    }

    const config = {
      get plugins() {
        throw new Error(secret);
      },
    };
    assert.throws(() => validateAppConfig(config), assertRedacted);
  });
});

// ---------------------------------------------------------------------------
// public directory isolation + shutdown timeout
// ---------------------------------------------------------------------------

describe('validateAppConfig: public directory isolation', () => {
  const cwd = makeDir('public-isolation');

  it('keeps sibling public/pages/api/out directories valid', () => {
    const resolved = validateAppConfig(
      { public: 'public', pages: 'pages', api: 'api', out: 'out' },
      { cwd },
    );

    assert.equal(resolved.publicDir, join(cwd, 'public'));
    assert.equal(resolved.pagesDir, join(cwd, 'pages'));
    assert.equal(resolved.apiDir, join(cwd, 'api'));
    assert.equal(resolved.outDir, join(cwd, 'out'));
  });

  it('rejects a public directory that equals or contains the project root', () => {
    for (const publicDir of ['.', '..']) {
      assert.throws(
        () => validateAppConfig({ public: publicDir }, { cwd }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /must not contain the project root/);
          return true;
        },
      );
    }
  });

  it('rejects a public directory overlapping pages/api/out in either direction', () => {
    const cases: ReadonlyArray<{
      config: Record<string, string>;
      field: string;
    }> = [
      { config: { public: 'pages' }, field: 'pages' },
      { config: { public: 'src', pages: 'src/pages' }, field: 'pages' },
      { config: { public: 'pages/sub', pages: 'pages' }, field: 'pages' },
      { config: { public: 'api' }, field: 'api' },
      { config: { public: 'api/v1', api: 'api' }, field: 'api' },
      { config: { public: 'dist', out: 'dist' }, field: 'out' },
      { config: { public: 'out/build', out: 'out' }, field: 'out' },
    ];
    for (const { config, field } of cases) {
      assert.throws(
        () => validateAppConfig(config, { cwd }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, new RegExp(`must not overlap the ${field} directory`));
          return true;
        },
      );
    }
  });

  it('rejects a config file living inside the public directory', () => {
    assert.throws(
      () =>
        validateAppConfig(
          { rootDir: '..', public: 'configs' },
          { configPath: join(cwd, 'configs', 'jsails.app.js'), cwd },
        ),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /must not live inside the public directory/);
        return true;
      },
    );
  });

  it('never echoes a path value in an isolation error', () => {
    assert.throws(
      () => validateAppConfig({ rootDir: 'supersecret-dir', public: '.' }, { cwd }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.doesNotMatch(error.message, /supersecret-dir/);
        return true;
      },
    );
  });
});

describe('validateAppConfig: storage directory', () => {
  const cwd = makeDir('storage');

  it('defaults storageDir to <rootDir>/storage and resolves a custom value', () => {
    assert.equal(validateAppConfig({}, { cwd }).storageDir, join(cwd, 'storage'));
    assert.equal(validateAppConfig({ storage: 'data' }, { cwd }).storageDir, join(cwd, 'data'));
  });

  it('resolves a relative storage against rootDir', () => {
    const resolved = validateAppConfig(
      { rootDir: 'app', storage: 'var/store' },
      { configPath: 'configs/jsails.app.js', cwd },
    );
    assert.equal(resolved.storageDir, join(cwd, 'configs', 'app', 'var/store'));
  });

  it('rejects a storage directory that equals the project root', () => {
    assert.throws(
      () => validateAppConfig({ storage: '.' }, { cwd }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /must not equal the project root/);
        return true;
      },
    );
  });

  it('rejects a storage directory overlapping public/out in either direction', () => {
    const cases: ReadonlyArray<{
      config: Record<string, string>;
      field: string;
    }> = [
      { config: { storage: 'public' }, field: 'public' },
      { config: { storage: 'public/sub', public: 'public' }, field: 'public' },
      { config: { storage: 'src', public: 'src/assets' }, field: 'public' },
      { config: { storage: 'out' }, field: 'out' },
      { config: { storage: 'dist', out: 'dist' }, field: 'out' },
    ];
    for (const { config, field } of cases) {
      assert.throws(
        () => validateAppConfig(config, { cwd }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, new RegExp(`must not overlap the ${field} directory`));
          return true;
        },
      );
    }
  });

  it('rejects a config file living inside the storage directory', () => {
    assert.throws(
      () =>
        validateAppConfig(
          { rootDir: '..', storage: 'configs' },
          { configPath: join(cwd, 'configs', 'jsails.app.js'), cwd },
        ),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /must not live inside the storage directory/);
        return true;
      },
    );
  });

  it('never echoes a path value in a storage isolation error', () => {
    assert.throws(
      () => validateAppConfig({ storage: 'supersecret-dir', public: 'supersecret-dir' }, { cwd }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.doesNotMatch(error.message, /supersecret-dir/);
        return true;
      },
    );
  });
});

describe('validateAppConfig: healthPath', () => {
  it('defaults to /up and disables on false', () => {
    assert.equal(validateAppConfig({}).healthPath, DEFAULT_HEALTH_PATH);
    assert.equal(validateAppConfig({ healthPath: false }).healthPath, undefined);
  });

  it('accepts the root path and a custom path', () => {
    assert.equal(validateAppConfig({ healthPath: '/' }).healthPath, '/');
    assert.equal(validateAppConfig({ healthPath: '/healthz' }).healthPath, '/healthz');
  });

  it('rejects malformed paths without echoing the value', () => {
    for (const healthPath of [
      'up',
      '/up/',
      'a/b',
      '/up?x=1',
      '/up#frag',
      '/up\\x',
      '/up//x',
      '/up:x',
      '/_jsails',
      '/_jsails/health',
    ]) {
      assert.throws(
        () => validateAppConfig({ healthPath }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.healthPath/);
          return true;
        },
      );
    }
  });

  it('never echoes the path value in an error', () => {
    assert.throws(
      () => validateAppConfig({ healthPath: 'supersecret-password' }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.doesNotMatch(error.message, /supersecret-password/);
        return true;
      },
    );
  });
});

describe('validateAppConfig: shutdownTimeoutMs', () => {
  it('defaults to DEFAULT_SHUTDOWN_TIMEOUT_MS and accepts positive bounded values', () => {
    assert.equal(validateAppConfig({}).shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS);
    assert.equal(validateAppConfig({ shutdownTimeoutMs: 30 }).shutdownTimeoutMs, 30);
    assert.equal(
      validateAppConfig({ shutdownTimeoutMs: MAX_SHUTDOWN_TIMEOUT_MS }).shutdownTimeoutMs,
      MAX_SHUTDOWN_TIMEOUT_MS,
    );
  });

  it('rejects non-positive, non-integer, and over-bounded timeouts', () => {
    for (const value of [0, -1, 1.5, Number.NaN, '5000', MAX_SHUTDOWN_TIMEOUT_MS + 1]) {
      assert.throws(
        () => validateAppConfig({ shutdownTimeoutMs: value as unknown as number }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.shutdownTimeoutMs/);
          return true;
        },
      );
    }
  });
});

// ---------------------------------------------------------------------------
// CLI commands are modules, not config
// ---------------------------------------------------------------------------

describe('validateAppConfig: CLI commands', () => {
  it('refuses a commands key, naming the command module convention', () => {
    assert.throws(
      () =>
        validateAppConfig({ commands: [{ name: 'hello', summary: 'say hello', run: () => 0 }] }),
      (error: unknown) => {
        assert.ok(ConfigErrors.is(error, 'removed_option'));
        assert.equal(error.context.option, 'commands');
        assert.equal(error.context.replacement, 'a defineCommand module under commands/');
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// middleware + globalMiddleware: removed (guards and transforms replace them)
// ---------------------------------------------------------------------------

describe('validateAppConfig: removed middleware keys', () => {
  it('refuses middleware and globalMiddleware, naming each replacement, value-free', () => {
    const forward = (_ctx: unknown, next: () => Promise<Response>) => next();
    const cases = [
      [
        { middleware: { 'secret-name': forward } },
        'middleware',
        'the middleware functions themselves in a route module middleware export',
      ],
      [
        { globalMiddleware: [forward, 'secret-name'] },
        'globalMiddleware',
        'http.guards and routes.transform',
      ],
    ] as const;
    for (const [input, option, replacement] of cases) {
      assert.throws(
        () => validateAppConfig(input),
        (error: unknown) => {
          assert.ok(ConfigErrors.is(error, 'removed_option'));
          assert.equal(error.context.option, option);
          assert.equal(error.context.replacement, replacement);
          assert.doesNotMatch(error.message, /secret-name/);
          return true;
        },
      );
    }
  });
});

// ---------------------------------------------------------------------------
// error hooks, readiness, system checks, server timeouts
// ---------------------------------------------------------------------------

describe('validateAppConfig: request errors and readiness', () => {
  it('passes onError, errorPage, readiness, and systemChecks through by identity', () => {
    const onError = (): void => undefined;
    const errorPage = (): string => '<h1>x</h1>';
    const readiness = { probes: { db: () => true }, path: '/ready' };
    const systemChecks = { register() {}, run: () => [] };
    const config = validateAppConfig({ onError, errorPage, readiness, systemChecks });
    assert.equal(config.onError, onError);
    assert.equal(config.errorPage, errorPage);
    assert.equal(config.readiness, readiness);
    assert.equal(config.systemChecks, systemChecks);
  });

  it('leaves every one of them unset by default', () => {
    const config = validateAppConfig({});
    for (const key of ['onError', 'errorPage', 'readiness', 'systemChecks'] as const) {
      assert.equal(config[key], undefined);
      assert.ok(!(key in config));
    }
  });

  it('rejects non-function error callbacks', () => {
    for (const name of ['onError', 'errorPage'] as const) {
      assert.throws(
        () => validateAppConfig({ [name]: 'nope' }),
        (error: unknown) =>
          error instanceof AppConfigError && error.message === `config.${name} must be a function`,
      );
    }
  });

  it('rejects malformed readiness options at load time without echoing values', () => {
    for (const readiness of [
      'yes',
      { probes: { db: 'SELECT 1 secret' } },
      { timeoutMs: 0 },
      { cacheMs: -1 },
      { authorize: true },
      { path: 'ready' },
    ]) {
      assert.throws(
        () => validateAppConfig({ readiness }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /^config\.readiness/);
          assert.doesNotMatch(error.message, /secret/);
          return true;
        },
      );
    }
  });

  it('rejects a readiness path equal to the health path', () => {
    assert.throws(
      () => validateAppConfig({ readiness: { path: '/up' } }),
      (error: unknown) => error instanceof AppConfigError && /differ/.test(error.message),
    );
    assert.equal(
      validateAppConfig({ healthPath: '/health', readiness: { path: '/up' } }).readiness?.path,
      '/up',
    );
  });

  it('rejects a systemChecks value without run', () => {
    for (const systemChecks of [{}, 'checks', null]) {
      assert.throws(
        () => validateAppConfig({ systemChecks }),
        (error: unknown) =>
          error instanceof AppConfigError && /systemChecks must be/.test(error.message),
      );
    }
  });
});

describe('validateAppConfig: server timeouts', () => {
  it('keeps only the overrides that were set', () => {
    const config = validateAppConfig({
      server: { keepAliveTimeoutMs: 70_000, headersTimeoutMs: 71_000, requestTimeoutMs: undefined },
    });
    assert.deepEqual(config.server.timeouts, {
      keepAliveTimeoutMs: 70_000,
      headersTimeoutMs: 71_000,
    });
    assert.ok(Object.isFrozen(config.server.timeouts));
  });

  it('accepts a disabled request timeout', () => {
    assert.deepEqual(validateAppConfig({ server: { requestTimeoutMs: 0 } }).server.timeouts, {
      requestTimeoutMs: 0,
    });
  });

  it('rejects mistyped, non-positive, and unknown fields', () => {
    for (const server of [
      { keepAliveTimeoutMs: 0 },
      { headersTimeoutMs: -1 },
      { requestTimeoutMs: 1.5 },
      { keepAliveTimeoutMs: '65000' },
      { idleTimeoutMs: 1 },
    ]) {
      assert.throws(
        () => validateAppConfig({ server }),
        (error: unknown) => error instanceof AppConfigError,
      );
    }
  });

  it('rejects a headers timeout above the request timeout', () => {
    assert.throws(
      () => validateAppConfig({ server: { headersTimeoutMs: 400_000 } }),
      (error: unknown) =>
        error instanceof AppConfigError &&
        error.message === 'config.server: headersTimeoutMs must not exceed requestTimeoutMs',
    );
  });
});

describe('validateAppConfig: render', () => {
  it('is absent unless configured', () => {
    assert.equal(validateAppConfig({}).render, undefined);
  });

  it('keeps only the settings that were set, frozen', () => {
    const config = validateAppConfig({ render: { streamTimeoutMs: undefined } });
    assert.deepEqual(config.render, {});
    assert.ok(Object.isFrozen(config.render));
    assert.deepEqual(validateAppConfig({ render: { streamTimeoutMs: 5000 } }).render, {
      streamTimeoutMs: 5000,
    });
    assert.deepEqual(validateAppConfig({ render: {} }).render, {});
  });

  it('rejects mistyped, out-of-range, and unknown fields without echoing them', () => {
    for (const render of [
      // The app-wide switch is gone: a page opts into streaming itself.
      { stream: true },
      { stream: 'yes-secret' },
      { stream: 1 },
      { streamTimeoutMs: 0 },
      { streamTimeoutMs: -5 },
      { streamTimeoutMs: 1.5 },
      { streamTimeoutMs: 2_147_483_648 },
      { streamTimeoutMs: '1000' },
      { streamSecret: true },
      'stream',
      null,
    ]) {
      assert.throws(
        () => validateAppConfig({ render }),
        (error: unknown) =>
          error instanceof AppConfigError &&
          error.code === 'invalid_config' &&
          /^(config\.render\b|unrecognized config field$)/.test(error.message) &&
          !error.message.includes('secret'),
      );
    }
  });
});

describe('validateAppConfig: telemetry', () => {
  it('is absent unless trustInbound is set, and frozen when it is', () => {
    assert.equal(validateAppConfig({}).telemetry, undefined);
    assert.equal(validateAppConfig({ telemetry: {} }).telemetry, undefined);
    const config = validateAppConfig({ telemetry: { trustInbound: true } });
    assert.deepEqual(config.telemetry, { trustInbound: true });
    assert.ok(Object.isFrozen(config.telemetry));
  });

  it('rejects mistyped and unknown fields without echoing them', () => {
    for (const telemetry of [
      { trustInbound: 'yes-secret' },
      { trustInbound: 1 },
      { secretSink: true },
      'telemetry',
      null,
    ]) {
      assert.throws(
        () => validateAppConfig({ telemetry }),
        (error: unknown) =>
          error instanceof AppConfigError &&
          error.code === 'invalid_config' &&
          /^(config\.telemetry\b|unrecognized config field$)/.test(error.message) &&
          !error.message.includes('secret'),
      );
    }
  });
});

describe('validateAppConfig: extension readiness', () => {
  it('rejects malformed or duplicated extension readiness probes without echoing names', () => {
    const setup = (): void => undefined;
    for (const [extensions, pattern] of [
      [[{ name: 'a', setup, readiness: { db: 'x' } }], /readiness must be an object/],
      [[{ name: 'a', setup, readiness: [] }], /readiness must be an object/],
      [
        [
          { name: 'a', setup, readiness: { 'secret-db': () => true } },
          { name: 'b', setup, readiness: { 'secret-db': () => true } },
        ],
        /same readiness probe name/,
      ],
    ] as const) {
      assert.throws(
        () => validateAppConfig({ extensions }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, pattern);
          assert.doesNotMatch(error.message, /secret/);
          return true;
        },
      );
    }
  });
});

describe('validateAppConfig: i18n prefix routing', () => {
  it('accepts locales and defaultLocale and resolves them as given', () => {
    const config = validateAppConfig({
      i18n: { locales: ['en', 'fr'], defaultLocale: 'en' },
    });
    assert.deepEqual(config.i18n?.locales, ['en', 'fr']);
    assert.equal(config.i18n?.defaultLocale, 'en');
    assert.ok(Object.isFrozen(config.i18n?.locales));
  });

  it('accepts a defaultLocale that is the configured locale', () => {
    const config = validateAppConfig({
      i18n: { locale: 'fr', locales: ['fr', 'en'], defaultLocale: 'fr' },
    });
    assert.equal(config.i18n?.defaultLocale, 'fr');
  });

  it('rejects malformed, empty, duplicated, or inconsistent locales without echoing them', () => {
    for (const i18n of [
      { locales: [] },
      { locales: ['secret locale'] },
      { locales: ['fr', 'fr'] },
      { locales: [''] },
      { locales: 'fr' },
      { defaultLocale: 'secret locale' },
      { defaultLocale: '' },
      { defaultLocale: 'en' },
      { locales: ['fr'], defaultLocale: 'en' },
      { locales: ['fr', 'de'], defaultLocale: 'en' },
      { locale: 'en', locales: ['en', 'fr'], defaultLocale: 'fr' },
      { locales: ['en', 'fr'], defaultLocale: 'fr' },
    ]) {
      assert.throws(
        () => validateAppConfig({ i18n }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.i18n/);
          assert.doesNotMatch(error.message, /secret/);
          return true;
        },
      );
    }
  });

  it('registers locale-prefixed routes, leaving the default locale bare', async () => {
    const dir = makeDir('i18n-prefix-routing');
    mkdirSync(join(dir, 'pages', 'about'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'about', 'index.js'), 'export default () => null;\n');
    const rendered: string[] = [];
    const renderer: PageRenderer = {
      render(entry: RouteManifestEntry): PageOutcome {
        rendered.push(entry.route);
        return documentOutcome(`<p>${entry.route}</p>`);
      },
    };
    const config = validateAppConfig(
      { rootDir: dir, port: 0, renderer, i18n: { locales: ['en', 'fr'], defaultLocale: 'en' } },
      { cwd: dir },
    );
    const app = await createApplication(config);
    try {
      assert.equal((await app.fetch(new Request('http://localhost/fr/about'))).status, 200);
      assert.equal((await app.fetch(new Request('http://localhost/about'))).status, 200);
      assert.equal((await app.fetch(new Request('http://localhost/en/about'))).status, 404);
      assert.deepEqual(rendered, ['/about', '/about']);
    } finally {
      await app.close();
    }
  });
});
