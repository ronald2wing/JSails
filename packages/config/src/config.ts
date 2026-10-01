/**
 * The config service: the one place values are resolved and written.
 *
 * A set's effective value is its defaults, then the stored (active) values,
 * then the code overrides. That is the Drupal model: the admin and the sync
 * files edit the active values, while an override in `jsails.app.js` wins at
 * runtime whatever is stored, and the admin shows that field as set in code.
 *
 * Overrides are checked when the service is created, so a typo or an invalid
 * forced value fails at startup. Writing a key that is overridden is refused,
 * because the write could never take effect.
 *
 * Resolved active values are cached per set for `cacheTtlMs` (5 s by default),
 * because a set read in a layout or middleware would otherwise cost a store
 * round trip and a full re-validation on every call. A `set` or `replace`
 * through this service invalidates the cache at once; a write made by another
 * process (another app instance, a `config:import` run) is seen once the TTL
 * lapses. `set` calls on one set are serialized in-process, so two saves of
 * different keys do not lose each other's update.
 */

import type { JsonValue } from 'jsails/plugin-sdk';

import { ConfigError } from './config-error.js';
import {
  checkValues,
  defaultValues,
  resolveStored,
  type ConfigFields,
  type ConfigSet,
  type ConfigValues,
} from './config-set.js';
import type { ConfigStore, ConfigStoreEntry } from './store.js';

