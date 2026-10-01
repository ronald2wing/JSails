/**
 * Dev live-reload: the reload SSE route, the injected client, the HTML
 * injection transform, and the dev plugin that registers both.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';

import type { RouteContext } from '../../src/contracts/http.js';
import {
  createGenerationChannel,
  generationFilePath,
  writeGeneration,
  type GenerationChannel,
} from '../../src/dev/generation.js';
import { devReloadTransform, injectReloadScript } from '../../src/dev/html-injection.js';
import {
  DEV_GENERATION_GLOBAL,
  devReloadScript,
  liveReloadResponse,
} from '../../src/dev/live-reload.js';
import { devPlugin } from '../../src/dev/plugin.js';
import { publicAccess } from '../../src/api/access-ref.js';
import { runExtensions } from '../../src/extensions/index.js';
import { definePlugin } from '../../src/plugins/contract/define-plugin.js';
import { ConfigErrors } from '../../src/plugins/contract/errors.js';
import { createApp } from '../../src/server/app.js';
import { testPlugin } from '../../src/testing/plugin-harness.js';
import { createTestRequestContext } from '../../src/testing/request-context.js';

/** A route context for a handler that reads nothing but the request. */
function routeContext(path: string): RouteContext {
  return {
    ...createTestRequestContext({ url: `http://localhost${path}` }),
    signal: new AbortController().signal,
  } as RouteContext;
}

/** The SSE frame a generation is reported in; the first one carries the retry hint. */
function generationFrame(generation: number, retry?: number): string {
  const hint = retry === undefined ? '' : `retry: ${retry}\n`;
  return `event: generation\n${hint}data: {"generation":${generation}}`;
}

