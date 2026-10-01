/**
 * Tests for the durable schedule-pause store and its integration with
 * `JobsRuntimeImpl`: memory store CRUD, runtime with/without a store,
 * cache-backed persistence, and error branches.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import type { CacheStore } from '../../src/cache/store.js';
import {
  CachePausedScheduleStore,
  MemoryPausedScheduleStore,
  PausedScheduleError,
} from '../../src/jobs/paused-schedules.js';
import { createJobRegistry, defineJob } from '../../src/jobs/registry.js';
import {
  JobsRuntimeImpl,
  type JobDispatchOptions,
  type JobsRuntimeAdapter,
  type ProcessJob,
} from '../../src/jobs/runtime.js';

/**
 * Minimal in-memory {@link CacheStore} fixture for the cache-backed store tests.
 * The real implementation lives in `@jsails/cache`; the paused-schedule store
 * only touches get/set/delete.
 */
class InMemoryCacheStore implements CacheStore {
  readonly #entries = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.#entries.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.#entries.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
  }

  async remember(key: string, _ttlMs: number, loader: () => Promise<string>): Promise<string> {
    const cached = await this.get(key);
    if (cached !== null) return cached;
    const value = await loader();
    await this.set(key, value);
    return value;
  }

  async close(): Promise<void> {
    this.#entries.clear();
  }
}

/** Fake adapter state shared across tests for schedule capture. */
interface FakeState {
  upsertSchedulesCalledWith: Array<{ id: string; job: string }> | undefined;
  pauseSchedulesCalledWith: { ids: readonly string[] } | undefined;
  producerCreates: number;
}

/**
 * Build a fake adapter that records what `upsertSchedules` and `pauseSchedules`
 * received. The adapter itself performs no real queue work.
 */
function fakeAdapter(): { adapter: JobsRuntimeAdapter; state: FakeState } {
  const state: FakeState = {
    upsertSchedulesCalledWith: undefined,
    pauseSchedulesCalledWith: undefined,
    producerCreates: 0,
  };

  const adapter: JobsRuntimeAdapter = {
    name: 'fake',
    createProducer() {
      state.producerCreates += 1;
      return {
        dispatch(_name, _data, _dispatchOptions: JobDispatchOptions) {
          return Promise.resolve({ queued: _name });
        },
        close() {
          return Promise.resolve();
        },
      };
    },
    createWorker(_context, _processJob: ProcessJob) {
      return {
        close() {
          return Promise.resolve();
        },
      };
    },
    upsertSchedules(_producer, schedules) {
      state.upsertSchedulesCalledWith = schedules.map((s) => ({
        id: s.id,
        job: s.job,
      }));
      return Promise.resolve();
    },
    pauseSchedules(_producer, ids) {
      state.pauseSchedulesCalledWith = { ids };
      return Promise.resolve();
    },
  };

  return { adapter, state };
}

function registry() {
  const digest = defineJob(z.object({ to: z.string(), subject: z.string() }), async () => {});
  const report = defineJob(z.object({ reportId: z.number() }), async () => {});
  return createJobRegistry({ digest, report });
}

// ---------------------------------------------------------------------------
// Memory store unit tests
// ---------------------------------------------------------------------------

describe('MemoryPausedScheduleStore', () => {
  it('isPaused returns false for an unknown id', async () => {
    const store = new MemoryPausedScheduleStore();
    assert.equal(await store.isPaused('digest'), false);
  });

  it('setPaused then isPaused returns true', async () => {
    const store = new MemoryPausedScheduleStore();
    await store.setPaused(['digest']);
    assert.equal(await store.isPaused('digest'), true);
  });

  it('setPaused is idempotent', async () => {
    const store = new MemoryPausedScheduleStore();
    await store.setPaused(['digest']);
    await store.setPaused(['digest']);
    assert.equal(await store.isPaused('digest'), true);
  });

  it('clearPaused removes a paused id', async () => {
    const store = new MemoryPausedScheduleStore();
    await store.setPaused(['digest']);
    await store.clearPaused(['digest']);
    assert.equal(await store.isPaused('digest'), false);
  });

  it('clearPaused is a no-op on an unknown id', async () => {
    const store = new MemoryPausedScheduleStore();
    await store.clearPaused(['unknown']);
    assert.equal(await store.isPaused('unknown'), false);
  });

  it('setPaused and clearPaused on multiple ids', async () => {
    const store = new MemoryPausedScheduleStore();
    await store.setPaused(['a', 'b', 'c']);
    assert.equal(await store.isPaused('a'), true);
    assert.equal(await store.isPaused('b'), true);
    assert.equal(await store.isPaused('c'), true);

    await store.clearPaused(['a', 'c']);
    assert.equal(await store.isPaused('a'), false);
    assert.equal(await store.isPaused('b'), true);
    assert.equal(await store.isPaused('c'), false);
  });
});

// ---------------------------------------------------------------------------
// Runtime with a durable memory store
// ---------------------------------------------------------------------------

