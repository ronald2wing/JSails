/**
 * The `transaction` wrapper: nesting, after-commit and after-rollback
 * callbacks, the handle lifecycle, and argument validation.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  BaseEntity,
  Column,
  Entity,
  JoinTable,
  ManyToMany,
  PrimaryGeneratedColumn,
  type SelectQueryBuilder,
} from 'typeorm';

import { ApplicationRecord } from '../../src/database/application-record.js';
import { JsailsDataSource } from '../../src/database/data-source.js';
import {
  createEntitySubscriber,
  defineEntityHooks,
} from '../../src/database/entity-subscribers.js';
import { query } from '../../src/database/model-query.js';
import { loadRelations } from '../../src/database/relation-loader/index.js';
import {
  TransactionError,
  transaction,
  type TransactionBody,
  type TransactionHandle,
} from '../../src/database/transaction.js';
import { diffSchemaStates } from '../../src/migrations/autodetector.js';
import { executeSchemaPlan } from '../../src/migrations/schema-executor.js';

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'transaction-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeItem() {
  @Entity('items')
  class Item extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 100, nullable: false })
    name!: string;
  }
  return Item;
}

let locationSeq = 0;

/** Build, initialize, and table-create a sqljs data source bound to `Item`. */
async function createDataSource(Item: ReturnType<typeof makeItem>): Promise<JsailsDataSource> {
  const location = join(tmpRoot, `db-${locationSeq++}.sqlite`);
  const dataSource = new JsailsDataSource({
    type: 'sqljs',
    location,
    entities: [Item],
  });
  await dataSource.initialize();
  const schema = await dataSource.getModelSchema();
  const operations = diffSchemaStates({ tables: [] }, schema);
  await executeSchemaPlan(dataSource, operations);
  return dataSource;
}

