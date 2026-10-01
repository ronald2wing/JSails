/**
 * Connection-free lookups over TypeORM's global decorator metadata
 * (`getMetadataArgsStorage()`).
 *
 * The relation resolver, the relation loader and query compiler, polymorphic
 * relations, enum checks, and the declared-schema adapter all need the same
 * few answers — an entity's table, a relation's target class, a join column —
 * before (or without) a live DataSource. They live here so every caller agrees
 * on the answer, including the class-name fallback for an unnamed `@Entity()`.
 */

import { getMetadataArgsStorage } from 'typeorm';
import type { TableMetadataArgs } from 'typeorm/metadata-args/TableMetadataArgs.js';
import type { RelationTypeInFunction } from 'typeorm/metadata/types/RelationTypeInFunction.js';

import { RelationError } from './relation-error.js';

/** The `@Entity()` table metadata registered for `target`, if any. */
export function findTableArgs(target: Function): TableMetadataArgs | undefined {
  return getMetadataArgsStorage().tables.find((table) => table.target === target);
}

/**
 * Resolve an entity class to its table name from decorator metadata — the
 * explicit `@Entity('name')`, else the class name. No `getRepository()` call,
 * so it works for classes not attached to a live DataSource.
 */
export function resolveTableName(target: Function): string {
  return findTableArgs(target)?.name ?? target.name;
}

/**
 * Find a registered entity class by its class name. Through relations and
 * string-typed relation decorators (`@OneToMany('Comment', ...)`) record class
 * names, not table names or class references. The most recent registration
 * wins: the global metadata storage accumulates every class ever decorated,
 * so a name redefined (a test suite declaring `class Post` per case) must
 * resolve to the live class, the one other relations compare against by
 * identity.
 */
export function findEntityByClassName(className: string): Function | undefined {
  const table = getMetadataArgsStorage().tables.findLast(
    (candidate) => typeof candidate.target === 'function' && candidate.target.name === className,
  );
  return table?.target as Function | undefined;
}

/** Find the database join-column name for an entity property, when declared. */
export function findJoinColumn(entity: Function, propertyName: string): string | undefined {
  const storage = getMetadataArgsStorage();
  const joinColumn = storage.joinColumns.find(
    (candidate) => candidate.target === entity && candidate.propertyName === propertyName,
  );
  return joinColumn?.name;
}

/**
 * Resolve a relation decorator's `type` to the target entity class. The value
 * is TypeORM's wrapper callback (`() => TargetClass`), a class name string
 * (`@OneToMany('Comment', ...)`), or, for an `EntitySchema` relation, an
 * object carrying the class as `type`.
 */
export function resolveRelationType(typeValue: RelationTypeInFunction): Function {
  if (typeof typeValue === 'object' && typeValue !== null && 'type' in typeValue) {
    const schemaType = (typeValue as { type: Function }).type;
    if (typeof schemaType !== 'function') {
      throw new RelationError(
        'missing_relation',
        'an entity schema relation must reference an entity class',
      );
    }
    return schemaType;
  }
  if (typeof typeValue === 'function') {
    // TypeScript narrows this union to `EntityTarget<any>` rather than the
    // callable arm, so cast through `Function` to invoke the wrapper.
    const resolved = (typeValue as Function)();
    if (typeof resolved !== 'function') {
      throw new RelationError(
        'invalid_relation',
        'a relation type callback must return an entity class',
      );
    }
    return resolved;
  }
  if (typeof typeValue === 'string') {
    const resolved = findEntityByClassName(typeValue);
    if (resolved === undefined) {
      throw new RelationError(
        'missing_relation',
        'a string relation type must reference a registered entity class',
      );
    }
    return resolved;
  }
  throw new RelationError('unsupported_relation', 'unsupported relation type value');
}
