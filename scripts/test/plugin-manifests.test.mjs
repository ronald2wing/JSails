/**
 * Tests for the `plugin-manifests` gate (`scripts/gates/plugin-manifests.mjs`):
 * the comment-aware source reader, classifying a declaration by the
 * `definePlugin` it imports, the legacy source analysis (the registrar and
 * shared-registry methods a setup calls included), and the
 * manifest/runtime agreement rules for both contracts (a kernel plugin is
 * read from its runtime definition, so a lazy setup or schema module is
 * judged like an inline one), and plugin dependencies over token objects
 * resolved for both contracts. The manifest parser is the framework's own and
 * needs a build, so these tests pass a stand-in `check`; the gate run against
 * the real repository is `npm run gates -- plugin-manifests`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  analyzePluginSource,
  checkAgreement,
  checkPackage,
  classifyDeclaration,
  kernelServices,
  memberCalls,
  pluginSourceFile,
  requiredPermissions,
  resolveLegacyServices,
  serviceProviders,
  stripComments,
  topLevelEntries,
  typedBindings,
  valueImports,
} from '../gates/plugin-manifests.mjs';

/** A stand-in service token: the fields the gate reads from `createServiceToken`'s record. */
const token = (name) => Object.freeze({ name, live: false, family: true, key: undefined });
const cacheToken = token('cache');
const cacheTagsToken = token('cache.tags');
const tasksToken = token('tasks');

/** The capability gate's table (`PLUGIN_CAPABILITY_PERMISSIONS`), which needs a build to import. */
const CAPABILITIES = Object.freeze({
  'routes.add': 'http.routes',
  'routes.mount': 'http.routes',
  'routes.guard': 'http.guard',
  'routes.transform': 'http.transform',
  configureRequestScope: 'http.scope',
  configureGuard: 'http.guard',
  onServe: 'http.serve',
  intercept: 'interceptors.register',
  'interceptorRegistry.intercept': 'interceptors.register',
  observe: 'events.observe',
  'interceptorRegistry.observe': 'events.observe',
  replaceService: 'services.replace',
  readiness: 'health.readiness',
});

const PLUGIN = `
/**
 * Example: definePlugin({ name: 'docs', setup(context) {} }) in a comment.
 */
export function tasksPlugin(options = {}) {
  // definePlugin({ name: 'commented' })
  return definePlugin({
    name: 'tasks',
    ...(options.store === undefined ? {} : { schema: { entities: taskEntities } }),
    readiness: { tasks: probe },
    setup({ services, routes, onServe: serve }) {
      services.provide(tasksToken, service, { replace: true });
      routes.add({ methods: ['GET'], path: '/tasks/*', access, handler: () => new Response('a, b') });
    },
  });
}
`;

/** A stand-in for checkPluginManifest that accepts its input as the manifest. */
const accept = (raw) => ({
  ok: true,
  manifest: { permissions: [], ...raw },
});

function packageFixture(jsails, overrides = {}) {
  return {
    dir: 'tasks',
    pkg: { name: '@jsails/tasks', version: '1.0.0', jsails },
    pluginSource: PLUGIN,
    source: PLUGIN,
    check: accept,
    capabilityPermissions: CAPABILITIES,
    ...overrides,
  };
}

const AGREEING = {
  id: 'jsails-tasks',
  version: '1.0.0',
  publisher: 'jsails',
  permissions: [
    'health.readiness',
    'http.routes',
    'http.serve',
    'services.provide',
    'services.replace',
    'data.own',
  ],
  schema: { tablePrefix: 'tasks_' },
};

