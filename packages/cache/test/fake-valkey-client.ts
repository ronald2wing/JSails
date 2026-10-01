/**
 * A fake Valkey for the store tests: an in-process keyspace with `PX`
 * expiries on an injectable clock, the binary reads and writes the cache store
 * sends (`getBuffer`, `mgetBuffer`, `SET … PX … [NX]`, `DEL`), `CONFIG GET`,
 * `PUBLISH`/`SUBSCRIBE` delivered as `message` events on a later turn, and
 * the package's Lua scripts, each recognised by its `-- jsails:<name>`
 * marker line and run against the same keyspace. The stores take their client
 * from the app's connection provider, so {@link fakeValkey} builds a real
 * provider over this client; the provider's `EVALSHA` → `NOSCRIPT` → `EVAL`
 * path therefore runs too.
 */

import { EventEmitter } from 'node:events';

import { createValkeyConnections, type ValkeyConnections } from 'jsails/plugin-sdk';

/** The slice of an ioredis `Command` the provider's script runner sends. */
interface SentCommand {
  readonly name: string;
  readonly args: readonly unknown[];
}

interface Stored {
  value: Buffer;
  expiresAt: number;
}

/** The keyspace a {@link FakeValkeyClient} serves; clients built on one share it. */
export class FakeValkeyServer {
  readonly #entries = new Map<string, Stored>();
  /** Every key a command touched, in order. */
  readonly keys: string[] = [];
  /** Every command, by name, in order. */
  readonly commands: string[] = [];
  /** The reply of `CONFIG GET maxmemory-policy`; `undefined` makes it fail. */
  maxmemoryPolicy: string | undefined = 'noeviction';
  /** When set, every data command throws this error. */
  failWith: Error | undefined;
  /** When set, `SUBSCRIBE` never answers, as a server that went silent. */
  silentSubscribe = false;
  readonly #now: () => number;
  readonly #subscribers = new Map<string, Set<FakeValkeyClient>>();

