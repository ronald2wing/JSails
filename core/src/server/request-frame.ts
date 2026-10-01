/**
 * The request frame: one immutable record per request, created by the
 * outermost stage and read by every later one.
 *
 * The request handler (`request-handler.ts`) opens it ({@link openFrame}):
 * it resolves the origin the request was addressed to and the client that
 * sent it (a host the app does not serve is answered 421 before a frame
 * exists), assigns the request id, and builds the request's one execution
 * context, which the handler enters once (a single `AsyncLocalStorage` run per
 * request), holding the frame under its context key and the application scope
 * facades resolve against. A request that can carry a body is rebuilt around
 * the frame's body budget (`body-budget.ts`), so every reader, a guard's
 * included, reads it lazily and counted against the limit of the route it
 * reaches. The guard tier ({@link runGuards}) runs next, before routes,
 * public files and the not-found answer, so a wall (basic auth, an IP
 * allowlist) stands in front of every fast path. Only
 * the health and readiness probes pass it unasked: a deploy tool probes the
 * container by its own address with no credential, and an app answer there
 * reveals nothing a route would.
 *
 * Nothing about who is asking is resolved until a route claims the request.
 * A framework route enters the frame ({@link RequestFrame.enter}) with its
 * {@link RouteMeta} (which sets the body budget's limit to the route's), then
 * calls {@link RequestFrame.claim}, the only place the
 * identity, the locale, and the extension request scopes resolve. The claim is
 * memoized and never throws: it settles as `claimed`, as `answered` (a scope
 * answered the request itself), or as `failed` (a scope threw). A request no
 * route claims (a public file, a JSON 404, a probe) resolves none of them. An
 * identity source that declares the cookies and headers it reads
 * ({@link identitySource}) is never called for a request that carries none of
 * them; a bare `resolveSession` declares nothing, so it runs for every claim.
 * The identity is the one the claimed route accepts
 * (`security/credentials.ts`): a route that declares no credentials never
 * resolves one, and an identity resolved from a credential kind the route
 * leaves out (a cookie session on a token-only route) is no identity there,
 * for its scopes, its access gate and its handler alike. A request context
 * built for a later route of the same request narrows the claimed identity
 * to that route's credentials again.
 *
 * What the claim resolves is bound, not set: the locale settles on the
 * request's execution context (no second context entry), and each scope's
 * binding wraps the rest of the route through {@link RequestFrame.run}, which
 * also wraps an error page and a late failure report so they see exactly what
 * the route saw. Handlers and middleware read the route's
 * {@link RequestContext}, built once per route entry, from
 * {@link RequestFrame.requestContext}.
 */

import type { Awaitable } from '../contracts/awaitable.js';
import type { AssetUrlResolver, RequestContext, RouteContext, Session } from '../contracts/http.js';
import {
  contextEntry,
  createExecutionContext,
  isRequestId,
  runInContext,
  withContext,
  withSettledValues,
  type ContextEntry,
  type ContextKey,
  type ExecutionContext,
} from '../context/execution-context.js';
import { createRootTrace, traceFromHeaders } from '../context/trace-context.js';
import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import type { ServiceRegistry } from '../extensions/services.js';
import type { LocaleDecision } from '../i18n/token.js';
import { localeKey } from '../i18n/request-locale.js';
import { acceptedIdentity, type CredentialKind } from '../security/credentials.js';
import {
  canonicalizeForwardingHeaders,
  resolveRequestOrigin,
  type ClientAddress,
  type OriginPolicy,
  type RequestOrigin,
} from '../security/request-origin.js';
import type { SeoRuntimeOptions } from '../seo/metadata.js';
import { requestFailed, type SignalBus } from '../signals/index.js';
import { parse as parseCookies } from '../support/cookie.server.js';
import { detach, escalate } from '../support/detach.js';
import {
  bindRequestBody,
  declaredBodyLength,
  RequestBodyBudget,
  type BodyBudget,
  type BodyWire,
} from './body-budget.js';
import { currentRequestFrame, frameKey } from './current-frame.js';
import { bodyLimitOf } from './route-limits.js';
import { DeadlineErrors, startDeadline, type Deadline } from './deadline.js';
import { createRequestBody } from './request-body.js';
import type { RequestErrorPhase, RequestErrorReporter } from './request-errors.js';
import {
  checkScopeResult,
  type CachePartition,
  type RequestScopeSpec,
  type ScopeBinding,
} from './request-scope.js';
import { requestSignalBase } from './request-signals.js';
import type { RouteMeta } from './route-meta.js';

