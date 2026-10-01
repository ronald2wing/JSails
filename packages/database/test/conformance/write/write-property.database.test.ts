/**
 * A property test of the write pipeline on the run's driver: seeded random
 * sequences of record builds, saves and destroys, `updateAll` and
 * `deleteAll` (by condition and by key), board creation and destruction
 * (its cards going by the foreign-key action), for two tenants, sometimes
 * inside a transaction that commits or rolls back. After every step:
 *
 * - each board's counter cache equals `COUNT(*)` of its cards;
 * - no row crosses tenants: a step changes only rows of the tenant it ran
 *   for, and a card's board belongs to the card's tenant;
 * - every stored encrypted value is a seal envelope;
 * - the change records equal the table-snapshot diff: every inserted,
 *   deleted or changed row is reported with its op (or covered by an
 *   `invalidate` of its collection and tenant), every key record agrees with
 *   the snapshots, every record carries the tenant of its row, and a
 *   rolled-back step reports nothing and changes nothing.
 *
 * The seed is printed in every failure; `JSAILS_TEST_SEED` replays one.
 */

import assert from 'node:assert/strict';
import { before, it } from 'node:test';

import {
  runWithTenant,
  withoutTenantScope,
  type ChangeRecord,
  type JsailsDataSource,
} from '../../../src/index.js';
import { forEachDriver } from '../../../src/testing/index.js';
import { unguarded, type Unguarded } from '../../../src/unguarded/index.js';
import { suiteLifecycle } from '../../query/fixtures/open-data-source.js';
import {
  isSealed,
  openWriteSource,
  recordChanges,
  TEST_SEAL,
} from '../../record/fixtures/open-write-source.js';
import { Board, Card, WRITE_MODELS } from './fixtures/write-models.js';

const STEPS = 60;
const TITLES = ['red', 'green', 'blue'] as const;
const TENANTS = [1, 2] as const;

/** mulberry32: a small, well-mixed PRNG whose sequence a seed fixes. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Row {
  readonly key: string;
  readonly tenant: string;
  readonly text: string;
  readonly values: Readonly<Record<string, unknown>>;
}

type Snapshot = ReadonlyMap<string, ReadonlyMap<string, Row>>;

function text(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) => {
    if (item instanceof Uint8Array) return Buffer.from(item).toString('hex');
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Date) return item.toISOString();
    return item;
  });
}

async function snapshot(raw: Unguarded): Promise<Snapshot> {
  const tables = new Map<string, Map<string, Row>>();
  for (const table of ['gm_boards', 'gm_cards']) {
    const result =
      table === 'gm_boards'
        ? await raw.sql`SELECT * FROM gm_boards`
        : await raw.sql`SELECT * FROM gm_cards`;
    const rows = new Map<string, Row>();
    for (const values of result.rows) {
      const key = String(values.id);
      rows.set(key, { key, tenant: String(values.tenant_id), text: text(values), values });
    }
    tables.set(table, rows);
  }
  return tables;
}

function keyText(record: ChangeRecord): string | undefined {
  return record.key === undefined ? undefined : String(record.key);
}

/** Check `records` against the diff of `before` and `after`; `where` names the seed and step. */
function assertRecordsMatchDiff(
  before: Snapshot,
  after: Snapshot,
  records: readonly ChangeRecord[],
  where: string,
): void {
  for (const record of records) {
    const was = before.get(record.collection);
    const now = after.get(record.collection);
    assert.ok(was !== undefined && now !== undefined, `${where}: unknown collection`);
    if (record.op === 'invalidate') {
      assert.ok(record.tenant !== undefined, `${where}: a scoped write invalidates one tenant`);
      continue;
    }
    const key = keyText(record) as string;
    const row = now.get(key) ?? was.get(key);
    assert.ok(
      row !== undefined,
      `${where}: ${record.op} of ${record.collection} ${key} names no row`,
    );
    assert.equal(
      String(record.tenant),
      row.tenant,
      `${where}: the record carries the row's tenant`,
    );
    if (record.op === 'insert') assert.ok(now.has(key) && !was.has(key), `${where}: insert ${key}`);
    if (record.op === 'delete') assert.ok(!now.has(key) && was.has(key), `${where}: delete ${key}`);
    if (record.op === 'update') assert.ok(now.has(key) && was.has(key), `${where}: update ${key}`);
  }
  const covers = (collection: string, key: string, tenant: string, op: string): boolean =>
    records.some(
      (record) =>
        record.collection === collection &&
        ((record.op === 'invalidate' && String(record.tenant) === tenant) ||
          (record.op === op && keyText(record) === key)),
    );
  for (const [collection, was] of before) {
    const now = after.get(collection) as ReadonlyMap<string, Row>;
    for (const [key, row] of now) {
      const old = was.get(key);
      if (old === undefined) {
        assert.ok(
          covers(collection, key, row.tenant, 'insert'),
          `${where}: unreported insert of ${collection} ${key}`,
        );
      } else if (old.text !== row.text) {
        assert.ok(
          covers(collection, key, row.tenant, 'update'),
          `${where}: unreported update of ${collection} ${key}`,
        );
      }
    }
    for (const [key, row] of was) {
      if (now.has(key)) continue;
      assert.ok(
        covers(collection, key, row.tenant, 'delete'),
        `${where}: unreported delete of ${collection} ${key}`,
      );
    }
  }
}

