/**
 * ModelSpec, the only way to declare a model: plain data naming the table,
 * its columns in portable types, its relations, indexes, tenant column and
 * optimistic-lock column. `defineModel` attaches one to a class and
 * `defineTable` makes a class-less one; `physicalTable` lowers either to a
 * dialect's table. Everything in a spec is JSON data except a relation's
 * `target`, a thunk so models can reference each other across modules, and a
 * `json` column's data contract, which validates its values (the physical
 * table never depends on it). Record hooks and validation are not part of
 * the spec: `defineModel` takes them beside it, and the write pipeline runs
 * them with the effects the spec declares (counter caches, touch,
 * dependents, autosave, attachments).
 *
 * Names: a spec names columns by property (`authorId`); the physical column
 * is the property in snake_case (`author_id`) unless `column` says otherwise.
 * Physical names are lowercase snake_case identifiers of at most 63
 * characters, so they mean the same on PostgreSQL and on a MariaDB with
 * case-insensitive table names.
 */

import type { StoredBehavior } from '../record/hooks.js';
import type {
  BigintType,
  BinaryType,
  BooleanType,
  DateType,
  DecimalType,
  FloatType,
  IdType,
  IntegerType,
  JsonType,
  PortableType,
  PortableValue,
  StringType,
  TextType,
  TimestampType,
  TimeType,
  UuidType,
} from './portable-type.js';

/** A column default: a literal the column's type accepts, or the current instant. */
export type ColumnDefault = string | number | boolean | { readonly now: true };

/**
 * Encryption of a column's value (DAT-10 supplies the codec). The column is
 * stored as portable `binary`, sized from the plaintext capacity: `maxLength`
 * (UTF-8 bytes of the plaintext) or, for a bounded type, the type's own.
 */
export interface EncryptionSpec {
  /** `deterministic` allows equality lookups; `random` does not. */
  readonly mode: 'deterministic' | 'random';
  /** The longest plaintext, in UTF-8 bytes. Required for a deterministic `text` or `json` column. */
  readonly maxLength?: number;
  /** Read rows written before the column was encrypted (a migration mode). */
  readonly acceptPlaintext?: true;
  /** Pinned additional authenticated data; `<table>.<column>` when unset. */
  readonly aad?: string;
}

/**
 * A data contract for a `json` column: every value written is parsed through
 * it, and every value read is checked against it. `jsails/data`'s
 * `defineData` and `defineDataList` contracts have this shape, as does any
 * schema with a synchronous `safeParse`.
 */
export interface ColumnDataContract {
  /** The contract's name, for diagnostics. */
  readonly name: string;
  readonly schema: {
    safeParse(input: unknown): { readonly success: boolean; readonly data?: unknown };
  };
}

/** One declared column. */
export interface ColumnSpec<T extends PortableType = PortableType, N extends boolean = boolean> {
  readonly type: T;
  /** Whether the column accepts `NULL`; `false` when unset. */
  readonly nullable?: N;
  readonly default?: ColumnDefault;
  /** The physical column name; the property in snake_case when unset. */
  readonly column?: string;
  readonly encrypted?: EncryptionSpec;
  /** The only values a `string` column accepts, on write and on read. */
  readonly enum?: readonly string[];
  /** The data contract of a `json` column. */
  readonly data?: ColumnDataContract;
}

/** Options of a {@link column} constructor. */
export interface ColumnOptions<N extends boolean = false> {
  readonly nullable?: N;
  readonly default?: ColumnDefault;
  readonly column?: string;
  readonly encrypted?: EncryptionSpec;
  /** See {@link ColumnSpec.enum}; `string` columns only. */
  readonly enum?: readonly string[];
  /** See {@link ColumnSpec.data}; `json` columns only. */
  readonly data?: ColumnDataContract;
}

/** The application value of a column, `null` included when it is nullable. */
export type ColumnValue<C extends ColumnSpec> = C['nullable'] extends true
  ? PortableValue<C['type']> | null
  : PortableValue<C['type']>;

