/**
 * Human-first HTTP response helpers.
 *
 * `Respond` builds web-standard `Response` objects with the correct content
 * type, a same-origin `Location` header (or an explicitly external one), a
 * `Content-Disposition` filename, a
 * progressive stream, or a server-sent event stream. Each factory records the
 * body it built (`response-bodies.ts`), so the server's finalizer sizes,
 * hashes, compresses and writes it without reading it back; a raw `Response`
 * still works and is drained instead.
 *
 * Headers and cookies are added to an existing response with
 * {@link withHeaders} and {@link withCookies}, which keep the recorded body:
 * a middleware wraps the response `next()` returned rather than staging
 * headers on a shared context.
 *
 * Browser-safe: this module uses only web-standard types, the error kernel
 * and the support toolkit, so it belongs to the `jsails/api` graph.
 */

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import {
  externalLocation,
  isRedirectStatus,
  RedirectErrors,
  sameOriginLocation,
} from '../url/redirect-target.js';
import { contentDisposition } from '../support/content-disposition.js';
import {
  bytesResponse,
  emptyResponse,
  streamResponse,
  utf8,
  withEditedHeaders,
} from './response-bodies.js';

const RESPOND_ERRORS = {
  invalid_event_field: {
    kind: 'invalid',
    message: 'a server-sent event field contains a line break',
    suggestion: 'keep event names and ids on one line; split multi-line data across data lines',
  },
  invalid_stream_chunk: {
    kind: 'invalid',
    message: 'a streamed response chunk is neither a string nor bytes',
  },
} as const;

/**
 * The response helpers' codes, `respond.*`: an event field that would break
 * the event-stream framing, and a stream chunk of the wrong type.
 *
 * @public
 */
export const RespondErrors: ErrorRegistry<'respond', typeof RESPOND_ERRORS> = defineErrors(
  'respond',
  RESPOND_ERRORS,
);

function withDefaultHeaders(
  init: ResponseInit | undefined,
  defaults: Readonly<Record<string, string>>,
): Headers {
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(defaults)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return headers;
}

function textBody(body: string, init: ResponseInit | undefined, contentType: string): Response {
  return bytesResponse(utf8(body), {
    ...init,
    headers: withDefaultHeaders(init, { 'content-type': contentType }),
  });
}

/** A JSON response (`application/json; charset=utf-8`). `undefined` becomes `null`. */
export function json(data: unknown, init?: ResponseInit): Response {
  const serialized = JSON.stringify(data);
  return textBody(serialized ?? 'null', init, 'application/json; charset=utf-8');
}

/** An HTML response (`text/html; charset=utf-8`). */
export function html(markup: string, init?: ResponseInit): Response {
  return textBody(markup, init, 'text/html; charset=utf-8');
}

/** A plain-text response (`text/plain; charset=utf-8`). */
export function text(body: string, init?: ResponseInit): Response {
  return textBody(body, init, 'text/plain; charset=utf-8');
}

/** An XML response (`application/xml; charset=utf-8`) for feeds and sitemaps. */
export function xml(body: string, init?: ResponseInit): Response {
  return textBody(body, init, 'application/xml; charset=utf-8');
}

/**
 * A redirect to a same-origin path (`/dashboard`, `/login?next=%2Fa`).
 * Defaults to `303 See Other` (the correct status after a mutation); pass
 * `{ status: 302 }` (or 301, 307, 308) to override. Anything that is not a
 * root-relative same-origin path is a `redirect.invalid_target` error, so a
 * target that came with the request goes through `safeRedirectPath` first;
 * characters outside visible ASCII are percent-encoded for the header.
 */
export function redirect(location: string, init?: ResponseInit): Response {
  const target = sameOriginLocation(location);
  if (target === undefined) throw new RedirectErrors.Error('invalid_target');
  return redirectTo(target, init);
}

/**
 * A redirect to another origin: an absolute `http:` or `https:` URL without
 * credentials, sent as its serialized `href` (anything else is
 * `redirect.invalid_external_target`). The status defaults to `303`, as for
 * {@link redirect}. Use it only for a target the code chose, never one the
 * request supplied.
 */
export function redirectExternal(url: string | URL, init?: ResponseInit): Response {
  const target = externalLocation(url);
  if (target === undefined) throw new RedirectErrors.Error('invalid_external_target');
  return redirectTo(target, init);
}

function redirectTo(location: string, init: ResponseInit | undefined): Response {
  const status = init?.status ?? 303;
  if (!isRedirectStatus(status)) {
    throw new RedirectErrors.Error('invalid_status', { allowed: '301, 302, 303, 307, 308' });
  }
  const headers = new Headers(init?.headers);
  headers.set('location', location);
  return emptyResponse({ ...init, status, headers });
}

/** An empty response; `204 No Content` by default. */
export function noContent(init?: ResponseInit): Response {
  const status = init?.status ?? 204;
  if (status !== 204 && status !== 205 && status !== 304) {
    throw new TypeError('noContent status must be 204, 205, or 304');
  }
  return emptyResponse({ ...init, status, headers: new Headers(init?.headers) });
}

/**
 * A file-download response. The filename is emitted through the RFC 5987-safe
 * `Content-Disposition` helper; the content type defaults to
 * `application/octet-stream` and can be overridden through `init.headers`.
 */
export function download(body: BodyInit | null, filename: string, init?: ResponseInit): Response {
  const responseInit: ResponseInit = {
    ...init,
    headers: withDefaultHeaders(init, {
      'content-type': 'application/octet-stream',
      'content-disposition': contentDisposition(filename),
    }),
  };
  if (body === null) return emptyResponse(responseInit);
  if (typeof body === 'string') return bytesResponse(utf8(body), responseInit);
  if (body instanceof Uint8Array) return bytesResponse(new Uint8Array(body), responseInit);
  if (body instanceof ReadableStream) {
    return streamResponse(body as ReadableStream<Uint8Array>, responseInit);
  }
  return new Response(body, responseInit);
}

