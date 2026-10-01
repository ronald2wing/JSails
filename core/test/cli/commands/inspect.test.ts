/**
 * Tests for `runInspectRoutes` and the `jsails inspect` command.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  inspectCommand,
  runInspectRoutes,
  type InspectRoutesDeps,
} from '../../../src/cli/commands/inspect.js';
import { dispatch } from '../../../src/cli/dispatch.js';
import { NON_INTERACTIVE_PROMPTER } from '../../../src/cli/prompter.js';
import type { ResolvedAppConfig } from '../../../src/app/config/index.js';

/**
 * Tests for `inspect routes`, exercised through its dependency seam so no real
 * config module is imported and no connection is opened.
 */

const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('../..', import.meta.url)), 'inspect-fixture-'),
);

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// inspect routes
// ---------------------------------------------------------------------------

function resolveConfig(rootDir: string, pagesRel?: string, apiRel?: string): ResolvedAppConfig {
  const pages = pagesRel ?? 'pages';
  const api = apiRel ?? 'api';
  return {
    rootDir,
    pagesDir: join(rootDir, pages),
    apiDir: join(rootDir, api),
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
    extensions: [],
    renderer: undefined,
    plugins: { use: [] },
  };
}

interface InspectSinks {
  out: string[];
  err: string[];
}

function inspectDeps(sinks: InspectSinks, config: ResolvedAppConfig): InspectRoutesDeps {
  return {
    loadConfig: async () => config,
    env: {},
    stdout: (text) => sinks.out.push(text),
    stderr: (text) => sinks.err.push(text),
  };
}

