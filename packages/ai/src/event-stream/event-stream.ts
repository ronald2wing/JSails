/**
 * {@link toEventStream} and {@link toEventStreamResponse}: a run as an ai.v1
 * server-sent event stream.
 *
 * The stream is pull-based with a high-water mark of zero: the run advances
 * only when the HTTP layer reads the next chunk, so a slow or paused browser
 * pauses the run, and through it the provider stream (backpressure). While
 * the run is quiet and the reader is waiting, a comment line goes out every
 * `heartbeatMs` so proxies keep the connection open. Cancelling the stream
 * (the browser went away) or firing `signal` aborts the run, which still
 * settles its `result` as `aborted` with everything appended so far: persist
 * that result, not what the browser saw.
 */

import { AiError } from '../errors/ai-error.js';
import { MAX_TIMER_MS, readTimeout } from '../provider/request-fields.js';
import type { AiRun, AiRunEvent } from '../run/run-contract.js';
import {
  AI_WIRE_VERSION,
  SSE_HEARTBEAT,
  createWireProjector,
  encodeWireEvent,
  type AiWireEvent,
} from './wire-events.js';

/** The default interval between heartbeat comments, in milliseconds. */
export const DEFAULT_HEARTBEAT_MS = 15_000;

/** Options for {@link toEventStream}. */
export interface AiEventStreamOptions {
  /** Aborts the run (pass the request's signal). */
  readonly signal?: AbortSignal;
  /** Milliseconds of silence before a heartbeat comment (default 15 000; 0 means none). */
  readonly heartbeatMs?: number;
  /** Send reasoning deltas to the browser (default `false`). */
  readonly reasoning?: boolean;
}

/** Options for {@link toEventStreamResponse}. */
export interface AiEventStreamResponseInit extends AiEventStreamOptions {
  /** Extra response headers; the content type and caching headers are fixed. */
  readonly headers?: ConstructorParameters<typeof Headers>[0];
}

function invalidOptions(reason: string): AiError {
  return new AiError('invalid_options', 'the event stream options are invalid', {
    context: { reason },
  });
}

function readOptions(options: unknown): {
  signal: AbortSignal | undefined;
  heartbeatMs: number;
  reasoning: boolean;
} {
  if (typeof options !== 'object' || options === null) throw invalidOptions('options');
  const { signal, heartbeatMs, reasoning } = options as AiEventStreamOptions;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw invalidOptions('signal');
  if (reasoning !== undefined && typeof reasoning !== 'boolean') throw invalidOptions('reasoning');
  return {
    signal,
    heartbeatMs: readTimeout(heartbeatMs, DEFAULT_HEARTBEAT_MS, 'heartbeat', invalidOptions),
    reasoning: reasoning === true,
  };
}

function isRun(value: unknown): value is AiRun {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<AiRun>).abort === 'function' &&
    typeof (value as Partial<AsyncIterable<unknown>>)[Symbol.asyncIterator] === 'function'
  );
}

/**
 * A run as a byte stream of ai.v1 events. The run is claimed at once (a run
 * iterates once, so a second consumer throws `AiError('invalid_options')`
 * here), but nothing runs until the stream is read.
 */
export function toEventStream(
  run: AiRun,
  options: AiEventStreamOptions = {},
): ReadableStream<Uint8Array> {
  if (!isRun(run)) throw invalidOptions('run');
  const { signal, heartbeatMs, reasoning } = readOptions(options);
  const iterator: AsyncIterator<AiRunEvent> = run[Symbol.asyncIterator]();
  const projector = createWireProjector({ reasoning });
  const encoder = new TextEncoder();

  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  let started = false;
  let pulling = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onAbort = (): void => run.abort();

  const write = (text: string): void => {
    stream?.enqueue(encoder.encode(text));
    schedule();
  };

  // A heartbeat goes out only while the reader waits on a quiet run, and
  // never piles up behind unread bytes.
  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (closed || heartbeatMs === 0) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        if (closed) return;
        const desired = stream?.desiredSize ?? null;
        if (pulling && desired !== null && desired >= 0) write(SSE_HEARTBEAT);
        else schedule();
      },
      Math.min(heartbeatMs, MAX_TIMER_MS),
    );
  }

  const finish = (): void => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    signal?.removeEventListener('abort', onAbort);
  };

  const send = (events: readonly AiWireEvent[]): boolean => {
    let ended = false;
    for (const event of events) {
      write(encodeWireEvent(event));
      if (event.event === 'finish') ended = true;
    }
    return ended;
  };

  return new ReadableStream<Uint8Array>(
    {
      start(controller): void {
        stream = controller;
        if (signal !== undefined) {
          if (signal.aborted) run.abort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
      },
      async pull(controller): Promise<void> {
        if (closed) return;
        if (!started) {
          started = true;
          send([{ event: 'start', data: { v: AI_WIRE_VERSION } }]);
          return;
        }
        pulling = true;
        schedule();
        try {
          for (;;) {
            const next = await iterator.next();
            if (closed) return;
            if (next.done === true) {
              finish();
              controller.close();
              return;
            }
            const events = projector.project(next.value);
            if (events.length === 0) continue;
            if (send(events)) {
              finish();
              controller.close();
            }
            return;
          }
        } catch {
          if (closed) return;
          send([{ event: 'error', data: { code: 'provider_failed' } }]);
          finish();
          controller.close();
          run.abort();
        } finally {
          pulling = false;
        }
      },
      async cancel(): Promise<void> {
        if (closed) return;
        finish();
        run.abort();
        await iterator.return?.();
      },
    },
    new CountQueuingStrategy({ highWaterMark: 0 }),
  );
}

/**
 * A run as a `text/event-stream` response with caching and proxy buffering
 * off. Pass the request's signal so a disconnect aborts the run even before
 * the body is cancelled.
 */
export function toEventStreamResponse(run: AiRun, init: AiEventStreamResponseInit = {}): Response {
  if (typeof init !== 'object' || init === null) throw invalidOptions('options');
  const { headers: extra, ...options } = init;
  const headers = new Headers(extra);
  headers.set('content-type', 'text/event-stream; charset=utf-8');
  headers.set('cache-control', 'no-store, no-transform');
  headers.set('x-accel-buffering', 'no');
  return new Response(toEventStream(run, options), { status: 200, headers });
}
