/**
 * Tests for the first-party `jobs` plugin: the dispatch service exposed under
 * `jobsToken`, its fully lazy construction, delegation to the neutral
 * runtime, idempotent cleanup, value-free construction errors, and its units:
 * the worker runs in every process of the worker role, an application
 * created without roles included. Everything
 * runs against an in-memory adapter, so no Valkey or BullMQ connection is
 * opened and no URL is required.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { createApplication } from '../../src/app/application.js';
import { runExtensions } from '../../src/extensions/extension.js';
import { createLoadedApp } from '../../src/kernel/load-app.js';
import type { PluginRole } from '../../src/plugins/contract/lifecycle.js';
import { createJobRegistry, defineJob } from '../../src/jobs/registry.js';
import { defaultQueuePrefix } from '../../src/jobs/connection.js';
import { MemoryJobsAdapter } from '../../src/jobs/memory-adapter.js';
import { jobsPlugin, jobsToken, type JobsService } from '../../src/jobs/plugin.js';
import { validateRuntimeConfig } from '../../src/jobs/runtime-config.js';
import type { JobDispatchOptions, JobsRuntimeAdapter } from '../../src/jobs/runtime.js';

interface FakeState {
  producerCreates: number;
  producerCloses: number;
  prefixes: string[];
  dispatched: Array<{ name: string; data: unknown; options: JobDispatchOptions }>;
}

/** A minimal in-memory adapter; no backend, no URL, no connection. */
function fakeAdapter(): { adapter: JobsRuntimeAdapter; state: FakeState } {
  const state: FakeState = {
    producerCreates: 0,
    producerCloses: 0,
    prefixes: [],
    dispatched: [],
  };
  const adapter: JobsRuntimeAdapter = {
    name: 'fake',
    createProducer(context) {
      state.producerCreates += 1;
      state.prefixes.push(context.prefix);
      return {
        dispatch(name, data, options) {
          state.dispatched.push({ name, data, options });
          return Promise.resolve({ queued: name });
        },
        close() {
          state.producerCloses += 1;
          return Promise.resolve();
        },
      };
    },
    createWorker() {
      return { close: () => Promise.resolve() };
    },
  };
  return { adapter, state };
}

const registry = createJobRegistry({
  sendEmail: defineJob(z.object({ to: z.string(), subject: z.string() }), async () => undefined),
});

