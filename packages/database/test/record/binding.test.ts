/**
 * Model binding: constructing a data source binds its models; a model bound
 * to an open data source cannot be bound to a second one
 * (`data_source.already_bound`, and nothing of the second is bound), and
 * `close()` unbinds, after which the model can be bound again. A model used
 * with no binding fails with `data_source.not_bound`, and a closed data
 * source refuses statements. Construction opens no connection. A second copy
 * of the package in the process shares the bindings, and refuses a data
 * source the first copy made as `data_source.duplicate_package`.
 */

import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it, type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ApplicationRecord,
  JsailsDataSource,
  query,
  resolveDatabaseConfig,
  transaction,
  type DatabaseConfig,
} from '../../src/index.js';
import { column, defineModel, defineTable } from '../../src/model/index.js';
import { unguarded } from '../../src/unguarded/index.js';

class Widget extends ApplicationRecord {
  declare id: number;
  declare name: string;
}
defineModel(Widget, { table: 'b_widgets', columns: { name: column.string(40) } });

class Gadget extends ApplicationRecord {
  declare id: number;
}
defineModel(Gadget, { table: 'b_gadgets', columns: {} });

const Link = defineTable({ table: 'b_links', columns: { note: column.string(40) } });

const memory = (): DatabaseConfig => resolveDatabaseConfig({ file: ':memory:' }, { env: {} });

/**
 * A second copy of the built package, loaded as separate modules. It lives
 * beside the build so its bare imports resolve through the same
 * node_modules.
 */
async function packageCopy(t: TestContext): Promise<{
  readonly index: typeof import('../../src/index.js');
  readonly model: typeof import('../../src/model/index.js');
}> {
  const built = fileURLToPath(new URL('../../src', import.meta.url));
  const root = mkdtempSync(join(fileURLToPath(new URL('../../', import.meta.url)), 'copy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(built, join(root, 'src'), { recursive: true });
  const load = (path: string): Promise<unknown> =>
    import(pathToFileURL(join(root, 'src', path)).href);
  return {
    index: (await load('index.js')) as typeof import('../../src/index.js'),
    model: (await load(join('model', 'index.js'))) as typeof import('../../src/model/index.js'),
  };
}

describe('model binding', () => {
  it('binds the models of a data source until it is closed', async () => {
    const dataSource = new JsailsDataSource({ config: memory(), models: [Widget, Link] });
    assert.equal(dataSource.closed, false);
    assert.equal(Widget.all() instanceof Object, true);
    assert.equal(typeof query(Link).getMany, 'function');
    await dataSource.close();
    assert.equal(dataSource.closed, true);
    assert.throws(() => Widget.all(), { code: 'data_source.not_bound' });
    assert.throws(() => query(Link), { code: 'data_source.not_bound' });
  });

  it('refuses to bind a model to a second open data source, binding nothing of it', async () => {
    const first = new JsailsDataSource({ config: memory(), models: [Widget] });
    after(() => first.close());
    assert.throws(() => new JsailsDataSource({ config: memory(), models: [Gadget, Widget] }), {
      code: 'data_source.already_bound',
      context: { model: 'Widget' },
    });
    assert.throws(() => Gadget.all(), { code: 'data_source.not_bound' });
    await first.close();
    const second = new JsailsDataSource({ config: memory(), models: [Gadget, Widget] });
    assert.doesNotThrow(() => Widget.all());
    await second.close();
  });

  it('refuses a table bound to two data sources, and binds a model listed twice once', async () => {
    const first = new JsailsDataSource({ config: memory(), models: [Link] });
    assert.throws(() => new JsailsDataSource({ config: memory(), models: [Link] }), {
      code: 'data_source.already_bound',
    });
    await first.close();
    const twice = new JsailsDataSource({ config: memory(), models: [Link, Link] });
    assert.deepEqual(twice.models, [Link]);
    await twice.close();
    assert.throws(() => query(Link), { code: 'data_source.not_bound' });
  });

  it('refuses things that are not models, and malformed options', () => {
    assert.throws(() => new JsailsDataSource({ config: memory(), models: [{}] }), {
      code: 'data_source.not_a_model',
    });
    assert.throws(() => query({}), { code: 'data_source.not_a_model' });
    assert.throws(() => new JsailsDataSource({ config: memory(), models: 'Widget' as never }), {
      code: 'data_source.invalid_options',
    });
    assert.throws(() => new JsailsDataSource(null as never), {
      code: 'data_source.invalid_options',
    });
  });

  it("shares bindings with another copy of the package, which refuses this copy's data source", async (t) => {
    const copy = await packageCopy(t);
    assert.notEqual(copy.index.JsailsDataSource, JsailsDataSource);
    class Item extends copy.index.ApplicationRecord {
      declare id: number;
    }
    copy.model.defineModel(Item, { table: 'b_items', columns: { name: column.string(40) } });
    const dataSource = new JsailsDataSource({ config: memory(), models: [Item] });
    const duplicate = { code: 'data_source.duplicate_package' };
    try {
      assert.doesNotThrow(() => query(Item));
      assert.throws(() => Item.all(), duplicate);
      assert.throws(() => copy.index.query(Item), duplicate);
      assert.throws(() => copy.index.dataHandle(dataSource, { models: [Item] }), duplicate);
      await assert.rejects(() => copy.index.transaction(dataSource, () => 1), duplicate);
      await assert.rejects(() => copy.index.withTestTransaction(dataSource, () => 1), duplicate);
      assert.throws(() => new copy.index.JsailsDataSource({ config: memory(), models: [Item] }), {
        code: 'data_source.already_bound',
      });
    } finally {
      await dataSource.close();
    }
    const own = new copy.index.JsailsDataSource({ config: memory(), models: [Item] });
    assert.doesNotThrow(() => Item.all());
    assert.throws(() => query(Item), duplicate);
    await own.close();
  });

  it('opens no connection until the first statement, and none after close', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jsails-binding-'));
    after(() => rmSync(directory, { recursive: true, force: true }));
    const config = resolveDatabaseConfig(
      { file: join(directory, 'missing', 'b.sqlite') },
      { env: {} },
    );
    // The directory of the file does not exist: opening would fail, constructing does not.
    const dataSource = new JsailsDataSource({ config, models: [Widget] });
    await dataSource.close();
    await dataSource.close();
    assert.throws(() => Widget.all(), { code: 'data_source.not_bound' });
    await assert.rejects(() => unguarded(dataSource).sql`SELECT 1`, { code: 'data_source.closed' });
    await assert.rejects(() => transaction(dataSource, () => 1), { code: 'data_source.closed' });
  });

  it('settles a statement in flight at close, and refuses the next', async () => {
    const dataSource = new JsailsDataSource({ config: memory(), models: [Widget] });
    const raw = unguarded(dataSource);
    await raw.sql`CREATE TABLE b_widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
    await Widget.create({ name: 'one' });
    const running = Widget.all().getMany();
    await dataSource.close();
    // The engine rejects a statement still waiting for it (its close contract); none hangs.
    const settled = await running.then(
      (rows) => rows.map((widget) => widget.name),
      (error: unknown) => (error as { code?: unknown }).code,
    );
    assert.ok(
      settled === 'closed' || JSON.stringify(settled) === '["one"]',
      'the statement in flight returned its rows or failed as closed',
    );
    await assert.rejects(() => raw.sql`SELECT 1`, { code: 'data_source.closed' });
  });
});
