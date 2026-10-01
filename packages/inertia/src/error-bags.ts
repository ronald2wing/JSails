/**
 * The `errors` prop shape: the default bag, named bags, and the error-bag rule.
 *
 * Validation errors are grouped in bags. The client reads `props.errors`
 * directly, or `props.errors[bag]` when the form that submitted set an error
 * bag (`X-Inertia-Error-Bag`). The reference adapter shapes the prop with one
 * rule, transcribed here from inertia-laravel `Middleware::resolveValidationErrors`:
 *
 * - a default bag and an error-bag header: `{ [header]: defaultBag }`;
 * - a default bag and no header: the default bag itself, unwrapped;
 * - no default bag: every named bag under its own name.
 *
 * Shaping happens when the errors are written (on the failing mutation, whose
 * request carries the header), not when they are read on the page that
 * follows the redirect, because whether a redirected request keeps the header
 * depends on the client's redirect handling.
 */

import { FORBIDDEN_KEYS } from './plain-data.js';

/** Field errors: a dotted field path to its first message, or to every message. */
export type InertiaErrors = Readonly<Record<string, string | readonly string[]>>;

/** Field errors grouped under error-bag names. */
export type InertiaErrorBags = Readonly<Record<string, InertiaErrors>>;

/** The name of the bag errors land in when the form names none. */
export const DEFAULT_ERROR_BAG = 'default';

/**
 * Shape bags into the `errors` prop for a request whose error-bag header is
 * `errorBag` (`null` when absent). A reserved bag name from the header is
 * treated as absent, so a header can never introduce a prototype key.
 */
export function shapeErrorBags(
  bags: InertiaErrorBags,
  errorBag: string | null,
): InertiaErrors | InertiaErrorBags {
  const defaultBag = Object.hasOwn(bags, DEFAULT_ERROR_BAG) ? bags[DEFAULT_ERROR_BAG] : undefined;
  if (defaultBag === undefined) return bags;
  if (errorBag === null || errorBag === '' || FORBIDDEN_KEYS.has(errorBag)) return defaultBag;
  const wrapped: Record<string, InertiaErrors> = {};
  wrapped[errorBag] = defaultBag;
  return wrapped;
}