/**
 * A frame a route entered: the route's meta, its path params, and the request
 * as the route receives it.
 *
 * @public
 */
export interface RoutedFrame {
  readonly frame: RequestFrame;
  readonly meta: RouteMeta;
  readonly params: Readonly<Record<string, string>>;
  readonly request: Request;
}

/**
 * What a claim resolved: the identity (`null` when the request carries no
 * credential, the identity source found none, or it came from a credential
 * kind the claimed route does not accept), the
 * locale decision (absent without the i18n plugin), the cache partitions
 * the bound scopes named, and whether a scope of cache class `private` bound
 * (the answer then depends on something only this caller has).
 *
 * @public
 */
export interface ClaimedScope {
  readonly identity: Session | null;
  readonly locale: LocaleDecision | undefined;
  readonly partitions: readonly CachePartition[];
  readonly privateScope: boolean;
}

/**
 * How a claim settled. `answered` and `failed` carry what had resolved before
 * the scope that answered or threw, so an error page can still render inside
 * it.
 *
 * @public
 */
export type ClaimResult =
  | { readonly kind: 'claimed'; readonly scope: ClaimedScope }
  | { readonly kind: 'answered'; readonly response: Response; readonly partial: ClaimedScope }
  | { readonly kind: 'failed'; readonly error: unknown; readonly partial: ClaimedScope };

/**
 * The per-application values every request context carries.
 *
 * @public
 */
export interface AppStatics {
  readonly services?: ServiceRegistry;
  readonly assetUrl?: AssetUrlResolver;
  readonly storagePath?: string;
  readonly seo?: SeoRuntimeOptions;
}

/**
 * The kernel seam the frame resolves identities through. `hasCredential` is a
 * cheap, synchronous look at the request (a cookie or header name the source
 * reads), asked at most once, when a route first needs it; `resolve` runs only
 * when it is true, at most once per request. Every place the source reads a
 * credential from must make `hasCredential` true, or a request carrying it
 * only there is anonymous. A throwing `hasCredential` or `resolve` fails
 * closed: the request continues without an identity and the failure is
 * reported (phase `session`).
 *
 * @public
 */
export interface IdentitySource {
  hasCredential(request: Request): boolean;
  resolve(request: Request): Awaitable<Session | null>;
}

/**
 * The names of the credentials an identity source reads: the cookies, and the
 * request headers (matched case-insensitively), that can carry one. A request
 * carries a credential when one of them is present with a non-empty value.
 *
 * @public
 */
export interface CredentialNames {
  readonly cookies?: readonly string[];
  readonly headers?: readonly string[];
}

/**
 * Options for {@link identitySource}: the credential names, and the resolver
 * that reads them.
 *
 * @public
 */
export interface IdentitySourceOptions extends CredentialNames {
  resolve(request: Request): Awaitable<Session | null>;
}

/**
 * Facts a {@link Guard} receives besides the request: the request id and the
 * resolved client.
 *
 * @public
 */
export interface GuardInfo {
  readonly id: string;
  readonly client: ClientAddress;
}

/**
 * A wall in front of every request but the health and readiness probes: it
 * runs before routes and public files, and answers with a
 * `Response` to refuse the request or with `undefined` to let it through. A
 * guard that throws, or returns anything else, fails the request with a
 * value-free 500.
 *
 * @public
 */
export type Guard = (request: Request, info: GuardInfo) => Awaitable<Response | undefined>;

/**
 * The per-request record every stage after the first reads.
 *
 * @public
 */
