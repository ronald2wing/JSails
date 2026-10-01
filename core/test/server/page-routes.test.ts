/**
 * Page route registration tests for the streamed-page path: a producer that
 * throws after the response started must still reach `requestFailed`
 * observers, because the handler has already returned by then.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { definePlugin, type PluginContext } from '../../src/extensions/plugin-contract.js';
import {
  requestFailed,
  RegistrySignalBus,
  signalsToken,
  type RequestSignalPayload,
} from '../../src/signals/index.js';
import { createTestApp } from '../../src/testing/app.js';
import { writeFixture } from '../fixtures/app.js';

const distDir = fileURLToPath(new URL('../../', import.meta.url));

describe('streamed page routes', () => {
  const suiteDir = mkdtempSync(join(distDir, 'page-routes-'));
  after(() => rmSync(suiteDir, { recursive: true, force: true }));

  it('reports a mid-stream producer failure as requestFailed', async (t) => {
    const dir = mkdtempSync(join(suiteDir, 'stream-fail-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFixture(
      dir,
      'pages/live.mjs',
      `export async function* stream() {
         yield '<p>start</p>';
         throw new Error('upstream lost');
       }
       export default function Page() { return null; }
`,
    );

    const failed: RequestSignalPayload[] = [];
    const app = await createTestApp({
      config: {
        rootDir: dir,
        port: 0,
        authorize: () => true,
        extensions: [
          definePlugin({
            name: 'signals',
            setup({ services, interceptorRegistry }) {
              services.provide(signalsToken, new RegistrySignalBus(interceptorRegistry));
            },
          }),
          definePlugin({
            name: 'capture',
            setup({ observe }: PluginContext) {
              observe(requestFailed, (payload) => {
                failed.push(payload);
              });
            },
          }),
        ],
      },
      lifecycle: t,
    });

    const response = await app.request('/live');
    assert.equal(response.status, 200);
    await assert.rejects(() => response.text());
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(failed.length, 1, 'the stream failure must reach requestFailed');
    const error = failed[0]!.error;
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'upstream lost');
  });
});
