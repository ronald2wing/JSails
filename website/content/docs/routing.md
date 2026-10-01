---
title: Routing
order: 8
section: Building
---

# Pages & Routing

JSails discovers routes from the filesystem. `discoverRoutes(rootDir, { pagesDir?,
apiDir? })` walks `pages/` and `api/` lexically — no module import, no connection.
Only compiled `.js`/`.mjs` modules are discovered; symlinks are never followed;
`api/` routes mount under `/api`. Parameters are single-segment `[id]`; catch-all
`[...id]` is rejected, not accepted as a literal path.

## Page modules

A page is a compiled module with a function default export, an optional
`load(context)` for async props, an optional `getStaticPaths()` for dynamic
routes, and an optional `revalidate` (seconds) that opts the page's `load` result
into the cache store when one is available.

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

The props cache is server-side. HTTP caching is separate: every response is
`Cache-Control: private, no-store` unless the page or API module exports
`cacheControl = { maxAge, staleWhileRevalidate? }`, which emits
`public, max-age=0, s-maxage=<maxAge>` and a matching `Surrogate-Control` for a
`GET`/`HEAD`. The declaration covers only an anonymous, cacheable answer: it is
not applied to a status other than 200, 203, 204, 206, 301, 308, 404, or 410, to
a response that sets its own `Cache-Control` or a cookie, or to a request that
resolved a session or carries `Authorization`. Those stay `private, no-store`.
A response that sets a cookie has `Cookie` added to its `Vary` list; entries the
handler set, such as `Origin`, are kept.

```tsx
// pages/index.tsx  (app-owned page)
import type { RequestContext } from 'jsails';

export async function load(context: RequestContext) {
  return { hello: 'world' };
}

export default function Home({ hello }: { hello: string }) {
  return <h1>{hello}</h1>;
}
```

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

## API modules

