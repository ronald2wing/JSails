/**
 * `defineModel` — the single place JSails lowers a model spec onto TypeORM.
 *
 * A JSails model is authored as a plain class that declares only its shape. The
 * compiler derives a {@link ModelSpec} from that shape and emits a
 * `defineModel(Class, spec)` call into a generated registry. This function is
 * the **only** code that knows TypeORM exists: it applies TypeORM's own
 * decorator factories programmatically (the mechanism proven in the model
 * spike), then records the class and its derived lifecycle hooks in the JSails
 * model registry.
 *
 * Why invoke the decorator factories rather than hand-push metadata: the
 * factories are TypeORM's public, version-stable surface. They write into
 * TypeORM's global metadata storage exactly as a hand-written `@Column` would,
 * so migrations and `getModelSchema()` see a byte-identical portable schema.
 * Reverse-engineering the storage internals would break on any TypeORM bump.
 *
 * The spec is **pure data** — no TypeORM types, no class references except the
 * relation targets, which are the real classes the compiler imported. That keeps
 * the generated registry a plain data file and keeps every TypeORM decision
 * here, where it can be tested once.
 *
 * Server-only: reaches `reflect-metadata` and TypeORM.
 */

import 'reflect-metadata';

import { z } from 'zod';

import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  type ObjectLiteral,
} from 'typeorm';

import { belongs_to, has_many, has_one } from '../database/associations.js';
import { encrypts } from '../database/attribute-encryption.js';
import { defineEntityHooks, type EntityHooksDefinition } from '../database/entity-subscribers.js';
import { EntityValidationError } from '../database/entity-validation.js';
import { registerModel } from '../database/model-registry.js';
import type { AnyDataContract } from '../data/index.js';
import { resolveDataContract } from '../data/model-data.js';
import { resolveModelEncrypter } from '../encryption/model-encrypter.js';
import type { JsailsOnDelete } from '../internal/jsails-namespace.js';
import { isOnDelete } from '../internal/relation-options.js';

/** A scalar column kind, in portable TypeORM column-type terms. */
export type ModelColumnType = 'varchar' | 'text' | 'integer' | 'boolean' | 'datetime' | 'json';

/** A column in a {@link ModelSpec}. */
export interface ModelColumnSpec {
  /** The property name, e.g. `title`. */
  readonly name: string;
  readonly type: ModelColumnType;
  /** For `varchar`, the explicit length. */
  readonly length?: number;
  /** Whether the column accepts `null`. Defaults to `false`. */
  readonly nullable?: boolean;
  /** Whether the column carries a unique constraint. Defaults to `false`. */
  readonly unique?: boolean;
  /** A permanent column default (`@jsails.default(value)`). */
  readonly default?: string | number | boolean;
  /**
   * A one-off default (`@jsails.temporaryDefault(value)`) used only while
   * adding a NOT NULL column to an existing table. Not lowered onto TypeORM.
   */
  readonly temporaryDefault?: string | number | boolean;
  /**
   * A prior column name (`@jsails.renamedFrom('old_name')`), carried as a
   * side-channel so the schema reconciler can emit a rename instead of drop+add.
   * Not part of the lowered TypeORM column — defineModel ignores it.
   */
  readonly renamedFrom?: string;
  /**
   * A column this one replaces (`@jsails.replacedFrom('old', 'expression')`).
   * Not lowered onto TypeORM; the reconciler emits the transition.
   */
  readonly replacedFrom?: string;
  /** Raw SQL expression used to copy `replacedFrom` into this column. */
  readonly copyExpression?: string;
}

