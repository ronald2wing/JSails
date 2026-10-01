/**
 * Desired-state schema reconciler: compare the declared model schema against the
 * live database and emit the operations needed to reach the desired state.
 *
 * ## Why desired-state
 *
 * A desired-state engine compares two snapshots — the declared model schema
 * and the live database — so no history file and no linear chain of applied
 * operations are needed. This is the Magento-2 model: the codebase declares
 * the shape the database must have, and the reconciler computes the shortest
 * plan from the live state to that shape. The differ itself (`diffSchemas` in
 * the autodetector) is reused unchanged; only the source of `current` changes.
 *
 * ## Rename hints
 *
 * `buildSchemaPlan` leaves `rename` hints undefined so the differ performs a
 * pure add/drop comparison. {@link reconcileDataSource} populates them from the
 * model registry via {@link buildRenameHintsFromRegistry} when the caller has
 * not supplied them, so a `@jsails.renamedFrom('old')` marker on a declared
 * model column automatically produces a `rename_column` instead of a
 * drop+add pair.
 */

import { normalizeSchemaState } from './schema-normalize.js';
import { diffSchemaStates, type AutodetectOptions } from './autodetector.js';
import type { Operation } from './operations.js';
import type { ColumnDefinition } from './schema-types.js';
import type { SchemaState } from './schema-types.js';
import {
  buildColumnReplacementHintsFromRegistry,
  buildRenameHintsFromRegistry,
  buildTableRenameHintsFromRegistry,
  buildTemporaryDefaultHintsFromRegistry,
} from './schema-hints.js';

/** The plan to transform a live database schema into the declared model schema. */
export interface SchemaPlan {
  /** Ordered operations that transform `current` into `desired`. Empty when up to date. */
  readonly operations: readonly Operation[];
  /** Whether any operation is destructive (drops, restrictive alterations). */
  readonly destructive: boolean;
  /** True when the schemas already match (no operations). */
  readonly upToDate: boolean;
}

/**
 * Compare two schema states and return the plan that reaches `desiredSchema`
 * from `currentSchema`.
 *
 * The two schemas are normalized before the diff so the comparison is
 * apples-to-apples regardless of whether the caller's builders already
 * normalized their output.
 */
export function buildSchemaPlan(
  desiredSchema: SchemaState,
  currentSchema: SchemaState,
  options: AutodetectOptions = {},
): SchemaPlan {
  const desired = normalizeSchemaState(desiredSchema);
  const current = normalizeSchemaState(currentSchema);
  const operations = diffSchemaStates(current, desired, options);
  return {
    operations: Object.freeze([...operations]),
    destructive: operations.length > 0 && operations.some(isOperationDestructive),
    upToDate: operations.length === 0,
  };
}

/**
 * Resolve both the declared model schema and the live database schema from a
 * data source and return the plan to reconcile them.
 *
 * When `options.renames` is not set, rename hints are populated from the model
 * registry via {@link buildRenameHintsFromRegistry} so any `@jsails.renamedFrom`
 * markers on declared model columns automatically drive `rename_column`
 * operations.
 */
export async function reconcileDataSource(
  dataSource: {
    getModelSchema(): Promise<SchemaState> | SchemaState;
    getLiveSchema(): Promise<SchemaState>;
  },
  options?: AutodetectOptions,
): Promise<SchemaPlan> {
  const [desiredSchema, currentSchema] = await Promise.all([
    dataSource.getModelSchema(),
    dataSource.getLiveSchema(),
  ]);

  // Rename and default hints fall back to the model registry so
  // `@jsails.renamedFrom` and friends drive the plan without caller wiring.
  const resolvedOptions: AutodetectOptions = {
    ...options,
    renames: options?.renames ?? buildRenameHintsFromRegistry(),
    tableRenames: options?.tableRenames ?? buildTableRenameHintsFromRegistry(),
    temporaryDefaults: options?.temporaryDefaults ?? buildTemporaryDefaultHintsFromRegistry(),
    columnReplacements: options?.columnReplacements ?? buildColumnReplacementHintsFromRegistry(),
  };

  return buildSchemaPlan(desiredSchema, currentSchema, resolvedOptions);
}

// ---------------------------------------------------------------------------
// Destructive classification
// ---------------------------------------------------------------------------

/**
 * Whether an operation is destructive.
 *
 * The rules mirror what {@link diffSchemas} gates behind `requireDestructive`:
 * every `drop_*` operation is destructive; `alter_column` is destructive only
 * for type, length, precision, nullability-tightening, or primary-key changes
 * (a default-only alteration is safe); `create_table`, `add_*`, `rename_*`,
 * `copy_column`, `alter_inheritance`, and `alter_polymorphic` are emitted
 * unconditionally and are never destructive.
 */
function alterationIsDestructive(previous: ColumnDefinition, next: ColumnDefinition): boolean {
  return (
    previous.type !== next.type ||
    previous.length !== next.length ||
    previous.precision !== next.precision ||
    previous.scale !== next.scale ||
    (previous.nullable && !next.nullable) ||
    Boolean(previous.primaryKey) !== Boolean(next.primaryKey)
  );
}

function isOperationDestructive(op: Operation): boolean {
  switch (op.kind) {
    case 'drop_table':
    case 'drop_column':
    case 'drop_index':
    case 'drop_unique':
    case 'drop_fk':
    case 'drop_check':
      return true;
    case 'alter_column':
      // A default-only alteration changes no data: adding or dropping a default
      // is safe. Type, length, precision, nullability, and primary-key changes
      // remain destructive.
      return alterationIsDestructive(op.previous, op.column);
    case 'create_table':
    case 'add_column':
    case 'copy_column':
    case 'rename_column':
    case 'rename_table':
    case 'add_index':
    case 'add_unique':
    case 'add_fk':
    case 'add_check':
    case 'alter_inheritance':
    case 'alter_polymorphic':
      return false;
    // Exhaustive; every Operation union member is listed above.
  }
}
