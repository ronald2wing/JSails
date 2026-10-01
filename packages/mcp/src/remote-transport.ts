/**
 * How the MCP client reaches a server, and the limits it puts on what comes
 * back. Everything a remote server sends is untrusted, so the client bounds it
 * twice:
 *
 * - On the wire. Over HTTP the response body passes through a byte counter: a
 *   JSON body may not exceed the result cap (plus envelope slack), and an SSE
 *   body may not carry an event that does, however many `data:` lines it is
 *   split across; over stdio the SDK's read buffer is
 *   capped the same way. A body that trips the counter is cut off before it is
 *   buffered whole, and the request it answers fails with `result_too_large`.
 * - Per message. Once connected, {@link MessageGuard} sits in front of the
 *   SDK's message handler and measures every inbound message: an oversized
 *   result is replaced by a locally made error for the same request id, an
 *   oversized notification is dropped, and an oversized server request is
 *   refused.
 *
 * A response stream the server closes before answering is resumed with a GET
 * carrying `Last-Event-ID` (SEP-1699), after the server's `retry` delay
 * clamped to between 250 ms and 30 s, giving up after three failed attempts
 * in a row; the call's deadline still bounds the whole exchange.
 *
 * Cancelling a request (its signal, its deadline, or closing the connection)
 * ends its HTTP exchange on every era. On 2026-07-28 the SDK closes the
 * request's stream, which is that revision's cancellation. A 2025 request is
 * cancelled with `notifications/cancelled`, which a stateless server (one per
 * request, no session) cannot route to the request it names; so the
 * transport also closes the request's exchange (the POST, its event stream,
 * or the GET resuming it) the moment the notification is sent. Closing it is
 * how such a server learns of the cancellation, and a stateful one, which must
 * not read a disconnect as cancellation, still gets the notification.
 *
 * Credentials come from a headers provider asked before every HTTP request,
 * so a token can rotate without reconnecting. The provider may not set the
 * headers the transport owns (content negotiation, the MCP protocol headers),
 * and its values may not carry line breaks. stdio servers are spawned from
 * code-supplied parameters only, without a shell, with a minimal inherited
 * environment plus the `env` given.
 */

import { randomUUID } from 'node:crypto';

import {
  StreamableHTTPClientTransport,
  type FetchLike,
  type JSONRPCMessage,
  type Transport,
  type TransportSendOptions,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { isRecord, type Awaitable } from 'jsails/plugin-sdk';

import { McpClientError } from './errors.js';

/** A `fetch`-compatible function. */
export type McpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** Headers sent with every HTTP request, typically `authorization`. */
export type McpHeaders = Readonly<Record<string, string>>;

/** A remote server over Streamable HTTP. */
export interface McpHttpTransport {
  readonly kind: 'http';
  /** The endpoint URL: `https:`, or `http:` on a loopback host; no credentials, no fragment. */
  readonly url: string;
  /**
   * Headers for every request: a fixed set, or a function asked before each
   * request (so a token can be refreshed). Names the transport owns
   * (`content-type`, `accept`, `content-length`, `host`, and every `mcp-*`
   * or `last-event-id` header) are refused.
   */
  readonly headers?: McpHeaders | (() => Awaitable<McpHeaders>);
  /** The `fetch` used for every request. Default: the global `fetch`. */
  readonly fetch?: McpFetch;
}

/** A local server spawned as a child process, speaking over its stdin and stdout. */
export interface McpStdioTransport {
  readonly kind: 'stdio';
  /** The executable. It is run directly, never through a shell. */
  readonly command: string;
  readonly args?: readonly string[];
  /**
   * Added to a minimal inherited environment (`PATH`, `HOME`, and the like);
   * the rest of the parent environment is not passed on.
   */
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** The child's stderr: shown on this process's stderr (default) or discarded. */
  readonly stderr?: 'inherit' | 'ignore';
}

/** How the client reaches a server. */
export type McpClientTransport = McpHttpTransport | McpStdioTransport;

/** Bytes allowed on the wire beyond the result cap, for the JSON-RPC envelope and SSE framing. */
export const ENVELOPE_SLACK_BYTES = 16_384;

/** The JSON-RPC internal error code. */
const INTERNAL_ERROR_CODE = -32603;

const LOOPBACK_HOSTS = new Set(['localhost', '[::1]']);
const IPV4_LOOPBACK = /^127(?:\.\d{1,3}){3}$/;
/** RFC 9110 `token`: the header name grammar. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** A header value without control characters other than tab. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const MAX_HEADER_VALUE_LENGTH = 8_192;
const OWNED_HEADERS = new Set([
  'accept',
  'connection',
  'content-length',
  'content-type',
  'host',
  'last-event-id',
  'transfer-encoding',
]);
/** HTTP statuses whose responses carry no body. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function invalidOption(reason: string): McpClientError {
  return new McpClientError('invalid_option', `transport ${reason}`);
}

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || IPV4_LOOPBACK.test(hostname);
}

/** Why a header set is refused, or `undefined` when every entry may be sent. */
function headerFault(headers: unknown): string | undefined {
  if (!isRecord(headers)) {
    return 'headers must be an object of strings';
  }
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!HEADER_NAME.test(name)) {
      return 'header names must be RFC 9110 tokens';
    }
    if (OWNED_HEADERS.has(lower) || lower.startsWith('mcp-')) {
      return 'headers may not set a header the transport owns';
    }
    if (
      typeof value !== 'string' ||
      value.length > MAX_HEADER_VALUE_LENGTH ||
      !HEADER_VALUE.test(value)
    ) {
      return 'header values must be strings without line breaks or control characters';
    }
  }
  return undefined;
}

