/**
 * Tests for the plugin: option validation, route mounting, and the status each
 * failure maps to.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { Hono } from 'hono';
import { runExtensions, type HttpExtensionHook } from 'jsails/extensions';
import type { CacheStore } from 'jsails/cache';

import { WebhookError } from '../src/errors.js';
import { webhookPlugin, type WebhookEndpoint } from '../src/plugin.js';
import { computeSignature } from '../src/signature.js';
import { githubVerifier, slackVerifier, stripeVerifier } from '../src/verifiers.js';

function hmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

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
    delete: async (key) => {
      counts.delete(key);
    },
    remember: async (_key, _ttl, loader) => loader(),
    increment: async (key) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    close: async () => undefined,
  };
}

/**
 * A store whose entries expire by their TTL against a clock the test moves,
 * so a test can observe what the replay guard still remembers later on.
 */
function expiringStore(): CacheStore & { advance(ms: number): void } {
  let now = 0;
  const entries = new Map<string, { count: number; expiresAt: number }>();
  return {
    advance: (ms) => {
      now += ms;
    },
    get: async () => null,
    set: async () => undefined,
    delete: async (key) => {
      entries.delete(key);
    },
    remember: async (_key, _ttl, loader) => loader(),
    increment: async (key, ttlMs) => {
      const entry = entries.get(key);
      const live = entry !== undefined && entry.expiresAt > now;
      const count = live ? entry.count + 1 : 1;
      entries.set(key, {
        count,
        expiresAt: live ? entry.expiresAt : now + (ttlMs ?? Number.POSITIVE_INFINITY),
      });
      return count;
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
async function mount(
  endpoint: Partial<WebhookEndpoint> = {},
  cache: CacheStore = countingStore(),
): Promise<Hono<TestAppEnv>> {
  const plugin = webhookPlugin({
    cache,
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

  it('rejects a non-positive replay window', () => {
    assert.throws(
      () =>
        webhookPlugin({
          cache: countingStore(),
          endpoints: [
            {
              id: ID,
              path: PATH,
              secret: SECRET,
              replayWindowSeconds: 0,
              onEvent: () => undefined,
            },
          ],
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

  it('accepts a retry after the handler threw instead of answering replayed', async () => {
    let attempts = 0;
    const app = await mount({
      onEvent: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('database unavailable');
        }
      },
    });
    app.onError(() => new Response('failed', { status: 500 }));
    const request = signedRequest();
    const retry = request.clone();
    assert.equal((await app.request(request)).status, 500);
    assert.equal((await app.request(retry)).status, 200);
    assert.equal(attempts, 2);
  });

  it('releases the claim when the handler answers with a 5xx', async () => {
    let attempts = 0;
    const app = await mount({
      onEvent: () => {
        attempts += 1;
        return attempts === 1 ? new Response(null, { status: 503 }) : undefined;
      },
    });
    const request = signedRequest();
    const retry = request.clone();
    assert.equal((await app.request(request)).status, 503);
    assert.equal((await app.request(retry)).status, 200);
    // A successful delivery keeps its claim.
    assert.equal((await app.request(signedRequest())).status, 409);
  });

  it('does not consume a replay slot for a non-JSON body', async () => {
    const cache = countingStore();
    let claims = 0;
    const counted: CacheStore = {
      ...cache,
      increment: async (key, ttl) => {
        claims += 1;
        return cache.increment!(key, ttl);
      },
    };
    const app = await mount({}, counted);
    assert.equal((await app.request(signedRequest('not json'))).status, 400);
    assert.equal(claims, 0);
  });

  it('accepts any secret listed for rotation', async () => {
    const app = await mount({ secret: ['new-secret', SECRET] });
    assert.equal((await app.request(signedRequest(BODY, SECRET))).status, 200);
    assert.equal((await app.request(signedRequest('{"n":2}', 'new-secret'))).status, 200);
    assert.equal((await app.request(signedRequest('{"n":3}', 'retired'))).status, 401);
  });

  it('verifies a Stripe-signed delivery through the stripe preset', async () => {
    const app = await mount({ verifier: stripeVerifier });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = hmac(SECRET, `${timestamp}.${BODY}`);
    const response = await app.request(
      new Request(`https://example.test${PATH}`, {
        method: 'POST',
        headers: { 'stripe-signature': `t=${timestamp},v1=${'0'.repeat(64)},v1=${signature}` },
        body: BODY,
      }),
    );
    assert.equal(response.status, 200);
  });

  it('refuses a Stripe replay that prepends a junk v1 candidate', async () => {
    const app = await mount({ verifier: stripeVerifier });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = hmac(SECRET, `${timestamp}.${BODY}`);
    const send = (header: string) =>
      app.request(
        new Request(`https://example.test${PATH}`, {
          method: 'POST',
          headers: { 'stripe-signature': header },
          body: BODY,
        }),
      );
    assert.equal((await send(`t=${timestamp},v1=${signature}`)).status, 200);
    const junk = 'ab'.repeat(32);
    assert.equal((await send(`t=${timestamp},v1=${junk},v1=${signature}`)).status, 409);
    assert.equal((await send(`t=${timestamp},v1=${'cd'.repeat(32)},v1=${signature}`)).status, 409);
  });

  it('remembers an untimed GitHub delivery well past twice the tolerance', async () => {
    const cache = expiringStore();
    const app = await mount({ verifier: githubVerifier }, cache);
    const send = () =>
      app.request(
        new Request(`https://example.test${PATH}`, {
          method: 'POST',
          headers: { 'x-hub-signature-256': `sha256=${hmac(SECRET, BODY)}` },
          body: BODY,
        }),
      );
    assert.equal((await send()).status, 200);
    cache.advance((2 * 300 + 60) * 1000);
    assert.equal((await send()).status, 409);
    cache.advance(7 * 24 * 60 * 60 * 1000);
    assert.equal((await send()).status, 200);
  });

  it('honours an endpoint replay window for an untimed scheme', async () => {
    const cache = expiringStore();
    const app = await mount({ verifier: githubVerifier, replayWindowSeconds: 60 }, cache);
    const send = () =>
      app.request(
        new Request(`https://example.test${PATH}`, {
          method: 'POST',
          headers: { 'x-hub-signature-256': `sha256=${hmac(SECRET, BODY)}` },
          body: BODY,
        }),
      );
    assert.equal((await send()).status, 200);
    cache.advance(30_000);
    assert.equal((await send()).status, 409);
    cache.advance(31_000);
    assert.equal((await send()).status, 200);
  });

  it('verifies a GitHub-signed delivery through the github preset', async () => {
    const app = await mount({ verifier: githubVerifier });
    const response = await app.request(
      new Request(`https://example.test${PATH}`, {
        method: 'POST',
        headers: { 'x-hub-signature-256': `sha256=${hmac(SECRET, BODY)}` },
        body: BODY,
      }),
    );
    assert.equal(response.status, 200);
  });

  it('verifies a Slack-signed delivery and rejects a stale one', async () => {
    const app = await mount({ verifier: slackVerifier });
    const fresh = Math.floor(Date.now() / 1000);
    const send = (timestamp: number) =>
      app.request(
        new Request(`https://example.test${PATH}`, {
          method: 'POST',
          headers: {
            'x-slack-request-timestamp': String(timestamp),
            'x-slack-signature': `v0=${hmac(SECRET, `v0:${timestamp}:${BODY}`)}`,
          },
          body: BODY,
        }),
      );
    assert.equal((await send(fresh)).status, 200);
    assert.equal((await send(fresh - 3600)).status, 401);
  });
});
