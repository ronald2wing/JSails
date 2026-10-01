/**
 * `unguarded(ds)`: the escape hatch to raw SQL on a data source. It returns
 * exactly two things:
 *
 * - `sql`, a tagged template: the text is SQL as written, and every
 *   interpolated value is a bound parameter (never spliced into the text),
 *   with the dialect's placeholders (`$1` on PostgreSQL, `?` elsewhere);
 * - `lease()`, a connection of the data source's engine: inside a
 *   `transaction()` it is a view of the transaction's connection, so raw
 *   work joins the ambient transaction (and a test transaction's rollback).
 *
 * Nothing on this path is guarded: no column codec encodes or decodes a
 * value, no tenant policy scopes a statement, no encryption, no record
 * logic. Rows come back as the engine returns them. Every statement `sql`
 * runs is recorded in the query ledger under the origin `unguarded`, so its
 * use stays visible. There is no ORM object here, by design.
 */

import type { Conn, QueryResult, SqlValue } from '../engine/contract.js';
import { internalsOf, type JsailsDataSource } from '../record/data-source.js';

/** The query-ledger origin of statements run through {@link Unguarded.sql}. */
export const UNGUARDED_ORIGIN = 'unguarded';

/** Raw SQL access to a data source. */
export interface Unguarded {
  /** Run one statement; interpolations are bound parameters. */
  sql(text: TemplateStringsArray, ...values: readonly SqlValue[]): Promise<QueryResult>;
  /** A connection; release it when done. Inside a transaction it joins it. */
  lease(): Promise<Conn>;
}

/**
 * Raw SQL on `dataSource`, outside every guarantee of the data layer.
 *
 * @throws `data_source.closed` (from `sql` and `lease`).
 */
export function unguarded(dataSource: JsailsDataSource): Unguarded {
  const internals = internalsOf(dataSource);
  const lease = async (): Promise<Conn> => {
    internals.assertOpen();
    const engine = await internals.engine();
    return engine.lease();
  };
  return Object.freeze({
    async sql(text: TemplateStringsArray, ...values: readonly SqlValue[]): Promise<QueryResult> {
      const placeholder =
        dataSource.dialect === 'postgres' ? (index: number) => `$${index}` : () => '?';
      let rendered = text[0] ?? '';
      for (let index = 1; index < text.length; index += 1) {
        rendered += `${placeholder(index)}${text[index] ?? ''}`;
      }
      const conn = await lease();
      try {
        return await conn.query(rendered, values, { origin: UNGUARDED_ORIGIN });
      } finally {
        await conn.release();
      }
    },
    lease,
  });
}
