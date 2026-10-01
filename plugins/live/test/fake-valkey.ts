/**
 * An in-memory stand-in for the slice of Valkey the live layer uses.
 *
 * It implements the three behaviours the change log depends on — the atomic
 * `INCR` + `XADD` script, `XRANGE` over a stream, and `MAXLEN ~` trimming — so
 * the log's contract can be tested without a live server. It is deliberately
 * not a general Redis: only the commands the log and bus issue exist, and an
 * unknown command throws so a test cannot silently pass against a stub that
 * does nothing.
 */

import type { ValkeyBusClient } from '../src/valkey-change-bus.js';
import type { ValkeyLiveClient } from '../src/valkey-change-log.js';

interface StreamEntry {
  readonly id: string;
  readonly fields: readonly string[];
}

/** A shared fake server: one instance backs several clients, as Valkey does. */
export interface FakeValkey {
  readonly counters: Map<string, number>;
  readonly streams: Map<string, StreamEntry[]>;
  /** Number of entries trimmed away, so a test can assert retention ran. */
  readonly trimmed: number;
  /** When set, the next command throws this error. */
  failNext: Error | undefined;
  client(): ValkeyLiveClient;
  busClient(): ValkeyBusClient;
}

export function createFakeValkey(): FakeValkey {
  const counters = new Map<string, number>();
  const streams = new Map<string, StreamEntry[]>();
  /** channel -> message listeners, per subscribed client. */
  const channels = new Map<string, Set<(channel: string, message: string) => void>>();
  /** Listeners registered before any subscribe; attached on subscribe. */
  const pending = new Set<(channel: string, message: string) => void>();
  let trimmed = 0;
  let failNext: Error | undefined;

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

  const live: ValkeyLiveClient = {
    async eval(_script, _numKeys, ...args) {
      takeFailure();
      const [counterKey, streamKey, maxLength, payload] = args as [string, string, number, string];
      return add(counterKey, streamKey, maxLength, payload);
    },
    async xrange(key) {
      takeFailure();
      return (streams.get(key) ?? []).map((entry) => [entry.id, [...entry.fields]]);
    },
    async xlen(key) {
      takeFailure();
      return (streams.get(key) ?? []).length;
    },
    async get(key) {
      takeFailure();
      const value = counters.get(key);
      return value === undefined ? null : String(value);
    },
    async disconnect() {},
    on() {},
  };

  const bus: ValkeyBusClient = {
    async subscribe(channel) {
      takeFailure();
      const listeners = channels.get(channel) ?? new Set();
      for (const listener of pending) {
        listeners.add(listener);
      }
      channels.set(channel, listeners);
    },
    async publish(channel, message) {
      takeFailure();
      for (const listener of channels.get(channel) ?? []) {
        listener(channel, message);
      }
      return 0;
    },
    on(event, listener) {
      if (event !== 'message') {
        return;
      }
      // A subscribed client receives every message on its channels; the bus
      // filters by channel name itself. Listeners registered before a subscribe
      // are attached when the subscribe happens.
      pending.add(listener);
      for (const listeners of channels.values()) {
        listeners.add(listener);
      }
    },
    async disconnect() {},
  };

  return {
    counters,
    streams,
    get trimmed() {
      return trimmed;
    },
    get failNext() {
      return failNext;
    },
    set failNext(error: Error | undefined) {
      failNext = error;
    },
    client: () => live,
    busClient: () => bus,
  };
}
