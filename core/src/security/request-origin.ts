/**
 * Request origin and client address: the one place a request's `Host` and
 * forwarding headers are read.
 *
 * {@link createOriginPolicy} compiles the `server` config (`origin`, `hosts`,
 * `trustedProxies`) once; {@link resolveRequestOrigin} then answers, per
 * request and without I/O, which origin the request was addressed to and which
 * client sent it, or that the `Host` is not one this app serves (421). A
 * health or readiness probe is the one exception to the 421: a deploy tool
 * probes the container by its own address, so a probe resolves to the
 * canonical origin whatever host it names.
 *
 * - The origin: with `server.origin` set, the request's host must be that
 *   origin's host or match one of `server.hosts` (`*.example.com` matches
 *   exactly one label). The canonical host always resolves to the configured
 *   origin itself; another allowed host takes the scheme a trusted proxy
 *   reported in `X-Forwarded-Proto`, else the configured origin's scheme.
 *   Without `server.origin` (development and test only; serving elsewhere
 *   requires it) every host is accepted as its own origin. `X-Forwarded-Host`
 *   is never read: the host is the one the request URL carries.
 * - The client: with `trustedProxies: 'none'` (the default) it is the socket
 *   peer and no header is read at all. With `{ hops: n }` it is the n-th
 *   `X-Forwarded-For` entry from the right, the address the outermost of the n
 *   proxies received the request from; everything to its left is
 *   client-supplied and never read, so garbage there changes nothing. With
 *   `{ cidrs }` the chain is walked from the peer leftwards past every address
 *   inside the trusted ranges, and only when the peer itself is inside them. A
 *   chain shorter than the hop count, or a malformed entry where the client
 *   should be, falls back to the peer and is reported as an `anomaly`.
 *
 * A client's `bucket` is the key per-client limits use: an IPv4 address
 * itself, an IPv6 address's /64 (the smallest block one host is handed, so it
 * cannot rotate through its own addresses), an IPv4-mapped IPv6 address as its
 * IPv4 form. {@link canonicalizeForwardingHeaders} then rewrites the request's
 * headers so anything downstream that reads them (a library's own limiter)
 * sees exactly one `X-Forwarded-For` value, the resolved client, an
 * `X-Forwarded-Proto` that agrees with the resolved origin, and no
 * `Forwarded`, `X-Real-IP`, or `X-Forwarded-Host`.
 *
 * Server-only (`node:net`). Errors are value-free: they name the field, never
 * the value.
 */

import { BlockList, isIP } from 'node:net';

import { JsailsError } from '../errors/jsails-error.js';
import { assertHttpOrigin } from '../url/origin.js';

/**
 * The environment variable a deploy tool sets when the app config states no `trustedProxies`.
 *
 * @public
 */
export const TRUSTED_PROXIES_ENV = 'JSAILS_TRUSTED_PROXIES';

/**
 * The largest accepted hop count; a longer proxy chain is stated as CIDR ranges.
 *
 * @public
 */
export const MAX_TRUSTED_HOPS = 16;

/**
 * Which peers may speak for the client through `X-Forwarded-For`:
 * `'none'` (no one; the socket peer is the client), `{ hops }` (exactly that
 * many proxies sit in front of the app, each appending the address it received
 * the request from), or `{ cidrs }` (any peer inside these ranges is a proxy).
 *
 * @public
 */
export type TrustedProxies =
  'none' | { readonly hops: number } | { readonly cidrs: readonly string[] };

/**
 * An additional host the app answers on: `example.org`, `example.org:8443`,
 * or `*.example.com`, where `*` stands for exactly one DNS label. A pattern
 * without a port is served on the canonical origin's port.
 *
 * @public
 */
export type HostPattern = string;

/**
 * The request-origin part of the `server` config.
 *
 * @public
 */
export interface ServerOriginConfig {
  /**
   * The canonical public origin, e.g. `https://example.com`. Required to
   * serve outside development and test; absent, every host is its own origin.
   */
  readonly origin?: string;
  /** Hosts besides the canonical one the app answers on (tenant subdomains, an alias). */
  readonly hosts?: readonly HostPattern[];
  /** Who may speak for the client; defaults to `'none'`. */
  readonly trustedProxies?: TrustedProxies;
}

