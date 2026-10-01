/**
 * `readAiEvents` over `Response` objects: decoded events in order, unknown
 * events skipped, iteration ends at `finish`, a non-2xx status, a wrong
 * content type, a missing body, events before `start`, malformed data, an
 * unknown version, and a cut-off stream are `stream_failed` (value-free),
 * the abort signal and an early `break` cancel the body, and decoding
 * survives multi-byte characters split across chunks.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AiError } from '../../src/errors/ai-error.js';
import { readAiEvents } from '../../src/client/read-ai-events.js';
import type { AiWireEvent } from '../../src/event-stream/wire-events.js';

const SSE = { 'content-type': 'text/event-stream; charset=utf-8' };
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const START = 'event: start\ndata: {"v":1}\n\n';
const FINISH = `event: finish\ndata: ${JSON.stringify({ status: 'completed', usage })}\n\n`;

interface Body {
  readonly stream: ReadableStream<Uint8Array>;
  cancelled: boolean;
}

function body(chunks: readonly (string | Uint8Array)[], hold = false): Body {
  const encoder = new TextEncoder();
  const state: Body = {
    cancelled: false,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
        }
        if (!hold) controller.close();
      },
      cancel() {
        state.cancelled = true;
      },
    }),
  };
  return state;
}

function response(chunks: readonly (string | Uint8Array)[], init: ResponseInit = {}): Response {
  return new Response(body(chunks).stream, { headers: SSE, ...init });
}

async function collect(source: AsyncIterable<AiWireEvent>): Promise<AiWireEvent[]> {
  const events: AiWireEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

async function failsWith(
  source: AsyncIterable<AiWireEvent>,
  code: string,
  reason?: string,
): Promise<void> {
  await assert.rejects(collect(source), (error) => {
    assert.ok(error instanceof AiError);
    assert.equal(error.code, code);
    if (reason !== undefined) assert.equal(error.context?.reason, reason);
    assert.ok(!error.message.includes('CANARY'));
    return true;
  });
}

describe('readAiEvents', () => {
  it('yields decoded events in order, skips unknown ones, and stops at finish', async () => {
    const events = await collect(
      readAiEvents(
        response([
          START,
          'event: future\ndata: {"x":1}\n\n',
          'data: plain message\n\n',
          'event: text\ndata: {"delta":"hi"}\n\n',
          FINISH,
          'event: text\ndata: {"delta":"after"}\n\n',
        ]),
      ),
    );
    assert.deepEqual(
      events.map((event) => event.event),
      ['start', 'text', 'finish'],
    );
    assert.ok(Object.isFrozen(events[1]));
  });

  it('decodes characters split across byte chunks', async () => {
    const bytes = new TextEncoder().encode(
      `${START}event: text\ndata: {"delta":"é😀"}\n\n${FINISH}`,
    );
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
    const events = await collect(readAiEvents(response(chunks)));
    assert.deepEqual(events[1], { event: 'text', data: { delta: 'é😀' } });
  });

  it('rejects a non-2xx status, a wrong content type, and a missing body', async () => {
    await failsWith(readAiEvents(response([START], { status: 500 })), 'stream_failed', 'status');
    await failsWith(
      readAiEvents(new Response('CANARY', { headers: { 'content-type': 'text/plain' } })),
      'stream_failed',
      'content_type',
    );
    await failsWith(readAiEvents(new Response(null, { headers: SSE })), 'stream_failed', 'body');
    await failsWith(readAiEvents({} as Response), 'invalid_options');
  });

  it('rejects events before start, a second start, and another version', async () => {
    await failsWith(readAiEvents(response([FINISH])), 'stream_failed', 'order');
    await failsWith(readAiEvents(response([START, START])), 'stream_failed', 'order');
    await failsWith(
      readAiEvents(response(['event: start\ndata: {"v":2}\n\n'])),
      'stream_failed',
      'version',
    );
  });

  it('rejects malformed data without echoing it', async () => {
    const cases: [string, string][] = [
      ['event: text\ndata: CANARY\n\n', 'data'],
      ['event: text\ndata: ["CANARY"]\n\n', 'data'],
      ['event: text\ndata: {"delta":1}\n\n', 'text'],
      ['event: tool\ndata: {"id":"c","name":"n","state":"CANARY"}\n\n', 'tool'],
      ['event: tool\ndata: {"id":"c","name":"n","state":"done","code":"CANARY"}\n\n', 'tool'],
      ['event: tool\ndata: {"id":"c","name":"n","state":"done","output":5}\n\n', 'tool_output'],
      ['event: approval\ndata: {"calls":[{"id":"c"}]}\n\n', 'approval'],
      ['event: error\ndata: {"code":"CANARY"}\n\n', 'error'],
      ['event: finish\ndata: {"status":"done","usage":{}}\n\n', 'finish'],
      ['event: step\ndata: {"index":-1}\n\n', 'step'],
    ];
    for (const [event, reason] of cases) {
      await failsWith(readAiEvents(response([START, event])), 'stream_failed', reason);
    }
  });

  it('a stream cut before finish is truncated, after the events it did carry', async () => {
    const seen: string[] = [];
    await assert.rejects(
      (async () => {
        for await (const event of readAiEvents(
          response([START, 'event: text\ndata: {"delta":"par"}\n\n']),
        )) {
          seen.push(event.event);
        }
      })(),
      (error) => error instanceof AiError && error.context?.reason === 'truncated',
    );
    assert.deepEqual(seen, ['start', 'text']);
  });

  it('a read that fails mid-stream is stream_failed with reason network, the error kept as cause', async () => {
    const broken = new Error('socket hang up CANARY');
    const encoder = new TextEncoder();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(encoder.encode(START));
        else controller.error(broken);
      },
    });
    await assert.rejects(
      collect(readAiEvents(new Response(stream, { headers: SSE }))),
      (error) =>
        error instanceof AiError &&
        error.code === 'stream_failed' &&
        error.context?.reason === 'network' &&
        error.cause === broken &&
        !error.message.includes('CANARY'),
    );
  });

  it('a read rejected by the aborted fetch is aborted, not a network failure', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(source) {
        source.enqueue(new TextEncoder().encode(START));
        controller.signal.addEventListener('abort', () => source.error(controller.signal.reason));
      },
    });
    const iterator = readAiEvents(new Response(stream, { headers: SSE }), {
      signal: controller.signal,
    });
    assert.equal((await iterator.next()).value?.event, 'start');
    const pending = iterator.next();
    controller.abort();
    await assert.rejects(pending, (error) => error instanceof AiError && error.code === 'aborted');
  });

  it('cancels the body when the loop is left early', async () => {
    const source = body([START, 'event: text\ndata: {"delta":"a"}\n\n'], true);
    for await (const event of readAiEvents(new Response(source.stream, { headers: SSE }))) {
      if (event.event === 'text') break;
    }
    assert.equal(source.cancelled, true);
  });

  it('the signal cancels the body and makes the iteration throw aborted', async () => {
    const source = body([START], true);
    const controller = new AbortController();
    const seen: string[] = [];
    await assert.rejects(
      (async () => {
        for await (const event of readAiEvents(new Response(source.stream, { headers: SSE }), {
          signal: controller.signal,
        })) {
          seen.push(event.event);
          controller.abort();
        }
      })(),
      (error) => error instanceof AiError && error.code === 'aborted',
    );
    assert.deepEqual(seen, ['start']);
    assert.equal(source.cancelled, true);

    const early = body([START], true);
    await failsWith(
      readAiEvents(new Response(early.stream, { headers: SSE }), { signal: AbortSignal.abort() }),
      'aborted',
    );
    assert.equal(early.cancelled, true);
  });
});