export interface RequestFrame {
  /** The request id (`X-Request-Id`): a valid inbound one, or a new UUID. */
  readonly id: string;
  /** The trace id the request runs under (the problem envelope's `traceId`). */
  readonly traceId: string;
  /**
   * The request's Content-Security-Policy nonce: 128 random bits, base64,
   * generated on first read and the same for the rest of the request.
   */
  readonly cspNonce: string;
  /**
   * The request, its headers canonical and its body (when it can carry one)
   * read through {@link body}. A route reads its own (`route.request`, which
   * the request context carries).
   */
  readonly request: Request;
  readonly url: URL;
  /** The origin the request was addressed to (see `server.origin`). */
  readonly origin: RequestOrigin;
  /** The client that sent the request (see `server.trustedProxies`). */
  readonly client: ClientAddress;
  /** True when the request arrived carrying forwarding headers. */
  readonly relayed: boolean;
  /** True when the immediate peer is a trusted proxy. */
  readonly trustedPeer: boolean;
  readonly statics: AppStatics;
  /**
   * Whether the request carries a credential the identity source reads, asked
   * of the source on first read; false without one, or when the source threw.
   */
  readonly credentialed: boolean;
  /**
   * Aborted when the client goes away, the route's deadline passes, or the
   * server shutting down ends the request (a live answer when the drain
   * starts, anything else at the shutdown deadline).
   */
  readonly signal: AbortSignal;
  /** The request body's budget: the route's limit, the bytes read, and whether a read went past it. */
  readonly body: BodyBudget;
  /** The route the request entered last, if any. */
  readonly route: RoutedFrame | undefined;
  /** What the claim resolved, once it settled (a scope's answer or failure included). */
  readonly claimed: ClaimedScope | undefined;
  /** Enter the frame as the route `meta` describes, with its path params and its request. */
  enter(meta: RouteMeta, params: Readonly<Record<string, string>>, request: Request): RoutedFrame;
  /** Resolve identity, locale, and scopes once; never rejects. */
  claim(): Promise<ClaimResult>;
  /**
   * The request context of the entered route as the settled claim resolved
   * it, built once per route entry.
   *
   * @throws `request_frame.unclaimed` before a claim settled.
   */
  requestContext(): RouteContext;
  /** Run `fn` inside every binding the settled claim made. */
  run<T>(fn: () => T): T;
  /**
   * Run `fn` inside the request's execution context and every binding the
   * settled claim made: for work that runs after the route returned (a
   * streamed body's reads).
   */
  runInRequest<T>(fn: () => T): T;
  /**
   * Report an unexpected failure with the entered route and the request id,
   * inside the request's context and bindings, whenever it happens.
   */
  report(error: unknown, phase: RequestErrorPhase): void;
}

const REQUEST_FRAME_ERRORS = {
  unclaimed: {
    kind: 'internal',
    message: 'the request context was read before the request was claimed',
    suggestion: 'read requestContext() inside a route, after its claim',
  },
  invalid_guard_result: {
    kind: 'internal',
    message: 'a guard returned something other than a Response or undefined',
  },
  invalid_identity_source: {
    kind: 'invalid',
    message:
      'an identity source needs a resolve function and at least one cookie or header name, each a valid name',
    suggestion: 'declare each cookie and header that can carry a credential the resolver reads',
  },
} as const;

/**
 * The request frame's codes, `request_frame.*`: a request context read before
 * the claim, a guard answering with something other than a `Response`, and an
 * identity source declared without a resolver or a valid credential name.
 *
 * @public
 */
export const RequestFrameErrors: ErrorRegistry<'request_frame', typeof REQUEST_FRAME_ERRORS> =
  defineErrors('request_frame', REQUEST_FRAME_ERRORS);

export { currentRequestFrame };

/**
 * Frame fields every request for the same URL shares: reading them through
 * {@link observeFrame}'s view is not a read of the caller. The methods run
 * framework work for the request (its bindings, its reports), never handing
 * the caller's facts to the code that called them.
 */
const SHARED_FRAME_FIELDS: ReadonlySet<PropertyKey> = new Set<PropertyKey>([
  'url',
  'origin',
  'statics',
  'run',
  'runInRequest',
  'report',
]);

/**
 * Run `fn` with {@link currentRequestFrame} answering a view of `frame` that
 * calls `onRead` on every read of a field only this request has (its id, its
 * request, client, nonce, claim, credential, signal, route), so a render
 * whose output may be shared with other requests can tell whether it
 * depended on the caller.
 */