describe('jobsPlugin', () => {
  it('constructs no runtime until the first dispatch', async () => {
    const { adapter, state } = fakeAdapter();
    const runtime = await runExtensions([jobsPlugin({ registry, adapter })], {
      rootDir: import.meta.dirname,
    });
    try {
      assert.equal(state.producerCreates, 0);
      const service = runtime.services.get(jobsToken);
      assert.equal(typeof service.dispatch, 'function');
      assert.equal(state.producerCreates, 0, 'setup never constructs the runtime');
    } finally {
      await runtime.close();
    }
  });

  it('dispatches through the runtime and reuses the producer across calls', async () => {
    const { adapter, state } = fakeAdapter();
    const runtime = await runExtensions([jobsPlugin({ registry, adapter })], {
      rootDir: import.meta.dirname,
    });
    try {
      const service: JobsService = runtime.services.get(jobsToken);
      const result = await service.dispatch(
        'sendEmail',
        { to: 'a@b.co', subject: 'hi' },
        { jobId: 'id-1' },
      );
      assert.deepEqual(result, { queued: 'sendEmail' });
      assert.equal(state.producerCreates, 1);
      assert.deepEqual(state.dispatched, [
        {
          name: 'sendEmail',
          data: { to: 'a@b.co', subject: 'hi' },
          options: { jobId: 'id-1' },
        },
      ]);

      await service.dispatch('sendEmail', { to: 'c@d.co', subject: 'yo' });
      assert.equal(state.producerCreates, 1, 'the producer handle is reused');
      assert.equal(state.dispatched.length, 2);
    } finally {
      await runtime.close();
    }
  });

  it('closes the runtime exactly once, and is a no-op when never constructed', async () => {
    // Never dispatched: close is a no-op with nothing to tear down.
    const idle = await runExtensions([jobsPlugin({ registry, adapter: fakeAdapter().adapter })], {
      rootDir: import.meta.dirname,
    });
    await idle.close();
    await idle.close();

    // Dispatched once, then closed twice: the producer closes exactly once.
    const { adapter, state } = fakeAdapter();
    const runtime = await runExtensions([jobsPlugin({ registry, adapter })], {
      rootDir: import.meta.dirname,
    });
    await runtime.services.get(jobsToken).dispatch('sendEmail', { to: 'a@b.co', subject: 'hi' });
    await runtime.close();
    await runtime.close();
    assert.equal(state.producerCloses, 1);
    assert.equal(state.producerCreates, 1);
  });

  it('autoloads a relative jobsDir from the app root, not the working directory', async () => {
    const appRoot = mkdtempSync(join(tmpdir(), 'jsails-jobs-dir-'));
    try {
      mkdirSync(join(appRoot, 'dist', 'jobs'), { recursive: true });
      writeFileSync(
        join(appRoot, 'dist', 'jobs', 'ping.job.js'),
        'export default { schema: { safeParse: (data) => ({ success: true, data }) }, handler: async () => {} };',
      );
      assert.ok(!process.cwd().startsWith(appRoot));
      const { adapter, state } = fakeAdapter();
      const runtime = await runExtensions([jobsPlugin({ adapter })], { rootDir: appRoot });
      try {
        await runtime.services.get(jobsToken).dispatch('ping', {});
      } finally {
        await runtime.close();
      }
      assert.deepEqual(
        state.dispatched.map((entry) => entry.name),
        ['ping'],
      );
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });

  it('defaults the key prefix to the app and environment, the same default as `work`', async () => {
    // An app root away from the working directory: the prefix must come from
    // the root setup receives, as `work` takes it from its config's directory.
    const appRoot = mkdtempSync(join(tmpdir(), 'jsails-jobs-root-'));
    try {
      writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'shop-app' }));
      const { adapter, state } = fakeAdapter();
      const runtime = await runExtensions([jobsPlugin({ registry, adapter })], {
        rootDir: appRoot,
      });
      try {
        await runtime.services.get(jobsToken).dispatch('sendEmail', { to: 'a@b.co', subject: 'x' });
      } finally {
        await runtime.close();
      }
      assert.deepEqual(state.prefixes, [defaultQueuePrefix(appRoot, process.env)]);
      assert.match(state.prefixes[0] ?? '', /^shop-app:/);
      assert.equal(
        validateRuntimeConfig({ registry, adapter }, process.env, appRoot).prefix,
        state.prefixes[0],
        'a producer and a worker started in one app and environment share a queue',
      );
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });

  it('keeps an explicit prefix', async () => {
    const { adapter, state } = fakeAdapter();
    const runtime = await runExtensions([jobsPlugin({ registry, adapter, prefix: 'mine' })], {
      rootDir: import.meta.dirname,
    });
    try {
      await runtime.services.get(jobsToken).dispatch('sendEmail', { to: 'a@b.co', subject: 'x' });
    } finally {
      await runtime.close();
    }
    assert.deepEqual(state.prefixes, ['mine']);
  });

  it('rejects a non-object registry at construction', () => {
    assert.throws(() => jobsPlugin({ registry: null } as never), TypeError);
    assert.throws(() => jobsPlugin(null as never), TypeError);
  });

  it('exposes a stable jobsToken singleton', async () => {
    assert.equal(jobsToken.name, 'jobs');
    const again = await import('../../src/jobs/plugin.js');
    assert.equal(again.jobsToken, jobsToken);
  });
});

describe('jobsPlugin concurrent first dispatch', () => {
  it('builds exactly one runtime for concurrent first dispatches and closes it', async () => {
    const { adapter, state } = fakeAdapter();
    const ext = await runExtensions([jobsPlugin({ registry, adapter })], {
      rootDir: import.meta.dirname,
    });
    const service: JobsService = ext.services.get(jobsToken);
    await Promise.all([
      service.dispatch('sendEmail', { to: 'a@b.co', subject: 'one' }),
      service.dispatch('sendEmail', { to: 'c@d.co', subject: 'two' }),
      service.dispatch('sendEmail', { to: 'e@f.co', subject: 'three' }),
    ]);
    assert.equal(state.producerCreates, 1);
    assert.equal(state.dispatched.length, 3);
    await ext.close();
    assert.equal(state.producerCloses, 1);
  });

  it('validates retention options eagerly', () => {
    assert.throws(() => jobsPlugin({ registry, removeOnComplete: -5 }), /removeOnComplete/);
  });
});

