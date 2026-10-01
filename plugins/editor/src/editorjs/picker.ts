/**
 * Media picker support for the image/gallery block tools.
 *
 * A `mediaPickerUrl` (declared on a `richText` admin field) points at a
 * same-origin endpoint that answers `?format=json` with the media library's
 * plain asset projection (`{ id, filename, mimeType, size, width?, height?,
 * alt, caption, createdAt }[]`). The image and gallery tools fetch that list
 * and let the author pick asset ids instead of typing them.
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

/** Control characters (including the null byte) that never belong in a URL. */
/**
 * Validate a `mediaPickerUrl` for the picker fetch.
 *
 * Allowed shapes (documented contract, enforced here):
 *
 * - a root-relative path starting with `/` (but not `//` — protocol-relative
 *   URLs cannot be judged same-origin and are rejected), e.g. `/admin/media?format=json`;
 * - an absolute `http://` or `https://` URL. The picker fetches with
 *   `credentials: 'same-origin'`, so an absolute URL is only useful when it
 *   resolves to the same origin; a cross-origin absolute URL is refused by the
 *   browser's CORS policy at request time.
 *
 * Anything else — a blank value, control characters, a `javascript:`/`data:`
 * scheme, or an unrooted relative path — is rejected. Relative paths have an
 * ambiguous base (the admin document, not the media root), so they are not
 * accepted.
 *
 * @returns a value-free error message, or `undefined` when the URL is valid.
 */
export function validateMediaPickerUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return 'mediaPickerUrl must be a string';
  }
  if (value.trim() === '') {
    return 'mediaPickerUrl must be a non-empty URL';
  }
  if (CONTROL_CHARS.test(value)) {
    return 'mediaPickerUrl must not contain control characters';
  }
  if (value.startsWith('/') && !value.startsWith('//')) {
    return undefined;
  }
  if (/^https?:\/\//i.test(value)) {
    return undefined;
  }
  return 'mediaPickerUrl must be a root-relative path or an absolute http(s) URL';
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
 * Project an arbitrary picker JSON payload into a stable {@link MediaPickerItem}
 * list, skipping any entry that is not a well-formed asset. The output is
 * plain data used only through `textContent`; nothing here is trusted as HTML.
 */
export function mapMediaAssetsToPickerItems(json: unknown): MediaPickerItem[] {
  if (!Array.isArray(json)) {
    return [];
  }
  const items: MediaPickerItem[] = [];
  for (const entry of json) {
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
