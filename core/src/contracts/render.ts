/**
 * Page and renderer contracts for filesystem pages, layouts, and static site
 * generation. Server-component authoring contracts live in `server-components/`.
 *
 * A renderer answers with a {@link PageOutcome}: a document (its bytes, or
 * its stream), a redirect, or not-found. The HTTP layer maps each one onto a
 * response body and the static exporter onto files, so a buffered, a
 * streamed and an exported page are one contract.
 */

import type { PageDefinition } from '../api/route-definition.js';
import type { StreamSource } from '../api/responses.js';
import type { LoadResult } from '../pages/reply.js';

import type { RenderChild } from './component.js';
import type { RequestContext } from './http.js';
import type { PageMetadata } from '../seo/metadata.js';
import type { RouteMiddleware } from '../routing/middleware.js';
import type { RouteManifestEntry } from '../routing/routes.js';
import type { Awaitable } from './awaitable.js';

/**
 * A stream of HTML chunks from a page's `stream` producer: a byte stream, or
 * an async iterable of strings (sent as UTF-8) and bytes. A Node `Readable`
 * is such an iterable.
 */
export type PageStream = StreamSource;

/**
 * The default export of a page: renders props to a render child.
 *
 * May be async: the framework resolves the promise through its async renderer
 * (`renderToStringAsync`). Preact function components stay synchronous; async
 * data should be loaded in {@link PageModule.load} and passed in as props.
 */
export interface PageComponent<P = Record<string, unknown>> {
  (props: P, context?: RequestContext): Awaitable<RenderChild>;
}

/**
 * A filesystem-routed page module.
 *
 * `default` renders the page; `context` is omitted during static generation.
 * `load` resolves dynamic props from the request context (async data fetch),
 * or answers with a `reply` from `jsails/pages`: `reply.props(props, {
 * status, headers, cookies })`, `reply.redirect(path)`,
 * `reply.redirectExternal(url)` or `reply.notFound()`. Only the page's `load`
 * may reply; a layout cannot redirect.
 * `getStaticPaths` enumerates the params for static generation. `middleware`
 * is an optional array of handlers run (in order) before `load` during live
 * serving; a handler may short-circuit with a `Response` (e.g. a redirect) or
 * await `next()` to proceed. Filename-to-route mapping is owned elsewhere.
 *
 * `P` defaults to an untyped record because the runtime loads modules it
 * cannot see the types of; a page's own props type is
 * `PageProps<typeof load>` from `jsails/view`.
 */
export interface PageModule<P = Record<string, unknown>> {
  /**
   * The page component. Required unless {@link stream} is a producer
   * function: a page that only streams is answered by live serving alone, so
   * a static export lists it as live-only instead of rendering it.
   */
  default?: PageComponent<P>;
  load?(context: RequestContext): Awaitable<LoadResult<P>>;
  getStaticPaths?(): Awaitable<Array<Record<string, string>>>;
  middleware?: readonly RouteMiddleware[];
  /**
   * The page's access (`definePage(path, { access })` from `jsails/api`),
   * whose path must be the page's route. Absent means the page is public and
   * its `load` decides.
   */
  route?: PageDefinition;
  /**
   * Opt-in route data cache TTL in seconds. When set (a positive finite
   * number) and a cache store is available on the request context, the
   * page's `load()` result is cached under a key derived from the route
   * pattern, resolved params, and query string. Absent means `load` runs
   * fresh on every request.
   *
   * Caching is only active when the module also declares `cache: 'public'`.
   * A page whose props depend on the session must not be shared between
   * visitors, so sharing is an explicit declaration rather than a default.
   */
  revalidate?: number;
  /**
   * Declares who may read the cached `load()` result. `'public'` opts into a
   * single shared cache entry for every visitor; the key omits session
   * identity. Absent means the page is never cached, even when `revalidate`
   * is set — a personalized page would otherwise leak one visitor's props to
   * another. There is no `'private'` mode: a per-session cache key still
   * serves stale props after a permission change, so personalized pages
   * should load fresh on every request.
   */
  cache?: 'public';
  /**
   * Query parameter names that participate in the shared cache key. Absent
   * means every query parameter does (each distinct query string is its own
   * entry, up to a per-route budget of live variants; past it a request loads
   * fresh and nothing is written). A declared list ignores every other
   * parameter, so `?utm_source=...` links share the entry of the bare page.
   */
  cacheQuery?: readonly string[];
  /**
   * Opt-in invalidation tags. When combined with `revalidate`, every tag is
   * recorded against the page's cache key so `revalidateTag(tag)` can purge it
   * on demand (the Next.js tag-invalidation analog). Absent means the page is
   * reachable only by `revalidatePath` or TTL expiry.
   */
  tags?: readonly string[];
  /**
   * Streaming for live serving; pages are buffered by default. `true` streams
   * `default` + `load`: `load`, the component, the layouts and the metadata
   * resolve first, then the shell is sent and each suspended subtree follows
   * as it resolves. A function is the progressive producer: live serving
   * answers with `stream(context)` instead of rendering `default`. A module
   * exporting `stream` together with `cache` or `cacheControl` is refused when
   * the route is assembled. Static export (`jsails build`) ignores `stream`
   * and renders `default` + `load` as usual.
   */
  stream?: true | ((context: RequestContext) => Awaitable<PageStream>);
  /**
   * Reserved SEO export. A static {@link PageMetadata} object, or a function
   * resolving one from the request context. When both `metadata` and
   * `generateMetadata` are present, `generateMetadata` wins.
   */
  metadata?: PageMetadata | ((context: RequestContext) => Awaitable<PageMetadata>);
  /**
   * Reserved SEO export. Resolves the page's {@link PageMetadata} from the
   * request context; takes precedence over a static `metadata` object.
   */
  generateMetadata?(context: RequestContext): Awaitable<PageMetadata>;
}

