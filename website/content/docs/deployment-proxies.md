---
title: Origin, hosts and proxies
order: 20
section: Operating
---

# Origin, hosts and proxies

Every request an app answers is first placed by one pipeline stage, before the
request id or any route: which origin it was addressed to,
and which client sent it. Three keys under `server` in `jsails.app.js` decide
both, and nothing else in the framework or its plugins reads `Host`,
`X-Forwarded-For`, `X-Forwarded-Proto`, `Forwarded`, or `X-Real-IP` itself.

```js
export default {
  server: {
    origin: 'https://example.com',
    hosts: ['*.example.com'],
    trustedProxies: { hops: 1 },
  },
};
```

## `server.origin`

The app's public origin: a scheme, a host, and a port only when it is not the
scheme's default (`https://example.com`, `http://localhost:3000`). A path,
query, fragment, credentials, or a scheme other than `http`/`https` is refused
when the config loads.

- A request whose `Host` is the origin's host is addressed to exactly this
  origin, including its scheme. Behind a TLS-terminating proxy the request URL
  is plain `http://`; the configured origin is still `https://`, so the
  same-origin checks accept the browser's `https://` `Origin` header.
- Every other `Host` (unless `server.hosts` allows it) is answered
  `421 Misdirected Request` before any other stage runs: no request id, no
  session lookup, no route, no `authorize`. A DNS-rebinding page, or a request
  sent straight to the server's IP, gets nothing but the 421.
- The one exception is a `GET` or `HEAD` for the health path (`healthPath`,
  `/up` by default) or `readiness.path`. A deploy tool and a reverse proxy
  probe the container by its own address (`jamal deploy` fetches
  `http://127.0.0.1:3000/up` inside it; kamal-proxy probes the container's
  network address), so a probe is answered whatever `Host` it names, as if it
  were addressed to the canonical origin. A probe's answer is a status, the
  same for every host.
- `jsails serve` outside the `development` and `test` environments refuses to
  start without it:
  `config.server.origin is required to serve outside the development and test environments`.

Without an origin (development and tests), every `Host` is accepted and is its
own origin, taken from the request URL.

The cross-site `Origin` check (core's access chain, which covers every route
accepting the session cookie, server-component updates and the admin panel,
auth and blog routes included) compares with the origin the request was
addressed to, the request frame's `origin.origin`.
The page cache stores a page only for the canonical origin.

## `server.hosts`

Further hosts the app answers on, each its own origin. An entry is a lowercase
host name with an optional port (`admin.example.com`, `example.net:8443`), or a
wildcard that stands for **exactly one** label under a name of two or more
labels, or under `localhost`: `*.example.com` allows `acme.example.com`, never
`example.com` and never `a.b.example.com`. A wildcard over an IP address or
another single-label name (`*.com`) is refused, and so is `hosts` without
`origin`.

An entry without a port is served on the origin's port: beside
`origin: 'http://localhost:3000'`, `*.localhost` allows
`acme.localhost:3000`; beside `https://example.com`, `*.example.com` allows
`acme.example.com` (port 443).

A request on an allowed host is addressed to `<scheme>://<host>`, where the
scheme is the configured origin's, or the one a trusted proxy reports in
`X-Forwarded-Proto`. Its origin is not canonical: a cookie POST from
`acme.example.com` to itself passes the same-origin check, and one from
`globex.example.com` to `acme.example.com` is cross-site and refused.

This is the multi-tenant shape: the saas starter sets
`hosts: ['*.<TENANT_ROOT_DOMAIN>']` whenever `PUBLIC_ORIGIN` and
`TENANT_ROOT_DOMAIN` are both set.

## `server.trustedProxies`

Which forwarding headers may name the client. The default is `'none'`.

| Value | Client address | Scheme |
| --- | --- | --- |
| `'none'` | the socket peer | the request URL's |
| `{ hops: n }` (1 to 16) | the `X-Forwarded-For` entry `n` places from the right | `X-Forwarded-Proto`, the matching entry |
| `{ cidrs: ['10.0.0.0/8', …] }` | only when the peer is in a range: the right-most entry not in a range | `X-Forwarded-Proto`, the matching entry |
| `{ hops: n, cidrs: [...] }` | from the entry `n` places from the right, the right-most entry not in a range | `X-Forwarded-Proto`, the matching entry |

Each proxy appends the address it saw to `X-Forwarded-For`, so the entry `n`
places from the right is the one the outermost of `n` trusted proxies wrote;
everything left of it is whatever the client sent and is never read. Set the
count exactly: one too few keys every client on a proxy's address, one too
many lets a client choose its own. A chain shorter than `n`, or a malformed
entry where the client should be, falls back to the socket peer.

