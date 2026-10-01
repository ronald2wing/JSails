/**
 * The keyset walk on the run's driver, as a property: for each seed, a table
 * of events whose millisecond timestamps collide often and whose rank is
 * often NULL is walked by `findEach` and `inBatches` in random batch sizes,
 * in several orders (the primary key; the timestamp either way; the nullable
 * rank with either null placement, then the timestamp), with and without a
 * condition and a limit. Every walk must visit each matching row exactly
 * once, in exactly the order the terms define with the key as tiebreak,
 * computed here in JavaScript, so a page boundary inside a run of equal
 * timestamps, a NULL boundary, or a cursor value that lost its milliseconds
 * on the way back would each show as a skipped or repeated row.
 */

import assert from 'node:assert/strict';
import { before, it } from 'node:test';

import { forEachSeed, type SeededRandom } from 'jsails/testing';

import { insertAll, query, type ModelQuery, type OrderBy } from '../../src/index.js';
import { forEachDriver } from '../../src/testing/index.js';
import { EVENT_MODELS, Event, type EventRow } from './fixtures/event-model.js';
import { openDataSource, suiteLifecycle } from './fixtures/open-data-source.js';

const BASE = Date.UTC(2024, 0, 1);

interface Walk {
  readonly order: readonly OrderBy<EventRow>[];
  readonly where?: { readonly label: string };
  readonly limit?: number;
}

type Term = {
  readonly column: 'id' | 'at' | 'rank';
  readonly direction: 'asc' | 'desc';
  readonly nulls?: 'first' | 'last';
};

function termsOf(walk: Walk): Term[] {
  const terms: Term[] = walk.order.map((order) =>
    typeof order === 'string'
      ? { column: order as Term['column'], direction: 'asc' }
      : (order as Term),
  );
  if (!terms.some((term) => term.column === 'id')) terms.push({ column: 'id', direction: 'asc' });
  return terms;
}

/** Sort `rows` as the walk's terms say, NULL lowest unless a term places it. */
function expectedOrder(rows: readonly EventRow[], walk: Walk): number[] {
  const terms = termsOf(walk);
  const value = (row: EventRow, column: Term['column']): number | null => {
    const raw = row[column];
    return raw instanceof Date ? raw.getTime() : raw;
  };
  const sorted = rows
    .filter((row) => walk.where === undefined || row.label === walk.where.label)
    .toSorted((a, b) => {
      for (const term of terms) {
        const x = value(a, term.column);
        const y = value(b, term.column);
        if (x === y) continue;
        const nulls = term.nulls ?? (term.direction === 'asc' ? 'first' : 'last');
        if (x === null) return nulls === 'first' ? -1 : 1;
        if (y === null) return nulls === 'first' ? 1 : -1;
        return term.direction === 'asc' ? x - y : y - x;
      }
      return 0;
    })
    .map((row) => row.id);
  return walk.limit === undefined ? sorted : sorted.slice(0, walk.limit);
}

function walksFor(random: SeededRandom): Walk[] {
  return [
    { order: [] },
    { order: ['at'] },
    { order: [{ column: 'at', direction: 'desc' }] },
    { order: ['rank', { column: 'at', direction: 'desc' }] },
    { order: [{ column: 'rank', direction: 'desc', nulls: 'first' }, 'at'] },
    { order: [{ column: 'rank', direction: 'asc', nulls: 'last' }] },
    { order: ['at'], where: { label: random.pick(['a', 'b']) }, limit: random.int(1, 60) },
  ];
}

function walkQuery(walk: Walk): ModelQuery<EventRow> {
  let q = query<EventRow>(Event);
  if (walk.where !== undefined) q = q.where(walk.where);
  if (walk.order.length > 0) q = q.orderBy(walk.order);
  if (walk.limit !== undefined) q = q.limit(walk.limit);
  return q;
}

void forEachDriver('findEach keyset walk', () => {
  const lifecycle = suiteLifecycle();

  before(async () => {
    await openDataSource(lifecycle, EVENT_MODELS);
  });

  it('visits every matching row exactly once, in order, for random timestamps', async (t) => {
    await forEachSeed(t, async (random) => {
      await query(Event).deleteAll();
      const count = random.int(1, 240);
      const spread = random.pick([4, 30, 5000]);
      const values = Array.from({ length: count }, () => ({
        at: new Date(BASE + random.int(0, spread) * random.pick([1, 7, 1000])),
        rank: random.next() < 0.3 ? null : random.int(0, 5),
        label: random.pick(['a', 'b']),
      }));
      await insertAll<EventRow>(Event, values);
      const rows = await query<EventRow>(Event).getMany();
      assert.equal(rows.length, count);
      for (const walk of walksFor(random)) {
        const expected = expectedOrder(rows, walk);
        const batchSize = random.int(1, 40);
        const visited: number[] = [];
        await walkQuery(walk).findEach(
          (row) => {
            visited.push(row.id);
          },
          { batchSize },
        );
        assert.deepEqual(visited, expected, `findEach ${JSON.stringify(walk)} by ${batchSize}`);
        const batches: number[][] = [];
        await walkQuery(walk).inBatches(batchSize, (batch, index) => {
          assert.equal(index, batches.length);
          assert.ok(batch.length > 0 && batch.length <= batchSize);
          batches.push(batch.map((row) => row.id));
        });
        assert.deepEqual(batches.flat(), expected, `inBatches ${JSON.stringify(walk)}`);
      }
    });
  });
});
