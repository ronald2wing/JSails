/**
 * The asset responder: the pipeline's fast path for a GET or HEAD of an
 * indexed file, after the guards and before the router.
 *
 * Trust model: in production the index is a deploy-time snapshot. Symbolic
 * links and paths the asset rule refuses are left out when it is built; the
 * open at request time is not validated again (it only refuses to follow a
 * final symlink, which costs nothing). A file replaced after the index was
 * built, so that the open file's size differs from the indexed one, or that
 * is gone, answers a 500 reported as `asset.stale_assets`, never bytes the
 * index did not describe under its validator. A file that is there but fails
 * to open (its permissions changed, no descriptors left) answers a 500
 * reported as `asset.read_failed`. Each failure is reported once per entry:
 * once per path for a snapshot, whose entries never change, and again for a
 * development file once it changes.
 *
 * A development (`watch`) index changes under the responder: after the file
 * is opened, the index is asked again, and an entry other than the one being
 * answered (the file was rewritten between its hash and the open, whatever
 * its size) or an open that finds no file starts the answer over from the
 * index, up to {@link MAX_ATTEMPTS} times, so a request racing a bundler's
 * write is answered from the new bytes under their own hash. A file gone
 * from the index by then passes the request on to the router.
 *
 * The precedence rule may block a path while the responder looks it up (a
 * development index runs it again inside `get` when files moved), so the
 * block list is read again after the lookup.
 *
 * A request's path is decoded once and looked up in the index: a miss costs
 * no filesystem call and passes the request on. A hit:
 * - `Cache-Control: public, max-age=31536000, immutable` when its `v` query is
 *   the entry's hash or the entry is immutable; otherwise
 *   `public, max-age=0, must-revalidate`, so a stale or made-up `v` never pins
 *   bytes in a cache for a year;
 * - a precompressed copy the client accepts (by q-value, brotli on a tie),
 *   with `Vary: Accept-Encoding` whenever the entry has one;
 * - a strong `ETag` of the chosen representation (`"<hash>"`, `"<hash>.br"`,
 *   `"<hash>.gz"`), then the conditional: a match is a 304 before any file is
 *   opened;
 * - one `bytes=` range of the identity file (honoured only when `If-Range`,
 *   if sent, is the identity ETag), a 416 for an unsatisfiable one; several
 *   ranges get the whole representation;
 * - the body: the index's inline bytes, or the chosen file opened once,
 *   checked against the indexed size on the open handle, and streamed from
 *   it. HEAD takes the same path; the finalizer sends no body.
 *
 * The finalizer then treats the answer like any other: it keeps the
 * responder's `Cache-Control`, `ETag` and `Content-Encoding`, adds the
 * request id and the security headers, and may compress an identity answer
 * of a compressible type (weakening its ETag) as it compresses any response.
 */

import { open, type FileHandle } from 'node:fs/promises';

import { toFailure } from '../api/error-response.js';
import { bytesResponse, emptyResponse, streamResponse } from '../api/response-bodies.js';
import { acceptQuality, type ContentCoding } from '../server/content-negotiation.js';
import type { FailureRenderer } from '../server/failure-renderer.js';
import { dropRepresentationHeaders, entityTag, isNotModified } from '../server/output.js';
import type { RequestFrame } from '../server/request-frame.js';
import { AssetErrors, pathSlot } from './asset-errors.js';
import { assetContentType } from './content-type.js';
import type { AssetEntry, AssetIndex, AssetVariant } from './asset-index.js';
import { decodeAssetPath } from './asset-path.js';
import { OPEN_FLAGS, READ_CHUNK_BYTES, readFailedError, readFailureOf } from './asset-walk.js';

/** `Cache-Control` of an immutable entry, or one addressed by its current hash. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** `Cache-Control` of every other asset URL. */
export const REVALIDATE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

/** How many times a request is answered from a development index whose file keeps changing. */
export const MAX_ATTEMPTS = 3;

/** The answer to an asset request: a response, or `undefined` when no asset has the path. */
export interface AssetResponder {
  /**
   * The answer to `frame`'s GET or HEAD, or `undefined` to pass the request
   * on: at once for a path the index does not hold, or once settled for a
   * development file that left the index while it was answered.
   */
  respond(frame: RequestFrame): Promise<Response | undefined> | undefined;
  /** Whether a request for `pathname` (as sent) reaches an asset. */
  serves(pathname: string): boolean;
  /** Stop serving these request paths (decoded): a route answers them. */
  block(paths: ReadonlySet<string>): void;
  /** Whether the request path `path` (decoded) is blocked: a route answers it. */
  blocks(path: string): boolean;
}

