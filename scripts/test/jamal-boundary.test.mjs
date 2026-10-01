/**
 * Jamal is a dependency of the app, never of the framework: core
 * declares no `@jsails/jamal` dependency, exports no `deploy` or `jamal`
 * subpath, and no core source (nor, after a build, any shipped `dist/src`
 * module) imports the package. `jsails jamal ...` reaches it only by resolving
 * the project's install at run time (`core/src/cli/jamal-forward.ts`), which
 * is a string, not an import.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

import { readManifest, repoRoot } from '../workspaces.mjs';

const core = join(repoRoot, 'core');
const JAMAL = '@jsails/jamal';
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/** Every file under `dir` whose name matches `pattern`. */
function filesUnder(dir, pattern) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** The module specifiers a source file imports, re-exports, or loads. */
function specifiers(text) {
  const found = [];
  const forms = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const form of forms) {
    for (const match of text.matchAll(form)) found.push(match[1]);
  }
  return found;
}

/** Files among `files` that import the jamal package or one of its subpaths. */
function importersOfJamal(files) {
  return files
    .filter((file) =>
      specifiers(readFileSync(file, 'utf8')).some(
        (specifier) => specifier === JAMAL || specifier.startsWith(`${JAMAL}/`),
      ),
    )
    .map((file) => relative(repoRoot, file));
}

describe('core and @jsails/jamal', () => {
  it('the specifier scan sees every import form', () => {
    assert.deepEqual(
      specifiers(
        [
          "import { a } from '@jsails/jamal';",
          'export * from "@jsails/jamal/x";',
          "import '@jsails/jamal';",
          "await import('@jsails/jamal');",
          "require('@jsails/jamal');",
          "const name = '@jsails/jamal';",
        ].join('\n'),
      ),
      ['@jsails/jamal', '@jsails/jamal/x', '@jsails/jamal', '@jsails/jamal', '@jsails/jamal'],
    );
  });

  it('core declares no dependency on the jamal package', () => {
    const manifest = readManifest(core);
    for (const field of DEPENDENCY_FIELDS) {
      assert.equal(manifest[field]?.[JAMAL], undefined, `${field} declares ${JAMAL}`);
    }
  });

  it('core exports no deploy or jamal subpath', () => {
    const subpaths = Object.keys(readManifest(core).exports);
    for (const removed of ['./deploy', './jamal']) {
      assert.ok(!subpaths.includes(removed), `core exports ${removed}`);
    }
  });

  it('no core source imports the jamal package', () => {
    const sources = filesUnder(join(core, 'src'), /\.tsx?$/);
    assert.ok(sources.length > 0);
    assert.deepEqual(importersOfJamal(sources), []);
  });

  it('no shipped core module imports the jamal package', (t) => {
    const shipped = filesUnder(join(core, 'dist', 'src'), /\.(?:js|d\.ts)$/);
    if (shipped.length === 0) {
      t.skip('core is not built');
      return;
    }
    assert.deepEqual(importersOfJamal(shipped), []);
  });

  it('the jamal package imports only public jsails subpaths', () => {
    const sources = filesUnder(join(repoRoot, 'packages', 'jamal', 'src'), /\.ts$/);
    assert.ok(sources.length > 0);
    const exported = new Set(Object.keys(readManifest(core).exports));
    const outside = sources.flatMap((file) =>
      specifiers(readFileSync(file, 'utf8'))
        .filter((specifier) => specifier === 'jsails' || specifier.startsWith('jsails/'))
        .filter((specifier) => !exported.has(`.${specifier.slice('jsails'.length)}`))
        .map((specifier) => `${relative(repoRoot, file)}: ${specifier}`),
    );
    assert.deepEqual(outside, []);
    assert.equal(readManifest(join(repoRoot, 'packages', 'jamal')).jsails, undefined);
  });
});