/** A relation in a {@link ModelSpec}. */
export interface ModelRelationSpec {
  readonly kind: 'many-to-one' | 'one-to-many' | 'one-to-one';
  /**
   * Whether this entity holds the foreign key. Required for `one-to-one`;
   * inferred from the kind for the other two (`many-to-one` owns,
   * `one-to-many` does not).
   */
  readonly owning?: boolean;
  /** The property name, e.g. `author`. */
  readonly name: string;
  /** The related class. */
  readonly target: new () => ObjectLiteral;
  /**
   * An explicit join-column name. Absent means the naming strategy derives
   * `<relation>_<referenced column>` (`user_id`).
   */
  readonly joinColumn?: string;
  /** Referential action when the referenced row is deleted. */
  readonly onDelete?: JsailsOnDelete;
  /** Whether the FK accepts `null` (owning side only). Defaults to `false`. */
  readonly nullable?: boolean;
  /**
   * For an owning relation, the inverse property on the target. For an inverse
   * relation, the owning property on the target (required for `one-to-one`).
   */
  readonly inverse?: string;
  /** Touch the related entity's `updated_at` when this row changes. */
  readonly touch?: boolean;
  /** For `one-to-many`, maintain a `<name>_count` counter cache. */
  readonly counterCache?: boolean;
  /**
   * A prior FK column name (`@jsails.renamedFrom('old_name')`); applies to the
   * derived FK column, not the relation property.
   */
  readonly renamedFrom?: string;
}

/** The primary key of a {@link ModelSpec}. */
export interface ModelPrimaryKeySpec {
  /** The property name, e.g. `id`. */
  readonly name: string;
  /** Only a generated integer key is supported in v1. */
  readonly kind: 'integer';
}

/** The full shape of a model, as derived by the compiler. */
export interface ModelSpec {
  /** The table name, e.g. `post` (or `@jsails.table(...)`). */
  readonly table: string;
  /** A prior table name (`@jsails.renamedFrom('old_table')` on the class). */
  readonly renamedFrom?: string;
  readonly primaryKey: ModelPrimaryKeySpec;
  readonly columns: readonly ModelColumnSpec[];
  readonly relations: readonly ModelRelationSpec[];
  /**
   * The names of fields marked `@jsails.encrypts()`. When non-empty,
   * `defineModel` wires the encryption hook for exactly this set, resolving the
   * encrypter from the environment (`JSAILS_ENCRYPTION_KEY`).
   */
  readonly encrypted?: readonly string[];
}

/** Raised for an invalid model spec. Messages are value-free. */
export class ModelDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelDefinitionError';
  }
}

/**
 * Lower a model spec onto TypeORM and register the class.
 *
 * Applies the entity, primary-key, column, and relation decorators in the order
 * TypeORM requires (relations before the hook factories that validate them),
 * derives the lifecycle hooks from relation behaviour flags, and records the
 * class in the JSails model registry. Idempotent per class via
 * {@link registerModel}.
 */
