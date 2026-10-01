/**
 * The planner: compares the declared tables of one owner with the live
 * schema and the ownership ledger, and produces the ordered, classified
 * operations that bring the database to the declaration.
 *
 * Ownership decides what may be touched. A declared table that does not
 * exist is created and owned. One this owner owns is reconciled column by
 * column. One nobody owns is adopted first (safe when it already matches,
 * blocking otherwise, and every change to it waits for the adoption). One
 * another owner owns is refused (`schema.owned_by_another`). A live table
 * this owner owns that is no longer declared is dropped (destructive). A
 * live table nobody owns and nothing declares is unmanaged: reported, never
 * altered or dropped. An ownership record whose table is gone is forgotten.
 *
 * Every operation gets a digest: the first 16 hex digits of the SHA-256 of
 * the operation and the introspected state of its table. Approving a digest
 * approves exactly that change to exactly that state; if the table changes
 * before the push, the digest no longer matches anything and the approval is
 * stale.
 *
 * Some operations only make sense together, so they form a unit that
 * applies whole or not at all: an index or foreign key replaced under its
 * name, or dropped to make way for a renamed equivalent, with its
 * replacement; and a foreign key dropped so a column it uses can change type,
 * with that change and the key's re-addition. A unit's drop comes first in
 * plan order, so whether a push may apply it is decided for the whole unit
 * before anything applies (`planDeferrals`): otherwise a safe or approved
 * drop would commit while its replacement waits, leaving the table without
 * the constraint.
 *
 * Order: ledger-only operations, foreign-key drops, replaced index drops,
 * table creation, column additions and changes, primary keys, SQLite
 * rebuilds, index creation, removed index drops (after creation, so a
 * MariaDB foreign key always has an index to lean on), foreign-key
 * additions, then column and table drops.
 */

import type { Dialect } from '../engine/contract.js';
import type { ColumnState, ForeignKeyState, IndexState, TableState } from '../model/index.js';
import { canonicalDigest } from './canonical-json.js';
import { sameDefault } from './column-default.js';
import { declaredDigest } from './declared-tables.js';
import { emit } from './emit.js';
import { SchemaErrors } from './schema-errors.js';
import { LEDGER_TABLE_NAMES } from './schema-ledger.js';
import type { Classification, SchemaOperation } from './schema-operation.js';
import type {
  LiveColumn,
  LiveForeignKey,
  LiveIndex,
  LiveTable,
  SchemaState,
} from './schema-state.js';

/** One operation of a plan. */
export interface PlannedOperation {
  /** 16 hex digits naming this operation on the introspected state of its table. */
  readonly digest: string;
  readonly operation: SchemaOperation;
  readonly classification: Classification;
  /** One line for people: `drop column posts.legacy`. */
  readonly summary: string;
  /** The statements `emit` produces for it. */
  readonly statements: readonly string[];
  /** Digests of the operations that must apply before this one can. */
  readonly dependsOn: readonly string[];
  /**
   * Digests of the operations this one applies together with, or not at all:
   * the other members of its unit (see the module header). Empty for most.
   */
  readonly appliesWith: readonly string[];
}

/** Why a push defers an operation. */
export type DeferralReason =
  /** Blocking or destructive, and not approved. */
  | 'approval'
  /** Safe or approved, but it depends on, or applies together with, a deferred operation. */
  | 'dependency';

/** What a push would do. */
export interface SchemaPlan {
  readonly dialect: Dialect;
  readonly owner: string;
  readonly operations: readonly PlannedOperation[];
  /** Live tables no owner has and no model declares; never touched. */
  readonly unmanaged: readonly string[];
  /** The digest of the declared tables, which a complete push records. */
  readonly declaredDigest: string;
}

/** The planner's input. */
export interface PlanInput {
  readonly dialect: Dialect;
  readonly owner: string;
  readonly declared: readonly TableState[];
  readonly live: SchemaState;
  /** Table name to owner, from `jsails_schema_objects`. */
  readonly ownership: ReadonlyMap<string, string>;
}

