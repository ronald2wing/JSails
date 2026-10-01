/**
 * Tests for overlap control middleware: lease-backed prevention of concurrent
 * scheduled job runs via the per-job middleware seam.
 *
 * All tests run against the same fake in-memory adapter as the chain and
 * batch tests, so no Redis/Valkey or BullMQ connection is opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { withLease, type LeaseStore } from '../../src/cache/lease.js';
import { MemoryJobsAdapter } from '../../src/jobs/memory-adapter.js';
import { createJobRegistry, defineJob } from '../../src/jobs/registry.js';
import {
  JobsRuntimeImpl,
  type JobDispatchOptions,
  type JobsRuntimeAdapter,
  type ProcessJob,
  type RuntimeJob,
  type RuntimeProducer,
} from '../../src/jobs/runtime.js';
import type { JobMiddlewareContext } from '../../src/jobs/middleware.js';
import { OVERLAP_OPTION_KEY } from '../../src/jobs/option-keys.js';
import { createOverlapMiddleware } from '../../src/jobs/overlap.js';
import { isOverlapDescriptor } from '../../src/jobs/scheduler.js';
import { MapLeaseStore } from '../cache/map-cache-store.js';

/** A lease store whose release always rejects. */
class ReleaseFailingLeaseStore extends MapLeaseStore {
  override async release(): Promise<boolean> {
    throw new Error('release failed');
  }
}

// ---------------------------------------------------------------------------
// Fake adapter (same pattern as chain.test.ts and batch.test.ts)
// ---------------------------------------------------------------------------

interface FakeState {
  producerCreates: number;
  workerCreates: number;
  dispatched: Array<{ name: string; data: unknown; options: JobDispatchOptions }>;
  processJob: ProcessJob | undefined;
  handlerCalls: string[];
}

