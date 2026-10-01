/**
 * Route limits. Deadline declarations are integers within a Node timer's
 * range, a stream's idle bound positive. Body declarations: caps are
 * validated and bounded, a `BodySpec` is checked shape and all, a route's
 * declared `body` replaces the app-wide cap (raising or lowering it) whether
 * or not the body declares its length, `none` refuses any byte, a route
 * declaring no body reads under the app-wide cap, and an API module's `body` export works like
 * a registrar route's.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { publicAccess } from '../../src/api/access-ref.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import { createApp } from '../../src/server/app.js';
import {
  BodyLimitError,
  bodyLimitOf,
  checkBodySpec,
  checkStreamSpec,
  isTimeoutMs,
  MAX_ROUTE_BODY_BYTES,
  validateBodyLimit,
  type BodySpec,
} from '../../src/server/route-limits.js';
import { createHttpRoutes } from '../../src/server/http-routes.js';
import { RouteErrors } from '../../src/server/route-meta.js';
import { writeFixture } from '../fixtures/app.js';

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const suiteDir = mkdtempSync(join(distDir, 'route-limits-'));
after(() => rmSync(suiteDir, { recursive: true, force: true }));

const EMPTY_MANIFEST = { entries: [], byRoute: new Map(), notFound: [] } as const;
const OPEN = publicAccess('body limit test');

/** POST `bytes` bytes with a declared Content-Length. */
function post(path: string, bytes: number): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      origin: 'http://localhost',
      'content-type': 'application/octet-stream',
      'content-length': String(bytes),
    },
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
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: { origin: 'http://localhost' },
    body,
    duplex: 'half',
  };
  return new Request(`http://localhost${path}`, init);
}

/** An app with routes declaring `body` and one declaring none, under the app-wide cap. */
async function build() {
  const { routes, contributions } = createHttpRoutes({
    owner: 'app',
    origin: 'app',
    allow: { mount: false, guard: false, transform: false },
  });
  const echo = (body: BodySpec, path: string) =>
    routes.add({
      methods: ['POST'],
      path,
      access: OPEN,
      credentials: [],
      body,
      handler: async (context) => Response.json({ bytes: (await context.body.bytes()).byteLength }),
    });
  echo({ kind: 'raw', maxBytes: 4096 }, '/upload');
  echo({ kind: 'raw', maxBytes: 16 }, '/tight');
  routes.add({
    methods: ['POST'],
    path: '/sealed',
    access: OPEN,
    credentials: [],
    body: { kind: 'none' },
    handler: () => new Response('sealed'),
  });
  routes.add({
    methods: ['POST'],
    path: '/plain',
    access: OPEN,
    credentials: [],
    // Declaring no body, it reads the request itself under the app-wide cap.
    handler: async ({ request }) =>
      Response.json({ bytes: (await request.arrayBuffer()).byteLength }),
  });
  return createApp({
    manifest: EMPTY_MANIFEST,
    maxBodyBytes: 1024,
    contributions: contributions(),
  });
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
});

describe('checkBodySpec', () => {
  it('accepts each kind with a valid cap, and none alone, frozen', () => {
    for (const kind of ['json', 'form', 'raw'] as const) {
      const spec = checkBodySpec({ kind, maxBytes: 10 });
      assert.deepEqual(spec, { kind, maxBytes: 10 });
      assert.ok(Object.isFrozen(spec));
    }
    assert.deepEqual(checkBodySpec({ kind: 'none' }), { kind: 'none' });
  });

  it('refuses an unknown kind, a bad cap, a missing cap, and extra members', () => {
    for (const value of [
      null,
      'json',
      {},
      { kind: 'xml', maxBytes: 10 },
      { kind: 'json' },
      { kind: 'json', maxBytes: 0 },
      { kind: 'json', maxBytes: MAX_ROUTE_BODY_BYTES + 1 },
      { kind: 'json', maxBytes: 10, extra: true },
      { kind: 'none', maxBytes: 10 },
    ]) {
      assert.equal(checkBodySpec(value), undefined);
    }
  });

  it('turns a spec into the limit the budget enforces', () => {
    assert.equal(bodyLimitOf(undefined, 99), 99);
    assert.equal(bodyLimitOf({ kind: 'none' }, 99), 0);
    assert.equal(bodyLimitOf({ kind: 'raw', maxBytes: 5 }, 99), 5);
  });
});

describe('deadline declarations', () => {
  it('accepts an integer from 0 to the largest timer delay', () => {
    for (const value of [0, 1, 30_000, 2_147_483_647]) assert.equal(isTimeoutMs(value), true);
    for (const value of [-1, 1.5, 2 ** 31, Number.NaN, '100', null]) {
      assert.equal(isTimeoutMs(value), false);
    }
  });

  it('accepts a positive stream idle bound and nothing else, frozen', () => {
    const spec = checkStreamSpec({ timeoutMs: 50 });
    assert.deepEqual(spec, { timeoutMs: 50 });
    assert.ok(Object.isFrozen(spec));
    for (const value of [{ timeoutMs: 0 }, { timeoutMs: 50, live: true }, {}, null, 50]) {
      assert.equal(checkStreamSpec(value), undefined);
    }
  });
});

