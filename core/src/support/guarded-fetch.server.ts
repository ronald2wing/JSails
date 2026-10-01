/**
 * `guardedFetch`, the one outbound HTTP primitive: a request to a URL that may
 * come from someone else (an admin form, a catalog, a webhook endpoint) without
 * the server becoming a way into its own network.
 *
 * Every hop, the first URL and each redirect alike, is checked the same way:
 * it must be credential-free `https:` (plain `http:` only to a loopback
 * address and only with `allowPrivate`), its host must be in `allowHosts` when
 * that is given, and the name is resolved once, with every address it returns
 * refused when any is loopback, link-local, private, carrier-grade NAT, unique
 * local, or otherwise reserved (unless `allowPrivate`). The connection is then
 * opened to one of exactly those vetted addresses, with the TLS server name
 * and the `Host` header taken from the URL, so a second DNS answer (rebinding)
 * can never redirect it. The whole chain runs under one deadline, the body is
 * read only up to `maxBytes`, and every exit destroys the sockets it opened, so
 * a refused, oversize, or timed-out request never keeps a connection open.
 *
 * Errors are {@link GuardedFetchError}s whose code and message never carry the
 * URL, a header, or an address: a URL may embed a token, and an address tells
 * a caller what the server's network looks like.
 */

import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';

import { JsailsError } from '../errors/jsails-error.js';
import { timeout as startTimeout } from './async.js';
import { concatBytes } from './bytes.js';
import { isLoopbackAddress, isPrivateAddress } from './private-address.server.js';

/**
 * Stable machine code carried by every {@link GuardedFetchError}.
 *
 * @public
 */
export type GuardedFetchErrorCode =
  | 'invalid_options'
  | 'invalid_url'
  | 'host_not_allowed'
  | 'resolve_failed'
  | 'blocked_address'
  | 'connect_failed'
  | 'tls'
  | 'response_failed'
  | 'too_many_redirects'
  | 'too_large'
  | 'timeout'
  | 'aborted';

/**
 * Raised for any refused or failed outbound request. The code and the message
 * are value-free: neither names the URL, a header, nor a resolved address.
 *
 * @public
 */
export class GuardedFetchError extends JsailsError {
  constructor(
    readonly code: GuardedFetchErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Resolves a host name to every address it currently has, as IP literals.
 *
 * @public
 */
export type GuardedResolver = (hostname: string) => Promise<readonly string[]>;

/**
 * The vetted address and port a {@link GuardedConnector} must connect to.
 *
 * @public
 */
export interface GuardedConnectTarget {
  /** An IP literal (no URL brackets) that passed the address checks. */
  readonly address: string;
  readonly port: number;
}

/**
 * Opens a TCP connection to exactly `target`. The signal aborts when the
 * request's deadline passes or its caller gives up; the connector then
 * destroys whatever it was opening.
 *
 * @public
 */
export type GuardedConnector = (
  target: GuardedConnectTarget,
  signal: AbortSignal,
) => Promise<Socket>;

/**
 * How a {@link createGuardedFetch} instance reaches the network. Each member
 * defaults to the system: the OS resolver, a TCP connection, and Node's root
 * certificates.
 *
 * @public
 */
export interface GuardedFetchTransport {
  /** Resolves each hop's host name; called once per hop. */
  readonly resolve?: GuardedResolver;
  /** Opens the connection to a vetted address. */
  readonly connect?: GuardedConnector;
  /** PEM certificates to trust instead of Node's root certificates. */
  readonly ca?: string | readonly string[];
}

/**
 * The methods a guarded request may use.
 *
 * @public
 */
export type GuardedFetchMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Options for one guarded request. The limits are required: every caller
 * states how much it will read and how long it will wait.
 *
 * @public
 */
export interface GuardedFetchOptions {
  /** Defaults to `GET`. `GET` and `HEAD` carry no body. */
  readonly method?: GuardedFetchMethod;
  /**
   * Request headers. `Host`, `Connection`, `Content-Length`,
   * `Transfer-Encoding` and the other connection-level headers are set by the
   * fetch and refused here. `Authorization`, `Cookie` and
   * `Proxy-Authorization` are dropped when a redirect leaves the origin.
   */
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array | string;
  /**
   * Host names every hop must use, compared with `URL#hostname` after the
   * same normalization (case, punycode, IP literal form). An IPv6 host is
   * written in brackets.
   */
  readonly allowHosts?: readonly string[];
  /**
   * Let a hop reach loopback, private, and other reserved addresses, and use
   * plain `http:` to a loopback address. Defaults to `false`. Only for a URL
   * the operator typed (a terminal, a local registry); never for one that
   * arrives over a request.
   */
  readonly allowPrivate?: boolean;
  /** The most response body bytes read; a longer body fails with `too_large`. */
  readonly maxBytes: number;
  /** The deadline for the whole chain (every hop, connect, and body), in milliseconds. */
  readonly timeoutMs: number;
  /** Redirects followed before failing with `too_many_redirects`. Defaults to 5; 0 follows none. */
  readonly maxRedirects?: number;
  /** Aborts the request; it then fails with `aborted`. */
  readonly signal?: AbortSignal;
}

/**
 * The final response of a guarded request, its body read in full.
 *
 * @public
 */
export interface GuardedResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly bytes: Uint8Array;
  /** The URL that answered, after redirects. */
  readonly url: string;
}

/**
 * A guarded request function; see {@link guardedFetch}.
 *
 * @public
 */
export type GuardedFetch = (url: string, options: GuardedFetchOptions) => Promise<GuardedResponse>;

/** Redirects followed when the caller does not say. */
const DEFAULT_MAX_REDIRECTS = 5;

/** A ceiling on `maxRedirects`, so a typo cannot make a chain unbounded. */
const MAX_REDIRECTS_CEILING = 20;

/** The largest delay a timer accepts. */
const MAX_TIMEOUT_MS = 2_147_483_647;

const METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Connection-level headers the fetch owns; a caller value would contradict the exchange. */
const OWNED_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'keep-alive',
  'proxy-connection',
]);

