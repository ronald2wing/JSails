/**
 * The Valkey transport across processes, on a real server: a producer in
 * this process and a worker in a spawned one share one namespace, so a
 * dispatch here runs there, a batch issued here settles there, and its
 * status reads here. A worker process killed mid-attempt leaves its job to
 * the next worker once its lock lapses: run again within the stall limit,
 * failed for good as `jobs.job_stalled` past it, a batch child then counted
 * as failed and its batch's catch fired. Live and opt-in (see
 * `live-server.ts`).
 */

import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { JobsAdapter } from '../../src/contract/index.js';
import type { JobCatalog } from '../../src/definition/catalog.js';
import { createProducer, type JobProducer } from '../../src/definition/jobs-service.js';
import { startRuntimeWorker, type RuntimeWorker } from '../../src/runtime/runtime-worker.js';
import { valkeyJobs } from '../../src/valkey/index.js';
import { unusedJobs } from '../runtime/fixtures/unused-jobs.js';
import { PROCESS_QUEUES, processCatalog, type RunReport } from './fixtures/process-jobs.js';
import {
  dropNamespace,
  freshNamespace,
  LIVE,
  liveConnections,
  SKIP_REASON,
  VALKEY_URL,
} from './live-server.js';

const CHILD = fileURLToPath(new URL('./fixtures/worker-process.js', import.meta.url));

/** The shortest lock the adapter accepts, so a killed worker's job comes back soon. */
const LOCK_MS = 5_000;

/** Long enough for a lapsed lock to be found (two stalled checks after it lapses) on a loaded runner. */
const REDELIVERY_BOUND_MS = 60_000;

const ROUND_TRIP_BOUND_MS = 20_000;

/** Every run reported by any process of one test, with waiters by predicate. */
class Runs {
  readonly all: RunReport[] = [];
  readonly #waiters = new Set<{
    readonly match: (run: RunReport) => boolean;
    readonly resolve: (run: RunReport) => void;
  }>();

  readonly report = (run: RunReport): void => {
    this.all.push(run);
    for (const waiter of [...this.#waiters]) {
      if (waiter.match(run)) {
        this.#waiters.delete(waiter);
        waiter.resolve(run);
      }
    }
  };

  /** The first run (past or future) `match` accepts; rejects after `ms`. */
  next(match: (run: RunReport) => boolean, ms: number, what: string): Promise<RunReport> {
    const seen = this.all.find(match);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise<RunReport>((resolve, reject) => {
      const waiter = {
        match,
        resolve: (run: RunReport) => {
          clearTimeout(timer);
          resolve(run);
        },
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(new Error(`timed out waiting for ${what}`));
      }, ms);
      this.#waiters.add(waiter);
    });
  }
}

interface Side {
  readonly adapter: JobsAdapter;
  /** The producer's catalog: its calls are the ones the producer takes. */
  readonly catalog: JobCatalog<'default'>;
  readonly producer: JobProducer;
  close(): Promise<void>;
}

/** A producer (and later, maybe, a worker) in this process on `namespace`. */
async function localSide(namespace: string, maxStalledCount: number): Promise<Side> {
  const connections = liveConnections(namespace);
  const adapter = await valkeyJobs({ connections, lockDurationMs: LOCK_MS, maxStalledCount })({
    namespace,
    queues: PROCESS_QUEUES.declarations,
  });
  const catalog = processCatalog('healthy', () => undefined);
  const producer = createProducer({ catalog, adapter });
  return {
    adapter,
    catalog,
    producer,
    async close() {
      producer.close();
      await adapter.close();
      await dropNamespace(connections, namespace);
    },
  };
}

/** A worker process on `namespace`, resolved once it fetches. */
async function spawnWorker(
  namespace: string,
  role: 'doomed' | 'healthy',
  runs: Runs,
): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JOBS_NAMESPACE: namespace,
    VALKEY_URL,
    LOCK_MS: String(LOCK_MS),
    ROLE: role,
  };
  delete env.NODE_TEST_CONTEXT;
  const child = fork(CHILD, [], {
    env,
    execArgv: [],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.on('message', (message: RunReport | { readonly type: 'ready' }) => {
      if (message.type === 'ready') resolve();
      else runs.report(message);
    });
    child.once('exit', (code) => reject(new Error(`the worker process exited early (${code})`)));
  });
  await ready;
  return child;
}

/** Drain a worker process and wait for it to exit. */
async function stopWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.send({ type: 'stop' });
  await exited;
}

/** Kill a worker process mid-attempt and wait until it is gone. */
async function killWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

