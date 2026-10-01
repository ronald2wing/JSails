/**
 * The request id is ambient for the whole request and absent outside one.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { createApp } from '../../src/server/app.js';
import {
  currentRequestId,
  isRequestId,
  withoutRequestId,
  withRequestId,
} from '../../src/server/request-scope.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import { runExtensions } from '../../src/extensions/index.js';

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const root = mkdtempSync(join(distDir, 'request-scope-'));
after(() => rmSync(root, { recursive: true, force: true }));
const manifest = discoverRoutes(root);

describe('ambient request id', () => {
  it('is undefined outside a request and scoped inside withRequestId', async () => {
    assert.equal(currentRequestId(), undefined);
    await withRequestId('abc', async () => {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(currentRequestId(), 'abc');
    });
  });

  it('withoutRequestId clears the id for its whole async path only', async () => {
    await withRequestId('outer', async () => {
      await withoutRequestId(async () => {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(currentRequestId(), undefined);
      });
      assert.equal(currentRequestId(), 'outer');
    });
  });

  it('matches the X-Request-Id response header across async work in a handler', async () => {
    const runtime = await runExtensions([
      {
        name: 'echo',
        setup: ({ configureHttp }) =>
          configureHttp((app) => {
            app.get('/echo', async () => {
              await new Promise((resolve) => setTimeout(resolve, 1));
              return Response.json({ id: currentRequestId() ?? null });
            });
          }),
      },
    ]);
    const app = await createApp({ manifest, httpHooks: runtime.httpHooks });

    const generated = await app.fetch(new Request('http://localhost/echo'));
    const header = generated.headers.get('x-request-id');
    assert.ok(header);
    assert.deepEqual(await generated.json(), { id: header });

    const inbound = await app.fetch(
      new Request('http://localhost/echo', { headers: { 'x-request-id': 'client-1' } }),
    );
    assert.deepEqual(await inbound.json(), { id: 'client-1' });
  });
});

describe('isRequestId', () => {
  it('accepts the ids createApp accepts or generates', () => {
    assert.equal(isRequestId('client-1'), true);
    assert.equal(isRequestId('3f1c2b4e-5d6a-4b7c-8d9e-0f1a2b3c4d5e'), true);
    assert.equal(isRequestId('a'.repeat(255)), true);
  });

  it('rejects anything else', () => {
    assert.equal(isRequestId(''), false);
    assert.equal(isRequestId('a'.repeat(256)), false);
    assert.equal(isRequestId('id with spaces'), false);
    assert.equal(isRequestId('id\nX-Injected: 1'), false);
    assert.equal(isRequestId(42), false);
    assert.equal(isRequestId(undefined), false);
  });
});