/**
 * Props passed to a layout's default export: `children` plus any page props.
 *
 * Non-generic — page props flow through as `Record<string, unknown>`.
 * A layout that needs narrower typing casts its props at the component level.
 */
export interface LayoutProps {
  readonly children: RenderChild;
  readonly [key: string]: unknown;
}

/**
 * A compiled layout module.
 *
 * `default` wraps its `children` (the inner rendered output) plus any page
 * props the layout consumes. The `context` parameter is omitted during static
 * generation, like {@link PageComponent}. Unlike {@link PageModule}, a layout
 * module carries no `load`, `getStaticPaths`, or `middleware` surface.
 */
export interface LayoutModule {
  readonly default: (props: LayoutProps, context?: RequestContext) => Awaitable<RenderChild>;
}

/** Options controlling a single page render, shared by every renderer. */
export interface PageRenderOptions {
  /**
   * Reject a default component annotated `SERVER_ONLY` instead of rendering it
   * to a static file. Nested annotations are not inspected. A static render
   * never streams.
   */
  readonly staticMode?: boolean;
  /**
   * Receives the page metadata the renderer resolved for this render. The
   * static exporter uses it to build the sitemap without calling a page's
   * `generateMetadata` a second time; a renderer that does not call it is
   * still valid, and the exporter then resolves the metadata itself.
   */
  readonly onMetadata?: (metadata: PageMetadata) => void;
  /**
   * Answer with a streamed document: the shell first, then each suspended
   * subtree as it resolves. A renderer that cannot stream answers with bytes.
   */
  readonly stream?: boolean;
  /**
   * Milliseconds a streamed document's suspended subtrees have once the shell
   * is out (a positive integer, 30 seconds by default); past it the document
   * ends with a generic notice and `onError` receives `render_timeout`.
   */
  readonly timeoutMs?: number;
  /**
   * Receives a failure the renderer answered itself: one an error boundary
   * rendered at status 500 or above, or one that came after a streamed
   * document's first chunk. The live route reports it with the route pattern
   * and the request id.
   */
  readonly onError?: (error: unknown) => void;
}

/**
 * A rendered document's body: its complete HTML, or a stream of it.
 *
 * @public
 */
export type PageDocumentBody =
  | { readonly kind: 'bytes'; readonly html: string }
  | { readonly kind: 'stream'; readonly stream: ReadableStream<Uint8Array> };

/**
 * What a renderer answers for one page:
 *
 * - `document`: the HTML with its status (200, the status a `reply.props`
 *   chose, or an error boundary's) and the headers the page set, its
 *   `Set-Cookie` lines included; the content type is the HTTP layer's;
 * - `redirect`: a `Location` (a same-origin path, or an explicit external
 *   URL) and a redirect status;
 * - `not-found`: the page has nothing at this URL; the app's not-found page
 *   answers, and a static export writes nothing.
 *
 * @public
 */
export type PageOutcome =
  | {
      readonly kind: 'document';
      readonly status: number;
      readonly headers: Headers;
      readonly body: PageDocumentBody;
    }
  | { readonly kind: 'redirect'; readonly status: number; readonly location: string }
  | { readonly kind: 'not-found' };

/**
 * Adapter seam for rendering one page route.
 *
 * A renderer receives the manifest entry, the request context, and render
 * options, and answers with a {@link PageOutcome}. A document's HTML is
 * trusted producer output: JSails never sanitizes it. The built-in Preact
 * renderer keeps Preact's escaping; a custom renderer owns the escaping and
 * safety of everything it emits (`documentOutcome(html)` from `jsails/pages`
 * wraps a string).
 */
export interface PageRenderer {
  render(
    entry: RouteManifestEntry,
    context: RequestContext,
    options?: PageRenderOptions,
  ): Awaitable<PageOutcome>;
  /**
   * Load and validate every module rendering `entry` needs (the page, its
   * layouts, its error boundary), so the first request imports nothing.
   * Production assembly calls it for every page; a renderer without it loads
   * on first render.
   */
  preload?(entry: RouteManifestEntry): Promise<void>;
}
