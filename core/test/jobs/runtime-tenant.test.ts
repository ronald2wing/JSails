/**
 * Tests that every job attempt starts with no ambient tenant, whatever context
 * dispatched it, and that a handler sets a tenant only explicitly.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  currentTenantId,
  runWithTenant,
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
  it('runs a job dispatched inside runWithTenant with no tenant', async () => {
    const seen: (TenantId | null)[] = [];
    const registry = createJobRegistry({
      probe: defineJob(z.object({}), () => observe(seen)),
    });
    const adapter = new MemoryJobsAdapter();
    const runtime = new JobsRuntimeImpl({ registry, adapter });
    await runtime.startWorker();
    await runWithTenant(1, () => runtime.dispatch('probe', {}));
    await adapter.drain();
    assert.deepEqual(seen, [null]);
    await runtime.close();
  });

  it('runs every retry of a failing job with no tenant', async () => {
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
    assert.deepEqual(seen, [null, null, null]);
    await runtime.close();
  });

  it('runs a delayed job with no tenant', async () => {
    const seen: (TenantId | null)[] = [];
    const registry = createJobRegistry({
      probe: defineJob(z.object({}), () => observe(seen)),
    });
    const adapter = new MemoryJobsAdapter();
    const runtime = new JobsRuntimeImpl({ registry, adapter });
    await runtime.startWorker();
    await runWithTenant('acme', () => runtime.dispatch('probe', {}, { delay: 5 }));
    await adapter.drain();
    assert.deepEqual(seen, [null]);
    await runtime.close();
  });

  it('does not carry a tenant from one job into the next waiting job', async () => {
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
    assert.deepEqual(seen, [7, null]);
    await runtime.close();
  });

  it('runs a job dispatched from a tenant-bound handler with no tenant', async () => {
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
    assert.deepEqual(seen, [null]);
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
