/**
 * The one place BullMQ is loaded: an absent `bullmq` is a value-free
 * `jobs.missing_dependency`, any other failure propagates as is, the
 * installed BullMQ maps onto the transport's interface, and the mapping
 * hands BullMQ every option and call as given, a closing flow producer
 * included.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ValkeyClient } from 'jsails/plugin-sdk';

import { JobsErrors } from '../../src/errors/jobs-errors.js';
import { loadBullmq } from '../../src/valkey/bullmq-module.js';
import type { BullJob, BullJobOptions } from '../../src/valkey/bullmq-surface.js';

/** What `loadBullmq` imports: BullMQ's module type, named without importing it here. */
type BullmqImport = Awaited<ReturnType<NonNullable<Parameters<typeof loadBullmq>[0]>>>;

function notFound(specifier: string): Error {
  return Object.assign(new Error(`Cannot find package '${specifier}' imported from /app/x.js`), {
    code: 'ERR_MODULE_NOT_FOUND',
  });
}

test('an absent bullmq is missing_dependency naming it, with no path in the message', async () => {
  await assert.rejects(
    loadBullmq(() => Promise.reject(notFound('bullmq'))),
    (error: unknown) => {
      assert.ok(JobsErrors.is(error, 'missing_dependency'));
      assert.deepEqual({ ...error.context }, { dependency: 'bullmq' });
      assert.doesNotMatch(error.message, /\/app/);
      return true;
    },
  );
});

test('a dependency of bullmq missing, or any other failure, propagates as is', async () => {
  const inner = notFound('ioredis');
  await assert.rejects(
    loadBullmq(() => Promise.reject(inner)),
    (error: unknown) => error === inner,
  );
  const broken = new SyntaxError('bad module');
  await assert.rejects(
    loadBullmq(() => Promise.reject(broken)),
    (error: unknown) => error === broken,
  );
});

test('the installed bullmq maps onto the transport interface', async () => {
  const module = await loadBullmq();
  assert.equal(module.unrecoverable('x').name, 'UnrecoverableError');
  assert.equal(module.waiting().name, 'WaitingError');
  assert.equal(module.delayed().name, 'DelayedError');
  assert.equal(typeof module.createQueue, 'function');
  assert.equal(typeof module.createWorker, 'function');
});

interface RecordedWorker {
  readonly processor: (job: unknown, token?: string) => Promise<unknown>;
  readonly options: {
    readonly settings: { readonly backoffStrategy: (...args: unknown[]) => number };
  };
}

/** A stand-in for BullMQ's classes that logs every construction and call. */
function recordingBullmq(): {
  readonly module: BullmqImport;
  readonly log: unknown[][];
  readonly workers: RecordedWorker[];
  readonly flows: { closing: boolean };
} {
  const log: unknown[][] = [];
  const workers: RecordedWorker[] = [];
  const flows = { closing: false };
  class Emitter {
    on(event: string, listener: unknown): this {
      log.push(['on', event, typeof listener]);
      return this;
    }
  }
  class Queue extends Emitter {
    constructor(name: string, options: unknown) {
      super();
      log.push(['Queue', name, options]);
    }
    add(name: string, data: unknown, options: unknown) {
      log.push(['add', name, data, options]);
      return Promise.resolve({ id: 'job-1' });
    }
    getJob(id: string) {
      log.push(['getJob', id]);
      return Promise.resolve(undefined);
    }
    waitUntilReady() {
      log.push(['queue ready']);
      return Promise.resolve();
    }
    close() {
      log.push(['queue close']);
      return Promise.resolve();
    }
  }
  class Worker extends Emitter implements RecordedWorker {
    readonly processor: RecordedWorker['processor'];
    readonly options: RecordedWorker['options'];
    constructor(
      name: string,
      processor: RecordedWorker['processor'],
      options: RecordedWorker['options'],
    ) {
      super();
      this.processor = processor;
      this.options = options;
      log.push(['Worker', name]);
      workers.push(this);
    }
    waitUntilReady() {
      log.push(['worker ready']);
      return Promise.resolve();
    }
    close(force?: boolean) {
      log.push(['worker close', force]);
      return Promise.resolve();
    }
  }
  class FlowProducer extends Emitter {
    constructor(options: unknown) {
      super();
      log.push(['FlowProducer', options]);
    }
    addBulk(jobs: unknown) {
      log.push(['addBulk', jobs]);
      return Promise.resolve(flows.closing ? undefined : jobs);
    }
    waitUntilReady() {
      log.push(['flows ready']);
      return Promise.resolve();
    }
    close() {
      log.push(['flows close']);
      return Promise.resolve();
    }
  }
  class UnrecoverableError extends Error {}
  class WaitingError extends Error {}
  class DelayedError extends Error {}
  const module = { Queue, Worker, FlowProducer, UnrecoverableError, WaitingError, DelayedError };
  return { module: module as unknown as BullmqImport, log, workers, flows };
}

