/**
 * Tests for `scripts/gates/isolated-declarations.mjs`: the temporary tsconfig
 * it compiles each workspace with, diagnostic parsing, and a real compile of a
 * fixture workspace whose `src/` breaks the rule while its `test/` (outside the
 * check) does too.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  checkWorkspace,
  isolatedConfig,
  parseDiagnostics,
  run,
} from '../gates/isolated-declarations.mjs';
import { repoRoot } from '../workspaces.mjs';

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A one-workspace repo whose tsconfig extends this repository's base config. */
function fixture(source) {
  const root = mkdtempSync(join(tmpdir(), 'jsails-isolated-'));
  roots.push(root);
  write(root, {
    'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    'packages/one/package.json': JSON.stringify({ name: 'one', type: 'module' }),
    'packages/one/tsconfig.json': JSON.stringify({
      extends: join(repoRoot, 'tsconfig.base.json').split('\\').join('/'),
    }),
    'packages/one/src/index.ts': source,
    // Tests are outside the check even when they break the rule.
    'packages/one/test/fixture.ts': 'export const made = [1].map((n) => ({ n }));\n',
  });
  return root;
}

describe('isolatedConfig', () => {
  it('narrows the program to src/ and restates the path options', () => {
    const config = isolatedConfig('/repo/packages/one', '/repo');
    assert.equal(config.extends, '/repo/packages/one/tsconfig.json');
    assert.deepEqual(config.include, [
      '/repo/packages/one/src/**/*.ts',
      '/repo/packages/one/src/**/*.tsx',
    ]);
    assert.equal(config.compilerOptions.isolatedDeclarations, true);
    assert.equal(config.compilerOptions.noEmit, true);
    assert.equal(config.compilerOptions.incremental, false);
    assert.equal(config.compilerOptions.rootDir, '/repo/packages/one');
    assert.deepEqual(config.compilerOptions.typeRoots.slice(0, 2), [
      '/repo/packages/one/node_modules/@types',
      '/repo/node_modules/@types',
    ]);
  });
});

describe('parseDiagnostics', () => {
  it('reads located errors relative to the repo and keeps unlocated ones', () => {
    const output = [
      'packages/one/src/a.ts(3,14): error TS9010: Variable must have an explicit type annotation with --isolatedDeclarations.',
      '  continuation text',
      "error TS5083: Cannot read file '/x/tsconfig.json'.",
      'Found 2 errors.',
    ].join('\n');
    assert.deepEqual(parseDiagnostics(output, '/repo', '/repo'), [
      {
        file: 'packages/one/src/a.ts',
        line: 3,
        column: 14,
        code: 'TS9010',
        message: 'Variable must have an explicit type annotation with --isolatedDeclarations.',
      },
      {
        file: null,
        line: 0,
        column: 0,
        code: 'TS5083',
        message: "error TS5083: Cannot read file '/x/tsconfig.json'.",
      },
    ]);
  });
});

describe('checkWorkspace', () => {
  it('reports an exported declaration whose type is not written down', async () => {
    const root = fixture(
      "import { readFileSync } from 'node:fs';\nexport const lines = readFileSync('x', 'utf8').split('\\n');\n",
    );
    const { status, diagnostics } = await checkWorkspace(join(root, 'packages', 'one'), root);
    assert.notEqual(status, 0);
    assert.deepEqual(
      diagnostics.map((d) => [d.file, d.line, d.code]),
      [['packages/one/src/index.ts', 2, 'TS9010']],
    );
  });

  it('passes annotated source, leaving test/ unchecked', async () => {
    const root = fixture(
      "import { readFileSync } from 'node:fs';\nexport const lines: string[] = readFileSync('x', 'utf8').split('\\n');\n",
    );
    assert.deepEqual(await run({ repoRoot: root }), []);
  });
});
