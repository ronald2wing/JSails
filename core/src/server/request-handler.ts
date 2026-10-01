/**
 * The request handler: what `app.fetch` runs for every request.
 *
 * Hono stays the router. Around its dispatch the handler owns the three things
 * that must stand outside every route and middleware:
 *
 * 1. the frame: the request id, then the origin and client
 *    (`request-frame.ts`). A host the app does not serve is answered 421 and
 *    a failure to open the frame 500, both before any app code runs, sealed
 *    without a frame (`private, no-store`, the security headers, the request id);
 * 2. the one execution context: everything after the frame opens, the guard
 *    tier, routing, the handler, the error page and the finalizer, runs in a
 *    single `AsyncLocalStorage` run;
 * 3. the finalizer (`output.ts`): every answer, a guard's, a route's, a
 *    failure's, leaves through it exactly once. An answer the finalizer
 *    cannot send (its body already read or locked by a middleware) is a
 *    failure like any other: reported, and its failure answer finalized.
 *
 * The guard tier runs first, before assets, routes and the not-found answer.
 * A GET or HEAD of a file in the asset index is answered next, from the
 * index, without entering the router (`assets/responder.ts`). A throw that escapes Hono (Hono hands only `Error`s to its error
 * stage, so a thrown string or plain object rejects its dispatch) is reported
 * and rendered here like any other failure.
 *
 * The request body (`body-budget.ts`): the router receives the frame's
 * request, whose body is read through the budget. A body declaring more than
 * `MAX_ROUTE_BODY_BYTES` is answered 413 after the guards, before routing. A
 * request whose budget a read went past is answered 413 whatever its route
 * answered (a route, mount or guard that caught the read error included). An
 * answer of 400 or above that leaves the body unread, and every 413, closes
 * the connection (`Connection: close`), so the server never drains a body
 * nobody wants; a client waiting on `Expect: 100-continue` was never invited
 * to send it.
 *
 * HEAD: Hono answers a HEAD with a bodiless copy of the GET answer. The
 * capture middleware ({@link RequestHandler.capture}, the app's first) keeps
 * the GET answer itself, so a HEAD is finalized from what a GET receives:
 * the same validator and coding, `Content-Length` when the body is sent
 * unencoded, and no body.
 *
 * Shutdown: the frame is bound to the adapter's `IncomingMessage`
 * (`env.incoming`, see `served-frames.ts`), so a draining server reads each
 * in-flight request's answer kind from its frame, and a live answer ends when
 * that server's drain starts.
 */

import type { Hono } from 'hono';

import { toFailure } from '../api/error-response.js';
import { failureResponse } from '../api/failure-response.js';
import type { AssetResponder } from '../assets/responder.js';
import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import { accessProbeOf, attachAccessProbe } from '../security/access-record.js';
import { detach, escalate } from '../support/detach.js';
import { tooLarge } from '../errors/kernel.js';
import { bodyWire, declaredBodyLength } from './body-budget.js';
import { MAX_ROUTE_BODY_BYTES } from './route-limits.js';
import { discardResponse } from './deadline.js';
import type { AppContext, AppEnv, AppMiddlewareHandler } from './env.js';
import type { FailureRenderer } from './failure-renderer.js';
import { finalize, sealUnframed } from './output.js';
import { httpFailure } from './request-pipeline.js';
import { bindServedFrame } from './served-frames.js';
import {
  openFrame,
  requestIdOf,
  runGuards,
  socketPeer,
  type FrameRuntime,
  type Guard,
  frameInternals,
  type RequestFrame,
} from './request-frame.js';

const REQUEST_HANDLER_ERRORS = {
  unframed: {
    kind: 'internal',
    message: 'a request reached the router without passing the request handler',
  },
} as const;

/**
 * The handler's own fault: the router was entered with a request the handler
 * did not open a frame for (Hono's dispatch called directly).
 */
export const RequestHandlerErrors: ErrorRegistry<'request_handler', typeof REQUEST_HANDLER_ERRORS> =
  defineErrors('request_handler', REQUEST_HANDLER_ERRORS);

/** Hono's own `fetch`, which the handler wraps. */
export type Dispatch = Hono<AppEnv>['fetch'];

/** Options for {@link createRequestHandler}. */
export interface RequestHandlerOptions {
  readonly runtime: FrameRuntime;
  readonly guards: readonly Guard[];
  readonly renderFailure: FailureRenderer;
  /** The asset fast path, between the guards and the router. */
  readonly assets?: AssetResponder | undefined;
}

