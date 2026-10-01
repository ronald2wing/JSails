/**
 * PostgreSQL introspection from `pg_catalog`, for the tables of the current
 * schema: `format_type` spells each type as `physicalTable` declares it, an
 * identity is `attidentity`, a collation is reported for every collatable
 * column (`default` when the column has the database's), and an index carries
 * `indisvalid`, so an index a failed `CREATE INDEX CONCURRENTLY` left behind
 * is recreated rather than trusted.
 */

import type { Conn, Row } from '../engine/contract.js';
import { parseLiveDefault } from './column-default.js';
import type { LiveColumn, LiveForeignKey, LiveIndex, LiveTable } from './schema-state.js';

const ORIGIN = 'schema';

const TABLES = `SELECT c.relname AS table_name
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')`;

const COLUMNS = `SELECT c.relname AS table_name, a.attname AS column_name,
  pg_catalog.format_type(a.atttypid, a.atttypmod) AS column_type,
  a.attnotnull AS not_null, a.attidentity AS identity,
  pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expr,
  co.collname AS collation_name
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation AND a.attcollation <> 0
WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
  AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
ORDER BY c.relname, a.attnum`;

const INDEXES = `SELECT t.relname AS table_name, i.relname AS index_name,
  ix.indisunique AS is_unique, ix.indisprimary AS is_primary, ix.indisvalid AS is_valid,
  (ix.indpred IS NOT NULL) AS is_partial,
  EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con
          WHERE con.conindid = ix.indexrelid AND con.contype IN ('p', 'u', 'x')) AS is_constraint,
  pk.conname AS constraint_name,
  k.ord AS position, a.attname AS column_name
FROM pg_catalog.pg_index ix
JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
LEFT JOIN pg_catalog.pg_constraint pk ON pk.conindid = ix.indexrelid AND pk.contype = 'p'
CROSS JOIN LATERAL unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
WHERE n.nspname = current_schema() AND t.relkind IN ('r', 'p') AND k.ord <= ix.indnkeyatts
ORDER BY t.relname, i.relname, k.ord`;

const FOREIGN_KEYS = `SELECT t.relname AS table_name, con.conname AS constraint_name,
  r.relname AS referenced_table, con.confdeltype AS delete_rule,
  k.ord AS position, a.attname AS column_name, ra.attname AS referenced_column
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class t ON t.oid = con.conrelid
JOIN pg_catalog.pg_class r ON r.oid = con.confrelid
JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, refnum, ord)
JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
JOIN pg_catalog.pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.refnum
WHERE n.nspname = current_schema() AND con.contype = 'f'
ORDER BY t.relname, con.conname, k.ord`;

const DELETE_RULES: Readonly<Record<string, LiveForeignKey['onDelete']>> = {
  a: 'restrict',
  r: 'restrict',
  c: 'cascade',
  n: 'set null',
  d: 'set default',
};

function text(row: Row, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : String(value ?? '');
}

function flag(row: Row, key: string): boolean {
  const value = row[key];
  return value === true || value === 1 || value === 't';
}

interface IndexDraft {
  name: string;
  columns: (string | null)[];
  unique: boolean;
  primary: boolean;
  valid: boolean;
  partial: boolean;
  constraint: boolean;
  constraintName: string | null;
}

/** Read the tables of the current schema, or only `wanted` when given. */
export async function introspectPostgres(
  conn: Conn,
  wanted: ReadonlySet<string> | undefined,
): Promise<LiveTable[]> {
  const keep = (name: string): boolean => wanted === undefined || wanted.has(name);
  const tables = (await conn.query(TABLES, [], { origin: ORIGIN })).rows
    .map((row) => text(row, 'table_name'))
    .filter(keep);
  const columns = new Map<string, LiveColumn[]>(tables.map((name) => [name, []]));
  for (const row of (await conn.query(COLUMNS, [], { origin: ORIGIN })).rows) {
    const list = columns.get(text(row, 'table_name'));
    if (list === undefined) continue;
    const collation = row.collation_name;
    const parsed = parseLiveDefault(
      typeof row.default_expr === 'string' ? row.default_expr : null,
      'postgres',
    );
    const identity = text(row, 'identity') !== '';
    list.push(
      Object.freeze({
        name: text(row, 'column_name'),
        type: text(row, 'column_type').toLowerCase(),
        nullable: !flag(row, 'not_null'),
        identity,
        ...(typeof collation === 'string' ? { collation } : {}),
        ...(parsed === undefined || identity ? {} : { default: parsed }),
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
      draft = {
        name,
        columns: [],
        unique: flag(row, 'is_unique'),
        primary: flag(row, 'is_primary'),
        valid: flag(row, 'is_valid'),
        partial: flag(row, 'is_partial'),
        constraint: flag(row, 'is_constraint'),
        constraintName: typeof row.constraint_name === 'string' ? row.constraint_name : null,
      };
      byName.set(name, draft);
    }
    draft.columns.push(typeof row.column_name === 'string' ? row.column_name : null);
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
        onDelete: DELETE_RULES[text(row, 'delete_rule')] ?? 'restrict',
      };
      byName.set(name, draft);
    }
    draft.columns.push(text(row, 'column_name'));
    (draft.referencedColumns as string[]).push(text(row, 'referenced_column'));
  }

  return tables.map((name) => {
    const drafts = [...(indexes.get(name)?.values() ?? [])];
    const primary = drafts.find((draft) => draft.primary);
    const table: LiveTable = {
      name,
      columns: Object.freeze(columns.get(name) ?? []),
      primaryKey: Object.freeze(
        (primary?.columns ?? []).filter((column): column is string => column !== null),
      ),
      ...(primary === undefined || primary.constraintName === null
        ? {}
        : { primaryKeyName: primary.constraintName }),
      indexes: Object.freeze(
        drafts
          .filter((draft) => !draft.primary)
          .map((draft): LiveIndex =>
            Object.freeze({
              name: draft.name,
              columns: Object.freeze(draft.columns),
              unique: draft.unique,
              valid: draft.valid,
              partial: draft.partial,
              constraint: draft.constraint,
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
    };
    return Object.freeze(table);
  });
}