interface Draft {
  readonly operation: SchemaOperation;
  readonly classification: Classification;
  readonly table: string;
  /** Columns the operation adds or changes, for dependency edges. */
  readonly columns?: readonly string[];
  /** Drafts this one applies together with; the relation is symmetric and transitive. */
  readonly appliesWith?: readonly Draft[];
  readonly rank: number;
}

const RANK = {
  adopt_table: 0,
  forget_table: 1,
  drop_foreign_key: 2,
  replaced_index: 3,
  create_table: 4,
  add_column: 5,
  alter_column: 6,
  set_primary_key: 7,
  rebuild_table: 8,
  create_index: 9,
  removed_index: 10,
  add_foreign_key: 11,
  drop_column: 12,
  drop_table: 13,
} as const;

const SEVERITY: Readonly<Record<Classification, number>> = { safe: 0, blocking: 1, destructive: 2 };

function worst(...classes: readonly Classification[]): Classification {
  return classes.reduce<Classification>(
    (current, next) => (SEVERITY[next] > SEVERITY[current] ? next : current),
    'safe',
  );
}

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function foreignKeySignature(foreignKey: {
  readonly columns: readonly string[];
  readonly referencedTable: string;
  readonly referencedColumns: readonly string[];
  readonly onDelete: string;
}): string {
  return `${foreignKey.columns.join(',')}>${foreignKey.referencedTable}(${foreignKey.referencedColumns.join(',')})/${foreignKey.onDelete}`;
}

interface ParsedType {
  readonly base: string;
  readonly args: readonly number[];
}

