/**
 * SQLite introspection from `sqlite_schema` and the table-valued pragmas
 * (`pragma_table_xinfo`, `pragma_index_list`, `pragma_index_info`,
 * `pragma_foreign_key_list`). Types are the declared type text, lowercased.
 *
 * Two facts live only in a table's `CREATE TABLE` text: `AUTOINCREMENT` (the
 * identity that never reuses a key) and a foreign key's constraint name. Both
 * are read from it; an unnamed foreign key gets the derived name the model
 * layer would give it. SQLite's own indexes (`sqlite_autoindex_*`, from a
 * `UNIQUE` or `PRIMARY KEY` clause) and its internal tables are left out.
 */

import type { Conn, Row } from '../engine/contract.js';
import { foreignKeyName } from '../model/index.js';
import { parseLiveDefault } from './column-default.js';
import type { LiveColumn, LiveForeignKey, LiveIndex, LiveTable } from './schema-state.js';

const ORIGIN = 'schema';

const TABLES = `SELECT name, sql FROM sqlite_schema
WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`;

const DELETE_RULES: Readonly<Record<string, LiveForeignKey['onDelete']>> = {
  'NO ACTION': 'restrict',
  RESTRICT: 'restrict',
  CASCADE: 'cascade',
  'SET NULL': 'set null',
  'SET DEFAULT': 'set default',
};

function text(row: Row, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : String(value ?? '');
}

/** An identifier as written in SQL: `"a""b"`, `` `a` ``, `[a]` or bare. */
function unquote(identifier: string): string {
  const trimmed = identifier.trim();
  const first = trimmed[0];
  if (first === '"' || first === '`') return trimmed.slice(1, -1).replaceAll(first + first, first);
  if (first === '[') return trimmed.slice(1, -1);
  return trimmed;
}

const IDENTIFIER = String.raw`("(?:[^"]|"")+"|\x60(?:[^\x60]|\x60\x60)+\x60|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)`;
const NAMED_FOREIGN_KEY = new RegExp(
  String.raw`CONSTRAINT\s+${IDENTIFIER}\s+FOREIGN\s+KEY\s*\(([^)]*)\)`,
  'gi',
);

/** Constraint names by their column list, read from a `CREATE TABLE` text. */
function foreignKeyNames(sql: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const match of sql.matchAll(NAMED_FOREIGN_KEY)) {
    const columns = (match[2] ?? '').split(',').map(unquote).join(',');
    names.set(columns, unquote(match[1] ?? ''));
  }
  return names;
}

/** Read the tables of the main database, or only `wanted` when given. */
export async function introspectSqlite(
  conn: Conn,
  wanted: ReadonlySet<string> | undefined,
): Promise<LiveTable[]> {
  const query = async (sql: string, params: readonly string[] = []): Promise<readonly Row[]> =>
    (await conn.query(sql, params, { origin: ORIGIN })).rows;
  const tables = (await query(TABLES))
    .map((row) => ({ name: text(row, 'name'), sql: text(row, 'sql') }))
    .filter((table) => wanted === undefined || wanted.has(table.name));
  const result: LiveTable[] = [];
  for (const table of tables) {
    const columnRows = await query(
      'SELECT name, type, "notnull" AS not_null, dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid',
      [table.name],
    );
    const keyed = columnRows
      .filter((row) => Number(row.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk));
    const primaryKey = keyed.map((row) => text(row, 'name'));
    const autoincrement = /\bAUTOINCREMENT\b/i.test(table.sql);
    const columns: LiveColumn[] = columnRows
      .filter((row) => Number(row.hidden) === 0)
      .map((row) => {
        const name = text(row, 'name');
        const type = text(row, 'type').toLowerCase();
        const identity =
          autoincrement && primaryKey.length === 1 && primaryKey[0] === name && type === 'integer';
        const parsed = parseLiveDefault(
          typeof row.dflt_value === 'string' ? row.dflt_value : null,
          'sqlite',
        );
        // An INTEGER PRIMARY KEY is the rowid and never NULL, whatever it declares.
        const rowid = primaryKey.length === 1 && primaryKey[0] === name && type === 'integer';
        return Object.freeze({
          name,
          type,
          nullable: Number(row.not_null) === 0 && !rowid,
          identity,
          ...(parsed === undefined ? {} : { default: parsed }),
        });
      });

    const indexes: LiveIndex[] = [];
    const indexRows = await query(
      'SELECT name, "unique" AS is_unique, origin, partial FROM pragma_index_list(?)',
      [table.name],
    );
    for (const row of indexRows) {
      if (text(row, 'origin') !== 'c') continue;
      const name = text(row, 'name');
      const parts = await query(
        'SELECT name FROM pragma_index_info(?) WHERE seqno >= 0 ORDER BY seqno',
        [name],
      );
      indexes.push(
        Object.freeze({
          name,
          columns: Object.freeze(
            parts.map((part) => (typeof part.name === 'string' ? part.name : null)),
          ),
          unique: Number(row.is_unique) === 1,
          valid: true,
          partial: Number(row.partial) === 1,
          constraint: false,
        }),
      );
    }

    const named = foreignKeyNames(table.sql);
    const keyRows = await query(
      'SELECT id, seq, "table" AS referenced_table, "from" AS column_name, "to" AS referenced_column, on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq',
      [table.name],
    );
    const drafts = new Map<
      number,
      { columns: string[]; referencedTable: string; referenced: string[]; onDelete: string }
    >();
    for (const row of keyRows) {
      const id = Number(row.id);
      let draft = drafts.get(id);
      if (draft === undefined) {
        draft = {
          columns: [],
          referencedTable: text(row, 'referenced_table'),
          referenced: [],
          onDelete: text(row, 'on_delete').toUpperCase(),
        };
        drafts.set(id, draft);
      }
      draft.columns.push(text(row, 'column_name'));
      draft.referenced.push(text(row, 'referenced_column'));
    }
    const foreignKeys: LiveForeignKey[] = [...drafts.values()].map((draft) =>
      Object.freeze({
        name: named.get(draft.columns.join(',')) ?? foreignKeyName(table.name, draft.columns),
        columns: Object.freeze(draft.columns),
        referencedTable: draft.referencedTable,
        referencedColumns: Object.freeze(draft.referenced),
        onDelete: DELETE_RULES[draft.onDelete] ?? 'restrict',
      }),
    );

    result.push(
      Object.freeze({
        name: table.name,
        columns: Object.freeze(columns),
        primaryKey: Object.freeze(primaryKey),
        indexes: Object.freeze(indexes),
        foreignKeys: Object.freeze(foreignKeys),
      }),
    );
  }
  return result;
}
