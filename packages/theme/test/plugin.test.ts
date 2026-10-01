/**
 * `themePlugin` tests: service registration under `themeToken`, option
 * validation, and the browser-safe guarantee for the plugin and barrel modules.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runExtensions, type ExtensionRuntime } from 'jsails/extensions';

import { themePlugin, themeToken, type ThemePluginOptions } from '../src/plugin.js';
import { themeTokensToCss, type ThemeResolution } from '../src/tokens.js';

async function setupThemePlugin(
  options: ThemePluginOptions = {},
): Promise<{ runtime: ExtensionRuntime; resolution: ThemeResolution }> {
  const runtime = await runExtensions([themePlugin(options)]);
  const resolution = runtime.services.get(themeToken);
  return { runtime, resolution };
}

describe('themePlugin', () => {
  it('provides under themeToken with an empty map by default', async () => {
    const { resolution, runtime } = await setupThemePlugin();
    assert.deepStrictEqual(resolution.active, {});
    assert.equal(themeTokensToCss(resolution), '');
    assert.equal(resolution.activeName, undefined);
    assert.ok(Object.isFrozen(resolution));
    await runtime.close();
  });

  it('provides app-level tokens', async () => {
    const { resolution, runtime } = await setupThemePlugin({
      tokens: { '--jsails-bg': '#000' },
    });
    assert.equal(resolution.active['--jsails-bg'], '#000');
    await runtime.close();
  });

  it('merges app tokens with plugin contributions', async () => {
    const { resolution, runtime } = await setupThemePlugin({
      tokens: { '--jsails-bg': '#app-bg' },
      contributions: [
        {
          source: 'plugin-x',
          tokens: { '--jsails-accent': '#plugin-accent' },
        },
      ],
    });
    const map = resolution.active;
    assert.equal(map['--jsails-bg'], '#app-bg');
    assert.equal(map['--jsails-accent'], '#plugin-accent');
    await runtime.close();
  });

  it('supports active named theme', async () => {
    const { resolution, runtime } = await setupThemePlugin({
      contributions: [
        {
          source: 'my-theme',
          name: 'dark',
          tokens: { '--jsails-bg': '#000' },
        },
      ],
      active: 'dark',
    });
    const map = resolution.active;
    assert.equal(map['--jsails-bg'], '#000');
    assert.equal(resolution.activeName, 'dark');
    await runtime.close();
  });

  it('a second themePlugin is rejected at setup (duplicate provide)', async () => {
    await assert.rejects(runExtensions([themePlugin(), themePlugin()]), (err: unknown) => {
      if (!(err instanceof Error)) return false;
      assert.match(err.message, /theme/);
      return true;
    });
  });

  it('rejects non-object options eagerly', () => {
    assert.throws(() => {
      themePlugin(null as never);
    }, TypeError);
    assert.throws(() => {
      themePlugin('bad' as never);
    }, TypeError);
  });
});

// ---------------------------------------------------------------------------
describe('browser-safe guarantee', () => {
  it('src/plugin.ts has no node:* specifiers in source', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../../src/plugin.ts', import.meta.url), 'utf-8');
    const importLines = source.split('\n').filter((line) => /^import\s/.test(line));
    const nodeImports = importLines.filter((line) => line.includes('node:'));
    assert.deepStrictEqual(nodeImports, [], 'plugin.ts must not import node:*');
  });

  it('src/index.ts has no node:* specifiers in source', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf-8');
    const importLines = source
      .split('\n')
      .filter((line) => /^import\s/.test(line) || /^export\s.*from/.test(line));
    const nodeImports = importLines.filter((line) => line.includes('node:'));
    assert.deepStrictEqual(nodeImports, [], 'index.ts must not import node:*');
  });
});
