/**
 * The schema-portability check (`data-specs` gate): source scanning, the
 * non-spec ledger ratchet, and, against fixture workspaces whose built
 * modules use the real `@jsails/database/model`, a non-portable type, an
 * unindexed foreign key, name collisions and an unexported model each fail.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  checkSchemaPortability,
  codeOnly,
  judgeEntities,
  scanSource,
} from '../check-schema-portability.mjs';
import { repoRoot } from '../workspaces.mjs';

const MODEL_DIST = join(repoRoot, 'packages', 'database', 'dist', 'src', 'model', 'index.js');
const built = existsSync(MODEL_DIST);

describe('scanning sources', () => {
  it('blanks comments and string contents but keeps line breaks', () => {
    const text = "a // @Entity('x')\nb = '@Entity(' + `defineModel(\n` /* defineTable( */ c";
    const code = codeOnly(text);
    assert.equal(code.split('\n').length, text.split('\n').length);
    assert.doesNotMatch(code, /Entity|define/);
    assert.match(code, /^a /);
    assert.match(code, / c$/);
  });

  it('finds model definitions only where the model API is imported', () => {
    const defining =
      "import { defineModel } from '@jsails/database/model';\nexport class A {}\ndefineModel(A, spec);";
    assert.equal(scanSource(defining).defines, true);
    assert.equal(
      scanSource("import { defineModel } from 'jsails/models';\ndefineModel(A, spec);").defines,
      false,
    );
    assert.equal(
      scanSource(
        "import { x } from '@jsails/database/model';\nexport function defineModel(a, b) {}",
      ).defines,
      false,
    );
    assert.equal(
      scanSource("import { defineTable } from '../model/define-model.js';\ndefineTable({});", {
        insideDatabase: true,
      }).defines,
      true,
    );
    assert.equal(
      scanSource("import { column } from '@jsails/database/model';\n// defineTable({})").defines,
      false,
    );
  });

  it('names TypeORM models by class, ignoring documentation', () => {
    const source = [
      "/** Example: @Entity('docs') class Doc {} */",
      "@Entity('posts')",
      "@Index('x', ['a'])",
      'export class Post extends BaseEntity {}',
      "const Schema = new EntitySchema({ name: 'thing' });",
      'const text = "@Entity(\'nope\')";',
    ].join('\n');
    const { entities } = scanSource(source);
    assert.equal(entities.length, 2);
    assert.equal(entities[0], 'Post');
    assert.match(entities[1], /^EntitySchema@\d+$/);
  });
});

describe('the non-spec ledger', () => {
  it('fails on an unlisted model and on a listed one that is gone', () => {
    const ledger = { entries: [{ id: 'a.ts#Old' }, { id: 'a.ts#Kept' }] };
    const failures = judgeEntities(['a.ts#Kept', 'b.ts#New'], ledger);
    assert.equal(failures.length, 2);
    assert.match(failures[0], /^b\.ts#New is a TypeORM model, not a ModelSpec/);
    assert.match(failures[1], /^fixed: "a\.ts#Old"/);
    assert.deepEqual(judgeEntities(['a.ts#Old', 'a.ts#Kept'], ledger), []);
  });
});

describe('fixture workspaces', { skip: built ? false : '@jsails/database is not built' }, () => {
  const roots = [];
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  /** A repo with one workspace whose `src/<name>.ts` defines models, built as `body`. */
  function fixture(files) {
    const root = mkdtempSync(join(tmpdir(), 'jsails-portability-'));
    roots.push(root);
    const workspace = join(root, 'packages', 'fixture');
    const header = `import { column, defineModel, defineTable } from ${JSON.stringify(pathToFileURL(MODEL_DIST).href)};\n`;
    for (const [name, body] of Object.entries(files)) {
      const source = join(workspace, 'src', `${name}.ts`);
      const dist = join(workspace, 'dist', 'src', `${name}.js`);
      mkdirSync(dirname(source), { recursive: true });
      mkdirSync(dirname(dist), { recursive: true });
      writeFileSync(
        source,
        `import { defineTable } from '@jsails/database/model';\ndefineTable({});\n`,
      );
      writeFileSync(dist, header + body);
    }
    return { root, workspaces: [workspace] };
  }

  async function check(files, ledger = { entries: [] }) {
    const model = await import(pathToFileURL(MODEL_DIST).href);
    return checkSchemaPortability({ ...fixture(files), ledger, model });
  }

  it('passes portable models', async () => {
    const failures = await check({
      models: `
        export const users = defineTable({ table: 'users', columns: { email: column.string(200) } });
        export class Post {}
        defineModel(Post, {
          table: 'posts',
          columns: { title: column.string(100) },
          relations: { author: { kind: 'belongsTo', target: () => users } },
        });
      `,
    });
    assert.deepEqual(failures, []);
  });

  it('fails on a non-portable type', async () => {
    const failures = await check({
      models: `export const bad = defineTable({ table: 'bad', columns: { at: { type: { kind: 'datetime' } } } });`,
    });
    assert.equal(failures.length, 1);
    assert.match(
      failures[0],
      /^packages\/fixture\/src\/models\.ts: the module fails to load \[invalid_type\]/,
    );
  });

  it('fails on a foreign key that leads no index', async () => {
    const failures = await check({
      models: `
        export const users = defineTable({ table: 'users', columns: {} });
        export const posts = defineTable({
          table: 'posts',
          columns: {},
          relations: { author: { kind: 'belongsTo', target: () => users, index: false } },
        });
      `,
    });
    assert.deepEqual(failures, [
      'packages/fixture/src/models.ts#posts: foreign-key or tenant column author_id leads no index',
    ]);
  });

  it('fails on a relation physicalTable refuses', async () => {
    const failures = await check({
      models: `export const orphan = defineTable({ table: 'orphans', columns: {}, relations: { owner: { kind: 'belongsTo', target: () => ({}) } } });`,
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /#orphan: postgres: a relation target is not a model/);
  });

  it('fails on shared table and index names across files, and on unexported models', async () => {
    const failures = await check({
      a: `export const one = defineTable({ table: 'shared', columns: { code: column.string(5) }, indexes: [{ columns: ['code'], name: 'same_name' }] });`,
      b: `export const two = defineTable({ table: 'shared', columns: {} });
          export const three = defineTable({ table: 'other', columns: { code: column.string(5) }, indexes: [{ columns: ['code'], name: 'same_name' }] });`,
      c: `defineTable({ table: 'hidden', columns: {} });`,
    });
    assert.deepEqual(failures.sort(), [
      'packages/fixture/src/b.ts#three: index "same_name" is also packages/fixture/src/a.ts#one\'s',
      'packages/fixture/src/b.ts#two: table "shared" is also packages/fixture/src/a.ts#one\'s',
      'packages/fixture/src/c.ts: defines models but exports none, so no tool can see them',
    ]);
  });
});