describe('runInspectRoutes', () => {
  it('prints the route manifest as a human-readable table', async () => {
    const dir = join(fixturesRoot, 'inspect-human');
    mkdirSync(join(dir, 'pages', 'blog'), { recursive: true });
    mkdirSync(join(dir, 'api'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');
    writeFileSync(join(dir, 'pages', 'about.js'), '');
    writeFileSync(join(dir, 'pages', 'blog', '[slug].js'), '');
    writeFileSync(join(dir, 'api', 'users.js'), '');

    const config = resolveConfig(dir);
    const sinks: InspectSinks = { out: [], err: [] };
    const deps = inspectDeps(sinks, config);

    const code = await runInspectRoutes({ configPath: config.configPath, options: {} }, deps);

    assert.equal(code, 0);
    assert.deepEqual(sinks.err, []);
    const out = sinks.out.join('\n');
    assert.match(out, /Route manifest \(4 route\(s\)\)/);
    assert.match(out, /\/\s+page\s+false/);
    assert.match(out, /\/about\s+page\s+false/);
    assert.match(out, /\/blog\/:slug\s+page\s+true/);
    assert.match(out, /\/api\/users\s+api\s+false/);
  });

  it('emits a single JSON line with --json', async () => {
    const dir = join(fixturesRoot, 'inspect-json');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');
    writeFileSync(join(dir, 'pages', 'about.js'), '');

    const config = resolveConfig(dir);
    const sinks: InspectSinks = { out: [], err: [] };
    const deps = inspectDeps(sinks, config);

    const code = await runInspectRoutes(
      { configPath: config.configPath, options: { json: true } },
      deps,
    );

    assert.equal(code, 0);
    assert.equal(sinks.out.length, 1);
    const parsed = JSON.parse(sinks.out[0] as string) as {
      entries: Array<{
        kind: string;
        route: string;
        file: string;
        dynamic: boolean;
        params: string[];
      }>;
    };
    assert.equal(parsed.entries.length, 2);
    const routes = parsed.entries.map((e) => e.route).sort();
    assert.deepEqual(routes, ['/', '/about']);
    for (const entry of parsed.entries) {
      assert.equal(typeof entry.kind, 'string');
      assert.equal(typeof entry.file, 'string');
      assert.ok(isAbsolute(entry.file), 'file path is absolute');
      assert.equal(typeof entry.dynamic, 'boolean');
      assert.equal((entry as Record<string, unknown>).catchAll, false);
      assert.ok(Array.isArray(entry.params));
    }
  });

  it('emits catchAll: true for a trailing catch-all route', async () => {
    const dir = join(fixturesRoot, 'inspect-catchall');
    mkdirSync(join(dir, 'pages', 'docs'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'docs', '[...slug].js'), '');

    const config = resolveConfig(dir);
    const sinks: InspectSinks = { out: [], err: [] };
    const deps = inspectDeps(sinks, config);

    const code = await runInspectRoutes(
      { configPath: config.configPath, options: { json: true } },
      deps,
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(sinks.out[0] as string) as {
      entries: Array<{ route: string; catchAll: boolean; params: string[] }>;
    };
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.entries[0]!.route, '/docs/*slug');
    assert.equal(parsed.entries[0]!.catchAll, true);
    assert.deepEqual(parsed.entries[0]!.params, ['slug']);
  });

  it('handles an empty route set', async () => {
    const dir = join(fixturesRoot, 'inspect-empty');
    mkdirSync(dir, { recursive: true });

    const config = resolveConfig(dir, 'nonexistent_pages', 'nonexistent_api');
    const sinks: InspectSinks = { out: [], err: [] };
    const deps = inspectDeps(sinks, config);

    const code = await runInspectRoutes({ configPath: config.configPath, options: {} }, deps);

    assert.equal(code, 0);
    const out = sinks.out.join('\n');
    assert.match(out, /No routes found/);
    assert.deepEqual(sinks.err, []);
  });

  it('handles empty route set with --json', async () => {
    const dir = join(fixturesRoot, 'inspect-empty-json');
    mkdirSync(dir, { recursive: true });

    const config = resolveConfig(dir, 'nonexistent_pages', 'nonexistent_api');
    const sinks: InspectSinks = { out: [], err: [] };
    const deps = inspectDeps(sinks, config);

    const code = await runInspectRoutes(
      { configPath: config.configPath, options: { json: true } },
      deps,
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(sinks.out[0] as string) as { entries: unknown[] };
    assert.deepEqual(parsed.entries, []);
  });

  it('returns 1 and a value-free message when the config fails to load', async () => {
    const sinks: InspectSinks = { out: [], err: [] };
    const deps: InspectRoutesDeps = {
      loadConfig: async () => {
        throw new Error('ENOENT: no such file, open "secret.yml"');
      },
      env: {},
      stdout: (text) => sinks.out.push(text),
      stderr: (text) => sinks.err.push(text),
    };

    const code = await runInspectRoutes({ configPath: '/nonexistent.js', options: {} }, deps);

    assert.equal(code, 1);
    assert.match(sinks.err.join('\n'), /failed to load config/);
    // The original error message must not be echoed.
    assert.ok(!sinks.err.join('\n').includes('secret.yml'));
  });

  it('returns 1 and a value-free message when route discovery fails', async () => {
    const dir = join(fixturesRoot, 'inspect-bad-route');
    mkdirSync(join(dir, 'pages', '[...catch]'), { recursive: true });
    // A non-trailing catch-all segment triggers a RouteManifestError.
    writeFileSync(join(dir, 'pages', '[...catch]', 'about.js'), '');

    const config = resolveConfig(dir);
    const sinks: InspectSinks = { out: [], err: [] };
    const deps = inspectDeps(sinks, config);

    const code = await runInspectRoutes({ configPath: config.configPath, options: {} }, deps);

    assert.equal(code, 1);
    assert.match(sinks.err.join('\n'), /route discovery failed/);
  });
});

describe('jsails inspect (arg parsing)', () => {
  /** Dispatch `jsails inspect ...args`; each case stops before the environment resolves. */
  async function inspect(...args: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await dispatch(['inspect', ...args], {
      cwd: fixturesRoot,
      stdout: (text) => out.push(text),
      stderr: (line) => err.push(line),
    });
    return { code, out: out.join(''), err: err.join('\n') };
  }

  it('prints its generated help for --help', async () => {
    const result = await inspect('--help');
    assert.equal(result.code, 0);
    assert.match(result.out, /^jsails inspect - /);
    assert.match(result.out, /Usage:/);
    assert.match(result.out, /--json/);
  });

  it('rejects a missing subject', async () => {
    const result = await inspect();
    assert.equal(result.code, 2);
    assert.match(result.err, /inspect requires <subject>/);
  });

  it('rejects an unknown flag', async () => {
    const result = await inspect('routes', '--unknown');
    assert.equal(result.code, 2);
    assert.match(result.err, /unknown option --unknown/);
  });

  it('rejects a subject other than routes before loading a config', async () => {
    const usage: string[] = [];
    const code = await inspectCommand.run({
      name: 'inspect',
      values: {},
      positionals: ['nope'],
      cwd: fixturesRoot,
      env: {},
      environment: 'test',
      interactive: false,
      prompter: NON_INTERACTIVE_PROMPTER,
      stdout: () => undefined,
      stderr: () => undefined,
      usage: (message) => {
        usage.push(message);
        return 2;
      },
    });
    assert.equal(code, 2);
    assert.deepEqual(usage, ['the one subject is routes']);
  });
});
