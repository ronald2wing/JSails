/**
 * Compiled filesystem page loading and server-side rendering to a
 * {@link PageOutcome}.
 *
 * This is the runtime half of the page route story: the manifest supplies a
 * `RouteManifestEntry`, {@link loadPageModule} imports the already-compiled
 * `.js`/`.mjs` module (never TypeScript, never a transformer), and
 * {@link renderRoute} resolves `load`, invokes the default component, and
 * renders through the thin Preact wrapper. A `load` that replies
 * (`reply.redirect`, `reply.notFound`) answers without rendering; a
 * `reply.props` renders with its status, headers and cookies. The document is
 * buffered unless the caller asks for a stream (`stream: true`), which runs
 * the same steps and streams the shell, then each suspended subtree (see
 * `streaming-render.ts`); `load` always settles before the first byte.
 *
 * Boundaries:
 * - No bespoke HTML escaping or JSX parsing: rendering and escaping are
 *   Preact's. Only a doctype and, when the root is not `<html>`, a minimal
 *   document shell are prepended by hand.
 * - Normal ESM import semantics apply: modules are cached process-globally by
 *   Node, so there is no hot-reload or per-request module re-evaluation.
 * - `staticMode` rejects a default component annotated `SERVER_ONLY`, and a
 *   server component the export cannot render (`component_static.*`) fails
 *   the page past its error boundary, naming the route.
 *
 * Setup-time failures surface as {@link PageRenderError}; the HTTP layer turns
 * any non-validation error into a generic 500, so these messages are for logs
 * and build tooling, not for response bodies.
 */

import { Fragment, h, type VNode } from 'preact';

import { tryResolveCacheStore } from './cache-resolver.js';
import { recordPageCacheKey } from './revalidate.js';
import {
  admitPageCacheHost,
  admitQueryVariant,
  describePageCacheKey,
  PAGE_GENERATION_TTL_MS,
  readThroughPageCache,
  versionedPageCacheKey,
} from './page-cache.js';
import {
  isPageReply,
  serializeCookie,
  type NotFoundReply,
  type PropsReply,
  type RedirectReply,
} from './reply.js';
import { tenantScopeState } from '../database/tenant-context.js';
import { toFailure } from '../api/error-response.js';
import { isPlainObject } from '../json/shape.js';
import { SERVER_ONLY, type Component, type RenderChild } from '../contracts/component.js';
import type { RequestContext } from '../contracts/http.js';
import type {
  LayoutModule,
  PageDocumentBody,
  PageModule,
  PageOutcome,
  PageRenderer,
  PageRenderOptions,
} from '../contracts/render.js';
import { renderToString } from '../jsx/render-to-string.js';
import { validateMiddlewareList } from '../routing/middleware.js';
import type { RouteManifestEntry } from '../routing/routes.js';
import { resolveSeoService, seoToken } from '../seo/service.js';
import type { PageMetadata } from '../seo/metadata.js';
import { JsailsError } from '../errors/jsails-error.js';
import { statusTitle } from '../errors/problem-document.server.js';
import { ComponentStaticErrors } from '../server-components/runtime/static-errors.js';
import { STREAM_TIMEOUT_MS, streamDocument } from './streaming-render.js';
import type { Awaitable } from '../contracts/awaitable.js';
import { loadRouteModule } from '../routing/route-module.js';

/** Stable codes carried by a {@link PageRenderError}. */
export type PageRenderErrorCode =
  'invalid_module' | 'invalid_route' | 'invalid_props' | 'invalid_render' | 'render_timeout';

