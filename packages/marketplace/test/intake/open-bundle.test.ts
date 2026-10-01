import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { ArchiveErrors } from '../../src/archive/index.js';
import { DIGEST_PATTERN, IntakeErrors, openBundle, sha256Hex } from '../../src/intake/index.js';
import { tarGz, type TarEntry } from '../archive/tar-builder.js';

const MANIFEST = {
  manifestVersion: 1,
  id: 'acme-notes',
  version: '1.0.0',
  name: 'Notes',
  summary: 'Notes for the admin.',
  publisher: 'acme',
  jsailsCompat: '^1.0.0',
  apiTier: 'stable',
  entry: './index.js',
  marketplace: true,
};

const manifest = (overrides: Readonly<Record<string, unknown>> = {}): string =>
  JSON.stringify({ ...MANIFEST, ...overrides });

const ENTRY: TarEntry = { name: 'index.js', content: 'export default {};\n' };

function intakeCode(entries: readonly TarEntry[], code: string): void {
  assert.throws(
    () => openBundle(tarGz(entries)),
    (error: unknown) => IntakeErrors.is(error) && error.code === `bundle_intake.${code}`,
  );
}

describe('openBundle', () => {
  it('opens a bundle at the archive root and digests the bytes and the manifest', () => {
    const text = manifest();
    const bytes = tarGz([{ name: 'manifest.json', content: text }, ENTRY]);
    const bundle = openBundle(bytes);
    assert.equal(bundle.manifest.id, 'acme-notes');
    assert.equal(bundle.digest, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(bundle.size, bytes.byteLength);
    assert.equal(bundle.manifestDigest, sha256Hex(new TextEncoder().encode(text)));
    assert.match(bundle.digest, DIGEST_PATTERN);
    assert.deepEqual([...bundle.files.keys()], ['manifest.json', 'index.js']);
    assert.ok(Object.isFrozen(bundle));
  });

  it('strips one shared top-level directory and nothing deeper', () => {
    const bundle = openBundle(
      tarGz([
        { name: 'package/manifest.json', content: manifest() },
        { name: 'package/index.js', content: 'x' },
        { name: 'package/lib/a.js', content: 'a' },
      ]),
    );
    assert.deepEqual([...bundle.files.keys()], ['manifest.json', 'index.js', 'lib/a.js']);
  });

  it('does not strip when the files do not share one top-level directory', () => {
    intakeCode(
      [
        { name: 'package/manifest.json', content: manifest() },
        { name: 'other/index.js', content: 'x' },
      ],
      'manifest_missing',
    );
  });

  it('strips at most one directory', () => {
    intakeCode(
      [
        { name: 'a/b/manifest.json', content: manifest() },
        { name: 'a/b/index.js', content: 'x' },
      ],
      'manifest_missing',
    );
  });

  it('refuses a bundle without a manifest, or with an empty archive', () => {
    intakeCode([ENTRY], 'manifest_missing');
    intakeCode([], 'manifest_missing');
  });

  it('refuses a manifest whose name differs in case', () => {
    intakeCode([{ name: 'Manifest.json', content: manifest() }, ENTRY], 'manifest_missing');
  });

  it('refuses a nested manifest beside the root one, whatever its case', () => {
    for (const nested of ['lib/manifest.json', 'lib/deep/MANIFEST.JSON']) {
      intakeCode(
        [
          { name: 'manifest.json', content: manifest() },
          ENTRY,
          { name: nested, content: manifest() },
        ],
        'multiple_manifests',
      );
    }
  });

  it('refuses a manifest that is not UTF-8 JSON of at most 256 KiB', () => {
    for (const content of [
      'not json',
      new Uint8Array([0x7b, 0xff, 0x7d]),
      `\ufeff${manifest()}`,
      JSON.stringify({ ...MANIFEST, summary: 'x', pad: ' '.repeat(256 * 1024) }),
    ]) {
      intakeCode([{ name: 'manifest.json', content }, ENTRY], 'manifest_unreadable');
    }
  });

  it('refuses an invalid bundle manifest, carrying value-free issues', () => {
    const secret = 'SECRET-VALUE-123';
    const bytes = tarGz([
      { name: 'manifest.json', content: manifest({ permissions: [secret], env: [] }) },
      ENTRY,
    ]);
    assert.throws(
      () => openBundle(bytes),
      (error: unknown) => {
        if (!IntakeErrors.is(error, 'manifest_invalid')) return false;
        const issues = error.payload.issues;
        assert.ok(issues.some((issue) => issue.code === 'npm_only_field'));
        assert.ok(issues.length >= 2);
        assert.ok(!JSON.stringify({ message: error.message, issues }).includes(secret));
        return true;
      },
    );
  });

  it('refuses a bundle whose entry module or schema file is missing', () => {
    intakeCode([{ name: 'manifest.json', content: manifest() }], 'missing_file');
    intakeCode(
      [
        {
          name: 'manifest.json',
          content: manifest({
            permissions: ['data.own'],
            schema: { tablePrefix: 'acme_notes', file: './schema.json' },
          }),
        },
        ENTRY,
      ],
      'missing_file',
    );
    const bundle = openBundle(
      tarGz([
        {
          name: 'manifest.json',
          content: manifest({
            permissions: ['data.own'],
            schema: { tablePrefix: 'acme_notes', file: 'schema.json' },
          }),
        },
        ENTRY,
        { name: 'schema.json', content: '{}' },
      ]),
    );
    assert.ok(bundle.files.has('schema.json'));
  });

  it('passes archive refusals through unchanged and honours tighter limits', () => {
    assert.throws(
      () =>
        openBundle(
          tarGz([{ name: 'manifest.json', content: manifest() }, ENTRY, { name: 'a', type: '2' }]),
        ),
      (error: unknown) => ArchiveErrors.is(error, 'symlink_entry'),
    );
    assert.throws(
      () =>
        openBundle(tarGz([{ name: 'manifest.json', content: manifest() }, ENTRY]), {
          limits: { maxEntries: 1 },
        }),
      (error: unknown) => ArchiveErrors.is(error, 'too_many_entries'),
    );
  });

  it('never echoes a path in an archive refusal', () => {
    const secret = 'SECRET-PATH-TOKEN';
    assert.throws(
      () => openBundle(tarGz([{ name: `${secret}/../x.js`, content: 'x' }])),
      (error: unknown) => ArchiveErrors.is(error, 'unsafe_path') && !error.message.includes(secret),
    );
  });
});
