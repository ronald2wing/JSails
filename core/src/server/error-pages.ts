/**
 * HTML error pages: the public facts a page may show, the app's renderer
 * type, the framework's built-in page, and the two questions that pick HTML
 * over the problem envelope. {@link prefersHtml} answers yes only when the
 * request lists `text/html` (a browser navigation does; `fetch()` sends
 * `*\/*`) at least as strongly as JSON; {@link createApiPathMatcher} tells an
 * API or framework path, which always gets the envelope.
 *
 * A leaf: the static export's 404 page and the not-found pages load it
 * without the request pipeline. The failure renderer that uses it is
 * `failure-renderer.ts`.
 */

import type { Awaitable } from '../contracts/awaitable.js';
import type { RequestContext } from '../contracts/http.js';
import { statusTitle } from '../errors/problem-document.server.js';
import { escapeHtml } from '../support/strings.js';
import { acceptQuality } from './content-negotiation.js';

/**
 * The public facts an error page may show.
 *
 * @public
 */
export interface PublicError {
  readonly status: number;
  readonly message: string;
}

/**
 * An app-supplied error page: returns the HTML document for `error`. It runs
 * for failures answered with HTML; a throw falls back to the built-in page.
 *
 * @public
 */
export type ErrorPageRenderer = (error: PublicError, context: RequestContext) => Awaitable<string>;

/** Path segments that always answer with the problem envelope. */
const FRAMEWORK_SEGMENTS = ['api', '_jsails'];

/** Build the matcher that tells an API/framework path from a page path. */
export function createApiPathMatcher(
  apiRoutes: readonly string[],
  locales: readonly string[] | undefined,
): (path: string) => boolean {
  const apiSegments = new Set(FRAMEWORK_SEGMENTS);
  for (const route of apiRoutes) {
    const first = route.split('/')[1];
    if (first !== undefined && first !== '') apiSegments.add(first);
  }
  const localeSet = new Set(locales ?? []);
  return (path) => {
    const segments = path.split('/');
    const first = segments[1] ?? '';
    if (apiSegments.has(first)) return true;
    return localeSet.has(first) && apiSegments.has(segments[2] ?? '');
  };
}

/** True when `request` lists HTML at least as strongly as JSON. */
export function prefersHtml(request: Request): boolean {
  const accept = request.headers.get('accept');
  const html = Math.max(
    acceptQuality(accept, 'text/html'),
    acceptQuality(accept, 'application/xhtml+xml'),
  );
  return html > 0 && html >= acceptQuality(accept, 'application/json');
}

/** The framework's minimal, dependency-free error document. */
export function builtInErrorPage(error: PublicError): string {
  const title = `${error.status} ${escapeHtml(statusTitle(error.status))}`;
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${title}</title>` +
    '<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222}' +
    'h1{font-size:1.5rem}@media (prefers-color-scheme:dark){body{background:#111;color:#ddd}}</style>' +
    `</head><body><h1>${title}</h1><p>${escapeHtml(error.message)}</p></body></html>`
  );
}