An API module exports named HTTP-method handlers `(request, context) => Response`;
there is no default-export guessing. The global `authorize` is **default-deny**
(see [Configuration](/docs/configuration#sessions-authorization-and-csrf)), and
a per-module `authorize` can only further restrict.

```ts
// api/me.ts
import { Respond } from 'jsails/api';

export async function GET(_request: Request, context: RequestContext) {
  return Respond.json({ session: context.session });
}
```

### Response helpers

`Respond` (`jsails/api`, re-exported from the root entry) covers the common HTTP
responses without hiding the web-standard `Response`:

- `Respond.json(data, init?)` — `application/json; charset=utf-8`; `undefined`
  serializes as `null`.
- `Respond.html(markup, init?)` — `text/html; charset=utf-8`.
- `Respond.text(body, init?)` — `text/plain; charset=utf-8`.
- `Respond.xml(body, init?)` — `application/xml; charset=utf-8` (feeds,
  sitemaps).
- `Respond.redirect(location, init?)` — `303 See Other` by default; the target
  is validated (no control characters, no `javascript:`/`data:`/`vbscript:`).
- `Respond.noContent(init?)` — `204 No Content` by default.
- `Respond.download(body, filename, init?)` — `Content-Disposition: attachment`
  with an RFC 5987-safe filename; `application/octet-stream` by default.

Caller-supplied headers win over each helper's defaults, and returning a raw
`Response` remains fully supported.

HTTP extension hooks run in order after the body-limit/405 middleware and before
the filesystem routes, receiving the real Hono app; hook routes are trusted code
that own their own security — the default-deny pipeline covers only filesystem API
routes.

### Request body limits

Every request body is capped at the app-wide `maxBodyBytes` (default 1 MiB);
a larger body gets `413`. A route that needs a different cap declares it. An API
module exports `maxBodyBytes`:

```ts
// api/imports.ts
export const maxBodyBytes = 8 * 1024 * 1024;
```

A route mounted from an HTTP hook adds `routeBodyLimit(bytes)` in front of its
handler, on the app the hook receives (not on a sub-app mounted with
`app.route()`):

```ts
import { routeBodyLimit } from 'jsails/app';

configureHttp((app) => {
  app.post('/admin/media', routeBodyLimit(6 * 1024 * 1024), handler);
});
```

The limit runs before the session, CSRF, and `authorize`, so it applies to
anonymous clients. A raised cap therefore applies only to a body that declares
its `Content-Length`, which is checked without reading the body. A chunked body
(no `Content-Length`, or one alongside `Transfer-Encoding`) has to be read to be
measured, so it is held to the app-wide `maxBodyBytes` even on a route with a
larger cap; a lower route cap still applies to it. Browsers and HTTP clients send
`Content-Length` for form posts and file uploads.

A declaration replaces the app-wide cap for that route, up or down. It must be a
positive integer of at most 100 MiB (`MAX_ROUTE_BODY_BYTES`); anything else
throws a `BodyLimitError` (code `invalid_body_limit`) when the app is assembled.
`routeBodyLimit`, `validateBodyLimit`, `MAX_ROUTE_BODY_BYTES`, and
`BodyLimitError` are exported from `jsails/app`.
When several matched routes declare a cap, such as a prefix middleware and the
route itself, the smallest one applies.

## Per-route middleware

A compiled page or API module may export `middleware`, an array of Hono
`MiddlewareHandler` handlers applied in declared order before the terminal
handler. Each handler receives a Hono `Context` (`c.req`, `c.var.session`, …)
and a `next` continuation; calling `next()` forwards down the chain, and
returning a `Response` (or returning without calling `next()`) short-circuits.
A thrown/rejected handler surfaces as the standard sanitized 500. Middleware
can never run before the default-deny gate.

```ts
// api/reports.ts
export const middleware = [
  async (c, next) => {
    if (!c.var.session) return new Response('Unauthorized', { status: 401 });
    return next();
  },
];

export async function GET(request: Request, context: RequestContext) {
  return Response.json({ ok: true });
}
```

The ordering invariant is fixed: body-limit/405 → session → origin/CSRF → global
`authorize` → module `authorize` → global middleware → per-route middleware →
handler. Global middleware is set via `globalMiddleware: readonly
RouteMiddlewareRef[]` in the app config; extensions add to the global chain through
`configureMiddleware(handler)` on the `ExtensionRuntime`. A named map
(`middleware: Record<string, RouteMiddleware>`) is collected at assembly time;
routes reference registered names (or inline handlers) in their `middleware`
export, and an unknown name fails at boot with a value-free error (it reports
the position, never the name or handler). `validateMiddlewareList` validates a module's
`middleware` export structurally; Hono's `app.use`/`app.on` compose the chain
(the old hand-rolled `runMiddleware`/`MiddlewareError` are gone — `next()` is
single-use by Hono's construction).

Middleware cannot reorder the built-in pipeline steps. It cannot run on
framework-owned routes (`/up`, `/_jsails/introspect`, server-component updates,
extension HTTP hooks). There is no route-path-keyed config map and no lazy or
async name resolution. The static export never runs middleware.

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
`Cache-Control: no-store` even when the page declares `cacheControl`. The status
comes from the built-in renderer; a custom `PageRenderer` that does not go
through `renderRoute` answers `200`. API routes have no error boundaries.

## Not-found and error pages

A browser navigation that matches no route, or whose page fails without an
error boundary, gets an HTML page with the real status (`404`, `500`, or the
thrown `HttpError`'s status) instead of the JSON envelope. HTML is chosen only
when the request's `Accept` lists `text/html` at least as strongly as JSON (a
browser navigation does; `fetch()`'s default `*/*` does not), and never for a
path under an API prefix (`/api`, locale-prefixed or not) or `/_jsails`, which
always answer with the envelope. The built-in page shows only the status and
its generic text (or an `HttpError`'s public message), escaped, and is never
cached. `createApp({ errorPage })` replaces it with the app's own document:
`(error: { status, message }, context: RequestContext) => string`; a throwing
renderer falls back to the built-in page.

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
`errorPage` or the built-in page. An app served through `renderPage` instead
keeps its `errorPage` alone.

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
`getStaticPaths`), copies `public/` byte-for-byte (symlinks rejected, dot-files
skipped), and swaps the result into `out` through a staging directory. API routes
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

```sh
jsails build --config jsails.app.js   # static export into `out`
```

The renderer seam is `PageRenderer.render(entry, context, options)` — the same
interface for `serve` and `build`; configure it with `renderer`. The built-in
renderer keeps the compiled-page loader and `getStaticPaths` contract. A custom
renderer's returned string is **trusted producer HTML** — JSails never sanitizes
it, so the renderer owns its escaping and safety.

## Progressive streaming

A page module may export `stream(context)` → `PageStream` to stream HTML
progressively during live serving instead of waiting for `load` + `default` to
finish. `PageStream` accepts `AsyncIterable<string>`,
`ReadableStream<Uint8Array>`, or a Node `Readable`:

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

`renderStreamResponse(stream, headers?, { onError }?)` (`jsails/pages`) wraps
the stream into a `Response` with chunked transfer encoding and
`X-Accel-Buffering: no` so buffering proxies pass chunks through uninspected.
The producer is advanced only as the client reads, so a slow client never makes
chunks pile up in memory, and a client disconnect calls the iterator's
`return()`, so the generator's `finally` blocks run and its cursors or upstream
requests are released. A producer that throws after the response has started
truncates the body; the page route reports that error as a `requestFailed`
signal, since the status line is already sent.

During live serving `stream` takes precedence over the string renderer
(`default` + `load`); a module may define both exports. Static export (`jsails
build`) ignores `stream` and renders `default` + `load` as usual.

A `stream` page writes its own document shell and does not get layouts, SEO
head injection, or the error boundary. For a page built from `load`, `default`,
and layouts, use streaming rendering instead.

## Streaming rendering

The built-in renderer can stream an ordinary page. It is opt-in and buffered
rendering stays the default. Turn it on for every page served by the renderer
with `render: { stream: true }` in `jsails.app.js`, or for one page with
`export const stream = true`. `export const stream = false` keeps one page
buffered when the app streams. A `stream` function (above) wins over both.

```js
// jsails.app.js
export default {
  render: { stream: true, streamTimeoutMs: 10_000 },
};
```

The config loader rejects an unknown `render` key, a `stream` that is not a
boolean, and a `streamTimeoutMs` that is not a positive integer up to 2147483647,
without echoing
the value. An app assembled by hand passes the same object to
`createApp({ render })`.

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
value-free error page. After the shell the `200` is already sent. A component
that throws in a resumed subtree, or suspended data that rejects, ends the
document with a generic `<div role="alert" data-jsails-stream-error>` notice.
The error goes to `onError` and to `requestFailed` observers, and never
into the page.

A streamed page carries `X-Accel-Buffering: no`, is never digested for an
`ETag`, and is flushed per chunk by compression. A page that declares a public
`cacheControl` is never streamed. Its `200` would go out before the suspended
subtrees render, so a shared cache could store a page that ended with the
error notice. Such a page stays buffered when the app streams, and
`export const stream = true` together with `cacheControl` fails at startup.
`cache: 'public'` with `revalidate` still serves `load` results from the shared
cache on a streamed page. The body is produced as the client reads it. A
client disconnect stops the render, so a subtree whose data resolves after that
is never rendered.

The suspended subtrees have 30 seconds after the shell to finish, so data that
never settles cannot hold a response open forever. Set `render.streamTimeoutMs`
(a positive integer of milliseconds, up to 2147483647) to change the limit. When the limit passes, the document ends
with the same generic notice, and `onError` receives a
`PageRenderError` with code `render_timeout`. Static export never streams. A custom renderer streams only
when it implements `renderStream(entry, context, options)`
(`StreamingPageRenderer`); otherwise its pages stay buffered.
`renderRouteStream` (`jsails/pages`) is the built-in streaming render.

## Asset URLs and Turbo reload

`createAssetUrlResolver(publicDir)` maps a root-relative public asset path
(`/assets/app.js`) to the same path with a content-derived query
(`/assets/app.js?v=<sha256>`). Hashing streams the file through SHA-256 and is
cached by `mtimeMs` + `size`, so an unchanged asset is never re-read. The resolver
is a **graceful-degradation seam, never a source of errors**: a missing
directory/asset, a traversal/absolute/hidden/backslash/query/fragment path, or a
symlink all return the unversioned path unchanged, so browser-free SSR (where
`public/` may not exist) still renders, and a hostile path is never read from
disk.

`context.assetUrl` is optional; `Application` and `createApp` attach the resolver
to each request context and the static export attaches it to each synthesized page
context. The starter layout tags the stylesheet and the module script with
`data-turbo-track="reload"`; Turbo compares that URL across navigations, so a
content change that keeps the same filename yields a new URL and forces a **full
reload** instead of serving a stale deployment cache. This is the intentional
exception to soft navigation: an unchanged asset keeps the same URL, so ordinary
links stay fast soft navigations, while changed build assets reload. The script
also carries `data-turbo-eval="false"` so Turbo does not re-evaluate the client
entry on every navigation. When no resolver is wired in (e.g. browser-free SSR),
`loadLayout` falls back to the plain `/assets/app.css` and `/assets/app.js` paths.

Files under `public/` are served with a size-and-mtime weak `ETag` and
`Cache-Control: public, max-age=0, must-revalidate`. A URL whose `v` is the
content hash the resolver currently generates for the file is served
`public, max-age=31536000, immutable`; any other `v` (a stale hash after a
deploy, or one a client made up) is served like an unversioned URL, so no
cache keeps the wrong bytes under a versioned URL for a year.
`createPublicFilesMiddleware(publicDir, { assetUrl })` checks against the given
resolver's hashes, and builds one over `publicDir` when none is given. A matching
`If-None-Match` (or `*`) gets a `304` before the file is opened. When the client
accepts it and a sibling `<file>.br` or `<file>.gz` exists (brotli preferred),
the sibling is served with `Content-Encoding`, the original content type, its
own `ETag`, and `Vary: Accept-Encoding`, so a build step can compress assets
once instead of the server compressing them on every request. A sibling passes
the same symlink and containment checks as the file; range requests always get
the uncompressed file. Dynamic responses that are `no-store` (the default), are
progressively streamed, or declare more than 1 MiB are not digested for an
`ETag`. A response with no `Content-Length` is digested only when its whole body
is already available (a string or bytes); a stream whose producer is still
working, such as an ndjson feed or a proxied chunked body, is sent as it is
produced and gets no generated `ETag`.

Other text responses of 1 KiB or more (HTML, JSON, JavaScript, CSS, SVG) are
compressed as they are sent: brotli when the client accepts it, otherwise gzip
or deflate, chosen by `Accept-Encoding` q-values. Event streams, already-encoded
responses, `HEAD`, `206`, and `Cache-Control: no-transform` responses are sent
as they are. A progressively streamed page, and any response without a
`Content-Length`, is flushed after every chunk, so compression does not hold
back a page's shell or a stream's records.

## Next steps

- [Server Components](/docs/server-components) — signed, stateful components with
  server actions.
- [Client & Islands](/docs/client) — islands, Turbo navigation, and hydration.