describe('classifyDeclaration', () => {
  it('ignores a file that calls no definePlugin, including a comment or its own definition', () => {
    assert.equal(
      classifyDeclaration(`// definePlugin({ name: 'x' })\nexport const a = 1;`),
      undefined,
    );
    assert.equal(
      classifyDeclaration(`export function definePlugin<T>(plugin: T): T { return plugin; }`),
      undefined,
    );
  });

  it('classifies by the import source', () => {
    const call = `export const p = definePlugin({ name: 'p', setup() {} });`;
    assert.deepEqual(
      classifyDeclaration(`import { definePlugin, envVar } from 'jsails/kernel';\n${call}`),
      { contract: 'kernel' },
    );
    assert.deepEqual(
      classifyDeclaration(
        `import { definePlugin } from '../plugins/contract/define-plugin.js';\n${call}`,
      ),
      { contract: 'kernel' },
    );
    assert.deepEqual(
      classifyDeclaration(
        `import {\n  definePlugin,\n  type JsailsPlugin,\n} from 'jsails/extensions';\n${call}`,
      ),
      { contract: 'legacy' },
    );
    assert.deepEqual(
      classifyDeclaration(`import { definePlugin } from '../extensions/index.js';\n${call}`),
      { contract: 'legacy' },
    );
  });

  it('reports a definePlugin from elsewhere, or one never imported', () => {
    const call = `definePlugin({ name: 'p' });`;
    assert.match(
      classifyDeclaration(`import { definePlugin } from 'some-lib';\n${call}`).error,
      /neither contract/,
    );
    assert.match(classifyDeclaration(call).error, /without one import/);
  });
});

describe('stripComments', () => {
  it('drops comments but keeps comment-like text inside strings', () => {
    const out = stripComments("a(); // x\nconst g = '/src/**/*.ts'; /* y */ b(`//not`);");
    assert.equal(out, "a(); \nconst g = '/src/**/*.ts';  b(`//not`);");
  });
});

describe('topLevelEntries', () => {
  it('splits only top-level commas', () => {
    const text = "x({ a: 1, b: f(1, 2), c: { d: [1, 2] }, e: 'x, y' })";
    const { entries } = topLevelEntries(text, text.indexOf('{'));
    assert.deepEqual(entries, ['a: 1', 'b: f(1, 2)', 'c: { d: [1, 2] }', "e: 'x, y'"]);
  });
});

describe('analyzePluginSource', () => {
  it('reads the name, schema ownership, capabilities, and service use', () => {
    assert.deepEqual(analyzePluginSource(PLUGIN), {
      name: 'tasks',
      schema: 'entities',
      capabilities: ['services', 'routes.add', 'onServe'],
      readiness: true,
      provides: true,
      replaces: true,
      requires: [],
      provided: ['tasksToken'],
    });
  });

  it('reads a literal requires list, and no requirement from a computed one', () => {
    assert.deepEqual(
      analyzePluginSource("definePlugin({ name: 'a', requires: [cacheToken, tagsToken] })")
        .requires,
      ['cacheToken', 'tagsToken'],
    );
    assert.deepEqual(
      analyzePluginSource("definePlugin({ name: 'a', requires: on ? [mailToken] : [] })").requires,
      [],
    );
  });

  it('treats tables another migrator owns as no ownership', () => {
    const analysis = analyzePluginSource(
      "definePlugin({ name: 'a', schema: { unmanagedTables: ['user'] }, setup() {} })",
    );
    assert.equal(analysis.schema, 'unmanaged');
    assert.deepEqual(analysis.capabilities, []);
  });

  it('reports a source it cannot read', () => {
    assert.match(analyzePluginSource('export {}').error, /found 0/);
    assert.match(
      analyzePluginSource("definePlugin({ name: 'a' }); definePlugin({ name: 'b' });").error,
      /found 2/,
    );
    assert.match(analyzePluginSource('definePlugin({ name: NAME })').error, /string literal/);
    assert.match(
      analyzePluginSource("definePlugin({ name: 'a', setup(context) {} })").error,
      /destructure/,
    );
  });
});