/** Credentials a redirect to another origin must not carry along. */
const ORIGIN_BOUND_HEADERS: readonly string[] = ['authorization', 'cookie', 'proxy-authorization'];

/** Body descriptors that go when a redirect turns the request into a `GET`. */
const BODY_HEADERS: readonly string[] = [
  'content-type',
  'content-encoding',
  'content-language',
  'content-location',
];

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Visible ASCII, space, tab, and obs-text; never CR, LF, or NUL.
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

const EMPTY = new Uint8Array(0);

/** One hop's request, after the options have been checked. */
interface HopRequest {
  readonly url: URL;
  readonly method: GuardedFetchMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | undefined;
}

/** The per-request policy, read once from the options. */
interface Policy {
  readonly allowHosts: readonly string[] | undefined;
  readonly allowPrivate: boolean;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly signal: AbortSignal | undefined;
}

/** A transport with every default filled in. */
interface Transport {
  readonly resolve: GuardedResolver;
  readonly connect: GuardedConnector;
  readonly ca: string | readonly string[] | undefined;
}

/** A hop's response before its body is read. */
interface HopResponse {
  readonly status: number;
  readonly headers: Headers;
  read(): Promise<Uint8Array>;
}

/** The system resolver, returning every address in the order the OS gives them. */
const systemResolve: GuardedResolver = async (hostname) =>
  (await lookup(hostname, { all: true, order: 'verbatim' })).map((entry) => entry.address);

/** A plain TCP connection to the vetted address; an IP literal host skips DNS. */
const tcpConnect: GuardedConnector = (target, signal) =>
  new Promise<Socket>((resolve, reject) => {
    const socket = netConnect({ host: target.address, port: target.port, noDelay: true });
    const onAbort = (): void => {
      settle();
      socket.destroy();
      reject(new Error('aborted'));
    };
    const onError = (): void => {
      settle();
      socket.destroy();
      reject(new Error('connect failed'));
    };
    const onConnect = (): void => {
      settle();
      resolve(socket);
    };
    function settle(): void {
      signal.removeEventListener('abort', onAbort);
      socket.off('error', onError);
      socket.off('connect', onConnect);
    }
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });

