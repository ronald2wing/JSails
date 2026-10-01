/**
 * {@link createSseParser}: the event-stream interpretation rules of the WHATWG
 * HTML standard (section 9.2.6), fed decoded text in chunks of any size.
 *
 * Lines end at CRLF, LF, or CR; a CR at the end of a chunk waits for the next
 * chunk, so a CRLF split across chunks is one line ending. One leading BOM is
 * skipped. A line starting with `:` is a comment. `data` lines accumulate
 * with LF between them; a blank line dispatches, and only when data was seen.
 * An `id` containing NUL is ignored, a `retry` that is not all ASCII digits
 * is ignored, and unknown fields are ignored. At the end of the stream an
 * event without its blank line is discarded. The result is the same for
 * every way the text is split into chunks.
 */

/** One dispatched event. */
export interface SseEvent {
  /** The `event` field, or `message` when none was given. */
  readonly event: string;
  readonly data: string;
  /** The last event id seen on the stream so far (`''` for none). */
  readonly id: string;
}

/** A push parser over decoded text. */
export interface SseParser {
  /** Feed the next chunk of text. */
  push(chunk: string): void;
  /** The stream ended: finish a pending line and discard an incomplete event. */
  end(): void;
  /** The last valid `retry` value in milliseconds, if any. */
  readonly retry: number | undefined;
}

const DIGITS = /^[0-9]+$/;

/** A parser that calls `onEvent` for every dispatched event, in order. */
export function createSseParser(onEvent: (event: SseEvent) => void): SseParser {
  let buffer = '';
  let atStart = true;
  let pendingCr = false;
  let ended = false;
  let data = '';
  let hasData = false;
  let eventType = '';
  let lastEventId = '';
  let retry: number | undefined;

  const dispatch = (): void => {
    if (!hasData) {
      eventType = '';
      return;
    }
    const event: SseEvent = Object.freeze({
      event: eventType === '' ? 'message' : eventType,
      data: data.endsWith('\n') ? data.slice(0, -1) : data,
      id: lastEventId,
    });
    data = '';
    hasData = false;
    eventType = '';
    onEvent(event);
  };

  const line = (text: string): void => {
    if (text === '') {
      dispatch();
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        eventType = value;
        break;
      case 'data':
        data += `${value}\n`;
        hasData = true;
        break;
      case 'id':
        if (!value.includes('\0')) lastEventId = value;
        break;
      case 'retry':
        if (DIGITS.test(value)) retry = Number(value);
        break;
      default:
        break;
    }
  };

  // `scanned` counts the leading buffer characters already known to hold no
  // line terminator, so a long line fed in small chunks is scanned once.
  let scanned = 0;
  const drain = (): void => {
    let from = 0;
    for (;;) {
      if (pendingCr) {
        pendingCr = false;
        if (buffer[from] === '\n') from += 1;
      }
      let at = Math.max(from, scanned);
      scanned = 0;
      while (at < buffer.length && buffer[at] !== '\n' && buffer[at] !== '\r') at += 1;
      if (at === buffer.length) break;
      line(buffer.slice(from, at));
      if (buffer[at] === '\r') {
        if (at + 1 === buffer.length) {
          pendingCr = true;
          from = at + 1;
          break;
        }
        from = buffer[at + 1] === '\n' ? at + 2 : at + 1;
      } else {
        from = at + 1;
      }
    }
    buffer = buffer.slice(from);
    scanned = pendingCr ? 0 : buffer.length;
  };

  return {
    push(chunk: string): void {
      if (ended || chunk.length === 0) return;
      let text = chunk;
      if (atStart) {
        atStart = false;
        if (text.startsWith('﻿')) text = text.slice(1);
      }
      buffer += text;
      drain();
    },
    end(): void {
      if (ended) return;
      ended = true;
      buffer = '';
      scanned = 0;
      pendingCr = false;
      data = '';
      hasData = false;
      eventType = '';
    },
    get retry(): number | undefined {
      return retry;
    },
  };
}
