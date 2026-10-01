/**
 * Tests for `autoloadPlugin`: the bundler plugin that injects imports for
 * autoloaded project symbols.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { autoloadPlugin } from '../../src/compiler/project-symbols-plugin.js';
import {
  AutoloadError,
  scanAutoload,
  toAutoloadJson,
} from '../../src/compiler/project-symbols-scan.js';
import {
  META_MANIFEST_FILE,
  buildMetaManifest,
  emitMetaManifest,
} from '../../src/build/meta-manifest.js';

const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'project-symbols-plugin-fixture-'),
);

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function makeProject(name: string): string {
  const root = join(fixturesRoot, name);
  mkdirSync(join(root, 'app', 'composables'), { recursive: true });
  mkdirSync(join(root, 'app', 'utils'), { recursive: true });
  mkdirSync(join(root, 'app', 'pages'), { recursive: true });
  mkdirSync(join(root, 'server', 'utils'), { recursive: true });
  mkdirSync(join(root, 'server', 'api'), { recursive: true });
  return root;
}

function writeModule(root: string, relPath: string, body: string): void {
  const filePath = join(root, relPath);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, body);
}

function seed(root: string): void {
  writeModule(root, 'app/composables/use-counter.js', 'export function useCounter() { return 0; }');
  writeModule(root, 'app/utils/format-date.js', 'export function formatDate() { return ""; }');
  writeModule(
    root,
    'server/utils/server-only-fn.js',
    'export function serverOnlyFn() { return 1; }',
  );
}

/**
 * Produce `.jsails/autoload.json` and its manifest exactly as `jsails
 * build:meta` would. The plugin verifies the manifest before trusting the
 * registry, so a registry without one is a hard error.
 */
async function writeRegistry(root: string): Promise<void> {
  const registry = await scanAutoload(root);
  const json = JSON.stringify(toAutoloadJson(registry), null, 2) + '\n';
  const dir = join(root, '.jsails');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'autoload.json'), json);
  writeFileSync(join(dir, META_MANIFEST_FILE), emitMetaManifest(buildMetaManifest(root)));
}

