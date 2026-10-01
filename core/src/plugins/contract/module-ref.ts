/**
 * Module references: how plugin options name application code.
 *
 * An application config is loaded without importing application modules, so
 * an option that needs app code (a policy, a handler module) holds a
 * reference instead: `moduleRef<Policy>('app/policies/post')`, an id relative
 * to the application root, without an extension. The reference is plain data
 * (frozen, comparable by id); the kernel resolves it through the build's
 * module table (KRN-14's `AppManifest.modules`) when the code is needed.
 */

import { PluginErrors } from './errors.js';

/**
 * The brand of a {@link ModuleRef}; `Symbol.for`, so a reference made by one
 * copy of the framework is recognised by another in the same process.
 */
const MODULE_REF: unique symbol = Symbol.for('jsails.module-ref');

declare const moduleDefault: unique symbol;

/**
 * A reference to an application module whose default export is a `T`.
 *
 * @public
 */
export interface ModuleRef<T> {
  readonly [MODULE_REF]: true;
  /** The module's id: a path relative to the application root, without an extension. */
  readonly id: string;
  /** Phantom type slot for the module's default export; never present at runtime. */
  readonly [moduleDefault]?: T;
}

/**
 * A module id: POSIX segments of letters, digits, `_`, `.` and `-`, none
 * starting with a dot (so no `.` or `..` segment), at most 200 characters.
 */
const MODULE_ID = /^(?=.{1,200}$)[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;

/**
 * Reference the application module `id` (`app/policies/post`). Throws
 * `plugin.invalid_module_ref` for an id that is not a relative module path.
 *
 * @public
 */
export function moduleRef<T>(id: string): ModuleRef<T> {
  if (typeof id !== 'string' || !MODULE_ID.test(id)) {
    throw new PluginErrors.Error('invalid_module_ref');
  }
  return Object.freeze({ [MODULE_REF]: true as const, id });
}

/**
 * Whether `value` is a {@link ModuleRef}.
 *
 * @public
 */
export function isModuleRef(value: unknown): value is ModuleRef<unknown> {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<PropertyKey, unknown>;
  return (
    record[MODULE_REF] === true && typeof record['id'] === 'string' && MODULE_ID.test(record['id'])
  );
}
