/**
 * The response finalizer: the only code that reads or rewrites a response
 * after its producer returned.
 *
 * Every response, whoever produced it (a `Respond` factory, a raw `Response`,
 * a proxied `fetch()`, a page, a guard, an error page), passes through
 * {@link finalize} once, in a fixed order:
 *
 * 1. adopt: its status, a fresh copy of its headers (so a `Response.redirect`
 *    or a fetched response's immutable headers never matter), and its body
 *    kind. A body the framework built (`response-bodies.ts`) is known
 *    without reading it; a recorded stream that `Response.clone()` teed is
 *    taken from the response's own branch. Any other body is drained without
 *    blocking: what arrives before the next macrotask, up to 64 KiB (or up to
 *    the `Content-Length` it declares). If it ends, it is bytes, otherwise a
 *    stream that still yields every byte, so a slow or stalled producer never
 *    holds back the head; a client that goes away stops the read. A body that
 *    outruns its declared length loses the false `Content-Length`. A body
 *    declaring more than 64 KiB is a stream at once. No content is sniffed. A
 *    body something else already read or locked cannot be sent: finalize
 *    throws `response_finalizer.body_taken`, and the request handler answers
 *    the failure instead.
 * 2. cache policy: the answer to a request the access chain denied
 *    (`wasDenied`) loses any `Set-Cookie` and `Surrogate-Control` and is
 *    `private, no-store`, whatever a renderer or an enclosing hook middleware
 *    put on it; every other answer takes `decideCache` (`cache-control.ts`).
 * 3. content coding, negotiated once: brotli (quality 4) or gzip (level 6) by
 *    the request's q-values, for a compressible type only, never for a body
 *    of (or declaring) under 1024 bytes, a 204/206/304, a `no-transform` answer, or one that already
 *    carries a `Content-Encoding`. A negotiable answer varies on
 *    `Accept-Encoding` whichever coding it got.
 * 4. validator: a storable 200 of at most 1 MiB of bytes to a GET or HEAD
 *    gets a strong `"<sha1-base64url>"` ETag (suffixed `.br`/`.gz` when
 *    encoded, so each representation has its own); a handler's own ETag is
 *    kept, weakened when the body is then encoded.
 * 5. conditional: `If-None-Match` (weak comparison), else `If-Modified-Since`
 *    against `Last-Modified`, answers 304 with the response's headers and no
 *    body; the discarded stream is cancelled.
 * 6. encode: bytes whole (synchronously up to 32 KiB, on the threadpool
 *    above), streams through a compressor flushed after every chunk, so a
 *    progressive producer's chunks are never held back.
 * 7. seal: the request id and the default security headers, each set only
 *    when the producer did not set its own.
 * 8. install: one `new Response(bytes, init)` with its `Content-Length`, the
 *    shape the Node adapter writes in a single `end()`; a stream is read
 *    inside the request's execution context and scope bindings, so a
 *    producer advanced after the handler returned still sees them, and a
 *    `Respond` stream's failure is reported once (phase `stream`). The kind
 *    of body installed is recorded on the frame ({@link answerOf}), which a
 *    draining server reads. A live stream (`Respond.eventStream`,
 *    `Respond.stream` with `live`, any `text/event-stream`) ends when the
 *    drain of the server that accepted the request starts
 *    (`served-frames.ts`): cleanly, its producer cancelled and the frame's
 *    signal aborted. Any other stream of a route declaring
 *    `stream.timeoutMs` fails with `deadline.stream_idle` (reported, phase
 *    `timeout`) when its producer takes longer than that for one chunk; a
 *    client that reads slowly is not the producer's delay.
 *
 * A HEAD request is finalized from the GET answer: the same status, headers,
 * validator and coding, `Content-Length` when the body was not encoded, and
 * no body.
 *
 * Steps 3 to 5 are exported as pure functions over headers
 * ({@link negotiable}, {@link entityTag}, {@link isNotModified},
 * {@link matchesEntityTag}, {@link dropRepresentationHeaders}), so a responder
 * that answers without a producer (static assets) applies the same rules.
 */

import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import {
  brotliCompress,
  brotliCompressSync,
  constants,
  createBrotliCompress,
  createGzip,
  gzip,
  gzipSync,
  type BrotliCompress,
  type BrotliOptions,
  type Gzip,
  type ZlibOptions,
} from 'node:zlib';

import { COMPRESSIBLE_CONTENT_TYPE_REGEX } from 'hono/utils/compress';

