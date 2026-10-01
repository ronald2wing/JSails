/**
 * `toEventStream` and `toEventStreamResponse`: nothing runs until read, one
 * run event is pulled per read (backpressure), heartbeats only while the
 * reader waits and never piling up, cancel and the external signal abort the
 * run and close its iterator, the response headers, option checks, and a
 * real run over the fake provider read back through `readAiEvents`,
 * including a cancelled run that still settles as `aborted`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

import { AiError } from '../../src/errors/ai-error.js';
import { readAiEvents } from '../../src/client/read-ai-events.js';
import { reduceAiEvents, type AiClientMessage } from '../../src/client/reduce-ai-events.js';
import { run } from '../../src/run/run.js';
import type { AiResult, AiRun, AiRunEvent } from '../../src/run/run-contract.js';
import { defineTool } from '../../src/tools/define-tool.js';
import { createFakeProvider } from '../../src/testing/fake-provider.js';
import { ZERO_USAGE } from '../../src/usage/usage.js';
import { toEventStream, toEventStreamResponse } from '../../src/event-stream/event-stream.js';

const decoder = new TextDecoder();

const finishResult: AiResult = {
  status: 'completed',
  text: '',
  appended: [],
  messages: [],
  steps: [],
  usage: ZERO_USAGE,
  pendingApprovals: [],
};

interface FakeRun extends AiRun {
  pulled: number;
  aborted: number;
  returned: number;
  release(): void;
}

/** A hand-driven run: `events` in order; `hang` waits for `release` before each event. */
function fakeRun(events: readonly AiRunEvent[], hang = false): FakeRun {
  let index = 0;
  let wake: (() => void) | undefined;
  const handle: FakeRun = {
    pulled: 0,
    aborted: 0,
    returned: 0,
    result: Promise.resolve(finishResult),
    abort() {
      handle.aborted += 1;
      wake?.();
    },
    release() {
      wake?.();
    },
    [Symbol.asyncIterator](): AsyncIterator<AiRunEvent> {
      return {
        async next(): Promise<IteratorResult<AiRunEvent>> {
          if (hang) await new Promise<void>((resolve) => (wake = resolve));
          const event = events[index];
          if (event === undefined) return { done: true, value: undefined };
          index += 1;
          handle.pulled += 1;
          return { done: false, value: event };
        },
        async return(): Promise<IteratorResult<AiRunEvent>> {
          handle.returned += 1;
          return { done: true, value: undefined };
        },
      };
    },
  };
  return handle;
}

