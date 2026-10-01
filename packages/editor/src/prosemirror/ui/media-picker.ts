/**
 * The media picker of the image and gallery blocks.
 *
 * A `mediaPickerUrl` (declared on a `richText` admin field) points at a
 * same-origin endpoint that answers with the media library's paged envelope
 * `{ assets, total }`, where each asset is the plain projection
 * `{ id, filename, mimeType, size, width?, height?, alt, caption, createdAt }`.
 * The picker fetches it (with `credentials: 'same-origin'`, `limit=50` and,
 * for a search term, `q`), lists the assets by name, and hands the chosen id
 * to the block, so the author picks media instead of typing ids.
 *
 * The URL policy ({@link isMediaPickerUrl}) and the projection
 * ({@link mapMediaAssetsToPickerItems}) are pure; {@link createMediaPicker}
 * builds the DOM. Every label is set through `textContent`, and a failed
 * request shows one fixed message that never echoes the response.
 */

import { isLinkHref } from 'jsails/rich-text';

// ---------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------

/**
 * Whether a `mediaPickerUrl` may be fetched by the picker: a root-relative
 * path (`/admin/media?format=json`, never `//host`) or an absolute `http://`
 * or `https://` URL, either passing the model's link rule (no whitespace,
 * control, bidi or backslash character, no userinfo), and with no `..` path
 * segment. The picker fetches with `credentials: 'same-origin'`, so an
 * absolute URL is only useful on the page's own origin; a cross-origin one is
 * refused by the browser at request time. An unrooted relative path has an
 * ambiguous base (the admin page, not the media root), so it is refused.
 */
export function isMediaPickerUrl(value: string): boolean {
  if (!isLinkHref(value)) {
    return false;
  }
  const rooted = value.startsWith('/') || /^https?:\/\//.test(value);
  const path = value.split(/[?#]/, 1)[0] ?? '';
  return rooted && !path.split('/').includes('..');
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
 * skipping any entry that is not a well-formed asset. Accepts the paged
 * envelope `{ assets, total }`; anything else projects to an empty list.
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
    if (typeof asset['filename'] !== 'string' || typeof asset['mimeType'] !== 'string') {
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

/** A human-readable label for a picker item, from its filename and MIME type. */
export function pickerItemLabel(item: MediaPickerItem): string {
  return item.filename.trim() === '' ? item.mimeType : `${item.filename} (${item.mimeType})`;
}

/** Page size requested from the media endpoint; keeps the payload bounded. */
export const PICKER_PAGE_SIZE = 50;

/** The request URL for `term`: `limit` and, for a search, `q` appended to the endpoint's query. */
export function pickerRequestUrl(url: string, term: string): string {
  const params = new URLSearchParams({ limit: String(PICKER_PAGE_SIZE) });
  if (term !== '') {
    params.set('q', term);
  }
  const [base = '', fragment] = url.split('#', 2);
  const joined = `${base}${base.includes('?') ? '&' : '?'}${params.toString()}`;
  return fragment === undefined ? joined : `${joined}#${fragment}`;
}

// ---------------------------------------------------------------------------
// DOM picker
// ---------------------------------------------------------------------------

/** The fixed text shown when the media list cannot be loaded. */
export const PICKER_ERROR_TEXT = 'The media library could not be loaded.';

/** Options for {@link createMediaPicker}. */
export interface MediaPickerOptions {
  /** The endpoint; it must pass {@link isMediaPickerUrl}. */
  readonly url: string;
  /** Called with the chosen asset. */
  readonly onSelect: (item: MediaPickerItem) => void;
}

let pickerCount = 0;

/**
 * A search box, a "Show media" button and the result list. The fetched page
 * is cached per picker and term, so showing the list again costs no request;
 * filtering stays server-side, so the client never holds the whole library.
 */
export function createMediaPicker(options: MediaPickerOptions): HTMLElement {
  pickerCount += 1;
  const id = `rich-text-media-picker-${String(pickerCount)}`;
  const root = document.createElement('div');
  root.className = 'rich-text-editor-picker';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Media library');

  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Search media';
  search.setAttribute('aria-label', 'Search media');
  search.setAttribute('aria-controls', `${id}-results`);

  const show = document.createElement('button');
  show.type = 'button';
  show.textContent = 'Show media';

  const status = document.createElement('p');
  status.className = 'rich-text-editor-picker-status';
  status.setAttribute('role', 'status');

  const results = document.createElement('ul');
  results.id = `${id}-results`;
  results.className = 'rich-text-editor-picker-results';

  let cached: { readonly term: string; readonly items: readonly MediaPickerItem[] } | undefined;
  // Only the latest search may answer: every search, a cache hit included,
  // takes a new number, so a response still in flight for an earlier term
  // can never overwrite the results of the term now in the box.
  let latestRequest = 0;

  const render = (items: readonly MediaPickerItem[]): void => {
    results.replaceChildren();
    status.textContent = items.length === 0 ? 'No media found.' : `${String(items.length)} found.`;
    for (const item of items) {
      const entry = document.createElement('li');
      const choose = document.createElement('button');
      choose.type = 'button';
      choose.textContent = pickerItemLabel(item);
      choose.addEventListener('click', () => {
        options.onSelect(item);
      });
      entry.append(choose);
      results.append(entry);
    }
  };

  const load = (): void => {
    const term = search.value.trim();
    latestRequest += 1;
    const request = latestRequest;
    if (cached?.term === term) {
      render(cached.items);
      return;
    }
    status.textContent = 'Loading…';
    fetch(pickerRequestUrl(options.url, term), { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) {
          return undefined;
        }
        return mapMediaAssetsToPickerItems(await response.json());
      })
      .then(
        (items) => {
          if (request !== latestRequest) {
            return;
          }
          if (items === undefined) {
            status.textContent = PICKER_ERROR_TEXT;
            return;
          }
          cached = { term, items };
          render(items);
        },
        () => {
          // A network failure or malformed JSON shows the one fixed message;
          // nothing from the response reaches the page.
          if (request === latestRequest) {
            status.textContent = PICKER_ERROR_TEXT;
          }
        },
      );
  };

  show.addEventListener('click', load);
  search.addEventListener('keydown', (event) => {
    // Enter searches; inside the app's form it would otherwise submit the form.
    if (event.key === 'Enter') {
      event.preventDefault();
      load();
    }
  });
  root.append(search, show, status, results);
  return root;
}