/**
 * Build a guarded fetch over `transport`. The transport is how the instance
 * reaches the network (a test points it at a loopback server); the guard
 * itself is not configurable here, only per request.
 *
 * @public
 */
export function createGuardedFetch(transport: GuardedFetchTransport = {}): GuardedFetch {
  const resolved = readTransport(transport);
  return (url, options) => fetchGuarded(resolved, url, options);
}

/**
 * Request `url` under the guard described in the module documentation and
 * resolve with the final response, its body read in full. A non-2xx status
 * is a response, not an error; a refused or failed request rejects with a
 * {@link GuardedFetchError}.
 *
 * @public
 */
export const guardedFetch: GuardedFetch = createGuardedFetch();

async function fetchGuarded(
  transport: Transport,
  url: unknown,
  options: GuardedFetchOptions,
): Promise<GuardedResponse> {
  const { policy, request: initial } = readRequest(url, options);
  if (policy.signal?.aborted === true) {
    throw new GuardedFetchError('aborted', 'the request was aborted');
  }
  const deadline = startTimeout(policy.timeoutMs);
  const signal =
    policy.signal === undefined
      ? deadline.signal
      : AbortSignal.any([deadline.signal, policy.signal]);
  const open = new Set<Socket>();
  const closeAll = (): void => {
    for (const socket of open) socket.destroy();
    open.clear();
  };
  signal.addEventListener('abort', closeAll, { once: true });
  try {
    let request = initial;
    for (let redirects = 0; ; redirects += 1) {
      const response = await hop(transport, request, policy, signal, open);
      const location = REDIRECT_STATUSES.has(response.status)
        ? response.headers.get('location')
        : null;
      if (location === null || location === '') {
        const bytes = request.method === 'HEAD' ? EMPTY : await response.read();
        return Object.freeze({
          status: response.status,
          headers: response.headers,
          bytes,
          url: request.url.href,
        });
      }
      // The redirect body is never read: closing the connection is cheaper
      // than draining a body of unknown size.
      closeAll();
      if (redirects >= policy.maxRedirects) {
        throw new GuardedFetchError('too_many_redirects', 'the request redirected too many times');
      }
      request = redirectRequest(request, response.status, location);
    }
  } catch (error) {
    if (deadline.signal.aborted) {
      throw new GuardedFetchError('timeout', 'the request did not finish in time');
    }
    if (signal.aborted) throw new GuardedFetchError('aborted', 'the request was aborted');
    if (error instanceof GuardedFetchError) throw error;
    // Sanitized: a Node network error names the host and address it failed on.
    throw new GuardedFetchError('response_failed', 'the request failed');
  } finally {
    signal.removeEventListener('abort', closeAll);
    closeAll();
    deadline.clear();
  }
}

/** Check, resolve, connect, and send one hop, resolving once its headers arrive. */
async function hop(
  transport: Transport,
  request: HopRequest,
  policy: Policy,
  signal: AbortSignal,
  open: Set<Socket>,
): Promise<HopResponse> {
  const { url } = request;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new GuardedFetchError('invalid_url', 'the url must use https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new GuardedFetchError('invalid_url', 'the url must not carry credentials');
  }
  if (url.protocol === 'http:' && !policy.allowPrivate) {
    throw new GuardedFetchError('invalid_url', 'the url must use https');
  }
  if (policy.allowHosts !== undefined && !policy.allowHosts.includes(url.hostname)) {
    throw new GuardedFetchError('host_not_allowed', 'the url host is not allowed');
  }

  const host = unbracket(url.hostname);
  const addresses = isIP(host) === 0 ? await resolveHost(transport.resolve, host, signal) : [host];
  if (!policy.allowPrivate && addresses.some(isPrivateAddress)) {
    throw new GuardedFetchError('blocked_address', 'the url host resolves to a blocked address');
  }
  if (url.protocol === 'http:' && !addresses.every(isLoopbackAddress)) {
    throw new GuardedFetchError('invalid_url', 'plain http is only allowed to a loopback address');
  }

  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  const socket = await connectFirst(transport.connect, addresses, port, signal, open);
  const stream =
    url.protocol === 'https:' ? await secure(socket, host, transport.ca, signal, open) : socket;
  return await exchange(stream, request, policy.maxBytes, signal);
}

