/**
 * Media admin page: the server-rendered admin surface for the media library.
 *
 * {@link defineMediaPage} builds one {@link AdminPage} (slug `media`, label
 * `Media`) that reads and mutates a caller-supplied {@link MediaLibrary}. The
 * library is captured by closure, so an application that also serves media
 * bytes elsewhere must hand the same instance here and to any other media
 * surface, exactly as the blog repository is shared between its HTTP and admin
 * slices.
 *
 * ## GET
 *
 * The page lists every asset from `library.list()`, honoring an optional `q`
 * query parameter through {@link selectMedia}, and renders a search form, a
 * multipart upload form, and a table of filename / MIME type / size / alt /
 * created date / per-row Edit and Delete actions. A `?edit=<id>` query renders
 * an edit form for alt/caption pre-filled with the current values plus Save and
 * Cancel. A `?download=<id>` query short-circuits the HTML render through the
 * page's `handleGet`, streaming the asset's recorded bytes back down with a
 * validated download disposition. A `?format=json` query (optionally plus `q`)
 * returns the selected assets as an `application/json` array for picker
 * consumers, again short-circuiting the HTML render; it never exposes disk
 * paths or raw bytes.
 *
 * ## POST
 *
 * Three actions, dispatched on the `action` field: `upload`, `update`, and
 * `delete`. The core admin panel has already enforced the auth gate, a
 * same-origin `Origin`, and a constant-time `_csrf` check, so this module only
 * applies the media library's own policy and its value-free error responses.
 *
 * - `upload` reads the request with {@link readFormBodyAndFiles}, takes the
 *   first file part, and calls `library.upload`. Client-supplied size/width/
 *   height are ignored, and the declared MIME is only trusted as far as the
 *   library itself validates it.
 * - `update` calls `library.update(id, { alt, caption })`; a missing id is a
 *   404.
 * - `delete` calls `library.remove(id)`; a `not_found` maps to 404, other media
 *   failures map to a value-free 400/500.
 *
 * Every error response is value-free: filenames, ids, MIME types, and error
 * details are never echoed. Search/query text is only ever rendered as an input
 * `value`, escaped by Preact's renderer.
 */

import { h, type ComponentChild } from 'preact';

import {
  adminBadRequestResponse,
  adminNotFoundResponse,
  adminRedirectResponse,
  adminServerErrorResponse,
  defineAdminPage,
  readFormBodyAndFiles,
  renderAdminDocumentWithTheme,
  type AdminPage,
  type AdminPagePostContext,
  type AdminPageRenderContext,
  type UploadedFilePart,
} from '@jsails/admin';

import { Encoding, Url } from 'jsails/support';

import { MediaError, type MediaAsset, type MediaContent, type MediaLibrary } from '../library.js';
import { selectMedia } from '../selection.js';

/** Stable success notices rendered from the `?notice=` query parameter. */
export const MEDIA_NOTICE_UPLOADED = 'uploaded';
export const MEDIA_NOTICE_UPDATED = 'updated';
export const MEDIA_NOTICE_DELETED = 'deleted';

/** Default preview byte cap: assets larger than this render a placeholder instead of a data URL. */
export const DEFAULT_PREVIEW_LIMIT_BYTES = 512 * 1024;

/** Maximum number of assets returned by the `?format=json` picker response. */
export const MAX_JSON_RESULTS = 1000;

/**
 * MIME types that may be inlined as an image preview. SVG is deliberately
 * excluded (it can carry scripts); anything not on this list renders a
 * placeholder and is never serialized into a `data:` image.
 */
export const PREVIEW_IMAGE_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
];

/** The page renderer, bound to one library instance. */
export interface MediaPageSource {
  readonly library: MediaLibrary;
  /** Optional path override; when omitted the panel's own `context.path` is used. */
  readonly path?: string;
  /** Byte cap for inlined previews (default {@link DEFAULT_PREVIEW_LIMIT_BYTES}). */
  readonly previewLimitBytes?: number;
}

/** Resolve the `?notice=` code into its stable human message, or `undefined`. */
function noticeMessage(code: string | null): string | undefined {
  switch (code) {
    case MEDIA_NOTICE_UPLOADED:
      return 'Asset uploaded.';
    case MEDIA_NOTICE_UPDATED:
      return 'Asset updated.';
    case MEDIA_NOTICE_DELETED:
      return 'Asset deleted.';
    default:
      return undefined;
  }
}

