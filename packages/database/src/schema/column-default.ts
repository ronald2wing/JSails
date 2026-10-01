/**
 * Column defaults in DDL and in introspection: how a declared default is
 * written as a literal for each dialect, how the text a server reports for a
 * default is parsed, and when the two mean the same value.
 *
 * DDL takes no bind parameters, so a default is a literal in the statement.
 * String literals double their quotes and nothing else: PostgreSQL has
 * `standard_conforming_strings` on, SQLite has no escapes, and the schema
 * session sets `NO_BACKSLASH_ESCAPES` on MariaDB, so a backslash is always
 * itself. The current instant is `CURRENT_TIMESTAMP(3)` on the servers and
 * the fixed-width ISO text the timestamp codec writes on SQLite.
 *
 * Servers print a default back in their own spelling (`'5'::integer`,
 * `1.50`, `current_timestamp(3)`), so equality is decided by the column's
 * portable type: numbers numerically, booleans as 0/1, JSON structurally,
 * times with their milliseconds, and `now` by kind.
 */

import type { Dialect, SqlValue } from '../engine/contract.js';
import type { ColumnDefaultState, PortableType } from '../model/index.js';
import { canonicalJson } from './canonical-json.js';
import type { LiveDefault } from './schema-state.js';

/** SQLite's default for a `timestamp` column: the codec's ISO text of now. */
const SQLITE_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const NOW = /^(current_timestamp(\(\s*\d*\s*\))?|now\(\)|localtimestamp(\(\s*\d*\s*\))?)$/i;
const SQLITE_NOW_PATTERN =
  /^strftime\(\s*'%Y-%m-%dT%H:%M:%fZ'\s*,\s*'now'\s*\)$|^strftime\(\s*'%Y-%m-%dT%H:%M:%f'\s*,\s*'now'\s*\)\s*\|\|\s*'Z'$/i;
/** A trailing PostgreSQL cast: `::character varying`, `::numeric(12,3)`, `::text[]`. */
const CAST = /::\s*("[^"]+"|[a-z_][a-z0-9_ ]*)(\(\s*\d+(\s*,\s*\d+)?\s*\))?(\[\])?\s*$/i;

function hex(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0');
  return text;
}