export function defineModel<T extends ObjectLiteral>(entity: new () => T, spec: ModelSpec): void {
  assertSpec(spec);

  Entity(spec.table)(entity);
  PrimaryGeneratedColumn()(entity.prototype, spec.primaryKey.name);

  const hooks: EntityHooksDefinition<ObjectLiteral>[] = [];

  for (const column of spec.columns) {
    Column(columnOptions(column))(entity.prototype, column.name);
    const contract = resolveDataContract(entity, column.name);
    if (contract !== undefined) {
      if (column.type !== 'json') {
        throw new ModelDefinitionError(
          `defineModel: @jsails.data field '${column.name}' must be a json column`,
        );
      }
      if (spec.encrypted?.includes(column.name) === true) {
        throw new ModelDefinitionError(
          `defineModel: @jsails.data field '${column.name}' cannot also be encrypted`,
        );
      }
      hooks.push(dataContractHooks(entity, column.name, column.nullable === true, contract));
    }
  }

  for (const relation of spec.relations) {
    if (relation.kind === 'many-to-one') {
      ManyToOne(() => relation.target, owningRelationOptions(relation))(
        entity.prototype,
        relation.name,
      );
      applyJoinColumn(relation)(entity.prototype, relation.name);
      if (relation.touch === true) {
        hooks.push(...belongs_to(entity, relation.name, { touch: true }));
      }
    } else if (relation.kind === 'one-to-one') {
      if (relation.owning === true) {
        const inverse = relation.inverse;
        if (inverse === undefined) {
          OneToOne(() => relation.target, owningRelationOptions(relation))(
            entity.prototype,
            relation.name,
          );
        } else {
          OneToOne(
            () => relation.target,
            (target: ObjectLiteral) => target[inverse],
            owningRelationOptions(relation),
          )(entity.prototype, relation.name);
        }
        applyJoinColumn(relation)(entity.prototype, relation.name);
        if (relation.touch === true) {
          hooks.push(...belongs_to(entity, relation.name, { touch: true }));
        }
      } else {
        // An inverse one-to-one has no column; TypeORM needs the owning
        // property on the target to link the two sides.
        const inverse = relation.inverse;
        if (inverse === undefined) {
          throw new ModelDefinitionError(
            'defineModel: inverse one-to-one relations require an inverse property name',
          );
        }
        OneToOne(
          () => relation.target,
          (target: ObjectLiteral) => target[inverse],
        )(entity.prototype, relation.name);
        if (relation.touch === true) {
          hooks.push(...has_one(entity, relation.name, { touch: true }));
        }
      }
    } else {
      OneToMany(() => relation.target, relation.inverse ?? defaultInverse(relation.name))(
        entity.prototype,
        relation.name,
      );
      if (relation.counterCache === true || relation.touch === true) {
        hooks.push(
          ...has_many(entity, relation.name, {
            ...(relation.counterCache === true ? { counter_cache: true } : {}),
            ...(relation.touch === true ? { touch: true } : {}),
          }),
        );
      }
    }
  }

  // Encryption is a declaration on the model; the encrypter is resolved from the
  // environment because this runs before any extension `setup`. A keyless
  // deployment gets a sentinel that fails at first use, never a plaintext write.
  if (spec.encrypted !== undefined && spec.encrypted.length > 0) {
    hooks.push(encrypts(entity, resolveModelEncrypter(), spec.encrypted));
  }

  registerModel(entity, hooks, spec);
}

/** Validate and persist a JSON-backed data contract on insert and on a present update. */
function dataContractHooks(
  entity: new () => ObjectLiteral,
  field: string,
  nullable: boolean,
  contract: AnyDataContract,
): EntityHooksDefinition<ObjectLiteral> {
  const schema = (contract as { readonly schema?: z.ZodType }).schema;
  if (contract === null || typeof contract !== 'object' || schema?.safeParse === undefined) {
    throw new ModelDefinitionError(
      'defineModel: @jsails.data requires a defineData or defineDataList contract',
    );
  }
  const fieldSchema: z.ZodType = nullable ? schema.nullable() : schema;

  const parse = (values: ObjectLiteral): void => {
    const result = fieldSchema.safeParse(values[field]);
    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        field: issue.path.length > 0 ? `${field}.${issue.path.join('.')}` : field,
        message: issue.message,
      }));
      throw new EntityValidationError('Entity validation failed', errors);
    }
    // Persist the parsed value, not just its validity: defaults and transforms
    // are part of the contract, and the stored JSON must match `DataValue`.
    values[field] = result.data;
  };

  return defineEntityHooks(entity, {
    beforeInsert({ data: values }) {
      parse(values);
    },
    beforeUpdate({ data: values }) {
      if (!Object.prototype.hasOwnProperty.call(values, field)) return;
      parse(values);
    },
  });
}

/** TypeORM options shared by the owning relation decorators. */
function owningRelationOptions(relation: ModelRelationSpec): {
  nullable: boolean;
  onDelete?: JsailsOnDelete;
} {
  return {
    nullable: relation.nullable ?? false,
    ...(relation.onDelete !== undefined ? { onDelete: relation.onDelete } : {}),
  };
}

/** Apply `@JoinColumn`, letting the naming strategy name it unless overridden. */
function applyJoinColumn(relation: ModelRelationSpec): PropertyDecorator {
  return relation.joinColumn === undefined
    ? JoinColumn()
    : JoinColumn({ name: relation.joinColumn });
}

