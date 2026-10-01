/**
 * Audit regressions for inbound webhooks (CNT-01): each test states the
 * correct behaviour for one audited defect. Those that fail today are listed,
 * with the failure they show, in `scripts/expected-failures/content.json`.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { Hono } from 'hono';
import type { CacheStore } from 'jsails/cache';
import { runExtensions, type HttpExtensionHook } from 'jsails/extensions';
import { auditCase, settlesWithin } from 'jsails/testing';

import { webhookPlugin, type WebhookEndpoint } from '../src/plugin.js';
import { computeSignature } from '../src/signature.js';
import { slackVerifier } from '../src/verifiers.js';

type TestAppEnv = Parameters<HttpExtensionHook>[0] extends Hono<infer E> ? E : never;

const SECRET = 'audit-secret';

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

async function mount(endpoint: WebhookEndpoint): Promise<Hono<TestAppEnv>> {
  const plugin = webhookPlugin({ cache: countingStore(), endpoints: [endpoint] });
  const runtime = await runExtensions([plugin]);
  const app = new Hono<TestAppEnv>();
  for (const hook of runtime.httpHooks) await hook(app);
  return app;
}

test(
  ...auditCase(
    'webhook/form-encoded-body',
    'a verified form-encoded delivery (Slack commands) reaches the handler',
  ),
  async () => {
    const received: unknown[] = [];
    const app = await mount({
      id: 'slack',
      path: '/webhooks/slack',
      secret: SECRET,
      verifier: slackVerifier,
      onEvent: (_verified, body) => {
        received.push(body);
      },
    });
    const body = 'command=%2Fdeploy&text=production&user_id=U1';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', SECRET).update(`v0:${timestamp}:${body}`).digest('hex');
    const response = await app.request('https://example.test/webhooks/slack', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': `v0=${signature}`,
      },
      body,
    });
    assert.equal(response.status, 200, 'a correctly signed form-encoded delivery was refused');
    assert.equal(received.length, 1);
  },
);

test(
  ...auditCase(
    'webhook/acknowledge-before-processing',
    'a delivery is acknowledged once stored, without waiting for its handler',
  ),
  async () => {
    let release: () => void = () => undefined;
    const handlerDone = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = await mount({
      id: 'audit',
      path: '/webhooks/audit',
      secret: SECRET,
      onEvent: () => handlerDone,
    });
    const body = '{"event":"paid"}';
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = computeSignature('audit', timestamp, body, SECRET);
    try {
      const response = await settlesWithin(
        Promise.resolve(
          app.request('https://example.test/webhooks/audit', {
            method: 'POST',
            headers: { 'x-webhook-signature': `t=${timestamp},v1=${signature}` },
            body,
          }),
        ),
        1000,
        'the response to a delivery whose handler is still running',
      );
      assert.ok(response.status >= 200 && response.status < 300);
    } finally {
      release();
    }
  },
);
