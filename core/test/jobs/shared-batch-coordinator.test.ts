/**
 * Tests for the shared-store batch coordinator backed by a {@link CacheStore}.
 *
 * Uses core's Map-backed cache double, so no Valkey connection is opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SharedBatchCoordinator,
  SharedBatchCoordinatorError,
} from '../../src/jobs/shared-batch-coordinator.js';
import {
  createJobBatch,
  type BatchCallbacks,
  type BatchCoordinator,
  type BatchFailedSummary,
  type BatchSummary,
} from '../../src/jobs/batch.js';
import type { JobsRuntime } from '../../src/jobs/runtime.js';
import { MapCacheStore } from '../cache/map-cache-store.js';
import { currentTenantId, runWithTenant } from '../../src/database/tenant-context.js';
import { tick, waitFor } from '../../src/testing/index.js';

function fakeCacheStore(): MapCacheStore {
  return new MapCacheStore();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CallbackCapture {
  thenCalls: BatchSummary[];
  catchCalls: BatchFailedSummary[];
  finallyCalls: BatchSummary[];
}

function captureCallbacks(): { capture: CallbackCapture; callbacks: BatchCallbacks } {
  const capture: CallbackCapture = { thenCalls: [], catchCalls: [], finallyCalls: [] };
  const callbacks: BatchCallbacks = {
    then(summary) {
      capture.thenCalls.push(summary);
    },
    catch(summary) {
      capture.catchCalls.push(summary);
    },
    finally(summary) {
      capture.finallyCalls.push(summary);
    },
  };
  return { capture, callbacks };
}

/** What the store holds for a batch: its descriptor and each recorded index. */
interface StoredBatch {
  total: number;
  /** Recorded indices, ascending. */
  recorded: number[];
  failures: Array<{ job: string; error: string }>;
}

