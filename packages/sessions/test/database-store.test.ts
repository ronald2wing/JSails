/**
 * Database session store tests, against a real on-disk sql.js database with
 * the `jsails_session` table created by the declarative schema plan — never by
 * runtime DDL. Covers the round trip, the upsert, lazy and bulk expiry against
 * an injected clock, value-free rejection of malformed rows and invalid
 * sessions, and the fail-closed paths for a missing table or an uninitialized
 * data source.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { JsailsDataSource } from 'jsails/database';
import { createEmptyDataSource, createTestSession, tempDir } from 'jsails/testing';
import { JsailsSession, SessionStoreError, createDatabaseSessionStore } from '../src/index.js';

/** An initialized data source with the session table migrated; destroyed with the test. */
async function openDataSource(t: TestContext): Promise<JsailsDataSource> {
  const dataSource = await createEmptyDataSource([JsailsSession], {
    location: join(tempDir(t), 'sessions.db'),
  });
  t.after(() => dataSource.destroy());
  return dataSource;
}

/** Assert a rejection is a `SessionStoreError` carrying `code`. */
function isStoreError(code: SessionStoreError['code']): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof SessionStoreError);
    assert.equal(error.code, code);
    return true;
  };
}

describe('createDatabaseSessionStore', () => {
  it('stores and retrieves a session through the ORM repository', async (t) => {
    const store = createDatabaseSessionStore({ dataSource: await openDataSource(t) });

    assert.equal(await store.get('test-session-1'), null);

    const value = createTestSession();
    await store.set(value);
    assert.deepEqual(await store.get('test-session-1'), value);
  });

  it('upserts by session id, preserving createdAt on update', async (t) => {
    const dataSource = await openDataSource(t);
    const store = createDatabaseSessionStore({ dataSource });
    const repository = dataSource.getRepository(JsailsSession);
    const now = Date.now();

    await store.set(
      createTestSession({ id: 's1', csrfToken: 'c1', data: { n: 1 }, expiresAt: now + 1000 }),
    );
    const first = await repository.findOneByOrFail({ sessionId: 's1' });

    await store.set(
      createTestSession({ id: 's1', csrfToken: 'c2', data: { n: 2 }, expiresAt: now + 2000 }),
    );

    assert.equal(await repository.count(), 1);
    const after = await repository.findOneByOrFail({ sessionId: 's1' });
    assert.equal(after.createdAt.getTime(), first.createdAt.getTime());

    const stored = await store.get('s1');
    assert.equal(stored?.csrfToken, 'c2');
    assert.deepEqual(stored?.data, { n: 2 });
    assert.equal(stored?.expiresAt, now + 2000);
  });

  it('deletes a session by id', async (t) => {
    const dataSource = await openDataSource(t);
    const store = createDatabaseSessionStore({ dataSource });

    await store.set(createTestSession({ id: 'd1' }));
    assert.notEqual(await store.get('d1'), null);

    await store.delete('d1');
    assert.equal(await store.get('d1'), null);
    assert.equal(await dataSource.getRepository(JsailsSession).count(), 0);
  });

  it('returns null and lazily deletes expired rows against an injected clock', async (t) => {
    const dataSource = await openDataSource(t);
    let current = 1000;
    const store = createDatabaseSessionStore({ dataSource, now: () => current });
    const value = createTestSession({ id: 'expires', expiresAt: 2000 });

    await store.set(value);

    current = 1999;
    assert.deepEqual(await store.get('expires'), value);

    current = 2000;
    assert.equal(await store.get('expires'), null);
    assert.equal(await dataSource.getRepository(JsailsSession).count(), 0);
  });

  it('prunes expired rows in bulk and leaves future sessions intact', async (t) => {
    const store = createDatabaseSessionStore({
      dataSource: await openDataSource(t),
      now: () => 1000,
    });

    await store.set(createTestSession({ id: 'e1', expiresAt: 1000 }));
    await store.set(createTestSession({ id: 'e2', expiresAt: 500 }));
    await store.set(createTestSession({ id: 'future', expiresAt: 5000 }));

    assert.equal(await store.pruneExpired(), 2);
    assert.equal(await store.get('e1'), null);
    assert.equal(await store.get('e2'), null);
    assert.notEqual(await store.get('future'), null);
  });

  it('rejects a malformed stored row without echoing its contents', async (t) => {
    const dataSource = await openDataSource(t);
    const store = createDatabaseSessionStore({ dataSource });
    const repository = dataSource.getRepository(JsailsSession);

    await repository.save({
      sessionId: 'bad-json',
      data: 'this is not json',
      expiresAt: new Date(9000),
      createdAt: new Date(),
    });
    await assert.rejects(store.get('bad-json'), (error: unknown) => {
      assert.ok(error instanceof SessionStoreError);
      assert.equal(error.code, 'malformed_row');
      assert.ok(!error.message.includes('this is not json'));
      return true;
    });

    // A row whose stored id disagrees with its sessionId column is also malformed.
    await repository.save({
      sessionId: 'mismatch',
      data: JSON.stringify({ id: 'other', csrfToken: 'c', data: {}, expiresAt: 9000 }),
      expiresAt: new Date(9000),
      createdAt: new Date(),
    });
    await assert.rejects(store.get('mismatch'), isStoreError('malformed_row'));
  });

  it('rejects an invalid session before writing anything', async (t) => {
    const dataSource = await openDataSource(t);
    const store = createDatabaseSessionStore({ dataSource });

    await assert.rejects(
      store.set(createTestSession({ id: '', csrfToken: 'c' })),
      isStoreError('invalid_session'),
    );
    assert.equal(await dataSource.getRepository(JsailsSession).count(), 0);
  });

  it('rejects malformed options at construction', (t) => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tempDir(t), 'options.db'),
      entities: [JsailsSession],
    });
    assert.throws(() => createDatabaseSessionStore(null as never), TypeError);
    assert.throws(() => createDatabaseSessionStore({ dataSource: {} as never }), TypeError);
    assert.throws(() => createDatabaseSessionStore({ dataSource, now: 1 as never }), TypeError);
  });

  it('fails with a clear error when the table was never migrated', async (t) => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tempDir(t), 'missing.db'),
      entities: [JsailsSession],
    });
    await dataSource.initialize();
    t.after(() => dataSource.destroy());

    const store = createDatabaseSessionStore({ dataSource });
    for (const operation of [
      () => store.get('x'),
      () => store.set(createTestSession()),
      () => store.delete('x'),
      () => store.pruneExpired(),
    ]) {
      await assert.rejects(operation, (error: unknown) => {
        assert.ok(isStoreError('missing_table')(error));
        assert.match((error as Error).message, /db:push/);
        return true;
      });
    }
  });

  it('fails on an uninitialized data source without querying', async (t) => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tempDir(t), 'uninitialized.db'),
      entities: [JsailsSession],
    });

    const store = createDatabaseSessionStore({ dataSource });
    await assert.rejects(store.get('x'), isStoreError('not_initialized'));
    assert.equal(dataSource.isInitialized, false);
  });
});
