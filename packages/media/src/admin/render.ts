/**
 * The media admin page's HTML: the search form, the multipart upload form, the
 * per-asset edit form (`?edit=<id>`), and the asset table with filename,
 * preview, MIME type, size, alt, created date, and per-row Edit / Download /
 * Delete actions.
 *
 * The list is one page of `library.query` (50 rows, `?page=<n>`), and nothing
 * on it reads asset bytes: a small asset of an allowlisted image type gets a
 * lazily loaded `<img>` pointing at the page's `?preview=<id>` route, and
 * everything else renders a placeholder. Downloads go through the page's
 * streaming `GET` route. Search text is only ever rendered as an input
 * `value`, escaped by Preact's renderer.
 */

import { h, type ComponentChild } from 'preact';

import {
  csrfInput,
  hiddenInput,
  panelDocumentOptions,
  renderAdminDocumentWithTheme,
  renderNotice,
  type AdminPageRenderContext,
} from '@jsails/admin';
import { Num } from 'jsails/support';

import {
  INLINE_IMAGE_TYPES,
  type MediaAsset,
  type MediaLibrary,
  type MediaQueryPage,
} from '../library.js';
import type { MediaAdminPageOptions } from './page.js';

/** Default preview byte cap: larger assets render a placeholder instead of a thumbnail. */
export const DEFAULT_PREVIEW_LIMIT_BYTES: number = 512 * 1024;

/** Rows per page of the HTML list. */
export const MEDIA_LIST_PAGE_SIZE = 50;

/** Stable success notices rendered from the `?notice=` query parameter. */
export const NOTICE_UPLOADED = 'uploaded';
export const NOTICE_UPDATED = 'updated';
export const NOTICE_DELETED = 'deleted';

/**
 * Whether the preview route may serve `asset` as an inline thumbnail: only
 * the raster types in `INLINE_IMAGE_TYPES`; anything else renders a
 * placeholder and the preview route refuses it.
 */
export function isPreviewable(asset: MediaAsset, previewLimitBytes: number): boolean {
  return INLINE_IMAGE_TYPES.includes(asset.mimeType) && asset.size <= previewLimitBytes;
}

/** Resolve the `?notice=` code into its stable human message, or `undefined`. */
function noticeMessage(code: string | null): string | undefined {
  switch (code) {
    case NOTICE_UPLOADED:
      return 'Asset uploaded.';
    case NOTICE_UPDATED:
      return 'Asset updated.';
    case NOTICE_DELETED:
      return 'Asset deleted.';
    default:
      return undefined;
  }
}

/** Render the full document for a `GET` against the bound library. */
export async function renderMediaPage(
  context: AdminPageRenderContext,
  options: MediaAdminPageOptions,
): Promise<string> {
  const { library } = options;
  const path = options.path ?? context.path;
  const csrf = context.session.csrfToken;
  const previewLimitBytes = options.previewLimitBytes ?? DEFAULT_PREVIEW_LIMIT_BYTES;

  const q = context.url.searchParams.get('q') ?? '';
  const editId = context.url.searchParams.get('edit');
  const pageNumber = parsePageNumber(context.url.searchParams.get('page'));

  const page = await library.query({
    q,
    limit: MEDIA_LIST_PAGE_SIZE,
    offset: (pageNumber - 1) * MEDIA_LIST_PAGE_SIZE,
  });

  const body: ComponentChild[] = [h('h1', null, 'Media')];

  const notice = noticeMessage(context.url.searchParams.get('notice'));
  if (notice !== undefined) {
    body.push(renderNotice(notice));
  }

  if (editId === null) {
    body.push(renderSearchForm(path, q));
    body.push(renderUploadForm(path, csrf));
  } else {
    const editing = await safeGet(library, editId);
    if (editing === undefined) {
      body.push(h('p', null, 'Asset not found.'));
      body.push(renderSearchForm(path, q));
    } else {
      body.push(renderEditForm(path, csrf, editing, q));
    }
  }

  body.push(renderTable(page.assets, path, csrf, previewLimitBytes));
  const pager = renderPager(path, q, pageNumber, page);
  if (pager !== undefined) {
    body.push(pager);
  }
  body.push(h('a', { href: path }, 'Back to dashboard'));

  return renderAdminDocumentWithTheme(panelDocumentOptions(context, 'Media'), ...body);
}

