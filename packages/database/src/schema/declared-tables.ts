/**
 * The declared side of a push: `physicalTable` over a source's models, checked
 * for what only a set of models can get wrong (two models on one table, a
 * model on a ledger table), and the digest of the result that a push records
 * and the boot check compares.
 *
 * The digest covers what the database holds, not how code maps it: table,
 * column, key, index and foreign-key names and definitions. A renamed
 * property or a reordered column does not change it, so it never asks for a
 * push the database does not need.
 */

import type { Dialect } from '../engine/contract.js';
import { physicalTable, type ModelTarget, type TableState } from '../model/index.js';
import { canonicalDigest } from './canonical-json.js';
import { SchemaErrors } from './schema-errors.js';
import { LEDGER_TABLE_NAMES } from './schema-ledger.js';

/** Lower every model of a source; throws on a shared or reserved table name. */
export function declaredTables(models: readonly ModelTarget[], dialect: Dialect): TableState[] {
  if (!Array.isArray(models)) throw new SchemaErrors.Error('invalid_source', { field: 'models' });
  const tables = new Map<string, TableState>();
  for (const model of models) {
    const table = physicalTable(model, dialect);
    if (LEDGER_TABLE_NAMES.has(table.name)) {
      throw new SchemaErrors.Error('reserved_table', { table: table.name });
    }
    if (tables.has(table.name)) {
      throw new SchemaErrors.Error('duplicate_table', { table: table.name });
    }
    tables.set(table.name, table);
  }
  return [...tables.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const byName = <T extends { readonly name: string }>(a: T, b: T): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** The physical facts of `table` the digest covers. */
function physicalFacts(table: TableState): unknown {
  return {
    name: table.name,
    columns: [...table.columns].sort(byName).map((column) => ({
      name: column.name,
      type: column.type,
      nullable: column.nullable,
      collation: column.collation,
      identity: column.identity,
      default: column.default,
      check: column.check,
    })),
    primaryKey: table.primaryKey,
    indexes: [...table.indexes]
      .sort(byName)
      .map((index) => ({ name: index.name, columns: index.columns, unique: index.unique })),
    foreignKeys: [...table.foreignKeys].sort(byName).map((foreignKey) => ({
      name: foreignKey.name,
      columns: foreignKey.columns,
      referencedTable: foreignKey.referencedTable,
      referencedColumns: foreignKey.referencedColumns,
      onDelete: foreignKey.onDelete,
    })),
  };
}

/** The SHA-256 (hex) of the declared tables' physical facts. */
export function declaredDigest(tables: readonly TableState[], dialect: Dialect): string {
  return canonicalDigest({ dialect, tables: [...tables].sort(byName).map(physicalFacts) });
}

/** The digest a push of `models` records on `dialect`: what the boot check expects to find. */
export function schemaDigest(models: readonly ModelTarget[], dialect: Dialect): string {
  return declaredDigest(declaredTables(models, dialect), dialect);
}
