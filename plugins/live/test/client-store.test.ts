/**
 * Tests for the normalized client store (LIVE-PLAN.md Phase 8).
 *
 * The store is the browser's only copy of live state, so its contract is narrow
 * and load-bearing: a snapshot replaces, a change upserts or deletes, a duplicate
 * apply is a no-op, and a change for an unknown id is an insert. There is no
 * matcher and no sorter to test — membership is the server's decision.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LiveRow, LiveServerMessage } from 'jsails/live';

import { createLiveClientStore } from '../src/client/client-store.js';

const COLLECTION = 'posts';

function row(id: number, overrides: Record<string, unknown> = {}): LiveRow {
  return { id, title: `post ${id}`, status: 'published', ...overrides };
}

function snapshot(rows: readonly LiveRow[], resumed = false): LiveServerMessage {
  return { type: 'snapshot', subscriptionId: '1', sequence: 10, rows, resumed };
}

function change(
  id: string,
  row: LiveRow | null,
  sequence = 11,
  collection = COLLECTION,
): LiveServerMessage {
  return { type: 'change', subscriptionId: '1', sequence, collection, id, row };
}

describe('createLiveClientStore', () => {
  it('rejects an empty collection name', () => {
    assert.throws(() => createLiveClientStore(''), TypeError);
  });

  it('populates from a snapshot, keyed by primary key', () => {
    const store = createLiveClientStore(COLLECTION);
    store.apply(snapshot([row(1), row(2)]));

    assert.deepEqual([...store.rows().keys()], ['1', '2']);
    assert.equal(store.rows().get('1')?.['title'], 'post 1');
  });

  it('replaces the collection wholesale on a snapshot', () => {
    const store = createLiveClientStore(COLLECTION);
    store.apply(snapshot([row(1), row(2)]));
    // A row deleted while the client was disconnected must not survive.
    store.apply(snapshot([row(2), row(3)]));

    assert.deepEqual([...store.rows().keys()], ['2', '3']);
  });

  it('applies an insert, an update, and a delete', () => {
    const store = createLiveClientStore(COLLECTION);
    store.apply(snapshot([row(1)]));

    store.apply(change('2', row(2)));
    assert.equal(store.rows().get('2')?.['title'], 'post 2');

    store.apply(change('1', row(1, { title: 'renamed' })));
    assert.equal(store.rows().get('1')?.['title'], 'renamed');

    store.apply(change('2', null));
    assert.equal(store.rows().has('2'), false);
  });

  it('treats a change for an unknown id as an insert', () => {
    const store = createLiveClientStore(COLLECTION);
    store.apply(snapshot([]));
    // The client may have missed the snapshot row; the change carries the full
    // row, so applying it is the correct recovery.
    store.apply(change('7', row(7)));

    assert.equal(store.rows().get('7')?.['title'], 'post 7');
  });

  it('treats a delete for an unknown id as a no-op', () => {
    const store = createLiveClientStore(COLLECTION);
    store.apply(snapshot([row(1)]));
    store.apply(change('99', null));

    assert.deepEqual([...store.rows().keys()], ['1']);
  });

  it('applying the same change twice is a no-op', () => {
    const store = createLiveClientStore(COLLECTION);
    store.apply(snapshot([row(1)]));

    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    const update = change('1', row(1, { title: 'renamed' }));
    store.apply(update);
    store.apply(update);

    // The second apply changed nothing, so it must not notify: a reconnect can
    // replay a suffix the client already applied.
    assert.equal(notifications, 1);
    assert.equal(store.rows().get('1')?.['title'], 'renamed');
  });

  it('ignores a change for another collection', () => {
    const store = createLiveClientStore(COLLECTION);
    store.apply(snapshot([row(1)]));
    store.apply(change('2', row(2), 11, 'pages'));

    assert.equal(store.rows().has('2'), false);
  });

  it('notifies once per snapshot, not once per row', () => {
    const store = createLiveClientStore(COLLECTION);
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.apply(snapshot([row(1), row(2), row(3)]));
    assert.equal(notifications, 1);
  });

  it('stops notifying after unsubscribe', () => {
    const store = createLiveClientStore(COLLECTION);
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    unsubscribe();

    store.apply(snapshot([row(1)]));
    assert.equal(notifications, 0);
  });

  it('ignores an error message but keeps the rows', () => {
    const store = createLiveClientStore(COLLECTION);
    store.apply(snapshot([row(1)]));
    store.apply({ type: 'error', subscriptionId: '1', code: 'unauthorized' });

    assert.equal(store.rows().size, 1);
  });

  it('skips a snapshot row with no usable id', () => {
    const store = createLiveClientStore(COLLECTION);
    store.apply(snapshot([{ title: 'no id' }, row(2)]));

    assert.deepEqual([...store.rows().keys()], ['2']);
  });

  it('normalizes a numeric id to the wire string form', () => {
    const store = createLiveClientStore(COLLECTION);
    store.apply(snapshot([row(5)]));
    // The change arrives with the string id the server normalized.
    store.apply(change('5', row(5, { title: 'updated' })));

    assert.equal(store.rows().size, 1);
    assert.equal(store.rows().get('5')?.['title'], 'updated');
  });

  it('reset drops every row and notifies once', () => {
    const store = createLiveClientStore(COLLECTION);
    store.apply(snapshot([row(1), row(2)]));

    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.reset();

    assert.equal(store.rows().size, 0);
    assert.equal(notifications, 1);
  });

  it('reset on an empty store does not notify', () => {
    const store = createLiveClientStore(COLLECTION);
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.reset();

    assert.equal(notifications, 0);
  });
});