/** Resolve `hostname` once; an empty or malformed answer fails closed. */
async function resolveHost(
  resolve: GuardedResolver,
  hostname: string,
  signal: AbortSignal,
): Promise<readonly string[]> {
  let answer: unknown;
  try {
    answer = await raceAbort(
      Promise.resolve().then(() => resolve(hostname)),
      signal,
    );
  } catch {
    throw new GuardedFetchError('resolve_failed', 'the url host could not be resolved');
  }
  if (!Array.isArray(answer) || answer.length === 0) {
    throw new GuardedFetchError('resolve_failed', 'the url host could not be resolved');
  }
  const entries: readonly unknown[] = answer;
  const addresses: string[] = [];
  for (const address of entries) {
    if (typeof address !== 'string' || isIP(address) === 0) {
      throw new GuardedFetchError('resolve_failed', 'the url host could not be resolved');
    }
    addresses.push(address);
  }
  return addresses;
}

/**
 * Connect to the first vetted address that accepts, in resolver order. Every
 * candidate passed the checks above, so falling back to the next one cannot
 * reach anything the guard refused.
 */
async function connectFirst(
  connect: GuardedConnector,
  addresses: readonly string[],
  port: number,
  signal: AbortSignal,
  open: Set<Socket>,
): Promise<Socket> {
  for (const address of addresses) {
    try {
      const socket = await raceAbort(
        Promise.resolve().then(() => connect({ address, port }, signal)),
        signal,
        (late) => late.destroy(),
      );
      track(socket, open);
      return socket;
    } catch {
      if (signal.aborted) throw new Error('aborted');
    }
  }
  throw new GuardedFetchError('connect_failed', 'the url host could not be reached');
}

/** Run TLS over `socket`, verifying the certificate against the URL host. */
async function secure(
  socket: Socket,
  host: string,
  ca: string | readonly string[] | undefined,
  signal: AbortSignal,
  open: Set<Socket>,
): Promise<Socket> {
  const options: ConnectionOptions = {
    socket,
    // `host` is what the certificate is checked against; without it Node
    // would check the address the socket is connected to.
    host,
    ALPNProtocols: ['http/1.1'],
    rejectUnauthorized: true,
    ...(isIP(host) === 0 ? { servername: host } : {}),
    ...(ca === undefined ? {} : { ca: typeof ca === 'string' ? ca : [...ca] }),
  };
  const tls = tlsConnect(options);
  track(tls, open);
  await raceAbort(
    new Promise<void>((resolve, reject) => {
      tls.once('secureConnect', () => resolve());
      tls.once('error', () => reject(new GuardedFetchError('tls', 'the TLS handshake failed')));
    }),
    signal,
  );
  return tls;
}

/** Send the request over `stream` and resolve with the response head. */
function exchange(
  stream: Socket,
  request: HopRequest,
  maxBytes: number,
  signal: AbortSignal,
): Promise<HopResponse> {
  const headers: OutgoingHttpHeaders = {
    'user-agent': 'jsails',
    // The body is returned as it arrives and `maxBytes` counts those bytes,
    // so nothing compressed is asked for unless the caller says otherwise.
    'accept-encoding': 'identity',
    ...request.headers,
    host: request.url.host,
    connection: 'close',
  };
  if (request.body !== undefined) headers['content-length'] = String(request.body.byteLength);
  return raceAbort(
    new Promise<HopResponse>((resolve, reject) => {
      const outgoing = httpRequest({
        createConnection: () => stream,
        method: request.method,
        path: `${request.url.pathname}${request.url.search}`,
        headers,
        setHost: false,
      });
      outgoing.on('error', () =>
        reject(new GuardedFetchError('response_failed', 'the request failed')),
      );
      outgoing.once('response', (incoming: IncomingMessage) => {
        let responseHeaders: Headers;
        try {
          responseHeaders = toHeaders(incoming.rawHeaders);
        } catch {
          reject(new GuardedFetchError('response_failed', 'the response headers are invalid'));
          return;
        }
        resolve({
          status: incoming.statusCode ?? 0,
          headers: responseHeaders,
          read: () => raceAbort(readBody(incoming, maxBytes), signal),
        });
      });
      outgoing.end(request.body);
    }),
    signal,
  );
}

