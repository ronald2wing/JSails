import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createThemeRegistry,
  discoverThemePackages,
  MAX_THEME_PARENT_DEPTH,
  ThemePackageError,
  type ThemePackage,
  type ThemeTokenMap,
} from '../../src/packages/index.js';

function makePackage(
  name: string,
  tokens: ThemeTokenMap = {},
  overrides: Record<string, unknown> = {},
): ThemePackage {
  const [pkg] = discoverThemePackages([
    { path: name, manifest: { name, version: '1.0.0', tokens, ...overrides } },
  ]);
  return pkg!;
}

describe('createThemeRegistry', () => {
  it('lists packages sorted by name and looks them up', () => {
    const registry = createThemeRegistry({
      packages: [makePackage('zephyr'), makePackage('aurora')],
    });
    assert.deepEqual(
      registry.list().map((p) => p.name),
      ['aurora', 'zephyr'],
    );
    assert.equal(registry.get('aurora')!.name, 'aurora');
    assert.equal(registry.get('missing'), undefined);
  });

  it('defaults the active theme to the first sorted package', () => {
    const registry = createThemeRegistry({
      packages: [makePackage('zephyr'), makePackage('aurora')],
    });
    assert.equal(registry.active()!.name, 'aurora');
    assert.equal(registry.activeName(), 'aurora');
  });

  it('honors an explicit active theme', () => {
    const registry = createThemeRegistry({
      packages: [makePackage('zephyr'), makePackage('aurora')],
      active: 'zephyr',
    });
    assert.equal(registry.active()!.name, 'zephyr');
  });

  it('returns no active theme for an empty package set', () => {
    const registry = createThemeRegistry({ packages: [] });
    assert.equal(registry.active(), undefined);
    assert.equal(registry.activeName(), undefined);
    assert.deepEqual(registry.list(), []);
  });

  it('rejects an unknown active theme at creation', () => {
    assert.throws(
      () => createThemeRegistry({ packages: [makePackage('aurora')], active: 'ghost' }),
      (error: unknown) => error instanceof ThemePackageError && error.code === 'unknown_theme',
    );
  });

  it('rejects duplicate package names', () => {
    assert.throws(
      () =>
        createThemeRegistry({
          packages: [
            makePackage('dup', { '--jsails-bg': '#000' }),
            makePackage('dup', { '--jsails-bg': '#111' }),
          ],
        }),
      (error: unknown) => error instanceof ThemePackageError && error.code === 'duplicate_name',
    );
  });

  it('rejects a non-object options argument', () => {
    assert.throws(
      () => createThemeRegistry(null as never),
      (error: unknown) => error instanceof ThemePackageError && error.code === 'invalid_input',
    );
  });
});

describe('activation immutability', () => {
  it('activate returns a new registry and leaves the original unchanged', () => {
    const original = createThemeRegistry({
      packages: [makePackage('aurora'), makePackage('zephyr')],
    });
    const activated = original.activate('zephyr');

    assert.equal(original.activeName(), 'aurora');
    assert.equal(activated.activeName(), 'zephyr');
    assert.notEqual(original, activated);
    assert.equal(activated.active()!.name, 'zephyr');
  });

  it('activate is chainable', () => {
    const registry = createThemeRegistry({ packages: [makePackage('a'), makePackage('b')] });
    const result = registry.activate('b').activate('a');
    assert.equal(result.activeName(), 'a');
  });

  it('activating an unknown name is a value-free error', () => {
    const registry = createThemeRegistry({ packages: [makePackage('aurora')] });
    assert.throws(
      () => registry.activate('ghost'),
      (error: unknown) => error instanceof ThemePackageError && error.code === 'unknown_theme',
    );
  });

  it('the registry object is frozen', () => {
    const registry = createThemeRegistry({ packages: [makePackage('aurora')] });
    assert.ok(Object.isFrozen(registry));
    assert.ok(Object.isFrozen(registry.list()));
  });
});

