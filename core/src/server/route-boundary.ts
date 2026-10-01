/**
 * The route boundary: every registered route's chain, compiled into one
 * async function with a fixed order.
 *
 * {@link compileRouteBoundary} turns a route's {@link RouteMeta}, its surface
 * descriptor, its middleware and its terminal into the single router handler
 * of the route.
 * For every request it:
 *
 * 1. enters the request frame with the route's meta, path params and request,
 *    which sets the body budget's limit to the route's (`body`, else the
 *    app-wide `maxBodyBytes`);
 * 2. answers 413 when the request declares a longer body than that limit,
 *    before anything is read or resolved;
 * 3. arms the route's deadline (`timeoutMs`, else the app's
 *    `handlerTimeoutMs`; `deadline.ts`), which runs until a response is
 *    returned;
 * 4. asks the rate-limit hook (`AppOptions.rateLimit`), keyed by the frame's
 *    client address: a `Response` answers before anything is resolved;
 * 5. claims the frame (identity, locale, request scopes): a scope's answer is
 *    returned, a scope's failure rendered;
 * 6. for a page or API route, emits `requestStarted`, and on the way out
 *    `requestFinished` or `requestFailed`;
 * 7. runs the access chain (`security/access-chain.ts`) for the route's
 *    surface: the cross-site check of an unsafe request to a cookie-accepting
 *    surface, then the gate for its `access`; a denial is rendered as a
 *    failure, which the finalizer sends `private, no-store` without
 *    `Set-Cookie`;
 * 8. runs the middleware, outermost first, around the terminal;
 * 9. applies the response transforms registered for the route's kind, in
 *    registration order, to the answer the chain produced;
 * 10. gives the budget's verdict: a request whose body a read went past the
 *     limit is answered 413, whatever the chain answered or threw;
 *
 * and catches any throw, reporting it once and rendering it inside the
 * claim's bindings, so an error page sees what the route saw. Steps 5 to 10
 * run inside those bindings. Nothing of the route's app code (middleware,
 * handler, transform) runs before the chain admitted the request, and no byte
 * of the body is read before a reader asks for it. When the deadline passes
 * first, the request is answered 504 and whatever the route produces later
 * is discarded (`deadline.ts`).
 */

import { toFailure } from '../api/error-response.js';
import type { Failure } from '../api/failure-response.js';
import type { Awaitable } from '../contracts/awaitable.js';
import type { RequestContext, RouteContext } from '../contracts/http.js';
import type { RouteMiddleware } from '../routing/middleware.js';
import { runAccessChain } from '../security/access-chain.js';
import { accessProbeOf } from '../security/access-record.js';
import type { SurfaceDescriptor } from '../security/surfaces.js';
import type { SignalBus } from '../signals/index.js';
import { tooLarge } from '../errors/kernel.js';
import { discardResponse, withinDeadline, type Deadline, type LateOutcome } from './deadline.js';
import type { AppContext } from './env.js';
import type { FailureRenderer } from './failure-renderer.js';
import {
  declaresTooLarge,
  frameInternals,
  type ClaimedScope,
  type RequestFrame,
  type RoutedFrame,
} from './request-frame.js';
import { withRequestSignals } from './request-signals.js';
import {
  RouteErrors,
  type RouteKind,
  type RouteMeta,
  type TransformableKind,
} from './route-meta.js';

/**
 * The rate-limit hook of every route: runs after the frame is entered and
 * before the claim, so a limited request resolves no identity. Answer with a
 * `Response` to refuse the request, or `undefined` to let it through.
 *
 * @public
 */
export type RouteRateLimit = (routed: RoutedFrame) => Awaitable<Response | undefined>;

/**
 * A response transform: rewrites the answer of a route whose kind it was
 * registered for. It runs after the access chain and the handler, so it can
 * neither answer in the route's place nor see a denied request.
 *
 * @public
 */
export type ResponseTransform = (
  response: Response,
  context: RequestContext,
) => Awaitable<Response>;

/** A transform and the route kinds it applies to. */
export interface TransformEntry {
  readonly kinds: readonly TransformableKind[];
  readonly transform: ResponseTransform;
}

/** What every boundary of one app shares. */
export interface BoundaryRuntime {
  readonly rateLimit: RouteRateLimit | undefined;
  readonly renderFailure: FailureRenderer;
  readonly signals: SignalBus | undefined;
  readonly transforms: readonly TransformEntry[];
  /** The deadline of a route that declares none (`0`: none). */
  readonly handlerTimeoutMs: number;
}

/** The terminal of a route: its handler, given the routed frame and its request context. */
export type RouteTerminal = (routed: RoutedFrame, context: RouteContext) => Awaitable<Response>;

/** How a route is registered beyond its meta: its chain. */
export interface RouteRegistrationSpec {
  readonly middleware: readonly RouteMiddleware[];
  readonly terminal: RouteTerminal;
}

/** Record a route in the table and the surface registry, and compile its boundary into the router. */
export type RegisterRoute = (meta: RouteMeta, spec: RouteRegistrationSpec) => void;

/** The kinds whose routes emit the request-lifecycle signals. */
const SIGNALLED: ReadonlySet<RouteKind> = new Set<RouteKind>(['api', 'page']);

