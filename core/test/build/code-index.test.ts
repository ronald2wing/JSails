/**
 * Tests for the `.jsails/index.json` code index: it projects the same facts the
 * live scans produce, it is fingerprinted by the manifest, and a stale or
 * corrupt index is a hard error rather than a wrong answer.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  CODE_INDEX_FILE,
  CodeIndexError,
  emitCodeIndex,
  hasCodeIndex,
  parseCodeIndex,
  readCodeIndex,
} from '../../src/build/code-index.js';
import { buildCodeIndex } from '../../src/build/scan-code-index.js';
import {
  buildMetaManifest,
  emitMetaManifest,
  META_MANIFEST_FILE,
} from '../../src/build/meta-manifest.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import { SOURCE_EXTENSIONS } from '../../src/compiler/conventions.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-code-index-'));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;

/** A project tree with the given files, keyed by project-relative path. */
function project(files: Readonly<Record<string, string>>): string {
  const dir = join(root, `case-${seq++}`);
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(dir, relative);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return dir;
}

/** Write the manifest and index artifacts for `dir`, as `build:meta` would. */
async function writeArtifacts(dir: string): Promise<void> {
  mkdirSync(join(dir, '.jsails'), { recursive: true });
  writeFileSync(join(dir, '.jsails', META_MANIFEST_FILE), emitMetaManifest(buildMetaManifest(dir)));
  writeFileSync(join(dir, '.jsails', CODE_INDEX_FILE), emitCodeIndex(await buildCodeIndex(dir)));
}

const ROUTES = {
  'pages/index.tsx': 'export default 1',
  'pages/blog/[slug].tsx': 'export default 1',
  'pages/docs/[...path].tsx': 'export default 1',
  'api/health.ts': 'export default 1',
};

describe('buildCodeIndex', () => {
  it('records every route the live discovery finds, in the same order', async () => {
    const dir = project(ROUTES);
    const index = await buildCodeIndex(dir);
    // The index scans the source tree, so the live comparison uses the same
    // extension set; the compiled default would find nothing here.
    const live = discoverRoutes(dir, { extensions: SOURCE_EXTENSIONS });
    assert.deepEqual(
      index.routes.map((route) => route.route),
      live.entries.map((entry) => entry.route),
    );
  });

  it('records route facts: kind, dynamic, catch-all, params, and layout count', async () => {
    const dir = project({ ...ROUTES, 'pages/blog/layout.tsx': 'export default 1' });
    const index = await buildCodeIndex(dir);
    const blog = index.routes.find((route) => route.route === '/blog/:slug');
    assert.deepEqual(blog, {
      kind: 'page',
      route: '/blog/:slug',
      dynamic: true,
      catchAll: false,
      optionalCatchAll: false,
      params: ['slug'],
      file: 'pages/blog/[slug].tsx',
      layoutCount: 1,
    });
  });

  it('records the catch-all flag for a trailing catch-all', async () => {
    const dir = project(ROUTES);
    const index = await buildCodeIndex(dir);
    const docs = index.routes.find((route) => route.route === '/docs/*path');
    assert.equal(docs?.catchAll, true);
  });

  it('records models with their fields', async () => {
    const dir = project({
      'models/post.ts': [
        "import { ApplicationRecord } from 'jsails/models';",
        'export class Post extends ApplicationRecord {',
        '  declare title: string;',
        '  declare views: number;',
        '}',
      ].join('\n'),
    });
    const index = await buildCodeIndex(dir);
    assert.equal(index.models.length, 1);
    assert.equal(index.models[0]?.className, 'Post');
    assert.equal(index.models[0]?.tableName, 'post');
    assert.deepEqual(
      index.models[0]?.fields.map((field) => field.name),
      ['title', 'views'],
    );
  });

  it('records server components by export name and relative path', async () => {
    const dir = project({ 'components/task-list.tsx': 'export function taskList() {}' });
    const index = await buildCodeIndex(dir);
    assert.deepEqual(index.components, [
      { exportName: 'taskList', relative: 'components/task-list.tsx' },
    ]);
  });

  it('carries the manifest fingerprint', async () => {
    const dir = project(ROUTES);
    const index = await buildCodeIndex(dir);
    assert.equal(index.fingerprint, buildMetaManifest(dir).fingerprint);
  });

  it('is deterministic: two builds of the same tree agree', async () => {
    const dir = project(ROUTES);
    assert.deepEqual(await buildCodeIndex(dir), await buildCodeIndex(dir));
  });
});

describe('readCodeIndex', () => {
  it('reads a fresh index', async () => {
    const dir = project(ROUTES);
    await writeArtifacts(dir);
    assert.equal(readCodeIndex(dir).routes.length, 4);
  });

  it('reports missing_index when the artifact is absent', () => {
    const dir = project(ROUTES);
    assert.throws(
      () => readCodeIndex(dir),
      (error: unknown) => error instanceof CodeIndexError && error.code === 'missing_index',
    );
    assert.equal(hasCodeIndex(dir), false);
  });

  it('reports stale_index when a source file changed after the build', async () => {
    const dir = project(ROUTES);
    await writeArtifacts(dir);
    writeFileSync(join(dir, 'pages/index.tsx'), 'export default 2');
    assert.throws(
      () => readCodeIndex(dir),
      (error: unknown) =>
        error instanceof CodeIndexError &&
        error.code === 'stale_index' &&
        error.suggestion === 'run "jsails build:meta" to regenerate it',
    );
  });

  it('reports stale_index when the manifest is missing', async () => {
    const dir = project(ROUTES);
    await writeArtifacts(dir);
    rmSync(join(dir, '.jsails', META_MANIFEST_FILE));
    assert.throws(
      () => readCodeIndex(dir),
      (error: unknown) => error instanceof CodeIndexError && error.code === 'stale_index',
    );
  });

  it('reports invalid_index for malformed JSON or a wrong version', async () => {
    const dir = project(ROUTES);
    await writeArtifacts(dir);
    const path = join(dir, '.jsails', CODE_INDEX_FILE);

    writeFileSync(path, 'not json');
    assert.throws(
      () => readCodeIndex(dir),
      (error: unknown) => error instanceof CodeIndexError && error.code === 'invalid_index',
    );

    writeFileSync(path, JSON.stringify({ version: 99 }));
    assert.throws(
      () => readCodeIndex(dir),
      (error: unknown) => error instanceof CodeIndexError && error.code === 'invalid_index',
    );
  });

  it('round-trips through emit and parse', async () => {
    const dir = project(ROUTES);
    const index = await buildCodeIndex(dir);
    assert.deepEqual(parseCodeIndex(emitCodeIndex(index)), index);
  });
});
