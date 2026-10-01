/**
 * Compiled filesystem page loading and synchronous server-side rendering.
 *
 * This is the runtime half of the page route story: the manifest supplies a
 * `RouteManifestEntry`, {@link loadPageModule} imports the already-compiled
 * `.js`/`.mjs` module (never TypeScript, never a transformer), and
 * {@link renderRoute} resolves `load`, invokes the default component, and
 * renders through the thin Preact wrapper. {@link renderRouteStream} runs the
 * same steps and streams the document instead (see `streaming-render.ts`).
 *
 * Boundaries:
 * - No bespoke HTML escaping or JSX parsing: rendering and escaping are
 *   Preact's. Only a doctype and, when the root is not `<html>`, a minimal
 *   document shell are prepended by hand.
 * - Normal ESM import semantics apply: modules are cached process-globally by
 *   Node, so there is no hot-reload or per-request module re-evaluation.
 * - `staticMode` rejects a default component annotated `SERVER_ONLY`. It does
 *   NOT enforce annotations on nested components or elements — the server
 *   component runtime does not exist yet.
 *
 * Setup-time failures surface as {@link PageRenderError}; the HTTP layer turns
 * any non-validation error into a generic 500, so these messages are for logs
 * and build tooling, not for response bodies.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { extname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Fragment, h, type VNode } from 'preact';

import { tryResolveCacheStore } from './cache-resolver.js';
import { recordPageCacheKey } from './revalidate.js';
import {
  admitPageCacheHost,
  admitQueryVariant,
  describePageCacheKey,
  PAGE_GENERATION_TTL_MS,
  versionedPageCacheKey,
} from './page-cache.js';
import { tenantScopeState } from '../database/tenant-context.js';
import { formatError } from '../errors/inspect.js';
import { isPlainObject } from '../json/shape.js';
import { SERVER_ONLY, type Component, type RenderChild } from '../contracts/component.js';
import { HttpError, type RequestContext } from '../contracts/http.js';
import type {
  LayoutModule,
  PageModule,
  PageProps,
  PageRenderer,
  PageRenderOptions,
  PageStream,
} from '../contracts/render.js';
import { renderToString } from '../jsx/render-to-string.js';
import { validateMiddlewareList } from '../routing/middleware.js';
import type { RouteManifestEntry } from '../routing/routes.js';
import { resolveSeoService, seoToken } from '../seo/service.js';
import type { PageMetadata } from '../seo/metadata.js';
import { JsailsError } from '../errors/jsails-error.js';
import { STREAM_TIMEOUT_MS, streamDocument } from './streaming-render.js';
import type { Awaitable } from '../contracts/awaitable.js';
import { importFile } from '../support/project-paths.server.js';

/** Stable codes carried by a {@link PageRenderError}. */
export type PageRenderErrorCode =
  | 'invalid_module'
  | 'import_failed'
  | 'invalid_route'
  | 'invalid_props'
  | 'invalid_render'
  | 'render_timeout';

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

/** Extensions accepted by {@link loadPageModule}; TypeScript is rejected. */
const PAGE_EXTENSIONS = new Set(['.js', '.mjs']);

const DOCTYPE = '<!DOCTYPE html>';

/**
 * Validated page and layout modules, keyed by kind and absolute module URL.
 *
 * Node already caches every imported module for the life of the process (the
 * dev runtime restarts its server child instead of re-importing), so a second
 * import of the same file can never observe new code. Memoizing the
 * *validated* result keeps that meaning while sparing each request the path
 * resolution, loader round trip, and export checks. Only successes are kept: a
 * rejected load is retried, and Node's own cache decides what it returns.
 */
const validatedModules = new Map<string, Promise<unknown>>();