/** Raised for malformed page modules and unrenderable page routes. */
export class PageRenderError extends JsailsError {
  constructor(
    readonly code: PageRenderErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

const DOCTYPE = '<!DOCTYPE html>';

/**
 * Import and validate a compiled page module.
 *
 * Loads through the route module importer (`loadRouteModule`: compiled
 * `.js`/`.mjs` only, imported by file URL, validated once per path), then
 * requires a function default export (absent only beside a `stream` producer
 * function), function-valued `load`/`getStaticPaths` exports when present,
 * and a structurally valid `middleware` export when present; a malformed
 * module is a {@link PageRenderError}.
 */
export function loadPageModule(file: string): Promise<PageModule> {
  return loadRouteModule('page', file, (record) => validatePageModule(file, record));
}

function validatePageModule(file: string, record: Record<string, unknown>): PageModule {
  // A page that only streams has nothing to render: its producer answers.
  if (
    typeof record.default !== 'function' &&
    (record.default !== undefined || typeof record.stream !== 'function')
  ) {
    throw new PageRenderError(
      'invalid_module',
      `page module "${file}" default export must be a function`,
    );
  }
  assertOptionalFunction(record, 'load', file);
  assertOptionalFunction(record, 'getStaticPaths', file);
  assertOptionalFunction(record, 'generateMetadata', file);
  assertOptionalMetadata(record, file);
  assertOptionalRevalidate(record, file);
  assertOptionalCache(record, file);
  assertOptionalCacheQuery(record, file);
  assertOptionalStream(record, file);
  validateMiddlewareList(
    record.middleware,
    (message) => new PageRenderError('invalid_module', `page module "${file}" ${message}`),
  );

  return record;
}

/**
 * Import and validate a compiled layout module.
 *
 * Loads through the route module importer like a page module. A layout
 * module differs from a page module only in its contract: it MUST export a
 * function default (the layout component) and carries no `load`,
 * `getStaticPaths`, or `middleware` surface.
 */
export function loadLayoutModule(file: string): Promise<LayoutModule> {
  return loadRouteModule('layout', file, (record) => {
    if (typeof record.default !== 'function') {
      throw new PageRenderError(
        'invalid_module',
        `layout module "${file}" default export must be a function`,
      );
    }
    return record as unknown as LayoutModule;
  });
}

/** Import and validate a co-located error boundary module. */
function loadErrorBoundary(file: string): Promise<ErrorBoundaryComponent> {
  return loadRouteModule('error', file, (record) => {
    if (typeof record.default !== 'function') {
      throw new PageRenderError(
        'invalid_module',
        `error boundary module "${file}" default export must be a function`,
      );
    }
    return record.default as ErrorBoundaryComponent;
  });
}

/**
 * Render a page manifest entry for one request to its {@link PageOutcome}.
 *
 * Resolves `load` (if any): a redirect or not-found reply is the outcome as
 * it is, and plain props or a `reply.props` render the default component
 * inside its layouts through Preact. The document is always prefixed with a
 * doctype: a root `<html>` element is emitted as-is, anything else is wrapped
 * in a minimal document. With `stream: true` (never in `staticMode`) the
 * document is streamed: the shell, head tags included, is the first chunk and
 * the content of each pending `Suspense` boundary follows as it resolves;
 * every failure before the shell still rejects, and one after it closes the
 * document with a generic notice and goes to `onError`.
 */
export async function renderRoute(
  entry: RouteManifestEntry,
  context: RequestContext,
  options: PageRenderOptions = {},
): Promise<PageOutcome> {
  const timeoutMs = options.timeoutMs ?? STREAM_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new PageRenderError('invalid_render', 'timeoutMs must be a positive integer');
  }
  const prepared = await prepareRoute(entry, context, options);
  if (prepared.kind === 'answered') return prepared.outcome;
  const { page, tree, renderContext, status, headers } = prepared;
  const metadata = await resolvePageMetadata(page, renderContext);
  options.onMetadata?.(metadata);
  const seo = resolveSeoService(renderContext.services?.tryGet(seoToken));
  const headTags = seo.buildHeadTags(metadata, renderContext.seo ?? {});
  const injectHead = (document: string): string =>
    headTags === '' ? document : seo.injectHead(document, headTags);

  if (options.stream === true && options.staticMode !== true) {
    const stream = streamDocument(tree, {
      injectHead,
      ...(options.onError !== undefined ? { onError: options.onError } : {}),
      timeoutMs,
      timeoutError: () =>
        new PageRenderError('render_timeout', 'a streamed page did not finish in time'),
    });
    return { kind: 'document', status, headers, body: { kind: 'stream', stream } };
  }
  const html = injectHead(DOCTYPE + withDocumentShell(renderToString(tree)));
  return { kind: 'document', status, headers, body: { kind: 'bytes', html } };
}

/**
 * A document outcome for `html`: status 200 unless given, and the headers
 * given. The seam for a custom {@link PageRenderer} that produces a string.
 *
 * @public
 */
export function documentOutcome(
  html: string,
  init: { readonly status?: number; readonly headers?: HeadersInit } = {},
): PageOutcome {
  return {
    kind: 'document',
    status: init.status ?? 200,
    headers: new Headers(init.headers),
    body: { kind: 'bytes', html },
  };
}

/** The HTML of a document body; a stream is read to its end. */
export async function documentHtml(body: PageDocumentBody): Promise<string> {
  return body.kind === 'bytes' ? body.html : new Response(body.stream).text();
}

/**
 * A page resolved up to the element tree, ready for either body, or the
 * outcome its `load` replied with.
 */
type PreparedRoute =
  | { readonly kind: 'answered'; readonly outcome: PageOutcome }
  | {
      readonly kind: 'tree';
      readonly page: PageModule;
      readonly tree: VNode;
      readonly renderContext: RequestContext;
      readonly status: number;
      readonly headers: Headers;
    };

/**
 * Load the page, resolve its props, and fold its layouts into one element
 * tree. A throw from `load`, the page, or a layout renders the nearest error
 * boundary instead when there is one, with the failure's status.
 */
async function prepareRoute(
  entry: RouteManifestEntry,
  context: RequestContext,
  options: PageRenderOptions,
): Promise<PreparedRoute> {
  if (entry === null || typeof entry !== 'object') {
    throw new PageRenderError('invalid_route', 'renderRoute requires a route manifest entry');
  }
  if (entry.kind !== 'page') {
    throw new PageRenderError('invalid_route', `route "${entry.route}" is not a page entry`);
  }

  const page = await loadPageModule(entry.file);
  if (page.default === undefined) {
    throw new PageRenderError(
      'invalid_route',
      `page "${entry.route}" exports only a stream producer, which live serving alone runs`,
    );
  }
  const render = page.default;
  const component = render as Component<Record<string, unknown>>;

  if (options.staticMode === true && component[SERVER_ONLY] === true) {
    throw new PageRenderError(
      'invalid_route',
      `page "${entry.route}" is marked SERVER_ONLY and cannot be rendered in static mode`,
    );
  }

  // Static exports render server components without signing; the derived context
  // carries that flag (preserving any services) so a page's renderServerComponent
  // calls see `renderMode: 'static'` and render only the fallback.
  const renderContext: RequestContext =
    options.staticMode === true ? { ...context, renderMode: 'static' } : context;

  let status = 200;
  let headers = new Headers();
  let element: RenderChild;
  try {
    const loaded = await resolvePageProps(page, entry, renderContext, options);
    let props: unknown = loaded;
    if (isPageReply(loaded)) {
      if (loaded.kind !== 'props') return { kind: 'answered', outcome: replyOutcome(loaded) };
      props = loaded.props;
      status = loaded.status;
      headers = replyHeaders(loaded, renderContext);
    }
    if (!isPlainObject(props)) {
      throw new PageRenderError(
        'invalid_props',
        `page "${entry.route}" load() must resolve to a plain object of props`,
      );
    }
    element = await render(props, renderContext);

    // Fold the layout chain around the page element. `entry.layouts` lists
    // absolute layout module paths outermost-first (root → page dir), so we
    // iterate in reverse to build the wrapping tree inside-out: the innermost
    // layout wraps the page, its result is wrapped by the next-outer layout, and
    // so on until the outermost layout wraps the whole chain.
    if (entry.layouts && entry.layouts.length > 0) {
      for (let i = entry.layouts.length - 1; i >= 0; i--) {
        const layout = await loadLayoutModule(entry.layouts[i]!);
        // Spread the resolved page props first, then set `children` explicitly
        // so the framework's slot always wins — a page prop named `children`
        // cannot override the actual child element.
        element = await layout.default({ ...props, children: element }, renderContext);
      }
    }
  } catch (error) {
    // A static export that cannot render a server component (no static form,
    // an initial render its authorize denies, or a static form that fails) is
    // a build refusal, not a page failure: no boundary may turn it into a
    // written page.
    if (options.staticMode === true && ComponentStaticErrors.is(error)) {
      throw new PageRenderError(
        'invalid_route',
        `page "${entry.route}" renders a server component the static export cannot render`,
        { cause: error },
      );
    }
    // Per-route error boundary: a co-located `error.js` (nearest ancestor)
    // catches a page/layout/load throw and renders the error UI instead of
    // the sanitized 500. The boundary is rendered into HTML, so it receives
    // only what the failure mapper lets a client read: the status and, for a
    // failure meant for the caller, its message; any other throw (which may
    // embed a connection string or other internals) is a generic 500. The
    // headers and cookies a props reply chose belong to the page that
    // failed, so the boundary's document carries only the failure's own
    // (`WWW-Authenticate`, `Retry-After`).
    if (entry.errorBoundary === undefined) throw error;
    const boundary = await loadErrorBoundary(entry.errorBoundary);
    const failure = toFailure(error);
    // A thrown value that names a non-error status (an `HttpError` of 204)
    // is a fault, never a successful answer.
    const errorStatus = failure.status >= 400 && failure.status <= 599;
    status = errorStatus ? failure.status : 500;
    if (status >= 500) options.onError?.(error);
    headers = errorStatus ? new Headers(failure.headers) : new Headers();
    const message = errorStatus ? failure.message : undefined;
    element = await boundary(
      { error: { status, message: message ?? statusTitle(status) } },
      renderContext,
    );
  }

  return {
    kind: 'tree',
    page,
    tree: h(Fragment, null, element),
    renderContext,
    status,
    headers,
  };
}

/** The outcome of a reply that does not render. */
function replyOutcome(answer: RedirectReply | NotFoundReply): PageOutcome {
  if (answer.kind === 'not-found') return { kind: 'not-found' };
  return { kind: 'redirect', status: answer.status, location: answer.location };
}

/**
 * The headers a props reply chose, with one `Set-Cookie` per cookie; a
 * cookie without its own `secure` is `Secure` when the request's resolved
 * origin is https. That origin, not the request URL, is the scheme the
 * visitor used: behind a TLS-terminating proxy the URL is plain http while
 * the canonical origin (or the trusted proxy's `X-Forwarded-Proto`) is
 * https. A context without a resolved origin (one built in process) falls
 * back to its URL.
 */
function replyHeaders(answer: PropsReply<unknown>, context: RequestContext): Headers {
  const headers = new Headers();
  for (const [name, value] of answer.headers) headers.append(name, value);
  const secure = (context.origin?.origin ?? context.url.origin).startsWith('https:');
  for (const cookie of answer.cookies) {
    headers.append('set-cookie', serializeCookie(cookie, secure));
  }
  return headers;
}

/** What an error boundary is told about a failure: public facts only. */
interface ErrorBoundaryError {
  readonly status: number;
  readonly message: string;
}

/** The default export of an error boundary module. */
type ErrorBoundaryComponent = (
  props: { error: ErrorBoundaryError },
  context?: RequestContext,
) => Awaitable<RenderChild>;

/**
 * The built-in {@link PageRenderer}. It is a thin adapter over
 * {@link renderRoute}, so the compiled-page loader, the `load`/`getStaticPaths`
 * contract, and Preact's escaping are unchanged; callers that swap in another
 * renderer opt out of all three.
 */
export const preactPageRenderer: PageRenderer = Object.freeze<PageRenderer>({
  render(entry, context, options) {
    return renderRoute(entry, context, options);
  },
  preload: preloadRoute,
});

/**
 * Load and validate every module rendering `entry` needs: the page, its
 * layouts and its error boundary.
 */
async function preloadRoute(entry: RouteManifestEntry): Promise<void> {
  await Promise.all([
    loadPageModule(entry.file),
    ...(entry.layouts ?? []).map((file) => loadLayoutModule(file)),
    ...(entry.errorBoundary === undefined ? [] : [loadErrorBoundary(entry.errorBoundary)]),
  ]);
}

/**
 * Resolve page props, optionally caching the result through a cache store when
 * configured. Caching requires BOTH `revalidate` (a TTL) and `cache: 'public'`
 * (an explicit declaration that the props are not personalized): a cached
 * result is served to every visitor without re-running `load()`, so a page that
 * authorized inside `load()` would otherwise hand one visitor's props to the
 * next. Any cache backend failure falls back to a fresh `load()` call so
 * caching is a graceful-degradation seam.
 *
 * The declaration is not trusted alone: a request that resolved a session,
 * carries an `Authorization` header, or runs under an ambient tenant neither
 * reads nor writes the cache (see {@link sharesAnonymousProps}), so props a
 * `load()` derived from the caller can never be replayed to someone else. A
 * `load()` that replies (`reply.*`) is never stored: its answer is the
 * request's own.
 */
async function resolvePageProps(
  page: PageModule,
  entry: RouteManifestEntry,
  renderContext: RequestContext,
  options: PageRenderOptions,
): Promise<unknown> {
  const ttl = page.revalidate;
  const shared = page.cache === 'public';
  if (
    shared &&
    options.staticMode !== true &&
    typeof ttl === 'number' &&
    ttl > 0 &&
    Number.isFinite(ttl) &&
    sharesAnonymousProps(renderContext)
  ) {
    const store = tryResolveCacheStore(renderContext.services);
    if (store !== undefined) {
      // Capped at the generation token's lifetime so an entry never outlives
      // the token its key embeds; whole milliseconds, as every cache TTL is.
      const ttlMs = Math.min(Math.ceil(ttl * 1000), PAGE_GENERATION_TTL_MS);
      const { key: baseKey, queried } = describePageCacheKey(
        entry,
        renderContext,
        page.cacheQuery === undefined ? {} : { query: page.cacheQuery },
      );
      // A query variant past the route's budget, or a request for a host the
      // store has no room for, is served fresh and never written, so minting
      // `?x=1`, `?x=2`, ... or arbitrary `Host` headers cannot grow the store.
      if (
        admitPageCacheHost(
          store,
          renderContext.url.host,
          renderContext.origin?.canonical === true,
          ttlMs,
        ) &&
        (!queried || admitQueryVariant(store, entry.route, baseKey, ttlMs))
      ) {
        const tags = resolvePageTags(page);
        // What the miss path's own `load()` did, so a failure of the cache can
        // be told apart from a failure of the page: `load()` runs at most once
        // per request, and its error reaches the caller unchanged.
        const miss: { loaded?: unknown; failed: boolean; error?: unknown } = {
          failed: false,
        };
        try {
          const key = await versionedPageCacheKey(store, baseKey, entry.route, tags);
          const cached = await readThroughPageCache(store, key, ttlMs, async () => {
            // Recorded on a miss only: the index lets revalidation delete the
            // entry early; the generation in the key is what makes it stale.
            recordPageCacheKey(store, key, entry.route, tags, ttlMs);
            try {
              miss.loaded = await loadPageProps(page, renderContext);
            } catch (error) {
              miss.failed = true;
              miss.error = error;
              throw error;
            }
            // A reply leaves through the catch below, so nothing is written.
            if (isPageReply(miss.loaded)) throw NOT_STORED;
            return JSON.stringify(miss.loaded);
          });
          return JSON.parse(cached) as unknown;
        } catch {
          if (miss.failed) throw miss.error;
          // A cache backend error, serialization failure, or any other caching
          // issue is never a source of errors: serve the props this request
          // already loaded, or load them fresh when the miss never ran.
          if (miss.loaded !== undefined) return miss.loaded;
        }
      }
    }
  }
  return loadPageProps(page, renderContext);
}

/**
 * Whether a request is anonymous enough to share cached props: no resolved
 * session, no `Authorization` header, and no ambient tenant (or tenant-scope
 * override). Each of those may change what `load()` returns without changing
 * the URL, and the cache key is built from the URL alone.
 */
function sharesAnonymousProps(context: RequestContext): boolean {
  if (context.session !== null && context.session !== undefined) return false;
  if (context.request.headers.has('authorization')) return false;
  const tenant = tenantScopeState();
  return tenant.tenantId === undefined && !tenant.unscoped;
}

/** Resolve a page's optional `tags` export to an array of string tags. */
function resolvePageTags(page: PageModule): readonly string[] {
  const tags = page.tags;
  if (tags === undefined) return [];
  if (typeof tags === 'function') {
    return [];
  }
  if (!Array.isArray(tags)) return [];
  return tags.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0);
}

