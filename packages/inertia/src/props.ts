/**
 * Prop descriptors: how a page prop is resolved and what the client is told
 * about it.
 *
 * A prop is a literal value, a bare resolver function (a lazy regular prop),
 * or a descriptor built here: `always`, `optional`, `defer`, `merge`, `once`,
 * or `scroll`. Combinations follow the reference adapter and are option
 * fields, not wrappers: `once` on `optional`, `defer`, and `merge`; `merge` on
 * `defer`; `defer` on `scroll`; `rescue` on `defer`.
 *
 * A descriptor is a frozen `{ kind }` object; its options live in a private
 * registry keyed by that object, so only a value this module built is ever
 * treated as a descriptor. Data that happens to look like one (a database row
 * with a `kind` column) stays data, and a descriptor that leaks into a
 * resolved value is rejected by the serializer instead of being sent.
 *
 * Options are validated when the descriptor is built, so a bad group or once
 * key fails at module load or in the handler, never in the middle of a
 * concurrent resolution.
 */

import { InertiaError } from './inertia-error.js';
import { FORBIDDEN_KEYS } from './plain-data.js';

/** What a lazy prop resolver receives. */
export interface InertiaPropContext {
  /** The component being rendered. */
  readonly component: string;
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  /**
   * Aborted when the request is aborted or a sibling resolver fails, so a
   * resolver can stop work whose result will never be sent.
   */
  readonly signal: AbortSignal;
}

/** A lazy prop: called only when the prop is selected for this response. */
export type PropResolver<T> = (context: InertiaPropContext) => T | Promise<T>;

/** The descriptor kinds. */
export type PropKind = 'always' | 'optional' | 'defer' | 'merge' | 'once' | 'scroll';

/** A prop descriptor. `T` is the client-side value type. */
export interface InertiaProp<T = unknown, K extends PropKind = PropKind> {
  readonly kind: K;
  /** Type-only marker carrying `T`; never present at runtime. */
  readonly '~value'?: T;
}

/** How a merge prop combines with the value the client already holds. */
export interface MergeSpec {
  /** `append` (the default) and `prepend` merge arrays; `deep` merges objects recursively. */
  readonly mode?: 'append' | 'prepend' | 'deep';
  /** Item fields used to replace matching items instead of duplicating them. */
  readonly matchOn?: string | readonly string[];
}

/** A once prop: resolved once, then reused by the client until it expires. */
export interface OnceSpec {
  /** The key the client tracks the prop under; defaults to the prop path. */
  readonly key?: string;
  /** Absolute expiry, as a `Date` or epoch milliseconds. */
  readonly expiresAt?: Date | number;
  /** Expiry relative to each response, in milliseconds. */
  readonly ttlMs?: number;
  /** Resolve and send the prop even when the client says it holds it. */
  readonly fresh?: boolean;
}

/** One page of an infinite-scroll prop. */
export interface ScrollPage<T> {
  readonly data: readonly T[];
  readonly currentPage: string | number | null;
  readonly previousPage: string | number | null;
  readonly nextPage: string | number | null;
}

/** Options for {@link scroll}. */
export interface ScrollOptions {
  /** The query parameter the client pages with. Defaults to `page`. */
  readonly pageName?: string;
  /** Load the first page in a deferred request instead of the initial response. */
  readonly defer?: boolean | { readonly group?: string };
  /** Item fields used to replace matching items in `data` instead of duplicating them. */
  readonly matchOn?: string | readonly string[];
}

/** Options for {@link defer}. */
export interface DeferOptions {
  /** Deferred props in one group are fetched in one request. Defaults to `default`. */
  readonly group?: string;
  /** A failing resolver omits the prop and lists it in `rescuedProps` instead of failing the request. */
  readonly rescue?: boolean;
  readonly merge?: boolean | MergeSpec;
  readonly once?: boolean | OnceSpec;
}

/** Validated merge options. */
export interface MergeRule {
  readonly mode: 'append' | 'prepend' | 'deep';
  readonly matchOn: readonly string[];
}

/** Validated once options. */
export interface OnceRule {
  readonly key: string | null;
  readonly expiresAt: number | null;
  readonly ttlMs: number | null;
  readonly fresh: boolean;
}

/** Validated scroll options. */
export interface ScrollRule {
  readonly pageName: string;
  readonly matchOn: readonly string[];
}

/** The full, validated description of a descriptor. */
export interface PropSpec {
  readonly kind: PropKind;
  /** A literal value or a {@link PropResolver}. */
  readonly source: unknown;
  /** The deferred group, or `null` when the prop is sent with the page. */
  readonly group: string | null;
  readonly rescue: boolean;
  readonly merge: MergeRule | null;
  readonly once: OnceRule | null;
  readonly scroll: ScrollRule | null;
}

const specs = new WeakMap<object, PropSpec>();

/** Whether `value` is a descriptor built by this module. */
export function isInertiaProp(value: unknown): value is InertiaProp {
  return typeof value === 'object' && value !== null && specs.has(value);
}

/** The spec of a descriptor, or `undefined` for any other value. */
export function propSpec(value: unknown): PropSpec | undefined {
  return typeof value === 'object' && value !== null ? specs.get(value) : undefined;
}

/** Sent on every response, partial reloads included, even when not requested. */
export function always<T>(resolve: PropResolver<T>): InertiaProp<T, 'always'>;
export function always<T>(value: T): InertiaProp<T, 'always'>;
export function always(source: unknown): InertiaProp<unknown, 'always'> {
  return describe('always', source, {});
}

