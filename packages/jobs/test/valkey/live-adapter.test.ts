/**
 * What the conformance suite does not pin about the Valkey transport, on a
 * real server: the settlement cost of a large batch (the record of the last
 * child and the status read cost the same whatever the batch's size), a
 * chunked batch resumed by its id, a batch that is not chunked staged until
 * it is known stored, a batch id issued again once its record expired, a
 * finalizer redelivered after its callbacks were evicted, failed-job paging
 * across queues with its cursor,
 * removal and pruning that keep a key's window, owner-token leases, and the
 * schedule store's compare-and-set and payload precision. Live and opt-in
 * (see `live-server.ts`).
 */

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import type { ValkeyClient } from 'jsails/plugin-sdk';
import { z } from 'zod';

import type { AttemptOutcome, FailedJob, ProcessJob } from '../../src/contract/index.js';
import { createJobCatalog, type JobCatalog } from '../../src/definition/catalog.js';
import { defineJob } from '../../src/definition/define-job.js';
import { createProducer, type JobProducer } from '../../src/definition/jobs-service.js';
import { runtimeSummary } from '../../src/errors/error-summary.js';
import { defineQueues } from '../../src/queues/queue-set.js';
import { schedule } from '../../src/schedules/define-schedule.js';
import { reconcileSchedules } from '../../src/schedules/reconcile.js';
import { realDelay } from '../../src/testing/conformance/recorder.js';
import { encodeFailure } from '../../src/valkey/failure-record.js';
import { keyLayout, type KeyLayout } from '../../src/valkey/key-layout.js';
import type { ValkeyBatches } from '../../src/valkey/valkey-batches.js';
import { bindValkeyScripts } from '../../src/valkey/valkey-scripts.js';
import { startRuntimeWorker } from '../../src/runtime/runtime-worker.js';
import { unusedJobs } from '../runtime/fixtures/unused-jobs.js';
import { LIVE, liveAdapter, SKIP_REASON, type LiveAdapter } from './live-server.js';

const QUEUES = defineQueues({ default: { concurrency: 4 }, mail: {} });

function catalogOf(): JobCatalog<'default' | 'mail'> {
  const noop = (name: string, queue: 'default' | 'mail' = 'default') =>
    defineJob({ name, queue, schema: z.unknown(), handle: () => Promise.resolve() });
  return createJobCatalog({
    queues: QUEUES,
    definitions: [noop('child'), noop('note'), noop('letter', 'mail')],
  });
}

interface Fixture {
  readonly live: LiveAdapter;
  readonly catalog: JobCatalog<'default' | 'mail'>;
  readonly producer: JobProducer;
}

/**
 * Commands this connection has issued, by the server's own count (Valkey 8's
 * `tot-cmds`), which includes every command a script runs: a budget read
 * from it bounds the work on the server, not only the round trips.
 */
async function commandsIssued(client: ValkeyClient): Promise<number> {
  const info = String(await client.call('CLIENT', 'INFO'));
  const match = / tot-cmds=(\d+)/.exec(info);
  if (match === null) throw new Error('the server reports no tot-cmds: the budget needs Valkey 8');
  return Number(match[1]);
}

/** Commands `work` issues on `client`, less the counting call itself. */
async function commandsOf(client: ValkeyClient, work: () => Promise<unknown>): Promise<number> {
  const before = await commandsIssued(client);
  await work();
  return (await commandsIssued(client)) - before - 1;
}

/** The finalizer id batch `id`'s record holds, which names its incarnation. */
async function recordedFinalizerId(
  client: ValkeyClient,
  layout: KeyLayout,
  id: string,
): Promise<string> {
  const finalizerId = await client.hget(layout.batchRecord(id), 'fid');
  if (finalizerId === null) throw new Error('the batch has no record');
  return finalizerId;
}

const failing: ProcessJob = (): Promise<AttemptOutcome> =>
  Promise.resolve({ kind: 'failed', error: runtimeSummary('attempt_timeout'), retryable: false });

