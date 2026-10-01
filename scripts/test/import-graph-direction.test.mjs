/**
 * Tests for the direction gate (`scripts/import-graph/direction.mjs`,
 * `package-map.mjs`, gate `import-direction`): import extraction, placement,
 * the allowed direction, owned dependencies, imports from mapped `packages/`, and the
 * ratchet against the ledger, on fixture repositories with a small map.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { listWorkspaces, loadParser } from '../api-report.mjs';
import { explain, judge } from '../gates/import-direction.mjs';
import { importsOf, packageName, scanDirection } from '../import-graph/direction.mjs';
import {
  PACKAGES,
  PLACEMENT,
  mayImport,
  ownsDependency,
  placeOf,
  reachable,
  validateMap,
} from '../import-graph/package-map.mjs';

const parseSync = await loadParser();
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'jsails-direction-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const packages = {
  kernel: { imports: [], dependencies: ['hono'] },
  data: { imports: ['kernel'], dependencies: ['typeorm'] },
  '@x/live': { imports: ['kernel', 'data'], dependencies: [] },
};
const placement = {
  'server/': 'kernel',
  'index.ts': 'kernel',
  'database/': 'data',
  'live/': '@x/live',
};

/** A repo whose core has a kernel and a data directory, plus workspace `@x/live`. */
function repo(extra = {}) {
  return fixture({
    'package.json': JSON.stringify({ private: true, workspaces: ['core', 'packages/*'] }),
    'core/package.json': JSON.stringify({
      name: 'jsails',
      exports: {
        '.': { types: './dist/src/index.d.ts', default: './dist/src/index.js' },
        './database': './dist/src/database/index.js',
      },
    }),
    'core/src/index.ts': "export * from './server/app.js';\n",
    'core/src/server/app.ts': "import { Hono } from 'hono';\nexport const app = new Hono();\n",
    'core/src/database/index.ts': "import { DataSource } from 'typeorm';\nexport { DataSource };\n",
    'packages/live/package.json': JSON.stringify({ name: '@x/live' }),
    'packages/live/src/index.ts': 'export const live = 1;\n',
    ...extra,
  });
}

function scan(root) {
  return scanDirection(parseSync, { root, packages, placement, workspaces: listWorkspaces(root) });
}

const ledger = (...ids) => ({ entries: ids.map((id) => ({ id, reason: 'r', fixedBy: 'KRN-22' })) });

describe('importsOf', () => {
  it('reads imports, re-exports and literal dynamic imports, marking type-only ones', () => {
    const found = importsOf(
      parseSync,
      'a.ts',
      [
        "import type { A } from './a.js';",
        "import { b, type C } from './b.js';",
        "import './side.js';",
        "export * from './c.js';",
        "export type { D } from './d.js';",
        "const e = await import('./e.js');",
        'const f = await import(name);',
        '',
      ].join('\n'),
    );
    assert.deepEqual(found, [
      { specifier: './a.js', typeOnly: true },
      { specifier: './b.js', typeOnly: false },
      { specifier: './side.js', typeOnly: false },
      { specifier: './c.js', typeOnly: false },
      { specifier: './d.js', typeOnly: true },
      { specifier: './e.js', typeOnly: false },
    ]);
  });

  it('names the package of a bare specifier', () => {
    assert.equal(packageName('typeorm/sub'), 'typeorm');
    assert.equal(packageName('@scope/name/sub'), '@scope/name');
  });
});

describe('the package map helpers', () => {
  it('place a path by its longest prefix, files exactly', () => {
    const rules = { 'cli/': 'kernel', 'cli/commands/db.ts': 'data', 'index.ts': 'kernel' };
    assert.equal(placeOf('cli/x.ts', rules), 'kernel');
    assert.equal(placeOf('cli/commands/db.ts', rules), 'data');
    assert.equal(placeOf('index.ts', rules), 'kernel');
    assert.equal(placeOf('index.tsx', rules), undefined);
    assert.equal(placeOf('other/x.ts', rules), undefined);
  });

  it('allow imports along the declared edges only', () => {
    assert.ok(mayImport('data', 'kernel', packages));
    assert.ok(mayImport('data', 'data', packages));
    assert.ok(!mayImport('kernel', 'data', packages));
    assert.ok(ownsDependency('data', 'typeorm', packages));
    assert.deepEqual([...reachable('@x/live', packages)].sort(), ['@x/live', 'data', 'kernel']);
  });

  it('reject unknown packages and mutual imports', () => {
    assert.deepEqual(validateMap(packages, placement), []);
    assert.deepEqual(
      validateMap({ a: { imports: ['b'] }, b: { imports: ['a', 'c'] } }, { 'x/': 'z' }),
      [
        'placement "x/" names unknown package z',
        'a and b may import each other',
        'b and a may import each other',
        'b may import unknown package c',
      ],
    );
  });

  it('the real map is consistent', () => {
    assert.deepEqual(validateMap(PACKAGES, PLACEMENT), []);
  });
});

