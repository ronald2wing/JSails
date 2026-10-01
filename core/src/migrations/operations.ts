/**
 * Migration operations: the unit of change applied to a {@link SchemaState}.
 *
 * Every operation carries enough information to be inverted: destructive
 * operations retain the previous definition (the full table or column they
 * remove), and `alter_column` retains both the old and new column definitions.
 */

import {
  type CheckDefinition,
  type ColumnDefinition,
  type ForeignKeyDefinition,
  type IndexDefinition,
  MigrationError,
  type SchemaState,
  type TableDefinition,
  type UniqueDefinition,
} from './schema-types.js';
import {
  normalizeCheck,
  normalizeColumn,
  normalizeForeignKey,
  normalizeIndex,
  normalizeInheritance,
  normalizePolymorphic,
  normalizeTable,
  normalizeUnique,
} from './schema-normalize.js';
import {
  checksEqual,
  columnsEqual,
  foreignKeysEqual,
  indexesEqual,
  inheritanceEqual,
  polymorphicEqual,
  tablesEqual,
  uniquesEqual,
} from './schema-compare.js';
import { validateIdentifier } from './schema-validation.js';
import { isRecord } from '../json/shape.js';

export interface CreateTableOperation {
  readonly kind: 'create_table';
  readonly table: TableDefinition;
}

export interface DropTableOperation {
  readonly kind: 'drop_table';
  /** Full definition retained so the drop can be inverted. */
  readonly table: TableDefinition;
}

export interface AddColumnOperation {
  readonly kind: 'add_column';
  readonly table: string;
  readonly column: ColumnDefinition;
}

export interface DropColumnOperation {
  readonly kind: 'drop_column';
  readonly table: string;
  /** Full definition retained so the drop can be inverted. */
  readonly column: ColumnDefinition;
}

export interface RenameColumnOperation {
  readonly kind: 'rename_column';
  readonly table: string;
  readonly from: string;
  readonly to: string;
}

export interface RenameTableOperation {
  readonly kind: 'rename_table';
  readonly from: string;
  readonly to: string;
}
/**
 * Copy one column's values into another with a caller-owned SQL expression.
 * Emitted as the middle step of a declared column replacement: add the new
 * column nullable, copy, drop the old column, then tighten the new one. The
 * operation is state-neutral; inversion is the pair of column operations around
 * it.
 */
export interface CopyColumnOperation {
  readonly kind: 'copy_column';
  readonly table: string;
  readonly from: string;
  readonly to: string;
  /** Raw SQL expression; the caller owns its correctness and portability. */
  readonly expression: string;
}

export interface AlterColumnOperation {
  readonly kind: 'alter_column';
  readonly table: string;
  /** New definition. */
  readonly column: ColumnDefinition;
  /** Previous definition, retained so the alteration can be inverted. */
  readonly previous: ColumnDefinition;
}

/**
 * Change a table's single-table-inheritance descriptor. This is metadata-only:
 * the discriminator column is a physical column managed by column operations,
 * so no DDL is emitted. The operation exists so replay reconstructs the
 * descriptor (e.g. a new child's discriminator value) exactly.
 */
export interface AlterInheritanceOperation {
  readonly kind: 'alter_inheritance';
  readonly table: string;
  /** New descriptor, or undefined to remove inheritance metadata. */
  readonly inheritance: TableDefinition['inheritance'];
  /** Previous descriptor, retained so the alteration can be inverted. */
  readonly previous: TableDefinition['inheritance'];
}

/**
 * Change a table's polymorphic-relation descriptor. This is metadata-only:
 * the type and id columns are physical columns managed by column operations,
 * so no DDL is emitted. The operation exists so replay reconstructs the
 * descriptor (e.g. a new polymorphic target) exactly.
 */
export interface AlterPolymorphicOperation {
  readonly kind: 'alter_polymorphic';
  readonly table: string;
  /** New descriptor, or undefined to remove polymorphic metadata. */
  readonly polymorphic: TableDefinition['polymorphic'];
  /** Previous descriptor, retained so the alteration can be inverted. */
  readonly previous: TableDefinition['polymorphic'];
}

export interface AddIndexOperation {
  readonly kind: 'add_index';
  readonly table: string;
  readonly index: IndexDefinition;
}

