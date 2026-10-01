/**
 * Streaming page rendering tests: the shell (with its head) is the first chunk
 * and arrives before a suspended component resolves; a shell failure rejects
 * before any byte; a later failure closes the document with the value-free
 * fallback and reaches `onError`; a cancel stops the render; a suspension
 * deep inside a boundary replaces the whole boundary without duplicating its
 * siblings; a never-settling suspension ends at the deadline; and
 * `renderRouteStream` keeps the shared page-props cache.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { h, type VNode } from 'preact';
import { Suspense } from 'preact/compat';

import type { CacheStore } from '../../src/cache/store.js';
import type { RequestContext } from '../../src/contracts/http.js';
import { PageRenderError, renderRouteStream } from '../../src/pages/page.js';
import { STREAM_ERROR_FALLBACK, streamDocument } from '../../src/pages/streaming-render.js';
import type { RouteManifestEntry } from '../../src/routing/routes.js';

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'stream-ssr-'));
const runtimeUrl = new URL('../../src/jsx/jsx-runtime.js', import.meta.url).href;
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const decoder = new TextDecoder();

interface Gate<T> {
  readonly promise: Promise<T>;
  readonly open: (value: T) => void;
}

function gate<T>(): Gate<T> {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * A component that suspends until `pending` resolves, then renders `render`
 * with the value. `renders` counts how often it ran.
 */
function slowComponent(pending: Promise<string>, render: (value: string) => VNode) {
  const state: { value?: string; renders: number } = { renders: 0 };
  function Slow(): VNode {
    state.renders += 1;
    if (state.value === undefined) {
      throw pending.then((value) => {
        state.value = value;
      });
    }
    return render(state.value);
  }
  return { Slow, state };
}

function documentWith(slow: () => VNode): VNode {
  return h(
    'html',
    null,
    h('head', null, h('title', null, 'Streamed')),
    h(
      'body',
      null,
      h('p', null, 'shell'),
      h(Suspense, { fallback: h('i', null, 'loading') }, h(slow, null)),
    ),
  );
}

const injectNothing = (start: string): string => start;

/** Read one chunk, failing instead of hanging when none arrives in time. */
async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('no chunk within 2s')), 2000);
  });
  try {
    const step = await Promise.race([reader.read(), timeout]);
    return step.done ? null : decoder.decode(step.value);
  } finally {
    clearTimeout(timer);
  }
}

async function readRest(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let text = '';
  for (let chunk = await readChunk(reader); chunk !== null; chunk = await readChunk(reader)) {
    text += chunk;
  }
  return text;
}

