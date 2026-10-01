/**
 * The request's execution context: one context per request, holding its id,
 * its span, and the application scope, and an inbound `traceparent`
 * continued only from a trusted proxy or with `telemetry.trustInbound`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { publicAccess } from '../../src/api/access-ref.js';
import { currentContext } from '../../src/context/execution-context.js';
import { runExtensions } from '../../src/extensions/index.js';
import { createServiceToken } from '../../src/extensions/services.js';
import { currentAppScope } from '../../src/facades/app-scope.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import { createApp, type AppOptions } from '../../src/server/app.js';

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const root = mkdtempSync(join(distDir, 'request-context-'));
after(() => rmSync(root, { recursive: true, force: true }));
const manifest = discoverRoutes(root);

const TRACE_ID = '12345678901234567890123456789012';
const TRACEPARENT = `00-${TRACE_ID}-1234567890123456-01`;
const marker = createServiceToken<string>('test.request-context.marker');

interface Seen {
  readonly id: string | null;
  readonly traceId: string | null;
  readonly parentSpanId: string | null;
  readonly tracestate: number;
  readonly scoped: boolean;
}

async function echoApp(options: Partial<AppOptions> = {}): Promise<{
  fetch: (request: Request, env?: unknown) => Promise<Response>;
}> {
  const runtime = await runExtensions(
    [
      {
        name: 'echo',
        setup: ({ services, routes }) => {
          services.provide(marker, 'present');
          routes.add({
            methods: ['GET'],
            path: '/echo',
            access: publicAccess('request context probe'),
            handler: async () => {
              await new Promise((resolve) => setTimeout(resolve, 1));
              const context = currentContext();
              const seen: Seen = {
                id: context?.requestId ?? null,
                traceId: context?.trace.traceId ?? null,
                parentSpanId: context?.trace.parentSpanId ?? null,
                tracestate: context?.trace.traceState.length ?? 0,
                scoped: currentAppScope()?.services.has(marker) === true,
              };
              return Response.json(seen);
            },
          });
        },
      },
    ],
    { rootDir: import.meta.dirname },
  );
  const app = await createApp({
    manifest,
    contributions: { routes: runtime.routes, transforms: runtime.transforms },
    services: runtime.services,
    ...options,
  });
  return { fetch: (request, env) => Promise.resolve(app.fetch(request, env)) };
}

async function echo(
  app: { fetch: (request: Request, env?: unknown) => Promise<Response> },
  headers: Record<string, string> = {},
  peer?: string,
): Promise<{ seen: Seen; header: string | null }> {
  const env = peer === undefined ? undefined : { incoming: { socket: { remoteAddress: peer } } };
  const response = await app.fetch(new Request('http://localhost/echo', { headers }), env);
  return { seen: (await response.json()) as Seen, header: response.headers.get('x-request-id') };
}

describe('request execution context', () => {
  it('holds the X-Request-Id, a span, and the app scope across async work', async () => {
    const app = await echoApp();
    const generated = await echo(app);
    assert.ok(generated.header);
    assert.equal(generated.seen.id, generated.header);
    assert.match(generated.seen.traceId ?? '', /^[0-9a-f]{32}$/);
    assert.equal(generated.seen.scoped, true);

    const inbound = await echo(app, { 'x-request-id': 'client-1' });
    assert.equal(inbound.seen.id, 'client-1');
    assert.equal(inbound.header, 'client-1');
  });

  it('gives every request its own trace', async () => {
    const app = await echoApp();
    const a = await echo(app);
    const b = await echo(app);
    assert.notEqual(a.seen.traceId, b.seen.traceId);
    assert.equal(a.seen.parentSpanId, null);
  });

  it('starts a new trace for an inbound traceparent from an untrusted caller', async () => {
    const app = await echoApp();
    const direct = await echo(app, { traceparent: TRACEPARENT, tracestate: 'a=1' });
    assert.notEqual(direct.seen.traceId, TRACE_ID);
    assert.equal(direct.seen.parentSpanId, null);
    assert.equal(direct.seen.tracestate, 0);
  });

  it('ignores a traceparent a client sends through an untrusted chain', async () => {
    const app = await echoApp({ server: { trustedProxies: { cidrs: ['10.0.0.0/8'] } } });
    const spoofed = await echo(
      app,
      { traceparent: TRACEPARENT, 'x-forwarded-for': '10.1.1.1' },
      '203.0.113.9',
    );
    assert.notEqual(spoofed.seen.traceId, TRACE_ID);
  });

  it('continues a traceparent a trusted proxy relayed', async () => {
    const app = await echoApp({ server: { trustedProxies: { hops: 1 } } });
    const relayed = await echo(
      app,
      { traceparent: TRACEPARENT, tracestate: 'a=1', 'x-forwarded-for': '198.51.100.7' },
      '10.0.0.2',
    );
    assert.equal(relayed.seen.traceId, TRACE_ID);
    assert.equal(relayed.seen.parentSpanId, '1234567890123456');
    assert.equal(relayed.seen.tracestate, 1);
  });

  it('continues a traceparent from a trusted { cidrs } peer that sent no X-Forwarded-For', async () => {
    const app = await echoApp({ server: { trustedProxies: { cidrs: ['10.0.0.0/8'] } } });
    const bare = await echo(app, { traceparent: TRACEPARENT, tracestate: 'a=1' }, '10.0.0.2');
    assert.equal(bare.seen.traceId, TRACE_ID);
    assert.equal(bare.seen.parentSpanId, '1234567890123456');
    assert.equal(bare.seen.tracestate, 1);
    const chained = await echo(
      app,
      { traceparent: TRACEPARENT, 'x-forwarded-for': '198.51.100.7' },
      '10.0.0.2',
    );
    assert.equal(chained.seen.traceId, TRACE_ID);
  });

  it('starts a new trace for a peer outside the trusted ranges that sent no chain', async () => {
    const app = await echoApp({ server: { trustedProxies: { cidrs: ['10.0.0.0/8'] } } });
    const direct = await echo(app, { traceparent: TRACEPARENT, tracestate: 'a=1' }, '203.0.113.9');
    assert.notEqual(direct.seen.traceId, TRACE_ID);
    assert.equal(direct.seen.parentSpanId, null);
    assert.equal(direct.seen.tracestate, 0);
  });

  it('starts a new trace when a { hops } chain is too short to name a trusted hop', async () => {
    const app = await echoApp({ server: { trustedProxies: { hops: 2 } } });
    const short = await echo(
      app,
      { traceparent: TRACEPARENT, 'x-forwarded-for': '198.51.100.7' },
      '10.0.0.2',
    );
    assert.notEqual(short.seen.traceId, TRACE_ID);
  });

  it('continues every inbound traceparent with telemetry.trustInbound', async () => {
    const app = await echoApp({ telemetry: { trustInbound: true } });
    const trusted = await echo(app, { traceparent: TRACEPARENT });
    assert.equal(trusted.seen.traceId, TRACE_ID);
    const invalid = await echo(app, { traceparent: `00-${'0'.repeat(32)}-1234567890123456-01` });
    assert.notEqual(invalid.seen.traceId, '0'.repeat(32));
  });
});
