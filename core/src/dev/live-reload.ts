/**
 * Dev live-reload — refresh the browser when the build changes.
 *
 * The honest HMR for a restarting SSR stack is not state-preserving module
 * replacement (which needs a Vite dev server and a module graph), it is
 * **reload-on-change**: an SSE stream at `/_jsails/dev/reload` that the browser
 * subscribes to in development.
 *
 * The reload signal is a **build generation**, not a reconnect. A reconnect is
 * ambiguous — it can mean "the server restarted" or "the laptop slept" — and it
 * misses the two cases that matter: a restart faster than the client's retry,
 * and a client-only change where the connection never drops at all. The
 * generation is unambiguous: the server embeds the value it rendered with into
 * the document, and the stream reports the current value. A difference means
 * the page is stale.
 *
 * The stream is `Respond.eventStream`'s, so it is live (never stored,
 * compressed or buffered, and ended when the server drains). Its source ends,
 * releasing its heartbeat timer and its channel subscription, on whichever
 * comes first: the route's abort signal (the client went away) or the
 * stream's cancel (a drain, or the reader giving up).
 *
 * This module is server-only and dev-only. It is never mounted in production.
 */

import { eventStream, type EventStreamMessage } from '../api/responses.js';
import type { GenerationChannel } from './generation.js';

/** The global the injected script reads the rendered generation from. */
export const DEV_GENERATION_GLOBAL = '__jsailsDevGeneration';

/**
 * The inline `<script>` the dev server appends to every HTML response.
 *
 * The baseline assignment and the subscriber live in one block, assignment
 * first: a script that subscribed before knowing its baseline would treat the
 * first frame as a change and reload in a loop.
 */
export function devReloadScript(generation: number): string {
  return `(function () {
  window.${DEV_GENERATION_GLOBAL} = ${generation};
  var url = '/_jsails/dev/reload';
  var es;
  function connect() {
    es = new EventSource(url);
    es.addEventListener('generation', function (event) {
      var next = Number(JSON.parse(event.data).generation);
      if (next !== window.${DEV_GENERATION_GLOBAL}) { location.reload(); }
    });
    es.onerror = function () { es.close(); setTimeout(connect, 1000); };
  }
  connect();
})();`;
}

/** How often an idle stream sends a heartbeat, so an idle connection is not cut. */
const HEARTBEAT_MS = 15_000;

/** The event a heartbeat is sent as: the client listens for `generation` only. */
const HEARTBEAT: EventStreamMessage = Object.freeze({ event: 'heartbeat', data: '' });

/** Options for {@link liveReloadResponse}. */
export interface LiveReloadOptions {
  /** The `retry` hint sent with the first event: the client probes again after it. Default 1000. */
  readonly retryMs?: number;
  /** The generation source. Without one the stream reports a constant 0. */
  readonly channel?: GenerationChannel;
  /** Ends the stream when it aborts: the route's `ctx.signal`. */
  readonly signal?: AbortSignal;
  /** Milliseconds between heartbeats of an idle stream. Default 15000. */
  readonly heartbeatMs?: number;
}

/** The event reporting `generation`. */
function generationEvent(generation: number, retry?: number): EventStreamMessage {
  return {
    event: 'generation',
    data: JSON.stringify({ generation }),
    ...(retry === undefined ? {} : { retry }),
  };
}

/**
 * A `Response` streaming the reload channel. Use as the handler for the
 * `GET /_jsails/dev/reload` route, passing the route's `ctx.signal`: the
 * first event carries the retry hint and the current generation, each change
 * of the channel is one more event, and an idle stream sends a heartbeat.
 */
export function liveReloadResponse(options: LiveReloadOptions = {}): Response {
  return eventStream(reloadEvents(options));
}

/**
 * The reload events, as an iterator that ends without waiting for its next
 * wake-up: `return()` (a cancel or a drain) and the signal each end it at
 * once, clearing the timer and the subscription. Nothing is subscribed or
 * timed until the stream is first read.
 */
function reloadEvents(options: LiveReloadOptions): AsyncIterable<EventStreamMessage> {
  const { channel, signal } = options;
  const retryMs = options.retryMs ?? 1000;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  return {
    [Symbol.asyncIterator](): AsyncIterator<EventStreamMessage> {
      let started = false;
      let ended = false;
      let changed: number | undefined;
      let heartbeatDue = false;
      let wake: (() => void) | undefined;
      const notify = (): void => {
        const resolve = wake;
        wake = undefined;
        resolve?.();
      };
      const unsubscribe = channel?.subscribe((generation) => {
        changed = generation;
        notify();
      });
      const timer = setInterval(() => {
        heartbeatDue = true;
        notify();
      }, heartbeatMs);
      timer.unref();
      const end = (): void => {
        if (ended) return;
        ended = true;
        clearInterval(timer);
        unsubscribe?.();
        signal?.removeEventListener('abort', end);
        notify();
      };
      if (signal?.aborted === true) end();
      else signal?.addEventListener('abort', end, { once: true });
      const done: IteratorReturnResult<undefined> = { done: true, value: undefined };
      return {
        async next(): Promise<IteratorResult<EventStreamMessage, undefined>> {
          if (!started) {
            started = true;
            if (!ended) {
              return { done: false, value: generationEvent(channel?.current() ?? 0, retryMs) };
            }
          }
          while (!ended) {
            if (changed !== undefined) {
              const generation = changed;
              changed = undefined;
              return { done: false, value: generationEvent(generation) };
            }
            if (heartbeatDue) {
              heartbeatDue = false;
              return { done: false, value: HEARTBEAT };
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          return done;
        },
        async return(): Promise<IteratorResult<EventStreamMessage, undefined>> {
          end();
          return done;
        },
      };
    },
  };
}