export interface DropIndexOperation {
  readonly kind: 'drop_index';
  readonly table: string;
  /** Full definition retained so the drop can be inverted. */
  readonly index: IndexDefinition;
}

export interface AddUniqueOperation {
  readonly kind: 'add_unique';
  readonly table: string;
  readonly unique: UniqueDefinition;
}

export interface DropUniqueOperation {
  readonly kind: 'drop_unique';
  readonly table: string;
  /** Full definition retained so the drop can be inverted. */
  readonly unique: UniqueDefinition;
}

export interface AddForeignKeyOperation {
  readonly kind: 'add_fk';
  readonly table: string;
  readonly foreignKey: ForeignKeyDefinition;
}

export interface DropForeignKeyOperation {
  readonly kind: 'drop_fk';
  readonly table: string;
  /** Full definition retained so the drop can be inverted. */
  readonly foreignKey: ForeignKeyDefinition;
}

interface AddCheckOperation {
  kind: 'add_check';
  table: string;
  check: CheckDefinition;
}

interface DropCheckOperation {
  kind: 'drop_check';
  table: string;
  /** Full definition retained so the drop can be inverted. */
  check: CheckDefinition;
}

export type Operation =
  | CreateTableOperation
  | DropTableOperation
  | AddColumnOperation
  | DropColumnOperation
  | RenameColumnOperation
  | RenameTableOperation
  | CopyColumnOperation
  | AlterColumnOperation
  | AlterInheritanceOperation
  | AlterPolymorphicOperation
  | AddIndexOperation
  | DropIndexOperation
  | AddUniqueOperation
  | DropUniqueOperation
  | AddForeignKeyOperation
  | DropForeignKeyOperation
  | AddCheckOperation
  | DropCheckOperation;

/**
 * Runtime-validate an operation from untrusted data (e.g. migration JSON) and
 * return a normalized copy. Rejects unknown operation types and malformed
 * definitions.
 */
export function validateOperation(op: unknown): Operation {
  if (!isRecord(op)) {
    throw new MigrationError('invalid_operation', 'operation must be an object');
  }
  const o = op;
  switch (o.kind) {
    case 'create_table':
      return { kind: 'create_table', table: normalizeTable(o.table as TableDefinition) };
    case 'drop_table':
      return { kind: 'drop_table', table: normalizeTable(o.table as TableDefinition) };
    case 'add_column':
      return {
        kind: 'add_column',
        table: validateIdentifier(o.table),
        column: normalizeColumn(o.column as ColumnDefinition),
      };
    case 'drop_column':
      return {
        kind: 'drop_column',
        table: validateIdentifier(o.table),
        column: normalizeColumn(o.column as ColumnDefinition),
      };
    case 'rename_column':
      return {
        kind: 'rename_column',
        table: validateIdentifier(o.table),
        from: validateIdentifier(o.from),
        to: validateIdentifier(o.to),
      };
    case 'alter_column':
      return {
        kind: 'alter_column',
        table: validateIdentifier(o.table),
        column: normalizeColumn(o.column as ColumnDefinition),
        previous: normalizeColumn(o.previous as ColumnDefinition),
      };
    case 'alter_inheritance':
      return {
        kind: 'alter_inheritance',
        table: validateIdentifier(o.table),
        inheritance: normalizeInheritance(o.inheritance, String(o.table)),
        previous: normalizeInheritance(o.previous, String(o.table)),
      };
    case 'alter_polymorphic':
      return {
        kind: 'alter_polymorphic',
        table: validateIdentifier(o.table),
        polymorphic: normalizePolymorphic(o.polymorphic, String(o.table)),
        previous: normalizePolymorphic(o.previous, String(o.table)),
      };
    case 'add_index':
      return {
        kind: 'add_index',
        table: validateIdentifier(o.table),
        index: normalizeIndex(o.index as IndexDefinition),
      };
    case 'drop_index':
      return {
        kind: 'drop_index',
        table: validateIdentifier(o.table),
        index: normalizeIndex(o.index as IndexDefinition),
      };
    case 'add_unique':
      return {
        kind: 'add_unique',
        table: validateIdentifier(o.table),
        unique: normalizeUnique(o.unique as UniqueDefinition),
      };
    case 'drop_unique':
      return {
        kind: 'drop_unique',
        table: validateIdentifier(o.table),
        unique: normalizeUnique(o.unique as UniqueDefinition),
      };
    case 'rename_table':
      return {
        kind: 'rename_table',
        from: validateIdentifier(o.from),
        to: validateIdentifier(o.to),
      };
    case 'copy_column':
      return {
        kind: 'copy_column',
        table: validateIdentifier(o.table),
        from: validateIdentifier(o.from),
        to: validateIdentifier(o.to),
        expression: validateCopyExpression(o.expression),
      };
    case 'add_fk':
      return {
        kind: 'add_fk',
        table: validateIdentifier(o.table),
        foreignKey: normalizeForeignKey(o.foreignKey as ForeignKeyDefinition),
      };
    case 'drop_fk':
      return {
        kind: 'drop_fk',
        table: validateIdentifier(o.table),
        foreignKey: normalizeForeignKey(o.foreignKey as ForeignKeyDefinition),
      };
    case 'add_check':
      return {
        kind: 'add_check',
        table: validateIdentifier(o.table),
        check: normalizeCheck(o.check as CheckDefinition),
      };
    case 'drop_check':
      return {
        kind: 'drop_check',
        table: validateIdentifier(o.table),
        check: normalizeCheck(o.check as CheckDefinition),
      };
    default:
      throw new MigrationError(
        'invalid_operation',
        `unknown operation type: ${JSON.stringify(o.kind)}`,
      );
  }
}

