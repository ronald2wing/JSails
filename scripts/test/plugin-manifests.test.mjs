/**
 * Tests for the `plugin-manifests` gate (`scripts/gates/plugin-manifests.mjs`):
 * the comment-aware source reader, the `definePlugin` analysis, and the
 * manifest/runtime agreement rules. The manifest parser is the framework's
 * own and needs a build, so these tests pass a stand-in `check`; the gate run
 * against the real repository is `npm run gates -- plugin-manifests`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  analyzePluginSource,
  checkPackage,
  pluginSourceFile,
  requiredPermissions,
  stripComments,
  topLevelEntries,
} from '../gates/plugin-manifests.mjs';

const CAPABILITIES = Object.freeze({
  configureHttp: 'http.routes',
  configureMiddleware: 'http.middleware',
  configureRequestScope: 'http.scope',
  onServe: 'http.serve',
  intercept: 'interceptors.register',
  observe: 'events.observe',
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
    setup({ services, configureHttp, onServe: serve }) {
      services.provide(tasksToken, service, { replace: true });
      configureHttp((app) => app.get('/tasks/*', (c) => c.text('a, b')));
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
      capabilities: ['services', 'configureHttp', 'onServe'],
      readiness: true,
      provides: true,
      replaces: true,
    });
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

describe('checkPackage', () => {
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