const connection = {} as ValkeyClient;

function jobOptions(jobId: string): BullJobOptions {
  return {
    jobId,
    attempts: 3,
    backoff: { type: 'envelope' },
    removeOnComplete: { age: 3_600, count: 1_000 },
    removeOnFail: { age: 604_800, count: 100_000 },
  };
}

test('a queue hands BullMQ its options, and each add a copy of its job options', async () => {
  const bullmq = recordingBullmq();
  const module = await loadBullmq(() => Promise.resolve(bullmq.module));
  const options = jobOptions('job-1');
  const queue = module.createQueue('default', { connection, prefix: 'app:jobs' });
  await queue.add('send', { to: 1 }, options);
  await queue.getJob('job-1');
  await queue.waitUntilReady();
  queue.on('error', () => undefined);
  await queue.close();
  assert.deepEqual(bullmq.log, [
    ['Queue', 'default', { connection, prefix: 'app:jobs' }],
    ['add', 'send', { to: 1 }, options],
    ['getJob', 'job-1'],
    ['queue ready'],
    ['on', 'error', 'function'],
    ['queue close'],
  ]);
  assert.notEqual(bullmq.log[1]![3], options, 'BullMQ mutates the options it is given');
});

test('a worker hands BullMQ its options, its processor and its backoff, and routes each event', async () => {
  const bullmq = recordingBullmq();
  const module = await loadBullmq(() => Promise.resolve(bullmq.module));
  const processed: unknown[] = [];
  const backoff: unknown[] = [];
  const worker = module.createWorker(
    'default',
    (job, token) => {
      processed.push([job, token]);
      return Promise.resolve('c');
    },
    {
      connection,
      prefix: 'app:jobs',
      concurrency: 2,
      lockDuration: 30_000,
      stalledInterval: 30_000,
      maxStalledCount: 5,
      settings: {
        backoffStrategy: (...args) => {
          backoff.push(args);
          return 250;
        },
      },
    },
  );
  const recorded = bullmq.workers[0]!;
  assert.deepEqual(
    { ...recorded.options, settings: undefined },
    {
      connection,
      prefix: 'app:jobs',
      concurrency: 2,
      lockDuration: 30_000,
      stalledInterval: 30_000,
      maxStalledCount: 5,
      settings: undefined,
    },
  );
  const job = { id: 'job-1' } as BullJob;
  assert.equal(await recorded.processor(job, 'token-1'), 'c');
  assert.deepEqual(processed, [[job, 'token-1']]);
  assert.equal(recorded.options.settings.backoffStrategy(2, 'custom', undefined, { data: 1 }), 250);
  assert.deepEqual(backoff, [[2, 'custom', undefined, { data: 1 }]]);
  assert.equal(
    worker.on('error', () => undefined),
    worker,
  );
  assert.equal(
    worker.on('completed', () => undefined),
    worker,
  );
  assert.equal(
    worker.on('failed', () => undefined),
    worker,
  );
  await worker.waitUntilReady();
  await worker.close(true);
  assert.deepEqual(bullmq.log, [
    ['Worker', 'default'],
    ['on', 'error', 'function'],
    ['on', 'completed', 'function'],
    ['on', 'failed', 'function'],
    ['worker ready'],
    ['worker close', true],
  ]);
});

test('a flow producer adds every job in one bulk add, and a closing one is no add', async () => {
  const bullmq = recordingBullmq();
  const module = await loadBullmq(() => Promise.resolve(bullmq.module));
  const flows = module.createFlowProducer({ connection, prefix: 'app:jobs' });
  const opts = jobOptions('bF.i.0');
  await flows.addBulk([{ queueName: 'mail', name: 'send', data: 1, opts }]);
  assert.deepEqual(bullmq.log.splice(0), [
    ['FlowProducer', { connection, prefix: 'app:jobs' }],
    ['addBulk', [{ name: 'send', queueName: 'mail', data: 1, opts }]],
  ]);
  bullmq.flows.closing = true;
  await assert.rejects(
    flows.addBulk([{ queueName: 'mail', name: 'send', data: 1, opts }]),
    (error: unknown) => JobsErrors.is(error, 'adapter_closed'),
  );
  bullmq.log.splice(0);
  flows.on('error', () => undefined);
  await flows.waitUntilReady();
  await flows.close();
  assert.deepEqual(bullmq.log, [['on', 'error', 'function'], ['flows ready'], ['flows close']]);
});
