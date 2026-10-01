import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isSafeRelativePath,
  parseThemePackageManifest,
  ThemePackageError,
} from '../../src/packages/index.js';

/** A minimal valid manifest fixture. */
function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'midnight',
    version: '1.2.3',
    ...overrides,
  };
}

describe('parseThemePackageManifest', () => {
  it('parses a valid manifest with empty defaults', () => {
    const manifest = parseThemePackageManifest(validManifest());
    assert.equal(manifest.name, 'midnight');
    assert.equal(manifest.version, '1.2.3');
    assert.equal(manifest.description, undefined);
    assert.equal(manifest.author, undefined);
    assert.equal(manifest.preview, undefined);
    assert.deepEqual(manifest.tokens, {});
    assert.deepEqual(manifest.templates, []);
    assert.deepEqual(manifest.partials, []);
    assert.equal(manifest.settingsSchema, undefined);
    assert.deepEqual(manifest.contentTypes, []);
    assert.deepEqual(manifest.layouts, {});
    assert.equal(manifest.css, '');
  });

  it('carries optional fields through verbatim', () => {
    const manifest = parseThemePackageManifest({
      ...validManifest(),
      description: 'A dark theme',
      author: 'Acme',
      preview: 'assets/preview.png',
      tokens: { '--jsails-bg': '#1a1a2e', '--jsails-fg': '#e0e0e0' },
      templates: ['templates/post.html'],
      partials: ['partials/header.html', 'partials/footer.html'],
      settingsSchema: { primary: { type: 'string' } },
      contentTypes: ['article', 'page'],
    });
    assert.equal(manifest.description, 'A dark theme');
    assert.equal(manifest.author, 'Acme');
    assert.equal(manifest.preview, 'assets/preview.png');
    assert.deepEqual(manifest.tokens, {
      '--jsails-bg': '#1a1a2e',
      '--jsails-fg': '#e0e0e0',
    });
    assert.deepEqual(manifest.templates, ['templates/post.html']);
    assert.deepEqual(manifest.partials, ['partials/header.html', 'partials/footer.html']);
    assert.deepEqual(manifest.settingsSchema, { primary: { type: 'string' } });
    assert.deepEqual(manifest.contentTypes, ['article', 'page']);
  });

  it('returns a frozen manifest with frozen nested maps and arrays', () => {
    const manifest = parseThemePackageManifest({
      ...validManifest(),
      tokens: { '--jsails-bg': '#000' },
      templates: ['templates/post.html'],
    });
    assert.ok(Object.isFrozen(manifest));
    assert.ok(Object.isFrozen(manifest.tokens));
    assert.ok(Object.isFrozen(manifest.templates));
    assert.ok(Object.isFrozen(manifest.partials));
    assert.ok(Object.isFrozen(manifest.contentTypes));
  });

  it('rejects unknown fields (strict schema)', () => {
    assert.throws(
      () => parseThemePackageManifest({ ...validManifest(), typo: true }),
      (error: unknown) =>
        error instanceof ThemePackageError &&
        error.code === 'invalid_manifest' &&
        error.issues!.some((i) => i.code === 'unrecognized_keys'),
    );
  });

  it('rejects a missing name with a value-free issue', () => {
    assert.throws(
      () => parseThemePackageManifest({ version: '1.0.0' }),
      (error: unknown) => {
        assert.ok(error instanceof ThemePackageError);
        assert.equal(error.code, 'invalid_manifest');
        assert.ok(error.issues!.some((i) => i.path.join('.') === 'name'));
        return true;
      },
    );
  });

  it('rejects a name that does not match the pattern', () => {
    assert.throws(
      () => parseThemePackageManifest({ ...validManifest(), name: 'Bad Name!' }),
      (error: unknown) =>
        error instanceof ThemePackageError &&
        error.issues!.some((i) => i.code === 'invalid_format' && i.path.join('.') === 'name'),
    );
  });

  it('rejects a version that is not valid semver', () => {
    assert.throws(
      () => parseThemePackageManifest({ ...validManifest(), version: 'one-point-oh' }),
      (error: unknown) =>
        error instanceof ThemePackageError &&
        error.issues!.some((i) => i.code === 'invalid_version' && i.path.join('.') === 'version'),
    );
  });

  it('accepts valid semver prereleases and build metadata', () => {
    assert.equal(
      parseThemePackageManifest({ ...validManifest(), version: '1.2.3-beta.1' }).version,
      '1.2.3-beta.1',
    );
    assert.equal(
      parseThemePackageManifest({ ...validManifest(), version: '1.2.3+build.7' }).version,
      '1.2.3+build.7',
    );
  });

  it('rejects a traversal preview path (invalid_path)', () => {
    assert.throws(
      () => parseThemePackageManifest({ ...validManifest(), preview: '../secret.png' }),
      (error: unknown) => error instanceof ThemePackageError && error.code === 'invalid_path',
    );
  });

  it('rejects an absolute preview path', () => {
    assert.throws(
      () => parseThemePackageManifest({ ...validManifest(), preview: '/etc/passwd' }),
      (error: unknown) => error instanceof ThemePackageError && error.code === 'invalid_path',
    );
  });

  it('rejects a backslash template path', () => {
    assert.throws(
      () => parseThemePackageManifest({ ...validManifest(), templates: ['..\\..\\x'] }),
      (error: unknown) => error instanceof ThemePackageError && error.code === 'invalid_path',
    );
  });

  it('rejects a Windows-drive template path', () => {
    assert.throws(
      () => parseThemePackageManifest({ ...validManifest(), templates: ['C:/x'] }),
      (error: unknown) => error instanceof ThemePackageError && error.code === 'invalid_path',
    );
  });

  it('rejects a token name outside the --jsails-* namespace', () => {
    assert.throws(
      () => parseThemePackageManifest({ ...validManifest(), tokens: { '--brand-bg': '#000' } }),
      (error: unknown) =>
        error instanceof ThemePackageError &&
        error.issues!.some((i) => i.code === 'invalid_token_name' && i.path.join('.') === 'tokens'),
    );
  });

  it('rejects a token value containing </style (injection)', () => {
    assert.throws(
      () =>
        parseThemePackageManifest({ ...validManifest(), tokens: { '--jsails-bg': 'red</style>' } }),
      (error: unknown) =>
        error instanceof ThemePackageError && error.issues!.some((i) => i.code === 'invalid_token'),
    );
  });

  it('rejects a token value containing a control character', () => {
    assert.throws(
      () =>
        parseThemePackageManifest({ ...validManifest(), tokens: { '--jsails-bg': 'red\u0000' } }),
      (error: unknown) =>
        error instanceof ThemePackageError && error.issues!.some((i) => i.code === 'invalid_token'),
    );
  });

  it('never echoes raw input values in its message', () => {
    try {
      parseThemePackageManifest({ name: 'SECRET', version: 'password123' });
      assert.fail('expected a ThemePackageError');
    } catch (error) {
      assert.ok(error instanceof ThemePackageError);
      assert.ok(!error.message.includes('SECRET'), error.message);
      assert.ok(!error.message.includes('password123'), error.message);
    }
  });
});

describe('isSafeRelativePath', () => {
  it('accepts safe package-relative paths', () => {
    for (const path of [
      'assets/preview.png',
      'templates/post.html',
      'partials/header.html',
      './index.html',
      'a/b.js',
      'a',
    ]) {
      assert.equal(isSafeRelativePath(path), true, path);
    }
  });

  it('rejects unsafe or non-relative paths', () => {
    const bad = [
      '',
      '/absolute',
      '../escape',
      'a/../../b',
      'a//b',
      'a/',
      'C:/drive',
      'C:\\drive',
      'a\\b',
      '..',
      'a\u0000b',
    ];
    for (const path of bad) {
      assert.equal(isSafeRelativePath(path), false, JSON.stringify(path));
    }
  });
});