/**
 * Thrown by the props cache's loader to keep a reply out of the store; a
 * request sharing that load then runs its own.
 */
const NOT_STORED: Error = new Error('a page reply is not stored in the props cache');

/** Call `page.load` (or return `{}` when absent) to produce the raw props or a reply. */
function loadPageProps(page: PageModule, renderContext: RequestContext): Awaitable<unknown> {
  return page.load === undefined ? {} : page.load(renderContext);
}

/**
 * Resolve a page's {@link PageMetadata}. `generateMetadata` wins over a static
 * `metadata` object; a `metadata` function is awaited. Absent metadata resolves
 * to an empty object so the runtime `seo` defaults still apply.
 */
export async function resolvePageMetadata(
  page: PageModule,
  renderContext: RequestContext,
): Promise<PageMetadata> {
  if (page.generateMetadata !== undefined) {
    return page.generateMetadata(renderContext);
  }
  const declared = page.metadata;
  if (typeof declared === 'function') {
    return declared(renderContext);
  }
  return declared ?? {};
}

/** Validate that an optional module export is a function when present. */
function assertOptionalFunction(record: Record<string, unknown>, name: string, file: string): void {
  const value = record[name];
  if (value !== undefined && typeof value !== 'function') {
    throw new PageRenderError(
      'invalid_module',
      `page module "${file}" export "${name}" must be a function`,
    );
  }
}

