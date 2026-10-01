/**
 * The processor, driven directly: decode, skew releases with their backoff
 * and cap, payload re-validation, middleware order, single-use `next`, the
 * chain held until every part of it settled, error classification and
 * `onError`, timeouts and shutdowns told apart by the source that aborted,
 * the hold rule and the grace, totality, and cleanup of every timer.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { z } from 'zod';

import {
  JOB_ENVELOPE_VERSION,
  type AttemptOutcome,
  type JobEnvelope,
  type JobOptions,
  type TransportJob,
} from '../../src/contract/index.js';
import { createJobCatalog } from '../../src/definition/catalog.js';
import {
  defineJob,
  type JobContext,
  type JobDefinition,
  type JobDefinitionInput,
  type JobMiddleware,
} from '../../src/definition/define-job.js';
import type { Jobs } from '../../src/definition/jobs-service.js';
import { buildEnvelope } from '../../src/envelope/codec.js';
import { JobsErrors } from '../../src/errors/jobs-errors.js';
import { defineQueues } from '../../src/queues/queue-set.js';
import { createProcessor } from '../../src/runtime/processor.js';
import { flush, VirtualClock } from '../timing/virtual-clock.js';
import { unusedJobs } from './fixtures/unused-jobs.js';

const START = 1_700_000_000_000;
const GRACE_MS = 30_000;

const jobs: Jobs = unusedJobs;

class Ledger {
  held = 0;
  poisoned = 0;
  enter(): void {
    this.held += 1;
  }
  leave(): void {
    this.held -= 1;
  }
  poison(): void {
    this.poisoned += 1;
  }
}

class HandlerError extends Error {
  override name = 'HandlerError';
}

class MiddlewareError extends Error {
  override name = 'MiddlewareError';
}

function job(
  input: Partial<JobDefinitionInput<string, z.ZodType, 'default'>> & {
    readonly handle: JobDefinitionInput<string, z.ZodType, 'default'>['handle'];
  },
): JobDefinition<string, z.ZodType, 'default'> {
  return defineJob({ name: 'work', schema: z.unknown(), ...input });
}

function setup(definitions: readonly JobDefinition<string, z.ZodType, 'default'>[]) {
  const clock = new VirtualClock(START);
  const ledger = new Ledger();
  const process = createProcessor({
    catalog: createJobCatalog({ queues: defineQueues({}), definitions }),
    jobs,
    transport: { capabilities: {} },
    clock,
    handlerGraceMs: GRACE_MS,
    storeErrorMessages: false,
    ledger,
  });
  return { clock, ledger, process };
}

function delivery(
  overrides: {
    readonly name?: string;
    readonly payload?: unknown;
    readonly options?: JobOptions;
    readonly attemptsMade?: number;
    readonly unknownReleases?: number;
    readonly envelope?: unknown;
    readonly tags?: readonly string[];
  } = {},
): TransportJob {
  const envelope =
    overrides.envelope ??
    buildEnvelope({
      name: overrides.name ?? 'work',
      payload: overrides.payload ?? null,
      options: overrides.options ?? {},
      ...(overrides.tags === undefined ? {} : { tags: overrides.tags }),
      dispatchedAt: START,
    });
  return {
    id: '7',
    queue: 'default',
    envelope: envelope as JobEnvelope,
    attemptsMade: overrides.attemptsMade ?? 0,
    unknownReleases: overrides.unknownReleases ?? 0,
  };
}

/** Whether `promise` is still pending after the queued reactions ran. */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol('pending');
  await flush();
  return (await Promise.race([promise, Promise.resolve(pending)])) === pending;
}

function failure(outcome: AttemptOutcome): { code?: string; kind: string; retryable: boolean } {
  assert.equal(outcome.kind, 'failed');
  return { code: outcome.error.code, kind: outcome.error.kind, retryable: outcome.retryable };
}

