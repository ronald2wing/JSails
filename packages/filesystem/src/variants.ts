/**
 * Image and document variants: a lazy materialization seam over a {@link Disk}.
 *
 * A variant is a deterministic, cached transformation of a stored source file.
 * Unlike ActiveStorage's image-specific variant pipeline, JSails variants are
 * **transform-agnostic**: the caller supplies the transform function, so
 * variants can resize images, transcode audio, re-encode video, or produce
 * document thumbnails through whatever native or WASM codec the app bundles.
 *
 * The resolver owns caching: on the first `resolve` it reads the source, runs
 * the transform, and writes the result to the disk under a derived key; every
 * subsequent resolve for the same source + variant returns immediately (cache
 * hit). The derived key is a SHA-256 hex hash of `sourceKey + variantName +
 * canonical-params`, so two variants with different params produce different
 * keys and never collide.
 *
 * ## Variant key format
 *
 * Variant keys are `_variants/<source digest>/<variant digest>`: the SHA-256 of
 * the source key, then the SHA-256 of the seed tuple. Grouping by source is
 * what lets {@link VariantResolver.purge} delete every variant of a source when
 * the source is removed, instead of leaving hashed objects orphaned. The layout
 * is opaque — callers address variants by `(sourceKey, variantName)` and never
 * construct keys themselves. Variants cached under the earlier flat
 * `_variants/<digest>` layout are not found by this one; they re-materialize on
 * first use and the old objects can be deleted.
 *
 * ## Cache checks
 *
 * A resolve that hits must not cost a round trip per rendered variant (a HEAD
 * request on S3), so the resolver remembers the keys it has seen on the disk in
 * a bounded in-memory set and checks the disk only for keys it does not know.
 * A source is read whole into memory for its transform, bounded by
 * `sourceMaxBytes`.
 *
 * ## Errors
 *
 * Every failure that reaches a caller is a value-free `variant.*` error from
 * {@link VariantErrors}: no key, path, variant name, or data content is ever
 * embedded in a message. `missing_source` means the source file was not on
 * the disk; `unknown_variant` means no variant with that name is registered;
 * `transform_failed` means the transform threw or rejected.
 */

import { Encoding } from 'jsails/support';
import { hashSync } from 'jsails/support/server';
import { DiskErrors, readBytes, type Disk } from 'jsails/filesystem';
import { defineErrors, type ErrorRegistry } from 'jsails/errors';

/**
 * A transform function: receives raw source bytes and the variant's static
 * params, returns transformed bytes. May be async. The transform itself has
 * **no dependency on any image or media library** — the caller supplies it.
 *
 * @public
 */
export type VariantTransform<Params extends Record<string, unknown> = Record<string, unknown>> = (
  input: Uint8Array,
  params: Params,
) => Uint8Array | Promise<Uint8Array>;

/**
 * A named, registered variant carrying its transform and static params.
 *
 * `transform` is declared as a method so that a registry typed over the
 * default `Record<string, unknown>` params accepts a definition whose transform
 * takes a narrower params shape (method parameters are checked bivariantly);
 * the resolver only ever hands a definition its own `params`.
 *
 * @public
 */
export interface VariantDef<Params extends Record<string, unknown> = Record<string, unknown>> {
  readonly name: string;
  transform(input: Uint8Array, params: Params): Uint8Array | Promise<Uint8Array>;
  readonly params: Params;
  /** The MIME type of the transform's output, stored with the variant. */
  readonly contentType?: string;
}

/**
 * Options for {@link DiskVariantResolver}.
 *
 * @public
 */
export interface VariantResolverOptions {
  /** The backing disk for source files and cached variant outputs. */
  readonly disk: Disk;
  /** Registered variants keyed by name. */
  readonly variants: Readonly<Record<string, VariantDef>>;
  /** How many materialized keys to remember between resolves. Defaults to 10 000. */
  readonly knownKeyLimit?: number;
  /** The largest source a transform is given; a bigger one fails with `disk.too_large`. Defaults to 64 MiB. */
  readonly sourceMaxBytes?: number;
}

