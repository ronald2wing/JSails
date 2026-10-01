/**
 * `reconcileSchedules`: the diff (upserted, unchanged, pruned) applied in one
 * compare-and-set with the stamp, which is always written, the owner check
 * and `adopt`, a reconcile that raced another one reading again (refused
 * when the other was another app's, never applied over it), every refusal
 * before any write, overlap needing leases, and a fingerprint that ignores
 * order and build time. Pause and resume change pause state only.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { z } from 'zod';

import type {
  JobsAdapter,
  LeaseCapability,
  ReconcileStamp,
  ScheduleCapability,
  ScheduleChange,
  ScheduleSpec,
} from '../../src/contract/index.js';
import { defineJob } from '../../src/definition/define-job.js';
import { JobsErrors } from '../../src/errors/jobs-errors.js';
import { MemoryJobsAdapter } from '../../src/memory/memory-adapter.js';
import { ScheduleStore } from '../../src/memory/schedule-store.js';
import { defineQueues } from '../../src/queues/queue-set.js';
import { schedule } from '../../src/schedules/define-schedule.js';
import {
  MAX_RECONCILE_ROUNDS,
  pauseSchedules,
  reconcileSchedules,
  resumeSchedules,
  scheduleFingerprint,
} from '../../src/schedules/reconcile.js';
import { MAX_SCHEDULES } from '../../src/schedules/schedule-spec.js';
import { VirtualClock } from '../timing/virtual-clock.js';

const START = 1_700_000_000_000;

const Digest = defineJob({
  name: 'digest',
  queue: 'mail',
  schema: z.object({ n: z.number() }),
  attempts: 2,
  handle: () => {},
});
const Locked = defineJob({
  name: 'locked',
  schema: z.object({ n: z.number() }),
  overlap: true,
  handle: () => {},
});

function describeChange(change: ScheduleChange): string {
  const upserted = change.upsert.map((spec) => spec.id).join(',');
  return `apply:${upserted}${change.remove.length > 0 ? `-${change.remove.join(',')}` : ''}`;
}

/**
 * A schedule capability over a memory store that records each call in order,
 * and runs `interleave` (when set) between a reconcile's read and its apply.
 */
function setup(options: { readonly leases?: boolean } = {}) {
  const clock = new VirtualClock(START);
  const calls: string[] = [];
  const store = new ScheduleStore({
    now: () => clock.now(),
    hasQueue: (queue) => queue === 'default' || queue === 'mail',
    store: () => undefined,
  });
  const hooks: { interleave: (() => Promise<void>) | undefined } = { interleave: undefined };
  const schedules: ScheduleCapability = {
    read: () => {
      calls.push('read');
      return store.read();
    },
    apply: async (change, revision) => {
      const interleave = hooks.interleave;
      if (interleave !== undefined) await interleave();
      const applied = await store.apply(change, revision);
      calls.push(`${describeChange(change)}${applied ? '' : ' (stale)'}`);
      return applied;
    },
    setPaused: (ids, paused) => {
      calls.push(`${paused ? 'pause' : 'resume'}:${ids.join(',')}`);
      return store.setPaused(ids, paused);
    },
  };
  const leases = {} as LeaseCapability;
  const adapter: Pick<JobsAdapter, 'capabilities'> = {
    capabilities: options.leases === true ? { schedules, leases } : { schedules },
  };
  const list = async () => (await store.read()).schedules;
  const stamp = async () => (await store.read()).stamp;
  return {
    adapter,
    calls,
    store,
    hooks,
    list,
    stamp,
    clock,
    reconcile: (declared: Parameters<typeof reconcileSchedules>[1], extra = {}) =>
      reconcileSchedules(adapter, declared, { app: 'shop', by: 'deploy-1', clock, ...extra }),
  };
}

function code(name: Parameters<typeof JobsErrors.is>[1]) {
  return (error: unknown) => JobsErrors.is(error, name);
}