/**
 * The client that sent a request. `via` says where the address came from: the
 * TCP peer, a trusted proxy's `X-Forwarded-For` entry, or nowhere (an
 * in-process request with no socket), in which case every such request shares
 * the one `unknown` bucket.
 *
 * @public
 */
export type ClientAddress =
  | { readonly via: 'socket' | 'forwarded'; readonly ip: string; readonly bucket: string }
  | { readonly via: 'unknown'; readonly bucket: 'unknown' };

/**
 * The origin a request was addressed to.
 *
 * @public
 */
export interface RequestOrigin {
  /** `scheme://host[:port]`, the value a same-origin `Origin` header carries. */
  readonly origin: string;
  /** The host, with a port only when it is not the scheme's default. */
  readonly host: string;
  /** True when this is the configured canonical origin; false for an alias or with none configured. */
  readonly canonical: boolean;
}

/**
 * Why a request's forwarded chain was not used for the client address.
 *
 * @public
 */
export type ForwardedAnomaly = 'short_chain' | 'malformed_forwarded';

/**
 * A request the app serves: who sent it and where it was addressed.
 *
 * @public
 */
export interface ResolvedRequestOrigin {
  readonly client: ClientAddress;
  readonly origin: RequestOrigin;
  /** True when the request arrived carrying `Forwarded`, `X-Forwarded-For`, or `X-Real-IP`. */
  readonly relayed: boolean;
  /** Set when a trusted chain was unusable and the peer was used instead. */
  readonly anomaly?: ForwardedAnomaly;
}

/**
 * A request whose `Host` this app does not serve.
 *
 * @public
 */
export interface RefusedRequestOrigin {
  readonly refused: 421;
}

/**
 * The outcome of {@link resolveRequestOrigin}.
 *
 * @public
 */
export type RequestOriginResult = ResolvedRequestOrigin | RefusedRequestOrigin;

/**
 * What {@link resolveRequestOrigin} reads from one request.
 *
 * @public
 */
export interface RequestOriginInput {
  /** The TCP peer address, or `undefined` for an in-process request. */
  readonly peer: string | undefined;
  /** The request URL; its host is the request's `Host`. */
  readonly url: URL;
  readonly headers: Headers;
  /**
   * True for a liveness or readiness probe, which is answered whatever host it
   * names: a deploy tool and a reverse proxy probe the container by its own
   * address (`127.0.0.1:3000`, `web-1:3000`), never by the public host. A
   * probe for a host the app does not serve resolves to the canonical origin
   * instead of 421; its answer carries nothing a host could be trusted for.
   */
  readonly probe?: boolean;
}

/**
 * A validated `server` origin config, frozen. Only a policy built by
 * {@link createOriginPolicy} is accepted by {@link resolveRequestOrigin}.
 *
 * @public
 */
export interface OriginPolicy {
  /** The canonical origin, or `undefined` when every host is accepted. */
  readonly origin: string | undefined;
  /** The additional host patterns. */
  readonly hosts: readonly HostPattern[];
  /** Who may speak for the client. */
  readonly trustedProxies: TrustedProxies;
}

/**
 * Stable failure codes of {@link RequestOriginConfigError}.
 *
 * @public
 */
export type RequestOriginConfigErrorCode =
  'invalid_origin' | 'invalid_host_pattern' | 'hosts_without_origin' | 'invalid_trusted_proxies';

/**
 * Raised for an invalid `server.origin`, `server.hosts`, or `server.trustedProxies`.
 *
 * @public
 */
export class RequestOriginConfigError extends JsailsError {
  readonly code: RequestOriginConfigErrorCode;
  /** The config field at fault: `origin`, `hosts`, or `trustedProxies`. */
  readonly field: 'origin' | 'hosts' | 'trustedProxies';

  constructor(
    code: RequestOriginConfigErrorCode,
    field: 'origin' | 'hosts' | 'trustedProxies',
    message: string,
  ) {
    super(message, { context: { field } });
    this.code = code;
    this.field = field;
  }
}