function readState(cache: MapCacheStore, id: string): StoredBatch {
  const raw = cache.entries.get(`jsails:batch:${id}`)?.value;
  assert.ok(typeof raw === 'string', `expected key jsails:batch:${id} to exist`);
  const { total } = JSON.parse(raw) as { total: number };
  const recorded: number[] = [];
  const failures: Array<{ job: string; error: string }> = [];
  for (let index = 0; index < total; index += 1) {
    const value = cache.entries.get(`jsails:batch:${id}:r:${String(index)}`)?.value;
    if (value === undefined) continue;
    recorded.push(index);
    if (value !== '') failures.push(JSON.parse(value as string) as { job: string; error: string });
  }
  return { total, recorded, failures };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SharedBatchCoordinator', () => {
  it('register persists the batch under its key', async () => {
    const cache = fakeCacheStore();
    const coordinator = new SharedBatchCoordinator(cache);

    await coordinator.register('batch-1', 3, {});

    const state = readState(cache, 'batch-1');
    assert.equal(state.total, 3);
    assert.deepEqual(state.recorded, []);
    assert.deepEqual(state.failures, []);
  });

  it('register and record write with the configured TTL', async () => {
    const ttlValues: number[] = [];
    const cache = fakeCacheStore();
    const set = cache.set.bind(cache);
    const add = cache.add.bind(cache);
    cache.set = async (key, value, ttlMs) => {
      ttlValues.push(ttlMs);
      await set(key, value, ttlMs);
    };
    cache.add = async (key, value, ttlMs) => {
      ttlValues.push(ttlMs);
      return add(key, value, ttlMs);
    };

    const a = new SharedBatchCoordinator(cache, { ttlMs: 60_000, pollIntervalMs: 0 });
    await a.register('a', 2, {});
    a.record('a', 'job', 0, undefined);
    await tick();
    assert.deepEqual(ttlValues, [60_000, 60_000]);

    // Default TTL (1 hour).
    const b = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });
    await b.register('b', 1, {});
    assert.equal(ttlValues.at(-1), 3_600_000);
  });

  it('refuses a TTL the cache contract does not accept', () => {
    const cache = fakeCacheStore();
    for (const ttlMs of [0, 1.5, Number.NaN, 400 * 86_400_000]) {
      assert.throws(() => new SharedBatchCoordinator(cache, { ttlMs }), /ttlMs/);
    }
  });

  it('record is idempotent for the same index: the first record wins', async () => {
    const cache = fakeCacheStore();
    const coordinator = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });

    await coordinator.register('batch-1', 2, {});
    coordinator.record('batch-1', 'jobA', 0, undefined);
    await tick();
    assert.deepEqual(readState(cache, 'batch-1').recorded, [0]);

    coordinator.record('batch-1', 'jobA', 0, 'duplicate error');
    await tick();
    const state = readState(cache, 'batch-1');
    assert.deepEqual(state.recorded, [0]);
    assert.deepEqual(state.failures, []);
  });

  it('record tracks failure separately from success', async () => {
    const cache = fakeCacheStore();
    const coordinator = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });

    await coordinator.register('batch-1', 3, {});
    coordinator.record('batch-1', 'jobA', 0, undefined);
    coordinator.record('batch-1', 'jobB', 1, 'boom');
    await tick();

    const state = readState(cache, 'batch-1');
    assert.deepEqual(state.recorded, [0, 1]);
    assert.deepEqual(state.failures, [{ job: 'jobB', error: 'boom' }]);
  });

  it('fires then and finally when all items succeed; catch not called', async () => {
    const cache = fakeCacheStore();
    const { capture, callbacks } = captureCallbacks();
    const coordinator = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });

    await coordinator.register('batch-1', 3, callbacks);
    coordinator.record('batch-1', 'taskA', 0, undefined);
    coordinator.record('batch-1', 'taskB', 1, undefined);
    coordinator.record('batch-1', 'taskC', 2, undefined);
    await tick();

    assert.deepEqual(capture.thenCalls, [{ id: 'batch-1', total: 3, succeeded: 3, failed: 0 }]);
    assert.equal(capture.catchCalls.length, 0);
    assert.deepEqual(capture.finallyCalls, [{ id: 'batch-1', total: 3, succeeded: 3, failed: 0 }]);
  });

  it('fires catch and finally when any item fails; then not called', async () => {
    const cache = fakeCacheStore();
    const { capture, callbacks } = captureCallbacks();
    const coordinator = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });

    await coordinator.register('batch-1', 3, callbacks);
    coordinator.record('batch-1', 'taskA', 0, undefined);
    coordinator.record('batch-1', 'taskB', 1, 'intentional failure');
    coordinator.record('batch-1', 'taskC', 2, undefined);
    await tick();

    assert.equal(capture.thenCalls.length, 0);
    assert.deepEqual(capture.catchCalls, [
      {
        id: 'batch-1',
        total: 3,
        succeeded: 2,
        failed: 1,
        failures: [{ job: 'taskB', error: 'intentional failure' }],
      },
    ]);
    assert.equal(capture.finallyCalls.length, 1);
    assert.equal(capture.finallyCalls[0]!.failed, 1);
  });

  it('fires settlement exactly once even when an index is recorded repeatedly', async () => {
    const cache = fakeCacheStore();
    const { capture, callbacks } = captureCallbacks();
    const coordinator = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });

    await coordinator.register('batch-1', 1, callbacks);
    coordinator.record('batch-1', 'taskA', 0, undefined);
    coordinator.record('batch-1', 'taskA', 0, undefined);
    coordinator.record('batch-1', 'taskA', 0, undefined);
    await tick();

    assert.equal(capture.thenCalls.length, 1);
    assert.equal(capture.finallyCalls.length, 1);
  });

  it('counts a burst of records with few store reads', async () => {
    const cache = fakeCacheStore();
    const { capture, callbacks } = captureCallbacks();
    const coordinator = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });

    await coordinator.register('batch-1', 50, callbacks);
    cache.calls.length = 0;
    for (let index = 0; index < 50; index += 1) {
      coordinator.record('batch-1', 'task', index, undefined);
    }
    await tick();

    assert.equal(capture.thenCalls.length, 1);
    const counts = cache.calls.filter((call) => call === 'getMany').length;
    assert.ok(counts < 10, `${String(counts)} counts for 50 records`);
  });

  it('reads a batch larger than one count chunk', async () => {
    const cache = fakeCacheStore();
    const { capture, callbacks } = captureCallbacks();
    const coordinator = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });

    await coordinator.register('batch-1', 2500, callbacks);
    for (let index = 0; index < 2500; index += 1) {
      coordinator.record('batch-1', 'task', index, index === 2400 ? 'late' : undefined);
    }
    await tick();

    assert.equal(capture.catchCalls.length, 1);
    assert.equal(capture.catchCalls[0]!.succeeded, 2499);
    assert.deepEqual(capture.catchCalls[0]!.failures, [{ job: 'task', error: 'late' }]);
  });

  it('resumes each count from the recorded frontier, so a batch costs linear reads', async () => {
    const cache = fakeCacheStore();
    const { capture, callbacks } = captureCallbacks();
    const coordinator = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });
    const getMany = cache.getMany.bind(cache);
    let reads = 0;
    let keysRead = 0;
    cache.getMany = async (keys) => {
      reads += 1;
      keysRead += keys.length;
      return getMany(keys);
    };
    const total = 3000;

    await coordinator.register('batch-1', total, callbacks);
    // In order and one at a time, so no count coalesces with another: the
    // pattern that made every count rescan from index 0.
    for (let index = 0; index < total; index += 1) {
      coordinator.record('batch-1', 'task', index, index === 1500 ? 'mid' : undefined);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await tick();

    assert.equal(capture.catchCalls.length, 1);
    assert.equal(capture.catchCalls[0]!.succeeded, total - 1);
    assert.deepEqual(capture.catchCalls[0]!.failures, [{ job: 'task', error: 'mid' }]);
    assert.ok(reads <= 2 * total, `${String(reads)} reads for ${String(total)} records`);
    assert.ok(keysRead <= 100 * total, `${String(keysRead)} keys read for ${String(total)}`);
  });

  it('remove deletes the batch key and in-process callbacks', async () => {
    const cache = fakeCacheStore();
    const { capture, callbacks } = captureCallbacks();
    const coordinator = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });

    await coordinator.register('batch-1', 1, callbacks);
    assert.ok(cache.entries.has('jsails:batch:batch-1'));

    coordinator.remove('batch-1');
    await tick();
    assert.equal(cache.entries.has('jsails:batch:batch-1'), false);

    // A late record neither resurrects the batch nor fires callbacks.
    coordinator.record('batch-1', 'taskA', 0, undefined);
    await tick();
    assert.equal(capture.thenCalls.length, 0);
    assert.equal(cache.entries.has('jsails:batch:batch-1:r:0'), false);
  });

  it('two coordinator instances over the same cache share persisted progress', async () => {
    const cache = fakeCacheStore();
    const { capture, callbacks } = captureCallbacks();
    const coordinatorA = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });
    const coordinatorB = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });

    await coordinatorA.register('batch-1', 3, callbacks);
    coordinatorB.record('batch-1', 'taskA', 0, undefined);
    coordinatorB.record('batch-1', 'taskB', 1, undefined);
    await tick();

    assert.deepEqual(readState(cache, 'batch-1').recorded, [0, 1]);
    assert.equal(capture.thenCalls.length, 0, 'process A has not observed completion yet');

    coordinatorA.record('batch-1', 'taskC', 2, undefined);
    await tick();

    assert.equal(capture.thenCalls.length, 1);
    assert.equal(capture.thenCalls[0]!.succeeded, 3);
    assert.deepEqual(readState(cache, 'batch-1').recorded, [0, 1, 2]);
  });

  it('records concurrent workers without losing an index', async () => {
    const cache = fakeCacheStore();
    const { capture, callbacks } = captureCallbacks();
    const producer = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });
    const workerA = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });
    const workerB = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });

    await producer.register('batch-1', 4, callbacks);
    // Interleaved records from two processes, plus a redelivered duplicate.
    workerA.record('batch-1', 'taskA', 0, undefined);
    workerB.record('batch-1', 'taskB', 1, 'boom');
    workerA.record('batch-1', 'taskA', 2, undefined);
    workerB.record('batch-1', 'taskB', 1, undefined);
    await tick();
    assert.deepEqual(readState(cache, 'batch-1').recorded, [0, 1, 2]);

    producer.record('batch-1', 'taskC', 3, undefined);
    await tick();
    assert.equal(capture.catchCalls.length, 1);
    assert.equal(capture.catchCalls[0]!.succeeded, 3);
    assert.equal(capture.catchCalls[0]!.failed, 1);
    assert.deepEqual(capture.catchCalls[0]!.failures, [{ job: 'taskB', error: 'boom' }]);
    assert.equal(capture.finallyCalls.length, 1);
  });

  it('settlement does not fire in a process that did not register the batch', async () => {
    const cache = fakeCacheStore();
    const coordinatorA = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });
    const coordinatorB = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });
    const { capture: captureA, callbacks: cbA } = captureCallbacks();

    await coordinatorA.register('batch-1', 2, cbA);
    coordinatorB.record('batch-1', 'taskA', 0, undefined);
    coordinatorB.record('batch-1', 'taskB', 1, undefined);
    await tick();

    // Without a poll, A never observes completion; a duplicate record in A
    // stores nothing and so does not count either. The poll covers this.
    assert.equal(captureA.thenCalls.length, 0);
    coordinatorA.record('batch-1', 'taskA', 0, undefined);
    await tick();
    assert.equal(captureA.thenCalls.length, 0);
  });

  it('persisted failures carry only the error message, never the payload', async () => {
    const cache = fakeCacheStore();
    const coordinator = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });

    await coordinator.register('batch-1', 1, {});
    coordinator.record('batch-1', 'secretJob', 0, 'boom');
    await tick();

    const raw = cache.entries.get('jsails:batch:batch-1:r:0')?.value;
    assert.equal(typeof raw, 'string');
    assert.deepEqual(Object.keys(JSON.parse(raw as string) as object).sort(), ['error', 'job']);
  });

  const isInvalidCacheError = (error: unknown): boolean =>
    error instanceof SharedBatchCoordinatorError && error.code === 'invalid_cache';

  it('throws for a missing cache or one without add and getMany', () => {
    const construct = SharedBatchCoordinator as unknown as new (c: unknown) => BatchCoordinator;
    assert.throws(() => new construct(null), isInvalidCacheError);
    assert.throws(() => new construct(undefined), isInvalidCacheError);
    const { add: _add, ...withoutAdd } = fakeCacheStore();
    assert.throws(
      () => new construct({ ...withoutAdd, get: async () => null }),
      isInvalidCacheError,
    );
  });

  it('throws for a non-object options argument', () => {
    const cache = fakeCacheStore();
    assert.throws(() => {
      new SharedBatchCoordinator(cache, 'bad' as unknown as { ttlMs?: number });
    }, /options must be an object/);
  });

  it('record is a no-op when the batch key has been removed or expired', async () => {
    const cache = fakeCacheStore();
    const { capture, callbacks } = captureCallbacks();
    const coordinator = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });

    await coordinator.register('batch-1', 2, callbacks);
    cache.entries.delete('jsails:batch:batch-1');

    coordinator.record('batch-1', 'taskA', 0, undefined);
    await tick();

    assert.equal(cache.entries.has('jsails:batch:batch-1:r:0'), false);
    assert.equal(capture.thenCalls.length, 0);
  });

  it('in-process entry is removed after settlement; a later record is a no-op', async () => {
    const cache = fakeCacheStore();
    const { capture, callbacks } = captureCallbacks();
    const coordinator = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });

    await coordinator.register('batch-1', 1, callbacks);
    coordinator.record('batch-1', 'taskA', 0, undefined);
    await tick();
    assert.equal(capture.thenCalls.length, 1);

    coordinator.record('batch-1', 'taskA', 0, 'late error');
    await tick();
    assert.equal(capture.thenCalls.length, 1);
    assert.equal(capture.catchCalls.length, 0);
  });

  it('reads an unparseable failure record as an anonymous failure', async () => {
    const cache = fakeCacheStore();
    const { capture, callbacks } = captureCallbacks();
    const coordinator = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });

    await coordinator.register('batch-1', 2, callbacks);
    await cache.set('jsails:batch:batch-1:r:0', '{not json', 60_000);
    coordinator.record('batch-1', 'taskB', 1, undefined);
    await tick();

    assert.deepEqual(capture.catchCalls[0]?.failures, [{ job: '', error: '' }]);
  });
});