describe('analyzePluginSource: methods of a gated context object', () => {
  /** The required permissions of a legacy plugin whose setup is `setup`. */
  const permissionsOf = (setup, packageSource) => {
    const source = `export default definePlugin({ name: 'a', ${setup} });`;
    const analysis = analyzePluginSource(source, packageSource ?? source);
    return analysis.error ?? requiredPermissions(analysis, CAPABILITIES);
  };

  it('reads each registrar method called, never the bare destructure', () => {
    assert.deepEqual(permissionsOf("setup({ routes }) { routes.transform(['page'], rewrite); }"), [
      'http.transform',
    ]);
    assert.deepEqual(permissionsOf('setup({ routes }) { routes.guard(g); }'), ['http.guard']);
    assert.deepEqual(permissionsOf('setup({ routes: r }) { r?.mount("/x", app.fetch, o); }'), [
      'http.routes',
    ]);
    assert.deepEqual(permissionsOf('setup({ routes }) {}'), []);
    assert.deepEqual(
      analyzePluginSource(
        "definePlugin({ name: 'a', setup({ routes }) { routes.add(a); routes.guard(g); } })",
      ).capabilities,
      ['routes.add', 'routes.guard'],
    );
  });

  it('reads the shared registry by method', () => {
    assert.deepEqual(
      permissionsOf('setup({ interceptorRegistry }) { interceptorRegistry.observe(e, f); }'),
      ['events.observe'],
    );
  });

  it('follows a registrar setup hands on to every binding typed HttpRoutes', () => {
    const helper = `
      export function register(registrar: HttpRoutes): void {
        registrar.transform(['page'], rewrite);
      }`;
    const setup = 'setup({ routes }) { register(routes); }';
    assert.deepEqual(permissionsOf(setup, `${helper}\n${setup}`), ['http.transform']);
  });

  it('fails a registrar handed on where no binding shows its calls', () => {
    assert.match(
      permissionsOf('setup({ routes }) { register(routes); }'),
      /setup hands routes on, and no binding typed HttpRoutes shows the calls made on it/,
    );
  });
});

describe('memberCalls and typedBindings', () => {
  it('separates method calls from other uses', () => {
    const { methods, escapes } = memberCalls('r.add(a); r?.guard(g); other.r.mount(x);', 'r');
    assert.deepEqual([...methods], ['add', 'guard']);
    assert.equal(escapes, false);
    assert.equal(memberCalls('r.add(a); use(r);', 'r').escapes, true);
  });

  it('finds every name declared with a type', () => {
    assert.deepEqual(
      typedBindings(
        'function f(a: HttpRoutes, b?: HttpRoutes, c: HttpRoutesLike, d: Other) {}',
        'HttpRoutes',
      ),
      ['a', 'b'],
    );
  });
});

describe('pluginSourceFile', () => {
  it('picks the one file that calls definePlugin outside comments', () => {
    const files = [
      { path: 'a.ts', text: '/** definePlugin({ name: "x" }) */' },
      { path: 'b.ts', text: PLUGIN },
    ];
    assert.equal(pluginSourceFile(files), PLUGIN);
  });
});

describe('requiredPermissions', () => {
  it('maps every gated capability and field to its permission', () => {
    assert.deepEqual(requiredPermissions(analyzePluginSource(PLUGIN), CAPABILITIES), [
      'health.readiness',
      'http.routes',
      'http.serve',
      'services.provide',
      'services.replace',
    ]);
  });
});

const REQUIRING = `
export const cachedPlugin = () =>
  definePlugin({
    name: 'tasks',
    schema: { entities: taskEntities },
    requires: [cacheToken, tasksToken],
    readiness: { tasks: probe },
    setup({ services, routes, onServe }) {
      services.provide(tasksToken, service, { replace: true });
    },
  });
`;

const CACHE_PACKAGE = {
  dir: 'cache',
  pkg: { name: '@jsails/cache', jsails: { id: 'jsails-cache', version: '1.2.0' } },
  services: { requires: [], provides: [cacheToken, cacheTagsToken] },
};

describe('valueImports', () => {
  it('maps each local value name to its specifier and export, leaving types out', () => {
    const imports = valueImports(`
      import { cacheToken, cacheTagsToken as tags, type Cache } from 'jsails/cache';
      import type { Mail } from 'jsails/mail';
      // import { commented } from 'nowhere';
      import { localToken } from './tokens.js';
    `);
    assert.deepEqual(Object.fromEntries(imports), {
      cacheToken: { specifier: 'jsails/cache', imported: 'cacheToken' },
      tags: { specifier: 'jsails/cache', imported: 'cacheTagsToken' },
      localToken: { specifier: './tokens.js', imported: 'localToken' },
    });
  });
});