export function observeFrame<T>(frame: RequestFrame, onRead: () => void, fn: () => T): T {
  const view = new Proxy(frame, {
    get(target, property) {
      if (!SHARED_FRAME_FIELDS.has(property)) onRead();
      // Read from the frame itself: its getters use private fields.
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return withContext(frameKey, view, fn);
}

/** Resolves a request's locale for its route, or is absent without i18n. */
export type LocaleResolver = (
  request: Request,
  url: URL,
  params: Readonly<Record<string, string>>,
) => Promise<LocaleDecision>;

/** What every frame of one application shares, built once by `createApp`. */
export interface FrameRuntime {
  readonly statics: AppStatics;
  readonly originPolicy: OriginPolicy;
  /** Paths answered on any host (the health and readiness probes). */
  readonly probePaths: ReadonlySet<string>;
  /** Continue every inbound `traceparent`, not only one a trusted proxy relayed. */
  readonly trustInboundTrace: boolean;
  /** Entries every request's context starts with (the application scope). */
  readonly contextEntries: readonly ContextEntry<unknown>[];
  readonly identity: IdentitySource | undefined;
  readonly locale: LocaleResolver | undefined;
  readonly scopes: readonly RequestScopeSpec[];
  readonly reportError: RequestErrorReporter;
  readonly signals: SignalBus | undefined;
  /** The body limit of a route that declares none, and of a request no route entered. */
  readonly maxBodyBytes: number;
  /** Refuse a body reader of a kind the route does not declare (outside production). */
  readonly strictBodyKinds: boolean;
}

/**
 * The {@link IdentitySource} over a bare `resolveSession` callback. A callback
 * declares nothing about where it reads a credential (a cookie, any header, the
 * URL), so every request a route claims counts as carrying one: skipping a
 * lookup the resolver needed would turn a signed-in caller anonymous unseen.
 */
export function sessionIdentitySource(
  resolve: (request: Request) => Awaitable<Session | null>,
): IdentitySource {
  return Object.freeze({ hasCredential: () => true, resolve });
}

/** An RFC 9110 token: a header field name, and (RFC 6265) a cookie name. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** A cookie value as sent: presence is the question, so nothing is decoded. */
const verbatim = (value: string): string => value;

/**
 * An {@link IdentitySource} that resolves only a request carrying one of the
 * declared credentials (see {@link CredentialNames}), so an anonymous request
 * never reaches `resolve`. Declare every cookie and header the resolver reads
 * a credential from: one sent anywhere else is never resolved.
 *
 * @throws `request_frame.invalid_identity_source` without a `resolve`
 *   function or a declared name, or for a name that is not a valid cookie or
 *   header name.
 * @public
 */
export function identitySource(options: IdentitySourceOptions): IdentitySource {
  const resolve: unknown = options.resolve;
  const cookies = declaredNames(options.cookies);
  const headers = declaredNames(options.headers)?.map((name) => name.toLowerCase());
  if (
    typeof resolve !== 'function' ||
    cookies === undefined ||
    headers === undefined ||
    cookies.length + headers.length === 0
  ) {
    throw new RequestFrameErrors.Error('invalid_identity_source');
  }
  const hasCredential = (request: Request): boolean => {
    for (const name of headers) {
      const value = request.headers.get(name);
      if (value !== null && value.trim() !== '') return true;
    }
    if (cookies.length === 0) return false;
    const header = request.headers.get('cookie');
    if (header === null) return false;
    const jar = parseCookies(header, { decode: verbatim });
    return cookies.some((name) => (jar[name] ?? '') !== '');
  };
  return Object.freeze({
    hasCredential,
    resolve: (request: Request) => options.resolve(request),
  });
}

/** `value` as a list of token names (empty when absent), or `undefined` when invalid. */
function declaredNames(value: unknown): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const names: unknown[] = value;
  return names.every((name) => typeof name === 'string' && TOKEN.test(name))
    ? Object.freeze([...(names as string[])])
    : undefined;
}

/** The locale and scopes a claim resolved, apart from the identity. */
interface SettledScopes {
  readonly locale: LocaleDecision | undefined;
  readonly bindings: readonly ScopeBinding[];
  readonly partitions: readonly CachePartition[];
  readonly privateScope: boolean;
  readonly answer?: Response;
  readonly failure?: { readonly error: unknown };
}

const NO_PARAMS: Readonly<Record<string, string>> = Object.freeze({});
const NO_BINDINGS: readonly ScopeBinding[] = Object.freeze([]);

class Frame implements RequestFrame {
  readonly id: string;
  readonly request: Request;
  readonly url: URL;
  readonly origin: RequestOrigin;
  readonly client: ClientAddress;
  readonly relayed: boolean;
  readonly trustedPeer: boolean;
  readonly statics: AppStatics;
  readonly #budget: RequestBodyBudget;
  #cspNonce: string | undefined;
  #signal: AbortSignal | undefined;
  #deadlineController: AbortController | undefined;
  #deadline: Deadline | undefined;
  readonly #runtime: FrameRuntime;
  readonly #context: ExecutionContext;
  #credentialed: boolean | undefined;
  #route: RoutedFrame | undefined;
  #identity: Promise<Session | null> | undefined;
  #claimedIdentity: Promise<Session | null> | undefined;
  #claimed: Promise<ClaimResult> | undefined;
  #bindings: readonly ScopeBinding[] = NO_BINDINGS;
  #settled: ReadonlyMap<ContextKey<unknown>, unknown> | undefined;
  #scope: ClaimedScope | undefined;
  #built:
    | {
        readonly route: RoutedFrame | undefined;
        readonly scope: ClaimedScope;
        readonly context: RouteContext;
      }
    | undefined;

  constructor(
    runtime: FrameRuntime,
    request: Request,
    url: URL,
    resolved: {
      readonly origin: RequestOrigin;
      readonly client: ClientAddress;
      readonly relayed: boolean;
      readonly trustedPeer: boolean;
    },
    id: string,
    budget: RequestBodyBudget,
  ) {
    this.#runtime = runtime;
    this.#budget = budget;
    this.id = id;
    this.request = request;
    this.url = url;
    this.origin = resolved.origin;
    this.client = resolved.client;
    this.relayed = resolved.relayed;
    this.trustedPeer = resolved.trustedPeer;
    this.statics = runtime.statics;
    const trusted = runtime.trustInboundTrace || resolved.trustedPeer;
    this.#context = withSettledValues(
      createExecutionContext({
        trace: trusted ? traceFromHeaders(request.headers) : createRootTrace(),
        requestId: id,
        values: [...runtime.contextEntries, contextEntry<unknown>(frameKey, this)],
      }),
      () => this.#settled,
    );
  }

  /** The request's one execution context. */
  get context(): ExecutionContext {
    return this.#context;
  }

  get route(): RoutedFrame | undefined {
    return this.#route;
  }

  get claimed(): ClaimedScope | undefined {
    return this.#scope;
  }

  get traceId(): string {
    return this.#context.trace.traceId;
  }

  get cspNonce(): string {
    this.#cspNonce ??= randomNonce();
    return this.#cspNonce;
  }

  get body(): BodyBudget {
    return this.#budget;
  }

  get signal(): AbortSignal {
    this.#signal ??= AbortSignal.any([this.request.signal, this.#deadlineSignal().signal]);
    return this.#signal;
  }

  /** The controller the route's deadline and a shutdown abort, made when first needed. */
  #deadlineSignal(): AbortController {
    this.#deadlineController ??= new AbortController();
    return this.#deadlineController;
  }

  /** Abort the frame's signal with `reason`, unless something already did. */
  abort(reason: unknown): void {
    this.#deadlineSignal().abort(reason);
  }

  /** The budget this frame reads its body through. */
  get budget(): RequestBodyBudget {
    return this.#budget;
  }

  /** The deadline armed for this request, if any. */
  get deadline(): Deadline | undefined {
    return this.#deadline;
  }

  /**
   * Arm the request's deadline of `timeoutMs` (none for `0`), once: the first
   * route the request enters owns it. `undefined` for a later caller, which
   * then neither races nor clears it.
   */
  armDeadline(timeoutMs: number): Deadline | undefined {
    if (this.#deadline !== undefined || timeoutMs === 0) return undefined;
    this.#deadline = startDeadline(timeoutMs, this.#deadlineSignal());
    return this.#deadline;
  }

  get credentialed(): boolean {
    this.#credentialed ??= this.#hasCredential();
    return this.#credentialed;
  }

  /**
   * The identity source's credential test, asked only when something needs
   * it. It is app code: a throw fails closed (no identity) and is reported,
   * never breaking the request.
   */
  #hasCredential(): boolean {
    const source = this.#runtime.identity;
    if (source === undefined) return false;
    try {
      return source.hasCredential(this.request) === true;
    } catch (error) {
      this.report(error, 'session');
      return false;
    }
  }

  enter(meta: RouteMeta, params: Readonly<Record<string, string>>, request: Request): RoutedFrame {
    const routed: RoutedFrame = Object.freeze({
      frame: this,
      meta: Object.freeze({ ...meta }),
      params: Object.freeze({ ...params }),
      request,
    });
    this.#route = routed;
    this.#budget.setLimit(bodyLimitOf(meta.body, this.#runtime.maxBodyBytes));
    return routed;
  }

  claim(): Promise<ClaimResult> {
    this.#claimed ??= this.#claim();
    return this.#claimed;
  }

  requestContext(): RouteContext {
    const scope = this.#scope;
    if (scope === undefined) throw new RequestFrameErrors.Error('unclaimed');
    const route = this.#route;
    const built = this.#built;
    if (built !== undefined && built.route === route && built.scope === scope) return built.context;
    const context = buildRequestContext(this, route, scope, this.#runtime.strictBodyKinds);
    this.#built = { route, scope, context };
    return context;
  }

  run<T>(fn: () => T): T {
    return runBound(this.#bindings, fn);
  }

  runInRequest<T>(fn: () => T): T {
    return runInContext(this.#context, () => runBound(this.#bindings, fn));
  }

  report(error: unknown, phase: RequestErrorPhase): void {
    const runtime = this.#runtime;
    const info = {
      phase,
      method: this.request.method,
      route: this.#route?.meta.pattern ?? '*',
      requestId: this.id,
    };
    runInContext(this.#context, () =>
      this.run(() => {
        detach(runtime.reportError(error, info), escalate);
        // A failure after the head was sent (a stream's, or its idle
        // bound's), or one the component lane answered value-free, leaves no
        // failed outcome for the route's own signal stage to see, so it is
        // announced here.
        const signals = runtime.signals;
        if (
          signals !== undefined &&
          this.#scope !== undefined &&
          (phase === 'stream' ||
            phase === 'component' ||
            (phase === 'timeout' && DeadlineErrors.is(error, 'stream_idle')))
        ) {
          detach(
            signals.emit(requestFailed, { ...requestSignalBase(this, this.request.method), error }),
            escalate,
          );
        }
      }),
    );
  }

  async #claim(): Promise<ClaimResult> {
    // The identity and the locale resolve concurrently; the scopes wait for
    // the identity they read.
    const [identity, settled] = await Promise.all([this.#claimIdentity(), this.#settleScopes()]);
    const scope: ClaimedScope = Object.freeze({
      identity,
      locale: settled.locale,
      partitions: settled.partitions,
      privateScope: settled.privateScope,
    });
    this.#scope = scope;
    if (settled.answer !== undefined) {
      return Object.freeze<ClaimResult>({
        kind: 'answered',
        response: settled.answer,
        partial: scope,
      });
    }
    if (settled.failure !== undefined) {
      return Object.freeze<ClaimResult>({
        kind: 'failed',
        error: settled.failure.error,
        partial: scope,
      });
    }
    return Object.freeze<ClaimResult>({ kind: 'claimed', scope });
  }

  /** The identity of the claim: the resolved one, as the claimed route's credentials accept it. */
  #claimIdentity(): Promise<Session | null> {
    this.#claimedIdentity ??= this.#identityFor(this.#route?.meta.credentials);
    return this.#claimedIdentity;
  }

  /**
   * The identity a route accepting `credentials` sees: none without a
   * credential kind (the source is never asked), else the resolved one when it
   * came from a kind the route accepts. A claim no route entered (an error
   * page's) sees the resolved identity.
   */
  async #identityFor(credentials: readonly CredentialKind[] | undefined): Promise<Session | null> {
    if (credentials === undefined) return this.#resolveIdentity();
    if (credentials.length === 0) return null;
    return acceptedIdentity(await this.#resolveIdentity(), credentials);
  }

  #resolveIdentity(): Promise<Session | null> {
    const source = this.#runtime.identity;
    if (source === undefined || !this.credentialed) return Promise.resolve(null);
    this.#identity ??= (async () => {
      try {
        return (await source.resolve(this.request)) ?? null;
      } catch (error) {
        // A store outage must not turn every visitor anonymous unseen.
        this.report(error, 'session');
        return null;
      }
    })();
    return this.#identity;
  }

  async #settleScopes(): Promise<SettledScopes> {
    const runtime = this.#runtime;
    const params = this.#route?.params ?? NO_PARAMS;
    const locale = await runtime.locale?.(this.request, this.url, params);
    if (locale !== undefined) this.#settled = new Map([[localeKey, locale.locale]]);
    if (runtime.scopes.length === 0) {
      return { locale, bindings: NO_BINDINGS, partitions: [], privateScope: false };
    }
    const identity = await this.#claimIdentity();
    const bindings: ScopeBinding[] = [];
    const partitions: CachePartition[] = [];
    let privateScope = false;
    const settled = (extra: Partial<SettledScopes>): SettledScopes => {
      this.#bindings = Object.freeze([...bindings]);
      return {
        locale,
        bindings: this.#bindings,
        partitions: Object.freeze(partitions),
        privateScope,
        ...extra,
      };
    };
    const request = Object.freeze({
      request: this.#route?.request ?? this.request,
      url: this.url,
      params,
      identity,
      locale: locale?.locale,
      origin: this.origin,
      client: this.client,
    });
    for (const spec of runtime.scopes) {
      let result: ScopeBinding | Response | undefined;
      try {
        result = checkScopeResult(spec, await runBound(bindings, () => spec.resolve(request)));
      } catch (error) {
        return settled({ failure: { error } });
      }
      if (result instanceof Response) return settled({ answer: result });
      if (result === undefined) continue;
      bindings.push(result);
      if (spec.cache === 'private') privateScope = true;
      if (result.partition !== undefined) partitions.push(Object.freeze({ ...result.partition }));
    }
    return settled({});
  }
}