/** What {@link stream} produces a body from. */
export type StreamSource = ReadableStream<Uint8Array> | AsyncIterable<string | Uint8Array>;

/** Options for {@link stream}. */
export interface StreamOptions {
  /**
   * The stream never ends on its own (a feed, a log tail): it is never stored
   * or compressed whole, and a server shutting down ends it when its drain
   * starts instead of waiting for it.
   */
  readonly live?: boolean;
}

/**
 * A progressive response: each chunk reaches the client as it is produced,
 * compressed per chunk when the client accepts it. An async iterable is read
 * only as fast as the client takes its chunks (strings are sent as UTF-8),
 * and a client that goes away ends it through `return()`, so its `finally`
 * blocks run. On the server every read runs in the request's context, so the
 * producer sees the identity, locale and tenant its route saw. The content
 * type defaults to `application/octet-stream`.
 */
export function stream(
  source: StreamSource,
  init?: ResponseInit,
  options?: StreamOptions,
): Response {
  const body = source instanceof ReadableStream ? source : iterableStream(source, encodeChunk);
  return streamResponse(
    body,
    { ...init, headers: withDefaultHeaders(init, { 'content-type': 'application/octet-stream' }) },
    { live: options?.live === true, reports: true },
  );
}

/** One server-sent event: a bare string is its `data`. */
export type EventStreamMessage =
  | string
  | {
      readonly data: string;
      readonly event?: string;
      readonly id?: string;
      /** Milliseconds the client waits before reconnecting. */
      readonly retry?: number;
    };

/**
 * A server-sent event stream (`text/event-stream`), live: never cached, never
 * compressed, never buffered by a proxy that honours `X-Accel-Buffering`.
 * Multi-line data is split across `data:` lines; an event name or id with a
 * line break fails the stream with `respond.invalid_event_field`. Reads run
 * in the request's context, as {@link stream}'s do.
 */
export function eventStream(
  events: AsyncIterable<EventStreamMessage>,
  init?: ResponseInit,
): Response {
  return streamResponse(
    iterableStream(events, encodeEvent),
    {
      ...init,
      headers: withDefaultHeaders(init, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      }),
    },
    { live: true, reports: true },
  );
}

/**
 * `response` with `headers` set on it (each name replacing what it had),
 * keeping its status and body. The original is not changed.
 */
export function withHeaders(response: Response, headers: HeadersInit): Response {
  return withEditedHeaders(response, (target) => {
    for (const [name, value] of new Headers(headers)) target.set(name, value);
  });
}

/**
 * `response` with one `Set-Cookie` header appended per serialized cookie
 * (`Cookie.serialize` on the server), keeping its status, headers and body.
 * The finalizer makes a cookie-setting answer `private, no-store`.
 */
export function withCookies(response: Response, cookies: readonly string[]): Response {
  return withEditedHeaders(response, (target) => {
    for (const cookie of cookies) target.append('set-cookie', cookie);
  });
}

function encodeChunk(chunk: unknown): Uint8Array {
  if (typeof chunk === 'string') return utf8(chunk);
  if (chunk instanceof Uint8Array) return chunk;
  throw new RespondErrors.Error('invalid_stream_chunk');
}

const LINE_BREAK = /[\r\n]/;

function eventField(name: string, value: string): string {
  if (LINE_BREAK.test(value)) throw new RespondErrors.Error('invalid_event_field');
  return `${name}: ${value}\n`;
}

function encodeEvent(message: EventStreamMessage): Uint8Array {
  const event = typeof message === 'string' ? { data: message } : message;
  let frame = '';
  if (event.event !== undefined) frame += eventField('event', event.event);
  if (event.id !== undefined) frame += eventField('id', event.id);
  if (event.retry !== undefined && Number.isSafeInteger(event.retry) && event.retry >= 0) {
    frame += `retry: ${event.retry}\n`;
  }
  for (const line of event.data.split(/\r\n|\r|\n/)) frame += `data: ${line}\n`;
  return utf8(`${frame}\n`);
}

/**
 * A pull-based byte stream over `source`: the iterator advances only when the
 * reader asks, and a cancel ends it through `return()`.
 */
function iterableStream<T>(
  source: AsyncIterable<T>,
  encode: (value: T) => Uint8Array,
): ReadableStream<Uint8Array> {
  let iterator: AsyncIterator<T> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      iterator ??= source[Symbol.asyncIterator]();
      const step = await iterator.next();
      if (step.done === true) {
        controller.close();
        return;
      }
      let chunk: Uint8Array;
      try {
        chunk = encode(step.value);
      } catch (error) {
        // The stream errors here, so no cancel will come to end the producer.
        await iterator.return?.();
        throw error;
      }
      controller.enqueue(chunk);
    },
    async cancel() {
      await iterator?.return?.();
    },
  });
}

/** The frozen response-helper namespace. */
export const Respond: Readonly<{
  json: typeof json;
  html: typeof html;
  text: typeof text;
  xml: typeof xml;
  redirect: typeof redirect;
  redirectExternal: typeof redirectExternal;
  noContent: typeof noContent;
  download: typeof download;
  stream: typeof stream;
  eventStream: typeof eventStream;
  withHeaders: typeof withHeaders;
  withCookies: typeof withCookies;
}> = Object.freeze({
  json,
  html,
  text,
  xml,
  redirect,
  redirectExternal,
  noContent,
  download,
  stream,
  eventStream,
  withHeaders,
  withCookies,
});
