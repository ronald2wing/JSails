/**
 * Request-cost budgets: what a request may cost, counted, never timed.
 *
 * Each case sends one request to the cost app (`cost-app.ts`) through both
 * drivers and counts the work with the bench collectors
 * (`scripts/bench/collectors/`) and the app-side counters in
 * `scope-probe.ts`: fs operations, zlib engines, store round trips, `Response`
 * and `ReadableStream` constructions after the handler, AsyncLocalStorage
 * runs, module loads, hashes, session resolutions, scope calls, `load` calls
 * and renders. A guard's refusal is measured in front of a public file and a
 * cached page: it answers before either is read. Counts are exact, so a budget fails on one extra operation and
 * never on a slow runner.
 *
 * Through `app.fetch`, constructions are counted up to the response head (the
 * client's own reading of the body is not the server's cost); everything else
 * is counted until the body has been read. Through the listener, everything
 * is counted until the adapter has written the response.
 */

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { TEST_ORIGIN } from '../../fixtures/app.js';
import { collectorsModule, type Counts } from './bench-tools.js';
import type { CostApp } from './cost-app.js';
import type { DrivenResponse, Driver } from './drivers.js';
import type { ProbeCounters } from './scope-probe.js';

/** Opening a file by path: the one path operation an asset may cost. */
const OPENS = new Set(['fs.open', 'fs.openSync', 'fs/promises.open', 'fs.openAsBlob']);

/**
 * fs functions that are not path operations of their own. Descriptor
 * operations act on an open file; a stream factory opens its file through
 * `fs.open`, which is counted as that open.
 */
const NOT_PATH_OPERATIONS = new Set([
  ...[
    'read',
    'readv',
    'close',
    'fstat',
    'write',
    'writev',
    'fsync',
    'fdatasync',
    'ftruncate',
    'futimes',
    'fchmod',
    'fchown',
  ].flatMap((name) => [`fs.${name}`, `fs.${name}Sync`]),
  'fs.createReadStream',
  'fs.createWriteStream',
]);

function pathOperations(counts: Counts): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts.fsCalls).filter(([name]) => !NOT_PATH_OPERATIONS.has(name)),
  );
}

function total(calls: Readonly<Record<string, number>>): number {
  return Object.values(calls).reduce((sum, count) => sum + count, 0);
}

/** What one measured request cost. */
interface Measured {
  readonly response: DrivenResponse;
  /** Until the head (app.fetch) or the end (listener). */
  readonly head: Counts;
  /** Until the body was read. */
  readonly full: Counts;
  /** From the handler's return to `head`, when the handler marked it. */
  readonly afterHandler: Counts | undefined;
  readonly app: ProbeCounters;
  readonly storeCalls: readonly string[];
}

// The collectors go in before the framework is imported, so a dependency that
// copies an fs function out of its module at load time is still counted; the
// modules that reach the framework are therefore imported dynamically, and
// the URLs loaded meanwhile are kept to prove they loaded after installation.
const collectors = collectorsModule.installCollectors();
const loadedAfterInstall = new Set<string>();
const loadWatch = registerHooks({
  load(url, context, nextLoad) {
    loadedAfterInstall.add(url);
    return nextLoad(url, context);
  },
});
const { counters, onHandlerReturn, resetCounters } = await import('./scope-probe.js');
const { createCostApp } = await import('./cost-app.js');
const { createDrivers } = await import('./drivers.js');
loadWatch.deregister();
const costApp = await createCostApp();
// Creating the listener installs the adapter's own global Response, as
// starting a server does; it is wrapped too.
const drivers = createDrivers(costApp.app);
collectors.adoptGlobals();
after(() => {
  collectors.uninstall();
  costApp.close();
});
onHandlerReturn(() => collectors.mark('handler'));

