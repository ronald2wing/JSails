/**
 * Every first-party plugin leaves nothing behind: run fifty times through
 * `measurePluginLeaks` of `jsails/testing` for the web and worker roles (each
 * cycle creates an application with it, starts its units, serves it, answers
 * one request and closes it), it grows no active resource kind and no process
 * listener by more than the harness tolerance.
 *
 * The plugins are every declaration the `unconverted-plugins` gate
 * inventories in `core/src` and `packages/<name>/src`, on either contract:
 *
 * - a converted declaration's exported `definePlugin` factories, each called
 *   with the fixture of its plugin name in {@link KERNEL_FIXTURES} (none when
 *   it is not listed);
 * - a legacy declaration (the `JsailsPlugin` contract), whose factory is a
 *   plain function: its fixture in {@link LEGACY_FIXTURES}, by source file,
 *   names that export and builds its options. A legacy declaration without a
 *   fixture is a violation, so a new one cannot go unmeasured.
 *
 * A fixture's `options` is a value or a function of the built modules it
 * lists in `modules` and of the run's context (`rootDir`, and `valkeyUrl`, an
 * in-process Redis-protocol peer, `respServer` of `jsails/testing`, so a
 * Valkey client's connection is measured without a server), called for
 * every cycle so each one gets fresh instances. The plugins a fixture lists
 * in `with` run beside it and are measured with it. A plugin that cannot be
 * assembled and served that way, or that leaks, is a violation, ratcheted
 * against `scripts/expected-failures/plugin-leaks.json`, which only shrinks.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readGateLedger, ratchet } from '../expected-failures.mjs';
import { builtModule } from './plugin-manifests.mjs';
import { inventory } from './unconverted-plugins.mjs';

export const name = 'plugin-leaks';
export const description =
  'every first-party plugin, on either contract, leaks no resource or listener over fifty create/serve/close cycles; violations may only shrink';
export const needsBuild = true;

/** The origin the socket transports of the fixtures accept. */
const ORIGIN = 'http://127.0.0.1';

/** The in-memory cache plugin, which the plugins requiring the cache services run beside. */
const CACHE = Object.freeze({
  module: 'packages/cache/dist/src/plugin.js',
  factory: 'cachePlugin',
  options: { store: 'memory' },
});

/** The legacy database plugin over a SQLite file in the run's directory. */
const DATABASE = Object.freeze({
  module: 'core/dist/src/database/plugin.js',
  factory: 'databasePlugin',
  modules: { data: 'core/dist/src/database/data-source.js' },
  options: ({ data }, { rootDir }) => ({
    dataSource: new data.JsailsDataSource({
      type: 'sqljs',
      location: join(rootDir, 'leaks.db'),
      entities: [],
    }),
    initialize: true,
  }),
});

/**
 * What a converted plugin needs to be assembled, by plugin name: its
 * `options`, the `env` its variables are read from, and the plugins it runs
 * `with` (each a built `module` of the repository, its `factory` export, and
 * that factory's `options`). A `framework` plugin is one every application
 * runs already (`resolvePlugins` adds it), so a second instance would be a
 * duplicate: it is measured as the bare application.
 */
export const KERNEL_FIXTURES = Object.freeze({
  routing: { framework: true },
  pages: { framework: true },
  database: { options: { dialect: 'sqlite', file: ':memory:', models: () => [] } },
  config: { with: [CACHE], options: { sets: [] } },
  encryption: { env: { JSAILS_ENCRYPTION_KEY: 'k'.repeat(48) } },
  filesystem: { options: { disks: { memory: { driver: 'memory' } } } },
  flags: { with: [CACHE] },
  notifications: { options: { channels: { log: { send: async () => undefined } } } },
  valkey: { options: (_modules, { valkeyUrl }) => ({ url: valkeyUrl, appPrefix: 'leaks' }) },
  webhook: {
    with: [CACHE],
    options: {
      endpoints: [
        { id: 'leaks', path: '/hooks/leaks', secret: 's'.repeat(32), onEvent: () => undefined },
      ],
    },
  },
});

/**
 * How each legacy plugin is assembled, by source file: the `factory` export
 * of its built module and, as for {@link KERNEL_FIXTURES}, its `options`,
 * `env` and `with`.
 */
export const LEGACY_FIXTURES = Object.freeze({
  'core/src/broadcast/plugin.ts': {
    factory: 'broadcastPlugin',
    options: () => ({ allowedOrigins: [ORIGIN], authenticate: () => null }),
  },
  'core/src/database/plugin.ts': {
    factory: DATABASE.factory,
    modules: DATABASE.modules,
    options: DATABASE.options,
  },
  'core/src/jobs/plugin.ts': {
    factory: 'jobsPlugin',
    modules: { jobs: 'core/dist/src/jobs/index.js' },
    options: ({ jobs }) => ({
      registry: jobs.createJobRegistry({}),
      adapter: new jobs.MemoryJobsAdapter(),
    }),
  },
  'core/src/server-components/extension.ts': {
    factory: 'serverComponentsPlugin',
    options: () => ({ signingKey: 'k'.repeat(48) }),
  },
  'packages/admin/src/plugin.ts': {
    factory: 'adminPlugin',
    modules: { panel: 'packages/admin/dist/src/panel.js' },
    options: ({ panel }) =>
      panel.defineAdminPanel({ resolveSession: () => null, authorize: () => false }),
  },
  'packages/auth/src/plugin.ts': { factory: 'authPlugin', options: () => ({}) },
  'packages/blog/src/plugin.ts': { factory: 'blogPlugin' },
  'packages/live/src/plugin.ts': {
    factory: 'livePlugin',
    with: [DATABASE],
    modules: { live: 'core/dist/src/live/index.js' },
    options: ({ live }) => ({
      registry: live.createPublicationRegistry(),
      allowedOrigins: [ORIGIN],
    }),
  },
  'packages/tenancy/src/plugin.ts': {
    factory: 'tenancyPlugin',
    options: () => ({ resolveTenant: () => null }),
  },
});