interface CompiledHost {
  /** For a wildcard, the hostname the single label sits under; else the whole hostname. */
  readonly hostname: string;
  readonly wildcard: boolean;
  /**
   * The port the host is served on, or `''` for the canonical scheme's
   * default; a pattern that names no port takes the canonical origin's.
   */
  readonly port: string;
}

type CompiledTrust =
  | { readonly kind: 'none' }
  | { readonly kind: 'hops'; readonly hops: number }
  | { readonly kind: 'cidrs'; readonly ranges: BlockList };

interface CompiledPolicy {
  readonly canonical:
    | { readonly origin: string; readonly host: string; readonly scheme: 'http' | 'https' }
    | undefined;
  readonly hosts: readonly CompiledHost[];
  readonly trust: CompiledTrust;
}

/**
 * Validate and compile the `server` origin config. Throws a value-free
 * {@link RequestOriginConfigError} naming the field at fault.
 *
 * @public
 */
export function createOriginPolicy(config: ServerOriginConfig = {}): OriginPolicy {
  const origin = validateOrigin(config.origin);
  let canonical: CompiledPolicy['canonical'];
  let canonicalPort = '';
  if (origin !== undefined) {
    const url = new URL(origin);
    canonical = { origin, host: url.host, scheme: url.protocol === 'https:' ? 'https' : 'http' };
    canonicalPort = url.port;
  }
  const hosts = compileHosts(config.hosts, canonical?.scheme ?? 'http', canonicalPort);
  if (origin === undefined && hosts.length > 0) {
    throw new RequestOriginConfigError(
      'hosts_without_origin',
      'hosts',
      'server.hosts requires server.origin',
    );
  }
  const trustedProxies = validateTrustedProxies(config.trustedProxies ?? 'none');
  const policy: OriginPolicy = Object.freeze({
    origin,
    hosts: Object.freeze([...(config.hosts ?? [])]),
    trustedProxies,
  });
  compiledPolicies.set(policy, { canonical, hosts, trust: compileTrust(trustedProxies) });
  return policy;
}

/**
 * Parse the `JSAILS_TRUSTED_PROXIES` environment value: `none`, `hops=<n>`,
 * or a comma-separated list of CIDR ranges (a bare address is a single-host
 * range). Throws a value-free {@link RequestOriginConfigError}.
 *
 * @public
 */
export function parseTrustedProxies(value: string): TrustedProxies {
  const text = value.trim();
  if (text === 'none') return 'none';
  const hops = /^hops=(\d{1,3})$/.exec(text);
  try {
    if (hops !== null) return validateTrustedProxies({ hops: Number(hops[1]) });
    if (text !== '' && !text.includes('=')) {
      return validateTrustedProxies({ cidrs: text.split(',').map((entry) => entry.trim()) });
    }
  } catch (error) {
    if (!(error instanceof RequestOriginConfigError)) throw error;
  }
  throw new RequestOriginConfigError(
    'invalid_trusted_proxies',
    'trustedProxies',
    `${TRUSTED_PROXIES_ENV} must be none, hops=<n> (n from 1 to ${MAX_TRUSTED_HOPS}), or a comma-separated list of CIDR ranges`,
  );
}

/**
 * True when two trusted-proxy settings mean the same thing.
 *
 * @public
 */
export function sameTrustedProxies(a: TrustedProxies, b: TrustedProxies): boolean {
  if (a === 'none' || b === 'none') return a === b;
  if ('hops' in a) return 'hops' in b && a.hops === b.hops;
  return (
    'cidrs' in b && a.cidrs.length === b.cidrs.length && a.cidrs.every((c, i) => c === b.cidrs[i])
  );
}

/**
 * Resolve who sent a request and where it was addressed, or refuse its host
 * with 421. Pure: reads only `input`, never mutates it.
 *
 * @public
 */