/** Compile the route `meta` describes into its one router handler. */
export function compileRouteBoundary(
  runtime: BoundaryRuntime,
  meta: RouteMeta,
  surface: SurfaceDescriptor,
  spec: RouteRegistrationSpec,
): (c: AppContext) => Promise<Response> {
  const { middleware, terminal } = spec;
  const { rateLimit, renderFailure } = runtime;
  const signals = SIGNALLED.has(meta.kind) ? runtime.signals : undefined;
  const transforms = runtime.transforms
    .filter((entry) => (entry.kinds as readonly RouteKind[]).includes(meta.kind))
    .map((entry) => entry.transform);

  const timeoutMs = meta.timeoutMs ?? runtime.handlerTimeoutMs;

  const run = async (routed: RoutedFrame, scope: ClaimedScope): Promise<Response> => {
    const frame = routed.frame;
    const outcome = await runAccessChain(surface, routed, scope);
    if (outcome.kind === 'denied') return renderFailure(frame, outcome.failure);
    // The access matrix's synthesised request stops where the route's code
    // would start (`security/access-record.ts`).
    const probe = accessProbeOf(routed.request);
    if (probe !== undefined) return probe.reached(outcome.admitted);
    const context = frame.requestContext();
    let response = await runChain(middleware, context, async () =>
      answerOf('handler', await terminal(routed, context)),
    );
    for (const transform of transforms) {
      response = answerOf('transform', await transform(response, context));
    }
    if (frame.body.exceeded) {
      discardResponse(response);
      return renderFailure(frame, TOO_LARGE());
    }
    return response;
  };

  const attempt = async (
    routed: RoutedFrame,
    deadline: Deadline | undefined,
  ): Promise<Response> => {
    const frame = routed.frame;
    if (rateLimit !== undefined) {
      const limited = await rateLimit(routed);
      if (limited !== undefined) return answerOf('rate_limit', limited);
    }
    const claim = await frame.claim();
    // A claim that settled after the deadline was answered 504 by the outer
    // race: nothing of the route runs for it.
    if (deadline?.fired === true) throw deadline.error;
    if (claim.kind === 'answered') return claim.response;
    if (claim.kind === 'failed') return await fail(frame, renderFailure, claim.error);
    const scope = claim.scope;
    const method = routed.request.method === 'HEAD' ? 'GET' : routed.request.method;
    // The outer race answers the request; this one lets the lifecycle
    // signals see the expiry as the route's failure when it happens.
    return await frame.run(() =>
      withRequestSignals(frame, signals, method, () =>
        withinDeadline(deadline, run(routed, scope), lateOutcome(frame)),
      ),
    );
  };

  return async (c) => {
    const frame = c.var.frame;
    const routed = frame.enter(meta, c.req.param(), c.req.raw);
    if (declaresTooLarge(frame)) return renderFailure(frame, TOO_LARGE(), { claimless: true });
    const deadline = frameInternals(frame)?.armDeadline(timeoutMs);
    try {
      return await withinDeadline(deadline, attempt(routed, deadline), lateOutcome(frame));
    } catch (error) {
      if (deadline !== undefined && error === deadline.error) {
        return expired(frame, renderFailure, deadline);
      }
      if (frame.body.exceeded) {
        frame.report(error, 'handler');
        return frame.run(() => renderFailure(frame, TOO_LARGE()));
      }
      return fail(frame, renderFailure, error);
    } finally {
      deadline?.clear();
    }
  };
}

/** The failure of a request body past its route's limit. */
export const TOO_LARGE = (): Failure => toFailure(tooLarge());

/** Where work that settles after the deadline goes: a rejection is reported. */
export function lateOutcome(frame: RequestFrame): LateOutcome {
  return { rejected: (error) => frame.report(error, 'timeout') };
}

/**
 * The answer to a request whose deadline passed: the expiry is reported and
 * rendered as a 504. An app error page renders only when the claim settled,
 * since it would wait on a claim that did not.
 */
export function expired(
  frame: RequestFrame,
  renderFailure: FailureRenderer,
  deadline: Deadline,
): Promise<Response> {
  frame.report(deadline.error, 'timeout');
  const failure = toFailure(deadline.error);
  if (frame.claimed === undefined) return renderFailure(frame, failure, { claimless: true });
  return frame.run(() => renderFailure(frame, failure));
}

/** Report `error` once and render it inside the claim's bindings. */
function fail(
  frame: RequestFrame,
  renderFailure: FailureRenderer,
  error: unknown,
): Promise<Response> {
  frame.report(error, 'handler');
  return frame.run(() => renderFailure(frame, toFailure(error)));
}

/** `value` when it is a `Response`; a route stage answering anything else is a fault. */
function answerOf(
  stage: 'handler' | 'middleware' | 'transform' | 'rate_limit',
  value: unknown,
): Response {
  if (isResponse(value)) return value;
  throw new RouteErrors.Error('invalid_answer', { stage });
}

/**
 * Whether `value` is a `Response` of either class a process holds once a
 * server listens: the adapter's global one, and the platform's own, which a
 * `fetch` answer is an instance of and the adapter's global is not.
 */
function isResponse(value: unknown): value is Response {
  return value instanceof Response || Object.prototype.toString.call(value) === '[object Response]';
}

/**
 * Run `middleware` around `terminal`, outermost first. Each middleware's
 * `next` runs the rest of the chain at most once.
 */
function runChain(
  middleware: readonly RouteMiddleware[],
  context: RequestContext,
  terminal: () => Promise<Response>,
): Promise<Response> {
  const dispatch = async (index: number): Promise<Response> => {
    const current = middleware[index];
    if (current === undefined) return terminal();
    let called = false;
    const next = (): Promise<Response> => {
      if (called) return Promise.reject(new RouteErrors.Error('next_called_twice'));
      called = true;
      return dispatch(index + 1);
    };
    return answerOf('middleware', await current(context, next));
  };
  return dispatch(0);
}
