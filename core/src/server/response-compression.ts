/**
 * Response compression with brotli, gzip, and deflate.
 *
 * Replaces `hono/compress`, which offers only gzip and deflate. The encoding
 * is negotiated from `Accept-Encoding` (highest q-value wins; on a tie brotli,
 * then gzip, then deflate), and the body is piped through a `node:zlib`
 * engine, so no dependency is added.
 *
 * What is left alone, as before: a response that already carries a
 * `Content-Encoding` (a precompressed public file) or `Transfer-Encoding`, a
 * 206, a HEAD, a declared body under the threshold, a type that is not
 * compressible (images, archives, and `text/event-stream`, so an SSE stream is
 * never buffered), and anything marked `Cache-Control: no-transform`.
 *
 * Streaming: a compressor holds input until it has enough to emit, which would
 * withhold a progressive page's first chunk, or an ndjson stream's records,
 * indefinitely. A response marked as streamed (`markStreamedResponse`) or
 * declaring no `Content-Length` is therefore flushed after every chunk, so
 * each chunk the producer writes reaches the client as soon as it is
 * compressed. A body built from a string arrives as one chunk, so the flush
 * costs it nothing.
 *
 * Brotli runs at quality 4 in text mode: the higher defaults are tuned for
 * build-time compression and cost far more CPU per request than they save.
 */

import { constants, createBrotliCompress, createDeflate, createGzip } from 'node:zlib';
import type { BrotliCompress, Deflate, Gzip } from 'node:zlib';

import { COMPRESSIBLE_CONTENT_TYPE_REGEX } from 'hono/utils/compress';

import { acceptQuality } from './content-negotiation.js';
import { isStreamedResponse, markStreamedResponse } from './streamed-response.js';
import type { AppMiddlewareHandler } from './env.js';

/** A content coding this middleware can produce. */
export type ResponseEncoding = 'br' | 'gzip' | 'deflate';

/** Preference order when the client weighs several codings equally. */
const ENCODINGS: readonly ResponseEncoding[] = ['br', 'gzip', 'deflate'];

/** Bodies declared smaller than this are sent as they are. */
const DEFAULT_THRESHOLD_BYTES = 1024;

/** Brotli quality for per-request compression (0-11). */
const BROTLI_QUALITY = 4;

const NO_TRANSFORM = /(?:^|,)\s*no-transform\s*(?:,|$)/i;
const VARY_ACCEPT_ENCODING = /(?:^|,)\s*accept-encoding\s*(?:,|$)/i;

/** Options for {@link compressResponses}. */
export interface CompressResponsesOptions {
  /** Minimum declared body size to compress. Defaults to 1024 bytes. */
  readonly threshold?: number;
}

/**
 * The coding to answer `acceptEncoding` with, or `undefined` for identity:
 * the highest positive q-value, `*` standing in for an unlisted coding.
 */
export function selectResponseEncoding(
  acceptEncoding: string | null | undefined,
): ResponseEncoding | undefined {
  let best: ResponseEncoding | undefined;
  let bestQ = 0;
  for (const encoding of ENCODINGS) {
    const q = acceptQuality(acceptEncoding, encoding, ['*']);
    if (q > bestQ) {
      best = encoding;
      bestQ = q;
    }
  }
  return best;
}

