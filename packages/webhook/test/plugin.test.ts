/**
 * Tests for the plugin: option validation, route mounting, and the status each
 * failure maps to.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Hono } from 'hono';
import { runExtensions, type HttpExtensionHook } from 'jsails/extensions';
import type { CacheStore } from 'jsails/cache';

import { WebhookError } from '../src/errors.js';
import { webhookPlugin, type WebhookEndpoint } from '../src/plugin.js';
import { computeSignature } from '../src/signature.js';

/** The Hono environment the extension hook expects, without naming it. */
type TestAppEnv = Parameters<HttpExtensionHook>[0] extends Hono<infer E> ? E : never;

const SECRET = 'shhh';
const ID = 'stripe';
const PATH = '/webhooks/stripe';
const BODY = '{"event":"paid"}';

function countingStore(): CacheStore {
  const counts = new Map<string, number>();
  return {
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined,
    remember: async (_key, _ttl, loader) => loader(),
    increment: async (key) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    close: async () => undefined,
  };
}

/** A request signed at the current second. */
function signedRequest(body = BODY, secret = SECRET): Request {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = computeSignature(ID, timestamp, body, secret);
  return new Request(`https://example.test${PATH}`, {
    method: 'POST',
    headers: { 'x-webhook-signature': `t=${timestamp},v1=${signature}` },
    body,
  });
}

/** Mount the plugin's HTTP hooks on a fresh Hono app. */
async function mount(endpoint: Partial<WebhookEndpoint> = {}): Promise<Hono<TestAppEnv>> {
  const plugin = webhookPlugin({
    cache: countingStore(),
    endpoints: [{ id: ID, path: PATH, secret: SECRET, onEvent: () => undefined, ...endpoint }],
  });
  const runtime = await runExtensions([plugin]);
  const app = new Hono<TestAppEnv>();
  for (const hook of runtime.httpHooks) await hook(app);
  return app;
}

describe('webhookPlugin options', () => {
  it('requires a cache store', () => {
    assert.throws(
      () => webhookPlugin({ endpoints: [] } as unknown as Parameters<typeof webhookPlugin>[0]),
      TypeError,
    );
  });

  it('requires at least one endpoint', () => {
    assert.throws(() => webhookPlugin({ cache: countingStore(), endpoints: [] }), TypeError);
  });

  it('rejects a malformed endpoint id', () => {
    assert.throws(
      () =>
        webhookPlugin({
          cache: countingStore(),
          endpoints: [{ id: 'Bad Id', path: PATH, secret: SECRET, onEvent: () => undefined }],
        }),
      (error: unknown) => error instanceof WebhookError && error.code === 'invalid_endpoint',
    );
  });

  it('rejects a path without a leading slash', () => {
    assert.throws(
      () =>
        webhookPlugin({
          cache: countingStore(),
          endpoints: [{ id: ID, path: 'webhooks', secret: SECRET, onEvent: () => undefined }],
        }),
      (error: unknown) => error instanceof WebhookError && error.code === 'invalid_endpoint',
    );
  });

  it('rejects an empty secret', () => {
    assert.throws(
      () =>
        webhookPlugin({
          cache: countingStore(),
          endpoints: [{ id: ID, path: PATH, secret: '', onEvent: () => undefined }],
        }),
      (error: unknown) => error instanceof WebhookError && error.code === 'invalid_endpoint',
    );
  });

  it('rejects duplicate ids and duplicate paths', () => {
    const endpoint = { id: ID, path: PATH, secret: SECRET, onEvent: () => undefined };
    assert.throws(
      () =>
        webhookPlugin({
          cache: countingStore(),
          endpoints: [endpoint, { ...endpoint, path: '/other' }],
        }),
      (error: unknown) => error instanceof WebhookError && error.code === 'invalid_endpoint',
    );
    assert.throws(
      () =>
        webhookPlugin({
          cache: countingStore(),
          endpoints: [endpoint, { ...endpoint, id: 'other' }],
        }),
      (error: unknown) => error instanceof WebhookError && error.code === 'invalid_endpoint',
    );
  });

  it('rejects a non-positive tolerance', () => {
    assert.throws(
      () =>
        webhookPlugin({
          cache: countingStore(),
          endpoints: [
            { id: ID, path: PATH, secret: SECRET, toleranceSeconds: 0, onEvent: () => undefined },
          ],
        }),
      (error: unknown) => error instanceof WebhookError && error.code === 'invalid_endpoint',
    );
  });
});

describe('webhookPlugin routes', () => {
  it('accepts a valid delivery and hands the parsed body to onEvent', async () => {
    const seen: unknown[] = [];
    const app = await mount({ onEvent: (_event, body) => void seen.push(body) });
    const response = await app.request(signedRequest());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: true });
    assert.deepEqual(seen, [{ event: 'paid' }]);
  });

  it('returns the handler response when it returns one', async () => {
    const app = await mount({ onEvent: () => Response.json({ ok: true }, { status: 202 }) });
    const response = await app.request(signedRequest());
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true });
  });

  it('rejects a bad signature with 401', async () => {
    const app = await mount();
    const response = await app.request(signedRequest(BODY, 'wrong'));
    assert.equal(response.status, 401);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'invalid_signature');
  });

  it('rejects a replay with 409', async () => {
    const app = await mount();
    const request = signedRequest();
    assert.equal((await app.request(request)).status, 200);
    const replay = await app.request(signedRequest());
    assert.equal(replay.status, 409);
    const body = (await replay.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'replayed');
  });

  it('rejects a non-JSON body with 400 after verification', async () => {
    const app = await mount();
    const response = await app.request(signedRequest('not json'));
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'invalid_payload');
  });

  it('never echoes the secret or the signature in an error body', async () => {
    const app = await mount();
    const response = await app.request(signedRequest(BODY, 'wrong'));
    const text = await response.text();
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes('wrong'), false);
  });
});
