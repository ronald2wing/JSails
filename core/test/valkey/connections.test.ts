/**
 * Tests for the Valkey connection provider: the role policy table, option
 * validation, the fault behaviour of every role against a peer that never
 * answers (`blackholeServer`) and one that resets mid-command, shared-role
 * memoization and retry, teardown, post-connect error reporting, and the
 * script runner's `EVALSHA`/`EVAL` fallback and per-script deadline.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { settlesWithin } from '../../src/testing/audit-test.js';
import { blackholeServer } from '../../src/testing/blackhole-server.js';
import { respServer } from '../../src/testing/resp-server.js';
import {
  createValkeyConnections,
  DEFAULT_VALKEY_TIMEOUTS,
  valkeyRoleOptions,
  ValkeyError,
  type ValkeyConnections,
  type ValkeyConnectionsOptions,
  type ValkeyRole,
} from '../../src/valkey/connections.js';

const SHORT = { connectMs: 300, commandMs: 200 } as const;

/** Margin over a deadline for timers and loopback round trips under load. */
const SLACK_MS = 1500;

function provider(url: string, options: Partial<ValkeyConnectionsOptions> = {}): ValkeyConnections {
  return createValkeyConnections(url, {
    appPrefix: 'test-app:test',
    name: 'test',
    timeouts: SHORT,
    ...options,
  });
}

/** Run `operation`, requiring it to reject with `ValkeyError(code)` within `ms`. */
async function rejectsWithin(
  operation: Promise<unknown>,
  ms: number,
  code: string,
  label: string,
): Promise<void> {
  const outcome = await settlesWithin(
    operation.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    ms,
    label,
  );
  assert.equal(outcome.ok, false, `${label} resolved`);
  if (!outcome.ok) {
    assert.ok(outcome.error instanceof ValkeyError, `${label}: ${String(outcome.error)}`);
    assert.equal(outcome.error.code, code);
  }
}

function connect(connections: ValkeyConnections, role: ValkeyRole): Promise<unknown> {
  return role === 'command' || role === 'subscriber'
    ? connections.shared(role)
    : connections.dedicated(role, 'fault');
}

describe('valkey role policies', () => {
  it('bounds every connect and gives each role its own command policy', () => {
    const timeouts = DEFAULT_VALKEY_TIMEOUTS;
    assert.deepEqual(timeouts, { connectMs: 5000, commandMs: 2000 });
    for (const role of ['command', 'subscriber', 'blocking', 'queue'] as const) {
      const options = valkeyRoleOptions(role, `app:${role}`, timeouts);
      assert.equal(options.lazyConnect, true, role);
      assert.equal(options.connectTimeout, 5000, role);
      assert.equal(options.connectionName, `app:${role}`, role);
      assert.equal(typeof options.keepAlive, 'number', role);
      assert.equal(typeof options.retryStrategy, 'function', role);
    }
    const command = valkeyRoleOptions('command', 'app:command', timeouts);
    assert.equal(command.enableOfflineQueue, false);
    assert.equal(command.commandTimeout, 2000);
    assert.equal(command.maxRetriesPerRequest, 1);

    const subscriber = valkeyRoleOptions('subscriber', 'app:subscriber', timeouts);
    assert.equal(subscriber.commandTimeout, undefined, 'a resubscribe nobody awaits never rejects');
    assert.equal(subscriber.maxRetriesPerRequest, null);
    assert.equal(subscriber.enableOfflineQueue, true);
    assert.equal(subscriber.autoResubscribe, true);

    const blocking = valkeyRoleOptions('blocking', 'app:blocking', timeouts);
    assert.equal(blocking.commandTimeout, undefined);
    assert.equal(blocking.maxRetriesPerRequest, null);
    assert.ok((blocking.blockingTimeout ?? 0) > 0, 'a dead blocking read still returns');

    const queue = valkeyRoleOptions('queue', 'app:queue', timeouts);
    assert.equal(queue.commandTimeout, undefined);
    assert.equal(queue.maxRetriesPerRequest, null, 'BullMQ requires it for blocking moves');
  });

  it('backs off between reconnects up to a cap', () => {
    const { retryStrategy } = valkeyRoleOptions('command', 'app:command', DEFAULT_VALKEY_TIMEOUTS);
    assert.equal(retryStrategy?.(1), 100);
    assert.equal(retryStrategy?.(100), 2000);
  });
});

