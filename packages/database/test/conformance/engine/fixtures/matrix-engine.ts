/**
 * An engine on a database of its own for the run's driver: a file in a fresh
 * temporary directory on SQLite, and on a server a new `jsails_m_<random>_test`
 * database from the driver matrix. The engine is closed before its database
 * or directory is removed, so a Windows run never unlinks an open file.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createEngine,
  resolveDatabaseConfig,
  type CreateEngineOptions,
  type DatabaseConfig,
  type DatabaseOptions,
  type Engine,
} from '../../../../src/engine/index.js';
import {
  createMatrixDatabase,
  lastInFirstOut,
  matrixDriver,
  matrixServer,
  matrixServerUrl,
  type MatrixLifecycle,
} from '../../../../src/testing/index.js';

/** A database for one test: its resolved config, before any engine opens it. */
export async function matrixEngineConfig(
  lifecycle: MatrixLifecycle,
  options: DatabaseOptions = {},
): Promise<DatabaseConfig> {
  if (matrixDriver() === 'sqlite') {
    const directory = mkdtempSync(join(tmpdir(), 'jsails-engine-'));
    lifecycle.after(() => rmSync(directory, { recursive: true, force: true }));
    return resolveDatabaseConfig(
      { ...options, file: join(directory, 'engine_test.sqlite') },
      { env: {} },
    );
  }
  const name = await createMatrixDatabase(lifecycle);
  return resolveDatabaseConfig(options, {
    env: { DATABASE_URL: matrixServerUrl(matrixServer(), name) },
  });
}

/**
 * An open engine on a database of its own. `lifecycle` closes the engine and
 * then removes the database.
 */
export async function openMatrixEngine(
  lifecycle: MatrixLifecycle,
  options: DatabaseOptions = {},
  engineOptions: CreateEngineOptions = {},
): Promise<Engine> {
  const ordered = lastInFirstOut(lifecycle);
  const config = await matrixEngineConfig(ordered, options);
  const engine = await createEngine(config, engineOptions);
  ordered.after(() => engine.close());
  return engine;
}

/** DDL for a table with an auto-generated integer key, per dialect. */
export function serialKey(engine: Engine): string {
  switch (engine.dialect) {
    case 'postgres':
      return 'id SERIAL PRIMARY KEY';
    case 'mariadb':
      return 'id INT AUTO_INCREMENT PRIMARY KEY';
    case 'sqlite':
      return 'id INTEGER PRIMARY KEY';
  }
}

/** Run DDL on a fresh autocommit lease. */
export async function exec(engine: Engine, ...statements: string[]): Promise<void> {
  const conn = await engine.lease();
  try {
    for (const statement of statements) await conn.query(statement);
  } finally {
    await conn.release();
  }
}