function findTable(state: SchemaState, name: string): TableDefinition | undefined {
  return state.tables.find((table) => table.name === name);
}

function replaceTable(state: SchemaState, index: number, table: TableDefinition): SchemaState {
  const tables = state.tables.slice();
  tables[index] = table;
  return { tables };
}

/** Every index/unique column must name a real column of the table at apply time. */
function assertConstraintColumnsExist(
  table: TableDefinition,
  constraint: { name: string; columns: string[] },
  kind: string,
): void {
  const columnNames = new Set(table.columns.map((column) => column.name));
  for (const column of constraint.columns) {
    if (!columnNames.has(column)) {
      throw new MigrationError(
        'invalid_operation',
        `${kind} "${constraint.name}" in table "${table.name}" references unknown column "${column}"`,
      );
    }
  }
}

/** Validate the caller-owned copy expression; it is never echoed in errors. */
function validateCopyExpression(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MigrationError(
      'invalid_operation',
      'copy_column requires a non-empty SQL expression',
    );
  }
  return value;
}

/**
 * Locate the table an operation targets. `action` is the operation's verb
 * phrase ("add column to table", "drop index from table"), so the failure
 * reads as the operation the caller attempted.
 */
function requireTable(
  state: SchemaState,
  name: string,
  action: string,
): { readonly index: number; readonly table: TableDefinition } {
  const index = state.tables.findIndex((table) => table.name === name);
  if (index === -1) {
    throw new MigrationError('invalid_operation', `cannot ${action} "${name}": it does not exist`);
  }
  return { index, table: state.tables[index] as TableDefinition };
}

function applyCreateTable(state: SchemaState, op: CreateTableOperation): SchemaState {
  if (findTable(state, op.table.name)) {
    throw new MigrationError(
      'invalid_operation',
      `cannot create table "${op.table.name}": it already exists`,
    );
  }
  return { tables: [...state.tables, normalizeTable(op.table)] };
}

function applyDropTable(state: SchemaState, op: DropTableOperation): SchemaState {
  const index = state.tables.findIndex((table) => table.name === op.table.name);
  if (index === -1) {
    throw new MigrationError(
      'invalid_operation',
      `cannot drop table "${op.table.name}": it does not exist`,
    );
  }
  const current = state.tables[index] as TableDefinition;
  if (!tablesEqual(current, op.table)) {
    throw new MigrationError(
      'invalid_operation',
      `cannot drop table "${op.table.name}": recorded definition does not match state`,
    );
  }
  return { tables: state.tables.filter((_, i) => i !== index) };
}

function applyAddColumn(state: SchemaState, op: AddColumnOperation): SchemaState {
  const { index, table } = requireTable(state, op.table, 'add column to table');
  if (table.columns.some((column) => column.name === op.column.name)) {
    throw new MigrationError(
      'invalid_operation',
      `cannot add column "${op.column.name}" to table "${op.table}": it already exists`,
    );
  }
  const column = normalizeColumn(op.column);
  return replaceTable(state, index, { ...table, columns: [...table.columns, column] });
}