describe('valkey connections options', () => {
  it('refuses a malformed URL without echoing it', () => {
    for (const url of ['', 'http://user:sup3rsecret@host:6379', 'not a url']) {
      assert.throws(
        () => provider(url),
        (error: unknown) => {
          assert.ok(error instanceof ValkeyError);
          assert.equal(error.code, 'invalid_url');
          assert.doesNotMatch(error.message, /sup3rsecret|user/);
          return true;
        },
      );
    }
  });

  it('refuses a bad prefix, name, or deadline', () => {
    const url = 'redis://127.0.0.1:6379';
    for (const options of [
      { appPrefix: 'has space' },
      { appPrefix: '' },
      { name: 'bad name' },
      { timeouts: { connectMs: 0 } },
      { timeouts: { commandMs: 1.5 } },
      { onError: 'nope' as unknown as () => void },
    ]) {
      assert.throws(
        () => provider(url, options),
        (error: unknown) => error instanceof ValkeyError && error.code === 'invalid_options',
        JSON.stringify(options),
      );
    }
  });

  it('exposes the app key prefix and connects nothing at construction', () => {
    let constructed = 0;
    class CountingClient {
      constructor() {
        constructed += 1;
      }
    }
    const connections = provider('redis://127.0.0.1:6379', {
      appPrefix: '{shop}:production',
      dependencies: { RedisClient: CountingClient },
    });
    assert.equal(connections.prefix, '{shop}:production');
    assert.equal(constructed, 0);
  });
});

describe('valkey connections against a silent peer', () => {
  for (const role of ['command', 'subscriber', 'blocking', 'queue'] as const) {
    it(`rejects a ${role} connect as unavailable within the connect deadline`, async (t) => {
      const blackhole = await blackholeServer();
      t.after(() => blackhole.close());
      const connections = provider(blackhole.url('redis'));
      t.after(() => connections.close());
      const started = Date.now();
      await rejectsWithin(
        connect(connections, role),
        SHORT.connectMs + SLACK_MS,
        'unavailable',
        `${role} connect`,
      );
      assert.ok(Date.now() - started >= SHORT.connectMs - 50, 'it waited for the deadline');
      assert.ok(blackhole.connections >= 1, 'the client reached the peer');
    });
  }

  it('retries a shared connect after a failure instead of memoizing it', async (t) => {
    const blackhole = await blackholeServer();
    t.after(() => blackhole.close());
    const connections = provider(blackhole.url('redis'));
    t.after(() => connections.close());
    await rejectsWithin(connections.shared('command'), 2000, 'unavailable', 'first connect');
    const before = blackhole.connections;
    await rejectsWithin(connections.shared('command'), 2000, 'unavailable', 'second connect');
    assert.ok(blackhole.connections > before, 'the second call opened a new connection');
  });
});

