/**
 * Tests for the response finalizer, called directly: how a body is adopted
 * (a recorded body, a teed one, a foreign one drained without blocking, one
 * already consumed), the content coding and its exceptions, the validator
 * per representation, the conditional answers, live answers, and the pure
 * helpers the asset responder shares.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bytesResponse, streamResponse, utf8 } from '../../src/api/response-bodies.js';
import {
  dropRepresentationHeaders,
  entityTag,
  finalize,
  answerOf,
  isNotModified,
  matchesEntityTag,
  negotiable,
  ResponseFinalizerErrors,
} from '../../src/server/output.js';
import type { RequestFrame } from '../../src/server/request-frame.js';

/** Long enough to be encoded (over 1 KiB), and compressible. */
const PAGE = '<p>a paragraph of compressible text</p>\n'.repeat(64);

/** Generous: finalize answers within a macrotask, so only a blocked one comes near it. */
const BLOCKED_AFTER_MS = 5_000;

/** A frame for `request`, as finalize reads it: no route, nothing claimed, no credential. */
function frameFor(request: Request, reports: unknown[] = []): RequestFrame {
  const frame: Pick<
    RequestFrame,
    'id' | 'request' | 'signal' | 'route' | 'claimed' | 'credentialed' | 'runInRequest' | 'report'
  > = {
    id: 'request-1',
    request,
    signal: request.signal,
    route: undefined,
    claimed: undefined,
    credentialed: false,
    runInRequest: (fn) => fn(),
    report: (error) => {
      reports.push(error);
    },
  };
  return frame as RequestFrame;
}

function get(headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request('http://localhost/page', { method, headers });
}

/** A stream that yields nothing until `release` is called, then `text` and ends. */
function gated(text: string): { stream: ReadableStream<Uint8Array>; release: () => void } {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      await opened;
      controller.enqueue(utf8(text));
      controller.close();
    },
  });
  return { stream, release };
}

/** `promise`'s value, or `'blocked'` when it has not settled after {@link BLOCKED_AFTER_MS}. */
async function unlessBlocked<T>(promise: Promise<T>): Promise<T | 'blocked'> {
  let timer: NodeJS.Timeout | undefined;
  const blocked = new Promise<'blocked'>((resolve) => {
    timer = setTimeout(() => resolve('blocked'), BLOCKED_AFTER_MS);
  });
  try {
    return await Promise.race([promise, blocked]);
  } finally {
    clearTimeout(timer);
  }
}

describe('finalize: adopting a foreign body', () => {
  it('sends the head of a stalled body that declares a small length at once', async () => {
    const { stream, release } = gated('hi');
    const finalized = await unlessBlocked(
      finalize(frameFor(get()), new Response(stream, { headers: { 'content-length': '2' } })),
    );
    release();
    assert.notEqual(finalized, 'blocked', 'the head waited for the producer');
    if (finalized === 'blocked') return;
    assert.equal(finalized.headers.get('content-length'), '2');
    assert.equal(await finalized.text(), 'hi');
  });

  it('sends a body that ends at once whole, with its real length', async () => {
    const response = new Response(utf8('hi'), { headers: { 'content-length': '2' } });
    const finalized = await finalize(frameFor(get()), response);
    assert.equal(finalized.headers.get('content-length'), '2');
    assert.equal(await finalized.text(), 'hi');
  });

  it('corrects a declared length longer than the body that ended', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(utf8('hi'));
        controller.close();
      },
    });
    const finalized = await finalize(
      frameFor(get()),
      new Response(body, { headers: { 'content-length': '10' } }),
    );
    assert.equal(finalized.headers.get('content-length'), '2');
    assert.equal(await finalized.text(), 'hi');
  });

  it('drops a declared length the body outruns, and still sends every byte', async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(utf8('hello'));
        await finished;
        controller.enqueue(utf8(' world'));
        controller.close();
      },
    });
    const finalized = await finalize(
      frameFor(get()),
      new Response(body, { headers: { 'content-length': '2' } }),
    );
    finish();
    assert.equal(finalized.headers.get('content-length'), null);
    assert.equal(await finalized.text(), 'hello world');
  });

  it('hands a read failure after the deadline to the client', async () => {
    let fail!: () => void;
    const failing = new Promise<void>((resolve) => (fail = resolve));
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(utf8('partial'));
        await failing;
        controller.error(new Error('producer failed'));
      },
    });
    const reports: unknown[] = [];
    const finalized = await finalize(frameFor(get(), reports), new Response(body));
    fail();
    await assert.rejects(finalized.text());
    assert.deepEqual(reports, [], 'a foreign stream has no producer the framework reports for');
  });

  it('refuses a body something already consumed with response_finalizer.body_taken', async () => {
    const response = new Response('already read');
    await response.text();
    await assert.rejects(finalize(frameFor(get()), response), (error: unknown) =>
      ResponseFinalizerErrors.is(error, 'body_taken'),
    );
  });
});

