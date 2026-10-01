/**
 * Parameter binding for MariaDB. The engine talks to MariaDB over the text
 * protocol, where parameters are written into the statement before it is
 * sent. mysql2's own interpolation quotes strings with backslash escapes,
 * which are only escapes while the session's `sql_mode` lacks
 * `NO_BACKSLASH_ESCAPES`: one raw `SET sql_mode` on a pooled connection, or a
 * server configured that way, would turn a bound string into SQL. So the
 * engine writes every value itself as a token whose meaning no session
 * setting changes:
 *
 * - a string as a hexadecimal literal with a character set introducer
 *   (`_utf8mb4 X'6869'`), which has no quote or escape to break out of;
 * - binary as a hexadecimal literal (`X'00ff'`);
 * - an integer (`number` or `bigint`) as its decimal digits, so `n + ?` stays
 *   exact 64-bit arithmetic and `LIMIT ?` stays valid, and a negative one in
 *   parentheses, so `a-?` cannot become `a--1`;
 * - any other number as its shortest round-trip decimal, likewise;
 * - booleans as `TRUE`/`FALSE`, and `NULL`.
 *
 * Placeholders are the `?` outside literals, quoted identifiers and comments.
 * A `?` inside one of those, or a count that differs from the parameters
 * given, refuses the statement: mysql2's rule (every `?` in order) and the
 * server's lexer would disagree about it.
 */

import type { SqlValue } from '../contract.js';
import { DatabaseError } from '../database-error.js';

/**
 * The offsets of the `?` placeholders outside quotes and comments, or
 * `undefined` when a `?` sits inside one.
 */
export function mariadbPlaceholderOffsets(sql: string): number[] | undefined {
  const offsets: number[] = [];
  let index = 0;
  const length = sql.length;
  while (index < length) {
    const char = sql[index];
    if (char === '?') {
      offsets.push(index);
      index += 1;
    } else if (char === "'" || char === '"' || char === '`') {
      // MariaDB's default mode escapes with a backslash or a doubled quote;
      // identifiers in backticks only by doubling.
      index += 1;
      for (;;) {
        if (index >= length) return offsets;
        const inner = sql[index];
        if (inner === '?') return undefined;
        if (inner === '\\' && char !== '`') {
          index += 2;
        } else if (inner === char) {
          if (sql[index + 1] === char) index += 2;
          else {
            index += 1;
            break;
          }
        } else {
          index += 1;
        }
      }
    } else if (
      char === '#' ||
      (char === '-' && sql[index + 1] === '-' && /\s/.test(sql[index + 2] ?? ' '))
    ) {
      const end = sql.indexOf('\n', index);
      const comment = sql.slice(index, end === -1 ? length : end);
      if (comment.includes('?')) return undefined;
      index = end === -1 ? length : end + 1;
    } else if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      const comment = sql.slice(index, end === -1 ? length : end);
      if (comment.includes('?')) return undefined;
      index = end === -1 ? length : end + 2;
    } else {
      index += 1;
    }
  }
  return offsets;
}

/** The SQL token for one value; see the module header. */
export function mariadbLiteral(value: SqlValue): string {
  if (value === null) return 'NULL';
  switch (typeof value) {
    case 'boolean':
      return value ? 'TRUE' : 'FALSE';
    case 'number':
      if (!Number.isFinite(value)) throw new DatabaseError('invalid_parameter');
      // String(-0) is '0'; a negative number is parenthesised.
      return value < 0 ? `(${String(value)})` : String(value);
    case 'bigint':
      return value < 0n ? `(${value.toString()})` : value.toString();
    case 'string':
      return ` _utf8mb4 X'${Buffer.from(value, 'utf8').toString('hex')}' `;
    default:
      return `X'${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex')}'`;
  }
}

/**
 * `sql` with every placeholder replaced by its value's literal.
 *
 * @throws {DatabaseError} `invalid_statement` for a `?` inside a literal or
 *   comment, `invalid_parameter` when the counts differ.
 */
export function bindMariadbParameters(sql: string, params: readonly SqlValue[]): string {
  if (params.length === 0) return sql;
  const offsets = mariadbPlaceholderOffsets(sql);
  if (offsets === undefined) {
    throw new DatabaseError('invalid_statement', {
      field: 'sql',
      suggestion: 'a statement with parameters may not contain ? inside a literal or comment',
    });
  }
  if (offsets.length !== params.length) {
    throw new DatabaseError('invalid_parameter', { field: 'params.length' });
  }
  let bound = '';
  let from = 0;
  offsets.forEach((offset, index) => {
    bound += sql.slice(from, offset) + mariadbLiteral(params[index] as SqlValue);
    from = offset + 1;
  });
  return bound + sql.slice(from);
}