/** Render the full document for a `GET` against the bound library. */
export async function renderMediaPage(
  context: AdminPageRenderContext,
  source: MediaPageSource,
): Promise<string> {
  const { library } = source;
  const path = source.path ?? context.path;
  const csrf = context.session.csrfToken;
  const previewLimitBytes = source.previewLimitBytes ?? DEFAULT_PREVIEW_LIMIT_BYTES;

  const q = context.url.searchParams.get('q') ?? '';
  const editId = context.url.searchParams.get('edit');

  const assets = selectMedia(await library.list(), { q });

  const body: ComponentChild[] = [h('h1', null, 'Media')];

  const notice = noticeMessage(context.url.searchParams.get('notice'));
  if (notice !== undefined) {
    body.push(h('p', { role: 'status' }, notice));
  }

  if (editId === null) {
    body.push(renderSearchForm(path, q));
    body.push(renderUploadForm(path, csrf));
  } else {
    const editing = await safeGet(library, editId);
    if (editing === undefined || editing === null) {
      body.push(h('p', null, 'Asset not found.'));
      body.push(renderSearchForm(path, q));
    } else {
      body.push(renderEditForm(path, csrf, editing.id, editing.alt, editing.caption, q));
    }
  }

  body.push(await renderTable(assets, path, csrf, library, previewLimitBytes));
  body.push(h('a', { href: path }, 'Back to dashboard'));

  return renderAdminDocumentWithTheme(
    { title: 'Media', theme: context.theme, themeCustomization: context.themeCustomization },
    ...body,
  );
}

/** `get` that never throws: a library/adapter failure becomes `null` (not found). */
function safeGet(library: MediaLibrary, id: string): Promise<MediaAsset | undefined | null> {
  return library.get(id).catch(() => null);
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
    h('input', { type: 'hidden', name: '_csrf', value: csrf }),
    h('input', { type: 'hidden', name: 'action', value: 'upload' }),
    h('label', null, 'File', h('input', { type: 'file', name: 'file' })),
    h('label', null, 'Alt text', h('input', { type: 'text', name: 'alt' })),
    h('label', null, 'Caption', h('textarea', { name: 'caption' })),
    h('button', { type: 'submit' }, 'Upload'),
  );
}

