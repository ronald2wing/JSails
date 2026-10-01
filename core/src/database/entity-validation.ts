/**
 * Model-level validation primitives: attach a Zod schema to every insert/update
 * of an entity, and validate data before persistence.
 *
 * {@link defineEntityValidation} declares the schema for one entity; {@link
 * validateEntity} and {@link assertEntityValid} check data against it. These
 * are the building blocks — the subscriber that wires them into TypeORM's
 * lifecycle events is {@link entityValidationHooks}.
 */

import type { EntityTarget, ObjectLiteral } from 'typeorm';
import { assertEntityTarget } from './entity-target.js';
import { safeParse, type z } from 'zod';

import type { FieldError } from '../validation/rules.js';
import { defineEntityHooks, type EntityHooksDefinition } from './entity-subscribers.js';
import { JsailsError } from '../errors/jsails-error.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An immutable, validated descriptor: one entity plus its Zod schema. */
export interface EntityValidation<Entity extends ObjectLiteral> {
  readonly entity: EntityTarget<Entity>;
  readonly schema: z.ZodObject<z.ZodRawShape>;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/** Machine-readable reason for an {@link EntityValidationError}. */
export type EntityValidationErrorCode = 'invalid_definition' | 'invalid_entity';

/** Raised for an invalid validation definition or by {@link assertEntityValid}. */
export class EntityValidationError extends JsailsError {
  /** The field-level validation errors, set only when thrown from {@link assertEntityValid}. */
  readonly errors: readonly FieldError[];

  constructor(
    readonly code: EntityValidationErrorCode,
    message: string,
    errors: readonly FieldError[] = [],
  ) {
    super(message);
    this.errors = Object.freeze(errors);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Declare an entity's validation schema. Returns an immutable descriptor that
 * {@link validateEntity} and {@link assertEntityValid} consume.
 *
 * @param entity - A TypeORM entity target (class, `EntitySchema`, or name).
 * @param schema - A Zod object schema used to validate entity data.
 * @throws {EntityValidationError} if the arguments are invalid.
 */
export function defineEntityValidation<Entity extends ObjectLiteral>(
  entity: EntityTarget<Entity>,
  schema: z.ZodObject<z.ZodRawShape>,
): EntityValidation<Entity> {
  assertEntityTarget(entity, () => {
    throw new EntityValidationError(
      'invalid_definition',
      'defineEntityValidation: "entity" must be a class, an EntitySchema, or an entity name',
    );
  });
  assertValidSchema(schema);
  return Object.freeze({ entity, schema });
}

/**
 * Validate data against an entity's schema. Returns an empty array on success,
 * or a flat list of value-free {@link FieldError}s on failure. Never throws
 * for a validation failure — only for an invalid descriptor.
 *
 * Messages come directly from the authored Zod schema (`issue.message`),
 * exactly like `validateFields` in `jsails/validation`. Input values are never
 * echoed.
 */
export function validateEntity(
  validation: EntityValidation<ObjectLiteral>,
  data: unknown,
): FieldError[] {
  const result = validation.schema.safeParse(data);
  if (result.success) {
    return [];
  }

  return result.error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join('.') : '_root';
    return { field, message: issue.message };
  });
}

/**
 * Assert that data is valid for an entity. Calls {@link validateEntity}; if
 * errors are found, throws an {@link EntityValidationError} whose `.errors`
 * carries the field-level issues.
 *
 * The thrown error's `message` is a fixed summary — it never contains field
 * values or issue text.
 */
export function assertEntityValid(
  validation: EntityValidation<ObjectLiteral>,
  data: unknown,
): void {
  const errors = validateEntity(validation, data);
  if (errors.length > 0) {
    throw new EntityValidationError('invalid_entity', 'entity validation failed', errors);
  }
}

/**
 * Build an {@link EntityHooksDefinition} that gates `beforeInsert` and
 * `beforeUpdate` on the entity's registered schema.
 *
 * Each hook calls {@link assertEntityValid} on the hook context's `data`, so
 * an invalid save throws {@link EntityValidationError} and aborts. The error
 * is propagated through the subscriber contract — the caller's `save` rejects
 * and any surrounding transaction rolls back.
 *
 * `beforeInsert` validates the full entity (insert data). `beforeUpdate`
 * validates the entity as passed to `save()` (the changed attributes plus any
 * unchanged columns loaded in the entity). `beforeBulkUpdate` (a query-builder
 * UPDATE such as `Model.update(id, values)`, which carries no row) validates
 * each column it sets against that column's own schema; the object-level
 * schema, and any refinement across columns, cannot be judged from a partial
 * row and is not applied, and a raw SQL expression (a function value) is not
 * data and is skipped. There is no `afterLoad` wiring — load-time validation
 * turns a data-quality issue into an availability outage.
 */
export function entityValidationHooks<Entity extends ObjectLiteral>(
  validation: EntityValidation<Entity>,
): EntityHooksDefinition<Entity> {
  return defineEntityHooks(validation.entity, {
    beforeInsert({ data }) {
      assertEntityValid(validation, data);
    },
    beforeUpdate({ data }) {
      assertEntityValid(validation, data);
    },
    beforeBulkUpdate({ values }) {
      assertSetValuesValid(validation, values);
    },
  });
}

/**
 * Validate the columns a query-builder UPDATE sets, each against its own
 * field schema, so a column absent from the SET map is never judged as
 * `undefined`.
 */
function assertSetValuesValid(
  validation: EntityValidation<ObjectLiteral>,
  values: Record<string, unknown>,
): void {
  const shape = validation.schema.shape;
  const errors: FieldError[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'function' || !Object.hasOwn(shape, key)) continue;
    const field = shape[key];
    if (field === undefined) continue;
    const result = safeParse(field, value);
    if (result.success) continue;
    for (const issue of result.error.issues) {
      errors.push({ field: [key, ...issue.path.map(String)].join('.'), message: issue.message });
    }
  }
  if (errors.length > 0) {
    throw new EntityValidationError('invalid_entity', 'entity validation failed', errors);
  }
}

// ---------------------------------------------------------------------------
// Internal guards
// ---------------------------------------------------------------------------

/**
 * Validate a Zod schema. Rejects non-object, null, and array values, anything
 * without a `safeParse` function, and anything without an object `shape`: a
 * query-builder update is validated column by column through that shape, so a
 * schema that hides it (`.transform()`, `.pipe()`) is refused here rather than
 * failing with a TypeError on the first bulk update.
 */
function assertValidSchema(schema: unknown): asserts schema is z.ZodObject<z.ZodRawShape> {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new EntityValidationError(
      'invalid_definition',
      'defineEntityValidation: "schema" must be a Zod object schema',
    );
  }
  if (typeof (schema as { safeParse?: unknown }).safeParse !== 'function') {
    throw new EntityValidationError(
      'invalid_definition',
      'defineEntityValidation: "schema" must have a safeParse function',
    );
  }
  const shape = (schema as { shape?: unknown }).shape;
  if (shape === null || typeof shape !== 'object' || Array.isArray(shape)) {
    throw new EntityValidationError(
      'invalid_definition',
      'defineEntityValidation: "schema" must be a Zod object schema with a shape',
    );
  }
}
