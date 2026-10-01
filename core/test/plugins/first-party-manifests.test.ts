import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PLUGIN_DECLARATION_FILENAME,
  parsePluginDeclaration,
} from '../../src/plugins/declaration.js';
import { parsePluginManifest, satisfiesRange } from '../../src/plugins/manifest/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const pluginsRoot = join(repoRoot, 'plugins');

/**
 * Packages under `plugins/*` that are libraries, not plugins: they export no
 * `src/plugin.ts` factory and therefore carry no declaration or manifest.
 */
const NON_PLUGIN_PACKAGES = new Set(['ai', 'content', 'editor', 'inertia', 'media', 'sessions']);

/**
 * Plugin packages deliberately left without a manifest while they are being
 * restructured. Remove an entry here once the package is stable.
 */
const SKIPPED_PACKAGES = new Set(['cache']);

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

  const packageDirs = readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const dir of packageDirs) {
    if (NON_PLUGIN_PACKAGES.has(dir)) {
      it(`${dir} is a library, not a plugin`, () => {
        assert.equal(
          existsSync(join(pluginsRoot, dir, 'src', 'plugin.ts')),
          false,
          `${dir} exports a plugin factory; move it out of NON_PLUGIN_PACKAGES`,
        );
      });
      continue;
    }

    if (SKIPPED_PACKAGES.has(dir)) {
      it(`${dir} is skipped while it is restructured`, () => {
        assert.equal(
          existsSync(join(pluginsRoot, dir, 'src', 'plugin.ts')),
          true,
          `${dir} no longer exports a plugin factory; remove it from SKIPPED_PACKAGES`,
        );
      });
      continue;
    }

    it(`${dir} ships a valid declaration and manifest`, () => {
      const packageDir = join(pluginsRoot, dir);
      const pkg = readJson(join(packageDir, 'package.json'));

      const declaration = parsePluginDeclaration(
        readJson(join(packageDir, PLUGIN_DECLARATION_FILENAME)),
      );
      const manifest = parsePluginManifest(pkg['jsails']);

      assert.equal(declaration.id, manifest.id, 'declaration and manifest ids differ');
      assert.equal(manifest.version, pkg['version'], 'manifest version differs from package');
      assert.equal(
        satisfiesRange(frameworkVersion as string, manifest.jsailsCompat),
        true,
        `jsailsCompat ${String(manifest.jsailsCompat)} does not include framework ${String(frameworkVersion)}`,
      );
      assert.deepEqual(
        [...declaration.provides].sort(),
        providedSpecifiers(pkg),
        'declaration provides does not match package exports',
      );
      assert.ok(manifest.entry.length > 0, 'manifest entry is empty');
      assert.ok(Array.isArray(manifest.permissions), 'manifest permissions is not an array');
    });
  }
});