/** The handler and the middleware it needs inside the router. */
export interface RequestHandler {
  /** Serve one request: `app.fetch`. */
  fetch(request: Request, env?: unknown, executionContext?: unknown): Promise<Response>;
  /**
   * The app's first middleware: puts the request's frame on the router
   * context (`c.var.frame`) and keeps the GET answer a HEAD is finalized from.
   */
  readonly capture: AppMiddlewareHandler;
  /**
   * The frame of the request the router is answering, for the not-found and
   * error handlers: a path no pattern matches (one whose decoded form holds a
   * line break matches not even `*`) reaches them without `capture` running.
   */
  frameOf(c: AppContext): RequestFrame;
}

/** The request handler around `dispatch` (Hono's own `fetch`). */
export function createRequestHandler(
  options: RequestHandlerOptions,
  dispatch: Dispatch,
): RequestHandler {
  const { runtime, guards, renderFailure, assets } = options;
  const frames = new WeakMap<Request, RequestFrame>();
  const frameOf = (c: AppContext): RequestFrame => {
    const frame = frames.get(c.req.raw);
    if (frame === undefined) throw new RequestHandlerErrors.Error('unframed');
    return frame;
  };
  const heads = new WeakMap<RequestFrame, Response>();

  async function answer(
    frame: RequestFrame,
    request: Request,
    env: unknown,
    executionContext: unknown,
  ): Promise<Response> {
    const guarded = await runGuards(frame, guards, runtime.probePaths);
    if (guarded.kind === 'answered') return guarded.response;
    if (guarded.kind === 'failed') {
      frame.report(guarded.error, 'guard');
      return renderFailure(frame, toFailure(guarded.error));
    }
    if (assets !== undefined && (request.method === 'GET' || request.method === 'HEAD')) {
      const asset = assets.respond(frame);
      // A miss passes on without an await; a development file that left the
      // index while it was answered passes on once settled.
      const answered = asset === undefined ? undefined : await asset;
      if (answered !== undefined) return answered;
    }
    const length = declaredBodyLength(request);
    if (length !== undefined && length > MAX_ROUTE_BODY_BYTES) {
      return renderFailure(frame, toFailure(tooLarge()), { claimless: true });
    }
    // The adapter's bindings and execution context pass through untouched.
    const dispatched = await dispatch(request, env, executionContext as never);
    return request.method === 'HEAD' ? (heads.get(frame) ?? dispatched) : dispatched;
  }

  async function serve(
    frame: RequestFrame,
    request: Request,
    env: unknown,
    executionContext: unknown,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await answer(frame, request, env, executionContext);
    } catch (error) {
      frame.report(error, 'handler');
      response = await renderFailure(frame, toFailure(error));
    }
    const budget = frameInternals(frame)?.budget;
    if (budget?.exceeded === true && response.status !== 413) {
      discardResponse(response);
      response = await renderFailure(frame, toFailure(tooLarge()));
    }
    let finalized: Response;
    try {
      finalized = await finalize(frame, response);
    } catch (error) {
      // The answer cannot be sent as it is; its failure answer is the
      // framework's own bytes, which finalize always takes.
      frame.report(error, 'handler');
      finalized = await finalize(frame, await renderFailure(frame, toFailure(error)));
    }
    if (budget !== undefined && (budget.exceeded || (finalized.status >= 400 && budget.unread))) {
      finalized.headers.set('connection', 'close');
    }
    return finalized;
  }

  return {
    async fetch(request, env, executionContext) {
      const id = requestIdOf(request);
      let opened: ReturnType<typeof openFrame>;
      try {
        opened = openFrame(runtime, request, socketPeer(env), id, bodyWire(env));
      } catch (error) {
        detach(
          runtime.reportError(error, {
            phase: 'frame',
            method: request.method,
            route: '*',
            requestId: id,
          }),
          escalate,
        );
        return sealUnframed(failureResponse(toFailure(error)), id);
      }
      if (opened === undefined) {
        return sealUnframed(failureResponse(httpFailure('misdirected_request', 421)), id);
      }
      const { frame } = opened;
      bindServedFrame(env, frame);
      // The router serves the frame's request: its body is the budget's.
      frames.set(frame.request, frame);
      // An access-matrix probe follows its request onto the frame's.
      const probe = accessProbeOf(request);
      if (probe !== undefined) attachAccessProbe(frame.request, probe);
      return opened.run(() => serve(frame, frame.request, env, executionContext));
    },
    capture: async (c, next) => {
      const frame = frameOf(c);
      c.set('frame', frame);
      await next();
      if (c.req.method === 'HEAD') heads.set(frame, c.res);
    },
    frameOf,
  };
}
