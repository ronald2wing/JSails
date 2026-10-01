/**
 * Row scope: which rows a request may see at all. A model resource requires
 * one, so forgetting to scope is a definition error rather than a data leak.
 *
 * `scopedBy(where)` derives a predicate from the request. It returns `null` to
 * mean "no rows": a signed-out caller of an owner-scoped resource gets an empty
 * list and a 404, never the unscoped table. `unscoped(reason)` is the only way
 * out, and it carries a written reason so the choice is visible in review.
 *
 * A scope also checks writes (a created or updated row must still be inside
 * it). A resource whose rows are deliberately not visible to their writer (a
 * moderation queue that creates unapproved rows, an anonymous submission
 * form) opts out with `scopedBy(where, { checkWrites: false, reason })`; like
 * `unscoped`, the opt-out needs a written reason.
 */

import type { RequestContext } from 'jsails';
import type { Q } from 'jsails/database';

import { ModelResourceError } from './resource-error.js';

/** A value or a promise of it. */
export type Awaitable<T> = T | Promise<T>;

/** Rows limited to a request-derived predicate; `null` means none. */
export interface ModelScope {
  readonly kind: 'scoped';
  readonly where: (context: RequestContext) => Awaitable<Q | null>;
  /**
   * Whether creates and updates must leave the row inside the scope. Absent
   * means `true`; `scopedBy` sets `false` only with a written reason.
   */
  readonly checkWrites?: boolean;
  /** Why writes are not checked, when `checkWrites` is `false`. */
  readonly writeCheckReason?: string;
}

/** Options for {@link scopedBy}. */
export type ScopedByOptions =
  | { readonly checkWrites?: true }
  | {
      /** Let a write leave the row outside the writer's scope. */
      readonly checkWrites: false;
      /** Why that is safe; required, so the choice is visible in review. */
      readonly reason: string;
    };

/** Every row, with the reason that is safe. */
export interface ModelUnscoped {
  readonly kind: 'unscoped';
  readonly reason: string;
}

/** Scope rows by a predicate built from the request. */
export function scopedBy(where: ModelScope['where'], options: ScopedByOptions = {}): ModelScope {
  if (typeof where !== 'function') {
    throw new ModelResourceError('invalid_scope', 'scopedBy requires a function');
  }
  if (options === null || typeof options !== 'object') {
    throw new ModelResourceError('invalid_scope', 'scopedBy options must be an object');
  }
  if (options.checkWrites === undefined || options.checkWrites === true) {
    return Object.freeze({ kind: 'scoped', where, checkWrites: true });
  }
  if (options.checkWrites !== false) {
    throw new ModelResourceError('invalid_scope', 'checkWrites must be a boolean');
  }
  const { reason } = options;
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new ModelResourceError(
      'invalid_scope',
      'scopedBy with checkWrites: false requires a non-empty reason',
    );
  }
  return Object.freeze({ kind: 'scoped', where, checkWrites: false, writeCheckReason: reason });
}

/** Opt out of row scope, stating why every row is safe to expose. */
export function unscoped(reason: string): ModelUnscoped {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new ModelResourceError('invalid_scope', 'unscoped requires a non-empty reason');
  }
  return Object.freeze({ kind: 'unscoped', reason });
}
