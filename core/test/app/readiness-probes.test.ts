/** Tests for the built-in data-source and Valkey readiness probes, over structural fakes. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createDataSourceReadinessProbe,
  createValkeyReadinessProbe,
  type QueryableDataSource,
} from '../../src/app/index.js';

function live(): AbortSignal {
  return new AbortController().signal;
}

function fakeDataSource(
  query: (sql: string) => Promise<unknown>,
  isInitialized = true,
): QueryableDataSource & { readonly queries: string[] } {
  const queries: string[] = [];
  return {
    isInitialized,
    queries,
    query(sql) {
      queries.push(sql);
      return query(sql);
    },
  };
}

describe('createDataSourceReadinessProbe', () => {
  it('passes after SELECT 1 succeeds', async () => {
    const source = fakeDataSource(() => Promise.resolve([{ 1: 1 }]));
    assert.equal(await createDataSourceReadinessProbe(source)(live()), true);
    assert.deepEqual(source.queries, ['SELECT 1']);
  });

  it('fails an uninitialized source without querying it', async () => {
    const source = fakeDataSource(() => Promise.resolve([]), false);
    assert.equal(await createDataSourceReadinessProbe(source)(live()), false);
    assert.deepEqual(source.queries, []);
  });

  it('rejects when the query fails', async () => {
    const source = fakeDataSource(() => Promise.reject(new Error('connection refused')));
    await assert.rejects(Promise.resolve(createDataSourceReadinessProbe(source)(live())));
  });

  it('gives up at the readiness signal and at its own timeout', async () => {
    const hanging = fakeDataSource(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = Promise.resolve(createDataSourceReadinessProbe(hanging)(controller.signal));
    controller.abort();
    await assert.rejects(pending, /aborted/);

    await assert.rejects(
      Promise.resolve(createDataSourceReadinessProbe(hanging, { timeoutMs: 10 })(live())),
      /aborted/,
    );
  });

  it('validates its arguments', () => {
    assert.throws(
      () => createDataSourceReadinessProbe({} as unknown as QueryableDataSource),
      TypeError,
    );
    assert.throws(
      () =>
        createDataSourceReadinessProbe(
          fakeDataSource(() => Promise.resolve([])),
          {
            timeoutMs: 0,
          },
        ),
      TypeError,
    );
  });
});

describe('createValkeyReadinessProbe', () => {
  it('passes only on PONG', async () => {
    let pings = 0;
    const client = {
      shared: () =>
        Promise.resolve({
          ping: () => {
            pings += 1;
            return Promise.resolve('PONG');
          },
        }),
    };
    assert.equal(await createValkeyReadinessProbe(client)(live()), true);
    assert.equal(pings, 1);

    const odd = { shared: () => Promise.resolve({ ping: () => Promise.resolve('LOADING') }) };
    assert.equal(await createValkeyReadinessProbe(odd)(live()), false);
  });

  it('rejects when the connect or the ping fails', async () => {
    const refused = { shared: () => Promise.reject(new Error('ECONNREFUSED')) };
    await assert.rejects(Promise.resolve(createValkeyReadinessProbe(refused)(live())));
    const failing = {
      shared: () => Promise.resolve({ ping: () => Promise.reject(new Error('offline')) }),
    };
    await assert.rejects(Promise.resolve(createValkeyReadinessProbe(failing)(live())));
  });

  it('gives up at its own timeout on a hanging ping', async () => {
    const hanging = { shared: () => Promise.resolve({ ping: () => new Promise(() => undefined) }) };
    await assert.rejects(
      Promise.resolve(createValkeyReadinessProbe(hanging, { timeoutMs: 10 })(live())),
      /aborted/,
    );
  });

  it('requires a connection provider', () => {
    assert.throws(
      () =>
        createValkeyReadinessProbe(null as unknown as { shared(role: 'command'): Promise<never> }),
      TypeError,
    );
  });
});