import { recordedBody, type ResponseBody } from '../api/response-bodies.js';
import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import { admissionOf, wasDenied } from '../security/access-record.js';
import { appendVary, decideCache, isStorable, PRIVATE_NO_STORE } from './cache-control.js';
import { DeadlineErrors } from './deadline.js';
import { selectEncoding, type ContentCoding } from './content-negotiation.js';
import { detach } from '../support/detach.js';
import { frameInternals, type RequestFrame } from './request-frame.js';
import { DEFAULT_SECURITY_HEADERS } from './security-headers.js';
import { drainSignalOf } from './served-frames.js';

/** A foreign body is drained up to this many bytes before it is sent as a stream. */
const DRAIN_LIMIT_BYTES = 64 * 1024;

/** Bytes under this size are sent unencoded: the coding would cost more than it saves. */
const ENCODE_THRESHOLD_BYTES = 1024;

/** Bytes up to this size are compressed synchronously; larger ones on the threadpool. */
const SYNC_ENCODE_LIMIT_BYTES = 32 * 1024;

/** Bytes above this size get no computed ETag: hashing them costs more than revalidation saves. */
const MAX_DIGEST_BYTES = 1024 * 1024;

/** Brotli quality for per-request compression (0-11); the higher defaults suit build time. */
const BROTLI_QUALITY = 4;

const GZIP_LEVEL = 6;

const NO_TRANSFORM = /(?:^|,)\s*no-transform\s*(?:,|$)/i;

/** Statuses whose body is never encoded: no content, a partial range, not modified. */
const UNENCODED_STATUSES: ReadonlySet<number> = new Set([204, 206, 304]);

/** Statuses that carry no body at all. */
const BODILESS_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/** Headers a 304 drops: it describes the stored representation, it does not carry one. */
const REPRESENTATION_HEADERS = [
  'content-length',
  'content-type',
  'content-encoding',
  'content-range',
];

const SECURITY_HEADERS: readonly (readonly [string, string])[] = Object.freeze(
  Object.entries(DEFAULT_SECURITY_HEADERS),
);

const RESPONSE_FINALIZER_ERRORS = {
  body_taken: {
    kind: 'internal',
    message: 'the response body was already read or locked when the response was finalized',
    suggestion:
      'read a response body only through Response.clone(), and return a response whose body is unread',
  },
} as const;

/**
 * The finalizer's codes, `response_finalizer.*`: a producer or middleware
 * returned a response whose body it (or something else) had already read or
 * locked, so no byte of it can reach the client.
 */
export const ResponseFinalizerErrors: ErrorRegistry<
  'response_finalizer',
  typeof RESPONSE_FINALIZER_ERRORS
> = defineErrors('response_finalizer', RESPONSE_FINALIZER_ERRORS);

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

/**
 * A foreign body the drain left unfinished: the chunks it read, the read
 * still in flight when the deadline passed, and the reader for the rest. It
 * becomes a stream only when one is needed (to compress it); otherwise the
 * installed body reads from it directly.
 */
export interface UnfinishedBody {
  readonly kind: 'unfinished';
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly prefix: Uint8Array[];
  readonly pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
}

/** A body as {@link finalize} works on it. */
export type DraftBody = ResponseBody | UnfinishedBody;

/** What {@link finalize} works on: the producer's status, adopted headers, and body. */
interface Draft {
  status: number;
  readonly headers: Headers;
  body: DraftBody;
}

/** Where the installed body takes its chunks from: the next one, and a cancel. */
interface ChunkSource {
  next(): Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel(reason: unknown): Promise<void>;
}

const EMPTY: ResponseBody = Object.freeze({ kind: 'empty' });

/**
 * What kind of body an answer {@link finalize} installed carries: none, bytes
 * sent whole, a finite stream, or a live stream (one that never ends on its
 * own).
 */
export type AnswerKind = 'empty' | 'bytes' | 'stream' | 'live';

/** The kind of each frame's installed answer (see {@link answerOf}). */
const answers = new WeakMap<RequestFrame, AnswerKind>();

/**
 * Finalize `response` for `frame`'s request: the one response the client
 * receives. `frame.request.method` is the method as it arrived, so a HEAD is
 * answered from the GET response it was dispatched as.
 */
