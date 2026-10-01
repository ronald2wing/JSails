/**
 * A sample key-value store with expiry, the kind of store the contract
 * harness is for: `set` upserts in one statement (the dialect's native
 * upsert, so concurrent writers never race between a read and a write),
 * `claim` inserts a key that must not exist and tries it in a nested
 * transaction (so its conflict does not poison a caller's transaction),
 * reads compare the expiry with the clock it was given, and `sweep` deletes
 * by condition. `brokenStores` are variants that each break one declared
 * semantic, for the harness's own tests.
 */

import { isDatabaseError } from '../../../src/engine/index.js';
import { column, defineModel, type ModelTarget } from '../../../src/model/index.js';
import { ApplicationRecord, type JsailsDataSource } from '../../../src/record/index.js';
import type { StoreContractCases, TestClock } from '../../../src/testing/index.js';
import { transaction } from '../../../src/transaction/index.js';
import { unguarded } from '../../../src/unguarded/index.js';

export class Entry extends ApplicationRecord {
  declare id: number;
  declare name: string;
  declare value: string;
  declare expiresAtMs: bigint | null;
}

defineModel(Entry, {
  table: 'ts_entries',
  columns: {
    name: column.string(64),
    value: column.string(200),
    expiresAtMs: column.bigint({ nullable: true }),
  },
  indexes: [{ columns: ['name'], unique: true }],
});

/** The same columns with no unique key, for a store that cannot keep one row per key. */
export class LooseEntry extends ApplicationRecord {
  declare id: number;
  declare name: string;
  declare value: string;
  declare expiresAtMs: bigint | null;
}

defineModel(LooseEntry, {
  table: 'ts_loose_entries',
  columns: {
    name: column.string(64),
    value: column.string(200),
    expiresAtMs: column.bigint({ nullable: true }),
  },
});

export const STORE_MODELS: readonly ModelTarget[] = Object.freeze([Entry, LooseEntry]);

export interface SampleStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string, ttlMs?: number): Promise<void>;
  claim(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  sweep(): Promise<void>;
}

/** Whether `error` is the store's refusal of a claimed key. */
export function isClaimConflict(error: unknown): boolean {
  return isDatabaseError(error, 'unique_violation');
}

function expiresAt(clock: TestClock, ttlMs: number | undefined): bigint | null {
  return ttlMs === undefined ? null : BigInt(clock.now().getTime() + ttlMs);
}

function live(entry: Entry | LooseEntry | null, clock: TestClock): string | undefined {
  if (entry === null) return undefined;
  if (entry.expiresAtMs !== null && entry.expiresAtMs <= BigInt(clock.now().getTime())) {
    return undefined;
  }
  return entry.value;
}

export function createSampleStore(dataSource: JsailsDataSource, clock: TestClock): SampleStore {
  const raw = unguarded(dataSource);
  return {
    get: async (name) => live(await Entry.findBy({ name }), clock),
    async set(name, value, ttlMs) {
      const expires = expiresAt(clock, ttlMs);
      switch (dataSource.dialect) {
        case 'postgres':
          await raw.sql`INSERT INTO ts_entries (name, value, expires_at_ms) VALUES (${name}, ${value}, ${expires})
            ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, expires_at_ms = EXCLUDED.expires_at_ms`;
          return;
        case 'mariadb':
          await raw.sql`INSERT INTO ts_entries (name, value, expires_at_ms) VALUES (${name}, ${value}, ${expires})
            ON DUPLICATE KEY UPDATE value = VALUES(value), expires_at_ms = VALUES(expires_at_ms)`;
          return;
        case 'sqlite':
          await raw.sql`INSERT INTO ts_entries (name, value, expires_at_ms) VALUES (${name}, ${value}, ${expires})
            ON CONFLICT (name) DO UPDATE SET value = excluded.value, expires_at_ms = excluded.expires_at_ms`;
          return;
      }
    },
    async claim(name, value) {
      await transaction(dataSource, () => Entry.insertAll([{ name, value, expiresAtMs: null }]));
    },
    async delete(name) {
      await Entry.where({ name }).deleteAll();
    },
    async sweep() {
      await Entry.where({ expiresAtMs: { lte: BigInt(clock.now().getTime()) } }).deleteAll();
    },
  };
}

/** The sample store's declared semantics. */
export const SAMPLE_CONTRACT: StoreContractCases<SampleStore, string, string> = {
  models: STORE_MODELS,
  table: Entry,
  keys: ['alpha', 'beta'],
  values: ['first value', 'second value'],
  read: (store, key) => store.get(key),
  upsert: (store, key, value) => store.set(key, value),
  unique: { insert: (store, key, value) => store.claim(key, value), isConflict: isClaimConflict },
  concurrency: 4,
  expiry: {
    write: (store, key, value, ttlMs) => store.set(key, value, ttlMs),
    ttlMs: 60_000,
    sweep: (store) => store.sweep(),
  },
  remove: (store, key) => store.delete(key),
};

/** Stores that each break one semantic the sample store keeps. */
export const brokenStores = {
  /** Every write is a new row: a second write leaves two rows. */
  duplicating(_dataSource: JsailsDataSource, clock: TestClock): SampleStore {
    return {
      get: async (name) =>
        live(
          await LooseEntry.where({ name })
            .orderBy({ column: 'id', direction: 'desc' })
            .limit(1)
            .getOne(),
          clock,
        ),
      async set(name, value, ttlMs) {
        await LooseEntry.insertAll([{ name, value, expiresAtMs: expiresAt(clock, ttlMs) }]);
      },
      async claim(name, value) {
        await LooseEntry.insertAll([{ name, value, expiresAtMs: null }]);
      },
      async delete(name) {
        await LooseEntry.where({ name }).deleteAll();
      },
      async sweep() {
        await LooseEntry.where({ expiresAtMs: { lte: BigInt(clock.now().getTime()) } }).deleteAll();
      },
    };
  },
  /** Expiry read from the real clock instead of the one it was given. */
  wallClock(dataSource: JsailsDataSource): SampleStore {
    const real: TestClock = { now: () => new Date(), advance: () => undefined };
    return createSampleStore(dataSource, real);
  },
  /** A claim tried in the caller's frame: its conflict poisons the caller's transaction. */
  unguardedClaim(dataSource: JsailsDataSource, clock: TestClock): SampleStore {
    return {
      ...createSampleStore(dataSource, clock),
      async claim(name, value) {
        await Entry.insertAll([{ name, value, expiresAtMs: null }]);
      },
    };
  },
};