/** Read the body up to `maxBytes`; past it, the response is destroyed at once. */
function readBody(incoming: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const declared = incoming.headers['content-length'];
    if (declared !== undefined && Number(declared) > maxBytes) {
      reject(tooLarge());
      incoming.destroy();
      return;
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    incoming.on('data', (chunk: Uint8Array) => {
      received += chunk.byteLength;
      if (received > maxBytes) {
        reject(tooLarge());
        incoming.destroy();
        return;
      }
      chunks.push(chunk);
    });
    incoming.once('end', () => resolve(concatBytes(chunks)));
    incoming.on('error', () =>
      reject(new GuardedFetchError('response_failed', 'the response could not be read')),
    );
    incoming.once('close', () => {
      if (!incoming.complete) {
        reject(new GuardedFetchError('response_failed', 'the response could not be read'));
      }
    });
  });
}

function tooLarge(): GuardedFetchError {
  return new GuardedFetchError('too_large', 'the response exceeds the size limit');
}

/** The next hop's request for a redirect to `location`, as `fetch` would build it. */
function redirectRequest(previous: HopRequest, status: number, location: string): HopRequest {
  let url: URL;
  try {
    url = new URL(location, previous.url);
  } catch {
    throw new GuardedFetchError('invalid_url', 'the redirect location is invalid');
  }
  url.hash = '';
  const toGet =
    status === 303
      ? previous.method !== 'HEAD'
      : status !== 307 && status !== 308 && previous.method === 'POST';
  const headers: Record<string, string> = { ...previous.headers };
  if (toGet) for (const name of BODY_HEADERS) delete headers[name];
  if (url.origin !== previous.url.origin) {
    for (const name of ORIGIN_BOUND_HEADERS) delete headers[name];
  }
  return {
    url,
    method: toGet ? 'GET' : previous.method,
    headers,
    body: toGet ? undefined : previous.body,
  };
}

/** Response headers in arrival order, repeated fields kept. */
function toHeaders(raw: readonly string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index + 1 < raw.length; index += 2) {
    headers.append(raw[index] ?? '', raw[index + 1] ?? '');
  }
  return headers;
}

/**
 * Keep `socket` for the request's cleanup. The listener stays for the
 * socket's life: an error after the exchange settled has nobody left to
 * report to, and without a listener Node would throw it as uncaught.
 */
function track(socket: Socket, open: Set<Socket>): void {
  open.add(socket);
  socket.on('error', () => socket.destroy());
}

/**
 * Settle with `promise`, or reject as soon as `signal` aborts. A value that
 * arrives after the abort is handed to `discard` (a socket nobody will use).
 */
function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  discard?: (late: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let aborted = signal.aborted;
    const onAbort = (): void => {
      aborted = true;
      reject(new Error('aborted'));
    };
    if (aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (aborted) discard?.(value);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('failed'));
      },
    );
  });
}

/** `URL#hostname` spells an IPv6 literal in brackets; the address checks want it bare. */
function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function invalidOptions(message: string): GuardedFetchError {
  return new GuardedFetchError('invalid_options', message);
}

function readTransport(transport: GuardedFetchTransport): Transport {
  if (typeof transport !== 'object' || transport === null) {
    throw invalidOptions('the transport must be an object');
  }
  const { resolve, connect, ca } = transport;
  if (resolve !== undefined && typeof resolve !== 'function') {
    throw invalidOptions('resolve must be a function');
  }
  if (connect !== undefined && typeof connect !== 'function') {
    throw invalidOptions('connect must be a function');
  }
  if (
    ca !== undefined &&
    typeof ca !== 'string' &&
    !(Array.isArray(ca) && ca.every((entry) => typeof entry === 'string'))
  ) {
    throw invalidOptions('ca must be a PEM string or an array of them');
  }
  return {
    resolve: resolve ?? systemResolve,
    connect: connect ?? tcpConnect,
    ca: ca === undefined ? undefined : typeof ca === 'string' ? ca : Object.freeze([...ca]),
  };
}

