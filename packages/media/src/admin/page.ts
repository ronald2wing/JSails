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
 * asset's recorded bytes with a validated download disposition. A
 * `?format=json` query (optionally plus `q` and `mime`) returns one page of the
 * selected assets as an `application/json` object `{ assets, total }` for
 * picker consumers; `limit`/`offset` page the result and `total` reports the
 * full match count. Neither branch exposes disk paths; the JSON branch exposes
 * no bytes. Any other query falls through to the HTML list.
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
  type MediaContent,
  type MediaLibrary,
} from '../library.js';
import { paginateMedia, selectMedia, type MediaSelectionPage } from '../selection.js';
import { handleMediaPost } from './mutations.js';
import { renderMediaPage } from './render.js';

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
 * The page's `handleGet`: serve a streamed download for `?download=<id>` or the
 * JSON asset picker for `?format=json`; `undefined` otherwise, so the route
 * falls through to the ordinary HTML list. `?download` wins: when present
 * (even empty) it skips the JSON branch.
 *
 * The download streams the asset's bytes with the recorded MIME type, a
 * validated `Content-Disposition`, a `content-length`, and
 * `cache-control: private, no-store`. A missing id is a value-free 404; a disk
 * failure a value-free 500.
 */
async function handleMediaGet(
  context: AdminPageRenderContext,
  options: MediaAdminPageOptions,
): Promise<Response | undefined> {
  const id = context.url.searchParams.get('download');
  if (id === null || id === '') {
    if (context.url.searchParams.get('format') === 'json') {
      return handleMediaJson(context, options);
    }
    return undefined;
  }

  let content: MediaContent;
  try {
    content = await options.library.content(id);
  } catch (error) {
    if (error instanceof MediaLibraryError && error.code === 'not_found') {
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
 * Filtering/ordering reuse {@link selectMedia} with the `q` and `mime` query
 * parameters, so the response is the same deterministic subset the HTML list
 * renders. `limit` and `offset` page that subset; `total` reports the full
 * match count so a picker can show progress without a second request. The
 * default and maximum page is 1000 entries, so a picker never receives an
 * unbounded list. A library failure maps to a value-free 500.
 */
async function handleMediaJson(
  context: AdminPageRenderContext,
  options: MediaAdminPageOptions,
): Promise<Response> {
  const params = context.url.searchParams;
  let page: MediaSelectionPage;
  try {
    const selected = selectMedia(await options.library.list(), {
      q: params.get('q') ?? '',
      mime: params.get('mime') ?? '',
    });
    page = paginateMedia(selected, {
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