describe('scanDirection', () => {
  it('passes a tree that follows the map', () => {
    assert.deepEqual(scan(repo()), { violations: [], unplaced: [] });
  });

  it('flags a new cross-package import, an unowned dependency and an unplaced file', () => {
    const root = repo({
      'core/src/server/readiness.ts':
        "import type { DataSource } from '../database/index.js';\nexport type R = DataSource;\n",
      'core/src/server/orm.ts': "export const load = () => import('typeorm');\n",
      'core/src/server/self.ts': "export { DataSource } from 'jsails/database';\n",
      'core/src/stray/x.ts': 'export const x = 1;\n',
    });
    const { violations, unplaced } = scan(root);
    assert.deepEqual(
      violations.map(({ id, owner, typeOnly }) => ({ id, owner, typeOnly })),
      [
        { id: 'core/src/server/orm.ts -> npm:typeorm', owner: 'kernel', typeOnly: false },
        { id: 'core/src/server/readiness.ts -> data', owner: 'kernel', typeOnly: true },
        { id: 'core/src/server/self.ts -> data', owner: 'kernel', typeOnly: false },
      ],
    );
    assert.deepEqual(unplaced, ['core/src/stray/x.ts']);
  });

  it('lets a package use a dependency owned by a package it may import', () => {
    const root = repo({
      'core/src/live/feed.ts': "import { DataSource } from 'typeorm';\nexport { DataSource };\n",
    });
    assert.deepEqual(scan(root).violations, []);
  });

  it('flags a workspace importing code that will depend on it', () => {
    const root = repo({
      'core/src/database/feed.ts': 'export const feed = 1;\n',
      'packages/live/src/x.ts':
        "import { DataSource } from 'jsails/database';\nexport { DataSource };\n",
    });
    assert.deepEqual(scan(root).violations, []);
    const cyclic = repo({
      'packages/live/package.json': JSON.stringify({ name: 'data' }),
      'packages/live/src/x.ts': "import { app } from 'jsails';\nexport { app };\n",
    });
    // `data` may import `kernel`, so importing the kernel is fine; reverse the map to make a cycle.
    const reversed = {
      kernel: { imports: ['data'], dependencies: ['hono'] },
      data: { imports: [], dependencies: ['typeorm'] },
      '@x/live': { imports: [], dependencies: [] },
    };
    const found = scanDirection(parseSync, {
      root: cyclic,
      packages: reversed,
      placement,
      workspaces: listWorkspaces(cyclic),
    }).violations.map((violation) => violation.id);
    assert.ok(found.includes('packages/live/src/x.ts -> kernel'));
  });

  it('flags a workspace importing a package its map entry does not allow', () => {
    const root = repo({
      'packages/live/src/x.ts':
        "import type { DataSource } from 'jsails/database';\nexport type D = DataSource;\n",
    });
    // No cycle: `data` does not reach `@x/live`; the edge is simply not allowed.
    const narrow = { ...packages, '@x/live': { imports: ['kernel'], dependencies: [] } };
    const found = scanDirection(parseSync, {
      root,
      packages: narrow,
      placement,
      workspaces: listWorkspaces(root),
    }).violations;
    assert.deepEqual(
      found.map(({ id, owner, typeOnly }) => ({ id, owner, typeOnly })),
      [{ id: 'packages/live/src/x.ts -> data', owner: '@x/live', typeOnly: true }],
    );
  });
});

describe('the gate verdict', () => {
  const root = () =>
    repo({
      'core/src/server/readiness.ts': "import '../database/index.js';\nexport const r = 1;\n",
    });

  it('fails a violation that is not listed', () => {
    const failures = judge(scan(root()), ledger());
    assert.deepEqual(failures, [
      'new violation: core/src/server/readiness.ts (future kernel) imports data, against the package map; import through an allowed package or change the map',
    ]);
  });

  it('accepts a listed violation and fails a listed one that is gone', () => {
    assert.deepEqual(judge(scan(root()), ledger('core/src/server/readiness.ts -> data')), []);
    assert.deepEqual(judge(scan(repo()), ledger('core/src/server/readiness.ts -> data')), [
      'fixed: "core/src/server/readiness.ts -> data" no longer occurs; remove it from import-direction.json',
    ]);
  });

  it('fails unplaced files and map problems', () => {
    const failures = judge({ violations: [], unplaced: ['core/src/x.ts'] }, ledger(), ['broken']);
    assert.deepEqual(failures, [
      'package map: broken',
      'core/src/x.ts is in no future package: place it in scripts/import-graph/package-map.mjs',
    ]);
  });

  it('explains a third-party violation', () => {
    assert.equal(
      explain({ file: 'core/src/a.ts', owner: 'kernel', target: 'npm:pg' }),
      'core/src/a.ts (future kernel) imports pg, which neither kernel nor a package it may import owns',
    );
  });
});