describe('autoloadPlugin', () => {
  it('injects app symbols into a client module', async () => {
    const root = makeProject('client');
    seed(root);
    await writeRegistry(root);
    const plugin = autoloadPlugin({ rootDir: root });
    await plugin.buildStart();

    const result = plugin.transform(
      'console.log(useCounter(), formatDate());',
      join(root, 'app/pages/index.tsx'),
    );

    assert.ok(result);
    assert.match(result.code, /import \{ formatDate \} from '\.\.\/utils\/format-date\.js';/);
    assert.match(result.code, /import \{ useCounter \} from '\.\.\/composables\/use-counter\.js';/);
  });

  it('injects a server symbol into a server module', async () => {
    const root = makeProject('server');
    seed(root);
    await writeRegistry(root);
    const plugin = autoloadPlugin({ rootDir: root });
    await plugin.buildStart();

    const result = plugin.transform(
      'console.log(serverOnlyFn());',
      join(root, 'server/api/foo.ts'),
    );

    assert.ok(result);
    assert.match(result.code, /import \{ serverOnlyFn \} from '\.\.\/utils\/server-only-fn\.js';/);
  });

  it('refuses a server-only symbol in a client module', async () => {
    const root = makeProject('refuse');
    seed(root);
    await writeRegistry(root);
    const plugin = autoloadPlugin({ rootDir: root });
    await plugin.buildStart();

    const result = plugin.transform(
      'console.log(serverOnlyFn());',
      join(root, 'app/pages/bad.tsx'),
    );

    assert.equal(result, null);
  });

  it('returns null for a module with no free autoload symbols', async () => {
    const root = makeProject('noop');
    seed(root);
    await writeRegistry(root);
    const plugin = autoloadPlugin({ rootDir: root });
    await plugin.buildStart();

    const result = plugin.transform('console.log("hi");', join(root, 'app/pages/index.tsx'));

    assert.equal(result, null);
  });

  it('skips CSS modules', async () => {
    const root = makeProject('css');
    seed(root);
    await writeRegistry(root);
    const plugin = autoloadPlugin({ rootDir: root });
    await plugin.buildStart();

    const result = plugin.transform('body { color: red; }', join(root, 'app/pages/x.css'));

    assert.equal(result, null);
  });

  it('returns null before buildStart has read the registry', () => {
    const root = makeProject('pre-scan');
    seed(root);
    const plugin = autoloadPlugin({ rootDir: root });

    const result = plugin.transform(
      'console.log(useCounter());',
      join(root, 'app/pages/index.tsx'),
    );

    assert.equal(result, null);
  });

  it('forces the server context when server: true', async () => {
    const root = makeProject('forced');
    seed(root);
    await writeRegistry(root);
    const plugin = autoloadPlugin({ rootDir: root, server: true });
    await plugin.buildStart();

    const result = plugin.transform(
      'console.log(serverOnlyFn());',
      join(root, 'app/pages/forced.tsx'),
    );

    assert.ok(result);
    assert.match(result.code, /serverOnlyFn/);
  });

  it('falls back to a source scan when no registry artifact exists', async () => {
    const root = makeProject('fallback');
    seed(root);
    // No `.jsails/autoload.json` — a bare Vite build with no preceding build:meta.
    const plugin = autoloadPlugin({ rootDir: root });
    await plugin.buildStart();

    const result = plugin.transform(
      'console.log(useCounter());',
      join(root, 'app/pages/index.tsx'),
    );

    assert.ok(result);
    assert.match(result.code, /import \{ useCounter \} from '\.\.\/composables\/use-counter\.js';/);
  });

  it('rejects a malformed registry artifact value-free', async () => {
    const root = makeProject('malformed');
    seed(root);
    const dir = join(root, '.jsails');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'autoload.json'), '{ "version": 999, "entries": [] }');
    // A valid manifest, so the failure is the registry's version, not staleness.
    writeFileSync(join(dir, META_MANIFEST_FILE), emitMetaManifest(buildMetaManifest(root)));

    await assert.rejects(autoloadPlugin({ rootDir: root }).buildStart(), (error: unknown) => {
      assert.ok(error instanceof AutoloadError);
      assert.equal(error.code, 'invalid_registry');
      assert.doesNotMatch(error.message, /999/);
      return true;
    });
  });

  it('rejects an unparseable registry artifact value-free', async () => {
    const root = makeProject('unparseable');
    seed(root);
    const dir = join(root, '.jsails');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'autoload.json'), 'not-json // secret-token-xyz');

    await assert.rejects(autoloadPlugin({ rootDir: root }).buildStart(), (error: unknown) => {
      assert.ok(error instanceof AutoloadError);
      assert.equal(error.code, 'invalid_registry');
      assert.doesNotMatch(error.message, /secret-token-xyz/);
      return true;
    });
  });

  it('picks the context from the root-relative path, not where the checkout lives', async () => {
    // A checkout under a directory named `server` must not turn client modules
    // into server modules.
    const root = makeProject(join('server', 'checkout'));
    seed(root);
    await writeRegistry(root);
    const plugin = autoloadPlugin({ rootDir: root });
    await plugin.buildStart();

    const result = plugin.transform(
      'console.log(useCounter(), serverOnlyFn());',
      join(root, 'app/pages/index.tsx'),
    );

    assert.ok(result);
    assert.match(result.code, /import \{ useCounter \}/);
    assert.doesNotMatch(result.code, /server-only-fn/);
  });

  it('lets a server module see app symbols', async () => {
    const root = makeProject('server-sees-app');
    seed(root);
    await writeRegistry(root);
    const plugin = autoloadPlugin({ rootDir: root });
    await plugin.buildStart();

    const result = plugin.transform('console.log(formatDate());', join(root, 'server/api/foo.ts'));

    assert.ok(result);
    assert.match(
      result.code,
      /import \{ formatDate \} from '\.\.\/\.\.\/app\/utils\/format-date\.js';/,
    );
  });

  it('appends imports so every original line keeps its number', async () => {
    const root = makeProject('line-numbers');
    seed(root);
    await writeRegistry(root);
    const plugin = autoloadPlugin({ rootDir: root });
    await plugin.buildStart();

    const source = "'use server';\nexport function f() {\n  return useState(useCounter());\n}\n";
    const result = plugin.transform(source, join(root, 'ui/widget.tsx'));

    assert.ok(result);
    assert.ok(result.code.startsWith(source), 'the original text is untouched, prologue first');
    assert.match(result.code, /import \{ useCounter \}/);
    assert.match(result.code, /import \{ useState \} from 'preact\/hooks';/);
    assert.ok(result.map !== null);
  });

  it('never parses a module that names no candidate symbol', async () => {
    const root = makeProject('prefilter');
    seed(root);
    await writeRegistry(root);
    const plugin = autoloadPlugin({ rootDir: root });
    await plugin.buildStart();

    // Unparseable on purpose: a parse would throw.
    assert.equal(plugin.transform('export function (', join(root, 'app/pages/x.ts')), null);
  });

  it('exposes the expected plugin shape', () => {
    const plugin = autoloadPlugin();
    assert.equal(plugin.name, 'jsails-autoload');
    assert.equal(plugin.enforce, 'pre');
    assert.deepEqual(Object.keys(plugin).sort(), ['buildStart', 'enforce', 'name', 'transform']);
  });
});
