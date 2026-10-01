/**
 * Database-backed {@link ConfigStore} over the framework-owned `jsails_config`
 * table, through the injected TypeORM data source's repository: no raw SQL and
 * no runtime DDL.
 *
 * The data source may be passed initialized, or as a `getDataSource` thunk
 * that the store initializes on first use, so an app config can build the
 * store without connecting. A missing table fails with a value-free
 * `missing_table` telling the caller to run `db:push`. `write` replaces every
 * given set inside one transaction, so an import is all-or-nothing. `close`
 * destroys the source only when this store initialized it; a CLI command calls
 * it so the process can exit, and a closed store is not reused.
 */

import type { DataSource } from 'typeorm';
import { createOwnedTables } from 'jsails/plugin-sdk';

import { ConfigError } from './config-error.js';
import { CONFIG_TABLE, JsailsConfigEntry } from './entities.js';
import { cloneValues, type ConfigStore } from './store.js';

/** Options for {@link createDatabaseConfigStore}; give one of the two sources. */
export interface DatabaseConfigStoreOptions {
  /** An initialized data source. */
  readonly dataSource?: DataSource;
  /** A thunk returning the data source; it is initialized on first use. */
  readonly getDataSource?: () => DataSource;
  /** Clock stamping `updatedAt`. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/** Create a database-backed config store. */
export function createDatabaseConfigStore(options: DatabaseConfigStoreOptions): ConfigStore {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new ConfigError(
      'invalid_options',
      'createDatabaseConfigStore requires an options object',
    );
  }
  const { dataSource, getDataSource } = options;
  if ((dataSource === undefined) === (getDataSource === undefined)) {
    throw new ConfigError('invalid_options', 'give exactly one of dataSource or getDataSource');
  }
  if (getDataSource !== undefined && typeof getDataSource !== 'function') {
    throw new ConfigError('invalid_options', 'getDataSource must be a function');
  }
  const now = options.now ?? (() => new Date());
  const tables = createOwnedTables({
    dataSource: getDataSource ?? (dataSource as DataSource),
    tables: [CONFIG_TABLE],
    initialize: getDataSource !== undefined,
    makeError: (failure) =>
      failure === 'not_initialized'
        ? new ConfigError('not_initialized', 'the config data source must be initialized')
        : new ConfigError(
            'missing_table',
            'the jsails_config table does not exist; run db:push to create it',
          ),
  });
  let opened: DataSource | undefined;
  // Whether this store initialized the source, which makes closing it ours.
  let initializedHere = false;

  async function open(): Promise<DataSource> {
    if (opened === undefined && getDataSource !== undefined) {
      initializedHere = !getDataSource().isInitialized;
    }
    opened = await tables.open();
    return opened;
  }

  return {
    async read(name) {
      const source = await open();
      const row = await source.getRepository(JsailsConfigEntry).findOneBy({ name });
      return row === null ? undefined : cloneValues(row.values);
    },

    async write(entries) {
      if (entries.length === 0) return;
      const source = await open();
      const stamp = now();
      await source.transaction(async (manager) => {
        const repository = manager.getRepository(JsailsConfigEntry);
        for (const entry of entries) {
          const values = cloneValues(entry.values);
          const existing = await repository.findOneBy({ name: entry.name });
          if (existing === null) {
            await repository.save(
              repository.create({ name: entry.name, values, updatedAt: stamp }),
            );
          } else {
            existing.values = values;
            existing.updatedAt = stamp;
            await repository.save(existing);
          }
        }
      });
    },

    async close() {
      // Only a source this store initialized is its to close.
      if (initializedHere && opened?.isInitialized === true) {
        await opened.destroy();
      }
      opened = undefined;
      initializedHere = false;
    },
  };
}
