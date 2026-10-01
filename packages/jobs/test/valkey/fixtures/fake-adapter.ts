/**
 * A Valkey adapter built by `valkeyJobs` over a fake BullMQ backend
 * (`fake-bullmq.ts`), every failure it reports collected, envelopes for it,
 * and a matcher for its value-free errors: the setup every server-free test
 * of the transport starts from.
 */

import assert from 'node:assert/strict';

import type { JobEnvelope } from '../../../src/contract/index.js';
import { buildEnvelope, type EnvelopeParts } from '../../../src/envelope/codec.js';
import { JobsErrors, type JobsErrorCode } from '../../../src/errors/jobs-errors.js';
import { defineQueues, type QueueOptions } from '../../../src/queues/queue-set.js';
import type { JobsClock } from '../../../src/timing/long-timer.js';
import { valkeyJobs, ValkeyJobsAdapter } from '../../../src/valkey/index.js';
import { fakeBackend, type FakeBackend } from '../fake-bullmq.js';

/** A built adapter, its backend, and what it reported. */
export interface FakeAdapter {
  readonly backend: FakeBackend;
  readonly adapter: ValkeyJobsAdapter;
  readonly reported: Error[];
}

/** The adapter options a test may set. */
export interface FakeAdapterOptions {
  readonly maxStalledCount?: number;
  readonly lockDurationMs?: number;
  readonly scheduleSyncMs?: number;
  readonly clock?: JobsClock;
  /** The backend to build on, set up beforehand; a fresh one by default. */
  readonly backend?: FakeBackend;
}

/** The adapter of namespace `app:test` declaring `queues` (plus `default`). */
export async function fakeAdapter(
  queues: Readonly<Record<string, QueueOptions>> = {},
  options: FakeAdapterOptions = {},
): Promise<FakeAdapter> {
  const { backend = fakeBackend(), ...adapterOptions } = options;
  const reported: Error[] = [];
  const adapter = await valkeyJobs({
    connections: backend.connections,
    ...adapterOptions,
    onError: (error) => reported.push(error),
    dependencies: { loadBullmq: () => Promise.resolve(backend.module) },
  })({ namespace: 'app:test', queues: defineQueues(queues).declarations });
  assert.ok(adapter instanceof ValkeyJobsAdapter);
  return { backend, adapter, reported };
}

/** An envelope of job `job`, dispatched now, with `overrides`. */
export function envelope(overrides: Partial<EnvelopeParts> = {}): JobEnvelope {
  return buildEnvelope({
    name: 'job',
    payload: null,
    options: {},
    dispatchedAt: Date.now(),
    ...overrides,
  });
}

/** An `assert.rejects`/`assert.throws` matcher for `jobs.<code>`, with `context` when given. */
export function refused(
  code: JobsErrorCode,
  context?: Readonly<Record<string, unknown>>,
): (error: unknown) => true {
  return (error) => {
    assert.ok(JobsErrors.is(error, code), `expected jobs.${code}, got ${String(error)}`);
    if (context !== undefined) assert.deepEqual({ ...error.context }, context);
    return true;
  };
}