/**
 * A resolver that derives, caches, and materializes variants on a {@link Disk}.
 *
 * `resolve(sourceKey, variantName)` returns the deterministic variant key
 * after the variant is on disk (either from cache, or freshly materialized).
 * `keyFor(sourceKey, variantName)` computes the same key without any I/O or
 * materialization.
 *
 * @public
 */
export interface VariantResolver {
  /** Resolve (and lazily materialize) a variant. Returns the derived key. */
  resolve(sourceKey: string, variantName: string): Promise<string>;

  /** Compute the deterministic variant key without touching the disk. */
  keyFor(sourceKey: string, variantName: string): string;

  /** Delete every cached variant of `sourceKey`, whatever variant produced it. */
  purge(sourceKey: string): Promise<void>;
}

const VARIANT_ERRORS = {
  unknown_variant: { kind: 'internal', message: 'no variant is registered under that name' },
  missing_source: { kind: 'not_found', message: 'the source file of the variant was not found' },
  transform_failed: { kind: 'internal', message: 'the variant transform failed' },
  invalid_option: {
    kind: 'internal',
    message: 'variant option {option} is invalid',
    context: { option: 'identifier' },
  },
} as const;

/**
 * The variant codes, `variant.*`. Messages never name the source, the
 * variant or the data.
 *
 * @public
 */
export const VariantErrors: ErrorRegistry<'variant', typeof VARIANT_ERRORS> = defineErrors(
  'variant',
  VARIANT_ERRORS,
);

/**
 * Define a variant.
 *
 * `name` is the lookup key passed to `resolve()` / `keyFor()`.
 * `transform` is the caller-supplied transformation function — JSails ships
 * no image or media library, so the caller owns every codec decision.
 * `params` are **static** configuration values passed to the transform and
 * included in the variant-key fingerprint. Use `{}` for parameterless variants.
 *
 * The returned definition is frozen and passed directly to
 * {@link DiskVariantResolver}. Validation is eager: a missing or non-string
 * `name`, or a non-function `transform`, throws `variant.invalid_option`.
 *
 * @public
 */
export function defineVariant<Params extends Record<string, unknown> = Record<string, unknown>>(
  def: VariantDef<Params>,
): VariantDef<Params> {
  if (!def.name || typeof def.name !== 'string') {
    throw new VariantErrors.Error('invalid_option', { option: 'name' });
  }
  if (typeof def.transform !== 'function') {
    throw new VariantErrors.Error('invalid_option', { option: 'transform' });
  }
  return Object.freeze(def);
}

/** The prefix every variant of `sourceKey` lives under. */
function variantPrefix(sourceKey: string): string {
  return `_variants/${hashSync('SHA-256', sourceKey)}`;
}

/** Compute the deterministic variant key. */
function computeVariantKey(
  sourceKey: string,
  variantName: string,
  params: Record<string, unknown>,
): string {
  const seed = `${sourceKey}\0${variantName}\0${Encoding.canonicalJson(params)}`;
  return `${variantPrefix(sourceKey)}/${hashSync('SHA-256', seed)}`;
}

const DEFAULT_KNOWN_KEY_LIMIT = 10_000;
const DEFAULT_SOURCE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * A variant resolver that caches materialized variants on a {@link Disk}.
 *
 * `resolve(sourceKey, variantName)` derives the variant key, checks the disk
 * for an existing cached output (immediate return on hit), and on a miss reads
 * the source, runs the variant's transform, writes the result to the disk, then
 * returns the key. Two resolves for the same `(sourceKey, variantName)` are
 * idempotent — the second is always a cache hit.
 *
 * `keyFor(sourceKey, variantName)` computes the same key with no disk I/O and
 * no materialization.
 *
 * A missing source throws `variant.missing_source`, an unregistered variant
 * name `variant.unknown_variant`, and a transform that throws or rejects
 * `variant.transform_failed`. Every error message is value-free.
 *
 * @public
 */
