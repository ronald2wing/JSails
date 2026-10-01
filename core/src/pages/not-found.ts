/**
 * The `not-found` page convention: an app's own page for unmatched URLs.
 *
 * Route discovery lists every `pages/**` `not-found` module with the URL scope
 * of its directory ({@link RouteManifest.notFound}). {@link matchNotFoundPage}
 * picks the nearest one for a path, and {@link createNotFoundErrorPage} turns
 * the set into an {@link ErrorPageRenderer}: a 404 for a browser navigation is
 * rendered through the app's page renderer, with the module's layouts and
 * `load`, while every other status, and a 404 outside every scope, goes to the
 * app's own `errorPage` or the framework's built-in page. The response status
 * stays the caller's (404), never the 200 of a normal page render.
 *
 * A not-found page answers arbitrary URLs, so it may not declare
 * `cache: 'public'`: every mistyped path would otherwise become a new entry in
 * the shared props cache. Nor may it export `middleware`: an error page renders
 * outside any route, so a per-route guard would never run, and a nested
 * `pages/admin/not-found` would show its layouts and `load` to anyone. It
 * renders a plain document: the error page's answer has the failure's status
 * and no headers of its own, so a redirect, a header or a cookie would be lost.
 */

import type { RequestContext } from '../contracts/http.js';
import type { PageOutcome, PageRenderer } from '../contracts/render.js';
import type {
  NotFoundManifestEntry,
  RouteManifest,
  RouteManifestEntry,
} from '../routing/routes.js';
import {
  builtInErrorPage,
  type ErrorPageRenderer,
  type PublicError,
} from '../server/error-pages.js';
import { documentHtml, loadPageModule, PageRenderError } from './page.js';

/** Options for {@link createNotFoundErrorPage}. */
export interface NotFoundErrorPageOptions {
  /** The manifest whose `notFound` pages answer 404s. */
  readonly manifest: RouteManifest;
  /** Renders a not-found page exactly like any other page route. */
  readonly renderer: PageRenderer;
  /** Answers every other error, and a 404 no scope covers. Defaults to the built-in page. */
  readonly fallback?: ErrorPageRenderer;
  /** Locale prefixes stripped before a path is matched against the scopes. */
  readonly locales?: readonly string[];
}

/**
 * The nearest not-found page for `pathname`: the most specific scope whose
 * segments prefix the path (a `:param` scope segment matches any one
 * decodable segment).
 * A leading segment naming one of `locales` is ignored. `undefined` when no
 * scope covers the path or the manifest has no not-found pages.
 */
export function matchNotFoundPage(
  manifest: RouteManifest,
  pathname: string,
  locales: readonly string[] = [],
): NotFoundManifestEntry | undefined {
  return matchNotFoundScope(manifest, pathname, locales)?.entry;
}

/** A matched not-found page and the path segments its `:param` scope segments captured. */
interface NotFoundMatch {
  readonly entry: NotFoundManifestEntry;
  readonly params: Readonly<Record<string, string>>;
}

function matchNotFoundScope(
  manifest: RouteManifest,
  pathname: string,
  locales: readonly string[],
): NotFoundMatch | undefined {
  const entries = manifest.notFound;
  if (entries === undefined || entries.length === 0) return undefined;
  let segments = pathname.split('/').filter((segment) => segment !== '');
  if (segments.length > 0 && locales.includes(segments[0]!)) segments = segments.slice(1);
  const decoded = segments.map(decodeSegment);
  for (const entry of entries) {
    const params = scopeParams(entry.scope, decoded);
    if (params !== undefined) return { entry, params };
  }
  return undefined;
}

/**
 * Build an {@link ErrorPageRenderer} that renders the nearest not-found page
 * for a 404. Returns `fallback` unchanged when the manifest declares no
 * not-found page, so an app without one keeps its current behavior.
 */