  /** Deliver `message` to every client subscribed to `channel`, on a later turn. */
  publish(channel: string, message: string): number {
    const clients = [...(this.#subscribers.get(channel) ?? [])];
    setImmediate(() => {
      for (const client of clients) client.emit('message', channel, message);
    });
    return clients.length;
  }

  subscribe(channel: string, client: FakeValkeyClient): void {
    let clients = this.#subscribers.get(channel);
    if (clients === undefined) {
      clients = new Set();
      this.#subscribers.set(channel, clients);
    }
    clients.add(client);
  }

  /** How many clients are subscribed to `channel`. */
  subscriberCount(channel: string): number {
    return this.#subscribers.get(channel)?.size ?? 0;
  }

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  /** Store a raw value, as another writer of the keyspace would. */
  put(key: string, value: Buffer, ttlMs = 60_000): void {
    this.#entries.set(key, { value, expiresAt: this.#now() + ttlMs });
  }

  /** The live raw value under `key`. */
  read(key: string): Buffer | undefined {
    return this.#live(key)?.value;
  }

  /** The live keys, sorted. */
  liveKeys(): string[] {
    return [...this.#entries.keys()].filter((key) => this.#live(key) !== undefined).sort();
  }

  /** Milliseconds `key` has left, or `undefined` when it is absent. */
  ttlOf(key: string): number | undefined {
    const entry = this.#live(key);
    return entry === undefined ? undefined : entry.expiresAt - this.#now();
  }

  enter(command: string, keys: readonly string[]): void {
    this.commands.push(command);
    this.keys.push(...keys);
    if (this.failWith !== undefined) throw this.failWith;
  }

  #live(key: string): Stored | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (this.#now() >= entry.expiresAt) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }

  get(key: string): Buffer | null {
    return this.#live(key)?.value ?? null;
  }

  set(key: string, value: Buffer, ttlMs: number, onlyIfAbsent: boolean): boolean {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error('ERR invalid expire time in set');
    }
    if (onlyIfAbsent && this.#live(key) !== undefined) return false;
    this.#entries.set(key, { value, expiresAt: this.#now() + ttlMs });
    return true;
  }

  del(key: string): number {
    return this.#live(key) !== undefined && this.#entries.delete(key) ? 1 : 0;
  }

  /** Run one of the package's scripts by its marker. */
  script(lua: string, keys: readonly string[], args: readonly string[]): unknown {
    const marker = /^-- jsails:([a-z-]+)/.exec(lua)?.[1];
    const [key = '', second = ''] = keys;
    switch (marker) {
      case 'lease-acquire': {
        if (this.#live(key) !== undefined) return null;
        const fence = this.#incr(second);
        this.set(key, Buffer.from(`${args[0] ?? ''}:${String(fence)}`), Number(args[1]), false);
        return fence;
      }
      case 'lease-renew': {
        const entry = this.#live(key);
        if (entry === undefined || entry.value.toString() !== args[0]) return 0;
        entry.expiresAt = this.#now() + Number(args[1]);
        return 1;
      }
      case 'lease-release': {
        if (this.#live(key)?.value.toString() !== args[0]) return 0;
        return this.del(key);
      }
      case 'window-increment': {
        const count = this.#incr(key);
        if (count === 1) {
          const entry = this.#entries.get(key);
          if (entry !== undefined) entry.expiresAt = this.#now() + Number(args[0]);
        }
        return count;
      }
      default:
        throw Object.assign(new Error('ERR unknown script'), { name: 'ReplyError' });
    }
  }

  /** `INCR`: a counter without an expiry, created at 1. */
  #incr(key: string): number {
    const entry = this.#live(key);
    const next = entry === undefined ? 1 : Number(entry.value.toString()) + 1;
    this.#entries.set(key, {
      value: Buffer.from(String(next)),
      expiresAt: entry?.expiresAt ?? Number.POSITIVE_INFINITY,
    });
    return next;
  }
}

/** A fake ioredis client over a {@link FakeValkeyServer}. */
export class FakeValkeyClient extends EventEmitter {
  readonly server: FakeValkeyServer;
  connected = 0;
  disconnected = 0;

  constructor(server: FakeValkeyServer) {
    super();
    this.server = server;
  }

  async publish(channel: string, message: string): Promise<number> {
    this.server.enter('publish', []);
    return this.server.publish(channel, message);
  }

  async subscribe(channel: string): Promise<number> {
    this.server.commands.push('subscribe');
    if (this.server.silentSubscribe) return new Promise<number>(() => undefined);
    this.server.subscribe(channel, this);
    return 1;
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    this.server.enter('get', [key]);
    return this.server.get(key);
  }

  async mgetBuffer(keys: string[]): Promise<(Buffer | null)[]> {
    this.server.enter('mget', keys);
    return keys.map((key) => this.server.get(key));
  }

  async set(
    key: string,
    value: Buffer | string,
    mode: 'PX',
    ttlMs: number,
    condition?: 'NX',
  ): Promise<'OK' | null> {
    this.server.enter('set', [key]);
    if (mode !== 'PX') throw new Error('ERR syntax error');
    const stored = this.server.set(
      key,
      typeof value === 'string' ? Buffer.from(value) : value,
      ttlMs,
      condition === 'NX',
    );
    return stored ? 'OK' : null;
  }

  async del(key: string): Promise<number> {
    this.server.enter('del', [key]);
    return this.server.del(key);
  }

  async config(operation: 'GET', name: string): Promise<string[]> {
    this.server.commands.push('config');
    const policy = this.server.maxmemoryPolicy;
    if (operation !== 'GET' || name !== 'maxmemory-policy' || policy === undefined) {
      throw new Error('ERR unknown command CONFIG');
    }
    return [name, policy];
  }

  /**
   * The provider sends scripts as `EVALSHA`, then `EVAL` once the server
   * answers `NOSCRIPT`. This server caches no script, so every script reaches
   * `EVAL` with its source.
   */
  async sendCommand(command: SentCommand): Promise<unknown> {
    if (command.name === 'evalsha') {
      throw new Error('NOSCRIPT No matching script. Please use EVAL.');
    }
    const [lua, numKeys, ...rest] = command.args.map((arg) => String(arg));
    const count = Number(numKeys);
    const keys = rest.slice(0, count);
    this.server.enter('eval', keys);
    return this.server.script(String(lua), keys, rest.slice(count));
  }

  async connect(): Promise<unknown> {
    this.connected += 1;
    return undefined;
  }

  disconnect(): void {
    this.disconnected += 1;
  }
}

/** The URL every fake provider is built on; it embeds a credential on purpose. */
export const FAKE_VALKEY_URL = 'redis://user:secret@host:6379/0';

/** A real provider over a {@link FakeValkeyClient}, its server, and every client it built. */
export function fakeValkey(
  options: {
    server?: FakeValkeyServer;
    client?: new (server: FakeValkeyServer) => FakeValkeyClient;
  } = {},
): {
  connections: ValkeyConnections;
  server: FakeValkeyServer;
  instances: FakeValkeyClient[];
} {
  const server = options.server ?? new FakeValkeyServer();
  const Client = options.client ?? FakeValkeyClient;
  const instances: FakeValkeyClient[] = [];
  class TrackingClient extends Client {
    constructor(_url: string, _options: object) {
      super(server);
      instances.push(this);
    }
  }
  const connections = createValkeyConnections(FAKE_VALKEY_URL, {
    appPrefix: 'app:test',
    name: 'test',
    dependencies: { RedisClient: TrackingClient },
  });
  return { connections, server, instances };
}
