/**
 * The memory schedule store: an apply compares the set's revision and checks
 * every spec before writing any, keeps pause state and (for an unchanged
 * repeat) the anchor and last fire, removes, and records the stamp; pause;
 * a resume skips the missed fire times; `read` reports the next fire; and
 * the firing port's compare-and-set.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { JobEnvelope, ReconcileStamp, ScheduleSpec } from '../../src/contract/index.js';
import { buildEnvelope } from '../../src/envelope/codec.js';
import { JobsErrors } from '../../src/errors/jobs-errors.js';
import { ScheduleStore } from '../../src/memory/schedule-store.js';
import { MAX_SCHEDULES } from '../../src/schedules/schedule-spec.js';
import type { ScheduleRecord } from '../../src/schedules/ticker.js';

const START = 1_700_000_000_000;
const STAMP: ReconcileStamp = { app: 'app', fingerprint: 'f', appliedAt: START, by: 'deploy' };
const ENVELOPE = buildEnvelope({ name: 'tick', payload: null, options: {}, dispatchedAt: 0 });

function spec(id: string, everyMs = 60_000, payload: unknown = null): ScheduleSpec {
  return {
    id,
    queue: 'default',
    envelope: payload === null ? ENVELOPE : { ...ENVELOPE, payload },
    repeat: { everyMs },
  };
}

function setup() {
  let now = START;
  const stored: { queue: string; envelope: JobEnvelope }[] = [];
  const store = new ScheduleStore({
    now: () => now,
    hasQueue: (queue) => queue === 'default',
    store: (queue, envelope) => stored.push({ queue, envelope }),
  });
  let changes = 0;
  store.port.subscribe(() => (changes += 1));
  return {
    store,
    stored,
    changes: () => changes,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

type Store = ScheduleStore;

async function upsert(store: Store, specs: readonly ScheduleSpec[], stamp = STAMP): Promise<void> {
  const { revision } = await store.read();
  assert.equal(await store.apply({ upsert: specs, remove: [], stamp }, revision), true);
}

async function remove(store: Store, ids: readonly string[]): Promise<void> {
  const { revision } = await store.read();
  assert.equal(await store.apply({ upsert: [], remove: ids, stamp: STAMP }, revision), true);
}

async function list(store: Store) {
  return (await store.read()).schedules;
}

async function stamp(store: Store) {
  return (await store.read()).stamp;
}

function rule(name: string) {
  return (error: unknown) =>
    JobsErrors.is(error, 'invalid_schedule') && error.context.rule === name;
}

describe('schedule store', () => {
  test('stores specs and the stamp, and lists them by id with their next fire', async () => {
    const { store, changes } = setup();
    assert.equal(await stamp(store), undefined);
    await upsert(store, [spec('b'), spec('a', 120_000)]);
    assert.deepEqual(await stamp(store), STAMP);
    assert.equal(changes(), 1);
    const listed = await list(store);
    assert.deepEqual(
      listed.map((entry) => [entry.id, entry.paused, entry.nextAt]),
      [
        ['a', false, START + 120_000],
        ['b', false, START + 60_000],
      ],
    );
    await upsert(store, [], { ...STAMP, fingerprint: 'g' });
    assert.equal((await stamp(store))?.fingerprint, 'g');
    assert.equal(changes(), 1, 'an empty upsert changes no record');
  });

  test('applies only on the revision it was read at, which only an apply changes', async () => {
    const { store, advance } = setup();
    const first = await store.read();
    assert.equal(first.revision, 0);
    await upsert(store, [spec('a')]);
    const read = await store.read();
    assert.equal(read.revision, 1);
    assert.equal(
      await store.apply({ upsert: [spec('b')], remove: ['a'], stamp: STAMP }, first.revision),
      false,
      'a change read before another apply',
    );
    assert.deepEqual(
      (await list(store)).map((entry) => entry.id),
      ['a'],
    );
    await store.setPaused(['a'], true);
    await store.setPaused(['a'], false);
    advance(60_000);
    const [record] = store.port.records() as readonly ScheduleRecord[];
    store.port.fire('a', { revision: record!.revision, through: record!.through }, START, ENVELOPE);
    assert.equal((await store.read()).revision, 1, 'a pause, a resume or a fire keeps it');
    assert.equal(
      await store.apply({ upsert: [spec('b')], remove: ['a'], stamp: STAMP }, read.revision),
      true,
    );
    assert.deepEqual(
      (await list(store)).map((entry) => entry.id),
      ['b'],
    );
  });

  test('refuses before writing anything', async () => {
    const { store } = setup();
    const apply = (change: unknown, revision: unknown = 0) =>
      store.apply(change as never, revision as never);
    await assert.rejects(
      apply({ upsert: [spec('a'), spec('Bad Id')], remove: [], stamp: STAMP }),
      rule('id'),
    );
    await assert.rejects(
      apply({ upsert: [spec('a'), spec('a')], remove: [], stamp: STAMP }),
      rule('shape'),
    );
    await assert.rejects(
      apply({ upsert: [spec('a')], remove: ['a'], stamp: STAMP }),
      rule('shape'),
    );
    await assert.rejects(apply({ upsert: [], remove: ['Bad Id'], stamp: STAMP }), rule('id'));
    await assert.rejects(apply({ upsert: [], remove: 'a', stamp: STAMP }), rule('id'));
    await assert.rejects(apply({ upsert: 'a', remove: [], stamp: STAMP }), rule('shape'));
    await assert.rejects(apply(null), rule('shape'));
    await assert.rejects(apply({ upsert: [], remove: [], stamp: STAMP }, 0.5), rule('shape'));
    await assert.rejects(apply({ upsert: [], remove: [], stamp: STAMP }, '0'), rule('shape'));
    await assert.rejects(
      apply({ upsert: [{ ...spec('a'), queue: 'mail' }], remove: [], stamp: STAMP }),
      (error: unknown) => JobsErrors.is(error, 'unknown_queue'),
    );
    for (const stamp of [
      null,
      { ...STAMP, app: '' },
      { ...STAMP, fingerprint: 7 },
      { ...STAMP, by: 'x'.repeat(129) },
      { ...STAMP, appliedAt: -1 },
      { ...STAMP, appliedAt: 1.5 },
    ]) {
      await assert.rejects(
        apply({ upsert: [spec('a')], remove: [], stamp: stamp as ReconcileStamp }),
        rule('shape'),
      );
    }
    assert.deepEqual(await store.read(), { schedules: [], stamp: undefined, revision: 0 });
  });

  test('holds at most MAX_SCHEDULES', async () => {
    const { store } = setup();
    const specs = Array.from({ length: MAX_SCHEDULES }, (_, index) => spec(`s${index}`));
    await upsert(store, specs);
    await upsert(store, [spec('s0', 30_000)]);
    const { revision } = await store.read();
    await assert.rejects(
      store.apply({ upsert: [spec('one-more')], remove: [], stamp: STAMP }, revision),
      rule('too_many'),
    );
    assert.equal(
      await store.apply(
        { upsert: [spec('one-more')], remove: ['s1', 'missing'], stamp: STAMP },
        revision,
      ),
      true,
      'a removal in the same apply makes room',
    );
  });

  test('an upsert keeps pause state, and the anchor unless the repeat changed', async () => {
    const { store, advance, stored } = setup();
    await upsert(store, [spec('a'), spec('b')]);
    await store.setPaused(['a'], true);
    advance(90_000);
    assert.equal(
      store.port.fire('b', { revision: 2, through: undefined }, START + 90_000, ENVELOPE),
      true,
    );
    await upsert(store, [spec('a', 60_000, { changed: true }), spec('b')]);
    const [a, b] = await list(store);
    assert.deepEqual(a?.envelope.payload, { changed: true });
    assert.equal(a?.paused, true);
    assert.equal(a?.nextAt, undefined);
    assert.equal(b?.nextAt, START + 120_000, 'an unchanged repeat keeps its anchor and last fire');
    await upsert(store, [spec('b', 30_000)]);
    assert.equal((await list(store))[1]?.nextAt, START + 120_000, 'a new repeat re-anchors');
    assert.equal(stored.length, 1);
  });

  test('removes and pauses by id, ignoring unknown ids', async () => {
    const { store, changes } = setup();
    await upsert(store, [spec('a'), spec('b')]);
    await remove(store, ['a', 'missing']);
    assert.deepEqual(
      (await list(store)).map((entry) => entry.id),
      ['b'],
    );
    const before = changes();
    await remove(store, ['missing']);
    await store.setPaused(['missing'], true);
    await store.setPaused(['b'], false);
    assert.equal(changes(), before, 'a no-op notifies nobody');
    await assert.rejects(store.setPaused('b' as never, true), rule('id'));
    await assert.rejects(store.setPaused(['b'], 'yes' as never), rule('shape'));
  });

  test('a resume skips the fire times missed while paused', async () => {
    const { store, advance } = setup();
    await upsert(store, [spec('a')]);
    await store.setPaused(['a'], true);
    advance(241_000);
    await store.setPaused(['a'], false);
    assert.equal((await list(store))[0]?.nextAt, START + 300_000);
  });

  test('the port fires only an unpaused record that still matches, and stores the fire', async () => {
    const { store, stored } = setup();
    await upsert(store, [spec('a')]);
    const [record] = store.port.records() as readonly { revision: number }[];
    const expected = { revision: record!.revision, through: undefined };
    assert.equal(store.port.fire('missing', expected, START, ENVELOPE), false);
    assert.equal(store.port.fire('a', { ...expected, revision: 99 }, START, ENVELOPE), false);
    assert.equal(store.port.fire('a', { ...expected, through: 5 }, START, ENVELOPE), false);
    assert.equal(store.port.fire('a', expected, START + 60_000, ENVELOPE), true);
    assert.equal(store.port.fire('a', expected, START + 60_000, ENVELOPE), false, 'a stale fire');
    assert.deepEqual(stored, [{ queue: 'default', envelope: ENVELOPE }]);
    await store.setPaused(['a'], true);
    const paused = (store.port.records() as readonly { revision: number; through?: number }[])[0]!;
    assert.equal(
      store.port.fire('a', { revision: paused.revision, through: START + 60_000 }, START, ENVELOPE),
      false,
    );
  });

  test('a subscriber can unsubscribe', async () => {
    const { store } = setup();
    let heard = 0;
    const unsubscribe = store.port.subscribe(() => (heard += 1));
    unsubscribe();
    await upsert(store, [spec('a')]);
    assert.equal(heard, 0);
  });
});