/** Validate that an optional `metadata` export is an object or a function. */
function assertOptionalMetadata(record: Record<string, unknown>, file: string): void {
  const value = record['metadata'];
  if (value === undefined) return;
  if (typeof value === 'function' || isPlainObject(value)) return;
  throw new PageRenderError(
    'invalid_module',
    `page module "${file}" export "metadata" must be an object or a function`,
  );
}

/** Validate that the optional `revalidate` export is a positive finite number when present. */
function assertOptionalRevalidate(record: Record<string, unknown>, file: string): void {
  const value = record['revalidate'];
  if (value !== undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new PageRenderError(
        'invalid_module',
        `page module "${file}" export "revalidate" must be a positive number`,
      );
    }
  }
}

/**
 * Validate that the optional `cacheQuery` export is an array of non-empty
 * strings: the query parameter names that participate in the page cache key.
 */
function assertOptionalCacheQuery(record: Record<string, unknown>, file: string): void {
  const value = record['cacheQuery'];
  if (value === undefined) return;
  if (
    Array.isArray(value) &&
    value.every((name: unknown) => typeof name === 'string' && name !== '')
  ) {
    return;
  }
  throw new PageRenderError(
    'invalid_module',
    `page module "${file}" export "cacheQuery" must be an array of non-empty strings`,
  );
}