/** 128 random bits as base64: a Content-Security-Policy nonce. */
function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/** `fn` run inside `bindings`, the first outermost. */
function runBound<T>(bindings: readonly ScopeBinding[], fn: () => T): T {
  let inner = fn;
  for (let index = bindings.length - 1; index >= 0; index -= 1) {
    const binding = bindings[index] as ScopeBinding;
    const next = inner;
    inner = () => binding.run(next);
  }
  return inner();
}

/** The request context of `frame` for the entered `route`, as `scope` resolved it. */
function buildRequestContext(
  frame: RequestFrame,
  route: RoutedFrame | undefined,
  scope: ClaimedScope,
  strictBodyKinds: boolean,
): RouteContext {
  const { statics } = frame;
  const locale = scope.locale?.locale;
  const request = route?.request ?? frame.request;
  return {
    request,
    url: frame.url,
    params: { ...(route?.params ?? NO_PARAMS) },
    session:
      route === undefined
        ? scope.identity
        : acceptedIdentity(scope.identity, route.meta.credentials),
    origin: frame.origin,
    client: frame.client,
    ...(statics.services === undefined ? {} : { services: statics.services }),
    ...(statics.assetUrl === undefined ? {} : { assetUrl: statics.assetUrl }),
    ...(statics.storagePath === undefined ? {} : { storagePath: statics.storagePath }),
    ...(statics.seo === undefined ? {} : { seo: statics.seo }),
    ...(locale === undefined ? {} : { locale }),
    body: createRequestBody(request, route?.meta.body, {
      strict: strictBodyKinds,
      budget: frameInternals(frame)?.budget,
      signal: () => frame.signal,
    }),
    // Read on demand: a request that renders no inline script draws no random bytes.
    get cspNonce(): string {
      return frame.cspNonce;
    },
    // Read on demand: a request whose handler never asks builds no combined signal.
    get signal(): AbortSignal {
      return frame.signal;
    },
  };
}

