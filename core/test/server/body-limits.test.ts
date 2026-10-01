/**
 * Per-route body limits: declarations are validated and bounded, a matched
 * route's cap replaces the app-wide one (raising or lowering it), the smallest
 * matched declaration wins, a body without a declared length never gets more
 * than the app-wide cap, and an API module's `maxBodyBytes` export works like
 * `routeBodyLimit`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { createApp } from '../../src/server/app.js';
import {
  BodyLimitError,
  MAX_ROUTE_BODY_BYTES,
  routeBodyLimit,
  validateBodyLimit,
} from '../../src/server/body-limits.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import type { HttpExtensionHook } from '../../src/extensions/extension.js';
import { writeFixture } from '../fixtures/app.js';

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const suiteDir = mkdtempSync(join(distDir, 'body-limits-'));
after(() => rmSync(suiteDir, { recursive: true, force: true }));

const emptyManifest = discoverRoutes(mkdtempSync(join(suiteDir, 'empty-')));

/** POST `bytes` bytes with a declared Content-Length. */
function post(path: string, bytes: number): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes) },
    body: new Uint8Array(bytes),
  });
}

/** POST `bytes` bytes as a stream, with no Content-Length to trust. */
function postStreamed(path: string, bytes: number): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
  // Node requires `duplex` for a stream body; TypeScript's RequestInit lacks it.
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half' };
  return new Request(`http://localhost${path}`, init);
}

/** A handler that reads the whole body and echoes its size. */
async function echoSize(c: { req: { raw: Request } }): Promise<Response> {
  const body = await c.req.raw.arrayBuffer();
  return Response.json({ bytes: body.byteLength });
}

describe('validateBodyLimit', () => {
  it('accepts a positive integer up to the ceiling', () => {
    assert.equal(validateBodyLimit(1), 1);
    assert.equal(validateBodyLimit(MAX_ROUTE_BODY_BYTES), MAX_ROUTE_BODY_BYTES);
  });

  it('rejects zero, negatives, fractions, non-numbers, and values over the ceiling', () => {
    for (const value of [
      0,
      -1,
      1.5,
      Number.NaN,
      Infinity,
      '1024',
      null,
      MAX_ROUTE_BODY_BYTES + 1,
    ]) {
      assert.throws(
        () => validateBodyLimit(value),
        (error: unknown) => error instanceof BodyLimitError && error.code === 'invalid_body_limit',
      );
    }
  });

  it('validates when routeBodyLimit is called, not per request', () => {
    assert.throws(() => routeBodyLimit(0), BodyLimitError);
  });
});

