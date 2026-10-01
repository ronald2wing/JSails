/**
 * SSR gateways and the render policy (P-19 Server-Side Rendering; clause
 * numbering as in props.test.ts): the in-process gateway with the upstream
 * `(page, renderToString)` signature and preact-render-to-string, the HTTP
 * gateway against the official render-server contract (@inertiajs/core 3.11.0
 * `dist/server.js`: `POST /render`, `200 { head, body }`, `500` classified
 * error JSON), timeouts, request aborts, and fallback to a client-rendered
 * document that still boots through upstream `getInitialPageFromDOM`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { Window } from 'happy-dom';
import { h } from 'preact';

import {
  defineInertia,
  httpSsr,
  inProcessSsr,
  InertiaError,
  resolveInertia,
  serializePage,
  type InertiaOutcome,
  type InertiaSsr,
  type InertiaSsrApp,
  type InertiaSsrOptions,
  type InertiaSsrPage,
  type InertiaSsrResult,
} from '../../src/index.js';
import { facts, inertiaHeaders } from './engine-fixture.js';

function code(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof InertiaError && error.code === expected;
}

function render(
  ssr: InertiaSsrOptions,
  options: {
    readonly headers?: Record<string, string>;
    readonly method?: string;
    readonly signal?: AbortSignal;
    readonly report?: (error: unknown, phase: string) => void;
    readonly spec?: { readonly ssr?: boolean };
  } = {},
): Promise<InertiaOutcome> {
  const config = defineInertia({
    version: 'v1',
    ssr,
    ...(options.report === undefined ? {} : { report: options.report }),
  });
  return resolveInertia(
    config,
    facts('/events/80', options.headers ?? {}, {
      method: options.method ?? 'GET',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),
    {
      component: 'Event',
      props: { title: 'Party', when: new Date(Date.UTC(2026, 0, 2)), guests: 12n },
      ...options.spec,
    },
  );
}

/** A gateway whose render is supplied per test, counting calls. */
function gateway(
  renderPage: (signal: AbortSignal) => Promise<InertiaSsrResult>,
): InertiaSsr & { calls: number } {
  const stub = {
    calls: 0,
    render(_page: unknown, init: { readonly signal: AbortSignal }): Promise<InertiaSsrResult> {
      stub.calls += 1;
      return renderPage(init.signal);
    },
  };
  return stub;
}

async function bootPage(html: string): Promise<unknown> {
  const window = new Window({ url: 'https://example.test/events/80' });
  try {
    window.document.write(html);
    const scope = globalThis as { window?: unknown; document?: unknown };
    scope.window = window;
    scope.document = window.document;
    try {
      const { getInitialPageFromDOM } = await import('@inertiajs/core');
      return getInitialPageFromDOM('app');
    } finally {
      delete scope.window;
      delete scope.document;
    }
  } finally {
    await window.happyDOM.close();
  }
}

