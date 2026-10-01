/**
 * Tests for `installPluginGlobals`: publishing a plugin's declared globals onto
 * `globalThis`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import type { FrameworkSymbolOverrideWarning } from '../../src/symbols/projection.js';
import {
  installPluginGlobals,
  type PluginAutoloadEntry,
} from '../../src/symbols/install-plugin-globals.js';

/**
 * `installPluginGlobals` projects a plugin's own surface onto `globalThis` from
 * pre-resolved manifest entries: it enumerates each opted-in subpath's named
 * exports and projects them, skipping `default`.
 */

const fixtureDir = mkdtempSync(join(tmpdir(), 'plugin-globals-'));

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

/** Write a synthetic subpath module and return its importable specifier. */
function writeModule(exports: string): string {
  const file = join(fixtureDir, `mod-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, exports, 'utf8');
  return pathToFileURL(file).href;
}

describe('installPluginGlobals', () => {
  it('projects a selected subpath onto globalThis, excluding default', async () => {
    const specifier = writeModule(
      'export const alpha = 1;\nexport default 2;\nexport const beta = 3;\n',
    );
    const entries: PluginAutoloadEntry[] = [
      { origin: 'fixture', autoload: { mode: 'selected', specifiers: [specifier] } },
    ];
    const warnings: FrameworkSymbolOverrideWarning[] = [];
    try {
      await installPluginGlobals(entries, { onWarn: (w) => warnings.push(w) });
      const target = globalThis as Record<string, unknown>;
      assert.equal(target['alpha'], 1);
      assert.equal(target['beta'], 3);
      assert.equal(target['default'], undefined); // never projected
    } finally {
      delete (globalThis as Record<string, unknown>)['alpha'];
      delete (globalThis as Record<string, unknown>)['beta'];
    }
  });

  it('contributes nothing for none or an empty selected list', async () => {
    const before = Object.keys(globalThis).length;
    await installPluginGlobals([
      { origin: 'a', autoload: undefined },
      { origin: 'b', autoload: { mode: 'none' } },
      { origin: 'c', autoload: { mode: 'selected', specifiers: [] } },
    ]);
    assert.equal(Object.keys(globalThis).length, before);
  });
});
