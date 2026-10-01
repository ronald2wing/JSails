/**
 * Loads the server drivers, which are optional peers: an app installs `pg`
 * for PostgreSQL or `mysql2` for MariaDB, and an app on SQLite installs
 * neither (node:sqlite ships with Node). Each is imported only when an engine
 * for its dialect opens, and a missing one is a value-free
 * `missing_dependency` naming the package. The loaded module is handed to
 * TypeORM through its `driver` option, so TypeORM never resolves a driver by
 * name on its own.
 */

import { createRequire } from 'node:module';

import { DatabaseError } from './database-error.js';

// Both drivers are CommonJS. They load through require, typed by the narrow
// interfaces below, so neither driver's own types (pg has none installed here)
// reach this package's declarations.
const require = createRequire(import.meta.url);

/** The surface of `pg` the engine uses directly. */
export interface PgModule {
  readonly types: {
    getTypeParser(oid: number, format?: string): (value: string) => unknown;
  };
}

/** The surface of `mysql2` the engine uses directly (TypeORM uses the rest). */
export interface Mysql2Module {
  createPool(options: unknown): unknown;
}

function isModuleNotFound(error: unknown, name: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') &&
    typeof message === 'string' &&
    message.includes(`'${name}'`)
  );
}

/**
 * Run `load` for the optional peer `name`, turning its absence into
 * `missing_dependency`. A failure inside an installed driver propagates as is.
 */
export function loadOptionalPeer<T>(name: string, load: () => unknown): T {
  try {
    return load() as T;
  } catch (error) {
    if (isModuleNotFound(error, name)) {
      throw new DatabaseError('missing_dependency', {
        dependency: name,
        suggestion: `npm install ${name}`,
      });
    }
    throw error;
  }
}

/** Import `pg`. */
export function loadPg(): PgModule {
  return loadOptionalPeer<PgModule>('pg', () => require('pg'));
}

/** Import `mysql2`. */
export function loadMysql2(): Mysql2Module {
  return loadOptionalPeer<Mysql2Module>('mysql2', () => require('mysql2'));
}