/** The response-compression stage of `createApp`. */
export function compressResponses(options: CompressResponsesOptions = {}): AppMiddlewareHandler {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD_BYTES;
  return async (c, next) => {
    await next();
    if (!isCompressible(c.res, c.req.method, threshold)) return;
    // The streamed mark belongs to the response object, which `c.header` below
    // may replace, so it is read first and re-applied to every replacement.
    const streamed = isStreamedResponse(c.res);

    // `c.header` re-creates a response whose headers are immutable (a proxied
    // `fetch()` result) before setting, where `headers.set` would throw. It may
    // replace `c.res`, so the response is read again afterwards.
    const vary = c.res.headers.get('Vary');
    if (vary !== '*' && !(vary !== null && VARY_ACCEPT_ENCODING.test(vary))) {
      c.header('Vary', vary === null ? 'Accept-Encoding' : `${vary}, Accept-Encoding`);
    }

    const response = c.res;
    const encoding = selectResponseEncoding(c.req.header('Accept-Encoding'));
    const body = response.body;
    if (encoding === undefined || body === null) {
      if (streamed) markStreamedResponse(response);
      return;
    }

    const lengthHeader = response.headers.get('Content-Length');
    const declared = lengthHeader === null ? undefined : Number(lengthHeader);
    const sizeHint = declared !== undefined && declared > 0 ? declared : undefined;
    // Without a declared length the body may be a live stream whose producer
    // waits between chunks, so nothing may sit in the compressor's window.
    const flushEachChunk = streamed || declared === undefined;
    // Hono's `c.res` setter re-wraps the response and copies the previous
    // response's headers over it, so headers are adjusted (and the streamed
    // mark re-applied) on the response it ends up holding.
    c.res = new Response(
      body.pipeThrough(zlibTransform(encoding, flushEachChunk, sizeHint)),
      response,
    );
    const headers = c.res.headers;
    headers.delete('Content-Length');
    headers.set('Content-Encoding', encoding);
    const etag = headers.get('ETag');
    if (etag !== null && !etag.startsWith('W/')) headers.set('ETag', `W/${etag}`);
    if (streamed) markStreamedResponse(c.res);
  };
}

/** Whether a finished response may be compressed at all. */
function isCompressible(response: Response, method: string, threshold: number): boolean {
  const headers = response.headers;
  if (response.status === 206 || method === 'HEAD') return false;
  if (headers.has('Content-Encoding') || headers.has('Transfer-Encoding')) return false;
  const length = headers.get('Content-Length');
  if (length !== null && Number(length) < threshold) return false;
  const type = headers.get('Content-Type');
  if (type === null || !COMPRESSIBLE_CONTENT_TYPE_REGEX.test(type)) return false;
  return !NO_TRANSFORM.test(headers.get('Cache-Control') ?? '');
}

/** A `node:zlib` compressor for `encoding`. */
function createEngine(encoding: ResponseEncoding, sizeHint: number | undefined): ZlibEngine {
  if (encoding === 'gzip') return createGzip();
  if (encoding === 'deflate') return createDeflate();
  return createBrotliCompress({
    params: {
      [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      ...(sizeHint === undefined ? {} : { [constants.BROTLI_PARAM_SIZE_HINT]: sizeHint }),
    },
  });
}

type ZlibEngine = BrotliCompress | Gzip | Deflate;

/**
 * A web `TransformStream` over a `node:zlib` engine. With `flushEachChunk`,
 * every written chunk is flushed through before the next is accepted, so a
 * progressive producer's chunks are not held back. Cancelling the stream (a
 * client that disconnects) destroys the engine.
 */
function zlibTransform(
  encoding: ResponseEncoding,
  flushEachChunk: boolean,
  sizeHint: number | undefined,
): TransformStream<Uint8Array, Uint8Array> {
  const engine = createEngine(encoding, sizeHint);
  const flushKind = encoding === 'br' ? constants.BROTLI_OPERATION_FLUSH : constants.Z_SYNC_FLUSH;
  // Output arrives through engine events; once the stream is closed, errored,
  // or cancelled, a late event must not touch the controller.
  let open = true;
  // `cancel` is part of the Streams standard and honored by Node, but not yet
  // in TypeScript's `Transformer` type.
  const transformer: Transformer<Uint8Array, Uint8Array> & { cancel(): void } = {
    start(controller) {
      engine.on('data', (chunk: Buffer) => {
        if (open) controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length));
      });
      engine.on('error', (error: Error) => {
        if (!open) return;
        open = false;
        controller.error(error);
      });
    },
    transform(chunk) {
      return new Promise<void>((resolve, reject) => {
        engine.write(chunk, (error) => {
          if (error !== null && error !== undefined) {
            reject(error);
          } else if (flushEachChunk) {
            engine.flush(flushKind, () => resolve());
          } else {
            resolve();
          }
        });
      });
    },
    flush() {
      return new Promise<void>((resolve, reject) => {
        engine.once('end', () => {
          open = false;
          resolve();
        });
        engine.once('error', reject);
        engine.end();
      });
    },
    cancel() {
      open = false;
      engine.destroy();
    },
  };
  return new TransformStream(transformer);
}
