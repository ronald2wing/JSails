/**
 * The failure renderer: the one place a {@link Failure} becomes a response.
 *
 * {@link createFailureRenderer} picks the format once per failure. A matched
 * route decides by its kind: an API or framework route answers with the
 * problem envelope, a page with an HTML page, a hook or component route by the
 * request's `Accept` (`prefersHtml`). A request no route entered decides by its
 * path (an API or framework path always gets the envelope) and then `Accept`.
 *
 * The HTML page shows only public facts: the status and its phrase, or the
 * failure's public message, escaped. An app may supply its own page
 * (`errorPage`); it runs at most once per request, inside the request's claim
 * (the only time a failure claims: when app-authored HTML will run), and a
 * throw, a non-string result, or a second failure of the same request gets the
 * built-in page, the throw reported with phase `error-page`. Every answer is
 * bytes, `private, no-store`, and carries the failure's headers (`Allow`,
 * `WWW-Authenticate`, `Retry-After`).
 *
 * Error hot path: the not-found answer (a request no route matched: its 404,
 * or the 405 of a path that answers other methods) for a request with no
 * credential is kept for 60 seconds in a 64-entry in-process LRU, keyed by
 * status, message, origin, path and query, locale and cache partitions, so a
 * burst of misses for the same URL (a missing favicon, a scanner's list)
 * renders once. Only that answer is kept: a 404 or 405 a route raised says
 * what the route decided, which can change from one request to the next. A
 * render that read something only this request has is not kept: the
 * request (its headers and cookies), the client address, the CSP nonce or
 * the session, whether through its context or through the ambient request
 * frame (`currentRequestFrame()`, every field but the URL, origin and app
 * statics), nor is one that ran under a private scope or a cookie-chosen
 * locale. The execution context's request id and trace are not watched: a
 * page that prints them must not be the not-found page of an anonymous URL.
 */

import { failureResponse, type Failure } from '../api/failure-response.js';
import { bytesResponse, utf8 } from '../api/response-bodies.js';
import type { Awaitable } from '../contracts/awaitable.js';
import type { RequestContext } from '../contracts/http.js';
import { statusTitle } from '../errors/problem-document.server.js';
import { PRIVATE_NO_STORE } from './cache-control.js';
import {
  builtInErrorPage,
  prefersHtml,
  type ErrorPageRenderer,
  type PublicError,
} from './error-pages.js';
import { claimForErrorPage, observeFrame, type RequestFrame } from './request-frame.js';

/** Where a failure arose, when the renderer must know. */
export interface FailureOrigin {
  /**
   * True for the not-found answer: no route matched the request (its 404, or
   * the 405 of a path that answers other methods). Only that page may be kept.
   */
  readonly unmatched?: boolean;
  /**
   * True when the request must not be claimed: its claim did not settle and
   * must not be waited on (a deadline passed while it resolved), or the
   * answer refuses the request before anything of it resolves (a body
   * declared longer than its limit resolves no identity, locale or scope).
   * The built-in page answers.
   */
  readonly claimless?: boolean;
}

/** Renders `failure` as the answer to `frame`'s request. */
export type FailureRenderer = (
  frame: RequestFrame,
  failure: Failure,
  origin?: FailureOrigin,
) => Promise<Response>;

/** Options for {@link createFailureRenderer}. */
export interface FailureRendererOptions {
  /** Tells an API or framework path (always the envelope) from a page path. */
  readonly isApiPath: (path: string) => boolean;
  /** The app's HTML page, when it has one. */
  readonly errorPage: ErrorPageRenderer | undefined;
}

const MEMO_ENTRIES = 64;
const MEMO_TTL_MS = 60_000;