function applyDropColumn(state: SchemaState, op: DropColumnOperation): SchemaState {
  const { index, table } = requireTable(state, op.table, 'drop column from table');
  const columnIndex = table.columns.findIndex((column) => column.name === op.column.name);
  if (columnIndex === -1) {
    throw new MigrationError(
      'invalid_operation',
      `cannot drop column "${op.column.name}" from table "${op.table}": it does not exist`,
    );
  }
  const current = table.columns[columnIndex] as ColumnDefinition;
  if (!columnsEqual(current, op.column)) {
    throw new MigrationError(
      'invalid_operation',
      `cannot drop column "${op.column.name}" from table "${op.table}": recorded definition does not match state`,
    );
  }
  return replaceTable(state, index, {
    ...table,
    columns: table.columns.filter((_, i) => i !== columnIndex),
  });
}

function applyRenameColumn(state: SchemaState, op: RenameColumnOperation): SchemaState {
  const { index, table } = requireTable(state, op.table, 'rename column in table');
  if (!table.columns.some((column) => column.name === op.from)) {
    throw new MigrationError(
      'invalid_operation',
      `cannot rename column "${op.from}" in table "${op.table}": it does not exist`,
    );
  }
  if (table.columns.some((column) => column.name === op.to)) {
    throw new MigrationError(
      'invalid_operation',
      `cannot rename column to "${op.to}" in table "${op.table}": it already exists`,
    );
  }
  const columns = table.columns.map((column) =>
    column.name === op.from ? { ...column, name: op.to } : column,
  );
  // A rename also rewrites any index/unique reference to the old name so the
  // constraints keep pointing at the same physical column.
  const renameIn = <T extends { columns: string[] }>(constraint: T): T => ({
    ...constraint,
    columns: constraint.columns.map((column) => (column === op.from ? op.to : column)),
  });
  // A foreign key's local columns live on this table; its referenced columns
  // live on whatever table it points at, so the referenced side is rewritten
  // across the whole schema below.
  const renamed: TableDefinition = { ...table, columns };
  if (table.indexes) {
    renamed.indexes = table.indexes.map(renameIn);
  }
  if (table.uniques) {
    renamed.uniques = table.uniques.map(renameIn);
  }
  if (table.foreignKeys) {
    renamed.foreignKeys = table.foreignKeys.map((foreignKey) => renameIn(foreignKey));
  }
  // Cross-table: any foreign key on another table referencing this table's
  // renamed column must follow the rename. The renamed table itself replaces
  // its previous definition (carrying the rewritten constraints).
  const tables = state.tables.map((other, otherIndex) => {
    if (otherIndex === index) {
      return renamed;
    }
    if (other.foreignKeys === undefined) {
      return other;
    }
    const foreignKeys = other.foreignKeys.map((foreignKey) =>
      foreignKey.referencedTable === op.table
        ? {
            ...foreignKey,
            referencedColumns: foreignKey.referencedColumns.map((column) =>
              column === op.from ? op.to : column,
            ),
          }
        : foreignKey,
    );
    return { ...other, foreignKeys };
  });
  return { tables };
}

function applyRenameTable(state: SchemaState, op: RenameTableOperation): SchemaState {
  if (op.from === op.to) {
    throw new MigrationError('invalid_operation', `cannot rename table "${op.from}" to itself`);
  }
  const index = state.tables.findIndex((table) => table.name === op.from);
  if (index === -1) {
    throw new MigrationError(
      'invalid_operation',
      `cannot rename table "${op.from}": it does not exist`,
    );
  }
  if (findTable(state, op.to)) {
    throw new MigrationError(
      'invalid_operation',
      `cannot rename table to "${op.to}": it already exists`,
    );
  }
  const source = state.tables[index] as TableDefinition;
  const renamed: TableDefinition = { ...source, name: op.to };
  // Rewrite every foreign key referencing the old table name across all tables.
  const tables = state.tables.map((other, otherIndex) => {
    if (otherIndex === index) {
      return renamed;
    }
    if (other.foreignKeys === undefined) {
      return other;
    }
    const foreignKeys = other.foreignKeys.map((foreignKey) =>
      foreignKey.referencedTable === op.from
        ? { ...foreignKey, referencedTable: op.to }
        : foreignKey,
    );
    return { ...other, foreignKeys };
  });
  return { tables };
}

