/**
 * The worker process of the spawned two-process tests: a runtime worker
 * over the Valkey transport on the namespace `JOBS_NAMESPACE`, reporting
 * `{ type: 'ready' }` once it fetches and every handler run over IPC. A
 * `stop` message drains it, closes the adapter and its connections, and
 * lets go of the channel. `ROLE=doomed` makes `hang` never settle, so the
 * test can kill this process mid-attempt.
 */

import { createValkeyConnections } from 'jsails/plugin-sdk';

import { startRuntimeWorker } from '../../../src/runtime/runtime-worker.js';
import { valkeyJobs } from '../../../src/valkey/index.js';
import { unusedJobs } from '../../runtime/fixtures/unused-jobs.js';
import { PROCESS_QUEUES, processCatalog, type RunReport } from './process-jobs.js';

const namespace = process.env.JOBS_NAMESPACE ?? '';
const url = process.env.VALKEY_URL ?? '';
const lockDurationMs = Number(process.env.LOCK_MS ?? '5000');

function send(message: RunReport | { readonly type: 'ready' }): void {
  process.send?.(message);
}

const connections = createValkeyConnections(url, {
  appPrefix: namespace,
  name: 'jsails-jobs-test',
});
const adapter = await valkeyJobs({ connections, lockDurationMs })({
  namespace,
  queues: PROCESS_QUEUES.declarations,
});
const worker = await startRuntimeWorker({
  catalog: processCatalog(process.env.ROLE === 'doomed' ? 'doomed' : 'healthy', send),
  adapter,
  jobs: unusedJobs,
});
send({ type: 'ready' });

async function stop(): Promise<void> {
  await worker.drain();
  await adapter.close();
  await connections.close();
}

process.on('message', (message: { readonly type?: unknown }) => {
  if (message.type !== 'stop') return;
  stop().then(
    () => process.disconnect?.(),
    (error: unknown) => {
      process.exitCode = 1;
      process.stderr.write(`worker stop failed: ${String(error)}\n`);
      process.disconnect?.();
    },
  );
});
