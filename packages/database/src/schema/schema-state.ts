/**
 * The live schema as introspection reads it: tables in the shape of the
 * model layer's {@link TableState}, without what only a model knows (a
 * column's property, portable type and encryption). Introspection spells every
 * type, default and action the way `physicalTable` declares them, so a table
 * pushed from a model and read back compares equal field by field.
 */

import type { Dialect } from '../engine/contract.js';
import type { OnDelete } from '../model/index.js';

/** A column default as the server reports it, before it is compared with a declared one. */
export type LiveDefault =
  /** The current instant (`CURRENT_TIMESTAMP(3)`, SQLite's `strftime(... 'now')`). */
  | { readonly kind: 'now' }
  /** A literal, as text: a string literal's content, a number or keyword, a blob's hex digits. */
  | { readonly kind: 'literal'; readonly text: string }
  /** Any other expression, as the server prints it. */
  | { readonly kind: 'expression'; readonly sql: string };

export interface LiveColumn {
  readonly name: string;
  /** The column type, lowercase, in the spelling `physicalTable` uses. */
  readonly type: string;
  readonly nullable: boolean;
  /** The collation of a collatable column, where the dialect reports one. */
  readonly collation?: string;
  readonly identity: boolean;
  readonly default?: LiveDefault;
  /** MariaDB's `json_valid` check on the column. */
  readonly check?: 'json';
}

export interface LiveIndex {
  readonly name: string;
  /** Column names in key order; an expression part is `null`. */
  readonly columns: readonly (string | null)[];
  readonly unique: boolean;
  /** PostgreSQL: false after a failed `CREATE INDEX CONCURRENTLY`. */
  readonly valid: boolean;
  /** A partial or prefix index, which no declaration produces. */
  readonly partial: boolean;
  /** Backed by a constraint (PostgreSQL `UNIQUE`), dropped as a constraint. */
  readonly constraint: boolean;
}

export interface LiveForeignKey {
  readonly name: string;
  readonly columns: readonly string[];
  readonly referencedTable: string;
  readonly referencedColumns: readonly string[];
  /** `NO ACTION` reads as `restrict`: without deferral they behave the same. */
  readonly onDelete: OnDelete | 'set default';
}

export interface LiveTable {
  readonly name: string;
  readonly columns: readonly LiveColumn[];
  readonly primaryKey: readonly string[];
  /** PostgreSQL's primary-key constraint name, needed to replace the key. */
  readonly primaryKeyName?: string;
  readonly indexes: readonly LiveIndex[];
  readonly foreignKeys: readonly LiveForeignKey[];
}

/** Every table of one database (or the ones asked for), sorted by name. */
export interface SchemaState {
  readonly dialect: Dialect;
  readonly tables: readonly LiveTable[];
}