describe('token precedence', () => {
  const DEFAULTS: ThemeTokenMap = {
    '--jsails-bg': '#ffffff',
    '--jsails-fg': '#1f2937',
  };

  it('core defaults sit below package tokens', () => {
    const registry = createThemeRegistry({
      packages: [makePackage('dark', { '--jsails-bg': '#1a1a2e' })],
      defaults: DEFAULTS,
    });
    const tokens = registry.resolveTokens();
    assert.equal(tokens['--jsails-bg'], '#1a1a2e'); // package wins over defaults
    assert.equal(tokens['--jsails-fg'], '#1f2937'); // defaults fill the gap
  });

  it('application tokens sit above package tokens', () => {
    const registry = createThemeRegistry({
      packages: [makePackage('dark', { '--jsails-bg': '#1a1a2e' })],
      appTokens: { '--jsails-bg': '#000000' },
    });
    assert.equal(registry.resolveTokens()['--jsails-bg'], '#000000');
  });

  it('full precedence: defaults < package < application', () => {
    const registry = createThemeRegistry({
      packages: [makePackage('dark', { '--jsails-bg': '#1a1a2e', '--jsails-accent': '#e94560' })],
      defaults: DEFAULTS,
      appTokens: { '--jsails-bg': '#000000' },
    });
    const tokens = registry.resolveTokens();
    assert.equal(tokens['--jsails-bg'], '#000000'); // application
    assert.equal(tokens['--jsails-accent'], '#e94560'); // package
    assert.equal(tokens['--jsails-fg'], '#1f2937'); // defaults
    assert.ok(Object.isFrozen(tokens));
  });

  it('only the active package contributes tokens', () => {
    const registry = createThemeRegistry({
      packages: [
        makePackage('light', { '--jsails-bg': '#ffffff' }),
        makePackage('dark', { '--jsails-bg': '#000000' }),
      ],
    });
    // Sorted by name: dark before light, so dark is active by default.
    assert.equal(registry.activeName(), 'dark');
    assert.equal(registry.resolveTokens()['--jsails-bg'], '#000000');

    const switched = registry.activate('light');
    assert.equal(switched.resolveTokens()['--jsails-bg'], '#ffffff');
  });

  it('themes() maps each package name to its token map', () => {
    const registry = createThemeRegistry({
      packages: [
        makePackage('light', { '--jsails-bg': '#ffffff' }),
        makePackage('dark', { '--jsails-bg': '#000000' }),
      ],
    });
    const themes = registry.themes();
    assert.deepEqual(Object.keys(themes).sort(), ['dark', 'light']);
    assert.equal(themes['dark']!['--jsails-bg'], '#000000');
    assert.equal(themes['light']!['--jsails-bg'], '#ffffff');
    assert.ok(Object.isFrozen(themes));
  });

  it('toCss emits :root active tokens plus per-theme data-theme blocks', () => {
    const registry = createThemeRegistry({
      packages: [
        makePackage('light', { '--jsails-bg': '#ffffff' }),
        makePackage('dark', { '--jsails-bg': '#000000' }),
      ],
    });
    const css = registry.toCss();
    assert.ok(css.includes(':root {'));
    assert.ok(css.includes('--jsails-bg: #000000;'), 'active dark tokens are in :root');
    assert.ok(css.includes('[data-theme="dark"]'));
    assert.ok(css.includes('[data-theme="light"]'));
    assert.equal(registry.resolveTokens()['--jsails-bg'], '#000000');
  });
});