describe('reconcileSchedules', () => {
  test('upserts new schedules with the stamp, built from the job definition', async () => {
    const { reconcile, list, stamp: readStamp, calls } = setup();
    const result = await reconcile([
      schedule('b', Digest.with({ n: 1 }, { tags: ['t'] }), { everyMs: 60_000 }),
      schedule('a', Digest.with({ n: 2 }), { cron: '0 9 * * *', timezone: 'Asia/Tokyo' }),
    ]);
    assert.deepEqual(result, { upserted: ['a', 'b'], pruned: [], unchanged: [] });
    assert.deepEqual(calls, ['read', 'apply:b,a']);
    const [a, b] = await list();
    assert.equal(a?.queue, 'mail');
    assert.deepEqual(a?.repeat, { cron: '0 9 * * *', tz: 'Asia/Tokyo' });
    assert.deepEqual(b?.envelope.options, {
      attempts: 2,
      backoff: { type: 'exponential', delayMs: 1_000 },
    });
    assert.deepEqual(b?.envelope.meta, { tags: ['t'], dispatchedAt: START });
    const stamp = (await readStamp()) as ReconcileStamp;
    assert.deepEqual(
      { app: stamp.app, by: stamp.by, appliedAt: stamp.appliedAt },
      { app: 'shop', by: 'deploy-1', appliedAt: START },
    );
    assert.match(stamp.fingerprint, /^[0-9a-f]{64}$/);
  });

  test('a second reconcile reports unchanged and changed schedules, and applies them at once', async () => {
    const { reconcile, calls, clock, list, stamp } = setup();
    await reconcile([
      schedule('a', Digest.with({ n: 1 }), { everyMs: 60_000 }),
      schedule('b', Digest.with({ n: 1 }), { everyMs: 60_000 }),
      schedule('c', Digest.with({ n: 1 }), { everyMs: 60_000 }),
    ]);
    await clock.advance(1_000);
    calls.length = 0;
    const result = await reconcile([
      schedule('a', Digest.with({ n: 1 }), { everyMs: 60_000 }),
      schedule('b', Digest.with({ n: 9 }), { everyMs: 60_000 }),
    ]);
    assert.deepEqual(result, { upserted: ['b'], pruned: ['c'], unchanged: ['a'] });
    assert.deepEqual(calls, ['read', 'apply:b-c']);
    assert.equal((await stamp())?.appliedAt, START + 1_000);
    assert.deepEqual(
      (await list()).map((entry) => entry.id),
      ['a', 'b'],
    );
  });

  test('the stamp is written even when nothing changed', async () => {
    const { reconcile, calls, clock, stamp } = setup();
    const declared = [schedule('a', Digest.with({ n: 1 }), { everyMs: 60_000 })];
    await reconcile(declared);
    await clock.advance(5_000);
    calls.length = 0;
    assert.deepEqual(await reconcile(declared, { by: 'deploy-2' }), {
      upserted: [],
      pruned: [],
      unchanged: ['a'],
    });
    assert.deepEqual(calls, ['read', 'apply:']);
    assert.equal((await stamp())?.by, 'deploy-2');
  });

  test('another app is refused unless the takeover is adopted', async () => {
    const { reconcile } = setup();
    const declared = [schedule('a', Digest.with({ n: 1 }), { everyMs: 60_000 })];
    await reconcile(declared);
    await assert.rejects(reconcile(declared, { app: 'other' }), code('schedule_owner_mismatch'));
    await reconcile(declared, { app: 'other', adopt: true });
    await reconcile(declared, { app: 'other' });
  });

  test("a reconcile that raced another app's reads again and is refused, never applied over it", async () => {
    const { reconcile, hooks, calls, list, stamp } = setup();
    hooks.interleave = async () => {
      hooks.interleave = undefined;
      await reconcile([schedule('a1', Digest.with({ n: 1 }), { everyMs: 60_000 })], {
        app: 'app-a',
      });
    };
    await assert.rejects(
      reconcile([schedule('b1', Digest.with({ n: 1 }), { everyMs: 60_000 })], { app: 'app-b' }),
      code('schedule_owner_mismatch'),
    );
    assert.deepEqual(calls, ['read', 'read', 'apply:a1', 'apply:b1 (stale)', 'read']);
    assert.deepEqual(
      (await list()).map((entry) => entry.id),
      ['a1'],
      "the other app's schedules are kept",
    );
    assert.equal((await stamp())?.app, 'app-a');
  });

  test('two apps reconciling one fresh namespace at once: one is refused, the other kept whole', async () => {
    const clock = new VirtualClock(START);
    const adapter = new MemoryJobsAdapter(
      { namespace: 'app:test', queues: defineQueues({ mail: {} }).declarations },
      { clock },
    );
    const results = await Promise.allSettled(
      (['app-a', 'app-b'] as const).map((app) =>
        reconcileSchedules(
          adapter,
          [schedule(`${app}-daily`, Digest.with({ n: 1 }), { everyMs: 60_000 })],
          { app, by: 'deploy', clock },
        ),
      ),
    );
    const refused = results.filter(
      (result) =>
        result.status === 'rejected' && JobsErrors.is(result.reason, 'schedule_owner_mismatch'),
    );
    assert.equal(refused.length, 1, 'both apps passed the owner check');
    const winner = results[0]?.status === 'fulfilled' ? 'app-a' : 'app-b';
    const set = await adapter.capabilities.schedules!.read();
    assert.deepEqual(
      set.schedules.map((entry) => entry.id),
      [`${winner}-daily`],
    );
    assert.equal(set.stamp?.app, winner);
    await adapter.close();
  });

  test('a reconcile that raced one of its own app diffs again against what that one stored', async () => {
    const { reconcile, hooks, calls, list } = setup();
    await reconcile([schedule('a', Digest.with({ n: 1 }), { everyMs: 60_000 })]);
    calls.length = 0;
    hooks.interleave = async () => {
      hooks.interleave = undefined;
      await reconcile([
        schedule('a', Digest.with({ n: 1 }), { everyMs: 60_000 }),
        schedule('x', Digest.with({ n: 1 }), { everyMs: 60_000 }),
      ]);
    };
    const result = await reconcile([
      schedule('a', Digest.with({ n: 1 }), { everyMs: 60_000 }),
      schedule('b', Digest.with({ n: 1 }), { everyMs: 60_000 }),
    ]);
    assert.deepEqual(result, { upserted: ['b'], pruned: ['x'], unchanged: ['a'] });
    assert.deepEqual(calls, ['read', 'read', 'apply:x', 'apply:b (stale)', 'read', 'apply:b-x']);
    assert.deepEqual(
      (await list()).map((entry) => entry.id),
      ['a', 'b'],
    );
  });

  test('gives up with schedule_conflict when the set changes before every apply', async () => {
    const { reconcile, hooks, store, calls } = setup();
    let other = 0;
    hooks.interleave = async () => {
      const { revision } = await store.read();
      other += 1;
      await store.apply(
        {
          upsert: [],
          remove: [],
          stamp: { app: 'shop', fingerprint: `f${other}`, appliedAt: START, by: 'elsewhere' },
        },
        revision,
      );
    };
    await assert.rejects(
      reconcile([schedule('a', Digest.with({ n: 1 }), { everyMs: 60_000 })]),
      code('schedule_conflict'),
    );
    assert.equal(other, MAX_RECONCILE_ROUNDS);
    assert.equal(calls.filter((call) => call === 'apply:a (stale)').length, MAX_RECONCILE_ROUNDS);
    assert.deepEqual((await store.read()).schedules, []);
  });

  test('a refused payload rejects the reconcile before any write, naming the item', async () => {
    const { reconcile, calls } = setup();
    await assert.rejects(
      reconcile([
        schedule('a', Digest.with({ n: 1 }), { everyMs: 60_000 }),
        schedule('b', Digest.with({ n: 'x' } as never), { everyMs: 60_000 }),
      ]),
      (error: unknown) =>
        JobsErrors.is(error, 'flow_item_refused') &&
        error.context.item === 1 &&
        JobsErrors.is((error as Error).cause, 'invalid_payload'),
    );
    await assert.rejects(
      reconcile([
        schedule('a', Digest.with({ n: 1, date: new Date(0) } as never), { everyMs: 60_000 }),
      ]),
      (error: unknown) =>
        JobsErrors.is(error, 'flow_item_refused') &&
        JobsErrors.is((error as Error).cause, 'payload_not_json'),
    );
    assert.deepEqual(calls, []);
  });

  test('refuses a bad declared set and bad options', async () => {
    const { reconcile, adapter } = setup();
    const a = schedule('a', Digest.with({ n: 1 }), { everyMs: 60_000 });
    await assert.rejects(
      reconcile([a, schedule('a', Digest.with({ n: 2 }), { everyMs: 60_000 })]),
      (error: unknown) =>
        JobsErrors.is(error, 'duplicate_schedule') && error.context.schedule === 'a',
    );
    await assert.rejects(reconcile('a' as never), code('invalid_schedule'));
    await assert.rejects(reconcile([{ id: 'a', name: 'digest' }]), code('invalid_schedule'));
    await assert.rejects(
      reconcile(Array.from({ length: MAX_SCHEDULES + 1 }, () => a)),
      (error: unknown) =>
        JobsErrors.is(error, 'invalid_schedule') && error.context.rule === 'too_many',
    );
    const option = (name: string) => (error: unknown) =>
      JobsErrors.is(error, 'invalid_option') && error.context.option === name;
    await assert.rejects(reconcileSchedules(adapter, [a], null as never), option('options'));
    await assert.rejects(reconcile([a], { extra: 1 }), code('unknown_option'));
    await assert.rejects(reconcile([a], { app: '' }), option('app'));
    await assert.rejects(reconcile([a], { by: 'has space' }), option('by'));
    await assert.rejects(reconcile([a], { clock: {} }), option('clock'));
    await assert.rejects(reconcile([a], { adopt: 'yes' }), option('adopt'));
  });

  test('defaults to the system clock', async () => {
    const { adapter, stamp } = setup();
    const before = Date.now();
    await reconcileSchedules(adapter, [schedule('a', Digest.with({ n: 1 }), { everyMs: 60_000 })], {
      app: 'shop',
      by: 'deploy',
    });
    assert.ok(((await stamp())?.appliedAt ?? 0) >= before);
  });

  test('needs the schedules capability, and leases for overlap', async () => {
    await assert.rejects(
      reconcileSchedules({ capabilities: {} }, [], { app: 'a', by: 'b' }),
      (error: unknown) =>
        JobsErrors.is(error, 'capability_missing') && error.context.capability === 'schedules',
    );
    const definition = schedule('a', Locked.with({ n: 1 }), { everyMs: 60_000 });
    await assert.rejects(
      setup().reconcile([definition]),
      (error: unknown) =>
        JobsErrors.is(error, 'capability_missing') && error.context.capability === 'leases',
    );
    const { reconcile, list } = setup({ leases: true });
    await reconcile([
      definition,
      schedule('b', Digest.with({ n: 1 }), { everyMs: 60_000, overlap: true }),
    ]);
    const [a, b] = await list();
    assert.deepEqual(a?.envelope.meta.overlap?.key, 'locked', "the definition's own overlap");
    assert.deepEqual(b?.envelope.meta.overlap?.key, 'schedule:b', "the schedule's own overlap");
  });

  test('the fingerprint ignores order and build time, not content', () => {
    const base = (id: string, n: number, dispatchedAt: number): ScheduleSpec => ({
      id,
      queue: 'default',
      envelope: {
        v: 2,
        name: 'digest',
        payload: { n },
        options: {},
        meta: { dispatchedAt },
      },
      repeat: { everyMs: 60_000 },
    });
    const one = scheduleFingerprint([base('a', 1, 0), base('b', 1, 0)]);
    assert.equal(scheduleFingerprint([base('b', 1, 5), base('a', 1, 9)]), one);
    assert.notEqual(scheduleFingerprint([base('a', 2, 0), base('b', 1, 0)]), one);
  });

  test('pause and resume change pause state only', async () => {
    const { adapter, reconcile, calls, list } = setup();
    await reconcile([schedule('a', Digest.with({ n: 1 }), { everyMs: 60_000 })]);
    calls.length = 0;
    await pauseSchedules(adapter, ['a']);
    assert.equal((await list())[0]?.paused, true);
    await resumeSchedules(adapter, ['a']);
    assert.equal((await list())[0]?.paused, false);
    assert.deepEqual(calls, ['pause:a', 'resume:a']);
    for (const action of [pauseSchedules, resumeSchedules]) {
      await assert.rejects(action(adapter, ['Bad Id']), code('invalid_schedule'));
      await assert.rejects(action(adapter, 'a' as never), code('invalid_schedule'));
      await assert.rejects(action({ capabilities: {} }, ['a']), code('capability_missing'));
    }
  });
});
