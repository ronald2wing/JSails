/**
 * SDK error mapping by shape: the status table, in-stream error types,
 * connection failures, aborts, retry-after parsing, and that no provider
 * message is ever copied into the mapped error.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AiError } from '../../src/errors/ai-error.js';
import { mapApiError, readApiErrorFacts, readRetryAfterMs } from '../../src/provider/api-error.js';

const never = (): boolean => false;
const always = (): boolean => true;

class APIError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly error: unknown,
    readonly headers?: Headers,
  ) {
    super('canary provider text');
  }
}

describe('mapApiError', () => {
  it('maps HTTP statuses', () => {
    const table: [number, boolean, string][] = [
      [429, false, 'rate_limited'],
      [500, false, 'provider_unavailable'],
      [529, false, 'provider_unavailable'],
      [408, false, 'provider_unavailable'],
      [409, false, 'provider_unavailable'],
      [401, false, 'provider_auth'],
      [403, false, 'provider_auth'],
      [400, true, 'context_length_exceeded'],
      [413, true, 'context_length_exceeded'],
      [422, true, 'context_length_exceeded'],
      [400, false, 'provider_rejected'],
      [404, true, 'provider_rejected'],
    ];
    for (const [status, contextLength, code] of table) {
      const error = mapApiError(
        new APIError(status, {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'canary' },
        }),
        undefined,
        contextLength ? always : never,
      );
      assert.equal(error.code, code, `${status}`);
      assert.deepEqual(error.context, { status, type: 'invalid_request_error' });
      assert.equal(JSON.stringify(error).includes('canary'), false);
      assert.equal(error.message.includes('canary'), false);
    }
  });

  it('maps an account out of credit to provider_rejected, never rate_limited', () => {
    const quota = mapApiError(
      new APIError(
        429,
        {
          message: 'You exceeded your current quota, canary',
          type: 'insufficient_quota',
          code: 'insufficient_quota',
        },
        new Headers({ 'retry-after': '20' }),
      ),
      undefined,
      never,
    );
    assert.equal(quota.code, 'provider_rejected');
    assert.equal(quota.retryAfterMs, undefined);
    assert.deepEqual(quota.context, { status: 429, reason: 'billing' });
    assert.equal(JSON.stringify(quota).includes('canary'), false);

    const codeOnly = mapApiError(
      new APIError(429, { type: 'requests', code: 'insufficient_quota' }),
      undefined,
      never,
    );
    assert.equal(codeOnly.code, 'provider_rejected');
    assert.equal(codeOnly.context.reason, 'billing');

    const anthropic = mapApiError(
      new APIError(400, { type: 'error', error: { type: 'billing_error', message: 'canary' } }),
      undefined,
      never,
    );
    assert.deepEqual(anthropic.context, { status: 400, type: 'billing_error', reason: 'billing' });

    const inStream = mapApiError(
      new APIError(undefined, { error: { type: 'insufficient_quota' } }),
      undefined,
      never,
    );
    assert.equal(inStream.code, 'provider_rejected');
    assert.equal(inStream.context.reason, 'billing');

    const plainLimit = mapApiError(
      new APIError(429, { type: 'requests', code: 'rate_limit_exceeded' }),
      undefined,
      never,
    );
    assert.equal(plainLimit.code, 'rate_limited');
  });

  it('maps in-stream error types when there is no status', () => {
    const table: [string, boolean, string][] = [
      ['overloaded_error', false, 'provider_unavailable'],
      ['api_error', false, 'provider_unavailable'],
      ['server_error', false, 'provider_unavailable'],
      ['rate_limit_error', false, 'rate_limited'],
      ['rate_limit_exceeded', false, 'rate_limited'],
      ['authentication_error', false, 'provider_auth'],
      ['invalid_request_error', true, 'context_length_exceeded'],
      ['invalid_request_error', false, 'provider_rejected'],
      ['mystery_error', false, 'provider_failed'],
    ];
    for (const [type, contextLength, code] of table) {
      const error = mapApiError(
        new APIError(undefined, { error: { type } }),
        undefined,
        contextLength ? always : never,
      );
      assert.equal(error.code, code, type);
    }
    assert.deepEqual(
      mapApiError(new APIError(undefined, { error: { type: 'server_error' } }), undefined, never)
        .context,
      {},
    );
  });

  it('maps connection failures, timeouts, and aborts by class name', () => {
    const named = (name: string): Error => Object.assign(new Error('x'), { name });
    assert.deepEqual(mapApiError(named('APIConnectionError'), undefined, never).context, {
      reason: 'connection',
    });
    assert.deepEqual(mapApiError(named('APIConnectionTimeoutError'), undefined, never).context, {
      reason: 'timeout',
    });
    assert.equal(mapApiError(named('APIUserAbortError'), undefined, never).code, 'aborted');
    assert.equal(mapApiError(named('AbortError'), undefined, never).code, 'aborted');
    class APIConnectionError extends Error {}
    assert.equal(
      mapApiError(new APIConnectionError('x'), undefined, never).code,
      'provider_unavailable',
    );
  });

  it('reports an aborted signal as aborted and passes an AiError through', () => {
    const controller = new AbortController();
    controller.abort();
    assert.equal(mapApiError(new APIError(500, {}), controller.signal, never).code, 'aborted');
    const original = new AiError('invalid_tool', 'x');
    assert.equal(mapApiError(original, controller.signal, never), original);
    assert.equal(mapApiError('string', undefined, never).code, 'provider_failed');
  });

  it('carries the retry-after wait of a rate limit', () => {
    const error = mapApiError(
      new APIError(429, {}, new Headers({ 'retry-after': '2' })),
      undefined,
      never,
    );
    assert.equal(error.retryAfterMs, 2000);
  });
});

describe('readApiErrorFacts', () => {
  it('reads the Anthropic body and the OpenAI inner error', () => {
    assert.deepEqual(
      readApiErrorFacts(new APIError(400, { type: 'error', error: { type: 't', message: 'm' } })),
      {
        status: 400,
        type: 't',
        code: undefined,
        message: 'm',
      },
    );
    assert.deepEqual(
      readApiErrorFacts(
        Object.assign(new APIError(400, { message: 'm2', code: 'c' }), {
          type: 'invalid_request_error',
        }),
      ),
      { status: 400, type: 'invalid_request_error', code: 'c', message: 'm2' },
    );
  });
});

describe('readRetryAfterMs', () => {
  it('reads milliseconds, seconds, and HTTP dates', () => {
    assert.equal(readRetryAfterMs(new Headers({ 'retry-after-ms': '12.2' })), 13);
    assert.equal(readRetryAfterMs(new Headers({ 'retry-after': '1.5' })), 1500);
    const now = Date.parse('Wed, 18 Nov 2026 10:00:00 GMT');
    assert.equal(
      readRetryAfterMs(new Headers({ 'retry-after': 'Wed, 18 Nov 2026 10:00:03 GMT' }), now),
      3000,
    );
    assert.equal(
      readRetryAfterMs(new Headers({ 'retry-after': 'Wed, 18 Nov 2026 09:00:00 GMT' }), now),
      0,
    );
    assert.equal(readRetryAfterMs(new Headers({ 'retry-after': 'soon' })), undefined);
    assert.equal(readRetryAfterMs(new Headers()), undefined);
    assert.equal(readRetryAfterMs({}), undefined);
    assert.equal(readRetryAfterMs(undefined), undefined);
  });
});
