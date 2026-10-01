/**
 * `publisher()`: a trusted publisher as config data, checked once when the
 * config loads.
 *
 * A publisher has an id (the `publisher` its manifests and statements name),
 * the plugin ids it may release (`ids`: exact ids, or `<prefix>-*` for every
 * id that starts with `<prefix>-`; the dash keeps `acme-*` from claiming
 * `acmecorp-notes`, and a bare `*` is refused), its keys, and its permission
 * ceiling. Each key has an id unique within the publisher, an Ed25519 public
 * key (standard base64 of the 32 raw bytes, distinct within the publisher) and
 * what it may sign: `root` keys sign delegations of further keys, `release`
 * keys sign release statements, `catalog` keys sign catalogs. Only values
 * returned by `publisher()` are accepted by `createTrust`, so a declaration is
 * never used unchecked.
 */

import type { KeyObject } from 'node:crypto';

import { PLUGIN_ID_PATTERN } from 'jsails/internal/plugin-manifest';

import { compileCeiling, type CompiledCeiling } from './ceiling.js';
import { MarketplaceConfigErrors } from './config-errors.js';
import {
  hasExactKeys,
  isRecord,
  KEY_ID_PATTERN,
  matches,
  PUBLISHER_ID_PATTERN,
} from './field-checks.js';
import { decodePublicKey } from './signature.js';

/**
 * What a key may sign.
 *
 * @public
 */
export type KeyUse = 'root' | 'release' | 'catalog';

/**
 * One publisher key.
 *
 * @public
 */
export interface PublisherKey {
  readonly id: string;
  /** Standard padded base64 of the raw 32-byte Ed25519 public key. */
  readonly publicKey: string;
  readonly use: readonly KeyUse[];
}

/**
 * A publisher declaration.
 *
 * @public
 */
export interface PublisherInput {
  readonly id: string;
  /** Exact plugin ids, or `<prefix>-*` patterns. */
  readonly ids: readonly string[];
  readonly keys: readonly PublisherKey[];
  /** Registered permissions, or `id:*` for every scope of a scoped one. */
  readonly ceiling: readonly string[];
}

/**
 * A checked, frozen publisher, as `publisher()` returns it.
 *
 * @public
 */
export interface Publisher extends PublisherInput {
  readonly ids: readonly string[];
  readonly keys: readonly PublisherKey[];
  readonly ceiling: readonly string[];
}

/** What the trust set reads from a publisher. */
export interface CompiledPublisher {
  readonly id: string;
  readonly ceiling: CompiledCeiling;
  readonly keys: ReadonlyMap<string, { readonly key: PublisherKey; readonly object: KeyObject }>;
  readonly exactIds: ReadonlySet<string>;
  readonly prefixes: readonly string[];
}

const KEY_USES: readonly KeyUse[] = ['root', 'release', 'catalog'];
const MAX_IDS = 100;
const MAX_KEYS = 32;

const compiled = new WeakMap<Publisher, CompiledPublisher>();

type Field = 'shape' | 'id' | 'ids' | 'keys' | 'key_id' | 'public_key' | 'use' | 'ceiling';

function invalid(field: Field): Error {
  return new MarketplaceConfigErrors.Error('invalid_publisher', { field });
}

function compileIds(value: unknown): { exactIds: Set<string>; prefixes: string[] } {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_IDS) throw invalid('ids');
  const exactIds = new Set<string>();
  const prefixes: string[] = [];
  for (const entry of value as readonly unknown[]) {
    if (typeof entry !== 'string') throw invalid('ids');
    if (entry.endsWith('-*')) {
      const prefix = entry.slice(0, -1);
      if (!PLUGIN_ID_PATTERN.test(prefix.slice(0, -1)) || prefixes.includes(prefix)) {
        throw invalid('ids');
      }
      prefixes.push(prefix);
    } else {
      if (!PLUGIN_ID_PATTERN.test(entry) || exactIds.has(entry)) throw invalid('ids');
      exactIds.add(entry);
    }
  }
  return { exactIds, prefixes };
}

function compileKey(value: unknown): { key: PublisherKey; object: KeyObject } {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'publicKey', 'use'])) throw invalid('keys');
  const { id, publicKey, use } = value;
  if (!matches(id, KEY_ID_PATTERN)) throw invalid('key_id');
  const object = typeof publicKey === 'string' ? decodePublicKey(publicKey) : undefined;
  if (object === undefined) throw invalid('public_key');
  if (
    !Array.isArray(use) ||
    use.length < 1 ||
    new Set(use).size !== use.length ||
    !use.every((entry: unknown) => KEY_USES.includes(entry as KeyUse))
  ) {
    throw invalid('use');
  }
  const key: PublisherKey = Object.freeze({
    id,
    publicKey: publicKey as string,
    use: Object.freeze([...(use as readonly KeyUse[])]),
  });
  return { key, object };
}

/**
 * Declare a trusted publisher. Throws `marketplace_config.invalid_publisher`
 * naming the first field that is wrong.
 *
 * @public
 */
export function publisher(input: PublisherInput): Publisher {
  if (!isRecord(input) || !hasExactKeys(input, ['id', 'ids', 'keys', 'ceiling'])) {
    throw invalid('shape');
  }
  if (!matches(input.id, PUBLISHER_ID_PATTERN)) throw invalid('id');
  const { exactIds, prefixes } = compileIds(input.ids);
  if (!Array.isArray(input.keys) || input.keys.length < 1 || input.keys.length > MAX_KEYS) {
    throw invalid('keys');
  }
  const keys = new Map<string, { key: PublisherKey; object: KeyObject }>();
  const publicKeys = new Set<string>();
  for (const entry of input.keys as readonly unknown[]) {
    const checked = compileKey(entry);
    if (keys.has(checked.key.id)) throw invalid('key_id');
    if (publicKeys.has(checked.key.publicKey)) throw invalid('public_key');
    keys.set(checked.key.id, checked);
    publicKeys.add(checked.key.publicKey);
  }
  const ceiling = compileCeiling(input.ceiling);
  if (ceiling === undefined) throw invalid('ceiling');
  const declared: Publisher = Object.freeze({
    id: input.id,
    ids: Object.freeze([...input.ids]),
    keys: Object.freeze([...keys.values()].map((entry) => entry.key)),
    ceiling: ceiling.entries,
  });
  compiled.set(
    declared,
    Object.freeze({ id: declared.id, ceiling, keys, exactIds, prefixes: Object.freeze(prefixes) }),
  );
  return declared;
}

/** The checked form of a value `publisher()` returned, or `undefined` for anything else. */
export function compiledPublisher(value: unknown): CompiledPublisher | undefined {
  return typeof value === 'object' && value !== null ? compiled.get(value as Publisher) : undefined;
}

/** Whether `publisher` may release the plugin id `id`. */
export function inNamespace(publisher: CompiledPublisher, id: string): boolean {
  return (
    publisher.exactIds.has(id) ||
    publisher.prefixes.some((prefix) => id.length > prefix.length && id.startsWith(prefix))
  );
}
