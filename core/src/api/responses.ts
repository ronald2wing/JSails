/**
 * Human-first HTTP response helpers.
 *
 * `Respond` builds web-standard `Response` objects with the correct
 * content type, a safe `Location` header, or a `Content-Disposition` filename.
 * Callers can still return a raw `Response`; these helpers cover the common
 * cases without hiding the platform.
 *
 * Browser-safe: this module uses only web-standard types and the support
 * toolkit, so it belongs to the `jsails/api` graph.
 */

import { assertRedirectTarget } from '../internal/redirect.js';
import { contentDisposition } from '../support/urls.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function withDefaultHeaders(
  init: ResponseInit | undefined,
  defaults: Readonly<Record<string, string>>,
): Headers {
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(defaults)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return headers;
}

/** A JSON response (`application/json; charset=utf-8`). `undefined` becomes `null`. */
export function json(data: unknown, init?: ResponseInit): Response {
  const serialized = JSON.stringify(data);
  return new Response(serialized === undefined ? 'null' : serialized, {
    ...init,
    headers: withDefaultHeaders(init, { 'content-type': 'application/json; charset=utf-8' }),
  });
}

/** An HTML response (`text/html; charset=utf-8`). */
export function html(markup: string, init?: ResponseInit): Response {
  return new Response(markup, {
    ...init,
    headers: withDefaultHeaders(init, { 'content-type': 'text/html; charset=utf-8' }),
  });
}

/** A plain-text response (`text/plain; charset=utf-8`). */
export function text(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    ...init,
    headers: withDefaultHeaders(init, { 'content-type': 'text/plain; charset=utf-8' }),
  });
}

/** An XML response (`application/xml; charset=utf-8`) for feeds and sitemaps. */
export function xml(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    ...init,
    headers: withDefaultHeaders(init, { 'content-type': 'application/xml; charset=utf-8' }),
  });
}

/**
 * A redirect response. Defaults to `303 See Other` (the correct status after a
 * mutation); pass `{ status: 302 }` (or another redirect status) to override.
 * The target is validated by the shared redirect guard.
 */
export function redirect(location: string, init?: ResponseInit): Response {
  const target = assertRedirectTarget(location);
  const status = init?.status ?? 303;
  if (!REDIRECT_STATUSES.has(status)) {
    throw new TypeError('redirect status must be 301, 302, 303, 307, or 308');
  }

  const headers = new Headers(init?.headers);
  headers.set('location', target);
  return new Response(null, { ...init, status, headers });
}

/** An empty response; `204 No Content` by default. */
export function noContent(init?: ResponseInit): Response {
  const status = init?.status ?? 204;
  if (status !== 204 && status !== 205 && status !== 304) {
    throw new TypeError('noContent status must be 204, 205, or 304');
  }
  return new Response(null, { ...init, status, headers: new Headers(init?.headers) });
}

/**
 * A file-download response. The filename is emitted through the RFC 5987-safe
 * `Content-Disposition` helper; the content type defaults to
 * `application/octet-stream` and can be overridden through `init.headers`.
 */
export function download(body: BodyInit | null, filename: string, init?: ResponseInit): Response {
  return new Response(body, {
    ...init,
    headers: withDefaultHeaders(init, {
      'content-type': 'application/octet-stream',
      'content-disposition': contentDisposition(filename),
    }),
  });
}

/** The frozen response-helper namespace. */
export const Respond = Object.freeze({
  json,
  html,
  text,
  xml,
  redirect,
  noContent,
  download,
});
