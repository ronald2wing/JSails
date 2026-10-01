/**
 * `runExtensions` with `definePlugin` instances: ordering by declared service
 * tokens, the declared-only service view, provisions, duplicate providers,
 * substrate resources, lifecycle registrations, roles, the environment
 * source, the HTTP registrar and the mode, and cleanup on failure, beside
 * plain extensions.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { z } from 'zod';

import {
  createServiceToken,
  ExtensionErrors,
  runExtensions,
  type JsailsExtension,
} from '../../src/extensions/index.js';
import { definePlugin } from '../../src/plugins/contract/define-plugin.js';
import { ConfigErrors, PluginErrors } from '../../src/plugins/contract/errors.js';
import type { SubstrateHandle } from '../../src/plugins/contract/instance.js';
import type { LifecycleUnit } from '../../src/plugins/contract/lifecycle.js';
import { envVar } from '../../src/plugins/contract/option-schemas.js';
import { publicAccess } from '../../src/api/access-ref.js';
import type { HttpRoutes } from '../../src/server/http-routes.js';

const rootDir = import.meta.dirname;

const config = createServiceToken<{ readonly level: number }>('probe.config');
const greeter = createServiceToken<string>('probe.greeter');

function unit(name: string): LifecycleUnit {
  return { name, start() {}, drain() {}, abort() {} };
}

describe('runExtensions: ordering', () => {
  it('runs a provider before every entry that requires or optionally reads its token', async () => {
    const order: string[] = [];
    const provider = definePlugin({
      name: 'provider',
      provides: [config],
      setup({ services }) {
        order.push('provider');
        services.provide(config, { level: 3 });
      },
    });
    const reader = definePlugin({
      name: 'reader',
      optional: [config],
      provides: [greeter],
      setup({ services }) {
        order.push('reader');
        services.provide(greeter, `level ${services.tryGet(config)?.level}`);
      },
    });
    const legacy: JsailsExtension = {
      name: 'legacy',
      requires: [greeter],
      setup({ services }) {
        order.push(`legacy: ${services.get(greeter)}`);
      },
    };
    const runtime = await runExtensions([legacy, reader(), provider()], { rootDir });
    await runtime.close();
    assert.deepEqual(order, ['provider', 'reader', 'legacy: level 3']);
  });

  it('runs an optional reader without its provider', async () => {
    let seen: unknown = 'unset';
    const reader = definePlugin({
      name: 'reader',
      optional: [config],
      setup({ services }) {
        seen = services.tryGet(config);
      },
    });
    const runtime = await runExtensions([reader()], { rootDir });
    await runtime.close();
    assert.equal(seen, undefined);
  });

  it('refuses a token two instances declare, before any setup', async () => {
    let setups = 0;
    const provider = definePlugin({
      name: 'one',
      provides: [config],
      setup({ services }) {
        setups += 1;
        services.provide(config, { level: 1 });
      },
    });
    const twin = definePlugin({
      name: 'two',
      provides: [config],
      setup({ services }) {
        setups += 1;
        services.provide(config, { level: 2 });
      },
    });
    await assert.rejects(runExtensions([provider(), twin()], { rootDir }), (error: unknown) =>
      ExtensionErrors.is(error, 'duplicate_provider'),
    );
    assert.equal(setups, 0);
  });

  it('runs one keyed plugin twice, each instance providing its own keyed member', async () => {
    const disk = createServiceToken<string>('probe.disk');
    const setups: string[] = [];
    const diskPlugin = definePlugin({
      name: 'disk',
      options: z.object({ disk: z.string() }).strict(),
      key: ({ disk: key }) => key,
      provides: ({ disk: key }) => [disk.named(key)],
      setup({ name, key, options, services }) {
        setups.push(name);
        assert.equal(key, options.disk);
        services.provide(disk.named(options.disk), `${options.disk} disk`);
      },
    });
    const media = diskPlugin({ disk: 'media' });
    assert.equal(media.name, 'disk:media');
    assert.equal(media.key, 'media');
    const runtime = await runExtensions([media, diskPlugin({ disk: 'backups' })], { rootDir });
    assert.deepEqual(setups, ['disk:media', 'disk:backups']);
    assert.equal(runtime.services.get(disk.named('media')), 'media disk');
    assert.equal(runtime.services.get(disk.named('backups')), 'backups disk');
    await runtime.close();
  });

  it('refuses one key configured twice, and an unkeyed plugin configured twice', async () => {
    let setups = 0;
    const keyed = definePlugin({
      name: 'disk',
      options: z.object({ disk: z.string() }).strict(),
      key: ({ disk }) => disk,
      setup() {
        setups += 1;
      },
    });
    const unkeyed = definePlugin({
      name: 'theme',
      setup() {
        setups += 1;
      },
    });
    for (const entries of [
      [keyed({ disk: 'media' }), keyed({ disk: 'media' })],
      [unkeyed(), unkeyed()],
    ]) {
      await assert.rejects(
        runExtensions(entries, { rootDir }),
        (error: unknown) =>
          ExtensionErrors.is(error, 'invalid_extension') &&
          error.context['problem'] === 'duplicate_name',
      );
    }
    assert.equal(setups, 0);
  });

  it('waits, with its dependents, for a required service a later legacy extension provides', async () => {
    const order: string[] = [];
    const reader = definePlugin({
      name: 'reader',
      requires: [config],
      provides: [greeter],
      setup({ services }) {
        order.push('reader');
        services.provide(greeter, `level ${services.get(config).level}`);
      },
    });
    const dependent: JsailsExtension = {
      name: 'dependent',
      requires: [greeter],
      setup({ services }) {
        order.push(`dependent: ${services.get(greeter)}`);
      },
    };
    const unrelated: JsailsExtension = {
      name: 'unrelated',
      setup() {
        order.push('unrelated');
      },
    };
    // The legacy provider needs `upstream` first, so the sort places it after
    // `dependent`: both the reader and its dependent reach their turn early.
    const upstreamToken = createServiceToken<number>('probe.upstream');
    const upstream = definePlugin({
      name: 'upstream',
      provides: [upstreamToken],
      setup({ services }) {
        order.push('upstream');
        services.provide(upstreamToken, 5);
      },
    });
    const legacyProvider: JsailsExtension = {
      name: 'legacy-provider',
      requires: [upstreamToken],
      setup({ services }) {
        order.push('legacy-provider');
        services.provide(config, { level: services.get(upstreamToken) });
      },
    };
    const runtime = await runExtensions(
      [reader(), dependent, unrelated, legacyProvider, upstream()],
      { rootDir },
    );
    await runtime.close();
    assert.deepEqual(order, [
      'unrelated',
      'upstream',
      'legacy-provider',
      'reader',
      'dependent: level 5',
    ]);
  });

  it('lets a legacy extension wait for a service a later legacy extension provides', async () => {
    const order: string[] = [];
    const consumer: JsailsExtension = {
      name: 'consumer',
      requires: [config],
      setup({ services }) {
        order.push(`consumer: ${services.get(config).level}`);
      },
    };
    const provider: JsailsExtension = {
      name: 'provider',
      setup({ services }) {
        order.push('provider');
        services.provide(config, { level: 2 });
      },
    };
    const runtime = await runExtensions([consumer, provider], { rootDir });
    await runtime.close();
    assert.deepEqual(order, ['provider', 'consumer: 2']);
    await assert.rejects(
      runExtensions([consumer], { rootDir }),
      (error: unknown) =>
        ExtensionErrors.is(error, 'missing_service') && error.context['token'] === 'probe.config',
    );
  });

  it('keeps the declared order when the legacy provider already ran', async () => {
    const order: string[] = [];
    const legacyProvider: JsailsExtension = {
      name: 'legacy-provider',
      setup({ services }) {
        order.push('legacy-provider');
        services.provide(config, { level: 1 });
      },
    };
    const reader = definePlugin({
      name: 'reader',
      requires: [config],
      setup() {
        order.push('reader');
      },
    });
    const after: JsailsExtension = {
      name: 'after',
      setup() {
        order.push('after');
      },
    };
    const runtime = await runExtensions([legacyProvider, reader(), after], { rootDir });
    await runtime.close();
    assert.deepEqual(order, ['legacy-provider', 'reader', 'after']);
  });

  it('refuses a required service no entry provides once every other entry ran, cleaning up', async () => {
    const order: string[] = [];
    const reader = definePlugin({
      name: 'reader',
      requires: [config],
      setup() {
        order.push('reader');
      },
    });
    const other: JsailsExtension = {
      name: 'other',
      setup() {
        order.push('other');
        return () => {
          order.push('other cleanup');
        };
      },
    };
    await assert.rejects(
      runExtensions([reader(), other], { rootDir }),
      (error: unknown) =>
        PluginErrors.is(error, 'missing_service') && error.context['token'] === 'probe.config',
    );
    assert.deepEqual(order, ['other', 'other cleanup']);
  });

  it('refuses a missing required service', async () => {
    const reader = definePlugin({ name: 'reader', requires: [config], setup() {} });
    await assert.rejects(
      runExtensions([reader()], { rootDir }),
      (error: unknown) =>
        PluginErrors.is(error, 'missing_service') && error.context['token'] === 'probe.config',
    );
  });
});

describe('runExtensions: the declared-only service view', () => {
  it('refuses reading an undeclared token and providing an undeclared one', async () => {
    const reads = definePlugin({
      name: 'reads',
      setup({ services }) {
        services.tryGet(config);
      },
    });
    await assert.rejects(
      runExtensions([reads()], { rootDir }),
      (error: unknown) =>
        PluginErrors.is(error, 'undeclared_service') && error.context['access'] === 'read',
    );
    const provides = definePlugin({
      name: 'provides',
      setup({ services }) {
        services.provide(config, { level: 1 });
      },
    });
    await assert.rejects(
      runExtensions([provides()], { rootDir }),
      (error: unknown) =>
        PluginErrors.is(error, 'undeclared_service') && error.context['access'] === 'provide',
    );
  });

  it('refuses a declared provision setup never made, after running its cleanup', async () => {
    const events: string[] = [];
    const lazy = definePlugin({
      name: 'lazy',
      provides: [config],
      setup() {
        return () => {
          events.push('cleanup');
        };
      },
    });
    await assert.rejects(runExtensions([lazy()], { rootDir }), (error: unknown) =>
      PluginErrors.is(error, 'missing_provision'),
    );
    assert.deepEqual(events, ['cleanup']);
  });
});

describe('runExtensions: substrate, lifecycle, roles and environment', () => {
  it('opens a substrate resource on first use and closes it once, after every cleanup', async () => {
    const pool = createServiceToken<SubstrateHandle<{ readonly id: number }>>('probe.pool');
    const events: string[] = [];
    let opened = 0;
    const database = definePlugin({
      name: 'database',
      substrate: () => [
        {
          token: pool,
          create: () => {
            opened += 1;
            events.push('open');
            return { id: opened };
          },
          close: () => {
            events.push('close');
          },
        },
      ],
      setup() {
        return () => {
          events.push('cleanup database');
        };
      },
    });
    const reader: JsailsExtension = {
      name: 'reader',
      requires: [pool],
      setup() {
        return () => {
          events.push('cleanup reader');
        };
      },
    };
    const runtime = await runExtensions([reader, database()], { rootDir });
    assert.equal(opened, 0, 'declaring and registering a resource opens nothing');
    const handle = runtime.services.get(pool);
    assert.deepEqual(await handle.get(), { id: 1 });
    assert.deepEqual(await handle.get(), { id: 1 });
    await runtime.close();
    await runtime.close();
    assert.equal(handle.closed, true);
    assert.deepEqual(events, ['open', 'cleanup reader', 'cleanup database', 'close']);
  });

  it('declares substrate from the options, the environment and the application root', async () => {
    const seen: unknown[] = [];
    const declaring = definePlugin({
      name: 'declaring',
      options: z.object({ file: z.string() }),
      env: { PROBE_LEVEL: envVar.integer() },
      substrate: (context) => {
        seen.push(context);
        return [];
      },
      setup() {},
    });
    const runtime = await runExtensions([declaring({ file: 'a.db' })], {
      rootDir,
      env: { PROBE_LEVEL: '3' },
    });
    await runtime.close();
    assert.deepEqual(seen, [{ options: { file: 'a.db' }, env: { PROBE_LEVEL: 3 }, rootDir }]);
  });

  it('refuses a malformed substrate declaration before any setup', async () => {
    const bad = definePlugin({
      name: 'bad',
      substrate: () => [{ token: 'pool' } as never],
      setup() {},
    });
    await assert.rejects(runExtensions([bad()], { rootDir }), (error: unknown) =>
      PluginErrors.is(error, 'invalid_substrate'),
    );
  });

  it('refuses a lifecycle unit for a role it runs, and leaves one for another role alone', async () => {
    const worker = definePlugin({
      name: 'worker',
      setup({ lifecycle, roles }) {
        if (!roles.has('export')) lifecycle.register(['worker'], unit('probe.worker'));
      },
    });
    await assert.rejects(
      runExtensions([worker()], { rootDir, roles: ['web', 'worker'] }),
      (error: unknown) =>
        PluginErrors.is(error, 'lifecycle_unavailable') && error.context['unit'] === 'probe.worker',
    );
    const runtime = await runExtensions([worker()], { rootDir, roles: ['web'] });
    await runtime.close();
    const exported = await runExtensions([worker()], { rootDir, roles: ['export'] });
    await exported.close();
  });

  it('is described by the shipped app guide: a unit for a role the app runs fails boot', async () => {
    // Every generated app carries core/AGENTS.md, so while this runner refuses
    // units the guide must say so rather than send long-running work to one.
    const worker = definePlugin({
      name: 'worker',
      setup({ lifecycle }) {
        lifecycle.register(['worker'], unit('probe.worker'));
      },
    });
    await assert.rejects(
      runExtensions([worker()], { rootDir, roles: ['web', 'worker'] }),
      (error: unknown) => PluginErrors.is(error, 'lifecycle_unavailable'),
    );
    const guide = readFileSync(new URL('../../../AGENTS.md', import.meta.url), 'utf8');
    const plugins = guide.slice(
      guide.indexOf('## Plugins'),
      guide.indexOf('\n## ', guide.indexOf('## Plugins') + 1),
    );
    assert.match(plugins, /`plugin\.lifecycle_unavailable`/);
    assert.doesNotMatch(plugins.replace(/\s+/g, ' '), /long-running work is a lifecycle unit/);
  });

  it('validates lifecycle registrations', async () => {
    const cases = [
      { roles: [], unit: unit('probe.unit') },
      { roles: ['cron'], unit: unit('probe.unit') },
      { roles: ['web'], unit: { name: 'probe.unit', start() {} } },
      { roles: ['web'], unit: unit('has space') },
    ];
    for (const registration of cases) {
      const plugin = definePlugin({
        name: 'units',
        setup({ lifecycle }) {
          lifecycle.register(registration.roles as never, registration.unit as never);
        },
      });
      await assert.rejects(runExtensions([plugin()], { rootDir }), (error: unknown) =>
        PluginErrors.is(error, 'invalid_lifecycle_unit'),
      );
    }
  });

  it('refuses roles that are not web, worker or export', async () => {
    await assert.rejects(
      runExtensions([], { rootDir, roles: ['cron' as never] }),
      (error: unknown) => ExtensionErrors.is(error, 'invalid_roles'),
    );
  });

  it('reads declared variables from the given environment, before any setup', async () => {
    let seen: unknown;
    let setups = 0;
    const plugin = definePlugin({
      name: 'configured',
      env: { PROBE_LEVEL: envVar.integer() },
      setup({ env }) {
        setups += 1;
        seen = env.PROBE_LEVEL;
      },
    });
    const runtime = await runExtensions([plugin()], { rootDir, env: { PROBE_LEVEL: '7' } });
    await runtime.close();
    assert.equal(seen, 7);
    const first: JsailsExtension = {
      name: 'first',
      setup() {
        setups += 1;
      },
    };
    await assert.rejects(
      runExtensions([first, plugin()], { rootDir, env: { PROBE_LEVEL: 'seven' } }),
      (error: unknown) => ConfigErrors.is(error, 'invalid_env'),
    );
    assert.equal(setups, 1, 'an invalid environment fails before any setup');
  });

  it('cleans up completed entries in reverse when a later setup fails', async () => {
    const events: string[] = [];
    const ok = definePlugin({
      name: 'ok',
      provides: [config],
      setup({ services }) {
        services.provide(config, { level: 1 });
        return () => {
          events.push('cleanup ok');
        };
      },
    });
    const failing = definePlugin({
      name: 'failing',
      requires: [config],
      setup() {
        throw new Error('setup failed');
      },
    });
    await assert.rejects(runExtensions([failing(), ok()], { rootDir }), /setup failed/);
    assert.deepEqual(events, ['cleanup ok']);
  });

  it('shares the name space with extensions', async () => {
    const plugin = definePlugin({ name: 'same', setup() {} });
    const legacy: JsailsExtension = { name: 'same', setup() {} };
    await assert.rejects(
      runExtensions([plugin(), legacy], { rootDir }),
      (error: unknown) =>
        ExtensionErrors.is(error, 'invalid_extension') &&
        error.context['problem'] === 'duplicate_name',
    );
  });
});

describe('runExtensions: the HTTP registrar and the mode', () => {
  it('collects the routes and transforms an instance registers, stamped with its name', async () => {
    const plugin = definePlugin({
      name: 'reports',
      setup({ routes }) {
        routes.add({
          methods: ['GET'],
          path: '/reports',
          access: publicAccess('probe route'),
          handler: () => new Response('ok'),
        });
        routes.transform(['page'], (response) => response);
      },
    });
    const legacy: JsailsExtension = {
      name: 'legacy',
      setup({ routes }) {
        routes.add({
          methods: ['POST'],
          path: '/legacy',
          access: publicAccess('probe route'),
          handler: () => new Response('ok'),
        });
      },
    };
    const runtime = await runExtensions([plugin(), legacy], { rootDir });
    await runtime.close();
    assert.deepEqual(
      runtime.routes.map((route) => [route.owner, route.origin, route.type]),
      [
        ['reports', 'code-plugin', 'route'],
        ['legacy', 'code-plugin', 'route'],
      ],
    );
    assert.deepEqual(
      runtime.transforms.map((entry) => [entry.owner, entry.kinds]),
      [['reports', ['page']]],
    );
  });

  it('refuses a registration once setup returned', async () => {
    let kept: HttpRoutes | undefined;
    const plugin = definePlugin({
      name: 'late',
      setup({ routes }) {
        kept = routes;
      },
    });
    const runtime = await runExtensions([plugin()], { rootDir });
    await runtime.close();
    assert.throws(
      () => kept?.guard(() => undefined),
      (error: unknown) =>
        PluginErrors.is(error, 'routes_closed') && error.context['plugin'] === 'late',
    );
  });

  it('derives the mode from NODE_ENV in the given environment, production otherwise', async () => {
    const seen: string[] = [];
    const plugin = definePlugin({
      name: 'moded',
      setup({ mode }) {
        seen.push(mode);
      },
    });
    for (const NODE_ENV of ['development', 'test', 'production', 'staging', undefined]) {
      const runtime = await runExtensions([plugin()], { rootDir, env: { NODE_ENV } });
      await runtime.close();
    }
    assert.deepEqual(seen, ['development', 'test', 'production', 'production', 'production']);
  });
});