describe('processor', () => {
  test('a completed attempt runs middleware outermost first, with the attempt context', async () => {
    const order: string[] = [];
    let seen: JobContext | undefined;
    const { process, ledger, clock } = setup([
      job({
        middleware: [
          async (_context, next) => {
            order.push('outer');
            await next();
          },
          async (_context, next) => {
            order.push('inner');
            await next();
          },
        ],
        handle: (_payload, context) => {
          order.push('handler');
          seen = context;
        },
      }),
    ]);
    const outcome = await process(
      delivery({ attemptsMade: 2, tags: ['t'] }),
      new AbortController().signal,
    );
    assert.deepEqual(outcome, { kind: 'completed' });
    assert.deepEqual(order, ['outer', 'inner', 'handler']);
    assert.ok(seen !== undefined);
    assert.deepEqual(
      [seen.attempt, seen.jobId, seen.name, seen.actor],
      [3, '7', 'work', { kind: 'system', reason: 'job:work' }],
    );
    assert.equal(Object.isFrozen(seen), true);
    assert.equal(Object.isFrozen(seen.meta), true);
    assert.equal('context' in seen.meta, false);
    assert.deepEqual(seen.meta.tags, ['t']);
    assert.equal(seen.jobs, jobs);
    assert.equal(ledger.held, 0);
    assert.equal(clock.pending, 0);
  });

  test('a malformed envelope fails for good', async () => {
    const { process } = setup([job({ handle: () => undefined })]);
    const outcome = await process(
      delivery({ envelope: { v: JOB_ENVELOPE_VERSION, name: 'work' } }),
      new AbortController().signal,
    );
    assert.deepEqual(failure(outcome), {
      code: 'jobs.invalid_envelope',
      kind: 'invalid',
      retryable: false,
    });
  });

  test('a newer envelope or an unknown name is released with a growing delay, then failed', async () => {
    const { process } = setup([job({ handle: () => undefined })]);
    const signal = new AbortController().signal;
    const newer = {
      ...buildEnvelope({ name: 'work', payload: null, options: {}, dispatchedAt: 0 }),
      v: JOB_ENVELOPE_VERSION + 1,
    };
    for (const [unknownReleases, delayMs] of [
      [0, 500],
      [3, 4_000],
      [7, 60_000],
      [9, 60_000],
    ] as const) {
      for (const source of [
        delivery({ envelope: newer, unknownReleases }),
        delivery({ name: 'novel', unknownReleases }),
      ]) {
        assert.deepEqual(await process(source, signal), {
          kind: 'released',
          reason: 'unknown_job',
          delayMs,
        });
      }
    }
    assert.deepEqual(
      failure(await process(delivery({ name: 'novel', unknownReleases: 10 }), signal)),
      {
        code: 'jobs.unknown_job',
        kind: 'not_found',
        retryable: false,
      },
    );
  });

  test('a payload the worker schema refuses fails for good and never runs the handler', async () => {
    let ran = 0;
    const { process } = setup([
      job({
        schema: z.object({ id: z.number() }),
        handle: () => {
          ran += 1;
        },
      }),
    ]);
    const outcome = await process(delivery({ payload: { id: 'x' } }), new AbortController().signal);
    assert.deepEqual(failure(outcome), {
      code: 'jobs.invalid_payload',
      kind: 'invalid',
      retryable: false,
    });
    assert.equal(ran, 0);
  });

  test('a failure is classified by its kind; onError may discard it', async () => {
    const thrown: unknown[] = [];
    const { process } = setup([
      job({
        name: 'refused',
        handle: () => Promise.reject(new JobsErrors.Error('invalid_payload')),
      }),
      job({ name: 'broken', handle: () => Promise.reject(new Error('boom')) }),
      job({
        name: 'discarding',
        handle: () => Promise.reject(new Error('boom')),
        onError: (error) => {
          thrown.push(error);
          return 'discard';
        },
      }),
      job({
        name: 'throwing-policy',
        handle: () => Promise.reject(new Error('boom')),
        onError: () => {
          throw new Error('policy');
        },
      }),
      job({
        name: 'odd-policy',
        handle: () => Promise.reject(new Error('boom')),
        onError: () => 'retry' as never,
      }),
    ]);
    const signal = new AbortController().signal;
    assert.deepEqual(failure(await process(delivery({ name: 'refused' }), signal)), {
      code: 'jobs.invalid_payload',
      kind: 'invalid',
      retryable: false,
    });
    assert.deepEqual(failure(await process(delivery({ name: 'broken' }), signal)), {
      code: 'errors.internal',
      kind: 'internal',
      retryable: true,
    });
    const discarded = await process(delivery({ name: 'discarding' }), signal);
    assert.equal(discarded.kind, 'discarded');
    assert.equal(discarded.kind === 'discarded' && discarded.error.code, 'errors.internal');
    assert.ok(thrown[0] instanceof Error, 'onError sees the thrown value as is');
    assert.equal((await process(delivery({ name: 'throwing-policy' }), signal)).kind, 'failed');
    assert.equal((await process(delivery({ name: 'odd-policy' }), signal)).kind, 'failed');
  });

  test('a cooperative handler past its deadline fails as a retryable timeout', async () => {
    let reason: unknown;
    const { process, clock } = setup([
      job({
        handle: (_payload, context) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener('abort', () => {
              reason = context.signal.reason;
              reject(new Error('stopped'));
            });
          }),
      }),
    ]);
    const outcome = process(
      delivery({ options: { timeoutMs: 1_000 } }),
      new AbortController().signal,
    );
    await flush();
    await clock.advance(1_000);
    assert.deepEqual(failure(await outcome), {
      code: 'jobs.attempt_timeout',
      kind: 'timeout',
      retryable: true,
    });
    assert.ok(JobsErrors.is(reason, 'attempt_timeout'));
    assert.equal(clock.pending, 0);
  });

  test('a handler that resolves after its deadline completed; onError may discard a timeout', async () => {
    let finish: () => void = () => undefined;
    const { process, clock } = setup([
      job({ name: 'late', handle: () => new Promise<void>((resolve) => (finish = resolve)) }),
      job({
        name: 'discard-timeout',
        handle: (_payload, context) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(context.signal.reason));
          }),
        onError: (error) => (JobsErrors.is(error, 'attempt_timeout') ? 'discard' : undefined),
      }),
    ]);
    const late = process(
      delivery({ name: 'late', options: { timeoutMs: 100 } }),
      new AbortController().signal,
    );
    await flush();
    await clock.advance(100);
    assert.equal(await isPending(late), true);
    finish();
    assert.deepEqual(await late, { kind: 'completed' });
    const discarded = process(
      delivery({ name: 'discard-timeout', options: { timeoutMs: 100 } }),
      new AbortController().signal,
    );
    await flush();
    await clock.advance(100);
    const outcome = await discarded;
    assert.equal(outcome.kind, 'discarded');
    assert.equal(outcome.kind === 'discarded' && outcome.error.code, 'jobs.attempt_timeout');
    assert.equal(clock.pending, 0);
  });

  test('a shutdown is a release, not a failure; a handler that still resolves completed', async () => {
    let finish: () => void = () => undefined;
    let ran = 0;
    const { process } = setup([
      job({
        name: 'cooperative',
        handle: (_payload, context) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(context.signal.reason));
          }),
      }),
      job({ name: 'stubborn', handle: () => new Promise<void>((resolve) => (finish = resolve)) }),
      job({
        name: 'never',
        handle: () => {
          ran += 1;
        },
      }),
    ]);
    const first = new AbortController();
    const cooperative = process(delivery({ name: 'cooperative' }), first.signal);
    await flush();
    first.abort(new JobsErrors.Error('worker_aborted'));
    assert.deepEqual(await cooperative, { kind: 'released', reason: 'shutdown' });
    const second = new AbortController();
    const stubborn = process(delivery({ name: 'stubborn' }), second.signal);
    await flush();
    second.abort(new JobsErrors.Error('worker_aborted'));
    finish();
    assert.deepEqual(await stubborn, { kind: 'completed' });
    const aborted = new AbortController();
    aborted.abort();
    assert.deepEqual(await process(delivery({ name: 'never' }), aborted.signal), {
      kind: 'released',
      reason: 'shutdown',
    });
    assert.equal(ran, 0);
  });

  test('a middleware that calls next twice fails the attempt and runs the handler once', async () => {
    let ran = 0;
    const { process } = setup([
      job({
        middleware: [
          async (_context, next) => {
            await next();
            await next().catch(() => undefined);
          },
        ],
        handle: () => {
          ran += 1;
        },
      }),
    ]);
    assert.deepEqual(failure(await process(delivery(), new AbortController().signal)), {
      code: 'jobs.middleware_next_reused',
      kind: 'internal',
      retryable: true,
    });
    assert.equal(ran, 1);
  });

  test('a second next() left unawaited fails the attempt without an unhandled rejection', async () => {
    let ran = 0;
    const { process } = setup([
      job({
        middleware: [
          async (_context, next) => {
            await next();
            // Dropped on purpose: the refusal must not surface as an unhandled rejection.
            const dropped = next();
            assert.ok(dropped instanceof Promise);
          },
        ],
        handle: () => {
          ran += 1;
        },
      }),
    ]);
    assert.deepEqual(failure(await process(delivery(), new AbortController().signal)), {
      code: 'jobs.middleware_next_reused',
      kind: 'internal',
      retryable: true,
    });
    assert.equal(ran, 1);
    await flush();
  });

  test('a middleware that drops next() holds the attempt until the handler settles, and reports its failure', async () => {
    let fail: (error: Error) => void = () => undefined;
    const { process, ledger } = setup([
      job({
        middleware: [
          async (_context, next) => {
            // Neither awaited nor returned: the chain must still wait for it.
            const dropped = next();
            assert.ok(dropped instanceof Promise);
          },
        ],
        handle: () =>
          new Promise<void>((_resolve, reject) => {
            fail = reject;
          }),
      }),
    ]);
    const outcome = process(delivery(), new AbortController().signal);
    assert.equal(await isPending(outcome), true, 'the attempt ended while its handler ran');
    assert.equal(ledger.held, 1);
    fail(new HandlerError());
    const settled = await outcome;
    assert.equal(settled.kind, 'failed');
    assert.equal(settled.kind === 'failed' && settled.error.name, 'HandlerError');
    assert.equal(ledger.held, 0);
  });

  test('a handler behind a dropped next() stays under the grace rule and completes when it resolves', async () => {
    let finish: () => void = () => undefined;
    const { process, clock, ledger } = setup([
      job({
        middleware: [
          async (_context, next) => {
            const dropped = next();
            assert.ok(dropped instanceof Promise);
          },
        ],
        handle: () => new Promise<void>((resolve) => (finish = resolve)),
      }),
    ]);
    const controller = new AbortController();
    const outcome = process(delivery(), controller.signal);
    await flush();
    controller.abort(new JobsErrors.Error('worker_aborted'));
    await flush();
    await clock.advance(GRACE_MS);
    assert.equal(ledger.poisoned, 1, 'the stuck handler escaped the grace');
    assert.equal(await isPending(outcome), true);
    finish();
    assert.deepEqual(await outcome, { kind: 'completed' });
    assert.equal(ledger.held, 0);
    assert.equal(clock.pending, 0);
  });

  test('a failure further in is not lost to a middleware that resolves; one it throws replaces it', async () => {
    const swallowing = setup([
      job({
        middleware: [
          async (_context, next) => {
            await next().catch(() => undefined);
          },
        ],
        handle: () => {
          throw new HandlerError();
        },
      }),
    ]);
    const swallowed = await swallowing.process(delivery(), new AbortController().signal);
    assert.equal(swallowed.kind === 'failed' && swallowed.error.name, 'HandlerError');
    const replacing = setup([
      job({
        middleware: [
          async (_context, next) => {
            try {
              await next();
            } catch {
              throw new MiddlewareError();
            }
          },
        ],
        handle: () => {
          throw new HandlerError();
        },
      }),
    ]);
    const replaced = await replacing.process(delivery(), new AbortController().signal);
    assert.equal(replaced.kind === 'failed' && replaced.error.name, 'MiddlewareError');
  });

  test('next() called after its middleware settled runs nothing and fails a running attempt', async () => {
    let ran = 0;
    let kept: (() => Promise<void>) | undefined;
    const keeping: JobMiddleware = async (_context, next) => {
      kept = next;
    };
    const handle = (): void => {
      ran += 1;
    };
    const after = setup([job({ middleware: [keeping], handle })]);
    assert.deepEqual(await after.process(delivery(), new AbortController().signal), {
      kind: 'completed',
    });
    await assert.rejects(kept?.() ?? Promise.resolve(), (error: unknown) =>
      JobsErrors.is(error, 'middleware_next_late'),
    );
    const during = setup([
      job({
        middleware: [
          async (_context, next) => {
            await next();
            const late = kept?.();
            assert.ok(late instanceof Promise);
          },
          keeping,
        ],
        handle,
      }),
    ]);
    assert.deepEqual(failure(await during.process(delivery(), new AbortController().signal)), {
      code: 'jobs.middleware_next_late',
      kind: 'internal',
      retryable: true,
    });
    assert.equal(ran, 0);
    await flush();
  });

  test('an abandoned attempt is held until its code settles; past the grace the worker is poisoned', async () => {
    let finish: () => void = () => undefined;
    const { process, clock, ledger } = setup([
      job({ handle: () => new Promise<void>((resolve) => (finish = resolve)) }),
    ]);
    const controller = new AbortController();
    const outcome = process(delivery(), controller.signal);
    await flush();
    controller.abort(new JobsErrors.Error('worker_aborted'));
    await flush();
    await clock.advance(GRACE_MS - 1);
    assert.equal(await isPending(outcome), true, 'the attempt resolved before its code settled');
    assert.equal(ledger.poisoned, 0);
    assert.equal(ledger.held, 1);
    await clock.advance(1);
    assert.equal(ledger.poisoned, 1);
    await clock.advance(GRACE_MS);
    assert.equal(ledger.poisoned, 1);
    assert.equal(await isPending(outcome), true, 'poisoning resolved the stuck attempt');
    finish();
    assert.deepEqual(await outcome, { kind: 'completed' });
    assert.equal(ledger.held, 0);
    assert.equal(clock.pending, 0);
  });

  test('a handler that throws synchronously fails the attempt', async () => {
    const { process } = setup([
      job({
        handle: () => {
          throw new Error('sync');
        },
      }),
    ]);
    assert.equal((await process(delivery(), new AbortController().signal)).kind, 'failed');
  });
});
