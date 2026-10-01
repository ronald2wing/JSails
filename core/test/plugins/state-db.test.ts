/** Tests for `createDatabasePluginStateStore`: round-trips, the missing-table failure, and `pluginStateEntities`. */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { Repository } from 'typeorm';

import { JsailsDataSource } from '../../src/database/data-source.js';
import {
  createDatabasePluginStateStore,
  loadPluginEnablement,
} from '../../src/plugins/database-state-store.js';
import {
  DatabasePluginState,
  pluginStateEntities,
} from '../../src/plugins/database-state-entity.js';
import {
  PluginStateError,
  PLUGIN_STATE_VERSION,
  type PluginState,
  type PluginStateSource,
} from '../../src/plugins/state-store.js';
import { createEmptyDataSource } from '../../src/testing/index.js';

/**
 * The database-backed plugin state store is exercised against a real on-disk
 * sql.js database (the actual WASM build TypeORM loads internally), with the
 * `jsails_plugin_state` table created by the real migration history — never by
 * runtime DDL.
 */

const tmpRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'plugins-state-db-'),
);

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function validState(): PluginState {
  return {
    version: PLUGIN_STATE_VERSION,
    plugins: {
      acme: { active: '1.2.3', enabled: true },
      tasks: { active: '2.0.0', enabled: false },
    },
  };
}

describe('createDatabasePluginStateStore round-trip', () => {
  it('saves and loads plugin state through the ORM repository', async () => {
    const dataSource = await createEmptyDataSource([DatabasePluginState], {
      location: join(tmpRoot, 'roundtrip.db'),
    });
    const store = createDatabasePluginStateStore({ dataSource });

    await store.save(validState());
    assert.deepEqual(await store.load(), validState());

    await dataSource.destroy();
  });

  it('replaces the table on save and reflects enable/disable', async () => {
    const dataSource = await createEmptyDataSource([DatabasePluginState], {
      location: join(tmpRoot, 'replace.db'),
    });
    const store = createDatabasePluginStateStore({ dataSource });

    await store.save(validState());

    const next: PluginState = {
      version: PLUGIN_STATE_VERSION,
      plugins: { acme: { active: '2.0.0', enabled: false } },
    };
    await store.save(next);
    assert.deepEqual(await store.load(), next);

    await dataSource.destroy();
  });

  it('round-trips a settings object through the JSON text column', async () => {
    const dataSource = await createEmptyDataSource([DatabasePluginState], {
      location: join(tmpRoot, 'settings.db'),
    });
    const store = createDatabasePluginStateStore({ dataSource });

    const state: PluginState = {
      version: PLUGIN_STATE_VERSION,
      plugins: {
        acme: {
          active: '1.2.3',
          enabled: true,
          settings: { retries: 3, verbose: true, name: 'demo', opaque: { nested: [1, 2] } },
        },
      },
    };
    await store.save(state);
    assert.deepEqual(await store.load(), state);

    // An entry saved without settings loads back without a settings key.
    const bare: PluginState = {
      version: PLUGIN_STATE_VERSION,
      plugins: { acme: { active: '1.2.3', enabled: true } },
    };
    await store.save(bare);
    const loaded = await store.load();
    assert.equal(Object.hasOwn(loaded.plugins['acme']!, 'settings'), false);

    await dataSource.destroy();
  });

  it('rejects an invalid stored settings column on load without echoing it', async () => {
    const dataSource = await createEmptyDataSource([DatabasePluginState], {
      location: join(tmpRoot, 'invalid-settings.db'),
    });
    const store = createDatabasePluginStateStore({ dataSource });

    await dataSource.getRepository(DatabasePluginState).save({
      pluginId: 'acme',
      activeVersion: '1.0.0',
      enabled: true,
      settings: 'not-json',
      updatedAt: new Date(),
    });

    await assert.rejects(
      async () => store.load(),
      (error: unknown) => error instanceof PluginStateError && !error.message.includes('not-json'),
    );

    await dataSource.destroy();
  });

  it('loadPluginEnablement merges managed state with the code list', async () => {
    const dataSource = await createEmptyDataSource([DatabasePluginState], {
      location: join(tmpRoot, 'enablement.db'),
    });
    const store = createDatabasePluginStateStore({ dataSource });
    await store.save(validState());

    const result = await loadPluginEnablement({
      managed: true,
      codeEnabled: ['core'],
      stateSource: store,
    });
    assert.deepEqual(result.enabled, ['acme', 'core']);
    assert.deepEqual(result.disabledManaged, ['tasks']);

    await dataSource.destroy();
  });

  it('loadPluginEnablement ignores the state source when not managed', async () => {
    let consulted = false;
    const stateSource: PluginStateSource = {
      load: () => {
        consulted = true;
        return { version: PLUGIN_STATE_VERSION, plugins: {} };
      },
      save: () => {},
    };

    const result = await loadPluginEnablement({
      managed: false,
      codeEnabled: ['core'],
      stateSource,
    });
    assert.deepEqual(result.enabled, ['core']);
    assert.equal(consulted, false);
  });

  it('loadPluginEnablement rejects a managed request without a state source', async () => {
    await assert.rejects(loadPluginEnablement({ managed: true }), /requires a state source/);
  });

  it('rejects invalid stored rows on load without echoing values', async () => {
    const dataSource = await createEmptyDataSource([DatabasePluginState], {
      location: join(tmpRoot, 'invalid-row.db'),
    });
    const store = createDatabasePluginStateStore({ dataSource });

    // Seed an invalid id directly through the repository, bypassing save().
    await dataSource.getRepository(DatabasePluginState).save({
      pluginId: 'Bad!',
      activeVersion: '1.0.0',
      enabled: true,
      updatedAt: new Date(),
    });

    await assert.rejects(
      async () => store.load(),
      (error: unknown) => error instanceof PluginStateError && !error.message.includes('Bad!'),
    );

    await dataSource.destroy();
  });

  it('rejects invalid state before writing anything', async () => {
    const dataSource = await createEmptyDataSource([DatabasePluginState], {
      location: join(tmpRoot, 'invalid-state.db'),
    });
    const store = createDatabasePluginStateStore({ dataSource });

    await assert.rejects(
      async () =>
        store.save({
          version: PLUGIN_STATE_VERSION,
          plugins: { 'Bad!': { active: '1.0.0', enabled: true } },
        }),
      PluginStateError,
    );
    assert.deepEqual(await store.load(), { version: PLUGIN_STATE_VERSION, plugins: {} });

    await dataSource.destroy();
  });
});