/** `character varying(40)` -> `character varying` [40]; `timestamp(3) with time zone` keeps its suffix. */
function parseType(type: string): ParsedType {
  const match = /^([^(]*)\(([\d,\s]+)\)(.*)$/.exec(type.trim());
  if (match === null) return { base: type.trim(), args: [] };
  return {
    base: `${(match[1] as string).trim()} ${(match[3] as string).trim()}`.trim(),
    args: (match[2] as string).split(',').map((part) => Number(part.trim())),
  };
}

const INTEGER_RANK: Readonly<Record<string, number>> = {
  smallint: 1,
  int: 2,
  integer: 2,
  bigint: 3,
};
const STRING_BASES: ReadonlySet<string> = new Set(['varchar', 'character varying']);
const UNBOUNDED_STRINGS: ReadonlySet<string> = new Set(['text', 'longtext']);
const BYTE_BASES: ReadonlySet<string> = new Set(['varbinary']);
const UNBOUNDED_BYTES: ReadonlySet<string> = new Set(['longblob', 'bytea', 'blob']);

/** Whether changing a column from `from` to `to` keeps every value it can hold. */
export function isWidening(from: string, to: string): boolean {
  if (from === to) return true;
  const a = parseType(from);
  const b = parseType(to);
  const integerA = INTEGER_RANK[a.base];
  const integerB = INTEGER_RANK[b.base];
  if (integerA !== undefined && integerB !== undefined) return integerB >= integerA;
  if (STRING_BASES.has(a.base)) {
    if (UNBOUNDED_STRINGS.has(b.base)) return true;
    return STRING_BASES.has(b.base) && (b.args[0] ?? 0) >= (a.args[0] ?? 0);
  }
  if (BYTE_BASES.has(a.base) || a.base === 'binary') {
    if (UNBOUNDED_BYTES.has(b.base)) return true;
    return BYTE_BASES.has(b.base) && (b.args[0] ?? 0) >= (a.args[0] ?? 0);
  }
  if ((a.base === 'decimal' || a.base === 'numeric') && a.base === b.base) {
    const [precisionA = 0, scaleA = 0] = a.args;
    const [precisionB = 0, scaleB = 0] = b.args;
    return scaleB >= scaleA && precisionB - scaleB >= precisionA - scaleA;
  }
  if (a.base === 'real' && (b.base === 'double precision' || b.base === 'double')) return true;
  return false;
}

/** What differs between a declared and a live column, and how bad changing it is. */
function columnChange(
  column: ColumnState,
  live: LiveColumn,
  dialect: Dialect,
): { changed: boolean; classification: Classification; notes: string[] } {
  const notes: string[] = [];
  const classes: Classification[] = [];
  if (column.type !== live.type) {
    notes.push(`type ${live.type} -> ${column.type}`);
    classes.push(isWidening(live.type, column.type) ? 'blocking' : 'destructive');
  }
  if (
    dialect !== 'sqlite' &&
    column.collation !== undefined &&
    live.collation !== column.collation
  ) {
    notes.push(`collation ${live.collation ?? 'none'} -> ${column.collation}`);
    classes.push('blocking');
  }
  if (live.nullable !== column.nullable) {
    notes.push(column.nullable ? 'drop not null' : 'set not null');
    classes.push(column.nullable ? 'safe' : 'blocking');
  }
  if (live.identity !== column.identity) {
    notes.push(column.identity ? 'add identity' : 'drop identity');
    classes.push('blocking');
  }
  if (!column.identity && !sameDefault(column.default, live.default, column.portable, dialect)) {
    notes.push(column.default === undefined ? 'drop default' : 'set default');
    classes.push('safe');
  }
  if ((column.check ?? null) !== (live.check ?? null)) {
    notes.push(column.check === undefined ? 'drop json check' : 'add json check');
    classes.push(column.check === undefined ? 'safe' : 'blocking');
  }
  return { changed: notes.length > 0, classification: worst(...classes), notes };
}

function sameIndex(declared: IndexState, live: LiveIndex): boolean {
  return (
    live.valid &&
    !live.partial &&
    declared.unique === live.unique &&
    sameList(declared.columns, live.columns)
  );
}

/** MariaDB's own index for a foreign key no other index leads with, named after it. */
function implicitForeignKeyIndex(live: LiveTable, index: LiveIndex): boolean {
  return live.foreignKeys.some(
    (foreignKey) => foreignKey.name === index.name && sameList(foreignKey.columns, index.columns),
  );
}

/** A column SQLite can add with `ALTER TABLE ... ADD COLUMN`. */
function sqliteAddable(column: ColumnState): boolean {
  return (
    !column.identity &&
    column.default?.kind !== 'now' &&
    (column.nullable || column.default !== undefined)
  );
}

function indexCreation(dialect: Dialect, table: string, index: IndexState): Draft {
  const online = dialect !== 'sqlite' && !index.unique;
  return {
    operation: { kind: 'create_index', table, index, online },
    classification: online ? 'safe' : 'blocking',
    table,
    columns: index.columns,
    rank: RANK.create_index,
  };
}

/**
 * The index work of one table. A declared index whose live namesake differs
 * replaces it: the old one is dropped first (the name is reused, so the
 * creation waits for the drop through the shared columns), classified as
 * the creation is, and the two form a unit. A live index nothing declares is
 * dropped after every creation (a MariaDB foreign key always keeps an index
 * to lean on); when a declared index with its columns and uniqueness is being
 * created under another name (a rename), the drop is a unit with that
 * creation, so the table is never left without the constraint.
 */
function indexChanges(dialect: Dialect, declared: TableState, live: LiveTable): Draft[] {
  const table = declared.name;
  const drafts: Draft[] = [];
  const creations: { readonly index: IndexState; readonly draft: Draft }[] = [];
  const liveIndexes = new Map(live.indexes.map((index) => [index.name, index]));
  const declaredIndexes = new Set(declared.indexes.map((index) => index.name));
  for (const index of declared.indexes) {
    const current = liveIndexes.get(index.name);
    if (current !== undefined && sameIndex(index, current)) continue;
    const creation = indexCreation(dialect, table, index);
    creations.push({ index, draft: creation });
    if (current !== undefined) {
      drafts.push({
        operation: { kind: 'drop_index', table, index: current },
        classification: creation.classification,
        table,
        columns: index.columns,
        appliesWith: [creation],
        rank: RANK.replaced_index,
      });
    }
    drafts.push(creation);
  }
  for (const index of live.indexes) {
    if (declaredIndexes.has(index.name)) continue;
    if (dialect === 'mariadb' && implicitForeignKeyIndex(live, index)) continue;
    const renamedTo = creations
      .filter(
        (creation) =>
          creation.index.unique === index.unique && sameList(creation.index.columns, index.columns),
      )
      .map((creation) => creation.draft);
    drafts.push({
      operation: { kind: 'drop_index', table, index },
      classification: 'safe',
      table,
      appliesWith: renamedTo,
      rank: RANK.removed_index,
    });
  }
  return drafts;
}

function serverTableChanges(declared: TableState, live: LiveTable, dialect: Dialect): Draft[] {
  const drafts: Draft[] = [];
  const table = declared.name;
  const liveColumns = new Map(live.columns.map((column) => [column.name, column]));
  const declaredNames = new Set(declared.columns.map((column) => column.name));
  for (const column of declared.columns) {
    const current = liveColumns.get(column.name);
    if (current === undefined) {
      drafts.push({
        operation: { kind: 'add_column', table, column },
        classification:
          !column.identity && (column.nullable || column.default !== undefined)
            ? 'safe'
            : 'blocking',
        table,
        columns: [column.name],
        rank: RANK.add_column,
      });
      continue;
    }
    const change = columnChange(column, current, dialect);
    if (change.changed) {
      drafts.push({
        operation: { kind: 'alter_column', table, column, from: current },
        classification: change.classification,
        table,
        columns: [column.name],
        rank: RANK.alter_column,
      });
    }
  }
  for (const column of live.columns) {
    if (!declaredNames.has(column.name)) {
      drafts.push({
        operation: { kind: 'drop_column', table, column: column.name },
        classification: 'destructive',
        table,
        rank: RANK.drop_column,
      });
    }
  }
  if (!sameList(declared.primaryKey, live.primaryKey)) {
    drafts.push({
      operation: {
        kind: 'set_primary_key',
        table,
        columns: declared.primaryKey,
        hadKey: live.primaryKey.length > 0,
        ...(live.primaryKeyName === undefined ? {} : { from: live.primaryKeyName }),
      },
      classification: 'blocking',
      table,
      columns: declared.primaryKey,
      rank: RANK.set_primary_key,
    });
  }
  drafts.push(...indexChanges(dialect, declared, live));
  // A key redefined under its name (another action or target) is dropped and
  // added back as one unit, so it is never simply gone.
  const liveKeys = new Set(live.foreignKeys.map(foreignKeySignature));
  const declaredKeys = new Set(declared.foreignKeys.map(foreignKeySignature));
  const additions = new Map<string, Draft>();
  for (const foreignKey of declared.foreignKeys) {
    if (liveKeys.has(foreignKeySignature(foreignKey))) continue;
    const addition = foreignKeyAddition(table, foreignKey, 'blocking');
    additions.set(foreignKey.name, addition);
    drafts.push(addition);
  }
  for (const foreignKey of live.foreignKeys) {
    if (declaredKeys.has(foreignKeySignature(foreignKey))) continue;
    const replacement = additions.get(foreignKey.name);
    drafts.push(foreignKeyDrop(table, foreignKey, replacement === undefined ? [] : [replacement]));
  }
  return drafts;
}

function foreignKeyAddition(
  table: string,
  foreignKey: ForeignKeyState,
  classification: Classification,
): Draft {
  return {
    operation: { kind: 'add_foreign_key', table, foreignKey },
    classification,
    table,
    rank: RANK.add_foreign_key,
  };
}

function foreignKeyDrop(
  table: string,
  foreignKey: LiveForeignKey,
  appliesWith: readonly Draft[],
): Draft {
  return {
    operation: { kind: 'drop_foreign_key', table, foreignKey: foreignKey.name },
    classification: 'safe',
    table,
    appliesWith,
    rank: RANK.drop_foreign_key,
  };
}

function sqliteTableChanges(declared: TableState, live: LiveTable): Draft[] {
  const table = declared.name;
  const liveColumns = new Map(live.columns.map((column) => [column.name, column]));
  const declaredNames = new Set(declared.columns.map((column) => column.name));
  const additions: Draft[] = [];
  const rebuild: Classification[] = [];
  for (const column of declared.columns) {
    const current = liveColumns.get(column.name);
    if (current === undefined) {
      if (sqliteAddable(column)) {
        additions.push({
          operation: { kind: 'add_column', table, column },
          classification: 'safe',
          table,
          columns: [column.name],
          rank: RANK.add_column,
        });
      } else {
        rebuild.push('blocking');
      }
      continue;
    }
    const change = columnChange(column, current, 'sqlite');
    if (change.changed) rebuild.push(worst('blocking', change.classification));
  }
  if (live.columns.some((column) => !declaredNames.has(column.name))) rebuild.push('destructive');
  if (!sameList(declared.primaryKey, live.primaryKey)) rebuild.push('blocking');
  const liveKeys = new Set(live.foreignKeys.map(foreignKeySignature));
  const declaredKeys = new Set(declared.foreignKeys.map(foreignKeySignature));
  if (
    liveKeys.size !== declaredKeys.size ||
    [...declaredKeys].some((signature) => !liveKeys.has(signature))
  ) {
    rebuild.push('blocking');
  }
  if (rebuild.length > 0) {
    return [
      {
        operation: { kind: 'rebuild_table', table: declared, from: live },
        classification: worst(...rebuild),
        table,
        columns: declared.columns.map((column) => column.name),
        rank: RANK.rebuild_table,
      },
    ];
  }
  return [...additions, ...indexChanges('sqlite', declared, live)];
}

/**
 * Foreign keys that stay but involve a column whose type changes: MariaDB
 * refuses to retype a column a foreign key uses, so the key is dropped
 * before the change and added back after it. The drop, the type changes it
 * makes way for and the re-addition are one unit: the drop alone would leave
 * the key off until someone approves the rest.
 */
function reattachedForeignKeys(
  drafts: readonly Draft[],
  declared: ReadonlyMap<string, TableState>,
  live: ReadonlyMap<string, LiveTable>,
): Draft[] {
  const retyped = new Map<string, Draft>();
  for (const draft of drafts) {
    const op = draft.operation;
    if (op.kind === 'alter_column' && op.from.type !== op.column.type) {
      retyped.set(`${op.table}.${op.column.name}`, draft);
    }
  }
  if (retyped.size === 0) return [];
  const extra: Draft[] = [];
  for (const [name, table] of declared) {
    const current = live.get(name);
    if (current === undefined) continue;
    const kept = new Set(table.foreignKeys.map(foreignKeySignature));
    for (const foreignKey of current.foreignKeys) {
      const signature = foreignKeySignature(foreignKey);
      if (!kept.has(signature)) continue;
      const alters = [
        ...foreignKey.columns.map((column) => retyped.get(`${name}.${column}`)),
        ...foreignKey.referencedColumns.map((column) =>
          retyped.get(`${foreignKey.referencedTable}.${column}`),
        ),
      ].filter((draft) => draft !== undefined);
      if (alters.length === 0) continue;
      const declaredKey = table.foreignKeys.find((key) => foreignKeySignature(key) === signature);
      if (declaredKey === undefined) continue;
      const addition = foreignKeyAddition(name, declaredKey, 'blocking');
      extra.push(foreignKeyDrop(name, foreignKey, [addition, ...alters]), addition);
    }
  }
  return extra;
}

function describe(op: SchemaOperation, dialect: Dialect): string {
  switch (op.kind) {
    case 'create_table':
      return `create table ${op.table.name}`;
    case 'drop_table':
      return `drop table ${op.table}`;
    case 'adopt_table':
      return `adopt table ${op.table}`;
    case 'forget_table':
      return `forget table ${op.table} (it no longer exists)`;
    case 'add_column':
      return `add column ${op.table}.${op.column.name} ${op.column.type}`;
    case 'drop_column':
      return `drop column ${op.table}.${op.column}`;
    case 'alter_column':
      return `alter column ${op.table}.${op.column.name}: ${columnChange(op.column, op.from, dialect).notes.join(', ')}`;
    case 'create_index':
      return `create ${op.index.unique ? 'unique ' : ''}index ${op.index.name} on ${op.table} (${op.index.columns.join(', ')})`;
    case 'drop_index':
      return `drop index ${op.index.name} on ${op.table}`;
    case 'add_foreign_key':
      return `add foreign key ${op.foreignKey.name} on ${op.table} (${op.foreignKey.columns.join(', ')}) -> ${op.foreignKey.referencedTable} (${op.foreignKey.referencedColumns.join(', ')})`;
    case 'drop_foreign_key':
      return `drop foreign key ${op.foreignKey} on ${op.table}`;
    case 'set_primary_key':
      return `set primary key of ${op.table} to (${op.columns.join(', ')})`;
    case 'rebuild_table':
      return `rebuild table ${op.table.name}`;
  }
}

/** The unit of each draft: drafts joined through `appliesWith`, directly or not, share one. */
function unitsOf(drafts: readonly Draft[]): number[] {
  const position = new Map(drafts.map((draft, index) => [draft, index]));
  const parent = drafts.map((_draft, index) => index);
  const root = (index: number): number => {
    let current = index;
    while (parent[current] !== current) current = parent[current] as number;
    return current;
  };
  drafts.forEach((draft, index) => {
    for (const other of draft.appliesWith ?? []) {
      const otherIndex = position.get(other);
      if (otherIndex !== undefined) parent[root(otherIndex)] = root(index);
    }
  });
  return drafts.map((_draft, index) => root(index));
}

/**
 * Which operations of a plan a push defers, and why, given which digests
 * are approved. An unapproved blocking or destructive operation waits for
 * approval; any other operation that depends on a deferred one, or applies
 * together with one, waits with it. Decided for the whole plan before
 * anything applies, because a unit's first member applies before its last
 * is reached in plan order.
 */
export function planDeferrals(
  operations: readonly PlannedOperation[],
  approved: (digest: string) => boolean,
): ReadonlyMap<string, DeferralReason> {
  const deferred = new Map<string, DeferralReason>();
  for (const op of operations) {
    if (op.classification !== 'safe' && !approved(op.digest)) deferred.set(op.digest, 'approval');
  }
  let grew = deferred.size > 0;
  while (grew) {
    grew = false;
    for (const op of operations) {
      if (deferred.has(op.digest)) continue;
      if ([...op.dependsOn, ...op.appliesWith].some((digest) => deferred.has(digest))) {
        deferred.set(op.digest, 'dependency');
        grew = true;
      }
    }
  }
  return deferred;
}

/**
 * Plan the push of `input.declared` for `input.owner`. Throws
 * `schema.owned_by_another` when a declared table belongs to another owner.
 */
export function planSchema(input: PlanInput): SchemaPlan {
  const { dialect, owner, ownership } = input;
  const live = new Map(input.live.tables.map((table) => [table.name, table]));
  const declared = new Map(input.declared.map((table) => [table.name, table]));
  const drafts: Draft[] = [];
  const unmanaged: string[] = [];

  for (const table of input.declared) {
    const tableOwner = ownership.get(table.name);
    if (tableOwner !== undefined && tableOwner !== owner) {
      throw new SchemaErrors.Error('owned_by_another', { table: table.name, owner: tableOwner });
    }
    const current = live.get(table.name);
    if (current === undefined) {
      drafts.push({
        operation: { kind: 'create_table', table },
        classification: 'safe',
        table: table.name,
        columns: table.columns.map((column) => column.name),
        rank: RANK.create_table,
      });
      if (dialect !== 'sqlite') {
        for (const foreignKey of table.foreignKeys) {
          drafts.push(foreignKeyAddition(table.name, foreignKey, 'safe'));
        }
      }
      continue;
    }
    const changes =
      dialect === 'sqlite'
        ? sqliteTableChanges(table, current)
        : serverTableChanges(table, current, dialect);
    if (tableOwner === undefined) {
      drafts.push({
        operation: { kind: 'adopt_table', table: table.name },
        classification: changes.length === 0 ? 'safe' : 'blocking',
        table: table.name,
        rank: RANK.adopt_table,
      });
    }
    drafts.push(...changes);
  }
  if (dialect !== 'sqlite') drafts.push(...reattachedForeignKeys(drafts, declared, live));

  for (const table of input.live.tables) {
    if (declared.has(table.name) || LEDGER_TABLE_NAMES.has(table.name)) continue;
    const tableOwner = ownership.get(table.name);
    if (tableOwner === owner) {
      drafts.push({
        operation: { kind: 'drop_table', table: table.name },
        classification: 'destructive',
        table: table.name,
        rank: RANK.drop_table,
      });
    } else if (tableOwner === undefined) {
      unmanaged.push(table.name);
    }
  }
  for (const [table, tableOwner] of ownership) {
    if (tableOwner === owner && !live.has(table) && !declared.has(table)) {
      drafts.push({
        operation: { kind: 'forget_table', table },
        classification: 'safe',
        table,
        rank: RANK.forget_table,
      });
    }
  }

  drafts.sort((a, b) => a.rank - b.rank || (a.table < b.table ? -1 : a.table > b.table ? 1 : 0));
  const digests = drafts.map((draft) =>
    canonicalDigest({ operation: draft.operation, target: live.get(draft.table) ?? null }).slice(
      0,
      16,
    ),
  );
  const units = unitsOf(drafts);
  const operations = drafts.map((draft, index): PlannedOperation => {
    const dependsOn = new Set<string>();
    const adopt = drafts.findIndex(
      (other) => other.operation.kind === 'adopt_table' && other.table === draft.table,
    );
    if (adopt !== -1 && adopt !== index) dependsOn.add(digests[adopt] as string);
    const needs: { table: string; columns: readonly string[] }[] = [];
    const op = draft.operation;
    if (op.kind === 'add_foreign_key') {
      needs.push(
        { table: op.table, columns: op.foreignKey.columns },
        { table: op.foreignKey.referencedTable, columns: op.foreignKey.referencedColumns },
      );
    } else if (op.kind === 'create_index') {
      needs.push({ table: op.table, columns: op.index.columns });
    }
    for (const need of needs) {
      drafts.forEach((other, position) => {
        if (position === index || other.table !== need.table || other.rank >= draft.rank) return;
        if (other.columns?.some((column) => need.columns.includes(column)) === true) {
          dependsOn.add(digests[position] as string);
        }
      });
    }
    const unit = units[index] as number;
    const appliesWith = digests.filter(
      (_digest, position) => position !== index && units[position] === unit,
    );
    return Object.freeze({
      digest: digests[index] as string,
      operation: op,
      classification: draft.classification,
      summary: describe(op, dialect),
      statements: Object.freeze(emit(op, dialect)),
      dependsOn: Object.freeze([...dependsOn]),
      appliesWith: Object.freeze(appliesWith),
    });
  });

  return Object.freeze({
    dialect,
    owner,
    operations: Object.freeze(operations),
    unmanaged: Object.freeze(unmanaged.sort()),
    declaredDigest: declaredDigest(input.declared, dialect),
  });
}
