/**
 * The conformance app for request-cost budgets, assembled the way
 * `Application` serves a site: `createApp` with services, a request scope, a
 * session resolver, a guard, an error page, the structured renderer and the
 * asset index of its `public/` (the `asset:public` surface: a small file
 * served from memory, a 100 KiB one streamed from disk). The guard refuses (401) a
 * request that carries `x-wall: deny` and lets every other through. Every app-side callback counts
 * its calls in `scope-probe.ts`; the cache store counts its round trips.
 *
 * Like the scope app, the fixture tree sits under a directory named
 * `app#2 %41`.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Hono } from 'hono';

import { createAssetIndex } from '../../../src/assets/asset-index.js';
import { cacheToken } from '../../../src/cache/tokens.js';
import { cacheServiceOf, MapCacheStore } from '../../cache/map-cache-store.js';
import { runExtensions } from '../../../src/extensions/index.js';
import { preactPageRenderer } from '../../../src/pages/page.js';
import { discoverRoutes } from '../../../src/routing/routes.js';
import { createApp } from '../../../src/server/app.js';
import { identitySource } from '../../../src/server/request-frame.js';
import type { AppEnv } from '../../../src/server/env.js';
import { createTestSession } from '../../../src/testing/index.js';
import { writeFixture } from '../../fixtures/app.js';
import { counters } from './scope-probe.js';

const distDir = fileURLToPath(new URL('../../../', import.meta.url));
const probeUrl = new URL('./scope-probe.js', import.meta.url).href;
const respondUrl = new URL('../../../src/api/responses.js', import.meta.url).href;

/** A Map-backed cache store that counts every call as one round trip. */
export type CountingStore = MapCacheStore;

/** Options of {@link createCostApp}. */
export interface CostAppOptions {
  /** Extra page routes, each a trivial page, to measure assembly at scale. */
  readonly extraPages?: number;
}

/** The cost app, its store, and the fixture directory. */
export interface CostApp {
  readonly app: Hono<AppEnv>;
  readonly store: CountingStore;
  /** The fixture app root (under `app#2 %41`). */
  readonly root: string;
  close(): void;
}

function writeRoutes(root: string, extraPages: number): void {
  const probe = `import { counters, evaluated, handlerReturned } from ${JSON.stringify(probeUrl)};\n`;
  writeFixture(
    root,
    'api/probe.mjs',
    `${probe}import { Respond } from ${JSON.stringify(respondUrl)};
evaluated(import.meta.url);
export const authorize = () => true;
export const GET = () => {
  const response = Respond.json({ ok: true });
  handlerReturned();
  return response;
};
`,
  );
  writeFixture(
    root,
    'pages/probe/index.mjs',
    `${probe}evaluated(import.meta.url);
export default () => {
  counters.renders += 1;
  return 'probe';
};
`,
  );
  writeFixture(
    root,
    'pages/cached/index.mjs',
    `${probe}export const cache = 'public';
export const revalidate = 60;
export const load = () => {
  counters.loads += 1;
  return { items: Array.from({ length: 400 }, (_, id) => 'cached item number ' + id) };
};
export default ({ items }) => {
  counters.renders += 1;
  return items.join(', ');
};
`,
  );
  writeFixture(
    root,
    'pages/fail/index.mjs',
    `export const load = () => {
  throw new Error('page failed');
};
export default () => 'never';
`,
  );
  for (let index = 0; index < extraPages; index += 1) {
    writeFixture(
      root,
      `pages/extra-${index}/index.mjs`,
      `export default () => 'extra ${index}';\n`,
    );
  }
  writeFixture(root, 'public/app.css', 'body { color: #222; }\n');
  writeFixture(root, 'public/big.txt', 'x'.repeat(100 * 1024));
}

/** Build the request-cost conformance app. */
export async function createCostApp(options: CostAppOptions = {}): Promise<CostApp> {
  const base = mkdtempSync(join(distDir, 'conformance-cost-'));
  const root = join(base, 'app#2 %41');
  mkdirSync(root, { recursive: true });
  writeRoutes(root, options.extraPages ?? 0);
  const store = new MapCacheStore();
  const session = createTestSession({ id: 's1' });
  const runtime = await runExtensions(
    [
      {
        name: 'conformance-cache',
        setup: ({ services }) => services.provide(cacheToken, cacheServiceOf(store)),
      },
      {
        name: 'conformance-scope',
        setup: ({ configureRequestScope }) =>
          configureRequestScope({
            name: 'conformance-scope',
            cache: 'transparent',
            resolve: () => {
              counters.scopes += 1;
              return undefined;
            },
          }),
      },
    ],
    { rootDir: import.meta.dirname },
  );
  const assets = await createAssetIndex({ roots: [{ dir: join(root, 'public') }] });
  const app = await createApp({
    manifest: discoverRoutes(root),
    assets,
    services: runtime.services,
    requestScopes: runtime.requestScopes,
    guards: [
      (request) =>
        request.headers.get('x-wall') === 'deny' ? new Response(null, { status: 401 }) : undefined,
    ],
    renderer: preactPageRenderer,
    // The session cookie is declared, so a request without it never resolves.
    identity: identitySource({
      cookies: ['sid'],
      resolve: (request) => {
        counters.sessions += 1;
        return /(?:^|;\s*)sid=s1(?:;|$)/.test(request.headers.get('cookie') ?? '') ? session : null;
      },
    }),
    errorPage: (error) => {
      counters.errorPages += 1;
      return `<p>${error.status}</p>`;
    },
    // A failing page is a measured case, not a suite failure.
    onError: () => undefined,
  });
  return { app, store, root, close: () => rmSync(base, { recursive: true, force: true }) };
}
