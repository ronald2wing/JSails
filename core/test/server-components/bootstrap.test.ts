/**
 * Tests for `loadComponentEntries`: the compiler-generated component entries
 * are read from the compiled registry module under the application root, a
 * project without one has none, and a module whose export is not a list is
 * refused. The server-components plugin reads them from the root its setup
 * context names, never from the working directory.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, describe, it } from 'node:test';

import { runExtensions } from '../../src/extensions/extension.js';
import { loadComponentEntries } from '../../src/server-components/bootstrap.js';
import {
  serverComponentsPlugin,
  serverComponentsToken,
} from '../../src/server-components/extension.js';

const createdDirs: string[] = [];

after(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRoot(source?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-component-entries-'));
  createdDirs.push(dir);
  if (source !== undefined) {
    const registry = join(dir, 'dist', '.jsails', 'components.registry.js');
    mkdirSync(join(registry, '..'), { recursive: true });
    writeFileSync(registry, source);
  }
  return dir;
}

const TASK_LIST_REGISTRY = `export const components = [{
  id: 'task-list',
  definition: { name: 'task-list', render() { return null; }, actions: { add() {} }, writableKeys: ['title'] },
}];
`;

describe('loadComponentEntries', () => {
  it('returns the entries the compiled registry exports', async () => {
    const root = makeRoot(
      "export const components = [{ id: 'task-list', definition: { name: 'task-list' } }];\n",
    );

    const entries = await loadComponentEntries({ rootDir: root });

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.id, 'task-list');
  });

  it('returns no entries when the project has no registry', async () => {
    assert.deepEqual(await loadComponentEntries({ rootDir: makeRoot() }), []);
  });

  it('refuses a call without the application root', async () => {
    await assert.rejects(
      () => loadComponentEntries({} as { rootDir: string }),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /requires the application rootDir/);
        return true;
      },
    );
  });

  it('refuses a registry whose components export is not a list', async () => {
    const root = makeRoot('export const components = {};\n');
    await assert.rejects(
      () => loadComponentEntries({ rootDir: root }),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, 'component_registry.invalid_entries');
        return true;
      },
    );
  });
});

describe('serverComponentsPlugin generated entries', () => {
  it('reads the entries under the setup context root, not the working directory', async () => {
    const root = makeRoot(TASK_LIST_REGISTRY);
    assert.notEqual(root, process.cwd());

    const runtime = await runExtensions([serverComponentsPlugin()], { rootDir: root });
    try {
      assert.deepEqual(runtime.services.get(serverComponentsToken).describe().components, [
        { name: 'task-list', actions: ['add'], writableKeys: ['title'] },
      ]);
    } finally {
      await runtime.close();
    }
  });

  it('announces generated components before setup and lists them after', async () => {
    const plugin = serverComponentsPlugin();
    assert.deepEqual(plugin.describe!(), { needsLive: true, generatedComponents: true });

    const runtime = await runExtensions([plugin], { rootDir: makeRoot(TASK_LIST_REGISTRY) });
    try {
      assert.deepEqual(plugin.describe!().components, [
        { name: 'task-list', actions: ['add'], writableKeys: ['title'] },
      ]);
    } finally {
      await runtime.close();
    }
  });
});