export async function finalize(frame: RequestFrame, response: Response): Promise<Response> {
  const request = frame.request;
  const method = request.method;
  // The client's signal, not the frame's: an answer to an expired deadline
  // (whose abort the frame's signal carries) is still drained and sent.
  const draft = await adopt(response, frame.request.signal);
  const { headers } = draft;
  const { body } = draft;
  const live =
    (body.kind === 'stream' && body.live) ||
    ((body.kind === 'stream' || body.kind === 'unfinished') && isEventStream(headers));

  if (wasDenied(frame)) {
    headers.delete('set-cookie');
    headers.delete('surrogate-control');
    headers.set('cache-control', PRIVATE_NO_STORE);
  } else {
    decideCache(
      frame.route?.meta.cache,
      { status: draft.status, headers, live },
      frame.claimed,
      admissionOf(frame),
      { request, credentialed: () => frame.credentialed },
    );
  }

  let coding: ContentCoding | undefined;
  if (negotiable(draft.status, headers, draft.body)) {
    appendVary(headers, 'Accept-Encoding');
    coding = selectEncoding(request.headers.get('accept-encoding'));
  }

  if (method === 'GET' || method === 'HEAD') {
    assignValidator(draft, coding);
    if (isNotModified(request.headers, draft.status, headers)) {
      notModified(draft);
      return install(frame, draft, method, false);
    }
  }
  if (coding !== undefined) await encode(draft, coding, method === 'HEAD');
  return install(frame, draft, method, live);
}

/**
 * The kind of body of the answer {@link finalize} installed for `frame`, or
 * `undefined` while none is: what a draining server reads to tell a request
 * it waits for from a live stream it ends.
 */
export function answerOf(frame: RequestFrame): AnswerKind | undefined {
  return answers.get(frame);
}

/**
 * Seal an answer given before the request has a frame (a 421, a failure to
 * open one): no-store, the security headers and the request id. Its body is
 * the framework's own bytes, so it needs nothing else.
 */
export function sealUnframed(response: Response, requestId: string): Response {
  const headers = response.headers;
  headers.set('cache-control', PRIVATE_NO_STORE);
  seal(headers, requestId);
  return response;
}

/**
 * The producer's status, a mutable copy of its headers, and its body kind.
 *
 * @throws `response_finalizer.body_taken` when the body was already read or locked.
 */
async function adopt(response: Response, signal: AbortSignal): Promise<Draft> {
  const status = response.status;
  const headers = new Headers(response.headers);
  const recorded = recordedBody(response);
  if (recorded !== undefined && (recorded.kind !== 'stream' || !recorded.stream.locked)) {
    return { status, headers, body: recorded };
  }
  const stream = unreadBody(response);
  if (stream === null) return { status, headers, body: EMPTY };
  // A recorded stream that is locked was teed by `Response.clone()`: the
  // response now carries a branch of it, which yields the same bytes and
  // keeps the record's live and reporting marks.
  if (recorded !== undefined) return { status, headers, body: { ...recorded, stream } };
  const declared = declaredLength(headers);
  if (declared !== undefined && declared > DRAIN_LIMIT_BYTES) {
    return { status, headers, body: { kind: 'stream', stream, live: false, reports: false } };
  }
  return { status, headers, body: await drain(stream, headers, declared, signal) };
}

/**
 * `response`'s body stream, or `null` for none.
 *
 * @throws `response_finalizer.body_taken` when it was read or is locked.
 */
function unreadBody(response: Response): ReadableStream<Uint8Array> | null {
  const stream = response.body;
  if (stream === null) return null;
  if (response.bodyUsed || stream.locked) throw new ResponseFinalizerErrors.Error('body_taken');
  return stream;
}

/** The response's `Content-Length`, when it states a valid one. */
function declaredLength(headers: Headers): number | undefined {
  const value = headers.get('content-length');
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : undefined;
}

/**
 * Read `stream` only as far as it is available without waiting on its
 * producer: what arrives before the next macrotask, up to its `declared`
 * length or else {@link DRAIN_LIMIT_BYTES}. A body that ends by then is bytes
 * (installed with its real length); any other is a stream that yields the
 * bytes already read and then the rest, so nothing is lost and the head of a
 * slow or stalled producer's answer still leaves at once. A body that read
 * past its declared length declared it falsely, so its `Content-Length` is
 * dropped from `headers` and the rest is sent without one.
 */
