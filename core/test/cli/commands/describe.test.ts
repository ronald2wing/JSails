/**
 * Tests for `runDescribe` and the `jsails describe` command: the
 * static-definition snapshot of an app config and its rendering.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  runDescribe,
  type DescribeDeps,
  type DescribeResult,
} from '../../../src/cli/commands/describe.js';
import { dispatch } from '../../../src/cli/dispatch.js';
import { createApplication } from '../../../src/app/application.js';
import type { ResolvedAppConfig } from '../../../src/app/config/index.js';
import { createServiceToken } from '../../../src/extensions/services.js';
import { loadApp } from '../../../src/kernel/load-app.js';
import { defaultDescribeDeps } from '../../../src/introspect/describe.js';
import { definePlugin } from '../../../src/plugins/contract/define-plugin.js';
import { serverComponentsToken } from '../../../src/server-components/extension.js';
import type { SchemaState } from '../../../src/migrations/schema-types.js';

/**
 * Tests for `jsails describe`. Exercises both `runDescribe` (the DI seam) and
 * the command's arg parsing through the dispatcher, without importing real config
 * modules or opening connections.
 */

const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('../..', import.meta.url)), 'describe-fixture-'),
);

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveConfig(rootDir: string, extensions: readonly any[] = []): ResolvedAppConfig {
  return {
    rootDir,
    pagesDir: join(rootDir, 'pages'),
    apiDir: join(rootDir, 'api'),
    publicDir: join(rootDir, 'public'),
    outDir: join(rootDir, 'out'),
    storageDir: join(rootDir, 'storage'),
    host: '127.0.0.1',
    port: 3000,
    server: {
      origin: undefined,
      hosts: [],
      trustedProxies: 'none',
      timeouts: {},
      handlerTimeoutMs: 30_000,
    },
    healthPath: '/up',
    http: { guards: [] },
    shutdownTimeoutMs: 5000,
    configPath: join(rootDir, 'jsails.app.js'),
    resolveSession: undefined,
    identity: undefined,
    maxBodyBytes: 1048576,
    setup: undefined,
    extensions,
    renderer: undefined,
    plugins: { use: [] },
  };
}

interface DescribeSinks {
  out: string[];
  err: string[];
}

function describeDeps(
  sinks: DescribeSinks,
  config: ResolvedAppConfig,
  overrides: Partial<DescribeDeps> = {},
): DescribeDeps {
  return {
    loadConfig: async () => config,
    stdout: (text) => sinks.out.push(text),
    stderr: (text) => sinks.err.push(text),
    ...overrides,
  };
}

function assertIsDescribeResult(value: unknown): DescribeResult {
  assert.ok(typeof value === 'object' && value !== null, 'result is an object');
  const result = value as Record<string, unknown>;

  // Top-level keys
  assert.ok(typeof result.app === 'object' && result.app !== null, 'app is present');
  assert.ok(Array.isArray(result.routes), 'routes is an array');
  assert.ok(typeof result.plugins === 'object' && result.plugins !== null, 'plugins is present');
  assert.ok(Array.isArray(result.components), 'components is an array');
  assert.ok(typeof result.schema === 'object' && result.schema !== null, 'schema is present');

  // App shape
  const app = result.app as Record<string, unknown>;
  assert.equal(typeof app.rootDir, 'string');
  assert.equal(typeof app.host, 'string');
  assert.equal(typeof app.port, 'number');
  assert.equal(typeof app.pages, 'string');
  assert.equal(typeof app.api, 'string');
  assert.equal(typeof app.public, 'string');
  assert.equal(typeof app.out, 'string');

  // Plugins shape
  const plugins = result.plugins as Record<string, unknown>;
  assert.ok(Array.isArray(plugins.graph));
  assert.ok(Array.isArray(plugins.liveOnly));

  // Schema shape
  const schema = result.schema as Record<string, unknown>;
  assert.ok(Array.isArray(schema.tables));

  return value as DescribeResult;
}

const TASK_LIST_DESCRIPTION = { name: 'task-list', actions: ['add'], writableKeys: ['title'] };