describe('resolveLegacyServices', () => {
  it('resolves imported and own identifiers to token objects, and reports the rest', async () => {
    const source = `
      import { cacheToken, cacheTagsToken as tags } from 'jsails/cache';
      export const tasksToken = createServiceToken('tasks');
    `;
    const analysis = { requires: ['cacheToken', 'tags', 'missing'], provided: ['tasksToken'] };
    const loaded = [];
    const services = await resolveLegacyServices({
      analysis,
      imports: valueImports(source),
      load: async (specifier) => {
        loaded.push(specifier);
        return specifier === 'jsails/cache' ? { cacheToken, cacheTagsToken } : undefined;
      },
      own: { tasksToken, notAToken: { name: 'x' } },
    });
    assert.deepEqual(services, {
      requires: [cacheToken, cacheTagsToken],
      provides: [tasksToken],
      unresolved: ['missing'],
    });
    assert.deepEqual(loaded, ['jsails/cache', 'jsails/cache']);
  });
});

describe('kernelServices', () => {
  /**
   * A stand-in factory: `definition` plus the instance a call returns, or,
   * without one, the throw of a plugin that needs options (or `thrown`).
   */
  const factoryOf = (
    definition,
    instance,
    thrown = Object.assign(new Error('invalid options'), { code: 'config.invalid_options' }),
  ) =>
    Object.assign(
      () => {
        if (instance === undefined) throw thrown;
        return instance;
      },
      { definition },
    );

  it('reads literal lists from the definition without instantiating', () => {
    const factory = factoryOf({ requires: [cacheToken], provides: [tasksToken] }, undefined);
    assert.deepEqual(kernelServices(factory), { requires: [cacheToken], provides: [tasksToken] });
  });

  it('reads a computed list from the zero-config instance', () => {
    const factory = factoryOf(
      { requires: undefined, provides: [tasksToken] },
      { requires: [cacheToken, cacheTagsToken], provides: [tasksToken] },
    );
    assert.deepEqual(kernelServices(factory), {
      requires: [cacheToken, cacheTagsToken],
      provides: [tasksToken],
    });
  });

  it('fails a computed provides on a plugin that cannot run without options', () => {
    const factory = factoryOf({ requires: [], provides: undefined }, undefined);
    assert.match(kernelServices(factory).error, /computes its services/);
  });

  it('reads a computed requires as conditional on a plugin that needs options', () => {
    const factory = factoryOf({ requires: undefined, provides: [tasksToken] }, undefined);
    assert.deepEqual(kernelServices(factory), { requires: [], provides: [tasksToken] });
  });

  it('fails a factory that throws for another reason than its options', () => {
    const factory = factoryOf(
      { requires: undefined, provides: [tasksToken] },
      undefined,
      new TypeError('broken'),
    );
    assert.match(kernelServices(factory).error, /computes its services/);
  });
});

describe('serviceProviders', () => {
  it('maps each provided token object to its package, and a token two provide to null', () => {
    const tasks = { dir: 'tasks', pkg: { jsails: AGREEING }, services: { provides: [tasksToken] } };
    const twin = { ...tasks, dir: 'twin', pkg: { jsails: { ...AGREEING, id: 'jsails-twin' } } };
    const providers = serviceProviders([CACHE_PACKAGE, tasks, twin, { dir: 'x', pkg: {} }]);
    assert.deepEqual(providers.get(cacheToken), {
      dir: 'cache',
      id: 'jsails-cache',
      version: '1.2.0',
    });
    assert.equal(providers.get(tasksToken), null);
    assert.equal(providers.get(token('cache')), undefined, 'keyed by object, never by name');
  });
});

