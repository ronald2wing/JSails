/**
 * Tests for the app-level Valkey provider: `valkeyPlugin` (on the kernel
 * contract, proven inert by the harness) registers one provider under
 * `valkeyToken` and the `valkey` lifecycle unit, whose start connects and
 * whose readiness pings, and closes the provider on teardown;
 * `useValkeyConnections` returns the registered provider, creates and
 * registers one from `VALKEY_URL`, or finds none.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { runExtensions } from '../../src/extensions/extension.js';
import { definePlugin } from '../../src/extensions/plugin-contract.js';
import { ConfigErrors } from '../../src/plugins/contract/errors.js';
import { testPlugin } from '../../src/testing/plugin-harness.js';
import { ValkeyError, type ValkeyConnections } from '../../src/valkey/connections.js';
import { valkeyPlugin } from '../../src/valkey/plugin.js';
import { useValkeyConnections, valkeyToken } from '../../src/valkey/provider.js';

const URL = 'redis://127.0.0.1:6379';
/** Port 1 refuses at once, so a connect fails fast without a server. */
const REFUSED_URL = 'redis://127.0.0.1:1';

/**
 * An app root outside the working directory, named `shop-app` by its
 * manifest: a prefix derived from the working directory would name another
 * app, never this one.
 */
const appRoot = mkdtempSync(join(tmpdir(), 'jsails-valkey-root-'));
writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'shop-app' }));
after(() => rmSync(appRoot, { recursive: true, force: true }));

describe('valkeyPlugin', () => {
  it('provides the app provider under valkeyToken and registers the valkey unit, inertly', async () => {
    const run = await testPlugin(valkeyPlugin({ url: URL, appPrefix: 'shop:test' }), {
      rootDir: appRoot,
    });
    try {
      assert.deepEqual(run.provided, [valkeyToken]);
      assert.equal(run.services.get(valkeyToken).prefix, 'shop:test');
      assert.deepEqual(
        run.units.map(({ unit, roles }) => [unit.name, roles]),
        [['valkey', ['web', 'worker']]],
      );
      assert.equal(typeof run.units[0]?.unit.ready, 'function');
    } finally {
      await run.close();
    }
  });

  it('reads VALKEY_URL and derives the default prefix from the app root and the mode, not the working directory', async () => {
    assert.ok(!process.cwd().startsWith(appRoot));
    for (const [nodeEnv, prefix] of [
      ['test', 'shop-app:test'],
      [undefined, 'shop-app:production'],
    ] as const) {
      const run = await testPlugin(valkeyPlugin(), {
        env: { VALKEY_URL: URL, ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }) },
        rootDir: appRoot,
      });
      try {
        assert.equal(run.services.get(valkeyToken).prefix, prefix);
      } finally {
        await run.close();
      }
    }
  });

  it('closes the provider on teardown', async () => {
    const run = await testPlugin(valkeyPlugin({ url: URL, appPrefix: 'shop:test' }));
    const connections = run.services.get(valkeyToken);
    await run.close();
    await assert.rejects(
      connections.shared('command'),
      (error: unknown) => error instanceof ValkeyError && error.code === 'closed',
    );
  });

  it('fails setup without a URL', async () => {
    await assert.rejects(
      testPlugin(valkeyPlugin(), { env: {} }),
      (error: unknown) => error instanceof ValkeyError && error.code === 'invalid_url',
    );
  });

  it('refuses a malformed URL or option when the factory is called, without echoing it', () => {
    for (const options of [
      { url: 'http://user:sup3rsecret@host' },
      { url: URL, appPrefix: 'has space sup3rsecret' },
      { url: URL, timeouts: { connectMs: -1 } },
      { url: URL, unknown: 'sup3rsecret' },
    ]) {
      assert.throws(
        () => valkeyPlugin(options),
        (error: unknown) =>
          ConfigErrors.is(error, 'invalid_options') &&
          !(error as Error).message.includes('sup3rsecret'),
      );
    }
  });

  it('starts by connecting the command role, so an unreachable server fails the start', async () => {
    const run = await testPlugin(
      valkeyPlugin({ url: REFUSED_URL, appPrefix: 'shop:test', timeouts: { connectMs: 1000 } }),
    );
    try {
      const unit = run.units[0]?.unit;
      assert.ok(unit !== undefined);
      await assert.rejects(
        Promise.resolve(unit.start()),
        (error: unknown) => error instanceof ValkeyError && error.code === 'unavailable',
      );
      await assert.rejects(
        Promise.resolve(unit.ready?.(new AbortController().signal)),
        (error: unknown) => error instanceof ValkeyError && error.code === 'unavailable',
      );
    } finally {
      await run.close();
    }
  });
});

describe('useValkeyConnections', () => {
  /** Run `use` inside a plugin's setup and return what it saw. */
  async function inSetup(
    plugins: Parameters<typeof runExtensions>[0],
    env: NodeJS.ProcessEnv,
    rootDir: string = import.meta.dirname,
  ): Promise<{
    seen: ReturnType<typeof useValkeyConnections>[];
    registered: ValkeyConnections | undefined;
    close: () => Promise<void>;
  }> {
    const seen: ReturnType<typeof useValkeyConnections>[] = [];
    const consumer = (name: string) =>
      definePlugin({
        name,
        setup(context) {
          const use = useValkeyConnections(context, env);
          seen.push(use);
          return () => use?.release();
        },
      });
    const runtime = await runExtensions([...plugins, consumer('first'), consumer('second')], {
      rootDir,
      env,
    });
    return {
      seen,
      registered: runtime.services.tryGet(valkeyToken),
      close: () => runtime.close(),
    };
  }

  it('returns the registered provider and never closes it', async () => {
    const result = await inSetup(
      [valkeyPlugin({ url: REFUSED_URL, appPrefix: 'shop:test', timeouts: { connectMs: 1000 } })],
      {},
    );
    try {
      assert.equal(result.seen[0]?.connections, result.registered);
      assert.equal(result.seen[1]?.connections, result.registered);
      await result.seen[0]?.release();
      await assert.rejects(
        result.registered!.shared('command'),
        (error: unknown) => error instanceof ValkeyError && error.code === 'unavailable',
        'release of a borrowed provider must not close it',
      );
    } finally {
      await result.close();
    }
  });

  it('creates one provider from VALKEY_URL for every later consumer', async () => {
    const result = await inSetup([], { VALKEY_URL: URL, NODE_ENV: 'test' });
    try {
      assert.ok(result.registered !== undefined);
      assert.equal(result.seen[0]?.connections, result.registered);
      assert.equal(result.seen[1]?.connections, result.registered);
      assert.match(result.registered.prefix, /:test$/);
    } finally {
      await result.close();
    }
    await assert.rejects(
      result.registered.shared('command'),
      (error: unknown) => error instanceof ValkeyError && error.code === 'closed',
      'the creating consumer closes the provider on teardown',
    );
  });

  it('keys a created provider under the app root of the setup context', async () => {
    const result = await inSetup([], { VALKEY_URL: URL, NODE_ENV: 'production' }, appRoot);
    try {
      assert.equal(result.registered?.prefix, 'shop-app:production');
    } finally {
      await result.close();
    }
  });

  it('finds nothing without a registered provider or a URL', async () => {
    const result = await inSetup([], {});
    try {
      assert.deepEqual(result.seen, [undefined, undefined]);
      assert.equal(result.registered, undefined);
    } finally {
      await result.close();
    }
  });
});