describe('transaction', () => {
  it('returns the body result', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    const result = await transaction(ds, async (handle) => {
      const item = await handle.manager.save(Item, { name: 'test-item' });
      return item.id;
    });

    assert.equal(typeof result, 'number');
    // The row was committed and is visible outside the transaction.
    assert.equal(await Item.count(), 1);
    await ds.destroy();
  });

  it('rolls back on body throw and re-throws the original error', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    class TestError extends Error {
      constructor() {
        super('test-error');
        this.name = 'TestError';
      }
    }

    await assert.rejects(
      transaction(ds, async (handle) => {
        await handle.manager.save(Item, { name: 'should-not-persist' });
        throw new TestError();
      }),
      TestError,
    );

    // No row persisted — the transaction was rolled back.
    assert.equal(await Item.count(), 0);
    await ds.destroy();
  });

  it('fires afterCommit callbacks in registration order and awaits them', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    const order: number[] = [];
    let asyncCompleted = false;

    const result = await transaction(ds, async (handle) => {
      // Nested callbacks to verify registration order within a single body call.
      handle.afterCommit(() => {
        order.push(1);
      });
      handle.afterCommit(async () => {
        order.push(2);
        // Delay to prove the callback is truly awaited before transaction() resolves.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        asyncCompleted = true;
      });
      handle.afterCommit(() => {
        order.push(3);
      });

      return 'body-result';
    });

    assert.deepEqual(order, [1, 2, 3], 'callbacks must run in registration order');
    assert.equal(asyncCompleted, true, 'async afterCommit callback must be awaited');
    assert.equal(result, 'body-result');
    await ds.destroy();
  });

  it('fires afterRollback callbacks in registration order and propagates the original error', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    class TestError extends Error {
      constructor() {
        super('rollback-error');
        this.name = 'TestError';
      }
    }

    const order: number[] = [];

    await assert.rejects(
      transaction(ds, async (handle) => {
        handle.afterRollback(() => {
          order.push(1);
        });
        handle.afterRollback(() => {
          order.push(2);
        });
        throw new TestError();
      }),
      TestError,
    );

    assert.deepEqual(order, [1, 2], 'afterRollback callbacks must run in registration order');
    await ds.destroy();
  });

  it('surfaces a throwing afterCommit callback error (commit already happened)', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    class CallbackError extends Error {
      constructor() {
        super('callback-error');
        this.name = 'CallbackError';
      }
    }

    await assert.rejects(
      transaction(ds, async (handle) => {
        await handle.manager.save(Item, { name: 'persisted' });
        handle.afterCommit(() => {
          throw new CallbackError();
        });
        return 'body-result';
      }),
      CallbackError,
    );

    // The write already committed — the row survives even though the
    // callback error replaced the body result.
    assert.equal(await Item.count(), 1, 'row must persist even when afterCommit callback throws');
    await ds.destroy();
  });

  it('does NOT fire afterRollback when a committed transaction has a throwing afterCommit callback', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    class CallbackError extends Error {
      constructor() {
        super('callback-error');
        this.name = 'CallbackError';
      }
    }

    const rollbackRan: string[] = [];

    await assert.rejects(
      transaction(ds, async (handle) => {
        await handle.manager.save(Item, { name: 'persisted' });
        handle.afterRollback(() => {
          rollbackRan.push('should-not-run');
        });
        handle.afterCommit(() => {
          throw new CallbackError();
        });
        return 'body-result';
      }),
      CallbackError,
    );

    // The transaction committed, so the rollback callback must never fire even
    // though an afterCommit callback threw and replaced the result.
    assert.deepEqual(rollbackRan, [], 'afterRollback must not fire after a commit');
    assert.equal(await Item.count(), 1, 'the committed row must persist');
    await ds.destroy();
  });

  it('swallows a throwing afterRollback callback and propagates the original body error', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    class BodyError extends Error {
      constructor() {
        super('body-error');
        this.name = 'BodyError';
      }
    }

    class CallbackError extends Error {
      constructor() {
        super('callback-error');
        this.name = 'CallbackError';
      }
    }

    await assert.rejects(
      transaction(ds, async (handle) => {
        handle.afterRollback(() => {
          throw new CallbackError();
        });
        throw new BodyError();
      }),
      BodyError, // the BODY error, not the callback error
    );

    await ds.destroy();
  });

  it('rejects an invalid dataSource argument with a value-free TransactionError', async () => {
    await assert.rejects(
      transaction(null as unknown as JsailsDataSource, async () => {}),
      (err: unknown) => err instanceof TransactionError && !err.message.includes('null'),
    );
    await assert.rejects(
      transaction(undefined as unknown as JsailsDataSource, async () => {}),
      TransactionError,
    );
    await assert.rejects(
      transaction({} as unknown as JsailsDataSource, async () => {}),
      TransactionError,
    );
  });

  it('rejects a non-function body argument with a value-free TransactionError', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    await assert.rejects(
      transaction(ds, 'bad-body' as unknown as TransactionBody<unknown>),
      (err: unknown) => err instanceof TransactionError && !err.message.includes('bad-body'),
    );
    await assert.rejects(
      transaction(ds, null as unknown as TransactionBody<unknown>),
      TransactionError,
    );
    await assert.rejects(
      transaction(ds, undefined as unknown as TransactionBody<unknown>),
      TransactionError,
    );
    await assert.rejects(
      transaction(ds, {} as unknown as TransactionBody<unknown>),
      TransactionError,
    );

    await ds.destroy();
  });

  // --- Slice 2: nested join semantics ---

  it('nested same-ds commits as one unit and passes through inner return value', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    const innerResult = await transaction(ds, async (outerHandle) => {
      await outerHandle.manager.save(Item, { name: 'outer-item' });
      const result = await transaction(ds, async (innerHandle) => {
        await innerHandle.manager.save(Item, { name: 'inner-item' });
        return 'inner-value';
      });
      return { outer: 'outer-value', inner: result };
    });

    assert.equal(innerResult.inner, 'inner-value');
    assert.equal(innerResult.outer, 'outer-value');
    // Both rows committed — the whole block was one TypeORM transaction.
    assert.equal(await Item.count(), 2);
    await ds.destroy();
  });

  it('nested same-ds: callbacks fire in registration order (outer before inner)', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    const order: number[] = [];

    await transaction(ds, async (outerHandle) => {
      outerHandle.afterCommit(() => {
        order.push(1);
      });
      await transaction(ds, async (innerHandle) => {
        innerHandle.afterCommit(() => {
          order.push(2);
        });
        return 'inner';
      });
      outerHandle.afterCommit(() => {
        order.push(3);
      });
      return 'outer';
    });

    // Callbacks fire in registration order: outer(1), inner(2), outer(3).
    assert.deepEqual(order, [1, 2, 3]);
    await ds.destroy();
  });

  it('nested same-ds: inner afterRollback fires on outer rollback; inner afterCommit does not fire', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    class TestError extends Error {
      constructor() {
        super('test-error');
        this.name = 'TestError';
      }
    }

    const commitRan: number[] = [];
    const rollbackRan: number[] = [];

    await assert.rejects(
      transaction(ds, async (outerHandle) => {
        outerHandle.afterCommit(() => {
          commitRan.push(1);
        });
        outerHandle.afterRollback(() => {
          rollbackRan.push(1);
        });
        await outerHandle.manager.save(Item, { name: 'outer-item' });
        await transaction(ds, async (innerHandle) => {
          innerHandle.afterCommit(() => {
            commitRan.push(2);
          });
          innerHandle.afterRollback(() => {
            rollbackRan.push(2);
          });
          await innerHandle.manager.save(Item, { name: 'inner-item' });
          return 'inner';
        });
        throw new TestError();
      }),
      TestError,
    );

    // No afterCommit callbacks fire when the outer transaction rolls back.
    assert.deepEqual(commitRan, []);
    // Both outer and inner afterRollback callbacks fire, in registration order.
    assert.deepEqual(rollbackRan, [1, 2]);
    // No rows persisted — the entire transaction rolled back.
    assert.equal(await Item.count(), 0);
    await ds.destroy();
  });

  it('nested same-ds: inner body throw rolls back the entire outer transaction', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    class TestError extends Error {
      constructor() {
        super('inner-error');
        this.name = 'TestError';
      }
    }

    await assert.rejects(
      transaction(ds, async (outerHandle) => {
        await outerHandle.manager.save(Item, { name: 'outer-item' });
        // Inner throw is not caught — it propagates to the outer body, which
        // re-throws it, triggering a rollback of the single shared transaction.
        await transaction(ds, async (innerHandle) => {
          await innerHandle.manager.save(Item, { name: 'inner-item' });
          throw new TestError();
        });
      }),
      TestError,
    );

    // Neither row persisted — the single transaction was rolled back.
    assert.equal(await Item.count(), 0);
    await ds.destroy();
  });

  it('nested different-ds opens an independent transaction with its own callback lifecycle', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    @Entity('other_items')
    class OtherItem extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 100, nullable: false })
      name!: string;
    }

    const otherDs = await createDataSource(OtherItem);

    const ds1CommitRan: number[] = [];
    const ds2CommitRan: number[] = [];

    await transaction(ds, async (outerHandle) => {
      outerHandle.afterCommit(() => {
        ds1CommitRan.push(1);
      });
      await outerHandle.manager.save(Item, { name: 'item-from-outer' });

      // Nested transaction on a different data source — independent lifecycle.
      const innerResult = await transaction(otherDs, async (innerHandle) => {
        innerHandle.afterCommit(() => {
          ds2CommitRan.push(1);
        });
        await innerHandle.manager.save(OtherItem, { name: 'other-from-inner' });
        return 'inner-ok';
      });

      assert.equal(innerResult, 'inner-ok');
      // ds2 committed already — its afterCommit callbacks have already fired.
      assert.deepEqual(ds2CommitRan, [1]);
      // ds1's afterCommit callbacks have NOT fired yet (outer tx still open).
      assert.deepEqual(ds1CommitRan, []);

      return 'outer-ok';
    });

    // Both data sources' transactions committed normally.
    assert.equal(await Item.count(), 1);
    assert.equal(await otherDs.manager.count(OtherItem), 1);
    // ds1's afterCommit fired after the outer body returned.
    assert.deepEqual(ds1CommitRan, [1]);

    await ds.destroy();
    await otherDs.destroy();
  });

  it('nested same-ds: inner afterCommit does not fire after outer afterCommit throws', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    class CallbackError extends Error {
      constructor() {
        super('callback-error');
        this.name = 'CallbackError';
      }
    }

    const commitOrder: number[] = [];

    await assert.rejects(
      transaction(ds, async (outerHandle) => {
        await outerHandle.manager.save(Item, { name: 'persisted' });
        // Outer afterCommit throws — stops the callback chain before inner's.
        outerHandle.afterCommit(() => {
          commitOrder.push(1);
          throw new CallbackError();
        });
        await transaction(ds, async (innerHandle) => {
          // This callback is appended after the throwing one and must never run.
          innerHandle.afterCommit(() => {
            commitOrder.push(2);
          });
          return 'inner';
        });
        return 'outer';
      }),
      CallbackError,
    );

    // Only the first (throwing) callback ran — the inner's afterCommit was
    // skipped because the callbacks stop on the first throw.
    assert.deepEqual(commitOrder, [1]);
    // The row persists because the transaction already committed.
    assert.equal(await Item.count(), 1);
    await ds.destroy();
  });
});

