/**
 * MariaDB introspection from `information_schema`, for the tables of the
 * connection's database (`DATABASE()`). `COLUMN_TYPE` is normalised to the
 * spelling `physicalTable` declares: integer display widths are dropped
 * (`int(11)` is `int`) except `tinyint(1)`, which is the boolean type. A
 * column-level `json_valid` check (what MariaDB's `JSON` alias expands to)
 * reads as `check: 'json'`. A default of `NULL` is no default.
 *
 * InnoDB creates an index for a foreign key that no index leads with, named
 * after the constraint. It is reported like any other index; the planner
 * ignores it when it is the implicit one of a live foreign key.
 */

import type { Conn, Row } from '../engine/contract.js';
import { parseLiveDefault } from './column-default.js';
import type { LiveColumn, LiveForeignKey, LiveIndex, LiveTable } from './schema-state.js';

const ORIGIN = 'schema';

const TABLES = `SELECT TABLE_NAME AS table_name FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`;

const COLUMNS = `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
  COLUMN_TYPE AS column_type, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default,
  COLLATION_NAME AS collation_name, EXTRA AS extra
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME, ORDINAL_POSITION`;

const INDEXES = `SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name,
  NON_UNIQUE AS non_unique, COLUMN_NAME AS column_name, SUB_PART AS sub_part
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`;

const FOREIGN_KEYS = `SELECT k.TABLE_NAME AS table_name, k.CONSTRAINT_NAME AS constraint_name,
  k.COLUMN_NAME AS column_name, k.REFERENCED_TABLE_NAME AS referenced_table,
  k.REFERENCED_COLUMN_NAME AS referenced_column, r.DELETE_RULE AS delete_rule
FROM information_schema.KEY_COLUMN_USAGE k
JOIN information_schema.REFERENTIAL_CONSTRAINTS r
  ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME
  AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`;

const CHECKS = `SELECT TABLE_NAME AS table_name, CHECK_CLAUSE AS check_clause
FROM information_schema.CHECK_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE()`;

const DELETE_RULES: Readonly<Record<string, LiveForeignKey['onDelete']>> = {
  'NO ACTION': 'restrict',
  RESTRICT: 'restrict',
  CASCADE: 'cascade',
  'SET NULL': 'set null',
  'SET DEFAULT': 'set default',
};

function text(row: Row, key: string): string {
  const value = row[key];
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return typeof value === 'string' ? value : String(value ?? '');
}

/** `int(11)` to `int`; `tinyint(1)` stays, being the boolean type. */
export function normalizeMariadbType(type: string): string {
  const lower = type.toLowerCase().trim();
  if (lower.startsWith('tinyint(1)')) return lower;
  return lower.replace(/^(tinyint|smallint|mediumint|int|bigint)\(\d+\)/, '$1');
}

interface IndexDraft {
  name: string;
  columns: (string | null)[];
  unique: boolean;
  partial: boolean;
}

/** Read the tables of the connection's database, or only `wanted` when given. */
export async function introspectMariadb(
  conn: Conn,
  wanted: ReadonlySet<string> | undefined,
): Promise<LiveTable[]> {
  const keep = (name: string): boolean => wanted === undefined || wanted.has(name);
  const tables = (await conn.query(TABLES, [], { origin: ORIGIN })).rows
    .map((row) => text(row, 'table_name'))
    .filter(keep)
    .sort();
  const jsonChecks = new Set<string>();
  for (const row of (await conn.query(CHECKS, [], { origin: ORIGIN })).rows) {
    const match = /^json_valid\(`([^`]+)`\)$/i.exec(text(row, 'check_clause').trim());
    if (match !== null) jsonChecks.add(`${text(row, 'table_name')}.${match[1] as string}`);
  }
  const columns = new Map<string, LiveColumn[]>(tables.map((name) => [name, []]));
  for (const row of (await conn.query(COLUMNS, [], { origin: ORIGIN })).rows) {
    const table = text(row, 'table_name');
    const list = columns.get(table);
    if (list === undefined) continue;
    const name = text(row, 'column_name');
    const identity = /\bauto_increment\b/i.test(text(row, 'extra'));
    const rawDefault = row.column_default;
    const parsed = parseLiveDefault(
      rawDefault === null || rawDefault === undefined ? null : text(row, 'column_default'),
      'mariadb',
    );
    const collation = row.collation_name;
    list.push(
      Object.freeze({
        name,
        type: normalizeMariadbType(text(row, 'column_type')),
        nullable: text(row, 'is_nullable') === 'YES',
        identity,
        ...(collation === null || collation === undefined
          ? {}
          : { collation: text(row, 'collation_name') }),
        ...(parsed === undefined || identity ? {} : { default: parsed }),
        ...(jsonChecks.has(`${table}.${name}`) ? { check: 'json' as const } : {}),
      }),
    );
  }
  const indexes = new Map<string, Map<string, IndexDraft>>();
  for (const row of (await conn.query(INDEXES, [], { origin: ORIGIN })).rows) {
    const table = text(row, 'table_name');
    if (!columns.has(table)) continue;
    let byName = indexes.get(table);
    if (byName === undefined) {
      byName = new Map();
      indexes.set(table, byName);
    }
    const name = text(row, 'index_name');
    let draft = byName.get(name);
    if (draft === undefined) {
      draft = { name, columns: [], unique: Number(row.non_unique) === 0, partial: false };
      byName.set(name, draft);
    }
    const column = row.column_name;
    draft.columns.push(column === null || column === undefined ? null : text(row, 'column_name'));
    if (row.sub_part !== null && row.sub_part !== undefined) draft.partial = true;
  }
  const foreignKeys = new Map<string, Map<string, LiveForeignKey & { columns: string[] }>>();
  for (const row of (await conn.query(FOREIGN_KEYS, [], { origin: ORIGIN })).rows) {
    const table = text(row, 'table_name');
    if (!columns.has(table)) continue;
    let byName = foreignKeys.get(table);
    if (byName === undefined) {
      byName = new Map();
      foreignKeys.set(table, byName);
    }
    const name = text(row, 'constraint_name');
    let draft = byName.get(name);
    if (draft === undefined) {
      draft = {
        name,
        columns: [],
        referencedTable: text(row, 'referenced_table'),
        referencedColumns: [],
        onDelete: DELETE_RULES[text(row, 'delete_rule').toUpperCase()] ?? 'restrict',
      };
      byName.set(name, draft);
    }
    draft.columns.push(text(row, 'column_name'));
    (draft.referencedColumns as string[]).push(text(row, 'referenced_column'));
  }

  return tables.map((name) => {
    const drafts = [...(indexes.get(name)?.values() ?? [])];
    const primary = drafts.find((draft) => draft.name === 'PRIMARY');
    return Object.freeze({
      name,
      columns: Object.freeze(columns.get(name) ?? []),
      primaryKey: Object.freeze(
        (primary?.columns ?? []).filter((column): column is string => column !== null),
      ),
      indexes: Object.freeze(
        drafts
          .filter((draft) => draft !== primary)
          .map((draft): LiveIndex =>
            Object.freeze({
              name: draft.name,
              columns: Object.freeze(draft.columns),
              unique: draft.unique,
              valid: true,
              partial: draft.partial,
              constraint: false,
            }),
          ),
      ),
      foreignKeys: Object.freeze(
        [...(foreignKeys.get(name)?.values() ?? [])].map((foreignKey) =>
          Object.freeze({
            ...foreignKey,
            columns: Object.freeze(foreignKey.columns),
            referencedColumns: Object.freeze(foreignKey.referencedColumns),
          }),
        ),
      ),
    });
  });
}
