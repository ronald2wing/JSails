/**
 * Tests for `scripts/check-declared-deps.mjs`: which specifiers count as
 * imports in shipped declarations and JavaScript, and which manifests pass,
 * including the exact `jsails` pin of a workspace that imports
 * `jsails/internal`.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  INDIRECT_DEPENDENCIES,
  checkWorkspace,
  declarationSpecifiers,
  isKernelInternal,
  packageName,
  runtimeSpecifiers,
  typesPackage,
} from '../check-declared-deps.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'jsails-deps-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;

/** A workspace with `manifest` and `files` (paths relative to `dist/src`). */
function workspace(manifest, files) {
  counter += 1;
  const dir = join(scratch, `ws-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', ...manifest }));
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, 'dist', 'src', path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return dir;
}

function messages(dir, options) {
  return checkWorkspace(dir, { root: dir, ...options }).violations.map(
    ({ file, message }) => `${file}: ${message}`,
  );
}

describe('packageName', () => {
  it('maps bare and scoped specifiers to their package', () => {
    assert.equal(packageName('zod'), 'zod');
    assert.equal(packageName('preact/hooks'), 'preact');
    assert.equal(packageName('@scope/pkg/sub/path'), '@scope/pkg');
  });

  it('ignores paths, builtins, subpath imports, and template placeholders', () => {
    for (const specifier of ['./a.js', '../b.js', '/abs', '#internal', 'node:fs', 'fs', '${x}']) {
      assert.equal(packageName(specifier), undefined, specifier);
    }
  });

  it('names the DefinitelyTyped package', () => {
    assert.equal(typesPackage('qs'), '@types/qs');
    assert.equal(typesPackage('@hotwired/turbo'), '@types/hotwired__turbo');
  });
});

describe('runtimeSpecifiers', () => {
  it('reads static, re-export, side-effect, dynamic, and require forms', () => {
    const text = [
      "import { a } from 'alpha';",
      'import {',
      '  b,',
      "} from 'beta/sub';",
      "export * from 'gamma';",
      "import 'delta';",
      "const e = await import('epsilon');",
      "const f = require('zeta');",
      "const g = require.resolve('eta/package.json');",
      "const h = import.meta.resolve('theta');",
    ].join('\n');
    assert.deepEqual([...runtimeSpecifiers(text)].sort(), [
      'alpha',
      'beta/sub',
      'delta',
      'epsilon',
      'eta/package.json',
      'gamma',
      'theta',
      'zeta',
    ]);
  });

  it('skips doc-comment examples and import text inside strings', () => {
    const text = [
      '/**',
      " * import { x } from 'from-doc';",
      " * await import('dynamic-doc');",
      ' */',
      "// import 'line-comment';",
      "const source = `import { y } from 'generated';`;",
      'const label = \'see import x from "quoted"\';',
    ].join('\n');
    assert.deepEqual([...runtimeSpecifiers(text)], []);
  });
});

describe('declarationSpecifiers', () => {
  it('reads imports and reference directives but not doc examples', () => {
    const text = [
      '/// <reference types="node" />',
      "/** import { z } from 'doc-only'; */",
      "import type { A } from 'alpha';",
      "export type B = import('beta').B;",
      "export type Mode = 'to' | 'from' | 'cc';",
      "import 'gamma';",
      "readonly message: 'a module failed to import';",
      "readonly kind: readonly ['api'];",
    ].join('\n');
    assert.deepEqual([...declarationSpecifiers(text)].sort(), ['alpha', 'beta', 'gamma', 'node']);
  });
});

describe('checkWorkspace', () => {
  it('passes a workspace that imports exactly what it declares', () => {
    const dir = workspace(
      {
        dependencies: { zod: '1', '@types/qs': '1' },
        peerDependencies: { preact: '1' },
      },
      {
        'index.js': "import { z } from 'zod';\nimport { h } from 'preact';\n",
        'index.d.ts': "import type { ParsedQs } from 'qs';\n",
      },
    );
    assert.deepEqual(messages(dir), []);
  });

  it('counts the types package when a declaration imports a package declared with it', () => {
    const dir = workspace(
      { dependencies: { nodemailer: '7', '@types/nodemailer': '7' } },
      {
        'a.js': "import nodemailer from 'nodemailer';\n",
        'a.d.ts': "import type { Transporter } from 'nodemailer';\n",
      },
    );
    assert.deepEqual(messages(dir), []);
  });

  it('reports a types package that only runtime code reaches', () => {
    const dir = workspace(
      { dependencies: { nodemailer: '7', '@types/nodemailer': '7' } },
      { 'a.js': "import nodemailer from 'nodemailer';\n", 'a.d.ts': 'export {};\n' },
    );
    assert.deepEqual(messages(dir), [
      'package.json: declares "@types/nodemailer", which nothing under dist/src imports',
    ]);
  });

  it('reports a runtime import that is not a runtime dependency', () => {
    const dir = workspace(
      { dependencies: { '@types/lodash': '1' }, devDependencies: { kysely: '1' } },
      {
        'a.js': "import 'kysely';\nconst l = await import('lodash');\n",
        'a.d.ts': "import type { L } from 'lodash';\n",
      },
    );
    assert.deepEqual(messages(dir).sort(), [
      'dist/src/a.js: imports "kysely", not a runtime dependency of demo',
      'dist/src/a.js: imports "lodash", not a runtime dependency of demo',
    ]);
  });

  it('reports a declaration import that only the root devDependencies provide', () => {
    const dir = workspace({}, { 'a.d.ts': "import type { Thing } from 'schema-dts';\n" });
    assert.deepEqual(messages(dir), [
      'dist/src/a.d.ts: imports "schema-dts", not a dependency of demo',
    ]);
  });

  it('reports declared dependencies that nothing imports', () => {
    const dir = workspace(
      {
        dependencies: { ioredis: '5', zod: '1' },
        optionalDependencies: { 'sql.js': '1' },
        peerDependencies: { preact: '1' },
      },
      { 'a.js': "import { z } from 'zod';\n" },
    );
    assert.deepEqual(messages(dir), [
      'package.json: declares "ioredis", which nothing under dist/src imports',
      'package.json: declares "preact", which nothing under dist/src imports',
      'package.json: declares "sql.js", which nothing under dist/src imports',
    ]);
  });

  it('accepts an indirect dependency with a reason and flags a stale entry', () => {
    const dir = workspace({ dependencies: { pg: '8' } }, { 'a.js': 'export {};\n' });
    assert.deepEqual(messages(dir, { indirect: { pg: 'loaded by name' } }), []);
    assert.deepEqual(messages(dir, { indirect: { pg: 'loaded by name', mysql2: 'gone' } }), [
      'scripts/check-declared-deps.mjs: INDIRECT_DEPENDENCIES lists "mysql2" for demo, which does not declare it',
    ]);
  });

  it('ignores the workspace own name and dist/test', () => {
    const dir = workspace(
      { name: '@scope/self' },
      { 'a.js': "export * from '@scope/self/sub';\n" },
    );
    mkdirSync(join(dir, 'dist', 'test'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'test', 'a.test.js'), "import 'node-only-in-tests';\n");
    assert.deepEqual(messages(dir), []);
  });

  it('reports a workspace with no build', () => {
    const dir = workspace({}, {});
    assert.deepEqual(messages(dir), ['.: no dist/src; run a build first']);
  });
});

describe('jsails/internal', () => {
  const internal = { 'a.js': "import { kernel } from 'jsails/internal';\nexport { kernel };\n" };

  it('recognises the internal subpath and nothing that merely shares its prefix', () => {
    assert.equal(isKernelInternal('jsails/internal'), true);
    assert.equal(isKernelInternal('jsails/internal/wire'), true);
    assert.equal(isKernelInternal('jsails/internals'), false);
    assert.equal(isKernelInternal('jsails'), false);
    assert.equal(isKernelInternal('@jsails/internal'), false);
  });

  it('accepts a workspace that pins jsails to exactly the lockstep version', () => {
    const dir = workspace(
      { peerDependencies: { jsails: '1.2.3' }, devDependencies: { jsails: '^1.0.0' } },
      internal,
    );
    assert.deepEqual(messages(dir, { lockstepVersion: '1.2.3' }), []);
  });

  it('fails every field that declares jsails with a range or another version', () => {
    const dir = workspace(
      { peerDependencies: { jsails: '^1.2.3' }, optionalDependencies: { jsails: '1.2.2' } },
      { 'deep/b.d.ts': "export type { Kernel } from 'jsails/internal/types';\n" },
    );
    assert.deepEqual(messages(dir, { lockstepVersion: '1.2.3' }), [
      'package.json: dist/src/deep/b.d.ts imports jsails/internal, so peerDependencies must pin "jsails" to exactly 1.2.3, not "^1.2.3"',
      'package.json: dist/src/deep/b.d.ts imports jsails/internal, so optionalDependencies must pin "jsails" to exactly 1.2.3, not "1.2.2"',
    ]);
  });

  it('leaves a range alone when only public subpaths are imported', () => {
    const dir = workspace(
      { peerDependencies: { jsails: '^1.0.0' } },
      { 'a.js': "import { x } from 'jsails/support';\nexport { x };\n" },
    );
    assert.deepEqual(messages(dir, { lockstepVersion: '1.2.3' }), []);
  });

  it('reports a missing declaration as an undeclared import, not a pin', () => {
    const dir = workspace({}, internal);
    assert.deepEqual(messages(dir, { lockstepVersion: '1.2.3' }), [
      'dist/src/a.js: imports "jsails", not a runtime dependency of demo',
    ]);
  });
});

describe('INDIRECT_DEPENDENCIES', () => {
  it('gives every entry a reason', () => {
    for (const [workspaceName, entries] of Object.entries(INDIRECT_DEPENDENCIES)) {
      for (const [name, reason] of Object.entries(entries)) {
        assert.ok(reason.trim().length > 20, `${workspaceName} ${name}`);
      }
    }
  });
});
