/**
 * Filesystem page route registration, and the page terminal: a renderer's
 * {@link PageOutcome} mapped one to one onto a response body.
 *
 * Each page module is loaded and validated through the renderer's loader
 * (`loadPageModule`, the route module importer), so the module the route
 * reads its declarations from is the one the renderer renders. Its optional
 * `middleware` export (a list of middleware functions, validated at
 * registration) runs after the access chain, then the renderer, behind one
 * compiled route boundary per path.
 *
 * Access: a page's `route` export (`definePage(path, { access, timeoutMs })`)
 * states its access and, optionally, its deadline; its path must be the
 * file's route. A page without one is public and its loader owns any
 * decision, as before.
 *
 * Outcomes: a document's bytes are a recorded byte body (`text/html` unless
 * the renderer chose a type), with the status and headers the page chose,
 * one `Set-Cookie` per cookie; a document's stream is a recorded stream the
 * finalizer reads inside the request, bounded by the route's idle timeout,
 * and reports when it fails; a redirect is an empty body with its
 * `Location`; not-found is `request.not_found`, which the app's not-found
 * page answers. Only a document at 200 carrying no header of its own may
 * take the page's public `cacheControl`; every other outcome is sent
 * `private, no-store`. A failure the renderer handled itself (an error
 * boundary's 500, a streamed document's late failure) is reported through
 * the frame with the route pattern and the request id.
 *
 * Pages are buffered. `export const stream = true` streams the page's render
 * and a `stream` function is a progressive producer; either is refused
 * beside a `cache` or `cacheControl` export, because a streamed `200` is
 * sent before the document is complete and a late failure would be stored
 * and served to every visitor.
 */

import { publicAccess, type AccessRef } from '../api/access-ref.js';
import { isPageDefinition } from '../api/route-definition.js';
import { bytesResponse, emptyResponse, streamResponse, utf8 } from '../api/response-bodies.js';
import { stream as streamBody } from '../api/responses.js';
import type { PageDocumentBody, PageOutcome, PageRenderer } from '../contracts/render.js';
import { notFound } from '../errors/kernel.js';
import { loadPageModule, PageRenderError } from '../pages/page.js';
import { isDocumentStatus } from '../pages/reply.js';
import { STREAM_TIMEOUT_MS } from '../pages/streaming-render.js';
import { validateMiddlewareList } from '../routing/middleware.js';
import type { RouteManifestEntry } from '../routing/routes.js';
import { isRedirectLocation, isRedirectStatus } from '../url/redirect-target.js';
import { resolveRoutePaths, type LocaleRouteOptions } from './route-paths.js';
import { extractCacheControlDeclaration, PRIVATE_NO_STORE } from './cache-control.js';
import type { RegisterRoute, RouteTerminal } from './route-boundary.js';
import { isTimeoutMs } from './route-limits.js';
import { patternSlot, RouteErrors } from './route-meta.js';

/** The access of a page without a `route` export. */
const PAGE_ACCESS = publicAccess('public page; its loader decides');

/** The credentials a page accepts: the session cookie its loader reads. */
const PAGE_CREDENTIALS = Object.freeze(['cookie'] as const);

/** The app-level inputs every page route shares. */
export interface PageRouteOptions {
  readonly renderer: PageRenderer;
  readonly localeOptions: LocaleRouteOptions | undefined;
  /**
   * Milliseconds a streamed page's suspended subtrees have after the shell,
   * and the most a page's stream producer may go between two chunks.
   */
  readonly streamTimeoutMs?: number;
}

