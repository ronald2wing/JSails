/**
 * Route modules load by file URL, not by raw path: an app directory whose path
 * holds `#` or `%` (legal in a file name, but a fragment and an escape in a
 * URL) still serves its API and page routes.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createApp } from '../../src/server/app.js';
import { preactPageRenderer } from '../../src/pages/page.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import { TEST_ORIGIN, writeFixture } from '../fixtures/app.js';

const root = mkdtempSync(join(tmpdir(), 'jsails routes #1 100%25 '));
after(() => rmSync(root, { recursive: true, force: true }));

writeFixture(root, 'api/ping.mjs', `export const GET = () => Response.json({ pong: true });\n`);
writeFixture(
  root,
  'pages/hello.mjs',
  `export async function* stream() {\n  yield '<!doctype html><p>hello from a # path</p>';\n}\n`,
);

describe('route module loading', () => {
  it('serves API and page routes from a directory whose path holds # and %', async () => {
    assert.match(root, /#/);
    assert.match(root, /%/);
    const app = await createApp({
      manifest: discoverRoutes(root),
      renderer: preactPageRenderer,
      authorize: () => true,
    });

    const api = await app.fetch(new Request(`${TEST_ORIGIN}/api/ping`));
    assert.equal(api.status, 200);
    assert.deepEqual(await api.json(), { pong: true });

    const page = await app.fetch(new Request(`${TEST_ORIGIN}/hello`));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /hello from a # path/);
  });
});
