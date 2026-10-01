/**
 * Adapter credential and transport settings: an explicit apiKey or an
 * injected client (never both), base URL rules, retry and timeout bounds,
 * the client shape check, and draining a stream into its final response.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AiError } from '../../src/errors/ai-error.js';
import {
  collectResponse,
  hasMethod,
  readBaseUrl,
  readClientSettings,
} from '../../src/provider/client-settings.js';

const isClient = (value: unknown): value is { run(): void } => hasMethod(value, ['run']);

function fails(fn: () => unknown, field: string): void {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof AiError);
    assert.equal(error.code, 'invalid_options');
    assert.deepEqual(error.context, { provider: 'p', field });
    return true;
  });
}

describe('readClientSettings', () => {
  it('reads owned settings with defaults', () => {
    assert.deepEqual(readClientSettings({ apiKey: 'k' }, 'p', 'https://api.test', isClient), {
      kind: 'owned',
      apiKey: 'k',
      baseURL: 'https://api.test',
      maxRetries: 2,
      timeoutMs: undefined,
      fetch: undefined,
    });
  });

  it('reads an injected client and refuses transport fields beside it', () => {
    const client = { run() {} };
    assert.deepEqual(readClientSettings({ client }, 'p', 'https://api.test', isClient), {
      kind: 'injected',
      client,
    });
    fails(() => readClientSettings({ client, apiKey: 'k' }, 'p', 'https://x', isClient), 'apiKey');
    for (const field of ['baseURL', 'maxRetries', 'timeoutMs', 'fetch']) {
      fails(() => readClientSettings({ client, [field]: 1 }, 'p', 'https://x', isClient), field);
    }
    fails(() => readClientSettings({ client: {} }, 'p', 'https://x', isClient), 'client');
  });

  it('refuses a missing key and out-of-range transport values', () => {
    let missing: unknown;
    try {
      readClientSettings({}, 'p', 'https://x', isClient);
    } catch (error) {
      missing = error;
    }
    assert.ok(missing instanceof AiError);
    assert.equal(missing.code, 'invalid_options');
    assert.equal(missing.context.field, 'apiKey');
    assert.ok(missing.suggestion !== undefined);
    fails(
      () => readClientSettings({ apiKey: 'k', maxRetries: 11 }, 'p', 'https://x', isClient),
      'maxRetries',
    );
    fails(
      () => readClientSettings({ apiKey: 'k', timeoutMs: 0 }, 'p', 'https://x', isClient),
      'timeoutMs',
    );
    fails(
      () => readClientSettings({ apiKey: 'k', fetch: 'f' }, 'p', 'https://x', isClient),
      'fetch',
    );
  });
});

describe('readBaseUrl', () => {
  it('accepts https and loopback http only, never credentials', () => {
    assert.equal(readBaseUrl('https://a.test/v1', 'd', 'p'), 'https://a.test/v1');
    assert.equal(readBaseUrl('http://localhost:8080', 'd', 'p'), 'http://localhost:8080');
    assert.equal(readBaseUrl('http://[::1]:8080', 'd', 'p'), 'http://[::1]:8080');
    assert.equal(readBaseUrl(undefined, 'd', 'p'), 'd');
    for (const bad of ['http://a.test', 'https://u:p@a.test', 'not a url', '', 5]) {
      fails(() => readBaseUrl(bad, 'd', 'p'), 'baseURL');
    }
  });
});

describe('collectResponse', () => {
  it('fails a stream with no response-end', async () => {
    await assert.rejects(
      collectResponse((async function* () {})()),
      (error) => error instanceof AiError && error.code === 'provider_failed',
    );
  });
});
