/**
 * Which proxies the deployed app must trust, from the topology jamal builds
 * in front of it.
 *
 * The app resolves its client from `X-Forwarded-For` only as far as
 * `server.trustedProxies` allows (core `security/request-origin.ts`). Left at
 * `'none'` behind a proxy, every client arrives from the proxy's address and
 * shares its rate-limit bucket; trusting one hop too few does the same, and
 * trusting an entry a client could write (one hop too many, or a count in
 * front of a proxy the client can reach directly) lets it name any address.
 * Jamal knows the topology, so the setting is derived here, never written by
 * hand:
 *
 * - kamal-proxy is one hop. Without `--forward-headers` it replaces the chain
 *   a request arrives with by the address it received it from, so whatever
 *   the client (or anything in front) wrote is gone, and a hop count is exact.
 * - The cache proxy (Varnish), when enabled, sits between kamal-proxy and the
 *   app and appends kamal-proxy's address: one more hop.
 * - With `proxy.forwardHeaders`, kamal-proxy keeps the incoming chain and
 *   appends to it. A count of the proxies in front of it would not be safe:
 *   kamal-proxy stays reachable on the server's public address, so a client
 *   that connects to it directly, around the CDN, could write the entry the
 *   count points at. The proxies in front are therefore trusted by address,
 *   the ranges in `proxy.upstreamCidrs`, and the ones jamal runs by position:
 *   `{ hops, cidrs }`, under which a client outside the ranges is its own
 *   client whatever chain it sends.
 *
 * {@link requiredProxyTrust} is that rule, pure; a topology jamal cannot
 * describe safely is refused rather than guessed. `planRelease` applies it
 * to every deploy, rollback, and dry run, so a refused topology fails before
 * anything touches the server, and the web container receives the setting as
 * `JSAILS_TRUSTED_PROXIES` ({@link trustedProxiesVariable}), the variable the
 * app reads when its config states no `server.trustedProxies`; the release's
 * `jsails check --deploy` step refuses a config that states another.
 */

import { formatTrustedProxies, TRUSTED_PROXIES_ENV } from 'jsails/internal';
import type { TrustedProxies } from 'jsails/security';

import type { JamalConfig } from '../config/index.js';
import { JamalConfigError } from '../error.js';

/** The proxies between the internet and the app container. */
export interface ProxyTopology {
  /** The cache proxy sits between kamal-proxy and the app. */
  readonly cacheProxy: boolean;
  /** kamal-proxy keeps and extends the incoming chain (`--forward-headers`). */
  readonly forwardHeaders: boolean;
  /** The address ranges the proxies in front of kamal-proxy connect from. */
  readonly upstreamCidrs: readonly string[] | undefined;
}

/**
 * Why a topology was refused:
 *
 * - `upstream_cidrs_required`: `forwardHeaders` without `upstreamCidrs`. The
 *   chain kamal-proxy keeps holds entries from proxies jamal does not know,
 *   and any client can reach kamal-proxy directly and write that chain.
 * - `forward_headers_required`: `upstreamCidrs` without `forwardHeaders`.
 *   kamal-proxy would replace the chain with the address of the upstream
 *   proxy, so every client would share that proxy's bucket.
 */
export type ProxyTrustRefusal = 'upstream_cidrs_required' | 'forward_headers_required';

/** The trust a topology requires: a `server.trustedProxies` setting, or a refusal. */
export type ProxyTrust =
  | { readonly kind: 'trusted'; readonly trust: TrustedProxies }
  | { readonly kind: 'refused'; readonly reason: ProxyTrustRefusal };

/**
 * The setting the app must trust behind `topology`: one hop for kamal-proxy
 * and one more for the cache proxy, plus, when kamal-proxy forwards the
 * incoming chain, the upstream ranges in front of them. Pure.
 */
export function requiredProxyTrust(topology: ProxyTopology): ProxyTrust {
  const { forwardHeaders, upstreamCidrs } = topology;
  if (forwardHeaders && upstreamCidrs === undefined) {
    return { kind: 'refused', reason: 'upstream_cidrs_required' };
  }
  if (!forwardHeaders && upstreamCidrs !== undefined) {
    return { kind: 'refused', reason: 'forward_headers_required' };
  }
  const hops = topology.cacheProxy ? 2 : 1;
  return {
    kind: 'trusted',
    trust: upstreamCidrs === undefined ? { hops } : { hops, cidrs: [...upstreamCidrs] },
  };
}

/** The topology a jamal config deploys. */
export function proxyTopologyOf(config: JamalConfig): ProxyTopology {
  return {
    cacheProxy: config.cacheProxy?.enabled === true,
    forwardHeaders: config.proxy.forwardHeaders,
    upstreamCidrs: config.proxy.upstreamCidrs,
  };
}

const REFUSALS: Readonly<Record<ProxyTrustRefusal, { message: string; suggestion: string }>> =
  Object.freeze({
    upstream_cidrs_required: {
      message:
        'config.proxy.forwardHeaders requires config.proxy.upstreamCidrs: kamal-proxy is reachable without passing the proxies in front of it, so the app can only trust the X-Forwarded-For entries those proxies wrote by the addresses they connect from',
      suggestion:
        'set config.proxy.upstreamCidrs to the address ranges the CDN or load balancer in front of kamal-proxy publishes',
    },
    forward_headers_required: {
      message:
        'config.proxy.upstreamCidrs requires config.proxy.forwardHeaders: kamal-proxy otherwise replaces the chain with the upstream proxy address, and every client would share it',
      suggestion: 'set config.proxy.forwardHeaders: true, or remove config.proxy.upstreamCidrs',
    },
  });

/**
 * The `-e` value that tells the web container which proxies are in front of
 * it, `JSAILS_TRUSTED_PROXIES=<setting>`, for `config`'s topology. Throws a
 * value-free {@link JamalConfigError} for a refused topology.
 */
export function trustedProxiesVariable(config: JamalConfig): string {
  const required = requiredProxyTrust(proxyTopologyOf(config));
  if (required.kind === 'refused') {
    const refusal = REFUSALS[required.reason];
    throw new JamalConfigError(refusal.message, { suggestion: refusal.suggestion });
  }
  // The config loader refused a range the app would refuse
  // (`config/safety.ts`), so formatting cannot fail here.
  return `${TRUSTED_PROXIES_ENV}=${formatTrustedProxies(required.trust)}`;
}