async function measure(target: CostApp, driver: Driver, request: Request): Promise<Measured> {
  // Let the previous request's trailing work (a file stream's close) finish
  // outside this measurement.
  await new Promise((resolve) => setTimeout(resolve, 5));
  resetCounters();
  target.store.calls.length = 0;
  collectors.reset();
  let head: Counts | undefined;
  let afterHandler: Counts | undefined;
  const takeHead = (): void => {
    head = collectors.read();
    if (collectors.marked('handler')) afterHandler = collectors.since('handler');
  };
  const response = await driver.send(request, { onHead: takeHead });
  if (head === undefined) takeHead();
  const full = collectors.read();
  return {
    response,
    head: head ?? full,
    full,
    afterHandler,
    app: { ...counters, evaluations: { ...counters.evaluations } },
    storeCalls: [...target.store.calls],
  };
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${TEST_ORIGIN}${path}`, { headers });
}

function fsDetail(counts: Counts): string {
  return JSON.stringify(counts.fsCalls);
}

describe('request cost', () => {
  it('measures a framework and an adapter imported after the collectors', () => {
    const loaded = [...loadedAfterInstall];
    const appModule = new URL('../../../src/server/app.js', import.meta.url).href;
    assert.ok(loaded.includes(appModule), 'the framework was loaded before the collectors');
    assert.ok(
      loaded.some((url) => url.includes('/@hono/node-server/')),
      'the Node adapter was loaded before the collectors',
    );
  });

  for (const driver of drivers) {
    describe(driver.name, () => {
      describe('anonymous API GET', () => {
        let cost: Measured;
        before(async () => {
          cost = await measure(costApp, driver, get('/api/probe', { accept: 'application/json' }));
          assert.equal(cost.response.status, 200);
        });
        it('performs no fs operation', () => {
          assert.equal(cost.full.fs, 0, `fs operations: ${fsDetail(cost.full)}`);
        });
        it('makes no store round trip', () => {
          assert.deepEqual(cost.storeCalls, [], `store calls: ${cost.storeCalls.join(', ')}`);
        });
        it('builds at most one Response after the handler', () => {
          assert.ok(cost.afterHandler !== undefined, 'the handler never returned');
          assert.ok(
            cost.afterHandler.responses <= 1,
            `${cost.afterHandler.responses} Responses built after the handler`,
          );
        });
        it('builds no ReadableStream for a bytes body', () => {
          const streams = cost.head.readableStreams + cost.head.bodyStreams;
          assert.equal(streams, 0, `${streams} ReadableStreams for a bytes body`);
        });
        it('runs one AsyncLocalStorage scope', () => {
          assert.equal(cost.full.alsRuns, 1, `${cost.full.alsRuns} AsyncLocalStorage runs`);
        });
        it('resolves no session for a request without a credential', () => {
          assert.equal(cost.app.sessions, 0, `${cost.app.sessions} session resolutions`);
        });
        if (driver.name === 'listener') {
          it('writes the body in one end() call', () => {
            assert.equal(cost.response.writes, 0, `${cost.response.writes} write() calls`);
            assert.equal(cost.response.endedWithBody, true, 'the body did not go out in end()');
          });
        }
      });

      describe('JSON 404', () => {
        let cost: Measured;
        before(async () => {
          cost = await measure(
            costApp,
            driver,
            get('/api/missing', { accept: 'application/json', cookie: 'sid=s1' }),
          );
          assert.equal(cost.response.status, 404);
        });
        it('resolves no session', () => {
          assert.equal(cost.app.sessions, 0, `${cost.app.sessions} session resolutions`);
        });
        it('calls no request scope', () => {
          assert.equal(cost.app.scopes, 0, `${cost.app.scopes} scope calls`);
        });
      });

      // A path of its own per driver: an anonymous not-found page is kept for
      // a minute, so the second driver would otherwise be served the first's.
      const missing = `/missing-${driver.name}`;
      describe('HTML 404 without a credential', () => {
        let cost: Measured;
        before(async () => {
          cost = await measure(costApp, driver, get(missing, { accept: 'text/html' }));
          assert.equal(cost.response.status, 404);
        });
        it('resolves no session', () => {
          assert.equal(cost.app.sessions, 0, `${cost.app.sessions} session resolutions`);
        });
        it('renders the error page once', () => {
          assert.equal(cost.app.errorPages, 1, `${cost.app.errorPages} error-page renders`);
        });
      });

      describe('repeated HTML 404 without a credential', () => {
        let cost: Measured;
        before(async () => {
          cost = await measure(costApp, driver, get(missing, { accept: 'text/html' }));
          assert.equal(cost.response.status, 404);
        });
        it('serves the kept page without rendering it again', () => {
          assert.equal(cost.app.errorPages, 0, `${cost.app.errorPages} error-page renders`);
        });
      });

      describe('small response under Accept-Encoding: br', () => {
        let cost: Measured;
        before(async () => {
          cost = await measure(
            costApp,
            driver,
            get('/api/probe', { accept: 'application/json', 'accept-encoding': 'br, gzip' }),
          );
          assert.equal(cost.response.status, 200);
        });
        it('creates no zlib engine', () => {
          assert.equal(cost.full.zlib, 0, `${cost.full.zlib} zlib engines`);
        });
      });

      describe('cached page hit', () => {
        let cost: Measured;
        before(async () => {
          const request = (): Request =>
            get('/cached', { accept: 'text/html', 'accept-encoding': 'br, gzip' });
          const fill = await measure(costApp, driver, request());
          assert.equal(fill.response.status, 200);
          cost = await measure(costApp, driver, request());
          assert.equal(cost.response.status, 200);
        });
        it('makes exactly one store round trip', () => {
          assert.equal(
            cost.storeCalls.length,
            1,
            `${cost.storeCalls.length} store round trips: ${cost.storeCalls.join(', ')}`,
          );
        });
        it('runs no load', () => {
          assert.equal(cost.app.loads, 0, `${cost.app.loads} load calls`);
        });
        it('renders nothing', () => {
          assert.equal(cost.app.renders, 0, `${cost.app.renders} renders`);
        });
        it('computes no hash', () => {
          assert.equal(cost.full.hashes, 0, `${cost.full.hashes} hashes`);
        });
        it('creates no zlib engine', () => {
          assert.equal(cost.full.zlib, 0, `${cost.full.zlib} zlib engines`);
        });
      });

      describe('asset 200', () => {
        let cost: Measured;
        before(async () => {
          cost = await measure(costApp, driver, get('/app.css'));
          assert.equal(cost.response.status, 200);
        });
        // A small asset may be served from bytes held in memory (no open) or
        // from the file it resolved at startup (one open).
        it('resolves the file with at most one open and no other path operation', () => {
          const operations = pathOperations(cost.full);
          const opens = total(
            Object.fromEntries(Object.entries(operations).filter(([name]) => OPENS.has(name))),
          );
          assert.ok(
            opens <= 1 && total(operations) === opens,
            `path operations: ${JSON.stringify(operations)}`,
          );
        });
      });

      describe('asset 200 streamed from disk', () => {
        let cost: Measured;
        before(async () => {
          cost = await measure(costApp, driver, get('/big.txt'));
          assert.equal(cost.response.status, 200);
        });
        it('opens the file once and performs no other path operation', () => {
          const operations = pathOperations(cost.full);
          const opens = total(
            Object.fromEntries(Object.entries(operations).filter(([name]) => OPENS.has(name))),
          );
          assert.ok(
            opens === 1 && total(operations) === 1,
            `path operations: ${JSON.stringify(operations)}`,
          );
        });
        it('computes no hash', () => {
          assert.equal(cost.full.hashes, 0, `${cost.full.hashes} hashes`);
        });
      });

      describe('asset 304', () => {
        let cost: Measured;
        before(async () => {
          const first = await measure(costApp, driver, get('/app.css'));
          const etag = first.response.headers.get('etag');
          assert.ok(etag !== null, 'the asset has no ETag');
          cost = await measure(costApp, driver, get('/app.css', { 'if-none-match': etag }));
          assert.equal(cost.response.status, 304);
        });
        it('performs no fs operation', () => {
          assert.equal(cost.full.fs, 0, `fs operations: ${fsDetail(cost.full)}`);
        });
      });

      describe('asset miss', () => {
        let cost: Measured;
        before(async () => {
          cost = await measure(costApp, driver, get('/missing.css'));
          assert.equal(cost.response.status, 404);
        });
        it('performs no fs operation', () => {
          assert.equal(cost.full.fs, 0, `fs operations: ${fsDetail(cost.full)}`);
        });
      });

      describe('guard 401 in front of a public file', () => {
        let cost: Measured;
        before(async () => {
          cost = await measure(costApp, driver, get('/app.css', { 'x-wall': 'deny' }));
        });
        it('answers the guard', () => {
          assert.equal(cost.response.status, 401);
        });
        it('performs no fs operation', () => {
          assert.equal(cost.full.fs, 0, `fs operations: ${fsDetail(cost.full)}`);
        });
      });

      describe('guard 401 in front of a cached page', () => {
        let cost: Measured;
        before(async () => {
          const request = (headers: Record<string, string> = {}): Request =>
            get('/cached', { accept: 'text/html', ...headers });
          const fill = await measure(costApp, driver, request());
          assert.equal(fill.response.status, 200);
          cost = await measure(costApp, driver, request({ cookie: 'sid=s1', 'x-wall': 'deny' }));
        });
        it('answers the guard', () => {
          assert.equal(cost.response.status, 401);
        });
        it('makes no store round trip', () => {
          assert.deepEqual(cost.storeCalls, [], `store calls: ${cost.storeCalls.join(', ')}`);
        });
        it('resolves no session and calls no request scope', () => {
          assert.equal(cost.app.sessions, 0, `${cost.app.sessions} session resolutions`);
          assert.equal(cost.app.scopes, 0, `${cost.app.scopes} scope calls`);
        });
        it('runs no load and renders nothing', () => {
          assert.equal(cost.app.loads, 0, `${cost.app.loads} load calls`);
          assert.equal(cost.app.renders, 0, `${cost.app.renders} renders`);
        });
      });

      describe('failed page', () => {
        let cost: Measured;
        before(async () => {
          cost = await measure(costApp, driver, get('/fail', { accept: 'text/html' }));
          assert.equal(cost.response.status, 500);
        });
        it('renders the error page once', () => {
          assert.equal(cost.app.errorPages, 1, `${cost.app.errorPages} error-page renders`);
        });
      });

      for (const extraPages of [5, 200]) {
        describe(`first request to a ${extraPages}-route app`, () => {
          let cost: Measured;
          let fresh: CostApp;
          before(async () => {
            fresh = await createCostApp({ extraPages });
            const [freshDriver] = createDrivers(fresh.app).filter(
              (candidate) => candidate.name === driver.name,
            );
            assert.ok(freshDriver !== undefined);
            cost = await measure(fresh, freshDriver, get('/probe', { accept: 'text/html' }));
            assert.equal(cost.response.status, 200);
          });
          after(() => fresh.close());
          it('loads no module', () => {
            assert.equal(cost.full.modules, 0, `${cost.full.modules} modules loaded`);
          });
          it('performs no fs operation', () => {
            assert.equal(cost.full.fs, 0, `fs operations: ${fsDetail(cost.full)}`);
          });
        });
      }
    });
  }

  describe('route modules', () => {
    it('evaluates each route module once, under a path that needs URL escaping', async () => {
      const [driver] = drivers;
      assert.ok(driver !== undefined);
      await driver.send(get('/probe', { accept: 'text/html' }));
      await driver.send(get('/api/probe'));
      // Keyed by the URL each evaluation ran under: a loader that spells the
      // `#`, space or `%41` differently from the renderer evaluates the
      // module a second time, under a second URL.
      const evaluations = (file: string): Record<string, number> => {
        const href = pathToFileURL(join(costApp.root, file)).href;
        const decoded = decodeURIComponent(href);
        return Object.fromEntries(
          Object.entries(counters.evaluations).filter(
            ([url]) => url === href || decodeURIComponent(url) === decoded,
          ),
        );
      };
      for (const file of ['pages/probe/index.mjs', 'api/probe.mjs']) {
        const seen = evaluations(file);
        assert.deepEqual(
          Object.values(seen),
          [1],
          `${file} evaluations by URL: ${JSON.stringify(seen)}`,
        );
      }
    });
  });
});
