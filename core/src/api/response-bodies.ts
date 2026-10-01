/**
 * What a framework-built `Response` carries as its body, recorded beside it.
 *
 * The server's finalizer must know whether a body is a complete byte array
 * (sized, hashable, compressible whole, written in one call) or a stream it
 * must pass through. Reading `response.body` to find out is not free: the Node
 * adapter's lightweight `Response` materializes a native one and a
 * `ReadableStream` for a body it would otherwise write directly. So every
 * producer that knows its body (the `Respond` factories, page documents,
 * error pages) records it here, keyed by the `Response` object itself, and the
 * finalizer reads the record instead of the body. A response nothing recorded
 * (a raw `Response`, a fetched one, one a middleware rebuilt) is drained
 * without blocking instead: slower, never wrong.
 *
 * The record is an optimisation, not a contract: it lives in a module-private
 * `WeakMap`, never in a header, and goes away with the response.
 *
 * Browser-safe: no runtime imports.
 */

/**
 * A response body as the finalizer handles it: none, every byte at hand, or a
 * stream. A `live` stream never ends on its own (server-sent events) and is
 * never stored or compressed whole. `reports` marks a stream whose producer
 * failures nothing else reports, so the server reports them once.
 */
export type ResponseBody =
  | { readonly kind: 'empty' }
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array<ArrayBuffer> }
  | {
      readonly kind: 'stream';
      readonly stream: ReadableStream<Uint8Array>;
      readonly live: boolean;
      readonly reports: boolean;
    };

const bodies = new WeakMap<Response, ResponseBody>();

const EMPTY: ResponseBody = Object.freeze({ kind: 'empty' });

/** Record `body` as what `response` carries, and return `response`. */
export function recordBody(response: Response, body: ResponseBody): Response {
  bodies.set(response, body);
  return response;
}

/** The body recorded for `response`, or `undefined` when nothing recorded one. */
export function recordedBody(response: Response): ResponseBody | undefined {
  return bodies.get(response);
}

/**
 * A response whose body is `bytes`, recorded as such. The status and headers
 * are `init`'s.
 */
export function bytesResponse(bytes: Uint8Array<ArrayBuffer>, init: ResponseInit): Response {
  return recordBody(new Response(bytes, init), { kind: 'bytes', bytes });
}

/** A response with no body, recorded as such. */
export function emptyResponse(init: ResponseInit): Response {
  return recordBody(new Response(null, init), EMPTY);
}

/** A response streaming `stream`, recorded as a stream. */
export function streamResponse(
  stream: ReadableStream<Uint8Array>,
  init: ResponseInit,
  options: { readonly live?: boolean; readonly reports?: boolean } = {},
): Response {
  return recordBody(new Response(stream, init), {
    kind: 'stream',
    stream,
    live: options.live === true,
    reports: options.reports === true,
  });
}

/**
 * A copy of `response` whose headers `edit` changed, with the same status and
 * body; a recorded body stays recorded, so the copy is written as cheaply as
 * the original. The original is not changed.
 */
export function withEditedHeaders(response: Response, edit: (headers: Headers) => void): Response {
  const headers = new Headers(response.headers);
  edit(headers);
  const init: ResponseInit = { status: response.status, headers };
  const body = recordedBody(response);
  if (body === undefined) return new Response(response.body, init);
  if (body.kind === 'empty') return emptyResponse(init);
  if (body.kind === 'bytes') return bytesResponse(body.bytes, init);
  return recordBody(new Response(body.stream, init), body);
}

const encoder = new TextEncoder();

/** `text` as UTF-8 bytes. */
export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}