async function drain(
  stream: ReadableStream<Uint8Array>,
  headers: Headers,
  declared: number | undefined,
  signal: AbortSignal,
): Promise<ResponseBody | UnfinishedBody> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: NodeJS.Immediate | undefined;
  let stop: (() => void) | undefined;
  // A declared length bounds the read, it never extends the wait: a producer
  // that declared its length can still stall after the head, and the client
  // must get the head without waiting on it. A client that goes away stops
  // the wait too.
  const deadline = new Promise<'late'>((resolve) => {
    stop = () => resolve('late');
    if (signal.aborted) stop();
    signal.addEventListener('abort', stop, { once: true });
    timer = setImmediate(stop);
  });
  const limit = declared ?? DRAIN_LIMIT_BYTES;
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  try {
    for (;;) {
      const read = reader.read();
      pending = read;
      const step = await Promise.race([
        read.then(
          (result) => ({ result }),
          () => 'failed' as const,
        ),
        deadline,
      ]);
      // A read that failed or did not settle in time is handed to the client
      // as it is: the failure belongs to the body the client reads.
      if (step === 'late' || step === 'failed') break;
      pending = undefined;
      if (step.result.done) return { kind: 'bytes', bytes: concat(chunks, size) };
      chunks.push(step.result.value);
      size += step.result.value.byteLength;
      if (size > limit) break;
    }
  } finally {
    clearImmediate(timer);
    if (stop !== undefined) signal.removeEventListener('abort', stop);
  }
  if (declared !== undefined && size > declared) headers.delete('content-length');
  return { kind: 'unfinished', reader, prefix: chunks, pending };
}

/**
 * The chunks of an unfinished body: those already read, then the read still
 * in flight, then the rest of the reader through `read` (which the installed
 * body runs inside the request's context). Only the reads it starts itself
 * need that context: the first ones started in it already.
 */
function unfinishedChunks(
  body: UnfinishedBody,
  read: (
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ) => Promise<ReadableStreamReadResult<Uint8Array>>,
): ChunkSource {
  const prefix = [...body.prefix];
  let pending = body.pending;
  return {
    next() {
      const head = prefix.shift();
      if (head !== undefined) return Promise.resolve({ done: false, value: head });
      const inFlight = pending;
      pending = undefined;
      return inFlight ?? read(body.reader);
    },
    cancel: (reason) => body.reader.cancel(reason),
  };
}

/** An unfinished body as the stream it is: for a compressor to read. */
function resume(body: UnfinishedBody): ReadableStream<Uint8Array> {
  const chunks = unfinishedChunks(body, (reader) => reader.read());
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const step = await chunks.next();
        if (step.done) controller.close();
        else controller.enqueue(step.value);
      },
      cancel: (reason) => chunks.cancel(reason),
    },
    { highWaterMark: 0 },
  );
}

/** Join `chunks` (totalling `size` bytes) into one buffer. */
function concat(chunks: readonly Uint8Array[], size: number): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/** True when the response's media type (parameters and case ignored) is `text/event-stream`. */
function isEventStream(headers: Headers): boolean {
  const type = headers.get('content-type');
  return type !== null && type.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream';
}

/**
 * Whether an answer of `status` with `headers` and `body` could be sent in
 * another content coding: a compressible type, at least 1024 bytes (or a
 * stream not declaring less), no `no-transform`, no coding of its own, and
 * not a 204, 206 or 304. A negotiable answer varies on `Accept-Encoding`
 * whichever coding it gets.
 */
export function negotiable(status: number, headers: Headers, body: DraftBody): boolean {
  if (status < 200 || UNENCODED_STATUSES.has(status)) return false;
  if (body.kind === 'empty') return false;
  if (body.kind === 'bytes' && body.bytes.byteLength < ENCODE_THRESHOLD_BYTES) return false;
  // A stream that declares a small length is as small as small bytes.
  const declared = body.kind === 'bytes' ? undefined : declaredLength(headers);
  if (declared !== undefined && declared < ENCODE_THRESHOLD_BYTES) return false;
  if (headers.has('content-encoding')) return false;
  const type = headers.get('content-type');
  if (type === null || !COMPRESSIBLE_CONTENT_TYPE_REGEX.test(type)) return false;
  return !NO_TRANSFORM.test(headers.get('cache-control') ?? '');
}

