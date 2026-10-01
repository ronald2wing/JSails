/**
 * Commit buffers on SQLite: items reach their consumer at once outside a
 * transaction, in one batch after the outermost commit inside one, never
 * from a frame that rolled back, at once at a `withTestTransaction` root and
 * on the release of a transaction directly inside it; a consumer failure
 * after a commit is reported as `after_commit_failed`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCommitBuffer } from '../../src/transaction/commit-buffer.js';
import {
  transaction,
  TransactionErrors,
  withTestTransaction,
} from '../../src/transaction/index.js';
import { openNotesEngine } from './fixtures/sqlite-transaction-engine.js';

const FAILURE = new Error('roll back');

function recorder() {
  const batches: string[][] = [];
  const buffer = createCommitBuffer<string>((items) => {
    batches.push([...items]);
  });
  return { batches, buffer };
}

describe('commit buffer', () => {
  it('delivers at once outside a transaction', async (t) => {
    const engine = await openNotesEngine(t);
    const { batches, buffer } = recorder();
    await buffer.add(engine, 'a');
    await buffer.add(engine, 'b');
    assert.deepEqual(batches, [['a'], ['b']]);
  });

  it('delivers the items surviving every frame in one batch after the outermost commit', async (t) => {
    const engine = await openNotesEngine(t);
    const { batches, buffer } = recorder();
    await transaction(engine, async () => {
      await buffer.add(engine, 'outer');
      await transaction(engine, () => buffer.add(engine, 'released'));
      await assert.rejects(
        transaction(engine, async () => {
          await buffer.add(engine, 'rolled back');
          throw FAILURE;
        }),
        (error) => error === FAILURE,
      );
      assert.deepEqual(batches, []);
    });
    assert.deepEqual(batches, [['outer', 'released']]);

    batches.length = 0;
    await assert.rejects(
      transaction(engine, async () => {
        await buffer.add(engine, 'lost');
        throw FAILURE;
      }),
      (error) => error === FAILURE,
    );
    assert.deepEqual(batches, []);
  });

  it("under withTestTransaction delivers at the root at once and on a transaction's release", async (t) => {
    const engine = await openNotesEngine(t);
    const { batches, buffer } = recorder();
    await withTestTransaction(engine, async () => {
      await buffer.add(engine, 'root');
      await transaction(engine, async () => {
        await buffer.add(engine, 'first');
        await transaction(engine, () => buffer.add(engine, 'second'));
        assert.deepEqual(batches, [['root']]);
      });
      assert.deepEqual(batches, [['root'], ['first', 'second']]);
    });
  });

  it('reports a failed delivery after the commit as after_commit_failed', async (t) => {
    const engine = await openNotesEngine(t);
    const consumerFailure = new Error('consumer failed');
    const buffer = createCommitBuffer<string>(() => {
      throw consumerFailure;
    });
    await assert.rejects(
      transaction(engine, () => buffer.add(engine, 'item')),
      (error: unknown) => {
        assert.ok(TransactionErrors.is(error, 'after_commit_failed'));
        assert.equal(error.cause, consumerFailure);
        return true;
      },
    );
  });

  it('refuses an item from a transaction that ended', async (t) => {
    const engine = await openNotesEngine(t);
    const { buffer } = recorder();
    let release!: () => void;
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    let added: Promise<void> | undefined;
    await transaction(engine, () => {
      added = opened.then(() => buffer.add(engine, 'late'));
    });
    release();
    await assert.rejects(added as Promise<void>, (error: unknown) =>
      TransactionErrors.is(error, 'closed'),
    );
  });
});