function applyAlterColumn(state: SchemaState, op: AlterColumnOperation): SchemaState {
  const { index, table } = requireTable(state, op.table, 'alter column in table');
  const columnIndex = table.columns.findIndex((column) => column.name === op.column.name);
  if (columnIndex === -1) {
    throw new MigrationError(
      'invalid_operation',
      `cannot alter column "${op.column.name}" in table "${op.table}": it does not exist`,
    );
  }
  const current = table.columns[columnIndex] as ColumnDefinition;
  if (!columnsEqual(current, op.previous)) {
    throw new MigrationError(
      'invalid_operation',
      `cannot alter column "${op.column.name}" in table "${op.table}": previous definition does not match state`,
    );
  }
  const columns = table.columns.slice();
  columns[columnIndex] = normalizeColumn(op.column);
  return replaceTable(state, index, { ...table, columns });
}

function applyAlterInheritance(state: SchemaState, op: AlterInheritanceOperation): SchemaState {
  const { index, table } = requireTable(state, op.table, 'alter inheritance on table');
  if (!inheritanceEqual(table.inheritance, op.previous)) {
    throw new MigrationError(
      'invalid_operation',
      `cannot alter inheritance on table "${op.table}": previous descriptor does not match state`,
    );
  }
  const updated: TableDefinition = { ...table };
  if (op.inheritance === undefined) {
    delete updated.inheritance;
  } else {
    updated.inheritance = normalizeInheritance(
      op.inheritance,
      op.table,
      new Set(table.columns.map((column) => column.name)),
    );
  }
  return replaceTable(state, index, updated);
}

function applyAlterPolymorphic(state: SchemaState, op: AlterPolymorphicOperation): SchemaState {
  const { index, table } = requireTable(state, op.table, 'alter polymorphic descriptor on table');
  if (!polymorphicEqual(table.polymorphic, op.previous)) {
    throw new MigrationError(
      'invalid_operation',
      `cannot alter polymorphic descriptor on table "${op.table}": previous descriptor does not match state`,
    );
  }
  const updated: TableDefinition = { ...table };
  if (op.polymorphic === undefined) {
    delete updated.polymorphic;
  } else {
    const columnNames = new Set(table.columns.map((column) => column.name));
    updated.polymorphic = normalizePolymorphic(op.polymorphic, op.table, columnNames);
  }
  return replaceTable(state, index, updated);
}

function applyCopyColumn(state: SchemaState, op: CopyColumnOperation): SchemaState {
  const { table } = requireTable(state, op.table, 'copy column in table');
  if (!table.columns.some((column) => column.name === op.from)) {
    throw new MigrationError(
      'invalid_operation',
      `cannot copy column "${op.from}" in table "${op.table}": it does not exist`,
    );
  }
  if (!table.columns.some((column) => column.name === op.to)) {
    throw new MigrationError(
      'invalid_operation',
      `cannot copy into column "${op.to}" in table "${op.table}": it does not exist`,
    );
  }
  if (op.from === op.to) {
    throw new MigrationError('invalid_operation', 'copy_column source and target must differ');
  }
  return state;
}

function applyAddIndex(state: SchemaState, op: AddIndexOperation): SchemaState {
  const { index, table } = requireTable(state, op.table, 'add index to table');
  if ((table.indexes ?? []).some((existing) => existing.name === op.index.name)) {
    throw new MigrationError(
      'invalid_operation',
      `cannot add index "${op.index.name}" to table "${op.table}": it already exists`,
    );
  }
  const normalized = normalizeIndex(op.index);
  assertConstraintColumnsExist(table, normalized, 'index');
  const updated: TableDefinition = {
    ...table,
    columns: table.columns,
    indexes: [...(table.indexes ?? []), normalized],
  };
  return replaceTable(state, index, updated);
}

