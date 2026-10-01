/**
 * Tests for `scanProjectMeta`: how models, components, and autoloadable symbols
 * are discovered from a project tree.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { MetaScanError, scanProjectMeta } from '../../src/build/meta-scan.js';
import { writeMetaArtifacts } from '../../src/build/generate-meta.js';
import {
  ComponentRegistryErrors,
  createComponentRegistry,
} from '../../src/server-components/registry.js';
import type { ServerComponentDefinition } from '../../src/server-components/component.js';

const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'meta-scan-fixture-'),
);

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function makeDir(name: string): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeModule(rootDir: string, relPath: string, body: string): void {
  const filePath = join(rootDir, relPath);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, body);
}

describe('scanProjectMeta', () => {
  it('returns an empty result for an empty project', async () => {
    const rootDir = makeDir('empty');
    const meta = await scanProjectMeta(rootDir);

    assert.deepEqual(meta.models, []);
    assert.deepEqual(meta.components, []);
    assert.equal(meta.autoload.entries.length, 0);
  });

  it('extracts models from models/ and sorts them by class name', async () => {
    const rootDir = makeDir('models');
    writeModule(
      rootDir,
      'models/post.ts',
      `import { ApplicationRecord } from 'jsails/models';
export class Post extends ApplicationRecord {
  declare title: string;
  declare views: number;
}`,
    );
    writeModule(
      rootDir,
      'models/author.ts',
      `import { ApplicationRecord } from 'jsails/models';
export class Author extends ApplicationRecord {
  declare name: string;
}`,
    );

    const meta = await scanProjectMeta(rootDir);

    assert.deepEqual(
      meta.models.map((m) => m.className),
      ['Author', 'Post'],
    );
    const post = meta.models.find((m) => m.className === 'Post');
    assert.equal(post?.tableName, 'post');
  });

  it('skips a models/ module that declares no ApplicationRecord subclass', async () => {
    const rootDir = makeDir('models-skip');
    writeModule(rootDir, 'models/helper.ts', 'export const helper = 1;');

    const meta = await scanProjectMeta(rootDir);
    assert.deepEqual(meta.models, []);
  });

  it('discovers component modules with camelCase export names', async () => {
    const rootDir = makeDir('components');
    writeModule(rootDir, 'components/task-list.tsx', 'export const taskList = () => null;');
    writeModule(rootDir, 'components/counter.tsx', 'export const counter = () => null;');

    const meta = await scanProjectMeta(rootDir);

    assert.deepEqual(
      meta.components.map((c) => c.exportName),
      ['counter', 'taskList'],
    );
    assert.deepEqual(
      meta.components.map((c) => c.relative),
      ['components/counter.tsx', 'components/task-list.tsx'],
    );
  });

  it('gives each component its path-derived id', async () => {
    const rootDir = makeDir('components-ids');
    writeModule(rootDir, 'components/task-list.tsx', 'export const taskList = () => null;');
    writeModule(rootDir, 'components/admin/UserCard.tsx', 'export const userCard = () => null;');
    writeModule(rootDir, 'components/card/card.tsx', 'export const card = () => null;');

    const meta = await scanProjectMeta(rootDir);

    // A TSX file named after its directory is an ordinary nested component.
    assert.deepEqual(meta.components.map((component) => component.id).sort(), [
      'admin/user-card',
      'card/card',
      'task-list',
    ]);
  });

  it('scans two spellings of one component to one id, which the registry refuses', async () => {
    const rootDir = makeDir('components-duplicate-id');
    writeModule(rootDir, 'components/task-list.tsx', 'export const taskList = () => null;');
    writeModule(rootDir, 'components/taskList.tsx', 'export const taskList = () => null;');

    const meta = await scanProjectMeta(rootDir);
    const entries = meta.components.map((component) => ({
      id: component.id,
      definition: {
        name: component.id,
        render: () => null,
      } as unknown as ServerComponentDefinition,
    }));

    assert.throws(
      () => createComponentRegistry(entries),
      (error: unknown) => ComponentRegistryErrors.is(error, 'duplicate_id'),
    );
  });

  it('registers no part of a .jsails component as a module of its own', async () => {
    const rootDir = makeDir('components-sfc-parts');
    writeModule(rootDir, 'components/card/card.jsails', '<template><p>card</p></template>\n');
    writeModule(rootDir, 'components/card/card.ts', 'export const stateSchema = {};');
    writeModule(rootDir, 'components/card/card.server.ts', 'export const loadCard = () => [];');
    writeModule(rootDir, 'components/list.jsails', '<template><p>list</p></template>\n');
    writeModule(rootDir, 'components/list.server.ts', 'export const loadList = () => [];');
    // Named like a part, but no `.jsails` file makes it one.
    writeModule(rootDir, 'components/menu/menu.ts', 'export const menu = () => null;');
    writeModule(rootDir, 'components/counter.tsx', 'export const counter = () => null;');

    const meta = await scanProjectMeta(rootDir);

    assert.deepEqual(
      meta.components.map((component) => component.relative),
      ['components/counter.tsx', 'components/menu/menu.ts'],
    );
  });

  it('collects autoload symbols alongside models and components in one scan', async () => {
    const rootDir = makeDir('combined');
    writeModule(rootDir, 'app/utils/format.ts', 'export const formatDate = () => "";');
    writeModule(
      rootDir,
      'models/post.ts',
      `import { ApplicationRecord } from 'jsails/models';
export class Post extends ApplicationRecord {
  declare title: string;
}`,
    );
    writeModule(rootDir, 'components/counter.tsx', 'export const counter = () => null;');

    const meta = await scanProjectMeta(rootDir);

    assert.equal(meta.models.length, 1);
    assert.equal(meta.components.length, 1);
    assert.ok(meta.autoload.byName.has('formatDate'));
  });

  it('is deterministic across repeated scans', async () => {
    const rootDir = makeDir('deterministic');
    writeModule(rootDir, 'models/b.ts', 'export class B extends ApplicationRecord {}');
    writeModule(rootDir, 'models/a.ts', 'export class A extends ApplicationRecord {}');

    const first = await scanProjectMeta(rootDir);
    const second = await scanProjectMeta(rootDir);

    assert.deepEqual(
      first.models.map((m) => m.className),
      second.models.map((m) => m.className),
    );
  });

  it('collects model extraction diagnostics instead of dropping them', async () => {
    const rootDir = makeDir('model-diagnostics');
    writeModule(
      rootDir,
      'models/post.ts',
      `import { ApplicationRecord } from 'jsails/models';
export class Post extends ApplicationRecord {
  declare title: string;
  declare tags: Map<string, string>;
}`,
    );

    const meta = await scanProjectMeta(rootDir);

    assert.equal(meta.models.length, 1);
    assert.ok((meta.diagnostics ?? []).length > 0);
    const first = meta.diagnostics?.[0];
    assert.equal(first?.file, 'models/post.ts');
    assert.equal(first?.diagnostic.severity, 'error');
    assert.equal(first?.diagnostic.range.start.line, 4);
  });

  it('refuses to write artifacts for a scan with model errors', async () => {
    const rootDir = makeDir('model-diagnostics-write');
    writeModule(
      rootDir,
      'models/post.ts',
      `import { ApplicationRecord } from 'jsails/models';
export class Post extends ApplicationRecord {
  declare tags: Map<string, string>;
}`,
    );

    const meta = await scanProjectMeta(rootDir);

    assert.throws(
      () => writeMetaArtifacts(meta, rootDir),
      (error: unknown) =>
        error instanceof MetaScanError &&
        error.code === 'invalid_model' &&
        /models\/post\.ts:3:\d+: error\[/.test(error.message),
    );
  });
});