/** Options for {@link createAssetResponder}. */
export interface AssetResponderOptions {
  /** Renders the failure of a stale asset. */
  readonly renderFailure: FailureRenderer;
}

/** A representation the responder may send: the identity file or a precompressed copy. */
interface Representation {
  readonly coding: ContentCoding | undefined;
  readonly file: string;
  readonly size: number;
  readonly inline: Uint8Array<ArrayBuffer> | undefined;
}

/** A satisfiable byte range, inclusive. */
interface ByteRange {
  readonly start: number;
  readonly end: number;
}

const CODINGS: readonly ContentCoding[] = ['br', 'gzip'];

/** An answer given up because the entry's file changed after the entry was read. */
class Changed {
  constructor(readonly cause?: unknown) {}
}

/** Answer the requests `index` holds an entry for. */
export function createAssetResponder(
  index: AssetIndex,
  options: AssetResponderOptions,
): AssetResponder {
  const { renderFailure } = options;
  const watching = index.source === 'watch';
  let blocked: ReadonlySet<string> = new Set();
  const reported = new WeakSet<AssetEntry>();

  const entryFor = (pathname: string): AssetEntry | undefined => {
    const path = decodeAssetPath(pathname);
    if (path === undefined || blocked.has(path)) return undefined;
    const entry = index.get(path);
    return entry === undefined || blocked.has(path) ? undefined : entry;
  };

  /** The 500 of `error` on `entry`, reported once per entry. */
  const fail = async (frame: RequestFrame, entry: AssetEntry, error: Error): Promise<Response> => {
    if (!reported.has(entry)) {
      reported.add(entry);
      frame.report(error, 'handler');
    }
    return renderFailure(frame, toFailure(error), { claimless: true });
  };

  /** A failed open or stat of `entry`'s file: changed when it is gone, else a read failure. */
  const openFailed = (
    frame: RequestFrame,
    entry: AssetEntry,
    error: unknown,
  ): Changed | Promise<Response> =>
    readFailureOf(error) === 'gone'
      ? new Changed(error)
      : fail(frame, entry, readFailedError(entry.path, error));

  /** Answer from `first`, starting over from the index while a development file changes. */
  const serve = async (
    frame: RequestFrame,
    pathname: string,
    first: AssetEntry,
  ): Promise<Response | undefined> => {
    let entry = first;
    for (let attempt = 1; ; attempt += 1) {
      const answered = await answer(frame, entry);
      if (!(answered instanceof Changed)) return answered;
      if (!watching || attempt === MAX_ATTEMPTS) {
        const error = new AssetErrors.Error(
          'stale_assets',
          { path: pathSlot(entry.path) },
          { cause: answered.cause },
        );
        return fail(frame, entry, error);
      }
      const next = entryFor(pathname);
      if (next === undefined) return undefined;
      entry = next;
    }
  };

  const answer = async (frame: RequestFrame, entry: AssetEntry): Promise<Response | Changed> => {
    const requestHeaders = frame.request.headers;
    const identityTag = entityTag(entry.hash, undefined);
    const ranged =
      requestHeaders.has('range') && ifRangeHolds(requestHeaders.get('if-range'), identityTag);
    const representation = ranged
      ? identity(entry)
      : chooseRepresentation(entry, requestHeaders.get('accept-encoding'));

    const headers = new Headers({
      // By the name's extension; the index stays free of HTTP concerns, so
      // a static build never loads the type table.
      'content-type': assetContentType(entry.path),
      'cache-control':
        entry.immutable || frame.url.searchParams.get('v') === entry.hash
          ? IMMUTABLE_CACHE_CONTROL
          : REVALIDATE_CACHE_CONTROL,
      etag: entityTag(entry.hash, representation.coding),
      'accept-ranges': 'bytes',
    });
    if (entry.encodings.br !== undefined || entry.encodings.gzip !== undefined) {
      headers.set('vary', 'Accept-Encoding');
    }
    if (representation.coding !== undefined) {
      headers.set('content-encoding', representation.coding);
    }

    if (isNotModified(requestHeaders, 200, headers)) {
      dropRepresentationHeaders(headers);
      return emptyResponse({ status: 304, headers });
    }

    let status = 200;
    let range: ByteRange = { start: 0, end: representation.size - 1 };
    if (ranged) {
      const parsed = parseRange(requestHeaders.get('range') ?? '', representation.size);
      if (parsed === 'unsatisfiable') {
        return emptyResponse({
          status: 416,
          headers: { 'content-range': `bytes */${representation.size}`, 'accept-ranges': 'bytes' },
        });
      }
      if (parsed !== undefined) {
        status = 206;
        range = parsed;
        headers.set('content-range', `bytes ${range.start}-${range.end}/${representation.size}`);
      }
    }
    const length = Math.max(range.end - range.start + 1, 0);
    headers.set('content-length', String(length));

    if (representation.inline !== undefined) {
      const bytes =
        status === 206
          ? representation.inline.subarray(range.start, range.end + 1)
          : representation.inline;
      return bytesResponse(bytes, { status, headers });
    }
    let handle: FileHandle;
    try {
      handle = await open(representation.file, OPEN_FLAGS);
    } catch (error) {
      return openFailed(frame, entry, error);
    }
    let size: number;
    try {
      size = (await handle.stat()).size;
    } catch (error) {
      await handle.close();
      return openFailed(frame, entry, error);
    }
    // A development entry is checked after the open: an entry read before it
    // may describe bytes the open handle no longer holds.
    if (size !== representation.size || (watching && index.get(entry.path) !== entry)) {
      await handle.close();
      return new Changed();
    }
    if (length === 0) {
      await handle.close();
      return bytesResponse(new Uint8Array(0), { status, headers });
    }
    return streamResponse(fileBody(handle, range, entry.path), { status, headers });
  };

  return {
    respond(frame) {
      const pathname = frame.url.pathname;
      const entry = entryFor(pathname);
      return entry === undefined ? undefined : serve(frame, pathname, entry);
    },
    serves: (pathname) => entryFor(pathname) !== undefined,
    block(paths) {
      blocked = paths;
    },
    blocks: (path) => blocked.has(path),
  };
}

