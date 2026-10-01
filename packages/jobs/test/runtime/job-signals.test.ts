/**
 * The job signals: each settle event maps to one frozen payload on its token,
 * a name that is not a job name is left out, an observer's error is isolated
 * by the bus, and a bus that rejects is surfaced as an uncaught exception in
 * a process of its own (a test process treats one as a failure).
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, test } from 'node:test';

import { createInterceptorRegistry } from 'jsails/extensions';
import { RegistrySignalBus } from 'jsails/signals';

import type {
  AttemptOutcome,
  ProcessJob,
  SettleEvent,
  TransportJob,
} from '../../src/contract/index.js';
import { buildEnvelope } from '../../src/envelope/codec.js';
import { MemoryJobsAdapter } from '../../src/memory/memory-adapter.js';
import { defineQueues } from '../../src/queues/queue-set.js';
import { emitSettleSignal, jobCompleted } from '../../src/runtime/job-signals.js';
import { RecordingSignalBus } from '../memory/recording-bus.js';

function job(name = 'report.send', attemptsMade = 1): TransportJob {
  const envelope = buildEnvelope({
    name: 'placeholder',
    payload: null,
    options: {},
    dispatchedAt: 0,
  });
  return {
    id: '9',
    queue: 'default',
    envelope: { ...envelope, name },
    attemptsMade,
    unknownReleases: 0,
  };
}

const summary = { code: 'jobs.attempt_timeout', kind: 'timeout', name: 'JobsError' } as const;

describe('job signals', () => {
  test('each outcome maps to one frozen payload on its token', () => {
    const bus = new RecordingSignalBus();
    const cases: [AttemptOutcome, boolean, string, Record<string, unknown>][] = [
      [{ kind: 'completed' }, true, 'jobs.completed', { discarded: undefined }],
      [{ kind: 'discarded', error: summary }, true, 'jobs.completed', { discarded: summary }],
      [{ kind: 'skipped', reason: 'overlap' }, true, 'jobs.skipped', { reason: 'overlap' }],
      [
        { kind: 'released', reason: 'shutdown' },
        false,
        'jobs.released',
        { reason: 'shutdown', delayMs: undefined },
      ],
      [
        { kind: 'released', reason: 'rate_limited', delayMs: 10 },
        false,
        'jobs.released',
        { reason: 'rate_limited', delayMs: 10 },
      ],
      [
        { kind: 'released', reason: 'unknown_job', delayMs: 500 },
        false,
        'jobs.released',
        { reason: 'unknown_job', delayMs: 500 },
      ],
      [
        { kind: 'failed', error: summary, retryable: true },
        false,
        'jobs.failed',
        { error: summary, retryable: true, final: false },
      ],
      [
        { kind: 'failed', error: summary, retryable: false },
        true,
        'jobs.failed',
        { error: summary, retryable: false, final: true },
      ],
    ];
    for (const [outcome, final, token, fields] of cases) {
      const event: SettleEvent = { job: job(), outcome, final, failedJob: undefined };
      emitSettleSignal(bus, event);
      const emitted = bus.emitted.at(-1);
      assert.equal(emitted?.name, token);
      assert.deepEqual(emitted.payload, {
        id: '9',
        queue: 'default',
        name: 'report.send',
        attempt: 2,
        ...fields,
      });
      assert.equal(Object.isFrozen(emitted.payload), true);
    }
    assert.equal(bus.emitted.length, cases.length);
  });

  test('a failure kept in the failed set names it, and only by id and queue', () => {
    const bus = new RecordingSignalBus();
    emitSettleSignal(bus, {
      job: job(),
      outcome: { kind: 'failed', error: summary, retryable: false },
      final: true,
      failedJob: { id: '9', queue: 'default', extra: 'not carried' } as SettleEvent['failedJob'],
    });
    const payload = bus.emitted[0]?.payload as { failedJob?: unknown };
    assert.deepEqual(payload.failedJob, { id: '9', queue: 'default' });
    assert.equal(Object.isFrozen(payload.failedJob), true);
  });

  test('a name that is not a job name is left out', () => {
    const bus = new RecordingSignalBus();
    emitSettleSignal(bus, {
      job: job('Not A Name\n'),
      outcome: { kind: 'completed' },
      final: true,
      failedJob: undefined,
    });
    assert.equal((bus.emitted[0]?.payload as { name?: unknown }).name, undefined);
  });

  test("an observer's error is isolated and the worker keeps running", async () => {
    const registry = createInterceptorRegistry();
    const bus = new RegistrySignalBus(registry);
    let observed = 0;
    registry.observe(jobCompleted, () => {
      observed += 1;
      throw new Error('observer');
    });
    const adapter = new MemoryJobsAdapter({
      namespace: 'app:test',
      queues: defineQueues({}).declarations,
    });
    const process: ProcessJob = () => Promise.resolve({ kind: 'completed' });
    await adapter.startWorker(
      { queues: ['default'], onSettle: (event) => emitSettleSignal(bus, event) },
      process,
    );
    const envelope = buildEnvelope({
      name: 'work',
      payload: null,
      options: {},
      dispatchedAt: Date.now(),
    });
    await adapter.enqueue('default', envelope);
    await adapter.enqueue('default', envelope);
    for (let index = 0; index < 20 && adapter.counts('default').completed < 2; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(adapter.counts('default').completed, 2);
    assert.equal(observed, 2);
    await adapter.close();
  });

  test('a bus that rejects or throws is surfaced as an uncaught exception, never dropped', async () => {
    const signals = new URL('../../src/runtime/job-signals.js', import.meta.url).href;
    const source = `
      import { emitSettleSignal } from ${JSON.stringify(signals)};
      const mode = process.argv[1];
      process.on('uncaughtException', (error) => {
        process.stdout.write('uncaught:' + error.message + '\\n');
        process.exit(0);
      });
      const bus = {
        observe() {},
        emit() {
          if (mode === 'throw') throw new Error('bus threw');
          return Promise.reject(new Error('bus rejected'));
        },
      };
      const job = { id: '1', queue: 'default', envelope: { name: 'work' }, attemptsMade: 0, unknownReleases: 0 };
      emitSettleSignal(bus, { job, outcome: { kind: 'completed' }, final: true });
      process.stdout.write('returned\\n');
      setTimeout(() => process.exit(3), 2000);
    `;
    for (const [mode, message] of [
      ['reject', 'bus rejected'],
      ['throw', 'bus threw'],
    ] as const) {
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, ['--input-type=module', '-e', source, mode], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      const status = await new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });
      assert.equal(status, 0, mode);
      assert.equal(stdout, `returned\nuncaught:${message}\n`, mode);
    }
  });
});