describe('transaction — Active Record calls join the transaction', () => {
  function makeRecord() {
    @Entity('records')
    class Record extends ApplicationRecord {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 100, nullable: false })
      name!: string;
    }
    return Record;
  }

  async function recordDataSource(
    Record: ReturnType<typeof makeRecord>,
  ): Promise<JsailsDataSource> {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, `db-${locationSeq++}.sqlite`),
      entities: [Record],
    });
    await dataSource.initialize();
    await executeSchemaPlan(
      dataSource,
      diffSchemaStates({ tables: [] }, await dataSource.getModelSchema()),
    );
    return dataSource;
  }

  it('resolves the model repository through the transaction manager inside the body', async () => {
    const Record = makeRecord();
    const ds = await recordDataSource(Record);

    await transaction(ds, async (handle) => {
      assert.equal(Record.getRepository().manager, handle.manager);
      // query() resolves its builder through the same repository.
      const builder = query(Record).builder as unknown as { queryRunner?: unknown };
      assert.equal(builder.queryRunner, handle.manager.queryRunner);
    });
    assert.equal(Record.getRepository().manager, ds.manager);
    await ds.destroy();
  });

  it('rolls back post.save() made inside a failing body', async () => {
    const Record = makeRecord();
    const ds = await recordDataSource(Record);

    await assert.rejects(
      transaction(ds, async () => {
        await Record.create({ name: 'a' }).save();
        await Record.create({ name: 'b' }).save();
        assert.equal(await Record.count(), 2);
        throw new Error('abort');
      }),
      /abort/,
    );
    assert.equal(await Record.count(), 0);
    await ds.destroy();
  });

  it('loads a many-to-many relation through the transaction query runner', async () => {
    @Entity('tx_tags')
    class TxTag extends ApplicationRecord {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 100, nullable: false })
      name!: string;
    }

    @Entity('tx_posts')
    class TxPost extends ApplicationRecord {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 100, nullable: false })
      title!: string;

      @ManyToMany(() => TxTag)
      @JoinTable({
        name: 'tx_post_tags',
        joinColumn: { name: 'postId', referencedColumnName: 'id' },
        inverseJoinColumn: { name: 'tagId', referencedColumnName: 'id' },
      })
      tags!: TxTag[];
    }

    const ds = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, `db-${locationSeq++}.sqlite`),
      entities: [TxPost, TxTag],
    });
    await ds.initialize();
    await executeSchemaPlan(ds, diffSchemaStates({ tables: [] }, await ds.getModelSchema()));

    await transaction(ds, async (handle) => {
      const post = await TxPost.create({ title: 'p' }).save();
      const tag = await TxTag.create({ name: 't' }).save();
      await handle.manager.query('INSERT INTO "tx_post_tags" ("postId", "tagId") VALUES (?, ?)', [
        post.id,
        tag.id,
      ]);

      // sql.js has a single connection, so a builder on a pooled connection
      // would still see the row; assert the junction query's runner instead.
      const manager = handle.manager;
      const original = manager.createQueryBuilder.bind(manager) as (
        ...args: unknown[]
      ) => SelectQueryBuilder<object>;
      const builders: SelectQueryBuilder<object>[] = [];
      Object.assign(manager, {
        createQueryBuilder: (...args: unknown[]) => {
          const builder = original(...args);
          builders.push(builder);
          return builder;
        },
      });
      try {
        await loadRelations([post], { with: { tags: true } });
      } finally {
        Reflect.deleteProperty(manager, 'createQueryBuilder');
      }

      assert.deepEqual(
        post.tags.map((t) => t.name),
        ['t'],
      );
      const junction = builders.filter((b) =>
        b.expressionMap.aliases.some((alias) => alias.name === 'jt'),
      );
      assert.equal(junction.length, 1);
      const runner = (junction[0] as unknown as { queryRunner?: unknown }).queryRunner;
      assert.equal(runner, handle.manager.queryRunner);
    });
    await ds.destroy();
  });

  it('afterCommit callbacks use the data source manager, and the handle is closed', async () => {
    const Record = makeRecord();
    const ds = await recordDataSource(Record);

    let stashed: TransactionHandle | undefined;
    await transaction(ds, async (handle) => {
      stashed = handle;
      handle.afterCommit(async () => {
        assert.equal(Record.getRepository().manager, ds.manager);
        await Record.create({ name: 'after' }).save();
      });
    });
    assert.equal(await Record.count(), 1);
    assert.throws(
      () => stashed!.manager,
      (err: unknown) => err instanceof TransactionError && err.code === 'closed',
    );
    await ds.destroy();
  });
});