function stringList(value: unknown, field: string): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw invalidOption(`${field} must be an array of strings`);
  }
  const items: unknown[] = value;
  return Object.freeze(
    items.map((item) => {
      if (typeof item !== 'string' || item.includes('\0')) {
        throw invalidOption(`${field} must be an array of strings`);
      }
      return item;
    }),
  );
}

function stringRecord(value: unknown, field: string): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw invalidOption(`${field} must be an object of strings`);
  }
  const copy: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' || key.length === 0 || key.includes('=') || key.includes('\0')) {
      throw invalidOption(`${field} must map variable names to strings`);
    }
    copy[key] = item;
  }
  return Object.freeze(copy);
}

/** Validate and copy a transport description. Throws `invalid_option` on anything malformed. */
export function checkTransport(value: unknown): McpClientTransport {
  if (!isRecord(value)) {
    throw invalidOption('must be an http or stdio transport description');
  }
  if (value.kind === 'http') {
    const known = new Set(['kind', 'url', 'headers', 'fetch']);
    if (Object.keys(value).some((key) => !known.has(key))) {
      throw invalidOption('has an unknown field');
    }
    if (typeof value.url !== 'string' || !URL.canParse(value.url)) {
      throw invalidOption('url must be an absolute URL');
    }
    const url = new URL(value.url);
    const secure =
      url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname));
    if (!secure || url.username !== '' || url.password !== '' || url.hash !== '') {
      throw invalidOption(
        'url must be https: (http: only on loopback), without credentials or a fragment',
      );
    }
    let headers: McpHttpTransport['headers'];
    if (typeof value.headers === 'function') {
      headers = value.headers as () => Awaitable<McpHeaders>;
    } else if (value.headers !== undefined) {
      const fault = headerFault(value.headers);
      if (fault !== undefined) {
        throw invalidOption(fault);
      }
      headers = Object.freeze({ ...(value.headers as McpHeaders) });
    }
    if (value.fetch !== undefined && typeof value.fetch !== 'function') {
      throw invalidOption('fetch must be a function');
    }
    return Object.freeze({
      kind: 'http',
      url: url.href,
      ...(headers === undefined ? {} : { headers }),
      ...(value.fetch === undefined ? {} : { fetch: value.fetch as McpFetch }),
    });
  }
  if (value.kind === 'stdio') {
    const known = new Set(['kind', 'command', 'args', 'env', 'cwd', 'stderr']);
    if (Object.keys(value).some((key) => !known.has(key))) {
      throw invalidOption('has an unknown field');
    }
    if (
      typeof value.command !== 'string' ||
      value.command.trim().length === 0 ||
      value.command.includes('\0')
    ) {
      throw invalidOption('command must be a non-empty string');
    }
    if (value.cwd !== undefined && (typeof value.cwd !== 'string' || value.cwd.length === 0)) {
      throw invalidOption('cwd must be a non-empty string');
    }
    if (value.stderr !== undefined && value.stderr !== 'inherit' && value.stderr !== 'ignore') {
      throw invalidOption("stderr must be 'inherit' or 'ignore'");
    }
    const env = stringRecord(value.env, 'env');
    return Object.freeze({
      kind: 'stdio',
      command: value.command,
      args: stringList(value.args, 'args'),
      ...(env === undefined ? {} : { env }),
      ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
      stderr: value.stderr ?? 'inherit',
    });
  }
  throw invalidOption("kind must be 'http' or 'stdio'");
}

