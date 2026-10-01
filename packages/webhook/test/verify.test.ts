/**
 * Tests for request verification: the header, the timestamp, the HMAC, and the
 * replay claim, in that order.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import type { CacheStore } from 'jsails/cache';

import { WebhookError } from '../src/errors.js';
import { computeSignature, computeSignatureBytes } from '../src/signature.js';
import { githubVerifier, stripeVerifier } from '../src/verifiers.js';
import {
  DEFAULT_UNTIMED_REPLAY_WINDOW_SECONDS,
  verifyWebhookRequest,
  verifyWebhookSignature,
} from '../src/verify.js';
import { claimStore } from './claim-store.js';

const SECRET = 'shhh';
const ID = 'stripe';
const BODY = '{"event":"paid"}';
const NOW = 1_700_000_000;

/** A request signed at `timestamp` with `secret`. */
function signedRequest(
  options: { timestamp?: number; secret?: string; body?: string; id?: string } = {},
): Request {
  const timestamp = options.timestamp ?? NOW;
  const body = options.body ?? BODY;
  const signature = computeSignature(options.id ?? ID, timestamp, body, options.secret ?? SECRET);
  return new Request('https://example.test/webhooks/stripe', {
    method: 'POST',
    headers: { 'x-webhook-signature': `t=${timestamp},v1=${signature}` },
    body,
  });
}

function options(cache: CacheStore) {
  return { endpointId: ID, secret: SECRET, cache, nowSeconds: NOW, toleranceSeconds: 300 };
}

