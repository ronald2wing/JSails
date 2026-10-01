---
title: Origin, hosts and proxies
order: 20
section: Operating
---

# Origin, hosts and proxies

Every request an app answers is first placed by one pipeline stage, before the
request id, the body limit, or any route: which origin it was addressed to,
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

The cookie-authenticated `Origin` check (core's CSRF middleware, signed
server-component updates, the admin panel, and the auth and blog hook routes)
compares with the origin the request was addressed to, `c.var.origin.origin`.
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

Each proxy appends the address it saw to `X-Forwarded-For`, so the entry `n`
places from the right is the one the outermost of `n` trusted proxies wrote;
everything left of it is whatever the client sent and is never read. Set the
count exactly: one too few keys every client on a proxy's address, one too
many lets a client choose its own. A chain shorter than `n`, or a malformed
entry where the client should be, falls back to the socket peer.

With `'none'` the client is the socket peer and the result never depends on a
header the client wrote. That is what the rate limiters rely on: with
`'none'`, no forwarded header changes the limiter key.

The environment variable `JSAILS_TRUSTED_PROXIES` is the fallback for a config
without the key: `none`, `hops=<n>`, or a comma-separated list of CIDR ranges.
A malformed value stops the config from loading. When both are set and
disagree, the config wins and a `JSAILS_TRUSTED_PROXIES_IGNORED` warning says
so. The server-rendered starters' `jamal.config.ts` sets `hops=1` for
kamal-proxy on the `jamal deploy` path.

## What a request carries

After the first stage, a hook route or middleware reads:

- `c.var.origin`: `{ origin, host, canonical }`, the origin the request was
  addressed to, its host, and whether that is the configured origin.
- `c.var.client`: `{ via: 'socket' | 'forwarded', ip, bucket }`, or
  `{ via: 'unknown', bucket: 'unknown' }` for an in-process request with no
  socket. `bucket` is the IPv4 address, or the IPv6 `/64` network
  (`2001:db8:1:2::/64`): one host is usually handed a whole `/64`, so a
  per-client limit keys on `bucket`.
- `c.var.relayed`: whether the request arrived with any forwarding header.

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
2. Count the proxies that append to `X-Forwarded-For` between the internet and
   the app (kamal-proxy alone is one) and set `trustedProxies: { hops: n }`, or
   list their addresses with `{ cidrs: [...] }` when they are known.
3. List each extra public host (an admin subdomain, the tenant wildcard) under
   `server.hosts`.
4. Check a page and a login through the public URL (the health route answers
   any host, so it proves nothing here). A `421` means the proxy forwards a
   `Host` the app does not answer on; forward the public host, or list it.