/** Write the compiled component registry the build would emit for one component. */
function writeGeneratedRegistry(dir: string): void {
  mkdirSync(join(dir, 'dist', '.jsails'), { recursive: true });
  writeFileSync(
    join(dir, 'dist', '.jsails', 'components.registry.js'),
    `export const components = [{
  id: 'task-list',
  definition: { name: 'task-list', render() { return null; }, actions: { add() {} }, writableKeys: ['title'] },
}];
`,
  );
}

/**
 * A project whose app config registers `serverComponentsPlugin()` with no
 * explicit map, so its components are the generated entries under its root.
 */
function writeGeneratedComponentsProject(dir: string): string {
  mkdirSync(join(dir, 'pages'), { recursive: true });
  writeFileSync(join(dir, 'pages', 'index.js'), '');
  writeGeneratedRegistry(dir);
  const plugin = pathToFileURL(
    fileURLToPath(new URL('../../../src/server-components/index.js', import.meta.url)),
  ).href;
  const configPath = join(dir, 'jsails.app.js');
  writeFileSync(
    configPath,
    `import { serverComponentsPlugin } from ${JSON.stringify(plugin)};
export default { port: 0, extensions: [serverComponentsPlugin()] };
`,
  );
  return configPath;
}

// ---------------------------------------------------------------------------
// runDescribe
// ---------------------------------------------------------------------------

