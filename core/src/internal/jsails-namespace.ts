/**
 * The runtime `jsails` decorator namespace.
 *
 * A model author writes `@jsails.maxLength(200) declare title: string` with no
 * import. TypeScript type-checks that against the ambient `declare namespace
 * jsails` in the generated `.jsails/framework-symbols.d.ts`, but it **emits the
 * decorator call as a runtime expression** — `jsails.maxLength(200)` inside
 * `__decorate([...])`. The name `jsails` must therefore resolve to a value at
 * module-evaluation time, or the model throws `ReferenceError` on import.
 *
 * This module supplies that value. Importing it installs `globalThis.jsails`
 * as a side effect; because ESM evaluates an imported module before the
 * importing module's body, any module that reaches this one (directly or
 * transitively) has the global set before its own `__decorate` calls run. The
 * install choke point is {@link ApplicationRecord} — every model extends it, so
 * importing a model always installs the global first.
 *
 * Most decorator factories here are **inert**: they return a no-op
 * `PropertyDecorator`. The real work is done by the compiler, which reads the
 * decorator AST and folds it into the model spec; the runtime call exists only
 * so the emitted expression does not throw. `@jsails.data` is the exception:
 * it records its contract in a module-level WeakMap so `defineModel` can validate
 * the field at persistence time. The compiler still decides that the field is a
 * JSON column; the registry only adds the schema.
 *
 * The only runtime dependency is the browser-safe data-contract registry, so
 * this module stays safe to reach from any layer.
 */

import type { AnyDataContract } from '../data/index.js';
import { registerDataContract } from '../data/model-data.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** A class constructor usable as a relation target. */
export type JsailsRelationTarget = new (...args: never[]) => object;

/** Referential action applied when the referenced row is deleted. */
export type JsailsOnDelete = 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'NO ACTION';

/** A scalar literal accepted as a column default. */
export type JsailsDefaultValue = string | number | boolean;

/** Options accepted by the relation decorators. */
export interface JsailsRelationOptions {
  /** Update the parent's timestamp when the related row changes. */
  readonly touch?: boolean;
  /** Maintain a counter column on the parent. */
  readonly counter_cache?: boolean;
  /** The inverse property name on the target, when inference is ambiguous. */
  readonly inverse?: string;
  /**
   * Override the join-column name. By convention it is
   * `<relation>_<referenced column>` (`user_id`); set this only for a deliberate
   * deviation.
   */
  readonly foreignKey?: string;
  /** Referential action on delete. Defaults to the database's `NO ACTION`. */
  readonly onDelete?: JsailsOnDelete;
}

/**
 * The shape of the `jsails` decorator namespace. The generated ambient
 * declaration mirrors this interface; a test asserts the two stay in sync.
 */
export interface JsailsNamespace {
  /**
   * Override the derived table name. Without it a model's table is the
   * snake_case class name (`Post` -> `post`).
   */
  table(name: string): ClassDecorator;
  /** Declare a JSON-backed data contract on a model field. */
  data(contract: AnyDataContract): PropertyDecorator;
  maxLength(length: number): PropertyDecorator;
  unique(): PropertyDecorator;
  nullable(): PropertyDecorator;
  /** A permanent column default, baked into the schema and the TypeORM column. */
  default(value: JsailsDefaultValue): PropertyDecorator;
  /**
   * A default used only while adding a NOT NULL column to an existing table.
   * It fills existing rows, then the reconciler drops it; it never persists.
   */
  temporaryDefault(value: JsailsDefaultValue): PropertyDecorator;
  encrypts(): PropertyDecorator;
  /**
   * Declares that the column (or, for a many-to-one relation, its derived FK
   * column) was previously stored under `previousName`. The schema reconciler
   * consumes this marker so the rename emits a data-preserving `rename_column`
   * instead of a drop+add.
   */
  renamedFrom(previousName: string): PropertyDecorator & ClassDecorator;
  /**
   * Declares that this column replaces `previousName`. The reconciler adds the
   * new column, copies the old value through `copyExpression` (raw SQL owned by
   * the caller), then drops the old column.
   */
  replacedFrom(previousName: string, copyExpression: string): PropertyDecorator;
  /** The owning side of a many-to-one relation (this entity holds the FK). */
  belongsTo(target: JsailsRelationTarget, options?: JsailsRelationOptions): PropertyDecorator;
  /** The owning side of a one-to-one relation (this entity holds the unique FK). */
  oneToOne(target: JsailsRelationTarget, options?: JsailsRelationOptions): PropertyDecorator;
  /** The inverse side of a one-to-many relation (the FK lives on the target). */
  hasMany(target: JsailsRelationTarget, options?: JsailsRelationOptions): PropertyDecorator;
  /** The inverse side of a one-to-one relation (the unique FK lives on the target). */
  hasOne(target: JsailsRelationTarget, options?: JsailsRelationOptions): PropertyDecorator;
  /**
   * Declares an enum column: a closed-set string/integer column with a `CHECK`
   * constraint and value predicates. The value set is a closed list of strings
   * or integers; the compiler derives the column kind and the check expression.
   */
  ['enum'](values: readonly (string | number)[]): PropertyDecorator;
}

/* ------------------------------------------------------------------ */
/*  Runtime value                                                      */
/* ------------------------------------------------------------------ */

/** A no-op property/class decorator; the compiler does the real lowering. */
const inert: PropertyDecorator & ClassDecorator = () => {
  // Intentionally empty: the decorator is a compile-time marker.
};

/**
 * The runtime `jsails` namespace. Most factories return the same inert
 * decorator; `data` records its contract so `defineModel` can validate the
 * field. Parameters are accepted (and otherwise ignored) so the emitted call
 * shape matches the ambient declaration.
 */
export const jsails: JsailsNamespace = {
  table: () => inert,
  data: (contract) => (target, property) => registerDataContract(target, property, contract),
  maxLength: () => inert,
  unique: () => inert,
  nullable: () => inert,
  default: () => inert,
  temporaryDefault: () => inert,
  encrypts: () => inert,
  renamedFrom: () => inert,
  replacedFrom: () => inert,
  belongsTo: () => inert,
  oneToOne: () => inert,
  hasMany: () => inert,
  hasOne: () => inert,
  enum: () => inert,
};

/* ------------------------------------------------------------------ */
/*  Global installation                                                */
/* ------------------------------------------------------------------ */

/**
 * Install the `jsails` namespace on `globalThis`. Idempotent: a repeated call
 * reassigns the same object. Called at module load so importing this module is
 * sufficient to make `@jsails.*` decorators resolve.
 */
export function installJsailsGlobal(): void {
  (globalThis as { jsails?: JsailsNamespace }).jsails = jsails;
}

installJsailsGlobal();
