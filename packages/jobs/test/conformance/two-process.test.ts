/**
 * A producer and a worker in separate processes over today's in-process
 * memory adapter. Correct behaviour is one of two things: the job runs, or the
 * split is refused because the adapter cannot reach another process. A refusal
 * exits non-zero naming `adapter_not_shared`. Today neither happens: the
 * producer's dispatch succeeds and the job is lost (listed in
 * `scripts/expected-failures/jobs.json`).
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const SETUP = `
  import { JobsRuntimeImpl, MemoryJobsAdapter, createJobRegistry, defineJob } from 'jsails/jobs';
  import { z } from 'zod';
  const registry = createJobRegistry({
    ping: defineJob(z.unknown(), () => { process.stdout.write('ran\\n'); }),
  });
  const runtime = new JobsRuntimeImpl({ registry, adapter: new MemoryJobsAdapter(), onJobFailed: false });
`;

const WORKER = `${SETUP}
  await runtime.startWorker();
  process.stdout.write('ready\\n');
  setTimeout(async () => { await runtime.close(); }, 1500);
`;

const PRODUCER = `${SETUP}
  await runtime.dispatch('ping', null);
  await runtime.close();
  process.stdout.write('dispatched\\n');
`;

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run an ESM snippet in its own process, from this package so `jsails` resolves. */
function run(source: string, onLine?: (line: string) => void): Promise<Run> {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    cwd: new URL('../../..', import.meta.url),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    for (const line of chunk.split('\n')) if (line !== '') onLine?.(line);
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('a job dispatched in another process than the worker is run or refused', async () => {
  let ready: () => void = () => undefined;
  const workerReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const worker = run(WORKER, (line) => {
    if (line === 'ready') ready();
  });
  // A worker that dies before 'ready' (an import error) fails at once.
  await Promise.race([
    workerReady,
    worker.then((result) => {
      throw new Error(
        `the worker process exited before it was ready (status ${String(result.status)}): ${result.stderr.slice(0, 500)}`,
      );
    }),
  ]);
  const producer = await run(PRODUCER);
  const workerRun = await worker;
  const ran = workerRun.stdout.includes('ran');
  // A refusal names the reason; any other non-zero exit is a broken fixture.
  const refused = producer.status !== 0 && /adapter_not_shared/.test(producer.stderr);
  assert.ok(
    refused || (producer.status === 0 && producer.stdout.includes('dispatched')),
    `the producer process failed for another reason: ${producer.stderr.slice(0, 500)}`,
  );
  assert.equal(workerRun.status, 0, `the worker process failed: ${workerRun.stderr.slice(0, 500)}`);
  assert.ok(
    ran || refused,
    'a job dispatched by another process over a process-local adapter was neither run nor refused',
  );
});
