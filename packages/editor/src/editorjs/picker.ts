/**
 * Media picker support for the image/gallery block tools.
 *
 * A `mediaPickerUrl` (declared on a `richText` admin field) points at a
 * same-origin endpoint that answers `?format=json` with the media library's
 * paged envelope `{ assets, total }`, where each asset is the plain projection
 * `{ id, filename, mimeType, size, width?, height?, alt, caption, createdAt }`.
 * The image and gallery tools fetch that list and let the author pick asset
 * ids instead of typing them.
 *
 * This module is DOM-free and import-safe under Node: it holds only the URL
 * validation policy and the defensive projection from an arbitrary JSON
 * payload into a stable {@link MediaPickerItem} list. Nothing here touches
 * `document`, `window`, or `fetch`; the tools own that interaction.
 */

import { CONTROL_CHARS } from 'jsails/support';

// ---------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------

/** An absolute `http://` or `https://` URL. */
const HTTP_URL = /^https?:\/\//i;

/**
 * True for a root-relative path of the form `/seg/seg`: starts with `/`, is
 * not protocol-relative (`//`), and contains no backslash, control character,
 * or `..` segment. The same rule as `isValidRelativePath` in
 * `jsails/plugin-sdk`; that subpath is server-only and this module runs in the
 * browser, so the rule is repeated here.
 */
function isRootRelativePath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//')) {
    return false;
  }
  if (value.includes('\\') || CONTROL_CHARS.test(value)) {
    return false;
  }
  return !value.split('/').includes('..');
}

/**
 * Whether a `mediaPickerUrl` may be fetched by the picker.
 *
 * Allowed shapes (documented contract, enforced here):
 *
 * - a root-relative path, e.g. `/admin/media?format=json`;
 * - an absolute `http://` or `https://` URL. The picker fetches with
 *   `credentials: 'same-origin'`, so an absolute URL is only useful when it
 *   resolves to the same origin; a cross-origin absolute URL is refused by the
 *   browser's CORS policy at request time.
 *
 * Anything else (a blank value, control characters, a `javascript:`/`data:`
 * scheme, or an unrooted relative path) is rejected. Relative paths have an
 * ambiguous base (the admin document, not the media root), so they are not
 * accepted.
 */
export function isMediaPickerUrl(value: string): boolean {
  if (CONTROL_CHARS.test(value)) {
    return false;
  }
  return isRootRelativePath(value) || HTTP_URL.test(value);
}

// ---------------------------------------------------------------------------
// Asset projection
// ---------------------------------------------------------------------------

/** One selectable asset projected from the picker JSON response. */
export interface MediaPickerItem {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly alt: string;
  readonly caption: string;
}

/**
 * Project a picker JSON payload into a stable {@link MediaPickerItem} list,
 * skipping any entry that is not a well-formed asset. The output is plain data
 * used only through `textContent`; nothing here is trusted as HTML.
 *
 * Accepts the paged envelope `{ assets, total }` the media admin page serves.
 * Anything else projects to an empty list.
 */
export function mapMediaAssetsToPickerItems(json: unknown): MediaPickerItem[] {
  const entries =
    json !== null &&
    typeof json === 'object' &&
    Array.isArray((json as { assets?: unknown }).assets)
      ? (json as { assets: unknown[] }).assets
      : [];
  const items: MediaPickerItem[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const asset = entry as Record<string, unknown>;
    if (typeof asset['id'] !== 'string' || asset['id'].trim() === '') {
      continue;
    }
    if (typeof asset['filename'] !== 'string') {
      continue;
    }
    if (typeof asset['mimeType'] !== 'string') {
      continue;
    }
    if (typeof asset['size'] !== 'number' || !Number.isFinite(asset['size']) || asset['size'] < 0) {
      continue;
    }
    items.push({
      id: asset['id'],
      filename: asset['filename'],
      mimeType: asset['mimeType'],
      size: asset['size'],
      alt: typeof asset['alt'] === 'string' ? asset['alt'] : '',
      caption: typeof asset['caption'] === 'string' ? asset['caption'] : '',
    });
  }
  return items;
}

/**
 * A human-readable label for a picker item, built only from the projected
 * filename and MIME type. Rendered via `textContent`, never as HTML.
 */
export function pickerItemLabel(item: MediaPickerItem): string {
  return item.filename.trim() === '' ? item.mimeType : `${item.filename} (${item.mimeType})`;
}