async function readText(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string | undefined> {
  const chunk = await reader.read();
  return chunk.done ? undefined : decoder.decode(chunk.value);
}

/** A read that resolves to `'timeout'` when nothing arrives within `ms`. */
function readWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<string | undefined> {
  return Promise.race([readText(reader), delay(ms).then(() => 'timeout')]);
}

const deltas: AiRunEvent[] = [
  { type: 'step-start', step: 0 },
  { type: 'text-delta', step: 0, delta: 'a' },
  { type: 'text-delta', step: 0, delta: 'b' },
  { type: 'text-delta', step: 0, delta: 'c' },
  { type: 'finish', result: finishResult },
];

describe('toEventStream', () => {
  it('pulls nothing until read, then one run event per read', async () => {
    const handle = fakeRun(deltas);
    const reader = toEventStream(handle, { heartbeatMs: 0 }).getReader();
    await delay(10);
    assert.equal(handle.pulled, 0);
    assert.equal(await readText(reader), 'event: start\ndata: {"v":1}\n\n');
    assert.equal(handle.pulled, 0);
    assert.equal(await readText(reader), 'event: step\ndata: {"index":0}\n\n');
    assert.equal(handle.pulled, 1);
    await delay(10);
    assert.equal(handle.pulled, 1, 'a paused reader pauses the run');
    assert.equal(await readText(reader), 'event: text\ndata: {"delta":"a"}\n\n');
    assert.equal(handle.pulled, 2);
    await readText(reader);
    await readText(reader);
    assert.match((await readText(reader)) ?? '', /^event: finish\n/);
    assert.equal(await readText(reader), undefined);
    assert.equal(handle.pulled, 5);
  });

  it('skips run events with no wire form without returning an empty chunk', async () => {
    const handle = fakeRun([
      { type: 'step-finish', step: 0, finishReason: 'stop', usage: ZERO_USAGE, appended: [] },
      { type: 'text-delta', step: 0, delta: 'x' },
      { type: 'finish', result: finishResult },
    ]);
    const reader = toEventStream(handle, { heartbeatMs: 0 }).getReader();
    await readText(reader);
    assert.equal(await readText(reader), 'event: text\ndata: {"delta":"x"}\n\n');
    assert.equal(handle.pulled, 2);
  });

  it('sends heartbeats while the reader waits on a quiet run, without piling up', async () => {
    const handle = fakeRun(deltas, true);
    const reader = toEventStream(handle, { heartbeatMs: 15 }).getReader();
    try {
      await readText(reader);
      assert.equal(await readWithin(reader, 500), ':\n\n');
      // The reader pauses for about ten intervals while the run stays quiet;
      // what is waiting afterwards is at most one heartbeat (plus one that may
      // fall due while draining), never one per interval.
      await delay(150);
      let waiting = 0;
      while ((await readWithin(reader, 2)) === ':\n\n') waiting += 1;
      assert.ok(waiting >= 1 && waiting <= 2, `heartbeats waiting: ${waiting}`);
      assert.equal(handle.pulled, 0);
    } finally {
      handle.release();
      await reader.cancel();
    }
  });

  it('sends no heartbeat when disabled', async () => {
    const handle = fakeRun(deltas, true);
    const reader = toEventStream(handle, { heartbeatMs: 0 }).getReader();
    try {
      await readText(reader);
      assert.equal(await readWithin(reader, 60), 'timeout');
    } finally {
      await reader.cancel();
    }
  });

  it('aborts the run and closes its iterator when the stream is cancelled', async () => {
    const handle = fakeRun(deltas, true);
    const reader = toEventStream(handle, { heartbeatMs: 0 }).getReader();
    await readText(reader);
    const pending = reader.read();
    await reader.cancel();
    assert.equal((await pending).done, true);
    assert.equal(handle.aborted, 1);
    assert.equal(handle.returned, 1);
  });

  it('aborts the run when the external signal fires, even before reading', async () => {
    const controller = new AbortController();
    const handle = fakeRun(deltas);
    toEventStream(handle, { signal: controller.signal });
    controller.abort();
    assert.equal(handle.aborted, 1);
    const already = fakeRun(deltas);
    toEventStream(already, { signal: AbortSignal.abort() });
    assert.equal(already.aborted, 1);
  });

  it('ends with a code-only error when the run iterator throws', async () => {
    const handle = fakeRun([]);
    const broken: AiRun = {
      result: handle.result,
      abort: () => handle.abort(),
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('CANARY')),
      }),
    };
    const reader = toEventStream(broken, { heartbeatMs: 0 }).getReader();
    await readText(reader);
    const text = await readText(reader);
    assert.equal(text, 'event: error\ndata: {"code":"provider_failed"}\n\n');
    assert.equal(await readText(reader), undefined);
    assert.equal(handle.aborted, 1);
  });

  it('rejects bad options and a run that was already iterated', () => {
    const handle = fakeRun(deltas);
    for (const options of [
      { heartbeatMs: -1 },
      { heartbeatMs: 1.5 },
      { signal: 'nope' },
      { reasoning: 'yes' },
    ]) {
      assert.throws(
        () => toEventStream(handle, options as never),
        (error) => error instanceof AiError && error.code === 'invalid_options',
      );
    }
    assert.throws(
      () => toEventStream({} as AiRun),
      (error) => error instanceof AiError && error.code === 'invalid_options',
    );
    const provider = createFakeProvider([{ text: 'hi' }]);
    const once = run({ model: provider.model(), input: 'Hi' });
    toEventStream(once);
    assert.throws(
      () => toEventStream(once),
      (error) => error instanceof AiError && error.code === 'invalid_options',
    );
  });
});

describe('toEventStreamResponse', () => {
  it('sets the event-stream headers and keeps extra ones', () => {
    const response = toEventStreamResponse(fakeRun(deltas), {
      headers: { 'content-type': 'text/plain', 'x-request-id': 'r1' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    assert.equal(response.headers.get('x-request-id'), 'r1');
  });

  it('streams a real tool run that the client reads back', async () => {
    const provider = createFakeProvider([
      { text: 'Checking.', toolCalls: [{ name: 'weather', input: { city: 'Oslo' } }] },
      { text: 'It is 21C.', chunkSize: 3 },
    ]);
    const weather = defineTool({
      name: 'weather',
      description: 'Weather for a city.',
      input: z.object({ city: z.string() }),
      exposeToBrowser: true,
      execute: ({ city }) => `${city}: 21C`,
    });
    const handle = run({
      model: provider.model(),
      input: 'Weather in Oslo?',
      tools: [weather],
      context: { actor: { kind: 'user', id: 'u1' } },
    });
    let message: AiClientMessage | undefined;
    const names: string[] = [];
    for await (const event of readAiEvents(toEventStreamResponse(handle))) {
      names.push(event.event);
      message = reduceAiEvents(message, event);
    }
    assert.equal(names[0], 'start');
    assert.equal(names.at(-1), 'finish');
    assert.equal(message?.status, 'completed');
    assert.equal(message?.text, 'Checking.\n\nIt is 21C.');
    assert.deepEqual(message?.parts[1], {
      type: 'tool',
      id: 'fake_call_1_0',
      name: 'weather',
      state: 'done',
      input: { city: 'Oslo' },
      output: 'Oslo: 21C',
    });
    assert.equal((await handle.result).status, 'completed');
  });

  it('a cancelled stream aborts the run, which settles with its partial transcript', async () => {
    const provider = createFakeProvider([{ text: 'a long answer', chunkSize: 1, delayMs: 5 }]);
    const handle = run({ model: provider.model(), input: 'Hi' });
    const reader = toEventStream(handle, { heartbeatMs: 0 }).getReader();
    await readText(reader);
    await readText(reader);
    await readText(reader);
    await reader.cancel();
    const result = await handle.result;
    assert.equal(result.status, 'aborted');
    assert.equal(result.error?.code, 'aborted');
    assert.equal(result.appended[0]?.role, 'user');
    assert.equal(provider.inits[0]?.signal.aborted, true);
  });
});
