/**
 * The Inertia v3 page object and its assembly.
 *
 * {@link InertiaPageObject} is the wire shape both representations carry: the
 * JSON body of an Inertia response and the `<script data-page>` block of the
 * HTML document. Optional fields follow the reference adapter: a metadata list
 * or map is present only when non-empty, a history flag only when `true`, and
 * `flash` only when it has a key. The client fills in `flash: {}` and
 * `rescuedProps: []` when they are absent (@inertiajs/core 3.11.0
 * `dist/index.js` lines 1358 and 2950), so omitting them is conformant.
 *
 * `preserveBigIntegers` is never set here: the serializer adds it exactly when
 * it encodes a `bigint`.
 */

import type { InertiaErrorBags, InertiaErrors } from './error-bags.js';
import { InertiaError } from './inertia-error.js';

/** A JSON value as the page object carries it, before serialization. */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Infinite-scroll metadata for one scroll prop. */
export interface InertiaScrollMeta {
  readonly pageName: string;
  readonly previousPage: string | number | null;
  readonly nextPage: string | number | null;
  readonly currentPage: string | number | null;
  /** The client asked to reset this prop (`X-Inertia-Reset`). */
  readonly reset: boolean;
}

/** One once prop: the path it lives at and when the client must refetch it. */
export interface InertiaOnceMeta {
  readonly prop: string;
  /** Epoch milliseconds, or `null` for no expiry. */
  readonly expiresAt: number | null;
}

/** The prop metadata the engine reports; each field present only when non-empty. */
export interface InertiaPropsMetadata {
  /** Top-level keys of the shared props, reused by instant visits. */
  readonly sharedProps?: readonly string[];
  /** Paths whose arrays are appended to the client's value. */
  readonly mergeProps?: readonly string[];
  /** Paths whose arrays are prepended to the client's value. */
  readonly prependProps?: readonly string[];
  /** Paths whose objects are deep-merged into the client's value. */
  readonly deepMergeProps?: readonly string[];
  /** `<path>.<field>` entries naming the item field merges match on. */
  readonly matchPropsOn?: readonly string[];
  /** Deferred prop paths by group, each group fetched in one request. */
  readonly deferredProps?: Readonly<Record<string, readonly string[]>>;
  /** Deferred props whose resolver failed and were left out. */
  readonly rescuedProps?: readonly string[];
  readonly scrollProps?: Readonly<Record<string, InertiaScrollMeta>>;
  /** Once props by once key. */
  readonly onceProps?: Readonly<Record<string, InertiaOnceMeta>>;
}

/** The v3 page object. */
export interface InertiaPageObject<
  P extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> extends InertiaPropsMetadata {
  readonly component: string;
  readonly props: P & { readonly errors: InertiaErrors | InertiaErrorBags };
  /** The request path and query. */
  readonly url: string;
  /** The asset version; `''` when versioning is off. */
  readonly version: string;
  readonly flash?: Readonly<Record<string, unknown>>;
  readonly encryptHistory?: true;
  readonly clearHistory?: true;
  readonly preserveFragment?: true;
  /** Set by the serializer when the page carries `{ "$bigint": "…" }` markers. */
  readonly preserveBigIntegers?: true;
}

/** The parts {@link createPageObject} assembles. */
export interface PageObjectInput {
  readonly component: string;
  readonly props: Readonly<Record<string, unknown>> & {
    readonly errors: InertiaErrors | InertiaErrorBags;
  };
  readonly url: string;
  readonly version: string;
  readonly metadata?: InertiaPropsMetadata;
  readonly flash?: Readonly<Record<string, unknown>>;
  readonly encryptHistory?: boolean;
  readonly clearHistory?: boolean;
  readonly preserveFragment?: boolean;
}

/**
 * Assemble a page object in the reference field order, leaving out every
 * empty or false optional field.
 */
export function createPageObject(input: PageObjectInput): InertiaPageObject {
  assertComponent(input.component);
  const metadata = input.metadata ?? {};
  return Object.freeze({
    component: input.component,
    props: input.props,
    url: input.url,
    version: input.version,
    ...nonEmptyList('sharedProps', metadata.sharedProps),
    ...nonEmptyList('mergeProps', metadata.mergeProps),
    ...nonEmptyList('prependProps', metadata.prependProps),
    ...nonEmptyList('deepMergeProps', metadata.deepMergeProps),
    ...nonEmptyList('matchPropsOn', metadata.matchPropsOn),
    ...nonEmptyMap('deferredProps', metadata.deferredProps),
    ...nonEmptyList('rescuedProps', metadata.rescuedProps),
    ...nonEmptyMap('scrollProps', metadata.scrollProps),
    ...nonEmptyMap('onceProps', metadata.onceProps),
    ...(input.clearHistory === true ? { clearHistory: true as const } : {}),
    ...(input.encryptHistory === true ? { encryptHistory: true as const } : {}),
    ...(input.flash !== undefined && Object.keys(input.flash).length > 0
      ? { flash: input.flash }
      : {}),
    ...(input.preserveFragment === true ? { preserveFragment: true as const } : {}),
  });
}

/**
 * Reject a component name the client could not resolve: empty, or holding a
 * control character (which would also corrupt logs and headers).
 */
export function assertComponent(component: unknown): asserts component is string {
  if (typeof component !== 'string' || component.trim() === '' || hasControl(component)) {
    throw new InertiaError('invalid_component');
  }
}

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function nonEmptyList<K extends string>(
  key: K,
  list: readonly string[] | undefined,
): Partial<Record<K, readonly string[]>> {
  if (list === undefined || list.length === 0) return {};
  const entry: Partial<Record<K, readonly string[]>> = {};
  entry[key] = Object.freeze([...list]);
  return entry;
}

function nonEmptyMap<K extends string, V>(
  key: K,
  map: Readonly<Record<string, V>> | undefined,
): Partial<Record<K, Readonly<Record<string, V>>>> {
  if (map === undefined || Object.keys(map).length === 0) return {};
  const entry: Partial<Record<K, Readonly<Record<string, V>>>> = {};
  entry[key] = map;
  return entry;
}
