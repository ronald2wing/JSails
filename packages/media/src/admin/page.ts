/**
 * Media admin page: the {@link AdminPage} descriptor (slug `media`, label
 * `Media`) bound to a caller-supplied {@link MediaLibrary}, plus its two
 * non-HTML `GET` branches. The HTML render lives in `./render.js` and the
 * `POST` mutations in `./mutations.js`.
 *
 * The library is captured by closure, so an application that also serves
 * media bytes elsewhere must hand the same instance here and to any other
 * media surface, exactly as the blog repository is shared between its HTTP and
 * admin slices.
 *
 * ## GET
 *
 * A `?download=<id>` query short-circuits the HTML render, streaming the
 * asset's recorded bytes with a validated download disposition; a single
 * `Range: bytes=a-b` is answered with `206` so large files resume. A
 * `?preview=<id>` query serves a small image inline for the list's lazy
 * thumbnails (only allowlisted raster types under the preview cap, with a
 * locked-down CSP), so the list page itself carries no bytes. A
 * `?format=json` query (optionally plus `q` and `mime`) returns one page of the
 * selected assets as an `application/json` object `{ assets, total }` for
 * picker consumers; `limit`/`offset` page the result through the index and
 * `total` reports the full match count. No branch exposes disk paths; the JSON
 * branch exposes no bytes. Any other query falls through to the HTML list.
 *
 * Every error response is value-free: filenames, ids, MIME types, and error
 * details are never echoed.
 */

import {
  adminNotFoundResponse,
  adminServerErrorResponse,
  defineAdminPage,
  type AdminPage,
  type AdminPageRenderContext,
} from '@jsails/admin';
import { Respond } from 'jsails/api';
import { isNonNegativeInteger, isPositiveInteger } from 'jsails/plugin-sdk';
import { Url } from 'jsails/support';

import {
  MediaLibraryError,
  type MediaAsset,
  type MediaLibrary,
  type MediaQueryPage,
  type MediaRange,
  type MediaStream,
} from '../library.js';
import { handleMediaPost } from './mutations.js';
import { DEFAULT_PREVIEW_LIMIT_BYTES, isPreviewable, renderMediaPage } from './render.js';

/** Maximum number of assets returned by the `?format=json` picker response. */
const MAX_JSON_RESULTS = 1000;

/** Options for {@link defineMediaAdminPage}: the library the page is bound to. */
export interface MediaAdminPageOptions {
  readonly library: MediaLibrary;
  /** Optional path override; when omitted the panel's own `context.path` is used. */
  readonly path?: string;
  /** Byte cap for inlined previews. Defaults to 512 KiB. */
  readonly previewLimitBytes?: number;
}

/** Define the frozen media admin page descriptor bound to one library. */
export function defineMediaAdminPage(options: MediaAdminPageOptions): AdminPage {
  return defineAdminPage({
    slug: 'media',
    label: 'Media',
    render: (context) => renderMediaPage(context, options),
    handleGet: (context) => handleMediaGet(context, options),
    handlePost: (context) => handleMediaPost(context, options),
  });
}

/**
 * The page's `handleGet`: a streamed download for `?download=<id>`, a list
 * thumbnail for `?preview=<id>`, or the JSON asset picker for `?format=json`;
 * `undefined` otherwise, so the route falls through to the ordinary HTML list.
 * `?download` wins over the others, even when empty values are present for
 * them. A missing id is a value-free 404; a disk failure a value-free 500.
 */
async function handleMediaGet(
  context: AdminPageRenderContext,
  options: MediaAdminPageOptions,
): Promise<Response | undefined> {
  const params = context.url.searchParams;
  const id = params.get('download');
  if (id !== null && id !== '') {
    return handleDownload(context.request, options.library, id);
  }
  const previewId = params.get('preview');
  if (previewId !== null && previewId !== '') {
    return handlePreview(options, previewId);
  }
  if (params.get('format') === 'json') {
    return handleMediaJson(context, options);
  }
  return undefined;
}

/** Look an asset up, reading a library failure as "not there". */
async function findAsset(library: MediaLibrary, id: string): Promise<MediaAsset | undefined> {
  try {
    return await library.get(id);
  } catch {
    return undefined;
  }
}

