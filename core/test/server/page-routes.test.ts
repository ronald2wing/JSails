/**
 * Page route registration tests: a page that exports only a stream producer
 * is served; a streamed producer that throws after the
 * response started must still reach `requestFailed` observers, because the
 * handler has already returned by then; and a page rendered by its error
 * boundary answers with the error's status, never 200, and is never cached.
 * Streaming rendering (a page's `export const stream = true`; pages are
 * buffered otherwise) is covered end to end: early first bytes, failures
 * before and after the first flush, a disconnect, the stream deadline, a
 * producer's idle bound, the refusal of `stream` beside a cache declaration
 * or as `false`, and a thrown non-Error value.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { definePlugin, type PluginContext } from '../../src/extensions/plugin-contract.js';
import { DeadlineErrors } from '../../src/server/deadline.js';
import { preactPageRenderer } from '../../src/pages/page.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import { createApp } from '../../src/server/app.js';
import {
  requestFailed,
  RegistrySignalBus,
  signalsToken,
  type RequestSignalPayload,
} from '../../src/signals/index.js';
import { createTestApp } from '../../src/testing/app.js';
import { writeFixture } from '../fixtures/app.js';

const distDir = fileURLToPath(new URL('../../', import.meta.url));

describe('streamed page routes', () => {
  const suiteDir = mkdtempSync(join(distDir, 'page-routes-'));
  after(() => rmSync(suiteDir, { recursive: true, force: true }));

  it('serves a page that exports only a stream producer, preloaded or not', async (t) => {
    const dir = mkdtempSync(join(suiteDir, 'stream-only-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFixture(
      dir,
      'pages/feed.mjs',
      `export async function* stream() {
         yield '<!DOCTYPE html><html><body>';
         yield '<article>first</article>';
         yield '</body></html>';
       }
`,
    );
    for (const preloadModules of [true, false]) {
      const app = await createApp({
        manifest: discoverRoutes(dir),
        renderer: preactPageRenderer,
        preloadModules,
      });
      const response = await app.fetch(new Request('http://localhost/feed'));
      assert.equal(response.status, 200);
      assert.match(await response.text(), /<article>first<\/article>/);
    }
  });

  it('refuses a page with neither a default component nor a stream producer', async (t) => {
    const dir = mkdtempSync(join(suiteDir, 'no-page-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFixture(dir, 'pages/empty.mjs', `export const stream = true;\n`);
    await assert.rejects(
      createApp({ manifest: discoverRoutes(dir), renderer: preactPageRenderer }),
      (error: unknown) => (error as { code?: unknown }).code === 'invalid_module',
    );
  });

  it('reports a mid-stream producer failure as requestFailed', async (t) => {
    const dir = mkdtempSync(join(suiteDir, 'stream-fail-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFixture(
      dir,
      'pages/live.mjs',
      `export async function* stream() {
         yield '<p>start</p>';
         throw new Error('upstream lost');
       }
       export default function Page() { return null; }
`,
    );

    const failed: RequestSignalPayload[] = [];
    const app = await createTestApp({
      config: {
        rootDir: dir,
        port: 0,
        extensions: [
          definePlugin({
            name: 'signals',
            setup({ services, interceptorRegistry }) {
              services.provide(signalsToken, new RegistrySignalBus(interceptorRegistry));
            },
          }),
          definePlugin({
            name: 'capture',
            setup({ observe }: PluginContext) {
              observe(requestFailed, (payload) => {
                failed.push(payload);
              });
            },
          }),
        ],
      },
      lifecycle: t,
    });

    const response = await app.request('/live');
    assert.equal(response.status, 200);
    await assert.rejects(() => response.text());
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(failed.length, 1, 'the stream failure must reach requestFailed');
    const error = failed[0]!.error;
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'upstream lost');
  });

  it('ends a producer that goes silent past streamTimeoutMs and reports the timeout', async (t) => {
    const dir = mkdtempSync(join(suiteDir, 'stream-idle-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFixture(
      dir,
      'pages/silent.mjs',
      `export async function* stream() {
         yield '<p>start</p>';
         await new Promise(() => {});
       }
`,
    );
    const reported: unknown[] = [];
    const app = await createApp({
      manifest: discoverRoutes(dir),
      renderer: preactPageRenderer,
      onError: (error) => {
        reported.push(error);
      },
      render: { streamTimeoutMs: 20 },
    });
    const response = await app.fetch(new Request('http://localhost/silent'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    await assert.rejects(() => response.text());
    assert.equal(reported.length, 1);
    assert.ok(DeadlineErrors.is(reported[0], 'stream_idle'));
  });

  /**
   * A page whose producer yields once, then waits on a query its cleanup
   * must outlast: like an async generator's, its `return()` waits for the
   * pending step. `cancelled` resolves when the cancel arrives; the query
   * completes on the next turn of the event loop (`finish: 'soon'`) or when
   * the test calls `finish()`; the cleanup records the request it ran in, then
   * throws when `fails`.
   */
  async function slowCleanupApp(
    dir: string,
    options: { finish: 'soon' | 'later'; fails: boolean },
  ) {
    const contextUrl = new URL('../../src/context/execution-context.js', import.meta.url).href;
    writeFixture(
      dir,
      'probe.mjs',
      `export const events = [];
let markCancelled;
export const cancelled = new Promise((resolve) => { markCancelled = resolve; });
export function cancel() { markCancelled(); }
let finishQuery;
export const query = new Promise((resolve) => { finishQuery = resolve; });
export function finish() { finishQuery(); }
`,
    );
    writeFixture(
      dir,
      'pages/feed.mjs',
      `import { currentContext } from ${JSON.stringify(contextUrl)};
import { cancel, events, finish, query } from '../probe.mjs';
export function stream() {
  let sent = false;
  let pending = Promise.resolve();
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (!sent) {
        sent = true;
        return Promise.resolve({ value: '<p>start</p>', done: false });
      }
      pending = query.then(() => ({ value: '<p>late</p>', done: false }));
      return pending;
    },
    async return() {
      cancel();
      ${options.finish === 'soon' ? 'setImmediate(finish);' : ''}
      await pending;
      events.push('cleanup:' + currentContext()?.requestId);
      ${options.fails ? "throw new Error('release failed');" : ''}
      return { value: undefined, done: true };
    },
  };
}
`,
    );
    const probe = (await import(pathToFileURL(join(dir, 'probe.mjs')).href)) as {
      readonly events: string[];
      readonly cancelled: Promise<void>;
      finish(): void;
    };
    const reported: { readonly error: unknown; readonly phase: string }[] = [];
    let observeCleanupFailure!: () => void;
    const cleanupFailed = new Promise<void>((resolve) => {
      observeCleanupFailure = resolve;
    });
    const app = await createApp({
      manifest: discoverRoutes(dir),
      renderer: preactPageRenderer,
      onError: (error, info) => {
        reported.push({ error, phase: info.phase });
        if (error instanceof Error && error.message === 'release failed') observeCleanupFailure();
      },
      // A generous bound: the cleanup takes one turn of the event loop.
      render: { streamTimeoutMs: 250 },
    });
    return { app, probe, reported, cleanupFailed };
  }

  it("runs an idle producer's cleanup inside the request, before the body fails", async (t) => {
    const dir = mkdtempSync(join(suiteDir, 'stream-cleanup-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { app, probe, reported } = await slowCleanupApp(dir, { finish: 'soon', fails: false });
    const response = await app.fetch(new Request('http://localhost/feed'));
    const requestId = response.headers.get('x-request-id');
    assert.ok(requestId !== null && requestId !== '');
    await assert.rejects(response.text(), (error: unknown) =>
      DeadlineErrors.is(error, 'stream_idle'),
    );
    assert.deepEqual(probe.events, [`cleanup:${requestId}`]);
    assert.deepEqual(
      reported.map(({ phase }) => phase),
      ['timeout'],
    );
  });

  it("reports an idle producer's cleanup that fails, in time or late", async (t) => {
    const soonDir = mkdtempSync(join(suiteDir, 'stream-cleanup-fails-'));
    t.after(() => rmSync(soonDir, { recursive: true, force: true }));
    const soon = await slowCleanupApp(soonDir, { finish: 'soon', fails: true });
    const answered = await soon.app.fetch(new Request('http://localhost/feed'));
    await assert.rejects(answered.text());
    await soon.cleanupFailed;
    const failures = soon.reported.filter(({ phase }) => phase === 'stream');
    assert.equal(failures.length, 1);

    // A producer that acknowledges the cancel only after the bound: the body
    // has failed, and its cleanup's failure still reaches onError.
    const laterDir = mkdtempSync(join(suiteDir, 'stream-cleanup-late-'));
    t.after(() => rmSync(laterDir, { recursive: true, force: true }));
    const later = await slowCleanupApp(laterDir, { finish: 'later', fails: true });
    const response = await later.app.fetch(new Request('http://localhost/feed'));
    await assert.rejects(response.text(), (error: unknown) =>
      DeadlineErrors.is(error, 'stream_idle'),
    );
    await later.probe.cancelled;
    assert.deepEqual(later.probe.events, []);
    later.probe.finish();
    await later.cleanupFailed;
    assert.equal(later.probe.events.length, 1);
    assert.deepEqual(
      later.reported.map(({ phase }) => phase),
      ['timeout', 'stream'],
    );
  });
});

