/**
 * The media admin page's HTML: the search form, the multipart upload form, the
 * per-asset edit form (`?edit=<id>`), and the asset table with filename,
 * preview, MIME type, size, alt, created date, and per-row Edit / Download /
 * Delete actions.
 *
 * Previews inline a `data:` URL only for small assets of an allowlisted image
 * type; everything else renders a placeholder, and downloads always go through
 * the page's streaming `GET` route rather than inlined bytes. Search text is
 * only ever rendered as an input `value`, escaped by Preact's renderer.
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
import { Encoding, Num } from 'jsails/support';

import type { MediaAsset, MediaContent, MediaLibrary } from '../library.js';
import { selectMedia } from '../selection.js';
import type { MediaAdminPageOptions } from './page.js';

/** Default preview byte cap: assets larger than this render a placeholder instead of a data URL. */
const DEFAULT_PREVIEW_LIMIT_BYTES = 512 * 1024;

/** Stable success notices rendered from the `?notice=` query parameter. */
export const NOTICE_UPLOADED = 'uploaded';
export const NOTICE_UPDATED = 'updated';
export const NOTICE_DELETED = 'deleted';

/**
 * MIME types that may be inlined as an image preview. SVG is deliberately
 * excluded (it can carry scripts); anything not on this list renders a
 * placeholder and is never serialized into a `data:` image.
 */
const PREVIEW_IMAGE_TYPES: readonly string[] = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
]);

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

  const assets = selectMedia(await library.list(), { q });

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

  body.push(await renderTable(assets, path, csrf, library, previewLimitBytes));
  body.push(h('a', { href: path }, 'Back to dashboard'));

  return renderAdminDocumentWithTheme(panelDocumentOptions(context, 'Media'), ...body);
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
async function renderTable(
  assets: readonly MediaAsset[],
  path: string,
  csrf: string,
  library: MediaLibrary,
  previewLimitBytes: number,
): Promise<ComponentChild> {
  if (assets.length === 0) {
    return h('p', null, 'No assets.');
  }
  const rows = await Promise.all(
    assets.map(async (asset) => {
      const preview = await readPreview(library, asset, previewLimitBytes);
      return h(
        'tr',
        null,
        h('td', null, asset.filename),
        h('td', null, renderPreviewCell(asset, preview)),
        h('td', null, asset.mimeType),
        h('td', null, Num.bytes(asset.size, { binary: true })),
        h('td', null, asset.alt),
        h('td', { class: 'admin-date' }, asset.createdAt),
        h('td', null, renderActions(asset, path, csrf)),
      );
    }),
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
 * Read and encode an asset's bytes for inline preview, bounded by
 * `previewLimitBytes`. Returns `undefined` when the asset is over the limit, so
 * callers never serialize huge payloads. The MIME allowlist for image previews
 * is applied separately (in {@link renderPreviewCell}); the recorded MIME is
 * only used as the `data:` prefix, which is safe for any recorded type. A
 * read/encode failure also returns `undefined` so a broken disk never takes the
 * whole table down.
 */
async function readPreview(
  library: MediaLibrary,
  asset: MediaAsset,
  previewLimitBytes: number,
): Promise<string | undefined> {
  if (asset.size > previewLimitBytes) {
    return undefined;
  }
  let content: MediaContent;
  try {
    content = await library.content(asset.id);
  } catch {
    return undefined;
  }
  return Encoding.toDataUrl(content.mimeType, content.bytes);
}

/** The preview cell: a thumbnail for small inlineable images, else a placeholder. */
function renderPreviewCell(asset: MediaAsset, dataUrl: string | undefined): ComponentChild {
  const previewable = PREVIEW_IMAGE_TYPES.includes(asset.mimeType);
  if (dataUrl !== undefined && previewable) {
    return h('img', { src: dataUrl, alt: asset.alt, loading: 'lazy', width: 48, height: 48 });
  }
  const reason = dataUrl === undefined && previewable ? 'Too large to preview.' : '';
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
