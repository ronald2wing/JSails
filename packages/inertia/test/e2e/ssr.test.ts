/**
 * Server-side rendering, then hydration, with the real client.
 *
 * The engine renders the first visit through an SSR gateway that forwards
 * the page to a DOM-free worker running `createInertiaApp` in server mode on
 * `preact/compat` behind the package's `inProcessSsr`. The browser loads that
 * document and the client hydrates it. Hydration is proven by node identity,
 * not by an absence of warnings (`preact/compat`'s `hydrateRoot` emits none):
 * every server-rendered node is the same object after hydration, the markup
 * is unchanged, and the hydrated tree is live (a click updates it in place).
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';

import type { Node as DomNode } from 'happy-dom';

import type { InertiaSsr, InertiaSsrResult } from '../../src/index.js';
import { openSession } from './session.js';

interface Pending {
  readonly resolve: (result: InertiaSsrResult) => void;
  readonly reject: (error: Error) => void;
}

/** An SSR gateway that renders in the worker. */
function workerGateway(worker: Worker): InertiaSsr {
  let nextId = 0;
  const pending = new Map<number, Pending>();
  worker.on('message', (message: unknown) => {
    const id: unknown = Reflect.get(Object(message), 'id');
    const waiting = typeof id === 'number' ? pending.get(id) : undefined;
    if (waiting === undefined || typeof id !== 'number') return;
    pending.delete(id);
    const error: unknown = Reflect.get(Object(message), 'error');
    const result: unknown = Reflect.get(Object(message), 'result');
    const head: unknown = Reflect.get(Object(result), 'head');
    const body: unknown = Reflect.get(Object(result), 'body');
    if (typeof error === 'string') waiting.reject(new Error(error));
    else if (Array.isArray(head) && typeof body === 'string') {
      waiting.resolve({ head: head.map(String), body });
    } else waiting.reject(new Error('the worker answered without a render result'));
  });
  return {
    render(page) {
      nextId += 1;
      const id = nextId;
      return new Promise<InertiaSsrResult>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, page });
      });
    },
  };
}

function descendants(node: DomNode): DomNode[] {
  const nodes: DomNode[] = [];
  for (const child of Array.from(node.childNodes)) nodes.push(child, ...descendants(child));
  return nodes;
}

/** Open `path` with SSR, boot the client, and prove hydration by node identity. */
async function hydrateInPlace(worker: Worker, path: string, title: string | null): Promise<void> {
  const session = await openSession('preact', { ssr: workerGateway(worker) });
  try {
    const { window } = session.browser;
    await session.browser.open(path);
    const root = window.document.getElementById('app');
    assert.ok(root !== null);
    assert.equal(root.getAttribute('data-server-rendered'), 'true');
    assert.equal(session.text('#increment'), 'Count 5');
    if (title !== null) assert.equal(window.document.title, title);
    const markup = root.innerHTML;
    const nodes = descendants(root);
    assert.ok(nodes.length > 3);

    await session.start();
    await session.settle();
    assert.equal(root.innerHTML, markup);
    const hydrated = descendants(root);
    assert.equal(hydrated.length, nodes.length);
    hydrated.forEach((node, index) =>
      assert.equal(node, nodes[index], `node ${index} was replaced`),
    );

    const button = window.document.getElementById('increment');
    session.click('#increment');
    await session.until('the hydrated counter', () => session.text('#increment') === 'Count 6');
    assert.equal(window.document.getElementById('increment'), button);
    assert.deepEqual(
      session.requests().map(({ method, url, status }) => [method, url, status]),
      [['GET', path, 200]],
    );
  } finally {
    await session.close();
  }
}

describe('SSR then hydrate', () => {
  let worker: Worker;

  before(async () => {
    worker = new Worker(new URL('./ssr-worker.js', import.meta.url));
    // The worker loads the aliased client and the demo pages before it can
    // render. Waiting for its ready message keeps that cold start, which can
    // take seconds on a loaded machine, out of the gateway's time limit.
    await new Promise<void>((resolve, reject) => {
      const onMessage = (message: unknown): void => {
        if (Reflect.get(Object(message), 'ready') !== true) return;
        worker.off('message', onMessage);
        worker.off('error', reject);
        resolve();
      };
      worker.on('message', onMessage);
      worker.once('error', reject);
    });
  });

  after(async () => {
    await worker.terminate();
  });

  it('hydrates a server-rendered page in place and keeps it live', async () => {
    await hydrateInPlace(worker, '/counter', null);
  });

  it('renders <Head> and a usePage() layout on the server, then hydrates them', async () => {
    await hydrateInPlace(worker, '/counter/titled', 'Counter from 5');
  });
});