describe('valkey connections against a peer that resets', () => {
  for (const role of ['command', 'subscriber', 'blocking', 'queue'] as const) {
    it(`rejects a ${role} connect when the handshake is reset`, async (t) => {
      const blackhole = await blackholeServer({ mode: 'reset' });
      t.after(() => blackhole.close());
      const connections = provider(blackhole.url('redis'));
      t.after(() => connections.close());
      await rejectsWithin(connect(connections, role), SLACK_MS, 'unavailable', `${role} connect`);
    });
  }

  it('rejects a command reset mid-flight instead of hanging', async (t) => {
    const server = await respServer({ resetOn: ['GET'] });
    t.after(() => server.close());
    const connections = provider(server.url);
    t.after(() => connections.close());
    const client = await connections.shared('command');
    const outcome = await settlesWithin(
      client.get('page').then(
        () => 'resolved',
        () => 'rejected',
      ),
      SHORT.commandMs + SLACK_MS,
      'a GET whose connection is reset',
    );
    assert.equal(outcome, 'rejected');
    assert.ok(server.received.includes('GET'));
  });

  it('resends a subscribe reset mid-flight once the connection is back', async (t) => {
    const server = await respServer({ resetFirst: ['SUBSCRIBE'] });
    t.after(() => server.close());
    const connections = provider(server.url);
    t.after(() => connections.close());
    const client = await connections.shared('subscriber');
    await settlesWithin(client.subscribe('channel'), 3000, 'a SUBSCRIBE whose first send is reset');
    assert.deepEqual(
      server.received.filter((name) => name === 'SUBSCRIBE'),
      ['SUBSCRIBE', 'SUBSCRIBE'],
    );
  });

  it('rejects a command whose reply never comes at the command deadline', async (t) => {
    const server = await respServer({ silentOn: ['GET'] });
    t.after(() => server.close());
    const connections = provider(server.url);
    t.after(() => connections.close());
    const client = await connections.shared('command');
    await assert.rejects(
      settlesWithin(client.get('page'), SHORT.commandMs + SLACK_MS, 'a GET with no reply'),
      /timed out/,
    );
  });
});