function applyDropIndex(state: SchemaState, op: DropIndexOperation): SchemaState {
  const { index, table } = requireTable(state, op.table, 'drop index from table');
  const current = (table.indexes ?? []).find((existing) => existing.name === op.index.name);
  if (current === undefined) {
    throw new MigrationError(
      'invalid_operation',
      `cannot drop index "${op.index.name}" from table "${op.table}": it does not exist`,
    );
  }
  if (!indexesEqual(current, op.index)) {
    throw new MigrationError(
      'invalid_operation',
      `cannot drop index "${op.index.name}" from table "${op.table}": recorded definition does not match state`,
    );
  }
  const indexes = (table.indexes ?? []).filter((existing) => existing.name !== op.index.name);
  const updated: TableDefinition = { ...table, columns: table.columns };
  if (indexes.length > 0) {
    updated.indexes = indexes;
  } else {
    delete updated.indexes;
  }
  return replaceTable(state, index, updated);
}

function applyAddUnique(state: SchemaState, op: AddUniqueOperation): SchemaState {
  const { index, table } = requireTable(state, op.table, 'add unique constraint to table');
  if ((table.uniques ?? []).some((existing) => existing.name === op.unique.name)) {
    throw new MigrationError(
      'invalid_operation',
      `cannot add unique constraint "${op.unique.name}" to table "${op.table}": it already exists`,
    );
  }
  const normalized = normalizeUnique(op.unique);
  assertConstraintColumnsExist(table, normalized, 'unique constraint');
  const updated: TableDefinition = {
    ...table,
    columns: table.columns,
    uniques: [...(table.uniques ?? []), normalized],
  };
  return replaceTable(state, index, updated);
}

function applyDropUnique(state: SchemaState, op: DropUniqueOperation): SchemaState {
  const { index, table } = requireTable(state, op.table, 'drop unique constraint from table');
  const current = (table.uniques ?? []).find((existing) => existing.name === op.unique.name);
  if (current === undefined) {
    throw new MigrationError(
      'invalid_operation',
      `cannot drop unique constraint "${op.unique.name}" from table "${op.table}": it does not exist`,
    );
  }
  if (!uniquesEqual(current, op.unique)) {
    throw new MigrationError(
      'invalid_operation',
      `cannot drop unique constraint "${op.unique.name}" from table "${op.table}": recorded definition does not match state`,
    );
  }
  const uniques = (table.uniques ?? []).filter((existing) => existing.name !== op.unique.name);
  const updated: TableDefinition = { ...table, columns: table.columns };
  if (uniques.length > 0) {
    updated.uniques = uniques;
  } else {
    delete updated.uniques;
  }
  return replaceTable(state, index, updated);
}

function applyAddFk(state: SchemaState, op: AddForeignKeyOperation): SchemaState {
  const { index, table } = requireTable(state, op.table, 'add foreign key to table');
  if ((table.foreignKeys ?? []).some((existing) => existing.name === op.foreignKey.name)) {
    throw new MigrationError(
      'invalid_operation',
      `cannot add foreign key "${op.foreignKey.name}" to table "${op.table}": it already exists`,
    );
  }
  const normalized = normalizeForeignKey(op.foreignKey);
  assertConstraintColumnsExist(table, normalized, 'foreign key');

  const referenced = findTable(state, normalized.referencedTable);
  if (referenced === undefined) {
    throw new MigrationError(
      'invalid_operation',
      `cannot add foreign key "${normalized.name}" to table "${op.table}": it references ` +
        `unknown table "${normalized.referencedTable}"`,
    );
  }
  const referencedColumns = new Set(referenced.columns.map((column) => column.name));
  for (const column of normalized.referencedColumns) {
    if (!referencedColumns.has(column)) {
      throw new MigrationError(
        'invalid_operation',
        `cannot add foreign key "${normalized.name}" to table "${op.table}": it references ` +
          `unknown column "${normalized.referencedTable}.${column}"`,
      );
    }
  }

  const updated: TableDefinition = {
    ...table,
    columns: table.columns,
    foreignKeys: [...(table.foreignKeys ?? []), normalized],
  };
  return replaceTable(state, index, updated);
}