A hop count trusts by position, so it is only sound when every request passes
through all `n` proxies. When the proxy nearest the app keeps the chain it
receives and stays reachable on a public address (a CDN in front of your own
reverse proxy), a client that connects to that proxy directly can write the
entry the count points at. `{ hops: n, cidrs }` closes that: the `n` proxies
you run are trusted by position, and in front of them only an entry inside the
ranges (the CDN's published address ranges) is another proxy. A client that
skips the CDN is not inside them, so it is its own client whatever chain it
sends.

With `'none'` the client is the socket peer and the result never depends on a
header the client wrote. That is what the rate limiters rely on: with
`'none'`, no forwarded header changes the limiter key.

The environment variable `JSAILS_TRUSTED_PROXIES` is the fallback for a config
without the key: `none`, `hops=<n>`, a comma-separated list of CIDR ranges, or
`hops=<n>` followed by such a list (`hops=1,173.245.48.0/20,2400:cb00::/32`).
A malformed value stops the config from loading. When both are set and
disagree, the config wins and a `JSAILS_TRUSTED_PROXIES_IGNORED` warning says
so. `jamal deploy` sets the variable from the proxies it deploys (see
[Deploying with jamal](#deploying-with-jamal)), which is why the starters
leave `server.trustedProxies` out of their app config: a value there would win
over the deploy's setting and go stale the day the topology changes (and the
deploy check refuses it, see [`jsails check --deploy`](#jsails-check---deploy)).

## Deploying with jamal

`jamal deploy` knows which proxies it puts in front of the web container, so it
derives the setting and passes it as `JSAILS_TRUSTED_PROXIES`, to the new
release, its deploy check, and a rollback alike. The `proxy` key of
`jamal.config.ts` describes the proxies in front of kamal-proxy that jamal does
not run:

```ts
// jamal.config.ts
import { defineJamal } from '@jsails/jamal';

export default defineJamal({
  service: 'my-app',
  image: 'registry.example.com/my-app',
  // Behind a CDN: the address ranges it publishes for its edge servers.
  proxy: { forwardHeaders: true, upstreamCidrs: ['173.245.48.0/20', '2400:cb00::/32'] },
});
```

| Topology | `proxy` | `JSAILS_TRUSTED_PROXIES` |
| --- | --- | --- |
| kamal-proxy alone (the default) | absent | `hops=1` |
| kamal-proxy and the cache proxy | absent | `hops=2` |
| a CDN or load balancer, then kamal-proxy | `{ forwardHeaders: true, upstreamCidrs: [...] }` | `hops=1,<ranges>` |
| the same, with the cache proxy | `{ forwardHeaders: true, upstreamCidrs: [...] }` | `hops=2,<ranges>` |

Without `forwardHeaders`, kamal-proxy replaces the `X-Forwarded-For` it
receives with the address it saw, so whatever was in front of it is invisible
and a hop count is exact. With `forwardHeaders: true` it appends instead, and
it stays reachable on the server's public address, so a count of the proxies in
front of it would let a client that skips the CDN name its own address. The
upstream proxies are therefore trusted by the ranges they connect from, and
kamal-proxy and the cache proxy by position. List every range the CDN or load
balancer publishes, IPv4 and IPv6: a request from an edge outside the list is
keyed on that edge's address. The deploy refuses, before it builds or touches
the server:

- `forwardHeaders` without `upstreamCidrs`: jamal cannot tell an upstream
  proxy from a client;
- `upstreamCidrs` without `forwardHeaders`: kamal-proxy would discard the chain
  those proxies wrote, so every client would share the nearest one's address.

A range the app cannot read is refused when `jamal.config.ts` loads.
`config.env` must not name `JSAILS_TRUSTED_PROXIES` (as a key or an alias): a
hand-written setting is the one that drifts. Every `kamal-proxy deploy` of the
app's service, the release switch and `jamal domain add` alike, passes the same
route (the target, the cache proxy when it is enabled, `--forward-headers`), so
the proxies in front of the app stay the ones the setting describes.

## Diagnostics

The app watches every request its origin policy resolves for the shapes of a
misconfigured proxy setup and emits a Node process warning, once per process
for each, naming no address:

| Warning | When |
| --- | --- |
| `JSAILS_PROXY_UNTRUSTED` | A request from a private or loopback address carried forwarding headers that `server.trustedProxies` does not trust: a reverse proxy in front of the app is not trusted, and every client shares its address and one rate-limit bucket. |
| `JSAILS_PROXY_CHAIN_SHORT` | A relayed request's `X-Forwarded-For` held fewer entries than `{ hops: n }` trusts: the count is higher than the proxies in front of the app. |
| `JSAILS_PROXY_CHAIN_MALFORMED` | The entry where the client should be was not an address. |
| `JSAILS_CLIENT_UNKNOWN` | In production, a request reached the app with no socket (an in-process request), so it has no client address and keys on the shared `unknown` bucket. |

A health or readiness probe never triggers a warning, whatever chain it
carries: a deploy tool or a proxy probes the container from inside the host,
and a proxy between them can give the probe a chain that says nothing about the
proxies in front of real clients. (Behind jamal's cache proxy it carries none:
Varnish appends the address it received a request from, and its VCL drops the
header again when that lone entry is all there is.) A public client that forges
`X-Forwarded-For` does not trigger one either, since a proxy connects from a
private or loopback address.

## `jsails check --deploy`

`jsails check --deploy` loads the app config the way the deployed app does
(the `production` environment unless `--env` or `JSAILS_ENV` names another)
and reports, without starting anything:

- `origin_missing` (error): `server.origin` is not set, so `jsails serve`
  would refuse to start;
- `proxy_untrusted` (error): `JSAILS_TRUSTED_PROXIES` states the proxies in
  front of the app, but the config resolves `'none'`;
- `proxy_trust_overridden` (error): the config states another trust than
  `JSAILS_TRUSTED_PROXIES`; the config would win, so the app would resolve its
  clients against proxies other than the ones in front of it;
- `proxy_trust_unstated` (info): `JSAILS_TRUSTED_PROXIES` is not set where the
  check ran, so there was nothing to compare the trust with.

It exits 1 on an error; `--json` prints one document
(`{ config, environment, deploy, findings }`).

The rules read the variables the deployed app receives (`server.origin` often
comes from one, and the proxy topology is `JSAILS_TRUSTED_PROXIES`), so the
check means something where they are set. `jamal deploy` runs it on every
deploy and rollback, inside the new image with the release's environment and no
network, after the image is pulled and before anything starts; an error stops
the deploy with the previous release still serving, and the findings appear in
the deploy's output. Another deploy pipeline runs it the same way. Run on a
workstation without those variables, it reports `origin_missing` for a config
that reads the origin from one, and `proxy_trust_unstated`.

## What a request carries

After the first stage, code the request runs reads the request frame through
`currentRequestFrame()` from `jsails`:

- `frame.id`: the request id, also sent as `X-Request-Id`.
- `frame.origin`: `{ origin, host, canonical }`, the origin the request was
  addressed to, its host, and whether that is the configured origin.
- `frame.client`: `{ via: 'socket' | 'forwarded', ip, bucket }`, or
  `{ via: 'unknown', bucket: 'unknown' }` for an in-process request with no
  socket. `bucket` is the IPv4 address, or the IPv6 `/64` network
  (`2001:db8:1:2::/64`): one host is usually handed a whole `/64`, so a
  per-client limit keys on `bucket`.
- `frame.relayed`: whether the request arrived with any forwarding header.
- `frame.trustedPeer`: whether the immediate peer is a trusted proxy, so the
  headers it sent are its own statements. With `{ cidrs }` this is the peer
  being inside the ranges, even when it sent no `X-Forwarded-For` (the client
  is then the peer itself, `via: 'socket'`); with `{ hops: n }` and
  `{ hops: n, cidrs }` it is the chain holding at least `n` entries.

API and page handlers see the same values as `context.origin` and
`context.client`.

The stage also rewrites the headers downstream code sees: `Forwarded`,
`X-Real-IP`, and `X-Forwarded-Host` are removed, `X-Forwarded-For` becomes
exactly the resolved client's address (or is removed when the client is
unknown), and an `X-Forwarded-Proto` the request carried is set to the
resolved origin's scheme. A library that reads these headers itself, such as
Better Auth's limiter and the address it records on a session, therefore sees
only what the app resolved.

## Behind a proxy, step by step

1. Set `server.origin` to the public `https://` origin.
2. With `jamal deploy`, describe any proxy in front of kamal-proxy in
   `proxy` and leave the setting to jamal. Otherwise count the proxies that
   append to `X-Forwarded-For` between the internet and the app and set
   `trustedProxies: { hops: n }` (or `JSAILS_TRUSTED_PROXIES`) when every
   request must pass through all of them; list their addresses with
   `{ cidrs: [...] }`, or combine the two as `{ hops, cidrs }`, when a client
   could reach one of them directly.
3. List each extra public host (an admin subdomain, the tenant wildcard) under
   `server.hosts`.
4. Check a page and a login through the public URL (the health route answers
   any host, so it proves nothing here). A `421` means the proxy forwards a
   `Host` the app does not answer on; forward the public host, or list it. A
   `JSAILS_PROXY_*` warning in the app's log means the trust does not match
   the proxies.
