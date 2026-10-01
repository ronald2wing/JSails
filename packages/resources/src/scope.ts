/**
 * Row scope: which rows a request may see at all. A model resource requires
 * one, so forgetting to scope is a definition error rather than a data leak.
 *
 * `scopedBy(where)` derives a predicate from the request. It returns `null` to
 * mean "no rows": a signed-out caller of an owner-scoped resource gets an empty
 * list and a 404, never the unscoped table. `unscoped(reason)` is the only way
 * out, and it carries a written reason so the choice is visible in review.
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
}

/** Every row, with the reason that is safe. */
export interface ModelUnscoped {
  readonly kind: 'unscoped';
  readonly reason: string;
}

/** Scope rows by a predicate built from the request. */
export function scopedBy(where: ModelScope['where']): ModelScope {
  if (typeof where !== 'function') {
    throw new ModelResourceError('invalid_scope', 'scopedBy requires a function');
  }
  return Object.freeze({ kind: 'scoped', where });
}

/** Opt out of row scope, stating why every row is safe to expose. */
export function unscoped(reason: string): ModelUnscoped {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new ModelResourceError('invalid_scope', 'unscoped requires a non-empty reason');
  }
  return Object.freeze({ kind: 'unscoped', reason });
}
