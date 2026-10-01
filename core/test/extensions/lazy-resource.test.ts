/**
 * Tests for `createLazyResource`: one shared creation for concurrent callers,
 * a retried creation after failure, and a close that is idempotent, awaits a
 * pending creation, and refuses every later `get`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLazyResource, LazyResourceError } from '../../src/extensions/lazy-resource.js';
import { deferred } from '../../src/testing/fixtures.js';

describe('createLazyResource', () => {
  it('creates nothing until the first get', async () => {
    let creations = 0;
    const resource = createLazyResource({
      create: () => {
        creations += 1;
        return { id: creations };
      },
      close: () => undefined,
    });

    assert.equal(creations, 0);
    assert.equal(resource.closed, false);
    assert.deepEqual(await resource.get(), { id: 1 });
    assert.deepEqual(await resource.get(), { id: 1 });
    assert.equal(creations, 1);
  });

  it('shares one in-flight creation between concurrent callers', async () => {
    const creation = deferred<string>();
    let creations = 0;
    const resource = createLazyResource({
      create: () => {
        creations += 1;
        return creation.promise;
      },
      close: () => undefined,
    });

    const first = resource.get();
    const second = resource.get();
    creation.resolve('shared');

    assert.deepEqual(await Promise.all([first, second]), ['shared', 'shared']);
    assert.equal(creations, 1);
  });

  it('retries a creation that rejected or threw synchronously', async () => {
    let attempt = 0;
    const resource = createLazyResource<number>({
      create: () => {
        attempt += 1;
        if (attempt === 1) throw new Error('sync failure');
        if (attempt === 2) return Promise.reject(new Error('async failure'));
        return attempt;
      },
      close: () => undefined,
    });

    await assert.rejects(resource.get(), /sync failure/);
    await assert.rejects(resource.get(), /async failure/);
    assert.equal(await resource.get(), 3);
    assert.equal(attempt, 3);
  });

  it('closes a created resource once and shares the close between callers', async () => {
    const closed: string[] = [];
    const resource = createLazyResource({
      create: () => 'handle',
      close: (handle) => {
        closed.push(handle);
      },
    });

    await resource.get();
    await Promise.all([resource.close(), resource.close()]);
    await resource.close();

    assert.deepEqual(closed, ['handle']);
    assert.equal(resource.closed, true);
  });

  it('close is a no-op when nothing was created', async () => {
    let closes = 0;
    const resource = createLazyResource({
      create: () => 'never',
      close: () => {
        closes += 1;
      },
    });

    await resource.close();

    assert.equal(closes, 0);
    assert.equal(resource.closed, true);
  });

  it('close awaits a pending creation and then releases it', async () => {
    const creation = deferred<string>();
    const closed: string[] = [];
    const resource = createLazyResource({
      create: () => creation.promise,
      close: (handle) => {
        closed.push(handle);
      },
    });

    const pending = resource.get();
    let closeSettled = false;
    const closing = resource.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    assert.equal(closeSettled, false);

    creation.resolve('late');
    await closing;

    assert.equal(await pending, 'late');
    assert.deepEqual(closed, ['late']);
  });

  it('close skips the release when the pending creation fails', async () => {
    const creation = deferred<string>();
    let closes = 0;
    const resource = createLazyResource({
      create: () => creation.promise,
      close: () => {
        closes += 1;
      },
    });

    const pending = resource.get();
    const closing = resource.close();
    creation.reject(new Error('creation failed'));

    await assert.rejects(pending, /creation failed/);
    await closing;
    assert.equal(closes, 0);
  });

  it('get after close rejects with code closed', async () => {
    const resource = createLazyResource({
      create: () => 'handle',
      close: () => undefined,
    });

    await resource.close();

    await assert.rejects(resource.get(), (error: unknown) => {
      assert.ok(error instanceof LazyResourceError);
      assert.equal(error.code, 'closed');
      assert.equal(error.name, 'LazyResourceError');
      return true;
    });
  });
});
