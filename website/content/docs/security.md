---
title: Security
order: 42
section: Reference
---

# Security

The HTTP pipeline is secure by default: API routes are default-deny, a
cookie-authenticated mutation needs a same-origin `Origin` and a CSRF token,
every response carries a small set of security headers, and server-component
state is signed. This page covers the primitives behind those defaults, which
live in `jsails/security` (sessions and CSRF), `jsails/plugin-sdk` (the
trusted-mutation guard for code outside the filesystem routes), and
`jsails/routing` (signed URLs).

Every error here is value-free: it carries a stable `code` and never echoes a
token, a session id, a key, or request input.

## What the pipeline enforces

For a filesystem API route the order is fixed: body-limit/405 → session →
origin/CSRF → global `authorize` → module `authorize` → global middleware →
route middleware → handler (see [Routing](/docs/routing#per-route-middleware)).

- **Default-deny authorization.** With no `authorize` in `jsails.app.js`, every
  API request gets `403`. A request passes only when `authorize` resolves to
  exactly `true`; a truthy non-boolean, a throw, or a rejection denies. A module
  `authorize` can only narrow the global one.
- **CSRF on cookie sessions.** A `POST`, `PUT`, `PATCH`, or `DELETE` that
  resolved a session (other than a header-authenticated one, below) must send an `Origin` header equal to the app's origin
  (the origin the request was addressed to, `context.origin.origin`: the
  configured `server.origin`, an allowed `server.hosts` entry, or the request
  URL's origin when no origin is configured) and an `X-CSRF-Token` header
  equal to the session's `csrfToken`. A failure is a `403` JSON envelope with
  code `origin_mismatch` or `csrf_mismatch`. `X-Forwarded-Host` is never
  consulted, and `X-Forwarded-Proto` only from a trusted proxy, so behind a
  TLS-terminating proxy set `server.origin` to the public `https://` origin.
- **Host allowlist.** With `server.origin` set, a request whose `Host` is
  neither the origin's host nor an allowed `server.hosts` entry is answered
  `421` before any other stage. The client address comes from forwarding
  headers only through `server.trustedProxies`; see
  [Origin, hosts and proxies](/docs/deployment-proxies).
- **Anonymous requests are origin-checked.** A mutation without a session has
  no CSRF token to check, but a cross-site one is still refused
  (`origin_mismatch`), so a hostile page cannot drive an anonymous endpoint
  (sign-in, a contact form) from a visitor's browser. The request's site is
  decided by the first of these it carries: an `Origin` header (equal to the
  app's origin), `Sec-Fetch-Site` (only `same-origin` passes), or a `Referer`
  whose origin matches. A request with none of them (a non-browser client)
  passes only when it also sends no `Cookie` header; with a cookie it is
  refused, since a stale or unresolved cookie session must not fall back to the
  anonymous path. A same-origin anonymous request then meets your `authorize`
  callback as before.
- **Header-authenticated sessions skip CSRF.** When `resolveSession` marks a
  session with `data.authMethod` of `'bearer'` or `'api-token'` (as
  `@jsails/auth` does for a credential read from a header), the filesystem API
  pipeline skips both checks, because a browser never sends a header credential
  cross-site. The marker must describe the credential verified on this request,
  never stored or client-supplied data; a cookie session or an unmarked one
  keeps both checks. `checkTrustedMutation` (below) does not apply this
  exemption: it checks every non-null session.
- **HTTP extension hooks own their security.** A route registered through
  `configureHttp` runs before the filesystem routes and gets none of the checks
  above; use `checkTrustedMutation` (below) in it.

Server components run their own origin and CSRF checks on every update and
upload (see [Server Components](/docs/server-components#the-update-endpoint)),
and the admin panel checks a `_csrf` form field (see
[Admin Panel](/docs/admin)).

## Sessions

The app supplies one seam, `resolveSession(request)`, in `jsails.app.js`. It
returns a `Session` (`{ id, csrfToken, data, expiresAt }`) or `null`. It is
called lazily, at most once per request, and a resolver that throws is reported
and treated as `null`, so a session-store outage fails closed instead of
granting access. The auth starters wire it to `@jsails/auth`; see
[Authentication](/docs/auth).

To manage sessions yourself, `SessionManager` layers the session lifecycle over
any `SessionStore` (`get`, `set`, `delete`):

```ts
import { InMemorySessionStore, SessionManager } from 'jsails/security';

const sessions = new SessionManager(new InMemorySessionStore(), {
  ttlMs: 7 * 24 * 60 * 60 * 1000, // default: 7 days
  cookieName: 'session', // default
  cookieSecure: true, // default; false only for local HTTP development
});

// Sign in: rotate the id and the CSRF token so a pre-login id is useless.
const session = await sessions.regenerate(previousId, { userId: user.id });
const setCookie = sessions.serializeCookie(session.id);

// Pass as `resolveSession` in jsails.app.js. A malformed or expired id resolves to null.
const resolveSession = async (request: Request) => {
  const id = sessions.parseCookie(request.headers.get('cookie'));
  return id === null ? null : sessions.get(id);
};
```

- Session ids and CSRF tokens are 32 random bytes, base64url-encoded.
- `create(data)` snapshots `data`, so later changes to your object never leak
  into the stored session. `regenerate(id, data?)` deletes the old id and
  issues a new id and CSRF token; call it on every sign-in to prevent session
  fixation. `logout(id)` deletes the session.
- `get(id)` returns `null` for an id that does not have the exact session-id
  shape, without touching the store, and deletes an expired session.
- Cookies are always `HttpOnly`, `SameSite=Lax`, and `Path=/`, and `Secure`
  unless you turn it off explicitly. `serializeSessionCookie(id, options)` and
  `parseSessionCookie(header, name)` are the same helpers without a manager. A
  cookie name outside the RFC 6265 token characters is rejected, so a name can
  never inject into the header.
- `InMemorySessionStore` is for development and tests only: it is lost on
  restart, is not shared between processes, and evicts past `capacity`
  (default 1000). Production uses a durable store such as
  `createDatabaseSessionStore` from `@jsails/sessions`, which stores only a
  digest of each session id (see
  [Authentication](/docs/auth#sessions)).

## CSRF tokens

The token to send is `context.session.csrfToken`. A page renders it where its
scripts can read it, and every mutating `fetch` sends it back:

```tsx
// pages/settings.tsx
import type { RequestContext } from 'jsails';

export async function load(context: RequestContext) {
  return { csrfToken: context.session?.csrfToken ?? '' };
}

export default function Settings({ csrfToken }: { csrfToken: string }) {
  return <main id="settings" data-csrf-token={csrfToken}>{/* ... */}</main>;
}
```

```js
// a client island
const token = document.getElementById('settings').dataset.csrfToken;
await fetch('/api/settings', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
  body: JSON.stringify({ theme: 'dark' }),
});
```

The token is per session, so never render it into a page that exports
`cache: 'public'`: a cached render would hand one visitor's token to the next.
The browser adds the `Origin` header to a same-origin `fetch` by itself. A
plain HTML `<form method="post">` cannot set a header, so with a session it is
refused by an API route; submit it from script as above, or use a server
component form, which carries its CSRF token for you (see
[Forms and Uploads](/docs/forms)).

The constant `CSRF_HEADER` (`'X-CSRF-Token'`) names the header.
`assertCsrfToken(session, supplied)` throws an `AuthError` (`csrf_mismatch`,
status 403) unless `supplied` is a string equal to the session token; the
comparison is constant-time, including the length.

## Guarding your own routes

Code that handles requests outside the filesystem routes (an HTTP extension
hook, a plugin route) applies the same rule with `checkTrustedMutation` from
`jsails/plugin-sdk`:

```ts
import type { RequestContext } from 'jsails';
import { checkTrustedMutation } from 'jsails/plugin-sdk';

export function refuseUntrusted(context: RequestContext): Response | undefined {
  const verdict = checkTrustedMutation(context.request, context.session, {
    expectedOrigin: context.origin?.origin,
    csrfValue: context.request.headers.get('X-CSRF-Token'),
  });
  if (verdict.allowed) return undefined;
  return Response.json({ error: verdict.code }, { status: verdict.status });
}
```

It checks the origin first, then the token, and returns a result instead of
throwing. A `null` session gets the anonymous origin check, as in the pipeline,
but a header-authenticated session does not get the pipeline's exemption: skip the call yourself only for a
credential you verified from a header on this request. The parts are exported
too: `requestSite(request, expectedOrigin?)` classifies a request as
`same-origin`, `cross-site`, or `unknown` from `Origin`, `Sec-Fetch-Site`, and
`Referer`; `checkRequestOrigin(request, session, expectedOrigin?)` is the
origin half of the check; `isUnsafeMethod(method)` is true for every method but
`GET`, `HEAD`, and `OPTIONS`; `isSameOriginRequest(request, expectedOrigin?)`
compares the `Origin` header verbatim, `csrfTokenValid(session, supplied)` is the boolean form of
`assertCsrfToken`, and `safeEqualStrings(a, b)` is the constant-time string
comparison the framework uses for every secret.

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

A route or an HTTP extension hook that sets one of these headers keeps its
value; the framework never overwrites an explicit header.

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
