/**
 * Tests for the plugin: option validation (before any setup, echoing no
 * input), the routes it registers, an inert setup, and the status each
 * failure maps to, served through the real request pipeline.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { cacheToken, type CacheService, type CacheStore } from 'jsails/cache';
import { runExtensions } from 'jsails/extensions';
import { checkOptionSchema, ConfigErrors } from 'jsails/kernel';
import { testPlugin } from 'jsails/testing';

import { webhookPlugin, type WebhookEndpoint } from '../src/plugin.js';
import { computeSignature } from '../src/signature.js';
import { githubVerifier, slackVerifier, stripeVerifier } from '../src/verifiers.js';
import { claimStore } from './claim-store.js';
import { serveWebhooks } from './serve-webhooks.js';

function hmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

const SECRET = 'shhh';
const ID = 'stripe';
const PATH = '/webhooks/stripe';
const BODY = '{"event":"paid"}';

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

/** Serve one endpoint through the request pipeline, its replay guard over `cache`. */
async function mount(endpoint: Partial<WebhookEndpoint> = {}, cache: CacheStore = claimStore()) {
  const { app } = await serveWebhooks(
    {
      endpoints: [{ id: ID, path: PATH, secret: SECRET, onEvent: () => undefined, ...endpoint }],
    },
    cache,
  );
  return app;
}

const ENDPOINT = { id: ID, path: PATH, secret: SECRET, onEvent: () => undefined };

describe('webhookPlugin options', () => {
  const LEAK = 'zz-secret-input';
  const invalidOptions: readonly { readonly name: string; readonly input: unknown }[] = [
    { name: 'no options', input: undefined },
    { name: 'an unknown option', input: { endpoints: [ENDPOINT], [LEAK]: true } },
    { name: 'a cache store instance', input: { cache: claimStore(), endpoints: [ENDPOINT] } },
    { name: 'an invalid cache namespace', input: { cache: `a:${LEAK}`, endpoints: [ENDPOINT] } },
    { name: 'no endpoint', input: { endpoints: [] } },
    { name: 'a malformed endpoint id', input: { endpoints: [{ ...ENDPOINT, id: `Bad ${LEAK}` }] } },
    { name: 'a relative path', input: { endpoints: [{ ...ENDPOINT, path: LEAK }] } },
    { name: 'a path with a query', input: { endpoints: [{ ...ENDPOINT, path: `/w?${LEAK}` }] } },
    { name: 'a trailing slash', input: { endpoints: [{ ...ENDPOINT, path: `/${LEAK}/` }] } },
    { name: 'an empty secret', input: { endpoints: [{ ...ENDPOINT, secret: '' }] } },
    { name: 'no rotation secret', input: { endpoints: [{ ...ENDPOINT, secret: [] }] } },
    { name: 'a non-string secret', input: { endpoints: [{ ...ENDPOINT, secret: [LEAK, 7] }] } },
    { name: 'a missing handler', input: { endpoints: [{ ...ENDPOINT, onEvent: LEAK }] } },
    { name: 'an unknown endpoint field', input: { endpoints: [{ ...ENDPOINT, [LEAK]: 1 }] } },
    {
      name: 'a verifier without verify',
      input: { endpoints: [{ ...ENDPOINT, verifier: { name: LEAK, parse: () => null } }] },
    },
    {
      name: 'a duplicate id',
      input: { endpoints: [ENDPOINT, { ...ENDPOINT, path: '/other' }] },
    },
    {
      name: 'a duplicate path',
      input: { endpoints: [ENDPOINT, { ...ENDPOINT, id: 'other' }] },
    },
    ...[0, 1.5, 31_536_001].map((replayWindowSeconds) => ({
      name: `a replay window of ${replayWindowSeconds}`,
      input: { endpoints: [{ ...ENDPOINT, replayWindowSeconds }] },
    })),
    ...[0, 0.0001, 400 * 86_400].map((replayWindowSeconds) => ({
      name: `a verifier replay window of ${replayWindowSeconds}`,
      input: {
        endpoints: [
          { ...ENDPOINT, verifier: { ...githubVerifier, name: 'acme', replayWindowSeconds } },
        ],
      },
    })),
    ...[0, 15_768_001].map((toleranceSeconds) => ({
      name: `a tolerance of ${toleranceSeconds}`,
      input: { endpoints: [{ ...ENDPOINT, toleranceSeconds }] },
    })),
  ];
  for (const { name, input } of invalidOptions) {
    it(`refuses ${name} with config.invalid_options before any setup, echoing no input`, () => {
      const factory = webhookPlugin as unknown as (input: unknown) => unknown;
      assert.throws(
        () => factory(input),
        (error: unknown) => {
          assert.ok(ConfigErrors.is(error, 'invalid_options'));
          const rendered = `${String(error)}${JSON.stringify(error.payload)}`;
          assert.equal(rendered.includes(LEAK), false);
          assert.equal(rendered.includes(SECRET), false);
          return true;
        },
      );
    });
  }

  it('accepts the longest replay window a cache entry holds', () => {
    assert.ok(webhookPlugin({ endpoints: [{ ...ENDPOINT, replayWindowSeconds: 31_536_000 }] }));
  });

  it('declares its options and the cache service it requires', () => {
    assert.deepEqual(checkOptionSchema(webhookPlugin.definition.options!), []);
    assert.deepEqual(webhookPlugin({ endpoints: [ENDPOINT] }).requires, [cacheToken]);
    assert.deepEqual(webhookPlugin({ endpoints: [ENDPOINT] }).provides, []);
  });

  it('needs the cache plugin', async () => {
    await assert.rejects(
      runExtensions([webhookPlugin({ endpoints: [ENDPOINT] })], {
        rootDir: import.meta.dirname,
        env: {},
      }),
    );
  });
});

