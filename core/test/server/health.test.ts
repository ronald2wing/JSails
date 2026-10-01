/**
 * Health route: bare `/up` is liveness; `/up?deep=1` (and `readiness.path`)
 * runs system checks plus async readiness probes, shows per-check results only
 * to an authorized caller, and both flip to 503 once the app is draining.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createApp } from '../../src/server/app.js';
import { markDraining } from '../../src/server/readiness.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import { createSystemCheckRegistry } from '../../src/database/system-checks.js';

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'health-'));
mkdirSync(join(tmpRoot, 'pages'), { recursive: true });
writeFileSync(join(tmpRoot, 'pages', 'index.js'), 'export default () => null;\n');
const manifest = discoverRoutes(tmpRoot);
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

interface ReadinessBody {
  status: string;
  checks?: { id: string; ok: boolean; severity?: string; reason?: string; message?: string }[];
}

const deep = (app: { fetch: (request: Request) => Response | Promise<Response> }) =>
  Promise.resolve(app.fetch(new Request('http://localhost/up?deep=1')));

describe('liveness', () => {
  it('bare /up is a plain-text 200 liveness probe', async () => {
    const app = await createApp({ manifest, healthPath: '/up' });
    const res = await app.fetch(new Request('http://localhost/up'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
  });

  it('without checks or probes, ?deep=1 falls back to the plain liveness response', async () => {
    const app = await createApp({ manifest, healthPath: '/up' });
    const res = await deep(app);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
  });

  it('never resolves the session for a health probe', async () => {
    let calls = 0;
    const app = await createApp({
      manifest,
      healthPath: '/up',
      resolveSession: () => {
        calls += 1;
        return null;
      },
    });
    const res = await app.fetch(
      new Request('http://localhost/up', { headers: { cookie: 'sid=abc' } }),
    );
    assert.equal(res.status, 200);
    assert.equal(calls, 0);
  });
});

describe('readiness', () => {
  it('answers 200/503 from system checks, with only the aggregate for anonymous callers', async () => {
    const healthy = createSystemCheckRegistry();
    healthy.register('db', () => [{ id: 'db', severity: 'info', message: 'reachable' }]);
    const app = await createApp({ manifest, healthPath: '/up', systemChecks: healthy });
    const ok = await deep(app);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { status: 'ok' });

    const failing = createSystemCheckRegistry();
    failing.register('db', () => [{ id: 'db', severity: 'error', message: 'secret dsn' }]);
    const app2 = await createApp({ manifest, healthPath: '/up', systemChecks: failing });
    const fail = await deep(app2);
    assert.equal(fail.status, 503);
    const text = await fail.text();
    assert.deepEqual(JSON.parse(text), { status: 'error' });
    assert.doesNotMatch(text, /secret dsn/);
  });

  it('shows per-check results only when authorize returns exactly true', async () => {
    const failing = createSystemCheckRegistry();
    failing.register('db', () => [{ id: 'db', severity: 'error', message: 'down' }]);
    const app = await createApp({
      manifest,
      healthPath: '/up',
      systemChecks: failing,
      readiness: {
        cacheMs: 0,
        authorize: (request) => request.headers.get('x-probe-token') === 'letmein',
      },
    });
    const anonymous = (await (await deep(app)).json()) as ReadinessBody;
    assert.equal(anonymous.checks, undefined);

    const res = await app.fetch(
      new Request('http://localhost/up?deep=1', { headers: { 'x-probe-token': 'letmein' } }),
    );
    assert.equal(res.status, 503);
    const body = (await res.json()) as ReadinessBody;
    assert.equal(body.status, 'error');
    assert.equal(body.checks?.[0]?.severity, 'error');
    assert.equal(body.checks?.[0]?.ok, false);
  });

  it('runs async probes; a throw, false, or timeout fails without leaking error text', async () => {
    const app = await createApp({
      manifest,
      healthPath: '/up',
      readiness: {
        timeoutMs: 20,
        cacheMs: 0,
        authorize: () => true,
        probes: {
          database: async () => undefined,
          cache: () => {
            throw new Error('password=hunter2');
          },
          queue: () => false,
          slow: (signal) =>
            new Promise((resolve) => {
              const timer = setTimeout(resolve, 5000);
              signal.addEventListener('abort', () => clearTimeout(timer));
            }),
        },
      },
    });
    const res = await deep(app);
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.doesNotMatch(text, /hunter2/);
    const body = JSON.parse(text) as ReadinessBody;
    const byId = new Map(body.checks?.map((check) => [check.id, check]));
    assert.equal(byId.get('database')?.ok, true);
    assert.equal(byId.get('cache')?.reason, 'failed');
    assert.equal(byId.get('queue')?.reason, 'failed');
    assert.equal(byId.get('slow')?.reason, 'timed_out');
  });

  it('caches one result for cacheMs and shares it between callers', async () => {
    let runs = 0;
    const app = await createApp({
      manifest,
      healthPath: '/up',
      readiness: {
        cacheMs: 60_000,
        probes: {
          database: () => {
            runs += 1;
          },
        },
      },
    });
    await Promise.all([deep(app), deep(app), deep(app)]);
    await deep(app);
    assert.equal(runs, 1);
  });

  it('serves readiness on readiness.path even without a health path', async () => {
    const app = await createApp({
      manifest,
      readiness: { path: '/ready', probes: { database: () => false } },
    });
    const res = await app.fetch(new Request('http://localhost/ready'));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { status: 'error' });
  });

  it('rejects malformed readiness options', async () => {
    await assert.rejects(
      createApp({ manifest, readiness: { timeoutMs: 0 } }),
      /readiness.timeoutMs/,
    );
    await assert.rejects(
      createApp({ manifest, readiness: { probes: { db: 'nope' as never } } }),
      /readiness.probes/,
    );
  });

  it('rejects a readiness.path equal to healthPath, which would serve liveness', async () => {
    await assert.rejects(
      createApp({
        manifest,
        healthPath: '/up',
        readiness: { path: '/up', probes: { database: () => false } },
      }),
      /readiness.path must differ from healthPath/,
    );
  });
});

describe('draining', () => {
  it('flips liveness and readiness to 503 once the app is draining', async () => {
    const app = await createApp({
      manifest,
      healthPath: '/up',
      readiness: { probes: { database: () => true } },
    });
    assert.equal((await app.fetch(new Request('http://localhost/up'))).status, 200);
    markDraining(app);
    const live = await app.fetch(new Request('http://localhost/up'));
    assert.equal(live.status, 503);
    assert.deepEqual(await live.json(), { status: 'draining' });
    const ready = await deep(app);
    assert.equal(ready.status, 503);
  });
});