describe('checkPackage', () => {
  it('needs a plugins entry for a service another first-party plugin provides', () => {
    const providers = serviceProviders([
      CACHE_PACKAGE,
      { dir: 'tasks', pkg: { jsails: AGREEING }, services: { provides: [tasksToken] } },
    ]);
    const fixture = (jsails) =>
      packageFixture(jsails, {
        pluginSource: REQUIRING,
        services: { requires: [cacheToken, tasksToken], provides: [tasksToken], unresolved: [] },
        providers,
        satisfies: (version, range) => range === '^1.0.0' && version.startsWith('1.'),
      });
    assert.deepEqual(checkPackage(fixture(AGREEING)), [
      'packages/tasks: the plugin requires cache, which packages/cache provides, ' +
        "but the manifest's plugins do not name jsails-cache",
    ]);
    assert.deepEqual(
      checkPackage(fixture({ ...AGREEING, plugins: [{ id: 'jsails-cache', range: '^2.0.0' }] })),
      [
        'packages/tasks: the manifest requires jsails-cache ^2.0.0, which its version 1.2.0 does not satisfy',
      ],
    );
    assert.deepEqual(
      checkPackage(fixture({ ...AGREEING, plugins: [{ id: 'jsails-cache', range: '^1.0.0' }] })),
      [],
    );
  });

  it('reports identifiers that name no token and services it cannot read', () => {
    assert.deepEqual(
      checkPackage(
        packageFixture(AGREEING, { services: { requires: [], provides: [], unresolved: ['x'] } }),
      ),
      ['packages/tasks: x names no service token the gate can resolve'],
    );
    assert.deepEqual(checkPackage(packageFixture(AGREEING, { services: { error: 'unread' } })), [
      'packages/tasks: unread',
    ]);
  });

  it('passes an agreeing manifest', () => {
    assert.deepEqual(checkPackage(packageFixture(AGREEING)), []);
  });

  it('reports manifest issues from the parser', () => {
    const failures = checkPackage(
      packageFixture(AGREEING, {
        check: () => ({
          ok: false,
          issues: [{ path: ['permissions', 0], code: 'unknown_permission', message: 'nope' }],
        }),
      }),
    );
    assert.deepEqual(failures, ['packages/tasks: jsails.permissions.0: nope']);
  });

  it('reports identity, name, schema, permission, and env disagreements', () => {
    const failures = checkPackage(
      packageFixture({
        ...AGREEING,
        id: 'tasks',
        version: '2.0.0',
        publisher: 'acme',
        permissions: ['http.routes'],
        schema: undefined,
        env: [{ name: 'TASKS_TOKEN' }],
      }),
    );
    assert.deepEqual(failures, [
      'packages/tasks: manifest id is not jsails-tasks',
      'packages/tasks: publisher is not jsails',
      'packages/tasks: manifest version differs from the package version',
      'packages/tasks: the plugin declares schema entities but the manifest has no schema',
      'packages/tasks: the plugin needs "health.readiness" but the manifest does not declare it',
      'packages/tasks: the plugin needs "http.serve" but the manifest does not declare it',
      'packages/tasks: the plugin needs "services.provide" but the manifest does not declare it',
      'packages/tasks: the plugin needs "services.replace" but the manifest does not declare it',
      'packages/tasks: env TASKS_TOKEN is declared but never read in src/',
    ]);
  });

  it('reports a manifest schema the plugin does not own and a renamed plugin', () => {
    const source = "definePlugin({ name: 'other', setup({ services }) {} })";
    assert.deepEqual(
      checkPackage(
        packageFixture(
          { ...AGREEING, permissions: ['data.own'] },
          { pluginSource: source, source },
        ),
      ),
      [
        'packages/tasks: definePlugin name "other" is not "tasks"',
        'packages/tasks: the manifest declares schema but the plugin owns no entities',
      ],
    );
  });
});

