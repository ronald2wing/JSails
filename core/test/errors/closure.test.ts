/**
 * Tests for the `jsails/errors` boundary: the subpath's static and dynamic
 * import closure stays inside the error kernel's browser-safe modules, so a
 * package that raises or recognizes framework errors loads nothing else of
 * the framework, no third-party package and no `node:` builtin.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const coreRoot = fileURLToPath(new URL('../../..', import.meta.url));
const errorsDir = resolve(coreRoot, 'src/errors');

/**
 * Every specifier the module graph from `entry` imports, statically or
 * through `import()`, followed through relative imports. Read from source, so
 * the check does not trust the framework's own import scanner.
 */
function closure(
  entry: string,
  seen = new Map<string, readonly string[]>(),
): Map<string, readonly string[]> {
  if (seen.has(entry)) return seen;
  const source = readFileSync(entry, 'utf8');
  const specifiers = [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)].flatMap(
    (match) => (match[1] === undefined ? [] : [match[1]]),
  );
  seen.set(entry, specifiers);
  for (const specifier of specifiers) {
    if (!specifier.startsWith('.')) continue;
    closure(resolve(dirname(entry), specifier).replace(/\.js$/, '.ts'), seen);
  }
  return seen;
}

describe('jsails/errors closure', () => {
  const graph = closure(resolve(errorsDir, 'index.ts'));

  it('imports only relative modules', () => {
    const external = [...graph.values()].flat().filter((specifier) => !specifier.startsWith('.'));
    assert.deepEqual(external, []);
  });

  it('stays inside the error kernel and leaves its server half out', () => {
    const files = [...graph.keys()].map((file) => relative(errorsDir, file).split('\\').join('/'));
    assert.deepEqual(
      files.filter((file) => file.startsWith('..') || file.includes('/')),
      [],
    );
    assert.deepEqual(
      files.filter((file) => file.endsWith('.server.ts')),
      [],
    );
  });
});
