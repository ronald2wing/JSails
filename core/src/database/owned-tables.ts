/**
 * Framework-owned tables that must already exist.
 *
 * A plugin that persists into its own tables (sessions, feature flags, media
 * metadata, blog content) never creates them: the app includes the plugin's
 * entities in its `JsailsDataSource` and `db:push` reconciles the schema. The
 * plugin's store opens the data source once, probes that every required table
 * exists, and fails value-free with the `db:push` hint otherwise.
 *
 * The probe is memoized on success and retried after a failure, so a request
 * costs one query rather than a schema probe plus a query, and a database that
 * is migrated later recovers without a restart. The live table list is used
 * rather than `hasTable`, which is unreliable on the sql.js driver.
 */

import type { DataSource } from 'typeorm';

/** The failure a {@link createOwnedTables} probe reports; the caller maps it to its own error class. */
export type OwnedTablesFailure = 'not_initialized' | 'missing_table';

/** Options for {@link createOwnedTables}. */
export interface OwnedTablesOptions {
  /** The data source, or a lazy getter for it. */
  readonly dataSource: DataSource | (() => DataSource);
  /** The table names that must exist. */
  readonly tables: readonly string[];
  /**
   * Whether an uninitialized source is initialized on first use. Defaults to
   * false: a store that is handed an initialized source reports
   * `not_initialized` instead of connecting on the caller's behalf.
   */
  readonly initialize?: boolean;
  /** Build the error thrown for `failure`; `table` names the missing table. */
  readonly makeError: (failure: OwnedTablesFailure, table: string | undefined) => Error;
}

/** The opened handle: a data source whose owned tables are known to exist. */
export interface OwnedTables {
  /** Resolve, initialize if configured, and verify the tables; memoized on success. */
  open(): Promise<DataSource>;
}

/** Create a memoized opener for a set of framework-owned tables. */
export function createOwnedTables(options: OwnedTablesOptions): OwnedTables {
  const { tables, makeError } = options;
  const initialize = options.initialize === true;
  let opened: Promise<DataSource> | undefined;

  async function probe(): Promise<DataSource> {
    const source =
      typeof options.dataSource === 'function' ? options.dataSource() : options.dataSource;
    if (!source.isInitialized) {
      if (!initialize) {
        throw makeError('not_initialized', undefined);
      }
      await source.initialize();
    }
    const queryRunner = source.createQueryRunner();
    try {
      await queryRunner.connect();
      const live = new Set((await queryRunner.getTables()).map((table) => table.name));
      for (const table of tables) {
        if (!live.has(table)) {
          throw makeError('missing_table', table);
        }
      }
    } finally {
      await queryRunner.release();
    }
    return source;
  }

  return {
    open(): Promise<DataSource> {
      opened ??= probe().catch((error: unknown) => {
        opened = undefined;
        throw error;
      });
      return opened;
    },
  };
}
