/**
 * Every first-party package that describes itself to the framework (a `jsails`
 * field in its `package.json`) ships a v1 manifest the framework accepts:
 * published by `jsails`, named after its package, pinned to the package
 * version, compatible with the framework at this checkout, and pointing only
 * at modules the package exports. A package without the field is a library or
 * a code-only plugin; the set is derived from the manifests themselves, not
 * from a hand-maintained list. The `plugin-manifests` gate checks the same
 * manifests against each plugin's runtime declaration.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parsePackageManifest, satisfiesRange } from '../../src/plugins/manifest/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const packagesRoot = join(repoRoot, 'packages');

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** The public specifiers a package provides, derived from its `exports` map. */
function providedSpecifiers(pkg: Record<string, unknown>): string[] {
  const name = pkg['name'];
  const exports = pkg['exports'];
  assert.equal(typeof name, 'string');
  assert.ok(exports !== null && typeof exports === 'object' && !Array.isArray(exports));
  return Object.keys(exports as Record<string, unknown>)
    .filter((key) => key !== './package.json')
    .map((key) => (key === '.' ? (name as string) : `${name as string}${key.slice(1)}`))
    .sort();
}

describe('first-party plugin manifests', () => {
  const frameworkVersion = readJson(join(repoRoot, 'core', 'package.json'))['version'];
  assert.equal(typeof frameworkVersion, 'string');

  const manifests = readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join(packagesRoot, entry.name, 'package.json')))
    .map((entry) => ({
      dir: entry.name,
      pkg: readJson(join(packagesRoot, entry.name, 'package.json')),
    }))
    .filter(({ pkg }) => pkg['jsails'] !== undefined)
    .sort((a, b) => a.dir.localeCompare(b.dir));

  it('at least one package describes itself to the framework', () => {
    assert.ok(manifests.length > 0);
  });

  for (const { dir, pkg } of manifests) {
    it(`${dir} ships a valid v1 manifest`, () => {
      const manifest = parsePackageManifest(pkg['jsails']);
      const provided = providedSpecifiers(pkg);
      const packageName = pkg['name'] as string;

      assert.equal(packageName, `@jsails/${dir}`, 'a first-party plugin is @jsails/<directory>');
      assert.equal(manifest.id, `jsails-${dir}`, 'the id follows @jsails/<name> -> jsails-<name>');
      assert.equal(manifest.publisher, 'jsails');
      assert.equal(manifest.version, pkg['version'], 'manifest version differs from package');
      assert.equal(
        satisfiesRange(frameworkVersion as string, manifest.jsailsCompat),
        true,
        `jsailsCompat ${manifest.jsailsCompat} does not include framework ${String(frameworkVersion)}`,
      );
      assert.ok(
        provided.includes(manifest.entry),
        `entry ${manifest.entry} is not a package export`,
      );
      if (manifest.autoload?.mode === 'selected') {
        for (const specifier of manifest.autoload.specifiers ?? []) {
          assert.ok(provided.includes(specifier), `autoload ${specifier} is not a package export`);
        }
      }
      for (const tool of [...(manifest.commands ?? []), ...(manifest.generators ?? [])]) {
        assert.ok(provided.includes(tool.module), `${tool.name} module is not a package export`);
      }
      if (manifest.schema?.file !== undefined) {
        assert.ok(
          existsSync(join(packagesRoot, dir, manifest.schema.file)),
          'schema file is missing',
        );
      }
    });
  }
});