/** The per-asset edit form for alt/caption. */
function renderEditForm(
  path: string,
  csrf: string,
  id: string,
  alt: string,
  caption: string,
  q: string,
): ComponentChild {
  const back = q === '' ? `${path}/media` : `${path}/media?q=${encodeURIComponent(q)}`;
  return h(
    'form',
    { method: 'post', action: `${path}/media` },
    h('input', { type: 'hidden', name: '_csrf', value: csrf }),
    h('input', { type: 'hidden', name: 'action', value: 'update' }),
    h('input', { type: 'hidden', name: 'id', value: id }),
    h('label', null, 'Alt text', h('input', { type: 'text', name: 'alt', value: alt })),
    h('label', null, 'Caption', h('textarea', { name: 'caption' }, caption)),
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
      const content = await readAssetContent(library, asset, previewLimitBytes);
      return h(
        'tr',
        null,
        h('td', null, asset.filename),
        h('td', null, renderPreviewCell(asset, content)),
        h('td', null, asset.mimeType),
        h('td', null, formatSize(asset.size)),
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

/** A successfully read asset payload, or `undefined` when it should not be inlined. */
interface PreviewData {
  readonly dataUrl: string;
}

/**
 * Read and encode an asset's bytes for inline preview, bounded by
 * `previewLimitBytes`. Returns `undefined` when the asset is over the limit, so
 * callers never serialize huge payloads. The MIME allowlist for image previews
 * is applied separately (in {@link renderPreviewCell}); the recorded MIME is
 * only used as the `data:` prefix, which is safe for any recorded type. A
 * read/encode failure also returns `undefined` so a broken disk never takes the
 * whole table down. Downloads never use these inlined bytes: they stream from a
 * dedicated route.
 */
async function readAssetContent(
  library: MediaLibrary,
  asset: MediaAsset,
  previewLimitBytes: number,
): Promise<PreviewData | undefined> {
  if (asset.size > previewLimitBytes) {
    return undefined;
  }
  let content: MediaContent;
  try {
    content = await library.content(asset.id);
  } catch {
    return undefined;
  }
  return { dataUrl: Encoding.toDataUrl(content.mimeType, content.bytes) };
}

/** The preview cell: a thumbnail for small inlineable images, else a placeholder. */
function renderPreviewCell(asset: MediaAsset, content: PreviewData | undefined): ComponentChild {
  if (content !== undefined && PREVIEW_IMAGE_TYPES.includes(asset.mimeType)) {
    return h('img', {
      src: content.dataUrl,
      alt: asset.alt,
      loading: 'lazy',
      width: 48,
      height: 48,
    });
  }
  const reason =
    content === undefined && PREVIEW_IMAGE_TYPES.includes(asset.mimeType)
      ? 'Too large to preview.'
      : '';
  return h('span', { class: 'admin-preview-placeholder' }, reason);
}

/** A human-readable byte size (binary units). */
function formatSize(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1);
  return `${rounded} ${units[unit]}`;
}

/** The per-row Edit link, Download link, and Delete button. */
function renderActions(asset: MediaAsset, path: string, csrf: string): ComponentChild {
  return h(
    'div',
    null,
    h(
      'a',
      { href: `${path}/media?edit=${encodeURIComponent(asset.id)}`, style: 'margin-right:8px' },
      'Edit',
    ),
    renderDownload(asset, path),
    h(
      'form',
      { method: 'post', action: `${path}/media`, style: 'display:inline' },
      h('input', { type: 'hidden', name: '_csrf', value: csrf }),
      h('input', { type: 'hidden', name: 'action', value: 'delete' }),
      h('input', { type: 'hidden', name: 'id', value: asset.id }),
      h('button', { type: 'submit' }, 'Delete'),
    ),
  );
}

/**
 * A per-asset download link to the streaming route (`?download=<id>`). No bytes
 * are inlined: the download is served by the page's `handleGet`, which streams
 * the recorded bytes with a validated `Content-Disposition`.
 */
function renderDownload(asset: MediaAsset, path: string): ComponentChild {
  return h(
    'a',
    { href: `${path}/media?download=${encodeURIComponent(asset.id)}`, style: 'margin-right:8px' },
    'Download',
  );
}

// ---------------------------------------------------------------------------
// GET download
// ---------------------------------------------------------------------------

/**
 * The page's `handleGet`: serve a streamed download for `?download=<id>` or a
 * JSON asset picker for `?format=json`.
 *
 * `?download` wins: when present (even empty) it skips the JSON branch. When the
 * download query is absent and `?format=json` is set, {@link handleMediaJson}
 * returns the selected assets as `application/json`. Otherwise it returns
 * `undefined`, so the route falls through to the ordinary HTML list.
 *
 * For the download branch, the matching asset's bytes are streamed with the
 * recorded MIME type, a validated `Content-Disposition`, a `content-length`, and
 * `cache-control: private, no-store`. A missing id is a value-free 404; a disk
 * failure is a value-free 500. No id, filename, MIME type, or error detail is
 * echoed.
 */
export async function handleMediaGet(
  context: AdminPageRenderContext,
  source: MediaPageSource,
): Promise<Response | undefined> {
  const id = context.url.searchParams.get('download');
  if (id === null || id === '') {
    if (context.url.searchParams.get('format') === 'json') {
      return handleMediaJson(context, source);
    }
    return undefined;
  }

  let content: MediaContent;
  try {
    content = await source.library.content(id);
  } catch (error) {
    if (error instanceof MediaError && error.code === 'not_found') {
      return adminNotFoundResponse();
    }
    return adminServerErrorResponse();
  }

  const body = new Uint8Array(content.bytes.byteLength);
  body.set(content.bytes);
  return new Response(body.buffer, {
    headers: {
      'content-type': content.mimeType,
      'content-disposition': Url.contentDisposition(content.filename, { type: 'attachment' }),
      'content-length': String(content.bytes.byteLength),
      'cache-control': 'private, no-store',
    },
  });
}

// ---------------------------------------------------------------------------
// GET JSON picker
// ---------------------------------------------------------------------------

/**
 * One asset in the `?format=json` picker response. A stable, plain-data
 * projection with no disk key and no bytes; width/height are omitted entirely
 * when the asset recorded none. Timestamps stay ISO-8601 strings.
 */
interface MediaJsonEntry {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly width?: number;
  readonly height?: number;
  readonly alt: string;
  readonly caption: string;
  readonly createdAt: string;
}

/** Project one asset into a {@link MediaJsonEntry}, dropping the disk key and bytes. */
function toJsonEntry(asset: MediaAsset): MediaJsonEntry {
  return {
    id: asset.id,
    filename: asset.filename,
    mimeType: asset.mimeType,
    size: asset.size,
    ...(asset.width === undefined ? {} : { width: asset.width }),
    ...(asset.height === undefined ? {} : { height: asset.height }),
    alt: asset.alt,
    caption: asset.caption,
    createdAt: asset.createdAt,
  };
}

/**
 * Serve the `?format=json` picker: the selected assets as a stable
 * `application/json` array, cap-bounded to {@link MAX_JSON_RESULTS}.
 *
 * Filtering/ordering reuse {@link selectMedia} with the `q` query parameter, so
 * the response is the same deterministic subset the HTML list renders. A
 * library failure maps to a value-free 500 (no id, filename, or error detail);
 * disk paths and raw bytes never leave the library. The array is a plain
 * projection of public metadata only.
 */
async function handleMediaJson(
  context: AdminPageRenderContext,
  source: MediaPageSource,
): Promise<Response> {
  let assets: readonly MediaAsset[];
  try {
    assets = selectMedia(await source.library.list(), {
      q: context.url.searchParams.get('q') ?? '',
    });
  } catch {
    return adminServerErrorResponse();
  }

  const entries = assets.slice(0, MAX_JSON_RESULTS).map(toJsonEntry);
  return new Response(JSON.stringify(entries), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
    },
  });
}