/**
 * A frame the request handler opened: the frame, and the one way into the
 * request's execution context.
 */
export interface OpenedFrame {
  readonly frame: RequestFrame;
  /** Run `fn` in the request's execution context: the one `AsyncLocalStorage` run per request. */
  run<T>(fn: () => T): T;
}

/**
 * The request's frame, or `undefined` for a host the app does not serve
 * (which the caller answers 421), except a probe of the runtime's probe paths.
 * The forwarding headers are canonicalized on the way, then the body (when the
 * request carries one) is bound to the frame's budget. `peer` is the TCP
 * peer the Node adapter exposes (see {@link socketPeer}); `wire` says how the
 * body arrived and writes the `100 Continue` the request is owed, at the
 * body's first read (`body-budget.ts`); without one the request is served in
 * process.
 */
export function openFrame(
  runtime: FrameRuntime,
  request: Request,
  peer: string | undefined,
  id: string,
  wire?: BodyWire,
): OpenedFrame | undefined {
  const url = new URL(request.url);
  const resolved = resolveRequestOrigin(
    {
      peer,
      url,
      headers: request.headers,
      probe: isProbe(request.method, url, runtime.probePaths),
    },
    runtime.originPolicy,
  );
  if ('refused' in resolved) return undefined;
  canonicalizeForwardingHeaders(request.headers, resolved);
  const budget = new RequestBodyBudget(runtime.maxBodyBytes);
  const bound = bindRequestBody(request, budget, wire);
  const frame = new Frame(runtime, bound, url, resolved, id, budget);
  return Object.freeze({ frame, run: <T>(fn: () => T): T => runInContext(frame.context, fn) });
}