/** Give a storable 200 its strong ETag, or weaken the handler's when the body will be encoded. */
function assignValidator(
  { status, headers, body }: Draft,
  coding: ContentCoding | undefined,
): void {
  const own = headers.get('etag');
  if (own !== null) {
    if (coding !== undefined && !own.startsWith('W/')) headers.set('etag', `W/${own}`);
    return;
  }
  if (status !== 200 || body.kind !== 'bytes' || body.bytes.byteLength > MAX_DIGEST_BYTES) return;
  if (!isStorable(headers)) return;
  headers.set('etag', entityTag(createHash('sha1').update(body.bytes).digest('base64url'), coding));
}

/**
 * The strong entity tag of one representation: `opaque` (a content hash)
 * quoted, suffixed `.br` or `.gz` when the representation is encoded, so each
 * coding of the same content is a representation of its own.
 */
export function entityTag(opaque: string, coding: ContentCoding | undefined): string {
  const suffix = coding === undefined ? '' : coding === 'br' ? '.br' : '.gz';
  return `"${opaque}${suffix}"`;
}

/**
 * Whether a request with `requestHeaders` is owed a 304 for a `status` answer
 * carrying `headers`: only a 200 qualifies; `If-None-Match` (weak comparison
 * against `ETag`) decides when present, else `If-Modified-Since` against
 * `Last-Modified` (both valid HTTP dates, the resource not modified since).
 */
export function isNotModified(requestHeaders: Headers, status: number, headers: Headers): boolean {
  if (status !== 200) return false;
  const ifNoneMatch = requestHeaders.get('if-none-match');
  if (ifNoneMatch !== null) {
    const etag = headers.get('etag');
    return etag !== null && matchesEntityTag(ifNoneMatch, etag);
  }
  const ifModifiedSince = requestHeaders.get('if-modified-since');
  const lastModified = headers.get('last-modified');
  if (ifModifiedSince === null || lastModified === null) return false;
  const since = Date.parse(ifModifiedSince);
  const modified = Date.parse(lastModified);
  return !Number.isNaN(since) && !Number.isNaN(modified) && modified <= since;
}

/** RFC 9110 weak comparison of `etag` against an `If-None-Match` list (`*` matches any). */
export function matchesEntityTag(list: string, etag: string): boolean {
  const opaque = etag.startsWith('W/') ? etag.slice(2) : etag;
  for (const candidate of list.split(',')) {
    const tag = candidate.trim();
    if (tag === '*') return true;
    if ((tag.startsWith('W/') ? tag.slice(2) : tag) === opaque) return true;
  }
  return false;
}

/** Turn `draft` into a 304: its headers, no body, the discarded stream released. */
function notModified(draft: Draft): void {
  release(draft.body);
  draft.status = 304;
  draft.body = EMPTY;
  dropRepresentationHeaders(draft.headers);
}

/**
 * Remove from `headers` what a 304 must not carry: the length, type, coding
 * and range of a representation it does not send. Validators, caching and
 * `Vary` stay.
 */
export function dropRepresentationHeaders(headers: Headers): void {
  for (const name of REPRESENTATION_HEADERS) headers.delete(name);
}

/** Cancel a body nobody will read, so its producer (an open file) is released. */
function release(body: DraftBody): void {
  if (body.kind === 'unfinished') {
    // The client never sees this body, so a cancel that fails changes nothing for it.
    body.reader.cancel().catch(() => undefined);
    return;
  }
  if (body.kind !== 'stream' || body.stream.locked) return;
  // As above: a failed cancel of an unsent body changes nothing for the client.
  body.stream.cancel().catch(() => undefined);
}

/**
 * Encode `draft`'s body as `coding`. A HEAD answer is only labelled: it
 * sends no body, so it is not compressed, and it states no length.
 */
async function encode(draft: Draft, coding: ContentCoding, head: boolean): Promise<void> {
  const { headers, body } = draft;
  headers.set('content-encoding', coding);
  headers.delete('content-length');
  if (head) return;
  if (body.kind === 'bytes') {
    draft.body = { kind: 'bytes', bytes: await compress(body.bytes, coding) };
  } else if (body.kind === 'stream') {
    draft.body = { ...body, stream: body.stream.pipeThrough(compressor(coding)) };
  } else if (body.kind === 'unfinished') {
    const stream = resume(body).pipeThrough(compressor(coding));
    draft.body = { kind: 'stream', stream, live: false, reports: false };
  }
}