describe('finalize: adopting a recorded body', () => {
  it('streams a recorded stream that Response.clone() teed, from the response branch', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(utf8('one,'));
        controller.enqueue(utf8('two'));
        controller.close();
      },
    });
    const response = streamResponse(source, { headers: { 'content-type': 'text/plain' } });
    // A tee branch's cancel settles once the other branch ends too.
    const cancelled = response.clone().body?.cancel();
    const finalized = await finalize(frameFor(get()), response);
    assert.equal(await finalized.text(), 'one,two');
    await cancelled;
  });

  it('keeps the live mark of a teed live stream', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(utf8('{"tick":1}\n'));
      },
    });
    const response = streamResponse(
      source,
      { headers: { 'content-type': 'application/x-ndjson' } },
      { live: true },
    );
    const cancelled = response.clone().body?.cancel();
    const frame = frameFor(get());
    const finalized = await finalize(frame, response);
    assert.equal(answerOf(frame), 'live');
    assert.equal(finalized.headers.get('cache-control'), 'private, no-store');
    await finalized.body?.cancel();
    await cancelled;
  });

  it('refuses a recorded stream a middleware consumed', async () => {
    const response = streamResponse(new Blob(['consumed']).stream(), {});
    await response.text();
    await assert.rejects(finalize(frameFor(get()), response), (error: unknown) =>
      ResponseFinalizerErrors.is(error, 'body_taken'),
    );
  });
});

describe('finalize: answer kinds', () => {
  it('records each answer kind on its frame: live, event stream, finite stream, bytes, empty', async () => {
    const frames = [get(), get(), get(), get(), get()].map((request) => frameFor(request));
    const [liveFrame, eventsFrame, finiteFrame, bytesFrame, emptyFrame] = frames as [
      RequestFrame,
      RequestFrame,
      RequestFrame,
      RequestFrame,
      RequestFrame,
    ];
    assert.equal(answerOf(liveFrame), undefined, 'nothing is recorded before finalize');
    const live = await finalize(
      liveFrame,
      streamResponse(new ReadableStream<Uint8Array>(), {}, { live: true }),
    );
    const events = await finalize(
      eventsFrame,
      new Response(new ReadableStream<Uint8Array>(), {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const finite = await finalize(finiteFrame, streamResponse(new Blob(['done']).stream(), {}));
    const bytes = await finalize(bytesFrame, bytesResponse(utf8('bytes'), {}));
    const empty = await finalize(emptyFrame, new Response(null, { status: 204 }));
    assert.deepEqual(
      frames.map((frame) => answerOf(frame)),
      ['live', 'live', 'stream', 'bytes', 'empty'],
    );
    await Promise.all([live.body?.cancel(), events.body?.cancel(), finite.text(), bytes.text()]);
    assert.equal(empty.body, null);
  });
});

describe('finalize: content coding and validators', () => {
  const page = (headers: Record<string, string> = {}): Response =>
    bytesResponse(utf8(PAGE), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public',
        ...headers,
      },
    });

  it('leaves a no-transform answer unencoded and not varying on Accept-Encoding', async () => {
    const finalized = await finalize(
      frameFor(get({ 'accept-encoding': 'br, gzip' })),
      page({ 'cache-control': 'public, no-transform' }),
    );
    assert.equal(finalized.headers.get('content-encoding'), null);
    assert.doesNotMatch(finalized.headers.get('vary') ?? '', /accept-encoding/i);
    assert.equal(await finalized.text(), PAGE);
  });

  it('gives each coding of the same content its own strong ETag', async () => {
    const tags = new Map<string, string | null>();
    for (const accept of ['br', 'gzip', 'identity']) {
      const finalized = await finalize(frameFor(get({ 'accept-encoding': accept })), page());
      tags.set(accept, finalized.headers.get('etag'));
      await finalized.arrayBuffer();
    }
    const identity = tags.get('identity') ?? '';
    assert.match(identity, /^"[\w-]+"$/);
    const opaque = identity.slice(1, -1);
    assert.equal(tags.get('br'), `"${opaque}.br"`);
    assert.equal(tags.get('gzip'), `"${opaque}.gz"`);
  });

  it('weakens a handler ETag when the body is then encoded', async () => {
    const finalized = await finalize(
      frameFor(get({ 'accept-encoding': 'gzip' })),
      page({ etag: '"v1"' }),
    );
    assert.equal(finalized.headers.get('etag'), 'W/"v1"');
    await finalized.arrayBuffer();
  });
});

describe('finalize: conditional requests', () => {
  const MODIFIED = 'Tue, 03 Nov 2026 10:00:00 GMT';
  const dated = (): Response =>
    bytesResponse(utf8(PAGE), {
      headers: { 'content-type': 'text/html', 'last-modified': MODIFIED },
    });

  it('answers If-Modified-Since at or after Last-Modified with a bodiless 304', async () => {
    const finalized = await finalize(
      frameFor(get({ 'if-modified-since': 'Wed, 04 Nov 2026 10:00:00 GMT' })),
      dated(),
    );
    assert.equal(finalized.status, 304);
    assert.equal(finalized.headers.get('content-type'), null);
    assert.equal(finalized.headers.get('content-length'), null);
    assert.equal(finalized.headers.get('last-modified'), MODIFIED);
    assert.equal(finalized.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await finalized.text(), '');
  });

  it('answers If-Modified-Since before Last-Modified with the full 200', async () => {
    const finalized = await finalize(
      frameFor(get({ 'if-modified-since': 'Mon, 02 Nov 2026 10:00:00 GMT' })),
      dated(),
    );
    assert.equal(finalized.status, 200);
    assert.equal(await finalized.text(), PAGE);
  });

  it('lets If-None-Match decide over If-Modified-Since', async () => {
    const finalized = await finalize(
      frameFor(
        get({ 'if-none-match': '"other"', 'if-modified-since': 'Wed, 04 Nov 2026 10:00:00 GMT' }),
      ),
      dated(),
    );
    assert.equal(finalized.status, 200);
    await finalized.arrayBuffer();
  });

  it('cancels the stream a 304 discards', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const response = streamResponse(body, { headers: { etag: '"v1"' } });
    const finalized = await finalize(frameFor(get({ 'if-none-match': 'W/"v1"' })), response);
    assert.equal(finalized.status, 304);
    assert.equal(cancelled, true);
  });
});

