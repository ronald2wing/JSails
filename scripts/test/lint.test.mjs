/**
 * Tests for `scripts/lint.mjs`: the typed-input fingerprint that keys the lint
 * cache covers every file a type-aware verdict can read (another workspace's
 * declarations, a sibling module's source in the same workspace, compiler
 * settings, the lockfile) and nothing else, and a changed fingerprint clears
 * the cache.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { inputFingerprint, prepareCache, typedLintInputs } from '../lint.mjs';

const dir = mkdtempSync(join(tmpdir(), 'jsails-lint-cache-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const core = join(dir, 'core');
const pkg = join(dir, 'packages', 'a');
const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
write(join(core, 'src', 'index.ts'), "export { b } from './nested/b.js';\n");
write(join(core, 'src', 'nested', 'b.ts'), 'export function b(): void {}\n');
write(join(core, 'test', 'b.test.ts'), "import { b } from '../src/nested/b.js';\nb();\n");
write(join(core, 'dist', 'src', 'index.d.ts'), 'export declare const a: number;\n');
write(join(core, 'dist', 'src', 'index.js'), 'export const a = 1;\n');
write(join(core, 'tsconfig.json'), '{}\n');
write(join(pkg, 'dist', 'src', 'index.d.ts'), 'export {};\n');
write(join(pkg, 'README.md'), 'Docs.\n');
write(join(dir, 'website', 'pages', 'index.tsx'), 'export default 1;\n');
write(join(dir, 'website', 'content', 'docs', 'a.md'), 'Docs.\n');
write(join(dir, 'tsconfig.base.json'), '{}\n');
write(join(dir, 'package-lock.json'), '{}\n');

const fingerprint = () =>
  inputFingerprint(typedLintInputs({ root: dir, workspaces: [core, pkg] }), dir);

describe('typed-input fingerprint', () => {
  it('ignores JavaScript output, docs, and other untyped files', () => {
    const first = fingerprint();
    write(join(core, 'dist', 'src', 'index.js'), 'export const a = 2;\n');
    write(join(pkg, 'README.md'), 'Other docs.\n');
    write(join(dir, 'website', 'content', 'docs', 'a.md'), 'Other docs.\n');
    assert.equal(fingerprint(), first);
  });

  it('changes when a sibling source in the same workspace changes, without a build', () => {
    // An importer (index.ts, b.test.ts) keeps its own content, so ESLint's
    // per-file cache alone would keep its verdict on the old types.
    const before = fingerprint();
    write(join(core, 'src', 'nested', 'b.ts'), 'export async function b(): Promise<void> {}\n');
    assert.notEqual(fingerprint(), before);
  });

  it('changes when a dependency declaration changes, appears, or is renamed', () => {
    const before = fingerprint();
    write(join(core, 'dist', 'src', 'index.d.ts'), 'export declare const a: string;\n');
    const changed = fingerprint();
    assert.notEqual(changed, before);
    write(join(pkg, 'dist', 'src', 'extra.d.ts'), 'export {};\n');
    const added = fingerprint();
    assert.notEqual(added, changed);
    rmSync(join(pkg, 'dist', 'src', 'extra.d.ts'));
    write(join(pkg, 'dist', 'src', 'renamed.d.ts'), 'export {};\n');
    assert.notEqual(fingerprint(), added);
  });

  it('changes with compiler settings, the lockfile, and the docs site sources', () => {
    for (const file of [
      join(dir, 'tsconfig.base.json'),
      join(core, 'tsconfig.json'),
      join(dir, 'package-lock.json'),
      join(dir, 'website', 'pages', 'index.tsx'),
    ]) {
      const before = fingerprint();
      write(file, `${JSON.stringify({ changed: file })}\n`);
      assert.notEqual(fingerprint(), before, file);
    }
  });
});

describe('prepareCache', () => {
  const cacheFile = join(dir, '.eslintcache');
  const stampFile = join(dir, 'cache', 'stamp');

  it('clears the cache when the typed inputs changed and keeps it otherwise', () => {
    writeFileSync(cacheFile, '{}');
    assert.equal(prepareCache({ fingerprint: 'one', cacheFile, stampFile }), false);
    assert.equal(existsSync(cacheFile), false, 'first run without a stamp clears');

    writeFileSync(cacheFile, '{}');
    assert.equal(prepareCache({ fingerprint: 'one', cacheFile, stampFile }), true);
    assert.equal(existsSync(cacheFile), true);

    assert.equal(prepareCache({ fingerprint: 'two', cacheFile, stampFile }), false);
    assert.equal(existsSync(cacheFile), false, 'a changed typed input clears the cache');
  });
});
