/**
 * The worker process of the spawned poisoned-worker test: a runtime worker
 * over the IPC bridge, with the real default `onPoisoned`. `stuck` reports
 * that it started and, on a poisoned run, never settles; `cooperative`
 * reports and, on a poisoned run, rejects once its signal aborts. With
 * `ROLE=healthy` both complete. A `SIGTERM` listener models the host's
 * graceful shutdown (abort the worker, then let go of the channel) unless
 * `SIGTERM_LISTENER=none`; `HOST_EXIT=code` makes that shutdown report
 * success through `process.exitCode = 0`, as the jsails CLI does with a
 * command's result, and `HOST_EXIT=call` through `process.exit(0)`.
 */

import { z } from 'zod';

import { createJobCatalog } from '../../../src/definition/catalog.js';
import { defineJob, type JobContext } from '../../../src/definition/define-job.js';
import { defineQueues } from '../../../src/queues/queue-set.js';
import { startRuntimeWorker } from '../../../src/runtime/runtime-worker.js';
import { bridgeAdapter, send, type ParentMessage } from './process-bridge.js';
import { unusedJobs } from './unused-jobs.js';

const healthy = process.env.ROLE === 'healthy';

function started(context: JobContext): void {
  send({ type: 'started', name: context.name, attempt: context.attempt });
}

const Stuck = defineJob({
  name: 'stuck',
  schema: z.null(),
  handle: (_payload, context) => {
    started(context);
    return healthy ? Promise.resolve() : new Promise<void>(() => undefined);
  },
});

const Cooperative = defineJob({
  name: 'cooperative',
  schema: z.null(),
  handle: (_payload, context) => {
    started(context);
    if (healthy) return Promise.resolve();
    return new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(context.signal.reason), {
        once: true,
      });
    });
  },
});

const worker = await startRuntimeWorker({
  catalog: createJobCatalog({
    queues: defineQueues({ default: { concurrency: 2 } }),
    definitions: [Stuck, Cooperative],
  }),
  adapter: bridgeAdapter(),
  jobs: unusedJobs,
  handlerGraceMs: 300,
  abortCollectMs: 200,
});

function letGo(): void {
  process.disconnect?.();
}

/** The host's graceful shutdown, unaware that the worker was poisoned. */
function shutDown(): void {
  if (process.env.HOST_EXIT === 'call') process.exit(0);
  if (process.env.HOST_EXIT === 'code') process.exitCode = 0;
  letGo();
}

if (process.env.SIGTERM_LISTENER !== 'none') {
  process.on('SIGTERM', () => {
    worker.abort().then(shutDown, shutDown);
  });
}

process.on('message', (message: ParentMessage) => {
  if (message.type === 'stop') worker.drain().then(letGo, letGo);
});

send({ type: 'ready' });
