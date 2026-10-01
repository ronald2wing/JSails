/**
 * Read a tenant slug from a path prefix (`/t/acme/projects`).
 *
 * {@link matchTenantPath} splits a URL pathname into the slug and the rest of
 * the path, so the router can strip the prefix the way it strips a locale
 * prefix. Paths are case-sensitive and arrive percent-encoded, so only the
 * canonical spelling matches: `/t/Acme` and `/t/%61cme` are not tenant paths
 * (an app that wants them can redirect to the canonical form). A slug the
 * policy rejects, reserved ones included, never matches.
 */

import { checkSlug, DEFAULT_SLUG_POLICY, type SlugPolicy } from './slug-policy.js';
import { TenancyError } from './tenancy-error.js';

/** A matched tenant path: the slug and the remaining path, always starting with `/`. */
export interface TenantPathMatch {
  readonly slug: string;
  readonly rest: string;
}

const PREFIX_SHAPE = /^(?:\/[a-z0-9][a-z0-9-]*)+$/;

/**
 * Validate a tenant path prefix: one or more lower-case segments, a leading
 * slash and no trailing one. Throws `invalid_path_prefix`.
 */
export function assertTenantPathPrefix(prefix: string): asserts prefix is `/${string}` {
  if (typeof prefix !== 'string' || !PREFIX_SHAPE.test(prefix)) {
    throw new TenancyError('invalid_path_prefix');
  }
}

/** Match `pathname` against `prefix`, returning the slug and the rest, or `null`. */
export function matchTenantPath(
  pathname: string,
  prefix: `/${string}`,
  policy: SlugPolicy = DEFAULT_SLUG_POLICY,
): TenantPathMatch | null {
  assertTenantPathPrefix(prefix);
  const base = `${prefix}/`;
  if (typeof pathname !== 'string' || !pathname.startsWith(base)) {
    return null;
  }
  const tail = pathname.slice(base.length);
  const end = tail.indexOf('/');
  const segment = end === -1 ? tail : tail.slice(0, end);
  const check = checkSlug(segment, policy);
  if (!check.ok || check.slug !== segment) {
    return null;
  }
  return { slug: segment, rest: end === -1 ? '/' : tail.slice(end) };
}
