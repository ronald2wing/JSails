/**
 * Keyset pagination for tenancy listings.
 *
 * A listing is ordered by an immutable unique key (a user id, a tenant id or a
 * record id), and the cursor names the last key a page returned. The next page
 * starts strictly after it, so rows inserted or deleted between two requests
 * never make an existing row appear twice or go missing, which offset paging
 * cannot promise.
 *
 * The cursor is opaque to callers: the unpadded base64url encoding of the JSON
 * pair `[listing, key]`. Decoding is strict. A cursor from another listing, a
 * non-canonical spelling or a key of the wrong type is refused with
 * `invalid_page_request`, as is a page size outside 1 to
 * {@link MAX_PAGE_LIMIT}. A cursor is not signed: it only positions a listing
 * whose scope (the tenant or user) the caller passes separately.
 */

import { TenancyError } from './tenancy-error.js';

/** The largest page a listing returns. */
export const MAX_PAGE_LIMIT = 200;

/** A request for one page. */
export interface PageRequest {
  /** Items per page, 1 to {@link MAX_PAGE_LIMIT}. */
  readonly limit: number;
  /** The `next` cursor of the previous page. */
  readonly after?: string;
}

/** One page of a listing. */
export interface Page<T> {
  readonly items: readonly T[];
  /** The cursor of the following page, or `null` on the last page. */
  readonly next: string | null;
}

/** The keyset listings and the type of the key each is ordered by. */
export interface PageListings {
  readonly members: string;
  readonly memberships_of_user: number;
  readonly invitations: number;
  readonly audit: number;
}

/** A keyset listing. */
export type PageListing = keyof PageListings;

const KEY_TYPES: Readonly<Record<PageListing, 'string' | 'number'>> = Object.freeze({
  members: 'string',
  memberships_of_user: 'number',
  invitations: 'number',
  audit: 'number',
});

function refused(): TenancyError {
  return new TenancyError('invalid_page_request');
}

/** The cursor naming `key` in `listing`. */
export function encodePageCursor<L extends PageListing>(listing: L, key: PageListings[L]): string {
  return Buffer.from(JSON.stringify([listing, key]), 'utf8').toString('base64url');
}

function decodePageCursor<L extends PageListing>(listing: L, cursor: string): PageListings[L] {
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) {
    throw refused();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw refused();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== listing) {
    throw refused();
  }
  const key: unknown = parsed[1];
  const valid =
    KEY_TYPES[listing] === 'string'
      ? typeof key === 'string' && key.length > 0
      : typeof key === 'number' && Number.isSafeInteger(key) && key > 0;
  if (!valid) {
    throw refused();
  }
  const typed = key as PageListings[L];
  if (encodePageCursor(listing, typed) !== cursor) {
    throw refused();
  }
  return typed;
}

/** A validated page request: the limit and the decoded key to start after. */
export interface PageWindow<K> {
  readonly limit: number;
  readonly after: K | null;
}

/** Validate a page request for `listing`. Throws `invalid_page_request`. */
export function pageWindow<L extends PageListing>(
  listing: L,
  request: PageRequest,
): PageWindow<PageListings[L]> {
  if (typeof request !== 'object' || request === null) {
    throw refused();
  }
  const { limit, after } = request;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw refused();
  }
  return { limit, after: after === undefined ? null : decodePageCursor(listing, after) };
}

/**
 * Cut a page from rows already sorted and filtered to those after the cursor:
 * the first `limit` items, and a cursor when more rows follow.
 */
export function cutPage<T, L extends PageListing>(
  listing: L,
  rows: readonly T[],
  limit: number,
  keyOf: (row: T) => PageListings[L],
): Page<T> {
  const items = Object.freeze(rows.slice(0, limit));
  const last = items.at(-1);
  const next =
    rows.length > limit && last !== undefined ? encodePageCursor(listing, keyOf(last)) : null;
  return Object.freeze({ items, next });
}