describe('checkAgreement', () => {
  const describeEnv = (_name, env) =>
    Object.entries(env).map(([name, kind]) => ({ name, ...kind }));
  const base = { name: 'mail', env: undefined, providesServices: false, contributes: [] };
  const manifest = { permissions: [], env: undefined, schema: undefined };

  it('accepts a matching definition', () => {
    const definition = {
      ...base,
      env: { MAIL_URL: { kind: 'url', required: true, generate: false } },
      providesServices: true,
      contributes: ['schema'],
    };
    assert.deepEqual(
      checkAgreement({
        label: 'mail',
        definition,
        describeEnv,
        manifest: {
          permissions: ['services.provide'],
          env: [{ name: 'MAIL_URL', kind: 'url', required: true }],
          schema: { tables: ['mail_outbox'] },
        },
      }),
      [],
    );
  });

  it('reports env, schema and permission disagreements', () => {
    const failures = checkAgreement({
      label: 'mail',
      definition: {
        ...base,
        env: { MAIL_URL: { kind: 'string', required: true, generate: false } },
        providesServices: true,
      },
      describeEnv,
      manifest: {
        ...manifest,
        env: [{ name: 'MAIL_URL', kind: 'url', required: true }],
        schema: { tables: [] },
      },
    });
    assert.deepEqual(failures, [
      "mail: the plugin's env declarations differ from jsails.env",
      'mail: the manifest declares a schema but the plugin contributes none',
      'mail: the plugin provides services but the manifest lacks services.provide',
    ]);
    assert.deepEqual(
      checkAgreement({
        label: 'mail',
        definition: { ...base, contributes: ['schema'] },
        describeEnv,
        manifest,
      }),
      ['mail: the plugin contributes a schema but the manifest declares none'],
    );
  });
});

describe('checkPackage: a kernel plugin', () => {
  /** A kernel plugin whose setup and schema are lazy modules, as a heavy package writes it. */
  const KERNEL_PLUGIN = `
import { definePlugin, lazy } from 'jsails/kernel';

export const tasksPlugin = definePlugin({
  name: 'tasks',
  provides: [tasksToken],
  schema: lazy(() => import('./schema.js')),
  setup: lazy(() => import('./setup.js')),
});
`;
  const describeEnv = (_name, env) =>
    Object.entries(env).map(([name, kind]) => ({ name, ...kind }));
  const definition = {
    name: 'tasks',
    env: { TASKS_TOKEN: { kind: 'secret', required: true, generate: false } },
    providesServices: true,
    contributes: ['schema'],
  };
  const manifest = {
    id: 'jsails-tasks',
    version: '1.0.0',
    publisher: 'jsails',
    permissions: ['services.provide', 'data.own'],
    schema: { tablePrefix: 'tasks_' },
    env: [{ name: 'TASKS_TOKEN', kind: 'secret', required: true }],
  };
  const kernelFixture = (jsails, overrides = {}) =>
    packageFixture(jsails, {
      pluginSource: KERNEL_PLUGIN,
      source: KERNEL_PLUGIN,
      definition,
      describeEnv,
      ...overrides,
    });

  it('passes a lazy setup and a lazy schema that agree with the manifest', () => {
    assert.deepEqual(checkPackage(kernelFixture(manifest)), []);
  });

  it('reads agreement from the runtime definition, never the source', () => {
    assert.deepEqual(
      checkPackage(kernelFixture({ ...manifest, schema: undefined, env: [], permissions: [] })),
      [
        "packages/tasks: the plugin's env declarations differ from jsails.env",
        'packages/tasks: the plugin contributes a schema but the manifest declares none',
        'packages/tasks: the plugin provides services but the manifest lacks services.provide',
      ],
    );
  });

  it('applies the dependency rule to a kernel consumer', () => {
    const providers = serviceProviders([CACHE_PACKAGE]);
    const services = { requires: [cacheToken, cacheTagsToken], provides: [tasksToken] };
    assert.deepEqual(checkPackage(kernelFixture(manifest, { services, providers })), [
      'packages/tasks: the plugin requires cache, which packages/cache provides, ' +
        "but the manifest's plugins do not name jsails-cache",
      'packages/tasks: the plugin requires cache.tags, which packages/cache provides, ' +
        "but the manifest's plugins do not name jsails-cache",
    ]);
    assert.deepEqual(
      checkPackage(
        kernelFixture(
          { ...manifest, plugins: [{ id: 'jsails-cache', range: '^1.0.0' }] },
          { services, providers },
        ),
      ),
      [],
    );
  });

  it('reports a package whose built module exports no factory named after it', () => {
    assert.deepEqual(
      checkPackage(kernelFixture({ ...manifest, version: '2.0.0' }, { definition: undefined })),
      [
        'packages/tasks: manifest version differs from the package version',
        'packages/tasks: exports no definePlugin factory named "tasks"',
      ],
    );
  });
});

