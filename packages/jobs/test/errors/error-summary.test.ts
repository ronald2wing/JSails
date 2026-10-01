/**
 * The failure summary: value-free by default (no message, no cause, frames
 * only, and only after an exact header match), classified by the kernel's
 * kinds and retry column, total for any thrown value, and with the opt-in
 * message capped.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { JsailsError } from 'jsails/errors';
import { z } from 'zod';

import {
  isJobErrorSummary,
  MAX_SUMMARY_FRAME_LENGTH,
  MAX_SUMMARY_FRAMES,
  MAX_SUMMARY_MESSAGE_LENGTH,
  runtimeSummary,
  summarizeJobError,
} from '../../src/errors/error-summary.js';
import { JobsErrors } from '../../src/errors/jobs-errors.js';

const MARKER = 'MARKER-5d1e';
const DEFAULTS = { storeMessages: false } as const;
const FRAME = /^\s+at /;

class PaymentDeclinedError extends Error {
  override readonly name = 'PaymentDeclinedError';
}

class HandWrittenError extends JsailsError {
  readonly code = 'not a code';
}

function framesOnly(stack: string | undefined): void {
  assert.ok(stack !== undefined, 'the stack was dropped');
  for (const line of stack.split('\n')) assert.match(line, FRAME);
}

describe('summarizeJobError', () => {
  test('a foreign error is internal and retryable, with frames and no message', () => {
    const { summary, retryable } = summarizeJobError(
      new Error(`pay ${MARKER}`, { cause: new Error(MARKER) }),
      DEFAULTS,
    );
    assert.equal(JSON.stringify(summary).includes(MARKER), false);
    assert.deepEqual(
      { code: summary.code, kind: summary.kind, name: summary.name, message: summary.message },
      { code: 'errors.internal', kind: 'internal', name: 'Error', message: undefined },
    );
    assert.equal(retryable, true);
    framesOnly(summary.stack);
    assert.equal(Object.isFrozen(summary), true);
    assert.equal(isJobErrorSummary(summary), true);
  });

  test('a forged frame line inside a multi-line message is skipped with the header', () => {
    const { summary } = summarizeJobError(
      new Error(`declined\n    at ${MARKER} (evil.js:1:1)\nmore ${MARKER}`),
      DEFAULTS,
    );
    assert.equal(JSON.stringify(summary).includes(MARKER), false);
    framesOnly(summary.stack);
  });

  test('a stack whose header no longer matches its message is dropped', () => {
    const error = new Error(`first ${MARKER}`);
    assert.ok(error.stack?.includes(MARKER));
    error.message = 'changed';
    const { summary } = summarizeJobError(error, DEFAULTS);
    assert.equal(summary.stack, undefined);
    assert.equal(JSON.stringify(summary).includes(MARKER), false);
  });

  test('a class name is kept; a token-shaped or non-string name reads Error', () => {
    assert.equal(
      summarizeJobError(new PaymentDeclinedError('x'), DEFAULTS).summary.name,
      'PaymentDeclinedError',
    );
    const token = new Error('x');
    token.name = 'sk_live_MARKER';
    const tokenSummary = summarizeJobError(token, DEFAULTS).summary;
    assert.equal(tokenSummary.name, 'Error');
    framesOnly(tokenSummary.stack);
    const odd = new Error('x');
    (odd as unknown as { name: unknown }).name = 42;
    assert.equal(summarizeJobError(odd, DEFAULTS).summary.name, 'Error');
  });

  test('a registry error keeps its code and kind; invalid is not retried', () => {
    const { summary, retryable } = summarizeJobError(
      new JobsErrors.Error('invalid_payload'),
      DEFAULTS,
    );
    assert.deepEqual(
      [summary.code, summary.kind, summary.name],
      ['jobs.invalid_payload', 'invalid', 'JobsError'],
    );
    assert.equal(retryable, false);
  });

  test('foreign errors are classified by the kernel translators', () => {
    const parsed = z.object({ id: z.number() }).safeParse({ id: MARKER });
    assert.equal(parsed.success, false);
    const zod = summarizeJobError(parsed.error, DEFAULTS);
    assert.deepEqual(
      [zod.summary.code, zod.summary.kind, zod.retryable],
      ['request.invalid', 'invalid', false],
    );
    assert.equal(JSON.stringify(zod.summary).includes(MARKER), false);
    const aborted = summarizeJobError(new DOMException('gone', 'AbortError'), DEFAULTS);
    assert.deepEqual([aborted.summary.kind, aborted.retryable], ['aborted', true]);
    const timedOut = summarizeJobError(new DOMException('slow', 'TimeoutError'), DEFAULTS);
    assert.deepEqual([timedOut.summary.kind, timedOut.retryable], ['timeout', true]);
  });

  test('a hand-written framework error with a malformed code keeps no code', () => {
    const { summary } = summarizeJobError(new HandWrittenError('x'), DEFAULTS);
    assert.equal(summary.code, undefined);
    assert.equal(summary.kind, 'internal');
  });

  test('any thrown value is summarized without throwing', () => {
    const hostile = {
      get stack(): string {
        throw new Error(MARKER);
      },
      get name(): string {
        throw new Error(MARKER);
      },
      get message(): string {
        throw new Error(MARKER);
      },
    };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const thrown of [MARKER, null, 42, undefined, hostile, revoked.proxy]) {
      const { summary, retryable } = summarizeJobError(thrown, { storeMessages: false });
      assert.equal(summary.kind, 'internal');
      assert.equal(summary.name, 'Error');
      assert.equal(retryable, true);
      assert.equal(JSON.stringify(summary).includes(MARKER), false);
      assert.equal(isJobErrorSummary(summary), true);
    }
  });

  test('with storeMessages the message is kept and capped; the stack stays frames only', () => {
    const { summary } = summarizeJobError(
      new Error(`${MARKER}\n    at ${MARKER} ${'x'.repeat(2_000)}`),
      { storeMessages: true },
    );
    assert.ok(summary.message?.startsWith(MARKER));
    assert.equal(summary.message?.length, MAX_SUMMARY_MESSAGE_LENGTH);
    assert.equal(summary.stack?.includes(MARKER), false);
    framesOnly(summary.stack);
    assert.equal(
      summarizeJobError(`thrown ${MARKER}`, { storeMessages: true }).summary.message,
      `thrown ${MARKER}`,
    );
    assert.equal(
      summarizeJobError(new Error('x', { cause: new Error(MARKER) }), { storeMessages: true })
        .summary.message,
      'x',
    );
  });

  test('frames are capped in count and in length', () => {
    const error = new Error('deep');
    const frames = Array.from(
      { length: 40 },
      (_, index) => `    at f${index} (${'p'.repeat(1_000)}.js:1:1)`,
    );
    Object.defineProperty(error, 'stack', { value: ['Error: deep', ...frames].join('\n') });
    const stack = summarizeJobError(error, DEFAULTS).summary.stack;
    const lines = stack?.split('\n') ?? [];
    assert.equal(lines.length, MAX_SUMMARY_FRAMES);
    assert.ok(lines.every((line) => line.length <= MAX_SUMMARY_FRAME_LENGTH));
  });

  test('a Node error stack with its code in the header keeps its frames', () => {
    const error = Object.assign(new Error('boom'), { code: 'ERR_TEST_CODE' });
    Object.defineProperty(error, 'stack', {
      value: 'Error [ERR_TEST_CODE]: boom\n    at here (file.js:1:1)',
    });
    assert.equal(summarizeJobError(error, DEFAULTS).summary.stack, '    at here (file.js:1:1)');
  });
});

describe('runtimeSummary and isJobErrorSummary', () => {
  test('a runtime summary names its code and kind and carries no stack', () => {
    assert.deepEqual(runtimeSummary('attempt_timeout'), {
      code: 'jobs.attempt_timeout',
      kind: 'timeout',
      name: 'JobsError',
    });
  });

  test('only the known fields within their bounds pass', () => {
    const base = { kind: 'internal', name: 'Error' };
    assert.equal(isJobErrorSummary(base), true);
    for (const bad of [
      null,
      [],
      { name: 'Error' },
      { ...base, kind: 'handler' },
      { ...base, name: 'not a name' },
      { ...base, code: 'Not.A.Code' },
      { ...base, code: `a.${'b'.repeat(200)}` },
      { ...base, stack: 1 },
      { ...base, stack: 'x'.repeat(16_385) },
      { ...base, message: 'x'.repeat(1_001) },
      { ...base, extra: true },
    ]) {
      assert.equal(isJobErrorSummary(bad), false, JSON.stringify(bad)?.slice(0, 60));
    }
  });
});
