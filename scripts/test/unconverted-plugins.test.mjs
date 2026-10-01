/**
 * Tests for the `unconverted-plugins` gate (`scripts/gates/unconverted-plugins.mjs`):
 * mapping a file to its built module and public entry, finding the awaited harness run that
 * proves a converted plugin inert, and spotting a forbidden runtime among
 * loaded modules. The gate run against the real repository is
 * `npm run gates -- unconverted-plugins` (it needs a build).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { builtModule } from '../gates/plugin-manifests.mjs';
import { awaitsHarnessRun, forbiddenLoads, publicEntry } from '../gates/unconverted-plugins.mjs';

describe('built module and public entry', () => {
  const corePackage = {
    exports: {
      '.': { default: './dist/src/index.js' },
      './encryption': {
        types: './dist/src/encryption/index.d.ts',
        default: './dist/src/encryption/index.js',
      },
    },
  };

  it('maps a source file to its built module', () => {
    assert.equal(
      builtModule('core/src/encryption/plugin.ts'),
      'core/dist/src/encryption/plugin.js',
    );
    assert.equal(builtModule('packages/theme/src/plugin.tsx'), 'packages/theme/dist/src/plugin.js');
    assert.equal(builtModule('scripts/x.mjs'), undefined);
  });

  it('finds the core subpath of the file directory, or the package itself', () => {
    assert.equal(publicEntry('core/src/encryption/plugin.ts', corePackage), 'jsails/encryption');
    assert.equal(publicEntry('core/src/hidden/plugin.ts', corePackage), undefined);
    assert.equal(
      publicEntry('packages/theme/src/plugin.ts', corePackage, '@jsails/theme'),
      '@jsails/theme',
    );
  });

  it('falls back to a core subpath whose barrel re-exports the file', () => {
    const withSdk = {
      exports: {
        ...corePackage.exports,
        './plugin-sdk': {
          types: './dist/src/plugin-sdk/index.d.ts',
          default: './dist/src/plugin-sdk/index.js',
        },
      },
    };
    const barrels = {
      'core/src/plugin-sdk/index.ts': "export * from '../valkey/plugin.js';\n",
    };
    const read = (path) => barrels[path];
    assert.equal(
      publicEntry('core/src/valkey/plugin.ts', withSdk, undefined, read),
      'jsails/plugin-sdk',
    );
    assert.equal(publicEntry('core/src/valkey/other.ts', withSdk, undefined, read), undefined);
    assert.equal(
      publicEntry('core/src/encryption/plugin.ts', withSdk, undefined, read),
      'jsails/encryption',
    );
  });
});

describe('awaitsHarnessRun', () => {
  it('finds an awaited harness run of the factory under any of its names', () => {
    const sources = [
      'const run = await testPlugin(\n  themePlugin({ tokens: {} }),\n);',
      'await testPlugin(other());',
    ];
    assert.equal(awaitsHarnessRun(sources, ['themePlugin']), true);
    assert.equal(awaitsHarnessRun(sources, ['theme', 'other']), true);
  });

  it('does not count a run expected to fail, a mention, or another factory', () => {
    const sources = [
      'await assert.rejects(testPlugin(themePlugin({ bad: true })), isViolation);',
      "it('themePlugin passes testPlugin', () => { themePlugin(); });",
      'await testPlugin(themePluginLegacy());',
    ];
    assert.equal(awaitsHarnessRun(sources, ['themePlugin']), false);
  });
});

describe('forbiddenLoads', () => {
  it('names each forbidden package found among module URLs', () => {
    assert.deepEqual(
      forbiddenLoads([
        'file:///repo/core/dist/src/index.js',
        'file:///repo/node_modules/typeorm/index.mjs',
        'file:///repo/node_modules/bullmq/dist/esm/index.js',
        'file:///repo/node_modules/typeorm-extra/index.js',
        'node:fs',
      ]),
      ['bullmq', 'typeorm'],
    );
  });
});