describe('SharedBatchCoordinator polling', () => {
  it('settles in the registering process by polling when workers record everything', async () => {
    const cache = fakeCacheStore();
    const { capture, callbacks } = captureCallbacks();
    const web = new SharedBatchCoordinator(cache, { pollIntervalMs: 5 });
    const worker = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });

    await web.register('batch-1', 2, callbacks);
    worker.record('batch-1', 'taskA', 0, undefined);
    worker.record('batch-1', 'taskB', 1, undefined);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(capture.thenCalls.length, 1);
    assert.equal(capture.thenCalls[0]!.succeeded, 2);
  });

  it('settles a poll started inside a tenant with no tenant', async () => {
    const cache = fakeCacheStore();
    const seen: unknown[] = [];
    const web = new SharedBatchCoordinator(cache, { pollIntervalMs: 5 });
    const worker = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });
    await runWithTenant(1, () =>
      web.register('batch-1', 1, {
        then: () => {
          seen.push(currentTenantId() ?? 'none');
        },
      }),
    );
    worker.record('batch-1', 'taskA', 0, undefined);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(seen, ['none']);
  });

  it('keeps polling through a failing read', async () => {
    const cache = fakeCacheStore();
    const { capture, callbacks } = captureCallbacks();
    const web = new SharedBatchCoordinator(cache, { pollIntervalMs: 5 });
    const worker = new SharedBatchCoordinator(cache, { pollIntervalMs: 0 });

    // Failing from the start, so no poll can settle through a healthy read
    // before the failures are in place.
    const getMany = cache.getMany.bind(cache);
    let failures = 2;
    cache.getMany = async (keys) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('store down');
      }
      return getMany(keys);
    };
    await web.register('batch-1', 1, callbacks);
    worker.record('batch-1', 'taskA', 0, undefined);
    // Waits on the outcome, not on a fixed number of poll fires, which a
    // loaded runner or a coarse timer tick cannot promise.
    await waitFor(() => capture.thenCalls.length === 1, {
      timeoutMs: 30_000,
      label: 'the batch to settle',
    });
    assert.equal(failures, 0);
    assert.equal(capture.thenCalls.length, 1);
  });

  it('drops in-process state for a batch that never settles', async () => {
    const cache = fakeCacheStore();
    const { capture, callbacks } = captureCallbacks();
    const coordinator = new SharedBatchCoordinator(cache, { ttlMs: 5, pollIntervalMs: 0 });
    await coordinator.register('batch-1', 1, callbacks);
    await new Promise((resolve) => setTimeout(resolve, 20));
    coordinator.record('batch-1', 'taskA', 0, undefined);
    await tick();
    await tick();
    assert.equal(capture.thenCalls.length, 0);
  });
});