/** `bytes` compressed whole: synchronously when small, on the threadpool otherwise. */
async function compress(
  bytes: Uint8Array<ArrayBuffer>,
  coding: ContentCoding,
): Promise<Uint8Array<ArrayBuffer>> {
  const sync = bytes.byteLength <= SYNC_ENCODE_LIMIT_BYTES;
  const output =
    coding === 'br'
      ? sync
        ? brotliCompressSync(bytes, brotliOptions(bytes.byteLength))
        : await brotliAsync(bytes, brotliOptions(bytes.byteLength))
      : sync
        ? gzipSync(bytes, GZIP_OPTIONS)
        : await gzipAsync(bytes, GZIP_OPTIONS);
  // zlib returns a Buffer over a plain ArrayBuffer of its own.
  return new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
}

const GZIP_OPTIONS: ZlibOptions = Object.freeze({ level: GZIP_LEVEL });

function brotliOptions(sizeHint: number | undefined): BrotliOptions {
  return {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      ...(sizeHint === undefined ? {} : { [constants.BROTLI_PARAM_SIZE_HINT]: sizeHint }),
    },
  };
}

/**
 * A web `TransformStream` over a `node:zlib` compressor that flushes after
 * every chunk, so a progressive producer's chunks reach the client as they
 * are produced. Cancelling it (a client that went away) destroys the engine.
 */
function compressor(coding: ContentCoding): TransformStream<Uint8Array, Uint8Array> {
  const engine: BrotliCompress | Gzip =
    coding === 'br' ? createBrotliCompress(brotliOptions(undefined)) : createGzip(GZIP_OPTIONS);
  const flushKind = coding === 'br' ? constants.BROTLI_OPERATION_FLUSH : constants.Z_SYNC_FLUSH;
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
          if (error !== null && error !== undefined) reject(error);
          else engine.flush(flushKind, () => resolve());
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

/** Set the request id and the default security headers the producer left unset. */
function seal(headers: Headers, requestId: string): void {
  if (!headers.has('x-request-id')) headers.set('x-request-id', requestId);
  for (const [name, value] of SECURITY_HEADERS) {
    if (!headers.has(name)) headers.set(name, value);
  }
}

/** The one response the client receives for `draft`; a `live` stream is marked as such. */
function install(frame: RequestFrame, draft: Draft, method: string, live: boolean): Response {
  const { status, headers, body } = draft;
  seal(headers, frame.id);
  const init: ResponseInit = { status, headers };
  if (method === 'HEAD' || BODILESS_STATUSES.has(status)) {
    if (
      body.kind === 'bytes' &&
      !headers.has('content-encoding') &&
      !BODILESS_STATUSES.has(status)
    ) {
      headers.set('content-length', String(body.bytes.byteLength));
    }
    release(body);
    answers.set(frame, 'empty');
    return new Response(null, init);
  }
  if (body.kind === 'empty') {
    answers.set(frame, 'empty');
    return new Response(null, init);
  }
  if (body.kind === 'bytes') {
    answers.set(frame, 'bytes');
    headers.set('content-length', String(body.bytes.byteLength));
    return new Response(body.bytes, init);
  }
  answers.set(frame, live ? 'live' : 'stream');
  if (live) return new Response(liveInRequest(frame, body, drainSignalOf(frame)), init);
  return new Response(inRequest(frame, body, frame.route?.meta.stream?.timeoutMs), init);
}

/**
 * A live `body` as {@link inRequest} reads it, ended when `draining` (the
 * drain signal of the server that accepted the request) aborts, or at once
 * when it already has: the body closes cleanly, so the client sees a finished
 * stream and reconnects, the producer is cancelled, and the frame's signal
 * aborts for a producer that watches it. Served in process, there is no
 * server to drain it.
 */
function liveInRequest(
  frame: RequestFrame,
  body: Extract<DraftBody, { kind: 'stream' | 'unfinished' }>,
  draining: AbortSignal | undefined,
): ReadableStream<Uint8Array> {
  if (draining === undefined) return inRequest(frame, body, undefined);
  const source = inRequest(frame, body, undefined);
  const reader = source.getReader();
  let ended = false;
  let onDrain: (() => void) | undefined;
  const stopWatching = (): void => {
    ended = true;
    if (onDrain !== undefined) draining.removeEventListener('abort', onDrain);
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        onDrain = () => {
          if (ended) return;
          stopWatching();
          const reason: unknown = draining.reason;
          frameInternals(frame)?.abort(reason);
          controller.close();
          // The client has its clean end; a producer that fails to stop has
          // nobody left to answer, so its failure is the request's to report.
          detach(reader.cancel(reason), (error) => frame.report(error, 'stream'));
        };
        if (draining.aborted) onDrain();
        else draining.addEventListener('abort', onDrain, { once: true });
      },
      async pull(controller) {
        let step: ReadableStreamReadResult<Uint8Array>;
        try {
          step = await reader.read();
        } catch (error) {
          if (ended) return;
          stopWatching();
          controller.error(error);
          return;
        }
        if (ended) return;
        if (step.done) {
          stopWatching();
          controller.close();
        } else {
          controller.enqueue(step.value);
        }
      },
      cancel(reason) {
        stopWatching();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/** Where the installed body of `body` takes its chunks from, each read inside the request. */
function chunkSource(
  frame: RequestFrame,
  body: Extract<DraftBody, { kind: 'stream' | 'unfinished' }>,
): ChunkSource {
  const read = (reader: ReadableStreamDefaultReader<Uint8Array>) =>
    frame.runInRequest(() => reader.read());
  if (body.kind === 'unfinished') return unfinishedChunks(body, read);
  const reader = body.stream.getReader();
  return { next: () => read(reader), cancel: (reason) => reader.cancel(reason) };
}

/**
 * `body`'s chunks as a stream, each read inside the request's execution
 * context and scope bindings: the client pulls it after the handler
 * returned, from the adapter's own async context. A `Respond` stream's failure is reported once,
 * then errors the body, so the client sees it cut short. With `idleMs`, a
 * chunk the producer takes longer than that to yield fails the body with
 * `deadline.stream_idle`, reported once, and cancels the producer.
 */
function inRequest(
  frame: RequestFrame,
  body: Extract<DraftBody, { kind: 'stream' | 'unfinished' }>,
  idleMs: number | undefined,
): ReadableStream<Uint8Array> {
  const chunks = chunkSource(frame, body);
  const reports = body.kind === 'stream' && body.reports;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let step: ReadableStreamReadResult<Uint8Array>;
        try {
          step =
            idleMs === undefined ? await chunks.next() : await withinIdle(frame, chunks, idleMs);
        } catch (error) {
          if (DeadlineErrors.is(error, 'stream_idle')) frame.report(error, 'timeout');
          else if (reports) frame.report(error, 'stream');
          controller.error(error);
          return;
        }
        if (step.done) controller.close();
        else controller.enqueue(step.value);
      },
      cancel: (reason) => frame.runInRequest(() => chunks.cancel(reason)),
    },
    { highWaterMark: 0 },
  );
}

