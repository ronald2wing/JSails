/**
 * HTTP-facing contracts: JSON value types, sessions, and the per-request
 * context threaded through routing and middleware. Uses Node's built-in web
 * types (`Request`, `URL`) from `@types/node`; no DOM lib is required.
 *
 * `ServiceRegistry` is referenced through `import type` only: the contract
 * carries no runtime dependency on the extension system (and therefore no ORM
 * or HTTP runtime) and does not require a registry to exist.
 */

import type { ServiceRegistry } from '../extensions/services.js';
import type { RouteMiddleware } from '../routing/middleware.js';
import type { SeoRuntimeOptions } from '../seo/metadata.js';
import type { ClientAddress, RequestOrigin } from '../security/request-origin.js';

import type { JsonObject, JsonValue } from '../json/shape.js';
import type { Schema } from '../api/validation.js';
import type { AccessRef } from '../api/access-ref.js';
import { JsailsError } from '../errors/jsails-error.js';
import type { Awaitable } from './awaitable.js';

export type { JsonObject, JsonValue };

/** A server-side session. */
export interface Session {
  /** Opaque, stable session identifier (the cookie value). */
  readonly id: string;
  /** Serialized session data. */
  readonly data: JsonObject;
  /** Expiry as a Unix epoch timestamp in milliseconds. */
  readonly expiresAt: number;
}

/** Storage backend for sessions; all operations are async. */
export interface SessionStore {
  get(id: string): Promise<Session | null>;
  set(session: Session): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * Maps a public asset path (e.g. `/assets/app.js`) to the URL to emit for it
 * (`/assets/app.js?v=<content hash>`), synchronously, from the asset index. A
 * path the index does not hold (missing, hidden, symlinked, or otherwise
 * refused) comes back unchanged rather than throwing, so a page never fails on
 * a link.
 */
export type AssetUrlResolver = (path: string) => string;

/** Per-request context handed to middleware, pages, and actions. */
export interface RequestContext {
  /** The incoming HTTP request. */
  readonly request: Request;
  /** The parsed request URL. */
  readonly url: URL;
  /** Route parameters extracted from the path (e.g. `{ id: "42" }`). */
  readonly params: Record<string, string>;
  /** The active session, or `null` when absent or unauthenticated. */
  readonly session: Session | null;
  /**
   * The origin the request was addressed to (see `server.origin` and
   * `server.hosts`): the value a same-origin `Origin` header carries, which
   * behind a TLS-terminating proxy differs from the plain-HTTP request URL.
   * Set on every request the HTTP pipeline serves; absent for static export
   * and hand-built contexts.
   */
  readonly origin?: RequestOrigin;
  /**
   * The client that sent the request, resolved from the socket peer and only
   * the forwarding headers `server.trustedProxies` vouches for. Per-client
   * limits key on its `bucket`. Set on every request the HTTP pipeline serves.
   */
  readonly client?: ClientAddress;
  /**
   * Whether the page is being rendered live (interactive, signable) or
   * statically (SSG/static export, where server components render only their
   * declared fallback). Absent means live.
   */
  readonly renderMode?: 'live' | 'static';
  /**
   * Services provided by applied extensions, when the host wired them in.
   * Optional because not every request runs behind the extension runner.
   */
  readonly services?: ServiceRegistry;
  /**
   * The URL to emit for a public asset path, from the app's asset index (the
   * HTTP layer and static export both attach it; synchronous). Absent for
   * hand-built contexts, where callers use the plain path. Carried so server
   * components, pages, and templates emit cache-busted asset URLs without
   * knowing the hashing policy.
   */
  readonly assetUrl?: AssetUrlResolver;
  /**
   * Absolute persistent-storage directory (resolved config `storageDir`), when
   * the host wired one in. Absent means no storage directory is configured for
   * this request path (e.g. browser-free SSR). The directory's existence is not
   * guaranteed here; `Application.serve` creates it before listening.
   */
  readonly storagePath?: string;
  /**
   * Resolved SEO runtime options (site name, canonical origin, default
   * metadata), when the host wired them in. The page renderer merges these
   * underneath each page's own metadata. Absent means no SEO defaults.
   */
  readonly seo?: SeoRuntimeOptions;
  /** Resolved request locale, when the i18n plugin is active. */
  readonly locale?: string;
  /**
   * A fresh base64 nonce for this request's inline `<script>` and `<style>`
   * tags, the value a `Content-Security-Policy` `'nonce-…'` source names. Set
   * on every request the HTTP pipeline serves; absent for static export and
   * hand-built contexts.
   */
  readonly cspNonce?: string;
  /**
   * Aborted when the work this context serves should stop: the client went
   * away, or a deadline passed (the route's `timeoutMs`, or a component
   * lane's). Set on every request the HTTP pipeline serves and by the
   * server-component transport; absent for static export and hand-built
   * contexts.
   */
  readonly signal?: AbortSignal;
  /**
   * The request body's readers, bounded by the route's body budget. Set on
   * every request the HTTP pipeline serves; absent for static export and
   * hand-built contexts.
   */
  readonly body?: RequestBody;
}

/**
 * The request context of a route the HTTP pipeline serves: a
 * {@link RequestContext} whose body readers and abort signal are always set.
 *
 * @public
 */
export interface RouteContext extends RequestContext {
  readonly signal: AbortSignal;
  readonly body: RequestBody;
}

/**
 * The readers of a request body. Each reads through the request's body
 * budget: a body past the route's limit fails the read with
 * `request.too_large`, and the request is answered 413 whatever the handler
 * does with the error.
 * Outside production, a reader of a kind the route's `body` does not declare
 * (json for `json`, form for `form`, raw for `bytes` and `stream`) throws
 * `body.undeclared_read`; `multipart` throws it in production too, since it
 * reads under the parts the route declares. A body is read once: a second
 * read fails.
 *
 * @public
 */
export interface RequestBody {
  /**
   * Parse the body as JSON and validate it with `schema`. An empty or
   * malformed body throws a 422 `request.invalid` (`invalid_json`); the
   * schema's own `ValidationError` is thrown as it is.
   */
  json<T>(schema: Pick<Schema<T>, 'validate'>): Promise<T>;
  /**
   * The body as form data: `application/x-www-form-urlencoded`, or a small
   * `multipart/form-data` body held in memory (any other content type throws
   * a 422 `unsupported_content_type`).
   */
  form(): Promise<FormData>;
  /** The body's bytes. */
  bytes(): Promise<Uint8Array>;
  /** The body as a stream (empty for a request without one). */
  stream(): ReadableStream<Uint8Array>;
  /**
   * The parts of a `multipart/form-data` body, in wire order, read under the
   * route's declared `parts`. A text field arrives whole; a file arrives as a
   * stream that must be read (or cancelled) before the next part, since
   * moving on discards what is left of it. Nothing is read until the first
   * part is asked for. A limit crossed (part count, a field or file past its
   * cap, a header block) fails the read and answers the request 413; a file
   * in a field the route does not declare, a media type it does not accept,
   * or a malformed body is a 422; a body that stops arriving for `idleMs` is
   * aborted.
   */
  multipart(): AsyncIterable<MultipartPart>;
}

/**
 * A text field of a multipart body: its name and its value, decoded as
 * UTF-8. Both are untrusted input.
 *
 * @public
 */
export interface MultipartFieldPart {
  readonly kind: 'field';
  readonly name: string;
  readonly value: string;
}

/**
 * A file of a multipart body, streamed as it arrives. `filename` is the name
 * the client sent, raw (it may hold a path, `..`, or any character, and is
 * `undefined` when the part carries none): never use it as a storage key or
 * a path. `contentType` is the media type the client claims, lowercased,
 * without parameters (`application/octet-stream` when it claims none); it
 * is not checked against the bytes.
 *
 * @public
 */
export interface MultipartFilePart {
  readonly kind: 'file';
  readonly name: string;
  readonly filename: string | undefined;
  readonly contentType: string;
  readonly stream: ReadableStream<Uint8Array>;
}

/**
 * One part of a multipart body: a text field or a file.
 *
 * @public
 */
export type MultipartPart = MultipartFieldPart | MultipartFilePart;

/**
 * Structured HTTP-layer error carrying a machine-readable code, a status, and
 * the headers its answer needs (`WWW-Authenticate`, `Retry-After`). The
 * pipeline answers it with that status, its code and its message (public by
 * contract, so it must be value-free) in the problem envelope; feature modules
 * (e.g. auth) may extend it so their domain errors are caught by the same path
 * without a runtime import from the pipeline back to the feature. It is
 * reported to `onError` only at 500 and above.
 */
export class HttpError extends JsailsError {
  /** Headers the failure's answer carries. */
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.headers = Object.freeze({ ...headers });
  }
}