describe('the shared conditional and negotiation helpers', () => {
  it('compares entity tags weakly, a star matching any', () => {
    assert.equal(matchesEntityTag('"a", W/"b"', '"b"'), true);
    assert.equal(matchesEntityTag('"a"', 'W/"a"'), true);
    assert.equal(matchesEntityTag('*', '"anything"'), true);
    assert.equal(matchesEntityTag('"a"', '"b"'), false);
  });

  it('owes a 304 only for a 200 whose validators match', () => {
    const headers = new Headers({ etag: '"x"', 'last-modified': 'Tue, 03 Nov 2026 10:00:00 GMT' });
    assert.equal(isNotModified(new Headers({ 'if-none-match': '"x"' }), 200, headers), true);
    assert.equal(isNotModified(new Headers({ 'if-none-match': '"x"' }), 404, headers), false);
    assert.equal(
      isNotModified(new Headers({ 'if-modified-since': 'garbage' }), 200, headers),
      false,
    );
    assert.equal(isNotModified(new Headers(), 200, headers), false);
  });

  it('suffixes an entity tag per coding', () => {
    assert.equal(entityTag('abc', undefined), '"abc"');
    assert.equal(entityTag('abc', 'br'), '"abc.br"');
    assert.equal(entityTag('abc', 'gzip'), '"abc.gz"');
  });

  it('drops only the representation headers for a 304', () => {
    const headers = new Headers({
      'content-type': 'text/css',
      'content-length': '10',
      'content-encoding': 'br',
      'content-range': 'bytes 0-9/10',
      etag: '"x"',
      vary: 'Accept-Encoding',
    });
    dropRepresentationHeaders(headers);
    assert.deepEqual([...headers.keys()].sort(), ['etag', 'vary']);
  });

  it('negotiates only a compressible body of at least 1 KiB that has no coding yet', () => {
    const html = new Headers({ 'content-type': 'text/html' });
    const large = { kind: 'bytes', bytes: utf8(PAGE) } as const;
    const small = { kind: 'bytes', bytes: utf8('<p>small</p>') } as const;
    assert.equal(negotiable(200, html, large), true);
    assert.equal(negotiable(200, html, small), false);
    assert.equal(negotiable(206, html, large), false);
    assert.equal(negotiable(200, new Headers({ 'content-type': 'image/png' }), large), false);
    assert.equal(
      negotiable(
        200,
        new Headers({ 'content-type': 'text/html', 'content-encoding': 'br' }),
        large,
      ),
      false,
    );
    const declaredSmall = new Headers({ 'content-type': 'text/html', 'content-length': '12' });
    const stream = {
      kind: 'stream',
      stream: new ReadableStream<Uint8Array>(),
      live: false,
      reports: false,
    } as const;
    assert.equal(negotiable(200, declaredSmall, stream), false);
  });
});
