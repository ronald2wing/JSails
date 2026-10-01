/**
 * Page stream producer tests: a page's `stream` function answers through the
 * app as a recorded stream response, read by the finalizer.
 *
 * Each fixture page delegates its producer to a function the test registers
 * under the page's name in a global map, so a test drives the producer
 * directly while the page goes through route registration, the request
 * frame and the finalizer like any other. Covered: every producer shape (an
 * async iterable of strings, a `ReadableStream`, a Node `Readable`), the
 * headers, backpressure, a disconnect, a mid-stream failure reported with its
 * route, the request context each chunk is produced in, and `renderRoute`,
 * which never runs a producer.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { currentContext } from '../../src/context/execution-context.js';
import type { RequestContext } from '../../src/contracts/http.js';
import type { PageStream } from '../../src/contracts/render.js';
import { preactPageRenderer } from '../../src/pages/page.js';
import { discoverRoutes, type RouteManifestEntry } from '../../src/routing/routes.js';
import { createApp } from '../../src/server/app.js';
import { writeFixture } from '../fixtures/app.js';
import { renderHtml } from './rendered-document.js';

type Producer = (context: RequestContext) => PageStream;

const producers = new Map<string, Producer>();
(globalThis as { __jsailsProducers?: Map<string, Producer> }).__jsailsProducers = producers;

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const appDir = mkdtempSync(join(distDir, 'page-producers-'));
const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'stream-'));
const runtimeUrl = new URL('../../src/jsx/jsx-runtime.js', import.meta.url).href;

after(() => {
  rmSync(appDir, { recursive: true, force: true });
  rmSync(tmpRoot, { recursive: true, force: true });
});

const PAGES = ['iterable', 'web', 'node', 'eager', 'endless', 'failing', 'scoped'] as const;
for (const name of PAGES) {
  writeFixture(
    appDir,
    `pages/${name}.mjs`,
    `export function stream(context) {
  return globalThis.__jsailsProducers.get(${JSON.stringify(name)})(context);
}
`,
  );
}
const manifest = discoverRoutes(appDir);

/** An app serving the producer pages; `reported` collects what reaches `onError`. */
async function producerApp(reported: unknown[] = []) {
  return createApp({
    manifest,
    renderer: preactPageRenderer,
    onError: (error) => {
      reported.push(error);
    },
  });
}

async function fetchPage(name: (typeof PAGES)[number], reported?: unknown[]): Promise<Response> {
  const app = await producerApp(reported);
  return app.fetch(new Request(`http://localhost/${name}`));
}

describe('page stream producers', () => {
  it('streams an async iterable of strings as an HTML document', async () => {
    producers.set('iterable', async function* () {
      yield '<h1>';
      yield 'hi';
      yield '</h1>';
    });
    const response = await fetchPage('iterable');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    assert.equal(response.headers.get('content-length'), null);
    assert.equal(await response.text(), '<h1>hi</h1>');
  });

  it('streams a ReadableStream of bytes', async () => {
    const encoder = new TextEncoder();
    producers.set(
      'web',
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('<h1>'));
            controller.enqueue(encoder.encode('stream'));
            controller.enqueue(encoder.encode('</h1>'));
            controller.close();
          },
        }),
    );
    assert.equal(await (await fetchPage('web')).text(), '<h1>stream</h1>');
  });

  it('streams a Node Readable, an async iterable of buffers', async () => {
    producers.set('node', () => Readable.from(['<h1>', 'node', '</h1>']) as PageStream);
    assert.equal(await (await fetchPage('node')).text(), '<h1>node</h1>');
  });

  it('advances the producer only as the client reads (backpressure)', async () => {
    let produced = 0;
    producers.set('eager', async function* () {
      for (let i = 0; i < 1_000; i += 1) {
        produced += 1;
        yield `chunk-${i};`;
      }
    });
    const response = await fetchPage('eager');
    const reader = response.body!.getReader();
    await reader.read();
    // Give an eager producer every chance to run ahead of the reader.
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(produced <= 3, `producer ran ahead of the client: ${produced} chunks`);
    await reader.cancel();
  });

  it('stops the producer when the client disconnects', async () => {
    let finalized = false;
    let produced = 0;
    producers.set('endless', async function* () {
      try {
        for (;;) {
          produced += 1;
          yield 'tick';
          await new Promise((resolve) => setImmediate(resolve));
        }
      } finally {
        finalized = true;
      }
    });
    const response = await fetchPage('endless');
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    const atCancel = produced;
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finalized, true, 'the producer finally block must run on cancel');
    assert.equal(produced, atCancel, 'the producer must not keep running after cancel');
  });

  it('reports a mid-stream producer failure once and errors the body', async () => {
    const failure = new Error('upstream lost');
    producers.set('failing', async function* () {
      yield '<p>start</p>';
      throw failure;
    });
    const reported: unknown[] = [];
    const response = await fetchPage('failing', reported);
    assert.equal(response.status, 200);
    await assert.rejects(() => response.text());
    assert.deepEqual(reported, [failure]);
  });

  it('produces every chunk inside the request it answers', async () => {
    const seen: (string | undefined)[] = [];
    producers.set('scoped', async function* () {
      seen.push(currentContext()?.requestId);
      yield '1;';
      await new Promise((resolve) => setImmediate(resolve));
      seen.push(currentContext()?.requestId);
      yield '2;';
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(currentContext()?.requestId);
      yield '3;';
    });
    const response = await fetchPage('scoped');
    const requestId = response.headers.get('x-request-id');
    assert.ok(requestId !== null && requestId !== '');
    // The reader waits before every read, as a socket under backpressure
    // does, so each pull starts from outside the request.
    const reader = response.body!.getReader();
    for (;;) {
      await new Promise((resolve) => setImmediate(resolve));
      const { done } = await reader.read();
      if (done) break;
    }
    assert.deepEqual(seen, [requestId, requestId, requestId]);
  });
});

let sequence = 0;
function writeModule(source: string): string {
  const file = join(tmpRoot, `fixture-stream-${sequence++}.js`);
  writeFileSync(file, source);
  return file;
}

function pageEntry(file: string, route = '/'): RouteManifestEntry {
  return { kind: 'page', route, file, dynamic: false, catchAll: false, params: [] };
}

function makeContext(): RequestContext {
  const url = new URL('http://localhost/test');
  return { request: new Request(url), url, params: {}, session: null };
}

describe('renderRoute and a stream producer', () => {
  it('renders the default component and never runs the producer', async () => {
    // The producer is the route's answer when the page is served; rendering
    // (the static export, a not-found page) only uses default and load.
    const file = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export async function* stream() { yield '<h1>ignored</h1>'; }
       export function load() { return { msg: 'rendered' }; }
       export default function Page({ msg }) {
         return jsx('p', { children: msg });
       }
      `,
    );
    const html = await renderHtml(pageEntry(file), makeContext());
    assert.equal(
      html,
      '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><p>rendered</p></body></html>',
    );
  });
});
