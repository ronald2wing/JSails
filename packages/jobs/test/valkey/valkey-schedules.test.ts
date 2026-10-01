/**
 * Schedules on the Valkey transport over a fake BullMQ, whose script
 * replies stand for the server: a close, or the last worker's drain, waits
 * for every schedule read and fire already on its way and lets no fire
 * enqueue once it began; the stored set read back; the compare-and-set
 * apply and the pause script, with the arguments they send; and the change
 * counter poll that carries another process's change to this ticker.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type {
  ProcessJob,
  ReconcileStamp,
  ScheduleChange,
  ScheduleSpec,
} from '../../src/contract/index.js';
import { MAX_SCHEDULES } from '../../src/schedules/schedule-spec.js';
import type { ScheduleRecord } from '../../src/schedules/ticker.js';
import type { ValkeySchedules } from '../../src/valkey/valkey-schedules.js';
import { held, type FakeBackend } from './fake-bullmq.js';
import { envelope, fakeAdapter, refused } from './fixtures/fake-adapter.js';

const completing: ProcessJob = () => Promise.resolve({ kind: 'completed' });

const stamp: ReconcileStamp = { app: 'app', fingerprint: 'f1', appliedAt: 1, by: 'test' };

function spec(id: string, repeat: ScheduleSpec['repeat'] = { everyMs: 60_000 }): ScheduleSpec {
  return { id, queue: 'default', envelope: envelope({ name: id }), repeat };
}

/** The reply of the read script for `records`, as the server flattens its hashes. */
function readReply(
  records: readonly Omit<ScheduleRecord, 'revision'>[],
  revision = 1,
  stored: ReconcileStamp | undefined = undefined,
): unknown[] {
  const flat = (pick: (record: Omit<ScheduleRecord, 'revision'>) => string | undefined) =>
    records.flatMap((record) => {
      const value = pick(record);
      return value === undefined ? [] : [record.spec.id, value];
    });
  return [
    flat((record) => JSON.stringify(record.spec)),
    flat((record) => (record.paused ? '1' : '0')),
    flat((record) => String(record.anchor)),
    flat((record) => (record.through === undefined ? undefined : String(record.through))),
    flat(() => '7'),
    String(revision),
    stored === undefined ? '' : JSON.stringify(stored),
  ];
}

/** One overdue schedule, `tick`, read back by the read script; `fire` answers the fire script. */
function overdue(backend: FakeBackend, fire: (phase: 'check' | 'record') => unknown): ScheduleSpec {
  const tick = spec('tick');
  const anchor = Date.now() - 120_000;
  backend.scriptReply = (script, _keys, args) => {
    if (script === 'scheduleRead') {
      return readReply([{ spec: tick, paused: false, anchor, through: undefined }]);
    }
    if (script === 'scheduleFire') return fire(args[4] === '0' ? 'check' : 'record');
    return 0;
  };
  return tick;
}