export function resolveRequestOrigin(
  input: RequestOriginInput,
  policy: OriginPolicy,
): RequestOriginResult {
  const compiled = compiledPolicies.get(policy);
  if (compiled === undefined) {
    throw new TypeError('resolveRequestOrigin requires a policy from createOriginPolicy');
  }
  const { canonical, hosts, trust } = compiled;
  const { headers, url } = input;
  const scheme = canonical?.scheme ?? (url.protocol === 'https:' ? 'https' : 'http');
  const host = hostKey(url, scheme);

  let allowed: 'canonical' | 'alias';
  if (canonical === undefined || host === canonical.host) {
    allowed = 'canonical';
  } else if (hosts.some((pattern) => matchesHost(pattern, url, host))) {
    allowed = 'alias';
  } else if (input.probe === true) {
    allowed = 'canonical';
  } else {
    return REFUSED;
  }

  const peer = input.peer === undefined ? undefined : normalizeAddress(input.peer);
  const client = resolveClient(peer, headers, trust);
  const relayed =
    headers.has('x-forwarded-for') || headers.has('forwarded') || headers.has('x-real-ip');

  let origin: RequestOrigin;
  if (allowed === 'canonical' && canonical !== undefined) {
    origin = { origin: canonical.origin, host: canonical.host, canonical: true };
  } else {
    const forwardedScheme = client.trusted ? forwardedProto(headers, trust, client) : undefined;
    const effective = forwardedScheme ?? scheme;
    origin = { origin: `${effective}://${host}`, host, canonical: false };
  }
  return client.anomaly === undefined
    ? { client: client.address, origin, relayed }
    : { client: client.address, origin, relayed, anomaly: client.anomaly };
}

/**
 * Rewrite a request's forwarding headers to what was resolved: one
 * `X-Forwarded-For` holding the client's address (none when it is unknown),
 * `X-Forwarded-Proto` naming the resolved origin's scheme when the request
 * carried one, and no `Forwarded`, `X-Real-IP`, or `X-Forwarded-Host` (the
 * host is the request's own, already checked). A library that reads these
 * headers itself therefore sees only resolved values, never ones the client
 * wrote. Headers already in that shape are left untouched.
 *
 * @public
 */
export function canonicalizeForwardingHeaders(
  headers: Headers,
  resolved: ResolvedRequestOrigin,
): void {
  if (headers.has('forwarded')) headers.delete('forwarded');
  if (headers.has('x-real-ip')) headers.delete('x-real-ip');
  if (headers.has('x-forwarded-host')) headers.delete('x-forwarded-host');
  const proto = headers.get('x-forwarded-proto');
  if (proto !== null) {
    const scheme = resolved.origin.origin.startsWith('https:') ? 'https' : 'http';
    if (proto !== scheme) headers.set('x-forwarded-proto', scheme);
  }
  const { client } = resolved;
  const current = headers.get('x-forwarded-for');
  if (client.via === 'unknown') {
    if (current !== null) headers.delete('x-forwarded-for');
  } else if (current !== client.ip) {
    headers.set('x-forwarded-for', client.ip);
  }
}

/**
 * The client address for a raw address string (`198.51.100.7`,
 * `[2001:db8::1]:443`, `fe80::1%eth0`), or `undefined` when it is not an IP
 * address. Exported for the transports that resolve a peer outside HTTP.
 *
 * @public
 */