describe('valkey connections lifecycle', () => {
  /** A client that connects at once; records what the provider does with it. */
  function recordingClient(): {
    instances: RecordingClient[];
    RedisClient: new (url: string, options: object) => RecordingClient;
  } {
    const instances: RecordingClient[] = [];
    class Tracked extends RecordingClient {
      constructor(url: string, options: object) {
        super(url, options);
        instances.push(this);
      }
    }
    return { instances, RedisClient: Tracked };
  }

  class RecordingClient {
    readonly options: Record<string, unknown>;
    readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    connectError: Error | undefined;
    disconnects = 0;

    constructor(_url: string, options: object) {
      this.options = { ...options };
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }

    connect(): Promise<void> {
      if (this.connectError !== undefined) return Promise.reject(this.connectError);
      this.emit('ready');
      return Promise.resolve();
    }

    disconnect(): void {
      this.disconnects += 1;
      this.emit('end');
    }
  }

  it('shares one client per shared role and names every client', async () => {
    const fake = recordingClient();
    const connections = provider('redis://127.0.0.1:6379', {
      dependencies: { RedisClient: fake.RedisClient },
    });
    const [first, second] = await Promise.all([
      connections.shared('command'),
      connections.shared('command'),
    ]);
    assert.equal(first, second);
    await connections.shared('subscriber');
    await connections.dedicated('queue', 'worker-emails');
    await connections.dedicated('queue', 'worker-emails');
    assert.deepEqual(
      fake.instances.map((client) => client.options.connectionName),
      ['test:command', 'test:subscriber', 'test:queue:worker-emails', 'test:queue:worker-emails'],
    );
    await connections.close();
  });

  it('replaces a shared client that someone ended', async () => {
    const fake = recordingClient();
    const connections = provider('redis://127.0.0.1:6379', {
      dependencies: { RedisClient: fake.RedisClient },
    });
    const first = await connections.shared('command');
    first.disconnect();
    const second = await connections.shared('command');
    assert.notEqual(first, second);
    await connections.close();
  });

  it('refuses a dedicated role it does not serve and a bad dedicated name', async () => {
    const connections = provider('redis://127.0.0.1:6379', {
      dependencies: { RedisClient: recordingClient().RedisClient },
    });
    await assert.rejects(
      connections.dedicated('command' as 'queue', 'x'),
      (error: unknown) => error instanceof ValkeyError && error.code === 'invalid_options',
    );
    await assert.rejects(
      connections.dedicated('queue', 'bad name'),
      (error: unknown) => error instanceof ValkeyError && error.code === 'invalid_options',
    );
    await connections.close();
  });

  it('disconnects every client on close, once, and refuses later calls', async () => {
    const fake = recordingClient();
    const connections = provider('redis://127.0.0.1:6379', {
      dependencies: { RedisClient: fake.RedisClient },
    });
    await connections.shared('command');
    await connections.dedicated('blocking', 'tail');
    await Promise.all([connections.close(), connections.close()]);
    assert.deepEqual(
      fake.instances.map((client) => client.disconnects),
      [1, 1],
    );
    for (const call of [
      () => connections.shared('command'),
      () => connections.dedicated('queue', 'late'),
    ]) {
      await assert.rejects(
        call(),
        (error: unknown) => error instanceof ValkeyError && error.code === 'closed',
      );
    }
  });

  it('does not leave behind a client whose connect raced the close', async () => {
    let release: (() => void) | undefined;
    const instances: RecordingClient[] = [];
    class SlowClient extends RecordingClient {
      constructor(url: string, options: object) {
        super(url, options);
        instances.push(this);
      }

      override connect(): Promise<void> {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
    }
    const connections = provider('redis://127.0.0.1:6379', {
      dependencies: { RedisClient: SlowClient },
    });
    const pending = connections.shared('command');
    await new Promise<void>((resolve) => setImmediate(resolve));
    await connections.close();
    release?.();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof ValkeyError && error.code === 'closed',
    );
    assert.ok((instances[0]?.disconnects ?? 0) >= 1);
  });

  it('rejects closed when the close cuts a connect short', async () => {
    let fail: ((error: Error) => void) | undefined;
    class CutClient extends RecordingClient {
      override connect(): Promise<void> {
        return new Promise((_resolve, reject) => {
          fail = reject;
        });
      }
    }
    const connections = provider('redis://127.0.0.1:6379', {
      dependencies: { RedisClient: CutClient },
    });
    const pending = connections.shared('command');
    await new Promise<void>((resolve) => setImmediate(resolve));
    await connections.close();
    fail?.(new Error('Connection is closed.'));
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof ValkeyError && error.code === 'closed',
    );
  });

  it('sanitizes a connect failure and never echoes the URL', async () => {
    class FailingClient extends RecordingClient {
      override connect(): Promise<void> {
        const error = new Error('connect ECONNREFUSED redis://:topsecret@host:6379');
        (error as NodeJS.ErrnoException).code = 'ECONNREFUSED';
        return Promise.reject(error);
      }
    }
    const connections = createValkeyConnections('redis://:topsecret@host:6379', {
      appPrefix: 'test-app:test',
      name: 'test',
      dependencies: { RedisClient: FailingClient },
    });
    await assert.rejects(connections.shared('command'), (error: unknown) => {
      assert.ok(error instanceof ValkeyError);
      assert.equal(error.code, 'unavailable');
      assert.match(error.message, /ECONNREFUSED/);
      assert.doesNotMatch(error.message, /topsecret/);
      return true;
    });
    await connections.close();
  });

  it('reports post-connect failures once per outage, sanitized', async () => {
    const fake = recordingClient();
    const observed: Error[] = [];
    const connections = provider('redis://:topsecret@127.0.0.1:6379', {
      dependencies: { RedisClient: fake.RedisClient },
      onError: (error) => observed.push(error),
    });
    await connections.shared('command');
    const client = fake.instances[0]!;
    const failure = new Error('read ECONNRESET redis://:topsecret@127.0.0.1');
    (failure as NodeJS.ErrnoException).code = 'ECONNRESET';
    client.emit('error', failure);
    client.emit('error', failure);
    assert.equal(observed.length, 1, 'reconnect attempts of one outage report once');
    assert.ok(observed[0] instanceof ValkeyError);
    assert.doesNotMatch(observed[0].message, /topsecret/);
    client.emit('ready');
    client.emit('error', failure);
    assert.equal(observed.length, 2, 'the next outage reports again');
    await connections.close();
  });

  it('keeps errors before the first ready out of onError', async () => {
    const observed: Error[] = [];
    class NoisyClient extends RecordingClient {
      override connect(): Promise<void> {
        this.emit('error', new Error('handshake noise'));
        return Promise.reject(new Error('connect failed'));
      }
    }
    const connections = provider('redis://127.0.0.1:6379', {
      dependencies: { RedisClient: NoisyClient },
      onError: (error) => observed.push(error),
    });
    await assert.rejects(connections.shared('command'));
    assert.deepEqual(observed, []);
    await connections.close();
  });
});