if (LIVE) {
  describe('the Valkey transport across processes', () => {
    const cleanups: (() => Promise<void>)[] = [];
    after(async () => {
      for (const cleanup of cleanups.reverse()) await cleanup();
    });

    test('a job and a batch dispatched in one process run in a worker process', async () => {
      const namespace = freshNamespace('two-process');
      const runs = new Runs();
      const side = await localSide(namespace, 1);
      cleanups.push(() => side.close());
      const child = await spawnWorker(namespace, 'healthy', runs);
      cleanups.push(() => stopWorker(child));

      const handle = await side.producer.dispatchByName('echo', { n: 1 });
      const ran = await runs.next(
        (run) => run.name === 'echo' && run.jobId === handle.id,
        ROUND_TRIP_BOUND_MS,
        'the dispatched job',
      );
      assert.equal(ran.pid, child.pid, 'the job ran in the worker process');
      assert.deepEqual(ran.payload, { n: 1 });

      const { catalog } = side;
      const echo = catalog.get('echo')!;
      const batch = await side.producer.batch(
        [echo.with({ i: 0 }), echo.with({ i: 1 }), echo.with({ i: 2 })],
        { then: catalog.get('on-then')!.with(null) },
      );
      await runs.next((run) => run.name === 'on-then', ROUND_TRIP_BOUND_MS, 'the batch callback');
      const status = await side.producer.batchStatus(batch.id);
      assert.deepEqual(
        { ...status },
        {
          total: 3,
          completed: 3,
          failed: 0,
          skipped: 0,
          pending: 0,
          settled: true,
          retriedAfterSettlement: 0,
        },
      );
      assert.equal(runs.all.filter((run) => run.name === 'echo').length, 4);
      assert.ok(
        runs.all.every((run) => run.pid === child.pid),
        'every job ran in the worker process',
      );
      await stopWorker(child);
    });

    test('a job whose worker process died runs again on another worker once its lock lapses', async () => {
      const namespace = freshNamespace('two-process');
      const runs = new Runs();
      const side = await localSide(namespace, 1);
      cleanups.push(() => side.close());
      const doomed = await spawnWorker(namespace, 'doomed', runs);
      cleanups.push(() => killWorker(doomed));

      const handle = await side.producer.dispatchByName('hang', null);
      await runs.next((run) => run.jobId === handle.id, ROUND_TRIP_BOUND_MS, 'the first attempt');
      await killWorker(doomed);

      const worker: RuntimeWorker = await startRuntimeWorker({
        catalog: processCatalog('healthy', runs.report),
        adapter: side.adapter,
        jobs: unusedJobs,
      });
      cleanups.push(() => worker.abort());
      const rerun = await runs.next(
        (run) => run.jobId === handle.id && run.pid === process.pid,
        REDELIVERY_BOUND_MS,
        'the redelivered attempt',
      );
      // A lost worker is no failed attempt.
      assert.equal(rerun.attempt, 1);
      await worker.drain();
    });

    test('a batch child whose worker died past the stall limit fails as job_stalled and fires the catch', async () => {
      const namespace = freshNamespace('two-process');
      const runs = new Runs();
      const side = await localSide(namespace, 0);
      cleanups.push(() => side.close());
      const doomed = await spawnWorker(namespace, 'doomed', runs);
      cleanups.push(() => killWorker(doomed));

      const { catalog } = side;
      const batch = await side.producer.batch([catalog.get('hang')!.with(null)], {
        catch: catalog.get('on-catch')!.with(null),
      });
      await runs.next((run) => run.name === 'hang', ROUND_TRIP_BOUND_MS, 'the first attempt');
      await killWorker(doomed);

      const worker = await startRuntimeWorker({
        catalog: processCatalog('healthy', runs.report),
        adapter: side.adapter,
        jobs: unusedJobs,
      });
      cleanups.push(() => worker.abort());
      await runs.next((run) => run.name === 'on-catch', REDELIVERY_BOUND_MS, 'the batch catch');
      assert.equal(
        runs.all.filter((run) => run.name === 'hang').length,
        1,
        'a job past the stall limit runs no code',
      );
      const status = await side.producer.batchStatus(batch.id);
      assert.equal(status?.settled, true);
      assert.equal(status?.failed, 1);
      const failures = await side.producer.batchFailures(batch.id);
      assert.equal(failures[0]?.error.code, 'jobs.job_stalled');
      const failed = await side.adapter.capabilities.failedJobs!.list();
      assert.equal(failed.length, 1);
      assert.equal(failed[0]?.error.code, 'jobs.job_stalled');
      await worker.drain();
    });
  });
} else {
  test('the Valkey transport across processes', { skip: SKIP_REASON }, () => undefined);
}
