/**
 * Tests for the release digests behind the first-party catalog: reading the
 * digest file the release script writes (missing and malformed files yield no
 * digests), attaching each digest to its entry by package name and version, and
 * keeping the catalog version equal to each package's own manifest version, which
 * is the version the release script keys every digest by.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createFirstPartyPluginDirectory,
  firstPartyPluginDirectory,
  readFirstPartyDigests,
} from '../../src/directory/first-party-catalog.js';

const DIGEST = 'b'.repeat(64);

const root = mkdtempSync(join(tmpdir(), 'jsails-first-party-digests-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** Write `content` to a fresh file under the temp root and return its URL. */
function digestFile(name: string, content: string): URL {
  const path = join(root, name);
  writeFileSync(path, content);
  return pathToFileURL(path);
}

describe('readFirstPartyDigests', () => {
  it('reads the release map and keeps only SHA-256 digests', () => {
    const file = digestFile(
      'mixed.json',
      JSON.stringify({
        '@jsails/auth@1.0.0': DIGEST,
        '@jsails/blog@1.0.0': 'not-a-digest',
        '@jsails/cache@1.0.0': 'B'.repeat(64),
        '@jsails/mail@1.0.0': 42,
      }),
    );
    assert.deepEqual([...readFirstPartyDigests(file)], [['@jsails/auth@1.0.0', DIGEST]]);
  });

  it('yields no digests when the file is missing, malformed, or not an object', () => {
    assert.equal(readFirstPartyDigests(pathToFileURL(join(root, 'absent.json'))).size, 0);
    assert.equal(readFirstPartyDigests(digestFile('broken.json', '{"@jsails/auth@1')).size, 0);
    assert.equal(readFirstPartyDigests(digestFile('array.json', `["${DIGEST}"]`)).size, 0);
    assert.equal(readFirstPartyDigests(digestFile('null.json', 'null')).size, 0);
  });

  it('keeps a __proto__ key as plain data', () => {
    const digests = readFirstPartyDigests(
      digestFile('proto.json', `{"__proto__": "${DIGEST}", "@jsails/auth@1.0.0": "${DIGEST}"}`),
    );
    assert.equal(digests.get('@jsails/auth@1.0.0'), DIGEST);
    assert.equal(digests.get('__proto__'), DIGEST);
    assert.equal(Object.getPrototypeOf(digests), Map.prototype);
  });
});

describe('createFirstPartyPluginDirectory', () => {
  it('attaches each digest to the entry whose package and version it names', () => {
    const directory = createFirstPartyPluginDirectory(
      new Map([
        ['@jsails/auth@1.0.0', DIGEST],
        ['@jsails/blog@0.9.0', 'c'.repeat(64)],
      ]),
    );
    assert.equal(directory.get('auth')?.sha256, DIGEST);
    assert.equal(directory.get('blog')?.sha256, undefined);
    assert.equal(directory.get('cache')?.sha256, undefined);
  });

  it('builds entries without digests when none were recorded', () => {
    const directory = createFirstPartyPluginDirectory(new Map());
    assert.ok(directory.entries.length >= 10);
    assert.ok(directory.entries.every((entry) => entry.sha256 === undefined));
  });
});

/** `packages/`, from this compiled test at `packages/<name>/dist/test/directory/`. */
const PACKAGES_DIR = fileURLToPath(new URL('../../../../', import.meta.url));

/** The `version` field of `packages/<name>/package.json`. */
function manifestVersion(name: string): unknown {
  const manifest: unknown = JSON.parse(
    readFileSync(join(PACKAGES_DIR, name, 'package.json'), 'utf8'),
  );
  return typeof manifest === 'object' && manifest !== null && 'version' in manifest
    ? manifest.version
    : undefined;
}

describe('firstPartyPluginDirectory versions', () => {
  // The release keys each digest by the workspace's manifest version, so a
  // catalog version that drifts from it silently drops every digest.
  it('targets the version in this package manifest', () => {
    const versions = new Set(firstPartyPluginDirectory.entries.map((entry) => entry.latestVersion));
    assert.deepEqual([...versions], [manifestVersion('admin-plugin-manager')]);
  });

  it('targets the manifest version of every listed package', () => {
    for (const entry of firstPartyPluginDirectory.entries) {
      assert.equal(entry.latestVersion, manifestVersion(entry.id), entry.id);
      assert.equal(
        entry.specifier,
        `https://registry.npmjs.org/@jsails/${entry.id}/-/${entry.id}-${entry.latestVersion}.tgz`,
        entry.id,
      );
    }
  });
});
