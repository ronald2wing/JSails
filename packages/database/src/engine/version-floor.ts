/**
 * The oldest servers the engine supports, checked when an engine opens:
 * MariaDB 10.6 (`INSERT ... RETURNING`, `SKIP LOCKED`, window functions),
 * PostgreSQL 14, and SQLite 3.35 (`RETURNING`), which every supported Node
 * bundles. A MySQL server answering on the MariaDB wire is refused outright.
 */

import type { Dialect } from './contract.js';
import { DatabaseError } from './database-error.js';

/** The supported floor per dialect, as `[major, minor]`. */
export const VERSION_FLOORS: Readonly<Record<Dialect, readonly [number, number]>> = Object.freeze({
  mariadb: [10, 6] as const,
  postgres: [14, 0] as const,
  sqlite: [3, 35] as const,
});

function parse(version: string): readonly [number, number] | undefined {
  const match = /^(\d+)\.(\d+)/.exec(version.trim());
  return match === null ? undefined : [Number(match[1]), Number(match[2])];
}

/**
 * Check a server's reported version string against the floor: `SELECT
 * VERSION()` on MariaDB, `SHOW server_version` on PostgreSQL, and
 * `sqlite_version()` on SQLite.
 *
 * @throws {DatabaseError} `unsupported_server` for a non-MariaDB server on the
 *   MariaDB dialect, `unsupported_version` below the floor.
 */
export function assertVersionFloor(dialect: Dialect, version: string): void {
  if (dialect === 'mariadb' && !/mariadb/i.test(version)) {
    throw new DatabaseError('unsupported_server', {
      suggestion: 'JSails supports MariaDB, PostgreSQL and SQLite; MySQL is not supported',
    });
  }
  const parsed = parse(version);
  const [floorMajor, floorMinor] = VERSION_FLOORS[dialect];
  if (
    parsed === undefined ||
    parsed[0] < floorMajor ||
    (parsed[0] === floorMajor && parsed[1] < floorMinor)
  ) {
    throw new DatabaseError('unsupported_version', {
      field: dialect,
      suggestion: `upgrade to ${dialect} ${floorMajor}.${floorMinor} or newer`,
    });
  }
}
