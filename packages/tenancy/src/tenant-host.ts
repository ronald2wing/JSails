/**
 * Classify a request host against the tenancy root domain.
 *
 * {@link matchTenantHost} takes the host string (`Host` header or the
 * request origin's host, port allowed) rather than a `Request`, so whichever
 * layer has already decided which host is authoritative can feed it unchanged.
 * The result says exactly one of:
 *
 * - `apex`: the root domain itself, which is global (no tenant);
 * - `subdomain`: one label below the root that is a valid, unreserved slug;
 * - `reserved`: below the root but never a tenant: a reserved label, a label
 *   that is not a valid slug, or more than one label (`a.b.example.com`). Such
 *   a host is not looked up anywhere, including as a custom domain;
 * - `other`: a host outside the root, which only a verified custom domain can
 *   name;
 * - `invalid`: not a host name at all (see {@link normalizeHostname}).
 */

import { isHostnameWithin, normalizeHostname } from './hostname.js';
import { checkSlug, DEFAULT_SLUG_POLICY, type SlugPolicy } from './slug-policy.js';
import { TenancyError } from './tenancy-error.js';

/** The outcome of {@link matchTenantHost}. */
export type HostMatch =
  | { readonly kind: 'apex' }
  | { readonly kind: 'subdomain'; readonly slug: string }
  | { readonly kind: 'reserved'; readonly hostname: string }
  | { readonly kind: 'other'; readonly hostname: string }
  | { readonly kind: 'invalid' };

/** Options for {@link matchTenantHost}. */
export interface TenantHostOptions {
  /** The domain tenants live under (`example.com` for `acme.example.com`). */
  readonly rootDomain: string;
  readonly policy?: SlugPolicy;
}

/**
 * Normalise a configured root domain. Throws `invalid_root_domain` when it is
 * not a host name.
 */
export function normalizeRootDomain(rootDomain: string): string {
  const normalized = normalizeHostname(rootDomain);
  if (normalized === null) {
    throw new TenancyError('invalid_root_domain');
  }
  return normalized;
}

/** Classify `host` against `options.rootDomain`. */
export function matchTenantHost(host: string, options: TenantHostOptions): HostMatch {
  const root = normalizeRootDomain(options.rootDomain);
  const hostname = normalizeHostname(host);
  if (hostname === null) {
    return { kind: 'invalid' };
  }
  if (hostname === root) {
    return { kind: 'apex' };
  }
  if (!isHostnameWithin(hostname, root)) {
    return { kind: 'other', hostname };
  }
  const label = hostname.slice(0, -(root.length + 1));
  if (label.includes('.')) {
    return { kind: 'reserved', hostname };
  }
  const check = checkSlug(label, options.policy ?? DEFAULT_SLUG_POLICY);
  return check.ok ? { kind: 'subdomain', slug: check.slug } : { kind: 'reserved', hostname };
}
