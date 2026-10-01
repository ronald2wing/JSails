/**
 * HTML not-found and error pages for browser navigations.
 *
 * The JSON envelope is the right answer for an API client, but a visitor who
 * mistypes a URL or hits a failing page should see a page, not
 * `{"error":{...}}`. {@link prefersHtml} picks HTML only when the request
 * explicitly lists `text/html` (a browser navigation does; `fetch()` sends
 * `*\/*`) at least as strongly as JSON, and never for an API or framework
 * path, so API clients keep the envelope whatever they send.
 *
 * The page shows only public facts — the status and the generic status text,
 * or an `HttpError`'s own message, which is public by contract — escaped. An
 * app may supply its own renderer (`errorPage`); when that renderer throws,
 * the built-in page is served instead.
 */

import { HttpError, type RequestContext } from '../contracts/http.js';
import type { Awaitable } from '../contracts/awaitable.js';
import { escapeHtml } from '../support/strings.js';
import { acceptQuality } from './content-negotiation.js';

/** The public facts an error page may show. */
export interface PublicError {
  readonly status: number;
  readonly message: string;
}

/**
 * An app-supplied error page: returns the HTML document for `error`. It runs
 * for 404s and failures of browser navigations; a throw falls back to the
 * built-in page.
 */
export type ErrorPageRenderer = (error: PublicError, context: RequestContext) => Awaitable<string>;

/** Path segments that always answer with the JSON envelope. */
const FRAMEWORK_SEGMENTS = ['api', '_jsails'];

const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  413: 'Payload Too Large',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

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

/** True when the request is a browser navigation that should get an HTML page. */
export function prefersHtml(request: Request, isApiPath: (path: string) => boolean): boolean {
  if (isApiPath(new URL(request.url).pathname)) return false;
  const accept = request.headers.get('accept');
  const html = Math.max(
    acceptQuality(accept, 'text/html'),
    acceptQuality(accept, 'application/xhtml+xml'),
  );
  return html > 0 && html >= acceptQuality(accept, 'application/json');
}

/** The public facts of a thrown value: an `HttpError`'s own, otherwise a generic 500. */
export function toPublicError(error: unknown): PublicError {
  if (error instanceof HttpError) {
    return { status: error.status, message: error.message };
  }
  return { status: 500, message: statusText(500) };
}

/** The generic text for a status code. */
export function statusText(status: number): string {
  return STATUS_TEXT[status] ?? (status >= 500 ? 'Server Error' : 'Error');
}

/** The framework's minimal, dependency-free error document. */
export function builtInErrorPage(error: PublicError): string {
  const title = `${error.status} ${escapeHtml(statusText(error.status))}`;
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${title}</title>` +
    '<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222}' +
    'h1{font-size:1.5rem}@media (prefers-color-scheme:dark){body{background:#111;color:#ddd}}</style>' +
    `</head><body><h1>${title}</h1><p>${escapeHtml(error.message)}</p></body></html>`
  );
}

/** Wrap an error document in a never-cached HTML response with the error's status. */
export function htmlErrorResponse(status: number, html: string): Response {
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