/** The identity representation of `entry`. */
function identity(entry: AssetEntry): Representation {
  return { coding: undefined, file: entry.file, size: entry.size, inline: entry.inline };
}

/**
 * The representation to send for `acceptEncoding`: the precompressed copy the
 * client values most (brotli on a tie), else the identity file.
 */
function chooseRepresentation(entry: AssetEntry, acceptEncoding: string | null): Representation {
  let best: { readonly coding: ContentCoding; readonly variant: AssetVariant } | undefined;
  let bestQuality = 0;
  for (const coding of CODINGS) {
    const variant = entry.encodings[coding];
    if (variant === undefined) continue;
    const quality = acceptQuality(acceptEncoding, coding, ['*']);
    if (quality > bestQuality) {
      best = { coding, variant };
      bestQuality = quality;
    }
  }
  if (best === undefined) return identity(entry);
  return {
    coding: best.coding,
    file: best.variant.file,
    size: best.variant.size,
    inline: undefined,
  };
}

/**
 * Whether a range may be honoured: no `If-Range`, or one that is exactly the
 * identity ETag (a date never matches: no `Last-Modified` is sent; a weak tag
 * never matches a range, RFC 9110 §13.1.5).
 */
function ifRangeHolds(ifRange: string | null, identityTag: string): boolean {
  return ifRange === null || ifRange.trim() === identityTag;
}

/**
 * The one range a `Range` header asks of a `size`-byte representation:
 * `undefined` to send it whole (another unit, several ranges, a malformed
 * header), `'unsatisfiable'` for a range that starts past its end.
 */
function parseRange(header: string, size: number): ByteRange | 'unsatisfiable' | undefined {
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (match === null) return undefined;
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return undefined;
  if (first === '') {
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix)) return undefined;
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(size - suffix, 0), end: size - 1 };
  }
  const start = Number(first);
  const end = last === '' ? Number.MAX_SAFE_INTEGER : Number(last);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return undefined;
  if (start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

/**
 * The bytes `range` covers of the open `handle`, read as the client pulls
 * them. The handle is closed when the range ends, when the reader cancels
 * (a client gone, a HEAD answer whose body is dropped), and when a read fails.
 */
function fileBody(handle: FileHandle, range: ByteRange, path: string): ReadableStream<Uint8Array> {
  let position = range.start;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const remaining = range.end + 1 - position;
        try {
          const buffer = new Uint8Array(Math.min(READ_CHUNK_BYTES, remaining));
          const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
          if (bytesRead === 0) {
            // The file shrank under an open handle: the body ends short, never padded.
            controller.error(new AssetErrors.Error('stale_assets', { path: pathSlot(path) }));
            await close();
            return;
          }
          position += bytesRead;
          controller.enqueue(buffer.subarray(0, bytesRead));
          if (position > range.end) {
            await close();
            controller.close();
          }
        } catch (error) {
          controller.error(error);
          await close();
        }
      },
      cancel: () => close(),
    },
    { highWaterMark: 0 },
  );
}
