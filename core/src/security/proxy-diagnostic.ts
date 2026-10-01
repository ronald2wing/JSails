/**
 * Proxy-trust diagnostics: what a request or a deploy environment shows about
 * a `server.trustedProxies` setting that does not match the proxies actually
 * in front of the app.
 *
 * A wrong setting fails quietly. Left at `'none'` behind a proxy, every
 * client arrives from the proxy's address and shares its rate-limit bucket;
 * with a hop count above the real number of proxies, every forwarded request
 * falls back to the proxy's address too. Nothing errors, so the two are
 * reported:
 *
 * - {@link createProxyDiagnostic} watches the requests the app's origin
 *   policy resolves (it rides on the policy, `observeRequestOrigins`, so it
 *   sees every resolution whichever stage makes it) and reports each
 *   condition at most once per process: `proxy_untrusted` (a forwarding
 *   header from a private or loopback peer that `'none'` or the CIDR ranges
 *   do not trust, which is what an untrusted reverse proxy in front of the
 *   app looks like), `proxy_chain_short` (a forwarded chain shorter than the
 *   hop count), `proxy_chain_malformed` (no address where the client should
 *   be), and, in production, `client_unknown` (a request with no socket peer,
 *   so every client shares the one `unknown` bucket). A request that carries
 *   no chain at all is direct and reports nothing, and neither does a health
 *   or readiness probe: a deploy tool or a proxy probes the container from
 *   inside the host, and a proxy between them (the cache proxy in front of
 *   the app) may give the probe a chain one entry long that says nothing
 *   about the proxies in front of real clients.
 * - {@link proxyTrustFindings} compares, without a request, the topology a
 *   deploy states in `JSAILS_TRUSTED_PROXIES` with the setting the app
 *   resolved; `jsails check --deploy` reports it.
 *
 * Reports are value-free: they name the condition and the fix, never an
 * address or a header value.
 */

import { BlockList, isIP } from 'node:net';

import {
  TRUSTED_PROXIES_ENV,
  sameTrustedProxies,
  type RequestOriginObserver,
  type TrustedProxies,
} from './request-origin.js';

/**
 * The conditions {@link createProxyDiagnostic} reports.
 *
 * @internal
 */
export type ProxyDiagnosticCode =
  'proxy_untrusted' | 'proxy_chain_short' | 'proxy_chain_malformed' | 'client_unknown';

/**
 * One report: its code, the `process.emitWarning` code it is emitted under,
 * and a value-free message naming the fix.
 *
 * @internal
 */
export interface ProxyDiagnostic {
  readonly code: ProxyDiagnosticCode;
  readonly warning: string;
  readonly message: string;
}

const DIAGNOSTICS: Readonly<Record<ProxyDiagnosticCode, ProxyDiagnostic>> = Object.freeze({
  proxy_untrusted: Object.freeze({
    code: 'proxy_untrusted',
    warning: 'JSAILS_PROXY_UNTRUSTED',
    message:
      "jsails: a request from a private or loopback address carried forwarding headers that server.trustedProxies does not trust, so a reverse proxy in front of the app is not trusted: every client behind it shares the proxy's address and one rate-limit bucket. Set server.trustedProxies (or JSAILS_TRUSTED_PROXIES) to the proxies in front of the app",
  }),
  proxy_chain_short: Object.freeze({
    code: 'proxy_chain_short',
    warning: 'JSAILS_PROXY_CHAIN_SHORT',
    message:
      "jsails: a request's X-Forwarded-For chain was shorter than server.trustedProxies.hops, so its client is the proxy's address: the hop count is higher than the number of proxies in front of the app. Lower it to the proxies that append to X-Forwarded-For",
  }),
  proxy_chain_malformed: Object.freeze({
    code: 'proxy_chain_malformed',
    warning: 'JSAILS_PROXY_CHAIN_MALFORMED',
    message:
      "jsails: the X-Forwarded-For entry server.trustedProxies names as the client was not an IP address, so the proxy's address was used. Check what the outermost trusted proxy writes, or the hop count",
  }),
  client_unknown: Object.freeze({
    code: 'client_unknown',
    warning: 'JSAILS_CLIENT_UNKNOWN',
    message:
      'jsails: a production request reached the app with no socket peer, so its client is unknown and shares one rate-limit bucket with every other such request. Serve it through jsails serve or an adapter that exposes the connection',
  }),
});

/**
 * The report for `code`.
 *
 * @internal
 */
export function proxyDiagnostic(code: ProxyDiagnosticCode): ProxyDiagnostic {
  return DIAGNOSTICS[code];
}

/** Where a report goes; defaults to `process.emitWarning` under its warning code. */
type ProxyDiagnosticSink = (diagnostic: ProxyDiagnostic) => void;

/**
 * Options for {@link createProxyDiagnostic}.
 *
 * @internal
 */
export interface ProxyDiagnosticOptions {
  /** The setting the app resolves every request with. */
  readonly trustedProxies: TrustedProxies;
  /** Whether the app runs in production (`NODE_ENV` neither development nor test). */
  readonly production: boolean;
  /** Receives each report; defaults to `process.emitWarning`. */
  readonly report?: ProxyDiagnosticSink;
  /**
   * The codes already reported, shared by every observer that should report a
   * code only once. Defaults to one set for the whole process, so an app
   * assembled again (a reload, a second app in one process) stays quiet.
   */
  readonly reported?: Set<ProxyDiagnosticCode>;
}

