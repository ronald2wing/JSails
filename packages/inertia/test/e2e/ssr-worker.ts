/**
 * The SSR side of the end-to-end suite, in a worker thread with no DOM
 * globals.
 *
 * @inertiajs/react picks server mode by `typeof window === 'undefined'`, so it
 * cannot render on the server in the thread where happy-dom has installed
 * `window`. This worker aliases React to `preact/compat` for every import,
 * builds the demo pages, takes the server render function `createInertiaApp`
 * returns in server mode, and serves it through the package's
 * `inProcessSsr` gateway: the main thread posts `{ id, page }`, the worker
 * answers `{ id, result }` or `{ id, error }`. Once every module is loaded it
 * posts `{ ready: true }`, so the suite's SSR time limit covers rendering
 * only, not the worker's cold start.
 */

import { parentPort } from 'node:worker_threads';

import {
  inProcessSsr,
  type InertiaPageObject,
  type InertiaSsrApp,
  type InertiaSsrResult,
} from '../../src/index.js';
import { createDemoClient } from './demo-app.js';
import { loadAliasedClient, registerCompatAliases } from './module-graph.js';

function isSsrResult(value: unknown): value is InertiaSsrResult {
  if (typeof value !== 'object' || value === null) return false;
  const head: unknown = Reflect.get(value, 'head');
  const body: unknown = Reflect.get(value, 'body');
  return (
    Array.isArray(head) &&
    head.every((entry: unknown) => typeof entry === 'string') &&
    typeof body === 'string'
  );
}

/** The structured clone of a page the engine built in the main thread. */
function isPage(value: unknown): value is InertiaPageObject {
  if (typeof value !== 'object' || value === null) return false;
  const props: unknown = Reflect.get(value, 'props');
  return (
    typeof Reflect.get(value, 'component') === 'string' &&
    typeof Reflect.get(value, 'url') === 'string' &&
    typeof Reflect.get(value, 'version') === 'string' &&
    typeof props === 'object' &&
    props !== null &&
    typeof Reflect.get(props, 'errors') === 'object'
  );
}

registerCompatAliases();
const client = await loadAliasedClient();
const { pages, layoutFor } = createDemoClient(client);
const serverRender: unknown = await client.inertia.createInertiaApp({
  resolve: (name: string) => pages[name],
  layout: layoutFor,
});
if (typeof serverRender !== 'function') throw new Error('createInertiaApp is not in server mode');

const app: InertiaSsrApp = async (page, renderToString) => {
  const result: unknown = await Reflect.apply(serverRender, undefined, [page, renderToString]);
  if (!isSsrResult(result)) throw new Error('the server render returned no { head, body }');
  return result;
};
const gateway = inProcessSsr(app);

parentPort?.on('message', (message: unknown) => {
  const id: unknown = Reflect.get(Object(message), 'id');
  const page: unknown = Reflect.get(Object(message), 'page');
  void (async () => {
    try {
      if (!isPage(page)) throw new Error('the message carries no page object');
      const result = await gateway.render(page, { signal: new AbortController().signal });
      parentPort?.postMessage({ id, result });
    } catch (error) {
      parentPort?.postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
});
parentPort?.postMessage({ ready: true });