describe('a kernel provider and consumers on both contracts', () => {
  // The repository's shape: cache is a kernel plugin whose provides list is
  // computed (leases add a token), config a legacy plugin with a literal
  // requires list, flags a kernel plugin whose requires list is computed.
  const leaseToken = token('cache.leases');
  const flagsToken = token('flags');
  const cacheFactory = Object.assign(
    () => ({ requires: [], provides: [cacheToken, cacheTagsToken] }),
    { definition: { requires: [], provides: undefined } },
  );
  const flagsFactory = Object.assign(
    () => ({ requires: [cacheToken, cacheTagsToken], provides: [flagsToken] }),
    { definition: { requires: undefined, provides: [flagsToken] } },
  );
  const manifestOf = (dir, plugins) => ({
    id: `jsails-${dir}`,
    version: '1.0.0',
    publisher: 'jsails',
    permissions: ['services.provide'],
    ...(plugins === undefined ? {} : { plugins }),
  });

  it('keeps the kernel provider in the provider map, so both consumers need it', async () => {
    const config = await resolveLegacyServices({
      analysis: analyzePluginSource(
        "definePlugin({ name: 'config', requires: [cacheToken, cacheTagsToken], setup({ services }) { services.provide(configToken, c); } })",
      ),
      imports: valueImports("import { cacheTagsToken, cacheToken } from 'jsails/cache';"),
      load: async () => ({ cacheToken, cacheTagsToken }),
      own: { configToken: token('config') },
    });
    const packages = [
      {
        dir: 'cache',
        pkg: { jsails: manifestOf('cache') },
        services: kernelServices(cacheFactory),
      },
      { dir: 'config', pkg: { jsails: manifestOf('config') }, services: config },
      {
        dir: 'flags',
        pkg: { jsails: manifestOf('flags') },
        services: kernelServices(flagsFactory),
      },
    ];
    const providers = serviceProviders(packages);
    assert.equal(providers.get(cacheToken)?.id, 'jsails-cache');
    assert.equal(providers.get(leaseToken), undefined);

    const check = (dir, services, plugins, pluginSource, definition) =>
      checkPackage({
        dir,
        pkg: { name: `@jsails/${dir}`, version: '1.0.0', jsails: manifestOf(dir, plugins) },
        pluginSource,
        source: pluginSource,
        check: accept,
        capabilityPermissions: CAPABILITIES,
        services,
        providers,
        definition,
        describeEnv: () => [],
      });
    const legacy =
      "definePlugin({ name: 'config', setup({ services }) { services.provide(configToken, c); } })";
    const kernel =
      "import { definePlugin } from 'jsails/kernel';\nexport const flagsPlugin = definePlugin({ name: 'flags' });";
    const flagsDefinition = { name: 'flags', providesServices: true, contributes: [] };
    const missing = (dir) =>
      `packages/${dir}: the plugin requires cache, which packages/cache provides, ` +
      "but the manifest's plugins do not name jsails-cache";
    assert.ok(check('config', config, undefined, legacy).includes(missing('config')));
    assert.ok(
      check('flags', packages[2].services, undefined, kernel, flagsDefinition).includes(
        missing('flags'),
      ),
    );
    const named = [{ id: 'jsails-cache', range: '^1.0.0' }];
    assert.deepEqual(check('config', config, named, legacy), []);
    assert.deepEqual(check('flags', packages[2].services, named, kernel, flagsDefinition), []);
  });
});