// ---------------------------------------------------------------------------
// POST dispatch
// ---------------------------------------------------------------------------

/** Dispatch the page POST on the submitted `action` field. */
export async function handleMediaPost(
  context: AdminPagePostContext,
  source: MediaPageSource,
): Promise<Response> {
  const { library } = source;
  const path = source.path ?? context.path;
  const action = context.body['action'];

  switch (action) {
    case 'upload':
      return handleUpload(context, library, path);
    case 'update':
      return handleUpdate(context, library, path);
    case 'delete':
      return handleDelete(context, library, path);
    default:
      return adminBadRequestResponse();
  }
}

/** The redirect target after a successful mutation, carrying a stable notice. */
function redirectWithNotice(path: string, notice: string): Response {
  return adminRedirectResponse(`${path}/media?notice=${notice}`);
}

/** Handle `upload`: read the first file part and call `library.upload`. */
async function handleUpload(
  context: AdminPagePostContext,
  library: MediaLibrary,
  path: string,
): Promise<Response> {
  // The admin route parses the multipart body once and hands the file parts
  // through the post context. Direct callers of this handler can omit `files`;
  // in that case read a still-unconsumed request as a fallback.
  const files = context.files ?? (await readFormBodyAndFiles(context.request)).files;
  const file = firstFilePart(files);
  if (file === undefined) {
    return adminBadRequestResponse();
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return adminBadRequestResponse();
  }
  if (bytes.byteLength === 0) {
    return adminBadRequestResponse();
  }

  const alt = context.body['alt'];
  const caption = context.body['caption'];

  try {
    await library.upload({
      bytes,
      filename: file.name,
      mimeType: file.type === '' ? 'application/octet-stream' : file.type,
      ...(alt === undefined ? {} : { alt }),
      ...(caption === undefined ? {} : { caption }),
    });
  } catch (error) {
    return mapMediaFailure(error);
  }

  return redirectWithNotice(path, MEDIA_NOTICE_UPLOADED);
}

/** Handle `update`: patch alt/caption; a missing id is a 404. */
async function handleUpdate(
  context: AdminPagePostContext,
  library: MediaLibrary,
  path: string,
): Promise<Response> {
  const id = context.body['id'];
  if (id === undefined || id === '') {
    return adminBadRequestResponse();
  }
  const alt = context.body['alt'];
  const caption = context.body['caption'];

  try {
    const updated = await library.update(id, {
      ...(alt === undefined ? {} : { alt }),
      ...(caption === undefined ? {} : { caption }),
    });
    if (updated === undefined) {
      return adminNotFoundResponse();
    }
  } catch (error) {
    return mapMediaFailure(error);
  }

  return redirectWithNotice(path, MEDIA_NOTICE_UPDATED);
}

/** Handle `delete`: remove and map `not_found` (and other failures) value-free. */
async function handleDelete(
  context: AdminPagePostContext,
  library: MediaLibrary,
  path: string,
): Promise<Response> {
  const id = context.body['id'];
  if (id === undefined || id === '') {
    return adminBadRequestResponse();
  }

  try {
    await library.remove(id);
  } catch (error) {
    return mapMediaFailure(error);
  }

  return redirectWithNotice(path, MEDIA_NOTICE_DELETED);
}

/** The first file part from a parsed multipart body, or `undefined` when none. */
function firstFilePart(files: ReadonlyMap<string, UploadedFilePart>): UploadedFilePart | undefined {
  return files.values().next().value;
}

/** Map a media failure to a value-free response. Raw input is never echoed. */
function mapMediaFailure(error: unknown): Response {
  if (error instanceof MediaError) {
    switch (error.code) {
      case 'not_found':
        return adminNotFoundResponse();
      case 'too_large':
      case 'unsupported_type':
      case 'invalid_input':
      case 'path_rejected':
        return adminBadRequestResponse();
      case 'disk_failed':
        return adminServerErrorResponse();
    }
  }
  return adminServerErrorResponse();
}

/** Build the frozen media admin page descriptor bound to one library. */
export function defineMediaPage(source: MediaPageSource): AdminPage {
  return defineAdminPage({
    slug: 'media',
    label: 'Media',
    render: (context) => renderMediaPage(context, source),
    handleGet: (context) => handleMediaGet(context, source),
    handlePost: (context) => handleMediaPost(context, source),
  });
}