/** Never sent on a full visit; resolved only when a partial reload asks for it. */
export function optional<T>(
  resolve: PropResolver<T>,
  options: { readonly once?: boolean | OnceSpec } = {},
): InertiaProp<T, 'optional'> {
  requireResolver(resolve);
  return describe('optional', resolve, { once: onceRule(options.once) });
}

/**
 * Left out of the page; the client fetches it right after rendering, in one
 * partial reload per group.
 */
export function defer<T>(
  resolve: PropResolver<T>,
  options: DeferOptions = {},
): InertiaProp<T, 'defer'> {
  requireResolver(resolve);
  return describe('defer', resolve, {
    group: groupName(options.group),
    rescue: options.rescue === true,
    merge: mergeRule(options.merge),
    once: onceRule(options.once),
  });
}

/** Merged into the value the client already holds instead of replacing it. */
export function merge<T>(
  resolve: PropResolver<T>,
  options?: MergeSpec & { readonly once?: boolean | OnceSpec },
): InertiaProp<T, 'merge'>;
export function merge<T>(
  value: T,
  options?: MergeSpec & { readonly once?: boolean | OnceSpec },
): InertiaProp<T, 'merge'>;
export function merge(
  source: unknown,
  options: MergeSpec & { readonly once?: boolean | OnceSpec } = {},
): InertiaProp<unknown, 'merge'> {
  return describe('merge', source, {
    merge: mergeRule({
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(options.matchOn === undefined ? {} : { matchOn: options.matchOn }),
    }),
    once: onceRule(options.once),
  });
}

/** Resolved once; the client keeps it across visits and skips it until it expires. */
export function once<T>(resolve: PropResolver<T>, options?: OnceSpec): InertiaProp<T, 'once'>;
export function once<T>(value: T, options?: OnceSpec): InertiaProp<T, 'once'>;
export function once(source: unknown, options: OnceSpec = {}): InertiaProp<unknown, 'once'> {
  return describe('once', source, { once: onceRule(options) });
}

/**
 * An infinite-scroll prop. `data` is appended (or prepended, per the client's
 * merge intent) and the page identifiers are reported in `scrollProps`.
 */
export function scroll<T>(
  page: ScrollPage<T> | PropResolver<ScrollPage<T>>,
  options: ScrollOptions = {},
): InertiaProp<ScrollPage<T>, 'scroll'> {
  if (options.pageName !== undefined && !isName(options.pageName)) invalid();
  const deferGroup =
    options.defer === undefined || options.defer === false
      ? null
      : groupName(options.defer === true ? undefined : options.defer.group);
  return describe('scroll', page, {
    group: deferGroup,
    scroll: Object.freeze({
      pageName: options.pageName ?? 'page',
      matchOn: matchFields(options.matchOn),
    }),
  });
}

function describe<K extends PropKind>(
  kind: K,
  source: unknown,
  rules: Partial<Omit<PropSpec, 'kind' | 'source'>>,
): InertiaProp<never, K> {
  if (isInertiaProp(source)) invalid();
  const descriptor: InertiaProp<never, K> = Object.freeze({ kind });
  specs.set(
    descriptor,
    Object.freeze({
      kind,
      source,
      group: rules.group ?? null,
      rescue: rules.rescue ?? false,
      merge: rules.merge ?? null,
      once: rules.once ?? null,
      scroll: rules.scroll ?? null,
    }),
  );
  return descriptor;
}

function requireResolver(value: unknown): void {
  if (typeof value !== 'function') invalid();
}

function groupName(group: string | undefined): string {
  if (group === undefined) return 'default';
  if (!isName(group)) invalid();
  return group;
}

function mergeRule(spec: boolean | MergeSpec | undefined): MergeRule | null {
  if (spec === undefined || spec === false) return null;
  const options = spec === true ? {} : spec;
  const mode = options.mode ?? 'append';
  if (mode !== 'append' && mode !== 'prepend' && mode !== 'deep') invalid();
  return Object.freeze({ mode, matchOn: matchFields(options.matchOn) });
}

function onceRule(spec: boolean | OnceSpec | undefined): OnceRule | null {
  if (spec === undefined || spec === false) return null;
  const options = spec === true ? {} : spec;
  if (options.key !== undefined && !isName(options.key)) invalid();
  if (options.expiresAt !== undefined && options.ttlMs !== undefined) invalid();
  let expiresAt: number | null = null;
  if (options.expiresAt !== undefined) {
    expiresAt = options.expiresAt instanceof Date ? options.expiresAt.getTime() : options.expiresAt;
    if (!Number.isFinite(expiresAt)) invalid();
  }
  if (options.ttlMs !== undefined && (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0)) {
    invalid();
  }
  return Object.freeze({
    key: options.key ?? null,
    expiresAt,
    ttlMs: options.ttlMs ?? null,
    fresh: options.fresh === true,
  });
}

function matchFields(matchOn: string | readonly string[] | undefined): readonly string[] {
  if (matchOn === undefined) return Object.freeze([]);
  const fields = typeof matchOn === 'string' ? [matchOn] : [...matchOn];
  if (!fields.every((field) => typeof field === 'string' && field !== '' && !field.includes(',')))
    invalid();
  return Object.freeze(fields);
}

/**
 * A group, key, or page name: non-empty, free of the header list separator,
 * and never a prototype key (these names become keys of the page metadata).
 */
function isName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    !value.includes(',') &&
    !FORBIDDEN_KEYS.has(value)
  );
}

function invalid(): never {
  throw new InertiaError('invalid_options');
}