function fakeAdapter(): { adapter: JobsRuntimeAdapter; state: FakeState } {
  const state: FakeState = {
    producerCreates: 0,
    workerCreates: 0,
    dispatched: [],
    processJob: undefined,
    handlerCalls: [],
  };

  const adapter: JobsRuntimeAdapter = {
    name: 'fake',
    createProducer() {
      state.producerCreates += 1;
      return Promise.resolve({
        dispatch(name, data, dispatchOptions) {
          state.dispatched.push({ name, data, options: dispatchOptions });
          return Promise.resolve({ queued: name });
        },
        close() {
          return Promise.resolve();
        },
      } satisfies RuntimeProducer);
    },
    createWorker(_context, processJob) {
      state.workerCreates += 1;
      state.processJob = processJob;
      return Promise.resolve({
        close() {
          return Promise.resolve();
        },
      });
    },
  };

  return { adapter, state };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runtimeJob(overrides: Partial<RuntimeJob> = {}): RuntimeJob {
  return {
    name: 'testJob',
    id: 'job-1',
    data: { n: 1 },
    attemptsMade: 0,
    attemptsStarted: 1,
    log: async () => undefined,
    updateProgress: async () => undefined,
    ...overrides,
  };
}

/** Build dispatch options carrying an overlap descriptor. */
function overlapOpts(key: string, ttlMs: number): Record<string, unknown> {
  return { [OVERLAP_OPTION_KEY]: { key, ttlMs } };
}

// ---------------------------------------------------------------------------
// Registry: a job that records every handler invocation.
// ---------------------------------------------------------------------------

interface RecordingRegistry {
  registry: ReturnType<typeof createJobRegistry>;
  calls: Array<{ name: string; data: unknown }>;
}

function recordingRegistry(): RecordingRegistry {
  const calls: Array<{ name: string; data: unknown }> = [];
  const testJob = defineJob(z.object({ n: z.number() }), async (data, _ctx) => {
    calls.push({ name: 'testJob', data });
  });
  return { registry: createJobRegistry({ testJob }), calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('overlap middleware', () => {
  // --- No descriptor: pass through ---

  it('runs the handler normally when no overlap descriptor is present in options', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const leases = new MapLeaseStore();

    const runtime = new JobsRuntimeImpl({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(leases)] },
    });
    await runtime.startWorker();

    // Dispatch without any overlap descriptor.
    await runtime.dispatch('testJob', { n: 1 });

    await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { name: 'testJob', data: { n: 1 } });
  });

  it('passes through next() result when no overlap descriptor is present (no side effect)', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const leases = new MapLeaseStore();

    const runtime = new JobsRuntimeImpl({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(leases)] },
    });
    await runtime.startWorker();

    // Dispatch without any overlap descriptor.
    await runtime.dispatch('testJob', { n: 1 });

    const result = await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    // The middleware calls next() whose result is void (the handler returns void).
    assert.equal(result, undefined);
    assert.equal(calls.length, 1, 'handler ran through the middleware');
  });

  // --- Malformed descriptor: fail safe ---

  it('runs handler normally when descriptor has a non-string key (fail safe)', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const leases = new MapLeaseStore();

    const runtime = new JobsRuntimeImpl({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(leases)] },
    });
    await runtime.startWorker();

    // Malformed: key is not a string.
    const malformed = { [OVERLAP_OPTION_KEY]: { key: 1, ttlMs: 5000 } };
    await runtime.dispatch('testJob', { n: 1 }, malformed);

    await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.equal(calls.length, 1, 'handler ran despite malformed descriptor');
    assert.deepEqual(calls[0], { name: 'testJob', data: { n: 1 } });
  });

  it('runs handler normally when descriptor has a zero ttlMs (fail safe)', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const leases = new MapLeaseStore();

    const runtime = new JobsRuntimeImpl({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(leases)] },
    });
    await runtime.startWorker();

    // Malformed: ttlMs is zero (not positive).
    const malformed = { [OVERLAP_OPTION_KEY]: { key: 'schedule:x', ttlMs: 0 } };
    await runtime.dispatch('testJob', { n: 1 }, malformed);

    await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.equal(calls.length, 1, 'handler ran despite zero ttlMs');
  });

  it('runs handler normally when raw descriptor is null (fail safe)', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const leases = new MapLeaseStore();

    const runtime = new JobsRuntimeImpl({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(leases)] },
    });
    await runtime.startWorker();

    const malformed = { [OVERLAP_OPTION_KEY]: null };
    await runtime.dispatch('testJob', { n: 1 }, malformed);

    await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.equal(calls.length, 1, 'handler ran despite null descriptor');
  });

  it('runs handler normally when raw descriptor is a string (fail safe)', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const leases = new MapLeaseStore();

    const runtime = new JobsRuntimeImpl({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(leases)] },
    });
    await runtime.startWorker();

    const malformed = { [OVERLAP_OPTION_KEY]: 'not-an-object' };
    await runtime.dispatch('testJob', { n: 1 }, malformed);

    await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.equal(calls.length, 1, 'handler ran despite string descriptor');
  });

  it('runs handler normally when raw descriptor has an empty key (fail safe)', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const leases = new MapLeaseStore();

    const runtime = new JobsRuntimeImpl({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(leases)] },
    });
    await runtime.startWorker();

    const malformed = { [OVERLAP_OPTION_KEY]: { key: '  ', ttlMs: 5000 } };
    await runtime.dispatch('testJob', { n: 1 }, malformed);

    await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.equal(calls.length, 1, 'handler ran despite empty key');
  });

  it('runs handler normally when raw descriptor is missing the key field (fail safe)', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const leases = new MapLeaseStore();

    const runtime = new JobsRuntimeImpl({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(leases)] },
    });
    await runtime.startWorker();

    const malformed = { [OVERLAP_OPTION_KEY]: { ttlMs: 5000 } };
    await runtime.dispatch('testJob', { n: 1 }, malformed);

    await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.equal(calls.length, 1);
  });

  // --- Descriptor present, acquires lease ---

  it('acquires lease, runs handler, releases lease when descriptor is valid', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const leases = new MapLeaseStore();

    const runtime = new JobsRuntimeImpl({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(leases)] },
    });
    await runtime.startWorker();

    const opts = overlapOpts('schedule:test', 5000);
    await runtime.dispatch('testJob', { n: 1 }, opts);

    await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.equal(calls.length, 1, 'handler should have run');
    assert.deepEqual(calls[0], { name: 'testJob', data: { n: 1 } });

    // After release, another job should be able to acquire the same key
    // (the lock was released).
    assert.notEqual(
      await leases.acquire('schedule:test', 1000),
      null,
      'lease should be released after the handler completes',
    );
  });

  // --- Lease already held: skip ---

  it('skips invocation without calling handler when lease is already held', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const leases = new MapLeaseStore();

    // Pre-acquire the lease so the middleware cannot get it.
    const preAcquired = await leases.acquire('schedule:locked', 60000);
    assert.notEqual(preAcquired, null, 'pre-acquire should succeed');

    const runtime = new JobsRuntimeImpl({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(leases)] },
    });
    await runtime.startWorker();

    const opts = overlapOpts('schedule:locked', 5000);
    await runtime.dispatch('testJob', { n: 1 }, opts);

    // The handler must not be called — the lease is held.
    const result = await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.equal(calls.length, 0, 'handler must not run when lease is held');
    assert.equal(result, undefined, 'skipped invocation returns undefined');
  });

  it('returns undefined without throwing when lease is held (not a failure)', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const leases = new MapLeaseStore();

    // Pre-acquire the lease.
    await leases.acquire('schedule:held', 60000);

    const runtime = new JobsRuntimeImpl({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(leases)] },
    });
    await runtime.startWorker();

    const opts = overlapOpts('schedule:held', 5000);
    await runtime.dispatch('testJob', { n: 1 }, opts);

    // processJob must resolve (not reject) — the skip is not a failure.
    const result = await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.equal(result, undefined);
    assert.equal(calls.length, 0);
  });

  // --- Handler throws: lease still released ---

  it('releases lease even when handler throws, and error propagates unchanged', async () => {
    const registry = createJobRegistry({
      testJob: defineJob(z.object({ n: z.number() }), async (_data, _ctx) => {
        throw new Error('handler failed');
      }),
    });
    const { adapter, state } = fakeAdapter();
    const leases = new MapLeaseStore();

    const runtime = new JobsRuntimeImpl({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(leases)] },
    });
    await runtime.startWorker();

    const opts = overlapOpts('schedule:throwing', 5000);
    await runtime.dispatch('testJob', { n: 1 }, opts);

    await assert.rejects(
      state.processJob!(
        runtimeJob({
          name: 'testJob',
          data: { n: 1 },
          opts: state.dispatched[0]!.options,
        }),
      ),
      /handler failed/,
      'the handler error must propagate to the caller',
    );

    // After the throw, the lease must be released — another job should be
    // able to acquire the same key.
    assert.notEqual(
      await leases.acquire('schedule:throwing', 1000),
      null,
      'lease must be released after handler throws so subsequent runs are not blocked',
    );
  });

  // --- Release throws: error swallowed, handler result propagates ---

  it('does not throw when release fails after a successful handler run', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();

    const brokenLeases = new ReleaseFailingLeaseStore();

    const runtime = new JobsRuntimeImpl({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(brokenLeases)] },
    });
    await runtime.startWorker();

    const opts = overlapOpts('schedule:x', 5000);
    await runtime.dispatch('testJob', { n: 1 }, opts);

    // processJob must resolve normally — the release failure is swallowed.
    const result = await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.equal(result, undefined);
    assert.equal(calls.length, 1, 'handler ran despite release failure');
  });

  it('propagates handler error unchanged when release throws', async () => {
    const registry = createJobRegistry({
      testJob: defineJob(z.object({ n: z.number() }), async (_data, _ctx) => {
        throw new Error('handler failed');
      }),
    });
    const { adapter, state } = fakeAdapter();

    const brokenLeases = new ReleaseFailingLeaseStore();

    const runtime = new JobsRuntimeImpl({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(brokenLeases)] },
    });
    await runtime.startWorker();

    const opts = overlapOpts('schedule:x', 5000);
    await runtime.dispatch('testJob', { n: 1 }, opts);

    await assert.rejects(
      state.processJob!(
        runtimeJob({
          name: 'testJob',
          data: { n: 1 },
          opts: state.dispatched[0]!.options,
        }),
      ),
      /handler failed/,
      'the handler error, not the release error, must propagate',
    );
  });

  // --- Integration: two sequential runs with a real memory lease store ---

  it('skips second run while first holds the lock (deferred handler)', async () => {
    const wrapped: Array<{ name: string }> = [];

    // Create a deferred promise so the first handler can be held while we
    // attempt a second run.
    let finishFirst: () => void;
    const firstDone = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });

    const registry = createJobRegistry({
      testJob: defineJob(z.object({ n: z.number() }), async (data, _ctx) => {
        wrapped.push({ name: `run-${data.n}` });
        if (data.n === 1) {
          // Hold handler 1 until we explicitly release it.
          await firstDone;
        }
      }),
    });

    const { adapter, state } = fakeAdapter();
    const leases = new MapLeaseStore();

    const runtime = new JobsRuntimeImpl({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(leases)] },
    });
    await runtime.startWorker();

    // Dispatch two runs with the same overlap key.
    const opts = overlapOpts('schedule:sequential', 30000);
    await runtime.dispatch('testJob', { n: 1 }, opts);
    await runtime.dispatch('testJob', { n: 2 }, opts);

    // Start processing run 1 — it will block on the deferred promise.
    const run1Promise = state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    // Process run 2 while run 1 is still in flight. It should be skipped.
    const run2Result = await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 2 },
        opts: state.dispatched[1]!.options,
      }),
    );

    assert.equal(run2Result, undefined, 'run 2 should be skipped');
    assert.deepEqual(wrapped, [{ name: 'run-1' }], 'only run 1 handler started');

    // Release run 1.
    finishFirst!();
    await run1Promise;

    assert.deepEqual(wrapped, [{ name: 'run-1' }], 'run 2 was never called');

    // After both complete, the lease should be released (run 1 released it).
    assert.notEqual(
      await leases.acquire('schedule:sequential', 1000),
      null,
      'lease released after run 1 completes',
    );
  });

  // --- Option allowlist: OVERLAP_OPTION_KEY survives validateJobOptions ---

  it('OVERLAP_OPTION_KEY survives the option allowlist and reaches middleware context', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const leases = new MapLeaseStore();

    const runtime = new JobsRuntimeImpl({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(leases)] },
    });
    await runtime.startWorker();

    // Dispatch with the overlap key — validateJobOptions must not reject it.
    const opts = overlapOpts('schedule:allowlist', 5000);
    await runtime.dispatch('testJob', { n: 1 }, opts);

    // The descriptor should be present in the dispatched options.
    const dispatchedOpts = state.dispatched[0]!.options;
    const raw = dispatchedOpts[OVERLAP_OPTION_KEY];
    assert.ok(
      isOverlapDescriptor(raw),
      'descriptor survives validateJobOptions and reaches dispatch options',
    );

    assert.equal(raw.key, 'schedule:allowlist');
    assert.equal(raw.ttlMs, 5000);

    // Process the job — handler runs normally.
    await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: dispatchedOpts,
      }),
    );

    assert.equal(calls.length, 1);
  });
});

