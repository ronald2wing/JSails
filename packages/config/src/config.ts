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
 * Resolved active values are read through a defined cache (`cache` option,
 * see {@link CONFIG_CACHE}), because a set read in a layout or middleware
 * would otherwise cost a store round trip and a full re-validation on every
 * call. Each set is tagged `config:<set>`, and a `set` or `replace`
 * through this service invalidates the sets it wrote once the store write
 * succeeded, in every process of the app. Without a cache every read goes to
 * the store. `set` calls on one set are serialized in-process, so two saves of
 * different keys do not lose each other's update.
 */

import type { Cache, CacheDefinition } from 'jsails/cache';
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
import type { ConfigField } from './fields.js';
import type { ConfigStore, ConfigStoreEntry } from './store.js';

/** Forced values by set name, then by key. */
export type ConfigOverrides = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * A set's resolved active values, as the read cache holds them.
 *
 * @public
 */
export type ResolvedConfigValues = Readonly<Record<string, unknown>>;

/**
 * The read cache of a config service: `defineCache(services, CONFIG_CACHE)`,
 * which is what `configPlugin` binds.
 *
 * @public
 */
export type ConfigCache = Cache<ResolvedConfigValues>;

/**
 * The definition of the config read cache: in-process (the values are small
 * and read on hot paths), keyed by set name, tagged per set. The 60 s TTL
 * only bounds how long a write that bypassed the service (a `config:import`
 * from the CLI, which runs without the app's services) takes to show.
 *
 * @public
 */
export const CONFIG_CACHE: CacheDefinition<ResolvedConfigValues> = Object.freeze({
  name: 'jsails.config',
  ttlMs: 60_000,
  tier: 'process',
  tags: (set: string): readonly string[] => [configTag(set)],
});

/**
 * The cache tag of one config set; every write through the service
 * invalidates the tags of the sets it wrote.
 *
 * @public
 */
export function configTag(set: string): string {
  return `config:${set}`;
}

/** Options for {@link createConfig}. */
export interface ConfigOptions {
  readonly store: ConfigStore;
  /** Every set the app uses. A set name may appear once. */
  readonly sets: readonly ConfigSet[];
  /** Values forced from code; they win over stored values. */
  readonly overrides?: ConfigOverrides;
  /** The read cache, defined from {@link CONFIG_CACHE}. Without one every read goes to the store. */
  readonly cache?: ConfigCache;
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

/** The declarative data of a field: everything but its functions. */
function fieldData(field: ConfigField): string {
  const { kind, label, required, multiline, max, min, options } = field;
  return JSON.stringify([kind, label, field.default, required, multiline, max, min, options]);
}

/**
 * Whether two sets declare the same thing. The `config` plugin's options are
 * parsed, so the service holds a copy of each set the app declared; a caller
 * still passes its own `defineConfig` value, which matches its copy field by
 * field.
 */
function sameDeclaration(known: ConfigSet, given: ConfigSet): boolean {
  if (known === given) return true;
  if (known.name !== given.name || known.label !== given.label) return false;
  const keys = Object.keys(known.fields);
  const givenKeys = Object.keys(given.fields);
  return (
    keys.length === givenKeys.length &&
    keys.every((key, index) => {
      const field = known.fields[key];
      const other = given.fields[key];
      return (
        givenKeys[index] === key &&
        field !== undefined &&
        other !== undefined &&
        fieldData(field) === fieldData(other)
      );
    })
  );
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
  const { cache } = options;
  if (
    cache !== undefined &&
    (cache === null || typeof cache !== 'object' || typeof cache.get !== 'function')
  ) {
    throw new ConfigError('invalid_options', 'cache must be a defined cache');
  }
  const writeChains = new Map<string, Promise<void>>();

  async function readStored(set: ConfigSet): Promise<ResolvedConfigValues> {
    return resolveStored(set, await store.read(set.name));
  }

  function readResolved(set: ConfigSet): Promise<ResolvedConfigValues> {
    return cache === undefined ? readStored(set) : cache.get(set.name, () => readStored(set));
  }

  /** Run a store write, then invalidate the cached reads of the sets it wrote. */
  async function written(names: readonly string[], write: () => Promise<void>): Promise<void> {
    const tags = names.map(configTag);
    try {
      await write();
    } catch (error) {
      // A write that failed may still have committed (a lost reply), so the
      // reads are dropped either way; the write's own error is the one to see.
      await cache?.invalidate(...tags).catch(() => undefined);
      throw error;
    }
    await cache?.invalidate(...tags);
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
    const known = byName.get(set.name);
    if (known === undefined || !sameDeclaration(known, set)) {
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
        // Keep only keys the set still declares, so stale keys do not linger.
        const kept: Record<string, JsonValue> = {};
        for (const [key, value] of Object.entries((await store.read(set.name)) ?? {})) {
          if (Object.hasOwn(set.fields, key)) kept[key] = value;
        }
        await written([set.name], () =>
          store.write([{ name: set.name, values: { ...kept, ...checked } }]),
        );
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
      await written(
        checked.map((entry) => entry.name),
        () => store.write(checked),
      );
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
