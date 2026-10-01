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
 * locked-down CSP), so the list page itself carries no bytes. With
 * `directUrls` on and a disk that can issue URLs (S3), both branches answer
 * `302` to a short-lived signed URL instead, so the bytes go from the store to
 * the browser without passing through the app; the authorization check still
 * runs first, and the URL carries the recorded type and disposition. A
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
  type AdminPageAuthorize,
  type AdminPageRenderContext,
} from '@jsails/admin';
import { Respond } from 'jsails/api';
import { SIGNED_URL_MAX_EXPIRES_IN_MS } from 'jsails/filesystem';
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
  /**
   * Who may use the page, checked after the panel's own `authorize`; exact
   * `true` allows. Without it the page is served to no one, because the
   * panel gate admits a session to the panel, not to every page in it, and
   * this page uploads, rewrites, and deletes every asset.
   */
  readonly authorize?: AdminPageAuthorize;
  /** Optional path override; when omitted the panel's own `context.path` is used. */
  readonly path?: string;
  /** Byte cap for inlined previews. Defaults to 512 KiB. */
  readonly previewLimitBytes?: number;
  /**
   * Redirect downloads and previews to a signed URL when the library's disk
   * can issue one (`true`, or `{ expiresIn }` in seconds; the lifetime
   * defaults to 5 minutes). Off by default: a signed URL is a bearer link that
   * works for anyone holding it until it expires, and the browser must be
   * allowed to load images from the store's origin.
   */
  readonly directUrls?: boolean | { readonly expiresIn?: number };
  /**
   * The largest form the page's upload `POST` reads, in bytes (the admin
   * page's `maxBodyBytes`; default 1 MiB, at most 100 MiB). A library whose
   * `maxBytes` is raised past the 960 KiB default raises this with it, with
   * room for the multipart framing.
   */
  readonly maxBodyBytes?: number;
}

/** Lifetime of an admin redirect URL: long enough to start a download, no more. */
const DEFAULT_DIRECT_URL_EXPIRES_IN = 300;

/**
 * Define the frozen media admin page descriptor bound to one library. A
 * malformed `directUrls` throws here, at construction, rather than failing
 * every download at request time.
 */
export function defineMediaAdminPage(options: MediaAdminPageOptions): AdminPage {
  assertDirectUrls(options.directUrls);
  return defineAdminPage({
    slug: 'media',
    label: 'Media',
    ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
    render: (context) => renderMediaPage(context, options),
    handleGet: (context) => handleMediaGet(context, options),
    handlePost: (context) => handleMediaPost(context, options),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
  });
}

/** Validate the `directUrls` option's shape and its lifetime bound. */
function assertDirectUrls(direct: unknown): void {
  if (direct === undefined || typeof direct === 'boolean') {
    return;
  }
  if (direct === null || typeof direct !== 'object' || Array.isArray(direct)) {
    throw new TypeError('directUrls must be a boolean or an options object');
  }
  const expiresIn = (direct as { readonly expiresIn?: unknown }).expiresIn;
  if (
    expiresIn !== undefined &&
    (!isPositiveInteger(expiresIn) || expiresIn * 1000 > SIGNED_URL_MAX_EXPIRES_IN_MS)
  ) {
    throw new TypeError('directUrls.expiresIn must be a positive integer up to 7 days');
  }
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
    return handleDownload(context.request, options, id);
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
 * A `302` to a signed URL for `asset` when `directUrls` is on and the disk can
 * issue one; `undefined` to serve the bytes through the app instead.
 */
async function directUrlResponse(
  options: MediaAdminPageOptions,
  asset: MediaAsset,
  disposition: 'inline' | 'attachment',
): Promise<Response | undefined> {
  const direct = options.directUrls;
  if (direct === undefined || direct === false || options.library.url === undefined) {
    return undefined;
  }
  const expiresIn =
    direct === true
      ? DEFAULT_DIRECT_URL_EXPIRES_IN
      : (direct.expiresIn ?? DEFAULT_DIRECT_URL_EXPIRES_IN);
  const location = await options.library.url(asset, { expiresIn, disposition });
  if (location === undefined) {
    return undefined;
  }
  return new Response(null, {
    status: 302,
    headers: {
      location,
      // The signed URL must not outlive its request in a cache, and must not
      // leak through a Referer on the store's side.
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

/**
 * Stream a download: the recorded MIME type, a validated attachment
 * disposition, and `206 Partial Content` for a satisfiable single range.
 */
async function handleDownload(
  request: Request,
  options: MediaAdminPageOptions,
  id: string,
): Promise<Response> {
  const library = options.library;
  const asset = await findAsset(library, id);
  if (asset === undefined) {
    return adminNotFoundResponse();
  }
  try {
    const redirect = await directUrlResponse(options, asset, 'attachment');
    if (redirect !== undefined) {
      return redirect;
    }
  } catch {
    return adminServerErrorResponse();
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
        headers: {
          'content-range': `bytes */${asset.size}`,
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
        },
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
    // The bytes are an upload, served from the admin's own origin: a browser
    // that sniffs them, or renders them despite the attachment disposition,
    // must not run them as a page with the admin's cookies.
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
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
  try {
    const redirect = await directUrlResponse(options, asset, 'inline');
    if (redirect !== undefined) {
      return redirect;
    }
  } catch {
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