function memoizeModule<T>(kind: string, file: string, load: () => Promise<T>): Promise<T> {
  // Invalid paths are rejected by `load` itself; only a usable path is a key.
  if (typeof file !== 'string' || file === '') {
    return load();
  }
  const key = `${kind}:${pathToFileURL(resolve(file)).href}`;
  const cached = validatedModules.get(key);
  if (cached !== undefined) {
    return cached as Promise<T>;
  }
  const pending = load();
  validatedModules.set(key, pending);
  pending.catch(() => {
    validatedModules.delete(key);
  });
  return pending;
}

/**
 * Import and validate a compiled page module.
 *
 * Rejects non-`.js`/`.mjs` paths (in particular `.ts`) before touching the
 * filesystem, then requires a function default export, function-valued
 * `load`/`getStaticPaths` exports when present, and a structurally valid
 * `middleware` export (an array of functions) when present. A failed import is
 * surfaced as a {@link PageRenderError}. A validated module is reused for
 * later calls with the same file.
 */
export function loadPageModule(file: string): Promise<PageModule> {
  return memoizeModule('page', file, () => importPageModule(file));
}

async function importPageModule(file: string): Promise<PageModule> {
  const record = await importCompiledModule(file);
  if (typeof record.default !== 'function') {
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

  return record as unknown as PageModule;
}

/**
 * Import and validate a compiled layout module.
 *
 * Rejects non-`.js`/`.mjs` paths and surfaces import failures as a
 * {@link PageRenderError} — the same path/extension guards shared with
 * {@link loadPageModule} through {@link importCompiledModule}. A layout
 * module differs from a page module only in its contract: it MUST export
 * a function default (the layout component) and carries no `load`,
 * `getStaticPaths`, or `middleware` surface. Memoized like a page module.
 */
export function loadLayoutModule(file: string): Promise<LayoutModule> {
  return memoizeModule('layout', file, async () => {
    const record = await importCompiledModule(file);
    if (typeof record.default !== 'function') {
      throw new PageRenderError(
        'invalid_module',
        `layout module "${file}" default export must be a function`,
      );
    }
    return record as unknown as LayoutModule;
  });
}

/** Import and validate a co-located error boundary module (memoized). */
function loadErrorBoundary(file: string): Promise<ErrorBoundaryComponent> {
  return memoizeModule('error', file, async () => {
    const record = await importCompiledModule(file);
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
 * Import a compiled `.js`/`.mjs` module, rejecting non-compiled paths and
 * surfacing import failures as {@link PageRenderError}. Shared by
 * {@link loadPageModule} so its path/extension and import-failure handling stay
 * identical wherever a page module is loaded.
 */
async function importCompiledModule(file: string): Promise<Record<string, unknown>> {
  if (typeof file !== 'string' || file === '') {
    throw new PageRenderError('invalid_module', 'page module path must be a non-empty string');
  }
  const extension = extname(file).toLowerCase();
  if (!PAGE_EXTENSIONS.has(extension)) {
    throw new PageRenderError(
      'invalid_module',
      `page module "${file}" must be a compiled .js or .mjs file (got "${extension || 'no extension'}")`,
    );
  }

  let imported: unknown;
  try {
    imported = await importFile(file);
  } catch (error) {
    throw new PageRenderError(
      'import_failed',
      `failed to import page module "${file}": ${formatError(error)}`,
    );
  }
  if (imported === null || typeof imported !== 'object') {
    throw new PageRenderError('invalid_module', `page module "${file}" has no module exports`);
  }
  return imported as Record<string, unknown>;
}

/**
 * Render a page manifest entry for one request.
 *
 * Resolves `load` (if any) to a plain props object, awaits the default
 * component, and renders through Preact. The returned string is always prefixed
 * with a doctype: a root `<html>` element is emitted as-is, anything else is
 * wrapped in a minimal document.
 */
export async function renderRoute(
  entry: RouteManifestEntry,
  context: RequestContext,
  options: PageRenderOptions = {},
): Promise<string> {
  const { page, tree, renderContext } = await prepareRoute(entry, context, options);
  const html = renderToString(tree);
  const document = DOCTYPE + withDocumentShell(html);

  const metadata = await resolvePageMetadata(page, renderContext);
  options.onMetadata?.(metadata);
  const seo = resolveSeoService(renderContext.services?.tryGet(seoToken));
  const headTags = seo.buildHeadTags(metadata, renderContext.seo ?? {});
  return headTags === '' ? document : seo.injectHead(document, headTags);
}

/** Options for {@link renderRouteStream}. */
export interface PageStreamRenderOptions extends PageRenderOptions {
  /**
   * Receives a failure that happened after the first chunk was sent. The
   * document is then closed with a generic notice; this hook is the only place
   * the error is seen.
   */
  readonly onError?: (error: unknown) => void;
  /**
   * Milliseconds the suspended subtrees have to finish once the shell is sent
   * (a positive integer, 30 seconds by default). When it passes,
   * the document ends with the generic notice and `onError` receives a
   * `PageRenderError('render_timeout')`.
   */
  readonly timeoutMs?: number;
}

/**
 * Render a page manifest entry as a streamed document.
 *
 * `load`, the page component, the layouts, and the metadata are resolved first,
 * exactly as in {@link renderRoute} (an error boundary included), so every
 * failure there rejects before a byte is sent. The shell, head tags included,
 * is the first chunk; the content of each pending `Suspense` boundary follows
 * as it resolves. `staticMode` is refused: a static file is never streamed.
 */
export async function renderRouteStream(
  entry: RouteManifestEntry,
  context: RequestContext,
  options: PageStreamRenderOptions = {},
): Promise<ReadableStream<Uint8Array>> {
  if (options.staticMode === true) {
    throw new PageRenderError('invalid_render', 'a static render cannot be streamed');
  }
  const timeoutMs = options.timeoutMs ?? STREAM_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new PageRenderError('invalid_render', 'timeoutMs must be a positive integer');
  }
  const { page, tree, renderContext } = await prepareRoute(entry, context, options);
  const metadata = await resolvePageMetadata(page, renderContext);
  options.onMetadata?.(metadata);
  const seo = resolveSeoService(renderContext.services?.tryGet(seoToken));
  const headTags = seo.buildHeadTags(metadata, renderContext.seo ?? {});
  return streamDocument(tree, {
    injectHead: (documentStart) =>
      headTags === '' ? documentStart : seo.injectHead(documentStart, headTags),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
    timeoutMs,
    timeoutError: () =>
      new PageRenderError('render_timeout', 'a streamed page did not finish in time'),
  });
}

/** A page resolved up to the element tree, ready for either renderer. */
interface PreparedRoute {
  readonly page: PageModule;
  readonly tree: VNode;
  readonly renderContext: RequestContext;
}

/**
 * Load the page, resolve its props, and fold its layouts into one element
 * tree. A throw from `load`, the page, or a layout renders the nearest error
 * boundary instead when there is one, and records its status.
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
  const component = page.default as Component<PageProps>;

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

  let props: PageProps;
  let element: RenderChild;
  try {
    props = await resolvePageProps(page, entry, renderContext, options);
    if (!isPlainObject(props)) {
      throw new PageRenderError(
        'invalid_props',
        `page "${entry.route}" load() must resolve to a plain object of props`,
      );
    }
    element = await page.default(props, renderContext);

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
    // Per-route error boundary: a co-located `error.js` (nearest ancestor)
    // catches a page/layout/load throw and renders the error UI instead of
    // the sanitized 500. The boundary is rendered into HTML, so it receives
    // only an `HttpError`'s public status and message; any other throw (which
    // may embed a connection string or other internals) becomes a generic 500.
    if (entry.errorBoundary !== undefined) {
      const boundary = await loadErrorBoundary(entry.errorBoundary);
      const boundaryError = toBoundaryError(error);
      element = await boundary({ error: boundaryError }, renderContext);
      // A boundary always answers with an error status: an `HttpError` built
      // with a 2xx/3xx or out-of-range status is still a failure.
      const status = boundaryError.status;
      boundaryStatuses.set(
        context,
        Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
      );
    } else {
      throw error;
    }
  }

  return { page, tree: h(Fragment, null, element), renderContext };
}

/**
 * The status of the error a boundary rendered, keyed by the request context
 * the caller passed to {@link renderRoute}. The renderer contract returns only
 * HTML, so the HTTP layer reads the status here to answer a boundary-handled
 * `HttpError(404)` with 404 rather than 200 (and a generic failure with 500).
 */
const boundaryStatuses = new WeakMap<RequestContext, number>();

/**
 * The status of the error an error boundary rendered during the last
 * {@link renderRoute} call with `context`, cleared once read; `undefined` when
 * the page rendered normally or a custom renderer bypassed `renderRoute`.
 */
export function takeErrorBoundaryStatus(context: RequestContext): number | undefined {
  const status = boundaryStatuses.get(context);
  boundaryStatuses.delete(context);
  return status;
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

function toBoundaryError(error: unknown): ErrorBoundaryError {
  if (error instanceof HttpError) {
    return { status: error.status, message: error.message };
  }
  return { status: 500, message: 'Internal Server Error' };
}

/**
 * The built-in {@link PageRenderer}. It is a thin adapter over
 * {@link renderRoute}, so the compiled-page loader, the `load`/`getStaticPaths`
 * contract, and Preact's escaping are unchanged; callers that swap in another
 * renderer opt out of all three.
 */
export const preactPageRenderer: StreamingPageRenderer = Object.freeze<StreamingPageRenderer>({
  render(entry, context, options) {
    return renderRoute(entry, context, options);
  },
  renderStream(entry, context, options) {
    return renderRouteStream(entry, context, options);
  },
});

/**
 * A {@link PageRenderer} that can also stream a page. The HTTP layer streams a
 * page only through a renderer with `renderStream`; any other renderer keeps
 * answering with its complete string.
 */
export interface StreamingPageRenderer extends PageRenderer {
  renderStream(
    entry: RouteManifestEntry,
    context: RequestContext,
    options?: PageStreamRenderOptions,
  ): Promise<ReadableStream<Uint8Array>>;
}

/**
 * Wrap a {@link PageStream} into a streaming HTTP response with chunked
 * transfer encoding. Chunks are trusted producer output (never sanitized) —
 * the same trust model as the string renderer.
 *
 * The response carries `Content-Type: text/html; charset=utf-8` (overridable
 * via `headers`) and `X-Accel-Buffering: no` so a buffering reverse proxy
 * flushes each chunk immediately.
 */
export function renderStreamResponse(
  stream: PageStream,
  headers?: HeadersInit,
  options: RenderStreamOptions = {},
): Response {
  let body: ReadableStream<Uint8Array>;

  if (stream instanceof ReadableStream) {
    body = stream;
  } else if (stream instanceof Readable) {
    // A Node `Readable` may be string-mode (emitting string chunks) or
    // byte-mode (emitting Buffer/Uint8Array). Convert through a normalizing
    // async-iterator so every chunk reaches the Response body as bytes:
    // undici's Response rejects non-Uint8Array chunks.
    body = encodeIterable(Readable.toWeb(stream) as AsyncIterable<unknown>, options.onError);
  } else {
    body = encodeIterable(stream, options.onError);
  }

  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has('content-type')) {
    responseHeaders.set('content-type', 'text/html; charset=utf-8');
  }
  responseHeaders.set('x-accel-buffering', 'no');

  return new Response(body, { headers: responseHeaders });
}

/** Options for {@link renderStreamResponse}. */
export interface RenderStreamOptions {
  /**
   * Called once when the producer throws after the response has started. The
   * status line is already sent by then, so the body is errored (the client
   * sees a truncated response) and this hook is the only place the failure
   * can be observed.
   */
  readonly onError?: (error: unknown) => void;
}

/**
 * Convert an async iterable whose chunks are either strings or bytes into a
 * byte-only `ReadableStream` suitable as a Response body. String chunks are
 * UTF-8 encoded; byte chunks (`Uint8Array`/`Buffer`) pass through unchanged so
 * an already-binary source is not double-encoded.
 *
 * The stream is pull-based: the producer is advanced only when the consumer
 * asks for more (honoring backpressure from a slow client, so chunks never
 * pile up in memory), and a cancel — a client disconnect — calls the
 * iterator's `return()` so the producer's `finally` blocks run and its
 * cursors or upstream requests are released.
 *
 * Each pull is driven by the consumer (the HTTP layer writing to the socket),
 * whose async context is not the request's once the handler has returned. The
 * producer is therefore advanced inside a snapshot of the context the stream
 * was built in, so every chunk after the first still sees the request's
 * tenant, locale, request id, and facade scope.
 */
function encodeIterable(
  iterable: AsyncIterable<unknown>,
  onError: ((error: unknown) => void) | undefined,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const inRequestScope = AsyncLocalStorage.snapshot();
  let iterator: AsyncIterator<unknown> | undefined;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          iterator ??= inRequestScope(() => iterable[Symbol.asyncIterator]());
          const source = iterator;
          // Skip chunks of a type the declared PageStream shapes cannot
          // produce, so one malformed chunk cannot corrupt the stream; loop
          // until one chunk is enqueued so a pull always makes progress.
          for (;;) {
            const step = await inRequestScope(() => source.next());
            if (step.done === true) {
              controller.close();
              return;
            }
            const chunk: unknown = step.value;
            if (typeof chunk === 'string') {
              controller.enqueue(encoder.encode(chunk));
              return;
            }
            if (chunk instanceof Uint8Array) {
              controller.enqueue(chunk);
              return;
            }
          }
        } catch (error) {
          reportStreamError(onError, error);
          controller.error(error);
        }
      },
      async cancel(reason) {
        const source = iterator;
        if (source?.return === undefined) return;
        await inRequestScope(() => source.return?.(reason));
      },
    },
    { highWaterMark: 1 },
  );
}