/** Check the URL and options before anything touches the network. */
function readRequest(
  url: unknown,
  options: GuardedFetchOptions,
): { readonly policy: Policy; readonly request: HopRequest } {
  if (typeof options !== 'object' || options === null) {
    throw invalidOptions('options must be an object');
  }
  const { maxBytes, timeoutMs, allowHosts, allowPrivate, signal } = options;
  if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw invalidOptions('maxBytes must be a non-negative integer');
  }
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw invalidOptions('timeoutMs must be a positive integer number of milliseconds');
  }
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (
    typeof maxRedirects !== 'number' ||
    !Number.isInteger(maxRedirects) ||
    maxRedirects < 0 ||
    maxRedirects > MAX_REDIRECTS_CEILING
  ) {
    throw invalidOptions('maxRedirects must be an integer from 0 to 20');
  }
  if (allowHosts !== undefined && !Array.isArray(allowHosts)) {
    throw invalidOptions('allowHosts must be an array of host names');
  }
  if (allowPrivate !== undefined && typeof allowPrivate !== 'boolean') {
    throw invalidOptions('allowPrivate must be a boolean');
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw invalidOptions('signal must be an AbortSignal');
  }

  const method = options.method ?? 'GET';
  if (typeof method !== 'string' || !METHODS.has(method)) {
    throw invalidOptions('method is not supported');
  }
  const body = readBodyOption(options.body);
  if (body !== undefined && (method === 'GET' || method === 'HEAD')) {
    throw invalidOptions('a GET or HEAD request carries no body');
  }

  if (typeof url !== 'string' || url === '') {
    throw new GuardedFetchError('invalid_url', 'the url is invalid');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GuardedFetchError('invalid_url', 'the url is invalid');
  }
  parsed.hash = '';

  return {
    policy: {
      allowHosts:
        allowHosts === undefined ? undefined : Object.freeze(allowHosts.map(normalizeHost)),
      allowPrivate: allowPrivate === true,
      maxBytes,
      timeoutMs,
      maxRedirects,
      signal,
    },
    request: { url: parsed, method, headers: readHeaders(options.headers), body },
  };
}

/**
 * An `allowHosts` entry spelled the way `URL#hostname` spells the host it
 * names (lower case, punycode, canonical IP literal), so the comparison with
 * each hop is exact. An entry that is not a bare host name is refused.
 */
function normalizeHost(host: unknown): string {
  if (typeof host !== 'string' || host === '' || /[/?#@\\\s]/.test(host)) {
    throw invalidOptions('allowHosts must be an array of host names');
  }
  let parsed: URL;
  try {
    parsed = new URL(`https://${host}/`);
  } catch {
    throw invalidOptions('allowHosts must be an array of host names');
  }
  // `URL` drops a default port, so a colon outside an IPv6 literal is refused
  // here rather than read as `host:443`.
  if (parsed.port !== '' || (host.includes(':') && !host.startsWith('['))) {
    throw invalidOptions('allowHosts must be an array of host names');
  }
  return parsed.hostname;
}

function readBodyOption(body: unknown): Uint8Array | undefined {
  if (body === undefined) return undefined;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body.slice();
  throw invalidOptions('body must be a string or a Uint8Array');
}

/** Lower-cased, validated request headers; a connection-level header is refused. */
function readHeaders(headers: unknown): Readonly<Record<string, string>> {
  if (headers === undefined) return {};
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    throw invalidOptions('headers must be an object of strings');
  }
  // No prototype, so a header named `__proto__` is kept like any other.
  const read: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name) || typeof value !== 'string' || !HEADER_VALUE.test(value)) {
      throw invalidOptions('headers must be valid header names and values');
    }
    const lower = name.toLowerCase();
    if (OWNED_HEADERS.has(lower)) {
      throw invalidOptions('a connection-level header is set by the fetch itself');
    }
    if (Object.hasOwn(read, lower)) {
      throw invalidOptions('a header is named twice');
    }
    read[lower] = value;
  }
  return read;
}