/** The request id for `request`: a valid inbound `X-Request-Id`, or a new UUID. */
export function requestIdOf(request: Request): string {
  const inbound = request.headers.get('x-request-id');
  return isRequestId(inbound) ? inbound : crypto.randomUUID();
}

/** True for a GET or HEAD of one of `probePaths`: a health or readiness probe. */
function isProbe(method: string, url: URL, probePaths: ReadonlySet<string>): boolean {
  return (method === 'GET' || method === 'HEAD') && probePaths.has(url.pathname);
}

/** The TCP peer the Node adapter exposes on `env.incoming.socket`; absent in-process. */
export function socketPeer(env: unknown): string | undefined {
  if (env === null || typeof env !== 'object') return undefined;
  const incoming = (env as { incoming?: unknown }).incoming;
  if (incoming === null || typeof incoming !== 'object') return undefined;
  const socket = (incoming as { socket?: unknown }).socket;
  if (socket === null || typeof socket !== 'object') return undefined;
  const address = (socket as { remoteAddress?: unknown }).remoteAddress;
  return typeof address === 'string' && address !== '' ? address : undefined;
}

/** How the guard tier settled: let through, answered, or failed with a guard's fault. */
export type GuardOutcome =
  | { readonly kind: 'pass' }
  | { readonly kind: 'answered'; readonly response: Response }
  | { readonly kind: 'failed'; readonly error: unknown };

