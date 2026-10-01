/**
 * {@link readAiEvents}: the ai.v1 events of a `fetch` response, for the
 * browser (or any runtime with WHATWG streams).
 *
 * The response must be a 2xx `text/event-stream`. Events are decoded as UTF-8
 * across chunk boundaries, parsed by the WHATWG rules, and checked against
 * the ai.v1 shapes; the first must be `start` and iteration ends after
 * `finish`. A stream that ends before `finish` (a dropped connection) is
 * `AiError('stream_failed')` with reason `truncated` (or `network` when the
 * read itself fails), so a cut-off reply is never mistaken for a complete
 * one. Leaving the loop early, or firing
 * `signal`, cancels the body, which tells the server to abort the run; the
 * signal makes the iteration throw `AiError('aborted')`.
 */

import { AiError } from '../errors/ai-error.js';
import type { AiWireEvent } from '../event-stream/wire-events.js';
import { createSseParser } from './sse-parser.js';
import { decodeWireEvent, streamFailed } from './wire-decoding.js';

/** Options for {@link readAiEvents}. */
export interface ReadAiEventsOptions {
  /** Stops reading and cancels the response body. */
  readonly signal?: AbortSignal;
}

const EVENT_STREAM = /^text\/event-stream\s*(;|$)/i;

/** Read through a call so a check after an `await` is not narrowed away. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function aborted(): AiError {
  return new AiError('aborted', 'reading the event stream was aborted');
}

function isResponse(value: unknown): value is Response {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<Response>).ok === 'boolean' &&
    typeof (value as Partial<Response>).status === 'number' &&
    typeof (value as Partial<Response>).headers?.get === 'function'
  );
}

/** Iterate the ai.v1 events of `response`. */
export async function* readAiEvents(
  response: Response,
  options: ReadAiEventsOptions = {},
): AsyncGenerator<AiWireEvent, void, undefined> {
  if (!isResponse(response)) {
    throw new AiError('invalid_options', 'readAiEvents needs a fetch response');
  }
  const signal = options.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new AiError('invalid_options', 'the signal must be an AbortSignal');
  }
  if (!response.ok) throw streamFailed('status', response.status);
  if (!EVENT_STREAM.test(response.headers.get('content-type') ?? '')) {
    throw streamFailed('content_type');
  }
  const body = response.body;
  if (body === null) throw streamFailed('body');
  if (isAborted(signal)) {
    // The abort is what the caller sees; a failing cancel of the unread body
    // adds nothing.
    await body.cancel().catch(() => undefined);
    throw aborted();
  }

  const reader = body.getReader();
  // The parser drops one leading BOM itself, so the decoder must keep it.
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const queue: AiWireEvent[] = [];
  let failure: unknown;
  const parser = createSseParser((sse) => {
    if (failure !== undefined) return;
    try {
      const event = decodeWireEvent(sse);
      if (event !== undefined) queue.push(event);
    } catch (error) {
      failure = error;
    }
  });
  const onAbort = (): void => {
    // Cancelling unblocks the pending read, and the read loop reports the
    // abort; the cancel's own failure adds nothing.
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  let started = false;
  let drained = false;
  try {
    for (;;) {
      let index = 0;
      while (index < queue.length) {
        const event = queue[index] as AiWireEvent;
        index += 1;
        if ((event.event === 'start') === started) throw streamFailed('order');
        started = true;
        yield event;
        if (event.event === 'finish') return;
      }
      queue.length = 0;
      if (failure !== undefined) throw failure;
      if (drained) throw streamFailed('truncated');
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        // The fetch was aborted, or the connection broke mid-stream.
        if (isAborted(signal)) throw aborted();
        throw new AiError('stream_failed', 'the event stream is not a valid ai.v1 stream', {
          context: { reason: 'network' },
          cause: error,
        });
      }
      if (isAborted(signal)) throw aborted();
      if (chunk.done) {
        drained = true;
        parser.push(decoder.decode());
        parser.end();
      } else {
        parser.push(decoder.decode(chunk.value, { stream: true }));
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Releasing an undrained stream on the way out: the error, abort, or early
    // return that ended the read wins over a failing cancel.
    if (!drained) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
