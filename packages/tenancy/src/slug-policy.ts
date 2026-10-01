/**
 * Tenant slugs: the policy, the check and the suggestion.
 *
 * A slug names a tenant in a subdomain (`acme.example.com`) and in a path
 * prefix (`/t/acme`), so it must be a valid DNS label and an unreserved URL
 * segment at the same time. A canonical slug is lower-case ASCII letters,
 * digits and single hyphens, starts and ends with a letter or digit, and is not
 * all digits (so a slug can never be confused with a numeric tenant id). It
 * never contains `--`, which keeps it clear of IDNA `xn--` labels.
 *
 * The reserved list stops a tenant from taking a host the app or its mail and
 * DNS setup needs (`www`, `api`, `mail`, `autoconfig`, ...). A policy built by
 * {@link slugPolicy} extends {@link DEFAULT_RESERVED_SLUGS} unless it says
 * otherwise. Refusals are value-free codes; the input is never echoed.
 */

import { MAX_LABEL_LENGTH } from './hostname.js';
import { TenancyError } from './tenancy-error.js';

/** The rules a slug must satisfy. Built by {@link slugPolicy}; frozen. */
export interface SlugPolicy {
  readonly minLength: number;
  readonly maxLength: number;
  /** Lower-case reserved slugs, sorted. */
  readonly reserved: readonly string[];
}

/** Options for {@link slugPolicy}. */
export interface SlugPolicyOptions {
  /** Shortest accepted slug; defaults to 3. */
  readonly minLength?: number;
  /** Longest accepted slug, at most 63; defaults to 63. */
  readonly maxLength?: number;
  /** Additional reserved slugs, compared case-insensitively. */
  readonly reserved?: Iterable<string>;
  /** Keep {@link DEFAULT_RESERVED_SLUGS} alongside `reserved`; defaults to true. */
  readonly extendDefaults?: boolean;
}

/** The outcome of {@link checkSlug}. */
export type SlugCheck =
  | { readonly ok: true; readonly slug: string }
  | {
      readonly ok: false;
      readonly code: 'invalid_slug' | 'reserved_slug' | 'too_short' | 'too_long';
    };

/**
 * Labels a tenant may never take: hosts an app, its mail and its DNS commonly
 * need, plus names that read as the operator's own.
 */
export const DEFAULT_RESERVED_SLUGS: readonly string[] = Object.freeze(
  [
    'abuse',
    'account',
    'accounts',
    'admin',
    'administrator',
    'api',
    'app',
    'apps',
    'assets',
    'auth',
    'autoconfig',
    'autodiscover',
    'billing',
    'blog',
    'cdn',
    'dashboard',
    'dev',
    'docs',
    'email',
    'files',
    'ftp',
    'help',
    'hostmaster',
    'imap',
    'localhost',
    'login',
    'logout',
    'mail',
    'media',
    'mta-sts',
    'mx',
    'ns',
    'ns1',
    'ns2',
    'ns3',
    'ns4',
    'oauth',
    'operator',
    'pop',
    'pop3',
    'postmaster',
    'public',
    'register',
    'root',
    'security',
    'settings',
    'signin',
    'signup',
    'smtp',
    'sso',
    'staging',
    'static',
    'status',
    'support',
    'system',
    'test',
    'webmail',
    'webmaster',
    'wpad',
    'www',
  ].sort(),
);

const DEFAULT_MIN_LENGTH = 3;

const SLUG_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function assertLength(value: number, min: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > MAX_LABEL_LENGTH) {
    throw new TenancyError('invalid_slug_policy');
  }
  return value;
}

/** Build a frozen {@link SlugPolicy}. Throws `invalid_slug_policy` on bad options. */
export function slugPolicy(options: SlugPolicyOptions = {}): SlugPolicy {
  const minLength = assertLength(options.minLength ?? DEFAULT_MIN_LENGTH, 1);
  const maxLength = assertLength(options.maxLength ?? MAX_LABEL_LENGTH, minLength);
  const reserved = new Set(options.extendDefaults === false ? [] : DEFAULT_RESERVED_SLUGS);
  for (const entry of options.reserved ?? []) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new TenancyError('invalid_slug_policy');
    }
    reserved.add(entry.toLowerCase());
  }
  return Object.freeze({
    minLength,
    maxLength,
    reserved: Object.freeze([...reserved].sort()),
  });
}

/** The policy used when none is given. */
export const DEFAULT_SLUG_POLICY: SlugPolicy = slugPolicy();

function lowerAscii(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * Check a slug against a policy. Surrounding whitespace is trimmed and ASCII
 * letters are lower-cased; nothing else is repaired.
 */
export function checkSlug(input: string, policy: SlugPolicy = DEFAULT_SLUG_POLICY): SlugCheck {
  if (typeof input !== 'string') {
    return { ok: false, code: 'invalid_slug' };
  }
  const slug = lowerAscii(input.trim());
  if (slug.length < policy.minLength) {
    return { ok: false, code: 'too_short' };
  }
  if (slug.length > policy.maxLength) {
    return { ok: false, code: 'too_long' };
  }
  if (!SLUG_SHAPE.test(slug) || slug.includes('--') || /^[0-9]+$/.test(slug)) {
    return { ok: false, code: 'invalid_slug' };
  }
  if (policy.reserved.includes(slug)) {
    return { ok: false, code: 'reserved_slug' };
  }
  return { ok: true, slug };
}

/** Letters NFKD does not decompose into an ASCII base, folded by hand. */
const LETTER_FOLDS: Readonly<Record<string, string>> = Object.freeze({
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  þ: 'th',
  ı: 'i',
  ħ: 'h',
});

/**
 * Suggest a slug for a display name: NFKD-fold to ASCII, lower-case, collapse
 * every other run of characters into one hyphen, and cut to the policy's
 * maximum length. Returns `null` when the result would not pass
 * {@link checkSlug} (too short, all digits, or reserved), so the caller asks
 * for a slug instead of inventing one.
 */
export function suggestSlug(name: string, policy: SlugPolicy = DEFAULT_SLUG_POLICY): string | null {
  if (typeof name !== 'string') {
    return null;
  }
  const folded = name
    .slice(0, 1024)
    .toLowerCase()
    .replace(/[ßæœøđðłþıħ]/g, (letter) => LETTER_FOLDS[letter] ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = folded.slice(0, policy.maxLength).replace(/-+$/, '');
  const check = checkSlug(cut, policy);
  return check.ok ? check.slug : null;
}
