/**
 * The client-audience constructors: the failures an application raises on
 * purpose for its caller to see (`throw notFound()` from a page load,
 * `throw invalid(issues)` from an action).
 *
 * Their messages are fixed text, so no argument ever reaches a message; what a
 * caller should act on travels as an exposed payload member (`issues`,
 * `reason`) or, for a rate limit, as the `Retry-After` header the problem
 * encoder derives from `retryAfterMs`.
 *
 * Browser-safe: no runtime imports beyond the error kernel's own leaves.
 */

import { isIdentifier } from './context-schema.js';
import type { JsailsError } from './jsails-error.js';
import { defineErrors, KernelErrors, type ErrorRegistry, type Payload } from './registry.js';

/**
 * One validation finding: where in the input, and what rule it broke.
 *
 * @public
 */
export interface ErrorIssue {
  /** Keys and indexes from the input's root to the offending value. */
  readonly path: readonly (string | number)[];
  /** The rule that failed, as a snake_case identifier (`too_small`, `invalid_type`). */
  readonly code: string;
  /** A human-readable explanation, written by the schema's author. */
  readonly message?: string;
}

const REQUEST_ERRORS = {
  not_found: {
    kind: 'not_found',
    audience: 'client',
    message: 'The requested resource was not found.',
  },
  forbidden: {
    kind: 'forbidden',
    audience: 'client',
    message: 'You are not allowed to perform this action.',
  },
  unauthenticated: {
    kind: 'unauthenticated',
    audience: 'client',
    message: 'Authentication is required.',
  },
  conflict: {
    kind: 'conflict',
    audience: 'client',
    message: 'The request conflicts with the current state of the resource.',
    payload: { expose: ['reason'] } as Payload<{ readonly reason: string }>,
  },
  invalid: {
    kind: 'invalid',
    audience: 'client',
    message: 'The request is invalid.',
    payload: { expose: ['issues'] } as Payload<{ readonly issues: readonly ErrorIssue[] }>,
  },
  too_large: {
    kind: 'too_large',
    audience: 'client',
    message: 'The request is too large.',
  },
  rate_limited: {
    kind: 'rate_limited',
    audience: 'client',
    message: 'Too many requests.',
    payload: {} as Payload<{ readonly retryAfterMs: number }>,
  },
} as const;

/**
 * The client-audience codes, `request.*`.
 *
 * @public
 */
export const RequestErrors: ErrorRegistry<'request', typeof REQUEST_ERRORS> = defineErrors(
  'request',
  REQUEST_ERRORS,
);

const ISSUE_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

function invalidArgument(fn: string, argument: string): JsailsError {
  return new KernelErrors.Error('invalid_argument', { function: fn, argument });
}

function copyIssue(issue: unknown): ErrorIssue | undefined {
  if (typeof issue !== 'object' || issue === null) return undefined;
  const { path, code, message } = issue as Record<string, unknown>;
  if (!Array.isArray(path)) return undefined;
  const keys: readonly unknown[] = path;
  if (!keys.every((key) => typeof key === 'string' || typeof key === 'number')) return undefined;
  if (typeof code !== 'string' || !ISSUE_CODE.test(code)) return undefined;
  if (message !== undefined && typeof message !== 'string') return undefined;
  return Object.freeze({
    path: Object.freeze([...keys]),
    code,
    ...(message === undefined ? {} : { message }),
  });
}

/**
 * The addressed resource does not exist (404).
 *
 * @public
 */
export function notFound(): JsailsError {
  return new RequestErrors.Error('not_found');
}

/**
 * The caller may not do this (403).
 *
 * @public
 */
export function forbidden(): JsailsError {
  return new RequestErrors.Error('forbidden');
}

/**
 * The caller has no usable identity (401).
 *
 * @public
 */
export function unauthenticated(): JsailsError {
  return new RequestErrors.Error('unauthenticated');
}

/**
 * The resource's state refuses the change (409). `reason` is a snake_case code
 * the caller can branch on (`email_taken`); it is exposed as the problem's
 * `reason` member and never enters the message.
 *
 * @public
 */
export function conflict(reason: string): JsailsError {
  if (!isIdentifier(reason) || !ISSUE_CODE.test(reason)) {
    throw invalidArgument('conflict', 'reason');
  }
  return new RequestErrors.Error('conflict', {}, { payload: { reason } });
}

/**
 * The input does not satisfy the contract (422); `issues` is exposed as-is.
 *
 * @public
 */
export function invalid(issues: readonly ErrorIssue[]): JsailsError {
  if (!Array.isArray(issues)) throw invalidArgument('invalid', 'issues');
  const copied: ErrorIssue[] = [];
  for (const issue of issues as readonly unknown[]) {
    const copy = copyIssue(issue);
    if (copy === undefined) throw invalidArgument('invalid', 'issues');
    copied.push(copy);
  }
  return new RequestErrors.Error('invalid', {}, { payload: { issues: Object.freeze(copied) } });
}

/**
 * The input exceeds a size limit (413).
 *
 * @public
 */
export function tooLarge(): JsailsError {
  return new RequestErrors.Error('too_large');
}

/**
 * The caller exceeded a rate limit (429). `retryAfterMs` becomes the
 * `Retry-After` header, rounded up to whole seconds.
 *
 * @public
 */
export function rateLimited(retryAfterMs: number): JsailsError {
  if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0) {
    throw invalidArgument('rateLimited', 'retryAfterMs');
  }
  return new RequestErrors.Error('rate_limited', {}, { payload: { retryAfterMs } });
}