/** Constructors for every portable column type. */
export interface ColumnFactory {
  id<N extends boolean = false>(options?: ColumnOptions<N>): ColumnSpec<IdType, N>;
  string<N extends boolean = false>(
    length: number,
    options?: ColumnOptions<N>,
  ): ColumnSpec<StringType, N>;
  text<N extends boolean = false>(options?: ColumnOptions<N>): ColumnSpec<TextType, N>;
  integer<N extends boolean = false>(options?: ColumnOptions<N>): ColumnSpec<IntegerType, N>;
  bigint<N extends boolean = false>(options?: ColumnOptions<N>): ColumnSpec<BigintType, N>;
  decimal<N extends boolean = false>(
    precision: number,
    scale: number,
    options?: ColumnOptions<N>,
  ): ColumnSpec<DecimalType, N>;
  float<N extends boolean = false>(options?: ColumnOptions<N>): ColumnSpec<FloatType, N>;
  boolean<N extends boolean = false>(options?: ColumnOptions<N>): ColumnSpec<BooleanType, N>;
  timestamp<N extends boolean = false>(options?: ColumnOptions<N>): ColumnSpec<TimestampType, N>;
  date<N extends boolean = false>(options?: ColumnOptions<N>): ColumnSpec<DateType, N>;
  time<N extends boolean = false>(options?: ColumnOptions<N>): ColumnSpec<TimeType, N>;
  json<N extends boolean = false>(options?: ColumnOptions<N>): ColumnSpec<JsonType, N>;
  uuid<N extends boolean = false>(options?: ColumnOptions<N>): ColumnSpec<UuidType, N>;
  binary<N extends boolean = false>(
    length?: number,
    options?: ColumnOptions<N>,
  ): ColumnSpec<BinaryType, N>;
}

function make<T extends PortableType, N extends boolean>(
  type: T,
  options: ColumnOptions<N> | undefined,
): ColumnSpec<T, N> {
  return Object.freeze({ ...options, type: Object.freeze(type) });
}

/** Column constructors: `column.string(200)`, `column.timestamp({ nullable: true })`. */
export const column: ColumnFactory = Object.freeze({
  id: (options) => make({ kind: 'id' }, options),
  string: (length, options) => make({ kind: 'string', length }, options),
  text: (options) => make({ kind: 'text' }, options),
  integer: (options) => make({ kind: 'integer' }, options),
  bigint: (options) => make({ kind: 'bigint' }, options),
  decimal: (precision, scale, options) => make({ kind: 'decimal', precision, scale }, options),
  float: (options) => make({ kind: 'float' }, options),
  boolean: (options) => make({ kind: 'boolean' }, options),
  timestamp: (options) => make({ kind: 'timestamp' }, options),
  date: (options) => make({ kind: 'date' }, options),
  time: (options) => make({ kind: 'time' }, options),
  json: (options) => make({ kind: 'json' }, options),
  uuid: (options) => make({ kind: 'uuid' }, options),
  binary: (length, options) =>
    make(length === undefined ? { kind: 'binary' } : { kind: 'binary', length }, options),
} satisfies ColumnFactory);

/** A referential action of a foreign key when the referenced row is deleted. */
export type OnDelete = 'cascade' | 'set null' | 'restrict';

/**
 * What deleting the owner does to the rows of a `hasMany`/`hasOne` whose
 * inverse is a real foreign key: `destroy` deletes them with the owner and
 * lowers to `ON DELETE CASCADE`; `nullify` clears their foreign key and
 * lowers to `ON DELETE SET NULL`, which needs a nullable key. The database
 * action is the whole work when deleting a child runs nothing (the child's
 * effect plan is empty); otherwise the write pipeline destroys or nullifies
 * the children itself before it deletes the owner, and the action only
 * catches a child inserted meanwhile. Whether the plan is empty is the
 * pipeline's to know, so the schema never depends on a model's hooks.
 */
export type Dependent = 'destroy' | 'nullify';

/** Anything `defineModel` or `defineTable` produced. */
export type ModelTarget = object;

/** The owning side of a relation: this table holds the foreign key. */
export interface BelongsToSpec {
  readonly kind: 'belongsTo';
  readonly target: () => ModelTarget;
  /** The foreign-key property; `<relation>Id` when unset. */
  readonly foreignKey?: string;
  /** The physical foreign-key column; the property in snake_case when unset. */
  readonly column?: string;
  readonly nullable?: boolean;
  /**
   * The database action. Derived from the inverse relation's `dependent`
   * when unset (`restrict` when no inverse declares one); when an inverse
   * declares `dependent`, it must be the action that implies. Declared here
   * alone, `cascade` and `set null` mean what `dependent: 'destroy'` and
   * `'nullify'` mean on an inverse: the write pipeline destroys or nullifies
   * the children itself whenever the action alone would skip their effects.
   */
  readonly onDelete?: OnDelete;
  /** `false` opts out of the automatic index on the foreign key. */
  readonly index?: false;
  /** The integer property on the target that counts this model's rows. */
  readonly counterCache?: string;
  /** The timestamp property on the target set to now when this row is written. */
  readonly touch?: string;
  /**
   * Save the target record held in this relation's property, when it is new
   * or changed, before this row, and copy its key into the foreign key.
   */
  readonly autosave?: true;
}

/**
 * A polymorphic owning side: `<relation>Type` (the target's model name) and
 * `<relation>Id` columns with no database foreign key.
 */