/** Build the TypeORM column options for a spec column. */
function columnOptions(column: ModelColumnSpec): {
  type: ModelColumnType;
  length?: number;
  nullable: boolean;
  unique: boolean;
  default?: string | number | boolean;
} {
  const options: {
    type: ModelColumnType;
    length?: number;
    nullable: boolean;
    unique: boolean;
    default?: string | number | boolean;
  } = {
    type: column.type,
    nullable: column.nullable ?? false,
    unique: column.unique ?? false,
  };
  if (column.type === 'varchar' && column.length !== undefined) {
    options.length = column.length;
  }
  if (column.default !== undefined) {
    options.default = column.default;
  }
  return options;
}

/**
 * The conventional inverse property name for a one-to-many relation: the
 * singular of the relation name (`comments` → `comment`). The compiler always
 * emits an explicit `inverse` when it can resolve one; this is the fallback.
 */
function defaultInverse(name: string): string {
  return name.endsWith('s') ? name.slice(0, -1) : name;
}

/** Reject a malformed spec before any decorator runs. */
function assertSpec(spec: ModelSpec): void {
  if (typeof spec.table !== 'string' || spec.table.length === 0) {
    throw new ModelDefinitionError('defineModel: table name is required');
  }
  if (spec.renamedFrom !== undefined) {
    if (spec.renamedFrom.length === 0) {
      throw new ModelDefinitionError('defineModel: renamedFrom must not be empty');
    }
    if (spec.renamedFrom === spec.table) {
      throw new ModelDefinitionError('defineModel: renamedFrom must differ from the table name');
    }
  }
  if (spec.primaryKey.kind !== 'integer') {
    throw new ModelDefinitionError(
      'defineModel: only a generated integer primary key is supported',
    );
  }
  const columnNames = new Set(spec.columns.map((column) => column.name));
  for (const column of spec.columns) {
    if (column.type === 'varchar' && column.length === undefined) {
      throw new ModelDefinitionError('defineModel: varchar columns require an explicit length');
    }
    for (const value of [column.default, column.temporaryDefault]) {
      if (
        value !== undefined &&
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean'
      ) {
        throw new ModelDefinitionError('defineModel: column defaults must be scalar literals');
      }
    }
    if ((column.replacedFrom === undefined) !== (column.copyExpression === undefined)) {
      throw new ModelDefinitionError(
        'defineModel: replacedFrom and copyExpression must be declared together',
      );
    }
    if (column.replacedFrom !== undefined) {
      if (column.replacedFrom.length === 0) {
        throw new ModelDefinitionError('defineModel: replacedFrom must not be empty');
      }
      if (column.replacedFrom === column.name) {
        throw new ModelDefinitionError(
          'defineModel: replacedFrom must differ from the column name',
        );
      }
      if (column.copyExpression !== undefined && column.copyExpression.trim().length === 0) {
        throw new ModelDefinitionError('defineModel: copyExpression must not be empty');
      }
    }
  }
  for (const field of spec.encrypted ?? []) {
    // An encrypted field names a scalar column; a typo would otherwise build a
    // hook that silently never fires.
    if (!columnNames.has(field)) {
      throw new ModelDefinitionError(
        `defineModel: encrypted field '${field}' is not a column of '${spec.table}'`,
      );
    }
  }
  for (const relation of spec.relations) {
    if (typeof relation.target !== 'function') {
      throw new ModelDefinitionError('defineModel: relation target must be a class');
    }
    if (relation.kind === 'one-to-one') {
      if (typeof relation.owning !== 'boolean') {
        throw new ModelDefinitionError('defineModel: one-to-one relations require an owning flag');
      }
      if (relation.owning === false && relation.inverse === undefined) {
        throw new ModelDefinitionError(
          'defineModel: inverse one-to-one relations require an inverse property name',
        );
      }
    }
    if (relation.joinColumn !== undefined && relation.joinColumn.length === 0) {
      throw new ModelDefinitionError('defineModel: joinColumn must not be empty');
    }
    if (relation.onDelete !== undefined && !isOnDelete(relation.onDelete)) {
      throw new ModelDefinitionError('defineModel: invalid onDelete value');
    }
  }
}
