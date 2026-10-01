/**
 * The schema operations a plan is made of: plain data, each naming its table
 * and carrying the declared state it moves to (and, where DDL needs it, the
 * live state it moves from). `emit` turns one into its dialect's statements;
 * the planner classifies and orders them.
 */

import type { ColumnState, ForeignKeyState, IndexState, TableState } from '../model/index.js';
import type { LiveColumn, LiveIndex, LiveTable } from './schema-state.js';

/**
 * How an operation can hurt a running site. `safe` is additive or loosening;
 * `blocking` may hold a lock on a populated table or fail on its data;
 * `destructive` may lose data. Only `safe` operations apply unapproved.
 */
export type Classification = 'safe' | 'blocking' | 'destructive';

export type SchemaOperation =
  /** Create a table with its indexes (and, on SQLite, its foreign keys). */
  | { readonly kind: 'create_table'; readonly table: TableState }
  | { readonly kind: 'drop_table'; readonly table: string }
  /** Record an existing, unowned table as owned; no DDL. */
  | { readonly kind: 'adopt_table'; readonly table: string }
  /** Remove the ownership record of a table that no longer exists; no DDL. */
  | { readonly kind: 'forget_table'; readonly table: string }
  | { readonly kind: 'add_column'; readonly table: string; readonly column: ColumnState }
  | { readonly kind: 'drop_column'; readonly table: string; readonly column: string }
  | {
      readonly kind: 'alter_column';
      readonly table: string;
      readonly column: ColumnState;
      readonly from: LiveColumn;
    }
  | {
      readonly kind: 'create_index';
      readonly table: string;
      readonly index: IndexState;
      /** Build without blocking writes: PostgreSQL `CONCURRENTLY`, MariaDB `LOCK=NONE`. */
      readonly online: boolean;
    }
  | { readonly kind: 'drop_index'; readonly table: string; readonly index: LiveIndex }
  | {
      readonly kind: 'add_foreign_key';
      readonly table: string;
      readonly foreignKey: ForeignKeyState;
    }
  | { readonly kind: 'drop_foreign_key'; readonly table: string; readonly foreignKey: string }
  | {
      readonly kind: 'set_primary_key';
      readonly table: string;
      readonly columns: readonly string[];
      /** The live key's constraint name (PostgreSQL), when there is a key to replace. */
      readonly from?: string;
      readonly hadKey: boolean;
    }
  /** SQLite: create the declared table beside the live one, copy, swap. */
  | { readonly kind: 'rebuild_table'; readonly table: TableState; readonly from: LiveTable };

export type SchemaOperationKind = SchemaOperation['kind'];
