/**
 * The request id is ambient for the whole request and absent outside one.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { createApp } from '../../src/server/app.js';
import { currentRequestId, withRequestId } from '../../src/server/request-scope.js';
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