/** Forced values by set name, then by key. */
export type ConfigOverrides = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** Options for {@link createConfig}. */
export interface ConfigOptions {
  readonly store: ConfigStore;
  /** Every set the app uses. A set name may appear once. */
  readonly sets: readonly ConfigSet[];
  /** Values forced from code; they win over stored values. */
  readonly overrides?: ConfigOverrides;
  /**
   * How long resolved values stay cached, in milliseconds. Bounds how stale a
   * write from another process can look. Defaults to 5000; `0` disables it.
   */
  readonly cacheTtlMs?: number;
  /** Injectable clock for the cache, in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Default lifetime of a cached set read. */
const DEFAULT_CACHE_TTL_MS = 5_000;

/** One cached set read: the resolved values, shared by concurrent readers. */
interface CachedRead {
  readonly values: Promise<Readonly<Record<string, unknown>>>;
  readonly expiresAt: number;
}

/** The config service. */
export interface Config {
  /** The declared sets, in declaration order. */
  readonly sets: readonly ConfigSet[];
  /** The store behind the service. */
  readonly store: ConfigStore;
  /** The effective values: defaults, then stored, then overrides. */
  get<F extends ConfigFields>(set: ConfigSet<F>): Promise<ConfigValues<F>>;
  /** The active values without overrides: what the admin edits and export writes. */
  active<F extends ConfigFields>(set: ConfigSet<F>): Promise<ConfigValues<F>>;
  /** Write some keys of a set. Refuses unknown, invalid, or overridden keys. */
  set<F extends ConfigFields>(set: ConfigSet<F>, values: Partial<ConfigValues<F>>): Promise<void>;
  /** The keys of a set that code overrides. */
  overridden(set: ConfigSet): readonly string[];
  /** The declared set with this name, or `undefined`. */
  find(name: string): ConfigSet | undefined;
  /**
   * Replace the active values of several sets at once, all or nothing. Each
   * entry is checked in full; overridden keys are stored like any other, and
   * the override keeps winning at runtime.
   */
  replace(entries: readonly ConfigStoreEntry[]): Promise<void>;
}

/** Create the config service. Fails at startup on a duplicate set or a bad override. */
export function createConfig(options: ConfigOptions): Config {
  if (options === null || typeof options !== 'object') {
    throw new ConfigError('invalid_options', 'createConfig requires an options object');
  }
  const { store } = options;
  if (store === null || typeof store !== 'object' || typeof store.read !== 'function') {
    throw new ConfigError('invalid_options', 'createConfig requires a config store');
  }
  if (!Array.isArray(options.sets)) {
    throw new ConfigError('invalid_options', 'createConfig requires a list of sets');
  }
  const byName = new Map<string, ConfigSet>();
  for (const set of options.sets) {
    if (set === null || typeof set !== 'object' || typeof set.name !== 'string') {
      throw new ConfigError('invalid_set', 'sets must come from defineConfig');
    }
    if (byName.has(set.name)) {
      throw new ConfigError('duplicate_set', 'a config set name may appear once', set.name);
    }
    byName.set(set.name, set);
  }
  const overrides = checkOverrides(byName, options.overrides ?? {});
  const sets = Object.freeze([...options.sets]);
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  if (typeof cacheTtlMs !== 'number' || !Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) {
    throw new ConfigError('invalid_options', 'cacheTtlMs must be a non-negative number');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new ConfigError('invalid_options', 'now must be a function');
  }
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, CachedRead>();
  // Bumped on every invalidation, so a read that started before a write cannot
  // repopulate the cache with the values the write replaced.
  const generations = new Map<string, number>();
  const writeChains = new Map<string, Promise<void>>();

  function invalidate(name: string): void {
    cache.delete(name);
    generations.set(name, (generations.get(name) ?? 0) + 1);
  }

  async function readResolved(set: ConfigSet): Promise<Readonly<Record<string, unknown>>> {
    if (cacheTtlMs === 0) {
      return resolveStored(set, await store.read(set.name));
    }
    const cached = cache.get(set.name);
    if (cached !== undefined && now() < cached.expiresAt) {
      return cached.values;
    }
    const generation = generations.get(set.name) ?? 0;
    const values = store.read(set.name).then((stored) => resolveStored(set, stored));
    const entry: CachedRead = { values, expiresAt: now() + cacheTtlMs };
    cache.set(set.name, entry);
    try {
      return await values;
    } catch (error) {
      if (cache.get(set.name) === entry) cache.delete(set.name);
      throw error;
    } finally {
      if ((generations.get(set.name) ?? 0) !== generation && cache.get(set.name) === entry) {
        cache.delete(set.name);
      }
    }
  }

  /** Run `write` after every earlier write to the same set has settled. */
  async function serialized(name: string, write: () => Promise<void>): Promise<void> {
    const previous = writeChains.get(name) ?? Promise.resolve();
    const run = previous.then(write, write);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    writeChains.set(name, settled);
    try {
      await run;
    } finally {
      if (writeChains.get(name) === settled) writeChains.delete(name);
    }
  }

  function declared(set: ConfigSet): ConfigSet {
    if (byName.get(set.name) !== set) {
      throw new ConfigError(
        'unknown_set',
        'the config set is not declared on this service',
        set.name,
      );
    }
    return set;
  }

  async function active<F extends ConfigFields>(set: ConfigSet<F>): Promise<ConfigValues<F>> {
    declared(set);
    // A copy, so a caller mutating its result cannot change the cached values.
    return structuredClone(await readResolved(set)) as ConfigValues<F>;
  }

  return Object.freeze({
    sets,
    store,
    active,

    async get<F extends ConfigFields>(set: ConfigSet<F>): Promise<ConfigValues<F>> {
      const values = await active(set);
      return { ...values, ...overrides.get(set.name) };
    },

    async set<F extends ConfigFields>(
      set: ConfigSet<F>,
      values: Partial<ConfigValues<F>>,
    ): Promise<void> {
      declared(set);
      const checked = checkValues(set, values);
      const forced = overrides.get(set.name);
      for (const key of Object.keys(checked)) {
        if (forced !== undefined && Object.hasOwn(forced, key)) {
          throw new ConfigError(
            'overridden',
            'this key is set in code and cannot be changed',
            set.name,
            key,
          );
        }
      }
      await serialized(set.name, async () => {
        try {
          // Keep only keys the set still declares, so stale keys do not linger.
          const kept: Record<string, JsonValue> = {};
          for (const [key, value] of Object.entries((await store.read(set.name)) ?? {})) {
            if (Object.hasOwn(set.fields, key)) kept[key] = value;
          }
          await store.write([{ name: set.name, values: { ...kept, ...checked } }]);
        } finally {
          invalidate(set.name);
        }
      });
    },

    overridden(set: ConfigSet): readonly string[] {
      declared(set);
      return Object.keys(overrides.get(set.name) ?? {});
    },

    find(name: string): ConfigSet | undefined {
      return byName.get(name);
    },

    async replace(entries: readonly ConfigStoreEntry[]): Promise<void> {
      const checked = entries.map((entry) => {
        const set = byName.get(entry.name);
        if (set === undefined) {
          throw new ConfigError('unknown_set', 'the config set is not declared', entry.name);
        }
        return {
          name: entry.name,
          values: {
            ...(defaultValues(set) as Record<string, JsonValue>),
            ...checkValues(set, entry.values),
          },
        };
      });
      try {
        await store.write(checked);
      } finally {
        for (const entry of checked) invalidate(entry.name);
      }
    },
  });
}

/** Check every override against its set; returns the normalized values by set. */
function checkOverrides(
  byName: ReadonlyMap<string, ConfigSet>,
  overrides: ConfigOverrides,
): ReadonlyMap<string, Readonly<Record<string, JsonValue>>> {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new ConfigError('invalid_options', 'overrides must be an object keyed by set name');
  }
  const checked = new Map<string, Readonly<Record<string, JsonValue>>>();
  for (const [name, values] of Object.entries(overrides)) {
    const set = byName.get(name);
    if (set === undefined) {
      throw new ConfigError('unknown_set', 'an override names a set that is not declared', name);
    }
    checked.set(name, Object.freeze(checkValues(set, values)));
  }
  return checked;
}
