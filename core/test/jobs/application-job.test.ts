import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { ApplicationJob, JobContextError } from '../../src/jobs/application-job.js';
import { createJobRegistry, type JobContext } from '../../src/jobs/registry.js';
import {
  JobsRuntimeImpl,
  type JobsRuntimeAdapter,
  type ProcessJob,
  type RuntimeJob,
} from '../../src/jobs/runtime.js';

interface Captured {
  readonly logs: string[];
  readonly progress: Array<number | Record<string, unknown>>;
  readonly dispatched: Array<{ name: string; payload: unknown; opts?: unknown }>;
  seen?: {
    jobId: string | undefined;
    jobName: string;
    attemptsMade: number;
    attemptsStarted: number;
    first: boolean;
  };
}

function context(captured: Captured): JobContext {
  return {
    jobId: 'job-1',
    name: 'test',
    attemptsMade: 2,
    attemptsStarted: 3,
    log: async (message) => {
      captured.logs.push(message);
    },
    updateProgress: async (progress) => {
      captured.progress.push(progress);
    },
    dispatch: async (name, payload, opts) => {
      captured.dispatched.push({ name, payload, opts });
    },
  };
}

class TestJob extends ApplicationJob<{ n: number }> {
  static readonly jobName = 'test';
  static readonly schema = z.object({ n: z.number() });
  readonly captured?: Captured;

  constructor(ctx: JobContext, captured?: Captured) {
    super(ctx);
    this.captured = captured;
  }

  async handle(data: { n: number }): Promise<void> {
    if (this.captured !== undefined) {
      this.captured.seen = {
        jobId: this.jobId,
        jobName: this.jobName,
        attemptsMade: this.attemptsMade,
        attemptsStarted: this.attemptsStarted,
        first: this.isFirstAttempt,
      };
    }
    await this.log(`n=${data.n}`);
    await this.updateProgress(50);
    await this.dispatch('child', { parent: data.n });
  }
}

describe('ApplicationJob', () => {
  it('exposes job context tools and nested dispatch', async () => {
    const captured: Captured = { logs: [], progress: [], dispatched: [] };
    const job = new TestJob(context(captured), captured);

    await job.handle({ n: 7 });

    assert.deepEqual(captured.logs, ['n=7']);
    assert.deepEqual(captured.progress, [50]);
    assert.deepEqual(captured.dispatched, [
      { name: 'child', payload: { parent: 7 }, opts: undefined },
    ]);
    assert.deepEqual(captured.seen, {
      jobId: 'job-1',
      jobName: 'test',
      attemptsMade: 2,
      attemptsStarted: 3,
      first: false,
    });
  });

  it('registers a class definition by its registry key', () => {
    const registry = createJobRegistry({ test: TestJob });
    assert.equal(registry.test, TestJob);
  });

  it('rejects a class whose static jobName differs from the registry key', () => {
    assert.throws(() => createJobRegistry({ other: TestJob }), /different name/);
  });

  it('rejects a class without a static schema or handle', () => {
    class MissingSchema extends ApplicationJob {
      static readonly jobName = 'missing';
      async handle(): Promise<void> {}
    }
    assert.throws(() => createJobRegistry({ missing: MissingSchema }), /static schema/);

    class MissingHandle {
      static readonly schema = z.object({});
    }
    assert.throws(
      () => createJobRegistry({ missing: MissingHandle as unknown as typeof MissingSchema }),
      /static schema|handle/,
    );
  });

  it('throws a value-free error when dispatch is unavailable', async () => {
    const captured: Captured = { logs: [], progress: [], dispatched: [] };
    const ctx = context(captured);
    // Remove the runtime-provided dispatch to simulate a broken context.
    const { dispatch: _dispatch, ...rest } = ctx;
    const job = new TestJob(rest, captured);
    await assert.rejects(
      async () => {
        await job.handle({ n: 1 });
      },
      (error: unknown) => error instanceof JobContextError && error.code === 'dispatch_unavailable',
    );
  });

  it('runs a class job through the neutral runtime', async () => {
    let seen = 0;
    class RuntimeClassJob extends ApplicationJob<{ n: number }> {
      static readonly jobName = 'runtimeClass';
      static readonly schema = z.object({ n: z.number() });
      async handle(data: { n: number }): Promise<void> {
        seen = data.n;
      }
    }
    const registry = createJobRegistry({ runtimeClass: RuntimeClassJob });
    let processJob: ProcessJob | undefined;
    const adapter: JobsRuntimeAdapter = {
      name: 'fake',
      createProducer: () => ({
        dispatch: async () => undefined,
        close: async () => undefined,
      }),
      createWorker: (_context, processor) => {
        processJob = processor;
        return Promise.resolve({ close: async () => undefined });
      },
    };
    const runtime = new JobsRuntimeImpl({ registry, adapter });
    await runtime.startWorker();
    const job: RuntimeJob = {
      name: 'runtimeClass',
      data: { n: 42 },
      attemptsMade: 0,
      attemptsStarted: 1,
      log: async () => undefined,
      updateProgress: async () => undefined,
    };
    await processJob!(job);
    assert.equal(seen, 42);
    await runtime.close();
  });

  it('exposes a static dispatch that requires a jobName', async () => {
    class Unnamed extends ApplicationJob {
      static readonly schema = z.object({});
      async handle(): Promise<void> {}
    }
    assert.throws(
      () => Unnamed.dispatch({}),
      (error: unknown) => error instanceof JobContextError && error.code === 'missing_job_name',
    );
  });
});