export function clientAddressOf(
  raw: string,
  via: 'socket' | 'forwarded',
): ClientAddress | undefined {
  const address = normalizeAddress(raw);
  return address === undefined ? undefined : toClient(address, via);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** The compiled matchers behind each policy {@link createOriginPolicy} returned. */
const compiledPolicies = new WeakMap<OriginPolicy, CompiledPolicy>();

const REFUSED: RefusedRequestOrigin = Object.freeze({ refused: 421 });

const UNKNOWN_CLIENT: ClientAddress = Object.freeze({ via: 'unknown', bucket: 'unknown' });

/** A validated, normalized IP address. */
interface Address {
  /** IPv4 dotted form, or compressed lowercase IPv6 (an IPv4-mapped address is IPv4). */
  readonly ip: string;
  readonly family: 'ipv4' | 'ipv6';
  /** The eight 16-bit groups of an IPv6 address. */
  readonly groups?: readonly number[];
}

interface ResolvedClient {
  readonly address: ClientAddress;
  /** True when the peer is a trusted proxy, so its other forwarded headers may be read. */
  readonly trusted: boolean;
  /** For a forwarded client, its index in the `X-Forwarded-For` chain. */
  readonly index?: number;
  readonly anomaly?: ForwardedAnomaly;
}

function resolveClient(
  peer: Address | undefined,
  headers: Headers,
  trust: CompiledTrust,
): ResolvedClient {
  const fromPeer: ClientAddress = peer === undefined ? UNKNOWN_CLIENT : toClient(peer, 'socket');
  if (trust.kind === 'none') return { address: fromPeer, trusted: false };

  if (trust.kind === 'hops') {
    const chain = forwardedChain(headers.get('x-forwarded-for'));
    const index = chain.length - trust.hops;
    if (index < 0) {
      return { address: fromPeer, trusted: false, anomaly: 'short_chain' };
    }
    const entry = normalizeAddress(chain[index] ?? '');
    if (entry === undefined) {
      return { address: fromPeer, trusted: false, anomaly: 'malformed_forwarded' };
    }
    return { address: toClient(entry, 'forwarded'), trusted: true, index };
  }

  if (peer === undefined || !inRanges(trust.ranges, peer)) {
    return { address: fromPeer, trusted: false };
  }
  const chain = forwardedChain(headers.get('x-forwarded-for'));
  let leftmost: Address | undefined;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const entry = normalizeAddress(chain[index] ?? '');
    if (entry === undefined) {
      return { address: fromPeer, trusted: true, anomaly: 'malformed_forwarded' };
    }
    if (!inRanges(trust.ranges, entry)) {
      return { address: toClient(entry, 'forwarded'), trusted: true, index };
    }
    leftmost = entry;
  }
  // Every hop, the peer included, is a trusted proxy: the chain's origin is
  // the left-most address, or the peer itself when no chain was sent.
  return leftmost === undefined
    ? { address: fromPeer, trusted: true }
    : { address: toClient(leftmost, 'forwarded'), trusted: true, index: 0 };
}

/** The `X-Forwarded-For` entries, joined across repeated headers, empty ones dropped. */
function forwardedChain(value: string | null): string[] {
  if (value === null) return [];
  const entries: string[] = [];
  for (const part of value.split(',')) {
    const entry = part.trim();
    if (entry !== '') entries.push(entry);
  }
  return entries;
}

/**
 * The scheme a trusted proxy reported, aligned with the hop that named the
 * client; `undefined` when it cannot be attributed to a trusted hop.
 */
function forwardedProto(
  headers: Headers,
  trust: CompiledTrust,
  client: ResolvedClient,
): 'http' | 'https' | undefined {
  const value = headers.get('x-forwarded-proto');
  if (value === null) return undefined;
  const list = forwardedChain(value);
  let entry: string | undefined;
  if (trust.kind === 'hops') {
    entry = list[list.length - trust.hops];
  } else if (client.index !== undefined) {
    const chainLength = forwardedChain(headers.get('x-forwarded-for')).length;
    entry = list.length === chainLength ? list[client.index] : undefined;
  }
  if (entry === undefined && list.length === 1) entry = list[0];
  const scheme = entry?.toLowerCase();
  return scheme === 'http' || scheme === 'https' ? scheme : undefined;
}

function toClient(address: Address, via: 'socket' | 'forwarded'): ClientAddress {
  return { via, ip: address.ip, bucket: bucketOf(address) };
}

/** The per-client limit key: the IPv4 address, or the IPv6 /64 network. */
function bucketOf(address: Address): string {
  if (address.family === 'ipv4' || address.groups === undefined) return address.ip;
  const network = [...address.groups.slice(0, 4), 0, 0, 0, 0];
  return `${compressIpv6(network)}/64`;
}

function inRanges(ranges: BlockList, address: Address): boolean {
  return ranges.check(address.ip, address.family);
}

/**
 * Normalize an address as a proxy or socket may write it: brackets, a port, an
 * IPv6 zone id, and an IPv4-mapped IPv6 form are stripped. `undefined` when
 * what remains is not an IP address.
 */
