---
title: Routing
order: 8
section: Building
---

# Pages & Routing

JSails discovers routes from the filesystem. `discoverRoutes(rootDir, { pagesDir?,
apiDir? })` walks `pages/` and `api/` lexically — no module import, no connection.
Only compiled `.js`/`.mjs` modules are discovered; symlinks are never followed;
`api/` routes mount under `/api`. Parameters are single-segment `[id]`; a
catch-all `[...slug]` matches one or more trailing segments, and an optional
catch-all `[[...slug]]` also answers its base path. Two files answering the same
URL fail discovery with `duplicate_route`, so an `index` (or a file named like
the directory) beside an optional catch-all is refused rather than left to
registration order. A server module (`post.server.ts`, compiled
`post.server.js`) is server code a route imports and is never a route itself.

## Page modules

A page is a compiled module with a function default export (a page that only
streams may export just a [`stream` producer](#progressive-streaming)), an optional
`load(context)` for async props or a [reply](#page-replies), an optional
`getStaticPaths()` for dynamic routes, and an optional `revalidate` (seconds) that opts the page's `load` result
into the cache store when one is available.

A page is public unless it states its access with a `route` export
(`definePage(path, { access })` from `jsails/api`, see
[Route access](#route-access)), whose path must be the page's route. A denied
request gets the error page (`401` for a caller without a session, `403` for
one with a session), and the page's middleware, `load` and component never run. A static export (`jsails build`) has no request to decide
for, so it never writes a page whose access is not public: the build lists it as
live-only and only the live server answers it.

```tsx
// pages/account.tsx
import { definePage } from 'jsails/api';

export const route = definePage('/account', {
  access: ({ session }) => session !== null,
});

export default function Account() {
  return <h1>Your account</h1>;
}
```

Page modules, their layouts and error boundaries are loaded and validated
once, through one importer. A production app (`NODE_ENV=production`, or
`createApp({ preloadModules: true })`) loads all of them, and every not-found
page, while it assembles, so a broken module fails the boot and no request
imports one.

Caching requires **both** `revalidate` and an explicit `cache: 'public'` export.
`revalidate` alone does not cache: a page whose props depend on the session must
not be shared between visitors, so sharing is a deliberate declaration. A cached
`load` result is served to every visitor without re-running `load`, so a page
that authorized inside `load` would otherwise hand one visitor's props to the
next. There is no `'private'` mode — a per-session key still serves stale props
after a permission change, so personalized pages should load fresh on every
request. Any other `cache` value is rejected when the module loads.

The declaration is not trusted alone. A request that resolved a session, carries
an `Authorization` header, or runs under an ambient tenant (`runWithTenant`, or
the `withoutTenantScope` override) neither reads nor writes the cache: `load`
runs fresh, so props derived from the caller are never replayed to anyone else.
An app that identifies visitors some other way than `resolveSession` (a cookie
it reads inside `load`) must not mark that page `cache: 'public'`.

```tsx
// pages/posts.tsx — shared, cacheable for 60 seconds
export const revalidate = 60;
export const cache = 'public';
export const cacheQuery = ['page']; // only ?page= varies the cached entry

declare function listPublishedPosts(): Promise<readonly { title: string }[]>;

export async function load() {
  return { posts: await listPublishedPosts() };
}
```

The cache key is the route pattern, the request host (`context.url.host`, port
included), the request locale (`context.locale`), the resolved params, and a
full SHA-256 digest of the query string. Without a
`cacheQuery` export every query parameter participates; with one, only the
listed names do, so `?utm_source=...` links share the bare page's entry. Query
strings are chosen by the client, so each route caches at most 1,000 live query
variants per store; past that budget a request runs `load` fresh and nothing is
written. A request without a query string never counts against the budget.
The `Host` header is chosen by the client too, so one store caches pages for at
most 64 live hosts besides the configured `server.origin`'s; a request for a host
past that budget runs `load` fresh and writes nothing.

`revalidatePath(path)` and `revalidateTag(tag)` (`jsails/pages`) invalidate by
replacing a generation token kept in the cache store itself; every page key
embeds the tokens of its route and tags. The purge therefore reaches every
process that shares the store (Valkey), and entries written under the old token
simply age out through their TTL. Each lookup of a cached page reads those
tokens first: one extra cache read, plus one per declared tag. A token that is
missing (expired, or evicted by the store's memory policy) is replaced by a new
random one, so losing it costs a cache miss and never brings back an older
entry; an entry's TTL is capped at the token's lifetime (366 days) for the same
reason.

`pageCacheKey(entry, context, { query })` returns the base key described above.
Stored entries append the generation suffix (`<base>:g:<path>.<tags>`), so
deleting `pageCacheKey(...)` from the store purges nothing: invalidate through
`revalidatePath` or `revalidateTag`.

The props cache is server-side. HTTP caching is separate, and one policy
decides it for every response, whoever produced it: each is
`Cache-Control: private, no-store` unless the page or API module exports
`cacheControl = { maxAge, staleWhileRevalidate? }`, which emits
`public, max-age=0, s-maxage=<maxAge>` and a matching `Surrogate-Control`. The
declaration covers only an anonymous, shareable answer. It applies to a `GET`
or `HEAD` answered 200, 203, 204, 301, or 308, and never when:

- the response sets a cookie, or `Vary: *`;
- the request carries a credential (a session cookie or token the identity
  source reads), `Authorization`, or `Cache-Control: no-store`;
- the request resolved an identity, ran under a private request scope, was
  partitioned by the session or a header, or had its locale chosen by a cookie;
- the response is a live stream (`Respond.eventStream`, `Respond.stream` with
  `{ live: true }`).

Those answers stay `private, no-store`. A response that sets its own
`Cache-Control` keeps it, except that a cookie always forces
`private, no-store`, adds `Cookie` to `Vary`, and drops `Surrogate-Control`.
`Vary` is only ever appended to: entries the handler set, such as `Origin`, are
kept. A shared answer whose locale was negotiated also varies on the headers it
was negotiated from (`Accept-Language`). Every failure (a 4xx or 5xx error
page or problem document) is `private, no-store` whatever the route declared.

```tsx
// pages/index.tsx  (app-owned page)
import type { RequestContext } from 'jsails';
import type { PageProps } from 'jsails/view';

export async function load(context: RequestContext) {
  return { hello: 'world' };
}

export default function Home({ hello }: PageProps<typeof load>) {
  return <h1>{hello}</h1>;
}
```

`PageProps<typeof load>` (from `jsails/view`, or `jsails/pages`) is what the
component renders with: the awaited result of `load`, with a `reply.props`
unwrapped to its props and a redirect or not-found reply left out, so the
component's props follow `load` without a second declaration.

### Page replies

A page's `load` answers with its props, or with a reply from `jsails/pages`
(`reply` is also a bare global):

- `reply.props(props, { status?, headers?, cookies? })` renders the page with
  those props. `status` is a document status (200 by default; 200 to 599, not
  a redirect, 204 or 205), `headers` are extra response headers (a `Headers` or
  `[name, value]` pairs), and each entry of `cookies` (`{ name, value,
  ...attributes }`) becomes its own `Set-Cookie` header. A cookie defaults to
  `Path=/`, `HttpOnly`, `SameSite=Lax`, and `Secure` when the request's
  origin is https: the canonical `server.origin`, or the scheme a trusted
  proxy forwarded, so a Node server on plain http behind a TLS-terminating
  proxy still marks it `Secure`.
- `reply.redirect(path, { status? })` redirects to a same-origin path (302 by
  default; 303, 307 or 308 on request) without rendering anything.
- `reply.redirectExternal(url, { status? })` is the explicit form for an
  absolute `http(s)` URL on another origin, without credentials.
- `reply.notFound()` answers with the app's not-found page (404).

```tsx
// pages/account.tsx — signed-out visitors are sent to sign in, then back
import type { RequestContext } from 'jsails';
import { reply } from 'jsails/pages';
import type { PageProps } from 'jsails/view';

declare function findAccount(sessionId: string): Promise<{ name: string } | undefined>;

export async function load(context: RequestContext) {
  if (context.session === null) {
    return reply.redirect(`/login?next=${encodeURIComponent(context.url.pathname)}`);
  }
  const account = await findAccount(context.session.id);
  if (account === undefined) return reply.notFound();
  return reply.props({ account }, { cookies: [{ name: 'seen', value: '1', maxAge: 3600 }] });
}

export default function Account({ account }: PageProps<typeof load>) {
  return <h1>{account.name}</h1>;
}
```

Every argument is checked when the reply is built, with value-free codes:
`reply.invalid_status`, `reply.reserved_header` (`Set-Cookie` has the
`cookies` option, `Location` the redirect helpers, `Cache-Control` and
`Surrogate-Control` are the route's declaration, and the framing headers are
the server's), `reply.invalid_header`, `reply.invalid_cookie`, and
`redirect.invalid_target` for a target that is not a same-origin path. A
target that came with the request (a `?next=` parameter) goes through
`safeRedirectPath(input, fallback)` from `jsails/api` first, which returns it
when it is a same-origin path and the fallback otherwise.

Only a page's `load` replies: a layout cannot redirect, and an error boundary
renders a document with the failure's status. A page's `cacheControl`
declares its rendered page public, so only a document at 200 with no headers
or cookies of its own takes it. Every other answer is the request's own and is
sent `private, no-store`: a redirect (a signed-out visitor's redirect to
`/login` must never be served to signed-in ones from a shared cache), a
document at another status, a document whose `reply.props` set headers or
cookies, and not-found. `load` always settles before the first byte, so a
streamed page can redirect or set cookies like a buffered one. Static export
writes a redirect to `redirects.json` and fails on an error status, headers or
cookies (see
[Static export](#static-export)). A raw `Response` is not a page answer: a
page that needs one is an API route.

`preactPageRenderer` + `renderRoute` render pages via **Preact SSR** (doctype plus
a minimal document shell) and reject a default component marked with
`SERVER_ONLY` (`import { SERVER_ONLY } from 'jsails/pages'`; set
`Page[SERVER_ONLY] = true`) in static mode. Set `"jsxImportSource": "jsails"` so JSX resolves to a thin
`preact/jsx-runtime` re-export; components are synchronous and async data belongs
in `load`. JSX/Preact runtimes are **not** interchangeable.

### Dynamic routes

A `[param]` filename segment is a single-segment parameter. A dynamic page
provides `getStaticPaths()` so the static export knows which paths to render:

```tsx
// pages/blog/[slug].tsx
export function getStaticPaths() {
  return [{ slug: 'hello-world' }, { slug: 'about' }];
}
```

## Route access

Every route the app serves states who may reach it; there is no default, and
a route that states nothing fails at startup (`surface.missing_access`):

- `publicAccess(reason)` from `jsails/api`: anyone. The reason (one line, at
  most 200 characters) says why the route is open and appears in the route
  table.
- a check, a function of the request context: the route is reached only when
  it resolves to exactly `true`. Any other value denies with a value-free
  `401` (no session) or `403` (a session); a throw or a rejection is a fault,
  answered `503` `access.fault` and reported with phase `authorize`.

The access chain runs inside the route boundary after the request is claimed
(session, locale, request scopes) and before any of the route's middleware or
handler. It first runs the cross-site check: an unsafe request (`POST`, `PUT`,
`PATCH`, `DELETE`) to a route that accepts the session cookie, from any
caller, anonymous included, must carry an `Origin` equal to the origin it was
addressed to, or, without `Origin`, `Sec-Fetch-Site: same-origin`; anything
else is refused `403` `access.cross_site` before the access check. There is no
token to send: a browser adds `Origin` to a same-origin form POST and `fetch`.
A route states the credentials it accepts with `credentials`: a filesystem API
route accepts `['cookie', 'token']` unless it says otherwise, a page and a
registrar route `['cookie']`, and `credentials: []` declares a route that
reads no credential (a webhook receiver, a signed protocol endpoint), which
gets no cross-site check. The list is enforced: a route sees a session only
when it came from a kind the route accepts, so a cookie session is no session
on a `['token']` route. Every denial is sent `private, no-store` without
`Set-Cookie`. See [Security](/docs/security#what-the-pipeline-enforces).

## API modules

An API module is either a `defineApi` definition or a set of named method
exports.

`defineApi(path, spec)` is the module's default export, and nothing else is
exported. The path is the file's route (assembly refuses any other with
`route.pattern_mismatch`), so each handler's `params` is typed from it:
`:name` and `*name` segments become string members. `access` is required;
`credentials`, `cacheControl`, `body`, `timeoutMs`, `stream` and `middleware` are
optional (see [Request bodies](#request-bodies) and
[Deadlines](#deadlines)), and each method handler takes the request context
alone.

```ts
// api/posts/[id].ts
import { defineApi, Respond } from 'jsails/api';

declare function deletePost(id: string): Promise<void>;

export default defineApi('/api/posts/:id', {
  access: ({ session }) => session !== null,
  GET: ({ params }) => Respond.json({ id: params.id }),
  DELETE: async ({ params }) => {
    await deletePost(params.id);
    return Respond.noContent();
  },
});
```

A module without `defineApi` exports named HTTP-method handlers
`(request, context) => Response`; there is no default-export guessing. Its
access is its `access` export (`publicAccess(reason)` or a check) or its
`authorize` export (a check), never both; a module with neither fails at
startup, since there is no app-wide default.

```ts
// api/me.ts
import type { RequestContext } from 'jsails';
import { Respond } from 'jsails/api';

export const authorize = ({ session }: RequestContext) => session !== null;

export async function GET(_request: Request, context: RequestContext) {
  return Respond.json({ session: context.session });
}
```

A `GET` route also answers `HEAD` (with the module's `HEAD` handler when it
has one). A request for a path whose routes answer other methods gets `405`
with `Allow`.

### Response helpers

`Respond` (`jsails/api`, re-exported from the root entry) covers the common HTTP
responses without hiding the web-standard `Response`:

- `Respond.json(data, init?)` — `application/json; charset=utf-8`; `undefined`
  serializes as `null`.
- `Respond.html(markup, init?)` — `text/html; charset=utf-8`.
- `Respond.text(body, init?)` — `text/plain; charset=utf-8`.
- `Respond.xml(body, init?)` — `application/xml; charset=utf-8` (feeds,
  sitemaps).
- `Respond.redirect(path, init?)` — `303 See Other` by default (301, 302,
  307 or 308 on request). The target must be a same-origin path: root-relative,
  no `//host`, no backslash, no control character, no `..` segment (plain or
  percent-encoded); anything else is `redirect.invalid_target`. Characters
  outside visible ASCII are percent-encoded for the header (`/café` is sent as
  `/caf%C3%A9`).
- `Respond.redirectExternal(url, init?)` — the explicit redirect to another
  origin: an absolute `http:` or `https:` URL without credentials, sent as its
  serialized form (`redirect.invalid_external_target` otherwise). Use it only
  for a target the code chose.
- `safeRedirectPath(input, fallback)` — the form for a target that came with
  the request (`?next=`): the input, encoded for the header, when it is a
  same-origin path, else `fallback` (which must itself be one).
  `isSameOriginPath(value)` is the check alone.
- `Respond.noContent(init?)` — `204 No Content` by default.
- `Respond.download(body, filename, init?)` — `Content-Disposition: attachment`
  with an RFC 5987-safe filename; `application/octet-stream` by default.

Caller-supplied headers win over each helper's defaults, and returning a raw
`Response` remains fully supported.

Code outside the filesystem adds routes through the HTTP registrar (an
extension's `routes`, see [Extending](/docs/extending)); they run through the
same boundary and gate.

### Request bodies

A request body is read only when a reader asks for it, and every byte read is
counted against the limit of the route the request reached. A request the
cross-site check, the access check, or a guard refuses costs none of its body,
and a client that sent `Expect: 100-continue` is invited to send it
(`100 Continue`) only when a reader asks.

A route states the body it reads with `body`: the kind and the most bytes it
accepts, or `{ kind: 'none' }` for a route that takes no body. A route that
declares nothing reads up to the app-wide `maxBodyBytes` (default 1 MiB). The
handler reads through `ctx.body`:

| `body.kind` | Reader                    | Gives                                                          |
| ----------- | ------------------------- | -------------------------------------------------------------- |
| `json`      | `ctx.body.json(schema)`   | the parsed JSON, validated by `schema` (a `422` when malformed) |
| `form`      | `ctx.body.form()`         | `FormData` from a urlencoded or small multipart body            |
| `raw`       | `ctx.body.bytes()`        | the body's bytes                                               |
| `raw`       | `ctx.body.stream()`       | the body as a `ReadableStream`, for a handler that streams it  |
| `multipart` | `ctx.body.multipart()`    | the parts of a `multipart/form-data` body, each file a stream   |

A `multipart` body also declares its parts (`{ kind: 'multipart', maxBytes,
parts }`): the part count, the bytes of a text field, the fields that may carry
a file with each file's cap, count and media types, and the idle bound. The
reader enforces each as the bytes arrive, and a part past its limit answers
`413` like a body past `maxBytes`; see
[Streaming a multipart body](/docs/forms#streaming-a-multipart-body).

```ts
// api/imports.ts
import { array, defineApi, object, Respond, string } from 'jsails/api';

const Import = object({ rows: array(string()) });

export default defineApi('/api/imports', {
  access: ({ session }) => session !== null,
  body: { kind: 'json', maxBytes: 8 * 1024 * 1024 },
  POST: async ({ body }) => {
    const { rows } = await body.json(Import);
    return Respond.json({ imported: rows.length });
  },
});
```

An API module without `defineApi` exports the declaration (`export const body
= { kind: 'raw', maxBytes: 8 * 1024 * 1024 }`); its handlers read
`context.body`. A registrar route declares it in its `RouteSpec`, and a mount
in its options:

```ts
import { publicAccess } from 'jsails/api';
import type { JsailsExtension } from 'jsails/extensions';

export const mediaUploads: JsailsExtension = {
  name: 'media-uploads',
  setup({ routes }) {
    routes.add({
      methods: ['POST'],
      path: '/admin/media',
      access: publicAccess('upload endpoint; the handler checks the token'),
      body: { kind: 'raw', maxBytes: 6 * 1024 * 1024 },
      handler: async ({ body }) => {
        const bytes = await body.bytes();
        return Response.json({ bytes: bytes.byteLength });
      },
    });
  },
};
```

A route that declares no `body` reads under the app-wide `maxBodyBytes`, and so
does a mount without one.

The limit holds whether or not the body declares its length:

- A `Content-Length` over the route's limit is answered `413` before anything
  is read or resolved: no session, no `authorize`, no handler. A length over
  100 MiB (`MAX_ROUTE_BODY_BYTES`, the largest limit any route may declare) is
  answered `413` before routing.
- A chunked body (no `Content-Length`, or one alongside `Transfer-Encoding`)
  is read up to the limit; the read past it fails with `request.too_large`,
  and nothing more is taken from the client.
- A read past the limit answers `413` whatever the handler then does: a
  handler that catches the error and answers `400` still yields `413`.
- Every `413`, and every answer of `400` or above that leaves the body unread,
  closes the connection (`Connection: close`), so the server never drains a
  body nobody wants. The server ends its side after the answer and destroys
  the socket a second later (`LINGER_MS`), reading nothing more meanwhile: a
  client still sending has that long to read the answer before the unread
  body makes the close a reset, which some clients (Windows) would answer by
  dropping the response.
- Over HTTP/1 a request with neither `Content-Length` nor `Transfer-Encoding`
  has no body (a bodiless `DELETE` or `OPTIONS`): there is nothing to leave
  unread, and its refusal keeps the connection.

Outside production, a reader of a kind the route does not declare (or any
reader on a route that declares none) throws `body.undeclared_read`, a `500`,
so a route that reads more than it states is caught in development and tests.
Production reads under the budget as the route asks, except
`ctx.body.multipart()`, which throws it in production too: it reads under the
parts the route declares, and a route that declares none has none to read
under.

A `maxBytes` must be a positive integer of at most 100 MiB, and so must the
app-wide `maxBodyBytes`: a length over 100 MiB is refused before routing, so a
larger app-wide cap would admit only chunked bodies. Anything else, or any other
shape, fails assembly with `route.invalid_definition` (a module) or
`route.invalid_route` (a registrar route). Code holding the request frame
(`currentRequestFrame()`) reads the budget as
`frame.body` (`BodyBudget`: `limit`, `consumed`, `exceeded`).
`BodySpec`, `BodyKind`, `MAX_ROUTE_BODY_BYTES`, `validateBodyLimit`, and
`BodyLimitError` are exported from `jsails/app`; `BodySpec` and `RequestBody`
also from `jsails/api`.

### Deadlines

Every route has to answer within its deadline: its `timeoutMs`, else the
app's `server.handlerTimeoutMs` (30 seconds by default; `0` disables it). The
deadline starts when the request enters the route and covers the rate-limit
hook, the session and request scopes, the access chain, the middleware, the
handler and the transforms. When it passes:

- `ctx.signal` aborts, its reason the `deadline.handler_timeout` error, so a
  handler that passes it to its own I/O (`fetch(url, { signal: ctx.signal })`,
  a database query) stops;
- the request is answered `504`, and the expiry is reported to `onError` with
  phase `timeout`;
- whatever the handler produces afterwards is discarded (a response's body is
  cancelled), and a rejection that comes after is reported with phase
  `timeout`.

```ts
// api/reports.ts
import { defineApi, Respond } from 'jsails/api';

declare function buildReport(options: { signal: AbortSignal }): Promise<object>;

export default defineApi('/api/reports', {
  access: ({ session }) => session !== null,
  timeoutMs: 120_000,
  GET: async ({ signal }) => Respond.json(await buildReport({ signal })),
});
```

An `onError` hook tells an expiry from other failures by its code:

```ts
// jsails.app.ts
import { DeadlineErrors, type RequestErrorHook } from 'jsails/app';

export const onError: RequestErrorHook = (error, { phase, route }) => {
  if (phase === 'timeout' && DeadlineErrors.is(error, 'handler_timeout')) {
    console.warn(`route ${route} missed its deadline`);
  }
};
```

`definePage(path, { access, timeoutMs })` sets a page's, a registrar route and a
mount take `timeoutMs` in their spec, and a legacy API module exports it;
without one, a route keeps the app's. The server-components transport
routes take their lane's `totalMs` plus the app's deadline, so the lane answers
its own `503 timeout` first.

A streamed answer is past the deadline once it is returned. A route that streams
declares `stream: { timeoutMs }` to bound the gap between two chunks instead:
when its producer takes longer for one chunk, the body fails with
`deadline.stream_idle` (reported, phase `timeout`) and the client sees it cut
short. A client that reads slowly is not the producer's delay, and a live stream
(`Respond.eventStream`, `Respond.stream` with `live`) has no idle bound.

## Per-route middleware

A compiled page or API module may export `middleware` (a `defineApi` spec
and `routes.add` carry it as `middleware`), an array of `RouteMiddleware`
functions applied in declared order before the handler. A middleware is
`(context, next) => Response`: it receives the route's request context and a
`next` that runs the rest of the chain and resolves to its answer. It returns
that answer, a changed copy of it (`Respond.withHeaders`,
`Respond.withCookies`), or its own `Response` without calling `next()` to
answer in the handler's place. `next()` runs at most once: a second call is a
reported fault (`route.next_called_twice`), and so is an answer that is not a
`Response`. A thrown or rejected middleware surfaces as the standard sanitized
500. There is no context to stage headers on: what a middleware adds, it adds
to the answer it returns.

```ts
// api/reports.ts
import { Respond, type RouteMiddleware } from 'jsails';

export const middleware: RouteMiddleware[] = [
  async (context, next) => {
    if (context.session === null) {
      return new Response('Unauthorized', { status: 401 });
    }
    return Respond.withHeaders(await next(), { 'x-report-version': '2' });
  },
];

export async function GET() {
  return Response.json({ ok: true });
}
```

Every route runs one compiled boundary in a fixed order (a health or readiness
probe skips the guards and claims nothing): guards → route match (no match:
405 or 404) → the declared body length against the route's limit → the
route's deadline → the rate-limit hook → route claim (session, locale,
request scopes) → the cross-site check for an unsafe method → the route's access →
the route's middleware → handler → response transforms → the body budget's
verdict.
Middleware never runs before the access chain admitted the request. An entry
is the middleware function itself; anything else (a name, a number) fails
assembly with a value-free error that reports the position, never the value.
`validateMiddlewareList` validates a module's `middleware` export
structurally.

There is no app-wide middleware chain: a wall in front of every request is a
guard (`http.guards`, `configureGuard`), and a rewrite of the answers of a
route kind is a transform (`routes.transform`). Middleware cannot reorder the
built-in pipeline steps, and framework-owned routes (`/up`,
`/_jsails/introspect`, server-component updates) carry none. The static export
never runs middleware.

## Route groups

A `pages/` directory named `(name)` (matching `[A-Za-z0-9_-]+`) is a route group:
it contributes no URL segment but does scope layouts. Groups are **pages-only**;
in `api/` the `(...)` is not a safe static segment and is rejected by the existing
literal check.

## Nested layouts

A `layout.js`/`layout.mjs` file in any `pages/` directory is a layout module,
discovered lexically by `discoverRoutes` and excluded from the route manifest. It
attaches to `RouteManifestEntry.layouts` as an ancestor chain (outermost first —
closest to `pages/` comes first). Layout modules carry no `load`, `middleware`, or
`getStaticPaths`; their default export is `(props: LayoutProps, context?) =>
RenderChild` where `props` receives the page's resolved props plus the
framework-reserved `children` slot (a colliding page prop loses). The function may
be sync or async.

```tsx
// pages/layout.tsx
export default function Layout({ children }: { children: unknown }) {
  return (
    <div>
      <nav>My Site</nav>
      <main>{children}</main>
    </div>
  );
}
```

`renderRoute` folds the chain inside-out: the innermost layout wraps the page, its
result is wrapped by the next-outer, and so on. If the outermost layout emits
`<html>`, the minimal document shell is skipped. Static export folds layouts
identically.

Layouts have no `load`, no `middleware`, and no `SERVER_ONLY` check (only the
page component is checked). Loading placeholders and parallel or intercepting
routes are not supported. The starter's `ui/layout.tsx` remains app-owned, and
`pages/layout.js` is opt-in.

## Error boundaries

An `error.js` file in a `pages/` directory is an error boundary for every page at
or below it; the nearest one wins, and it is excluded from the route manifest
like a layout. When a page, its layouts, or its `load` throws, the boundary's
default export renders in place of the sanitized 500:

```tsx
// pages/blog/error.tsx
export default function BlogError({ error }: { error: { status: number; message: string } }) {
  return <p>Something went wrong ({error.status}).</p>;
}
```

The boundary's output is HTML sent to the visitor, so it only ever sees public
facts: an `HttpError`'s `status` and `message`, or `500` and a generic message
for any other throw. Throw an `HttpError` to show a specific message. The
response carries that status, not `200`: a boundary that renders
`HttpError(404)` answers `404`, any other throw answers `500` (as does an
`HttpError` built with a non-error status), and a boundary response is sent with
`Cache-Control: private, no-store` even when the page declares `cacheControl`. The status
travels in the renderer's outcome, so a custom `PageRenderer` chooses its own.
A boundary that renders a 500 or above still reports the failure to `onError`.
In a static export a boundary's document fails the build instead of being
written (`error_status`, see [Static export](#static-export)).
The headers and cookies of a `reply.props` belong to the page that failed, so a
boundary document carries only the failure's own (`WWW-Authenticate`,
`Retry-After`). API routes have no error boundaries.

## Not-found and error pages

Every failure is answered in one of two formats, chosen once. A failed page
route always gets an HTML page with the real status (`404`, `500`, or the
thrown `HttpError`'s status); an API or framework route always gets the
[problem envelope](/docs/errors#the-problem-envelope); a route an HTTP hook or
the server-component transport registered decides by `Accept`. A request that
matched no route is an HTML page only when its `Accept` lists `text/html` at
least as strongly as JSON (a browser navigation does; `fetch()`'s default `*/*`
does not), and never for a path under an API prefix (`/api`, locale-prefixed or
not) or `/_jsails`, which always answer with the envelope. A path no route has
is a `404`; a path that a route answers under other methods is a `405` with an
`Allow` header listing them (`GET` implies `HEAD`).

The built-in page shows only the status and its generic text (or an
`HttpError`'s public message), escaped, and is never cached. Every error answer
keeps the headers its failure carries: `Allow` on a 405, `WWW-Authenticate` on
a 401 challenge, `Retry-After` on a rate limit. `createApp({ errorPage })`
replaces the built-in page with the app's own document:
`(error: { status, message }, context: RequestContext) => string`. It runs at
most once per request, inside the request's identity, locale, and scope
bindings; a throw, a result that is not a string, or a second failure of the
same request falls back to the built-in page, and the throw is reported to
`onError` with phase `error-page`.

The not-found page (a request no route matched: its 404, or the 405 of a path
that answers other methods) for a request without a credential is kept in
memory for 60 seconds (64 pages, least recently used first out), keyed by
status, message, origin, path and query, locale, and cache partitions, so a
burst of misses for one URL renders once. A 404 or 405 that a route throws is
never kept: its message is the route's decision for that request. A render
that read the request, the client address, the CSP nonce, or the session is
not kept, whether it read them from its `context` or from
`currentRequestFrame()`, nor is one that ran under a private scope or a
cookie-chosen locale. A not-found page that prints the request id or trace
from the execution context would show the first request's; read them through
`currentRequestFrame()` instead, which keeps the page out of the memo.

A `not-found.js` file in a `pages/` directory is the app's own 404 page for
every unmatched URL under that directory. Like `layout` and `error`, it is not a
route. The nearest one wins: `pages/docs/not-found.js` answers `/docs/anything`,
`pages/teams/[team]/not-found.js` answers `/teams/acme/anything`, and
`pages/not-found.js` answers the rest. A route group adds no segment, so
`pages/(shop)/not-found.js` beside `pages/not-found.js` is a duplicate and fails
discovery, as do two not-found modules in one directory or one inside a
catch-all directory. Under `api/` a `not-found.js` stays an ordinary route.

```tsx
// pages/not-found.tsx
export default function NotFound() {
  return <p>We could not find that page.</p>;
}
```

`discoverRoutes` lists these pages, most specific first, in
`manifest.notFound` (`NotFoundManifestEntry`: `scope`, `file`, `layouts`,
`errorBoundary`). `createApp` serves them whenever it has a structured
`renderer`: a 404 inside a not-found page's scope renders that page, and every
other status, and a 404 that no scope covers, still goes to the app's
`errorPage` or the built-in page. An app without a renderer keeps its
`errorPage` alone.

`createNotFoundErrorPage({ manifest, renderer, fallback?, locales? })` from
`jsails/pages` is the same wiring as a standalone `errorPage` renderer, for a
custom setup that assembles its own error handling. It returns `fallback`
unchanged when the manifest has no not-found page, and
`matchNotFoundPage(manifest, pathname, locales?)` returns the page a path would
get.

The page renders like any other: through the page renderer, wrapped in the
layouts above its directory, with its own `load` and metadata. Its
`context.params` are the ones its own scope captures (`team` for
`pages/teams/[team]/not-found.js`), never those of the route that failed. It
answers with status `404`, for an unmatched browser navigation and for an
`HttpError(404)` thrown by a page that has no error boundary. Every other status
still goes to `fallback` or the built-in page. A not-found page answers
arbitrary URLs, so it may not export `cache: 'public'`. It also renders outside
any route, so it runs without per-route middleware and may not export
`middleware`: a guard it declared would never run, and its layouts and `load`
would reach every visitor. A page that breaks either rule fails to render, the
failure is reported to `onError`, and the built-in page is served instead.

## Static export

`jsails build` is a static export: it renders every page (expanding
`getStaticPaths`), copies every file of the asset index byte-for-byte (exactly
what the server serves: no symlink, no dot-file but `.well-known/`), and swaps
the result into `out` through a staging directory. API routes
are never rendered and are reported skipped. A root `pages/not-found.js` is
rendered to `404.html`, the file static hosts serve for an unmatched URL; it is
listed last in `written` and is never in the sitemap. Nested not-found pages are
server-only, because a static host serves one file for every miss.

No existing directory on the way to `out` may be a symlink, so a link the build
would write through cannot redirect the staging directory, the swap, or the
removal of the old output. The exception is `root`, the project root (the
working directory unless `generateStaticSite` is given one; `jsails build` and
`Application.build` pass the app's `rootDir`), and its parents: they are the
machine's own layout, such as macOS's `/var` -> `/private/var` or a symlinked
home directory, and may be links.

Every output path is planned and checked for collisions before anything renders.
`generateStaticSite` then renders up to `concurrency` pages at once (default 8;
pass `1` for pages that share mutable state) and writes each page into the
staging directory as soon as it renders, so memory does not grow with the size
of the site. Output order and the reported error (the earliest failing page in
manifest order) do not depend on timing. Any failure removes the staging
directory, so the previous `out` is left as it was. The built-in renderer
reports each page's resolved metadata through `PageRenderOptions.onMetadata`,
so `generateMetadata` runs once per page; a custom renderer that does not call
it still works, and the exporter then resolves the metadata itself.

A page's outcome decides what is written. A document is written as rendered,
and a 2xx status other than 200 is dropped. A document at an error status, a
`reply.props` 4xx or an error boundary's document for a `load` that failed
during the build, fails the build with `error_status`, naming the route (with
the boundary's failure as the cause): a static host would serve it with 200
and list it in the sitemap as a page. A `load` that answers `reply.redirect` (or `redirectExternal`) leaves an HTML
fallback at the page's path (a zero-second refresh, a link, the target as
canonical, `noindex`) and an entry in `redirects.json` at the root of `out`:

```json
{ "redirects": [{ "from": "/account", "to": "/login?next=%2Faccount", "status": 302 }] }
```

The table is host-neutral, in manifest order, for a deploy step to translate
into its host's rules; it is written only when a page redirected, and an asset
at that path is a collision. Redirected pages are kept out of the sitemap and
listed in the result's `redirects`. A `load` that answers `reply.notFound()`
writes nothing and is listed in `notFound`; it is how a page leaves a path out
of the export. A document that sets response headers or cookies fails the
build with `reply_not_static`, naming the route: a static file carries
neither. `jsails build` names every not-found page and every redirect it
recorded.

```sh
jsails build --config jsails.app.js   # static export into `out`
```

The renderer seam is `PageRenderer.render(entry, context, options)` — the same
interface for a buffered page, a streamed page and `build`; configure it with
`renderer`. It answers with a `PageOutcome`:

```ts
type PageOutcome =
  | {
      kind: 'document';
      status: number;
      headers: Headers;
      body: { kind: 'bytes'; html: string } | { kind: 'stream'; stream: ReadableStream<Uint8Array> };
    }
  | { kind: 'redirect'; status: number; location: string }
  | { kind: 'not-found' };
```

The server maps each kind onto one response body: a document's bytes or its
stream (`text/html` unless the headers name a type; its status is 200 to 599,
never 204, 205 or a 3xx), an empty redirect with its `Location` (a redirect
status, and a same-origin path or an absolute http(s) URL), and the app's
not-found page. Anything else is `invalid_render`. `options.stream`
asks for a streamed document (a renderer that cannot stream answers bytes), and
`options.onError` receives a failure the renderer answered itself (a 500
boundary, a late stream failure). `documentOutcome(html, { status?, headers? })`
(`jsails/pages`) wraps a string for a renderer that only produces HTML. The
built-in renderer keeps the compiled-page loader and `getStaticPaths` contract.
A custom renderer's document is **trusted producer HTML** — JSails never
sanitizes it, so the renderer owns its escaping and safety. A not-found page
must render a document without headers or cookies.

## Progressive streaming

A page module may export `stream(context)` → `PageStream` to stream HTML
progressively during live serving instead of waiting for `load` + `default` to
finish. `PageStream` is what `Respond.stream` accepts: a
`ReadableStream<Uint8Array>`, or an async iterable of strings (sent as UTF-8)
and bytes, which a Node `Readable` is:

```tsx
// pages/feed.tsx
import type { RequestContext } from 'jsails';
import type { PageStream } from 'jsails/pages';

export async function* stream(context: RequestContext): PageStream {
  yield '<!DOCTYPE html><html><body>';
  for await (const item of fetchItems()) {
    yield `<article>${item.title}</article>`;
  }
  yield '</body></html>';
}
```

The route answers through `Respond.stream` with `text/html` and
`X-Accel-Buffering: no`, so buffering proxies pass chunks through uninspected,
and each chunk is produced inside the request's context. The producer is
advanced only as the client reads, so a slow client never makes chunks pile up
in memory, and a client disconnect calls the iterator's `return()`, so the
generator's `finally` blocks run and its cursors or upstream requests are
released. A producer that throws after the response has started truncates the
body; the route reports that error to `onError` and as a `requestFailed`
signal (phase `stream`, with the route pattern and the request id), since the
status line is already sent. A producer that goes longer than
`render.streamTimeoutMs` (30 seconds by default) without a chunk is cut off
with `deadline.stream_idle`.

During live serving `stream` takes precedence over the renderer
(`default` + `load`); a module may define both exports, or `stream` alone, as
above. A module exporting `stream` beside `cache` or `cacheControl` is refused
when the route is assembled. Static export (`jsails build`) ignores `stream` and renders `default` +
`load` as usual; a page that exports only `stream` is listed as live-only and
not written.

A `stream` page writes its own document shell and does not get layouts, SEO
head injection, or the error boundary. For a page built from `load`, `default`,
and layouts, use streaming rendering instead.

## Streaming rendering

The built-in renderer can stream an ordinary page. Pages are buffered; one
streams when it exports `stream = true`. There is no app-wide switch, and
`export const stream = false` is refused (it would say nothing). The only
`render` setting is the stream deadline:

```js
// jsails.app.js
export default {
  render: { streamTimeoutMs: 10_000 },
};
```

The config loader rejects an unknown `render` key and a `streamTimeoutMs` that
is not a positive integer up to 2147483647, without echoing the value. An app
assembled by hand passes the same object to `createApp({ render })`.

```tsx
// pages/post/[slug].tsx
import { Suspense, lazy } from 'preact/compat';

const Comments = lazy(() => import('../../components/comments.js'));

export const stream = true;

export default function Post({ post }) {
  return (
    <article>
      <h1>{post.title}</h1>
      <Suspense fallback={<p>Loading comments...</p>}>
        <Comments postId={post.id} />
      </Suspense>
    </article>
  );
}
```

`load`, the page component, the layouts, and the metadata resolve first, as in
a buffered render. Then the shell is sent: the whole document outside any
pending `Suspense` boundary, with the head tags and each boundary's `fallback`.
Each suspended subtree follows when its data resolves, in a hidden
`<jsails-chunk>` element that a small inline script moves over the fallback.
The whole boundary is replaced as a unit: when any component inside it
suspends, at any depth, its siblings inside the boundary wait with it and
arrive in the same chunk. A page with no pending boundary is sent as one chunk. A Content-Security-Policy
that blocks inline scripts must allow that script.

Failures depend on whether the shell was sent. A failure before it (in `load`,
the page, a layout, the metadata, or the shell itself) behaves as in a buffered
render: the error boundary answers with its status, or the app answers with the
value-free error page. A reply from `load` (a redirect, not-found, a status or
cookies) is answered exactly as for a buffered page. After the shell the `200` is already sent. A component
that throws in a resumed subtree, or suspended data that rejects, ends the
document with a generic `<div role="alert" data-jsails-stream-error>` notice.
The error goes to `onError` and to `requestFailed` observers (phase `stream`,
with the route pattern and the request id), and never into the page.

A streamed page carries `X-Accel-Buffering: no`, is never digested for an
`ETag`, and is compressed and flushed per chunk. A streamed page cannot declare
a cache: its `200` would go out before the suspended subtrees render, so a
shared cache could store a page that ended with the error notice.
`export const stream = true` together with `cache` or `cacheControl` fails at
startup. The body is produced as the client reads it. A
client disconnect stops the render, so a subtree whose data resolves after that
is never rendered.

The suspended subtrees have 30 seconds after the shell to finish, so data that
never settles cannot hold a response open forever. Set `render.streamTimeoutMs`
(a positive integer of milliseconds, up to 2147483647) to change the limit. When the limit passes, the document ends
with the same generic notice, and `onError` receives a
`PageRenderError` with code `render_timeout`. Static export never streams. A
custom renderer receives `stream: true` and `timeoutMs` in its options and
answers a document whose body is a stream, or bytes when it cannot stream.

## Public files and asset URLs

Files under `public/` are served from the **asset index**
(`createAssetIndex` in `jsails/app`), built once when the application first
needs it. It walks `public/` without following links and records each regular
file's URL path, size and content hash (SHA-256, base64url, the first 16
characters); a file up to 64 KiB keeps its bytes in memory (32 MiB in all). The
index holds no symlink, special file, or hidden file: a name beginning with `.`
is left out (`.env`, `.git/`), except a top-level `.well-known/` directory, so
`/.well-known/security.txt` is served. A symlink or a name a URL path cannot
carry (a backslash, a control character) is left out too, and the start emits
one `JSAILS_ASSETS_REFUSED` warning with their count. A file or directory the
server may not read (a root-owned file a deploy left behind) is left out and
counted in one `JSAILS_ASSETS_UNREADABLE` warning, so the app still starts; a
`public/` it cannot list at all, or any other read failure (an I/O error), fails
the start with `asset.read_failed`, which names the URL path, never the
location on disk. Every request answers from
what the index holds; a path is decoded once and looked up, so a traversal
(`/.well-known/../x`, `%2e%2e`, an encoded slash) cannot name a file the walk
did not list.

In development (`NODE_ENV=development`) the index follows the files: it watches
`public/`, hashes a file when a request first asks for it, and checks its size
and modification time on every request, so a bundler's rewrite is served under
its new hash at once. A request that races the rewrite (the file changes
between its hash and its opening) is answered again from the new bytes, up to
three times. Anywhere else it is a snapshot taken at start: a file added
afterwards is not served until the next start, and a file that changes size
under a running server is answered with a `500` reported once as
`asset.stale_assets` (a file that is there but no longer opens, as
`asset.read_failed`). A production start that hashed the files of `public/`
itself emits one `JSAILS_ASSETS_NOT_BUILT` warning; the bytes served are still
the file's. An app with no `public/`, or an empty one, gets no such warning.

**Order and precedence.** A `GET` or `HEAD` of an indexed path is answered after
the guards and before routing, without entering the router, so a public file
wins over a parametric, catch-all, or mount route that would also match it
(`public/favicon.ico` beside a root `pages/[slug].js`). Any other method on an
asset path is answered `405` with `Allow: GET, HEAD`. A directory request
(`/docs/` or `/docs`) is answered with its `index.html` unless a route has that
literal path. An asset whose path equals a literal route, a reserved framework
path (the health or readiness probe, `/_jsails/...`) fails `createApp` with
`asset.route_collision`; a development index warns once
(`JSAILS_ASSET_ROUTE_COLLISION`), lets the route answer, and checks again when
the files change. An asset path is never matched case-insensitively.

**Caching and validators.** An asset answer carries a strong `ETag` (its
content hash), `Accept-Ranges: bytes`, and `Cache-Control: public, max-age=0,
must-revalidate`. A URL whose `v` is the file's current content hash is served
`public, max-age=31536000, immutable`; any other `v` (a stale hash after a
deploy, or one a client made up) is served like an unversioned URL, so no cache
keeps the wrong bytes under a versioned URL for a year. A matching
`If-None-Match` (or `*`) gets a `304` without touching the disk. One `bytes=`
range is honoured (`206`, or `416` past the end), only when `If-Range` is absent
or equal to the `ETag`. The finalizer may compress an uncompressed answer of a
compressible type, as it compresses any response, weakening its `ETag`.
Precompressed copies are an entry's `encodings`, which only a built manifest
declares; a `<file>.br` or `<file>.gz` beside a file in `public/` is an ordinary
file of its own.

**Asset URLs.** `context.assetUrl(path)` is the index's `url`, synchronous:
`/assets/app.js` becomes `/assets/app.js?v=<hash>`, percent-encoded. It never
throws and never reads the disk for a snapshot: a path the index does not hold
(missing, hidden, a traversal, a query or fragment) comes back unchanged, and a
built entry marked `immutable` (a fingerprinted name) comes back without a
query. `context.assetUrl` is optional; `Application` and `createApp({ assets })`
attach it to each request context and the static export to each page context.

The starter layout tags the stylesheet and the module script with
`data-turbo-track="reload"`; Turbo compares that URL across navigations, so a
content change that keeps the same filename yields a new URL and forces a **full
reload** instead of serving a stale deployment cache. This is the intentional
exception to soft navigation: an unchanged asset keeps the same URL, so ordinary
links stay fast soft navigations, while changed build assets reload. The script
also carries `data-turbo-eval="false"` so Turbo does not re-evaluate the client
entry on every navigation. When no resolver is wired in (e.g. browser-free SSR),
`loadLayout` falls back to the plain `/assets/app.css` and `/assets/app.js` paths.

An app that assembles `createApp` itself passes the index:

```ts
import { createApp, createAssetIndex } from 'jsails/app';
import type { RouteManifest } from 'jsails/routing';

declare const manifest: RouteManifest;

const assets = await createAssetIndex({ roots: [{ dir: 'public' }] });
export const app = await createApp({ manifest, assets });
```

A root may carry a `prefix` (`/plugins/widget`) and an `owner`; two roots that
serve the same path fail with `asset.duplicate_asset`.

## Response finalization

Every dynamic response, whoever produced it (a `Respond` helper, a raw
`Response`, a proxied `fetch()`, a page, a guard, an error page), passes once
through the same finalizer after its producer returns:

1. Its body is classified without sniffing content. A body a `Respond` helper,
   a page, or an error page built is known as bytes or a stream without being
   read (a stream a middleware teed with `Response.clone()` included). Any
   other body is read for as long as it is already available (until the next
   macrotask, up to 64 KiB or the `Content-Length` it declares): if it ends,
   it is sent whole; otherwise it is sent as it is produced, nothing lost, so
   a slow or stalled producer never holds back the response head. A foreign
   body that declares more than 64 KiB is streamed at once, and one that
   outruns its declared length is sent without it. A body something already
   read or locked is answered as a `500` and reported
   (`response_finalizer.body_taken`).
2. The cache policy above decides `Cache-Control` and `Vary`.
3. The content coding is chosen once: brotli or gzip by the client's
   `Accept-Encoding` q-values (brotli on a tie), for a compressible type
   (HTML, JSON, JavaScript, CSS, SVG, XML, other text) only. A body under 1 KiB,
   a 204, 206, or 304, a `Cache-Control: no-transform` answer, an event stream,
   and a response that already carries `Content-Encoding` are sent as they are.
   An answer that could be encoded carries `Vary: Accept-Encoding` whichever
   coding it got; one too small to encode does not vary on it.
4. A storable `200` of at most 1 MiB of bytes gets a strong `ETag` from its
   content (`.br` or `.gz` appended when encoded, so each coding is its own
   representation). A handler's own `ETag` is kept, made weak when the body is
   then encoded. A `private, no-store` answer, a stream, and a larger body get
   none.
5. A matching `If-None-Match` (or `If-Modified-Since` against `Last-Modified`)
   answers `304` with the response's headers and no body.
6. The body is encoded: whole for bytes (synchronously up to 32 KiB, on the
   thread pool above), per chunk for a stream, flushed after each chunk so
   compression never holds back a page's shell or a feed's records.
7. The request id (`X-Request-Id`) and the default security headers are added
   unless the producer set its own.
8. Bytes are installed with their `Content-Length`, which the Node server
   writes in one call. A stream is read inside the request's execution
   context, so a producer advanced after the handler returned still sees the
   identity, locale, and tenant its route saw; a `Respond.stream` failure is
   reported to `onError` once (phase `stream`) and cuts the body short.

A `HEAD` request is finalized from the answer a `GET` gets: the same status,
headers, validator, and coding, `Content-Length` when the body is sent
unencoded, and no body.

### Streaming responses

`Respond.stream(source, init?, { live? })` sends a progressive body from a
`ReadableStream` or an async iterable of strings and bytes: each chunk reaches
the client as it is produced, compressed per chunk when the client accepts it.
An iterable is read only as fast as the client takes chunks, and a client that
goes away ends it through `return()`, so its `finally` blocks run. `live: true`
marks a stream that never ends on its own (a feed, a log tail): it is never
stored or compressed whole, and a server shutting down ends it cleanly when
the drain starts, as it ends an event stream, instead of waiting out
`shutdownTimeoutMs` for it: its producer is cancelled and `ctx.signal` aborts
with `serve.draining`. An endless stream not marked live is reported as
`serve.unfinished_stream` at the shutdown deadline (see
[Deployment](/docs/deploy#shutdown-and-live-streams)).

`Respond.eventStream(events, init?)` sends server-sent events
(`text/event-stream`): live, `no-store`, never compressed, and marked
`X-Accel-Buffering: no` so a proxy does not buffer it. A bare string is an
event's `data`; an object carries `data`, `event`, `id`, and `retry`.
Multi-line data is split across `data:` lines; an event name or id containing a
line break fails the stream with `respond.invalid_event_field`.

```ts
// api/clock.ts
import { Respond } from 'jsails/api';

export function GET() {
  return Respond.eventStream(
    (async function* () {
      for (let tick = 0; tick < 3; tick += 1) {
        yield { event: 'tick', data: String(tick) };
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    })(),
  );
}
```

`Respond.withHeaders(response, headers)` and
`Respond.withCookies(response, cookies)` return a copy with headers set or
cookies appended, keeping the status and the body, which is still sent as
cheaply as the original.

## Next steps

- [Server Components](/docs/server-components) — signed, stateful components with
  server actions.
- [Client & Islands](/docs/client) — islands, Turbo navigation, and hydration.