describe('error boundary status', () => {
  const dir = mkdtempSync(join(distDir, 'page-boundary-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const runtimeUrl = new URL('../../src/jsx/jsx-runtime.js', import.meta.url).href;
  const httpUrl = new URL('../../src/contracts/http.js', import.meta.url).href;
  writeFixture(
    dir,
    'pages/error.mjs',
    `import { jsx } from ${JSON.stringify(runtimeUrl)};
export default function ErrorBoundary({ error }) {
  return jsx('p', { children: error.status + ' ' + error.message });
}
`,
  );
  writeFixture(
    dir,
    'pages/missing.mjs',
    `import { HttpError } from ${JSON.stringify(httpUrl)};
export const cacheControl = { maxAge: 60 };
export function load() { throw new HttpError('not_found', 'No such thing', 404); }
export default function Page() { return null; }
`,
  );
  writeFixture(
    dir,
    'pages/odd.mjs',
    `import { HttpError } from ${JSON.stringify(httpUrl)};
export function load() { throw new HttpError('odd', 'Odd', 204); }
export default function Page() { return null; }
`,
  );
  writeFixture(
    dir,
    'pages/broken.mjs',
    `export default function Page() { throw new Error('db secret'); }
`,
  );
  writeFixture(
    dir,
    'pages/fine.mjs',
    `export default function Page() { return 'ok'; }
`,
  );
  const manifest = discoverRoutes(dir);

  async function fetchPage(path: string): Promise<Response> {
    const app = await createApp({ manifest, renderer: preactPageRenderer, onError: () => {} });
    return app.fetch(new Request(`http://localhost${path}`));
  }

  it('answers a boundary-rendered HttpError with its status and no shared caching', async () => {
    const res = await fetchPage('/missing');
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.match(await res.text(), /404 No such thing/);
  });

  it('answers a boundary-rendered unexpected error with 500', async () => {
    const res = await fetchPage('/broken');
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.match(text, /500 Internal Server Error/);
    assert.doesNotMatch(text, /db secret/);
  });

  it('never answers a boundary render with a non-error status', async () => {
    assert.equal((await fetchPage('/odd')).status, 500);
  });

  it('keeps 200 for a page that rendered normally', async () => {
    assert.equal((await fetchPage('/fine')).status, 200);
  });
});

describe('a custom renderer outcome', () => {
  const dir = mkdtempSync(join(distDir, 'page-outcome-shape-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFixture(dir, 'pages/index.mjs', `export default function Page() { return 'unused'; }\n`);
  const manifest = discoverRoutes(dir);

  /** Serve `/` through a renderer answering `answer`, with the failures reported. */
  async function serve(answer: unknown): Promise<{ response: Response; reported: unknown[] }> {
    const reported: unknown[] = [];
    const app = await createApp({
      manifest,
      renderer: { render: () => answer as never },
      onError: (error) => {
        reported.push(error);
      },
    });
    const response = await app.fetch(new Request('http://localhost/'));
    return { response, reported };
  }

  it('sends a redirect outcome as an empty body with its Location', async () => {
    const { response } = await serve({ kind: 'redirect', status: 301, location: '/moved' });
    assert.equal(response.status, 301);
    assert.equal(response.headers.get('location'), '/moved');
    assert.equal(await response.text(), '');
  });

  for (const [name, answer] of [
    ['a string', '<p>html</p>'],
    ['a redirect with a non-redirect status', { kind: 'redirect', status: 200, location: '/x' }],
    ['a redirect to a protocol-relative URL', { kind: 'redirect', status: 302, location: '//x' }],
    [
      'a document with a redirect status',
      { kind: 'document', status: 302, headers: new Headers(), body: { kind: 'bytes', html: '' } },
    ],
    [
      'a document without a body',
      { kind: 'document', status: 200, headers: new Headers(), body: undefined },
    ],
  ] as const) {
    it(`refuses ${name} as a reported value-free 500`, async () => {
      const { response, reported } = await serve(answer);
      assert.equal(response.status, 500);
      assert.equal(response.headers.get('location'), null);
      await response.body?.cancel();
      assert.equal(reported.length, 1);
      assert.match(String(reported[0]), /did not answer with a page outcome/);
    });
  }
});

describe('streaming page rendering', () => {
  const dir = mkdtempSync(join(distDir, 'page-streaming-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const runtimeUrl = new URL('../../src/jsx/jsx-runtime.js', import.meta.url).href;
  const httpUrl = new URL('../../src/contracts/http.js', import.meta.url).href;

  /** Each test drives its page's slow component through a named global gate. */
  interface Gate {
    open: (value: string) => void;
    promise: Promise<string>;
    renders: number;
  }
  const gates = new Map<string, Gate>();
  (globalThis as { __jsailsStreamGates?: Map<string, Gate> }).__jsailsStreamGates = gates;
  function gateFor(name: string): Gate {
    let open!: (value: string) => void;
    const promise = new Promise<string>((resolve) => {
      open = resolve;
    });
    const created: Gate = { open, promise, renders: 0 };
    gates.set(name, created);
    return created;
  }

  /** A streamed page whose `<b>` waits on gate `name`; the value `boom` makes it throw. */
  function suspendingPage(name: string): string {
    return `import { jsx } from ${JSON.stringify(runtimeUrl)};
import { Suspense } from 'preact/compat';
export const stream = true;
let value;
function Slow() {
  const gate = globalThis.__jsailsStreamGates.get(${JSON.stringify(name)});
  gate.renders += 1;
  if (value === undefined) throw gate.promise.then((resolved) => { value = resolved; });
  if (value === 'boom') throw new Error('late secret');
  return jsx('b', { children: value });
}
export const metadata = { title: 'Streamed page' };
export default function Page() {
  return jsx('main', { children: [
    jsx('p', { children: 'shell' }),
    jsx(Suspense, { fallback: jsx('i', { children: 'loading' }), children: jsx(Slow, {}) }),
  ] });
}
`;
  }

  writeFixture(dir, 'pages/slow.mjs', suspendingPage('slow'));
  writeFixture(dir, 'pages/failing.mjs', suspendingPage('failing'));
  writeFixture(dir, 'pages/leaving.mjs', suspendingPage('leaving'));
  writeFixture(
    dir,
    'pages/buffered.mjs',
    `export default function Page() { return 'buffered'; }
`,
  );
  writeFixture(
    dir,
    'pages/guarded/error.mjs',
    `import { jsx } from ${JSON.stringify(runtimeUrl)};
export default function ErrorBoundary({ error }) {
  return jsx('p', { children: error.status + ' ' + error.message });
}
`,
  );
  writeFixture(
    dir,
    'pages/guarded/missing.mjs',
    `import { HttpError } from ${JSON.stringify(httpUrl)};
export const stream = true;
export function load() { throw new HttpError('not_found', 'No such thing', 404); }
export default function Page() { return null; }
`,
  );
  writeFixture(
    dir,
    'pages/shell-broken.mjs',
    `import { jsx } from ${JSON.stringify(runtimeUrl)};
export const stream = true;
function Broken() { throw new Error('shell secret'); }
export default function Page() { return jsx('main', { children: jsx(Broken, {}) }); }
`,
  );
  writeFixture(
    dir,
    'pages/hung.mjs',
    `import { jsx } from ${JSON.stringify(runtimeUrl)};
import { Suspense } from 'preact/compat';
export const stream = true;
function Hung() { throw new Promise(() => {}); }
export default function Page() {
  return jsx('main', { children: jsx(Suspense, { fallback: jsx('i', { children: 'wait' }), children: jsx(Hung, {}) }) });
}
`,
  );
  writeFixture(
    dir,
    'pages/throws-string.mjs',
    `export default function Page() { throw 'string secret'; }
`,
  );
  const manifest = discoverRoutes(dir);
  const BROWSER = { accept: 'text/html,application/xhtml+xml' };
  const decoder = new TextDecoder();

  async function streamingApp(onError: (error: unknown) => void = () => undefined) {
    return createApp({ manifest, renderer: preactPageRenderer, onError });
  }

  /** Assembling an app with `source` as its only page fails with `pattern`. */
  async function refusesPage(source: string, pattern: RegExp): Promise<void> {
    const conflictDir = mkdtempSync(join(distDir, 'page-streaming-conflict-'));
    try {
      writeFixture(conflictDir, 'pages/index.mjs', source);
      await assert.rejects(
        createApp({ manifest: discoverRoutes(conflictDir), renderer: preactPageRenderer }),
        (error: unknown) =>
          error instanceof Error &&
          (error as { code?: unknown }).code === 'invalid_module' &&
          pattern.test(error.message),
      );
    } finally {
      rmSync(conflictDir, { recursive: true, force: true });
    }
  }

  async function readAll(response: Response): Promise<string> {
    return response.text();
  }

  it('sends the head and shell before a slow component resolves', async () => {
    const gate = gateFor('slow');
    const app = await streamingApp();
    const res = await app.fetch(new Request('http://localhost/slow', { headers: BROWSER }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    assert.equal(res.headers.get('etag'), null);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');

    const reader = res.body!.getReader();
    const first = await reader.read();
    const shell = decoder.decode(first.value);
    assert.match(shell, /<title>Streamed page<\/title>/);
    assert.match(shell, /<p>shell<\/p><!--\$s:-?\d+--><i>loading<\/i>/);
    assert.doesNotMatch(shell, /<b>/);

    gate.open('arrived');
    let rest = '';
    for (let step = await reader.read(); !step.done; step = await reader.read()) {
      rest += decoder.decode(step.value);
    }
    assert.match(rest, /<b>arrived<\/b>/);
    assert.ok(rest.endsWith('</body></html>'));
  });

  it('buffers a page that does not export stream', async () => {
    const res = await (
      await streamingApp()
    ).fetch(new Request('http://localhost/buffered', { headers: BROWSER }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-accel-buffering'), null);
    assert.ok(res.headers.get('content-length') !== null, 'a buffered page has a length');
    assert.match(await readAll(res), /buffered/);
  });

  it('refuses a page that streams and declares a cache', async () => {
    await refusesPage(
      `export const stream = true;
export const cacheControl = { maxAge: 60 };
export default function Page() { return 'shared'; }
`,
      /cannot both stream and declare a cache/,
    );
    await refusesPage(
      `export const stream = true;
export const cache = 'public';
export const revalidate = 60;
export default function Page() { return 'shared'; }
`,
      /cannot both stream and declare a cache/,
    );
  });

  it('refuses stream = false: pages are buffered unless they opt in', async () => {
    await refusesPage(
      `export const stream = false;
export default function Page() { return 'buffered'; }
`,
      /export "stream" must be true or a function/,
    );
  });

  it('ends a streamed page at render.streamTimeoutMs and reports the timeout', async () => {
    const reported: unknown[] = [];
    const app = await createApp({
      manifest,
      renderer: preactPageRenderer,
      onError: (error) => {
        reported.push(error);
      },
      render: { streamTimeoutMs: 20 },
    });
    const res = await app.fetch(new Request('http://localhost/hung', { headers: BROWSER }));
    assert.equal(res.status, 200);
    const text = await readAll(res);
    assert.match(text, /<i>wait<\/i>/);
    assert.match(text, /data-jsails-stream-error/);
    assert.ok(text.endsWith('</body></html>'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reported.length, 1);
    assert.equal((reported[0] as { code?: unknown }).code, 'render_timeout');
  });

  it('keeps the error-boundary status for a failure before the first flush', async () => {
    const res = await (
      await streamingApp()
    ).fetch(new Request('http://localhost/guarded/missing', { headers: BROWSER }));
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.match(await readAll(res), /404 No such thing/);
  });

  it('answers a shell failure with the value-free 500 page and reports it', async () => {
    const reported: unknown[] = [];
    const res = await (
      await streamingApp((error) => reported.push(error))
    ).fetch(new Request('http://localhost/shell-broken', { headers: BROWSER }));
    assert.equal(res.status, 500);
    assert.doesNotMatch(await readAll(res), /shell secret/);
    assert.equal(reported.length, 1);
  });

  it('closes the document with a fallback and reports a failure after the flush', async () => {
    const gate = gateFor('failing');
    const reported: unknown[] = [];
    const res = await (
      await streamingApp((error) => reported.push(error))
    ).fetch(new Request('http://localhost/failing', { headers: BROWSER }));
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    await reader.read();
    gate.open('boom');
    let rest = '';
    for (let step = await reader.read(); !step.done; step = await reader.read()) {
      rest += decoder.decode(step.value);
    }
    assert.match(rest, /data-jsails-stream-error/);
    assert.ok(rest.endsWith('</body></html>'));
    assert.doesNotMatch(rest, /late secret/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reported.length, 1);
    assert.match(String(reported[0]), /late secret/);
  });

  it('stops rendering when the client disconnects', async () => {
    const gate = gateFor('leaving');
    const res = await (
      await streamingApp()
    ).fetch(new Request('http://localhost/leaving', { headers: BROWSER }));
    const reader = res.body!.getReader();
    await reader.read();
    assert.equal(gate.renders, 1);
    await reader.cancel();
    gate.open('gone');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(gate.renders, 1);
  });

  it('answers a page that throws a non-Error value with the 500 page and reports the value', async () => {
    const reported: unknown[] = [];
    const res = await (
      await streamingApp((error) => reported.push(error))
    ).fetch(new Request('http://localhost/throws-string', { headers: BROWSER }));
    assert.equal(res.status, 500);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.doesNotMatch(await readAll(res), /string secret/);
    assert.deepEqual(reported, ['string secret']);
  });

  it('rejects the app-wide render.stream switch and a malformed streamTimeoutMs', async () => {
    await assert.rejects(
      createApp({ manifest, render: { stream: true } as unknown as { streamTimeoutMs?: number } }),
      /render.stream is not an option/,
    );
    for (const streamTimeoutMs of [0, 2.5, 2_147_483_648, '30' as unknown as number]) {
      await assert.rejects(
        createApp({ manifest, render: { streamTimeoutMs } }),
        /render.streamTimeoutMs must be a positive integer/,
      );
    }
  });
});

describe('module preloading', () => {
  const suiteDir = mkdtempSync(join(distDir, 'page-preload-'));
  after(() => rmSync(suiteDir, { recursive: true, force: true }));

  it('loads every layout at assembly when preloading, and on first render otherwise', async () => {
    const dir = mkdtempSync(join(suiteDir, 'layout-'));
    writeFixture(dir, 'pages/index.mjs', `export default () => 'home';\n`);
    writeFixture(dir, 'pages/layout.mjs', `throw new Error('layout evaluation failed');\n`);
    const manifest = discoverRoutes(dir);

    await assert.rejects(
      createApp({ manifest, renderer: preactPageRenderer, preloadModules: true }),
      (error: unknown) => (error as { code?: unknown }).code === 'route_module.import_failed',
    );

    const lazy = await createApp({
      manifest,
      renderer: preactPageRenderer,
      preloadModules: false,
      onError: () => undefined,
    });
    assert.equal((await lazy.fetch(new Request('http://localhost/'))).status, 500);
  });
});
