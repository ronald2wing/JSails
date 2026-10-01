import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isValidSemverVersion } from 'jsails/semver';

import { builtinThemePackages } from '../src/builtin.js';
import { createThemeRegistry, isSafeRelativePath } from '../src/packages/index.js';

describe('builtinThemePackages', () => {
  it('ships at least two built-in themes', () => {
    assert.ok(builtinThemePackages.length >= 2);
  });

  it('is a frozen, name-sorted array of frozen packages', () => {
    assert.ok(Object.isFrozen(builtinThemePackages));
    const names = builtinThemePackages.map((pkg) => pkg.name);
    assert.deepEqual(names, [...names].sort());
    for (const pkg of builtinThemePackages) {
      assert.ok(Object.isFrozen(pkg));
    }
  });

  it('has unique names', () => {
    const names = builtinThemePackages.map((pkg) => pkg.name);
    assert.equal(new Set(names).size, names.length);
  });

  it('every entry has a valid semver version', () => {
    for (const pkg of builtinThemePackages) {
      assert.ok(isValidSemverVersion(pkg.version), `${pkg.name} version must be valid semver`);
    }
  });

  it('every entry contributes only --jsails-* tokens', () => {
    for (const pkg of builtinThemePackages) {
      for (const tokenName of Object.keys(pkg.tokens)) {
        assert.match(tokenName, /^--jsails-[a-z0-9-]+$/, `${pkg.name} token ${tokenName}`);
      }
    }
  });

  it('every entry declares at least one token', () => {
    for (const pkg of builtinThemePackages) {
      assert.ok(Object.keys(pkg.tokens).length > 0, `${pkg.name} must contribute tokens`);
    }
  });

  it('every entry exposes only a safe relative preview path, if any', () => {
    // Built-ins ship no preview image asset, so `preview` is currently omitted;
    // when one is added it must remain a safe package-relative path so no
    // listing can resolve it outside the package.
    for (const pkg of builtinThemePackages) {
      if (pkg.preview !== undefined) {
        assert.ok(isSafeRelativePath(pkg.preview), `${pkg.name} preview must be a safe path`);
      }
    }
  });

  it('includes Jello Elementor, neutral, and a dark alternative', () => {
    const names = new Set(builtinThemePackages.map((pkg) => pkg.name));
    assert.ok(names.has('jello-elementor'), 'must ship Jello Elementor');
    assert.ok(names.has('neutral'), 'must ship a neutral theme');
    assert.ok(names.has('night'), 'must ship a dark/high-contrast theme');
  });

  it('Jello Elementor is the default (sorts first, so the registry activates it)', () => {
    assert.equal(builtinThemePackages[0]!.name, 'jello-elementor');
  });
});

describe('builtin registry activation', () => {
  it('builds a registry over every built-in and activates each deterministically', () => {
    const registry = createThemeRegistry({ packages: builtinThemePackages });

    // First sorted name is the default active theme.
    assert.equal(registry.activeName(), builtinThemePackages[0]!.name);
    assert.equal(registry.list().length, builtinThemePackages.length);

    for (const pkg of builtinThemePackages) {
      const activated = registry.activate(pkg.name);
      assert.equal(activated.activeName(), pkg.name);

      // The active token map is exactly the package's contributions (no
      // defaults or app tokens fold in from outside).
      assert.deepStrictEqual(activated.resolveTokens(), pkg.tokens);
      assert.ok(Object.isFrozen(activated.resolveTokens()));
    }
  });

  it('every activation is deterministic across repeated registry builds', () => {
    const a = createThemeRegistry({ packages: builtinThemePackages });
    const b = createThemeRegistry({ packages: builtinThemePackages });
    for (const pkg of builtinThemePackages) {
      assert.deepStrictEqual(
        a.activate(pkg.name).resolveTokens(),
        b.activate(pkg.name).resolveTokens(),
      );
    }
  });

  it('themes() maps each built-in name to its token map', () => {
    const registry = createThemeRegistry({ packages: builtinThemePackages });
    const themes = registry.themes();
    for (const pkg of builtinThemePackages) {
      assert.deepStrictEqual(themes[pkg.name], pkg.tokens);
    }
  });

  it('toCss emits a [data-theme] block per built-in', () => {
    const registry = createThemeRegistry({ packages: builtinThemePackages });
    const css = registry.toCss();
    for (const pkg of builtinThemePackages) {
      assert.ok(css.includes(`[data-theme="${pkg.name}"]`), `missing block for ${pkg.name}`);
    }
  });

  it('activation never mutates the built-in array', () => {
    const before = builtinThemePackages.map((pkg) => pkg.tokens);
    const registry = createThemeRegistry({ packages: builtinThemePackages });
    registry.activate(builtinThemePackages[1]!.name);
    const after = builtinThemePackages.map((pkg) => pkg.tokens);
    assert.deepStrictEqual(after, before);
    assert.ok(Object.isFrozen(builtinThemePackages));
  });
});

describe('Jello Elementor', () => {
  it('ships functional blog layouts and scoped CSS', async () => {
    const jello = builtinThemePackages.find((pkg) => pkg.name === 'jello-elementor');
    assert.ok(jello, 'Jello Elementor must be built in');
    assert.ok(jello.layouts.header, 'header layout');
    assert.ok(jello.layouts.footer, 'footer layout');
    assert.ok(jello.layouts.blogIndex, 'blog index layout');
    assert.ok(jello.layouts.blogArchive, 'archive layout');
    assert.ok(jello.layouts.blogSingle, 'single layout');
    assert.ok(jello.layouts.blogError, 'error layout');
    assert.match(jello.css, /\.jello-header/);
    assert.match(jello.css, /\.jello-grid/);
  });

  it('renders its header and blog layouts with escaped text and trusted slots', async () => {
    const { renderThemeTemplate } = await import('../src/packages/index.js');
    const jello = builtinThemePackages.find((pkg) => pkg.name === 'jello-elementor')!;
    const header = renderThemeTemplate(jello.layouts.header!, {
      siteName: 'JSails',
      navigation: '<a href="/blog">Blog</a>',
      actions: '<a href="/admin">Admin</a>',
    });
    assert.match(header, /class="jello-header"/);
    assert.match(header, /href="\/blog"/);

    const index = renderThemeTemplate(jello.layouts.blogIndex!, {
      heading: 'Blog',
      description: 'Notes',
      posts: '<article>Post</article>',
    });
    assert.match(index, /<h1>Blog<\/h1>/);
    assert.match(index, /class="jello-grid"/);
  });
});