describe('inProcessSsr', () => {
  it('renders the page the browser will parse, with preact-render-to-string', async () => {
    const seen: InertiaSsrPage[] = [];
    const app: InertiaSsrApp = (page, renderToString) => {
      seen.push(page);
      const props = page.props as { title: string };
      const html = renderToString(h('h1', null, props.title));
      return Promise.resolve({
        head: ['<title inertia>Party</title>'],
        body: `<script data-page="app" type="application/json">{}</script><div data-server-rendered="true" id="app">${html}</div>`,
      });
    };
    const outcome = await render({ gateway: inProcessSsr(app) });
    assert.ok(outcome.kind === 'document');
    assert.equal(outcome.ssr, true);
    assert.ok(outcome.body !== null);
    assert.ok(outcome.body.includes('<title inertia>Party</title></head>'));
    assert.ok(
      outcome.body.includes('<div data-server-rendered="true" id="app"><h1>Party</h1></div>'),
    );
    assert.equal(outcome.body.split('<script data-page=').length, 2);
    const [page] = seen;
    assert.ok(page !== undefined);
    assert.deepEqual(page.props, {
      errors: {},
      title: 'Party',
      when: '2026-01-02T00:00:00.000Z',
      guests: 12n,
    });
    assert.equal((page as { preserveBigIntegers?: boolean }).preserveBigIntegers, true);
  });

  it('accepts a render function typed with the upstream Page (compile-time)', () => {
    // @inertiajs/core 3.11.0 types/types.d.ts 225-257, transcribed: its index.d.ts
    // re-exports './types' without an extension, so `Page` does not resolve under
    // NodeNext. The fields that decide assignability are kept as upstream types them.
    interface UpstreamPage {
      component: string;
      props: Record<string, unknown> & { errors: Record<string, string> };
      url: string;
      version: string | null;
      rescuedProps: string[];
      flash: Record<string, unknown>;
      mergeProps?: string[];
      rememberedState: Record<string, unknown>;
    }
    interface ReactElement {
      readonly type: string;
    }
    // types/createInertiaApp.d.ts 39-40 (@inertiajs/react): RenderFunction.
    const upstream = (
      page: UpstreamPage,
      renderToString: (element: ReactElement) => string,
    ): Promise<{ head: string[]; body: string }> =>
      Promise.resolve({ head: [], body: renderToString({ type: page.component }) });
    assert.equal(typeof inProcessSsr(upstream).render, 'function');
  });

  it('rejects a non-element passed to renderToString', async () => {
    const app: InertiaSsrApp = (_page, renderToString) =>
      Promise.resolve({ head: [], body: renderToString('text') });
    await assert.rejects(
      render({ gateway: inProcessSsr(app), onError: 'throw' }),
      code('ssr_failed'),
    );
    assert.throws(() => inProcessSsr('app' as never), code('invalid_options'));
  });
});

describe('render policy', () => {
  it('throws ssr_failed with the cause under onError throw', async () => {
    const failure = new Error('window is not defined');
    await assert.rejects(
      render({ gateway: gateway(() => Promise.reject(failure)), onError: 'throw' }),
      (error) => code('ssr_failed')(error) && (error as InertiaError).cause === failure,
    );
  });

  it('falls back to a client-rendered document that boots, and reports', async () => {
    const reports: [unknown, string][] = [];
    const outcome = await render(
      { gateway: gateway(() => Promise.reject(new Error('boom'))), onError: 'fallback' },
      { report: (error, phase) => reports.push([error, phase]) },
    );
    assert.ok(outcome.kind === 'document');
    assert.equal(outcome.ssr, false);
    assert.equal(reports.length, 1);
    assert.ok(code('ssr_failed')(reports[0]?.[0]));
    assert.equal(reports[0]?.[1], 'ssr');
    const booted = await bootPage(outcome.body ?? '');
    const { parsePage } = await import('@inertiajs/core/json');
    assert.deepEqual(booted, parsePage(serializePage(outcome.page)));
  });

  it('times out a slow asynchronous render', async () => {
    let aborted = false;
    const slow = gateway(async (signal) => {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      await delay(500);
      return { head: [], body: '' };
    });
    await assert.rejects(
      render({ gateway: slow, timeoutMs: 20, onError: 'throw' }),
      code('ssr_timeout'),
    );
    assert.equal(aborted, true);
    const reports: unknown[] = [];
    const outcome = await render(
      { gateway: slow, timeoutMs: 20, onError: 'fallback' },
      { report: (error) => reports.push(error) },
    );
    assert.ok(outcome.kind === 'document' && !outcome.ssr);
    assert.ok(code('ssr_timeout')(reports[0]));
  });

  it('rethrows a request abort as its reason, without reporting', async () => {
    const controller = new AbortController();
    const reason = new Error('client went away');
    const reports: unknown[] = [];
    const pending = render(
      {
        gateway: gateway(async () => {
          controller.abort(reason);
          await delay(50);
          return { head: [], body: '' };
        }),
        onError: 'fallback',
      },
      { signal: controller.signal, report: (error) => reports.push(error) },
    );
    await assert.rejects(pending, (error) => error === reason);
    assert.deepEqual(reports, []);
  });

  it('rejects a malformed render result', async () => {
    for (const result of [null, { head: 'x', body: '' }, { head: [1], body: '' }, { head: [] }]) {
      await assert.rejects(
        render({ gateway: gateway(() => Promise.resolve(result as never)), onError: 'throw' }),
        code('ssr_failed'),
      );
    }
  });

  it('skips SSR for Inertia visits, HEAD, ssr: false, and excluded URLs', async () => {
    const stub = gateway(() => Promise.resolve({ head: [], body: '<div id="app"></div>' }));
    const page = await render({ gateway: stub }, { headers: inertiaHeaders() });
    assert.equal(page.kind, 'page');
    await render({ gateway: stub }, { method: 'HEAD' });
    const optedOut = await render({ gateway: stub }, { spec: { ssr: false } });
    assert.ok(optedOut.kind === 'document' && !optedOut.ssr);
    await render({ gateway: stub, exclude: (url) => url.pathname.startsWith('/events') });
    assert.equal(stub.calls, 0);
    await render({ gateway: stub });
    assert.equal(stub.calls, 1);
  });

  it('validates SSR options at configuration time', () => {
    const stub = gateway(() => Promise.resolve({ head: [], body: '' }));
    for (const ssr of [
      { gateway: stub, timeoutMs: 0 },
      { gateway: stub, timeoutMs: 60_001 },
      { gateway: stub, onError: 'ignore' },
      { gateway: stub, exclude: true },
      { gateway: null },
    ]) {
      assert.throws(
        () => defineInertia({ version: 'v1', ssr: ssr as never }),
        code('invalid_options'),
      );
    }
  });

  it('throws under NODE_ENV=test by default', async () => {
    await assert.rejects(
      render({ gateway: gateway(() => Promise.reject(new Error('x'))) }),
      code('ssr_failed'),
    );
  });
});

