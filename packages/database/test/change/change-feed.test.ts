/**
 * The change feed outside any transaction: nothing is delivered without a
 * subscription, each delivery is coalesced and filtered per subscription by
 * the tables of its models, and every failure on the subscriber's side (the
 * listener, its promise, `models()`, even `onError` itself) stays there.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createChangeFeed } from '../../src/change/change-feed.js';
import { changeRecord, type ChangeRecord } from '../../src/change/change-record.js';
import type { Engine } from '../../src/engine/index.js';
import { column, defineTable } from '../../src/model/index.js';

const Posts = defineTable({ table: 'cf_posts', columns: { title: column.string(20) } });
const Comments = defineTable({ table: 'cf_comments', columns: { body: column.string(20) } });

/** An engine no transaction is bound to, so records are delivered at once. */
const ENGINE = Object.freeze({}) as Engine;

describe('the change feed', () => {
  it('is inactive, and delivers nothing, without a subscription', async () => {
    const { feed, emitter } = createChangeFeed();
    assert.equal(emitter.active, false);
    await emitter.emit(ENGINE, [changeRecord('cf_posts', 'insert', 1)]);
    const received: (readonly ChangeRecord[])[] = [];
    const stop = feed.subscribe((records) => received.push(records), {
      models: () => new Set([Posts]),
      onError: () => assert.fail('no failure expected'),
    });
    assert.equal(emitter.active, true);
    stop();
    assert.equal(emitter.active, false);
    assert.deepEqual(received, []);
  });

  it('coalesces each delivery and filters it by the tables of the models', async () => {
    const { feed, emitter } = createChangeFeed();
    const posts: (readonly ChangeRecord[])[] = [];
    const both: (readonly ChangeRecord[])[] = [];
    const stops = [
      feed.subscribe((records) => posts.push(records), {
        models: () => new Set([Posts]),
        onError: () => assert.fail('no failure expected'),
      }),
      feed.subscribe((records) => both.push(records), {
        models: () => new Set([Posts, Comments]),
        onError: () => assert.fail('no failure expected'),
      }),
    ];
    await emitter.emit(ENGINE, [
      changeRecord('cf_posts', 'insert', 1),
      changeRecord('cf_posts', 'update', 1),
      changeRecord('cf_comments', 'delete', 9),
    ]);
    await emitter.emit(ENGINE, [changeRecord('cf_comments', 'update', 9)]);
    await emitter.emit(ENGINE, []);
    assert.deepEqual(posts, [[changeRecord('cf_posts', 'insert', 1)]]);
    assert.deepEqual(both, [
      [changeRecord('cf_posts', 'insert', 1), changeRecord('cf_comments', 'delete', 9)],
      [changeRecord('cf_comments', 'update', 9)],
    ]);
    assert.ok(Object.isFrozen(both[0]));
    for (const stop of stops) stop();
  });

  it('keeps every subscriber failure on the subscriber side', async () => {
    const { feed, emitter } = createChangeFeed();
    const reported: string[] = [];
    feed.subscribe(() => undefined, {
      models: () => {
        throw new Error('models failed');
      },
      onError: (error) => reported.push((error as Error).message),
    });
    feed.subscribe(
      () => {
        throw new Error('listener failed');
      },
      {
        models: () => new Set([Posts]),
        onError: () => {
          throw new Error('the reporter failed too');
        },
      },
    );
    const delivered: number[] = [];
    feed.subscribe((records) => delivered.push(records.length), {
      models: () => new Set([Posts]),
      onError: () => assert.fail('no failure expected'),
    });
    await emitter.emit(ENGINE, [changeRecord('cf_posts', 'insert', 1)]);
    assert.deepEqual(reported, ['models failed']);
    assert.deepEqual(delivered, [1], 'later subscribers still receive the records');
  });
});
