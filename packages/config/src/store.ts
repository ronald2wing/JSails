/**
 * The {@link ConfigStore} contract and its in-memory implementation.
 *
 * A store holds the active (stored) values of each set as a plain JSON object
 * keyed by set name. It knows nothing about fields or overrides: the config
 * service validates before writing and resolves after reading. `write` takes
 * several sets at once so an import lands all-or-nothing.
 */

import type { JsonValue } from 'jsails/plugin-sdk';

/** One set's stored values. */
export interface ConfigStoreEntry {
  readonly name: string;
  readonly values: Readonly<Record<string, JsonValue>>;
}

/** Where active config values live. */
export interface ConfigStore {
  /** The stored values of one set, or `undefined` when none are stored. */
  read(name: string): Promise<Readonly<Record<string, JsonValue>> | undefined>;
  /** Replace the stored values of every given set, all or nothing. */
  write(entries: readonly ConfigStoreEntry[]): Promise<void>;
  /** Release what the store opened. A CLI command calls it before exiting. */
  close?(): Promise<void>;
}

/** True when `value` implements the {@link ConfigStore} contract. */
export function isConfigStore(value: unknown): value is ConfigStore {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<ConfigStore>;
  return typeof candidate.read === 'function' && typeof candidate.write === 'function';
}

/** A JSON round-trip copy, so a caller can never mutate stored state. */
export function cloneValues(
  values: Readonly<Record<string, JsonValue>>,
): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(values)) as Record<string, JsonValue>;
}

/**
 * A store that keeps values in memory. Values are lost on restart, so it suits
 * tests and apps whose config comes entirely from sync files and overrides.
 */
export function createMemoryConfigStore(): ConfigStore {
  const sets = new Map<string, Record<string, JsonValue>>();
  return {
    async read(name) {
      const values = sets.get(name);
      return values === undefined ? undefined : cloneValues(values);
    },
    async write(entries) {
      const copies = entries.map((entry) => [entry.name, cloneValues(entry.values)] as const);
      for (const [name, values] of copies) sets.set(name, values);
    },
  };
}