/** Load one page module and register every path it answers. */
export async function registerPageRoutes(
  register: RegisterRoute,
  entry: RouteManifestEntry,
  options: PageRouteOptions,
): Promise<void> {
  const { renderer } = options;
  const module = await loadPageModule(entry.file);
  const middleware =
    validateMiddlewareList(module.middleware, (message) => {
      return new Error(`page route "${entry.route}" ${message}`);
    }) ?? [];
  const { access, timeoutMs } = pageDeclaration(entry, module.route);

  const cacheControl = extractCacheControlDeclaration(
    entry.route,
    module as unknown as Record<string, unknown>,
  );

  const producer = module.stream;
  if (producer !== undefined && producer !== true && typeof producer !== 'function') {
    throw new PageRenderError(
      'invalid_module',
      `page route "${entry.route}" export "stream" must be true or a function`,
    );
  }
  const streamed = producer !== undefined;
  if (streamed && (cacheControl !== undefined || module.cache !== undefined)) {
    throw new PageRenderError(
      'invalid_module',
      `page route "${entry.route}" cannot both stream and declare a cache`,
    );
  }
  const streamTimeoutMs = options.streamTimeoutMs ?? STREAM_TIMEOUT_MS;

  const terminal: RouteTerminal = async ({ frame }, ctx) => {
    if (typeof producer === 'function') {
      // The producer's failures error the stream, which the finalizer reports.
      return streamBody(await producer(ctx), { headers: STREAM_HEADERS });
    }
    // A failure the renderer handles while this terminal runs (an error
    // boundary's) belongs to the handler; one after it returned can only be a
    // streamed document's, past the head.
    let returned = false;
    const outcome = await renderer.render(entry, ctx, {
      staticMode: false,
      ...(streamed ? { stream: true, timeoutMs: streamTimeoutMs } : {}),
      onError: (error) => frame.report(error, returned ? 'stream' : 'handler'),
    });
    returned = true;
    return outcomeResponse(entry, outcome);
  };
  for (const pattern of resolveRoutePaths(entry, options.localeOptions)) {
    register(
      {
        kind: 'page',
        pattern,
        methods: ['GET'],
        access,
        credentials: PAGE_CREDENTIALS,
        surface: 'page',
        ...(cacheControl === undefined ? {} : { cache: cacheControl }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        // A rendered stream ends itself at its deadline, closing the document;
        // a producer is arbitrary code, so the finalizer bounds its silences.
        ...(typeof producer === 'function' ? { stream: { timeoutMs: streamTimeoutMs } } : {}),
        owner: 'app',
        origin: 'app',
      },
      { middleware, terminal },
    );
  }
}

/** A page's access and deadline: its `definePage` export's, else public with the app's. */
function pageDeclaration(
  entry: RouteManifestEntry,
  route: unknown,
): { readonly access: AccessRef; readonly timeoutMs?: number } {
  if (route === undefined) return { access: PAGE_ACCESS };
  const pattern = patternSlot(entry.route);
  if (!isPageDefinition(route)) {
    throw new RouteErrors.Error('invalid_definition', { pattern, problem: 'invalid_route_export' });
  }
  if (route.path !== entry.route) throw new RouteErrors.Error('pattern_mismatch', { pattern });
  const { timeoutMs } = route;
  if (timeoutMs === undefined) return { access: route.access };
  if (!isTimeoutMs(timeoutMs)) {
    throw new RouteErrors.Error('invalid_definition', { pattern, problem: 'invalid_timeout' });
  }
  return { access: route.access, timeoutMs };
}

const HTML = 'text/html; charset=utf-8';

/** A buffering reverse proxy would otherwise hold a streamed page until it ends. */
const STREAM_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': HTML,
  'x-accel-buffering': 'no',
});

/**
 * The response for `outcome`, one body kind per outcome kind.
 *
 * A page's `cacheControl` declares its rendered page public, so only that
 * may take it: a document at 200 that carries no header but its content
 * type. Every other answer is the request's own and is sent
 * `private, no-store` unless the renderer chose its own `Cache-Control`: a
 * redirect (a `load` that sends a signed-out visitor to `/login` must not
 * be stored for the signed-in ones), a document with another status (a
 * `reply.props` status or an error boundary's), and a document with the
 * headers or cookies a reply chose. The finalizer then applies the cache
 * policy, under which a `Set-Cookie` always makes the answer private.
 */
function outcomeResponse(entry: RouteManifestEntry, answered: PageOutcome): Response {
  // A custom renderer is checked at runtime: its outcome may not be one.
  const outcome = answered as PageOutcome | null | undefined;
  switch (outcome?.kind) {
    case 'document': {
      const { status, headers } = outcome;
      const body: PageDocumentBody | undefined = outcome.body;
      if (!isDocumentStatus(status) || !(headers instanceof Headers)) break;
      const answer = new Headers(headers);
      if (status !== 200 || [...answer.keys()].some((name) => name !== 'content-type')) {
        keepPrivate(answer);
      }
      if (!answer.has('content-type')) answer.set('content-type', HTML);
      if (body?.kind === 'bytes' && typeof body.html === 'string') {
        return bytesResponse(utf8(body.html), { status, headers: answer });
      }
      if (body?.kind === 'stream' && body.stream instanceof ReadableStream) {
        answer.set('x-accel-buffering', 'no');
        return streamResponse(body.stream, { status, headers: answer }, { reports: true });
      }
      break;
    }
    case 'redirect': {
      const { status, location } = outcome;
      if (!isRedirectStatus(status) || !isRedirectLocation(location)) break;
      return emptyResponse({
        status,
        headers: { location, 'cache-control': PRIVATE_NO_STORE },
      });
    }
    case 'not-found':
      throw notFound();
  }
  throw new PageRenderError(
    'invalid_render',
    `page route "${entry.route}" renderer did not answer with a page outcome`,
  );
}

/** Mark an answer no cache may store, unless the renderer chose its own policy. */
function keepPrivate(headers: Headers): void {
  if (!headers.has('cache-control')) headers.set('cache-control', PRIVATE_NO_STORE);
}