/**
 * Parse a single `bytes=start-end` or `bytes=start-` range. Anything else —
 * several ranges, a suffix range, garbage — is `undefined`, and the whole file
 * is served, which RFC 9110 permits.
 */
function parseRange(header: string | null): MediaRange | undefined {
  const match = header === null ? null : /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (match === null) {
    return undefined;
  }
  const start = Number(match[1]);
  const end = match[2] === '' || match[2] === undefined ? undefined : Number(match[2]);
  return end === undefined ? { start } : { start, end };
}

/**
 * Stream a download: the recorded MIME type, a validated attachment
 * disposition, and `206 Partial Content` for a satisfiable single range.
 */
async function handleDownload(
  request: Request,
  library: MediaLibrary,
  id: string,
): Promise<Response> {
  const asset = await findAsset(library, id);
  if (asset === undefined) {
    return adminNotFoundResponse();
  }
  const range = parseRange(request.headers.get('range'));
  let content: MediaStream;
  try {
    content = await library.stream(asset, range);
  } catch (error) {
    if (error instanceof MediaLibraryError && error.code === 'not_found') {
      return adminNotFoundResponse();
    }
    if (error instanceof MediaLibraryError && error.code === 'invalid_range') {
      return new Response(null, {
        status: 416,
        headers: { 'content-range': `bytes */${asset.size}`, 'cache-control': 'private, no-store' },
      });
    }
    return adminServerErrorResponse();
  }
  const headers: Record<string, string> = {
    'content-type': content.mimeType,
    'content-disposition': Url.contentDisposition(content.filename, { type: 'attachment' }),
    'content-length': String(content.end - content.start + 1),
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
  };
  if (range !== undefined) {
    headers['content-range'] = `bytes ${content.start}-${content.end}/${content.size}`;
  }
  return new Response(content.stream, { status: range === undefined ? 200 : 206, headers });
}

/**
 * Serve one list thumbnail. Only an allowlisted raster type within the
 * preview cap is served, inline and under a CSP that permits nothing, so the
 * route can never render an uploaded document as a page.
 */
async function handlePreview(options: MediaAdminPageOptions, id: string): Promise<Response> {
  const limit = options.previewLimitBytes ?? DEFAULT_PREVIEW_LIMIT_BYTES;
  const asset = await findAsset(options.library, id);
  if (asset === undefined || !isPreviewable(asset, limit)) {
    return adminNotFoundResponse();
  }
  let content: MediaStream;
  try {
    content = await options.library.stream(asset);
  } catch {
    return adminNotFoundResponse();
  }
  return new Response(content.stream, {
    headers: {
      'content-type': content.mimeType,
      'content-length': String(content.size),
      'content-disposition': 'inline',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=300',
    },
  });
}

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
 * Serve the `?format=json` picker: one page of the selected assets as a stable
 * `application/json` object `{ assets, total }`.
 *
 * Filtering, ordering, and paging go through `library.query` with the `q` and
 * `mime` query parameters, so the response is the same deterministic subset
 * the HTML list renders and only one page is read from the index. `total`
 * reports the full match count so a picker can show progress without a second
 * request. The default and maximum page is 1000 entries. A library failure
 * maps to a value-free 500.
 */
async function handleMediaJson(
  context: AdminPageRenderContext,
  options: MediaAdminPageOptions,
): Promise<Response> {
  const params = context.url.searchParams;
  let page: MediaQueryPage;
  try {
    page = await options.library.query({
      q: params.get('q') ?? '',
      mime: params.get('mime') ?? '',
      limit: Math.min(
        parseQueryInteger(params.get('limit'), MAX_JSON_RESULTS, isPositiveInteger),
        MAX_JSON_RESULTS,
      ),
      offset: parseQueryInteger(params.get('offset'), 0, isNonNegativeInteger),
    });
  } catch {
    return adminServerErrorResponse();
  }

  return Respond.json(
    { assets: page.assets.map(toJsonEntry), total: page.total },
    { headers: { 'cache-control': 'private, no-store' } },
  );
}

/**
 * Parse a paging query parameter, falling back to `fallback` when it is
 * missing or `accept` rejects it. A malformed page parameter must not fail the
 * request — the picker degrades to the default page.
 */
function parseQueryInteger(
  raw: string | null,
  fallback: number,
  accept: (value: unknown) => value is number,
): number {
  if (raw === null || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  return accept(value) ? value : fallback;
}