describe('isOverlapDescriptor', () => {
  it('returns false for null', () => {
    assert.equal(isOverlapDescriptor(null), false);
  });

  it('returns false for a plain empty object', () => {
    assert.equal(isOverlapDescriptor({}), false);
  });

  it('returns false when key is missing', () => {
    assert.equal(isOverlapDescriptor({ ttlMs: 5000 }), false);
  });

  it('returns false when key is an empty string (after trim)', () => {
    assert.equal(isOverlapDescriptor({ key: '  ', ttlMs: 5000 }), false);
  });

  it('returns false when key is a number', () => {
    assert.equal(isOverlapDescriptor({ key: 1, ttlMs: 5000 }), false);
  });

  it('returns false when ttlMs is missing', () => {
    assert.equal(isOverlapDescriptor({ key: 'schedule:x' }), false);
  });

  it('returns false when ttlMs is zero', () => {
    assert.equal(isOverlapDescriptor({ key: 'schedule:x', ttlMs: 0 }), false);
  });

  it('returns false when ttlMs is negative', () => {
    assert.equal(isOverlapDescriptor({ key: 'schedule:x', ttlMs: -1 }), false);
  });

  it('returns false when ttlMs is NaN', () => {
    assert.equal(isOverlapDescriptor({ key: 'schedule:x', ttlMs: NaN }), false);
  });

  it('returns false when ttlMs is Infinity', () => {
    assert.equal(isOverlapDescriptor({ key: 'schedule:x', ttlMs: Infinity }), false);
  });

  it('returns false when ttlMs is a string', () => {
    assert.equal(isOverlapDescriptor({ key: 'schedule:x', ttlMs: '5000' }), false);
  });

  it('returns true for a well-formed descriptor', () => {
    assert.equal(isOverlapDescriptor({ key: 'schedule:test', ttlMs: 5000 }), true);
  });

  it('returns true for a custom key (not just schedule: prefix)', () => {
    assert.equal(isOverlapDescriptor({ key: 'custom-lock', ttlMs: 1000 }), true);
  });
});

