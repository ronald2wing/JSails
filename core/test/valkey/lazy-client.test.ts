/**
 * Tests for `createLazyValkeyClient` over an injected fake ioredis constructor:
 * nothing connects until the first `get`, concurrent callers share one
 * connect, a failed connect is retried, errors are rebuilt by the caller's
 * factories, and `close` disconnects exactly once.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { createLazyValkeyClient } from '../../src/valkey/lazy-client.js';
import { deferred } from '../../src/testing/fixtures.js';

class FakeBackendError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'FakeBackendError';
  }
}

class FakeClosedError extends Error {
  constructor() {
    super('fake client is closed');
    this.name = 'FakeClosedError';
  }
}

/** A recording ioredis stand-in; `connectResult` controls the connect outcome. */
class FakeClient {
  static readonly instances: FakeClient[] = [];
  static connectResult: () => Promise<void> = () => Promise.resolve();

  readonly listeners: Array<(error: unknown) => void> = [];
  disconnects = 0;

  constructor(
    readonly url: string,
    readonly options: object,
  ) {
    FakeClient.instances.push(this);
  }

  connect(): Promise<void> {
    return FakeClient.connectResult();
  }

  disconnect(): Promise<void> {
    this.disconnects += 1;
    return Promise.resolve();
  }

  on(_event: 'error', listener: (error: unknown) => void): this {
    this.listeners.push(listener);
    return this;
  }

  emitError(error: unknown): void {
    for (const listener of this.listeners) listener(error);
  }
}

function createHandle(options: { valkeyUrl?: string; onError?: (error: Error) => void } = {}) {
  return createLazyValkeyClient<FakeClient>({
    ...options,
    dependencies: { RedisClient: FakeClient },
    label: 'test backend',
    makeError: (message, code) => new FakeBackendError(message, code),
    makeClosedError: () => new FakeClosedError(),
  });
}

describe('createLazyValkeyClient', () => {
  afterEach(() => {
    FakeClient.instances.length = 0;
    FakeClient.connectResult = () => Promise.resolve();
  });

  it('constructs and connects the client on the first get only', async () => {
    const handle = createHandle({ valkeyUrl: 'redis://localhost:6379' });
    assert.equal(FakeClient.instances.length, 0);

    const client = await handle.get();

    assert.equal(FakeClient.instances.length, 1);
    assert.equal(client, FakeClient.instances[0]);
    assert.equal(client.url, 'redis://localhost:6379');
    assert.deepEqual(client.options, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
    });
    assert.equal(await handle.get(), client);
    assert.equal(FakeClient.instances.length, 1);
  });

  it('shares one connect between concurrent callers', async () => {
    const connecting = deferred();
    FakeClient.connectResult = () => connecting.promise;
    const handle = createHandle({ valkeyUrl: 'redis://localhost:6379' });

    const first = handle.get();
    const second = handle.get();
    connecting.resolve();
    const [a, b] = await Promise.all([first, second]);

    assert.equal(a, b);
    assert.equal(FakeClient.instances.length, 1);
  });

  it('rejects get with the caller-built error and retries after a failed connect', async () => {
    let attempts = 0;
    FakeClient.connectResult = () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))
        : Promise.resolve();
    };
    const handle = createHandle({ valkeyUrl: 'redis://localhost:6379' });

    await assert.rejects(handle.get(), (error: unknown) => {
      assert.ok(error instanceof FakeBackendError);
      assert.equal(error.message, 'test backend error (ECONNREFUSED)');
      assert.equal(error.code, 'ECONNREFUSED');
      return true;
    });
    assert.equal(FakeClient.instances[0]?.disconnects, 1);

    const client = await handle.get();
    assert.equal(client, FakeClient.instances[1]);
    assert.equal(attempts, 2);
  });

  it('fails value-free when no URL is configured or the URL is not redis://', async () => {
    const saved = process.env.VALKEY_URL;
    delete process.env.VALKEY_URL;
    try {
      await assert.rejects(createHandle().get(), (error: unknown) => {
        assert.ok(error instanceof FakeBackendError);
        assert.equal(error.message, 'no Valkey URL configured: set valkeyUrl or VALKEY_URL');
        return true;
      });
    } finally {
      if (saved !== undefined) process.env.VALKEY_URL = saved;
    }

    await assert.rejects(
      createHandle({ valkeyUrl: 'http://secret:password@host' }).get(),
      (error: unknown) => {
        assert.ok(error instanceof FakeBackendError);
        assert.doesNotMatch(error.message, /password/);
        return true;
      },
    );
    assert.equal(FakeClient.instances.length, 0);
  });

  it('routes only post-connect errors to onError, sanitized', async () => {
    const seen: Error[] = [];
    const handle = createHandle({
      valkeyUrl: 'redis://localhost:6379',
      onError: (error) => {
        seen.push(error);
      },
    });
    const client = await handle.get();

    client.emitError(Object.assign(new Error('dropped with secret'), { code: 'ECONNRESET' }));

    assert.equal(seen.length, 1);
    assert.ok(seen[0] instanceof FakeBackendError);
    assert.equal(seen[0]?.message, 'test backend error (ECONNRESET)');
  });

  it('close disconnects once, shares concurrent closes, and rejects later gets', async () => {
    const handle = createHandle({ valkeyUrl: 'redis://localhost:6379' });
    const client = await handle.get();

    await Promise.all([handle.close(), handle.close()]);
    await handle.close();

    assert.equal(client.disconnects, 1);
    await assert.rejects(handle.get(), (error: unknown) => error instanceof FakeClosedError);
  });

  it('close before any get is a no-op that still rejects later gets', async () => {
    const handle = createHandle({ valkeyUrl: 'redis://localhost:6379' });

    await handle.close();

    assert.equal(FakeClient.instances.length, 0);
    await assert.rejects(handle.get(), (error: unknown) => error instanceof FakeClosedError);
  });

  it('a close racing the connect disconnects the finished client', async () => {
    const connecting = deferred();
    FakeClient.connectResult = () => connecting.promise;
    const handle = createHandle({ valkeyUrl: 'redis://localhost:6379' });

    const pending = handle.get();
    const closing = handle.close();
    connecting.resolve();

    await assert.rejects(pending, (error: unknown) => error instanceof FakeClosedError);
    await closing;
    assert.equal(FakeClient.instances[0]?.disconnects, 1);
  });
});