if (LIVE) {
  describe('the Valkey transport on a live server', () => {
    const opened: (() => Promise<void>)[] = [];
    after(async () => {
      for (const close of opened.reverse()) await close();
    });

    async function fixture(label: string): Promise<Fixture> {
      const live = await liveAdapter(label, QUEUES.declarations);
      const catalog = catalogOf();
      const producer = createProducer({ catalog, adapter: live.adapter });
      opened.push(async () => {
        producer.close();
        await live.close();
        assert.deepEqual(live.reported, [], 'the adapter reported no unawaited failure');
      });
      return { live, catalog, producer };
    }

    test('settling a batch and reading its status cost the same commands whatever its size', async () => {
      const { live, catalog, producer } = await fixture('budget');
      const child = catalog.get('child')!;
      const flows = live.adapter.capabilities.flows as ValkeyBatches;
      const client = await live.connections.shared('command');
      const layout = keyLayout(live.namespace);

      async function lastSettleCost(size: number): Promise<{ settle: number; status: number }> {
        const batch = await producer.batch(
          Array.from({ length: size }, (_, index) => child.with(index)),
          { then: catalog.get('note')!.with(null) },
        );
        const finalizerId = await recordedFinalizerId(client, layout, batch.id);
        for (let index = 0; index < size - 1; index += 1) {
          await flows.recordChild({ id: batch.id, index, finalizerId }, 'c');
        }
        const settle = await commandsOf(client, () =>
          flows.recordChild({ id: batch.id, index: size - 1, finalizerId }, 'c'),
        );
        let status: unknown;
        const statusCost = await commandsOf(client, async () => {
          status = await flows.batchStatus(batch.id);
        });
        assert.deepEqual(
          { ...(status as object) },
          {
            total: size,
            completed: size,
            failed: 0,
            skipped: 0,
            pending: 0,
            settled: true,
            retriedAfterSettlement: 0,
          },
        );
        return { settle, status: statusCost };
      }

      // A script's first run on a server whose script cache is cold costs a
      // reload; one unmeasured batch loads every script the budget measures.
      await lastSettleCost(2);
      const small = await lastSettleCost(2);
      const large = await lastSettleCost(1_000);
      assert.equal(large.status, small.status, 'the status read costs the same at any size');
      // One script, one read of the record.
      assert.ok(large.status <= 2, `a batch status took ${large.status} commands`);
      assert.equal(large.settle, small.settle, 'the settling record costs the same at any size');
      // The record script that settles the batch, BullMQ's add of the finalizer, and its released mark.
      assert.ok(large.settle <= 40, `settling the last child took ${large.settle} commands`);
    });

    test('a chunked batch resumed by its id stores no child twice and skips recorded ones', async () => {
      const { live, catalog, producer } = await fixture('chunked');
      const child = catalog.get('child')!;
      const client = await live.connections.shared('command');
      const items = Array.from({ length: 2_500 }, (_, index) => child.with(index));
      const id = 'chunked-batch';
      const first = await producer.batch(items, { id, chunked: true });
      assert.equal(first.deduplicated, false);
      const layout = keyLayout(live.namespace);
      const wait = `${layout.queueKey('default')}wait`;
      assert.equal(await client.llen(wait), 2_500);

      // Ten children ran and were evicted; the producer died before it marked any chunk stored.
      const flows = live.adapter.capabilities.flows as ValkeyBatches;
      const finalizerId = await recordedFinalizerId(client, layout, id);
      for (let index = 0; index < 10; index += 1) {
        const jobId = `${finalizerId}.${index}`;
        await client.lrem(wait, 0, jobId);
        await client.del(layout.jobKey('default', jobId));
        await flows.recordChild({ id, index, finalizerId }, 'c');
      }
      await client.hset(layout.batchRecord(id), 'stored', '0');

      const again = await producer.batch(items, { id, chunked: true });
      assert.equal(again.deduplicated, true);
      assert.equal(await client.llen(wait), 2_490, 'no child was stored twice or run again');
      const status = await producer.batchStatus(id);
      assert.equal(status?.total, 2_500);
      assert.equal(status?.pending, 2_490);
    });

    test('a batch that is not chunked stays staged until it is known stored', async () => {
      const { live, catalog, producer } = await fixture('staged');
      const child = catalog.get('child')!;
      const client = await live.connections.shared('command');
      const layout = keyLayout(live.namespace);
      const scripts = bindValkeyScripts(live.connections);
      const flows = live.adapter.capabilities.flows as ValkeyBatches;
      const items = [child.with(0), child.with(1)];

      // A producer claimed the batch, then lost the server before its one transaction ran.
      const lost = layout.batchRecord('lost');
      await scripts.batchClaim.run([lost], [2, 'default', '{}', 'bLOST.inc', '1', 60_000]);
      assert.equal(await producer.batchStatus('lost'), undefined, 'a staged batch is not reported');
      const ttl = await client.pttl(lost);
      assert.ok(ttl > 0 && ttl <= 60_000, `a staged record expires (pttl ${ttl})`);
      const again = await producer.batch(items, { id: 'lost' });
      assert.equal(again.deduplicated, false, 'it was never known stored');
      assert.equal(await client.pttl(lost), -1, 'stored, it keeps no expiry until it settles');
      assert.equal(await client.exists(layout.jobKey('default', 'bLOST.inc.0')), 1);
      assert.equal(await client.exists(layout.jobKey('default', 'bLOST.inc.1')), 1);
      assert.equal((await producer.batchStatus('lost'))?.pending, 2);

      // The transaction applied but its stored mark was lost: the first child to record proves it.
      const unmarked = layout.batchRecord('unmarked');
      await scripts.batchClaim.run([unmarked], [2, 'default', '{}', 'bMARK.inc', '1', 60_000]);
      await flows.recordChild({ id: 'unmarked', index: 0, finalizerId: 'bMARK.inc' }, 'c');
      assert.equal(await client.pttl(unmarked), -1);
      const status = await producer.batchStatus('unmarked');
      assert.equal(status?.total, 2);
      assert.equal(status?.pending, 1);

      // A batch stored in one go is never staged.
      const stored = await producer.batch(items, { id: 'stored' });
      assert.equal(stored.deduplicated, false);
      assert.equal(await client.pttl(layout.batchRecord('stored')), -1);
      assert.equal((await producer.batchStatus('stored'))?.pending, 2);
    });

    test('a batch id issued again once its record expired stores fresh children', async () => {
      const { live, catalog, producer } = await fixture('reissue');
      const child = catalog.get('child')!;
      const client = await live.connections.shared('command');
      const layout = keyLayout(live.namespace);
      const flows = live.adapter.capabilities.flows as ValkeyBatches;
      const id = 'weekly-export';
      const items = [child.with(0), child.with(1)];
      await producer.batch(items, { id });
      const first = await recordedFinalizerId(client, layout, id);
      await flows.recordChild({ id, index: 0, finalizerId: first }, 'c');
      await flows.recordChild(
        { id, index: 1, finalizerId: first },
        encodeFailure('child', runtimeSummary('attempt_timeout')),
      );
      assert.equal((await producer.batchStatus(id))?.settled, true);

      // The record expired; BullMQ still keeps both children's jobs.
      const record = layout.batchRecord(id);
      await client.del(record, `${record}:r`, `${record}:f`);
      assert.equal(await client.exists(layout.jobKey('default', `${first}.1`)), 1);

      const again = await producer.batch(items, { id });
      assert.equal(again.deduplicated, false);
      const second = await recordedFinalizerId(client, layout, id);
      assert.notEqual(second, first, 'the new record has its own incarnation');
      assert.equal(await client.exists(layout.jobKey('default', `${second}.0`)), 1);
      assert.equal(await client.exists(layout.jobKey('default', `${second}.1`)), 1);

      // A late outcome of the expired incarnation counts nothing in the new one.
      await flows.recordChild({ id, index: 0, finalizerId: first }, 'c');
      const status = await producer.batchStatus(id);
      assert.equal(status?.pending, 2);
      assert.equal(status?.settled, false);
    });

    test('a finalizer redelivered after its callbacks were evicted fires none of them again', async () => {
      const { live, catalog: calls, producer } = await fixture('finalizer');
      const runs = new Map<string, number>();
      const counted = (name: string, queue: 'default' | 'mail' = 'default') =>
        defineJob({
          name,
          queue,
          schema: z.unknown(),
          handle: () => {
            runs.set(name, (runs.get(name) ?? 0) + 1);
            return Promise.resolve();
          },
        });
      const catalog = createJobCatalog({
        queues: QUEUES,
        definitions: [counted('child'), counted('note'), counted('letter', 'mail')],
      });
      const worker = await startRuntimeWorker({ catalog, adapter: live.adapter, jobs: unusedJobs });
      const { id } = await producer.batch([calls.get('child')!.with(1)], {
        then: calls.get('note')!.with(null),
        finally: calls.get('letter')!.with(null),
      });
      const settled = async (): Promise<void> => {
        const deadline = performance.now() + 20_000;
        let quiet = 0;
        while (quiet < 3) {
          if (performance.now() > deadline) throw new Error('the adapter did not settle');
          await realDelay(20);
          quiet = (await live.adapter.busy()) ? 0 : quiet + 1;
        }
      };
      await settled();
      assert.equal(runs.get('note'), 1);
      assert.equal(runs.get('letter'), 1);

      // Retention evicted the callbacks but not the finalizer, which a lost lock then redelivers.
      const client = await live.connections.shared('command');
      const layout = keyLayout(live.namespace);
      const finalizerId = await recordedFinalizerId(client, layout, id);
      for (const queue of ['default', 'mail'] as const) {
        const completed = `${layout.queueKey(queue)}completed`;
        for (const jobId of await client.zrange(completed, 0, -1)) {
          if (jobId === finalizerId) continue;
          await client.zrem(completed, jobId);
          await client.del(layout.jobKey(queue, jobId));
        }
      }
      assert.equal(await live.adapter.redeliver(finalizerId), true);
      await settled();
      assert.equal(runs.get('note'), 1, 'then fired again');
      assert.equal(runs.get('letter'), 1, 'finally fired again');
      await worker.drain();
    });

    test('failed jobs page newest first across queues, and removal and pruning keep the key', async () => {
      const { live, catalog, producer } = await fixture('failed');
      const failedJobs = live.adapter.capabilities.failedJobs!;
      let settled = 0;
      const worker = await live.adapter.startWorker(
        { queues: ['default', 'mail'], onSettle: () => (settled += 1) },
        failing,
      );
      const note = catalog.get('note')!;
      const letter = catalog.get('letter')!;
      for (let index = 0; index < 4; index += 1) await producer.dispatch(note.with(index));
      for (let index = 0; index < 3; index += 1) await producer.dispatch(letter.with(index));
      const keyed = await producer.dispatch(note.with('keyed'), {
        key: 'once',
        keyWindowMs: 3_600_000,
      });
      const deadline = performance.now() + 20_000;
      while (settled < 8) {
        if (performance.now() > deadline) throw new Error('the jobs did not fail in time');
        await realDelay(10);
      }
      await worker.drain();

      const whole = await failedJobs.list({ limit: 1_000 });
      assert.equal(whole.length, 8);
      for (let index = 1; index < whole.length; index += 1) {
        const [newer, older] = [whole[index - 1]!, whole[index]!];
        assert.ok(
          newer.failedAt > older.failedAt ||
            (newer.failedAt === older.failedAt && newer.id > older.id),
          'newest first, then id descending',
        );
      }
      const paged: FailedJob[] = [];
      let page = await failedJobs.list({ limit: 3 });
      while (page.length > 0) {
        paged.push(...page);
        const last = page[page.length - 1]!;
        page = await failedJobs.list({
          limit: 3,
          before: { failedAt: last.failedAt, id: last.id },
        });
      }
      assert.deepEqual(
        paged.map((job) => job.id),
        whole.map((job) => job.id),
      );
      assert.equal((await failedJobs.list({ queue: 'mail' })).length, 3);
      assert.equal((await failedJobs.get(keyed.id))?.error.code, 'jobs.attempt_timeout');

      assert.equal(await failedJobs.remove(keyed.id), true);
      assert.equal(await failedJobs.remove(keyed.id), false);
      assert.equal(await failedJobs.get(keyed.id), undefined);
      const again = await producer.dispatch(note.with('keyed'), {
        key: 'once',
        keyWindowMs: 3_600_000,
      });
      assert.deepEqual(
        { ...again },
        { id: keyed.id, deduplicated: true },
        'the key outlived its job',
      );

      assert.equal(await failedJobs.prune({ olderThanMs: 0 }), 7);
      assert.deepEqual(await failedJobs.list(), []);
    });

    test('a lease is held by one owner token at a time and lapses on the server', async () => {
      const { live } = await fixture('leases');
      const leases = live.adapter.capabilities.leases!;
      const token = await leases.acquire('report', 60_000);
      assert.equal(typeof token, 'string');
      assert.equal(await leases.acquire('report', 60_000), undefined);
      assert.equal(await leases.renew('report', 'not-the-token', 60_000), false);
      assert.equal(await leases.release('report', 'not-the-token'), false);
      assert.equal(await leases.renew('report', token!, 60_000), true);
      assert.equal(await leases.release('report', token!), true);
      assert.equal(await leases.release('report', token!), false);

      const short = await leases.acquire('brief', 1_000);
      assert.equal(typeof short, 'string');
      let next: string | undefined;
      const deadline = performance.now() + 10_000;
      while (next === undefined) {
        if (performance.now() > deadline) throw new Error('the lease did not lapse');
        await realDelay(100);
        next = await leases.acquire('brief', 1_000);
      }
      assert.notEqual(next, short);
      assert.equal(
        await leases.renew('brief', short!, 1_000),
        false,
        'a lapsed token renews nothing',
      );
    });

    test('schedules apply by compare-and-set and keep payload numbers exact', async () => {
      const { live, catalog } = await fixture('schedules');
      const schedules = live.adapter.capabilities.schedules!;
      const payload = { big: Number.MAX_SAFE_INTEGER, fraction: 0.1 + 0.2, tiny: 5e-324 };
      await reconcileSchedules(
        live.adapter,
        [schedule('nightly', catalog.get('note')!.with(payload), { cron: '0 3 * * *' })],
        { app: 'live', by: 'test' },
      );
      const stored = await schedules.read();
      assert.equal(stored.schedules.length, 1);
      assert.deepEqual(stored.schedules[0]!.envelope.payload, payload);
      assert.equal(stored.stamp?.app, 'live');
      assert.equal(typeof stored.schedules[0]!.nextAt, 'number');

      const change = { upsert: [], remove: ['nightly'], stamp: stored.stamp };
      assert.equal(await schedules.apply(change, stored.revision - 1), false, 'a stale revision');
      assert.equal((await schedules.read()).schedules.length, 1);
      assert.equal(await schedules.apply(change, stored.revision), true);
      const after = await schedules.read();
      assert.deepEqual(after.schedules, []);
      assert.notEqual(after.revision, stored.revision);
    });
  });
} else {
  test('the Valkey transport on a live server', { skip: SKIP_REASON }, () => undefined);
}