// ---------------------------------------------------------------------------
// Automatic overlap wiring (overlapLeases option)
// ---------------------------------------------------------------------------

describe('automatic overlap wiring', () => {
  it('enforces overlap when overlapLeases is configured', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const registry = createJobRegistry({
      testJob: defineJob(z.object({ n: z.number() }), async () => {
        calls += 1;
        await gate;
      }),
    });
    const { adapter, state } = fakeAdapter();
    const runtime = new JobsRuntimeImpl({
      registry,
      adapter,
      overlapLeases: new MapLeaseStore(),
    });
    await runtime.startWorker();

    const first = state.processJob!(
      runtimeJob({ id: 'first', opts: overlapOpts('automatic', 5_000) }),
    );
    const second = state.processJob!(
      runtimeJob({ id: 'second', opts: overlapOpts('automatic', 5_000) }),
    );

    assert.equal(await second, undefined, 'the second run skips');
    assert.equal(calls, 1, 'only the first run entered the handler');

    release();
    await first;
    assert.equal(calls, 1);
  });

  it('does not double-wrap an explicitly registered overlap middleware', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const leases = new MapLeaseStore();
    const runtime = new JobsRuntimeImpl({
      registry,
      adapter,
      overlapLeases: leases,
      middleware: { testJob: [createOverlapMiddleware(leases)] },
    });
    await runtime.startWorker();

    await state.processJob!(runtimeJob({ opts: overlapOpts('explicit', 5_000) }));
    assert.equal(calls.length, 1, 'the handler ran exactly once');
  });

  it('rejects a malformed overlapLeases', () => {
    const { registry } = recordingRegistry();
    const { adapter } = fakeAdapter();
    assert.throws(
      () =>
        new JobsRuntimeImpl({
          registry,
          adapter,
          overlapLeases: {} as unknown as LeaseStore,
        }),
      /overlapLeases/,
    );
  });
});

