/**
 * Minimal {@link RequestContext} factory for generated and hand-written unit
 * tests.
 *
 * Route handlers and page `load` functions receive a `RequestContext`, not a
 * Hono context. Tests that call those functions directly should not have to
 * construct a fake one by hand. This helper builds the same context shape the
 * request pipeline builds, with a real `Request` and an inert session.
 */

import { createRequestContext } from '../server/request-pipeline.js';

import type { Session, RequestContext } from '../contracts/http.js';

/** Options for {@link createTestRequestContext}. */
export interface TestRequestContextOptions {
  /** Absolute request URL. Defaults to `http://localhost/`. */
  readonly url?: string | URL;
  /** HTTP method. Defaults to `GET`. */
  readonly method?: string;
  /** Request headers. */
  readonly headers?: HeadersInit;
  /** Route parameters, keyed by name. Defaults to `{}`. */
  readonly params?: Record<string, string>;
  /** Session to expose on the context. Defaults to `null`. */
  readonly session?: Session | null;
  /** Public origin used by asset and SEO helpers. */
  readonly publicOrigin?: string;
}

/**
 * Build a real `RequestContext` for a unit test.
 *
 * The returned context carries a live `Request`; mutate nothing global. The
 * default URL is deliberately absolute because `Request` rejects relative URLs
 * and page code may read `context.url`.
 */
export function createTestRequestContext(options: TestRequestContextOptions = {}): RequestContext {
  const url = options.url === undefined ? new URL('http://localhost/') : new URL(options.url);
  const request = new Request(url, {
    method: options.method ?? 'GET',
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });

  return createRequestContext({
    request,
    url,
    params: options.params ?? {},
    session: options.session ?? null,
    ...(options.publicOrigin === undefined ? {} : { publicOrigin: options.publicOrigin }),
  });
}