describe('webhookPlugin setup', () => {
  it('sets up inertly, registering one public POST route per endpoint that skips the cross-site check', async () => {
    const namespaces: string[] = [];
    const store = claimStore();
    const service: CacheService = {
      cache(name) {
        namespaces.push(name);
        return store;
      },
    };
    const run = await testPlugin(
      webhookPlugin({ endpoints: [ENDPOINT, { ...ENDPOINT, id: 'github', path: '/hooks/gh' }] }),
      { services: [[cacheToken, service]] },
    );
    try {
      assert.deepEqual(
        run.http.routes.map((route) =>
          route.type === 'route'
            ? [route.methods, route.path, route.access.kind, route.credentials, route.owner]
            : route.type,
        ),
        [
          [['POST'], PATH, 'public', [], 'webhook'],
          [['POST'], '/hooks/gh', 'public', [], 'webhook'],
        ],
      );
      assert.deepEqual(namespaces, ['webhooks']);
    } finally {
      await run.close();
    }
  });

  it('claims deliveries in the cache namespace it is given', async () => {
    const { namespaces } = await serveWebhooks(
      { cache: 'inbound', endpoints: [ENDPOINT] },
      claimStore(),
    );
    assert.deepEqual(namespaces, ['inbound']);
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
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, 'invalid_signature');
  });

  it('rejects a replay with 409', async () => {
    const app = await mount();
    const request = signedRequest();
    assert.equal((await app.request(request)).status, 200);
    const replay = await app.request(signedRequest());
    assert.equal(replay.status, 409);
    const body = (await replay.json()) as { code: string };
    assert.equal(body.code, 'replayed');
  });

  it('rejects a non-JSON body with 400 after verification', async () => {
    const app = await mount();
    const response = await app.request(signedRequest('not json'));
    assert.equal(response.status, 400);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, 'invalid_payload');
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
    const cache = claimStore();
    const app = await mount({}, cache);
    assert.equal((await app.request(signedRequest('not json'))).status, 400);
    assert.deepEqual(cache.adds, []);
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
    const cache = claimStore();
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
    const cache = claimStore();
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