/**
 * Run `body` while recording unhandled rejections: before the store writes
 * were awaited or caught, a failing store write ended the process this way.
 */
async function withoutUnhandledRejections(body: () => Promise<void>): Promise<void> {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', listener);
  try {
    await body();
    // Unhandled rejections are reported after the microtask queue drains.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', listener);
  }
  assert.deepEqual(unhandled, [], 'a store failure must not become an unhandled rejection');
}

/** A store whose every write rejects with an error carrying a secret-looking message. */
function failingCacheStore(): MapCacheStore {
  const failure = (): Promise<never> =>
    Promise.reject(Object.assign(new Error('auth failed for s3cr3t'), { code: 'store_down' }));
  const cache = fakeCacheStore();
  cache.set = failure;
  cache.add = failure;
  cache.delete = failure;
  return cache;
}

describe('SharedBatchCoordinator store failures', () => {
  it('rejects register, and a batch dispatches nothing, when the write fails', async () => {
    await withoutUnhandledRejections(async () => {
      const coordinator = new SharedBatchCoordinator(failingCacheStore(), {
        pollIntervalMs: 0,
      });
      await assert.rejects(Promise.resolve(coordinator.register('b', 1, {})), /auth failed/);

      const dispatched: string[] = [];
      const runtime = {
        dispatch: async (name: string) => {
          dispatched.push(name);
          return undefined;
        },
      } as unknown as JobsRuntime;
      const batch = createJobBatch(runtime, coordinator, [{ job: 'a', data: {} }]);
      await assert.rejects(batch.dispatch(), /auth failed/);
      assert.deepEqual(dispatched, []);

      // A batch that is never dispatched must not leak the rejection either.
      createJobBatch(runtime, coordinator, [{ job: 'a', data: {} }]);
    });
  });

  it('reports failed background writes through onError', async () => {
    await withoutUnhandledRejections(async () => {
      const reported: string[] = [];
      const cache = failingCacheStore();
      // The batch key reads back, so a record goes on to write (and fails).
      cache.get = async () => JSON.stringify({ id: 'b', total: 2 });
      const coordinator = new SharedBatchCoordinator(cache, {
        pollIntervalMs: 0,
        onError: (_error, operation) => {
          reported.push(operation);
          throw new Error('a throwing handler stays contained');
        },
      });
      coordinator.record('b', 'job', 0, 'failed');
      coordinator.remove('b');
      await tick();
      await tick();
      assert.deepEqual(reported.sort(), ['record', 'remove']);
    });
  });

  it('logs a value-free line by default', async () => {
    const logged: string[] = [];
    const original = console.error;
    console.error = (line: string) => logged.push(line);
    try {
      await withoutUnhandledRejections(async () => {
        new SharedBatchCoordinator(failingCacheStore(), { pollIntervalMs: 0 }).remove('b');
        await tick();
      });
    } finally {
      console.error = original;
    }
    assert.ok(logged.length > 0);
    assert.match(logged[0] ?? '', /could not remove batch progress: Error \[store_down\]/);
    assert.ok(!logged.join('\n').includes('s3cr3t'));
  });
});
