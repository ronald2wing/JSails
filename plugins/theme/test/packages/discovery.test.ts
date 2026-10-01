import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  discoverThemePackages,
  ThemePackageError,
  type ThemePackageEntry,
} from '../../src/packages/index.js';

/** A minimal valid raw manifest fixture. */
function rawManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'midnight',
    version: '1.0.0',
    ...overrides,
  };
}

function entry(name: string, manifest: unknown, path = name): ThemePackageEntry {
  return { path, manifest };
}

describe('discoverThemePackages', () => {
  it('returns validated packages sorted by name', () => {
    const packages = discoverThemePackages([
      entry('zephyr', rawManifest({ name: 'zephyr' })),
      entry('aurora', rawManifest({ name: 'aurora' })),
    ]);
    assert.equal(packages.length, 2);
    assert.deepEqual(
      packages.map((p) => p.name),
      ['aurora', 'zephyr'],
    );
    assert.deepEqual(
      packages.map((p) => p.path),
      ['aurora', 'zephyr'],
    );
    assert.ok(Object.isFrozen(packages));
  });

  it('carries the manifest defaults and path onto each package', () => {
    const [pkg] = discoverThemePackages([entry('midnight', rawManifest())]);
    assert.equal(pkg!.name, 'midnight');
    assert.equal(pkg!.version, '1.0.0');
    assert.equal(pkg!.path, 'midnight');
    assert.deepEqual(pkg!.tokens, {});
    assert.deepEqual(pkg!.templates, []);
    assert.ok(Object.isFrozen(pkg));
  });

  it('carries a validated preview path onto each package', () => {
    const [pkg] = discoverThemePackages([
      entry('midnight', rawManifest({ preview: 'assets/preview.png' })),
    ]);
    assert.equal(pkg!.preview, 'assets/preview.png');
  });

  it('rejects an unsafe preview path during discovery', () => {
    assert.throws(
      () => discoverThemePackages([entry('midnight', rawManifest({ preview: '../secret.png' }))]),
      (error: unknown) => error instanceof ThemePackageError && error.code === 'invalid_path',
    );
  });

  it('yields an empty frozen result for an empty listing', () => {
    const packages = discoverThemePackages([]);
    assert.equal(packages.length, 0);
    assert.ok(Object.isFrozen(packages));
  });

  it('rejects a non-array entries argument', () => {
    assert.throws(
      () => discoverThemePackages(null as never),
      (error: unknown) => error instanceof ThemePackageError && error.code === 'invalid_input',
    );
  });

  it('rejects a malformed entry', () => {
    assert.throws(
      () => discoverThemePackages([null as never]),
      (error: unknown) => error instanceof ThemePackageError && error.code === 'invalid_input',
    );
  });

  it('rejects a path escape on an entry path', () => {
    assert.throws(
      () => discoverThemePackages([entry('midnight', rawManifest(), '../outside')]),
      (error: unknown) => error instanceof ThemePackageError && error.code === 'invalid_path',
    );
  });

  it('rejects an absolute entry path', () => {
    assert.throws(
      () => discoverThemePackages([entry('midnight', rawManifest(), '/abs')]),
      (error: unknown) => error instanceof ThemePackageError && error.code === 'invalid_path',
    );
  });

  it('rejects a malformed manifest', () => {
    assert.throws(
      () => discoverThemePackages([entry('midnight', { name: 'midnight' })]),
      (error: unknown) => error instanceof ThemePackageError && error.code === 'invalid_manifest',
    );
  });

  it('rejects duplicate names', () => {
    assert.throws(
      () =>
        discoverThemePackages([
          entry('a', rawManifest({ name: 'dup' })),
          entry('b', rawManifest({ name: 'dup' })),
        ]),
      (error: unknown) => error instanceof ThemePackageError && error.code === 'duplicate_name',
    );
  });

  it('accepts any semver when no supportedRange is given', () => {
    const packages = discoverThemePackages([
      entry('old', rawManifest({ name: 'old', version: '0.1.0' })),
    ]);
    assert.equal(packages[0]!.version, '0.1.0');
  });

  it('rejects a version outside the supported range', () => {
    assert.throws(
      () =>
        discoverThemePackages([entry('old', rawManifest({ name: 'old', version: '0.1.0' }))], {
          supportedRange: '>=1.0.0',
        }),
      (error: unknown) =>
        error instanceof ThemePackageError && error.code === 'unsupported_version',
    );
  });

  it('accepts a version inside the supported range', () => {
    const packages = discoverThemePackages(
      [entry('old', rawManifest({ name: 'old', version: '1.5.0' }))],
      { supportedRange: '>=1.0.0' },
    );
    assert.equal(packages[0]!.name, 'old');
  });
});
