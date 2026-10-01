/**
 * Page route registration tests: a streamed producer that throws after the
 * response started must still reach `requestFailed` observers, because the
 * handler has already returned by then; and a page rendered by its error
 * boundary answers with the error's status, never 200, and is never cached.
 * Streaming rendering (`render: { stream }` and the page `stream` export) is
 * covered end to end: early first bytes, failures before and after the first
 * flush, a disconnect, the stream deadline, caching headers (a page with a
 * public `cacheControl` stays buffered), and a thrown non-Error value.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { definePlugin, type PluginContext } from '../../src/extensions/plugin-contract.js';
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
        authorize: () => true,
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
    assert.equal(res.headers.get('cache-control'), 'no-store');
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

  /** A page whose `<b>` waits on gate `name`; the value `boom` makes it throw. */
  function suspendingPage(name: string, exports = ''): string {
    return `import { jsx } from ${JSON.stringify(runtimeUrl)};
import { Suspense } from 'preact/compat';
${exports}
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
    'pages/opted-in.mjs',
    suspendingPage('opted-in', 'export const stream = true;'),
  );
  writeFixture(
    dir,
    'pages/opted-out.mjs',
    `export const stream = false;
export default function Page() { return 'buffered'; }
`,
  );
  writeFixture(
    dir,
    'pages/public.mjs',
    `export const cacheControl = { maxAge: 60 };
export default function Page() { return 'shared'; }
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
export function load() { throw new HttpError('not_found', 'No such thing', 404); }
export default function Page() { return null; }
`,
  );
  writeFixture(
    dir,
    'pages/shell-broken.mjs',
    `import { jsx } from ${JSON.stringify(runtimeUrl)};
function Broken() { throw new Error('shell secret'); }
export default function Page() { return jsx('main', { children: jsx(Broken, {}) }); }
`,
  );
  writeFixture(
    dir,
    'pages/hung.mjs',
    `import { jsx } from ${JSON.stringify(runtimeUrl)};
import { Suspense } from 'preact/compat';
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

  async function streamingApp(
    stream: boolean | undefined,
    onError: (error: unknown) => void = () => undefined,
  ) {
    return createApp({
      manifest,
      renderer: preactPageRenderer,
      onError,
      ...(stream === undefined ? {} : { render: { stream } }),
    });
  }

  async function readAll(response: Response): Promise<string> {
    return response.text();
  }

  it('sends the head and shell before a slow component resolves', async () => {
    const gate = gateFor('slow');
    const app = await streamingApp(true);
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

  it('streams a page that exports stream = true when the app default is buffered', async () => {
    const gate = gateFor('opted-in');
    gate.open('now');
    const res = await (
      await streamingApp(undefined)
    ).fetch(new Request('http://localhost/opted-in', { headers: BROWSER }));
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    assert.match(await readAll(res), /<b>now<\/b>/);
  });

  it('buffers a page that exports stream = false when the app streams', async () => {
    const res = await (
      await streamingApp(true)
    ).fetch(new Request('http://localhost/opted-out', { headers: BROWSER }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-accel-buffering'), null);
    assert.match(await readAll(res), /buffered/);
  });

  it('keeps a page with a public cacheControl buffered when the app streams', async () => {
    const res = await (
      await streamingApp(true)
    ).fetch(new Request('http://localhost/public', { headers: BROWSER }));
    assert.equal(res.headers.get('x-accel-buffering'), null);
    assert.match(res.headers.get('cache-control') ?? '', /^public, max-age=0, s-maxage=60/);
    assert.match(await readAll(res), /shared/);
  });

  it('refuses a page that exports stream = true with a public cacheControl', async () => {
    const conflictDir = mkdtempSync(join(distDir, 'page-streaming-conflict-'));
    try {
      writeFixture(
        conflictDir,
        'pages/index.mjs',
        `export const stream = true;
export const cacheControl = { maxAge: 60 };
export default function Page() { return 'shared'; }
`,
      );
      await assert.rejects(
        createApp({ manifest: discoverRoutes(conflictDir), renderer: preactPageRenderer }),
        (error: unknown) =>
          error instanceof Error &&
          (error as { code?: unknown }).code === 'invalid_module' &&
          /cannot stream with a public cacheControl/.test(error.message),
      );
    } finally {
      rmSync(conflictDir, { recursive: true, force: true });
    }
  });

  it('ends a streamed page at render.streamTimeoutMs and reports the timeout', async () => {
    const reported: unknown[] = [];
    const app = await createApp({
      manifest,
      renderer: preactPageRenderer,
      onError: (error) => {
        reported.push(error);
      },
      render: { stream: true, streamTimeoutMs: 20 },
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
      await streamingApp(true)
    ).fetch(new Request('http://localhost/guarded/missing', { headers: BROWSER }));
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(await readAll(res), /404 No such thing/);
  });

  it('answers a shell failure with the value-free 500 page and reports it', async () => {
    const reported: unknown[] = [];
    const res = await (
      await streamingApp(true, (error) => reported.push(error))
    ).fetch(new Request('http://localhost/shell-broken', { headers: BROWSER }));
    assert.equal(res.status, 500);
    assert.doesNotMatch(await readAll(res), /shell secret/);
    assert.equal(reported.length, 1);
  });

  it('closes the document with a fallback and reports a failure after the flush', async () => {
    const gate = gateFor('failing');
    const reported: unknown[] = [];
    const res = await (
      await streamingApp(true, (error) => reported.push(error))
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
      await streamingApp(true)
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
      await streamingApp(undefined, (error) => reported.push(error))
    ).fetch(new Request('http://localhost/throws-string', { headers: BROWSER }));
    assert.equal(res.status, 500);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.doesNotMatch(await readAll(res), /string secret/);
    assert.deepEqual(reported, ['string secret']);
  });

  it('rejects a render option that is not an object or a non-boolean stream', async () => {
    await assert.rejects(
      createApp({ manifest, render: { stream: 'yes' as unknown as boolean } }),
      /render.stream must be a boolean/,
    );
    for (const streamTimeoutMs of [0, 2.5, 2_147_483_648, '30' as unknown as number]) {
      await assert.rejects(
        createApp({ manifest, render: { stream: true, streamTimeoutMs } }),
        /render.streamTimeoutMs must be a positive integer/,
      );
    }
  });
});
