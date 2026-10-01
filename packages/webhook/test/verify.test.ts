/**
 * Tests for request verification: the header, the timestamp, the HMAC, and the
 * replay claim, in that order.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CacheStore } from 'jsails/cache';

import { WebhookError } from '../src/errors.js';
import { computeSignature } from '../src/signature.js';
import { verifyWebhookRequest } from '../src/verify.js';

const SECRET = 'shhh';
const ID = 'stripe';
const BODY = '{"event":"paid"}';
const NOW = 1_700_000_000;

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
    const verified = await verifyWebhookRequest(signedRequest(), options(countingStore()));
    assert.deepEqual(verified, { endpointId: ID, rawBody: BODY, timestamp: NOW });
  });

  it('rejects a missing signature header', async () => {
    const request = new Request('https://example.test/webhooks/stripe', {
      method: 'POST',
      body: BODY,
    });
    await assert.rejects(
      () => verifyWebhookRequest(request, options(countingStore())),
      (error: unknown) => error instanceof WebhookError && error.code === 'invalid_signature',
    );
  });

  it('rejects a stale timestamp', async () => {
    await assert.rejects(
      () => verifyWebhookRequest(signedRequest({ timestamp: NOW - 400 }), options(countingStore())),
      (error: unknown) =>
        error instanceof WebhookError && error.code === 'timestamp_out_of_tolerance',
    );
  });

  it('rejects a wrong secret', async () => {
    await assert.rejects(
      () => verifyWebhookRequest(signedRequest({ secret: 'other' }), options(countingStore())),
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
      () => verifyWebhookRequest(tampered, options(countingStore())),
      (error: unknown) => error instanceof WebhookError && error.code === 'invalid_signature',
    );
  });

  it('rejects a replayed request', async () => {
    const cache = countingStore();
    await verifyWebhookRequest(signedRequest(), options(cache));
    await assert.rejects(
      () => verifyWebhookRequest(signedRequest(), options(cache)),
      (error: unknown) => error instanceof WebhookError && error.code === 'replayed',
    );
  });

  it('does not consume a replay slot for a request that fails the HMAC', async () => {
    const cache = countingStore();
    await assert.rejects(() =>
      verifyWebhookRequest(signedRequest({ secret: 'other' }), options(cache)),
    );
    // The correctly signed request is still the first claim.
    const verified = await verifyWebhookRequest(signedRequest(), options(cache));
    assert.equal(verified.endpointId, ID);
  });

  it('carries the endpoint id in the error context', async () => {
    await assert.rejects(
      () => verifyWebhookRequest(signedRequest({ secret: 'other' }), options(countingStore())),
      (error: unknown) => error instanceof WebhookError && error.context.endpoint === ID,
    );
  });
});