describe('durable schedule pause via JobsRuntime', () => {
  it('pauseSchedules persists paused ids to the store', async () => {
    const store = new MemoryPausedScheduleStore();
    const { adapter } = fakeAdapter();
    const runtime = new JobsRuntimeImpl({
      registry: registry(),
      adapter,
      pausedSchedules: store,
    });

    await runtime.pauseSchedules(['digest']);
    assert.equal(await store.isPaused('digest'), true);

    await runtime.close();
  });

  it('upsertSchedules skips paused ids when the store has them', async () => {
    const store = new MemoryPausedScheduleStore();
    await store.setPaused(['digest']);
    const { adapter, state } = fakeAdapter();
    const runtime = new JobsRuntimeImpl({
      registry: registry(),
      adapter,
      pausedSchedules: store,
    });

    await runtime.upsertSchedules([
      { id: 'digest', job: 'digest', intervalMs: 60000 },
      { id: 'report', job: 'report', intervalMs: 60000 },
    ]);

    // Only `report` should have been passed through; `digest` is paused.
    assert.deepEqual(state.upsertSchedulesCalledWith, [{ id: 'report', job: 'report' }]);

    await runtime.close();
  });

  it('pauseSchedules then upsertSchedules: paused id stays skipped', async () => {
    const store = new MemoryPausedScheduleStore();
    const { adapter, state } = fakeAdapter();
    const runtime = new JobsRuntimeImpl({
      registry: registry(),
      adapter,
      pausedSchedules: store,
    });

    // Pause digest via the runtime.
    await runtime.pauseSchedules(['digest']);
    assert.equal(await store.isPaused('digest'), true);

    // Now simulate a `work` restart: upsertSchedules re-evaluates.
    await runtime.upsertSchedules([
      { id: 'digest', job: 'digest', intervalMs: 60000 },
      { id: 'report', job: 'report', intervalMs: 60000 },
    ]);

    assert.deepEqual(state.upsertSchedulesCalledWith, [{ id: 'report', job: 'report' }]);

    await runtime.close();
  });
});

// ---------------------------------------------------------------------------
// Runtime WITHOUT a store (non-durable, existing behaviour)
// ---------------------------------------------------------------------------

describe('non-durable pause (no store)', () => {
  it('pauseSchedules calls the adapter but does not persist', async () => {
    const { adapter, state } = fakeAdapter();
    const runtime = new JobsRuntimeImpl({ registry: registry(), adapter });

    await runtime.pauseSchedules(['digest']);
    assert.deepEqual(state.pauseSchedulesCalledWith, { ids: ['digest'] });

    await runtime.close();
  });

  it('upsertSchedules re-registers everything even after a pause (non-durable)', async () => {
    const { adapter, state } = fakeAdapter();
    const runtime = new JobsRuntimeImpl({ registry: registry(), adapter });

    await runtime.pauseSchedules(['digest']);

    // With no store, upsertSchedules always passes the full list.
    await runtime.upsertSchedules([
      { id: 'digest', job: 'digest', intervalMs: 60000 },
      { id: 'report', job: 'report', intervalMs: 60000 },
    ]);

    assert.deepEqual(state.upsertSchedulesCalledWith, [
      { id: 'digest', job: 'digest' },
      { id: 'report', job: 'report' },
    ]);

    await runtime.close();
  });

  it('upsertSchedules with no store and an empty schedule list still calls the adapter', async () => {
    const { adapter, state } = fakeAdapter();
    const runtime = new JobsRuntimeImpl({ registry: registry(), adapter });

    await runtime.upsertSchedules([]);
    assert.deepEqual(state.upsertSchedulesCalledWith, []);

    await runtime.close();
  });
});

// ---------------------------------------------------------------------------
// Cache-backed store via an injected CacheStore
// ---------------------------------------------------------------------------

describe('CachePausedScheduleStore', () => {
  it('setPaused writes through the cache, isPaused reads from it', async () => {
    const cache = new InMemoryCacheStore();
    const store = new CachePausedScheduleStore(cache);

    await store.setPaused(['digest']);
    assert.equal(await store.isPaused('digest'), true);
    assert.equal(await store.isPaused('unknown'), false);
  });

  it('clearPaused removes the cache entry', async () => {
    const cache = new InMemoryCacheStore();
    const store = new CachePausedScheduleStore(cache);

    await store.setPaused(['digest']);
    assert.equal(await store.isPaused('digest'), true);

    await store.clearPaused(['digest']);
    assert.equal(await store.isPaused('digest'), false);
  });

  it('throws PausedScheduleError on a malformed cache store', () => {
    assert.throws(
      () => new CachePausedScheduleStore(null as unknown as CacheStore),
      PausedScheduleError,
    );
    assert.throws(() => new CachePausedScheduleStore({} as CacheStore), PausedScheduleError);
  });

  it('respects a custom prefix', async () => {
    const cache = new InMemoryCacheStore();
    const store = new CachePausedScheduleStore(cache, { prefix: 'myapp:pause' });

    await store.setPaused(['digest']);
    assert.equal(await store.isPaused('digest'), true);

    // The default-prefix key should not be present.
    const rawDefault = await cache.get('jsails:paused-schedule-digest');
    assert.equal(rawDefault, null);

    // But the custom prefix should.
    const rawCustom = await cache.get('myapp:pause-digest');
    assert.equal(rawCustom, '1');
  });

  it('runtime with a cache-backed store: pauseSchedules persists, upsertSchedules filters', async () => {
    const cache = new InMemoryCacheStore();
    const store = new CachePausedScheduleStore(cache);
    const { adapter, state } = fakeAdapter();
    const runtime = new JobsRuntimeImpl({
      registry: registry(),
      adapter,
      pausedSchedules: store,
    });

    await runtime.pauseSchedules(['digest']);
    // The store should reflect the paused state.
    assert.equal(await store.isPaused('digest'), true);

    // UpsertSchedules should skip digest.
    await runtime.upsertSchedules([
      { id: 'digest', job: 'digest', intervalMs: 60000 },
      { id: 'report', job: 'report', intervalMs: 60000 },
    ]);

    assert.deepEqual(state.upsertSchedulesCalledWith, [{ id: 'report', job: 'report' }]);

    await runtime.close();
  });
});