/** The answer for `frame`'s request to every failure, from `options`. */
export function createFailureRenderer(options: FailureRendererOptions): FailureRenderer {
  const { isApiPath, errorPage } = options;
  const pageRan = new WeakSet<RequestFrame>();
  const memo = new PageMemo();

  async function appPage(
    frame: RequestFrame,
    error: PublicError,
    page: ErrorPageRenderer,
    unmatched: boolean,
  ): Promise<string | undefined> {
    try {
      const context = await claimForErrorPage(frame);
      const key = unmatched ? memoKey(frame, error) : undefined;
      if (key === undefined) return await asPage(frame.run(() => page(error, context)));
      const kept = memo.get(key);
      if (kept !== undefined) return kept;
      let observed = false;
      const onRead = (): void => {
        observed = true;
      };
      const watched = watchContext(context, onRead);
      const html = await asPage(
        observeFrame(frame, onRead, () => frame.run(() => page(error, watched))),
      );
      if (html !== undefined && !observed) memo.set(key, html);
      return html;
    } catch (renderError) {
      frame.report(renderError, 'error-page');
      return undefined;
    }
  }

  return async (frame, failure, origin) => {
    if (!wantsHtml(frame, isApiPath)) return sealed(failureResponse(failure, frame.traceId));
    const error: PublicError = {
      status: failure.status,
      message: failure.message ?? statusTitle(failure.status),
    };
    let html: string | undefined;
    if (errorPage !== undefined && origin?.claimless !== true && !pageRan.has(frame)) {
      pageRan.add(frame);
      html = await appPage(frame, error, errorPage, origin?.unmatched === true);
    }
    return sealed(
      bytesResponse(utf8(html ?? builtInErrorPage(error)), {
        status: failure.status,
        headers: { ...failure.headers, 'content-type': 'text/html; charset=utf-8' },
      }),
    );
  };
}

/** `response` marked never to be stored, whatever the route declared. */
function sealed(response: Response): Response {
  response.headers.set('cache-control', PRIVATE_NO_STORE);
  return response;
}

/** An app page's result as a document, or `undefined` for anything but a string. */
async function asPage(result: Awaitable<string>): Promise<string | undefined> {
  const html: unknown = await result;
  return typeof html === 'string' ? html : undefined;
}

/** Whether the failure of `frame`'s request is answered with an HTML page. */
function wantsHtml(frame: RequestFrame, isApiPath: (path: string) => boolean): boolean {
  const kind = frame.route?.meta.kind;
  if (kind === 'api' || kind === 'framework') return false;
  if (kind === 'page') return true;
  if (kind === undefined && isApiPath(frame.url.pathname)) return false;
  return prefersHtml(frame.request);
}

/**
 * The memo key of the not-found page `error` for `frame`'s request, or
 * `undefined` when its page must not be shared: a route entered the request,
 * the request carries a credential, a private scope bound, or a cookie chose
 * the locale.
 */
function memoKey(frame: RequestFrame, error: PublicError): string | undefined {
  if (frame.route !== undefined || frame.credentialed) return undefined;
  const scope = frame.claimed;
  if (scope === undefined || scope.privateScope || scope.locale?.cookie === true) return undefined;
  const partitions = scope.partitions.map((partition) => `${partition.name}=${partition.value}`);
  return JSON.stringify([
    error.status,
    error.message,
    frame.origin.origin,
    `${frame.url.pathname}${frame.url.search}`,
    scope.locale?.locale ?? '',
    ...partitions,
  ]);
}

/** Context fields a shared page must not depend on. */
const WATCHED_FIELDS = ['request', 'client', 'cspNonce', 'session'] as const;

/** `context` with its caller-specific fields reporting each read to `onRead`. */
function watchContext(context: RequestContext, onRead: () => void): RequestContext {
  const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(context);
  for (const field of WATCHED_FIELDS) {
    const descriptor = descriptors[field];
    if (descriptor === undefined) continue;
    descriptors[field] = {
      enumerable: true,
      configurable: true,
      get: (): unknown => {
        onRead();
        return descriptor.get === undefined ? descriptor.value : descriptor.get.call(context);
      },
    };
  }
  return Object.defineProperties({}, descriptors) as RequestContext;
}

/** A bounded, expiring map of rendered pages, least recently used evicted first. */
class PageMemo {
  readonly #entries = new Map<string, { readonly html: string; readonly expires: number }>();

  get(key: string): string | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    this.#entries.delete(key);
    if (entry.expires <= Date.now()) return undefined;
    this.#entries.set(key, entry);
    return entry.html;
  }

  set(key: string, html: string): void {
    this.#entries.delete(key);
    if (this.#entries.size >= MEMO_ENTRIES) {
      const oldest = this.#entries.keys().next();
      if (oldest.done !== true) this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, { html, expires: Date.now() + MEMO_TTL_MS });
  }
}