describe('valkey scripts', () => {
  it('runs EVALSHA and falls back to EVAL when the server lacks the script', async () => {
    const sent: { name: string; args: unknown[] }[] = [];
    class ScriptClient {
      on(): this {
        return this;
      }

      connect(): Promise<void> {
        return Promise.resolve();
      }

      disconnect(): void {}

      sendCommand(command: { name: string; args: unknown[] }): Promise<unknown> {
        sent.push({ name: command.name, args: command.args });
        if (command.name === 'evalsha') {
          return Promise.reject(new Error('NOSCRIPT No matching script.'));
        }
        return Promise.resolve(7);
      }
    }
    const connections = provider('redis://127.0.0.1:6379', {
      dependencies: { RedisClient: ScriptClient },
    });
    const script = connections.script({ lua: "return redis.call('INCR', KEYS[1])" });
    assert.equal(await script.run(['counter'], ['60000']), 7);
    assert.deepEqual(
      sent.map((command) => command.name),
      ['evalsha', 'eval'],
    );
    assert.match(String(sent[0]?.args[0]), /^[0-9a-f]{40}$/);
    assert.deepEqual(sent[1]?.args, [
      "return redis.call('INCR', KEYS[1])",
      '1',
      'counter',
      '60000',
    ]);
    await connections.close();
  });

  it('rejects a script failure value-free, with the reply text left out', async () => {
    const secret = 'session:4f1c secret-token';
    const failures: [Error, string][] = [
      [
        Object.assign(new Error(`ERR user_script:1: bad value ${secret}`), { name: 'ReplyError' }),
        'script_failed',
      ],
      [new Error('Command timed out'), 'unavailable'],
      [new Error(`Connection is closed. ${secret}`), 'unavailable'],
    ];
    for (const [failure, code] of failures) {
      class FailingClient {
        on(): this {
          return this;
        }

        connect(): Promise<void> {
          return Promise.resolve();
        }

        disconnect(): void {}

        sendCommand(): Promise<unknown> {
          return Promise.reject(failure);
        }
      }
      const connections = provider('redis://127.0.0.1:6379', {
        dependencies: { RedisClient: FailingClient },
      });
      const error = await connections
        .script({ lua: 'return 1' })
        .run(['key'], [secret])
        .then(
          () => undefined,
          (rejection: unknown) => rejection,
        );
      assert.ok(error instanceof ValkeyError, String(error));
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /secret|session/);
      await connections.close();
    }
  });

  it('refuses a script without a source or with a bad deadline', () => {
    const connections = provider('redis://127.0.0.1:6379');
    assert.throws(() => connections.script({} as { lua: string }), ValkeyError);
    assert.throws(() => connections.script({ lua: 'return 1', timeoutMs: 0 }), ValkeyError);
  });

  it('cuts a script at the command deadline unless it states a longer one', async (t) => {
    const server = await respServer({ silentOn: ['EVALSHA'] });
    t.after(() => server.close());
    const connections = provider(server.url);
    t.after(() => connections.close());

    let started = Date.now();
    await rejectsWithin(
      connections.script({ lua: 'return 1' }).run([], []),
      SHORT.commandMs + SLACK_MS,
      'unavailable',
      'a script with the default deadline',
    );
    assert.ok(Date.now() - started < 900, 'the default deadline applied');

    started = Date.now();
    await rejectsWithin(
      connections.script({ lua: 'return 2', timeoutMs: 1000 }).run([], []),
      1000 + SLACK_MS,
      'unavailable',
      'a script with its own deadline',
    );
    assert.ok(Date.now() - started >= 950, 'the script ran past the default deadline');
  });
});