describe('a declared route body', () => {
  it('raises the cap for the declaring route only', async () => {
    const app = await build();
    const ok = await app.fetch(post('/upload', 3000));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { bytes: 3000 });

    assert.equal((await app.fetch(post('/upload', 5000))).status, 413);
    assert.equal((await app.fetch(post('/plain', 3000))).status, 413);
    assert.equal((await app.fetch(post('/plain', 1000))).status, 200);
  });

  it('holds a body without Content-Length to the route cap, not the app-wide one', async () => {
    const app = await build();
    const ok = await app.fetch(postStreamed('/upload', 3000));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { bytes: 3000 });
    assert.equal((await app.fetch(postStreamed('/upload', 5000))).status, 413);
    assert.equal((await app.fetch(postStreamed('/plain', 3000))).status, 413);
  });

  it('can lower the cap below the app-wide one, with and without a length', async () => {
    const app = await build();
    assert.equal((await app.fetch(post('/tight', 16))).status, 200);
    assert.equal((await app.fetch(post('/tight', 17))).status, 413);
    assert.equal((await app.fetch(postStreamed('/tight', 16))).status, 200);
    assert.equal((await app.fetch(postStreamed('/tight', 17))).status, 413);
  });

  it('refuses any declared byte to a route declaring none', async () => {
    const app = await build();
    assert.equal((await app.fetch(post('/sealed', 1))).status, 413);
    const empty = await app.fetch(post('/sealed', 0));
    assert.equal(empty.status, 200);
  });

  it('treats a body with both Content-Length and Transfer-Encoding as unframed', async () => {
    const app = await build();
    const request = new Request('http://localhost/tight', {
      method: 'POST',
      headers: { 'content-length': '3', 'transfer-encoding': 'chunked' },
      body: new Uint8Array(3000),
    });
    assert.equal((await app.fetch(request)).status, 413);
  });

  it('answers over the cap with the problem envelope and closes the connection', async () => {
    const app = await build();
    const response = await app.fetch(post('/upload', 5000));
    assert.equal(response.status, 413);
    assert.equal(response.headers.get('connection'), 'close');
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, 'request.too_large');
  });

  it('refuses a declared length over the largest route cap before routing', async () => {
    const app = await build();
    const response = await app.fetch(post('/nowhere', MAX_ROUTE_BODY_BYTES + 1));
    assert.equal(response.status, 413);
  });
});

describe('API module body export', () => {
  it('replaces the app-wide cap for the module routes', async () => {
    const root = mkdtempSync(join(suiteDir, 'api-'));
    writeFixture(
      root,
      'api/import.mjs',
      `export const body = { kind: 'raw', maxBytes: 4096 };
export const POST = async (_request, context) => Response.json({ bytes: (await context.body.bytes()).byteLength });\nexport const authorize = () => true;\n`,
    );
    writeFixture(
      root,
      'api/other.mjs',
      `export const POST = async (request) => Response.json({ bytes: (await request.arrayBuffer()).byteLength });\nexport const authorize = () => true;\n`,
    );
    const app = await createApp({
      manifest: discoverRoutes(root),
      maxBodyBytes: 1024,
    });
    assert.equal((await app.fetch(post('/api/import', 3000))).status, 200);
    assert.equal((await app.fetch(post('/api/import', 5000))).status, 413);
    assert.equal((await app.fetch(post('/api/other', 3000))).status, 413);
  });

  it('fails assembly on an invalid export, value-free', async () => {
    const root = mkdtempSync(join(suiteDir, 'api-bad-'));
    writeFixture(
      root,
      'api/huge.mjs',
      `export const body = { kind: 'raw', maxBytes: ${MAX_ROUTE_BODY_BYTES + 1} };
export const POST = () => new Response('ok');\nexport const authorize = () => true;\n`,
    );
    await assert.rejects(
      createApp({ manifest: discoverRoutes(root) }),
      (error: unknown) =>
        RouteErrors.is(error, 'invalid_definition') &&
        error.context.problem === 'invalid_body' &&
        !error.message.includes(String(MAX_ROUTE_BODY_BYTES + 1)),
    );
  });
});

describe('jsails/app body-limit surface', () => {
  it('re-exports the same bindings a plugin imports', async () => {
    const app = await import('../../src/app/index.js');
    assert.strictEqual(app.validateBodyLimit, validateBodyLimit);
    assert.strictEqual(app.BodyLimitError, BodyLimitError);
    assert.equal(app.MAX_ROUTE_BODY_BYTES, MAX_ROUTE_BODY_BYTES);
  });
});