/** A lease store on a clock the test moves. */
function leaseStoreAt(start = 0): { store: MapLeaseStore; advance(ms: number): void } {
  let now = start;
  return {
    store: new MapLeaseStore(() => now),
    advance(ms) {
      now += ms;
    },
  };
}

function count(calls: readonly string[], operation: string): number {
  return calls.filter((call) => call === operation).length;
}

function overlapContext(ttlMs: number, signal?: AbortSignal): JobMiddlewareContext {
  return {
    name: 'digest',
    jobId: 'job-1',
    options: { [OVERLAP_OPTION_KEY]: { key: 'schedule:digest', ttlMs } },
    dispatch: () => Promise.resolve(undefined),
    ...(signal === undefined ? {} : { signal }),
  };
}

/** Let pending promise callbacks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('overlap middleware leases', () => {
  it('renews the lease while a long run holds it, then releases it', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const { store, advance } = leaseStoreAt();
    const middleware = createOverlapMiddleware(store);
    let finish: () => void = () => undefined;
    const running = middleware({}, overlapContext(3000), () => {
      return new Promise<unknown>((resolve) => {
        finish = () => resolve('done');
      });
    });
    await flush();
    for (let step = 0; step < 6; step += 1) {
      advance(1000);
      t.mock.timers.tick(1000);
      await flush();
    }
    assert.equal(count(store.calls, 'renew'), 6, 'renewed every ttl/3');
    assert.equal(store.isHeld('schedule:digest'), true, 'still held past its ttl');

    finish();
    assert.equal(await running, 'done');
    assert.equal(count(store.calls, 'release'), 1);
    assert.equal(store.isHeld('schedule:digest'), false, 'released when the run ends');
    t.mock.timers.tick(3000);
    assert.equal(count(store.calls, 'renew'), 6, 'renewal stops with the run');
  });

  it("an expired run never releases the next holder's lease", async () => {
    const { store, advance } = leaseStoreAt();
    const middleware = createOverlapMiddleware(store);
    let next: Awaited<ReturnType<LeaseStore['acquire']>> = null;
    await middleware({}, overlapContext(3000), async () => {
      // The lease is lost (expired) and the next run takes the key.
      advance(4000);
      next = await store.acquire('schedule:digest', 60_000);
      return undefined;
    });
    assert.notEqual(next, null, 'the next run took the expired key');
    assert.equal(store.isHeld('schedule:digest'), true, 'the next holder keeps the key');
    assert.equal(await store.release(next!), true);
  });

  it('aborts the work signal when a renewal finds the lease lost', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const { store, advance } = leaseStoreAt();
    const outcome = withLease(store, 'schedule:digest', { ttlMs: 3000 }, async (_lease, signal) => {
      advance(4000);
      await store.acquire('schedule:digest', 60_000);
      t.mock.timers.tick(1000);
      await flush();
      return signal.aborted;
    });
    assert.deepEqual(await outcome, { acquired: true, value: true });
  });
});

describe('overlap middleware and aborted attempts', () => {
  it('keeps the lease when the attempt aborts while its handler still runs', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const store = new MapLeaseStore();
    const middleware = createOverlapMiddleware(store);
    const controller = new AbortController();
    await assert.rejects(
      middleware({}, overlapContext(3000, controller.signal), () => {
        // The runtime abandons a timed-out handler: the chain rejects while
        // the handler itself is still running.
        controller.abort(new Error('timed out'));
        return Promise.reject(new Error('timed out'));
      }),
      /timed out/,
    );
    assert.equal(count(store.calls, 'release'), 0, 'the lease is left to expire');
    assert.equal(store.isHeld('schedule:digest'), true);
    t.mock.timers.tick(3000);
    assert.equal(count(store.calls, 'renew'), 0, 'renewal stops with the attempt');
  });

  it('keeps the lease when the attempt aborted before the handler ran', async () => {
    const store = new MapLeaseStore();
    const middleware = createOverlapMiddleware(store);
    const controller = new AbortController();
    controller.abort(new Error('timed out'));
    await assert.rejects(
      middleware({}, overlapContext(60_000, controller.signal), () =>
        Promise.reject(new Error('timed out')),
      ),
    );
    assert.equal(count(store.calls, 'release'), 0);
  });

  it('does not free the lease under a handler that outlives its timeout', async () => {
    const store = new MapLeaseStore();
    let finishZombie: () => void = () => undefined;
    const registry = createJobRegistry({
      digest: defineJob(
        z.object({}),
        () =>
          new Promise<void>((resolve) => {
            finishZombie = resolve;
          }),
        { timeoutMs: 5 },
      ),
    });
    const adapter = new MemoryJobsAdapter();
    const runtime = new JobsRuntimeImpl({
      registry,
      adapter,
      overlapLeases: store,
      onJobFailed: false,
    });
    await runtime.startWorker();
    await runtime.dispatch(
      'digest',
      {},
      { attempts: 1, [OVERLAP_OPTION_KEY]: { key: 'schedule:digest', ttlMs: 60_000 } },
    );
    await adapter.drain();
    assert.equal((await runtime.readCounts()).failed, 1, 'the attempt timed out');
    assert.equal(count(store.calls, 'release'), 0, 'the timed-out run keeps its lease');
    assert.equal(store.isHeld('schedule:digest'), true);
    finishZombie();
    await runtime.close();
  });
});