/** A channel whose generation a test sets, counting its live subscriptions. */
function manualChannel(start = 0): GenerationChannel & {
  set(generation: number): void;
  subscribers(): number;
} {
  let current = start;
  const listeners = new Set<(generation: number) => void>();
  return {
    current: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => listeners.clear(),
    set(generation) {
      current = generation;
      for (const listener of listeners) listener(generation);
    },
    subscribers: () => listeners.size,
  };
}

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

  it('opens with the current generation and the retry hint', async () => {
    const response = track(liveReloadResponse({ retryMs: 500 }));
    assert.deepEqual(await readFrames(response, 1), [generationFrame(0, 500)]);
  });

  it('reports the channel generation on open', async () => {
    const path = generationFilePath(tempRoot());
    writeGeneration(path, 4);
    const channel = createGenerationChannel({ path, pollMs: 5 });
    const response = track(liveReloadResponse({ channel }));
    assert.deepEqual(await readFrames(response, 1), [generationFrame(4, 1000)]);
    channel.close();
  });

  it('sends a heartbeat while idle and the latest generation once', async () => {
    const channel = manualChannel(1);
    const response = track(liveReloadResponse({ channel, heartbeatMs: 10 }));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const next = async (): Promise<string> =>
      decoder.decode((await reader.read()).value).replace(/\n\n$/, '');
    assert.equal(await next(), generationFrame(1, 1000));
    assert.equal(await next(), 'event: heartbeat\ndata: ');
    channel.set(2);
    channel.set(3);
    let frame = await next();
    while (frame.startsWith('event: heartbeat')) frame = await next();
    assert.equal(frame, generationFrame(3));
    reader.releaseLock();
  });

  it("ends, unsubscribed, when the route's signal aborts", async () => {
    const channel = manualChannel();
    const controller = new AbortController();
    const response = liveReloadResponse({ channel, signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    assert.equal(channel.subscribers(), 1);
    const pending = reader.read();
    controller.abort();
    assert.equal((await pending).done, true);
    assert.equal(channel.subscribers(), 0);
  });

  it('ends, unsubscribed, when the reader cancels', async () => {
    const channel = manualChannel();
    const response = liveReloadResponse({ channel });
    const reader = response.body!.getReader();
    await reader.read();
    assert.equal(channel.subscribers(), 1);
    await reader.cancel();
    assert.equal(channel.subscribers(), 0);
  });

  it('opens nothing for a signal already aborted', async () => {
    const channel = manualChannel();
    const controller = new AbortController();
    controller.abort();
    const response = liveReloadResponse({ channel, signal: controller.signal });
    const reader = response.body!.getReader();
    assert.equal((await reader.read()).done, true);
    assert.equal(channel.subscribers(), 0);
  });

  it('emits a generation frame when the channel changes', async () => {
    const path = generationFilePath(tempRoot());
    writeGeneration(path, 1);
    const channel = createGenerationChannel({ path, pollMs: 5 });
    const response = track(liveReloadResponse({ channel }));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    // Drain the initial frame.
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
});

describe('devPlugin', () => {
  it('registers nothing outside development, or when disabled', async () => {
    for (const [instance, env] of [
      [devPlugin(), {}],
      [devPlugin(), { NODE_ENV: 'test' }],
      [devPlugin({ enabled: false }), { NODE_ENV: 'development' }],
    ] as const) {
      const run = await testPlugin(instance, { env });
      try {
        assert.equal(run.http.routes.length, 0);
        assert.equal(run.http.transforms.length, 0);
      } finally {
        await run.close();
      }
    }
  });

  it('serves the reload stream and transforms page, API and mount answers in development', async () => {
    const run = await testPlugin(devPlugin(), { env: { NODE_ENV: 'development' } });
    try {
      const [route] = run.http.routes;
      assert.ok(route?.type === 'route');
      assert.deepEqual(route.methods, ['GET']);
      assert.equal(route.path, '/_jsails/dev/reload');
      assert.equal(route.access.kind, 'public');
      // It reads no session, so a cookie is no credential and no origin check applies.
      assert.deepEqual(route.credentials, []);
      assert.deepEqual(
        run.http.transforms.map((entry) => entry.kinds),
        [['page', 'api', 'mount']],
      );
      const response = track(await route.handler(routeContext('/_jsails/dev/reload')));
      assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
      assert.deepEqual(await readFrames(response, 1), [generationFrame(0, 1000)]);
    } finally {
      await run.close();
    }
  });

  it('injects the client into another plugin route served through the pipeline', async () => {
    const pages = definePlugin({
      name: 'pages',
      setup({ routes }) {
        routes.add({
          methods: ['GET'],
          path: '/page',
          access: publicAccess('probe page'),
          handler: () =>
            new Response('<!DOCTYPE html><html><body>page</body></html>', {
              headers: { 'content-type': 'text/html; charset=utf-8' },
            }),
        });
      },
    });
    const runtime = await runExtensions([devPlugin(), pages()], {
      rootDir: import.meta.dirname,
      env: { NODE_ENV: 'development' },
    });
    try {
      const app = await createApp({
        manifest: { entries: [], byRoute: new Map() },
        contributions: { routes: runtime.routes, transforms: runtime.transforms },
      });
      const body = await (await app.request('http://localhost/page')).text();
      assert.match(body, new RegExp(`window\\.${DEV_GENERATION_GLOBAL} = 0`));
      assert.match(body, /<\/script><\/body>/);
    } finally {
      await runtime.close();
    }
  });

  it('enables itself outside development when asked', async () => {
    const run = await testPlugin(devPlugin({ enabled: true }));
    try {
      assert.equal(run.http.routes.length, 1);
    } finally {
      await run.close();
    }
  });

  it('reports the generation the file named by JSAILS_DEV_GENERATION holds', async () => {
    const path = generationFilePath(tempRoot());
    writeGeneration(path, 6);
    const run = await testPlugin(devPlugin({ enabled: true }), {
      env: { JSAILS_DEV_GENERATION: path },
    });
    try {
      const [route] = run.http.routes;
      assert.ok(route?.type === 'route');
      const response = track(await route.handler(routeContext('/_jsails/dev/reload')));
      assert.deepEqual(await readFrames(response, 1), [generationFrame(6, 1000)]);
    } finally {
      await run.close();
    }
  });

  const SECRET = 'zz-secret-input';
  const invalidOptions: readonly { readonly name: string; readonly input: unknown }[] = [
    { name: 'null', input: null },
    { name: 'an unknown option', input: { [SECRET]: true } },
    { name: 'a non-boolean enabled', input: { enabled: SECRET } },
  ];
  for (const { name, input } of invalidOptions) {
    it(`refuses ${name} with config.invalid_options before any setup, echoing no input`, () => {
      const factory = devPlugin as unknown as (input: unknown) => unknown;
      assert.throws(
        () => factory(input),
        (error: unknown) => {
          assert.ok(ConfigErrors.is(error, 'invalid_options'));
          assert.equal(`${String(error)}${JSON.stringify(error.payload)}`.includes(SECRET), false);
          return true;
        },
      );
    });
  }
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

describe('devReloadTransform', () => {
  const PAGE = '<!DOCTYPE html><html><body>page</body></html>';

  function html(body: string, headers: HeadersInit = {}): Response {
    return new Response(body, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        ...Object.fromEntries(new Headers(headers)),
      },
    });
  }

  function context(options: { readonly method?: string; readonly cspNonce?: string } = {}) {
    const base = createTestRequestContext({ method: options.method ?? 'GET' });
    return options.cspNonce === undefined ? base : { ...base, cspNonce: options.cspNonce };
  }

  it('injects into an HTML page answer', async () => {
    const response = await devReloadTransform({ generation: () => 5 })(html(PAGE), context());
    const body = await response.text();
    assert.match(body, new RegExp(`window\\.${DEV_GENERATION_GLOBAL} = 5`));
    assert.match(body, /<\/script><\/body>/);
  });

  it('drops the stale content-length and etag', async () => {
    const response = await devReloadTransform({ generation: () => 1 })(
      html(PAGE, { 'content-length': String(PAGE.length), etag: '"abc"' }),
      context(),
    );
    assert.equal(response.headers.get('content-length'), null);
    assert.equal(response.headers.get('etag'), null);
    assert.match(await response.text(), /<\/script><\/body>/);
  });

  it('returns a fragment and an already-injected page as they are', async () => {
    const transform = devReloadTransform({ generation: () => 4 });
    const fragment = html('<li>partial</li>');
    assert.equal(await transform(fragment, context()), fragment);
    const page = html(injectReloadScript('<html><body>page</body></html>', 3));
    assert.equal(await transform(page, context()), page);
  });

  it("adds the request's valid CSP nonce to the script and drops an invalid one", async () => {
    const transform = devReloadTransform({ generation: () => 1 });
    const nonced = await transform(html(PAGE), context({ cspNonce: 'abc123+/=' }));
    assert.match(await nonced.text(), /<script nonce="abc123\+\/=">/);
    const forged = await transform(html(PAGE), context({ cspNonce: '"><img src=x>' }));
    const body = await forged.text();
    assert.match(body, /<script>/);
    assert.doesNotMatch(body, /img/);
  });

  it('leaves non-HTML, non-GET, non-200 and streamed answers alone', async () => {
    const transform = devReloadTransform({ generation: () => 1 });
    const json = Response.json({ ok: true });
    assert.equal(await transform(json, context()), json);
    const posted = html(PAGE);
    assert.equal(await transform(posted, context({ method: 'POST' })), posted);
    const missing = new Response(PAGE, { status: 404, headers: { 'content-type': 'text/html' } });
    assert.equal(await transform(missing, context()), missing);
    const streamed = html(PAGE, { 'x-accel-buffering': 'no' });
    assert.equal(await transform(streamed, context()), streamed);
  });
});