/** A SQL string literal: quotes doubled, nothing else escaped. */
export function stringLiteral(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function valueLiteral(value: SqlValue, dialect: Dialect): string {
  if (value === null) return 'NULL';
  if (typeof value === 'string') return stringLiteral(value);
  if (typeof value === 'boolean') {
    if (dialect === 'postgres') return value ? 'true' : 'false';
    return value ? '1' : '0';
  }
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return dialect === 'postgres' ? `'\\x${hex(value)}'::bytea` : `X'${hex(value)}'`;
}

/** The DDL literal of a declared default on `dialect`. */
export function defaultLiteral(state: ColumnDefaultState, dialect: Dialect): string {
  if (state.kind === 'now') {
    return dialect === 'sqlite' ? `(${SQLITE_NOW})` : 'CURRENT_TIMESTAMP(3)';
  }
  return valueLiteral(state.value, dialect);
}

/** Read a quoted literal at the start of `text`; returns its content and the rest. */
function readQuoted(
  text: string,
  backslashEscapes: boolean,
): { content: string; rest: string } | undefined {
  let content = '';
  let index = 1;
  while (index < text.length) {
    const char = text[index] as string;
    if (backslashEscapes && char === '\\' && index + 1 < text.length) {
      const next = text[index + 1] as string;
      content += next === 'n' ? '\n' : next === 't' ? '\t' : next === '0' ? '\0' : next;
      index += 2;
      continue;
    }
    if (char === "'") {
      if (text[index + 1] === "'") {
        content += "'";
        index += 2;
        continue;
      }
      return { content, rest: text.slice(index + 1) };
    }
    content += char;
    index += 1;
  }
  return undefined;
}

/** Strip parentheses that enclose the whole of `text`. */
function unwrap(text: string): string {
  let current = text.trim();
  for (;;) {
    if (!current.startsWith('(') || !current.endsWith(')')) return current;
    let depth = 0;
    let quoted = false;
    let enclosesAll = true;
    for (let index = 0; index < current.length; index += 1) {
      const char = current[index];
      if (char === "'") quoted = !quoted;
      if (quoted) continue;
      if (char === '(') depth += 1;
      if (char === ')') depth -= 1;
      if (depth === 0 && index < current.length - 1) {
        enclosesAll = false;
        break;
      }
    }
    if (!enclosesAll) return current;
    current = current.slice(1, -1).trim();
  }
}

/**
 * Parse the default text a server reports (`pg_get_expr`, MariaDB's
 * `COLUMN_DEFAULT`, SQLite's `dflt_value`). `undefined` when the column has
 * none, which includes MariaDB's `NULL` and PostgreSQL's `NULL::type`.
 */
export function parseLiveDefault(
  text: string | null | undefined,
  dialect: Dialect,
): LiveDefault | undefined {
  if (text === null || text === undefined) return undefined;
  let current = unwrap(text);
  if (dialect === 'postgres') {
    // A literal followed by casts: strip the casts.
    for (let cast = CAST.exec(current); cast !== null; cast = CAST.exec(current)) {
      current = unwrap(current.slice(0, cast.index));
    }
  }
  if (current === '' || /^null$/i.test(current)) return undefined;
  if (current.startsWith("'")) {
    const quoted = readQuoted(current, dialect === 'mariadb');
    if (quoted !== undefined && quoted.rest.trim() === '') {
      return { kind: 'literal', text: quoted.content };
    }
    return { kind: 'expression', sql: text };
  }
  const blob = /^[xX]'([0-9a-fA-F]*)'$/.exec(current);
  if (blob !== null) return { kind: 'literal', text: (blob[1] as string).toLowerCase() };
  if (NUMBER.test(current) || /^(true|false)$/i.test(current)) {
    return { kind: 'literal', text: current.toLowerCase() };
  }
  if (NOW.test(current) || SQLITE_NOW_PATTERN.test(current)) return { kind: 'now' };
  return { kind: 'expression', sql: text };
}

/** A decimal number in one spelling: no `+`, no leading or trailing zeros, `0` for zero. */
function canonicalNumber(text: string): string | undefined {
  const trimmed = text.trim();
  if (!NUMBER.test(trimmed)) return undefined;
  if (/[eE]/.test(trimmed)) return String(Number(trimmed));
  const negative = trimmed.startsWith('-');
  const unsigned = trimmed.replace(/^[+-]/, '');
  const [whole = '', fraction = ''] = unsigned.split('.');
  const integer = whole.replace(/^0+(?=\d)/, '') || '0';
  const decimals = fraction.replace(/0+$/, '');
  const body = decimals === '' ? integer : `${integer}.${decimals}`;
  return negative && /[1-9]/.test(body) ? `-${body}` : body;
}

/** One spelling of a default's text for `type`, so two spellings of one value compare equal. */
function canonical(type: PortableType, dialect: Dialect, text: string): string {
  switch (type.kind) {
    case 'id':
    case 'integer':
    case 'bigint':
    case 'float':
      return canonicalNumber(text) ?? text;
    case 'decimal':
      // SQLite stores a wide decimal as sortable text, compared as written.
      if (dialect === 'sqlite' && !NUMBER.test(text)) return text;
      return canonicalNumber(text) ?? text;
    case 'boolean': {
      const lower = text.toLowerCase();
      if (lower === 'true' || lower === 't' || lower === '1') return '1';
      if (lower === 'false' || lower === 'f' || lower === '0') return '0';
      return text;
    }
    case 'json':
      try {
        return canonicalJson(JSON.parse(text));
      } catch {
        // Not JSON: the server holds a default the type cannot carry.
        return text;
      }
    case 'time': {
      const match = /^(\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(text);
      return match === null
        ? text
        : `${match[1] as string}.${(match[2] ?? '').padEnd(3, '0').slice(0, 3)}`;
    }
    default:
      return text;
  }
}

function declaredText(value: SqlValue): string {
  if (value instanceof Uint8Array) return hex(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

/**
 * Whether a live default is the declared one for a column of portable
 * `type`. An identity column's default belongs to its generator and is not
 * compared.
 */
export function sameDefault(
  declared: ColumnDefaultState | undefined,
  live: LiveDefault | undefined,
  type: PortableType,
  dialect: Dialect,
): boolean {
  if (declared === undefined || live === undefined) return declared === live;
  if (declared.kind === 'now' || live.kind === 'now') return declared.kind === live.kind;
  if (live.kind === 'expression') return false;
  return (
    canonical(type, dialect, declaredText(declared.value)) === canonical(type, dialect, live.text)
  );
}
