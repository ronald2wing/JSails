/**
 * Route access references: what every registered route states about who may
 * reach it.
 *
 * Every route the framework serves carries an {@link AccessRef}, and none has
 * a default: a route registered without one fails to compile and fails
 * assembly (`surface.missing_access`). The reference is opaque and
 * brand-checked, so the access chain (`security/access-chain.ts`) is its only
 * reader and a hand-built object is refused.
 *
 * A route states its access as a {@link RouteAccess}:
 * - {@link publicAccess}: anyone may reach the route; the reason is recorded
 *   in the registration snapshot, so a reviewer sees why it is open;
 * - a boolean check (today's `authorize` contract), which core wraps into a
 *   legacy reference: the route is reached only when the check resolves to
 *   exactly `true`; anything else denies, and a throw is a reported fault.
 *
 * Only core constructs a legacy reference ({@link legacyAccess}), so the
 * boolean form has one constructor to delete when policies replace it. No
 * route decides access inside its own handler: there is no reference that
 * defers to it.
 *
 * Browser-safe: no Node or HTTP runtime dependency.
 */

import type { Authorize } from '../contracts/http.js';

declare const accessBrand: unique symbol;

/**
 * Who may reach a route: an opaque reference only the access chain reads.
 * Build a public one with {@link publicAccess}; pass a boolean check as a
 * {@link RouteAccess} for the rest.
 *
 * @public
 */
export interface AccessRef {
  readonly [accessBrand]: true;
  /** How the gate decides: open, or a boolean check. */
  readonly kind: 'public' | 'legacy';
  /** Why the route is open; empty for a boolean check. */
  readonly reason: string;
}

/**
 * What a route states as its access: {@link publicAccess}, or a check that
 * admits a request only by resolving to exactly `true`.
 *
 * @public
 */
export type RouteAccess = AccessRef | Authorize;

/** Every reference this module built, with the check behind a `legacy` one. */
const references = new WeakMap<AccessRef, Authorize | undefined>();

function brand(kind: AccessRef['kind'], reason: string, check?: Authorize): AccessRef {
  const ref = Object.freeze({ kind, reason }) as AccessRef;
  references.set(ref, check);
  return ref;
}

/** A non-empty, single-line reason of at most 200 characters, or `undefined`. */
function validReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const reason = value.trim();
  if (reason === '' || reason.length > 200 || /[\u0000-\u001f\u007f]/.test(reason)) {
    return undefined;
  }
  return reason;
}

/**
 * Anyone may reach the route. `reason` says why (`'sign-in form'`,
 * `'public feed'`) and appears in the registration snapshot.
 *
 * @throws TypeError for a reason that is empty, longer than 200 characters,
 *   or spans lines.
 * @public
 */
export function publicAccess(reason: string): AccessRef {
  const valid = validReason(reason);
  if (valid === undefined) {
    throw new TypeError('publicAccess needs a one-line reason of at most 200 characters');
  }
  return brand('public', valid);
}

/**
 * The route is reached only when `check(context)` resolves to exactly `true`
 * for the route's request context (core only: a route states a check by
 * passing the function as its {@link RouteAccess}).
 */
export function legacyAccess(check: Authorize): AccessRef {
  if (typeof check !== 'function') {
    throw new TypeError('a legacy access needs an authorize function');
  }
  return brand('legacy', '', check);
}

/**
 * `value` as a reference: a reference as it is, a function wrapped as a
 * legacy one, anything else `undefined`.
 */
export function toAccessRef(value: unknown): AccessRef | undefined {
  if (isAccessRef(value)) return value;
  if (typeof value === 'function') return legacyAccess(value as Authorize);
  return undefined;
}

/** Whether `value` is a reference one of this module's constructors built. */
export function isAccessRef(value: unknown): value is AccessRef {
  return typeof value === 'object' && value !== null && references.has(value as AccessRef);
}

/** Whether `value` is a {@link RouteAccess}: a reference this module built, or a function. */
export function isRouteAccess(value: unknown): value is RouteAccess {
  return isAccessRef(value) || typeof value === 'function';
}

/**
 * True for a reference {@link publicAccess} made: brand-checked, so a
 * look-alike `{ kind: 'public' }` object is not one.
 *
 * @public
 */
export function isPublicAccess(value: unknown): value is AccessRef {
  return isAccessRef(value) && value.kind === 'public';
}

/** The check behind a `legacy` reference; `undefined` for any other kind. */
export function accessCheck(ref: AccessRef): Authorize | undefined {
  return references.get(ref);
}
