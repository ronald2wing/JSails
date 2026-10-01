/**
 * The poisoned-worker rule across processes. This process holds the
 * transport (a memory adapter) and plays a shared transport's lock: each
 * delivery goes to a forked worker over IPC and stays held until that worker
 * reports its outcome or dies. A stuck attempt past its grace makes the
 * worker exit with code 75; only then is its job delivered again, to a fresh
 * worker, so it never runs twice at once. The cooperative attempt beside it
 * comes back released without spending an attempt. A host whose own
 * shutdown path then reports success still exits with 75.
 */

import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type {
  AdapterWorker,
  AttemptOutcome,
  ProcessJob,
  SettleEvent,
} from '../../src/contract/index.js';
import { buildEnvelope } from '../../src/envelope/codec.js';
import { MemoryJobsAdapter } from '../../src/memory/memory-adapter.js';
import { defineQueues } from '../../src/queues/queue-set.js';
import type { ChildMessage, ParentMessage } from './fixtures/process-bridge.js';

const CHILD = fileURLToPath(new URL('./fixtures/worker-child.js', import.meta.url));
const EXIT_BOUND_MS = 10_000;

interface Child {
  readonly process: ChildProcess;
  readonly exited: Promise<number | null>;
  readonly ready: Promise<void>;
  readonly stderr: () => string;
}

interface Served extends Child {
  /** Resolves once the transport took back what the dead child held. */
  readonly released: Promise<void>;
}

/** Fork a worker child; every message it sends is logged as `<label>:<type>[:<name>:<attempt>]`. */
function spawnChild(
  label: string,
  env: Record<string, string>,
  log: string[],
  onMessage: (message: ChildMessage) => void,
): Child {
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = fork(CHILD, [], {
    env: childEnv,
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let ready: () => void = () => undefined;
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.on('message', (message: ChildMessage) => {
    log.push(
      message.type === 'started'
        ? `${label}:started:${message.name}:${message.attempt}`
        : `${label}:${message.type}`,
    );
    if (message.type === 'ready') ready();
    onMessage(message);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      log.push(`${label}:exit`);
      resolve(code);
    });
  });
  return { process: child, exited, ready: readyPromise, stderr: () => stderr };
}

function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
  });
  return Promise.race([work, bound]).finally(() => clearTimeout(timer));
}

/**
 * Hold the transport for one child at a time: the memory adapter's worker
 * forwards each delivery to the child and keeps it held until the child
 * reports or dies.
 */
class Lock {
  readonly adapter = new MemoryJobsAdapter({
    namespace: 'app:test',
    queues: defineQueues({ default: { concurrency: 2 } }).declarations,
  });
  readonly settles: SettleEvent[] = [];
  readonly log: string[] = [];
  #pending = new Map<string, (outcome: AttemptOutcome) => void>();

  async enqueue(name: string, timeoutMs?: number): Promise<void> {
    await this.adapter.enqueue(
      'default',
      buildEnvelope({
        name,
        payload: null,
        options: timeoutMs === undefined ? {} : { timeoutMs },
        dispatchedAt: Date.now(),
      }),
    );
  }

  /** Fork a child and deliver to it until it stops fetching or dies. */
  async serve(label: string, env: Record<string, string>): Promise<Served> {
    let worker: AdapterWorker | undefined;
    const child = spawnChild(label, env, this.log, (message) => {
      if (message.type === 'outcome') {
        this.#pending.get(message.id)?.(message.outcome);
        this.#pending.delete(message.id);
      }
      // The child stopped fetching: stop delivering, keeping what it holds.
      // The memory worker's drain only rejects for a broken adapter, which the
      // test's own assertions on counts and outcomes then report.
      if (message.type === 'stopping') worker?.drain().catch(() => undefined);
    });
    await child.ready;
    const process: ProcessJob = (job) =>
      new Promise((resolve) => {
        this.#pending.set(job.id, resolve);
        const message: ParentMessage = { type: 'deliver', job };
        child.process.send(message);
      });
    worker = await this.adapter.startWorker(
      { queues: ['default'], onSettle: (event) => this.settles.push(event) },
      process,
    );
    const held = worker;
    // A dead holder's lock lapses: stop delivering, then return what it held.
    const released = child.exited.then(async () => {
      const stopping = held.abort();
      for (const resolve of this.#pending.values()) {
        resolve({ kind: 'released', reason: 'shutdown' });
      }
      this.#pending.clear();
      await stopping;
    });
    return { ...child, released };
  }

  outcomes(name: string): string[] {
    return this.settles
      .filter((event) => event.job.envelope.name === name)
      .map((event) => event.outcome.kind);
  }
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + EXIT_BOUND_MS;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('poisoned worker, across processes', () => {
  test('a stuck attempt past its grace exits the worker with 75; its job runs again only after', async () => {
    const lock = new Lock();
    await lock.enqueue('stuck', 100);
    await lock.enqueue('cooperative');
    const first = await lock.serve('first', { ROLE: 'poisoned' });
    const code = await bounded(first.exited, EXIT_BOUND_MS, 'the poisoned worker exit');
    assert.equal(code, 75);
    assert.equal(lock.log.filter((line) => line === 'first:started:stuck:1').length, 1);
    assert.match(first.stderr(), /exits with code 75 \(1 attempts held\)/);
    assert.deepEqual(lock.outcomes('cooperative'), ['released']);
    await first.released;
    assert.equal(lock.adapter.counts('default').waiting, 2, 'the stuck job was not returned');
    const second = await lock.serve('second', { ROLE: 'healthy' });
    await until(() => lock.adapter.counts('default').completed === 2, 'both jobs completed');
    second.process.send({ type: 'stop' } satisfies ParentMessage);
    assert.equal(await bounded(second.exited, EXIT_BOUND_MS, 'the healthy worker exit'), 0);
    await second.released;
    const exit = lock.log.indexOf('first:exit');
    const rerun = lock.log.indexOf('second:started:stuck:1');
    assert.ok(
      exit !== -1 && rerun > exit,
      `the stuck job ran again before its holder died: ${lock.log.join(', ')}`,
    );
    assert.equal(lock.log.filter((line) => line.endsWith(':started:stuck:1')).length, 2);
    assert.ok(lock.log.includes('second:started:cooperative:1'), 'the release spent an attempt');
    assert.deepEqual(lock.outcomes('stuck'), ['released', 'completed']);
    assert.deepEqual(lock.outcomes('cooperative'), ['released', 'completed']);
    await lock.adapter.close();
  });

  for (const hostExit of ['code', 'call']) {
    test(`a host whose shutdown reports success (HOST_EXIT=${hostExit}) still exits with 75`, async () => {
      const lock = new Lock();
      await lock.enqueue('stuck', 100);
      const child = await lock.serve('only', { ROLE: 'poisoned', HOST_EXIT: hostExit });
      assert.equal(await bounded(child.exited, EXIT_BOUND_MS, 'the poisoned worker exit'), 75);
      await child.released;
      assert.equal(lock.adapter.counts('default').waiting, 1, 'the stuck job was not returned');
      await lock.adapter.close();
    });
  }

  test('without a SIGTERM listener the worker exits with 75 directly', async () => {
    const lock = new Lock();
    await lock.enqueue('stuck', 100);
    const child = await lock.serve('only', { ROLE: 'poisoned', SIGTERM_LISTENER: 'none' });
    assert.equal(await bounded(child.exited, EXIT_BOUND_MS, 'the poisoned worker exit'), 75);
    await child.released;
    assert.equal(lock.adapter.counts('default').waiting, 1, 'the stuck job was not returned');
    await lock.adapter.close();
  });
});