describe('jobsPlugin lifecycle units', () => {
  /** The units `plugin` registers, as plain data. */
  async function unitsOf(plugin: ReturnType<typeof jobsPlugin>) {
    const runtime = await runExtensions([plugin], {
      rootDir: import.meta.dirname,
      units: 'collect',
    });
    try {
      return runtime.units.map(({ unit, roles, after, transport }) => ({
        name: unit.name,
        roles,
        after,
        transport,
      }));
    } finally {
      await runtime.close();
    }
  }

  it('registers the producer for web and worker and the worker after it, on the adapter reach', async () => {
    assert.deepEqual(await unitsOf(jobsPlugin({ registry, adapter: new MemoryJobsAdapter() })), [
      {
        name: 'jobs.producer',
        roles: ['web', 'worker'],
        after: [],
        transport: { name: 'jobs', reach: 'process' },
      },
      {
        name: 'jobs.worker',
        roles: ['worker'],
        after: ['jobs.producer'],
        transport: { name: 'jobs', reach: 'process' },
      },
    ]);
    const custom = await unitsOf(jobsPlugin({ registry, adapter: fakeAdapter().adapter }));
    assert.deepEqual(
      custom.map(({ transport }) => transport),
      [undefined, undefined],
      'a custom adapter that declares no reach is not checked',
    );
  });

  it('starts the worker: registers the schedules without pruning, then processes jobs with the app services', async () => {
    const calls: string[] = [];
    const { adapter } = fakeAdapter();
    const scheduling: JobsRuntimeAdapter = {
      ...adapter,
      async upsertSchedules(_producer, schedules) {
        calls.push(`upsert:${schedules.map((entry) => entry.id).join(',')}`);
      },
      async listSchedules() {
        calls.push('list');
        return [];
      },
      async removeSchedules() {
        calls.push('remove');
      },
      createWorker() {
        calls.push('worker');
        return { close: () => Promise.resolve() };
      },
    };
    const runtime = await runExtensions(
      [
        jobsPlugin({
          registry,
          adapter: scheduling,
          schedules: [
            {
              id: 'nightly',
              job: 'sendEmail',
              cron: '0 3 * * *',
              data: { to: 'a@b.co', subject: 'x' },
            },
          ],
        }),
      ],
      { rootDir: import.meta.dirname, units: 'collect', roles: ['worker'] },
    );
    try {
      const worker = runtime.units.find(({ unit }) => unit.name === 'jobs.worker');
      assert.ok(worker !== undefined);
      await worker.unit.start();
      assert.deepEqual(calls, ['upsert:nightly', 'worker']);
      await worker.unit.drain(new AbortController().signal);
    } finally {
      await runtime.close();
    }
  });

  it('reads the app root jsails.schedules.json when no schedules are declared', async () => {
    const appRoot = mkdtempSync(join(tmpdir(), 'jsails-jobs-schedules-'));
    try {
      writeFileSync(
        join(appRoot, 'jsails.schedules.json'),
        JSON.stringify([
          {
            id: 'from-file',
            job: 'sendEmail',
            intervalMs: 60_000,
            data: { to: 'a@b.co', subject: 'x' },
          },
        ]),
      );
      const upserted: string[] = [];
      const { adapter } = fakeAdapter();
      const runtime = await runExtensions(
        [
          jobsPlugin({
            registry,
            adapter: {
              ...adapter,
              async upsertSchedules(_producer, schedules) {
                upserted.push(...schedules.map((entry) => entry.id));
              },
            },
          }),
        ],
        { rootDir: appRoot, units: 'collect', roles: ['worker'] },
      );
      try {
        const worker = runtime.units.find(({ unit }) => unit.name === 'jobs.worker');
        await worker?.unit.start();
        assert.deepEqual(upserted, ['from-file']);
      } finally {
        await runtime.close();
      }
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });

  it('runs a dispatched job on the worker over one shared in-memory adapter, and aborts it', async () => {
    const ran: unknown[] = [];
    const adapter = new MemoryJobsAdapter();
    const jobs = createJobRegistry({
      record: defineJob(z.number(), (payload) => {
        ran.push(payload);
      }),
    });
    const runtime = await runExtensions([jobsPlugin({ registry: jobs, adapter })], {
      rootDir: import.meta.dirname,
      units: 'collect',
      roles: ['web', 'worker'],
    });
    try {
      for (const { unit } of runtime.units) await unit.start();
      await runtime.services.get(jobsToken).dispatch('record', 7);
      await adapter.drain();
      assert.deepEqual(ran, [7]);
      for (const { unit } of [...runtime.units].reverse()) await unit.abort();
    } finally {
      await runtime.close();
    }
  });

  it('starts the worker in an application created without roles, and not in a web one', async () => {
    const appRoot = mkdtempSync(join(tmpdir(), 'jsails-jobs-roles-'));
    writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'jobs-roles' }));
    try {
      const { adapter } = fakeAdapter();
      const shared: JobsRuntimeAdapter = { ...adapter, reach: 'shared' };
      const unitsFor = async (roles?: readonly PluginRole[]) => {
        const app = await createApplication(
          createLoadedApp(
            { rootDir: appRoot, extensions: [jobsPlugin({ registry, adapter: shared })] },
            { cwd: appRoot },
          ),
          roles === undefined ? {} : { roles },
        );
        try {
          return { roles: app.roles, units: app.units };
        } finally {
          await app.close();
        }
      };
      // One process doing everything: a custom server entry that serves it
      // consumes the queue too.
      assert.deepEqual(await unitsFor(), {
        roles: ['web', 'worker'],
        units: ['jobs.producer', 'jobs.worker'],
      });
      assert.deepEqual(await unitsFor(['web']), { roles: ['web'], units: ['jobs.producer'] });
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });

  it('validates the worker options eagerly', () => {
    assert.throws(() => jobsPlugin({ registry, schedules: {} as never }), /schedules/);
    assert.throws(() => jobsPlugin({ registry, jobTimeoutMs: 0 }), /jobTimeoutMs/);
    assert.throws(() => jobsPlugin({ registry, shutdownTimeoutMs: -1 }), /shutdownTimeoutMs/);
    assert.throws(() => jobsPlugin({ registry, failedJobs: {} as never }), /failedJobs/);
  });
});