describe('runDescribe', () => {
  it('produces valid JSON with all top-level keys', async () => {
    const dir = join(fixturesRoot, 'describe-json');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'api'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');
    writeFileSync(join(dir, 'api', 'users.js'), '');

    const config = resolveConfig(dir);
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config);

    const code = await runDescribe(
      { configPath: config.configPath, options: { json: true } },
      {},
      deps,
    );

    assert.equal(code, 0);
    assert.equal(sinks.out.length, 1);
    assert.deepEqual(sinks.err, []);

    const parsed = JSON.parse(sinks.out[0] as string);
    const result = assertIsDescribeResult(parsed);

    // Routes
    assert.equal(result.routes.length, 2);
    const routes = result.routes.map((r) => r.route).sort();
    assert.deepEqual(routes, ['/', '/api/users']);

    // Plugins: the framework plugins of a config that declares none
    assert.deepEqual(
      result.plugins.graph.map((node) => node.origin),
      ['framework', 'framework'],
    );
    assert.deepEqual([...result.plugins.liveOnly], []);

    // Components: empty when no server-components extension
    assert.deepEqual(result.components, []);

    // Schema: empty when no db config
    assert.deepEqual(result.schema.tables, []);
  });

  it('names the live-only plugins.use instances a static export drops from the graph', async () => {
    const dir = join(fixturesRoot, 'describe-live-only');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    const live = createServiceToken<object>('describe.live', { live: true });
    const provider = definePlugin({ name: 'live-provider', provides: [live], setup() {} })();
    const dependent = definePlugin({ name: 'dependent', requires: [live], setup() {} })();
    const site = definePlugin({ name: 'site', setup() {} })();
    const config: ResolvedAppConfig = {
      ...resolveConfig(dir, [{ name: 'live-extension', describe: () => ({ needsLive: true }) }]),
      shape: 'static',
      plugins: { use: [provider, dependent, site] },
    };

    const json: DescribeSinks = { out: [], err: [] };
    assert.equal(
      await runDescribe(
        { configPath: config.configPath, options: { json: true } },
        {},
        describeDeps(json, config),
      ),
      0,
    );
    const result = assertIsDescribeResult(JSON.parse(json.out[0] as string));
    assert.deepEqual(
      result.plugins.graph.map((node) => node.name),
      ['routing', 'pages', 'site'],
    );
    assert.deepEqual(result.plugins.liveOnly, ['live-provider', 'dependent', 'live-extension']);

    const text: DescribeSinks = { out: [], err: [] };
    assert.equal(
      await runDescribe(
        { configPath: config.configPath, options: {} },
        {},
        describeDeps(text, config),
      ),
      0,
    );
    assert.match(text.out.join('\n'), /live-only: live-provider, dependent, live-extension/);
  });

  it('routes omit absolute file paths', async () => {
    const dir = join(fixturesRoot, 'describe-no-path');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');

    const config = resolveConfig(dir);
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config);

    const code = await runDescribe(
      { configPath: config.configPath, options: { json: true } },
      {},
      deps,
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(sinks.out[0] as string) as DescribeResult;
    for (const route of parsed.routes) {
      const entry = route as unknown as Record<string, unknown>;
      assert.ok(entry.file === undefined, 'route must not have a file key');
    }
  });

  it('routes include layoutCount (0 for fixture with no layouts)', async () => {
    const dir = join(fixturesRoot, 'describe-layout-count');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');

    const config = resolveConfig(dir);
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config);

    const code = await runDescribe(
      { configPath: config.configPath, options: { json: true } },
      {},
      deps,
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(sinks.out[0] as string) as DescribeResult;
    for (const route of parsed.routes) {
      assert.equal(
        typeof route.layoutCount,
        'number',
        `route ${route.route} must have layoutCount`,
      );
      assert.ok(route.layoutCount >= 0, `route ${route.route} layoutCount must be >= 0`);
    }
  });

  it('describe output never contains layouts (absolute paths) in route entries', async () => {
    const dir = join(fixturesRoot, 'describe-no-layout-paths');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');

    const config = resolveConfig(dir);
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config);

    const code = await runDescribe(
      { configPath: config.configPath, options: { json: true } },
      {},
      deps,
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(sinks.out[0] as string) as DescribeResult;
    // Each route entry must NOT carry `layouts` (it leaks absolute paths).
    // Only `layoutCount` — a non-negative integer — is exposed.
    for (const route of parsed.routes) {
      const entry = route as unknown as Record<string, unknown>;
      assert.ok(entry.layouts === undefined, `route ${route.route} must not have layouts`);
    }
  });

  it('no secrets or env values are leaked', async () => {
    const dir = join(fixturesRoot, 'describe-no-leak');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');

    const config = resolveConfig(dir);
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config);

    const code = await runDescribe(
      { configPath: config.configPath, options: { json: true } },
      {},
      deps,
    );

    assert.equal(code, 0);
    const raw = sinks.out[0] as string;
    // configPath (the framework-internal config path) must not leak
    assert.ok(!raw.includes('configPath'), 'configPath must not be in output');
    // No session, CSRF, or env tokens
    assert.ok(!raw.includes('csrf'), 'CSRF must not be in output');
    assert.ok(!raw.includes('session'), 'session must not be in output');
    assert.ok(!raw.includes('secret'), 'secrets must not be in output');
    assert.ok(!raw.includes('JSAILS_'), 'env vars must not be in output');
  });

  it('missing config returns 1 with a value-free message', async () => {
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps: DescribeDeps = {
      loadConfig: async () => {
        throw new Error('ENOENT: no such file, open "secret.yml"');
      },
      stdout: (text) => sinks.out.push(text),
      stderr: (text) => sinks.err.push(text),
    };

    const code = await runDescribe({ configPath: '/nonexistent.js', options: {} }, {}, deps);

    assert.equal(code, 1);
    assert.match(sinks.err.join('\n'), /failed to load config/);
    // The original error message must not be echoed
    assert.ok(!sinks.err.join('\n').includes('secret.yml'));
  });

  it('human-readable output is non-empty and mentions the app', async () => {
    const dir = join(fixturesRoot, 'describe-human');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');

    const config = resolveConfig(dir);
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config);

    const code = await runDescribe({ configPath: config.configPath, options: {} }, {}, deps);

    assert.equal(code, 0);
    const out = sinks.out.join('\n');
    assert.ok(out.length > 0, 'human-readable output must not be empty');
    assert.match(out, /Application/);
    assert.match(out, /Routes/);
    assert.match(out, /Plugins/);
    assert.match(out, /Components/);
    assert.match(out, /Schema/);
  });

  it('human-readable output shows empty state cleanly', async () => {
    const dir = join(fixturesRoot, 'describe-empty');
    mkdirSync(dir, { recursive: true });

    const config = resolveConfig(dir);
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config);

    const code = await runDescribe({ configPath: config.configPath, options: {} }, {}, deps);

    assert.equal(code, 0);
    const out = sinks.out.join('\n');
    assert.match(out, /\(none\)/);
    assert.match(out, /no entity tables declared/);
  });

  it('loads schema from db config when provided', async () => {
    const dir = join(fixturesRoot, 'describe-schema');
    mkdirSync(dir, { recursive: true });

    const config = resolveConfig(dir);
    const schema: SchemaState = {
      tables: [
        {
          name: 'users',
          columns: [
            { name: 'id', type: 'integer', nullable: false, primaryKey: true },
            { name: 'email', type: 'varchar', nullable: false, length: 255 },
          ],
        },
      ],
    };
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config, {
      loadSchema: async () => schema,
    });

    const code = await runDescribe(
      {
        configPath: config.configPath,
        dbConfigPath: 'jsails.database.js',
        options: { json: true },
      },
      {},
      deps,
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(sinks.out[0] as string) as DescribeResult;
    assert.equal(parsed.schema.tables.length, 1);
    const table = parsed.schema.tables[0]!;
    assert.equal(table.name, 'users');
    assert.equal(table.columns.length, 2);
    assert.equal(table.columns[0]!.name, 'id');
    assert.equal(table.columns[0]!.primaryKey, true);
  });

  it('schema is empty when loadSchema returns undefined', async () => {
    const dir = join(fixturesRoot, 'describe-schema-undefined');
    mkdirSync(dir, { recursive: true });

    const config = resolveConfig(dir);
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config, {
      loadSchema: async () => undefined,
    });

    const code = await runDescribe(
      {
        configPath: config.configPath,
        dbConfigPath: 'jsails.database.js',
        options: { json: true },
      },
      {},
      deps,
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(sinks.out[0] as string) as DescribeResult;
    assert.deepEqual(parsed.schema.tables, []);
  });

  it('schema degrades gracefully when loadSchema throws', async () => {
    const dir = join(fixturesRoot, 'describe-schema-throw');
    mkdirSync(dir, { recursive: true });

    const config = resolveConfig(dir);
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config, {
      loadSchema: async () => {
        throw new Error('cannot load db config');
      },
    });

    const code = await runDescribe(
      {
        configPath: config.configPath,
        dbConfigPath: 'jsails.database.js',
        options: { json: true },
      },
      {},
      deps,
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(sinks.out[0] as string) as DescribeResult;
    assert.deepEqual(parsed.schema.tables, []);
  });

  it('collects components from plugins with a describe() descriptor', async () => {
    const dir = join(fixturesRoot, 'describe-components-from-describe');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');

    const config = resolveConfig(dir, [
      {
        name: 'server-components',
        setup() {},
        describe: () => ({
          components: [
            { name: 'task-list', actions: ['add', 'remove'], writableKeys: ['title'] },
            { name: 'sidebar', actions: [], writableKeys: [] },
          ],
        }),
      } as any,
    ]);

    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config);

    const code = await runDescribe(
      { configPath: config.configPath, options: { json: true } },
      {},
      deps,
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(sinks.out[0] as string) as DescribeResult;
    assert.equal(parsed.components.length, 2);
    assert.deepEqual(parsed.components[0], {
      name: 'task-list',
      actions: ['add', 'remove'],
      writableKeys: ['title'],
    });
    assert.deepEqual(parsed.components[1], {
      name: 'sidebar',
      actions: [],
      writableKeys: [],
    });
  });

  it('describes the safe-mode plugin graph, plugins.use included, in setup order', async () => {
    const dir = join(fixturesRoot, 'describe-plugin-graph');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    const usedPath = join(dir, 'used-plugin.mjs');
    writeFileSync(
      usedPath,
      [
        'export default {',
        "  name: 'used',",
        '  setup() {},',
        '  describe: () => ({',
        "    components: [{ name: 'used-widget', actions: ['save'], writableKeys: [] }],",
        '  }),',
        '};',
        '',
      ].join('\n'),
    );
    const base = resolveConfig(dir, [{ name: 'legacy', setup() {} } as any]);
    const config = {
      ...base,
      plugins: { ...base.plugins, use: [pathToFileURL(usedPath).href] },
    } as ResolvedAppConfig;

    const sinks: DescribeSinks = { out: [], err: [] };
    const code = await runDescribe(
      { configPath: config.configPath, options: { json: true } },
      {},
      describeDeps(sinks, config),
    );

    assert.equal(code, 0, sinks.err.join('\n'));
    const parsed = JSON.parse(sinks.out[0] as string) as DescribeResult;
    assert.deepEqual(parsed.plugins.graph, [
      { name: 'routing', origin: 'framework' },
      { name: 'pages', origin: 'framework' },
      { name: 'used', origin: 'config' },
      { name: 'legacy', origin: 'extension' },
    ]);
    assert.deepEqual(
      parsed.components.map((component) => component.name),
      ['used-widget'],
    );
    assert.deepEqual(parsed.commands, []);
  });

  it('lists the commands the dependencies declare and the app builds, without importing them', async () => {
    const dir = join(fixturesRoot, 'describe-commands');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { 'sync-tools': '1.0.0' } }),
    );
    mkdirSync(join(dir, 'node_modules', 'sync-tools'), { recursive: true });
    writeFileSync(
      join(dir, 'node_modules', 'sync-tools', 'package.json'),
      JSON.stringify({
        name: 'sync-tools',
        jsails: {
          commands: [{ name: 'sync:run', summary: 'Run a sync', module: 'sync-tools/run' }],
        },
      }),
    );
    mkdirSync(join(dir, 'dist', 'commands'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'commands', 'hello.js'), "throw new Error('imported');\n");
    mkdirSync(join(dir, 'commands'), { recursive: true });
    writeFileSync(join(dir, 'commands', 'pending.ts'), 'export {};\n');

    const config = resolveConfig(dir);
    const sinks: DescribeSinks = { out: [], err: [] };
    const code = await runDescribe(
      { configPath: config.configPath, options: { json: true } },
      {},
      describeDeps(sinks, config),
    );

    assert.equal(code, 0, sinks.err.join('\n'));
    const parsed = JSON.parse(sinks.out[0] as string) as DescribeResult;
    assert.deepEqual(parsed.commands, [
      { name: 'sync:run', summary: 'Run a sync', source: 'dependency', package: 'sync-tools' },
      { name: 'hello', summary: null, source: 'app' },
      { name: 'pending', summary: null, source: 'app', unbuilt: true },
    ]);
  });

  it('components array is empty when plugins have no describe()', async () => {
    const dir = join(fixturesRoot, 'describe-no-describe');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');

    const config = resolveConfig(dir, [
      {
        name: 'auth',
        setup() {},
        // No describe() at all
      } as any,
    ]);

    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config);

    const code = await runDescribe(
      { configPath: config.configPath, options: { json: true } },
      {},
      deps,
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(sinks.out[0] as string) as DescribeResult;
    assert.deepEqual(parsed.components, []);
  });

  it('lists the generated components of a plugin without an explicit map', async () => {
    const dir = join(fixturesRoot, 'describe-generated-components');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');
    writeGeneratedRegistry(dir);

    const config = resolveConfig(dir, [
      {
        name: 'server-components',
        setup() {},
        describe: () => ({ needsLive: true, generatedComponents: true }),
      } as any,
    ]);
    const sinks: DescribeSinks = { out: [], err: [] };

    const code = await runDescribe(
      { configPath: config.configPath, options: { json: true } },
      {},
      describeDeps(sinks, config),
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(sinks.out[0] as string) as DescribeResult;
    assert.deepEqual(parsed.components, [TASK_LIST_DESCRIPTION]);
  });

  it('prefers a descriptor that lists its components over the generated entries', async () => {
    const dir = join(fixturesRoot, 'describe-listed-over-generated');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');
    writeGeneratedRegistry(dir);

    const listed = { name: 'sidebar', actions: [], writableKeys: [] };
    const config = resolveConfig(dir, [
      {
        name: 'server-components',
        setup() {},
        describe: () => ({ generatedComponents: true, components: [listed] }),
      } as any,
    ]);
    const sinks: DescribeSinks = { out: [], err: [] };

    const code = await runDescribe(
      { configPath: config.configPath, options: { json: true } },
      {},
      describeDeps(sinks, config),
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(sinks.out[0] as string) as DescribeResult;
    assert.deepEqual(parsed.components, [listed]);
  });

  it('origin is only included when set', async () => {
    const dir = join(fixturesRoot, 'describe-origin');
    mkdirSync(dir, { recursive: true });

    // Without server.origin
    const config1 = resolveConfig(dir);
    const sinks1: DescribeSinks = { out: [], err: [] };
    let code = await runDescribe(
      { configPath: config1.configPath, options: { json: true } },
      {},
      describeDeps(sinks1, config1),
    );
    assert.equal(code, 0);
    let parsed = JSON.parse(sinks1.out[0] as string) as DescribeResult;
    assert.ok(!('origin' in (parsed.app as unknown as Record<string, unknown>)));

    // With server.origin
    const config2: ResolvedAppConfig = {
      ...resolveConfig(dir),
      server: {
        origin: 'https://example.com',
        hosts: [],
        trustedProxies: 'none',
        timeouts: {},
        handlerTimeoutMs: 30_000,
      },
    };
    const sinks2: DescribeSinks = { out: [], err: [] };
    code = await runDescribe(
      { configPath: config2.configPath, options: { json: true } },
      {},
      describeDeps(sinks2, config2),
    );
    assert.equal(code, 0);
    parsed = JSON.parse(sinks2.out[0] as string) as DescribeResult;
    assert.equal((parsed.app as unknown as Record<string, unknown>).origin, 'https://example.com');
  });
});