describe('streamDocument', () => {
  it('sends the shell and head before a suspended component resolves', async () => {
    const data = gate<string>();
    const { Slow } = slowComponent(data.promise, (value) => h('b', null, value));
    const body = streamDocument(documentWith(Slow), {
      injectHead: (start) => start.replace('</head>', '<meta name="x" content="y"></head>'),
    });
    const reader = body.getReader();

    const first = await readChunk(reader);
    assert.ok(first !== null);
    assert.ok(first.startsWith('<!DOCTYPE html><html><head><title>Streamed</title>'));
    assert.match(first, /<meta name="x" content="y"><\/head>/);
    assert.match(first, /<p>shell<\/p>/);
    assert.match(first, /<i>loading<\/i>/);
    assert.doesNotMatch(first, /resolved/);

    data.open('resolved');
    const rest = await readRest(reader);
    assert.match(rest, /<b>resolved<\/b>/);
    assert.ok(rest.endsWith('</body></html>'));
    assert.equal((first + rest).match(/<!DOCTYPE html>/g)?.length, 1);
  });

  it('opens and closes a document around a shell without an html root', async () => {
    const body = streamDocument(h('main', null, 'plain'), { injectHead: injectNothing });
    const text = await readRest(body.getReader());
    assert.equal(
      text,
      '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><main>plain</main></body></html>',
    );
  });

  it('throws before any byte when the shell fails', () => {
    function Broken(): VNode {
      throw new Error('shell secret');
    }
    function Wrapper(): VNode {
      return h('section', null, h(Broken, null));
    }
    assert.throws(
      () => streamDocument(h('main', null, h(Wrapper, null)), { injectHead: injectNothing }),
      /shell secret/,
    );
  });

  it('throws when a component suspends outside any Suspense boundary', () => {
    function Waiting(): VNode {
      throw new Promise(() => undefined);
    }
    assert.throws(() =>
      streamDocument(h('main', null, h(Waiting, null)), { injectHead: injectNothing }),
    );
  });

  it('closes the document with the fallback when suspended data is rejected', async () => {
    let reject!: (error: Error) => void;
    const data = new Promise<string>((_resolve, rejectWith) => {
      reject = rejectWith;
    });
    data.catch(() => undefined);
    const { Slow } = slowComponent(data, (value) => h('b', null, value));
    const reported: unknown[] = [];
    const body = streamDocument(documentWith(Slow), {
      injectHead: injectNothing,
      onError: (error) => reported.push(error),
    });
    const reader = body.getReader();
    await readChunk(reader);
    reject(new Error('fetch secret'));
    const rest = await readRest(reader);
    assert.ok(rest.endsWith(STREAM_ERROR_FALLBACK));
    assert.doesNotMatch(rest, /fetch secret/);
    assert.equal(reported.length, 1);
  });

  it('reports a failure nested below the suspended component', async () => {
    const data = gate<string>();
    function Thrower(): VNode {
      throw new Error('nested secret');
    }
    const { Slow } = slowComponent(data.promise, () => h('div', null, h(Thrower, null)));
    const reported: unknown[] = [];
    const body = streamDocument(documentWith(Slow), {
      injectHead: injectNothing,
      onError: (error) => reported.push(error),
    });
    const reader = body.getReader();
    await readChunk(reader);
    data.open('go');
    const rest = await readRest(reader);
    assert.ok(rest.endsWith(STREAM_ERROR_FALLBACK));
    assert.equal(reported.length, 1);
    assert.match(String(reported[0]), /nested secret/);
  });

  it('closes the document with the fallback when a subtree fails after the flush', async () => {
    const data = gate<string>();
    const { Slow } = slowComponent(data.promise, () => {
      throw new Error('late secret');
    });
    const reported: unknown[] = [];
    const body = streamDocument(documentWith(Slow), {
      injectHead: injectNothing,
      onError: (error) => reported.push(error),
    });
    const reader = body.getReader();
    const first = await readChunk(reader);
    assert.match(first ?? '', /<p>shell<\/p>/);

    data.open('go');
    const rest = await readRest(reader);
    assert.ok(rest.endsWith(STREAM_ERROR_FALLBACK), rest);
    assert.doesNotMatch(first + rest, /late secret|>undefined</);
    assert.equal(reported.length, 1);
    assert.match(String(reported[0]), /late secret/);
  });

  it('stops rendering when the client disconnects', async () => {
    const data = gate<string>();
    const { Slow, state } = slowComponent(data.promise, (value) => h('b', null, value));
    const body = streamDocument(documentWith(Slow), { injectHead: injectNothing });
    const reader = body.getReader();
    await readChunk(reader);
    assert.equal(state.renders, 1);

    await reader.cancel();
    data.open('too late');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(state.renders, 1, 'the suspended subtree must not render after a cancel');
  });

  it('replaces the whole boundary when a grandchild suspends next to a sibling', async () => {
    const data = gate<string>();
    const { Slow: List } = slowComponent(data.promise, (value) => h('li', null, value));
    function Comments(): VNode {
      return h('ul', null, h(List, null));
    }
    const tree = h(
      'main',
      null,
      h(Suspense, { fallback: h('i', null, 'loading') }, h('h2', null, 'Title'), h(Comments, null)),
    );
    const reader = streamDocument(tree, { injectHead: injectNothing }).getReader();
    const shell = (await readChunk(reader)) ?? '';
    assert.match(shell, /<main><!--\$s:(-?\d+)--><i>loading<\/i><!--\/\$s:\1-->/);
    assert.doesNotMatch(shell, /Title/);

    data.open('x');
    const rest = await readRest(reader);
    assert.match(
      rest,
      /<jsails-chunk hidden data-target="-?\d+"><h2>Title<\/h2><ul><li>x<\/li><\/ul>/,
    );
    assert.equal((shell + rest).match(/<h2>Title<\/h2>/g)?.length, 1);
  });

  it('sends a boundary once when a grandchild suspends again while resuming', async () => {
    const first = gate<string>();
    const second = gate<string>();
    const { Slow: Outer } = slowComponent(first.promise, (value) => h('span', null, value));
    const { Slow: Inner } = slowComponent(second.promise, (value) => h('em', null, value));
    function Panel(): VNode {
      return h('section', null, h(Outer, null), h('div', null, h(Inner, null)));
    }
    const tree = h(
      'main',
      null,
      h(Suspense, { fallback: h('i', null, 'loading') }, h('h2', null, 'Title'), h(Panel, null)),
    );
    const reader = streamDocument(tree, { injectHead: injectNothing }).getReader();
    const shell = (await readChunk(reader)) ?? '';
    first.open('a');
    await new Promise((resolve) => setTimeout(resolve, 10));
    second.open('b');
    const rest = await readRest(reader);
    const chunks = rest.match(/<jsails-chunk/g) ?? [];
    assert.equal(chunks.length, 1, rest);
    assert.match(rest, /<h2>Title<\/h2><section><span>a<\/span><div><em>b<\/em><\/div><\/section>/);
    assert.equal((shell + rest).match(/<h2>Title<\/h2>/g)?.length, 1);
  });

  it('ends a suspension that never settles at the deadline and reports it once', async () => {
    const { Slow } = slowComponent(new Promise<string>(() => undefined), (value) =>
      h('b', null, value),
    );
    const reported: unknown[] = [];
    const timeout = new Error('timed out');
    const body = streamDocument(documentWith(Slow), {
      injectHead: injectNothing,
      onError: (error) => reported.push(error),
      timeoutMs: 20,
      timeoutError: () => timeout,
    });
    const reader = body.getReader();
    await readChunk(reader);
    const rest = await readRest(reader);
    assert.ok(rest.endsWith(STREAM_ERROR_FALLBACK));
    assert.deepEqual(reported, [timeout]);
  });

  it('delivers queued chunks one read at a time', async () => {
    const data = gate<string>();
    const { Slow } = slowComponent(data.promise, (value) => h('b', null, value));
    const body = streamDocument(documentWith(Slow), { injectHead: injectNothing });
    data.open('ready');
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The subtree resolved while nobody read; it waits in the queue, and the
    // first read still returns the shell alone.
    const reader = body.getReader();
    const first = await readChunk(reader);
    assert.doesNotMatch(first ?? '', /ready/);
    assert.match(await readRest(reader), /<b>ready<\/b>/);
  });
});

