/**
 * An in-memory stand-in for the slice of Valkey the live layer uses.
 *
 * It implements the behaviours the change log and bus depend on — the atomic
 * `INCR` + `XADD` script, `XRANGE` over a stream, `MAXLEN ~` trimming, and
 * pub/sub — so their contracts can be tested without a live server. It is
 * deliberately not a general Redis: only the commands the log and bus issue
 * exist, and an unknown command throws so a test cannot silently pass against
 * a stub that does nothing.
 *
 * The log and bus take their clients from the app's connection provider, so
 * {@link FakeValkey.connections} builds a real provider whose clients all talk
 * to this one fake server, as every instance of a deployment talks to one
 * Valkey.
 */

import { EventEmitter } from 'node:events';

import { definePlugin, type JsailsPlugin } from 'jsails/extensions';
import { createValkeyConnections, valkeyToken, type ValkeyConnections } from 'jsails/plugin-sdk';

import type { ValkeyLiveClient } from '../src/valkey-change-log.js';

interface StreamEntry {
  readonly id: string;
  readonly fields: readonly string[];
}

/** The slice of an ioredis `Command` the provider's script runner sends. */
interface SentCommand {
  readonly name: string;
  readonly args: readonly unknown[];
}

/** The app key prefix every fake provider uses, so the live keys are `jsails:live:*`. */
export const FAKE_APP_PREFIX = 'jsails';

/**
 * A plugin standing in for `valkeyPlugin`: it registers one app instance's
 * provider over the fake under `valkeyToken` and closes it on teardown.
 */
export function fakeValkeyPlugin(fake: FakeValkey): JsailsPlugin {
  return definePlugin({
    name: 'valkey',
    setup({ services }) {
      const connections = fake.connections();
      services.provide(valkeyToken, connections);
      return () => connections.close();
    },
  });
}

/** A shared fake server: one instance backs several clients, as Valkey does. */
export interface FakeValkey {
  readonly counters: Map<string, number>;
  readonly streams: Map<string, StreamEntry[]>;
  /** Number of entries trimmed away, so a test can assert retention ran. */
  readonly trimmed: number;
  /** When set, the next command throws this error. */
  failNext: Error | undefined;
  /** When set, every new connection fails its connect with this error. */
  refuseConnect: Error | undefined;
  /** Every `XRANGE` issued, as `[start, end, count]`, so a test can assert read cost. */
  readonly xranges: (readonly [string, string, number | undefined])[];
  /** A bare client over the fake, for the stream readers. */
  client(): ValkeyLiveClient;
  /** A new provider (one app instance's connections) over the fake. */
  connections(): ValkeyConnections;
  /** Publish on the fake as another process would. */
  publish(channel: string, message: string): void;
}