function assertInvariants(state: Snapshot, where: string): void {
  const boards = state.get('gm_boards') as ReadonlyMap<string, Row>;
  const cards = [...(state.get('gm_cards') as ReadonlyMap<string, Row>).values()];
  for (const board of boards.values()) {
    const counted = cards.filter((card) => String(card.values.board_id) === board.key).length;
    assert.equal(
      Number(board.values.cards_count),
      counted,
      `${where}: counter of board ${board.key}`,
    );
    if (board.values.motto !== null)
      assert.ok(isSealed(board.values.motto), `${where}: motto sealed`);
  }
  for (const card of cards) {
    assert.ok(isSealed(card.values.secret), `${where}: secret of card ${card.key} sealed`);
    const boardId = card.values.board_id;
    if (boardId === null) continue;
    assert.equal(
      boards.get(String(boardId))?.tenant,
      card.tenant,
      `${where}: card ${card.key} crosses tenants`,
    );
  }
}

/** Only rows of `tenant` differ between `before` and `after`. */
function assertTenantConfined(
  before: Snapshot,
  after: Snapshot,
  tenant: number,
  where: string,
): void {
  for (const [collection, was] of before) {
    const now = after.get(collection) as ReadonlyMap<string, Row>;
    for (const key of new Set([...was.keys(), ...now.keys()])) {
      const old = was.get(key);
      const row = now.get(key);
      if (old?.text === row?.text) continue;
      assert.equal(
        (row ?? old)?.tenant,
        String(tenant),
        `${where}: ${collection} ${key} of another tenant changed`,
      );
    }
  }
}

void forEachDriver('the write property', () => {
  const lifecycle = suiteLifecycle();
  let dataSource: JsailsDataSource;
  let raw: Unguarded;

  before(async () => {
    dataSource = await openWriteSource(lifecycle, WRITE_MODELS, { seal: TEST_SEAL });
    raw = unguarded(dataSource);
  });

  const seeds =
    process.env.JSAILS_TEST_SEED === undefined ? [1, 2, 3] : [Number(process.env.JSAILS_TEST_SEED)];

  for (const seed of seeds) {
    it(`holds over ${STEPS} random steps (seed ${seed})`, async () => {
      await withoutTenantScope(async () => {
        await Card.all().deleteAll({ skipHooks: true });
        await Board.all().deleteAll();
      });
      const random = prng(seed);
      const pick = <T>(items: readonly T[]): T | undefined =>
        items.length === 0 ? undefined : items[Math.floor(random() * items.length)];

      for (let step = 0; step < STEPS; step += 1) {
        const tenant = pick(TENANTS) as number;
        const where = `seed ${seed}, step ${step}, tenant ${tenant}`;
        const before = await snapshot(raw);
        // Ids are read when an operation runs, so a step's second operation
        // sees what its first one did (inside a transaction too).
        const boards = (): Promise<number[]> => Board.all().pluck('id');
        const cards = (): Promise<number[]> => Card.all().pluck('id');
        const boardOrNull = async (): Promise<number | null> =>
          random() < 0.2 ? null : (pick(await boards()) ?? null);
        const secret = (): string => `s${Math.floor(random() * 1000)}`;

        const operations: (() => Promise<unknown>)[] = [
          () => Board.create({ name: `b${step}`, motto: random() < 0.5 ? null : secret() }),
          async () => {
            const id = pick(await boards());
            if (id !== undefined) await (await Board.find(id)).destroy();
          },
          async () =>
            Card.build({
              title: pick(TITLES) as string,
              secret: secret(),
              boardId: await boardOrNull(),
            }).save(),
          async () => {
            const id = pick(await cards());
            if (id === undefined) return;
            const card = await Card.find(id);
            if (random() < 0.5) card.title = pick(TITLES) as string;
            if (random() < 0.5) card.secret = secret();
            if (random() < 0.5) card.boardId = await boardOrNull();
            await card.save();
          },
          async () => {
            const id = pick(await cards());
            if (id !== undefined) await (await Card.find(id)).destroy();
          },
          async () =>
            Card.where({ title: pick(TITLES) as string }).updateAll(
              { boardId: await boardOrNull(), secret: secret() },
              { skipHooks: true },
            ),
          async () =>
            Card.where({ id: (await cards()).filter(() => random() < 0.3) }).updateAll(
              { title: pick(TITLES) },
              { skipHooks: true },
            ),
          () => Card.where({ title: pick(TITLES) as string }).deleteAll({ skipHooks: true }),
          async () =>
            Card.insertAll([{ title: 'bulk', secret: secret(), boardId: await boardOrNull() }], {
              skipHooks: true,
            }),
        ];
        // Outside a transaction each operation is a commit of its own, and
        // the snapshot diff is per commit, so such a step runs one; inside
        // one, a step runs up to three, delivered as one coalesced batch.
        const mode = random();
        const run = async (): Promise<void> => {
          const count = mode < 0.6 ? 1 : 1 + Math.floor(random() * 3);
          for (let index = 0; index < count; index += 1) {
            await (pick(operations) as () => Promise<unknown>)();
          }
        };
        const changes = recordChanges(dataSource);
        let rolledBack = false;
        try {
          await runWithTenant(tenant, async () => {
            if (mode < 0.6) await run();
            else if (mode < 0.8) await dataSource.transaction(run);
            else {
              rolledBack = true;
              await dataSource
                .transaction(async () => {
                  await run();
                  throw new Error('roll back');
                })
                .catch((error: unknown) => {
                  if (!(error instanceof Error) || error.message !== 'roll back') throw error;
                });
            }
          });
          const after = await snapshot(raw);
          const records = changes.take();
          assert.deepEqual(changes.errors, [], where);
          assertInvariants(after, where);
          assertTenantConfined(before, after, tenant, where);
          if (rolledBack) {
            assert.deepEqual(records, [], `${where}: a rollback reports nothing`);
            assert.deepEqual(after, before, `${where}: a rollback changes nothing`);
          } else {
            assertRecordsMatchDiff(before, after, records, where);
          }
        } finally {
          changes.stop();
        }
      }
    });
  }
});
