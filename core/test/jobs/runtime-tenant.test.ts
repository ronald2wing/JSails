/**
 * Tests that a job attempt runs in exactly the tenant its dispatch carried:
 * the dispatcher's tenant when there was one, none otherwise, and never the
 * tenant of whichever context started the attempt (a worker started inside a
 * tenant, the previous job, a custom adapter). A switched-off scope is never
 * carried.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { serializeContext } from '../../src/context/carrier.js';
import {
  currentTenantId,
  runWithTenant,
  tenantScopeState,
  withoutTenantScope,
  type TenantId,
} from '../../src/database/tenant-context.js';
import {
  createBatchMiddleware,
  createJobBatch,
  InMemoryBatchCoordinator,
} from '../../src/jobs/batch.js';
import { MemoryJobsAdapter } from '../../src/jobs/memory-adapter.js';
import { createJobRegistry, defineJob } from '../../src/jobs/registry.js';
import { JobsRuntimeImpl, type ProcessJob } from '../../src/jobs/runtime.js';
import { tick } from '../../src/testing/index.js';

function observe(seen: (TenantId | null)[]): void {
  seen.push(currentTenantId() ?? null);
}

describe('job tenant isolation', () => {
  it('runs a job dispatched inside runWithTenant in that tenant', async () => {
    const seen: (TenantId | null)[] = [];
    const registry = createJobRegistry({
      probe: defineJob(z.object({}), () => observe(seen)),
    });
    const adapter = new MemoryJobsAdapter();
    const runtime = new JobsRuntimeImpl({ registry, adapter });
    await runtime.startWorker();
    await runWithTenant(1, () => runtime.dispatch('probe', {}));
    await runtime.dispatch('probe', {});
    await adapter.drain();
    assert.deepEqual(seen, [1, null]);
    await runtime.close();
  });

  it('runs every retry of a failing job in the carried tenant', async () => {
    const seen: (TenantId | null)[] = [];
    const registry = createJobRegistry({
      flaky: defineJob(z.object({}), () => {
        observe(seen);
        if (seen.length < 3) throw new Error('transient');
      }),
    });
    const adapter = new MemoryJobsAdapter();
    const runtime = new JobsRuntimeImpl({ registry, adapter, onJobFailed: false });
    await runtime.startWorker();
    await runWithTenant(1, () => runtime.dispatch('flaky', {}, { attempts: 3, backoff: 1 }));
    await adapter.drain();
    assert.deepEqual(seen, [1, 1, 1]);
    await runtime.close();
  });

  it('runs a delayed job in the carried tenant', async () => {
    const seen: (TenantId | null)[] = [];
    const registry = createJobRegistry({
      probe: defineJob(z.object({}), () => observe(seen)),
    });
    const adapter = new MemoryJobsAdapter();
    const runtime = new JobsRuntimeImpl({ registry, adapter });
    await runtime.startWorker();
    await runWithTenant('acme', () => runtime.dispatch('probe', {}, { delay: 5 }));
    await adapter.drain();
    assert.deepEqual(seen, ['acme']);
    await runtime.close();
  });

  it('does not carry a tenant from one job, or the worker start, into the next job', async () => {
    const seen: (TenantId | null)[] = [];
    const registry = createJobRegistry({
      first: defineJob(z.object({}), () => runWithTenant(7, () => observe(seen))),
      second: defineJob(z.object({}), () => observe(seen)),
    });
    const adapter = new MemoryJobsAdapter();
    const runtime = new JobsRuntimeImpl({ registry, adapter, concurrency: 1 });
    await runWithTenant(1, async () => {
      await runtime.dispatch('first', {});
      await runtime.dispatch('second', {});
    });
    await runWithTenant(2, () => runtime.startWorker());
    await adapter.drain();
    assert.deepEqual(seen, [7, 1]);
    await runtime.close();
  });

  it('runs a job dispatched from a tenant-bound handler in that tenant', async () => {
    const seen: (TenantId | null)[] = [];
    const registry = createJobRegistry({
      parent: defineJob(z.object({}), async (_data, context) => {
        const dispatch = context.dispatch;
        assert.ok(dispatch);
        await runWithTenant(3, () => dispatch('child', {}));
      }),
      child: defineJob(z.object({}), () => observe(seen)),
    });
    const adapter = new MemoryJobsAdapter();
    const runtime = new JobsRuntimeImpl({ registry, adapter });
    await runtime.startWorker();
    await runtime.dispatch('parent', {});
    await adapter.drain();
    assert.deepEqual(seen, [3]);
    await runtime.close();
  });

  it('never carries a switched-off tenant scope', async () => {
    const seen: { tenant: TenantId | undefined; unscoped: boolean }[] = [];
    const registry = createJobRegistry({
      probe: defineJob(z.object({}), () => {
        const state = tenantScopeState();
        seen.push({ tenant: state.tenantId, unscoped: state.unscoped });
      }),
    });
    const adapter = new MemoryJobsAdapter();
    const runtime = new JobsRuntimeImpl({ registry, adapter });
    await runtime.startWorker();
    await runWithTenant(4, () => withoutTenantScope(() => runtime.dispatch('probe', {})));
    await withoutTenantScope(() => runtime.dispatch('probe', {}));
    await adapter.drain();
    assert.deepEqual(seen, [
      { tenant: 4, unscoped: false },
      { tenant: undefined, unscoped: false },
    ]);
    await runtime.close();
  });

  it('lets a handler run for a tenant carried in its payload', async () => {
    const seen: (TenantId | null)[] = [];
    const registry = createJobRegistry({
      report: defineJob(z.object({ tenantId: z.number() }), (data) =>
        runWithTenant(data.tenantId, () => observe(seen)),
      ),
    });
    const adapter = new MemoryJobsAdapter();
    const runtime = new JobsRuntimeImpl({ registry, adapter });
    await runtime.startWorker();
    await runWithTenant(1, () => runtime.dispatch('report', { tenantId: 9 }));
    await adapter.drain();
    assert.deepEqual(seen, [9]);
    await runtime.close();
  });

  it('isolates a custom adapter that calls processJob inside a tenant', async () => {
    const seen: (TenantId | null)[] = [];
    const registry = createJobRegistry({
      probe: defineJob(z.object({}), () => observe(seen)),
    });
    let process: ProcessJob | undefined;
    const runtime = new JobsRuntimeImpl({
      registry,
      adapter: {
        name: 'custom',
        createProducer: () => ({
          dispatch: () => Promise.resolve(undefined),
          close: () => Promise.resolve(),
        }),
        createWorker: (_context, processJob) => {
          process = processJob;
          return { close: () => Promise.resolve() };
        },
      },
    });
    await runtime.startWorker();
    assert.ok(process);
    const run = process;
    await runWithTenant(5, () =>
      run({
        name: 'probe',
        id: '1',
        data: {},
        attemptsMade: 0,
        attemptsStarted: 1,
        opts: {},
        log: () => Promise.resolve(),
        updateProgress: () => Promise.resolve(),
      }),
    );
    assert.deepEqual(seen, [null]);
    await runtime.close();
  });

  it("reports a failure in the attempt's tenant, never the caller's", async () => {
    const seen: (TenantId | null)[] = [];
    const registry = createJobRegistry({
      fail: defineJob(z.object({}), () => {
        throw new Error('handler failed');
      }),
    });
    let process: ProcessJob | undefined;
    const runtime = new JobsRuntimeImpl({
      registry,
      onJobFailed: () => observe(seen),
      adapter: {
        name: 'custom',
        createProducer: () => ({
          dispatch: () => Promise.resolve(undefined),
          close: () => Promise.resolve(),
        }),
        createWorker: (_context, processJob) => {
          process = processJob;
          return { close: () => Promise.resolve() };
        },
      },
    });
    await runtime.startWorker();
    assert.ok(process);
    const run = process;
    const job = (opts: Record<string, unknown>) => ({
      name: 'fail',
      id: '1',
      data: {},
      attemptsMade: 0,
      attemptsStarted: 1,
      opts,
      log: () => Promise.resolve(),
      updateProgress: () => Promise.resolve(),
    });
    const carried = runWithTenant(8, () => serializeContext());
    await runWithTenant(5, () => assert.rejects(run(job({}))));
    await runWithTenant(5, () => assert.rejects(run(job({ __jsailsContext: carried }))));
    await runWithTenant(5, () => assert.rejects(run(job({ __jsailsContext: { v: 1 } }))));
    assert.deepEqual(seen, [null, 8, null]);
    await runtime.close();
  });

  it('runs in-memory coordinator callbacks with no tenant when recorded inside one', async () => {
    const seen: (TenantId | null)[] = [];
    const coordinator = new InMemoryBatchCoordinator();
    coordinator.register('batch-1', 1, { then: () => observe(seen) });
    runWithTenant(1, () => coordinator.record('batch-1', 'task', 0, undefined));
    await tick();
    assert.deepEqual(seen, [null]);
  });

  it('runs batch callbacks with no tenant', async () => {
    const seen: (TenantId | null)[] = [];
    const coordinator = new InMemoryBatchCoordinator();
    const registry = createJobRegistry({
      task: defineJob(z.object({}), () => {}),
    });
    const adapter = new MemoryJobsAdapter();
    const runtime = new JobsRuntimeImpl({
      registry,
      adapter,
      middleware: { task: [createBatchMiddleware(coordinator)] },
    });
    await runtime.startWorker();
    let settled!: () => void;
    const done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    await runWithTenant(1, () =>
      createJobBatch(runtime, coordinator, [{ job: 'task', data: {} }], {
        then: () => {
          observe(seen);
          settled();
        },
      }).dispatch(),
    );
    await adapter.drain();
    await done;
    assert.deepEqual(seen, [null]);
    await runtime.close();
  });
});