/**
 * The violation id of a plugin: its source file and its name (a converted
 * plugin's definition name, a legacy plugin's factory export).
 */
export function violationId(file, plugin) {
  return `${file} (${plugin})`;
}

/** A one-line verdict for a measured plugin, or `undefined` when it passed. */
export function verdict(report) {
  if (!report.leaked) return undefined;
  const grown = Object.entries(report.growth)
    .map(([kind, growth]) => `${kind} +${growth}`)
    .join(', ');
  return `leaks over ${report.cycles} cycles: ${grown}`;
}

/** The value-free code of an assembly failure. */
function failureCode(error) {
  if (typeof error?.code === 'string') return error.code;
  return error?.name ?? 'Error';
}

/** Import a built module of the repository. */
function importBuilt(repoRoot, path) {
  return import(pathToFileURL(join(repoRoot, path)).href);
}

/**
 * A function returning `factory(options)` afresh, with the fixture's
 * `options` resolved against its loaded `modules` and the run's `context`.
 */
async function instanceOf(repoRoot, factory, fixture, context) {
  const modules = {};
  for (const [key, path] of Object.entries(fixture.modules ?? {})) {
    modules[key] = await importBuilt(repoRoot, path);
  }
  const { options } = fixture;
  return () => factory(typeof options === 'function' ? options(modules, context) : options);
}

/**
 * Measure `factory` with `fixture` and its companions; the verdict, or an
 * assembly failure.
 */
async function measure(repoRoot, measurePluginLeaks, factory, fixture, context) {
  try {
    const companions = await Promise.all(
      (fixture.with ?? []).map(async (companion) => {
        const loaded = await importBuilt(repoRoot, companion.module);
        return instanceOf(repoRoot, loaded[companion.factory], companion, context);
      }),
    );
    const plugin =
      fixture.framework === true
        ? undefined
        : await instanceOf(repoRoot, factory, fixture, context);
    const report = await measurePluginLeaks(
      () => [...companions.map((create) => create()), ...(plugin === undefined ? [] : [plugin()])],
      { rootDir: context.rootDir, env: { NODE_ENV: 'production', ...fixture.env } },
    );
    return verdict(report);
  } catch (error) {
    return `cannot be assembled and served (${failureCode(error)})`;
  }
}

export async function run({ repoRoot }) {
  const dist = join(repoRoot, 'core', 'dist', 'src');
  const [{ isPluginFactory }, { measurePluginLeaks }, { respServer }] = await Promise.all(
    ['plugins/contract/define-plugin.js', 'testing/leak-harness.js', 'testing/resp-server.js'].map(
      (path) => import(pathToFileURL(join(dist, path)).href),
    ),
  );
  const rootDir = mkdtempSync(join(tmpdir(), 'jsails-plugin-leaks-'));
  writeFileSync(join(rootDir, 'package.json'), JSON.stringify({ name: 'plugin-leaks' }));
  const valkey = await respServer();
  const context = Object.freeze({ rootDir, valkeyUrl: valkey.url });
  const problems = new Map();
  const record = (id, problem) => {
    if (problem !== undefined) problems.set(id, problem);
  };
  try {
    for (const { file, contract } of inventory(repoRoot)) {
      const module = await importBuilt(repoRoot, builtModule(file));
      if (contract === 'kernel') {
        const factories = new Set(Object.values(module).filter((value) => isPluginFactory(value)));
        for (const factory of factories) {
          const plugin = factory.definition.name;
          const fixture = KERNEL_FIXTURES[plugin] ?? {};
          record(
            violationId(file, plugin),
            await measure(repoRoot, measurePluginLeaks, factory, fixture, context),
          );
        }
      } else if (contract === 'legacy') {
        const fixture = LEGACY_FIXTURES[file];
        const factory = fixture === undefined ? undefined : module[fixture.factory];
        if (typeof factory !== 'function') {
          record(file, 'declares a legacy plugin with no fixture in LEGACY_FIXTURES');
          continue;
        }
        record(
          violationId(file, fixture.factory),
          await measure(repoRoot, measurePluginLeaks, factory, fixture, context),
        );
      }
    }
  } finally {
    await valkey.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
  const { unlisted, fixed } = ratchet(readGateLedger(name, { root: repoRoot }), [
    ...problems.keys(),
  ]);
  return [
    ...unlisted.map(
      (id) => `${id} ${problems.get(id)}; release what it takes, or list it with why`,
    ),
    ...fixed.map((id) => `fixed: ${id} no longer leaks; remove it from plugin-leaks.json`),
  ];
}
