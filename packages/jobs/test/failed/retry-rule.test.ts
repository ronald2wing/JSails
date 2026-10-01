/**
 * The retry rule: a chain step whose catch fired is retried only when
 * forced, a stored value that is not an envelope is never retried, and an
 * envelope of a newer release is left to the workers that read it.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { JOB_ENVELOPE_VERSION } from '../../src/contract/index.js';
import { buildEnvelope } from '../../src/envelope/codec.js';
import { retryRefusal } from '../../src/failed/retry-rule.js';

function stored(flow?: Parameters<typeof buildEnvelope>[0]['flow']): unknown {
  return JSON.parse(
    JSON.stringify(
      buildEnvelope({
        name: 'job',
        payload: null,
        options: {},
        dispatchedAt: 0,
        ...(flow === undefined ? {} : { flow }),
      }),
    ),
  );
}

describe('retryRefusal', () => {
  test('a plain job, a batch child and a chain step without a fired catch are retried', () => {
    assert.equal(retryRefusal(stored(), false), undefined);
    assert.equal(retryRefusal(stored({ kind: 'batch', id: 'b', index: 0 }), false), undefined);
    assert.equal(
      retryRefusal(stored({ kind: 'chain', id: 'c', step: 0, next: [] }), false),
      undefined,
    );
  });

  test('a chain step whose catch fired needs force', () => {
    const fired = stored({ kind: 'chain', id: 'c', step: 1, next: [], catchFired: true });
    assert.equal(retryRefusal(fired, false), 'not_retryable');
    assert.equal(retryRefusal(fired, true), undefined);
  });

  test('a malformed value is not retryable; a newer envelope is', () => {
    assert.equal(retryRefusal({ v: JOB_ENVELOPE_VERSION, name: '' }, true), 'not_retryable');
    assert.equal(retryRefusal({ v: JOB_ENVELOPE_VERSION + 1 }, false), undefined);
  });
});