export function createFakeValkey(): FakeValkey {
  const counters = new Map<string, number>();
  const streams = new Map<string, StreamEntry[]>();
  /** channel -> the clients subscribed to it. */
  const channels = new Map<string, Set<FakeRedis>>();
  let trimmed = 0;
  let failNext: Error | undefined;
  let refuseConnect: Error | undefined;
  const xranges: (readonly [string, string, number | undefined])[] = [];

  function takeFailure(): void {
    const failure = failNext;
    if (failure !== undefined) {
      failNext = undefined;
      throw failure;
    }
  }

  function add(counterKey: string, streamKey: string, maxLength: number, payload: string): number {
    const sequence = (counters.get(counterKey) ?? 0) + 1;
    counters.set(counterKey, sequence);
    const entries = streams.get(streamKey) ?? [];
    entries.push({ id: `${sequence}-0`, fields: ['change', payload] });
    // `MAXLEN ~` trims approximately; the fake trims exactly, which is the
    // stricter behaviour and therefore a valid stand-in.
    while (entries.length > maxLength) {
      entries.shift();
      trimmed += 1;
    }
    streams.set(streamKey, entries);
    return sequence;
  }

  function publish(channel: string, message: string): number {
    const subscribers = channels.get(channel) ?? new Set();
    for (const subscriber of subscribers) {
      subscriber.emit('message', channel, message);
    }
    return subscribers.size;
  }

  const live: ValkeyLiveClient = {
    async xrange(key, start, end, countToken, count) {
      takeFailure();
      const limit = countToken === 'COUNT' ? count : undefined;
      xranges.push([start, end, limit]);
      const lower = rangeBound(start, Number.NEGATIVE_INFINITY);
      const upper = rangeBound(end, Number.POSITIVE_INFINITY);
      const selected = (streams.get(key) ?? []).filter((entry) => {
        const sequence = Number(entry.id.split('-')[0]);
        const aboveLower = lower.exclusive ? sequence > lower.value : sequence >= lower.value;
        const belowUpper = upper.exclusive ? sequence < upper.value : sequence <= upper.value;
        return aboveLower && belowUpper;
      });
      return selected
        .slice(0, limit ?? selected.length)
        .map((entry) => [entry.id, [...entry.fields]]);
    },
    async get(key) {
      takeFailure();
      const value = counters.get(key);
      return value === undefined ? null : String(value);
    },
  };

  /** The ioredis surface the provider, the log, and the bus call. */
  class FakeRedis extends EventEmitter {
    readonly xrange = live.xrange;
    readonly get = live.get;

    constructor(_url: string, _options: object) {
      super();
    }

    async connect(): Promise<void> {
      if (refuseConnect !== undefined) {
        throw refuseConnect;
      }
      this.emit('ready');
    }

    disconnect(): void {
      for (const subscribers of channels.values()) {
        subscribers.delete(this);
      }
      this.emit('end');
    }

    /**
     * The provider sends a script as `EVALSHA`, then `EVAL` once the server
     * answers `NOSCRIPT`; this server has never seen a script, so the append
     * always arrives as `EVAL` with its keys and arguments.
     */
    async sendCommand(command: SentCommand): Promise<unknown> {
      if (command.name === 'evalsha') {
        throw new Error('NOSCRIPT No matching script. Please use EVAL.');
      }
      if (command.name !== 'eval') {
        throw new Error(`the fake Valkey has no ${command.name} command`);
      }
      takeFailure();
      const [, , counterKey, streamKey, maxLength, payload] = command.args.map(String);
      return add(String(counterKey), String(streamKey), Number(maxLength), String(payload));
    }

    async subscribe(channel: string): Promise<number> {
      takeFailure();
      const subscribers = channels.get(channel) ?? new Set();
      subscribers.add(this);
      channels.set(channel, subscribers);
      return 1;
    }

    async unsubscribe(channel: string): Promise<number> {
      channels.get(channel)?.delete(this);
      return 0;
    }

    async publish(channel: string, message: string): Promise<number> {
      takeFailure();
      return publish(channel, message);
    }
  }

  return {
    counters,
    streams,
    xranges,
    get trimmed() {
      return trimmed;
    },
    get failNext() {
      return failNext;
    },
    set failNext(error: Error | undefined) {
      failNext = error;
    },
    get refuseConnect() {
      return refuseConnect;
    },
    set refuseConnect(error: Error | undefined) {
      refuseConnect = error;
    },
    client: () => live,
    connections: () =>
      createValkeyConnections('redis://user:secret@valkey.internal:6379/0', {
        appPrefix: FAKE_APP_PREFIX,
        name: 'live-test',
        dependencies: { RedisClient: FakeRedis },
      }),
    publish(channel, message) {
      publish(channel, message);
    },
  };
}

/**
 * Parse an `XRANGE` bound: `-`/`+`, `<n>-<m>`, or `(<n>-<m>` (exclusive). Ids
 * in the fake always end in `-0`, so the sequence alone orders them.
 */
function rangeBound(bound: string, open: number): { value: number; exclusive: boolean } {
  if (bound === '-' || bound === '+') {
    return { value: open, exclusive: false };
  }
  const exclusive = bound.startsWith('(');
  const id = exclusive ? bound.slice(1) : bound;
  return { value: Number(id.split('-')[0]), exclusive };
}
