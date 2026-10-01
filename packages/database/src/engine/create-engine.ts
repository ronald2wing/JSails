/**
 * Opens the engine for a resolved {@link DatabaseConfig}: SQLite through
 * node:sqlite, PostgreSQL through `pg`, MariaDB through `mysql2`. The server
 * drivers are optional peers loaded here, so an app on SQLite never imports
 * either, and TypeORM itself loads only when an engine opens. The engine
 * handed out is bound (`transaction/bound-engine.ts`): a lease taken inside a
 * transaction joins it.
 */

import { bindEngine } from '../transaction/bound-engine.js';
import type { DatabaseConfig } from './config.js';
import type { Engine } from './contract.js';
import { DatabaseError } from './database-error.js';
import { openServerEngine, type ConnectionErrorListener } from './server/server-engine.js';
import { openSqliteEngine } from './sqlite/sqlite-engine.js';

/** Options for {@link createEngine}. */
export interface CreateEngineOptions {
  /**
   * `app` (default) opens the pooled application connection. `migration`
   * opens one connection for schema changes: `config.migration` when set,
   * else the main connection, with no statement timeout, since DDL on a
   * large table may run long. SQLite has one file, so both open it.
   */
  readonly purpose?: 'app' | 'migration';
  /**
   * Receives failures of pooled connections no caller holds. Default: a
   * process warning with the value-free message.
   */
  readonly onConnectionError?: ConnectionErrorListener;
}

/**
 * Open an engine and check the server against the supported floor.
 *
 * @throws {DatabaseError} `missing_dependency` when the driver is not
 *   installed, `connection_failed` when the server cannot be reached,
 *   `unsupported_server` or `unsupported_version` for a server below the floor.
 */
export async function createEngine(
  config: DatabaseConfig,
  options: CreateEngineOptions = {},
): Promise<Engine> {
  return bindEngine(await openEngine(config, options), {
    acquireTimeoutMs: config.acquireTimeoutMs,
  });
}

async function openEngine(config: DatabaseConfig, options: CreateEngineOptions): Promise<Engine> {
  const purpose = options.purpose ?? 'app';
  if (purpose !== 'app' && purpose !== 'migration') {
    throw new DatabaseError('invalid_config', { field: 'purpose' });
  }
  if (config.dialect === 'sqlite') return openSqliteEngine(config);
  if (purpose === 'app') {
    return openServerEngine(
      config,
      options.onConnectionError === undefined
        ? {}
        : { onConnectionError: options.onConnectionError },
    );
  }
  const migrationConfig: DatabaseConfig = Object.freeze({
    ...config,
    pool: Object.freeze({ max: 1 }),
    statementTimeoutMs: 0,
  });
  const connection = config.migration ?? config.connection;
  return openServerEngine(migrationConfig, {
    ...(connection === undefined ? {} : { connection }),
    ...(options.onConnectionError === undefined
      ? {}
      : { onConnectionError: options.onConnectionError }),
  });
}
