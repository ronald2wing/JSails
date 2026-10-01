/**
 * Owner decision 4 holds inside `@jsails/database`: TypeORM is imported only
 * under `src/engine/`, and nothing the engine exports names a TypeORM type.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// The compiled test runs from dist/test/engine; the sources sit beside dist.
const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SOURCE = join(PACKAGE_ROOT, 'src');
const DECLARATIONS = join(PACKAGE_ROOT, 'dist', 'src');
const TYPEORM_IMPORT =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"]typeorm(?:\/[^'"]*)?['"]/;

function files(root: string, extension: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => join(entry.parentPath, entry.name));
}

function importsTypeorm(file: string): boolean {
  return TYPEORM_IMPORT.test(readFileSync(file, 'utf8'));
}

describe('TypeORM confinement', () => {
  it('imports typeorm only under src/engine', () => {
    const offenders = files(SOURCE, '.ts')
      .filter(importsTypeorm)
      .map((file) => relative(SOURCE, file))
      .filter((path) => !path.startsWith(`engine${sep}`));
    assert.deepEqual(offenders, []);
  });

  it('finds the engine files that do import it, so the scan is live', () => {
    const engineFiles = files(join(SOURCE, 'engine'), '.ts').filter(importsTypeorm);
    assert.ok(engineFiles.length >= 2);
  });

  it('exposes no TypeORM type in the shipped declarations outside the engine internals', () => {
    const exported = files(DECLARATIONS, '.d.ts')
      .filter(importsTypeorm)
      .map((file) => relative(DECLARATIONS, file));
    // The two engine modules type their private TypeORM handles; neither is
    // reachable from a public type (the barrel re-exports no TypeORM name).
    for (const path of exported) {
      assert.match(
        path,
        /^engine[\\/](?:server[\\/]server-engine|sqlite[\\/]sqlite-engine)\.d\.ts$/,
      );
    }
    const barrel = readFileSync(join(DECLARATIONS, 'engine', 'index.d.ts'), 'utf8');
    assert.doesNotMatch(barrel, /typeorm/);
  });
});