const PASS: GuardOutcome = Object.freeze({ kind: 'pass' });

/**
 * The guard tier: each guard in order, the first `Response` answers. A probe
 * of `probePaths` passes unguarded: a deploy tool's health check carries no
 * credential, and a wall there would fail every release. A guard that throws,
 * or answers with anything but a `Response` or `undefined`, fails the request.
 */
export async function runGuards(
  frame: RequestFrame,
  guards: readonly Guard[],
  probePaths: ReadonlySet<string>,
): Promise<GuardOutcome> {
  if (guards.length === 0 || isProbe(frame.request.method, frame.url, probePaths)) return PASS;
  const info: GuardInfo = Object.freeze({ id: frame.id, client: frame.client });
  for (const guard of guards) {
    let answer: unknown;
    try {
      answer = await guard(frame.request, info);
    } catch (error) {
      return { kind: 'failed', error };
    }
    if (answer === undefined) continue;
    if (!(answer instanceof Response)) {
      return { kind: 'failed', error: new RequestFrameErrors.Error('invalid_guard_result') };
    }
    return { kind: 'answered', response: answer };
  }
  return PASS;
}

/** Validate the `guards` option: an array of functions. */
export function resolveGuards(value: unknown): readonly Guard[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((guard) => typeof guard === 'function')) {
    throw new TypeError('guards must be an array of functions');
  }
  return Object.freeze([...(value as Guard[])]);
}

/** The pipeline's own view of a frame `openFrame` built: its budget, deadline and abort. */
interface FrameInternals {
  readonly budget: RequestBodyBudget;
  readonly deadline: Deadline | undefined;
  armDeadline(timeoutMs: number): Deadline | undefined;
  /** Abort the frame's signal (a server shutting down ends the request). */
  abort(reason: unknown): void;
}

/** `frame`'s internals, or `undefined` for a frame `openFrame` did not build (a test double). */
export function frameInternals(frame: RequestFrame): FrameInternals | undefined {
  return frame instanceof Frame ? frame : undefined;
}

/**
 * Whether `frame`'s request declares a body length over the limit of the
 * route it entered: answered 413 before anything is read or resolved.
 */
export function declaresTooLarge(frame: RequestFrame): boolean {
  const length = declaredBodyLength(frame.request);
  return length !== undefined && length > frame.body.limit;
}

/**
 * The request's context for an error page: the entered route's, or one with
 * no params, as whatever the claim settled resolved it (a scope's answer or
 * failure keeps what resolved before it).
 */
export async function claimForErrorPage(frame: RequestFrame): Promise<RequestContext> {
  await frame.claim();
  return frame.requestContext();
}