describe('httpSsr', () => {
  it('posts the serialized page to <url>/render and reads { head, body }', async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const fetchStub: typeof fetch = (input, init) => {
      requests.push({ url: String(input), init });
      return Promise.resolve(
        Response.json({ head: ['<title>x</title>'], body: '<div id="app">ssr</div>' }),
      );
    };
    const outcome = await render({
      gateway: httpSsr({ url: 'http://127.0.0.1:13714/', fetch: fetchStub }),
    });
    assert.ok(outcome.kind === 'document' && outcome.ssr);
    assert.ok(outcome.body?.includes('<div id="app">ssr</div>'));
    const [sent] = requests;
    assert.equal(sent?.url, 'http://127.0.0.1:13714/render');
    assert.equal(sent.init?.method, 'POST');
    assert.deepEqual(new Headers(sent.init?.headers).get('content-type'), 'application/json');
    assert.equal(sent.init?.body, serializePage(outcome.page));
  });

  it('turns the official 500 error JSON into ssr_failed with status and type', async () => {
    const fetchStub: typeof fetch = () =>
      Promise.resolve(
        Response.json(
          { error: 'window is not defined', type: 'browser-api', component: 'Event', hint: '...' },
          { status: 500 },
        ),
      );
    await assert.rejects(
      render({
        gateway: httpSsr({ url: 'http://ssr.internal', fetch: fetchStub }),
        onError: 'throw',
      }),
      (error) =>
        code('ssr_failed')(error) &&
        JSON.stringify((error as InertiaError).cause) === '{"status":500,"type":"browser-api"}',
    );
  });

  it('applies its own timeout and passes the abort signal to fetch', async () => {
    const fetchStub: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    await assert.rejects(
      render({
        gateway: httpSsr({ url: 'http://ssr.internal', timeoutMs: 10, fetch: fetchStub }),
        timeoutMs: 5000,
        onError: 'throw',
      }),
      code('ssr_timeout'),
    );
  });

  it('validates its options', () => {
    for (const options of [
      { url: 'ftp://ssr' },
      { url: 'not a url' },
      { url: 'http://ssr/?q=1' },
      { url: 'http://ssr', timeoutMs: -1 },
      { url: 3 },
    ]) {
      assert.throws(() => httpSsr(options as never), code('invalid_options'));
    }
  });
});