/** The headers provider failed or answered something the transport may not send. */
export class CredentialsError extends Error {
  constructor(reason: string, cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = 'CredentialsError';
  }
}

/** A response body went past the byte limit and was cut off. */
export class BodyLimitError extends Error {
  constructor() {
    super('the response exceeded the result size limit');
    this.name = 'BodyLimitError';
  }
}

/** A JSON-RPC request id. */
type RequestId = string | number;

/** The JSON-RPC id of the request a POST body carries, when it carries exactly one. */
function requestIdOf(body: unknown): RequestId | undefined {
  if (typeof body !== 'string') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (_notJson) {
    return undefined;
  }
  // A response the client sends back to a server request carries an id too,
  // from the server's id space, so it could collide with a request of ours.
  return isRecord(parsed) && typeof parsed.method === 'string' ? requestIdIn(parsed) : undefined;
}

function requestIdIn(record: Record<string, unknown>): RequestId | undefined {
  const id = record.id;
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

/**
 * Count the bytes of a body. With `perEvent` (an SSE stream) the count covers
 * one event, every line of it up to the blank line that ends it, so a message
 * split across many `data:` lines is measured whole, and restarts after each
 * event; otherwise it covers the whole body. A line ends at CRLF, LF, or CR,
 * as the SSE grammar allows. Past `limit`, `onTrip` runs and the stream errors.
 */
function limitBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
  perEvent: boolean,
  onTrip: () => void,
): ReadableStream<Uint8Array> {
  let count = 0;
  let lineLength = 0;
  let afterCarriageReturn = false;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        let tripped = false;
        if (perEvent) {
          for (const byte of chunk) {
            if (byte === 0x0a && afterCarriageReturn) {
              // The LF of a CRLF: the line already ended at the CR.
              afterCarriageReturn = false;
              continue;
            }
            afterCarriageReturn = byte === 0x0d;
            if (byte === 0x0a || byte === 0x0d) {
              if (lineLength === 0) {
                count = 0;
              }
              lineLength = 0;
              continue;
            }
            lineLength += 1;
            count += 1;
            if (count > limit) {
              tripped = true;
              break;
            }
          }
        } else {
          count += chunk.byteLength;
          tripped = count > limit;
        }
        if (tripped) {
          onTrip();
          controller.error(new BodyLimitError());
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

async function resolveHeaders(
  source: McpHttpTransport['headers'],
): Promise<McpHeaders | undefined> {
  if (typeof source !== 'function') {
    return source;
  }
  let provided: unknown;
  try {
    provided = await source();
  } catch (error) {
    throw new CredentialsError('the headers provider threw', error);
  }
  const fault = headerFault(provided);
  if (fault !== undefined) {
    throw new CredentialsError(`the headers provider answered badly: ${fault}`);
  }
  return provided as McpHeaders;
}

/** What {@link guardedFetch} tells the transport about the POST that carried request `id`. */
export interface ExchangeEvents {
  /** The response opened an event stream, which outlives the POST itself. */
  readonly streamed: (id: RequestId) => void;
  /** The response was cut off at the limit, so the call can fail at once instead of at its deadline. */
  readonly overflowed: (id: RequestId) => void;
}

/**
 * The `fetch` the HTTP transport uses: the caller's headers merged in, and
 * every response body bounded. `events` hears about the responses to
 * requests.
 */
export function guardedFetch(
  spec: McpHttpTransport,
  limit: number,
  events: ExchangeEvents,
): FetchLike {
  const base: FetchLike = spec.fetch ?? fetch;
  return async (url, init) => {
    const extra = await resolveHeaders(spec.headers);
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(extra ?? {})) {
      headers.set(name, value);
    }
    const response = await base(url, { ...init, headers });
    const status = response.status;
    if (
      response.body === null ||
      NULL_BODY_STATUSES.has(status) ||
      (status >= 300 && status < 400)
    ) {
      return response;
    }
    const id = requestIdOf(init?.body);
    const sse = response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream');
    if (id !== undefined && response.ok && sse === true) {
      events.streamed(id);
    }
    const body = limitBody(response.body, limit, sse === true, () => {
      if (id !== undefined && response.ok) {
        events.overflowed(id);
      }
    });
    return new Response(body, {
      status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/** Failed attempts in a row before a resumable stream is given up. */
const RECONNECT_ATTEMPTS = 3;
const MIN_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 30_000;

/** Run `reconnect` after `delay`, clamped to the bounds above; the timer never holds the process. */
export function scheduleReconnection(reconnect: () => void, delay: number): () => void {
  const wait = Number.isFinite(delay)
    ? Math.min(Math.max(delay, MIN_RECONNECT_DELAY_MS), MAX_RECONNECT_DELAY_MS)
    : MAX_RECONNECT_DELAY_MS;
  const timer = setTimeout(reconnect, wait);
  timer.unref();
  return () => {
    clearTimeout(timer);
  };
}

/** The request a `notifications/cancelled` message names, or `undefined` for any other message. */
function cancelledRequestOf(message: JSONRPCMessage): RequestId | undefined {
  const record: Record<string, unknown> = message;
  if (record.method !== 'notifications/cancelled' || !isRecord(record.params)) {
    return undefined;
  }
  const id = record.params.requestId;
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

/** The id of a JSON-RPC request, or `undefined` for a notification or a response. */
function outgoingRequestOf(message: JSONRPCMessage): RequestId | undefined {
  const record: Record<string, unknown> = message;
  return typeof record.method === 'string' ? requestIdIn(record) : undefined;
}

interface Exchange {
  readonly controller: AbortController;
  /** The answer is an event stream, open until the SDK reports its end. */
  streaming: boolean;
}

/**
 * The open HTTP exchanges of the requests the SDK sends without an abort
 * signal of its own (every 2025-era request), by request id. An exchange is
 * open from its POST until its answer is in: a JSON answer has been delivered
 * by the time the POST's send settles, and an event stream (resumed GETs
 * included) stays open until the SDK reports its end. Cancelling aborts the
 * exchange, which the SDK takes as deliberate: no error, no resumption.
 */
class OpenExchanges {
  private readonly open = new Map<RequestId, Exchange>();

  /** Open the exchange for request `id`; its signal goes with every fetch it makes. */
  begin(id: RequestId): Exchange {
    const exchange: Exchange = { controller: new AbortController(), streaming: false };
    this.open.set(id, exchange);
    return exchange;
  }

  streamed(id: RequestId): void {
    const exchange = this.open.get(id);
    if (exchange !== undefined) {
      exchange.streaming = true;
    }
  }

  /** The exchange's POST settled: over, unless its answer is still streaming. */
  sent(id: RequestId, exchange: Exchange): void {
    if (!exchange.streaming) {
      this.end(id, exchange);
    }
  }

  end(id: RequestId, exchange: Exchange): void {
    if (this.open.get(id) === exchange) {
      this.open.delete(id);
    }
  }

  cancel(id: RequestId): void {
    const exchange = this.open.get(id);
    if (exchange !== undefined) {
      this.open.delete(id);
      exchange.controller.abort();
    }
  }

  /** Forget every exchange; closing the transport aborts their fetches. */
  clear(): void {
    this.open.clear();
  }
}

/**
 * The SDK's Streamable HTTP transport, bounded by {@link guardedFetch}, whose
 * `notifications/cancelled` also ends the HTTP exchange of the request it
 * names (see the module comment).
 */
class HttpClientTransport extends StreamableHTTPClientTransport {
  private readonly exchanges: OpenExchanges;

  constructor(spec: McpHttpTransport, limit: number, guard: MessageGuard) {
    const exchanges = new OpenExchanges();
    super(new URL(spec.url), {
      fetch: guardedFetch(spec, limit, {
        streamed: (id) => {
          exchanges.streamed(id);
        },
        overflowed: (id) => {
          guard.overflow(id);
        },
      }),
      onInsufficientScope: 'throw',
      redirectPolicy: 'same-origin',
      // A server may close a response stream mid-call and resume it on a GET
      // carrying Last-Event-ID (SEP-1699). Resumption is on, at the server's
      // `retry` delay, clamped so a hostile `retry: 0` cannot spin a loop.
      reconnectionOptions: {
        maxRetries: RECONNECT_ATTEMPTS,
        initialReconnectionDelay: 1_000,
        maxReconnectionDelay: MAX_RECONNECT_DELAY_MS,
        reconnectionDelayGrowFactor: 2,
      },
      reconnectionScheduler: scheduleReconnection,
    });
    this.exchanges = exchanges;
  }

  override async send(
    message: JSONRPCMessage | JSONRPCMessage[],
    options?: TransportSendOptions,
  ): Promise<void> {
    if (Array.isArray(message)) {
      return super.send(message, options);
    }
    const cancelled = cancelledRequestOf(message);
    if (cancelled !== undefined) {
      const sent = super.send(message, options);
      this.exchanges.cancel(cancelled);
      return sent;
    }
    const id = outgoingRequestOf(message);
    // A request carrying its own signal (2026-07-28) is cancelled by the SDK
    // aborting that signal, never by a notification.
    if (id === undefined || options?.requestSignal !== undefined) {
      return super.send(message, options);
    }
    const exchange = this.exchanges.begin(id);
    const streamEnded = options?.onRequestStreamEnd;
    try {
      await super.send(message, {
        ...options,
        requestSignal: exchange.controller.signal,
        onRequestStreamEnd: () => {
          this.exchanges.end(id, exchange);
          streamEnded?.();
        },
      });
    } catch (error) {
      this.exchanges.end(id, exchange);
      throw error;
    }
    this.exchanges.sent(id, exchange);
  }

  override async close(): Promise<void> {
    this.exchanges.clear();
    await super.close();
  }
}

/** Build the SDK transport for a checked description. */
export function sdkTransport(
  spec: McpClientTransport,
  maxResultBytes: number,
  guard: MessageGuard,
): Transport {
  const limit = maxResultBytes + ENVELOPE_SLACK_BYTES;
  if (spec.kind === 'http') {
    return new HttpClientTransport(spec, limit, guard);
  }
  return new StdioClientTransport({
    command: spec.command,
    args: [...(spec.args ?? [])],
    ...(spec.env === undefined ? {} : { env: { ...spec.env } }),
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    stderr: spec.stderr ?? 'inherit',
    maxBufferSize: limit,
  });
}

/** The JSON-RPC error code of a locally made "result too large" error. */
const TOO_LARGE_CODE = -32603;
/** The `data` key that marks an error as made by this guard. */
const MARKER_KEY = 'io.jsails.mcp/client';

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/**
 * Records the error codes of the JSON-RPC error responses a transport
 * delivers while the SDK connects, so a failed connect can tell a server that
 * failed (`-32603`) from one that speaks no usable revision: the SDK's
 * negotiation error carries neither the reply nor its code. It wraps whatever
 * handler the SDK installs (the probe window swaps handlers, so it intercepts
 * every assignment) and, once released, leaves the handler it last saw in
 * place unwrapped.
 */
export class ConnectReplies {
  private readonly codes: number[] = [];
  private released = false;

  constructor(transport: Transport) {
    const wrappers = new WeakMap<object, NonNullable<Transport['onmessage']>>();
    const originals = new WeakMap<object, NonNullable<Transport['onmessage']>>();
    let current = transport.onmessage;
    const wrap = (handler: Transport['onmessage']): Transport['onmessage'] => {
      if (handler === undefined) {
        return undefined;
      }
      const known = wrappers.get(handler);
      if (known !== undefined) {
        return known;
      }
      const wrapper: NonNullable<Transport['onmessage']> = (message, extra) => {
        this.record(message);
        handler.call(transport, message, extra);
      };
      wrappers.set(handler, wrapper);
      originals.set(wrapper, handler);
      return wrapper;
    };
    Object.defineProperty(transport, 'onmessage', {
      configurable: true,
      enumerable: true,
      get: () => wrap(current),
      set: (handler: Transport['onmessage']) => {
        current = handler === undefined ? undefined : (originals.get(handler) ?? handler);
      },
    });
    this.release = () => {
      if (this.released) {
        return;
      }
      this.released = true;
      Object.defineProperty(transport, 'onmessage', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: current,
      });
    };
  }

  /** Stop recording and put the plain handler back. */
  readonly release: () => void;

  /** True when the server answered any request with an internal error. */
  serverFailed(): boolean {
    return this.codes.includes(INTERNAL_ERROR_CODE);
  }

  private record(message: JSONRPCMessage): void {
    if (this.released) {
      return;
    }
    const record: Record<string, unknown> = message;
    if (isRecord(record.error) && typeof record.error.code === 'number') {
      this.codes.push(record.error.code);
    }
  }
}

/**
 * The per-message bound, installed in front of the SDK's message handler once
 * a connection is open. Errors it makes carry a per-connection random marker,
 * so a server cannot forge one.
 */
export class MessageGuard {
  private readonly marker = randomUUID();
  private deliver: ((message: JSONRPCMessage) => void) | undefined;

  constructor(private readonly limit: number) {}

  /** Wrap the transport's current message handler (the SDK's, after `connect`). */
  install(transport: Transport): void {
    const handler = transport.onmessage;
    if (handler === undefined) {
      return;
    }
    this.deliver = (message) => {
      handler.call(transport, message);
    };
    transport.onmessage = (message, extra) => {
      const admitted = this.admit(message, transport);
      if (admitted !== undefined) {
        handler.call(transport, admitted, extra);
      }
    };
  }

  /** Fail the request `id` with a locally made "result too large" error. */
  overflow(id: string | number): void {
    this.deliver?.(this.tooLarge(id));
  }

  /** True for an error this guard made. */
  isTooLarge(data: unknown): boolean {
    return isRecord(data) && data[MARKER_KEY] === this.marker;
  }

  private tooLarge(id: string | number): JSONRPCMessage {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: TOO_LARGE_CODE,
        message: 'Result too large',
        data: { [MARKER_KEY]: this.marker },
      },
    };
  }

  private admit(message: JSONRPCMessage, transport: Transport): JSONRPCMessage | undefined {
    const record: Record<string, unknown> = message;
    const id = record.id;
    const hasId = typeof id === 'string' || typeof id === 'number';
    if (hasId && ('result' in record || 'error' in record)) {
      const payload = 'result' in record ? record.result : record.error;
      return byteLength(payload) > this.limit ? this.tooLarge(id) : message;
    }
    if (byteLength(message) <= this.limit) {
      return message;
    }
    if (hasId) {
      transport
        .send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Request too large' } })
        .catch((error: unknown) => {
          transport.onerror?.(error instanceof Error ? error : new Error('send failed'));
        });
    }
    return undefined;
  }
}