describe('createDatabasePluginStateStore: per-row save', () => {
  it('never truncates the table: unchanged rows keep their primary key', async () => {
    const dataSource = await createEmptyDataSource([DatabasePluginState], {
      location: join(tmpRoot, 'diff.db'),
    });
    const store = createDatabasePluginStateStore({ dataSource });
    const repository = dataSource.getRepository(DatabasePluginState);
    const originalClear = Repository.prototype.clear;
    Repository.prototype.clear = () => {
      throw new Error('clear must not be called');
    };
    try {
      await store.save(validState());
      const before = await repository.find();
      const idOf = (rows: readonly DatabasePluginState[], pluginId: string): number | undefined =>
        rows.find((row) => row.pluginId === pluginId)?.id;

      await store.save({
        version: PLUGIN_STATE_VERSION,
        plugins: {
          acme: { active: '1.2.3', enabled: true },
          tasks: { active: '2.1.0', enabled: true },
          extra: { active: '0.1.0', enabled: true, settings: { a: 1 } },
        },
      });
      const after = await repository.find();
      assert.equal(after.length, 3);
      assert.equal(idOf(after, 'acme'), idOf(before, 'acme'));
      assert.equal(idOf(after, 'tasks'), idOf(before, 'tasks'));

      await store.save({
        version: PLUGIN_STATE_VERSION,
        plugins: { tasks: { active: '2.1.0', enabled: false } },
      });
      assert.deepEqual(await store.load(), {
        version: PLUGIN_STATE_VERSION,
        plugins: { tasks: { active: '2.1.0', enabled: false } },
      });
      assert.equal(idOf(await repository.find(), 'tasks'), idOf(before, 'tasks'));
    } finally {
      Repository.prototype.clear = originalClear;
      await dataSource.destroy();
    }
  });

  it('checks for the table once per store instead of on every call', async () => {
    const dataSource = await createEmptyDataSource([DatabasePluginState], {
      location: join(tmpRoot, 'has-table.db'),
    });
    let hasTableCalls = 0;
    const createQueryRunner = dataSource.createQueryRunner.bind(dataSource);
    dataSource.createQueryRunner = (...args) => {
      const runner = createQueryRunner(...args);
      const hasTable = runner.hasTable.bind(runner);
      runner.hasTable = (table) => {
        hasTableCalls += 1;
        return hasTable(table);
      };
      return runner;
    };
    const store = createDatabasePluginStateStore({ dataSource });
    await store.load();
    await store.save(validState());
    await store.load();
    assert.equal(hasTableCalls, 1);
    await dataSource.destroy();
  });
});

describe('createDatabasePluginStateStore: missing table', () => {
  it('fails with a clear error when the table was never migrated', async () => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'missing.db'),
      entities: [DatabasePluginState],
    });
    await dataSource.initialize();

    const store = createDatabasePluginStateStore({ dataSource });
    await assert.rejects(async () => store.load(), /db:push/);
    await assert.rejects(async () => store.save(validState()), /db:push/);

    await dataSource.destroy();
  });

  it('fails on an uninitialized data source without querying', async () => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'uninitialized.db'),
      entities: [DatabasePluginState],
    });

    const store = createDatabasePluginStateStore({ dataSource });
    await assert.rejects(async () => store.load(), /must be initialized/);
  });
});

describe('pluginStateEntities', () => {
  it('lists the framework entity for app data sources', () => {
    assert.deepEqual(pluginStateEntities, [DatabasePluginState]);
  });
});