/** Let every callback already queued run, twice over. */
async function turns(): Promise<void> {
  for (let i = 0; i < 2; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('a close while a schedule fires', () => {
  test('waits for the fire to record before it closes the queues', async () => {
    const { backend, adapter, reported } = await fakeAdapter();
    const recording = held<number>();
    const tick = overdue(backend, (phase) => {
      if (phase === 'check') return JSON.stringify(spec('tick'));
      recording.reach();
      return recording.promise.then((value) => {
        backend.events.push('fire recorded');
        return value;
      });
    });
    await adapter.startWorker({ queues: ['default'] }, completing);
    await recording.reached;
    assert.deepEqual(
      backend.adds.map((add) => add.name),
      [tick.id],
    );
    const closing = adapter.close().then(() => {
      backend.events.push('adapter closed');
    });
    await turns();
    assert.ok(
      !backend.events.some((event) => event === 'close default' || event === 'close flows'),
      'no queue closes while the fire is on its way',
    );
    recording.release(1);
    await closing;
    const recorded = backend.events.indexOf('fire recorded');
    assert.ok(recorded >= 0);
    assert.ok(recorded < backend.events.indexOf('close default'));
    assert.ok(recorded < backend.events.indexOf('close flows'));
    assert.equal(backend.events.at(-1), 'adapter closed');
    assert.deepEqual(reported, [], 'nothing reaches the server after the close, so nothing fails');
  });

  test('a fire whose check passes once the close began enqueues and records nothing', async () => {
    const { backend, adapter, reported } = await fakeAdapter();
    const checking = held<string>();
    overdue(backend, (phase) => {
      if (phase === 'record') return 1;
      checking.reach();
      return checking.promise;
    });
    await adapter.startWorker({ queues: ['default'] }, completing);
    await checking.reached;
    const closing = adapter.close();
    checking.release(JSON.stringify(spec('tick')));
    await closing;
    assert.deepEqual(backend.adds, [], 'the slot is left for whichever process fires next');
    assert.equal(
      backend.scriptCalls.filter((call) => call.script === 'scheduleFire').length,
      1,
      'only the check ran',
    );
    assert.deepEqual(reported, []);
  });

  test('a fire that fails while the close waits is reported before the close resolves', async () => {
    const { backend, adapter, reported } = await fakeAdapter();
    const recording = held<number>();
    overdue(backend, (phase) => {
      if (phase === 'check') return JSON.stringify(spec('tick'));
      recording.reach();
      return recording.promise;
    });
    await adapter.startWorker({ queues: ['default'] }, completing);
    await recording.reached;
    const closing = adapter.close();
    recording.fail(new Error('connection reset'));
    await closing;
    assert.equal(reported.length, 1);
    assert.ok(refused('transport_failed')(reported[0]));
  });

  test('the last worker draining stops firing the same way', async () => {
    const { backend, adapter } = await fakeAdapter();
    const recording = held<number>();
    overdue(backend, (phase) => {
      if (phase === 'check') return JSON.stringify(spec('tick'));
      recording.reach();
      return recording.promise.then((value) => {
        backend.events.push('fire recorded');
        return value;
      });
    });
    const worker = await adapter.startWorker({ queues: ['default'] }, completing);
    await recording.reached;
    const draining = worker.drain().then(() => {
      backend.events.push('drained');
    });
    await turns();
    assert.ok(!backend.events.includes('drained'));
    recording.release(1);
    await draining;
    assert.ok(backend.events.indexOf('fire recorded') < backend.events.indexOf('drained'));
    await adapter.close();
  });
});

describe('the stored set', () => {
  test('reads back every schedule with its pause flag, next fire time and stamp', async () => {
    const { backend, adapter } = await fakeAdapter();
    const anchor = Date.UTC(2026, 0, 1);
    backend.scriptReply = () =>
      readReply(
        [
          { spec: spec('b'), paused: true, anchor, through: undefined },
          { spec: spec('a'), paused: false, anchor, through: anchor + 60_000 },
        ],
        4,
        stamp,
      );
    const stored = await adapter.capabilities.schedules!.read();
    assert.equal(stored.revision, 4);
    assert.deepEqual(stored.stamp, stamp);
    assert.deepEqual(
      stored.schedules.map((schedule) => [schedule.id, schedule.paused, schedule.nextAt]),
      [
        ['a', false, anchor + 120_000],
        ['b', true, undefined],
      ],
    );
    await adapter.close();
  });

  test('an empty store reads as revision 0 with no stamp', async () => {
    const { backend, adapter } = await fakeAdapter();
    backend.scriptReply = () => [[], [], [], [], [], '', ''];
    assert.deepEqual(await adapter.capabilities.schedules!.read(), {
      schedules: [],
      stamp: undefined,
      revision: 0,
    });
    await adapter.close();
  });
});

describe('apply', () => {
  const change = (
    upsert: readonly ScheduleSpec[],
    remove: readonly string[] = [],
  ): ScheduleChange => ({
    upsert,
    remove,
    stamp,
  });

  test('sends the revision, the limit, the stamp, each spec with its canonical repeat, and the removals', async () => {
    const { backend, adapter } = await fakeAdapter();
    const schedules = adapter.capabilities.schedules as ValkeySchedules;
    let notified = 0;
    schedules.port.subscribe(() => {
      notified += 1;
    });
    backend.scriptReply = () => 1;
    const every = spec('every');
    const cron = spec('cron', { cron: '0 3 * * *', tz: 'UTC' });
    assert.equal(await schedules.apply(change([every, cron], ['gone']), 3), true);
    const call = backend.scriptCalls.at(-1)!;
    assert.equal(call.script, 'scheduleApply');
    assert.equal(call.args[0], 3);
    assert.equal(call.args[2], MAX_SCHEDULES);
    assert.deepEqual(JSON.parse(String(call.args[3])), stamp);
    assert.equal(call.args[4], 2);
    assert.deepEqual(call.args.slice(5, 8), [
      'every',
      JSON.stringify(every),
      JSON.stringify({ everyMs: 60_000 }),
    ]);
    assert.deepEqual(call.args.slice(8, 11), [
      'cron',
      JSON.stringify(cron),
      JSON.stringify({ cron: '0 3 * * *', tz: 'UTC' }),
    ]);
    assert.deepEqual(call.args.slice(11), ['gone']);
    assert.equal(notified, 1, 'an applied change refreshes this process at once');
    await adapter.close();
  });

  test('a stale revision applies nothing and notifies nobody', async () => {
    const { backend, adapter } = await fakeAdapter();
    const schedules = adapter.capabilities.schedules as ValkeySchedules;
    let notified = 0;
    schedules.port.subscribe(() => {
      notified += 1;
    });
    backend.scriptReply = () => 0;
    assert.equal(await schedules.apply(change([spec('a')]), 0), false);
    assert.equal(notified, 0);
    await adapter.close();
  });

  test('a set that would grow past the limit is refused as too_many', async () => {
    const { backend, adapter } = await fakeAdapter();
    backend.scriptReply = () => -1;
    await assert.rejects(
      adapter.capabilities.schedules!.apply(change([spec('a')]), 0),
      refused('invalid_schedule', { rule: 'too_many' }),
    );
    await adapter.close();
  });

  test('a malformed change or a spec on an undeclared queue reaches no script', async () => {
    const { backend, adapter } = await fakeAdapter();
    const schedules = adapter.capabilities.schedules!;
    await assert.rejects(
      schedules.apply(change([{ ...spec('a'), queue: 'mail' }]), 0),
      refused('unknown_queue'),
    );
    await assert.rejects(
      schedules.apply(change([spec('a')], ['a']), 0),
      refused('invalid_schedule'),
    );
    assert.deepEqual(backend.scriptCalls, []);
    await adapter.close();
  });
});

describe('setPaused', () => {
  test('pauses or resumes in one script, a resume carrying now, and notifies', async () => {
    const { backend, adapter } = await fakeAdapter();
    const schedules = adapter.capabilities.schedules as ValkeySchedules;
    let notified = 0;
    schedules.port.subscribe(() => {
      notified += 1;
    });
    const before = Date.now();
    await schedules.setPaused(['a', 'b'], false);
    const call = backend.scriptCalls.at(-1)!;
    assert.equal(call.script, 'schedulePause');
    assert.equal(call.keys.length, 5);
    assert.equal(call.args[0], '0');
    assert.ok(Number(call.args[1]) >= before);
    assert.deepEqual(call.args.slice(2), ['a', 'b']);
    await schedules.setPaused(['a'], true);
    assert.equal(backend.scriptCalls.at(-1)!.args[0], '1');
    assert.equal(notified, 2);
    await adapter.close();
  });

  test('no ids run no script; a bad flag or id is refused', async () => {
    const { backend, adapter } = await fakeAdapter();
    const schedules = adapter.capabilities.schedules!;
    await schedules.setPaused([], true);
    assert.deepEqual(backend.scriptCalls, []);
    await assert.rejects(
      schedules.setPaused(['a'], 'yes' as unknown as boolean),
      refused('invalid_schedule', { rule: 'shape' }),
    );
    await assert.rejects(schedules.setPaused(['not an id'], true), refused('invalid_schedule'));
    await adapter.close();
  });
});

describe('the change counter', () => {
  test('a change made elsewhere refreshes the ticker; a failed read is reported and polled again', async () => {
    const { backend, adapter, reported } = await fakeAdapter({}, { scheduleSyncMs: 1_000 });
    const polls = [held<string>(), held<string>(), held<string>()];
    let poll = 0;
    let reads = 0;
    backend.scriptReply = (script) => {
      if (script === 'scheduleRead') {
        reads += 1;
        return readReply([]);
      }
      if (script === 'scheduleChanges') {
        const next = polls[poll]!;
        poll += 1;
        next.reach();
        return next.promise;
      }
      return 0;
    };
    await adapter.startWorker({ queues: ['default'] }, completing);
    await adapter.schedulesIdle();
    assert.equal(reads, 1, 'the ticker read the set once as it started');
    await polls[0]!.reached;
    polls[0]!.release('3');
    await polls[1]!.reached;
    await adapter.schedulesIdle();
    assert.equal(reads, 2, 'the first poll refreshes');
    polls[1]!.fail(new Error('connection reset'));
    await polls[2]!.reached;
    assert.equal(reported.length, 1);
    assert.ok(refused('transport_failed')(reported[0]));
    const closing = adapter.close();
    polls[2]!.release('3');
    await closing;
    assert.equal(reads, 2, 'an unchanged counter refreshes nothing, and a stopped poll neither');
  });
});