export function createNotFoundErrorPage(
  options: NotFoundErrorPageOptions,
): ErrorPageRenderer | undefined {
  const { manifest, renderer, fallback, locales = [] } = options;
  if (manifest.notFound === undefined || manifest.notFound.length === 0) return fallback;
  const answerOtherwise = (error: PublicError, context: RequestContext) =>
    fallback === undefined ? builtInErrorPage(error) : fallback(error, context);

  return async (error, context) => {
    if (error.status !== 404) return answerOtherwise(error, context);
    const match = matchNotFoundScope(manifest, context.url.pathname, locales);
    if (match === undefined) return answerOtherwise(error, context);
    // The incoming context carries the params of whichever route threw (or
    // none for an unmatched URL); the page sees its own scope's params instead.
    return renderNotFoundPage(match.entry, renderer, withParams(context, match.params), false);
  };
}

/**
 * `context` with `params` replaced. Every other field keeps its descriptor,
 * so a field the caller exposes through a getter (to learn whether the page
 * read it) is not read here.
 */
function withParams(
  context: RequestContext,
  params: Readonly<Record<string, string>>,
): RequestContext {
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(context),
      params: { value: { ...params }, enumerable: true, configurable: true, writable: false },
    },
  ) as RequestContext;
}

/**
 * Render one not-found page through `renderer`. Used for live 404s and, with
 * `staticMode`, for the static export's `404.html`.
 */
export async function renderNotFoundPage(
  match: NotFoundManifestEntry,
  renderer: PageRenderer,
  context: RequestContext,
  staticMode: boolean,
): Promise<string> {
  const page = await loadPageModule(match.file);
  if (page.default === undefined) {
    throw new PageRenderError(
      'invalid_module',
      `not-found page "${match.file}" default export must be a function`,
    );
  }
  if (page.cache === 'public') {
    throw new PageRenderError(
      'invalid_module',
      `not-found page "${match.file}" must not declare cache: 'public'`,
    );
  }
  if (page.middleware !== undefined && page.middleware.length > 0) {
    throw new PageRenderError(
      'invalid_module',
      `not-found page "${match.file}" must not declare middleware`,
    );
  }
  const outcome: PageOutcome | undefined = await renderer.render(
    notFoundRouteEntry(match),
    context,
    { staticMode },
  );
  // An error page answers with the failure's status and no headers of its
  // own, so a not-found page renders a plain document: a redirect, another
  // not-found, a header or a cookie would be lost.
  if (
    outcome?.kind !== 'document' ||
    !(outcome.headers instanceof Headers) ||
    [...outcome.headers.keys()].some((name) => name !== 'content-type')
  ) {
    throw new PageRenderError(
      'invalid_render',
      `not-found page "${match.file}" must render a document without headers or cookies`,
    );
  }
  return documentHtml(outcome.body);
}

/** The page entry a renderer receives for a not-found page: its scope and that scope's params. */
export function notFoundRouteEntry(match: NotFoundManifestEntry): RouteManifestEntry {
  const params = scopeSegments(match.scope)
    .filter((part) => part.startsWith(':'))
    .map((part) => part.slice(1));
  return {
    kind: 'page',
    route: match.scope,
    file: match.file,
    dynamic: params.length > 0,
    catchAll: false,
    params,
    layouts: match.layouts,
    ...(match.errorBoundary !== undefined ? { errorBoundary: match.errorBoundary } : {}),
  };
}

function scopeSegments(scope: string): string[] {
  return scope === '/' ? [] : scope.slice(1).split('/');
}

/**
 * The params a scope captures from `segments` when every scope segment matches
 * the path segment at its position, otherwise `undefined`. A `:param` segment
 * needs a decodable path segment, so a malformed escape never becomes a value.
 */
function scopeParams(
  scope: string,
  segments: readonly (string | undefined)[],
): Record<string, string> | undefined {
  const parts = scopeSegments(scope);
  if (parts.length > segments.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, part] of parts.entries()) {
    const segment = segments[index];
    if (part.startsWith(':')) {
      if (segment === undefined) return undefined;
      params[part.slice(1)] = segment;
    } else if (segment !== part) {
      return undefined;
    }
  }
  return params;
}

/**
 * Decode one percent-encoded path segment so it compares with the literal
 * scope segment; a malformed escape matches no static segment.
 */
function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}
