/**
 * Editor media selection: pure, dependency-free helpers for the content
 * editor's media picker.
 *
 * {@link toMediaRef} projects a {@link MediaAsset} into the lightweight
 * {@link MediaRef} the content model stores in a post body (a stable id plus
 * enough display metadata to render inline; the disk key stays out of the
 * reference so content never hard-codes storage paths).
 *
 * {@link selectMedia} filters and deterministically orders a set of assets for
 * the picker UI: an optional substring search across filename/alt/caption and
 * an optional MIME filter (exact `image/png` or wildcard `image/*`). Ordering
 * is by filename (code-point) then id, so the same inputs always yield the same
 * order regardless of the source order or locale.
 *
 * Both helpers are pure and synchronous; they perform no I/O and raise only
 * `TypeError` for programmer mistakes.
 */

import type { MediaAsset } from './library.js';
import { mimeMatches } from './library.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A media reference embedded in content. Minimal and stable: the `id` is the
 * library's handle (`MediaLibrary.get` / `update` / `remove`), and the rest is
 * display metadata for rendering. Storage stays addressable through the
 * library, never through the reference.
 */
export interface MediaRef {
  /** The asset id in the media library. */
  readonly id: string;
  /** Display name recorded at upload time. */
  readonly filename: string;
  /** MIME type recorded at upload time. */
  readonly mimeType: string;
  /** Optional width in pixels, when recorded. */
  readonly width?: number;
  /** Optional height in pixels, when recorded. */
  readonly height?: number;
}

/** Filter/ordering inputs for {@link selectMedia}. */
export interface MediaSelectionQuery {
  /** Substring term matched case-insensitively against filename/alt/caption. */
  readonly q?: string;
  /** MIME filter: an exact `image/png` or wildcard `image/*` (or `*`). */
  readonly mime?: string;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Code-point ordering: fully deterministic across environments and locales. */
function compareAssets(a: MediaAsset, b: MediaAsset): number {
  if (a.filename !== b.filename) {
    return a.filename < b.filename ? -1 : 1;
  }
  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }
  return 0;
}

/**
 * Filter and deterministically order assets for a media picker.
 *
 * `query.q`, when a non-empty trimmed string, matches case-insensitively
 * against `filename`, `alt`, and `caption`. `query.mime`, when a non-empty
 * trimmed string, filters by {@link mimeMatches} (exact or `type/*`). The
 * result is a sorted copy; the input array is never mutated.
 */
export function selectMedia(
  assets: readonly MediaAsset[],
  query: MediaSelectionQuery = {},
): readonly MediaAsset[] {
  if (!Array.isArray(assets)) {
    throw new TypeError('selectMedia requires an array of assets');
  }
  if (query === null || typeof query !== 'object' || Array.isArray(query)) {
    throw new TypeError('selectMedia query must be an object');
  }
  const term = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';
  const mime = typeof query.mime === 'string' ? query.mime.trim().toLowerCase() : '';

  const filtered = assets.filter((asset) => {
    if (mime !== '' && !mimeMatches(mime, asset.mimeType)) {
      return false;
    }
    if (term === '') {
      return true;
    }
    return (
      asset.filename.toLowerCase().includes(term) ||
      asset.alt.toLowerCase().includes(term) ||
      asset.caption.toLowerCase().includes(term)
    );
  });

  return filtered.slice().sort(compareAssets);
}

/**
 * One page of a selection, plus the total before paging.
 *
 * `total` is the count of assets that matched the query, not the page length,
 * so a picker can show "showing 50 of 1200" without a second request.
 */
export interface MediaSelectionPage {
  readonly assets: readonly MediaAsset[];
  readonly total: number;
}

/** Paging inputs for {@link paginateMedia}. */
export interface MediaPageQuery {
  /** Maximum assets to return. Non-positive or non-finite values yield an empty page. */
  readonly limit?: number;
  /** Assets to skip before the page starts. Negative values are treated as zero. */
  readonly offset?: number;
}

/**
 * Slice an already-filtered, already-ordered selection into one page.
 *
 * Paging happens after {@link selectMedia} so the order is stable across pages:
 * the same query with `offset: 0, 50, 100` yields disjoint, contiguous slices.
 * `total` always reports the full match count.
 */
export function paginateMedia(
  assets: readonly MediaAsset[],
  query: MediaPageQuery = {},
): MediaSelectionPage {
  const total = assets.length;
  const limit = query.limit === undefined ? total : Math.floor(query.limit);
  if (!Number.isFinite(limit) || limit <= 0) {
    return { assets: [], total };
  }
  const offset = query.offset === undefined ? 0 : Math.max(0, Math.floor(query.offset));
  return { assets: assets.slice(offset, offset + limit), total };
}

/**
 * Project an asset into a {@link MediaRef} for storage in content. The returned
 * object is frozen and is a plain-data projection — no disk key, no timestamps.
 */
export function toMediaRef(asset: MediaAsset): MediaRef {
  if (asset === null || typeof asset !== 'object') {
    throw new TypeError('toMediaRef requires an asset');
  }
  return Object.freeze({
    id: asset.id,
    filename: asset.filename,
    mimeType: asset.mimeType,
    ...(asset.width === undefined ? {} : { width: asset.width }),
    ...(asset.height === undefined ? {} : { height: asset.height }),
  });
}