/** Hand a mid-stream failure to the hook; a throwing hook must not mask it. */
function reportStreamError(onError: ((error: unknown) => void) | undefined, error: unknown): void {
  if (onError === undefined) return;
  try {
    onError(error);
  } catch {
    // The original producer error is what errors the body; a broken observer
    // is not allowed to replace it.
  }
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
 * `load()` derived from the caller can never be replayed to someone else.
 */
async function resolvePageProps(
  page: PageModule,
  entry: RouteManifestEntry,
  renderContext: RequestContext,
  options: PageRenderOptions,
): Promise<PageProps> {
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
      // the token its key embeds.
      const ttlMs = Math.min(ttl * 1000, PAGE_GENERATION_TTL_MS);
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
        const miss: { loaded?: PageProps; failed: boolean; error?: unknown } = { failed: false };
        try {
          const key = await versionedPageCacheKey(store, baseKey, entry.route, tags);
          const cached = await store.remember(key, ttlMs, async () => {
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
            return JSON.stringify(miss.loaded);
          });
          return JSON.parse(cached) as PageProps;
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

/** Call `page.load` (or return `{}` when absent) to produce the raw props. */
function loadPageProps(page: PageModule, renderContext: RequestContext): Awaitable<PageProps> {
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
 * Validate the optional `stream` export: a function is a progressive stream
 * producer, and a boolean turns streaming rendering on or off for the page.
 */
function assertOptionalStream(record: Record<string, unknown>, file: string): void {
  const value = record['stream'];
  if (value === undefined || typeof value === 'function' || typeof value === 'boolean') return;
  throw new PageRenderError(
    'invalid_module',
    `page module "${file}" export "stream" must be a function or a boolean`,
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