export interface BelongsToPolymorphicSpec {
  readonly kind: 'belongsTo';
  readonly polymorphic: true;
  readonly nullable?: boolean;
  /** `false` opts out of the automatic `(type, id)` index. */
  readonly index?: false;
}

/** An inverse side: the target holds the foreign key, through its `inverse` relation. */
export interface HasManySpec {
  readonly kind: 'hasMany' | 'hasOne';
  readonly target: () => ModelTarget;
  /** The `belongsTo` relation on the target that points back here. */
  readonly inverse: string;
  readonly dependent?: Dependent;
  /**
   * Save the records held in this relation's property (an array for
   * `hasMany`, a record or `null` for `hasOne`), when new or changed, after
   * this row, with their foreign key set to it.
   */
  readonly autosave?: true;
}

/** A relation reached through another relation of this model (a link table). */
export interface HasManyThroughSpec {
  readonly kind: 'hasMany' | 'hasOne';
  readonly target: () => ModelTarget;
  /** The relation of this model whose target links to `target`. */
  readonly through: string;
  /** The relation on the `through` target that reaches `target`. */
  readonly source: string;
}

export type RelationSpec =
  BelongsToSpec | BelongsToPolymorphicSpec | HasManySpec | HasManyThroughSpec;

/**
 * A named file attached to each record (`hasOneAttached`): one row of the
 * framework's attachment table per record and name, pointing at a blob on the
 * data source's attachment disk. The model needs a one-column primary key.
 */
export interface AttachmentSpec {
  readonly kind: 'one';
}

/** A declared index. */
export interface IndexSpec {
  /** Properties, in key order. */
  readonly columns: readonly string[];
  readonly unique?: true;
  /** The index name; derived from the table and columns when unset. */
  readonly name?: string;
  /**
   * On a tenant-scoped model, a unique index without the tenant column is an
   * error unless it is marked global: unique across every tenant.
   */
  readonly global?: true;
}

/** A model declaration. */
export interface ModelSpec {
  /** The physical table name. */
  readonly table: string;
  /**
   * The model's name, stored in polymorphic type columns; the class name for
   * `defineModel` and the table for `defineTable` when unset.
   */
  readonly name?: string;
  readonly columns: Readonly<Record<string, ColumnSpec>>;
  /**
   * The primary-key properties. When unset it is `id`, and an undeclared
   * `id` column is added as `column.id()`, generated by the database.
   */
  readonly primaryKey?: string | readonly string[];
  readonly relations?: Readonly<Record<string, RelationSpec>>;
  readonly indexes?: readonly IndexSpec[];
  /** The tenant property: every statement on this model is scoped by it. */
  readonly tenant?: string;
  /** Adds a `lockVersion` integer column for optimistic locking. */
  readonly lockVersion?: true;
  /** Named attachments, by property. */
  readonly attachments?: Readonly<Record<string, AttachmentSpec>>;
}

/** Where a resolved column came from. */
export type ColumnOrigin =
  | 'declared'
  | 'primary-key'
  | 'foreign-key'
  | 'polymorphic-type'
  | 'polymorphic-id'
  | 'lock-version';

/** A column of a normalized spec: declared or derived, with its physical name. */
export interface ResolvedColumn {
  readonly property: string;
  readonly column: string;
  readonly type: PortableType;
  readonly nullable: boolean;
  readonly default?: ColumnDefault;
  readonly encrypted?: EncryptionSpec;
  readonly enum?: readonly string[];
  readonly data?: ColumnDataContract;
  readonly origin: ColumnOrigin;
  /** The relation a derived key column belongs to. */
  readonly relation?: string;
}

/** A declared index with its resolved name. */
export interface ResolvedIndex {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly global: boolean;
}

/**
 * A validated, frozen spec with every derived column made explicit. Relation
 * targets are still thunks; `physicalTable` resolves them.
 */
export interface NormalizedSpec {
  readonly name: string;
  readonly table: string;
  /** Every column in table order: primary key, declared, derived. */
  readonly columns: readonly ResolvedColumn[];
  readonly primaryKey: readonly string[];
  /** Whether the primary key is one `id` column the database generates. */
  readonly generatedKey: boolean;
  readonly relations: Readonly<Record<string, RelationSpec>>;
  readonly indexes: readonly ResolvedIndex[];
  readonly tenant: string | undefined;
  readonly lockVersion: boolean;
  readonly attachments: Readonly<Record<string, AttachmentSpec>>;
}

/** What `defineModel` and `defineTable` attach: a model's normalized spec. */
export interface ModelDefinition {
  readonly kind: 'model' | 'table';
  readonly spec: NormalizedSpec;
  /** The record hooks and validation `defineModel` was given; never set for a table. */
  readonly behavior?: StoredBehavior;
}