/**
 * The next chunk of `chunks`, or `deadline.stream_idle` when it takes longer
 * than `idleMs`; the producer is then cancelled with that error (see
 * {@link cancelProducer}) before the body fails.
 */
async function withinIdle(
  frame: RequestFrame,
  chunks: ChunkSource,
  idleMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DeadlineErrors.Error('stream_idle', { timeoutMs: idleMs }));
    }, idleMs);
  });
  const next = chunks.next();
  try {
    return await Promise.race([next, idle]);
  } catch (error) {
    if (DeadlineErrors.is(error, 'stream_idle')) {
      // The pending read settles once the cancel lands; the body fails with
      // the idle error, so the read's own outcome has no reader.
      next.catch(() => undefined);
      await cancelProducer(frame, chunks, error, idleMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cancel an idle producer inside the request, and wait for it to finish its
 * cleanup for at most `graceMs`, as long as it had to yield a chunk.
 *
 * Waiting keeps the producer's cleanup (an async generator's `finally`
 * releasing a connection or a lock) inside the request: it runs before the
 * body fails, so before the request ends and its scope is disposed. The wait
 * is bounded because a producer stuck in an await can never acknowledge the
 * cancel (an async generator's `return()` waits for its pending step), and
 * the idle bound exists so that such a producer cannot hold the response
 * open. Its cleanup then runs whenever its await settles, and a cleanup that
 * fails, in time or late, is reported with phase `stream`, never dropped.
 */
async function cancelProducer(
  frame: RequestFrame,
  chunks: ChunkSource,
  reason: unknown,
  graceMs: number,
): Promise<void> {
  const acknowledged = frame
    .runInRequest(() => chunks.cancel(reason))
    .then(undefined, (failure: unknown) => {
      if (failure !== reason) frame.report(failure, 'stream');
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, graceMs);
  });
  try {
    await Promise.race([acknowledged, grace]);
  } finally {
    clearTimeout(timer);
  }
}
