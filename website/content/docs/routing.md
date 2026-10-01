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

```tsx
// pages/posts.tsx — shared, cacheable for 60 seconds
export const revalidate = 60;
export const cache = 'public';
export const cacheQuery = ['page']; // only ?page= varies the cached entry

export async function load() {
  return { posts: await listPublishedPosts() };
}
```

The cache key is the route pattern, the request locale (`context.locale`), the
resolved params, and a full SHA-256 digest of the query string. Without a
`cacheQuery` export every query parameter participates; with one, only the
listed names do, so `?utm_source=...` links share the bare page's entry. Query
strings are chosen by the client, so each route caches at most 1,000 live query
variants per store; past that budget a request runs `load` fresh and nothing is
written. A request without a query string never counts against the budget.

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
for any other throw. Throw an `HttpError` to show a specific message. API routes
have no error boundaries.

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

## Static export

`jsails build` is a static export: it renders every page (expanding
`getStaticPaths`), copies `public/` byte-for-byte (symlinks rejected, dot-files
skipped), and swaps the result into `out` through a staging directory. API routes
are never rendered and are reported skipped.

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

Streaming is opt-in. The built-in renderer stays buffered on purpose: the error
boundary, head injection from `generateMetadata`, `cacheControl`, and ETags all
need the finished document, so turning it on by default would change how
existing pages behave. A `stream` page writes its own document shell and does
not get layouts, SEO head injection, or the error boundary.

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

Files under `public/` are served with a size-and-mtime weak `ETag`. A matching
`If-None-Match` (or `*`) gets a `304` before the file is opened. When the client
accepts it and a sibling `<file>.br` or `<file>.gz` exists (brotli preferred),
the sibling is served with `Content-Encoding`, the original content type, its
own `ETag`, and `Vary: Accept-Encoding`, so a build step can compress assets
once instead of the server compressing them on every request. A sibling passes
the same symlink and containment checks as the file; range requests always get
the uncompressed file. Dynamic responses that are `no-store` (the default), are
progressively streamed, or declare more than 1 MiB are not digested for an
`ETag`.

## Next steps

- [Server Components](/docs/server-components) — signed, stateful components with
  server actions.
- [Client & Islands](/docs/client) — islands, Turbo navigation, and hydration.
