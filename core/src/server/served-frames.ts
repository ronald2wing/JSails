/**
 * The link between a listening server and the request pipeline, for the
 * server's drain (`app/serve.ts`).
 *
 * The server hands every request it accepts its drain signal
 * ({@link serveRequest}), keyed by the Node `IncomingMessage`. The request
 * handler, opening the request's frame, binds the frame to that message
 * ({@link bindServedFrame}). From then on the server reads each in-flight
 * request's frame, and through it the answer's kind (`output.ts` `answerOf`),
 * from the message alone ({@link servedFrameOf}); and the finalizer ends a
 * live answer when the drain starts ({@link drainSignalOf}). A request served
 * in process (`app.fetch`) has no message, so it is bound to nothing and its
 * live answer is the caller's to end.
 */

import type { RequestFrame } from './request-frame.js';

/** Each accepted request's server drain signal, by its `IncomingMessage`. */
const drainOfIncoming = new WeakMap<object, AbortSignal>();

/** Each accepted request's frame, by its `IncomingMessage`. */
const frameOfIncoming = new WeakMap<object, RequestFrame>();

/** Each served frame's server drain signal. */
const drainOfFrame = new WeakMap<RequestFrame, AbortSignal>();

/** Record that the server whose drain aborts `draining` accepted `incoming`. */
export function serveRequest(incoming: object, draining: AbortSignal): void {
  drainOfIncoming.set(incoming, draining);
}

/**
 * Bind `frame` to the `IncomingMessage` the Node adapter passes in `env`
 * (`env.incoming`), when a server accepted it. A request served in process is
 * left unbound.
 */
export function bindServedFrame(env: unknown, frame: RequestFrame): void {
  if (env === null || typeof env !== 'object') return;
  const incoming = (env as { incoming?: unknown }).incoming;
  if (incoming === null || typeof incoming !== 'object') return;
  const draining = drainOfIncoming.get(incoming);
  if (draining === undefined) return;
  frameOfIncoming.set(incoming, frame);
  drainOfFrame.set(frame, draining);
}

/** The frame the request handler opened for `incoming`, if any. */
export function servedFrameOf(incoming: object): RequestFrame | undefined {
  return frameOfIncoming.get(incoming);
}

/** The drain signal of the server that accepted `frame`'s request, if any. */
export function drainSignalOf(frame: RequestFrame): AbortSignal | undefined {
  return drainOfFrame.get(frame);
}
