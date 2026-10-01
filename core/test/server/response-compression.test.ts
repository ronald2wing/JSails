/**
 * Response compression: brotli is negotiated alongside gzip and deflate, the
 * compressed body round-trips, small, non-compressible, already-encoded, HEAD,
 * and event-stream responses are left alone, and a progressive stream's first
 * chunk reaches the client before the producer finishes.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { describe, it } from 'node:test';
import { Hono } from 'hono';

import {
  compressResponses,
  selectResponseEncoding,
} from '../../src/server/response-compression.js';
import { markStreamedResponse } from '../../src/server/streamed-response.js';
import type { AppEnv } from '../../src/server/env.js';

const TEXT = 'jsails '.repeat(2000);

function appWith(handler: (c: { req: { raw: Request } }) => Response | Promise<Response>) {
  const app = new Hono<AppEnv>();
  app.use('*', compressResponses());
  app.all('*', handler);
  return app;
}

function html(body: BodyInit, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

function get(acceptEncoding: string, method = 'GET'): Request {
  return new Request('http://localhost/', {
    method,
    headers: { 'accept-encoding': acceptEncoding },
  });
}

describe('selectResponseEncoding', () => {
  it('prefers brotli, then gzip, then deflate on equal weight', () => {
    assert.equal(selectResponseEncoding('gzip, deflate, br'), 'br');
    assert.equal(selectResponseEncoding('deflate, gzip'), 'gzip');
    assert.equal(selectResponseEncoding('deflate'), 'deflate');
  });

  it('honors q-values, refusals, and the wildcard', () => {
    assert.equal(selectResponseEncoding('br;q=0.5, gzip'), 'gzip');
    assert.equal(selectResponseEncoding('br;q=0, gzip;q=0'), undefined);
    assert.equal(selectResponseEncoding('*'), 'br');
    assert.equal(selectResponseEncoding('identity'), undefined);
    assert.equal(selectResponseEncoding(undefined), undefined);
  });
});

describe('compressResponses', () => {
  it('compresses with brotli and round-trips the body', async () => {
    const res = await appWith(() => html(TEXT)).fetch(get('gzip, br'));
    assert.equal(res.headers.get('content-encoding'), 'br');
    assert.equal(res.headers.get('content-length'), null);
    assert.match(res.headers.get('vary') ?? '', /Accept-Encoding/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.ok(bytes.length < TEXT.length);
    assert.equal(brotliDecompressSync(bytes).toString(), TEXT);
  });

  it('falls back to gzip and deflate', async () => {
    const gz = await appWith(() => html(TEXT)).fetch(get('gzip, br;q=0'));
    assert.equal(gz.headers.get('content-encoding'), 'gzip');
    assert.equal(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString(), TEXT);

    const df = await appWith(() => html(TEXT)).fetch(get('deflate'));
    assert.equal(df.headers.get('content-encoding'), 'deflate');
    assert.equal(inflateSync(Buffer.from(await df.arrayBuffer())).toString(), TEXT);
  });

  it('weakens a strong ETag on the compressed variant', async () => {
    const res = await appWith(() => html(TEXT, { etag: '"abc"' })).fetch(get('br'));
    assert.equal(res.headers.get('etag'), 'W/"abc"');
    await res.arrayBuffer();
  });

  it('leaves small, binary, encoded, no-transform, and HEAD responses alone', async () => {
    const cases: Array<[Response, string]> = [
      [html('tiny', { 'content-length': '4' }), 'GET'],
      [new Response(TEXT, { headers: { 'content-type': 'image/png' } }), 'GET'],
      [html(TEXT, { 'content-encoding': 'gzip' }), 'GET'],
      [html(TEXT, { 'cache-control': 'public, no-transform' }), 'GET'],
      [html(TEXT), 'HEAD'],
    ];
    for (const [response, method] of cases) {
      const encodingBefore = response.headers.get('content-encoding');
      const res = await appWith(() => response).fetch(get('br, gzip', method));
      assert.equal(res.headers.get('content-encoding'), encodingBefore);
    }
  });

  it('never compresses or buffers an event stream', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(new TextEncoder().encode('data: hello\n\n'));
      },
    });
    const res = await appWith(
      () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    ).fetch(get('br'));
    assert.equal(res.headers.get('content-encoding'), null);
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), 'data: hello\n\n');
    controller?.close();
    await reader.cancel();
  });

  it('flushes each chunk of a progressive stream before the producer finishes', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(encoder.encode('<html><body>shell'));
        await gate;
        c.enqueue(encoder.encode('rest</body></html>'));
        c.close();
      },
    });
    const res = await appWith(() => markStreamedResponse(html(stream))).fetch(get('br'));
    assert.equal(res.headers.get('content-encoding'), 'br');

    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.ok(first.value !== undefined && first.value.length > 0, 'the shell arrives early');

    release?.();
    const chunks = [Buffer.from(first.value)];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(Buffer.from(next.value));
    }
    assert.equal(
      brotliDecompressSync(Buffer.concat(chunks)).toString(),
      '<html><body>shellrest</body></html>',
    );
  });

  it('compresses a proxied fetch() response whose headers are immutable', async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(TEXT),
      });
      res.end(TEXT);
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = upstream.address() as AddressInfo;
      const res = await appWith(() => fetch(`http://127.0.0.1:${port}/`)).fetch(get('br'));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-encoding'), 'br');
      assert.equal(res.headers.get('vary'), 'Accept-Encoding');
      assert.equal(brotliDecompressSync(Buffer.from(await res.arrayBuffer())).toString(), TEXT);

      const identity = await appWith(() => fetch(`http://127.0.0.1:${port}/`)).fetch(
        get('identity'),
      );
      assert.equal(identity.status, 200);
      assert.equal(identity.headers.get('content-encoding'), null);
      assert.equal(identity.headers.get('vary'), 'Accept-Encoding');
      assert.equal(await identity.text(), TEXT);
    } finally {
      await new Promise((resolve) => upstream.close(resolve));
    }
  });

  it('releases the engine when the client cancels', async () => {
    let markCancelled: () => void = () => {};
    const cancelled = new Promise<void>((resolve) => {
      markCancelled = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new TextEncoder().encode(TEXT));
      },
      cancel() {
        markCancelled();
      },
    });
    const res = await appWith(() => html(stream)).fetch(get('gzip'));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    // A body without a declared length is flushed per chunk, so the cancel
    // reaches the source only after the in-flight flush, which zlib runs on the
    // thread pool: wait for it in time, not in event-loop turns.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        cancelled,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('the source was never cancelled')), 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  });

  it('flushes each chunk of a body that declares no length', async () => {
    let release: (() => void) | undefined;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(TEXT));
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        controller.close();
      },
    });
    const res = await appWith(
      () => new Response(stream, { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
    ).fetch(get('gzip'));
    assert.equal(res.headers.get('content-encoding'), 'gzip');
    const reader = res.body!.getReader();
    // Without a per-chunk flush the compressor would hold the first chunk
    // until the producer ends, which here only happens after this read.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('the first chunk was held back')), 2000);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(first.done, false);
    assert.ok((first.value?.byteLength ?? 0) > 0);
    release?.();
    await reader.cancel();
  });
});