describe('verifyWebhookRequest', () => {
  it('returns the raw body and timestamp for a valid request', async () => {
    const verified = await verifyWebhookRequest(signedRequest(), options(claimStore()));
    assert.equal(verified.endpointId, ID);
    assert.equal(verified.rawBody, BODY);
    assert.equal(verified.timestamp, NOW);
    assert.match(verified.replayKey, /^webhook:stripe:[0-9a-f]{64}$/);
  });

  it('rejects a missing signature header', async () => {
    const request = new Request('https://example.test/webhooks/stripe', {
      method: 'POST',
      body: BODY,
    });
    await assert.rejects(
      () => verifyWebhookRequest(request, options(claimStore())),
      (error: unknown) => error instanceof WebhookError && error.code === 'invalid_signature',
    );
  });

  it('rejects a stale timestamp', async () => {
    await assert.rejects(
      () => verifyWebhookRequest(signedRequest({ timestamp: NOW - 400 }), options(claimStore())),
      (error: unknown) =>
        error instanceof WebhookError && error.code === 'timestamp_out_of_tolerance',
    );
  });

  it('rejects a wrong secret', async () => {
    await assert.rejects(
      () => verifyWebhookRequest(signedRequest({ secret: 'other' }), options(claimStore())),
      (error: unknown) => error instanceof WebhookError && error.code === 'invalid_signature',
    );
  });

  it('rejects a tampered body', async () => {
    const request = signedRequest();
    const tampered = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: '{"event":"refunded"}',
    });
    await assert.rejects(
      () => verifyWebhookRequest(tampered, options(claimStore())),
      (error: unknown) => error instanceof WebhookError && error.code === 'invalid_signature',
    );
  });

  it('rejects a replayed request', async () => {
    const cache = claimStore();
    await verifyWebhookRequest(signedRequest(), options(cache));
    await assert.rejects(
      () => verifyWebhookRequest(signedRequest(), options(cache)),
      (error: unknown) => error instanceof WebhookError && error.code === 'replayed',
    );
  });

  it('does not consume a replay slot for a request that fails the HMAC', async () => {
    const cache = claimStore();
    await assert.rejects(() =>
      verifyWebhookRequest(signedRequest({ secret: 'other' }), options(cache)),
    );
    // The correctly signed request is still the first claim.
    const verified = await verifyWebhookRequest(signedRequest(), options(cache));
    assert.equal(verified.endpointId, ID);
  });

  it('carries the endpoint id in the error context', async () => {
    await assert.rejects(
      () => verifyWebhookRequest(signedRequest({ secret: 'other' }), options(claimStore())),
      (error: unknown) => error instanceof WebhookError && error.context.endpoint === ID,
    );
  });

  it('rejects a stale request without reading the body', async () => {
    let read = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          read = true;
          controller.enqueue(new TextEncoder().encode(BODY));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const signature = computeSignature(ID, NOW - 3600, BODY, SECRET);
    const request = new Request('https://example.test/webhooks/stripe', {
      method: 'POST',
      headers: { 'x-webhook-signature': `t=${NOW - 3600},v1=${signature}` },
      body,
      duplex: 'half',
    } as RequestInit);
    await assert.rejects(
      verifyWebhookRequest(request, options(claimStore())),
      (error: unknown) =>
        error instanceof WebhookError && error.code === 'timestamp_out_of_tolerance',
    );
    assert.equal(read, false);
  });

  it('signs over the received bytes, not a re-encoded string', async () => {
    // 0xff is not valid UTF-8: decoding and re-encoding it would change the bytes.
    const bytes = new Uint8Array([0x7b, 0xff, 0x7d]);
    const signature = computeSignatureBytes(ID, NOW, bytes, SECRET);
    const request = new Request('https://example.test/webhooks/stripe', {
      method: 'POST',
      headers: { 'x-webhook-signature': `t=${NOW},v1=${signature}` },
      body: bytes,
    });
    const verified = await verifyWebhookRequest(request, options(claimStore()));
    assert.equal(verified.endpointId, ID);
  });

  it('keys the replay claim on the signed material, not the header candidates', async () => {
    const signature = createHmac('sha256', SECRET).update(`${NOW}.${BODY}`).digest('hex');
    const verify = (header: string) =>
      verifyWebhookSignature(
        new Request('https://example.test/webhooks/stripe', {
          method: 'POST',
          headers: { 'stripe-signature': header },
          body: BODY,
        }),
        { ...options(claimStore()), verifier: stripeVerifier },
      );
    const plain = await verify(`t=${NOW},v1=${signature}`);
    const padded = await verify(`t=${NOW},v1=${'ab'.repeat(32)},v1=${signature}`);
    assert.equal(padded.replayKey, plain.replayKey);
  });

  it('holds a timestamped claim for at least twice the tolerance', async () => {
    const verified = await verifyWebhookSignature(signedRequest(), {
      ...options(claimStore()),
      replayWindowSeconds: 10,
    });
    assert.equal(verified.replayWindowSeconds, 600);
  });

  it('refuses options whose windows no claim can hold before reading the request', async () => {
    const acme = { ...githubVerifier, name: 'acme', replayWindowSeconds: 400 * 86_400 };
    const misconfigured = [
      { toleranceSeconds: 200 * 86_400 },
      { toleranceSeconds: 0 },
      { replayWindowSeconds: 2 * 365 * 86_400 },
      { replayWindowSeconds: 3.0001 },
      { verifier: acme },
    ];
    for (const overrides of misconfigured) {
      const cache = claimStore();
      const request = signedRequest();
      await assert.rejects(
        () => verifyWebhookRequest(request, { ...options(cache), ...overrides }),
        (error: unknown) => error instanceof WebhookError && error.code === 'invalid_endpoint',
      );
      assert.equal(request.bodyUsed, false);
    }
  });

  it('holds an untimed claim for the long default window', async () => {
    const body = new TextEncoder().encode(BODY);
    const signature = createHmac('sha256', SECRET).update(body).digest('hex');
    const verified = await verifyWebhookSignature(
      new Request('https://example.test/webhooks/github', {
        method: 'POST',
        headers: { 'x-hub-signature-256': `sha256=${signature}` },
        body,
      }),
      { ...options(claimStore()), verifier: githubVerifier },
    );
    assert.equal(verified.timestamp, undefined);
    assert.equal(verified.replayWindowSeconds, DEFAULT_UNTIMED_REPLAY_WINDOW_SECONDS);
  });
});