describe('parent theme inheritance', () => {
  it('inherits parent tokens and lets the child override individual properties', () => {
    const parent = makePackage('parent', {
      '--jsails-bg': '#ffffff',
      '--jsails-accent': '#888888',
    });
    const child = makePackage(
      'child',
      { '--jsails-accent': '#00aaff' },
      { parent: 'parent', description: 'Child theme' },
    );
    const registry = createThemeRegistry({ packages: [parent, child] });

    const resolved = registry.resolve('child');
    assert.ok(resolved);
    assert.equal(resolved.tokens['--jsails-bg'], '#ffffff');
    assert.equal(resolved.tokens['--jsails-accent'], '#00aaff');
    assert.equal(resolved.description, 'Child theme');

    assert.deepEqual(
      registry.lineage('child').map((pkg) => pkg.name),
      ['parent', 'child'],
    );
    assert.equal(registry.themes()['child']!['--jsails-bg'], '#ffffff');
    assert.equal(registry.themes()['child']!['--jsails-accent'], '#00aaff');
  });

  it('allows activating a child and resolves the inherited token map', () => {
    const parent = makePackage('parent', { '--jsails-bg': '#ffffff' });
    const child = makePackage('child', { '--jsails-accent': '#00aaff' }, { parent: 'parent' });
    const registry = createThemeRegistry({ packages: [parent, child], active: 'child' });

    assert.equal(registry.active()!.name, 'child');
    assert.equal(registry.activeName(), 'child');
    assert.equal(registry.resolveTokens()['--jsails-bg'], '#ffffff');
    assert.equal(registry.resolveTokens()['--jsails-accent'], '#00aaff');
    assert.equal(registry.resolveActive()!.tokens['--jsails-bg'], '#ffffff');
  });

  it('allows activating the parent directly', () => {
    const parent = makePackage('parent', { '--jsails-bg': '#ffffff' });
    const child = makePackage('child', { '--jsails-accent': '#00aaff' }, { parent: 'parent' });
    const registry = createThemeRegistry({ packages: [parent, child], active: 'parent' });

    assert.equal(registry.activeName(), 'parent');
    assert.equal(registry.resolveTokens()['--jsails-bg'], '#ffffff');
    assert.equal(registry.resolveTokens()['--jsails-accent'], undefined);
  });

  it('inherits layouts and CSS, with child layout overrides and CSS appended', () => {
    const header = {
      version: 1,
      name: 'header',
      root: { type: 'element', tag: 'header', children: [{ type: 'text', value: 'parent' }] },
    };
    const childHeader = {
      version: 1,
      name: 'child-header',
      root: { type: 'element', tag: 'header', children: [{ type: 'text', value: 'child' }] },
    };
    const parent = makePackage('parent', {}, { layouts: { header }, css: '.parent{}' });
    const child = makePackage(
      'child',
      {},
      { parent: 'parent', layouts: { header: childHeader }, css: '.child{}' },
    );
    const registry = createThemeRegistry({ packages: [parent, child] });
    const resolved = registry.resolve('child');
    assert.ok(resolved);
    assert.deepEqual(resolved.layouts.header, childHeader);
    assert.equal(resolved.css, '.parent{}\n.child{}');
  });

  it('inherits preview, templates, partials, and content types with child fallbacks', () => {
    const parent = makePackage(
      'parent',
      {},
      {
        preview: 'preview.png',
        templates: ['templates/index.json'],
        partials: ['partials/nav.json'],
        contentTypes: ['article'],
      },
    );
    const child = makePackage(
      'child',
      {},
      {
        parent: 'parent',
        templates: ['templates/single.json'],
        contentTypes: ['page'],
      },
    );
    const registry = createThemeRegistry({ packages: [parent, child] });
    const resolved = registry.resolve('child');
    assert.ok(resolved);
    assert.equal(resolved.preview, 'preview.png');
    assert.deepEqual(resolved.templates, ['templates/index.json', 'templates/single.json']);
    assert.deepEqual(resolved.partials, ['partials/nav.json']);
    assert.deepEqual(resolved.contentTypes, ['article', 'page']);
  });

  it('rejects missing parents and cycles', () => {
    assert.throws(
      () => createThemeRegistry({ packages: [makePackage('child', {}, { parent: 'ghost' })] }),
      (error: unknown) => error instanceof ThemePackageError && error.code === 'missing_parent',
    );
    assert.throws(
      () =>
        createThemeRegistry({
          packages: [makePackage('a', {}, { parent: 'b' }), makePackage('b', {}, { parent: 'a' })],
        }),
      (error: unknown) => error instanceof ThemePackageError && error.code === 'parent_cycle',
    );
    assert.throws(
      () => createThemeRegistry({ packages: [makePackage('self', {}, { parent: 'self' })] }),
      (error: unknown) => error instanceof ThemePackageError && error.code === 'parent_cycle',
    );
  });

  it('rejects a parent chain deeper than the supported bound', () => {
    const chain = Array.from({ length: MAX_THEME_PARENT_DEPTH + 1 }, (_, index) =>
      makePackage(`level-${index}`, {}, index === 0 ? {} : { parent: `level-${index - 1}` }),
    );
    assert.throws(
      () => createThemeRegistry({ packages: chain }),
      (error: unknown) => error instanceof ThemePackageError && error.code === 'parent_depth',
    );
  });
});
