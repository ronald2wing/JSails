import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertCompatible,
  createPluginDirectory,
  DirectoryError,
  firstPartyPluginDirectory,
  parsePluginDirectoryEntry,
} from '../../src/directory/index.js';

/** A raw directory entry with overridable fields. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'acme-tasks',
    name: 'Acme Tasks',
    description: 'Task management for teams.',
    categories: ['productivity', 'collaboration'],
    featured: false,
    latestVersion: '1.2.3',
    frameworkRange: '>=1.0.0 <2.0.0',
    summary: 'Track and share tasks.',
    screenshots: ['https://example.com/shot.png'],
    specifier: 'acme-tasks@1.2.3',
    settingsSchema: { retries: 'number' },
    ...overrides,
  };
}

describe('parsePluginDirectoryEntry', () => {
  it('parses a valid entry and freezes its arrays', () => {
    const parsed = parsePluginDirectoryEntry(entry());
    assert.equal(parsed.id, 'acme-tasks');
    assert.equal(parsed.name, 'Acme Tasks');
    assert.equal(parsed.latestVersion, '1.2.3');
    assert.deepEqual(parsed.categories, ['collaboration', 'productivity']);
    assert.equal(parsed.featured, false);
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(Object.isFrozen(parsed.categories), true);
    assert.equal(Object.isFrozen(parsed.screenshots), true);
  });

  it('rejects an unknown field value-free', () => {
    assert.throws(
      () => parsePluginDirectoryEntry(entry({ typo: true })),
      (error: unknown) => error instanceof DirectoryError && error.code === 'invalid_entry',
    );
  });

  it('rejects an invalid version and an invalid range value-free', () => {
    assert.throws(
      () => parsePluginDirectoryEntry(entry({ latestVersion: 'not-semver' })),
      (error: unknown) => error instanceof DirectoryError && error.code === 'invalid_entry',
    );
    assert.throws(
      () => parsePluginDirectoryEntry(entry({ frameworkRange: 'not-a-range' })),
      (error: unknown) => error instanceof DirectoryError && error.code === 'invalid_entry',
    );
  });

  it('never echoes raw input values in its message', () => {
    try {
      parsePluginDirectoryEntry(entry({ latestVersion: 'SECRET-VERSION' }));
      assert.fail('expected a DirectoryError');
    } catch (error) {
      assert.ok(error instanceof DirectoryError);
      assert.ok(!error.message.includes('SECRET-VERSION'), error.message);
    }
  });
});

describe('createPluginDirectory', () => {
  const directory = createPluginDirectory([
    entry(),
    entry({
      id: 'zebra-notes',
      name: 'Zebra Notes',
      description: 'A notebook for ideas.',
      summary: 'Capture thoughts.',
      categories: ['collaboration'],
      featured: true,
    }),
    entry({
      id: 'beta-board',
      name: 'Beta Board',
      description: 'A board for planning.',
      summary: 'Plan work.',
      categories: ['productivity'],
    }),
  ]);

  it('orders entries deterministically by name then id', () => {
    assert.deepEqual(
      directory.entries.map((e) => e.id),
      ['acme-tasks', 'beta-board', 'zebra-notes'],
    );
  });

  it('derives sorted categories and featured lists', () => {
    assert.deepEqual(directory.categories, ['collaboration', 'productivity']);
    assert.deepEqual(
      directory.featured.map((e) => e.id),
      ['zebra-notes'],
    );
  });

  it('looks up an entry by id or returns undefined', () => {
    assert.equal(directory.get('acme-tasks')?.name, 'Acme Tasks');
    assert.equal(directory.get('missing'), undefined);
  });

  it('searches case-insensitively across searchable text', () => {
    assert.deepEqual(
      directory.search('TASK').map((e) => e.id),
      ['acme-tasks'],
    );
    assert.deepEqual(
      directory.search('board').map((e) => e.id),
      ['beta-board'],
    );
    assert.deepEqual(
      directory.search('').map((e) => e.id),
      [],
    );
  });

  it('filters by category and by featured', () => {
    assert.deepEqual(
      directory.list({ category: 'productivity' }).map((e) => e.id),
      ['acme-tasks', 'beta-board'],
    );
    assert.deepEqual(
      directory.list({ featured: true }).map((e) => e.id),
      ['zebra-notes'],
    );
    assert.deepEqual(
      directory.list({ featured: false }).map((e) => e.id),
      ['acme-tasks', 'beta-board'],
    );
  });

  it('sorts by latest version descending', () => {
    const byVersion = createPluginDirectory([
      entry({ id: 'old', name: 'Old', latestVersion: '1.0.0' }),
      entry({ id: 'new', name: 'New', latestVersion: '2.0.0' }),
      entry({ id: 'mid', name: 'Mid', latestVersion: '1.5.0' }),
    ]);
    assert.deepEqual(
      byVersion.list({ sort: 'version' }).map((e) => e.id),
      ['new', 'mid', 'old'],
    );
  });

  it('sorts featured first', () => {
    assert.deepEqual(
      directory.list({ sort: 'featured' }).map((e) => e.id),
      ['zebra-notes', 'acme-tasks', 'beta-board'],
    );
  });

  it('rejects an unknown category value-free', () => {
    assert.throws(
      () => directory.list({ category: 'nope' }),
      (error: unknown) => error instanceof DirectoryError && error.code === 'unknown_category',
    );
  });

  it('rejects duplicate ids value-free', () => {
    assert.throws(
      () => createPluginDirectory([entry(), entry({ name: 'Acme Tasks Duplicate' })]),
      (error: unknown) => error instanceof DirectoryError && error.code === 'duplicate_id',
    );
  });

  it('is deterministic and frozen', () => {
    assert.equal(Object.isFrozen(directory), true);
    assert.equal(Object.isFrozen(directory.entries), true);
    assert.equal(Object.isFrozen(directory.featured), true);
    assert.equal(Object.isFrozen(directory.categories), true);
  });
});

describe('assertCompatible', () => {
  const parsed = parsePluginDirectoryEntry(entry());

  it('accepts a satisfying framework version', () => {
    assert.doesNotThrow(() => assertCompatible(parsed, '1.5.0'));
  });

  it('rejects an incompatible framework version', () => {
    assert.throws(
      () => assertCompatible(parsed, '2.0.0'),
      (error: unknown) => error instanceof DirectoryError && error.code === 'incompatible_version',
    );
  });

  it('rejects a malformed framework version', () => {
    assert.throws(
      () => assertCompatible(parsed, 'nope'),
      (error: unknown) => error instanceof DirectoryError && error.code === 'invalid_framework',
    );
  });
});

describe('firstPartyPluginDirectory', () => {
  it('exposes the official plugins in a stable, categorized catalog', () => {
    assert.ok(firstPartyPluginDirectory.entries.length >= 10);
    assert.equal(firstPartyPluginDirectory.get('blog')?.name, 'Blog CMS');
    assert.equal(firstPartyPluginDirectory.get('flags')?.featured, true);
    assert.ok(firstPartyPluginDirectory.categories.includes('content'));
    assert.ok(firstPartyPluginDirectory.categories.includes('infrastructure'));
    assert.ok(firstPartyPluginDirectory.featured.length > 0);
    assert.equal(Object.isFrozen(firstPartyPluginDirectory), true);
  });

  it('lists the installable editor, media, and theme plugins', () => {
    for (const id of ['editor', 'media', 'theme']) {
      const entry = firstPartyPluginDirectory.get(id);
      assert.ok(entry, `missing first-party entry "${id}"`);
      assert.equal(entry.latestVersion, '1.0.0');
      assert.equal(entry.frameworkRange, '^1.0.0');
      assert.match(
        entry.specifier,
        new RegExp(`^https://registry\\.npmjs\\.org/@jsails/${id}/-/${id}-1\\.0\\.0\\.tgz$`),
      );
    }
    assert.equal(firstPartyPluginDirectory.get('editor')?.name, 'Rich-Text Editor');
    assert.equal(firstPartyPluginDirectory.get('media')?.name, 'Media Library');
    assert.equal(firstPartyPluginDirectory.get('theme')?.name, 'Theming');
    assert.ok(firstPartyPluginDirectory.get('editor')!.categories.includes('content'));
    assert.ok(firstPartyPluginDirectory.get('media')!.categories.includes('content'));
    assert.ok(firstPartyPluginDirectory.get('theme')!.categories.includes('design'));
  });

  it('the new entries are compatible with the catalog framework version and searchable', () => {
    assert.doesNotThrow(() => assertCompatible(firstPartyPluginDirectory.get('theme')!, '1.0.0'));
    assert.throws(
      () => assertCompatible(firstPartyPluginDirectory.get('theme')!, '2.0.0'),
      (error: unknown) => error instanceof DirectoryError && error.code === 'incompatible_version',
    );
    assert.deepEqual(
      firstPartyPluginDirectory.search('theming').map((e) => e.id),
      ['theme'],
    );
  });

  it('points every entry at a registry tarball for the same version', () => {
    for (const entry of firstPartyPluginDirectory.entries) {
      assert.match(
        entry.specifier,
        /^https:\/\/registry\.npmjs\.org\/@jsails\/[a-z-]+\/-\/[a-z-]+-1\.0\.0\.tgz$/,
      );
      assert.equal(entry.latestVersion, '1.0.0');
      assert.equal(entry.frameworkRange, '^1.0.0');
    }
  });
});