function normalizeAddress(raw: string): Address | undefined {
  let text = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(text);
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(text);
  const port = bracketed?.[2] ?? withPort?.[2];
  if (port !== undefined && Number(port) > 65535) return undefined;
  if (bracketed !== null) text = bracketed[1] ?? '';
  else if (withPort !== null) text = withPort[1] ?? '';
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  const family = isIP(text);
  if (family === 4) return { ip: text, family: 'ipv4' };
  if (family !== 6) return undefined;
  const groups = ipv6Groups(text.toLowerCase());
  if (groups === undefined) return undefined;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const [high = 0, low = 0] = groups.slice(6);
    return { ip: `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`, family: 'ipv4' };
  }
  return { ip: compressIpv6(groups), family: 'ipv6', groups };
}

/** Expand an IPv6 address (already validated by `isIP`) to its eight groups. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address;
  const tail: number[] = [];
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted !== null) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.slice(1).map(Number);
    tail.push((a << 8) | b, (c << 8) | d);
    text = text.slice(0, dotted.index);
    if (!text.endsWith('::')) text = text.slice(0, -1);
  }
  const parts = text.split('::');
  if (parts.length > 2) return undefined;
  const [head = '', rest] = parts;
  const left = head === '' ? [] : head.split(':');
  const right = rest === undefined || rest === '' ? [] : rest.split(':');
  const missing = 8 - tail.length - left.length - right.length;
  if (rest === undefined ? missing !== 0 : missing < 0) return undefined;
  const groups = [...left, ...Array<string>(missing).fill('0'), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
  return [...groups, ...tail];
}

/** RFC 5952 text for eight groups: lowercase, the longest zero run (2+) compressed. */
function compressIpv6(groups: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 1;
  for (let start = 0; start < 8; start += 1) {
    let length = 0;
    while (start + length < 8 && groups[start + length] === 0) length += 1;
    if (length > bestLength) {
      bestStart = start;
      bestLength = length;
    }
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestStart === -1) return hex.join(':');
  const head = hex.slice(0, bestStart).join(':');
  const tail = hex.slice(bestStart + bestLength).join(':');
  return `${head}::${tail}`;
}

/** The request host, without a port that is the default for `scheme`. */
function hostKey(url: URL, scheme: 'http' | 'https'): string {
  const port = url.port;
  if (port === '' || port === defaultPort(scheme)) return url.hostname;
  return `${url.hostname}:${port}`;
}

function defaultPort(scheme: 'http' | 'https'): string {
  return scheme === 'https' ? '443' : '80';
}

function matchesHost(pattern: CompiledHost, url: URL, host: string): boolean {
  // `host` carries a port only when it is not the canonical scheme's default.
  const separator = host.lastIndexOf(':');
  const hasPort = separator > host.lastIndexOf(']');
  const port = hasPort ? host.slice(separator + 1) : '';
  if (port !== pattern.port) return false;
  const hostname = url.hostname;
  if (!pattern.wildcard) return hostname === pattern.hostname;
  const suffix = `.${pattern.hostname}`;
  if (!hostname.endsWith(suffix)) return false;
  const label = hostname.slice(0, -suffix.length);
  return label !== '' && !label.includes('.');
}

function validateOrigin(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const invalid = (problem: string): RequestOriginConfigError =>
    new RequestOriginConfigError('invalid_origin', 'origin', `server.origin ${problem}`);
  if (typeof value !== 'string') throw invalid('must be an http(s) origin string');
  return assertHttpOrigin(value, invalid);
}

/**
 * Compile the host patterns against the canonical origin: a pattern without a
 * port is served on the canonical origin's port (`*.localhost` beside
 * `http://localhost:3000` means port 3000), and a port that is the canonical
 * scheme's default is the same as none, as it is in the request host.
 */
function compileHosts(
  value: readonly HostPattern[] | undefined,
  scheme: 'http' | 'https',
  canonicalPort: string,
): readonly CompiledHost[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new RequestOriginConfigError(
      'invalid_host_pattern',
      'hosts',
      'server.hosts must be an array of host patterns',
    );
  }
  return Object.freeze(
    value.map((pattern: unknown) => {
      const compiled = compileHost(pattern);
      let port = compiled.port === '' ? canonicalPort : compiled.port;
      if (port === defaultPort(scheme)) port = '';
      return Object.freeze({ ...compiled, port });
    }),
  );
}

