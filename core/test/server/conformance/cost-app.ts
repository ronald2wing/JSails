/**
 * The conformance app for request-cost budgets, assembled the way
 * `Application` serves a site: `createApp` with services, a request scope, a
 * session resolver, an error page and the structured renderer, then the
 * public-files middleware behind the routes. Every app-side callback counts
 * its calls in `scope-probe.ts`; the cache store counts its round trips.
 *
 * Like the scope app, the fixture tree sits under a directory named
 * `app#2 %41`.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Hono } from 'hono';

import { createPublicFilesMiddleware } from '../../../src/app/public-files.js';
import type { CacheStore } from '../../../src/cache/store.js';
import { cacheToken } from '../../../src/cache/tokens.js';
import { runExtensions } from '../../../src/extensions/index.js';
import { preactPageRenderer } from '../../../src/pages/page.js';
import { discoverRoutes } from '../../../src/routing/routes.js';
import { createApp } from '../../../src/server/app.js';
import type { AppEnv } from '../../../src/server/env.js';
import { createTestSession } from '../../../src/testing/index.js';
import { writeFixture } from '../../fixtures/app.js';
import { counters } from './scope-probe.js';

const distDir = fileURLToPath(new URL('../../../', import.meta.url));
const probeUrl = new URL('./scope-probe.js', import.meta.url).href;
const respondUrl = new URL('../../../src/api/responses.js', import.meta.url).href;

/** A Map-backed cache store that counts every call as one round trip. */
export interface CountingStore extends CacheStore {
  readonly calls: string[];
}

function createCountingStore(): CountingStore {
  const entries = new Map<string, { value: string; expires: number }>();
  const calls: string[] = [];
  const read = (key: string): string | null => {
    const entry = entries.get(key);
    if (entry === undefined || entry.expires <= Date.now()) return null;
    return entry.value;
  };
  return {
    calls,
    get(key) {
      calls.push('get');
      return Promise.resolve(read(key));
    },
    set(key, value, ttlMs) {
      calls.push('set');
      entries.set(key, { value, expires: Date.now() + ttlMs });
      return Promise.resolve();
    },
    delete(key) {
      calls.push('delete');
      entries.delete(key);
      return Promise.resolve();
    },
    async remember(key, ttlMs, loader) {
      calls.push('remember');
      const hit = read(key);
      if (hit !== null) return hit;
      const value = await loader();
      entries.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    },
    increment(key, ttlMs) {
      calls.push('increment');
      const next = Number(read(key) ?? '0') + 1;
      const entry = entries.get(key);
      entries.set(key, {
        value: String(next),
        expires: entry !== undefined && next > 1 ? entry.expires : Date.now() + ttlMs,
      });
      return Promise.resolve(next);
    },
    close: () => Promise.resolve(),
  };
}

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
}

/** Build the request-cost conformance app. */
export async function createCostApp(options: CostAppOptions = {}): Promise<CostApp> {
  const base = mkdtempSync(join(distDir, 'conformance-cost-'));
  const root = join(base, 'app#2 %41');
  mkdirSync(root, { recursive: true });
  writeRoutes(root, options.extraPages ?? 0);
  const store = createCountingStore();
  const session = createTestSession({ id: 's1' });
  const runtime = await runExtensions([
    {
      name: 'conformance-cache',
      setup: ({ services }) => services.provide(cacheToken, store),
    },
    {
      name: 'conformance-scope',
      setup: ({ configureRequestScope }) =>
        configureRequestScope(async (_c, next) => {
          counters.scopes += 1;
          await next();
        }),
    },
  ]);
  const app = await createApp({
    manifest: discoverRoutes(root),
    services: runtime.services,
    httpHooks: runtime.httpHooks,
    requestScopes: runtime.requestScopes,
    renderer: preactPageRenderer,
    authorize: () => true,
    resolveSession: (request) => {
      counters.sessions += 1;
      return /(?:^|;\s*)sid=s1(?:;|$)/.test(request.headers.get('cookie') ?? '') ? session : null;
    },
    errorPage: (error) => {
      counters.errorPages += 1;
      return `<p>${error.status}</p>`;
    },
    // A failing page is a measured case, not a suite failure.
    onError: () => undefined,
  });
  const publicFiles = await createPublicFilesMiddleware(join(root, 'public'));
  if (publicFiles !== undefined) app.use('*', publicFiles);
  return { app, store, root, close: () => rmSync(base, { recursive: true, force: true }) };
}
