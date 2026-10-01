---
title: Security
order: 42
section: Reference
---

# Security

The HTTP pipeline is secure by default: every route states who may reach it
and an app that leaves one unstated does not start, an unsafe request to a
route that accepts the session cookie must come from the app's own origin,
every response carries a small set of security headers, and server-component
state is signed. This page covers the primitives behind those defaults, which
live in `jsails/security` (the surface registry and the access codes),
`jsails/plugin-sdk` (the cross-site check for code that runs outside the
access chain), and `jsails/routing` (signed URLs).

Every error here is value-free: it carries a stable `code` and never echoes a
token, a session id, a key, or request input.

## What the pipeline enforces

Every route runs one compiled boundary in a fixed order: request frame →
guards → route match → declared body length → deadline → rate-limit hook →
claim (session, locale, request scopes) → access chain (the cross-site check,
then the route's access) → global middleware → route middleware → handler →
transforms → body verdict → finalize, and no byte of the request body is read
before a reader asks for it, so a refused request costs none of its body (see
[Routing](/docs/routing#per-route-middleware)). A method no route on the path
answers is a 405 with `Allow`, given only after no route matched.

- **Every route states its access, and there is no default.** A route's
  access is `publicAccess(reason)` (anyone may reach it; the reason is
  recorded in the registration snapshot) or a check, a function of the
  request context that admits the request only by resolving to exactly
  `true` (see [Route access](/docs/routing#route-access)). A filesystem API
  module states it with `defineApi({ access })`, or with an `access` or an
  `authorize` export; a module that states none, or both exports, fails
  `createApp` (`surface.missing_access`, `route.invalid_definition`). There is
  no app-wide `authorize`: the `authorize` key of `jsails.app.js` is refused
  with `config.removed_option`.
- **The surface registry.** Every route, and the app's public files, is
  registered as a surface: its methods and pattern, its access, the action it
  is asked about (`read` when every method is safe, else `write`), the
  credential kinds it accepts, its body limit and its owner. Registration
  refuses a surface without access, one registered twice, and a malformed one
  (`surface.*`), so assembly fails before a request is served. `surfacesOf(app)`
  from `jsails/security` lists an assembled app's surfaces.
- **One access chain.** Every route request passes the same decision before
  any of the route's middleware or handler runs: the cross-site check, then
  the gate for the route's access. A check that returns anything but exactly
  `true` (a truthy non-boolean, `undefined`) denies: `401`
  `request.unauthenticated` for a caller without a session, `403`
  `request.forbidden` for one with a session. A check that throws or rejects
  is not a deny but a fault: the request is answered `503` `access.fault` and
  the error reaches `onError` with phase `authorize`.
- **The cross-site check.** A route whose credentials include `cookie` (every
  filesystem API route, page, registrar route, mount and server-component
  transport route, unless it states otherwise) refuses a `POST`, `PUT`,
  `PATCH` or `DELETE` that was not sent from the app's own origin, for every
  caller, anonymous included: a hostile page could otherwise sign a visitor in
  to its own account or drive a contact form. The request must send an
  `Origin` header equal to the origin it was addressed to
  (`context.origin.origin`: the configured `server.origin`, an allowed
  `server.hosts` entry, or the request URL's origin when no origin is
  configured), compared as exact strings; only when it sends no `Origin` may
  `Sec-Fetch-Site: same-origin` stand in. Anything else, `Origin: null`, a
  `Referer` alone, or no site header at all, is refused with `403`
  `access.cross_site`. There is no token to send: a browser adds `Origin` to a
  same-origin `fetch` and form POST by itself. A client outside a browser that
  sends a cookie sends `Origin` too; one that authenticates with a header
  credential is exempt (below). `X-Forwarded-Host` is never consulted, and
  `X-Forwarded-Proto` only from a trusted proxy, so behind a TLS-terminating
  proxy set `server.origin` to the public `https://` origin.
- **A route sees only the credentials it declares.** The session a route's
  request scopes, access check and handler see is the one `resolveSession`
  found only when it came from a credential kind the route accepts: a cookie
  session is no session on a `credentials: ['token']` route, and a
  header-authenticated one (below) is none on a `['cookie']` route. So
  leaving `cookie` out, which turns the cross-site check off, also stops the
  route from acting on the visitor's cookie.
- **Routes that read no credential.** A route that declares `credentials: []`
  (`defineApi`, `routes.add`, `routes.mount`) never calls `resolveSession`,
  so a cross-site request carries nothing it trusts and the check does not
  apply: a webhook receiver or a signed protocol endpoint. Its access still
  applies.
- **Header-authenticated sessions are exempt.** When `resolveSession` marks a
  session with `data.authMethod` of `'bearer'` or `'api-token'` (as
  `@jsails/auth` does for a credential read from a header), the cross-site
  check does not apply, because a page on another site cannot attach an
  `Authorization` header without a CORS preflight the app never grants. The
  marker must describe the credential verified on this request, never stored
  or client-supplied data; a cookie session or an unmarked one is checked.
- **Denials are never stored and set no cookie.** Every answer the access
  chain denies is sent `Cache-Control: private, no-store`, without
  `Set-Cookie` or `Surrogate-Control`, whatever an error page or a middleware
  around the route put on it.
- **Only public routes are shared.** A route's `cacheControl` declaration
  makes its answer publicly cacheable only when its access is
  `publicAccess(...)` and the caller is anonymous: a route behind a check is
  answered `private, no-store` even when the check admits an anonymous
  caller (see [Caching](/docs/caching)).
- **Host allowlist.** With `server.origin` set, a request whose `Host` is
  neither the origin's host nor an allowed `server.hosts` entry is answered
  `421` before any other stage. The client address comes from forwarding
  headers only through `server.trustedProxies`; see
  [Origin, hosts and proxies](/docs/deployment-proxies).
- **Reserved paths.** The health and readiness paths, `/_jsails/introspect`,
  the server-component endpoints and (for app routes and managed plugins) the
  whole `/_jsails` namespace belong to the framework: a route registered there
  fails assembly with `route.reserved_path`, as does the same method and path
  registered twice (`route.duplicate_route`) and a route under a mount
  (`route.mount_overlap`). A catch-all cannot take them over either: the
  framework routes compile before every other route and answer a method they
  do not serve with a 405, and a code plugin's `/_jsails` routes compile before
  any app or managed-plugin route.
- **Plugins never receive the router.** A plugin adds routes only through
  `routes.add` and `routes.mount`, each with its access and the credentials it
  accepts, so every route it serves is a surface in the registry and the
  access chain runs in front of its handler: a cross-site unsafe request to a
  route that accepts the session cookie is refused with `403`
  `access.cross_site` before the handler runs, and the denial is sealed like
  every other. The `access` gate proves this for every first-party plugin
  and starter preset with the access matrix: it sends each unsafe method a
  foreign `Origin` and no `Origin` at all, as every actor, and fails unless
  the pipeline refuses both with no route code having run and no body byte
  read.

The registry is the list a reviewer reads to see what an app exposes. A
script or a test can print it from an app assembled over the discovered
routes:

```ts
import { createApp } from 'jsails/app';
import { discoverRoutes } from 'jsails/routing';
import { surfacesOf } from 'jsails/security';

const app = await createApp({ manifest: discoverRoutes(process.cwd()) });
for (const surface of surfacesOf(app)?.entries() ?? []) {
  const credentials = surface.credentials.join(',') || 'none';
  console.log(`${surface.id} ${surface.kind} ${surface.access.kind} ${credentials}`);
}
```

Server components verify their signed state on every update and upload, and
their transport routes accept the session cookie, so the access chain gives
each update the same cross-site check (see
[Server Components](/docs/server-components#the-update-endpoint)). The admin
panel's routes are `admin` surfaces that accept the session cookie only, so
the chain runs the same check on every mutation, and its session gate is
their access (see [Admin Panel](/docs/admin)).

Each surface has a kind: `api` for a filesystem API route, `page`, `route`
for a registrar route or mount, `component-action`, `upload` and `download`
for the server-component transport, `ops` for health and readiness, `asset`
for the public files, and `admin` or `webhook` when a registrar route states
it (`routes.add({ surface: 'admin', ... })`, as the admin panel and the
webhook receiver do), so a reviewer, and an invariant such as "no admin
surface accepts a token", can find every surface of a kind.

An app can run the same check on itself: `accessMatrix` (`jsails/testing`)
asks every surface in the registry as every canonical actor through the real
pipeline, with a probe in place of the route's code, and reports each breach
of the hard access rules (see [Testing](/docs/testing#the-access-matrix)).

## Sessions

The app supplies one seam, `resolveSession(request)`, in `jsails.app.js`. It
returns a `Session` (`{ id, data, expiresAt }`) or `null`. It is called
lazily, at most once per request, for every request a route claims, and a
resolver that throws is reported and treated as `null`, so a session-store
outage fails closed instead of granting access. An `identity` source built
with `identitySource({ cookies, headers, resolve })` takes its place when the
app wants anonymous requests to skip the lookup: it declares the cookies and
headers the resolver reads, and a request carrying none of them is never
resolved (see [Configuration](/docs/configuration#sessions-and-authorization)).
The auth starters wire it to `@jsails/auth`, whose session cookies are
`HttpOnly` and `SameSite=Lax`; a production session store such as
`createDatabaseSessionStore` from `@jsails/sessions` stores only a digest of
each session id (see [Authentication](/docs/auth#sessions)).

## Guarding your own routes

A plugin's route goes through the registrar, `routes.add`, so the access
chain decides it: it states its access and the credentials it reads, and the
chain runs the cross-site check whenever those include the session cookie.
There is no per-handler check to write, and no origin to configure:

```ts
import { definePlugin, publicAccess } from 'jsails/kernel';

export const contact = definePlugin({
  name: 'contact',
  setup({ routes }) {
    routes.add({
      methods: ['POST'],
      path: '/contact',
      access: publicAccess('contact form'),
      body: { kind: 'form', maxBytes: 64 * 1024 },
      handler: async (context) => {
        const form = await context.body.form();
        const message = form.get('message');
        if (typeof message !== 'string' || message === '') {
          return new Response(null, { status: 422 });
        }
        return new Response(null, { status: 303, headers: { location: '/thanks' } });
      },
    });
  },
});
```

A route a non-browser client or another site must reach (a webhook, an OAuth
callback a provider posts, a device-flow poll) declares `credentials: []`: it
reads no session, so the cross-site check has nothing to protect there.
`isHeaderAuthenticatedSession(session)` from `jsails/plugin-sdk` is the
check's exemption, to apply only for a credential you verified from a header
on this request, and `safeEqualStrings(a, b)` is the constant-time string
comparison the framework uses for every secret:

```ts
import type { Session } from 'jsails';
import { isHeaderAuthenticatedSession, safeEqualStrings } from 'jsails/plugin-sdk';

export function viaHeaderCredential(session: Session | null): boolean {
  return session !== null && isHeaderAuthenticatedSession(session);
}

export function signatureMatches(expected: string, supplied: string): boolean {
  return safeEqualStrings(expected, supplied);
}
```

## Security headers

Every framework response gets three headers unless the response already set
them:

| Header                   | Value                             |
| ------------------------ | --------------------------------- |
| `X-Content-Type-Options` | `nosniff`                         |
| `X-Frame-Options`        | `SAMEORIGIN`                      |
| `Referrer-Policy`        | `strict-origin-when-cross-origin` |

The Netlify, Vercel, and Cloudflare Pages configs in
[Deployment](/docs/deploy#static-hosts) carry the same set for a static
export. GitHub Pages cannot set response headers, so a site there goes without them; a
`Content-Security-Policy` can still be carried in a `<meta http-equiv>` tag. Two headers are deliberately not defaults:

- **`Content-Security-Policy`** depends on each app's scripts and styles; a
  generic policy would break inline ones. Set your own.
- **`Strict-Transport-Security`** belongs at the TLS-terminating proxy, which
  knows whether HTTPS is really in front of the app.

A route (a filesystem route, or one a plugin registers through `routes.add`
or `routes.mount`) that sets one of these headers keeps its value; the
framework never overwrites an explicit header.

## Signed URLs

`HmacUrlSigner` (`jsails/routing`, also on the root `jsails` entry) makes links
that work without a session and cannot be altered: an email confirmation, a
time-limited download, an unsubscribe link.

```ts
import { HmacUrlSigner } from 'jsails/routing';

const signer = new HmacUrlSigner({ key: process.env.URL_SIGNING_KEY! });

// Sign a path and its params; the link expires in 15 minutes by default.
const link = signer.sign('/api/downloads/42', { user: '7' }, 60 * 60 * 1000);
// "/api/downloads/42?user=7&signature=...&expires=..."
```

```ts
// api/downloads/[id].ts
import { Respond } from 'jsails/api';
import type { RequestContext } from 'jsails';

export async function GET(_request: Request, context: RequestContext) {
  const verified = signer.verify(context.url.pathname + context.url.search);
  if (verified === null) return Respond.json({ error: 'invalid_link' }, { status: 403 });
  const userId = verified.params.user; // read params only from the verified value
  // ...
}
```

- The key must be at least 32 characters; a shorter one throws a
  `SignedUrlError` (`invalid_key`). Keep it in the environment or encrypted
  credentials, and rotate it to revoke every outstanding link.
- `sign(path, params?, expiresInMs?)` takes a path without `?` or `#` and
  string, number, or boolean params. `signature` and `expires` are reserved
  names. `expiresInMs` defaults to 15 minutes; `0` signs a link that never
  expires. Bad input throws `SignedUrlError` (`invalid_path`, `invalid_param`,
  `invalid_expiry`) rather than producing a link that could never verify.
- `verify(url)` returns a frozen `{ path, params }` when the signature is valid
  and unexpired, and `null` otherwise. It never throws. Pass it the path and
  query exactly as requested (`context.url.pathname + context.url.search`),
  not an absolute URL: the signature covers the path, not the host.
- A URL that repeats a query key is refused. Read parameters from
  `verified.params`, never by parsing the request URL again: those are the only
  values the signature covers, and extra query keys added to a link change the
  signature and fail verification.
- The signature covers the path, the params, and the expiry under a
  domain-separated HMAC-SHA256. It provides integrity, not secrecy: anyone who
  holds the link can read its params.

## Next steps

- [Forms and Uploads](/docs/forms) — reading and validating request bodies.
- [Authentication](/docs/auth) — sign-in, sessions, and API tokens.
- [Encryption](/docs/encryption) — encrypted attributes and credentials.
