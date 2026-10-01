/**
 * Tests for the `.jsails/manifest.json` staleness record: a matching tree
 * verifies, an edited file is `stale_meta`, a missing manifest beside a present
 * artifact is `stale_meta`, and a corrupt or self-inconsistent document is
 * `invalid_manifest`.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  META_MANIFEST_FILE,
  MetaManifestError,
  buildMetaManifest,
  computeFingerprint,
  emitMetaManifest,
  parseMetaManifest,
  verifyMetaManifest,
} from '../../src/build/meta-manifest.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-meta-manifest-'));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;

/** A project tree with the given files, keyed by project-relative path. */
function project(files: Readonly<Record<string, string>>): string {
  const dir = join(root, `case-${seq++}`);
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(dir, relative);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return dir;
}

/** Write the manifest artifact for `dir`, as `build:meta` would. */
function writeManifest(dir: string): void {
  mkdirSync(join(dir, '.jsails'), { recursive: true });
  writeFileSync(join(dir, '.jsails', META_MANIFEST_FILE), emitMetaManifest(buildMetaManifest(dir)));
}

describe('meta manifest', () => {
  it('hashes only the scanned convention directories, sorted by path', () => {
    const dir = project({
      'models/user.ts': 'export class User {}',
      'components/card.tsx': 'export function Card() {}',
      'pages/index.tsx': 'export default 1',
      'README.md': 'not scanned',
      'src/other.ts': 'not scanned',
    });
    const manifest = buildMetaManifest(dir);
    assert.deepEqual(
      manifest.inputs.map((input) => input.path),
      ['components/card.tsx', 'models/user.ts', 'pages/index.tsx'],
    );
  });

  it('is deterministic: two builds of the same tree agree', () => {
    const dir = project({ 'models/a.ts': 'x', 'models/b.ts': 'y' });
    assert.equal(buildMetaManifest(dir).fingerprint, buildMetaManifest(dir).fingerprint);
  });

  it('changes the fingerprint when a scanned file changes', () => {
    const dir = project({ 'models/a.ts': 'x' });
    const before = buildMetaManifest(dir).fingerprint;
    writeFileSync(join(dir, 'models/a.ts'), 'y');
    assert.notEqual(buildMetaManifest(dir).fingerprint, before);
  });

  it('ignores a change outside the scanned directories', () => {
    const dir = project({ 'models/a.ts': 'x', 'README.md': 'one' });
    const before = buildMetaManifest(dir).fingerprint;
    writeFileSync(join(dir, 'README.md'), 'two');
    assert.equal(buildMetaManifest(dir).fingerprint, before);
  });

  it('verifies a tree that still matches', () => {
    const dir = project({ 'models/a.ts': 'x' });
    writeManifest(dir);
    assert.equal(verifyMetaManifest(dir).version, 1);
  });

  it('reports stale_meta when a scanned file changed after the build', () => {
    const dir = project({ 'models/a.ts': 'x' });
    writeManifest(dir);
    writeFileSync(join(dir, 'models/a.ts'), 'changed');
    assert.throws(
      () => verifyMetaManifest(dir),
      (error: unknown) =>
        error instanceof MetaManifestError &&
        error.code === 'stale_meta' &&
        error.suggestion === 'run "jsails build:meta" to regenerate them',
    );
  });

  it('reports stale_meta when a scanned file was added after the build', () => {
    const dir = project({ 'models/a.ts': 'x' });
    writeManifest(dir);
    writeFileSync(join(dir, 'models/b.ts'), 'new');
    assert.throws(
      () => verifyMetaManifest(dir),
      (error: unknown) => error instanceof MetaManifestError && error.code === 'stale_meta',
    );
  });

  it('reports missing_manifest when the artifact is absent', () => {
    const dir = project({ 'models/a.ts': 'x' });
    assert.throws(
      () => verifyMetaManifest(dir),
      (error: unknown) => error instanceof MetaManifestError && error.code === 'missing_manifest',
    );
  });

  it('reports invalid_manifest for malformed JSON, a wrong version, or a bad fingerprint', () => {
    const dir = project({ 'models/a.ts': 'x' });
    mkdirSync(join(dir, '.jsails'), { recursive: true });
    const path = join(dir, '.jsails', META_MANIFEST_FILE);

    writeFileSync(path, 'not json');
    assert.throws(
      () => verifyMetaManifest(dir),
      (error: unknown) => error instanceof MetaManifestError && error.code === 'invalid_manifest',
    );

    writeFileSync(path, JSON.stringify({ version: 99, fingerprint: 'x', inputs: [] }));
    assert.throws(
      () => verifyMetaManifest(dir),
      (error: unknown) => error instanceof MetaManifestError && error.code === 'invalid_manifest',
    );

    // A fingerprint that does not match the inputs it claims to describe.
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        fingerprint: 'deadbeef',
        inputs: [{ path: 'models/a.ts', sha256: 'abc' }],
      }),
    );
    assert.throws(
      () => verifyMetaManifest(dir),
      (error: unknown) => error instanceof MetaManifestError && error.code === 'invalid_manifest',
    );
  });

  it('round-trips through emit and parse', () => {
    const dir = project({ 'models/a.ts': 'x' });
    const manifest = buildMetaManifest(dir);
    assert.deepEqual(parseMetaManifest(emitMetaManifest(manifest)), manifest);
  });

  it('computes the fingerprint over sorted path and hash pairs', () => {
    const a = { path: 'b.ts', sha256: '2' };
    const b = { path: 'a.ts', sha256: '1' };
    assert.equal(computeFingerprint([a, b]), computeFingerprint([b, a]));
  });
});
