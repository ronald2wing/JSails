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
 * This module is server-only and dev-only. It is never mounted in production.
 */

import type { GenerationChannel } from './dev-generation.js';

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

/** A comment frame: a heartbeat the client never mistakes for a generation. */
const SSE_HEARTBEAT = ': keep-alive\n\n';

/** Options for {@link liveReloadResponse}. */
export interface LiveReloadOptions {
  /** Emit a `retry` hint so the client probes again after `retryMs`. Default 1000. */
  readonly retryMs?: number;
  /** The generation source. Without one the stream reports a constant 0. */
  readonly channel?: GenerationChannel;
}

/**
 * A `Response` streaming the reload channel. Use as the handler for the
 * `GET /_jsails/dev/reload` route; the connection stays open until the client
 * or server drops it.
 */
export function liveReloadResponse(options: LiveReloadOptions = {}): Response {
  const retryMs = options.retryMs ?? 1000;
  const channel = options.channel;
  let timer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (generation: number): void => {
        try {
          controller.enqueue(
            encoder.encode(`event: generation\ndata: {"generation":${generation}}\n\n`),
          );
        } catch {
          // The client went away between the poll and the write. Stop listening;
          // `cancel` may not run when the stream is already errored.
          unsubscribe?.();
          unsubscribe = undefined;
        }
      };

      controller.enqueue(encoder.encode(`retry: ${retryMs}\n\n`));
      send(channel?.current() ?? 0);
      unsubscribe = channel?.subscribe(send);
      timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(SSE_HEARTBEAT));
        } catch {
          // Same as above: a dead stream needs no heartbeat.
          if (timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
          }
        }
      }, 15000);
    },
    cancel() {
      // The stream was closed (browser navigated away, or a test cancelled).
      // Clear the heartbeat and the subscription so the event loop can drain.
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      unsubscribe?.();
      unsubscribe = undefined;
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    },
  });
}
