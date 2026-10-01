/**
 * Dev live-reload: the reload SSE route, the injected client, and the HTML
 * injection middleware.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';

import { Hono } from 'hono';

import {
  createGenerationChannel,
  generationFilePath,
  writeGeneration,
} from '../../src/dev/dev-generation.js';
import { devReloadMiddleware, injectReloadScript } from '../../src/dev/html-injection.js';
import {
  DEV_GENERATION_GLOBAL,
  devReloadScript,
  liveReloadResponse,
} from '../../src/dev/live-reload.js';
import { devPlugin } from '../../src/dev/plugin.js';

const openStreams: ReadableStream<Uint8Array>[] = [];
const roots: string[] = [];

function track(response: Response): Response {
  if (response.body !== null) openStreams.push(response.body);
  return response;
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'jsails-live-reload-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const stream of openStreams.splice(0)) {
    await stream.cancel();
  }
});

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Read the first `count` SSE frames from a response. */
async function readFrames(response: Response, count: number): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buffer = '';
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1 && frames.length < count) {
      frames.push(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
  }
  reader.releaseLock();
  return frames;
}

describe('dev live reload', () => {
  it('emits an SSE response with the event-stream content type', () => {
    const response = track(liveReloadResponse());
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('streams a retry hint then the current generation', async () => {
    const response = track(liveReloadResponse({ retryMs: 500 }));
    const frames = await readFrames(response, 2);
    assert.match(frames[0] ?? '', /retry: 500/);
    assert.match(frames[1] ?? '', /event: generation/);
    assert.match(frames[1] ?? '', /"generation":0/);
  });

  it('reports the channel generation on open', async () => {
    const path = generationFilePath(tempRoot());
    writeGeneration(path, 4);
    const channel = createGenerationChannel({ path, pollMs: 5 });
    const response = track(liveReloadResponse({ channel }));
    const frames = await readFrames(response, 2);
    assert.match(frames[1] ?? '', /"generation":4/);
    channel.close();
  });

  it('emits a generation frame when the channel changes', async () => {
    const path = generationFilePath(tempRoot());
    writeGeneration(path, 1);
    const channel = createGenerationChannel({ path, pollMs: 5 });
    const response = track(liveReloadResponse({ channel }));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    // Drain the retry hint and the initial frame.
    await reader.read();
    await reader.read();

    writeGeneration(path, 2);
    let text = '';
    while (!text.includes('"generation":2')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    assert.match(text, /"generation":2/);
    reader.releaseLock();
    channel.close();
  });

  it('emits a self-contained subscriber script that compares generations', () => {
    const script = devReloadScript(3);
    assert.match(script, /EventSource/);
    assert.match(script, /location\.reload/);
    assert.match(script, /_jsails\/dev\/reload/);
    assert.match(script, new RegExp(`window\\.${DEV_GENERATION_GLOBAL} = 3`));
    // The baseline must be assigned before the subscriber is created, or the
    // first frame looks like a change and the page reloads in a loop.
    assert.ok(
      script.indexOf(`window.${DEV_GENERATION_GLOBAL} = 3`) < script.indexOf('new EventSource'),
      'baseline assignment precedes the subscription',
    );
  });

  it('devPlugin is a no-op when disabled (no http hook)', async () => {
    const plugin = devPlugin({ enabled: false });
    const hooks: unknown[] = [];
    await plugin.setup?.({ configureHttp: (hook: unknown) => hooks.push(hook) } as never);
    assert.equal(hooks.length, 0);
  });
});

describe('injectReloadScript', () => {
  const document = '<!DOCTYPE html><html><body><p>hi</p></body></html>';

  it('appends the script before the closing body tag', () => {
    const injected = injectReloadScript(document, 2);
    assert.match(injected, /<p>hi<\/p><script>/);
    assert.match(injected, /<\/script><\/body><\/html>/);
    assert.match(injected, new RegExp(`window\\.${DEV_GENERATION_GLOBAL} = 2`));
  });

  it('is idempotent', () => {
    const once = injectReloadScript(document, 2);
    assert.equal(injectReloadScript(once, 2), once);
    assert.equal(injectReloadScript(once, 9), once, 'a second pass never re-injects');
  });

  it('leaves a document with no closing body unchanged', () => {
    assert.equal(injectReloadScript('<div>fragment</div>', 1), '<div>fragment</div>');
  });
});

describe('devReloadMiddleware', () => {
  function appWith(generation: () => number) {
    const app = new Hono();
    app.use('*', devReloadMiddleware({ generation }));
    app.get('/page', (c) => c.html('<!DOCTYPE html><html><body>page</body></html>'));
    app.get('/json', (c) => c.json({ ok: true }));
    app.post('/page', (c) => c.html('<!DOCTYPE html><html><body>posted</body></html>'));
    app.get('/missing', () => new Response('nope', { status: 404 }));
    app.get('/stream', () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('<!DOCTYPE html><html><body>s'));
          controller.close();
        },
      });
      return new Response(body, {
        headers: { 'content-type': 'text/html', 'x-accel-buffering': 'no' },
      });
    });
    return app;
  }

  it('injects into an HTML page response', async () => {
    const response = await appWith(() => 5).request('/page');
    const body = await response.text();
    assert.match(body, new RegExp(`window\\.${DEV_GENERATION_GLOBAL} = 5`));
    assert.match(body, /<\/script><\/body>/);
  });

  it('drops the stale content-length and etag', async () => {
    const app = new Hono();
    app.use('*', devReloadMiddleware({ generation: () => 1 }));
    app.get('/page', () => {
      const body = '<!DOCTYPE html><html><body>page</body></html>';
      return new Response(body, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-length': String(body.length),
          etag: '"abc"',
        },
      });
    });
    const response = await app.request('/page');
    assert.equal(response.headers.get('content-length'), null);
    assert.equal(response.headers.get('etag'), null);
    assert.match(await response.text(), /<\/script><\/body>/);
  });

  it('leaves non-HTML, non-GET, non-200, and streamed responses alone', async () => {
    const app = appWith(() => 1);
    assert.doesNotMatch(await (await app.request('/json')).text(), /EventSource/);
    assert.doesNotMatch(
      await (await app.request('/page', { method: 'POST' })).text(),
      /EventSource/,
    );
    assert.doesNotMatch(await (await app.request('/missing')).text(), /EventSource/);
    assert.doesNotMatch(await (await app.request('/stream')).text(), /EventSource/);
  });
});