/** A 1-based page number from the query; anything malformed is the first page. */
function parsePageNumber(raw: string | null): number {
  const value = raw === null ? 1 : Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

/** Previous/next links, or `undefined` when everything fits on one page. */
function renderPager(
  path: string,
  q: string,
  pageNumber: number,
  page: MediaQueryPage,
): ComponentChild | undefined {
  const pages = Math.max(1, Math.ceil(page.total / MEDIA_LIST_PAGE_SIZE));
  if (pages === 1 && pageNumber === 1) {
    return undefined;
  }
  const href = (target: number): string => {
    const query = new URLSearchParams();
    if (q !== '') {
      query.set('q', q);
    }
    query.set('page', String(target));
    return `${path}/media?${query.toString()}`;
  };
  return h(
    'nav',
    { class: 'admin-pager', 'aria-label': 'Pages' },
    pageNumber > 1 ? h('a', { href: href(pageNumber - 1), rel: 'prev' }, 'Previous') : null,
    h('span', null, ` Page ${pageNumber} of ${pages} (${page.total} assets) `),
    pageNumber < pages ? h('a', { href: href(pageNumber + 1), rel: 'next' }, 'Next') : null,
  );
}

/** `get` that never throws: a library/adapter failure reads as not found. */
function safeGet(library: MediaLibrary, id: string): Promise<MediaAsset | undefined> {
  return library.get(id).catch(() => undefined);
}

/** The search form (submits `q` as a GET parameter). */
function renderSearchForm(path: string, q: string): ComponentChild {
  return h(
    'form',
    { method: 'get', action: `${path}/media` },
    h('label', null, 'Search', h('input', { type: 'text', name: 'q', value: q })),
    h('button', { type: 'submit' }, 'Search'),
  );
}

/** The multipart upload form with optional alt/caption fields. */
function renderUploadForm(path: string, csrf: string): ComponentChild {
  return h(
    'form',
    { method: 'post', action: `${path}/media`, enctype: 'multipart/form-data' },
    csrfInput(csrf),
    hiddenInput('action', 'upload'),
    h('label', null, 'File', h('input', { type: 'file', name: 'file' })),
    h('label', null, 'Alt text', h('input', { type: 'text', name: 'alt' })),
    h('label', null, 'Caption', h('textarea', { name: 'caption' })),
    h('button', { type: 'submit' }, 'Upload'),
  );
}

/** The per-asset edit form for alt/caption. */
function renderEditForm(path: string, csrf: string, asset: MediaAsset, q: string): ComponentChild {
  const back = q === '' ? `${path}/media` : `${path}/media?q=${encodeURIComponent(q)}`;
  return h(
    'form',
    { method: 'post', action: `${path}/media` },
    csrfInput(csrf),
    hiddenInput('action', 'update'),
    hiddenInput('id', asset.id),
    h('label', null, 'Alt text', h('input', { type: 'text', name: 'alt', value: asset.alt })),
    h('label', null, 'Caption', h('textarea', { name: 'caption' }, asset.caption)),
    h('button', { type: 'submit' }, 'Save'),
    h('a', { href: back, role: 'button', style: 'margin-left:8px' }, 'Cancel'),
  );
}

/** The asset table: filename, preview, MIME, size, alt, created, actions. */
function renderTable(
  assets: readonly MediaAsset[],
  path: string,
  csrf: string,
  previewLimitBytes: number,
): ComponentChild {
  if (assets.length === 0) {
    return h('p', null, 'No assets.');
  }
  const rows = assets.map((asset) =>
    h(
      'tr',
      null,
      h('td', null, asset.filename),
      h('td', null, renderPreviewCell(asset, path, previewLimitBytes)),
      h('td', null, asset.mimeType),
      h('td', null, Num.bytes(asset.size, { binary: true })),
      h('td', null, asset.alt),
      h('td', { class: 'admin-date' }, asset.createdAt),
      h('td', null, renderActions(asset, path, csrf)),
    ),
  );
  return h(
    'table',
    null,
    h(
      'thead',
      null,
      h(
        'tr',
        null,
        h('th', null, 'Filename'),
        h('th', null, 'Preview'),
        h('th', null, 'Type'),
        h('th', null, 'Size'),
        h('th', null, 'Alt'),
        h('th', null, 'Created'),
        h('th', null, 'Actions'),
      ),
    ),
    h('tbody', null, ...rows),
  );
}

/**
 * The preview cell: a lazily loaded thumbnail from the preview route for a
 * small allowlisted image, else a placeholder. No bytes are read here.
 */
function renderPreviewCell(
  asset: MediaAsset,
  path: string,
  previewLimitBytes: number,
): ComponentChild {
  if (isPreviewable(asset, previewLimitBytes)) {
    return h('img', {
      src: `${path}/media?preview=${encodeURIComponent(asset.id)}`,
      alt: asset.alt,
      loading: 'lazy',
      width: 48,
      height: 48,
    });
  }
  const reason = INLINE_IMAGE_TYPES.includes(asset.mimeType) ? 'Too large to preview.' : '';
  return h('span', { class: 'admin-preview-placeholder' }, reason);
}

/** The per-row Edit link, Download link, and Delete button. */
function renderActions(asset: MediaAsset, path: string, csrf: string): ComponentChild {
  const id = encodeURIComponent(asset.id);
  return h(
    'div',
    null,
    h('a', { href: `${path}/media?edit=${id}`, style: 'margin-right:8px' }, 'Edit'),
    // The download link points at the streaming route; no bytes are inlined.
    h('a', { href: `${path}/media?download=${id}`, style: 'margin-right:8px' }, 'Download'),
    h(
      'form',
      { method: 'post', action: `${path}/media`, style: 'display:inline' },
      csrfInput(csrf),
      hiddenInput('action', 'delete'),
      hiddenInput('id', asset.id),
      h('button', { type: 'submit' }, 'Delete'),
    ),
  );
}
