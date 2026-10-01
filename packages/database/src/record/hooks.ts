/**
 * Record hooks: the functions a model gives `defineModel` beside its spec,
 * which the write pipeline calls around a record write.
 *
 * ```ts
 * defineModel(Post, spec, {
 *   hooks: {
 *     beforeSave({ record }) { record.slug = slugify(record.title); },
 *     afterCommit({ record, operation }) { notify(operation, record.id); },
 *   },
 *   validate: z.object({ title: z.string().min(1) }),
 * });
 * ```
 *
 * Every hook receives the caller's full instance (`record`), the operation,
 * the changed columns as `[before, after]` pairs, and the transaction it runs
 * in. Before hooks see the changes as they stood when the write began; after
 * hooks and `afterCommit` see what was written. The order of a save is
 * `beforeSave`, `beforeInsert` or `beforeUpdate`, validation, the write and
 * its declared effects, `afterInsert` or `afterUpdate`, `afterSave`; a
 * destroy runs `beforeDelete`, the dependents, the delete and its effects,
 * `afterDelete`. `afterCommit` runs once the outermost transaction commits,
 * and never when it rolls back. A hook that throws fails the write and rolls
 * back its transaction.
 *
 * Hooks run for record writes only: set writes (`updateAll`, `deleteAll`,
 * `insertAll`) and the pipeline's own effect writes never call them, and a
 * set write on a model with hooks must say so (`{ skipHooks: true }`). There
 * is no `afterLoad`: decoding and the change baseline are structural.
 *
 * The behaviour is checked and frozen when the model is defined, so the
 * effect plan of a model is computed once.
 */

import type { ColumnKey } from '../statement/where.js';
import type { Tx } from '../transaction/run-transaction.js';
import { ModelSpecError } from '../model/model-error.js';
import type { RecordValidator } from './validation.js';

/** What a record write does to its row. */
export type RecordOperation = 'insert' | 'update' | 'delete';

/** What a hook receives. */
export interface RecordHookContext<T> {
  /** The caller's full instance. */
  readonly record: T;
  readonly operation: RecordOperation;
  /**
   * The changed columns, each `[before, after]`: every set column of an
   * insert (`before` is `undefined`), the changed columns of an update, and
   * nothing for a delete.
   */
  readonly changes: ReadonlyMap<ColumnKey<T>, readonly [before: unknown, after: unknown]>;
  /** The transaction the write runs in. */
  readonly tx: Tx;
}

/** One hook. */
export type RecordHook<T> = (context: RecordHookContext<T>) => void | Promise<void>;

/** The hooks a model may declare. */
export interface RecordHooks<T> {
  readonly beforeSave?: RecordHook<T>;
  readonly beforeInsert?: RecordHook<T>;
  readonly beforeUpdate?: RecordHook<T>;
  readonly beforeDelete?: RecordHook<T>;
  readonly afterInsert?: RecordHook<T>;
  readonly afterUpdate?: RecordHook<T>;
  readonly afterDelete?: RecordHook<T>;
  readonly afterSave?: RecordHook<T>;
  readonly afterCommit?: RecordHook<T>;
}

/** What `defineModel` takes beside the spec. */
export interface RecordBehavior<T> {
  readonly hooks?: RecordHooks<T>;
  /** Validates the full instance before every insert and update. */
  readonly validate?: RecordValidator;
}

/** The name of a hook. */
export type HookName = keyof RecordHooks<object>;

/** Every hook name, in the order the pipeline may call them. */
export const HOOK_NAMES: readonly HookName[] = Object.freeze([
  'beforeSave',
  'beforeInsert',
  'beforeUpdate',
  'beforeDelete',
  'afterInsert',
  'afterUpdate',
  'afterDelete',
  'afterSave',
  'afterCommit',
]);

/** The hooks a write of each operation may call. */
export const OPERATION_HOOKS: Readonly<Record<RecordOperation, readonly HookName[]>> =
  Object.freeze({
    insert: Object.freeze<HookName[]>([
      'beforeSave',
      'beforeInsert',
      'afterInsert',
      'afterSave',
      'afterCommit',
    ]),
    update: Object.freeze<HookName[]>([
      'beforeSave',
      'beforeUpdate',
      'afterUpdate',
      'afterSave',
      'afterCommit',
    ]),
    delete: Object.freeze<HookName[]>(['beforeDelete', 'afterDelete', 'afterCommit']),
  });

/** A model's behaviour as the definition keeps it: the record type erased. */
export interface StoredBehavior {
  readonly hooks: Readonly<Partial<Record<HookName, (context: never) => unknown>>>;
  readonly validate: RecordValidator | undefined;
}

const BEHAVIOR_KEYS: ReadonlySet<string> = new Set(['hooks', 'validate']);
const HOOK_NAME_SET: ReadonlySet<string> = new Set(HOOK_NAMES);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Check and freeze the behaviour `defineModel` was given.
 *
 * @throws {ModelSpecError} `invalid_spec` naming `hooks.<name>` or
 *   `validate` for an unknown hook, a hook that is not a function, or a
 *   validator without `safeParse`.
 */
export function checkBehavior(value: unknown, model: string): StoredBehavior {
  const fail = (field: string): never => {
    throw new ModelSpecError('invalid_spec', { model, field });
  };
  if (!isRecord(value)) return fail('behavior');
  for (const key of Object.keys(value)) if (!BEHAVIOR_KEYS.has(key)) fail(key);
  const hooks: Partial<Record<HookName, (context: never) => unknown>> = {};
  if (value.hooks !== undefined) {
    if (!isRecord(value.hooks)) return fail('hooks');
    for (const [name, hook] of Object.entries(value.hooks)) {
      if (!HOOK_NAME_SET.has(name)) fail(`hooks.${name}`);
      if (hook === undefined) continue;
      if (typeof hook !== 'function') fail(`hooks.${name}`);
      hooks[name as HookName] = hook as (context: never) => unknown;
    }
  }
  const validate = value.validate;
  if (
    validate !== undefined &&
    (!isRecord(validate) ||
      typeof (validate as { readonly safeParse?: unknown }).safeParse !== 'function')
  ) {
    fail('validate');
  }
  return Object.freeze({
    hooks: Object.freeze(hooks),
    validate: validate as RecordValidator | undefined,
  });
}

/** Whether `behavior` declares any hook a write of `operation` calls, or validation for a save. */
export function runsRecordLogic(
  behavior: StoredBehavior | undefined,
  operation: RecordOperation,
): boolean {
  if (behavior === undefined) return false;
  if (operation !== 'delete' && behavior.validate !== undefined) return true;
  return OPERATION_HOOKS[operation].some((name) => behavior.hooks[name] !== undefined);
}

/** A hook context as the pipeline builds it, before the record type is known. */
export interface PipelineHookContext {
  readonly record: object;
  readonly operation: RecordOperation;
  readonly changes: ReadonlyMap<string, readonly [before: unknown, after: unknown]>;
  readonly tx: Tx;
}

/** Call hook `name` of `behavior`, if declared, with `context`. */
export async function runHook(
  behavior: StoredBehavior | undefined,
  name: HookName,
  context: PipelineHookContext,
): Promise<void> {
  const hook = behavior?.hooks[name] as ((context: PipelineHookContext) => unknown) | undefined;
  if (hook !== undefined) await hook(context);
}