/**
 * Validate the optional `stream` export: `true` streams the page's render,
 * and a function is a progressive stream producer. Pages are buffered by
 * default, so `false` would say nothing and is refused like any other value.
 */
function assertOptionalStream(record: Record<string, unknown>, file: string): void {
  const value = record['stream'];
  if (value === undefined || value === true || typeof value === 'function') return;
  throw new PageRenderError(
    'invalid_module',
    `page module "${file}" export "stream" must be true or a function`,
  );
}

/**
 * Validate that the optional `cache` export is the literal `'public'` when
 * present. Any other value is rejected at load time rather than silently
 * disabling caching, so a typo cannot quietly turn a shared page into an
 * uncached one (or vice versa).
 */
function assertOptionalCache(record: Record<string, unknown>, file: string): void {
  const value = record['cache'];
  if (value !== undefined && value !== 'public') {
    throw new PageRenderError(
      'invalid_module',
      `page module "${file}" export "cache" must be "public" when present`,
    );
  }
}

/**
 * Return the rendered HTML unchanged when the emitted root is an `<html>`
 * element, otherwise wrap it in a minimal document so the route still emits
 * valid HTML. Detection reads the maintained renderer's actual output, so it is
 * correct regardless of how many component layers produced the root; escaped
 * text cannot spoof it because a literal `<` in text is emitted as `&lt;`.
 */
function withDocumentShell(html: string): string {
  if (/^<html[\s>]/i.test(html.trimStart())) return html;
  return `<html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
}