/** The codes reported in this process, for observers given no set of their own. */
const PROCESS_REPORTED = new Set<ProxyDiagnosticCode>();

const emitDiagnostic: ProxyDiagnosticSink = (diagnostic) => {
  process.emitWarning(diagnostic.message, { code: diagnostic.warning });
};

/**
 * An observer of resolved requests that reports each proxy-trust condition
 * the first time a request shows it. It reads only the resolution, never the
 * request, and costs a few comparisons per request; once every condition the
 * setting allows has been reported it does nothing at all.
 *
 * @internal
 */
export function createProxyDiagnostic(options: ProxyDiagnosticOptions): RequestOriginObserver {
  const { production } = options;
  const report = options.report ?? emitDiagnostic;
  const reported = options.reported ?? PROCESS_REPORTED;
  // A hop count trusts by position, not by address: a peer it does not trust
  // is a chain anomaly, reported as such, never an untrusted proxy.
  const byAddress = options.trustedProxies === 'none' || !('hops' in options.trustedProxies);

  const once = (code: ProxyDiagnosticCode): void => {
    if (reported.has(code)) return;
    reported.add(code);
    report(DIAGNOSTICS[code]);
  };

  return (resolved, input) => {
    if (input.probe === true) return;
    const { client } = resolved;
    if (client.via === 'unknown') {
      if (production) once('client_unknown');
      return;
    }
    if (!resolved.relayed) return;
    const anomaly = resolved.anomaly;
    if (anomaly === 'short_chain') {
      once('proxy_chain_short');
    } else if (anomaly === 'malformed_forwarded') {
      once('proxy_chain_malformed');
    } else if (
      byAddress &&
      !resolved.trustedPeer &&
      client.via === 'socket' &&
      !reported.has('proxy_untrusted') &&
      isPrivateOrLoopback(client.ip)
    ) {
      once('proxy_untrusted');
    }
  };
}

/**
 * The address ranges a reverse proxy in front of an app connects from:
 * loopback, the RFC 1918 and RFC 6598 (carrier-grade NAT, also used by
 * container overlays) IPv4 ranges, IPv4 link-local, IPv6 loopback, unique
 * local and link-local.
 */
const PRIVATE_RANGES: BlockList = (() => {
  const ranges = new BlockList();
  ranges.addSubnet('127.0.0.0', 8, 'ipv4');
  ranges.addSubnet('10.0.0.0', 8, 'ipv4');
  ranges.addSubnet('172.16.0.0', 12, 'ipv4');
  ranges.addSubnet('192.168.0.0', 16, 'ipv4');
  ranges.addSubnet('100.64.0.0', 10, 'ipv4');
  ranges.addSubnet('169.254.0.0', 16, 'ipv4');
  ranges.addAddress('::1', 'ipv6');
  ranges.addSubnet('fc00::', 7, 'ipv6');
  ranges.addSubnet('fe80::', 10, 'ipv6');
  return ranges;
})();

/**
 * Whether `ip` (a normalized address, as `ClientAddress.ip` holds it) is a
 * loopback or private address; anything that is not an IP address is not.
 *
 * @internal
 */
export function isPrivateOrLoopback(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  return PRIVATE_RANGES.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * A finding of {@link proxyTrustFindings}; each one fails a deploy check.
 *
 * @internal
 */
export interface ProxyTrustFinding {
  readonly code: 'proxy_untrusted' | 'proxy_trust_overridden';
  readonly severity: 'error';
  readonly message: string;
}

/**
 * Compare the proxy topology a deploy states (`JSAILS_TRUSTED_PROXIES`, parsed;
 * `undefined` when the deploy states none) with the setting the app resolved.
 * The resolved setting already is the stated one unless the app config sets
 * `server.trustedProxies` itself, so a difference means the config overrides
 * the deploy:
 *
 * - with `'none'` while the deploy states proxies: `proxy_untrusted`, an
 *   error, because every client would share the proxy's address;
 * - with another setting: `proxy_trust_overridden`, also an error. The config
 *   wins at runtime (the app reports it at boot), but the deploy's statement
 *   is the topology it built, so two settings that disagree mean the app
 *   resolves its clients against proxies that are not the ones in front of
 *   it. A deploy whose config should decide states no topology.
 *
 * Without a statement nothing can be compared, and nothing is found.
 *
 * @internal
 */
export function proxyTrustFindings(
  stated: TrustedProxies | undefined,
  resolved: TrustedProxies,
): readonly ProxyTrustFinding[] {
  if (stated === undefined || sameTrustedProxies(stated, resolved)) return [];
  if (resolved === 'none') {
    return [
      {
        code: 'proxy_untrusted',
        severity: 'error',
        message: `the deploy states proxies in front of the app (${TRUSTED_PROXIES_ENV}) but config.server.trustedProxies is 'none', which wins: every client would share the proxy's address and one rate-limit bucket. Remove server.trustedProxies from the app config, or set it to the proxies in front of the app`,
      },
    ];
  }
  return [
    {
      code: 'proxy_trust_overridden',
      severity: 'error',
      message: `config.server.trustedProxies differs from the proxy topology the deploy states (${TRUSTED_PROXIES_ENV}), and the config value wins: the app would resolve its clients against proxies other than the ones the deploy put in front of it. Remove server.trustedProxies from the app config, or make it state the same topology`,
    },
  ];
}
