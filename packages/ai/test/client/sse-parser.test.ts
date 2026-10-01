/**
 * `createSseParser` against the WHATWG event-stream rules: LF, CR, and CRLF
 * endings, one leading BOM, comments, multi-line data, the space after the
 * colon, fields without a colon, an `id` with NUL ignored, a non-digit
 * `retry` ignored, dispatch only on a blank line and only with data, the
 * default `message` type, an incomplete event discarded at the end, and the
 * same events for every split of the text (and of its UTF-8 bytes).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSseParser, type SseEvent } from '../../src/client/sse-parser.js';

function parse(chunks: readonly string[]): { events: SseEvent[]; retry: number | undefined } {
  const events: SseEvent[] = [];
  const parser = createSseParser((event) => events.push(event));
  for (const chunk of chunks) parser.push(chunk);
  parser.end();
  return { events, retry: parser.retry };
}

function only(text: string): SseEvent[] {
  return parse([text]).events;
}

describe('createSseParser: WHATWG vectors', () => {
  it('accepts LF, CR, and CRLF line endings alike', () => {
    for (const eol of ['\n', '\r', '\r\n']) {
      assert.deepEqual(only(`event: a${eol}data: 1${eol}${eol}`), [
        { event: 'a', data: '1', id: '' },
      ]);
    }
  });

  it('skips exactly one leading BOM', () => {
    assert.deepEqual(only('\uFEFFdata: x\n\n'), [{ event: 'message', data: 'x', id: '' }]);
    assert.deepEqual(only('\uFEFF\uFEFFdata: x\n\n'), []);
  });

  it('ignores comments and unknown fields', () => {
    assert.deepEqual(only(': hello\nfoo: bar\ndata: x\n:\n\n'), [
      { event: 'message', data: 'x', id: '' },
    ]);
  });

  it('joins multi-line data with LF and strips only one leading space', () => {
    assert.deepEqual(only('data: a\ndata:  b\ndata:c\n\n'), [
      { event: 'message', data: 'a\n b\nc', id: '' },
    ]);
  });

  it('treats a field without a colon as an empty value', () => {
    assert.deepEqual(only('data\ndata\n\n'), [{ event: 'message', data: '\n', id: '' }]);
    assert.deepEqual(only('data\n\n'), [{ event: 'message', data: '', id: '' }]);
  });

  it('dispatches only on a blank line, and only when data was seen', () => {
    assert.deepEqual(only('event: a\n\ndata: x\n\n'), [{ event: 'message', data: 'x', id: '' }]);
    assert.deepEqual(only('data: x\n'), []);
    assert.deepEqual(only('data: x'), []);
  });

  it('keeps the last event id across events and ignores one containing NUL', () => {
    assert.deepEqual(only('id: 7\ndata: a\n\ndata: b\n\nid: x\0y\ndata: c\n\nid\ndata: d\n\n'), [
      { event: 'message', data: 'a', id: '7' },
      { event: 'message', data: 'b', id: '7' },
      { event: 'message', data: 'c', id: '7' },
      { event: 'message', data: 'd', id: '' },
    ]);
  });

  it('accepts only an all-digit retry', () => {
    assert.equal(parse(['retry: 1500\n']).retry, 1500);
    assert.equal(parse(['retry: 15x\n']).retry, undefined);
    assert.equal(parse(['retry: 10\nretry: -5\nretry: 1.5\n']).retry, 10);
  });

  it('a CR then LF across chunks is one line ending, a lone CR at the end still ends a line', () => {
    assert.deepEqual(parse(['data: a\r', '\ndata: b\r', '\n\r', '\n']).events, [
      { event: 'message', data: 'a\nb', id: '' },
    ]);
    assert.deepEqual(parse(['data: a\n\r']).events, [{ event: 'message', data: 'a', id: '' }]);
  });

  it('ignores input after end', () => {
    const events: SseEvent[] = [];
    const parser = createSseParser((event) => events.push(event));
    parser.end();
    parser.push('data: x\n\n');
    assert.deepEqual(events, []);
  });
});

describe('createSseParser: chunk-boundary invariance', () => {
  const stream =
    '\uFEFFevent: text\r\ndata: {"delta":"h\u00e9llo \ud83d\ude00"}\r\n\r\n' +
    ': ping\rid: 1\rdata: a\rdata: b\r\r' +
    'event: finish\ndata: \u2028x\n\ndata: tail-without-blank-line\n';

  it('yields the same events for every split into two and three chunks', () => {
    const whole = only(stream);
    assert.equal(whole.length, 3);
    for (let i = 0; i <= stream.length; i += 1) {
      assert.deepEqual(parse([stream.slice(0, i), stream.slice(i)]).events, whole, `split ${i}`);
      for (let j = i; j <= stream.length; j += 7) {
        assert.deepEqual(
          parse([stream.slice(0, i), stream.slice(i, j), stream.slice(j)]).events,
          whole,
        );
      }
    }
  });

  it('yields the same events for every split of the UTF-8 bytes, inside code points too', () => {
    const bytes = new TextEncoder().encode(stream);
    const whole = only(stream.slice(1));
    for (let i = 0; i <= bytes.length; i += 1) {
      const decoder = new TextDecoder();
      const chunks = [
        decoder.decode(bytes.slice(0, i), { stream: true }),
        decoder.decode(bytes.slice(i), { stream: true }),
        decoder.decode(),
      ];
      assert.deepEqual(parse(chunks).events, whole, `byte split ${i}`);
    }
  });

  it('yields the same events one character at a time', () => {
    assert.deepEqual(parse(Array.from(stream)).events, only(stream));
  });
});
