/**
 * The first keyword of a SQL statement, past whitespace, comments and opening
 * parentheses. The engine uses it where a driver does not say what kind of
 * statement ran: to count a `RETURNING` write's rows as affected, to trust an
 * `insertId` only after an `INSERT`, and on SQLite to send reads to the
 * shared reader. It is a routing hint, never a security boundary: SQLite's
 * reader is opened read-only, so a write misrouted there fails and is retried
 * on the writer.
 */

/** Statement kinds that write rows. */
const WRITE_KEYWORDS: ReadonlySet<string> = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);

/** The upper-cased first keyword of `sql`, or `''` when there is none. */
export function leadingKeyword(sql: string): string {
  let index = 0;
  const length = sql.length;
  while (index < length) {
    const char = sql.charCodeAt(index);
    // whitespace or '('
    if (char === 0x20 || char === 0x09 || char === 0x0a || char === 0x0d || char === 0x28) {
      index += 1;
    } else if (char === 0x2d && sql.charCodeAt(index + 1) === 0x2d) {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? length : end + 1;
    } else if (char === 0x2f && sql.charCodeAt(index + 1) === 0x2a) {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? length : end + 2;
    } else {
      break;
    }
  }
  const match = /^[A-Za-z]+/.exec(sql.slice(index, index + 16));
  return match === null ? '' : match[0].toUpperCase();
}

/** Whether a statement starting with `keyword` writes rows. */
export function isWriteKeyword(keyword: string): boolean {
  return WRITE_KEYWORDS.has(keyword);
}
