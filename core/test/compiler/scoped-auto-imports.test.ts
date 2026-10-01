import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  ScopedAutoImportError,
  assertNoOutOfScopeAutoImports,
  generateScopedAutoImportsDts,
  injectScopedAutoImports,
  injectScopedAutoImportsInDirectory,
} from '../../src/compiler/scoped-auto-imports.js';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'jsails-scoped-imports-'));
}

describe('scoped auto-imports', () => {
  it('injects hooks into a ui module and leaves a client module scoped too', () => {
    const root = makeRoot();
    try {
      const file = join(root, 'ui', 'counter.tsx');
      const result = injectScopedAutoImports(
        `const count = useSignal(0);\nconst [open, setOpen] = useState(false);\n`,
        { fileName: file, rootDir: root },
      );
      assert.ok(result);
      assert.match(result.code, /import \{ useSignal \} from '@preact\/signals';/);
      assert.match(result.code, /import \{ useState \} from 'preact\/hooks';/);
      assert.equal(result.injected.length, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not inject into a page outside the scope', () => {
    const root = makeRoot();
    try {
      const result = injectScopedAutoImports(`const [open] = useState(false);\n`, {
        fileName: join(root, 'pages', 'index.tsx'),
        rootDir: root,
      });
      assert.equal(result, null);
      assert.throws(
        () =>
          assertNoOutOfScopeAutoImports(`const [open] = useState(false);\n`, {
            fileName: join(root, 'pages', 'index.tsx'),
            rootDir: root,
          }),
        (error) => error instanceof ScopedAutoImportError && error.code === 'out_of_scope',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is idempotent when the import already exists', () => {
    const root = makeRoot();
    try {
      const code = `import { useState } from 'preact/hooks';\nconst [open] = useState(false);\n`;
      const result = injectScopedAutoImports(code, {
        fileName: join(root, 'ui', 'counter.tsx'),
        rootDir: root,
      });
      assert.equal(result, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('appends server imports before the source map marker', () => {
    const root = makeRoot();
    try {
      const code = `const [open] = useState(false);\n//# sourceMappingURL=x.js.map\n`;
      const result = injectScopedAutoImports(code, {
        fileName: join(root, 'ui', 'counter.js'),
        rootDir: root,
        placement: 'append',
      });
      assert.ok(result);
      assert.ok(
        result.code.indexOf('import { useState }') < result.code.indexOf('sourceMappingURL'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('injects a compiled tree and rejects scoped names outside it', () => {
    const root = makeRoot();
    try {
      mkdirSync(join(root, 'ui'), { recursive: true });
      mkdirSync(join(root, 'pages'), { recursive: true });
      writeFileSync(join(root, 'ui', 'counter.js'), 'const [open] = useState(false);\n');
      writeFileSync(join(root, 'pages', 'index.js'), 'const [open] = useState(false);\n');

      assert.throws(
        () => injectScopedAutoImportsInDirectory(root),
        (error) => error instanceof ScopedAutoImportError && error.code === 'out_of_scope',
      );

      rmSync(join(root, 'pages', 'index.js'));
      const result = injectScopedAutoImportsInDirectory(root);
      assert.equal(result.files, 1);
      assert.match(readFileSync(join(root, 'ui', 'counter.js'), 'utf8'), /from 'preact\/hooks'/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits a global declaration file', () => {
    const dts = generateScopedAutoImportsDts();
    assert.match(dts, /declare global \{/);
    assert.match(dts, /const useState: typeof import\('preact\/hooks'\)\.useState;/);
    assert.match(dts, /const useSignal: typeof import\('@preact\/signals'\)\.useSignal;/);
  });
});