describe('renderRouteStream', () => {
  let sequence = 0;
  function pageEntry(source: string): RouteManifestEntry {
    const file = join(tmpRoot, `page-${sequence++}.mjs`);
    writeFileSync(file, source);
    return { kind: 'page', route: '/', file, dynamic: false, catchAll: false, params: [] };
  }

  function contextFor(services?: unknown): RequestContext {
    const url = new URL('http://localhost/page');
    return {
      request: new Request(url),
      url,
      params: {},
      session: null,
      ...(services === undefined ? {} : { services }),
    } as RequestContext;
  }

  it('injects the page metadata into the first chunk', async () => {
    const entry = pageEntry(`import { jsx } from ${JSON.stringify(runtimeUrl)};
export const metadata = { title: 'Streamed title' };
export default function Page() { return jsx('main', { children: 'hi' }); }
`);
    const text = await readRest((await renderRouteStream(entry, contextFor())).getReader());
    assert.match(text, /<title>Streamed title<\/title>/);
    assert.match(text, /<main>hi<\/main><\/body><\/html>$/);
  });

  it('refuses a static render', async () => {
    const entry = pageEntry(`export default function Page() { return null; }\n`);
    await assert.rejects(
      renderRouteStream(entry, contextFor(), { staticMode: true }),
      (error: unknown) => error instanceof PageRenderError && error.code === 'invalid_render',
    );
  });

  it('refuses a stream export that is neither a function nor a boolean', async () => {
    const entry = pageEntry(`export const stream = 'yes';
export default function Page() { return null; }
`);
    await assert.rejects(
      renderRouteStream(entry, contextFor()),
      (error: unknown) => error instanceof PageRenderError && error.code === 'invalid_module',
    );
  });

  it('reports a render_timeout when a suspended subtree outlives timeoutMs', async () => {
    const entry = pageEntry(`import { jsx } from ${JSON.stringify(runtimeUrl)};
import { Suspense } from 'preact/compat';
function Hung() { throw new Promise(() => {}); }
export default function Page() {
  return jsx(Suspense, { fallback: jsx('i', { children: 'wait' }), children: jsx(Hung, {}) });
}
`);
    const reported: unknown[] = [];
    const body = await renderRouteStream(entry, contextFor(), {
      timeoutMs: 20,
      onError: (error) => reported.push(error),
    });
    const text = await readRest(body.getReader());
    assert.ok(text.endsWith(STREAM_ERROR_FALLBACK));
    assert.equal(reported.length, 1);
    assert.ok(reported[0] instanceof PageRenderError && reported[0].code === 'render_timeout');
  });

  it('refuses a timeoutMs that is not a positive integer', async () => {
    const entry = pageEntry(`export default function Page() { return null; }\n`);
    for (const timeoutMs of [0, -1, 1.5, Number.NaN]) {
      await assert.rejects(
        renderRouteStream(entry, contextFor(), { timeoutMs }),
        (error: unknown) => error instanceof PageRenderError && error.code === 'invalid_render',
      );
    }
  });

  it('rejects before streaming when load fails and no boundary exists', async () => {
    const entry = pageEntry(`export function load() { throw new Error('load secret'); }
export default function Page() { return null; }
`);
    await assert.rejects(renderRouteStream(entry, contextFor()), /load secret/);
  });

  it("serves cache: 'public' props from the shared cache", async () => {
    const entries = new Map<string, string>();
    const store: CacheStore = {
      async get(key) {
        return entries.get(key) ?? null;
      },
      async set(key, value) {
        entries.set(key, value);
      },
      async delete(key) {
        entries.delete(key);
      },
      async remember(key, _ttlMs, loader) {
        const cached = entries.get(key);
        if (cached !== undefined) return cached;
        const value = await loader();
        entries.set(key, value);
        return value;
      },
      async close() {
        entries.clear();
      },
    };
    const services = { has: () => true, tryGet: () => store, get: () => store };
    const entry = pageEntry(`import { jsx } from ${JSON.stringify(runtimeUrl)};
let loads = 0;
export const cache = 'public';
export const revalidate = 60;
export function load() { loads += 1; return { loads }; }
export default function Page({ loads }) { return jsx('main', { children: 'loads ' + loads }); }
`);
    const first = await readRest(
      (await renderRouteStream(entry, contextFor(services))).getReader(),
    );
    const second = await readRest(
      (await renderRouteStream(entry, contextFor(services))).getReader(),
    );
    assert.match(first, /loads 1/);
    assert.match(second, /loads 1/);
  });
});