function applyDropFk(state: SchemaState, op: DropForeignKeyOperation): SchemaState {
  const { index, table } = requireTable(state, op.table, 'drop foreign key from table');
  const current = (table.foreignKeys ?? []).find(
    (existing) => existing.name === op.foreignKey.name,
  );
  if (current === undefined) {
    throw new MigrationError(
      'invalid_operation',
      `cannot drop foreign key "${op.foreignKey.name}" from table "${op.table}": it does not exist`,
    );
  }
  if (!foreignKeysEqual(current, op.foreignKey)) {
    throw new MigrationError(
      'invalid_operation',
      `cannot drop foreign key "${op.foreignKey.name}" from table "${op.table}": recorded definition does not match state`,
    );
  }
  const foreignKeys = (table.foreignKeys ?? []).filter(
    (existing) => existing.name !== op.foreignKey.name,
  );
  const updated: TableDefinition = { ...table, columns: table.columns };
  if (foreignKeys.length > 0) {
    updated.foreignKeys = foreignKeys;
  } else {
    delete updated.foreignKeys;
  }
  return replaceTable(state, index, updated);
}

function applyAddCheck(state: SchemaState, op: AddCheckOperation): SchemaState {
  const { index, table } = requireTable(state, op.table, 'add check constraint to table');
  if ((table.checks ?? []).some((existing) => existing.name === op.check.name)) {
    throw new MigrationError(
      'invalid_operation',
      `cannot add check constraint "${op.check.name}" to table "${op.table}": it already exists`,
    );
  }
  const normalized = normalizeCheck(op.check);
  const updated: TableDefinition = {
    ...table,
    columns: table.columns,
    checks: [...(table.checks ?? []), normalized],
  };
  return replaceTable(state, index, updated);
}

function applyDropCheck(state: SchemaState, op: DropCheckOperation): SchemaState {
  const { index, table } = requireTable(state, op.table, 'drop check constraint from table');
  const currentCheck = (table.checks ?? []).find((existing) => existing.name === op.check.name);
  if (currentCheck === undefined) {
    throw new MigrationError(
      'invalid_operation',
      `cannot drop check constraint "${op.check.name}" from table "${op.table}": it does not exist`,
    );
  }
  if (!checksEqual(currentCheck, op.check)) {
    throw new MigrationError(
      'invalid_operation',
      `cannot drop check constraint "${op.check.name}" from table "${op.table}": recorded definition does not match state`,
    );
  }
  const checkList = (table.checks ?? []).filter((existing) => existing.name !== op.check.name);
  const updated: TableDefinition = { ...table, columns: table.columns };
  if (checkList.length > 0) {
    updated.checks = checkList;
  } else {
    delete updated.checks;
  }
  return replaceTable(state, index, updated);
}

/** One pure applier per operation kind; {@link applyOperation} dispatches on `kind`. */
const OPERATION_APPLIERS: {
  readonly [K in Operation['kind']]: (
    state: SchemaState,
    op: Extract<Operation, { kind: K }>,
  ) => SchemaState;
} = Object.freeze({
  create_table: applyCreateTable,
  drop_table: applyDropTable,
  add_column: applyAddColumn,
  drop_column: applyDropColumn,
  rename_column: applyRenameColumn,
  rename_table: applyRenameTable,
  alter_column: applyAlterColumn,
  alter_inheritance: applyAlterInheritance,
  alter_polymorphic: applyAlterPolymorphic,
  copy_column: applyCopyColumn,
  add_index: applyAddIndex,
  drop_index: applyDropIndex,
  add_unique: applyAddUnique,
  drop_unique: applyDropUnique,
  add_fk: applyAddFk,
  drop_fk: applyDropFk,
  add_check: applyAddCheck,
  drop_check: applyDropCheck,
});

/**
 * Apply a single operation to a schema state, returning a new state. The input
 * is never mutated. Preconditions (existence, uniqueness, recorded-definition
 * agreement) are validated and throw {@link MigrationError} on violation.
 */
export function applyOperation(state: SchemaState, op: Operation): SchemaState {
  if (!Object.hasOwn(OPERATION_APPLIERS, op.kind)) {
    throw new MigrationError(
      'invalid_operation',
      `unknown operation type: ${JSON.stringify(op.kind)}`,
    );
  }
  const apply = OPERATION_APPLIERS[op.kind] as (state: SchemaState, op: Operation) => SchemaState;
  return apply(state, op);
}

/** Apply operations in order, folding over {@link applyOperation}. */
export function applyOperations(state: SchemaState, operations: Operation[]): SchemaState {
  return operations.reduce(applyOperation, state);
}