/** Validate one host pattern; the message names the field, never the pattern. */
function compileHost(pattern: unknown): CompiledHost {
  const invalid = (): RequestOriginConfigError =>
    new RequestOriginConfigError(
      'invalid_host_pattern',
      'hosts',
      'server.hosts entries must be a host, host:port, or *.domain pattern',
    );
  if (typeof pattern !== 'string' || pattern === '' || pattern !== pattern.toLowerCase()) {
    throw invalid();
  }
  const wildcard = pattern.startsWith('*.');
  const rest = wildcard ? pattern.slice(2) : pattern;
  let url: URL;
  try {
    url = new URL(`http://${rest}`);
  } catch {
    throw invalid();
  }
  const port = /:(\d{1,5})$/.exec(rest)?.[1] ?? '';
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    `${url.hostname}${port === '' ? '' : `:${port}`}` !== rest ||
    rest.includes('*')
  ) {
    throw invalid();
  }
  // A wildcard must sit under a name with at least two labels (`*.com` would
  // admit every host in a top-level domain), or under `localhost`, whose
  // subdomains resolve to loopback; never over an IP literal.
  if (
    wildcard &&
    ((!url.hostname.includes('.') && url.hostname !== 'localhost') ||
      isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0)
  ) {
    throw invalid();
  }
  return { hostname: url.hostname, wildcard, port };
}

function validateTrustedProxies(value: unknown): TrustedProxies {
  const invalid = (message: string): RequestOriginConfigError =>
    new RequestOriginConfigError('invalid_trusted_proxies', 'trustedProxies', message);
  if (value === 'none') return 'none';
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid("server.trustedProxies must be 'none', { hops }, or { cidrs }");
  }
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === 'hops') {
    const hops = (value as { hops: unknown }).hops;
    if (
      typeof hops !== 'number' ||
      !Number.isInteger(hops) ||
      hops < 1 ||
      hops > MAX_TRUSTED_HOPS
    ) {
      throw invalid(`server.trustedProxies.hops must be an integer from 1 to ${MAX_TRUSTED_HOPS}`);
    }
    return Object.freeze({ hops });
  }
  if (keys.length === 1 && keys[0] === 'cidrs') {
    const cidrs = (value as { cidrs: unknown }).cidrs;
    if (!Array.isArray(cidrs) || cidrs.length === 0) {
      throw invalid('server.trustedProxies.cidrs must be a non-empty array of CIDR ranges');
    }
    const ranges = new BlockList();
    for (const range of cidrs) {
      if (typeof range !== 'string' || !addRange(ranges, range)) {
        throw invalid('server.trustedProxies.cidrs entries must be IP addresses or CIDR ranges');
      }
    }
    return Object.freeze({ cidrs: Object.freeze([...(cidrs as string[])]) });
  }
  throw invalid("server.trustedProxies must be 'none', { hops }, or { cidrs }");
}

function compileTrust(value: TrustedProxies): CompiledTrust {
  if (value === 'none') return { kind: 'none' };
  if ('hops' in value) return { kind: 'hops', hops: value.hops };
  const ranges = new BlockList();
  for (const range of value.cidrs) addRange(ranges, range);
  return { kind: 'cidrs', ranges };
}

/** Add `range` (`10.0.0.0/8`, `fd00::/8`, or a bare address) to `ranges`; false when invalid. */
function addRange(ranges: BlockList, range: string): boolean {
  const slash = range.indexOf('/');
  const address = normalizeAddress(slash === -1 ? range : range.slice(0, slash));
  if (address === undefined || (slash !== -1 && range.slice(0, slash).includes('['))) return false;
  const maxPrefix = address.family === 'ipv4' ? 32 : 128;
  let prefix = maxPrefix;
  if (slash !== -1) {
    const text = range.slice(slash + 1);
    if (!/^\d{1,3}$/.test(text)) return false;
    prefix = Number(text);
    if (prefix > maxPrefix) return false;
  }
  ranges.addSubnet(address.ip, prefix, address.family);
  return true;
}
