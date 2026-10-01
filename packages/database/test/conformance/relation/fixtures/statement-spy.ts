/**
 * A spy on a data source's engine for the relation suites: while it is
 * installed, every lease taken and every statement run on one (its SQL,
 * parameters and the number of rows the driver returned) is recorded, so a
 * test can count what a load cost on the wire, not only in the ledger.
 */

import type { Conn, Engine, JsailsDataSource, SqlValue } from '../../../../src/index.js';
import { internalsOf } from '../../../../src/record/data-source.js';

/** One statement as the driver saw it. */
export interface SpiedStatement {
  readonly sql: string;
  readonly params: readonly SqlValue[];
  readonly rows: number;
}

/** What ran while the spy was installed. */
export interface StatementSpy {
  readonly leases: number;
  readonly statements: readonly SpiedStatement[];
}

/** Run `fn` with `dataSource`'s engine spied on, and resolve to its result and what ran. */
export async function spyStatements<T>(
  dataSource: JsailsDataSource,
  fn: () => Promise<T>,
): Promise<{ readonly result: T; readonly spy: StatementSpy }> {
  const engine: Engine = await internalsOf(dataSource).engine();
  const lease = engine.lease.bind(engine);
  const statements: SpiedStatement[] = [];
  let leases = 0;
  Object.defineProperty(engine, 'lease', {
    configurable: true,
    value: async (): Promise<Conn> => {
      leases += 1;
      const conn = await lease();
      return {
        dialect: conn.dialect,
        query: async (sql, params = [], options) => {
          const result = await conn.query(sql, params, options);
          statements.push({ sql, params, rows: result.rows.length });
          return result;
        },
        release: () => conn.release(),
      };
    },
  });
  try {
    const result = await fn();
    return { result, spy: { leases, statements } };
  } finally {
    Reflect.deleteProperty(engine, 'lease');
  }
}