export class DiskVariantResolver implements VariantResolver {
  readonly #disk: Disk;
  readonly #variants: Readonly<Record<string, VariantDef>>;
  /** Materializations in flight, keyed by variant key, so concurrent misses share one transform. */
  readonly #inflight = new Map<string, Promise<string>>();
  /** Keys known to be on the disk, oldest first; bounded by `#knownLimit`. */
  readonly #known = new Set<string>();
  readonly #knownLimit: number;
  readonly #sourceMaxBytes: number;

  constructor(options: VariantResolverOptions) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new VariantErrors.Error('invalid_option', { option: 'options' });
    }
    this.#disk = options.disk;
    this.#variants = options.variants;
    const limit = options.knownKeyLimit ?? DEFAULT_KNOWN_KEY_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new VariantErrors.Error('invalid_option', { option: 'knownKeyLimit' });
    }
    this.#knownLimit = limit;
    const sourceMaxBytes = options.sourceMaxBytes ?? DEFAULT_SOURCE_MAX_BYTES;
    if (!Number.isSafeInteger(sourceMaxBytes) || sourceMaxBytes < 0) {
      throw new VariantErrors.Error('invalid_option', { option: 'sourceMaxBytes' });
    }
    this.#sourceMaxBytes = sourceMaxBytes;
  }

  #remember(key: string): void {
    if (this.#knownLimit === 0) {
      return;
    }
    this.#known.delete(key);
    this.#known.add(key);
    if (this.#known.size > this.#knownLimit) {
      const oldest = this.#known.values().next().value;
      if (oldest !== undefined) {
        this.#known.delete(oldest);
      }
    }
  }

  #lookup(name: string): VariantDef {
    const def = this.#variants[name];
    if (def === undefined) {
      throw new VariantErrors.Error('unknown_variant');
    }
    return def;
  }

  keyFor(sourceKey: string, variantName: string): string {
    const def = this.#lookup(variantName);
    return computeVariantKey(sourceKey, def.name, def.params);
  }

  async resolve(sourceKey: string, variantName: string): Promise<string> {
    const def = this.#lookup(variantName);
    const variantKey = computeVariantKey(sourceKey, def.name, def.params);

    if (this.#known.has(variantKey)) {
      return variantKey;
    }
    if ((await this.#disk.stat(variantKey)) !== null) {
      this.#remember(variantKey);
      return variantKey;
    }

    // Within one process, concurrent misses for the same variant wait on a
    // single materialization instead of each reading, transforming, and
    // writing the same bytes.
    const pending = this.#inflight.get(variantKey);
    if (pending !== undefined) {
      return pending;
    }
    const task = this.#materialize(sourceKey, variantKey, def).finally(() => {
      this.#inflight.delete(variantKey);
    });
    this.#inflight.set(variantKey, task);
    return task;
  }

  async #materialize(sourceKey: string, variantKey: string, def: VariantDef): Promise<string> {
    let source: Uint8Array;
    try {
      source = await readBytes(this.#disk, sourceKey, { maxBytes: this.#sourceMaxBytes });
    } catch (error) {
      if (DiskErrors.is(error, 'not_found')) {
        throw new VariantErrors.Error('missing_source', {}, { cause: error });
      }
      throw error;
    }

    let result: Uint8Array;
    try {
      result = await def.transform(source, def.params);
    } catch (error) {
      throw new VariantErrors.Error('transform_failed', {}, { cause: error });
    }

    await this.#disk.write(variantKey, result, {
      maxBytes: result.byteLength,
      ...(def.contentType === undefined ? {} : { contentType: def.contentType }),
    });
    this.#remember(variantKey);
    return variantKey;
  }

  async purge(sourceKey: string): Promise<void> {
    const prefix = variantPrefix(sourceKey);
    for (const key of this.#known) {
      if (key.startsWith(`${prefix}/`)) this.#known.delete(key);
    }
    await this.#disk.deletePrefix(prefix);
  }
}