/**
 * Authorization decision for a request. The request is allowed only when the
 * callback resolves to exactly `true`; any other value (falsy, truthy
 * non-boolean) denies, and a throw or a rejection is a reported fault that
 * denies.
 */
export type Authorize = (context: RequestContext) => Awaitable<boolean>;

/** Trusted application callback resolving the session for a request. */
export type ResolveSession = (request: Request) => Awaitable<Session | null>;

/** A recognized HTTP method name. */
export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';

/**
 * An API route handler: receives the raw request plus a per-request context.
 * Returns a `Response` directly (or a promise of one); JSON serialization is
 * the handler's own responsibility.
 */
export type ApiHandler = (request: Request, context: RequestContext) => Awaitable<Response>;

/**
 * A compiled API module in the method-export shape: named HTTP-method
 * handlers, and its access, as an `access` export (`publicAccess(reason)` or
 * a check) or an `authorize` check. A module stating neither fails assembly.
 */
export interface ApiModule {
  readonly GET?: ApiHandler;
  readonly POST?: ApiHandler;
  readonly PUT?: ApiHandler;
  readonly PATCH?: ApiHandler;
  readonly DELETE?: ApiHandler;
  readonly OPTIONS?: ApiHandler;
  readonly HEAD?: ApiHandler;
  readonly access?: AccessRef | Authorize;
  readonly authorize?: Authorize;
  /** Middleware run in order before the method handler; see {@link RouteMiddleware}. */
  readonly middleware?: readonly RouteMiddleware[];
}