describe('routeBodyLimit', () => {
  const hook: HttpExtensionHook = (app) => {
    app.post('/upload', routeBodyLimit(4096), echoSize);
    app.post('/tight', routeBodyLimit(16), echoSize);
    app.use('/nested/*', routeBodyLimit(64));
    app.post('/nested/big', routeBodyLimit(4096), echoSize);
    app.post('/plain', echoSize);
  };

  async function build() {
    return createApp({ manifest: emptyManifest, maxBodyBytes: 1024, httpHooks: [hook] });
  }

  it('raises the cap for the declaring route only', async () => {
    const app = await build();
    const ok = await app.fetch(post('/upload', 3000));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { bytes: 3000 });

    assert.equal((await app.fetch(post('/upload', 5000))).status, 413);
    assert.equal((await app.fetch(post('/plain', 3000))).status, 413);
    assert.equal((await app.fetch(post('/plain', 1000))).status, 200);
  });

  it('holds a body without Content-Length to the app-wide cap on a raised route', async () => {
    const app = await build();
    const ok = await app.fetch(postStreamed('/upload', 1000));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { bytes: 1000 });
    // Within the route's 4096 but over the app-wide 1024: only a body that
    // declares its length may use the raised cap.
    assert.equal((await app.fetch(postStreamed('/upload', 3000))).status, 413);
    assert.equal((await app.fetch(postStreamed('/upload', 5000))).status, 413);
    assert.equal((await app.fetch(post('/upload', 3000))).status, 200);
  });

  it('still applies a lowered cap to a body without Content-Length', async () => {
    const app = await build();
    assert.equal((await app.fetch(postStreamed('/tight', 16))).status, 200);
    assert.equal((await app.fetch(postStreamed('/tight', 17))).status, 413);
  });

  it('stops reading an endless chunked body at the app-wide cap', async () => {
    const app = await build();
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 256;
        controller.enqueue(new Uint8Array(256));
      },
    });
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half' };
    const response = await app.fetch(new Request('http://localhost/upload', init));
    assert.equal(response.status, 413);
    // The cap is 1024; the stream's own read-ahead may add a chunk or two.
    assert.ok(pulled <= 1024 + 3 * 256, `read ${pulled} bytes of an anonymous body`);
  });

  it('treats a body with both Content-Length and Transfer-Encoding as unframed', async () => {
    const app = await build();
    const request = new Request('http://localhost/upload', {
      method: 'POST',
      headers: { 'content-length': '3000', 'transfer-encoding': 'chunked' },
      body: new Uint8Array(3000),
    });
    assert.equal((await app.fetch(request)).status, 413);
  });

  it('can lower the cap below the app-wide one', async () => {
    const app = await build();
    assert.equal((await app.fetch(post('/tight', 16))).status, 200);
    assert.equal((await app.fetch(post('/tight', 17))).status, 413);
  });

  it('applies the smallest matched declaration', async () => {
    const app = await build();
    assert.equal((await app.fetch(post('/nested/big', 64))).status, 200);
    assert.equal((await app.fetch(post('/nested/big', 65))).status, 413);
  });

  it('answers an over-cap API request with the JSON envelope', async () => {
    const app = await build();
    const res = await app.fetch(post('/upload', 5000));
    assert.equal(res.status, 413);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'payload_too_large');
  });
});

describe('API module maxBodyBytes export', () => {
  it('replaces the app-wide cap for the module routes', async () => {
    const root = mkdtempSync(join(suiteDir, 'api-'));
    writeFixture(
      root,
      'api/import.mjs',
      `export const maxBodyBytes = 4096;
export const POST = async (request) => Response.json({ bytes: (await request.arrayBuffer()).byteLength });\n`,
    );
    writeFixture(
      root,
      'api/other.mjs',
      `export const POST = async (request) => Response.json({ bytes: (await request.arrayBuffer()).byteLength });\n`,
    );
    const app = await createApp({
      manifest: discoverRoutes(root),
      maxBodyBytes: 1024,
      authorize: () => true,
    });
    assert.equal((await app.fetch(post('/api/import', 3000))).status, 200);
    assert.equal((await app.fetch(post('/api/import', 5000))).status, 413);
    assert.equal((await app.fetch(post('/api/other', 3000))).status, 413);
  });

  it('fails assembly on an out-of-bounds export', async () => {
    const root = mkdtempSync(join(suiteDir, 'api-bad-'));
    writeFixture(
      root,
      'api/huge.mjs',
      `export const maxBodyBytes = ${MAX_ROUTE_BODY_BYTES + 1};
export const POST = () => new Response('ok');\n`,
    );
    await assert.rejects(
      createApp({ manifest: discoverRoutes(root), authorize: () => true }),
      (error: unknown) => error instanceof BodyLimitError && /api\/huge/.test(error.message),
    );
  });
});

describe('jsails/app body-limit surface', () => {
  it('re-exports the same bindings a hook or plugin imports', async () => {
    const app = await import('../../src/app/index.js');
    assert.strictEqual(app.routeBodyLimit, routeBodyLimit);
    assert.strictEqual(app.validateBodyLimit, validateBodyLimit);
    assert.strictEqual(app.BodyLimitError, BodyLimitError);
    assert.equal(app.MAX_ROUTE_BODY_BYTES, MAX_ROUTE_BODY_BYTES);
  });
});