// ---------------------------------------------------------------------------
// jsails describe (arg parsing, through the dispatcher)
// ---------------------------------------------------------------------------

describe('jsails describe (arg parsing)', () => {
  /** Dispatch `jsails describe ...args`; each case stops before the environment resolves. */
  async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await dispatch(['describe', ...args], {
      cwd: fixturesRoot,
      stdout: (text) => out.push(text),
      stderr: (line) => err.push(line),
    });
    return { code, out: out.join(''), err: err.join('\n') };
  }

  it('prints its generated help for --help', async () => {
    const result = await run('--help');
    assert.equal(result.code, 0);
    assert.match(result.out, /^jsails describe - /);
    for (const flag of ['--json', '--config', '--db-config']) assert.ok(result.out.includes(flag));
  });

  it('rejects an unknown flag and a positional', async () => {
    const unknown = await run('--unknown');
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /unknown option --unknown/);
    const extra = await run('extra');
    assert.equal(extra.code, 2);
    assert.match(extra.err, /describe takes no arguments/);
    assert.doesNotMatch(extra.err, /extra/);
  });
});

// ---------------------------------------------------------------------------
// --config pointing at a project outside the working directory
// ---------------------------------------------------------------------------

describe('generated components of a project named by --config', () => {
  const configPath = writeGeneratedComponentsProject(
    join(fixturesRoot, 'describe-config-elsewhere'),
  );

  it('describe lists them from the project root', async () => {
    assert.notEqual(join(configPath, '..'), process.cwd());
    const sinks: DescribeSinks = { out: [], err: [] };

    const code = await runDescribe(
      { configPath, options: { json: true } },
      {},
      {
        ...defaultDescribeDeps,
        stdout: (text: string) => sinks.out.push(text),
        stderr: (text: string) => sinks.err.push(text),
      },
    );

    assert.equal(code, 0, sinks.err.join('\n'));
    const parsed = JSON.parse(sinks.out[0] as string) as DescribeResult;
    assert.deepEqual(parsed.components, [TASK_LIST_DESCRIPTION]);
  });

  it('the assembled application serves them', async () => {
    const app = await createApplication(await loadApp({ configPath }));
    try {
      assert.deepEqual(app.services.get(serverComponentsToken).describe().components, [
        TASK_LIST_DESCRIPTION,
      ]);
    } finally {
      await app.close();
    }
  });
});