describe('transaction — one connection on sqljs', () => {
  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  it('a rollback does not discard a concurrent transaction that committed', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    const committed = transaction(ds, async (handle) => {
      await handle.manager.save(Item, { name: 'committed' });
      await pause(20);
      return 'ok';
    });
    const rolledBack = transaction(ds, async (handle) => {
      await handle.manager.save(Item, { name: 'rolled-back' });
      await pause(40);
      throw new Error('abort');
    });

    const [first, second] = await Promise.allSettled([committed, rolledBack]);
    assert.deepEqual(first, { status: 'fulfilled', value: 'ok' });
    assert.equal(second.status, 'rejected');
    const names = (await Item.find()).map((item) => item.name);
    assert.deepEqual(names, ['committed']);
    await ds.destroy();
  });

  it('queues overlapping transactions in arrival order', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    const log: string[] = [];

    const run = (name: string, ms: number) =>
      transaction(ds, async (handle) => {
        log.push(`start:${name}`);
        await pause(ms);
        await handle.manager.save(Item, { name });
        log.push(`end:${name}`);
      });
    await Promise.all([run('a', 30), run('b', 5), run('c', 0)]);

    assert.deepEqual(log, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
    assert.equal(await Item.count(), 3);
    await ds.destroy();
  });

  /** A gate the test opens by hand: `wait` settles once `open()` is called. */
  function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
    let open: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { wait, open };
  }

  it(
    'bare writes made while a transaction is open survive its rollback',
    { timeout: 10_000 },
    async () => {
      const Item = makeItem();
      const ds = await createDataSource(Item);
      await Item.create({ name: 'to-update' }).save();
      const inside = gate();
      const finish = gate();

      const rolledBack = transaction(ds, async (handle) => {
        await handle.manager.save(Item, { name: 'rolled-back' });
        inside.open();
        await finish.wait;
        throw new Error('abort');
      });
      await inside.wait;
      // Outside the body's async context: other requests' work.
      const writes = Promise.all([
        Item.create({ name: 'bare-save' }).save(),
        Item.update({ name: 'to-update' }, { name: 'bare-update' }),
        ds.query('INSERT INTO items (name) VALUES (?)', ['bare-query']),
      ]);
      await pause(20);
      finish.open();

      await assert.rejects(rolledBack, /abort/);
      await writes;
      const names = (await Item.find()).map((item) => item.name).sort();
      assert.deepEqual(names, ['bare-query', 'bare-save', 'bare-update']);
      await ds.destroy();
    },
  );

  it(
    'a transaction opened while a bare save runs is not lost to its rollback',
    { timeout: 10_000 },
    async () => {
      const Item = makeItem();
      const location = join(tmpRoot, `db-${locationSeq++}.sqlite`);
      const saving = gate();
      const resume = gate();
      const ds = new JsailsDataSource({
        type: 'sqljs',
        location,
        entities: [Item],
        subscribers: [
          createEntitySubscriber(
            defineEntityHooks(Item, {
              async afterInsert({ data }) {
                if (data.name !== 'bare') return;
                saving.open();
                await resume.wait;
                throw new Error('bare failed');
              },
            }),
          ),
        ],
      });
      await ds.initialize();
      await executeSchemaPlan(ds, diffSchemaStates({ tables: [] }, await ds.getModelSchema()));

      const bare = Item.create({ name: 'bare' }).save();
      await saving.wait;
      const committed = transaction(ds, async (handle) => {
        await handle.manager.save(Item, { name: 'committed' });
      });
      await pause(20);
      resume.open();

      await assert.rejects(bare, /bare failed/);
      await committed;
      assert.deepEqual(
        (await Item.find()).map((item) => item.name),
        ['committed'],
      );
      await ds.destroy();
    },
  );

  it(
    'the data source manager inside the body joins the transaction',
    { timeout: 10_000 },
    async () => {
      const Item = makeItem();
      const ds = await createDataSource(Item);

      await assert.rejects(
        transaction(ds, async () => {
          await ds.getRepository(Item).save({ name: 'joined' });
          assert.equal(await ds.getRepository(Item).count(), 1);
          throw new Error('abort');
        }),
        /abort/,
      );
      assert.equal(await Item.count(), 0);

      await transaction(ds, async () => {
        await ds.query('INSERT INTO items (name) VALUES (?)', ['committed']);
      });
      assert.equal(await Item.count(), 1);
      await ds.destroy();
    },
  );

  it(
    'a hook that writes through the data source during a bare save joins it',
    { timeout: 10_000 },
    async () => {
      const Item = makeItem();
      const ds: JsailsDataSource = new JsailsDataSource({
        type: 'sqljs',
        location: join(tmpRoot, `db-${locationSeq++}.sqlite`),
        entities: [Item],
        subscribers: [
          createEntitySubscriber(
            defineEntityHooks(Item, {
              async afterInsert({ data }) {
                if (data.name === 'audit') return;
                await ds.query('INSERT INTO items (name) VALUES (?)', ['audit']);
                await ds.getRepository(Item).save({ name: 'audit' });
              },
            }),
          ),
        ],
      });
      await ds.initialize();
      await executeSchemaPlan(ds, diffSchemaStates({ tables: [] }, await ds.getModelSchema()));

      await Item.create({ name: 'parent' }).save();

      assert.deepEqual((await Item.find()).map((item) => item.name).sort(), [
        'audit',
        'audit',
        'parent',
      ]);
      await ds.destroy();
    },
  );

  it('a runner is refused once released', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);
    const runner = ds.createQueryRunner();
    await runner.query('SELECT 1');
    await runner.release();
    assert.equal(runner.isReleased, true);
    await assert.rejects(runner.query('SELECT 1'));
    // The connection went back: other work proceeds.
    assert.equal(await Item.count(), 0);
    await ds.destroy();
  });

  it('an afterCommit callback may open its own transaction', async () => {
    const Item = makeItem();
    const ds = await createDataSource(Item);

    await transaction(ds, async (handle) => {
      await handle.manager.save(Item, { name: 'outer' });
      handle.afterCommit(async () => {
        await transaction(ds, async (inner) => {
          await inner.manager.save(Item, { name: 'follow-up' });
        });
      });
    });

    assert.equal(await Item.count(), 2);
    await ds.destroy();
  });
});
